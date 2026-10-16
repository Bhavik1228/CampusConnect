# Campus Connect Android app

The Expo app in this folder connects to the existing Campus Connect Supabase project. It does not create a second database. Its first release focuses on mobile school access, a role-aware home, badge/barcode scanning, visitor management, library ISBN/catalogue workflows, confidential health visits, in-app notifications, and PDF sharing/printing.

## Configuration

1. From `app/mobile`, copy `.env.example` to `.env`.
2. Set `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` to the same Supabase project used by the web application. The anon key is public configuration; never put a service-role key in the app.
3. Set `EXPO_PUBLIC_WEB_URL` to the production web URL so generated visitor badge QR codes point to the existing protected verification page.
4. From `app/`, apply pending database migrations to the project:

   ```powershell
   npx supabase db push --project-ref <your-project-ref>
   ```

   Migration `202610160001_android_app_access.sql` creates school-level Android access settings and audit history, registers mobile sessions, and applies backend checks to shared membership, visitor, health, library, student-roster, and notification access. It preserves web sessions. The System Owner can suspend mobile access globally in the existing platform feature controls.

5. In the web app, first enable **Settings → Modules & features** for each mobile service the school intends to use. Then enable **Android app access** in the same settings page and select allowed features for each school role. A role cannot gain permissions the web backend does not already grant it. Visitor, health, library, and notification data stay protected by their existing server authorization.

## Run and build

```powershell
cd app\mobile
npm install
npm run typecheck
npm test
npx expo start
```

Run the Android development app with `npm run android` and a configured Android emulator/device. Camera behavior must be verified on a physical device as well as an emulator.

Install the EAS CLI and authenticate, then build an internal test APK:

```powershell
npm install --global eas-cli
eas build --platform android --profile preview
```

Build a signed Play Store bundle with:

```powershell
eas build --platform android --profile production
```

EAS account credentials and Android signing material are managed outside this repository. Do not commit those credentials.

## Mobile workflows

- Login uses the existing Supabase Auth accounts and secure device storage. Users can choose among school memberships that report mobile eligibility.
- The scanner requests camera access only when opened. It routes visitor badge references, ISBN-10/ISBN-13, library accession codes, and 16-character library return codes to the relevant workflow. Manual entry is available if camera access is denied.
- Visitor reads and status changes use the existing RLS-protected records and `save_visitor_record` / `transition_visitor_status` RPCs. Badge PDFs contain a QR reference, not visitor personal details in the QR payload.
- Library metadata lookup uses the same Open Library lookup used by the web app. Catalogue writes, student selection, checkouts, and returns use the current Supabase schema and RPCs. Sticker PDFs use the existing title-level barcode.
- Health records use `student_health_visits` and `save_student_health_visit`. The app only shows this workflow to nurse/doctor roles and submits no invented vital signs.
- Notifications are read from the existing `notifications` table. Android push delivery is not configured in this repository; enabling device notification permission alone does not create push delivery.
- PDF output uses Android's system print/share flow. Device printer support depends on Android's installed print service.
- The app requires connectivity for all protected operations. It does not cache medical information or perform sensitive offline actions.

## Known backend limitations

- The current library data model stores inventory counts and a barcode on the book title, not a barcode per physical copy. This app intentionally uses the existing model and does not pretend to provide per-copy tracking.
- The web schema currently has no shared mobile push-token registration/delivery worker. Push notifications need that backend work before they can be delivered.
- Visitor photo capture and per-copy barcode inventory are not added by this initial mobile package.
- The existing book metadata provider is Open Library; metadata availability varies by ISBN and requires an internet connection.
- Supabase access tokens do not prove whether a request came from the Android app or the web app. The app registers its sessions and backend policies apply the configured mobile restrictions to those sessions, but a client that deliberately skips registration is not cryptographically distinguishable from a web client. These settings are role/module controls for the official app, not a hard native-client boundary. Enforcing a strict client boundary requires a trusted gateway or server-issued claims and corresponding changes to web authentication.

## Test checklist

1. Apply the migration in a non-production Supabase project first, then verify a school starts with Android access disabled.
2. Enable relevant school modules and Android access. Confirm allowed roles can select the school, while non-selected roles and schools show a clear unavailable state.
3. Disable Android access while a mobile session is active. Refresh access and confirm protected data requests fail, while the web app remains usable.
4. Verify the System Owner platform-wide mobile switch disables mobile access.
5. Test visitor QR, invalid/expired badge, manual visit ID, check-in/out, duplicate active visitor handling, and badge PDF print/share.
6. Test valid/invalid ISBNs, metadata lookup failure, duplicate title detection, book checkout/return codes, sticker PDF, and restricted library roles.
7. Test health student search, optional vitals left blank, nurse diagnosis restriction, doctor diagnosis, record save/history, and unauthorized-role denial.
8. Test offline indicator, interrupted requests, camera denial/retry, app background/resume, expired sessions, and logout.

The repository build/type checks do not substitute for authenticated tests on a physical Android device and a test Supabase project.
