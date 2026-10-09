# Campus Connect

Campus Connect is the Vite + React application for the school information and learning management system. The existing `index.html` in the repository root remains the separate landing-page demo; the application lives in `app/`.

## V1 implemented in this workspace

- Supabase email/password authentication, persisted sessions, sign-out, and password-reset email requests
- School workspace creation for a newly signed-in account
- School membership and active-school selection
- Tenant-scoped PostgreSQL schema and row-level security policies
- Live school dashboard counts and attendance summary
- Student, teacher, class, and subject directory views, search, and administrator-only create flows
- Foundational academic, timetable, attendance, assignment, announcement, event, messaging, notification, audit, and private file-storage schema
- Responsive application shell, mobile navigation, loading/error/empty states

The academic modules whose backend schema exists but which do not yet have complete interaction screens are intentionally not presented as finished workflows.

## Technology

- React and TypeScript
- Vite
- React Router
- Supabase Auth, PostgreSQL, RLS, and Storage

Supabase is the only application backend. No service-role key belongs in the browser.

## Supabase setup

1. Create a Supabase project.
2. Copy `app/.env.example` to `app/.env` and set the project URL and public anon key:

   ```env
   VITE_SUPABASE_URL=https://your-project.supabase.co
   VITE_SUPABASE_ANON_KEY=your-anon-key
   ```

3. Apply `app/supabase/migrations/202610090001_initial_campus_connect.sql` using the Supabase CLI or the Supabase SQL editor. With the CLI installed and linked to your project, run these commands from `app/`:

   ```powershell
   supabase link --project-ref <your-project-ref>
   supabase db push
   ```

   This migration creates the schema, tenant-aware RLS policies, profile creation trigger, audit triggers, and private Storage buckets. Review the policies against your deployment's exact requirements before production rollout.
4. In Supabase Auth settings, configure the site's allowed redirect URLs and email-confirmation behavior.
5. Start the app from `app/`.

## Run locally

```powershell
cd app
npm install
npm run dev
```

Production validation/build:

```powershell
npm run typecheck
npm run build
npm run preview
```

## First workspace

Sign up with an account, confirm the email if the Supabase project requires it, then sign in and create the first school workspace. The bootstrap RPC allows a user with no existing school membership to create one initial school and assigns that user the school administrator role. Adding/inviting other users and switching into additional schools require administrative membership-management workflows, which are not yet exposed in the UI.

## Data and access model

`auth.users` is the identity source. `profiles` stores the corresponding application profile, while `school_memberships` maps a user to each school and role. School records carry `school_id`; composite foreign keys prevent cross-school relationships. RLS policies authorize access in PostgreSQL, independently of frontend route visibility. Parents' access is constrained by `parent_students`; student academic records are restricted to the student, linked parent, authorized teacher, and school administrator.

The first administrator can create student, teacher, class, and subject directory records. Associate a user account to a teacher/student/parent record by setting its `profile_id` through a properly authorized administrative workflow; role access does not come from editable profile fields.

## Current scope

This is the initial working application foundation—not a claim that every V1 module is complete. Attendance recording/history, full staff and family invitations, timetable editing, assignment submission/grading, learning-resource upload/download UX, assessments/quizzes, richer announcements/events, notification inbox, messaging UI, advanced search, and settings management still need implementation before the larger supplied V1 definition of done is met. No sample users, customer claims, or hard-coded school statistics are included.

## Security notes

- `.env` is excluded from version control; only the Supabase public URL and anon key are used by this browser client.
- Do not add a Supabase service-role key to Vite environment variables.
- The SQL migration enables RLS for application tables and keeps files in private buckets.
- Configure Supabase Auth, email delivery, backups, deployment redirects, and production monitoring before deployment.
- Test policies with separate administrator, teacher, student, and parent accounts before storing real student data.
