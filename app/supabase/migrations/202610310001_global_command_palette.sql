create extension if not exists pg_trgm with schema extensions;

create index if not exists students_command_name_trgm_idx
  on public.students using gin (lower(first_name || ' ' || last_name) extensions.gin_trgm_ops);
create index if not exists students_command_number_trgm_idx
  on public.students using gin (lower(student_number) extensions.gin_trgm_ops);
create index if not exists school_classes_command_name_trgm_idx
  on public.school_classes using gin (lower(name) extensions.gin_trgm_ops);
create index if not exists subjects_command_name_trgm_idx
  on public.subjects using gin (lower(name) extensions.gin_trgm_ops);
create index if not exists subjects_command_code_trgm_idx
  on public.subjects using gin (lower(coalesce(code, '')) extensions.gin_trgm_ops);
create index if not exists school_books_command_title_trgm_idx
  on public.school_books using gin (lower(title) extensions.gin_trgm_ops)
  where archived_at is null;
create index if not exists school_books_command_isbn_trgm_idx
  on public.school_books using gin (lower(coalesce(isbn, '')) extensions.gin_trgm_ops)
  where archived_at is null;
create index if not exists school_books_command_barcode_trgm_idx
  on public.school_books using gin (lower(barcode) extensions.gin_trgm_ops)
  where archived_at is null;
create index if not exists student_fee_invoices_command_number_trgm_idx
  on public.student_fee_invoices using gin (lower(invoice_number) extensions.gin_trgm_ops);
create index if not exists student_fee_invoices_command_description_trgm_idx
  on public.student_fee_invoices using gin (lower(description) extensions.gin_trgm_ops);

create table public.command_palette_favourites (
  school_id uuid not null references public.schools(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  entry_key text not null check (entry_key ~ '^(page|action|setting):[a-z0-9_-]+$'),
  sort_order integer not null default 0 check (sort_order between 0 and 1000),
  created_at timestamptz not null default now(),
  primary key (school_id, profile_id, entry_key)
);
alter table public.command_palette_favourites enable row level security;
revoke all on public.command_palette_favourites from anon, authenticated;
grant select, insert, delete, update on public.command_palette_favourites to authenticated;
create policy "Users manage their own school-scoped command favourites"
  on public.command_palette_favourites for all to authenticated
  using (profile_id = auth.uid() and public.is_school_member(school_id))
  with check (profile_id = auth.uid() and public.is_school_member(school_id));

create table public.command_search_analytics_keys (
  school_id uuid primary key references public.schools(id) on delete cascade,
  secret bytea not null default gen_random_bytes(32)
);
alter table public.command_search_analytics_keys enable row level security;
revoke all on public.command_search_analytics_keys from public, anon, authenticated;

create table public.command_search_events (
  id bigint generated always as identity primary key,
  school_id uuid not null references public.schools(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  correlation_id uuid not null,
  event_type text not null check (event_type in (
    'command_palette_opened', 'search_started', 'search_completed', 'search_failed',
    'search_result_selected', 'search_no_results', 'search_action_executed',
    'favourite_added', 'favourite_removed'
  )),
  category text check (category is null or category in (
    'pages', 'actions', 'settings', 'students', 'classes', 'subjects', 'books', 'invoices'
  )),
  result_count integer check (result_count is null or result_count between 0 and 30),
  duration_ms integer check (duration_ms is null or duration_ms between 0 and 120000),
  success boolean,
  created_at timestamptz not null default now()
);
create index command_search_events_school_created_idx
  on public.command_search_events(school_id, created_at desc);
create index command_search_events_school_type_idx
  on public.command_search_events(school_id, event_type, created_at desc);
alter table public.command_search_events enable row level security;
revoke all on public.command_search_events from public, anon, authenticated;

create table public.command_no_result_terms (
  school_id uuid not null references public.schools(id) on delete cascade,
  term_digest bytea not null,
  occurrence_count bigint not null default 1 check (occurrence_count > 0),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (school_id, term_digest)
);
alter table public.command_no_result_terms enable row level security;
revoke all on public.command_no_result_terms from public, anon, authenticated;

create or replace function public.record_command_no_result_term(
  target_school uuid,
  target_term text
)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  analytics_secret bytea;
  normalized_term text := lower(regexp_replace(trim(coalesce(target_term, '')), '\s+', ' ', 'g'));
begin
  if auth.uid() is null or not public.is_school_member(target_school) then
    raise exception 'An active school membership is required to record search analytics.';
  end if;
  if char_length(normalized_term) not between 2 and 100 then return; end if;
  insert into public.command_search_analytics_keys(school_id)
  values (target_school) on conflict (school_id) do nothing;
  select secret into analytics_secret from public.command_search_analytics_keys
  where school_id = target_school;
  insert into public.command_no_result_terms(school_id, term_digest)
  values (target_school, hmac(convert_to(normalized_term, 'UTF8'), analytics_secret, 'sha256'))
  on conflict (school_id, term_digest) do update
  set occurrence_count = public.command_no_result_terms.occurrence_count + 1,
      last_seen_at = now();
end;
$$;
revoke all on function public.record_command_no_result_term(uuid, text) from public, anon;
grant execute on function public.record_command_no_result_term(uuid, text) to authenticated;

create or replace function public.search_school_command_records(
  target_school uuid,
  search_query text,
  requested_categories text[] default array['students', 'classes', 'subjects', 'books', 'invoices'],
  requested_per_category integer default 8,
  requested_limit integer default 30
)
returns table (
  category text,
  record_id uuid,
  title text,
  subtitle text,
  relevance real
)
language plpgsql
stable
security invoker
set search_path = public, extensions, pg_temp
as $$
declare
  needle text := lower(trim(coalesce(search_query, '')));
  school_settings public.school_module_settings%rowtype;
  per_category_limit integer := greatest(1, least(coalesce(requested_per_category, 8), 8));
  combined_limit integer := greatest(1, least(coalesce(requested_limit, 30), 30));
begin
  if auth.uid() is null or not public.is_school_member(target_school) then
    raise exception 'An active school membership is required to search records.';
  end if;
  if char_length(needle) < 2 or char_length(needle) > 100 then
    return;
  end if;
  select * into school_settings from public.school_module_settings
  where school_id = target_school;
  if not found then
    raise exception 'School module settings are unavailable.';
  end if;

  return query
  with candidates as (
    select 'students'::text as result_category, student.id as result_id,
      concat_ws(' ', student.first_name, student.last_name) as result_title,
      student.student_number as result_subtitle,
      case
        when lower(student.student_number) = needle then 1.0
        when lower(concat_ws(' ', student.first_name, student.last_name)) = needle then 0.98
        when lower(concat_ws(' ', student.first_name, student.last_name)) like needle || '%' then 0.94
        when lower(student.student_number) like needle || '%' then 0.92
        else greatest(
          similarity(lower(concat_ws(' ', student.first_name, student.last_name)), needle),
          similarity(lower(student.first_name), needle),
          similarity(lower(student.last_name), needle),
          similarity(lower(student.student_number), needle)
        )
      end::real as score
    from public.students student
    where student.school_id = target_school
      and 'students' = any(requested_categories)
      and public.school_permission_allowed(target_school, 'students', 'access')
      and public.school_permission_allowed(target_school, 'students', 'view')
      and (
        lower(student.student_number) like '%' || needle || '%'
        or lower(concat_ws(' ', student.first_name, student.last_name)) like '%' || needle || '%'
        or lower(student.first_name) % needle
        or lower(student.last_name) % needle
        or lower(student.student_number) % needle
      )

    union all

    select 'classes', school_class.id, school_class.name,
      coalesce(school_class.grade_level, ''),
      case
        when lower(school_class.name) = needle then 0.98
        when lower(school_class.name) like needle || '%' then 0.94
        else similarity(lower(school_class.name), needle)
      end::real
    from public.school_classes school_class
    where school_class.school_id = target_school
      and 'classes' = any(requested_categories)
      and public.has_school_role(target_school, array['school_admin', 'academic_coordinator', 'teacher', 'student', 'parent']::public.app_role[])
      and public.school_permission_allowed(target_school, 'academics', 'access')
      and public.school_permission_allowed(target_school, 'academics', 'view')
      and (
        lower(school_class.name) like '%' || needle || '%'
        or lower(school_class.name) % needle
      )

    union all

    select 'subjects', subject.id, subject.name, coalesce(subject.code, ''),
      case
        when lower(coalesce(subject.code, '')) = needle then 1.0
        when lower(subject.name) = needle then 0.98
        when lower(subject.name) like needle || '%' then 0.94
        when lower(coalesce(subject.code, '')) like needle || '%' then 0.92
        else greatest(similarity(lower(subject.name), needle), similarity(lower(coalesce(subject.code, '')), needle))
      end::real
    from public.subjects subject
    where subject.school_id = target_school
      and 'subjects' = any(requested_categories)
      and public.has_school_role(target_school, array['school_admin', 'academic_coordinator', 'teacher', 'student', 'parent']::public.app_role[])
      and public.school_permission_allowed(target_school, 'academics', 'access')
      and public.school_permission_allowed(target_school, 'academics', 'view')
      and (
        lower(subject.name) like '%' || needle || '%'
        or lower(coalesce(subject.code, '')) like '%' || needle || '%'
        or lower(subject.name) % needle
        or lower(coalesce(subject.code, '')) % needle
      )

    union all

    select 'books', book.id, book.title,
      coalesce(nullif(array_to_string(book.authors, ', '), ''), book.isbn, book.barcode),
      case
        when lower(coalesce(book.isbn, '')) = needle or lower(book.barcode) = needle then 1.0
        when lower(book.title) = needle then 0.98
        when lower(book.title) like needle || '%' then 0.94
        when lower(coalesce(book.isbn, '')) like needle || '%' or lower(book.barcode) like needle || '%' then 0.92
        else greatest(
          similarity(lower(book.title), needle),
          similarity(lower(coalesce(book.isbn, '')), needle),
          similarity(lower(book.barcode), needle),
          similarity(lower(array_to_string(book.authors, ' ')), needle)
        )
      end::real
    from public.school_books book
    where book.school_id = target_school
      and 'books' = any(requested_categories)
      and public.has_school_role(target_school, array['school_admin', 'academic_coordinator', 'teacher', 'student', 'parent', 'librarian']::public.app_role[])
      and school_settings.module_library
      and public.school_permission_allowed(target_school, 'library', 'access')
      and public.school_permission_allowed(target_school, 'library', 'view')
      and book.archived_at is null
      and (
        lower(book.title) like '%' || needle || '%'
        or lower(coalesce(book.isbn, '')) like '%' || needle || '%'
        or lower(book.barcode) like '%' || needle || '%'
        or lower(array_to_string(book.authors, ' ')) like '%' || needle || '%'
        or lower(book.title) % needle
        or lower(coalesce(book.isbn, '')) % needle
        or lower(book.barcode) % needle
        or lower(array_to_string(book.authors, ' ')) % needle
      )

    union all

    select 'invoices', invoice.id, invoice.invoice_number,
      concat_ws(' · ', invoice.description, invoice.status),
      case
        when lower(invoice.invoice_number) = needle then 1.0
        when lower(coalesce(account.student_number, '')) = needle then 0.96
        when lower(invoice.invoice_number) like needle || '%' then 0.94
        when lower(concat_ws(' ', account.first_name, account.last_name)) = needle then 0.92
        when lower(invoice.description) like needle || '%' then 0.88
        else greatest(
          similarity(lower(invoice.invoice_number), needle),
          similarity(lower(invoice.description), needle),
          similarity(lower(coalesce(account.student_number, '')), needle),
          similarity(lower(concat_ws(' ', account.first_name, account.last_name)), needle)
        )
      end::real
    from public.student_fee_invoices invoice
    left join public.finance_student_directory account
      on account.school_id = invoice.school_id and account.id = invoice.student_id
    where invoice.school_id = target_school
      and 'invoices' = any(requested_categories)
      and school_settings.module_finance
      and public.school_permission_allowed(target_school, 'finance', 'access')
      and public.school_permission_allowed(target_school, 'finance', 'view')
      and (
        lower(invoice.invoice_number) like '%' || needle || '%'
        or lower(invoice.description) like '%' || needle || '%'
        or lower(invoice.invoice_number) % needle
        or lower(invoice.description) % needle
        or lower(coalesce(account.student_number, '')) like '%' || needle || '%'
        or lower(concat_ws(' ', account.first_name, account.last_name)) like '%' || needle || '%'
        or lower(coalesce(account.student_number, '')) % needle
        or lower(concat_ws(' ', account.first_name, account.last_name)) % needle
      )
  ), ranked as (
    select candidate.*,
      row_number() over (partition by result_category order by score desc, result_title, result_id) as category_rank
    from candidates candidate
    where score > 0.12
  )
  select result_category, result_id, result_title, result_subtitle, score
  from ranked
  where category_rank <= per_category_limit
  order by score desc, result_category, result_title
  limit combined_limit;
end;
$$;
revoke all on function public.search_school_command_records(uuid, text, text[], integer, integer) from public, anon;
grant execute on function public.search_school_command_records(uuid, text, text[], integer, integer) to authenticated;

create or replace function public.record_command_search_event(
  target_school uuid,
  target_correlation_id uuid,
  target_event_type text,
  target_category text default null,
  target_result_count integer default null,
  target_duration_ms integer default null,
  target_success boolean default null
)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_school_member(target_school) then
    raise exception 'An active school membership is required to record search analytics.';
  end if;
  if target_correlation_id is null
    or target_event_type not in (
      'command_palette_opened', 'search_started', 'search_completed', 'search_failed',
      'search_result_selected', 'search_no_results', 'search_action_executed',
      'favourite_added', 'favourite_removed'
    )
    or (target_category is not null and target_category not in (
      'pages', 'actions', 'settings', 'students', 'classes', 'subjects', 'books', 'invoices'
    ))
    or (target_result_count is not null and target_result_count not between 0 and 30)
    or (target_duration_ms is not null and target_duration_ms not between 0 and 120000) then
    raise exception 'Invalid command search analytics event.';
  end if;

  insert into public.command_search_events(
    school_id, profile_id, correlation_id, event_type, category, result_count, duration_ms, success
  ) values (
    target_school, auth.uid(), target_correlation_id, target_event_type, target_category,
    target_result_count, target_duration_ms, target_success
  );

end;
$$;
revoke all on function public.record_command_search_event(uuid, uuid, text, text, integer, integer, boolean) from public, anon;
grant execute on function public.record_command_search_event(uuid, uuid, text, text, integer, integer, boolean) to authenticated;

create or replace function public.get_command_search_metrics(target_school uuid)
returns table (
  event_type text,
  event_count bigint,
  median_duration_ms numeric,
  category text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.has_school_role(target_school, array['school_admin']::public.app_role[])
    and not public.school_permission_allowed(target_school, 'audit', 'view') then
    raise exception 'School administrator or audit analytics permission is required.';
  end if;
  return query
  select events.event_type, count(*)::bigint,
    percentile_cont(0.5) within group (order by events.duration_ms)::numeric,
    events.category
  from public.command_search_events events
  where events.school_id = target_school
    and events.created_at >= now() - interval '90 days'
  group by events.event_type, events.category
  order by events.event_type, events.category;
end;
$$;
revoke all on function public.get_command_search_metrics(uuid) from public, anon;
grant execute on function public.get_command_search_metrics(uuid) to authenticated;

notify pgrst, 'reload schema';
