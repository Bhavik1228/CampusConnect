# Campus Connect

Campus Connect is the Vite + React application for the school information and learning management system. The existing `index.html` in the repository root remains the separate landing-page demo; the application lives in `app/`. The app's public `/` route is its product landing page, `/login` is for account access, and school workspaces are available after sign-in.

## V1 implemented in this workspace

- Supabase email/password authentication, persisted sessions, sign-out, email-confirmation redirects, and password-reset email requests
- School workspace creation for a newly signed-in account
- School membership and active-school selection
- Tenant-scoped PostgreSQL schema and row-level security policies
- Live school dashboard counts and attendance summary
- Student, teacher, class, and subject directory views, search, and administrator-only create flows
- Foundational academic, timetable, attendance, assignment, announcement, event, messaging, notification, audit, and private file-storage schema
- Responsive application shell, mobile navigation, loading/error/empty states
- School administrator settings for school identity and branding, grading and academic-year defaults, attendance policies, family/student portals, notification preferences, 45+ module/feature switches, and security/privacy policies
- School-scoped Test Maker for teacher-created and authorized-resource assessments, question libraries, configuration, and print-to-PDF previews
- Assessment result entry with validated marks, calculated percentages, and searchable student attempt histories
- Grades & results management with configurable school grading bands, teacher comments, approval and publication workflows, authorized audited corrections, student/parent result viewing, and individual or all-student PDF reports
- Five original report layouts plus school-customizable report templates with configurable titles, colors, subtitles, and footers
- Authorized past-paper ingestion to private Firebase Storage, with school metadata catalogued in Supabase

The academic modules whose backend schema exists but which do not yet have complete interaction screens are intentionally not presented as finished workflows. The authorized-paper ingestion pipeline stores files privately; a signed download/viewer endpoint is not included yet.

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

3. Apply `app/supabase/migrations/202610090001_initial_campus_connect.sql` using the Supabase CLI or the Supabase SQL editor. From `app/`, authenticate, link this folder to your Supabase project, and push pending migrations:

   ```powershell
   npx supabase login
   npx supabase link --project-ref <your-project-ref>
   npx supabase db push
   ```

   `npx` runs the Supabase CLI without requiring a global install. Get the project ref from the Supabase dashboard URL or **Project Settings → General**. The initial migration creates the schema, tenant-aware RLS policies, profile creation trigger, audit triggers, and private Storage buckets. Review the policies against your deployment's exact requirements before production rollout.
   The timetable migrations `202610100001_timetable_dashboard.sql` through `202610100004_bell_schedule.sql` add academic coordinator access, editable and automatically generated schedules, change history, academic calendars, terms, teaching-week patterns, holidays, closures, date-specific timetable exceptions, configurable bell schedules, day-specific periods, and A/B rotation cycles. School administrators and academic coordinators can configure periods, preview a bell schedule, build and publish timetables, and export schedules; students and families can view published schedules. Migration `202610100005_attendance_core.sql` extends attendance with academic-year and term linkage, daily/morning/afternoon/lesson registers, configurable status policies, attendance submission and locking, corrections, arrival/departure and absence details, parent explanations and review, in-app notifications, audit history, reports, and role-scoped RLS. Migration `202610100006_attendance_session_transition_fix.sql` avoids reapplying the non-school-day restriction and re-resolving academic periods during ordinary updates of existing attendance sessions, while retaining date/class/override validation and allowing administrators to correct academic-period metadata on saved registers. `npx supabase db push` applies pending migrations in order. If migrations `202610090001` through `202610090003` were previously applied manually, reconcile those versions with `npx supabase migration repair --status applied 202610090001 202610090002 202610090003` before pushing; do not rerun the initial schema against an already initialized database.
   Migration `202610100007_attendance_automation.sql` adds timetable-generated lesson registers (including academic week rotation and date overrides), substitute assignments, configurable attendance thresholds, absence follow-up tasks, in-app absence and late notices, leave and correction request workflows, notification templates/history, and attendance completion/analytics views. It installs `pg_cron` and schedules generation and follow-up jobs; verify `pg_cron` is available for the project before applying. The operations screen supports bulk register submission/closure, bulk correction decisions, and insert-only CSV imports. Email/SMS rows are queued for a separately configured delivery worker and are not sent by this migration; push delivery also requires device subscriptions.
   Migration `202610100008_timetable_teacher_subject_assignments.sql` permits school administrators and academic coordinators to manage teacher-subject eligibility. In a draft timetable's Schedule Builder, add each teacher/subject pairing under **Teacher subject assignments** before generating the timetable.
   Migration `202610100009_learning_test_maker.sql` adds school-scoped assessment drafts and a reusable question library, writable by school administrators and teachers. Teachers can create questions, import CSV/JSON question lists, configure and duplicate tests, and use the browser print dialog to save printable papers as PDFs. Cambridge past-paper access opens the official Cambridge resource page; only add content that your school is authorized to use.
   Migration `202610100010_authorized_past_papers.sql` adds school-scoped metadata for papers stored in Firebase Storage. Run `npm ci` from `app/` after pulling changes. Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `FIREBASE_SERVICE_ACCOUNT` (the complete Firebase service-account JSON), `FIREBASE_STORAGE_BUCKET`, and `PAPER_SOURCE_HOSTS` only in a trusted server environment or GitHub Actions secrets/variables. Never put these values in the Vite `.env` file, browser code, or client bundle.
   Migration `202610100011_basic_assessment_results.sql` adds school-scoped assessment attempts with a saved maximum-mark snapshot, database-calculated percentages, and teacher access limited to their assigned classes. The Learning → Results screen records and corrects marks, preserves separate retakes in each student's history, and prevents deleting tests that have recorded results.
   Migration `202610130001_grades_results_reports.sql` adds draft/approved/published result states, comment fields, audited administrator/coordinator corrections, published-result visibility for students and parents, and school-owned report templates. Open **Grades & results** to record and approve marks, publish results, configure grading bands and report designs, and download an individual or combined A4 PDF report. School administrators can save custom templates based on the five built-in layouts.
   The `Import authorized past paper` GitHub Actions workflow is manual (`workflow_dispatch`) and requires the source URL, target school and staff profile IDs, paper metadata, a specific rights basis, and an affirmative rights confirmation. Add the four credentials above as GitHub Actions secrets and `PAPER_SOURCE_HOSTS` as a comma-separated Actions variable; then use **Actions → Import authorized past paper → Run workflow**. The importer checks that the staff profile belongs to the school, requires an HTTPS source host on the allowlist, follows only allowlisted HTTPS redirects, verifies PDF content, caps downloads at 50 MB, buffers the document in memory, and writes the PDF privately to Firebase Storage. Supabase stores metadata and a checksum, not the PDF. Imports are not crawled or scheduled, and repeated filenames are refused to avoid overwrites. The source and school must have the necessary permission to copy and store the paper; do not use this to scrape or re-host Cambridge papers or third-party repositories without authorization. Firebase objects are private; serving them in the app requires a separately authenticated, short-lived signed-URL endpoint.
4. If the SQL Editor reports `column reference "school_id" is ambiguous` after a previous attempt, first run `app/supabase/migrations/202610090003_repair_ambiguous_school_policies.sql` in a new SQL Editor query. If it reports that the initial schema is missing, run the corrected `202610090001_initial_campus_connect.sql` first instead.
5. In **Authentication → URL Configuration**, set the Site URL to your deployed app origin and add its `/login` callback URL to Redirect URLs. During local development, allow the actual Vite origin, for example `http://localhost:5173/login` or `http://127.0.0.1:5173/login`.
6. In **Authentication → Providers → Email**, enable email signup and email confirmation. Configure the **Confirm signup** and **Reset password** templates. Supabase sends those transactional messages; the app directs confirmation and recovery links back to `/login`.
7. Apply the newer login-alert migration and deploy the Supabase Edge Function:

   ```powershell
   npx supabase db push
   npx supabase functions deploy login-alert
   ```

8. In the Supabase dashboard's **Edge Functions → Secrets**, set `POSTMARK_SERVER_TOKEN`, `POSTMARK_FROM_EMAIL` (a verified Postmark sender), `SECURITY_ALERT_EMAIL` (the security mailbox), and `LOGIN_ALERT_HASH_SECRET` (a random secret of at least 32 bytes). Do not put these values in the Vite `.env` file or browser bundle. Supabase supplies the function with its project URL and service-role secret; the service-role secret must remain in Edge Function/server configuration only.
9. Start the app from `app/`.

The project URL and anon key must come from the same active Supabase project. Copy the **Project URL** from the Supabase dashboard (Project Settings → API); a DNS error such as `ERR_NAME_NOT_RESOLVED` means the configured hostname cannot be found and authentication requests cannot reach Supabase. Correct `VITE_SUPABASE_URL` in `app/.env`, then restart Vite because environment variables are read at startup.

Supabase Auth sends signup verification and password-reset messages. The deployed `login-alert` Edge Function uses Postmark for successful-login notices and notifies the designated security mailbox after five failed-login responses for the same account/source within 15 minutes; repeat notices are limited to one per hour for that pair. Failed-attempt reports originate in the browser after Supabase rejects a sign-in, so treat them as a security signal, not authoritative audit evidence. Failed-attempt fingerprints are HMACed server-side and retained for at most 30 days. Do not email passwords, access tokens, or the submitted login credentials.

For production, configure custom SMTP in Supabase for reliable verification and password-reset delivery (the default email service is rate-limited and intended for testing), and verify the sender domain in Postmark. The Postmark Edge Function can be deployed without Postmark secrets, but alerts will return an error and will not be delivered until those secrets and the migration are configured.

## Deploying the app to Vercel

For this repository, set the Vercel project's **Root Directory** to `app`. In **Settings → Environment Variables**, set `VITE_SUPABASE_URL` to the exact Project URL shown in Supabase **Project Settings → API**, and `VITE_SUPABASE_ANON_KEY` to that same project's public anon key. These are build-time Vite variables: save them for Production (and Preview if needed), then redeploy the app. Updating only `app/.env` on your computer does not update the deployed site.

The `app/vercel.json` rewrite lets React Router serve `/login` and other client-side routes on a direct visit or an email-confirmation/password-reset redirect. In Supabase **Authentication → URL Configuration**, set the Site URL to the deployed site and add `https://<your-vercel-domain>/login` to Redirect URLs. After redeploying, open the Vercel `/login` route directly; it should load the app rather than return a 404.

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

This is the initial working application foundation—not a claim that every V1 module is complete. Full staff and family invitations, timetable editing, assignment submission/grading, learning-resource upload/download UX, advanced assessment and quiz workflows, richer announcements/events, notification inbox, messaging UI, advanced search, and settings management still need implementation before the larger supplied V1 definition of done is met. No sample users, customer claims, or hard-coded school statistics are included.

## Security notes

- `.env` is excluded from version control; only the Supabase public URL and anon key are used by this browser client.
- Do not add a Supabase service-role key to Vite environment variables.
- The SQL migration enables RLS for application tables and keeps files in private buckets.
- Configure Supabase Auth, email delivery, backups, deployment redirects, and production monitoring before deployment.
- Test policies with separate administrator, teacher, student, and parent accounts before storing real student data.
