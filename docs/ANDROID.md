# Android companion app: automatic SMS sync

The companion app (`android/`) syncs the texts on your own Android phone to your Public Records Search site. You pair the phone once, allow SMS access on it, and from then on texts sync by themselves. No exports, no uploads, and nothing is read from Windows Phone Link.

## Why not Phone Link

The PC sync helper (`phonelink-sync.bat`) reads the copy of your texts that Windows Phone Link keeps on the PC. Recent Phone Link versions encrypt that database, and Microsoft does not document it, so the helper can no longer read it. Nothing on the PC side can fix that. The companion app reads texts on the phone instead, through Android's public SMS store with the permission you grant.

## How it works

1. On the website, go to **Connected Sources → Android phone (companion app) → Connect phone**, tick the confirmation and click **Show pairing code**. The site shows a QR code and an 8-character code (for example `ABCD-2345`). The code lasts 10 minutes and works once.
2. In the app, tap **Scan QR code**, or type the website address and the code, then tap **Pair**. The site creates your private source "Android texts from <phone> (<you>)" and gives the phone its own revocable key.
3. The app shows what it will read and where it will send it. Tap **I agree, allow SMS access**, and Android asks for the SMS permission.
4. The app sends your existing texts in batches of 500, then each new text a few seconds after it arrives.
5. The website's dialog shows each phone's status: Connected, Syncing or Up to date, the SMS permission, texts synced, the last sync and the last error.

Sync is incremental. The app keeps the highest SMS id the server has accepted and sends only newer texts. The server stores each text once, both by the phone's message id and by a fingerprint (time, number, direction, body hash), so a resend or a reinstall never creates duplicates. Texts are merged into one record per conversation per day and indexed like any other source.

When syncs run (all through WorkManager, so they survive restarts and reboots and retry with exponential backoff):

- right after you allow access, when you tap **Sync now**, and when a text arrives (the `SMS_RECEIVED` broadcast);
- when the phone's SMS store changes, which also catches texts you send;
- every 15 minutes as a safety net. Once a day, the last 3 days are re-checked, and the server ignores what it already has.

## Stopping and deleting

- **On the website:** in the phone dialog, **Disconnect** revokes the phone's key, and the texts stay. **Disconnect and delete synced texts** also removes the source, its records and the stored texts. Removing the source on its card does the same.
- **In the app:** **Disconnect**, or **Disconnect and delete synced texts from the website**. Texts on the phone are never touched.
- Uninstalling the app stops syncing, but it does not delete anything on the website. Use the website to delete.

## Security and privacy

- **Pairing:** codes are random, expire after 10 minutes, work once, and are stored only as hashes. Wrong codes are limited to 10 per address per 15 minutes.
- **Phone key:** shown only to the phone, stored on the server only as a SHA-256 hash, and encrypted on the phone with an AES-GCM key held in the Android Keystore. App backup and device transfer are switched off, so the key cannot be copied off the phone. It can only add texts to its own source and report status; it cannot search or read anything.
- **Transport:** HTTPS only. Release builds refuse plain http entirely (network security config, plus a check in code). Debug builds also allow `http://10.0.2.2` (the emulator's view of your PC) and `localhost` for testing. Redirects are not followed, so the key is never sent to another address.
- **No message content in logs:** the app logs only counts and error codes, release builds strip non-warning logs, and WorkManager logs errors only. The server audit log records counts, never text.
- **Smallest set of permissions:** READ_SMS and RECEIVE_SMS (plus internet). No contacts, camera, location or MMS. QR scanning uses Google Play services' scanner, which needs no camera permission.

## Android and Google Play policy limits (please read)

- **READ_SMS and RECEIVE_SMS are restricted permissions on Google Play.** An app may request them only if it is the default SMS app or qualifies for an exception, and the developer must submit a **Permissions Declaration Form** and pass Google's review. Syncing texts between a phone and another device ("cross-device synchronization or transfer of SMS") is one of the listed exceptions, but approval is not guaranteed. Check the current *Use of SMS or Call Log permission groups* policy before you submit.
- **Without Play approval, distribute the APK yourself:** sideload it, or use your organization's MDM or a managed Google Play private app. Sideloading needs no Play review.
- **Restricted settings:** on recent Android versions, some permissions for sideloaded apps can be greyed out as "Restricted setting". If that happens, open App info → ⋮ → **Allow restricted settings**, then allow SMS.
- **SMS only.** RCS chat messages (blue bubbles in Google Messages), MMS pictures and group MMS, and texts kept only inside other apps (WhatsApp, Signal, Telegram) are **not** in Android's SMS store, so they cannot be synced. This is an Android limit, not a bug.
- **Background limits:** some manufacturers (Xiaomi, Huawei, Oppo, Vivo, some Samsung settings) stop background apps aggressively. If syncing stalls, set the app's battery use to **Unrestricted**. The 15-minute periodic sync catches up when the phone allows it.
- **Work profiles:** a phone in a managed work profile may block SMS access, depending on the organization's policy.
- **Google Play target API:** the project targets API 35. Google Play's target-API deadline moves every year, so raise `targetSdk` in `android/app/build.gradle.kts` before you publish.

## Build the app

Requirements: **Android Studio** (Ladybug 2024.2 or newer, which includes JDK 17 and the Android SDK) and an Android phone or emulator running Android 8.0 (API 26) or newer.

1. In Android Studio: **File → Open** → choose the `android` folder of this project. Let Gradle sync; it downloads Gradle 8.11.1, AGP 8.7.3, Kotlin 2.1.0 and the libraries. If Android Studio offers to update versions, that is fine.
   - The repository does not include `gradle-wrapper.jar`. Android Studio does not need it. To build from a terminal, run `gradle wrapper` once inside `android/` (with Gradle installed), or let Android Studio create it.
2. Build a test APK: **Build → Build App Bundle(s) / APK(s) → Build APK(s)**. The file is `android/app/build/outputs/apk/debug/app-debug.apk`.
3. For a release APK: **Build → Generate Signed App Bundle / APK**, and create a keystore. Keep the keystore safe; `*.jks` and `*.keystore` are git-ignored.
4. Install it: connect the phone with USB debugging on and press **Run**, or copy the APK to the phone and open it (allow "install unknown apps" for your file manager).

Unit tests (code parsing): `./gradlew test` inside `android/`, or right-click `app/src/test` → Run tests.

## Test it end to end

**Against your hosted site (recommended):**

1. Deploy this version (Render or Azure), with `REAL_SOURCES=true` and `PUBLIC_URL` set to its https address.
2. Open the site at its **https** address, sign in, go to Connected Sources → **Connect phone** → **Show pairing code**.
3. On the phone, open the app → **Scan QR code** → **Pair** → read the consent screen → **I agree, allow SMS access** → Allow.
4. Within a minute the website dialog shows **Connected · Syncing**, then **Up to date**, with the number of texts. The phone's texts appear under the new source (**View conversations**) and in searches over that source.
5. Send yourself a text from another phone. Within about 10 seconds (with network) the count goes up and the new text appears in that day's conversation record.
6. Turn SMS permission off in Android settings and tap **Sync now**. The website shows **Needs SMS permission**. Turn it back on and the sync resumes.
7. Put the phone in airplane mode, receive a text, and turn the network back on. WorkManager retries and the text arrives.
8. **Disconnect and delete synced texts** in the app or on the website. The source and its records disappear, and the app returns to the pairing screen.

**Locally with the emulator (debug build):**

1. Run the site on your PC (`start.bat`, or `npm start` with `REAL_SOURCES=true`).
2. Start an Android emulator. In the app, enter `http://10.0.2.2:8765` (the default port; use yours if different) and the code shown at `http://localhost:8765`. The website warns that a phone cannot reach `localhost`; that is expected, so type the address by hand.
3. Send test texts into the emulator from its **Extended controls → Phone → SMS message**.
4. A real phone on USB can reach your PC through `adb reverse tcp:8765 tcp:8765`, then `http://localhost:8765` in a debug build.

**Server tests:** `npm test` (see `tests/phone.test.mjs`: pairing, single-use and expiring codes, rate limits, incremental sync, duplicates, merging, dashboard states, disconnect and delete, no message text in the audit log).

## API

See `docs/API.md` → *Android companion app*.
