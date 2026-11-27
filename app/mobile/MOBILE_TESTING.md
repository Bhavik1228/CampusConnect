# Campus Connect Mobile — Testing

## Automated
- `src/lib/validation.test.mjs` — ISBN normalization/validation, scan classification, module access gating. Run with `node --experimental-strip-types --test src/lib/validation.test.mjs`. Result: 4/4 pass.
- TypeScript strict typecheck: `npx tsc --noEmit` — clean.

## To add
- Tests for new screen helpers (role-based access, attendance status transitions)
- Component tests where practical

## Manual (requires a test Supabase project + Android device/emulator)
- Login / logout / session restore
- School selection (eligible vs ineligible schools)
- Each module screen loads and enforces role gating
- Scanner camera permission + manual entry fallback
- Visitor check-in/out, badge PDF
- Library ISBN lookup, checkout/return, sticker PDF
- Health visit save (nurse vs doctor gating)
- Expired session handling

## Notes
- No automated tests currently exercise Supabase or native modules.
- Backend permission tests should use separate administrator, teacher, student, and parent accounts on a non-production project.
