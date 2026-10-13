alter table public.conversation_members
  add column last_read_at timestamptz;

create or replace function public.lookup_public_student_results(
  target_slug text,
  target_student_number text
)
returns table (
  student_number text,
  first_name text,
  last_name text,
  subject text,
  assessment_title text,
  assessment_date date,
  marks_obtained numeric,
  maximum_marks numeric,
  percentage numeric,
  teacher_comment text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_school_id uuid;
  v_student_id uuid;
begin
  select website.school_id into v_school_id
  from public.school_websites website
  where website.slug = lower(trim(target_slug))
    and website.enabled
    and website.public_results_enabled;

  if v_school_id is null then return; end if;

  select student.id into v_student_id
  from public.students student
  where student.school_id = v_school_id
    and student.student_number = trim(target_student_number)
    and exists (
      select 1
      from public.learning_assessment_results result
      where result.school_id = v_school_id
        and result.student_id = student.id
        and result.status = 'published'
    )
  limit 1;

  insert into public.audit_logs (
    school_id, actor_id, action, target_table, target_id, metadata
  ) values (
    v_school_id,
    auth.uid(),
    'public_result_lookup',
    'public_student_results',
    v_student_id,
    jsonb_build_object(
      'outcome',
      case when v_student_id is null then 'no_published_results' else 'published_results_found' end
    )
  );

  if v_student_id is null then return; end if;

  return query
  select
    student.student_number,
    student.first_name,
    student.last_name,
    assessment.subject,
    assessment.title,
    result.assessment_date,
    result.marks_obtained,
    result.maximum_marks,
    result.percentage,
    result.teacher_comment
  from public.students student
  join public.learning_assessment_results result
    on result.school_id = student.school_id and result.student_id = student.id
  join public.learning_assessments assessment
    on assessment.school_id = result.school_id and assessment.id = result.assessment_id
  where student.school_id = v_school_id
    and student.id = v_student_id
    and result.status = 'published'
  order by result.assessment_date desc, assessment.subject, assessment.title;
end;
$$;

create or replace function public.messaging_is_enabled(target_school uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_school_member(target_school)
    and coalesce((
      select settings.module_messaging
      from public.school_module_settings settings
      where settings.school_id = target_school
    ), true);
$$;

create or replace function public.messaging_attachments_are_enabled(target_school uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.messaging_is_enabled(target_school)
    and coalesce((
      select settings.messaging_attachments
      from public.school_module_settings settings
      where settings.school_id = target_school
    ), true);
$$;

revoke all on function public.messaging_is_enabled(uuid) from public;
revoke all on function public.messaging_attachments_are_enabled(uuid) from public;
grant execute on function public.messaging_is_enabled(uuid) to authenticated;
grant execute on function public.messaging_attachments_are_enabled(uuid) to authenticated;

create or replace function public.get_messaging_settings(target_school uuid)
returns table (module_messaging boolean, messaging_attachments boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    coalesce(settings.module_messaging, true),
    coalesce(settings.messaging_attachments, true)
  from (select 1) singleton
  left join public.school_module_settings settings on settings.school_id = target_school
  where public.is_school_member(target_school);
$$;

revoke all on function public.get_messaging_settings(uuid) from public;
grant execute on function public.get_messaging_settings(uuid) to authenticated;

create or replace function public.can_message_school_profile(
  target_school uuid,
  target_profile uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  sender_role public.app_role;
  recipient_role public.app_role;
begin
  if auth.uid() is null or target_profile = auth.uid() then
    return false;
  end if;
  if not public.messaging_is_enabled(target_school) then
    return false;
  end if;

  select membership.role into sender_role
  from public.school_memberships membership
  where membership.school_id = target_school
    and membership.profile_id = auth.uid();
  if sender_role is null then return false; end if;

  select membership.role into recipient_role
  from public.school_memberships membership
  where membership.school_id = target_school
    and membership.profile_id = target_profile;
  if recipient_role is null then return false; end if;

  if sender_role in ('school_admin', 'academic_coordinator')
    or recipient_role in ('school_admin', 'academic_coordinator') then
    return true;
  end if;

  if sender_role in ('teacher', 'finance_manager', 'accountant', 'bursar', 'cashier')
    and recipient_role in ('teacher', 'finance_manager', 'accountant', 'bursar', 'cashier') then
    return true;
  end if;

  if sender_role = 'teacher' and recipient_role in ('parent', 'student') then
    return exists (
      select 1
      from public.teacher_profiles teacher
      join public.teacher_class_assignments assignment
        on assignment.school_id = teacher.school_id and assignment.teacher_id = teacher.id
      join public.students student
        on student.school_id = assignment.school_id
      where teacher.school_id = target_school
        and teacher.profile_id = auth.uid()
        and (
          student.class_id = assignment.class_id
          or exists (
            select 1 from public.class_students roster
            where roster.school_id = target_school
              and roster.student_id = student.id
              and roster.class_id = assignment.class_id
          )
        )
        and (
          (recipient_role = 'student' and student.profile_id = target_profile)
          or (
            recipient_role = 'parent'
            and exists (
              select 1 from public.parent_students parent_link
              join public.parent_profiles parent
                on parent.school_id = parent_link.school_id and parent.id = parent_link.parent_id
              where parent_link.school_id = target_school
                and parent_link.student_id = student.id
                and parent.profile_id = target_profile
            )
          )
        )
    );
  end if;

  if sender_role in ('parent', 'student') and recipient_role = 'teacher' then
    return exists (
      select 1
      from public.teacher_profiles teacher
      join public.teacher_class_assignments assignment
        on assignment.school_id = teacher.school_id and assignment.teacher_id = teacher.id
      join public.students student
        on student.school_id = assignment.school_id
      where teacher.school_id = target_school
        and teacher.profile_id = target_profile
        and (
          student.class_id = assignment.class_id
          or exists (
            select 1 from public.class_students roster
            where roster.school_id = target_school
              and roster.student_id = student.id
              and roster.class_id = assignment.class_id
          )
        )
        and (
          (sender_role = 'student' and student.profile_id = auth.uid())
          or (
            sender_role = 'parent'
            and exists (
              select 1 from public.parent_students parent_link
              join public.parent_profiles parent
                on parent.school_id = parent_link.school_id and parent.id = parent_link.parent_id
              where parent_link.school_id = target_school
                and parent_link.student_id = student.id
                and parent.profile_id = auth.uid()
            )
          )
        )
    );
  end if;

  return false;
end;
$$;

revoke all on function public.can_message_school_profile(uuid, uuid) from public;
grant execute on function public.can_message_school_profile(uuid, uuid) to authenticated;

create or replace function public.can_send_conversation_message(
  target_school uuid,
  target_conversation uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.conversations conversation
    join public.conversation_members own_member
      on own_member.school_id = conversation.school_id
     and own_member.conversation_id = conversation.id
     and own_member.profile_id = auth.uid()
    join public.conversation_members other_member
      on other_member.school_id = conversation.school_id
     and other_member.conversation_id = conversation.id
     and other_member.profile_id <> auth.uid()
    where conversation.school_id = target_school
      and conversation.id = target_conversation
      and (
        select count(*)
        from public.conversation_members participants
        where participants.school_id = target_school
          and participants.conversation_id = target_conversation
      ) = 2
      and public.can_message_school_profile(target_school, other_member.profile_id)
  );
$$;

revoke all on function public.can_send_conversation_message(uuid, uuid) from public;
grant execute on function public.can_send_conversation_message(uuid, uuid) to authenticated;

create or replace function public.can_add_conversation_member(
  target_conversation uuid,
  target_profile uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.conversations conversation
    where conversation.id = target_conversation
      and conversation.created_by = auth.uid()
      and public.is_school_member(conversation.school_id)
      and (
        select count(*)
        from public.conversation_members existing_member
        where existing_member.conversation_id = target_conversation
          and existing_member.profile_id = auth.uid()
      ) = 1
      and public.can_message_school_profile(conversation.school_id, target_profile)
  );
$$;

revoke all on function public.can_add_conversation_member(uuid, uuid) from public;
grant execute on function public.can_add_conversation_member(uuid, uuid) to authenticated;

create or replace function public.list_message_recipients(target_school uuid)
returns table (profile_id uuid, display_name text, role public.app_role)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select membership.profile_id,
    coalesce(nullif(trim(profile.full_name), ''), 'School member'),
    membership.role
  from public.school_memberships membership
  join public.profiles profile on profile.id = membership.profile_id
  where membership.school_id = target_school
    and public.is_school_member(target_school)
    and public.can_message_school_profile(target_school, membership.profile_id)
  order by profile.full_name, membership.role;
$$;

revoke all on function public.list_message_recipients(uuid) from public;
grant execute on function public.list_message_recipients(uuid) to authenticated;

create or replace function public.start_direct_conversation(
  target_school uuid,
  target_profile uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_conversation uuid;
begin
  if not public.can_message_school_profile(target_school, target_profile) then
    raise exception 'You are not authorized to message this school member.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    target_school::text || least(auth.uid()::text, target_profile::text)
      || greatest(auth.uid()::text, target_profile::text),
    0
  ));

  select conversation.id into new_conversation
  from public.conversations conversation
  where conversation.school_id = target_school
    and (
      select count(*) from public.conversation_members member
      where member.school_id = target_school
        and member.conversation_id = conversation.id
    ) = 2
    and exists (
      select 1 from public.conversation_members member
      where member.conversation_id = conversation.id and member.profile_id = auth.uid()
    )
    and exists (
      select 1 from public.conversation_members member
      where member.conversation_id = conversation.id and member.profile_id = target_profile
    )
  limit 1;

  if new_conversation is not null then
    return new_conversation;
  end if;

  insert into public.conversations (school_id, created_by)
  values (target_school, auth.uid())
  returning id into new_conversation;

  insert into public.conversation_members (school_id, conversation_id, profile_id, last_read_at)
  values
    (target_school, new_conversation, auth.uid(), timezone('utc', now())),
    (target_school, new_conversation, target_profile, null);

  return new_conversation;
end;
$$;

revoke all on function public.start_direct_conversation(uuid, uuid) from public;
grant execute on function public.start_direct_conversation(uuid, uuid) to authenticated;

create or replace function public.list_direct_conversations(target_school uuid)
returns table (
  conversation_id uuid,
  other_profile_id uuid,
  other_display_name text,
  other_role public.app_role,
  other_last_read_at timestamptz,
  last_message text,
  last_message_at timestamptz,
  unread_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    conversation.id,
    other_member.profile_id,
    coalesce(nullif(trim(other_profile.full_name), ''), 'School member'),
    other_membership.role,
    other_member.last_read_at,
    latest.body,
    latest.created_at,
    (
      select count(*)
      from public.messages unread
      join public.conversation_members own_member
        on own_member.school_id = target_school
       and own_member.conversation_id = conversation.id
       and own_member.profile_id = auth.uid()
      where unread.school_id = target_school
        and unread.conversation_id = conversation.id
        and unread.sender_id <> auth.uid()
        and (own_member.last_read_at is null or unread.created_at > own_member.last_read_at)
    )
  from public.conversations conversation
  join public.conversation_members own_member
    on own_member.school_id = target_school
   and own_member.conversation_id = conversation.id
   and own_member.profile_id = auth.uid()
  join public.conversation_members other_member
    on other_member.school_id = target_school
   and other_member.conversation_id = conversation.id
   and other_member.profile_id <> auth.uid()
  join public.school_memberships other_membership
    on other_membership.school_id = target_school
   and other_membership.profile_id = other_member.profile_id
  join public.profiles other_profile on other_profile.id = other_member.profile_id
  left join lateral (
    select message.body, message.created_at
    from public.messages message
    where message.school_id = target_school
      and message.conversation_id = conversation.id
    order by message.created_at desc
    limit 1
  ) latest on true
  where conversation.school_id = target_school
    and public.is_school_member(target_school)
    and public.messaging_is_enabled(target_school)
    and (
      select count(*) from public.conversation_members participants
      where participants.school_id = target_school
        and participants.conversation_id = conversation.id
    ) = 2
  order by coalesce(latest.created_at, conversation.created_at) desc;
$$;

revoke all on function public.list_direct_conversations(uuid) from public;
grant execute on function public.list_direct_conversations(uuid) to authenticated;

alter table public.messages
  alter column body set default '',
  drop constraint if exists messages_body_check,
  add constraint messages_body_check
    check (char_length(body) <= 10000 and (char_length(trim(body)) > 0 or body = ''));

create table public.message_attachments (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references public.schools(id) on delete cascade,
  conversation_id uuid not null,
  message_id uuid not null references public.messages(id) on delete cascade,
  uploaded_by uuid not null references public.profiles(id),
  file_name text not null check (char_length(file_name) between 1 and 200),
  storage_path text not null unique,
  content_type text not null,
  file_size bigint not null check (file_size > 0 and file_size <= 10485760),
  created_at timestamptz not null default timezone('utc', now()),
  foreign key (school_id, conversation_id)
    references public.conversations(school_id, id) on delete cascade
);

create index message_attachments_message_idx
  on public.message_attachments(school_id, message_id);

alter table public.message_attachments enable row level security;

create policy "Conversation members read message attachments"
  on public.message_attachments for select to authenticated
  using (
    public.is_school_member(school_id)
    and public.is_conversation_member(conversation_id)
    and public.messaging_attachments_are_enabled(school_id)
  );

create policy "Senders attach files to their conversations"
  on public.message_attachments for insert to authenticated
  with check (
    uploaded_by = auth.uid()
    and public.is_school_member(school_id)
    and public.is_conversation_member(conversation_id)
    and public.messaging_attachments_are_enabled(school_id)
    and exists (
      select 1 from public.messages message
      where message.school_id = message_attachments.school_id
        and message.id = message_attachments.message_id
        and message.conversation_id = message_attachments.conversation_id
        and message.sender_id = auth.uid()
    )
  );

create or replace function public.send_message_with_attachment(
  target_school uuid,
  target_conversation uuid,
  message_body text,
  target_file_name text,
  target_storage_path text,
  target_content_type text,
  target_file_size bigint
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_message_id uuid;
begin
  if auth.uid() is null
    or not public.messaging_attachments_are_enabled(target_school)
    or not public.can_send_conversation_message(target_school, target_conversation) then
    raise exception 'You are not authorized to send an attachment in this conversation.';
  end if;
  if target_file_name is null or char_length(target_file_name) not between 1 and 200
    or target_file_size is null or target_file_size not between 1 and 10485760
    or target_content_type is null
    or target_content_type not in (
      'application/pdf', 'image/jpeg', 'image/png', 'text/plain',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
    or target_storage_path not like
      target_school::text || '/' || target_conversation::text || '/' || auth.uid()::text || '/%' then
    raise exception 'The attachment details are invalid or exceed the allowed file limits.';
  end if;
  if not exists (
    select 1 from storage.objects object
    where object.bucket_id = 'message-attachments'
      and object.name = target_storage_path
  ) then
    raise exception 'The uploaded attachment could not be found.';
  end if;

  insert into public.messages (school_id, conversation_id, sender_id, body)
  values (
    target_school,
    target_conversation,
    auth.uid(),
    coalesce(nullif(trim(message_body), ''), 'Shared an attachment.')
  )
  returning id into new_message_id;

  insert into public.message_attachments (
    school_id, conversation_id, message_id, uploaded_by, file_name,
    storage_path, content_type, file_size
  ) values (
    target_school, target_conversation, new_message_id, auth.uid(),
    target_file_name, target_storage_path, target_content_type, target_file_size
  );

  return new_message_id;
end;
$$;

revoke all on function public.send_message_with_attachment(uuid, uuid, text, text, text, text, bigint) from public;
grant execute on function public.send_message_with_attachment(uuid, uuid, text, text, text, text, bigint) to authenticated;
revoke all on public.message_attachments from anon, authenticated;
grant select on public.message_attachments to authenticated;

create or replace function public.mark_conversation_read(target_conversation uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  read_timestamp timestamptz := timezone('utc', now());
begin
  update public.conversation_members member
  set last_read_at = read_timestamp
  from public.conversations conversation
  where member.conversation_id = target_conversation
    and member.profile_id = auth.uid()
    and conversation.id = member.conversation_id
    and conversation.school_id = member.school_id
    and public.messaging_is_enabled(conversation.school_id);

  if not found then
    raise exception 'You are not authorized to mark this conversation as read.';
  end if;
  return read_timestamp;
end;
$$;

revoke all on function public.mark_conversation_read(uuid) from public;
grant execute on function public.mark_conversation_read(uuid) to authenticated;

create or replace function public.guard_conversation_member_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.school_id is distinct from new.school_id
    or old.conversation_id is distinct from new.conversation_id
    or old.profile_id is distinct from new.profile_id
    or old.joined_at is distinct from new.joined_at
    or new.profile_id <> auth.uid()
    or (
      old.last_read_at is not null
      and (new.last_read_at is null or new.last_read_at < old.last_read_at)
    ) then
    raise exception 'Conversation membership can only update its own increasing read timestamp.';
  end if;
  if new.last_read_at > timezone('utc', now()) then
    raise exception 'A conversation read timestamp cannot be in the future.';
  end if;
  return new;
end;
$$;

create trigger guard_conversation_member_update
  before update on public.conversation_members
  for each row execute function public.guard_conversation_member_update();

drop policy if exists "Conversation creators add members" on public.conversation_members;
create policy "Conversation creators add authorized direct recipients"
  on public.conversation_members for insert to authenticated
  with check (
    profile_id = auth.uid()
    and public.is_school_member(school_id)
    and exists (
      select 1 from public.conversations conversation
      where conversation.id = conversation_members.conversation_id
        and conversation.school_id = conversation_members.school_id
        and conversation.created_by = auth.uid()
    )
    or public.can_add_conversation_member(conversation_id, profile_id)
  );
create policy "Members update their own conversation read status"
  on public.conversation_members for update to authenticated
  using (
    profile_id = auth.uid()
    and public.is_conversation_member(conversation_id)
    and public.messaging_is_enabled(school_id)
  )
  with check (
    profile_id = auth.uid()
    and public.is_conversation_member(conversation_id)
    and coalesce((select settings.module_messaging from public.school_module_settings settings where settings.school_id = conversation_members.school_id), true)
  );

drop policy if exists "Members read conversations" on public.conversations;
create policy "Members read enabled school conversations"
  on public.conversations for select to authenticated using (
    public.is_school_member(school_id)
    and public.is_conversation_member(id)
    and public.messaging_is_enabled(school_id)
  );

drop policy if exists "Members read conversation participants" on public.conversation_members;
create policy "Members read enabled conversation participants"
  on public.conversation_members for select to authenticated using (
    public.is_conversation_member(conversation_id)
    and public.messaging_is_enabled(school_id)
  );

drop policy if exists "Participants read messages" on public.messages;
create policy "Participants read enabled messages"
  on public.messages for select to authenticated using (
    public.is_conversation_member(conversation_id)
    and public.messaging_is_enabled(school_id)
  );

drop policy if exists "Participants send messages" on public.messages;
create policy "Participants send enabled messages"
  on public.messages for insert to authenticated with check (
    sender_id = auth.uid()
    and char_length(trim(body)) > 0
    and public.can_send_conversation_message(school_id, conversation_id)
  );

revoke all on public.conversations from anon, authenticated;
grant select on public.conversations to authenticated;
revoke all on public.conversation_members from anon, authenticated;
grant select, update on public.conversation_members to authenticated;
revoke all on public.messages from anon, authenticated;
grant select, insert on public.messages to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'message-attachments',
  'message-attachments',
  false,
  10485760,
  array[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'text/plain',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do nothing;

create policy "Conversation members access message attachment files"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'message-attachments'
    and public.is_school_member(((storage.foldername(name))[1])::uuid)
    and public.is_conversation_member(((storage.foldername(name))[2])::uuid)
    and public.messaging_attachments_are_enabled(((storage.foldername(name))[1])::uuid)
  );

create policy "Conversation members upload their own attachments"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'message-attachments'
    and (storage.foldername(name))[3] = auth.uid()::text
    and public.is_school_member(((storage.foldername(name))[1])::uuid)
    and public.can_send_conversation_message(
      ((storage.foldername(name))[1])::uuid,
      ((storage.foldername(name))[2])::uuid
    )
    and public.messaging_attachments_are_enabled(((storage.foldername(name))[1])::uuid)
  );

create policy "Conversation members delete their own attachments"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'message-attachments'
    and (storage.foldername(name))[3] = auth.uid()::text
    and public.is_school_member(((storage.foldername(name))[1])::uuid)
    and public.is_conversation_member(((storage.foldername(name))[2])::uuid)
    and public.messaging_attachments_are_enabled(((storage.foldername(name))[1])::uuid)
  );

create or replace function public.log_message_storage_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  object_record jsonb;
  school_id_value uuid;
begin
  if tg_op <> 'DELETE' then object_record := to_jsonb(new); else object_record := to_jsonb(old); end if;
  if object_record ->> 'bucket_id' <> 'message-attachments' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  begin
    school_id_value := ((storage.foldername(object_record ->> 'name'))[1])::uuid;
  exception when invalid_text_representation then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end;

  insert into public.audit_logs (
    school_id, actor_id, action, target_table, target_id, metadata
  ) values (
    school_id_value,
    auth.uid(),
    lower(tg_op),
    'message_attachments_storage',
    nullif(object_record ->> 'id', '')::uuid,
    jsonb_build_object('changed_columns', jsonb_build_array('attachment_file'))
  );

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger audit_message_storage_change
  after insert or update or delete on storage.objects
  for each row execute function public.log_message_storage_change();

create or replace function public.log_school_record_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  old_record jsonb;
  new_record jsonb;
  record_data jsonb;
  school_id_value uuid;
  target_id_value uuid;
  operation_value text := lower(tg_op);
  changed_columns jsonb;
begin
  if tg_op <> 'INSERT' then old_record := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then new_record := to_jsonb(new); end if;
  record_data := coalesce(new_record, old_record);
  if tg_table_name = 'schools' then
    school_id_value := nullif(record_data ->> 'id', '')::uuid;
  else
    school_id_value := nullif(record_data ->> 'school_id', '')::uuid;
  end if;
  if school_id_value is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  begin
    target_id_value := nullif(record_data ->> 'id', '')::uuid;
  exception when invalid_text_representation then
    target_id_value := null;
  end;

  if tg_op = 'INSERT' then
    select coalesce(jsonb_agg(key order by key), '[]'::jsonb)
      into changed_columns from jsonb_object_keys(new_record) as keys(key)
      where key not in ('school_id', 'created_at', 'updated_at');
  elsif tg_op = 'DELETE' then
    select coalesce(jsonb_agg(key order by key), '[]'::jsonb)
      into changed_columns from jsonb_object_keys(old_record) as keys(key)
      where key not in ('school_id', 'created_at', 'updated_at');
  else
    select coalesce(jsonb_agg(new_keys.key order by new_keys.key), '[]'::jsonb)
      into changed_columns
    from jsonb_each(new_record) new_keys
    left join jsonb_each(old_record) old_keys on old_keys.key = new_keys.key
    where new_keys.value is distinct from old_keys.value
      and new_keys.key not in ('school_id', 'created_at', 'updated_at');
    if changed_columns = '[]'::jsonb then return new; end if;
  end if;

  insert into public.audit_logs (
    school_id, actor_id, action, target_table, target_id, metadata
  ) values (
    school_id_value,
    auth.uid(),
    operation_value,
    tg_table_name,
    target_id_value,
    jsonb_build_object('changed_columns', changed_columns)
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

do $$
declare
  table_record record;
begin
  for table_record in
    select namespace.nspname as schema_name, relation.relname as table_name
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    join pg_attribute attribute on attribute.attrelid = relation.oid
    where namespace.nspname = 'public'
      and relation.relkind in ('r', 'p')
      and attribute.attname = 'school_id'
      and not attribute.attisdropped
      and relation.relname <> 'audit_logs'
  loop
    if not exists (
      select 1
      from pg_trigger trigger_record
      where trigger_record.tgrelid = format('%I.%I', table_record.schema_name, table_record.table_name)::regclass
        and trigger_record.tgname = 'audit_school_record_change'
        and not trigger_record.tgisinternal
    ) then
      execute format(
        'create trigger audit_school_record_change after insert or update or delete on %I.%I for each row execute function public.log_school_record_change()',
        table_record.schema_name, table_record.table_name
      );
    end if;
  end loop;

  if not exists (
    select 1 from pg_trigger trigger_record
    where trigger_record.tgrelid = 'public.schools'::regclass
      and trigger_record.tgname = 'audit_school_record_change'
      and not trigger_record.tgisinternal
  ) then
    execute 'create trigger audit_school_record_change after insert or update or delete on public.schools for each row execute function public.log_school_record_change()';
  end if;
end;
$$;

grant select on public.audit_logs to authenticated;
revoke all on public.audit_logs from anon, authenticated;
grant select on public.audit_logs to authenticated;
revoke all on public.message_attachments from anon, authenticated;
grant select on public.message_attachments to authenticated;
