alter type public.app_role add value if not exists 'accounts_payable_officer';
alter type public.app_role add value if not exists 'auditor';
alter type public.app_role add value if not exists 'librarian';

create or replace function public.is_school_auditor(target_school uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.school_memberships membership
    where membership.school_id = target_school
      and membership.profile_id = auth.uid()
      and membership.role::text = 'auditor'
  );
$$;

revoke all on function public.is_school_auditor(uuid) from public;
grant execute on function public.is_school_auditor(uuid) to authenticated;

create or replace function public.can_access_finance(target_school uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.school_memberships membership
    where membership.school_id = target_school
      and membership.profile_id = auth.uid()
      and membership.role::text in (
        'school_admin', 'finance_manager', 'accountant', 'bursar', 'cashier', 'auditor'
      )
  );
$$;

revoke all on function public.can_access_finance(uuid) from public;
grant execute on function public.can_access_finance(uuid) to authenticated;

drop policy if exists "Admins read audit logs" on public.audit_logs;
create policy "Admins and auditors read audit logs"
  on public.audit_logs for select to authenticated
  using (
    public.has_school_role(school_id, array['school_admin']::public.app_role[])
    or public.is_school_auditor(school_id)
  );

create policy "Auditors read school member profiles"
  on public.profiles for select to authenticated
  using (
    exists (
      select 1
      from public.school_memberships membership
      where membership.profile_id = profiles.id
        and public.is_school_auditor(membership.school_id)
    )
  );

create or replace function public.can_manage_school_library(target_school uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.school_memberships membership
    where membership.school_id = target_school
      and membership.profile_id = auth.uid()
      and membership.role::text in ('school_admin', 'academic_coordinator', 'librarian')
  );
$$;

revoke all on function public.can_manage_school_library(uuid) from public;
grant execute on function public.can_manage_school_library(uuid) to authenticated;

drop policy if exists "School library managers manage books" on public.school_books;
create policy "School library managers manage books"
  on public.school_books for all to authenticated
  using (public.can_manage_school_library(school_id))
  with check (public.can_manage_school_library(school_id));

drop policy if exists "Requesters and library managers read requests" on public.library_requests;
create policy "Requesters and library managers read requests"
  on public.library_requests for select to authenticated
  using (
    requester_id = auth.uid()
    or public.can_manage_school_library(school_id)
  );

drop policy if exists "Library managers and borrower students read checkouts" on public.library_checkouts;
create policy "Library managers and borrower students read checkouts"
  on public.library_checkouts for select to authenticated
  using (
    public.can_manage_school_library(school_id)
    or exists (
      select 1
      from public.students student
      where student.id = library_checkouts.student_id
        and student.school_id = library_checkouts.school_id
        and student.profile_id = auth.uid()
    )
  );

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
  if not public.can_manage_school_library(pending_request.school_id) then
    raise exception 'Only authorized library staff can review book requests.';
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
  if not public.can_manage_school_library(book_record.school_id) then
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

  if exists (select 1 from public.library_checkouts where return_code_hash = requested_code_hash) then
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
  if not public.can_manage_school_library(checkout_record.school_id) then
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
