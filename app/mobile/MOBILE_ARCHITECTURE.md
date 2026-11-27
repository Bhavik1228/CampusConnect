# Campus Connect Mobile — Architecture

This document describes the current architecture of the Expo/React Native mobile application in `app/mobile/`. It is kept accurate to the implemented code; it does not claim unfinished features are complete.

## Stack
- **Framework**: Expo SDK 58, React Native 0.88, React 19.3, TypeScript (strict)
- **Navigation**: Expo Router (file-based, `src/app/`), stack + tabs
- **Backend**: Existing Campus Connect Supabase project (same as the web app). No second database.
- **Auth**: Supabase Auth (email/password), session persisted in `expo-secure-store`
- **Native modules**: `expo-camera`, `expo-notifications`, `expo-secure-store`, `expo-file-system`, `expo-print`, `expo-sharing`, `expo-updates`, `expo-linking`, `expo-web-browser`, `expo-crypto`, `@react-native-community/netinfo`, `react-native-reanimated`, `react-native-safe-area-context`, `react-native-screens`
- **QR/barcode**: `qrcode` (generate), `expo-camera` (scan)
- **Styling**: inline `StyleSheet` (no Tailwind), shared `src/components/ui.tsx` design tokens/components

## Directory layout
```
app/mobile/
  app/                     # Expo Router screens (each file = a screen)
    _layout.tsx            # Root stack: auth -> select-school -> (tabs) -> feature screens
    +html.tsx, +not-found.tsx
    index.tsx              # Auth gate: login / select-school / tabs
    login.tsx
    select-school.tsx
    (tabs)/_layout.tsx     # Bottom tabs: home, scan, modules, notifications, profile
    (tabs)/index.tsx       # Home dashboard
    (tabs)/scan.tsx        # QR/barcode scanner
    (tabs)/modules.tsx     # Module catalogue
    (tabs)/notifications.tsx
    (tabs)/profile.tsx
    visitors.tsx           # Visitor management (scan/register/check-in/out/badge PDF)
    library.tsx            # Library catalogue, ISBN lookup, checkout/return, stickers
    health.tsx             # Student health clinic visits (nurse/doctor only)
  src/
    lib/
      auth-context.tsx     # Campus auth: session, memberships, selectSchool, registerSession
      supabase.ts          # Supabase client (anon key, secure-store persistence)
      types.ts             # MobileModule, MobileRole, MobileMembership, domain types
      validation.ts        # canUseModule, classifyScan, ISBN helpers
      pdf.ts               # printOrSharePdf, htmlDocument, escapeHtml
      validation.test.mjs  # Node tests for validation helpers
    components/
      ui.tsx               # Page, Card, Button, Field, Loading, Message, ConnectivityBanner
      Themed.tsx, StyledText.tsx, ExternalLink.tsx, EditScreenInfo.tsx
      useClientOnlyValue.ts, useColorScheme.ts
  constants/Colors.ts
  assets/                  # app icon, splash, fonts
  android/                 # Generated native project (Continuous Native Generation)
  app.json, app.config.js, eas.json
```

## Authentication & session
- `AuthProvider` restores the Supabase session from secure store, then calls the backend RPC `register_mobile_app_session('android', appVersion)` which returns the user's school memberships with mobile eligibility (`eligible`, `mobile_enabled`, `platform_enabled`, `accessible_modules`).
- `selectSchool(schoolId)` stores the active school; only memberships returned as eligible may be selected.
- `signOut` calls `unregister_mobile_app_session` then `supabase.auth.signOut()`.
- Sensitive session tokens are never written to plain local storage; they live in `expo-secure-store`.

## Access control
- Frontend: `canUseModule(membership, module)` gates the backend-supported mobile modules (`visitors`, `library`, `health`, `notifications`) using `accessible_modules` returned by `register_mobile_app_session`.
- Backend: every Supabase query/RPC is protected by existing RLS policies and security-definer functions. The frontend never bypasses authorization; hiding a screen is never the sole protection for data.
- The backend `mobile_module_access_allowed` function currently only recognizes `visitors`, `library`, `health`, `notifications`. Adding further backend-gated mobile modules requires a small, version-controlled migration extending that function and `school_module_settings`.

## Screens implemented
- **Auth**: login, password-reset request, session restore
- **School selection**: choose an eligible enabled school; shows ineligible schools with reasons
- **Tabs**: Home, Scan, Modules, Notifications, Profile
- **Visitor management**: register expected visitor, check-in/check-out/cancel, audit history, badge PDF with QR
- **Library**: catalogue search, Open Library ISBN metadata, add book, checkout with one-time return code, return verification, sticker PDFs
- **Student health**: student search, clinic visit record (symptoms, vitals, prescriptions), nurse/doctor diagnosis gating, visit history
- **Notifications**: in-app notices, mark as read, refresh

## Native capabilities
- Camera: requested only when the scanner is opened; manual entry fallback
- Notifications: device permission check/request (push delivery not yet configured on this backend)
- PDF: `expo-print` + `expo-sharing` for badge/sticker/return-pass PDFs
- Offline: connectivity banner; no sensitive data cached offline; protected actions require connectivity

## Build
- EAS build profiles: `preview` (internal APK), `production` (signed APK)
- Android package: `com.campusconnect.mobile`
- **APK cannot be produced in this environment**: no Android SDK and no Java 17+ (only Java 8 is installed), and no EAS credentials are available. See `MOBILE_RELEASE_GUIDE.md` (planned) for how to build on a machine with Android tooling or EAS.

## Security boundaries respected
- No Supabase service-role key in the app; only the public anon key.
- No passwords or credentials stored in code or `.env` (`.env` is gitignored).
- No production system-owner credentials used or recorded.
- No offline caching of clinical/financial data.
- RLS remains the authorization authority.
