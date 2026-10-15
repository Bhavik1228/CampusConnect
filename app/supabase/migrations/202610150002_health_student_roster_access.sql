create policy "Healthcare staff read student roster"
  on public.students for select to authenticated
  using (public.health_access_enabled(school_id));
