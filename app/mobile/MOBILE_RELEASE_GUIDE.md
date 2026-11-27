# Campus Connect Mobile — Release Guide

## Important: APK cannot be produced in this environment

This machine does not have the Android SDK (`ANDROID_HOME` is unset) and only has Java 8, while Android builds for this project require Java 17+. There are also no Expo EAS credentials available. Therefore **no signed APK or AAB can be generated here**.

The app code is complete, typechecked, and tested, and is ready to be built on a machine with Android tooling or via EAS in the cloud.

## Option 1: EAS build (cloud, recommended — no local Android Studio needed)

From `app/mobile`:

```powershell
# 1. Install EAS CLI and log in (one time)
npm install -g eas-cli
eas login

# 2. Initialize the EAS project (links this folder to your Expo account)
eas init

# 3. Build an internal-test APK (preview channel)
eas build --platform android --profile preview

# 4. Build a signed distribution APK (production channel)
eas build --platform android --profile production
```

The `eas.json` already defines `preview` (internal distribution APK) and `production` (signed APK) profiles. The built APK can be downloaded from the EAS dashboard or the CLI output.

EAS Update can ship JS/CSS/asset updates over the air after the initial build:

```powershell
eas update --channel production --message "Describe the change"
```

Native changes (new permissions, dependencies, Expo SDK upgrade) require a new signed APK.

## Option 2: Local Android build

Requires Android Studio / command-line tools with `ANDROID_HOME` set and Java 17+.

```powershell
cd app\mobile
npm install
npx expo prebuild           # generates ios/ and android/ (Continuous Native Generation)
npx expo run:android        # debug build to an emulator/device
```

For a release APK locally you need a signing keystore configured in `android/` and Gradle release signing — signing material must be created and stored by you, never committed to the repository.

## APK distribution (per the existing mobile README)

1. Upload the signed production APK to a **public** Supabase Storage bucket named `mobile-app` as `campus-connect-latest.apk`.
2. Set `VITE_ANDROID_APK_URL` in the web app's Vercel environment to the stable public URL for that object, and `VITE_PUBLIC_APP_URL` to the production web-app origin.
3. Redeploy the web app. After a school administrator enables Android access, **Settings → Modules & features** displays that school's download QR, which opens `/mobile/install?school=<school-id>` and offers the APK download.

Android will prompt the user to permit installing apps from outside Google Play — this cannot be bypassed by the QR code.

## Environment (.env, gitignored — never commit)

Copy `.env.example` to `.env` and set:

```
EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=your-public-anon-key
EXPO_PUBLIC_WEB_URL=https://your-web-app.vercel.app
EXPO_PUBLIC_EAS_PROJECT_ID=your-eas-project-id
```

The anon key is public configuration. Never put a Supabase service-role key or any credentials in the app.

## What still needs backend support before mobile users can use it

- Apply migration `202610160001_android_app_access.sql` (creates `school_mobile_access`, `mobile_app_sessions`, and the mobile access RPCs) from `app/`.
- In the web app, enable **Settings → Modules & features** and **Android app access** per school and role.
- The system owner can suspend mobile access platform-wide in platform feature controls.
- Push notifications require a backend push-token registration/delivery worker (not yet present).
