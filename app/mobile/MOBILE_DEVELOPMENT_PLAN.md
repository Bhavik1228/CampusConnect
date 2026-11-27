# Campus Connect Mobile — Development Plan

Current phase: expanding the existing Expo mobile app beyond its initial four modules (visitors, library, health, notifications) toward the full mobile product scope.

## Baseline state (verified)
- TypeScript strict typecheck: clean (`npx tsc --noEmit` passes)
- Validation tests: 4/4 pass
- App runs in Expo dev client; android/ native folder generated
- `.env` configured with the same Supabase URL/anon key as the web app (gitignored, not recorded here)

## Remaining work (priority order)
1. Students directory + profiles (read-only, RLS-protected)
2. Teachers/staff directory (read-only, RLS-protected)
3. Attendance register: select class, mark present/absent/late, submit (`transition_attendance_session`)
4. Timetable view (daily/weekly, read-only)
5. Finance: student fee invoices + record payment (`record_student_fee_payment`, finance roles only)
6. Additional polish: empty/error states, deep links, OTA update notes
7. Release guide: APK/AAB build instructions (cannot be produced in this environment)

## Not in scope for this session
- Producing a signed APK/AAB (no Android SDK, Java 8 only, no EAS credentials)
- Backend schema changes beyond what already exists
- Push-notification delivery (backend lacks push-token registration/delivery worker)
- Per-copy library barcode tracking (backend stores barcode at title level)
