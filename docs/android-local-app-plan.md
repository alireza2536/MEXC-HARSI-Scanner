# Android Local Harsi App — Implementation Plan

## Goal
Create a private Android APK that runs the existing Harsi scanner locally on the phone including while the app is in the background after the user manually starts a scan. The existing Render deployment and Neon database remain untouched until the Android build is verified against the current service.

## Confirmed constraints
- Private, single-user Android app; no Play Store release required.
- A scan starts only when the user taps «بروزرسانی». It continues in the background with an Android foreground-service notification and partial wake lock, then stops when that one scan completes. No periodic or automatic follow-up scan is scheduled. Android force-stop or system termination can still interrupt it.
- Run the same 15-minute MEXC futures scan and preserve the current eligibility rules, HARSI calculation, 2,000 closed-candle history, current-candle handling, 7-day HARSI-result retention, filtering and sorting.
- No Render or Neon dependency in the final local app.
- MEXC remains the external data source, so internet access is still required for fresh market data.
- Do not change the existing production branch or deployment during development.

## Repository findings (main branch at start)
- The current UI is a plain HTML/CSS/JavaScript page at `public/index.html`.
- HARSI calculation is implemented in `src/harsi.js`; it is pure JavaScript and should be reused without changing its formula.
- MEXC HTTP access and contract eligibility are in `src/mexc-client.js`.
- Live scan orchestration is in `src/live-scanner.js`; it currently depends on PostgreSQL via `pg` and reads/writes the Neon tables.
- Runtime configuration in `src/config.js` requires `DATABASE_URL`, so the current scanner cannot run independently on Android.
- The UI currently calls `/api/status` and `/api/refresh`; these server endpoints must be replaced by a local app bridge.
- Current live scanner is Min15, uses 2,000 closed candles plus the current forming candle, and retains HARSI results for seven days. Treat runtime code as source of truth; older README/spec text contains stale descriptions.

## Proposed implementation
Use Capacitor to package the existing web UI as a private Android application. Keep the existing JavaScript HARSI implementation unchanged. Add native Android bridges for:
1. MEXC HTTP requests, avoiding browser CORS limitations and keeping networking behavior controlled.
2. Local SQLite persistence, replacing Neon/PostgreSQL.
3. A native Android foreground service and partial wake lock to keep a user-started scan active while the app is backgrounded; stop the service when that scan finishes.

The local scanner should use the same contract discovery, candle normalization, request spacing/retry behavior, candle-window validation, and HARSI calculation as the current live scanner. Persistence should retain the latest 2,000 closed candles plus the currently forming candle per symbol, and keep HARSI result rows for seven days. Any necessary adaptations must be verified by parity tests before they are accepted.

## Implementation status on `android/local-harsi-app`

- Added a Capacitor 8 / Vite build configuration and a workflow that generates an Android project and builds a debug APK artifact.
- Added a native SQLite repository using `@capacitor-community/sqlite`, with transactional batched writes, latest 2,000 closed candles plus the forming candle, and seven-day HARSI retention.
- Added a local scanner orchestration module that reuses `MexcClient`, `hasCompleteCandleWindow`, and the unchanged `calculateHarsi` function.
- Replaced automatic foreground lifecycle scheduling with a manual-only scan flow. The user starts each scan with «بروزرسانی»; no scan starts on app launch and no recurring 15-minute timer is created. The Android foreground service shows progress and holds a partial wake lock until the scan finishes.
- Added restoration of the latest saved HARSI value per symbol from local SQLite when the app opens.
- Added tests for the local scanner and SQLite repository. The latest PR-check run should be used as the authoritative test result.
- APK generation is automated, but installation on the target Samsung phone and Render-vs-Android value parity are still pending. No APK should be treated as production-ready before those checks.

## Delivery phases
1. Add Android packaging and local runtime scaffolding on this branch only.
2. Implement SQLite schema/repository and migrate live-scan persistence from PostgreSQL to the local store without changing calculation logic.
3. Add Android-native MEXC networking bridge and app-foreground 15-minute scheduling.
4. Package a debug APK and install/test on the target phone.
5. Compare the same symbols/candle timestamps and HA values between Android and the existing Render service across multiple scans.
6. Only after user approval, consider retiring cloud services. No automatic production merge, Render deployment, or Neon deletion is part of this work.

## Acceptance checks
- Build produces an installable Android APK.
- A scan starts only after the user taps «بروزرسانی», continues while backgrounded/screen-off with a visible foreground-service notification, and stops after completion. Reopening the app does not start a scan automatically.
- No Render, Neon, PostgreSQL connection string, or cloud database is required by the Android app.
- The exact same eligible symbols and MEXC candle timestamps are used for parity comparison.
- HARSI values match the existing implementation for identical input candles (within the established numeric precision).
- Local storage retains the expected history and prunes expired HARSI results correctly.
- Existing main branch and Render deployment remain unchanged until the user explicitly approves any later migration.
\n\n## Background-scan limitations\n\nThe Android foreground service improves process priority and keeps the CPU awake during the manual scan. Android can still interrupt work if the user force-stops the app, the OS terminates the process, or device/vendor power management imposes restrictions. Android 13+ notification permission is requested when the user starts a scan.\n