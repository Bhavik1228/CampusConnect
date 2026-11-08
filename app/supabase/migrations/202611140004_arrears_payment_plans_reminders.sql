create table public.student_fee_payment_plans (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  invoice_id uuid not null,
  balance_at_setup numeric(12, 2) not null check (balance_at_setup > 0),
  installment_count integer not null check (installment_count between 2 and 24),
  frequency text not null check (frequency in ('weekly', 'biweekly', 'monthly')),
  status text not null default 'active' check (status in ('active', 'completed', 'cancelled')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  completed_at timestamptz,
  cancelled_at timestamptz,
  unique (school_id, id),
  foreign key (school_id, invoice_id)
    references public.student_fee_invoices(school_id, id) on delete restrict,
  check ((status = 'cancelled') = (cancelled_at is not null)),
  check ((status = 'completed') = (completed_at is not null))
);

create unique index student_fee_payment_plans_one_active_invoice
  on public.student_fee_payment_plans(school_id, invoice_id)
  where status = 'active';

create table public.student_fee_payment_plan_installments (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  plan_id uuid not null,
  invoice_id uuid not null,
  installment_number integer not null check (installment_number between 1 and 24),
  due_on date not null,
  amount numeric(12, 2) not null check (amount > 0),
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (school_id, plan_id, installment_number),
  foreign key (school_id, plan_id)
    references public.student_fee_payment_plans(school_id, id) on delete cascade,
  foreign key (school_id, invoice_id)
    references public.student_fee_invoices(school_id, id) on delete restrict
);

create index student_fee_plan_installments_due_idx
  on public.student_fee_payment_plan_installments(school_id, due_on, plan_id);

create or replace function public.refresh_student_fee_payment_plan_status()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  affected_school uuid;
  affected_invoice uuid;
  invoice_balance numeric;
begin
  if tg_op = 'DELETE' then
    affected_school := old.school_id;
    affected_invoice := old.invoice_id;
  else
    affected_school := new.school_id;
    affected_invoice := new.invoice_id;
  end if;

  select greatest(0,
    invoice.amount - invoice.discount_amount
    + coalesce((
      select sum(case when adjustment.adjustment_type = 'charge'
        then adjustment.amount else -adjustment.amount end)
      from public.student_fee_adjustments adjustment
      where adjustment.school_id = invoice.school_id
        and adjustment.invoice_id = invoice.id
    ), 0)
    - coalesce((
      select sum(allocation.amount)
      from public.student_fee_payment_allocations allocation
      where allocation.school_id = invoice.school_id
        and allocation.invoice_id = invoice.id
    ), 0)
  ) into invoice_balance
  from public.student_fee_invoices invoice
  where invoice.school_id = affected_school and invoice.id = affected_invoice;

  if invoice_balance <= 0 then
    update public.student_fee_payment_plans
    set status = 'completed', completed_at = timezone('utc', now())
    where school_id = affected_school
      and invoice_id = affected_invoice
      and status = 'active';
  elsif not exists (
    select 1 from public.student_fee_payment_plans plan
    where plan.school_id = affected_school
      and plan.invoice_id = affected_invoice
      and plan.status = 'active'
  ) then
    update public.student_fee_payment_plans
    set status = 'active', completed_at = null
    where id = (
      select plan.id
      from public.student_fee_payment_plans plan
      where plan.school_id = affected_school
        and plan.invoice_id = affected_invoice
        and plan.status = 'completed'
      order by plan.created_at desc
      limit 1
    );
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger refresh_student_fee_payment_plan_status
  after insert or update or delete on public.student_fee_payment_allocations
  for each row execute function public.refresh_student_fee_payment_plan_status();

create table public.fee_reminder_cadences (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  days_after_due integer not null check (days_after_due between 0 and 365),
  channel text not null check (channel in ('email', 'phone', 'sms', 'in_app')),
  is_active boolean not null default true,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  unique (school_id, days_after_due, channel)
);

create table public.fee_reminder_logs (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  invoice_id uuid not null,
  cadence_id uuid not null,
  channel text not null check (channel in ('email', 'phone', 'sms', 'in_app')),
  contact_note text not null default '' check (char_length(contact_note) <= 1000),
  contacted_at timestamptz not null default timezone('utc', now()),
  recorded_by uuid not null references public.profiles(id),
  unique (school_id, invoice_id, cadence_id),
  foreign key (school_id, invoice_id)
    references public.student_fee_invoices(school_id, id) on delete cascade,
  foreign key (school_id, cadence_id)
    references public.fee_reminder_cadences(school_id, id) on delete cascade
);

alter table public.student_fee_payment_plans enable row level security;
alter table public.student_fee_payment_plan_installments enable row level security;
alter table public.fee_reminder_cadences enable row level security;
alter table public.fee_reminder_logs enable row level security;

create policy "Finance staff read payment plans"
  on public.student_fee_payment_plans for select to authenticated
  using (public.can_access_finance(school_id));

create policy "Finance staff read plan installments"
  on public.student_fee_payment_plan_installments for select to authenticated
  using (public.can_access_finance(school_id));

create policy "Finance staff read reminder cadences"
  on public.fee_reminder_cadences for select to authenticated
  using (public.can_access_finance(school_id));

create policy "Finance managers manage reminder cadences"
  on public.fee_reminder_cadences for all to authenticated
  using (public.can_manage_finance(school_id))
  with check (public.can_manage_finance(school_id));

create policy "Finance staff read reminder logs"
  on public.fee_reminder_logs for select to authenticated
  using (public.can_access_finance(school_id));

grant select on public.student_fee_payment_plans, public.student_fee_payment_plan_installments,
  public.fee_reminder_cadences, public.fee_reminder_logs to authenticated;
grant insert, update on public.fee_reminder_cadences to authenticated;

insert into public.fee_reminder_cadences(school_id, days_after_due, channel, created_by)
select school.id, cadence.days_after_due, cadence.channel, school.created_by
from public.schools school
cross join (values
  (0, 'email'),
  (7, 'email'),
  (30, 'phone')
) as cadence(days_after_due, channel)
on conflict (school_id, days_after_due, channel) do nothing;

create or replace function public.create_student_fee_payment_plan(
  target_invoice uuid,
  plan_installment_count integer,
  plan_frequency text,
  first_due_date date
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  selected_invoice public.student_fee_invoices%rowtype;
  invoice_balance numeric;
  new_plan_id uuid;
  installment_number integer;
  installment_amount numeric;
begin
  select invoice.* into selected_invoice
  from public.student_fee_invoices invoice
  where invoice.id = target_invoice
  for update;
  if not found then
    raise exception 'The invoice does not exist.';
  end if;
  if not public.can_manage_finance(selected_invoice.school_id) then
    raise exception 'You do not have permission to create payment plans.';
  end if;
  if selected_invoice.status <> 'issued'
    or plan_installment_count is null
    or plan_installment_count not between 2 and 24
    or plan_frequency is null
    or plan_frequency not in ('weekly', 'biweekly', 'monthly')
    or first_due_date is null
    or first_due_date < current_date then
    raise exception 'Enter an open invoice, 2–24 installments, a valid frequency, and a current or future first due date.';
  end if;
  if exists (
    select 1 from public.student_fee_payment_plans plan
    where plan.school_id = selected_invoice.school_id
      and plan.invoice_id = selected_invoice.id
      and plan.status = 'active'
  ) then
    raise exception 'An active payment plan already exists for this invoice.';
  end if;

  select greatest(0,
    selected_invoice.amount - selected_invoice.discount_amount
    + coalesce((
      select sum(case when adjustment.adjustment_type = 'charge'
        then adjustment.amount else -adjustment.amount end)
      from public.student_fee_adjustments adjustment
      where adjustment.school_id = selected_invoice.school_id
        and adjustment.invoice_id = selected_invoice.id
    ), 0)
    - coalesce((
      select sum(allocation.amount)
      from public.student_fee_payment_allocations allocation
      where allocation.school_id = selected_invoice.school_id
        and allocation.invoice_id = selected_invoice.id
    ), 0)
  ) into invoice_balance;
  if invoice_balance <= 0 then
    raise exception 'The invoice has no remaining balance to schedule.';
  end if;
  if invoice_balance < plan_installment_count * 0.01 then
    raise exception 'The invoice balance is too small for that many positive installments.';
  end if;

  insert into public.student_fee_payment_plans (
    school_id, invoice_id, balance_at_setup, installment_count, frequency, created_by
  ) values (
    selected_invoice.school_id, selected_invoice.id, invoice_balance,
    plan_installment_count, plan_frequency, auth.uid()
  ) returning id into new_plan_id;

  for installment_number in 1..plan_installment_count
  loop
    installment_amount := case
      when installment_number < plan_installment_count
        then round(invoice_balance / plan_installment_count, 2)
      else invoice_balance - round(invoice_balance / plan_installment_count, 2) * (plan_installment_count - 1)
    end;
    insert into public.student_fee_payment_plan_installments (
      school_id, plan_id, invoice_id, installment_number, due_on, amount
    ) values (
      selected_invoice.school_id,
      new_plan_id,
      selected_invoice.id,
      installment_number,
      case plan_frequency
        when 'weekly' then first_due_date + (installment_number - 1) * 7
        when 'biweekly' then first_due_date + (installment_number - 1) * 14
        else (first_due_date + make_interval(months => installment_number - 1))::date
      end,
      installment_amount
    );
  end loop;

  return new_plan_id;
end;
$$;

create or replace function public.cancel_student_fee_payment_plan(target_plan uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  selected_plan public.student_fee_payment_plans%rowtype;
begin
  select plan.* into selected_plan
  from public.student_fee_payment_plans plan
  where plan.id = target_plan
  for update;
  if not found then
    raise exception 'The payment plan does not exist.';
  end if;
  if not public.can_manage_finance(selected_plan.school_id) then
    raise exception 'You do not have permission to cancel this payment plan.';
  end if;
  if selected_plan.status <> 'active' then
    raise exception 'Only an active payment plan can be cancelled.';
  end if;

  update public.student_fee_payment_plans
  set status = 'cancelled', cancelled_at = timezone('utc', now())
  where id = selected_plan.id;
end;
$$;

create or replace function public.record_fee_reminder_contact(
  target_invoice uuid,
  target_cadence uuid,
  contact_channel text,
  contact_note text default ''
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  selected_invoice public.student_fee_invoices%rowtype;
  selected_cadence public.fee_reminder_cadences%rowtype;
  days_overdue integer;
  invoice_balance numeric;
  new_log_id uuid;
begin
  select invoice.* into selected_invoice
  from public.student_fee_invoices invoice
  where invoice.id = target_invoice
  for update;
  if not found then
    raise exception 'The invoice does not exist.';
  end if;
  if not public.can_manage_finance(selected_invoice.school_id) then
    raise exception 'You do not have permission to log reminder contacts.';
  end if;
  select cadence.* into selected_cadence
  from public.fee_reminder_cadences cadence
  where cadence.school_id = selected_invoice.school_id
    and cadence.id = target_cadence
    and cadence.is_active;
  if not found or selected_cadence.channel <> contact_channel then
    raise exception 'Choose an active reminder cadence and its configured channel.';
  end if;

  days_overdue := current_date - selected_invoice.due_on;
  select greatest(0,
    selected_invoice.amount - selected_invoice.discount_amount
    + coalesce((
      select sum(case when adjustment.adjustment_type = 'charge'
        then adjustment.amount else -adjustment.amount end)
      from public.student_fee_adjustments adjustment
      where adjustment.school_id = selected_invoice.school_id
        and adjustment.invoice_id = selected_invoice.id
    ), 0)
    - coalesce((
      select sum(allocation.amount)
      from public.student_fee_payment_allocations allocation
      where allocation.school_id = selected_invoice.school_id
        and allocation.invoice_id = selected_invoice.id
    ), 0)
  ) into invoice_balance;
  if selected_invoice.status <> 'issued'
    or invoice_balance <= 0
    or days_overdue < selected_cadence.days_after_due then
    raise exception 'The invoice does not currently qualify for this reminder cadence.';
  end if;

  insert into public.fee_reminder_logs (
    school_id, invoice_id, cadence_id, channel, contact_note, recorded_by
  ) values (
    selected_invoice.school_id, selected_invoice.id, selected_cadence.id,
    selected_cadence.channel, left(trim(coalesce(contact_note, '')), 1000), auth.uid()
  ) returning id into new_log_id;
  return new_log_id;
end;
$$;

revoke all on function public.create_student_fee_payment_plan(uuid, integer, text, date) from public;
revoke all on function public.cancel_student_fee_payment_plan(uuid) from public;
revoke all on function public.record_fee_reminder_contact(uuid, uuid, text, text) from public;
grant execute on function public.create_student_fee_payment_plan(uuid, integer, text, date) to authenticated;
grant execute on function public.cancel_student_fee_payment_plan(uuid) to authenticated;
grant execute on function public.record_fee_reminder_contact(uuid, uuid, text, text) to authenticated;

create or replace view public.student_fee_payment_plan_schedule
with (security_barrier = true)
as
  select
    installment.id,
    installment.school_id,
    installment.plan_id,
    installment.invoice_id,
    installment.installment_number,
    installment.due_on,
    installment.amount,
    least(
      installment.amount,
      greatest(0, coalesce(invoice_payments.allocated_total, 0) - coalesce(prior_installments.amount_before, 0))
    ) as paid_amount,
    greatest(
      0,
      installment.amount - least(
        installment.amount,
        greatest(0, coalesce(invoice_payments.allocated_total, 0) - coalesce(prior_installments.amount_before, 0))
      )
    ) as balance_amount,
    case
      when installment.amount <= greatest(0, coalesce(invoice_payments.allocated_total, 0) - coalesce(prior_installments.amount_before, 0)) then 'paid'
      when installment.due_on < current_date then 'overdue'
      else 'scheduled'
    end as status
  from public.student_fee_payment_plan_installments installment
  join public.student_fee_payment_plans plan
    on plan.school_id = installment.school_id and plan.id = installment.plan_id
  left join lateral (
    select sum(allocation.amount) as allocated_total
    from public.student_fee_payment_allocations allocation
    where allocation.school_id = installment.school_id
      and allocation.invoice_id = installment.invoice_id
  ) invoice_payments on true
  left join lateral (
    select sum(previous.amount) as amount_before
    from public.student_fee_payment_plan_installments previous
    where previous.school_id = installment.school_id
      and previous.plan_id = installment.plan_id
      and previous.installment_number < installment.installment_number
  ) prior_installments on true
  where public.can_access_finance(installment.school_id);

grant select on public.student_fee_payment_plan_schedule to authenticated;
