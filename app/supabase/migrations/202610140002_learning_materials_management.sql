alter table public.learning_materials
  add column topic text not null default ''
    check (char_length(topic) <= 160),
  add column file_name text,
  add column visibility text not null default 'class'
    check (visibility in ('class', 'school')),
  add column is_published boolean not null default false,
  add column is_uploaded boolean,
  add column storage_provider text;

update public.learning_materials
set storage_provider = 'supabase',
    is_uploaded = true,
    is_published = true;

alter table public.learning_materials
  alter column is_uploaded set default false,
  alter column is_uploaded set not null,
  alter column storage_provider set default 'r2',
  alter column storage_provider set not null,
  add constraint learning_materials_provider_check
    check (storage_provider in ('r2', 'supabase')),
  add constraint learning_materials_file_size_limit
    check (file_size is null or file_size between 1 and 524288000);

create index learning_materials_school_subject_topic_idx
  on public.learning_materials(school_id, subject_id, topic, created_at desc);
create index learning_materials_school_class_published_idx
  on public.learning_materials(school_id, class_id, is_published, created_at desc);

drop policy if exists "Class members read learning materials" on public.learning_materials;
drop policy if exists "Teachers and admins manage learning materials" on public.learning_materials;

create policy "Authorized members read learning materials"
  on public.learning_materials for select to authenticated
  using (
    (
      uploaded_by = auth.uid()
      and public.is_school_member(school_id)
      and (
        public.can_manage_timetable(school_id)
        or public.is_teacher_for_class(school_id, class_id)
      )
    )
    or public.can_manage_timetable(school_id)
    or (
      public.is_teacher_for_class(school_id, class_id)
      and (
        visibility = 'school'
        or exists (
          select 1
          from public.teacher_profiles teacher
          where teacher.school_id = learning_materials.school_id
            and teacher.profile_id = auth.uid()
            and (
              teacher.id = learning_materials.uploaded_by
              or exists (
                select 1 from public.teacher_class_assignments assignment
                where assignment.school_id = learning_materials.school_id
                  and assignment.teacher_id = teacher.id
                  and assignment.class_id = learning_materials.class_id
              )
            )
        )
      )
    )
    or (
      is_uploaded
      and is_published
      and (
        visibility = 'school' and public.is_school_member(school_id)
        or (
          visibility = 'class'
          and (
            exists (
              select 1 from public.class_students roster
              join public.students student
                on student.school_id = roster.school_id
               and student.id = roster.student_id
              where roster.school_id = learning_materials.school_id
                and roster.class_id = learning_materials.class_id
                and student.profile_id = auth.uid()
            )
            or exists (
              select 1 from public.class_students roster
              where roster.school_id = learning_materials.school_id
                and roster.class_id = learning_materials.class_id
                and public.is_parent_of_student(learning_materials.school_id, roster.student_id)
            )
          )
        )
      )
    )
  );

create policy "Authorized staff add learning materials"
  on public.learning_materials for insert to authenticated
  with check (
    uploaded_by = auth.uid()
    and not is_uploaded
    and not is_published
    and storage_provider = 'r2'
    and (
      public.can_manage_timetable(school_id)
      or public.is_teacher_for_class(school_id, class_id)
    )
  );

create policy "Authorized staff update learning materials"
  on public.learning_materials for update to authenticated
  using (
    public.can_manage_timetable(school_id)
    or (
      uploaded_by = auth.uid()
      and public.is_teacher_for_class(school_id, class_id)
    )
  )
  with check (
    public.can_manage_timetable(school_id)
    or (
      uploaded_by = auth.uid()
      and public.is_teacher_for_class(school_id, class_id)
    )
  );

create policy "Authorized staff delete learning materials"
  on public.learning_materials for delete to authenticated
  using (
    public.can_manage_timetable(school_id)
    or (
      uploaded_by = auth.uid()
      and public.is_teacher_for_class(school_id, class_id)
    )
  );

revoke update, delete on public.learning_materials from authenticated;
grant update (title, description, class_id, subject_id, topic, visibility, is_published)
  on public.learning_materials to authenticated;

create or replace function public.can_access_learning_material_object(target_path text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.learning_materials material
    where material.storage_provider = 'supabase'
      and material.storage_path = target_path
      and public.is_school_member(material.school_id)
      and (
        material.uploaded_by = auth.uid()
        or public.can_manage_timetable(material.school_id)
        or public.is_teacher_for_class(material.school_id, material.class_id)
        or (
          material.is_published
          and (
            material.visibility = 'school' and public.is_school_member(material.school_id)
            or (
              material.visibility = 'class'
              and (
                exists (
                  select 1 from public.class_students roster
                  join public.students student
                    on student.school_id = roster.school_id
                   and student.id = roster.student_id
                  where roster.school_id = material.school_id
                    and roster.class_id = material.class_id
                    and student.profile_id = auth.uid()
                )
                or exists (
                  select 1 from public.class_students roster
                  where roster.school_id = material.school_id
                    and roster.class_id = material.class_id
                    and public.is_parent_of_student(material.school_id, roster.student_id)
                )
              )
            )
          )
        )
      )
  );
$$;

create policy "Authorized users read learning material files"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'learning-materials'
    and public.can_access_learning_material_object(name)
  );

update storage.buckets
set file_size_limit = 52428800,
    allowed_mime_types = array[
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain',
      'video/mp4',
      'video/webm',
      'video/quicktime'
    ]
where id = 'learning-materials';

revoke all on function public.can_access_learning_material_object(text) from public;
grant execute on function public.can_access_learning_material_object(text) to authenticated;
