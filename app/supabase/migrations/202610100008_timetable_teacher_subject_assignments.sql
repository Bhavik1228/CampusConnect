create policy "Timetable managers manage teacher subject assignments"
  on public.teacher_subjects for all to authenticated
  using (public.can_manage_timetable(school_id))
  with check (public.can_manage_timetable(school_id));
