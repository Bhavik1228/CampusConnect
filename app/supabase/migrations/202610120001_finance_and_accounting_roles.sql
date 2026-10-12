alter type public.app_role add value if not exists 'finance_manager';
alter type public.app_role add value if not exists 'accountant';
alter type public.app_role add value if not exists 'bursar';
alter type public.app_role add value if not exists 'cashier';

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
        'school_admin', 'finance_manager', 'accountant', 'bursar', 'cashier'
      )
  );
$$;

create or replace function public.can_manage_finance(target_school uuid)
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
        'school_admin', 'finance_manager', 'accountant', 'bursar'
      )
  );
$$;

revoke all on function public.can_access_finance(uuid) from public;
revoke all on function public.can_manage_finance(uuid) from public;
grant execute on function public.can_access_finance(uuid) to authenticated;
grant execute on function public.can_manage_finance(uuid) to authenticated;

create view public.finance_student_directory
with (security_barrier = true)
as
  select student.id, student.school_id, student.student_number, student.first_name, student.last_name
  from public.students student
  where public.can_access_finance(student.school_id);

grant select on public.finance_student_directory to authenticated;

create policy "School admins read member profiles"
  on public.profiles for select to authenticated
  using (
    exists (
      select 1 from public.school_memberships membership
      where membership.profile_id = profiles.id
        and public.has_school_role(membership.school_id, array['school_admin']::public.app_role[])
    )
  );

create table public.fee_structures (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 120),
  description text,
  amount numeric(12, 2) not null check (amount >= 0),
  currency_code text not null default 'USD' check (currency_code ~ '^[A-Z]{3}$'),
  academic_year_id uuid,
  due_date date,
  is_active boolean not null default true,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, academic_year_id)
    references public.academic_years(school_id, id) on delete set null (academic_year_id)
);

create table public.student_fee_invoices (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null,
  fee_structure_id uuid,
  invoice_number text not null,
  description text not null check (char_length(trim(description)) between 2 and 240),
  amount numeric(12, 2) not null check (amount > 0),
  discount_amount numeric(12, 2) not null default 0 check (discount_amount >= 0),
  discount_reason text,
  currency_code text not null default 'USD' check (currency_code ~ '^[A-Z]{3}$'),
  issued_on date not null default current_date,
  due_on date not null,
  status text not null default 'issued' check (status in ('issued', 'void')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (school_id, invoice_number),
  foreign key (school_id, student_id)
    references public.students(school_id, id) on delete restrict,
  foreign key (school_id, fee_structure_id)
    references public.fee_structures(school_id, id) on delete set null (fee_structure_id),
  check (discount_amount <= amount),
  check (due_on >= issued_on),
  check ((discount_amount = 0) or nullif(trim(discount_reason), '') is not null)
);

create index student_fee_invoices_student_idx
  on public.student_fee_invoices(school_id, student_id, issued_on desc);

create table public.student_fee_adjustments (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  invoice_id uuid not null,
  adjustment_type text not null check (adjustment_type in ('charge', 'credit')),
  amount numeric(12, 2) not null check (amount > 0),
  reason text not null check (char_length(trim(reason)) between 2 and 240),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  foreign key (school_id, invoice_id)
    references public.student_fee_invoices(school_id, id) on delete cascade
);

create index student_fee_adjustments_invoice_idx
  on public.student_fee_adjustments(school_id, invoice_id);

create or replace function public.record_student_fee_adjustment(
  target_school uuid,
  target_invoice uuid,
  p_adjustment_type text,
  p_adjustment_amount numeric,
  p_adjustment_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  invoice_status text;
  invoice_balance numeric;
  new_adjustment_id uuid;
begin
  if not public.can_manage_finance(target_school) then
    raise exception 'You do not have permission to adjust fees for this school.';
  end if;
  if p_adjustment_type is null or p_adjustment_type not in ('charge', 'credit')
    or p_adjustment_amount is null
    or p_adjustment_amount <= 0
    or p_adjustment_amount <> round(p_adjustment_amount, 2)
    or char_length(trim(coalesce(p_adjustment_reason, ''))) not between 2 and 240 then
    raise exception 'Enter a valid adjustment type, amount, and reason.';
  end if;

  select invoice.status into invoice_status
  from public.student_fee_invoices invoice
  where invoice.school_id = target_school and invoice.id = target_invoice
  for update;
  if not found or invoice_status <> 'issued' then
    raise exception 'The invoice is not open for adjustments.';
  end if;

  select invoice.amount - invoice.discount_amount
    + coalesce((
      select sum(case when adjustment.adjustment_type = 'charge'
        then adjustment.amount else -adjustment.amount end)
      from public.student_fee_adjustments adjustment
      where adjustment.school_id = invoice.school_id and adjustment.invoice_id = invoice.id
    ), 0)
    - coalesce((
      select sum(payment_allocation.amount)
      from public.student_fee_payment_allocations payment_allocation
      where payment_allocation.school_id = invoice.school_id
        and payment_allocation.invoice_id = invoice.id
    ), 0)
  into invoice_balance
  from public.student_fee_invoices invoice
  where invoice.school_id = target_school and invoice.id = target_invoice;

  if p_adjustment_type = 'credit' and p_adjustment_amount > invoice_balance then
    raise exception 'A credit cannot exceed the invoice outstanding balance.';
  end if;

  insert into public.student_fee_adjustments (
    school_id, invoice_id, adjustment_type, amount, reason, created_by
  ) values (
    target_school, target_invoice, p_adjustment_type, p_adjustment_amount,
    trim(p_adjustment_reason), auth.uid()
  ) returning id into new_adjustment_id;
  return new_adjustment_id;
end;
$$;

revoke all on function public.record_student_fee_adjustment(uuid, uuid, text, numeric, text) from public;
grant execute on function public.record_student_fee_adjustment(uuid, uuid, text, numeric, text) to authenticated;

create table public.student_fee_payments (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  student_id uuid not null,
  receipt_number text not null,
  amount numeric(12, 2) not null check (amount > 0),
  currency_code text not null default 'USD' check (currency_code ~ '^[A-Z]{3}$'),
  payment_date date not null default current_date,
  payment_method text not null check (payment_method in ('cash', 'bank_transfer', 'card', 'mobile_money', 'cheque', 'other')),
  reference text,
  recorded_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id, student_id),
  unique (school_id, receipt_number),
  foreign key (school_id, student_id)
    references public.students(school_id, id) on delete restrict
);

create index student_fee_payments_student_idx
  on public.student_fee_payments(school_id, student_id, payment_date desc);

create table public.student_fee_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  student_id uuid not null,
  payment_id uuid not null,
  invoice_id uuid not null,
  amount numeric(12, 2) not null check (amount > 0),
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, payment_id, invoice_id),
  foreign key (school_id, payment_id, student_id)
    references public.student_fee_payments(school_id, id, student_id) on delete cascade,
  foreign key (school_id, invoice_id)
    references public.student_fee_invoices(school_id, id) on delete restrict,
  foreign key (school_id, student_id)
    references public.students(school_id, id) on delete restrict
);

create index student_fee_payment_allocations_invoice_idx
  on public.student_fee_payment_allocations(school_id, invoice_id);

create or replace function public.record_student_fee_payment(
  target_school uuid,
  target_student uuid,
  payment_amount numeric,
  payment_currency_code text,
  payment_date date,
  payment_method text,
  payment_reference text,
  invoice_allocations jsonb
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  new_payment_id uuid;
  new_receipt_number text;
  allocation jsonb;
  allocation_invoice uuid;
  allocation_amount numeric;
  invoice_balance numeric;
  invoice_currency text;
  total_allocated numeric := 0;
begin
  if not public.can_access_finance(target_school) then
    raise exception 'You do not have permission to record fees for this school.';
  end if;
  if payment_amount is null or payment_amount <= 0 or payment_amount <> round(payment_amount, 2) then
    raise exception 'Payment amount must be a positive amount with at most two decimal places.';
  end if;
  if payment_currency_code is null or payment_currency_code !~ '^[A-Z]{3}$' then
    raise exception 'Choose a valid three-letter currency code.';
  end if;
  if payment_method is null or payment_method not in ('cash', 'bank_transfer', 'card', 'mobile_money', 'cheque', 'other') then
    raise exception 'Choose a valid payment method.';
  end if;
  if not exists (
    select 1 from public.students
    where school_id = target_school and id = target_student
  ) then
    raise exception 'The selected student does not belong to this school.';
  end if;
  if invoice_allocations is null or jsonb_typeof(invoice_allocations) <> 'array' then
    raise exception 'Payment allocations must be a list.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(invoice_allocations) as allocations(value)
    group by value ->> 'invoice_id'
    having count(*) > 1
  ) then
    raise exception 'Each invoice can only appear once in the payment allocations.';
  end if;

  for allocation in select value from jsonb_array_elements(invoice_allocations)
  loop
    allocation_invoice := (allocation ->> 'invoice_id')::uuid;
    allocation_amount := (allocation ->> 'amount')::numeric;
    if allocation_amount is null or allocation_amount <= 0 or allocation_amount <> round(allocation_amount, 2) then
      raise exception 'Each allocation must be a positive amount with at most two decimal places.';
    end if;

    perform 1
    from public.student_fee_invoices invoice
    where invoice.school_id = target_school
      and invoice.id = allocation_invoice
      and invoice.student_id = target_student
      and invoice.status = 'issued'
    for update;
    if not found then
      raise exception 'An allocation references an invoice that is not open for this student.';
    end if;
    select invoice.amount - invoice.discount_amount
      + coalesce((
        select sum(case when adjustment.adjustment_type = 'charge'
          then adjustment.amount else -adjustment.amount end)
        from public.student_fee_adjustments adjustment
        where adjustment.school_id = invoice.school_id and adjustment.invoice_id = invoice.id
      ), 0)
      - coalesce((
        select sum(payment_allocation.amount)
        from public.student_fee_payment_allocations payment_allocation
        where payment_allocation.school_id = invoice.school_id
          and payment_allocation.invoice_id = invoice.id
      ), 0),
      invoice.currency_code
    into invoice_balance, invoice_currency
    from public.student_fee_invoices invoice
    where invoice.school_id = target_school and invoice.id = allocation_invoice;
    if allocation_amount > invoice_balance then
      raise exception 'An allocation cannot exceed the invoice outstanding balance.';
    end if;
    if invoice_currency <> payment_currency_code then
      raise exception 'A payment can only be allocated to invoices in the same currency.';
    end if;
    total_allocated := total_allocated + allocation_amount;
  end loop;

  if total_allocated > payment_amount then
    raise exception 'Allocated payments cannot exceed the payment amount.';
  end if;

  new_receipt_number := 'RCP-' || to_char(coalesce(payment_date, current_date), 'YYYYMMDD')
    || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  insert into public.student_fee_payments (
    school_id, student_id, receipt_number, amount, currency_code, payment_date,
    payment_method, reference, recorded_by
  ) values (
    target_school, target_student, new_receipt_number, payment_amount, payment_currency_code,
    coalesce(payment_date, current_date), payment_method, nullif(trim(payment_reference), ''), auth.uid()
  ) returning id into new_payment_id;

  for allocation in select value from jsonb_array_elements(invoice_allocations)
  loop
    insert into public.student_fee_payment_allocations (
      school_id, student_id, payment_id, invoice_id, amount
    ) values (
      target_school, target_student, new_payment_id,
      (allocation ->> 'invoice_id')::uuid, (allocation ->> 'amount')::numeric
    );
  end loop;

  return new_receipt_number;
end;
$$;

revoke all on function public.record_student_fee_payment(uuid, uuid, numeric, text, date, text, text, jsonb) from public;
grant execute on function public.record_student_fee_payment(uuid, uuid, numeric, text, date, text, text, jsonb) to authenticated;

alter table public.fee_structures enable row level security;
alter table public.student_fee_invoices enable row level security;
alter table public.student_fee_adjustments enable row level security;
alter table public.student_fee_payments enable row level security;
alter table public.student_fee_payment_allocations enable row level security;

create policy "Finance staff read fee structures"
  on public.fee_structures for select to authenticated
  using (public.can_access_finance(school_id));
create policy "Finance managers manage fee structures"
  on public.fee_structures for all to authenticated
  using (public.can_manage_finance(school_id))
  with check (public.can_manage_finance(school_id));

create policy "Finance staff read student fee invoices"
  on public.student_fee_invoices for select to authenticated
  using (public.can_access_finance(school_id));
create policy "Finance managers create student fee invoices"
  on public.student_fee_invoices for insert to authenticated
  with check (public.can_manage_finance(school_id));
create policy "Finance staff read fee adjustments"
  on public.student_fee_adjustments for select to authenticated
  using (public.can_access_finance(school_id));

create policy "Finance staff read student fee payments"
  on public.student_fee_payments for select to authenticated
  using (public.can_access_finance(school_id));
create policy "Finance staff read payment allocations"
  on public.student_fee_payment_allocations for select to authenticated
  using (public.can_access_finance(school_id));

create trigger set_updated_at before update on public.fee_structures
  for each row execute function public.set_updated_at();

grant select, insert, update on public.fee_structures to authenticated;
grant select, insert on public.student_fee_invoices to authenticated;
grant select on public.student_fee_adjustments to authenticated;
grant select on public.student_fee_payments to authenticated;
grant select on public.student_fee_payment_allocations to authenticated;
