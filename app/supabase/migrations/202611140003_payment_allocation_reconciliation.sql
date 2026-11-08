create or replace function public.replace_student_fee_payment_allocations(
  target_payment uuid,
  invoice_allocations jsonb
)
returns numeric
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  selected_payment public.student_fee_payments%rowtype;
  allocation jsonb;
  allocation_invoice uuid;
  allocation_amount numeric;
  invoice_currency text;
  total_allocated numeric := 0;
  unlocked_balance numeric;
begin
  select payment.* into selected_payment
  from public.student_fee_payments payment
  where payment.id = target_payment
  for update;
  if not found then
    raise exception 'The payment does not exist.';
  end if;
  if not public.can_manage_finance(selected_payment.school_id) then
    raise exception 'You do not have permission to reconcile payment allocations.';
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

  for allocation in
    select value from jsonb_array_elements(invoice_allocations)
    order by value ->> 'invoice_id'
  loop
    allocation_invoice := (allocation ->> 'invoice_id')::uuid;
    allocation_amount := (allocation ->> 'amount')::numeric;
    if allocation_amount is null or allocation_amount <= 0
      or allocation_amount <> round(allocation_amount, 2) then
      raise exception 'Each allocation must be a positive amount with at most two decimal places.';
    end if;

    perform 1
    from public.student_fee_invoices invoice
    where invoice.school_id = selected_payment.school_id
      and invoice.id = allocation_invoice
      and invoice.student_id = selected_payment.student_id
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
        where adjustment.school_id = invoice.school_id
          and adjustment.invoice_id = invoice.id
      ), 0)
      - coalesce((
        select sum(payment_allocation.amount)
        from public.student_fee_payment_allocations payment_allocation
        where payment_allocation.school_id = invoice.school_id
          and payment_allocation.invoice_id = invoice.id
          and payment_allocation.payment_id <> selected_payment.id
      ), 0),
      invoice.currency_code
    into unlocked_balance, invoice_currency
    from public.student_fee_invoices invoice
    where invoice.school_id = selected_payment.school_id
      and invoice.id = allocation_invoice;

    if allocation_amount > greatest(0, unlocked_balance) then
      raise exception 'An allocation cannot exceed the invoice balance after other payments.';
    end if;
    if invoice_currency <> selected_payment.currency_code then
      raise exception 'A payment can only be allocated to invoices in the same currency.';
    end if;
    total_allocated := total_allocated + allocation_amount;
  end loop;

  if total_allocated > selected_payment.amount then
    raise exception 'Allocations cannot exceed the payment amount.';
  end if;

  delete from public.student_fee_payment_allocations
  where school_id = selected_payment.school_id
    and payment_id = selected_payment.id;

  for allocation in select value from jsonb_array_elements(invoice_allocations)
  loop
    insert into public.student_fee_payment_allocations (
      school_id, student_id, payment_id, invoice_id, amount
    ) values (
      selected_payment.school_id,
      selected_payment.student_id,
      selected_payment.id,
      (allocation ->> 'invoice_id')::uuid,
      (allocation ->> 'amount')::numeric
    );
  end loop;

  return selected_payment.amount - total_allocated;
end;
$$;

revoke all on function public.replace_student_fee_payment_allocations(uuid, jsonb) from public;
grant execute on function public.replace_student_fee_payment_allocations(uuid, jsonb) to authenticated;
