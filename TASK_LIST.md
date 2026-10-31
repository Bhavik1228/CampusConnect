# Campus Connect Task List

Status legend:
- [x] Implemented / understood in the current workspace
- [ ] Not yet implemented / pending

## 1. Platform Foundation

### 1.1 Multi-school architecture
- [x] Support multiple independent schools on one platform.
- [x] Create and configure school profiles.
- [x] Enforce school-level data isolation.
- [x] Associate users with their permitted school memberships.
- [x] Support school-specific settings, branding and academic years.
- [x] Prevent users from accessing another school's records.
- [x] Configure enabled modules separately for each school.
- [x] Support multiple campuses within a school.
- [x] Support school-specific feature configuration.
- [x] Support controlled cross-campus administration.

### 1.2 Authentication and security
- [x] Login, logout and session management.
- [x] Password recovery and account security.
- [x] Role-based access control.
- [x] Supabase Row Level Security policies.
- [x] Server-side permission checks for sensitive operations.
- [x] Account suspension and access revocation.
- [x] Audit logging for sensitive operations.
- [x] Secure file access and uploads.
- [x] Secure configuration and environment variables.
- [x] Session/device management.
- [x] Configurable multi-factor authentication.
- [x] Security event monitoring.

### 1.3 Shared platform capabilities
- [x] Responsive navigation and layouts.
- [x] Shared notification infrastructure.
- [x] Global search with permission filtering.
- [x] File and image storage.
- [x] Common loading, empty, error and success states.
- [x] Shared audit infrastructure.
- [x] Consistent school branding.
- [x] Accessible interface and keyboard navigation.
- [x] Customisable dashboards and saved views.
- [x] Platform-wide performance monitoring.

## 2. Roles and Permissions

### 2.1 Core roles
- [x] System Owner.
- [x] School Admin.
- [x] Teacher.
- [x] Student.
- [x] Parent/Guardian.
- [x] Finance Manager.
- [x] Accountant.
- [x] Bursar/Fees Officer.
- [x] Cashier.
- [x] Accounts Payable Officer.
- [x] Auditor/Read-only Reviewer.
- [x] Librarian.
- [x] Secretary.
- [x] School Nurse.
- [x] School Doctor.

Accounts Payable Officer is available as a restricted core role; supplier-payables workflows remain tracked in section 18.3.

### 2.2 Additional teaching responsibilities
- [x] Class Teacher/Form Tutor.
- [x] Head of Department.
- [x] Senior Teacher/Academic Coordinator.

### 2.3 Additional administrative responsibilities
- [x] Website Editor.
- [x] Website Publisher.
- [x] Admissions Officer.
- [x] HR/Staff Administrator.
- [x] Transport Manager.
- [x] Facilities Manager.
- [x] IT Support Technician.
- [x] Safeguarding Officer.
- [x] Procurement Officer.
- [x] Compliance/Audit Officer.

### 2.4 Permission management
- [x] Assign roles to users.
- [x] Configure role-specific module access.
- [x] Configure create, view, edit, delete and approve permissions.
- [x] Restrict users to assigned classes, departments and schools.
- [x] Prevent school users from granting themselves platform-level privileges.
- [x] Record permission changes.
- [x] Configure custom roles.
- [x] Support temporary delegated permissions.
- [x] Preview permissions before applying them.

## 3. Student Information Management
- [x] Create and edit student profiles.
- [x] Assign admission numbers and student identifiers.
- [x] Record student names, photographs and basic details.
- [x] Maintain class, year group, stream and enrolment information.
- [x] Link parents and guardians.
- [x] Record enrolment and withdrawal dates.
- [x] Search and filter student records.
- [x] Import student records.
- [x] Export authorised student lists.
- [x] Detect duplicate student records.
- [x] Maintain student status and enrolment history.
- [x] Control access to confidential student information.
- [x] Provide a consolidated student timeline.
- [x] Support academic-year history.
- [x] Provide profile completeness checks.
- [x] Support controlled record correction and merge workflows.

## 4. School, Academic Structure and Calendar
- [x] School and campus profiles.
- [x] Academic years and terms.
- [x] Classes, year groups and streams.
- [x] Subjects and subject assignments.
- [x] Class-subject relationships.
- [x] Teacher-class and teacher-subject assignments.
- [x] Room and facility records.
- [x] School holidays and term dates.
- [x] School calendar and events.
- [x] Academic grading configuration.
- [x] Subject combinations and optional subjects.
- [x] Academic-year rollover.
- [x] Student promotion and class allocation.
- [x] Academic-year rollover simulation.
- [x] Detect class-capacity and subject-allocation conflicts.

## 5. Admissions Management
- [x] Create and manage applications.
- [x] Configure application fields.
- [x] Record applicant and guardian details.
- [x] Track application status.
- [x] Upload and manage required documents.
- [x] Search and filter applications.
- [x] Assign applications to admissions staff.
- [x] Record decisions and authorised notes.
- [x] Convert accepted applications into student records.
- [x] Save-and-resume online applications.
- [x] Application document checklist.
- [x] Admissions appointment and open-day booking.
- [x] Enquiry-to-application tracking.
- [x] Configurable application stages and approval workflows.

## 6. Staff Management
- [x] Staff profiles.
- [x] Staff identifiers and contact details.
- [x] Job titles, departments and responsibilities.
- [x] Staff-to-school assignments.
- [x] Teacher subject and class assignments.
- [x] Staff document uploads.
- [x] Staff directory and authorised exports.
- [x] Staff account and role linkage.
- [x] Qualifications and certification tracking.
- [x] Employment document expiry reminders.
- [x] Staff attendance and leave management.
- [x] Workload summaries.
- [x] Substitute coverage planning.
- [x] Advanced HR and payroll integration (payroll-ready CSV export; provider-neutral).

## 7. Parent and Guardian Management
- [ ] Parent/guardian profiles.
- [ ] Link guardians to one or more students.
- [ ] Define authorised relationships and access.
- [ ] Parent portal access.
- [ ] Display authorised academic and attendance information.
- [ ] Display permitted announcements and school events.
- [ ] Display authorised fee statements and receipts.
- [ ] Parent-teacher meeting booking.
- [ ] Guardian consent and permission forms.
- [ ] Configurable family communication preferences.

## 8. Timetable Management

### 8.1 Configuration and creation
- [x] Configure periods, bells, breaks and school days.
- [x] Configure class, teacher, subject and room availability.
- [x] Build timetables manually.
- [x] Assign subjects, teachers, classes and rooms.
- [x] Detect teacher, class and room conflicts.
- [x] Save timetable drafts.
- [x] Publish approved timetables.
- [x] View daily and weekly timetables.
- [x] Provide role-specific timetable views.
- [x] Export and print timetables as PDFs.
- [ ] Automatic timetable generation.
- [ ] Substitution and cover management.
- [ ] Timetable exceptions and temporary changes.
- [ ] Change notifications.
- [ ] Timetable version history.
- [ ] Export CSV and iCalendar files.
- [ ] Optimisation and what-if scheduling.
- [ ] Advanced room and resource constraints.

## 9. Attendance Management

### Phase 1: Essential attendance
- [x] Daily and class attendance.
- [x] Record attendance for individual students.
- [x] Support Present, Absent, Late and Excused statuses.
- [x] Edit attendance with appropriate permissions.
- [x] View historical attendance.
- [x] Calculate attendance percentages.
- [x] Generate attendance registers and reports.
- [x] Prevent duplicate submissions.
- [x] Audit attendance corrections.
- [x] Export and print attendance registers.

### Phase 2: Workflow improvements
- [ ] Integrate attendance with the timetable.
- [ ] Attendance reminders and follow-up tasks.
- [ ] Student leave and absence requests.
- [ ] Configurable attendance rules.
- [ ] Bulk attendance operations.

## 10. Teacher Workspace

### 10.1 Dashboard and class access
- [x] Recent classroom activity.
- [x] Quick links to frequently used classes.
- [ ] Customisable dashboard widgets.
- [ ] Teacher workload overview.

### 10.2 Class and student access
- [x] View assigned class lists.
- [x] Search assigned students.
- [x] View authorised student profiles.
- [x] View subject enrolments and academic progress.
- [x] View authorised attendance history.
- [x] Export permitted class lists.
- [x] Print class registers.
- [ ] Add teacher observations.
- [ ] Flag students needing academic support.

### 10.3 Lesson planning and resources
- [x] Create lesson plans.
- [x] Record objectives and learning outcomes.
- [x] Record topics and subtopics.
- [x] Link plans to classes and subjects.
- [x] Maintain schemes of work.
- [x] Track syllabus coverage.
- [x] Upload and share teaching resources.
- [x] Reuse lesson templates.
- [x] Record completed, missed or rescheduled lessons.
- [ ] Compare planned versus completed syllabus coverage.

### 10.4 Assignments and homework
- [x] Create assignments and homework.
- [x] Set deadlines and maximum marks.
- [x] Assign work to selected classes.
- [x] Attach learning materials.
- [x] View submitted and missing work.
- [x] Mark submissions and provide feedback.
- [x] Return marked work.
- [x] Record late submissions.
- [x] Reuse or duplicate assignments.
- [ ] Allow resubmissions.
- [ ] Schedule publication and reminders.
- [ ] Export assignment results.

### 10.5 Assessments and marks
- [x] Create tests and assessments.
- [x] Configure assessment dates and maximum marks.
- [x] Enter marks individually.
- [x] Enter marks in a spreadsheet-style grid.
- [x] Validate marks against maximum scores.
- [x] Save draft marks.
- [x] Submit marks for approval where required.
- [x] Calculate configured grades and percentages.
- [x] Identify missing marks.
- [x] Export marksheets.
- [x] Record authorised corrections and change history.
- [ ] Import marks from CSV.
- [ ] Compare assessment trends.
- [ ] Support marking moderation and approval.

### 10.6 Progress and reporting
- [x] View subject-specific student progress.
- [x] Record academic concerns.
- [x] Set learning targets.
- [x] Prepare report-card comments.
- [x] View class performance summaries.
- [ ] Track academic interventions.
- [ ] Compare progress across terms.
- [ ] Generate student progress summaries.

### 10.7 Communication and classroom behaviour
- [x] View school announcements.
- [x] Create class announcements where authorised.
- [x] Send permitted assignment reminders.
- [ ] Message authorised students or guardians.
- [ ] Record positive behaviour and achievements.
- [ ] Record permitted classroom incidents.
- [ ] Refer serious concerns to authorised staff.
- [ ] Track follow-up actions.

### 10.8 Additional teacher responsibilities
- [ ] Class Teacher/Form Tutor dashboard.
- [ ] Class-wide attendance and progress oversight.
- [ ] Form-period activities and notices.
- [ ] Head of Department dashboard.
- [ ] Departmental syllabus and assessment oversight.
- [ ] Departmental reports.
- [ ] Senior Teacher/Academic Coordinator dashboard.
- [ ] Academic completion and report-card oversight.

## 11. Learning Management System
- [x] Learning material library.
- [x] Upload PDFs, documents, presentations and links.
- [x] Organise resources by subject, class and topic.
- [x] Share resources with authorised students.
- [x] Assign learning materials to lessons.
- [x] Student access to assigned materials.
- [x] Assignment submission workflow.
- [x] Assessment and examination integration.
- [ ] Quizzes and online tests.
- [ ] Question banks.
- [ ] Reusable assessment blueprints.
- [ ] Rubric-based marking.
- [ ] Learning progress tracking.
- [ ] Resource versioning.
- [ ] Advanced learning analytics.
- [ ] Human-reviewed AI-assisted educational tools.

## 12. Cambridge Past-Paper Test Maker
- [x] Import authorised past papers and question documents.
- [x] Upload PDFs and extract text where possible.
- [x] Support OCR for scanned documents.
- [x] Organise questions by syllabus and qualification.
- [x] Tag questions by subject, paper, variant and marks.
- [x] Build a searchable question bank.
- [x] Create tests manually from selected questions.
- [x] Configure question order and marks.
- [x] Generate formatted question-paper PDFs.
- [x] Support mark schemes and answer documents where available.
- [ ] Generate tests using configurable criteria.
- [ ] Support online assessments and assignments.
- [ ] Support marking and result recording.
- [ ] Provide assessment analytics.
- [ ] Allow teacher review before generated papers are used.
- [ ] Human-reviewed AI-assisted question generation.
- [ ] Detect duplicate or very similar questions.
- [ ] Track source and usage permissions for imported materials.

## 13. Examinations and Results
- [x] Create examination sessions.
- [x] Schedule examination dates and times.
- [x] Allocate subjects and classes.
- [x] Enter and validate marks.
- [x] Configure grading scales.
- [x] Calculate totals, percentages and grades.
- [x] Track missing marks.
- [x] Generate examination reports.
- [x] Control result approval and publication.
- [x] Maintain result correction history.
- [ ] Examination seating plans.
- [ ] Candidate-number allocation.
- [ ] Invigilator scheduling.
- [ ] Examination clash detection.
- [ ] Marks moderation.
- [ ] Printable examination timetables.
- [ ] Report-card generation.

## 14. Reports Management
- [x] Reports dashboard.
- [x] Categorised reports.
- [x] Recent and favourite reports.
- [x] Search and filter reports.
- [x] Role-based report access.
- [x] Student reports.
- [x] Attendance reports.
- [x] Academic and class reports.
- [x] Assessment and examination reports.
- [x] Staff reports.
- [x] Administrative reports.
- [x] Report filters and date ranges.
- [x] Report preview.
- [x] PDF, CSV and print exports.
- [x] School-level data isolation.
- [x] Report generation audit logs.
- [ ] Custom report builder.
- [ ] Saved report definitions.
- [ ] Cross-module reporting.
- [ ] Scheduled report packs.
- [ ] Data freshness indicators.

## 15. Student Health Module
- [x] Select an existing student.
- [x] Display student name, ID/admission number, class, stream and basic details.
- [x] Record clinic visit date and time.
- [x] Record symptoms.
- [x] Record clinical notes.
- [x] Record temperature when measured.
- [x] Record heart rate when measured.
- [x] Record blood pressure when measured.
- [x] Record weight and height when measured.
- [x] Support other optional measured vitals.
- [x] Record assessment or diagnosis when applicable and entered by an authorised professional.
- [x] Record prescriptions when prescribed, including medication, dosage, frequency, duration and instructions.
- [x] Save the health record linked to the existing student profile.
- [x] View previous clinic visits and details.
- [x] Allow School Nurse to create and manage permitted visit records.
- [x] Allow School Doctor to record authorised assessments and prescriptions.
- [x] Allow School Admin to configure access and assign health staff without automatically exposing private clinical notes.
- [x] Enforce strict clinical-record permissions and audit access.
- [x] Preserve correction history.
- [ ] Health inventory management.
- [ ] Parent health portal.
- [ ] Advanced health analytics.
- [ ] Incident management.

## 16. Library Management

### 16.1 Catalogue
- [x] Add, edit and archive books.
- [x] Search by title, author, ISBN and category.
- [x] Record publishers, editions and publication details.
- [x] Fetch book metadata from available online sources.
- [x] Fetch online book covers where available.
- [x] Upload, replace and correct cover images.
- [x] Preview and confirm automatically retrieved metadata.
- [x] Detect duplicate ISBNs and catalogue records.
- [x] Support manual entry when online metadata is unavailable.
- [x] Manage categories, authors and publishers.

### 16.2 ISBN scanning and inventory
- [x] Scan ISBN-10 and ISBN-13 barcodes.
- [x] Add books using scanned ISBN information.
- [x] Track individual physical copies.
- [x] Assign accession numbers.
- [x] Record shelf, condition and circulation status.
- [x] Generate internal barcodes or QR codes.
- [x] Prevent duplicate copy registration.

### 16.3 Book stickers and PDFs
- [x] Generate book stickers.
- [x] Include title, author, ISBN and accession number as configured.
- [x] Include barcode or QR code.
- [x] Include school/library branding.
- [x] Preview sticker sheets.
- [x] Configure sticker dimensions and page layouts.
- [x] Generate labels in bulk.
- [x] Download sticker PDFs.
- [x] Print sticker sheets.
- [x] Support common paper sizes and margins.

### 16.4 Circulation and reporting
- [x] Register library members.
- [x] Issue and return books.
- [x] Renew loans.
- [x] Track due dates and overdue loans.
- [x] View borrowing history with appropriate permissions.
- [x] Generate inventory and circulation reports.
- [ ] Public catalogue website integration.
- [ ] Acquisition suggestions based on circulation.
- [ ] Batch catalogue enrichment.

## 17. Visitor Management

### Phase 1: Registration and records
- [x] Create visitor records.
- [x] Record visitor name and phone.
- [x] Record organisation and visit purpose.
- [x] Record host or department.
- [x] Record ID type/number when required by school policy.
- [x] Record visit date and time.
- [x] Search and view authorised visitor records.

### Phase 1: Check-in and check-out
- [x] Check visitors in and out.
- [x] Automatically record timestamps.
- [x] Display currently checked-in visitors.
- [x] Support Expected, Checked In, Checked Out and Cancelled statuses.
- [x] Prevent duplicate active check-ins.

### Phase 1: QR badges and PDFs
- [x] Generate a unique visitor badge number.
- [x] Create a badge containing permitted visitor details.
- [x] Include school branding, date and validity.
- [x] Generate a unique QR code.
- [x] Preview the badge.
- [x] Download badge as PDF.
- [x] Print individual badges.
- [x] Scan and verify QR badges.
- [x] Reject invalid, expired or revoked badges.
- [x] Prevent unauthorised check-out actions.

### Phase 1: Secretary role and oversight
- [x] Create Secretary role.
- [x] Allow authorised visitor registration and corrections.
- [x] Allow check-in/check-out.
- [x] Allow badge creation, preview, download and printing.
- [x] Allow QR generation and verification.
- [x] Display current visitors and recent arrivals/departures.
- [x] Audit registration, badge issuance and record changes.
- [x] Restrict visitor records by school and role.
- [ ] Appointment scheduling.
- [ ] SMS integrations.
- [ ] Self-service kiosks.
- [ ] Advanced analytics.
- [ ] Approval workflows.

## 18. Accounting and Fees Management

### 18.1 Finance dashboard
- [ ] Income and expense overview.
- [ ] Cash and bank balances.
- [ ] Fees collected and outstanding.
- [ ] Pending payments.
- [ ] Recent transactions.
- [ ] Monthly finance summary.

### 18.2 Student fees
- [ ] Configure fee structures.
- [ ] Generate invoices.
- [ ] Manage student fee statements.
- [ ] Record full and partial payments.
- [ ] Allocate payments to invoices.
- [ ] Track outstanding balances.
- [ ] Manage authorised discounts and adjustments.
- [ ] Generate payment receipts.
- [ ] Record refunds and reversals with audit history.

### 18.3 Expenses and suppliers
- [ ] Record expenses.
- [ ] Manage supplier records.
- [ ] Record supplier bills.
- [ ] Track outstanding supplier payments.
- [ ] Restrict approval and payment permissions.

### 18.4 Basic accounting
- [ ] Chart of accounts.
- [ ] Double-entry bookkeeping.
- [ ] General ledger.
- [ ] Journal entries.
- [ ] Trial balance.
- [ ] Cashbook and bank records.
- [ ] Bank reconciliation.
- [ ] Financial reports.
- [ ] Audit and correction history.

### 18.5 Finance roles
- [ ] Finance Manager permissions.
- [ ] Accountant permissions.
- [ ] Bursar/Fees Officer permissions.
- [ ] Cashier permissions.
- [ ] Accounts Payable Officer permissions.
- [ ] Auditor/read-only reviewer permissions.

### 18.6 Later finance features
- [ ] Budgeting.
- [ ] Payroll integration.
- [ ] Tax configuration.
- [ ] Asset accounting.
- [ ] Payment gateway integrations.
- [ ] Advanced finance analytics.
- [ ] Anomaly flags.

## 19. System Owner Panel
- [x] Platform-wide dashboard.
- [x] Create and manage schools.
- [x] View school status and configuration.
- [x] Manage global users.
- [x] Manage platform roles and permissions.
- [x] Configure platform-wide settings.
- [x] Enable and disable modules.
- [x] Send platform notifications.
- [x] View global audit logs.
- [x] Monitor basic service health.
- [x] View basic platform reports.
- [x] Manage owner account security.
- [x] Enforce owner-only access to platform controls.
- [ ] Support and issue management.
- [ ] Global search.
- [ ] Storage usage and backup status.
- [ ] Cross-school configuration comparison.
- [ ] Platform-wide incident controls.
- [ ] Advanced cross-school analytics.

## 20. Maintenance Mode
- [ ] Enable and disable global maintenance.
- [ ] Display current maintenance status.
- [ ] Create and edit maintenance notices.
- [ ] Preview the maintenance page.
- [ ] Configure maintenance start and end times.
- [ ] Schedule automatic activation and deactivation.
- [ ] Provide an emergency maintenance switch.
- [ ] Restrict writes during maintenance.
- [ ] Provide authorised System Owner access.
- [ ] Record maintenance events in audit logs.
- [ ] Monitor service health and database connectivity.
- [ ] Verify service restoration.
- [ ] School-specific maintenance mode.
- [ ] Module-specific maintenance mode.
- [ ] Read-only mode.
- [ ] Admin exceptions.
- [ ] Countdown and estimated downtime.
- [ ] Platform and school impact reports.
- [ ] Recovery and rollback tracking.
- [ ] Backup verification and restoration alerts.

## 21. Notifications, Messaging and Calendar
- [x] In-app notifications.
- [x] School announcements.
- [x] Academic calendar and events.
- [x] Role-targeted notifications.
- [x] Notification history.
- [x] Notification preferences.
- [ ] Email integration.
- [ ] Push notifications.
- [ ] Configurable messaging between authorised users.
- [ ] Delivery status and failure reporting.
- [ ] Quiet hours and communication preferences.
- [ ] Parent-teacher meeting scheduling.
- [ ] Scheduled reminders and event notifications.

## 22. Automations Module

### 22.1 Workflow management
- [ ] Create, edit, duplicate and delete workflows.
- [ ] Enable, pause and resume workflows.
- [ ] Categorise and search workflows.
- [ ] Track workflow status.
- [ ] Validate workflows before activation.
- [ ] Display last and next execution times.
- [ ] Prevent duplicate or conflicting workflows.

### 22.2 Triggers, conditions and actions
- [ ] Scheduled and recurring triggers.
- [ ] Supported record-created and record-updated triggers.
- [ ] Date and status-change triggers.
- [ ] Supported attendance, assignment, assessment, fee and admissions triggers.
- [ ] AND/OR conditions.
- [ ] Field, status, date and numeric conditions.
- [ ] In-app notification actions.
- [ ] Administrative task creation.
- [ ] Permitted record updates.
- [ ] Multiple supported actions in sequence.
- [ ] Dry-run mode.
- [ ] Server-side execution, idempotency and retry protection.

### 22.3 Preset automation templates
- [ ] Attendance Submission Reminder.
- [ ] Low Attendance Alert.
- [ ] Assignment Deadline Reminder.
- [ ] Missing Marks Reminder.
- [ ] Overdue Fees Follow-up.
- [ ] Payment Recorded Notification.
- [ ] Overdue Library Book.
- [ ] New Admission Application.
- [ ] Pending Application Reminder.
- [ ] Upcoming School Event Reminder.
- [ ] Staff Task Deadline Reminder.
- [ ] Daily Administrative Summary.
- [ ] Browse and filter presets.
- [ ] Create a draft from a template.
- [ ] Customise, duplicate and save school templates.
- [ ] Check required modules and permissions.
- [ ] Version templates without overwriting custom workflows.

### 22.4 Execution and audit
- [ ] Run history.
- [ ] Successful, skipped and failed status.
- [ ] Action-level execution details.
- [ ] Retry eligible failures safely.
- [ ] Error reporting and repeated-failure alerts.
- [ ] Audit changes and manual execution.
- [ ] Advanced branching.
- [ ] External webhooks and integrations.
- [ ] AI-assisted workflow creation.

## 23. Document and PDF Management
- [ ] Generate branded PDFs from authorised records.
- [ ] Generate report cards, marksheets and attendance registers.
- [ ] Generate invoices, receipts and statements.
- [ ] Generate admission forms and certificates.
- [ ] Generate timetables and examination schedules.
- [ ] Generate library stickers and visitor badges.
- [ ] Preview, download and print PDFs.
- [ ] Generate documents in bulk.
- [ ] Store files securely.
- [ ] Manage document categories and versions.
- [ ] Record generation and download history.
- [ ] Configure school branding, headers, footers and page numbering.
- [ ] Visual document template designer.
- [ ] Dynamic fields and conditional sections.
- [ ] Repeating tables and complex page layouts.
- [ ] Merge and split PDFs.
- [ ] ZIP downloads for authorised bulk exports.
- [ ] Background batch generation and retry.
- [ ] Watermarks such as Draft and Confidential.
- [ ] Version comparison.
- [ ] OCR and scanned-document search.
- [ ] Accessible PDF validation.
- [ ] Document retention and legal holds.
- [ ] Duplicate-document detection.
- [ ] Secure temporary download links.

### 23.1 Advanced document capabilities
- [ ] Student Record Pack Generator.
- [ ] Assemble authorised records for school transfers.
- [ ] Identify missing documents in record packs.
- [ ] Create indexed, ordered document packages.
- [ ] Unique certificate verification codes and QR codes.
- [ ] Public authenticity verification without exposing private records.
- [ ] Certificate revocation and replacement.
- [ ] Digital approval and signing workflows.
- [ ] Advanced digital credential integrations.

## 24. Templates Library
- [ ] Central template gallery.
- [ ] Report-card templates.
- [ ] Invoice and receipt templates.
- [ ] Certificate and award templates.
- [ ] Admission form templates.
- [ ] Timetable and examination schedule templates.
- [ ] Library sticker templates.
- [ ] Visitor badge templates.
- [ ] Newsletter and prospectus templates.
- [ ] Website theme templates.
- [ ] Preview templates before use.
- [ ] Apply school branding.
- [ ] Duplicate and customise templates.
- [ ] Restore original template configurations.
- [ ] Version control for templates.
- [ ] Publish platform-wide presets.
- [ ] Allow school-specific template libraries.
- [ ] Track template compatibility with enabled modules.

## 25. School Website Management

### 25.1 Website structure and design
- [ ] School-specific public website.
- [ ] Custom school logo, colours and branding.
- [ ] Homepage and navigation.
- [ ] About Us, academics and facilities pages.
- [ ] Contact page and enquiries.
- [ ] News, announcements and events.
- [ ] Gallery and downloads.
- [ ] Admissions information.
- [ ] Public fee information.
- [ ] Public library catalogue.
- [ ] Responsive mobile layouts.
- [ ] Website editor with drafts and preview.
- [ ] Publish and unpublish controls.
- [ ] Separate configuration and content for each school.

### 25.2 Website content management
- [ ] Edit and preview page content.
- [ ] Upload banners, photographs and documents.
- [ ] Manage menus and footers.
- [ ] Schedule page publication.
- [ ] Schedule content expiry.
- [ ] Maintain version history.
- [ ] Restrict publishing to authorised users.
- [ ] Reusable page sections.
- [ ] Visual drag-and-drop page builder.
- [ ] Desktop, tablet and mobile preview.
- [ ] Website theme switching and rollback.
- [ ] Private preview links.
- [ ] Separate editor and publisher permissions.

### 25.3 Website integrations
- [ ] Publish approved announcements.
- [ ] Display approved events and term dates.
- [ ] Publish approved news.
- [ ] Display approved examination timetables.
- [ ] Publish approved public fee schedules.
- [ ] Display approved library catalogue cards.
- [ ] Manage website SEO and metadata.
- [ ] Publish approved admissions content.

## Quality of Life Features Update

### Feature 01: Global Command Palette & Universal Search
- [x] Open a keyboard-accessible global palette with Ctrl/Cmd+K and a visible search control.
- [x] Search accessible pages, role-gated actions, settings, and school records.
- [x] Search students, classes, subjects, books, and finance-authorized invoices with school-scoped server queries.
- [x] Support keyboard navigation, favorites, recent items, and record-aware navigation.
- [x] Record school-scoped usage metrics without storing raw search terms.
- [x] Document the palette and its migration/deployment requirements.

### Features 02–70
- [ ] Pending: their specifications were not included with the supplied Feature 01 brief.

## Priority Order for Next Implementation
1. Roles and permissions
2. Admissions management
3. Accounting and fees management
4. Maintenance mode
5. Automations module
6. Document and PDF management
7. Templates library
8. School website management

## Notes
- The current workspace already includes a substantial first implementation of the platform, especially around school management, timetables, attendance, reporting, health, library, visitor management, and the system owner panel.
- The unchecked items are the remaining functional backlog to be implemented in later phases.
