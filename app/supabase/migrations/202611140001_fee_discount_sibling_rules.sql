create table public.fee_discount_rules (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  fee_structure_id uuid,
  name text not null check (char_length(trim(name)) between 2 and 120),
  discount_type text not null check (discount_type in ('percentage', 'fixed')),
  discount_value numeric(12, 2) not null check (discount_value > 0),
  currency_code text not null default 'USD' check (currency_code ~ '^[A-Z]{3}$'),
  minimum_active_siblings integer not null default 0
    check (minimum_active_siblings between 0 and 50),
  is_active boolean not null default true,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, id),
  foreign key (school_id, fee_structure_id)
    references public.fee_structures(school_id, id) on delete cascade,
  check (discount_type <> 'percentage' or discount_value <= 100)
);

create index fee_discount_rules_lookup_idx
  on public.fee_discount_rules(school_id, is_active, minimum_active_siblings);

create unique index fee_discount_rules_scope_unique
  on public.fee_discount_rules(
    school_id,
    coalesce(fee_structure_id, '00000000-0000-0000-0000-000000000000'::uuid),
    minimum_active_siblings,
    discount_type,
    currency_code
  );

alter table public.fee_discount_rules enable row level security;

create policy "Finance staff read fee discount rules"
  on public.fee_discount_rules for select to authenticated
  using (public.can_access_finance(school_id));

create policy "Finance managers manage fee discount rules"
  on public.fee_discount_rules for all to authenticated
  using (public.can_manage_finance(school_id))
  with check (public.can_manage_finance(school_id));

grant select, insert, update on public.fee_discount_rules to authenticated;

create trigger set_updated_at before update on public.fee_discount_rules
  for each row execute function public.set_updated_at();

create or replace function public.get_student_fee_discount(
  target_school uuid,
  target_student uuid,
  target_fee_structure uuid,
  invoice_amount numeric,
  invoice_currency_code text
)
returns table (
  rule_id uuid,
  rule_name text,
  discount_amount numeric,
  active_sibling_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.can_manage_finance(target_school) then
    raise exception 'You do not have permission to calculate fee discounts for this school.';
  end if;
  if invoice_amount is null or invoice_amount <= 0
    or invoice_amount <> round(invoice_amount, 2)
    or invoice_currency_code is null
    or upper(invoice_currency_code) !~ '^[A-Z]{3}$' then
    raise exception 'Enter a valid invoice amount and three-letter currency code.';
  end if;
  if not exists (
    select 1 from public.students student
    where student.school_id = target_school and student.id = target_student
  ) then
    raise exception 'The selected student is not part of this school.';
  end if;
  if target_fee_structure is not null and not exists (
    select 1 from public.fee_structures structure
    where structure.school_id = target_school
      and structure.id = target_fee_structure
      and structure.is_active
  ) then
    raise exception 'The selected fee structure is unavailable.';
  end if;

  return query
  with sibling_count as (
    select count(distinct sibling.id)::integer as active_count
    from public.parent_students family_link
    join public.parent_students student_link
      on student_link.school_id = family_link.school_id
      and student_link.parent_id = family_link.parent_id
      and student_link.student_id = target_student
    join public.students sibling
      on sibling.school_id = family_link.school_id
      and sibling.id = family_link.student_id
    where family_link.school_id = target_school
      and sibling.id <> target_student
      and sibling.status = 'active'
  )
  select
    selected_rule.id,
    selected_rule.name,
    case
      when selected_rule.discount_type = 'percentage'
        then round(invoice_amount * selected_rule.discount_value / 100, 2)
      when selected_rule.discount_type = 'fixed'
        then least(invoice_amount, selected_rule.discount_value)
      else 0::numeric
    end,
    sibling_count.active_count
  from sibling_count
  left join lateral (
    select rule.id, rule.name, rule.discount_type, rule.discount_value
    from public.fee_discount_rules rule
    where rule.school_id = target_school
      and rule.is_active
      and (rule.fee_structure_id is null or rule.fee_structure_id = target_fee_structure)
      and rule.minimum_active_siblings <= sibling_count.active_count
      and (rule.discount_type = 'percentage' or rule.currency_code = upper(invoice_currency_code))
    order by
      (rule.fee_structure_id is not null) desc,
      rule.minimum_active_siblings desc,
      rule.created_at desc
    limit 1
  ) selected_rule on true;
end;
$$;

revoke all on function public.get_student_fee_discount(uuid, uuid, uuid, numeric, text) from public;
grant execute on function public.get_student_fee_discount(uuid, uuid, uuid, numeric, text) to authenticated;

create or replace function public.create_student_fee_invoice(
  target_school uuid,
  target_student uuid,
  target_fee_structure uuid,
  invoice_description text,
  custom_amount numeric,
  custom_currency_code text,
  manual_discount numeric,
  manual_discount_reason text,
  invoice_issued_on date,
  custom_due_on date
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  final_description text;
  final_amount numeric;
  final_currency_code text;
  final_due_on date;
  structure_due_on date;
  automatic_discount numeric := 0;
  automatic_rule_name text;
  total_discount numeric;
  combined_discount_reason text;
  new_invoice_number text;
begin
  if not public.can_manage_finance(target_school) then
    raise exception 'You do not have permission to issue invoices for this school.';
  end if;
  if not exists (
    select 1 from public.students student
    where student.school_id = target_school and student.id = target_student
  ) then
    raise exception 'The selected student is not part of this school.';
  end if;
  if invoice_issued_on is null then
    raise exception 'Enter an invoice issue date.';
  end if;

  if target_fee_structure is not null then
    select structure.name, structure.amount, structure.currency_code, structure.due_date
    into final_description, final_amount, final_currency_code, structure_due_on
    from public.fee_structures structure
    where structure.school_id = target_school
      and structure.id = target_fee_structure
      and structure.is_active;
    if not found then
      raise exception 'The selected fee structure is unavailable.';
    end if;
    final_due_on := coalesce(structure_due_on, custom_due_on);
  else
    final_description := trim(coalesce(invoice_description, ''));
    final_amount := custom_amount;
    final_currency_code := upper(trim(coalesce(custom_currency_code, '')));
    final_due_on := custom_due_on;
  end if;

  if char_length(trim(coalesce(final_description, ''))) not between 2 and 240
    or final_amount is null
    or final_amount <= 0
    or final_amount <> round(final_amount, 2)
    or final_currency_code !~ '^[A-Z]{3}$'
    or final_due_on is null
    or final_due_on < invoice_issued_on then
    raise exception 'Enter a valid invoice description, amount, currency, issue date, and due date.';
  end if;
  if manual_discount is null or manual_discount < 0
    or manual_discount <> round(manual_discount, 2)
    or manual_discount > 0 and char_length(trim(coalesce(manual_discount_reason, ''))) not between 2 and 200 then
    raise exception 'Enter a valid manual discount and its reason.';
  end if;

  select applied.discount_amount, applied.rule_name
  into automatic_discount, automatic_rule_name
  from public.get_student_fee_discount(
    target_school,
    target_student,
    target_fee_structure,
    final_amount,
    final_currency_code
  ) applied;

  total_discount := automatic_discount + manual_discount;
  if total_discount > final_amount then
    raise exception 'The automatic sibling discount and manual discount cannot exceed the invoice amount.';
  end if;
  combined_discount_reason := concat_ws(
    ' · ',
    case when automatic_rule_name is not null then 'Automatic: ' || automatic_rule_name end,
    case when manual_discount > 0 then trim(manual_discount_reason) end
  );
  if total_discount > 0 and char_length(combined_discount_reason) > 240 then
    raise exception 'The combined discount reason must be 240 characters or fewer.';
  end if;

  new_invoice_number := 'INV-' || to_char(invoice_issued_on, 'YYYYMMDD')
    || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  insert into public.student_fee_invoices (
    school_id, student_id, fee_structure_id, invoice_number, description, amount,
    discount_amount, discount_reason, currency_code, issued_on, due_on, created_by
  ) values (
    target_school, target_student, target_fee_structure, new_invoice_number,
    final_description, final_amount, total_discount,
    case when total_discount > 0 then combined_discount_reason end,
    final_currency_code, invoice_issued_on, final_due_on, auth.uid()
  );

  return new_invoice_number;
end;
$$;

drop policy if exists "Finance managers create student fee invoices" on public.student_fee_invoices;
revoke insert on public.student_fee_invoices from authenticated;
revoke all on function public.create_student_fee_invoice(uuid, uuid, uuid, text, numeric, text, numeric, text, date, date) from public;
grant execute on function public.create_student_fee_invoice(uuid, uuid, uuid, text, numeric, text, numeric, text, date, date) to authenticated;
