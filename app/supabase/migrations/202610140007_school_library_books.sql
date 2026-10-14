alter table public.school_websites
  add column if not exists public_library_enabled boolean not null default false;

create table public.school_books (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  barcode text not null,
  isbn text,
  title text not null check (char_length(trim(title)) between 1 and 240),
  authors text[] not null default '{}',
  publisher text,
  edition text,
  publication_year integer check (publication_year between 1000 and 2200),
  cover_url text,
  description text,
  total_copies integer not null default 1 check (total_copies >= 0),
  available_copies integer not null default 1 check (available_copies >= 0 and available_copies <= total_copies),
  archived_at timestamptz,
  archived_by uuid references public.profiles(id),
  created_by uuid not null references public.profiles(id),
  updated_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (school_id, barcode),
  check (isbn is null or char_length(isbn) between 10 and 17)
);
create index school_books_search_idx on public.school_books(school_id, lower(title));
create index school_books_isbn_idx on public.school_books(school_id, isbn) where isbn is not null;

create table public.library_requests (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  book_id uuid not null,
  requester_id uuid not null references public.profiles(id) on delete cascade,
  requester_name text not null default '',
  requester_email text,
  request_type text not null check (request_type in ('request', 'preorder')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  note text not null default '' check (char_length(note) <= 1000),
  decision_note text not null default '' check (char_length(decision_note) <= 1000),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  foreign key (school_id, book_id) references public.school_books(school_id, id) on delete restrict,
  unique (school_id, id)
);
create index library_requests_school_status_idx on public.library_requests(school_id, status, created_at desc);
create index library_requests_requester_idx on public.library_requests(requester_id, created_at desc);
create unique index library_requests_one_pending_per_user_book_idx
  on public.library_requests(book_id, requester_id) where status = 'pending';

alter table public.school_books enable row level security;
alter table public.library_requests enable row level security;

create policy "School members read library books"
  on public.school_books for select to authenticated
  using (public.is_school_member(school_id));
create policy "School library managers manage books"
  on public.school_books for all to authenticated
  using (public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[]))
  with check (public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[]));
create policy "Requesters and library managers read requests"
  on public.library_requests for select to authenticated
  using (
    requester_id = auth.uid()
    or public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
  );
grant select, insert, update, delete on public.school_books to authenticated;
grant select on public.library_requests to authenticated;
revoke insert, update, delete on public.library_requests from authenticated;

create or replace function public.get_public_school_website(target_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'school_id', website.school_id,
    'slug', website.slug,
    'public_results_enabled', website.public_results_enabled,
    'public_library_enabled', website.public_library_enabled,
    'hero_title', website.hero_title,
    'hero_message', website.hero_message,
    'about_title', website.about_title,
    'about_text', website.about_text,
    'admissions_open', website.admissions_open,
    'admissions_applications_enabled', website.admissions_applications_enabled,
    'admissions_title', website.admissions_title,
    'admissions_text', website.admissions_text,
    'admission_requirements', website.admission_requirements,
    'admissions_deadline', website.admissions_deadline,
    'admissions_email', website.admissions_email,
    'fees', website.fees,
    'name', school.name,
    'address', school.address,
    'contact_email', school.contact_email,
    'contact_phone', school.contact_phone,
    'website', school.website,
    'logo_path', school.logo_path,
    'primary_color', school.primary_color,
    'secondary_color', school.secondary_color,
    'motto', school.motto
  )
  from public.school_websites website
  join public.schools school on school.id = website.school_id
  where website.slug = lower(trim(target_slug))
    and website.enabled;
$$;

create or replace function public.lookup_public_library_book(target_slug text, target_barcode text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'public_enabled', website.enabled and website.public_library_enabled and school.platform_status = 'active'
      and coalesce((select settings.module_library from public.school_module_settings settings where settings.school_id = school.id), false),
    'school_name', school.name,
    'school_slug', website.slug,
    'book', case
      when website.enabled and website.public_library_enabled and school.platform_status = 'active'
        and coalesce((select settings.module_library from public.school_module_settings settings where settings.school_id = school.id), false)
        and book.id is not null and book.archived_at is null
      then jsonb_build_object(
        'barcode', book.barcode,
        'isbn', book.isbn,
        'title', book.title,
        'authors', book.authors,
        'publisher', book.publisher,
        'edition', book.edition,
        'publication_year', book.publication_year,
        'cover_url', book.cover_url,
        'description', book.description,
        'available_copies', book.available_copies
      )
      else null
    end
  )
  from public.school_websites website
  join public.schools school on school.id = website.school_id
  left join public.school_books book
    on book.school_id = website.school_id
    and book.barcode = trim(target_barcode)
  where website.slug = lower(trim(target_slug));
$$;

create or replace function public.request_public_library_book(
  target_slug text,
  target_barcode text,
  request_note text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  requester uuid := auth.uid();
  target_book public.school_books%rowtype;
  request_id uuid;
  request_kind text;
  requester_name text;
  requester_email text;
begin
  if requester is null then
    raise exception 'Sign in to request or preorder a book.';
  end if;
  select coalesce(profile.full_name, ''), profile.email
  into requester_name, requester_email
  from public.profiles profile
  where profile.id = requester;
  if char_length(coalesce(request_note, '')) > 1000 then
    raise exception 'The request note must be 1000 characters or fewer.';
  end if;

  select book.* into target_book
  from public.school_websites website
  join public.schools school on school.id = website.school_id
  join public.school_books book on book.school_id = website.school_id
  where website.slug = lower(trim(target_slug))
    and website.enabled and website.public_library_enabled
    and school.platform_status = 'active'
    and coalesce((select settings.module_library from public.school_module_settings settings where settings.school_id = school.id), false)
    and book.barcode = trim(target_barcode)
    and book.archived_at is null
  for update of book;
  if not found then
    raise exception 'This book is not available for public requests.';
  end if;
  if not public.is_school_member(target_book.school_id) then
    raise exception 'Only a student, parent, or staff member connected to this school can request a book. Please sign in with a school account.';
  end if;
  if exists (
    select 1 from public.library_requests request
    where request.book_id = target_book.id
      and request.requester_id = requester
      and request.status = 'pending'
  ) then
    raise exception 'You already have a pending request for this book.';
  end if;

  request_kind := case when target_book.available_copies > 0 then 'request' else 'preorder' end;
  insert into public.library_requests (school_id, book_id, requester_id, requester_name, requester_email, request_type, note)
  values (target_book.school_id, target_book.id, requester, requester_name, requester_email, request_kind, trim(coalesce(request_note, '')))
  returning id into request_id;
  return jsonb_build_object('id', request_id, 'request_type', request_kind, 'status', 'pending');
end;
$$;

create or replace function public.request_school_library_book(target_book uuid, request_note text default '')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  requester uuid := auth.uid();
  book_record public.school_books%rowtype;
  request_id uuid;
  request_kind text;
  requester_name text;
  requester_email text;
begin
  if requester is null then raise exception 'Sign in to request or preorder a book.'; end if;
  select coalesce(profile.full_name, ''), profile.email
  into requester_name, requester_email
  from public.profiles profile
  where profile.id = requester;
  if char_length(coalesce(request_note, '')) > 1000 then
    raise exception 'The request note must be 1000 characters or fewer.';
  end if;
  select * into book_record
  from public.school_books
  where id = target_book and archived_at is null
  for update;
  if not found then raise exception 'This book is unavailable.'; end if;
  if not public.is_school_member(book_record.school_id) then
    raise exception 'Only a student, parent, or staff member connected to this school can request a book.';
  end if;
  if exists (
    select 1 from public.library_requests request
    where request.book_id = book_record.id and request.requester_id = requester and request.status = 'pending'
  ) then raise exception 'You already have a pending request for this book.'; end if;

  request_kind := case when book_record.available_copies > 0 then 'request' else 'preorder' end;
  insert into public.library_requests (school_id, book_id, requester_id, requester_name, requester_email, request_type, note)
  values (book_record.school_id, book_record.id, requester, requester_name, requester_email, request_kind, trim(coalesce(request_note, '')))
  returning id into request_id;
  return jsonb_build_object('id', request_id, 'request_type', request_kind, 'status', 'pending');
end;
$$;

create or replace function public.review_library_request(
  target_request uuid,
  decision text,
  decision_message text default ''
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  pending_request public.library_requests%rowtype;
  book_record public.school_books%rowtype;
begin
  if decision is null or decision not in ('approved', 'denied') or char_length(coalesce(decision_message, '')) > 1000 then
    raise exception 'Choose approve or deny and provide a decision note of at most 1000 characters.';
  end if;
  select * into pending_request
  from public.library_requests
  where id = target_request
  for update;
  if not found then raise exception 'The book request was not found.'; end if;
  if not public.has_school_role(pending_request.school_id, array['school_admin', 'academic_coordinator']::public.app_role[]) then
    raise exception 'Only a school administrator or academic coordinator can review book requests.';
  end if;
  if pending_request.status <> 'pending' then
    raise exception 'This book request has already been reviewed.';
  end if;
  if decision = 'approved' and pending_request.request_type = 'request' then
    select * into book_record from public.school_books where id = pending_request.book_id for update;
    if book_record.archived_at is not null or book_record.available_copies < 1 then
      raise exception 'No copies are currently available. Deny this request or ask the user to preorder.';
    end if;
    update public.school_books
    set available_copies = available_copies - 1,
        updated_by = auth.uid(),
        updated_at = timezone('utc', now())
    where id = book_record.id;
  end if;
  update public.library_requests
  set status = decision,
      decision_note = trim(coalesce(decision_message, '')),
      reviewed_by = auth.uid(),
      reviewed_at = timezone('utc', now()),
      updated_at = timezone('utc', now())
  where id = pending_request.id;
end;
$$;

revoke all on function public.lookup_public_library_book(text, text) from public;
revoke all on function public.request_public_library_book(text, text, text) from public, anon;
revoke all on function public.request_school_library_book(uuid, text) from public, anon;
revoke all on function public.review_library_request(uuid, text, text) from public, anon;
grant execute on function public.lookup_public_library_book(text, text) to anon, authenticated;
grant execute on function public.request_public_library_book(text, text, text) to authenticated;
grant execute on function public.request_school_library_book(uuid, text) to authenticated;
grant execute on function public.review_library_request(uuid, text, text) to authenticated;

create trigger audit_school_books_change
  after insert or update or delete on public.school_books
  for each row execute function public.log_school_record_change();
create trigger audit_library_requests_change
  after insert or update or delete on public.library_requests
  for each row execute function public.log_school_record_change();
create trigger enforce_maintenance_school_books
  before insert or update or delete on public.school_books
  for each row execute function public.enforce_maintenance_write();
create trigger enforce_maintenance_library_requests
  before insert or update or delete on public.library_requests
  for each row execute function public.enforce_maintenance_write();

create or replace function public.enforce_maintenance_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  old_school uuid;
  new_school uuid;
  module_key text;
  maintenance_state jsonb;
begin
  if auth.role() = 'service_role' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op <> 'INSERT' then old_school := nullif(to_jsonb(old) ->> 'school_id', '')::uuid; end if;
  if tg_op <> 'DELETE' then new_school := nullif(to_jsonb(new) ->> 'school_id', '')::uuid; end if;
  module_key := case
    when tg_table_name like 'attendance%' then 'attendance'
    when tg_table_name like 'timetable%' or tg_table_name like 'bell_schedule%' or tg_table_name like 'academic_bell%' then 'timetable'
    when tg_table_name like 'assignment%' or tg_table_name like 'submission%' then 'assignments'
    when tg_table_name like 'assessment%' or tg_table_name like 'grade%' or tg_table_name like 'report_card%' or tg_table_name like 'school_report%' or tg_table_name = 'learning_assessment_results' then 'grades'
    when tg_table_name like 'learning_material%' or tg_table_name like 'learning_assessment%' or tg_table_name like 'course%' or tg_table_name like 'lesson%' or tg_table_name = 'past_papers' then 'learning'
    when tg_table_name like 'library_%' or tg_table_name = 'school_books' then 'library'
    when tg_table_name like 'fee%' or tg_table_name like 'student_fee%' or tg_table_name like 'payment%' or tg_table_name like 'finance%' or tg_table_name like 'accounting%' then 'finance'
    when tg_table_name like '%message%' or tg_table_name like '%conversation%' or tg_table_name like 'managed_storage%' then 'messaging'
    when tg_table_name like 'admission%' then 'admissions'
    when tg_table_name like 'staff%' or tg_table_name like 'teacher%' or tg_table_name like 'department%' or tg_table_name like 'school_department%' then 'staff'
    when tg_table_name like 'student%' or tg_table_name like 'parent%' or tg_table_name like 'emergency_contact%' then 'students'
    when tg_table_name like '%calendar%' or tg_table_name like 'term%' then 'calendar'
    when tg_table_name like 'academic%' or tg_table_name like 'school_class%' or tg_table_name like 'class_%' or tg_table_name like 'subject%' then 'academics'
    when tg_table_name like 'announcement%' or tg_table_name like 'event%' or tg_table_name like 'notification%' then 'communication'
    else null
  end;

  if old_school is not null then
    maintenance_state := public.platform_maintenance_status(old_school, module_key);
    if coalesce((maintenance_state ->> 'active')::boolean, false) then
      raise exception 'This school or feature is under maintenance. Changes are temporarily disabled.';
    end if;
  end if;
  if new_school is not null and new_school is distinct from old_school then
    maintenance_state := public.platform_maintenance_status(new_school, module_key);
    if coalesce((maintenance_state ->> 'active')::boolean, false) then
      raise exception 'This school or feature is under maintenance. Changes are temporarily disabled.';
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.enforce_maintenance_write() from public, anon, authenticated;
