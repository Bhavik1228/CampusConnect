alter table public.learning_assessments
  add column blueprint jsonb not null default
    '{"enabled":false,"target_question_count":null,"target_total_marks":null,"difficulty_targets":{"Foundation":null,"Standard":null,"Challenging":null}}'::jsonb,
  add constraint learning_assessments_blueprint_shape_check
    check (
      jsonb_typeof(blueprint) = 'object'
      and jsonb_typeof(blueprint -> 'enabled') = 'boolean'
      and jsonb_typeof(blueprint -> 'difficulty_targets') = 'object'
    );

create or replace function public.validate_learning_assessment_blueprint()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_question_count integer;
  target_total_marks numeric;
  target_foundation numeric;
  target_standard numeric;
  target_challenging numeric;
  question_count integer;
  found_question_count integer;
  total_question_marks numeric;
  foundation_count integer;
  standard_count integer;
  challenging_count integer;
begin
  if jsonb_typeof(new.blueprint -> 'enabled') <> 'boolean'
    or not (new.blueprint ? 'target_question_count')
    or not (new.blueprint ? 'target_total_marks')
    or jsonb_typeof(new.blueprint -> 'difficulty_targets') <> 'object'
    or not (new.blueprint -> 'difficulty_targets' ? 'Foundation')
    or not (new.blueprint -> 'difficulty_targets' ? 'Standard')
    or not (new.blueprint -> 'difficulty_targets' ? 'Challenging') then
    raise exception 'The assessment blueprint is incomplete.';
  end if;

  if jsonb_typeof(new.blueprint -> 'target_question_count') not in ('number', 'null')
    or jsonb_typeof(new.blueprint -> 'target_total_marks') not in ('number', 'null')
    or jsonb_typeof(new.blueprint -> 'difficulty_targets' -> 'Foundation') not in ('number', 'null')
    or jsonb_typeof(new.blueprint -> 'difficulty_targets' -> 'Standard') not in ('number', 'null')
    or jsonb_typeof(new.blueprint -> 'difficulty_targets' -> 'Challenging') not in ('number', 'null') then
    raise exception 'Blueprint targets must be numbers or null.';
  end if;

  if jsonb_typeof(new.blueprint -> 'target_question_count') = 'number' then
    if (new.blueprint ->> 'target_question_count')::numeric < 1
      or (new.blueprint ->> 'target_question_count')::numeric > 10000
      or (new.blueprint ->> 'target_question_count')::numeric <> trunc((new.blueprint ->> 'target_question_count')::numeric) then
      raise exception 'The target question count must be a whole number between 1 and 10000.';
    end if;
    target_question_count := (new.blueprint ->> 'target_question_count')::integer;
  end if;
  if jsonb_typeof(new.blueprint -> 'target_total_marks') = 'number' then
    target_total_marks := (new.blueprint ->> 'target_total_marks')::numeric;
    if target_total_marks <= 0 or target_total_marks > 999999.99
      or target_total_marks <> round(target_total_marks, 2) then
      raise exception 'The target total marks must be greater than zero and within the supported range.';
    end if;
  end if;

  if jsonb_typeof(new.blueprint -> 'difficulty_targets' -> 'Foundation') = 'number' then
    target_foundation := (new.blueprint -> 'difficulty_targets' ->> 'Foundation')::numeric;
  end if;
  if jsonb_typeof(new.blueprint -> 'difficulty_targets' -> 'Standard') = 'number' then
    target_standard := (new.blueprint -> 'difficulty_targets' ->> 'Standard')::numeric;
  end if;
  if jsonb_typeof(new.blueprint -> 'difficulty_targets' -> 'Challenging') = 'number' then
    target_challenging := (new.blueprint -> 'difficulty_targets' ->> 'Challenging')::numeric;
  end if;
  if (target_foundation is not null and (target_foundation < 0 or target_foundation > 10000))
    or (target_standard is not null and (target_standard < 0 or target_standard > 10000))
    or (target_challenging is not null and (target_challenging < 0 or target_challenging > 10000)) then
    raise exception 'Difficulty targets must be whole numbers from 0 to 10000.';
  end if;
  if (jsonb_typeof(new.blueprint -> 'difficulty_targets' -> 'Foundation') = 'number'
      and (new.blueprint -> 'difficulty_targets' ->> 'Foundation')::numeric <> trunc((new.blueprint -> 'difficulty_targets' ->> 'Foundation')::numeric))
    or (jsonb_typeof(new.blueprint -> 'difficulty_targets' -> 'Standard') = 'number'
      and (new.blueprint -> 'difficulty_targets' ->> 'Standard')::numeric <> trunc((new.blueprint -> 'difficulty_targets' ->> 'Standard')::numeric))
    or (jsonb_typeof(new.blueprint -> 'difficulty_targets' -> 'Challenging') = 'number'
      and (new.blueprint -> 'difficulty_targets' ->> 'Challenging')::numeric <> trunc((new.blueprint -> 'difficulty_targets' ->> 'Challenging')::numeric)) then
    raise exception 'Difficulty targets must be whole numbers from 0 to 10000.';
  end if;
  if new.status <> 'ready' then
    return new;
  end if;
  if jsonb_typeof(new.question_ids) <> 'array' then
    raise exception 'Ready assessments must include a question list.';
  end if;
  if jsonb_array_length(new.question_ids) = 0 then
    raise exception 'Add at least one question before marking the test ready.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(new.question_ids) selected(value)
    where jsonb_typeof(selected.value) <> 'string'
      or (selected.value #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    raise exception 'Every selected question must have a valid question ID.';
  end if;
  select count(*) into question_count from jsonb_array_elements_text(new.question_ids);
  if question_count <> (select count(distinct value) from jsonb_array_elements_text(new.question_ids)) then
    raise exception 'A question cannot appear more than once in an assessment.';
  end if;

  select count(question.id)::integer, coalesce(sum(question.marks), 0),
    count(*) filter (where question.difficulty = 'Foundation')::integer,
    count(*) filter (where question.difficulty = 'Standard')::integer,
    count(*) filter (where question.difficulty = 'Challenging')::integer
  into found_question_count, total_question_marks, foundation_count, standard_count, challenging_count
  from jsonb_array_elements_text(new.question_ids) selected(question_id)
  join public.learning_questions question
    on question.school_id = new.school_id and question.id = selected.question_id::uuid;

  if found_question_count <> question_count then
    raise exception 'One or more selected questions no longer belong to this school.';
  end if;
  if coalesce((new.blueprint ->> 'enabled')::boolean, false) then
    if target_question_count is null and target_total_marks is null
      and target_foundation is null and target_standard is null and target_challenging is null then
      raise exception 'Set at least one blueprint target or turn blueprint controls off.';
    end if;
    if target_question_count is not null and question_count <> target_question_count then
      raise exception 'The selected question count does not meet the blueprint target.';
    end if;
    if target_total_marks is not null
      and (total_question_marks <> target_total_marks or new.total_marks <> target_total_marks) then
      raise exception 'Question marks and assessment total marks must match the blueprint target.';
    end if;
    if target_foundation is not null and foundation_count <> target_foundation then
      raise exception 'The selected Foundation question count does not meet the blueprint target.';
    end if;
    if target_standard is not null and standard_count <> target_standard then
      raise exception 'The selected Standard question count does not meet the blueprint target.';
    end if;
    if target_challenging is not null and challenging_count <> target_challenging then
      raise exception 'The selected Challenging question count does not meet the blueprint target.';
    end if;
    if target_question_count is not null
      and target_foundation is not null and target_standard is not null and target_challenging is not null
      and target_foundation + target_standard + target_challenging <> target_question_count then
      raise exception 'Difficulty targets must add up to the target question count.';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.validate_learning_assessment_blueprint() from public, anon, authenticated;

create trigger validate_learning_assessment_blueprint
  before insert or update on public.learning_assessments
  for each row execute function public.validate_learning_assessment_blueprint();
