create table public.admission_offer_tracking (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null,
  application_id uuid not null,
  offer_status text not null default 'not_offered'
    check (offer_status in ('not_offered', 'offered', 'accepted', 'declined', 'expired')),
  offer_sent_at date,
  offer_expires_at date,
  offer_responded_at date,
  deposit_status text not null default 'not_required'
    check (deposit_status in ('not_required', 'pending', 'partially_received', 'received', 'waived')),
  deposit_amount numeric(12, 2) not null default 0 check (deposit_amount >= 0),
  deposit_received numeric(12, 2) not null default 0 check (deposit_received >= 0),
  deposit_currency text not null default 'USD' check (deposit_currency ~ '^[A-Z]{3}$'),
  deposit_due_at date,
  deposit_received_at date,
  payment_reference text check (payment_reference is null or char_length(payment_reference) <= 120),
  note text not null default '' check (char_length(note) <= 1000),
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (school_id, application_id),
  foreign key (school_id, application_id)
    references public.admission_applications(school_id, id) on delete cascade,
  check (deposit_received <= deposit_amount),
  check (
    (deposit_status in ('not_required', 'waived') and deposit_amount = 0 and deposit_received = 0)
    or (deposit_status = 'pending' and deposit_amount > 0 and deposit_received = 0)
    or (deposit_status = 'partially_received' and deposit_amount > 0 and deposit_received > 0 and deposit_received < deposit_amount)
    or (deposit_status = 'received' and deposit_amount > 0 and deposit_received = deposit_amount)
  ),
  check (deposit_received = 0 or (deposit_received_at is not null and payment_reference is not null))
);

alter table public.admission_offer_tracking enable row level security;
revoke all on public.admission_offer_tracking from public, anon, authenticated;
create policy "Admissions staff read offer tracking"
  on public.admission_offer_tracking for select to authenticated
  using (public.is_admissions_officer(school_id));
grant select on public.admission_offer_tracking to authenticated;

create or replace function public.save_admission_offer_tracking(
  target_application uuid,
  tracking_payload jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  application_record public.admission_applications%rowtype;
  previous_offer_status text;
  next_offer_status text;
  next_offer_sent_at date;
  next_offer_expires_at date;
  next_offer_responded_at date;
  next_deposit_status text;
  next_deposit_amount numeric(12, 2);
  next_deposit_received numeric(12, 2);
  next_deposit_currency text;
  next_deposit_due_at date;
  next_deposit_received_at date;
  next_payment_reference text;
  next_note text;
begin
  select * into application_record
  from public.admission_applications
  where id = target_application
  for update;
  if not found or not public.is_admissions_officer(application_record.school_id) then
    raise exception 'Application not found or admissions staff authorization is required.';
  end if;
  if application_record.status not in ('accepted', 'registered') then
    raise exception 'Move the application to Accepted before tracking an offer or deposit.';
  end if;
  if jsonb_typeof(tracking_payload) is distinct from 'object' then
    raise exception 'Provide valid offer and deposit tracking details.';
  end if;

  next_offer_status := tracking_payload ->> 'offer_status';
  next_offer_sent_at := nullif(tracking_payload ->> 'offer_sent_at', '')::date;
  next_offer_expires_at := nullif(tracking_payload ->> 'offer_expires_at', '')::date;
  next_offer_responded_at := nullif(tracking_payload ->> 'offer_responded_at', '')::date;
  next_deposit_status := tracking_payload ->> 'deposit_status';
  next_deposit_amount := coalesce(nullif(tracking_payload ->> 'deposit_amount', '')::numeric, 0);
  next_deposit_received := coalesce(nullif(tracking_payload ->> 'deposit_received', '')::numeric, 0);
  next_deposit_currency := tracking_payload ->> 'deposit_currency';
  next_deposit_due_at := nullif(tracking_payload ->> 'deposit_due_at', '')::date;
  next_deposit_received_at := nullif(tracking_payload ->> 'deposit_received_at', '')::date;
  next_payment_reference := nullif(trim(tracking_payload ->> 'payment_reference'), '');
  next_note := coalesce(tracking_payload ->> 'note', '');

  if next_offer_status not in ('not_offered', 'offered', 'accepted', 'declined', 'expired')
    or next_deposit_status not in ('not_required', 'pending', 'partially_received', 'received', 'waived')
    or next_deposit_currency !~ '^[A-Z]{3}$'
    or next_deposit_amount < 0 or next_deposit_received < 0
    or next_deposit_received > next_deposit_amount
    or char_length(next_note) > 1000
    or (next_payment_reference is not null and char_length(next_payment_reference) > 120) then
    raise exception 'Provide valid offer and deposit values.';
  end if;
  if next_offer_status <> 'not_offered' and next_offer_sent_at is null then
    raise exception 'Enter the date the offer was sent.';
  end if;
  if next_offer_status in ('accepted', 'declined') and next_offer_responded_at is null then
    raise exception 'Enter the date the family responded to the offer.';
  end if;
  if next_offer_expires_at is not null and next_offer_sent_at is not null
    and next_offer_expires_at < next_offer_sent_at then
    raise exception 'The offer expiry date cannot be before the sent date.';
  end if;
  if next_offer_status = 'expired' and next_offer_expires_at is null then
    raise exception 'Enter the expiry date for an expired offer.';
  end if;
  if not (
    (next_deposit_status in ('not_required', 'waived') and next_deposit_amount = 0 and next_deposit_received = 0)
    or (next_deposit_status = 'pending' and next_deposit_amount > 0 and next_deposit_received = 0)
    or (next_deposit_status = 'partially_received' and next_deposit_amount > 0 and next_deposit_received > 0 and next_deposit_received < next_deposit_amount)
    or (next_deposit_status = 'received' and next_deposit_amount > 0 and next_deposit_received = next_deposit_amount)
  ) then
    raise exception 'Deposit status and amounts do not match.';
  end if;
  if next_deposit_received > 0 and (next_deposit_received_at is null or next_payment_reference is null) then
    raise exception 'Enter the receipt date and payment reference for recorded deposits.';
  end if;

  select offer_status into previous_offer_status
  from public.admission_offer_tracking
  where school_id = application_record.school_id and application_id = target_application;

  insert into public.admission_offer_tracking(
    school_id, application_id, offer_status, offer_sent_at, offer_expires_at, offer_responded_at,
    deposit_status, deposit_amount, deposit_received, deposit_currency, deposit_due_at,
    deposit_received_at, payment_reference, note, updated_by, updated_at
  ) values (
    application_record.school_id, target_application, next_offer_status, next_offer_sent_at,
    next_offer_expires_at, next_offer_responded_at, next_deposit_status, next_deposit_amount,
    next_deposit_received, next_deposit_currency, next_deposit_due_at, next_deposit_received_at,
    next_payment_reference, next_note, auth.uid(), timezone('utc', now())
  )
  on conflict (school_id, application_id) do update set
    offer_status = excluded.offer_status,
    offer_sent_at = excluded.offer_sent_at,
    offer_expires_at = excluded.offer_expires_at,
    offer_responded_at = excluded.offer_responded_at,
    deposit_status = excluded.deposit_status,
    deposit_amount = excluded.deposit_amount,
    deposit_received = excluded.deposit_received,
    deposit_currency = excluded.deposit_currency,
    deposit_due_at = excluded.deposit_due_at,
    deposit_received_at = excluded.deposit_received_at,
    payment_reference = excluded.payment_reference,
    note = excluded.note,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  insert into public.admission_application_history(
    school_id, application_id, actor_id, action, from_status, to_status, note
  ) values (
    application_record.school_id, target_application, auth.uid(), 'offer_tracking_updated',
    previous_offer_status, next_offer_status,
    format('Offer: %s; deposit: %s (%s %s received of %s).',
      next_offer_status, next_deposit_status, next_deposit_currency,
      next_deposit_received, next_deposit_amount)
  );
end;
$$;

revoke all on function public.save_admission_offer_tracking(uuid, jsonb) from public, anon;
grant execute on function public.save_admission_offer_tracking(uuid, jsonb) to authenticated;
