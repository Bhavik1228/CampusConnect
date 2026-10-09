do $$
begin
  if to_regclass('public.attendance_records') is null
    or to_regclass('public.assignments') is null
    or to_regclass('public.quiz_questions') is null
    or to_regclass('public.quiz_options') is null
    or to_regclass('public.quiz_answer_keys') is null
    or to_regclass('public.quiz_attempts') is null
    or to_regclass('public.quiz_answers') is null then
    raise exception 'The initial Campus Connect schema is not present. Run the corrected 202610090001_initial_campus_connect.sql migration first.';
  end if;
end;
$$;

drop policy if exists "Teachers and admins manage attendance records" on public.attendance_records;
create policy "Teachers and admins manage attendance records" on public.attendance_records for all to authenticated using (
  public.has_school_role(attendance_records.school_id, array['school_admin']::public.app_role[])
  or exists (
    select 1 from public.attendance_sessions a
    where a.id = attendance_records.session_id
      and a.school_id = attendance_records.school_id
      and public.is_teacher_for_class(attendance_records.school_id, a.class_id)
  )
) with check (
  public.has_school_role(attendance_records.school_id, array['school_admin']::public.app_role[])
  or exists (
    select 1 from public.attendance_sessions a
    join public.class_students roster
      on roster.school_id = a.school_id
      and roster.class_id = a.class_id
    where a.id = attendance_records.session_id
      and a.school_id = attendance_records.school_id
      and roster.school_id = attendance_records.school_id
      and roster.student_id = attendance_records.student_id
      and public.is_teacher_for_class(attendance_records.school_id, a.class_id)
  )
);

drop policy if exists "Authorized users read published assignments" on public.assignments;
create policy "Authorized users read published assignments" on public.assignments for select to authenticated using (
  public.has_school_role(assignments.school_id, array['school_admin']::public.app_role[])
  or assignments.teacher_id in (
    select teacher.id from public.teacher_profiles teacher
    where teacher.profile_id = auth.uid()
      and teacher.school_id = assignments.school_id
  )
  or (assignments.status = 'published' and (
    public.is_teacher_for_class(assignments.school_id, assignments.class_id)
    or exists (
      select 1 from public.class_students cs
      join public.students s on s.id = cs.student_id and s.school_id = cs.school_id
      where cs.school_id = assignments.school_id
        and cs.class_id = assignments.class_id
        and s.profile_id = auth.uid()
    )
    or exists (
      select 1 from public.class_students cs
      where cs.school_id = assignments.school_id
        and cs.class_id = assignments.class_id
        and public.is_parent_of_student(assignments.school_id, cs.student_id)
    )
  ))
);

drop policy if exists "Users read quiz questions for authorized quizzes" on public.quiz_questions;
create policy "Users read quiz questions for authorized quizzes" on public.quiz_questions for select to authenticated using (
  exists (
    select 1 from public.quizzes quiz
    where quiz.id = quiz_questions.quiz_id
      and quiz.school_id = quiz_questions.school_id
      and (
        public.has_school_role(quiz_questions.school_id, array['school_admin']::public.app_role[])
        or public.is_teacher_for_class(quiz_questions.school_id, quiz.class_id)
        or (quiz.published_at is not null and (
          public.is_student_in_class(quiz_questions.school_id, quiz.class_id)
          or public.is_parent_of_class_student(quiz_questions.school_id, quiz.class_id)
        ))
      )
  )
);

drop policy if exists "Teachers and admins manage quiz questions" on public.quiz_questions;
create policy "Teachers and admins manage quiz questions" on public.quiz_questions for all to authenticated using (
  public.has_school_role(quiz_questions.school_id, array['school_admin']::public.app_role[])
  or exists (
    select 1 from public.quizzes quiz
    where quiz.id = quiz_questions.quiz_id
      and quiz.school_id = quiz_questions.school_id
      and public.is_teacher_for_class(quiz_questions.school_id, quiz.class_id)
  )
) with check (
  public.has_school_role(quiz_questions.school_id, array['school_admin']::public.app_role[])
  or exists (
    select 1 from public.quizzes quiz
    where quiz.id = quiz_questions.quiz_id
      and quiz.school_id = quiz_questions.school_id
      and public.is_teacher_for_class(quiz_questions.school_id, quiz.class_id)
  )
);

drop policy if exists "Users read options for authorized quizzes" on public.quiz_options;
create policy "Users read options for authorized quizzes" on public.quiz_options for select to authenticated using (
  exists (
    select 1 from public.quiz_questions question
    join public.quizzes quiz
      on quiz.school_id = question.school_id
      and quiz.id = question.quiz_id
    where question.id = quiz_options.question_id
      and question.school_id = quiz_options.school_id
      and (
        public.has_school_role(quiz_options.school_id, array['school_admin']::public.app_role[])
        or public.is_teacher_for_class(quiz_options.school_id, quiz.class_id)
        or (quiz.published_at is not null and (
          public.is_student_in_class(quiz_options.school_id, quiz.class_id)
          or public.is_parent_of_class_student(quiz_options.school_id, quiz.class_id)
        ))
      )
  )
);

drop policy if exists "Teachers and admins manage quiz options" on public.quiz_options;
create policy "Teachers and admins manage quiz options" on public.quiz_options for all to authenticated using (
  public.has_school_role(quiz_options.school_id, array['school_admin']::public.app_role[])
  or exists (
    select 1 from public.quiz_questions question
    join public.quizzes quiz
      on quiz.school_id = question.school_id
      and quiz.id = question.quiz_id
    where question.id = quiz_options.question_id
      and question.school_id = quiz_options.school_id
      and public.is_teacher_for_class(quiz_options.school_id, quiz.class_id)
  )
) with check (
  public.has_school_role(quiz_options.school_id, array['school_admin']::public.app_role[])
  or exists (
    select 1 from public.quiz_questions question
    join public.quizzes quiz
      on quiz.school_id = question.school_id
      and quiz.id = question.quiz_id
    where question.id = quiz_options.question_id
      and question.school_id = quiz_options.school_id
      and public.is_teacher_for_class(quiz_options.school_id, quiz.class_id)
  )
);

drop policy if exists "Teachers manage private quiz answer keys" on public.quiz_answer_keys;
create policy "Teachers manage private quiz answer keys" on public.quiz_answer_keys for all to authenticated using (
  public.has_school_role(quiz_answer_keys.school_id, array['school_admin']::public.app_role[])
  or exists (
    select 1 from public.quiz_questions question
    join public.quizzes quiz
      on quiz.school_id = question.school_id
      and quiz.id = question.quiz_id
    where question.id = quiz_answer_keys.question_id
      and question.school_id = quiz_answer_keys.school_id
      and public.is_teacher_for_class(quiz_answer_keys.school_id, quiz.class_id)
  )
) with check (
  public.has_school_role(quiz_answer_keys.school_id, array['school_admin']::public.app_role[])
  or exists (
    select 1 from public.quiz_questions question
    join public.quizzes quiz
      on quiz.school_id = question.school_id
      and quiz.id = question.quiz_id
    where question.id = quiz_answer_keys.question_id
      and question.school_id = quiz_answer_keys.school_id
      and public.is_teacher_for_class(quiz_answer_keys.school_id, quiz.class_id)
  )
);

drop policy if exists "Users read own and authorized quiz attempts" on public.quiz_attempts;
create policy "Users read own and authorized quiz attempts" on public.quiz_attempts for select to authenticated using (
  exists (
    select 1 from public.students student
    where student.id = quiz_attempts.student_id
      and student.school_id = quiz_attempts.school_id
      and student.profile_id = auth.uid()
  )
  or public.is_parent_of_student(quiz_attempts.school_id, quiz_attempts.student_id)
  or public.has_school_role(quiz_attempts.school_id, array['school_admin']::public.app_role[])
  or exists (
    select 1 from public.quizzes quiz
    where quiz.id = quiz_attempts.quiz_id
      and quiz.school_id = quiz_attempts.school_id
      and public.is_teacher_for_class(quiz_attempts.school_id, quiz.class_id)
  )
);

drop policy if exists "Students submit own quiz attempts" on public.quiz_attempts;
create policy "Students submit own quiz attempts" on public.quiz_attempts for insert to authenticated with check (
  exists (
    select 1 from public.students student
    where student.id = quiz_attempts.student_id
      and student.school_id = quiz_attempts.school_id
      and student.profile_id = auth.uid()
  )
  and exists (
    select 1 from public.quizzes quiz
    where quiz.id = quiz_attempts.quiz_id
      and quiz.school_id = quiz_attempts.school_id
      and quiz.published_at is not null
      and public.is_student_in_class(quiz_attempts.school_id, quiz.class_id)
  )
);

drop policy if exists "Students answer own attempts" on public.quiz_answers;
create policy "Students answer own attempts" on public.quiz_answers for all to authenticated using (
  exists (
    select 1 from public.quiz_attempts attempt
    join public.students student on student.id = attempt.student_id
    where attempt.id = quiz_answers.attempt_id
      and attempt.school_id = quiz_answers.school_id
      and student.school_id = quiz_answers.school_id
      and student.profile_id = auth.uid()
      and attempt.submitted_at is null
  )
) with check (
  exists (
    select 1 from public.quiz_attempts attempt
    join public.students student on student.id = attempt.student_id
    where attempt.id = quiz_answers.attempt_id
      and attempt.school_id = quiz_answers.school_id
      and student.school_id = quiz_answers.school_id
      and student.profile_id = auth.uid()
      and attempt.submitted_at is null
  )
);

drop policy if exists "Teachers read quiz answers" on public.quiz_answers;
create policy "Teachers read quiz answers" on public.quiz_answers for select to authenticated using (
  exists (
    select 1 from public.quiz_attempts attempt
    join public.quizzes quiz
      on quiz.id = attempt.quiz_id
      and quiz.school_id = attempt.school_id
    where attempt.id = quiz_answers.attempt_id
      and attempt.school_id = quiz_answers.school_id
      and public.is_teacher_for_class(quiz_answers.school_id, quiz.class_id)
  )
);
