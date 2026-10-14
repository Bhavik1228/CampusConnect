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

  code_hash := encode(
    extensions.digest(
      convert_to(upper(regexp_replace(return_code, '[^A-Za-z0-9]', '', 'g')), 'UTF8'),
      'sha256'::text
    ),
    'hex'
  );
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

revoke all on function public.return_library_book(text) from public;
grant execute on function public.return_library_book(text) to anon, authenticated;
notify pgrst, 'reload schema';
