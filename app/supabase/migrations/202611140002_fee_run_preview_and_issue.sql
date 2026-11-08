create table public.student_fee_runs (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  fee_structure_id uuid not null,
  description text not null check (char_length(trim(description)) between 2 and 240),
  amount numeric(12, 2) not null check (amount > 0),
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  issued_on date not null,
  due_on date not null,
  status text not null default 'draft' check (status in ('draft', 'issued', 'cancelled')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  issued_at timestamptz,
  issued_by uuid references public.profiles(id),
  unique (school_id, id),
  foreign key (school_id, fee_structure_id)
    references public.fee_structures(school_id, id) on delete restrict,
  check (due_on >= issued_on),
  check ((status = 'issued') = (issued_at is not null and issued_by is not null))
);

create index student_fee_runs_school_created_idx
  on public.student_fee_runs(school_id, created_at desc);

create table public.student_fee_run_items (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  run_id uuid not null,
  student_id uuid not null,
  amount numeric(12, 2) not null check (amount > 0),
  discount_amount numeric(12, 2) not null default 0
    check (discount_amount >= 0 and discount_amount <= amount),
  discount_reason text,
  currency_code text not null check (currency_code ~ '^[A-Z]{3}$'),
  invoice_id uuid unique,
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (school_id, run_id, student_id),
  foreign key (school_id, run_id)
    references public.student_fee_runs(school_id, id) on delete cascade,
  foreign key (school_id, student_id)
    references public.students(school_id, id) on delete restrict,
  foreign key (school_id, invoice_id)
    references public.student_fee_invoices(school_id, id) on delete restrict,
  check ((discount_amount = 0) = (discount_reason is null))
);

create index student_fee_run_items_run_idx
  on public.student_fee_run_items(school_id, run_id, student_id);

alter table public.student_fee_runs enable row level security;
alter table public.student_fee_run_items enable row level security;

create policy "Finance staff read fee runs"
  on public.student_fee_runs for select to authenticated
  using (public.can_access_finance(school_id));

create policy "Finance staff read fee run items"
  on public.student_fee_run_items for select to authenticated
  using (public.can_access_finance(school_id));

grant select on public.student_fee_runs, public.student_fee_run_items to authenticated;

create or replace function public.preview_student_fee_run(
  target_school uuid,
  target_fee_structure uuid,
  invoice_issued_on date,
  invoice_due_on date
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  selected_structure public.fee_structures%rowtype;
  final_due_on date;
  new_run_id uuid;
  student record;
  applied_rule_id uuid;
  applied_rule_name text;
  calculated_discount numeric;
  item_discount_reason text;
  student_count integer := 0;
begin
  if not public.can_manage_finance(target_school) then
    raise exception 'You do not have permission to preview fee runs for this school.';
  end if;
  if invoice_issued_on is null then
    raise exception 'Enter an invoice issue date.';
  end if;

  select structure.* into selected_structure
  from public.fee_structures structure
  where structure.school_id = target_school
    and structure.id = target_fee_structure
    and structure.is_active;
  if not found then
    raise exception 'Choose an active fee structure.';
  end if;

  final_due_on := coalesce(invoice_due_on, selected_structure.due_date);
  if final_due_on is null or final_due_on < invoice_issued_on then
    raise exception 'Enter a due date on or after the issue date.';
  end if;

  insert into public.student_fee_runs (
    school_id, fee_structure_id, description, amount, currency_code,
    issued_on, due_on, created_by
  ) values (
    target_school, selected_structure.id, selected_structure.name,
    selected_structure.amount, selected_structure.currency_code,
    invoice_issued_on, final_due_on, auth.uid()
  ) returning id into new_run_id;

  for student in
    select person.id
    from public.students person
    where person.school_id = target_school and person.status = 'active'
    order by person.last_name, person.first_name, person.id
  loop
    select applied.rule_id, applied.rule_name, applied.discount_amount
    into applied_rule_id, applied_rule_name, calculated_discount
    from public.get_student_fee_discount(
      target_school,
      student.id,
      selected_structure.id,
      selected_structure.amount,
      selected_structure.currency_code
    ) applied;

    item_discount_reason := case
      when applied_rule_id is not null and coalesce(calculated_discount, 0) > 0
        then 'Automatic: ' || applied_rule_name
      else null
    end;

    insert into public.student_fee_run_items (
      school_id, run_id, student_id, amount, discount_amount,
      discount_reason, currency_code
    ) values (
      target_school, new_run_id, student.id, selected_structure.amount,
      coalesce(calculated_discount, 0), item_discount_reason, selected_structure.currency_code
    );
    student_count := student_count + 1;
  end loop;

  if student_count = 0 then
    raise exception 'There are no active students to include in this fee run.';
  end if;

  return new_run_id;
end;
$$;

create or replace function public.issue_student_fee_run(target_run uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  selected_run public.student_fee_runs%rowtype;
  run_item public.student_fee_run_items%rowtype;
  new_invoice_id uuid;
  invoice_number text;
  issued_count integer := 0;
begin
  select fee_run.* into selected_run
  from public.student_fee_runs fee_run
  where fee_run.id = target_run
  for update;
  if not found then
    raise exception 'The fee run does not exist.';
  end if;
  if not public.can_manage_finance(selected_run.school_id) then
    raise exception 'You do not have permission to issue this fee run.';
  end if;
  if selected_run.status <> 'draft' then
    raise exception 'Only a draft fee run can be issued.';
  end if;

  for run_item in
    select item.*
    from public.student_fee_run_items item
    where item.school_id = selected_run.school_id
      and item.run_id = selected_run.id
      and item.invoice_id is null
    order by item.student_id
  loop
    invoice_number := 'INV-' || to_char(selected_run.issued_on, 'YYYYMMDD')
      || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    insert into public.student_fee_invoices (
      school_id, student_id, fee_structure_id, invoice_number, description, amount,
      discount_amount, discount_reason, currency_code, issued_on, due_on, created_by
    ) values (
      selected_run.school_id, run_item.student_id, selected_run.fee_structure_id,
      invoice_number, selected_run.description, run_item.amount, run_item.discount_amount,
      run_item.discount_reason, run_item.currency_code, selected_run.issued_on,
      selected_run.due_on, auth.uid()
    ) returning id into new_invoice_id;

    update public.student_fee_run_items
    set invoice_id = new_invoice_id
    where id = run_item.id;
    issued_count := issued_count + 1;
  end loop;

  if issued_count = 0 then
    raise exception 'This fee run contains no issuable invoices.';
  end if;

  update public.student_fee_runs
  set status = 'issued', issued_at = timezone('utc', now()), issued_by = auth.uid()
  where id = selected_run.id;
  return issued_count;
end;
$$;

create or replace function public.cancel_student_fee_run(target_run uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  selected_run public.student_fee_runs%rowtype;
begin
  select fee_run.* into selected_run
  from public.student_fee_runs fee_run
  where fee_run.id = target_run
  for update;
  if not found then
    raise exception 'The fee run does not exist.';
  end if;
  if not public.can_manage_finance(selected_run.school_id) then
    raise exception 'You do not have permission to cancel this fee run.';
  end if;
  if selected_run.status <> 'draft' then
    raise exception 'Only a draft fee run can be cancelled.';
  end if;

  update public.student_fee_runs
  set status = 'cancelled'
  where id = selected_run.id;
end;
$$;

revoke all on function public.preview_student_fee_run(uuid, uuid, date, date) from public;
revoke all on function public.issue_student_fee_run(uuid) from public;
revoke all on function public.cancel_student_fee_run(uuid) from public;
grant execute on function public.preview_student_fee_run(uuid, uuid, date, date) to authenticated;
grant execute on function public.issue_student_fee_run(uuid) to authenticated;
grant execute on function public.cancel_student_fee_run(uuid) to authenticated;
