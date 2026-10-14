create table public.library_checkouts (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  book_id uuid not null,
  student_id uuid not null,
  return_code_hash text not null unique check (return_code_hash ~ '^[a-f0-9]{64}$'),
  checked_out_by uuid not null references public.profiles(id),
  checked_out_at timestamptz not null default timezone('utc', now()),
  returned_by uuid references public.profiles(id),
  returned_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, book_id) references public.school_books(school_id, id) on delete restrict,
  foreign key (school_id, student_id) references public.students(school_id, id) on delete restrict,
  check ((returned_at is null and returned_by is null) or (returned_at is not null and returned_by is not null))
);
create index library_checkouts_school_active_idx
  on public.library_checkouts(school_id, checked_out_at desc) where returned_at is null;
create index library_checkouts_student_idx
  on public.library_checkouts(school_id, student_id, checked_out_at desc);

alter table public.library_checkouts enable row level security;
create policy "Library managers and borrower students read checkouts"
  on public.library_checkouts for select to authenticated
  using (
    public.has_school_role(school_id, array['school_admin', 'academic_coordinator']::public.app_role[])
    or exists (
      select 1 from public.students student
      where student.id = library_checkouts.student_id
        and student.school_id = library_checkouts.school_id
        and student.profile_id = auth.uid()
    )
  );
grant select on public.library_checkouts to authenticated;
revoke insert, update, delete on public.library_checkouts from anon, authenticated;

create or replace function public.guard_library_book_inventory()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  active_checkout_count integer;
begin
  select count(*) into active_checkout_count
  from public.library_checkouts
  where book_id = new.id and returned_at is null;
  if new.total_copies - new.available_copies < active_checkout_count then
    raise exception 'Total and available copies cannot be reduced below the number of books currently checked out.';
  end if;
  if new.archived_at is not null and active_checkout_count > 0 then
    raise exception 'Return all checked-out copies before archiving this book.';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_library_book_inventory() from public, anon, authenticated;
create trigger guard_library_book_inventory
  before update on public.school_books
  for each row execute function public.guard_library_book_inventory();

create or replace function public.checkout_library_book(
  target_book uuid,
  target_student uuid,
  requested_code_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  book_record public.school_books%rowtype;
  student_record public.students%rowtype;
  checkout_id uuid;
begin
  if actor is null then raise exception 'Sign in to check out a book.'; end if;
  if requested_code_hash is null or requested_code_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'A valid one-time return code is required.';
  end if;

  select * into book_record
  from public.school_books
  where id = target_book and archived_at is null
  for update;
  if not found then raise exception 'This book is unavailable.'; end if;
  if not public.has_school_role(book_record.school_id, array['school_admin', 'academic_coordinator']::public.app_role[]) then
    raise exception 'Only school library staff can check out books.';
  end if;
  if book_record.available_copies < 1 then raise exception 'There are no available copies of this book.'; end if;

  select * into student_record
  from public.students
  where id = target_student
    and school_id = book_record.school_id
    and status = 'active'
  for share;
  if not found then raise exception 'Choose an active student from this school.'; end if;

  if exists (select 1 from public.library_checkouts where library_checkouts.return_code_hash = requested_code_hash) then
    raise exception 'This return code has already been used. Generate a new code and try again.';
  end if;

  update public.school_books
  set available_copies = available_copies - 1,
      updated_by = actor,
      updated_at = timezone('utc', now())
  where id = book_record.id;

  insert into public.library_checkouts (
    school_id, book_id, student_id, return_code_hash, checked_out_by
  ) values (
    book_record.school_id, book_record.id, student_record.id, requested_code_hash, actor
  ) returning id into checkout_id;

  return jsonb_build_object('checkout_id', checkout_id, 'checked_out_at', timezone('utc', now()));
end;
$$;

create or replace function public.return_library_book(return_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor uuid := auth.uid();
  code_hash text;
  checkout_record public.library_checkouts%rowtype;
  book_record public.school_books%rowtype;
begin
  if actor is null then raise exception 'Sign in to process a book return.'; end if;
  if not exists (
    select 1
    from public.school_memberships membership
    where membership.profile_id = actor
      and membership.role in ('school_admin', 'academic_coordinator')
  ) then raise exception 'Only school library staff can process returns.'; end if;
  if return_code is null or length(regexp_replace(return_code, '[^A-Za-z0-9]', '', 'g')) <> 16 then
    raise exception 'Enter the 16-character return code printed below the QR code.';
  end if;

  code_hash := encode(digest(convert_to(upper(regexp_replace(return_code, '[^A-Za-z0-9]', '', 'g')), 'UTF8'), 'sha256'), 'hex');
  select * into checkout_record
  from public.library_checkouts
  where library_checkouts.return_code_hash = code_hash
    and library_checkouts.returned_at is null
  for update;
  if not found then raise exception 'No active checkout matches this code. It may be invalid or already returned.'; end if;
  if not public.has_school_role(checkout_record.school_id, array['school_admin', 'academic_coordinator']::public.app_role[]) then
    raise exception 'You are not authorized to process returns for this school.';
  end if;

  select * into book_record from public.school_books where id = checkout_record.book_id for update;
  if not found then raise exception 'The book record for this checkout is unavailable.'; end if;
  update public.library_checkouts
  set returned_by = actor, returned_at = timezone('utc', now())
  where id = checkout_record.id and returned_at is null;
  if not found then raise exception 'This book has already been returned.'; end if;
  update public.school_books
  set available_copies = least(total_copies, available_copies + 1),
      updated_by = actor,
      updated_at = timezone('utc', now())
  where id = book_record.id;

  return jsonb_build_object(
    'checkout_id', checkout_record.id,
    'book_title', book_record.title,
    'returned_at', timezone('utc', now())
  );
end;
$$;

revoke all on function public.checkout_library_book(uuid, uuid, text) from public, anon;
revoke all on function public.return_library_book(text) from public, anon;
grant execute on function public.checkout_library_book(uuid, uuid, text) to authenticated;
grant execute on function public.return_library_book(text) to authenticated;

create trigger audit_library_checkouts_change
  after insert or update or delete on public.library_checkouts
  for each row execute function public.log_school_record_change();
create trigger enforce_maintenance_library_checkouts
  before insert or update or delete on public.library_checkouts
  for each row execute function public.enforce_maintenance_write();
