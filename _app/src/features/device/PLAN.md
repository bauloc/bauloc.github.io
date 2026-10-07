# Device Lab: the Android plan

`/device/` over WebUSB, from `_app/src/features/device/` · installs, installed apps, images and the preflight checklist · planned and built 2026-10-04 · as built

**What this is.** The plan the Android features of Device Lab were built from: installing an app, listing what is installed, reading the phone's images, and the preflight checklist. It is kept up to date with what was built. The page's code cites it as `PLAN §…` ("PLAN §4.4"), so section numbers are stable: a section that no longer applies says so instead of disappearing.

**How to read it.** The plan's text is kept, because the code comments lean on its reasoning. Where the build went another way, an **As built** note says what shipped and why, and §0.1 lists every change in one place. The sentences quoted here are the plan's; the words on screen live in `preflight/copy.ts` (the checklist), `model.ts` (`INSTALL_ERRORS`, `DEVICE_HINTS`) and the components, each tested string by string. Where they differ, those files are right.

**The other document.** The local helper (`device/agent/device-bridge.mjs`, iOS, and Android through Google's adb server, including Android over Wi‑Fi) has its own specification, `_app/helper/SPEC.md`. A bare "§…" in the code cites that one; "PLAN §…" cites this one.

**Evidence tags**

- **[V]**: run, or read in the exact code or file.
- **[S]**: read in AOSP main or scrcpy source. A phone's own Android build may differ.
- **[I]**: inferred. To be confirmed on a phone.

**Placeholders.** "Pixel 9" stands for the phone being tested, as it does in the code and the mock lane. Real serial numbers, names and personal data from the test phones are not part of this document.

---

## Summary

- **All four asks are feasible: install an APK, install a split set, list the apps, list the images.**
  - `.apk`, `.apks`, `.xapk`, `.apkm`, several APKs picked at once, a `.zip` of APKs and a folder all install from the browser alone.
  - Only `.aab` needs a local helper running Java and bundletool.
- **P1** is the four asks plus the preflight checklist, which is mandatory. The plan estimated about 24–27 dev-days in the page plus 2.5–3 in the helper.
- **P2** is screen recording, per-app logcat, bug reports, app labels and icons, a file browser and deep links. **P3** is mirroring and control, settings toggles with a restore ledger, and batch work on several phones.
- **Not feasible, or only partly:**
  - An `.aab` can't be installed by the browser alone.
  - No shell command prints an app's label or icon; they have to be read out of the APK.
  - Image previews need either Android's thumbnail cache (which can write cache files on the phone) or the original file.
  - Chrome can't draw HEIC.
  - A build signed with another key can't update an app installed from Google Play without an uninstall, which deletes its data.

**As built.** P1 shipped, with labels and icons moved in from P2 and without the `.aab` install, which waits for a helper that can build APKs (§4.3). The answers to §10's questions are recorded there, and the follow-up change after the first real-phone testing (a steadier image viewer, Export app as `.xapk`) is in §0.1 and §4.4.

---

## 0. Decisions at a glance

| Topic | Decision | Why |
| --- | --- | --- |
| Library line | Keep `@yume-chan/adb` 2.6.4, `adb-daemon-webusb` 2.3.2 and `adb-credential-web` 2.1.0. Add `@yume-chan/android-bin` **2.1.0**: exact pin, lazy-loaded. Revisit only after the P2 mirroring spike. | 2.1.0 is npm `latest` and dedupes onto adb 2.6.4 [V npm]. 3.0.0-beta.3 pins adb 3.0 beta and reshapes the API. |
| How android-bin is used | As a transport only. `CmdNoneProtocolService(adb, 'pm')` sends `abb_exec:` on Android 10+ and `cmd package` on Android 7–9. In P2/P3, also `BugReport`, `Logcat` and `DemoMode`. We own the command lines and the output parsing. | Several helpers in 2.1.0 misbehave [V source]: see the list under this table. |
| Install mechanism | Every install is a PackageInstaller session: create, stream each part, commit. This holds for a single APK too. | One code path for 1 or N APKs, a real Cancel (`install-abandon`), and byte-level progress. |
| Shell safety | A `shellCmd` tagged template: literal text is sent as-is, and every `${…}` goes through `escapeArg()`, which `@yume-chan/adb` exports [V]. Package names and media ids are validated first. Only validated tokens go down the Cmd/abb route. | `exec:` and `shell,v2` send `command.join(" ")` to `sh -c` [V adb 2.6.4 source]. `abb_exec` runs no shell, so escaped text would arrive with its quotes still in it [S]. |
| Long-running work | Per-device `jobs` in the store, each with a phase, bytes and a cancel function. Announce phase changes only. | Before this, `capturing` was a single global flag. |
| Detail column | shadcn Tabs: **Overview** (the existing content, kept mounted), **Apps**, **Images**. P2 adds **Files**. | A layout change to a locked UI, so it needed the owner's OK (§10 Q1: yes). |
| Helper's Android role | Turn `.aab` into `.apks` with bundletool, and report doctor facts: whether an adb server is running, who holds the USB interface, and which Java is installed. It never runs `adb` or bundletool's device modes. | An adb server claims the USB interface and breaks WebUSB. |
| Archives | No new library. An own ZIP reader (central directory, ZIP64), `DecompressionStream('deflate-raw')`, a minimal `toc.pb` reader, and a port of bundletool's split matchers. About 600 lines, roughly 5 KB gzipped. | The prototype matched `bundletool extract-apks` in 224 of 224 cases [V]. |

android-bin 2.1.0 problems that rule out its higher-level helpers [V source]:

- `installStream` and `uninstall` require the exact text `Success`.
- `checkResult` throws on `Completed with warning(s)`, even though the app is installed.
- `listPackages` returns a row for every output line, error lines included.
- `ActivityManager.startActivity` loops over the characters of the output string and never throws.

**As built.** Every row held, except the helper's role: the helper that shipped (`_app/helper/SPEC.md`) shares Google's adb server for Android and iOS and has no bundletool lane yet, so `.aab` stays out of reach (§4.3). Its doctor does report the adb server and bundletool with Java (SPEC §12).

### 0.1 Changes while building

| Change | Why | Where |
| --- | --- | --- |
| Installs need Android 7.0 (`MIN_INSTALL_SDK = 24`); the Android 5–6 push fallback was not built | §10 Q6: the tested session path only | §4.1, §9 |
| Previews never make the phone write: no `content read …/thumbnail`. A preview is a thumbnail Android already has, or the original when it is at most 8 MB and the browser can draw it | §10 Q2: strict no-write | §4.5 |
| App labels and icons shipped in P1, read out of the installed APKs, two apps at a time, for rows on screen; kept in memory for the page's life, keyed by package, version code and update time (no IndexedDB) | §10 Q9 | §4.4, §5 row 2.2 |
| APK slices are read with `dd if=<path> bs=4096 skip=<n> count=<n>` on whole blocks, then cut to the range, not with `tail -c +N \| head -c M` | toybox gained `head -c` only in 0.7.5 (late 2017), after Android 7.x and 8.0 shipped, so labels and icons never loaded there (a review finding) | §5 row 2.2, `backends/android/files.ts` |
| The page pulls an APK only from a path `pm path` listed for that app on that device in this session; anything else must be a media file under `/storage/…` or `/sdcard/…` | The pull operation reads whole files off the phone, so it reads only what Device Lab itself listed | §4.4, `backends/webusb-ops.ts` |
| Size caps on pulled files: 1 GiB per APK, 512 MB per photo or video, 8 MB for an original read as a preview | A game's `base.apk` can pass 512 MB; everything else is held in the tab's memory | §4.4, §4.5 |
| P1 shipped "Download APK(s)": one APK as `.apk`, several as a stored `.zip`. The follow-up replaced it with **Export app**: one APK as `.apk`, a split app as one `.xapk` (APKPure's v2 `manifest.json`, an optional `icon.png`, the APKs under the names Android gave them) | An `.xapk` installs again when dropped on Device Lab, and with SAI or APKPure; a bare `.zip` of splits is not a format other installers know | §4.4, `backends/archive/xapk.ts` |
| An `.aab` is recognised and refused with `AAB_NEEDS_HELPER`, plus the bundletool command to build an `.apks` by hand; the device-spec builder and the `.aab` checklist rows are ready for the helper | The helper shipped without `build-apks` (SPEC §0.5) | §4.3, §3.4 |
| Open install sessions are remembered in localStorage, not sessionStorage | sessionStorage dies with the tab, and a closed or crashed tab is exactly the case the record is for | §4.1 |
| "Uninstall and install…" is offered for a signature mismatch or a downgrade only when the installed copy is the one thing in the way, and always behind a confirmation | Uninstalling deletes the app's data; with anything else still Blocking, the install would then fail anyway (a review finding) | §4.1 |
| The checklist's phone steps are four rows: USB debugging, **the cable** (its own row), the browser's picker, Allow on the phone | A charge-only cable is the most common cause of "nothing listed" | §3.1, §3.2 |
| "Find my phone…" lists every USB device the browser sees and what it says about each (`preflight/usb-diagnose.ts`) | Built as planned | §3.2 |
| System USB access: Linux udev rules for Debian/Ubuntu, Fedora, Arch and snap Chromium; Windows WinUSB (Google's driver, or switching a maker's driver in Device Manager) | §10 Q10 had no answer, so both got real guidance; both are untested on those systems | §3.2 |
| The helper's connection rows come from the helper's own checklist (SPEC §12); the `.aab` rows (Java, bundletool, signing key) read "Not checked" with a note that they are coming, until a helper can build APKs | One checklist for the page and the terminal | §3.4 |
| The mock lane picks an install's outcome from the file name (`INSTALL_TRIGGERS` in `backends/mock-android.ts`) | Every error path can be shown without a phone | §3.5, §4.1 |
| Not built: the cross-tab handshake over `BroadcastChannel` and the helper naming who holds the phone (their wording and actions exist, nothing raises them yet), `helper.usbOwner`, `?mock=1&preflight=<scenario>`, "Add to Screenshots" in the image viewer, and everything in P2 and P3 | Left for later | §3.2, §3.5, §4.5, §5, §6 |

## 1. Where the research reports disagreed, and what the plan uses

| # | Topic | Disagreement | Resolution |
| --- | --- | --- | --- |
| 1 | `getPackageSources` (`package -p <pkg>`) | One report: AOSP main has no `-p`. Another: the legacy alias still works. | AOSP main keeps the alias: when the argument is `-p` followed by exactly one more argument, it calls `displayPackageFilePath(pkg, USER_SYSTEM)` [V PackageManagerShellCommand.java:421]. The plan still runs `pm path <pkg>` itself, because that is user-aware and escaped. |
| 2 | Launching an app | Use `ActivityManager.startActivity`, or avoid it. | Avoid it (bug above). Run `cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER <pkg>`, then `am start -n <component>`. Fall back to `monkey -p <pkg> -c android.intent.category.LAUNCHER 1` [I]. |
| 3 | Thumbnails | Use `content read …/thumbnail`; or not, because that call writes `Pictures/.thumbnails/<id>.jpg` when the file is missing. | Both are right. It is a write into MediaProvider's own cache, so it was a product decision (§4.5, §10 Q2: no write). |
| 4 | Low-target-SDK block threshold | 23 vs 24 | AOSP sets `MIN_INSTALLABLE_TARGET_SDK = Flags.minTargetSdk24() ? 24 : 23` [V source]. So Android 14 uses 23 and Android 15+ uses 24 (unconfirmed for 17 [I]). The pre-check uses 24 on API ≥ 35 and 23 on API 34. The phone's own message is final. |
| 5 | What the `.aab` helper returns | an output directory, a `.apks`, or `extract-apks` | The device-targeted `.apks` (`build-apks --device-spec`). The page installs it through its normal `.apks` path, so there is one install path. `extract-apks` is only a fallback for targeting the browser can't evaluate (P3). |
| 6 | Stopping `screenrecord` | PTY `sigint()` vs `pkill -INT` | Run `echo $$; exec screenrecord …` over `exec:` and stop it with `kill -INT <pid>`. This needs no PTY and kills only our own process. SIGHUP also finalizes the MP4 (screenrecord.cpp:144–145 [V]), which covers a closed socket or a pulled cable. |
| 7 | Media scan after a push | `cmd media_scanner` vs a broadcast | The `MEDIA_SCANNER_SCAN_FILE` broadcast, which scrcpy 4.1 ships [S]. Probe for `cmd media_scanner` first, read-only [I]. P2. |
| 8 | Java needed for bundletool | unspecified | Main classes target Java 8, but the jar contains 619 Java 11 class files (ddmlib) [V class-version scan]. Require **Java 11+** and recommend 21 LTS. bundletool needs no SDK and no aapt2: it ran with `PATH=/usr/bin:/bin` [V]. |
| 9 | bundletool on testers' machines | Homebrew assumed | The helper downloads `bundletool-all-1.18.3.jar` itself. 1.18.3 is the latest release (2025-12-15): 32,520,401 bytes, sha256 `a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29`, the same bytes as Homebrew's jar [V GitHub API + shasum]. Testers then only need Java. |
| 10 | Installs that succeed with warnings | not handled | AOSP prints `Warning: …` lines, then `Completed with warning(s)`, and returns a failure status even though the app is installed [V source:4317–4321]. Classified as "Installed, with warnings". |

**As built.** Rows 1–4 and 10 are in the code (`backends/android/pm.ts`, `packages.ts`, `pm-output.ts`, `archive/plan.ts`). Rows 5, 8 and 9 wait for the helper's `.aab` lane; today the helper's checklist only reports bundletool and its Java (SPEC §12b `android.bundletool`). Rows 6 and 7 are P2.

---

## 2. P1.0 Foundation (3 dev-days)

**New files**, under `_app/src/features/device/`, as planned:

```
backends/android/shell.ts        shellCmd`…` tag (escapeArg on every interpolation); run() → {stdout, stderr, exitCode|null}
                                 (shell v2 when adb.subprocess.shellProtocol exists, else exec:); assertPackageName()
backends/android/pm.ts           lazy import('@yume-chan/android-bin') → CmdNoneProtocolService(adb,'pm'); sessions,
                                 uninstall, clear, path, list, resolveLauncher
backends/android/pm-output.ts    pure: parseSessionId, classifyPmOutput → InstallOutcome
backends/android/packages.ts     pure: parsePmList, parseCheckin, parseDumpsysPackage, installerName
backends/android/media.ts        pure: imagesQuery(sdk, album, page) → argv, parseContentRows; io: thumbnail()
backends/android/device-spec.ts  pure: buildDeviceSpec(outputs) + validation; io: collector
backends/archive/{zip,toc,select,axml,arsc,plan}.ts   pure, Blob-based (ported from the prototypes, §11)
backends/helper/client.ts        health / doctor / buildApks (XHR for upload progress), LNA-aware errors
preflight/{checks,copy,env,usb-diagnose}.ts
components/{checklist,install-dialog,jobs-strip,apps-tab,app-sheet,images-tab,image-viewer}.tsx
components/ui/{tabs,progress}.tsx       shadcn, built on radix-ui 1.6.7 (already installed, ships Tabs/Progress [V])
```

**As built**, the files are:

```
backends/android/{shell,pm,pm-output,packages,media,device-spec}.ts   as planned
backends/android/files.ts        sync reads (one AdbSync per transfer), folder listings, dd slices (§5 row 2.2)
backends/android/{fake-adb,fixtures}.ts   a scripted Adb and synthetic outputs for the tests
backends/archive/{zip,toc,select,axml,arsc,plan}.ts   as planned
backends/archive/apk-badge.ts    an app's label and icon from its APKs (§4.4)
backends/archive/xapk.ts         Export app: a stored .apk or .xapk (the follow-up change, §4.4)
backends/webusb-ops.ts           the Android operations of the WebUSB lane, lazily loading the modules above
backends/mock-android.ts         the same operations in the mock lane
preflight/{checks,copy,env,types,usb-diagnose}.ts
components/{checklist,doctor-dialog,install-dialog,jobs-strip,apps-tab,app-sheet,images-tab,image-viewer}.tsx
src/components/ui/{tabs,progress}.tsx
```

The planned `backends/helper/client.ts` became the page's helper lane in `helper/` (`client.ts`, `connection.ts`, `protocol.ts` and the rest), specified in SPEC §7.

**Changes to existing files:**

- **`model.ts`**:
  - `Capabilities` gains `apps` and `images` (P1), then `files`, `record`, `bugreport`, `mirror` and `controls`.
  - New hint codes (§3).
  - An `INSTALL_ERRORS` wording table. Backends return codes and the UI owns the wording, exactly like `DEVICE_HINTS`.
  - `Fix` gains `{label, href}`, `{label, path}` (a phone settings path) and the new actions listed in §3.1. `HintCard` renders them.
- **`backend.ts`**: optional operations, each one mirrored in the mock lane:
  ```ts
  install?(id, plan: InstallPlan, opts: InstallOptions, onProgress: (p: InstallProgress) => void, signal: AbortSignal): Promise<InstallOutcome>
  apps?(id, scope: 'user' | 'system' | 'all'): Promise<AppRow[]>
  app?(id, pkg: string): Promise<AppDetail>
  appAction?(id, pkg: string, action: 'launch' | 'stop' | 'clear' | 'uninstall' | 'info'): Promise<void>
  images?(id, q: { album: Album; offset: number; limit: number }): Promise<ImageRow[]>
  thumbnail?(id, mediaId: string, signal: AbortSignal): Promise<Blob>
  pull?(id, devicePath: string, onProgress: (sent: number, total: number) => void, signal: AbortSignal): Promise<Blob>
  deviceSpec?(id): Promise<DeviceSpec>
  ```
  As built, two more: `installFacts` (free space, the installed copy, Play Protect's setting, for the dialog's checks) and `appBadge` (an app's label and icon).
- **`webusb.ts`**:
  - At connect, also read `ro.build.version.sdk` and `ro.product.cpu.abilist`, inside the existing `Promise.all`.
  - Gate capabilities by API level. As built, installs need API 24 (§10 Q6).
  - Add `classifyUsbErrorFor(error, os)` for the Linux/Windows open-denied case. Keep `classifyUsbError` unchanged, so `parity.json` still holds.
- **`store.ts`**:
  - Add `jobs: readonly Job[]` (`{id, deviceId, kind, label, phase, sent?, total?, cancel?}`).
  - Add the last picker outcome (`none | dismissed | picked`) and `authorizingSince` per device. The checklist uses both.
  - When a device disappears, its jobs are aborted.
- **`device-lab-page.tsx`**:
  - Tabs go under the detail header. The Overview tab uses `forceMount` and is hidden while inactive, so `LogConsole` keeps streaming. As built, the detail is always a Tabs, even with Overview alone, so the log never remounts when Apps and Images appear.
  - Add a `vite:preloadError` listener (Vite 8 emits it [V]) plus import-failure handling, feeding the "Device Lab was updated" item. `npm run publish` wipes `/assets/` [V publish.mjs], so a tab left open across a deploy gets a 404 on any new lazy chunk. As built, a tab whose chunk fails to load says so with Reload, and is not retried.

**Rules for every feature:**

1. Never concatenate a shell string; use `shellCmd`. Validate before any command:
   - package names against `^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$`
   - media ids against `^\d+$`
   - device paths must come from `pm` or MediaStore output, and are still escaped.
2. Nothing escaped goes down android-bin's Cmd path, only validated tokens. abb has no shell, while `cmd` on Android 7–9 does.
3. Convert DOM streams to Tango streams with one helper, `toTango()` [V tsc]. Add `@yume-chan/stream-extra` only if code imports from it, and then pin 2.6.1.
4. Use one `AdbSync` per transfer and abort with `sync.dispose()`. Cancelling the reader otherwise drains the whole file first [S].
5. Always drain process output. On failure, prefer the phone's text over the transport error.
6. Every new backend method gets a mock with fake progress and every error code, triggered by file names documented in the mock lane (for example `*-incompatible.apk`).
7. Load lazily:
   - android-bin and the archive code load on the first install: about 6–9 KB gzipped (android-bin measured at ≤ 3 KB gz for PackageManager [V]; archive code 5.3 KB gz [V]).
   - Apps and Images code loads with its tab.

---

## 3. P1.1 Preflight checklist (mandatory): 4–5 dev-days in the page, about 1 day in the helper

### 3.1 Model and placement

```ts
type CheckStatus = 'ok' | 'warning' | 'blocking' | 'unchecked' // tone: ok · warn · bad · off (TONE_DOT/TONE_SURFACE reused)
interface CheckItem {
  id: CheckId
  group: 'browser' | 'phone' | 'helper' | 'feature'
  label: string
  status: CheckStatus
  sentence: string
  fixes?: Fix[]
  detail?: string
}
// Fix actions added: 'add-device' | 'find-phone' | 'reload' | 'release-other-tab' | 'pair-helper' | 'get-bundletool' | 'create-key'
```

- **Pure functions:** `browserChecks(env)`, `phoneChecks(input)`, `helperChecks(probe, doctor)`, `featureChecks(feature, ctx)`, `checklistText(items)` and `worst(items)`.
- `preflight/env.ts` reads the real environment once and injects it. That makes every path testable in Vitest's node environment.
- Every status is written as a word next to its dot ("OK", "Warning", "Blocking", "Not checked"). Colour is never shown alone.

**Where it shows:**

- **Gate** (nothing connected). The Android card becomes "Before you connect":
  - First the browser items.
  - Then the phone items as numbered steps: 1 USB debugging, 2 data cable, 3 Add device, 4 Allow on the phone. A "Not checked" step looks like a neutral step, not a warning.
  - A "Didn't see your phone?" disclosure replaces the earlier "Picker empty, or 'unable to claim interface'?" disclosure, and keeps its adb text.
- **Environment check dialog.** It shows every item, grouped as _This browser · Phone: {name} · Helper · Features_. "Copy as text" stays, now as `status — label — sentence — fix`. The token is never printed.
- **Inline.** A compact card in the HintCard look, tinted by the worst status and listing only non-OK rows, sits at the top of the Install dialog, the Images tab and so on. While any row is Blocking, the feature's main button is `aria-disabled` and points at the card through `aria-describedby`.
- **Device HintCard.** Stays as it is for connection blockers (held, unauthorized, offline), with the holder detail added when known.
- **Helper probing** happens only on user intent: opening the Environment check, picking an `.aab`, or a stored pairing. When the helper is down, the connection is refused before any Local Network Access prompt appears [V].

**As built.** The four steps are `GATE_STEPS` in `preflight/checks.ts`, with the cable as its own row (`phone.cable`). The helper's groups (This Mac, iPhone tools, Android tools, Devices, Wi‑Fi devices, Optional tools) joined the same dialog when the helper shipped (SPEC §12d). The `group` field gained those groups; the shape is otherwise the plan's.

### 3.2 Connection items

| ID, label | Detection | Status: exact sentence | Fix | Shown in |
| --- | --- | --- | --- | --- |
| `browser.secure` "Secure page" | `window.isSecureContext` | **OK** "Opened over HTTPS." · **Blocking** "USB access only works on https:// pages or on localhost. This page was opened over plain http." | Link "Open the secure page": `https://bauloc.github.io/device/` | Gate, dialog |
| `browser.webusb` "WebUSB" | `'usb' in navigator` (the API only exists in secure contexts); `document.featurePolicy?.allowsFeature('usb')` when available | **OK** "This browser can talk to Android phones over USB." · **Blocking** "This browser can't talk to USB devices. Use Chrome, Edge or Opera on a computer." · **Blocking (policy)** "The page that embeds Device Lab blocks USB. Open Device Lab in its own tab." · **Not checked** "Can't check until the page is on HTTPS." | Link "Get Chrome" https://www.google.com/chrome/ · Copy "Copy this page's link" | Gate, dialog |
| `phone.permission` "Phone allowed in the browser" | Tango `getDevices()` count; the last picker outcome | **OK** "Chrome may use Pixel 9." · **Warning** "No phone allowed yet. Click Add device and pick your phone in the browser's list." · **Warning (picker closed)** "No phone was picked. If yours wasn't in the list, check USB debugging and the cable." | Action "Add device" · Action "Find my phone…" | Gate (step 3), dialog |
| `phone.usbDebugging` "USB debugging" | See the notes under this table. | **OK** "USB debugging is on." · **Not checked** (step 1) "Turn it on once per phone." · **Blocking** "Pixel 9 is plugged in, but USB debugging is off." · **Warning** (picked device is not a phone) "That device has no Android debugging interface. Pick your phone." · **Warning** (nothing listed) "The computer doesn't see the phone. Try another cable or port (some cables only charge), unlock the phone, and check USB debugging." | Path "Settings → About phone → tap Build number 7 times (Samsung: About phone → Software information → Build number)", then "Settings → System → Developer options → USB debugging (some phones: System → Advanced)" [V doc] · Link https://developer.android.com/studio/debug/dev-options · Action "Add device" | Gate (step 1), dialog |
| `phone.authorized` "Allowed on the phone" | Device state `authorizing` or `unauthorized` (the existing `ANDROID_UNAUTHORIZED`); `authorizingSince` | **OK** "This computer is allowed." · **Warning** "Unlock the phone and tap Allow on “Allow USB debugging?”. Tick “Always allow from this computer” so it stops asking." · **Warning after 30 s** "No prompt on the phone? Unplug and replug the cable. Still nothing: Developer options → Revoke USB debugging authorizations, then reconnect." · **Not checked** with no device | Action Retry · Path "Settings → System → Developer options → Revoke USB debugging authorizations" · Extra "Clearing this site's data makes a new key, so the phone asks again." | Gate (step 4), HintCard, dialog |
| `phone.notHeld` "No other program has the phone" | See the notes under this table. | **OK** "Device Lab has the phone's debugging connection." · **Blocking** "Another program is using the phone's debugging connection: usually Google's adb server (Android Studio, Flutter, scrcpy, a terminal), another browser tab, or chrome://inspect with “Discover USB devices” on." · **Blocking (other tab)** "Another Device Lab tab in this browser has Pixel 9." · **Blocking (helper knows)** "The adb server (pid 4242) has Pixel 9." / "Google Chrome (pid 4243) has Pixel 9, probably another tab." | Copy `adb kill-server` · Action Reconnect · Action "Ask the other tab to let go" · Extra: the existing text about IDEs restarting adb | HintCard, dialog, Gate disclosure |
| `phone.osAccess` "System access to USB" (Linux, Windows) | `SecurityError` / "Access denied" from `open()` on Linux or Windows. Before this, it was misread as `held`. | **Blocking (Linux)** "Linux must allow the browser to open the phone. Install the Android udev rules, then unplug and replug." · **Blocking (Windows)** "A phone maker's USB driver may be blocking the browser. Use Google's USB driver or Windows' built-in WinUSB." [I both] | Copy `sudo apt-get install android-sdk-platform-tools-common` and `sudo usermod -aG plugdev $LOGNAME`, then log out and back in [V doc for adb; I for WebUSB] · Link https://developer.android.com/studio/run/win-usb | HintCard, dialog |
| `app.current` "Device Lab version" | `vite:preloadError`, or a failed dynamic import | **Blocking** "Device Lab was updated while this tab was open. Reload to continue." | Action Reload | toast, dialog |

Detection notes for `phone.usbDebugging`:

- (a) Any visible device with the ADB interface (class 0xFF / subclass 0x42 / protocol 0x01) means USB debugging is on.
- (b) Raw `navigator.usb.getDevices()` returns a granted device without that interface.
- (c) "Find my phone…" calls `navigator.usb.requestDevice({filters: []})` and reads `configurations` without opening the device. Tango's own `matchFilters` reads them the same way [V]. A device without the interface whose vendor is a known Android vendor is reported as the "USB debugging is off" case (the vendor list needs checking [I]).

Detection notes for `phone.notHeld`:

- `classifyUsbError` returns `held`. This covers Tango's `DeviceBusyError` and "Unable to claim interface" [V].
- **Other tab:** over `BroadcastChannel('device-lab')`, a tab that fails to claim asks "who has serial X". The holder tab answers, and on "let go" it releases the phone and shows "Pixel 9 moved to another tab" (about 1 day of work).
- **Helper doctor (§3.4):** for when another program holds the phone.

**As built**

- `phone.cable` "Data cable" is a row of its own, step 2 on the Gate.
- "Find my phone…" is built (`preflight/usb-diagnose.ts`) and lists every USB device the browser sees, with what each one says.
- `phone.osAccess` names the fix per system: udev rules for Debian/Ubuntu, Fedora, Arch and snap Chromium; on Windows, Google's USB driver or switching a maker's driver to WinUSB in Device Manager. Both keep Reconnect and `adb kill-server` (a review finding). Neither has run on those systems.
- Who holds the phone is not wired in yet: neither the cross-tab handshake nor a holder named by the helper (`otherTab: false` and `holder: null` in `device-lab-page.tsx`). The "other tab" and "pid" sentences and the "Ask the other tab to let go" action exist and are tested; until something raises them, a held phone reads as the generic "another program" case.
- The `phone.*` rows are about a phone on this computer's USB through the browser. In a session that is only about an iPhone through the helper, they should not read as warnings; see SPEC §12a.

### 3.3 Prerequisites per feature

| Feature | Item | Detection | Status: sentence | Fix | Where |
| --- | --- | --- | --- | --- | --- |
| Any install | `install.android` | `sdk` read at connect | **Blocking** "Installing needs Android 5.0 or newer. This phone runs Android {release}." | — | Install dialog, dialog → Features |
| Any install | `install.oem` "Installs over USB allowed" | Manufacturer/brand is Xiaomi, Redmi or POCO. The toggle itself can't be read. | **Warning** "Xiaomi, Redmi and POCO phones refuse installs over USB until you allow them." Becomes **Blocking** after `INSTALL_FAILED_USER_RESTRICTED`. | Path "Settings → Additional settings → Developer options → Install via USB (needs a Mi account)" [I] | Install dialog |
| Any install | `install.verify` "Play Protect" | `settings get global verifier_verify_adb_installs`, read-only [I] | **Warning** "Play Protect may scan the app and ask on the phone. Keep the phone unlocked and watch its screen." | — | Install dialog |
| `.xapk`, `.apkm` | `install.unzip` | `new DecompressionStream('deflate-raw')` throws | **Blocking** "This browser can't unpack .xapk or .apkm files. Update Chrome or Edge (version 103 or newer)." | Link "Get Chrome" | Install dialog |
| Old `.apkm` | `install.apkmEncrypted` | File doesn't start with `PK` | **Blocking** "This .apkm is encrypted (an old APKMirror format). Download it again from APKMirror." | — | Install dialog |
| `.aab` | `helper.*`, `aab.java`, `aab.bundletool`, `aab.key` | Helper health and doctor (§3.4) | see §3.4 | see §3.4 | Install dialog card, dialog |
| `.aab` without a helper | `aab.manual` | Helper down | **Warning** "No helper? Build an .apks yourself and drop it here: `bundletool build-apks --bundle=app.aab --output=app.apks --mode=universal`" | Copy | Install dialog |
| Images | `images.mediastore` | First query's exit code and stderr | **Blocking** "Android didn't list the images: {first stderr line}." · **Warning** (fallback in use) "Showing folders only (Screenshots, Camera, Download). Dates are file times." | Retry | Images tab |
| Images | `images.heic` | `mime_type` is `image/heic` or `image/heif` | Item note: "Chrome can't show HEIC images. Save it to open it on this computer." | Save | Viewer |
| Recording (P2) | `record.tool` | `command -v screenrecord` | **Blocking** "This phone has no screen recorder (screenrecord)." · **Note** "Recordings stop after 3 minutes on this Android version." | — | Record button |
| Bug report (P2) | `bugreport.tool`, `bugreport.save` | `bugreportz -v`; `'showSaveFilePicker' in window` | **Blocking** "Full bug reports need Android 7 or newer." · **Warning** "This browser keeps the whole report in memory before saving it." | — | Bug report menu |
| Mirroring (P3) | `mirror.decode`, `mirror.android`, `mirror.xiaomi` | `VideoDecoder.isConfigSupported({codec:'avc1.640028'})`; `sdk` ≥ 21 (audio needs ≥ 30); server compatibility from the spike; injection `SecurityException` | **Blocking** "This browser can't decode the phone's video." · **Warning** "Xiaomi phones need “USB debugging (Security settings)” for taps and keys." [I] | Path in Developer options | Screen tab |

**As built.** `install.android` says Android 7.0 (§10 Q6). The `.aab` rows show the bundletool command and say the helper rows are coming (§4.3). The P2 and P3 rows are not built.

### 3.4 Helper doctor: Android rows (added in the helper project)

| Item | Detection | Status: sentence | Fix |
| --- | --- | --- | --- |
| `helper.running` "Device Lab helper" | `GET http://127.0.0.1:8787/api/health` | **OK** "Helper {version} is running on this computer." · **Blocking** "The helper isn't running. Start it in Terminal, then press Check again." | Copy the start command from the helper design; "Needs Node.js 18 or newer" |
| `helper.lna` "Browser may reach the helper" | `navigator.permissions.query({name:'loopback-network'})` (Chrome 145+, Firefox 151+; `local-network-access` in Chrome 142–144) [V] | **OK** granted · **Warning** (prompt) "Chrome will ask once to let this page reach apps on this computer. Choose Allow." · **Blocking** (denied) "Chrome blocks this page from reaching the helper." · **Blocking** (Safari) "Safari can't reach the helper from this page. Open the helper's own page." · **Not checked** when unsupported | Path "Site controls (left of the address) → Site settings → Apps on device → Allow" · Copy `chrome://settings/content/siteDetails?site=https%3A%2F%2Fbauloc.github.io` · Link `http://127.0.0.1:8787/device/` |
| `helper.paired` | tokenId compared with `health.tokenId` (helper design) | **Warning** "Pair this page with the helper using the link it printed (…#pair=…)." | Action "Pair…" |
| `helper.version` | `health.protocol` ≥ the minimum and `capabilities` include `android.buildApks` | **Blocking** "This helper is too old for .aab installs. Download the latest one and restart it." | Link |
| `aab.java` "Java 11 or newer" | Doctor `java {found, version, vendor, path}`. Resolve in this order: `$JAVA_HOME`; macOS `/usr/libexec/java_home` (no GUI; the `/usr/bin/java` stub may pop an install dialog [I]); Android Studio's bundled JBR; Homebrew `openjdk`; PATH | **OK** "Java {version} ({vendor})." · **Blocking** "Building APKs from an .aab needs Java, and none was found." · **Blocking** "Java {version} is too old. bundletool needs 11 or newer." | Link https://adoptium.net/ (Temurin 21 LTS) · Copy `brew install --cask temurin` |
| `aab.bundletool` | Doctor (pinned jar in the helper's data folder, or Homebrew) | **OK** "bundletool 1.18.3." · **Warning** "The helper will download bundletool 1.18.3 (32.5 MB, checksum-checked) the first time you install an .aab." | Action "Download now" · Copy `brew install bundletool` |
| `aab.key` "Signing key" | Doctor: `~/.android/debug.keystore` or the helper's own key | **OK** "APKs are signed with this computer's debug key." · **Warning** "There's no debug signing key on this computer. The helper can create one." Always shown: "A build signed here can't update a copy installed from Google Play." | Action "Create key" |
| `helper.adbServer` | adb host protocol `host:version` on 127.0.0.1:5037, which never spawns adb (refused means no server) [V]; `host:devices-l` for serials | **OK** "No adb server is running." · **Warning** "An adb server is running on this computer. It can take the phone away from the browser." · **Blocking** "The adb server on this computer has Pixel 9." | Copy `adb kill-server` |
| `helper.usbOwner` (macOS) | `ioreg -r -c IOUSBHostInterface -l`, read `UsbExclusiveOwner` on the "ADB Interface" [V] | Fills in the detail for `phone.notHeld` | — |

**As built.** The helper shipped as its own project (SPEC.md), and its checklist (SPEC §12) is where the connection rows live now: `helper.running`, `helper.lna`, `helper.paired` and `helper.version` are worded by the page from the helper's phase; `android.adb`, `android.adb-server`, `android.wifi` and `android.bundletool` are worded by the helper. The `.aab` rows of this table (`aab.java`, `aab.bundletool`, `aab.key`) are kept in `preflight/checks.ts` (`aabHelperChecks`) for the Install dialog's `.aab` card, and read "Not checked" with a note that they are coming until a helper reports `android.buildApks`. `helper.usbOwner` is not built.

### 3.5 Tests for every missing-prerequisite path

- **Unit tests (node), table-driven.** One test per item × status, built from injected environments. Cases:
  - insecure page
  - no `navigator.usb`
  - USB blocked by policy
  - zero granted devices
  - picker dismissed
  - device without an ADB interface (Google vendor id → "debugging off"; Apple vendor id → "not a phone")
  - nothing listed
  - authorizing for less than / more than 30 s
  - held: Tango `DeviceBusyError`, "Unable to claim interface", other tab, helper says adb, helper says Chrome
  - Linux / Windows / macOS `SecurityError`
  - preload error
  - LNA granted / prompt / denied / unsupported / Safari
  - helper down / unpaired / stale token / too old
  - Java missing / 8 / 21; bundletool missing; key missing; adb server running
  - `DecompressionStream` missing; encrypted `.apkm`

  Also test `checklistText()` output and `worst()`.

- **Parity.** `classifyUsbError` keeps its legacy answers. The new `classifyUsbErrorFor` gets its own tests.
- **Component tests (jsdom, with `// @vitest-environment jsdom` and `@testing-library/react`):**
  - status words are rendered, not just dots
  - copy buttons copy the exact command
  - the Gate lists Blocking items first
  - inline cards set `aria-disabled` and `aria-describedby` on the feature button
- **Mock lane.** `?mock=1&preflight=<scenario>` renders each failing state, for visual and a11y review.
- **Helper (fake PATH and fake tools, per the helper research layout):**
  - `java` missing
  - a `java` stub that prints the macOS "Unable to locate a Java Runtime" text
  - `java version "1.8.0_402"` → too old
  - `openjdk version "21.0.11"` → OK
  - a fake host-protocol server on a random port (running, refused, garbage)
  - an `ioreg` text fixture
  - jar download with a matching and a mismatching checksum
- **Real checks:**
  - Firefox and Safari: Gate shows Blocking.
  - A LAN `http://` URL: secure-context Blocking.
  - Chrome with LNA denied, set through CDP `Browser.setPermission`.
  - Helper stopped.
  - A second Device Lab tab holding the phone: tests "held" without any adb.
  - An iPhone on the cable through "Find my phone…": tests "not a phone".
  - With the owner's consent:
    - turn USB debugging off, then back on
    - Revoke authorizations
    - the owner runs `adb start-server`, then `adb kill-server`

**As built.** The page's cases are in `preflight/checks.test.ts`, `copy.test.ts`, `env.test.ts` and `usb-diagnose.test.ts`, with the expected sentences typed out. The helper's (Java, bundletool, the adb server) are in `_app/helper/test/preflight.test.ts` and `tools.test.ts` (SPEC §12e); the jar download and `ioreg` cases wait for the features they test. There is no `?preflight=` scenario switch: the mock lane shows the install failures through file names (§4.1), and the checklist's states are covered by the unit tests.

---

## 4. P1: the explicit asks

### 4.1 Install an APK (3 dev-days, browser only)

**What the user sees**

- **Entry points:**
  - An **Install app** button (outline, `PackagePlus` icon) after Take Screenshot.
  - Dropping a file anywhere on the detail column shows a dashed overlay, "Drop to install on Pixel 9", in the empty-Screenshots style.
  - The picker accepts `.apk,.apks,.xapk,.apkm,.aab,.zip`, several at once.
  - All of this is enabled only when the device is Ready and has `capabilities.install`.
  - Any other dropped file gets: "Device Lab installs .apk, .apks, .xapk, .apkm and .aab files."
- **Dialog "Install on Pixel 9"**, in five steps:
  1. **From the file, read locally:** icon, label, `versionName (versionCode)`, package and size.
  2. **Checks, as checklist rows:**
     - Android version vs minSdk (Blocking).
     - Native code vs the ABI list (Blocking): "The app has native code only for armeabi-v7a. This phone runs 64-bit apps only."
     - Free space, from `df /data`: Warning below 2× the size, Blocking below 1×. "Not enough space: needs about 210 MB, 150 MB free."
     - Installed version, from `dumpsys package <pkg>`: update, reinstall, or downgrade (Blocking: "A newer version is installed (1.5.0 (900)). Android won't put an older one over it.").
     - Low target SDK: Warning plus an "Install anyway" checkbox.
     - Test-only build: shown as information; `-t` is added automatically.
     - The OEM and Play Protect rows from §3.3.
  3. **Options (collapsed):** "Grant all runtime permissions" (`-g`, off by default); "Allow downgrade" (`-d`, offered only when the installed app is debuggable).
  4. **Progress:**
     - "Sending to Pixel 9 · 21.5 of 34.7 MB · 62% · 28 MB/s" with a **Cancel** button. Cancel gives: "Cancelled. Nothing was installed."
     - Then "Installing on the phone…" (indeterminate). Cancel is hidden because Android can't stop a commit.
     - After 10 s: "Still installing. Check the phone: it may be asking you to confirm (Play Protect)."
  5. **Result:**
     - "Installed {label} 1.4.0 (812) on Pixel 9." with **Open app** and **Done**, plus a toast with Open and a live-region announcement.
     - Warnings: "Installed, with warnings:" followed by the list.
     - Failure: the wording and action from the table below, plus a "Details" section with the raw output, copyable.
- Closing the dialog while sending keeps the job running in the jobs strip, with a Progress bar and Cancel. Only one install per device runs at a time. Screenshots and the log keep working meanwhile.
- **Destructive confirmations** use an AlertDialog with a red action, as in XConsole:
  - **"Replace {label} on Pixel 9?"** "The installed copy is signed with a different key (for example from Google Play), so Android can't update it. Device Lab will uninstall it, which deletes its data on the phone, and then install this build." Buttons: Cancel / Uninstall and install.

**Technical approach**

- **Detect file types by content, never by extension.** An APK's root `AndroidManifest.xml` is binary XML (`03 00 08 00`) [V]. A lone split (`split="…"`) gets: "This is one part of a split app. Pick it together with its base APK."
- **Reading the file:**
  - The manifest gives the package, versions, `uses-sdk`, `testOnly`, `debuggable` and `split`.
  - Native code comes from the `lib/<abi>/` entries.
  - Label and icon come from `resources.arsc`. Port the APK badge prototype, which matched `aapt2 dump badging` on 9 APKs [V].
- **Phone facts:**
  - `sdk` and `abilist`, read at connect
  - `df /data`, already parsed for the detail pane
  - `dumpsys package <pkg>`: versions and the `DEBUGGABLE` flag
- **The session, through `CmdNoneProtocolService(adb,'pm')`:**
  - `package install-create -r [-t] [-d] [-g if API≥23] [--bypass-low-target-sdk-block if API≥34 and chosen]`. Expect `Success: created install session [N]` [V source:1738]. install-create accepts every install option [V].
  - `package install-write -S <bytes> <N> 0.apk -`. Pipe `toTango(counted(file.stream()))` into stdin while draining the output, and expect `Success: streamed …` [S]. If the pipe fails, use the output text.
  - `package install-commit <N>`, then `classifyPmOutput`: `Success`, `Completed with warning(s)` (installed), `Failure [CODE: msg]`, or anything else as UNKNOWN.
  - On cancel or failure: kill the write process, then `install-abandon <N>`. Keep `{serial, sessionId}` in sessionStorage until the session is closed, so a pulled cable gets the session abandoned on reconnect.
  - On Android 7.0/7.1 an empty commit output means "check with `pm path <pkg>`" [S].
  - On Android 5–6 (no `cmd`): push each part to `/data/local/tmp/dl-<n>.apk`, run `pm install-write <N> <name> <path>`, then `rm` (android-bin `sessionAddSplit` [S]). This is untested without an old phone (§10 Q6).
- **Open app:** resolve the launcher activity, then `am start -n` (§1 row 2). Without one: "This app has no screen to open."
- **Error wording** (the `INSTALL_ERRORS` table):

| Code | Wording | Action |
| --- | --- | --- |
| UPDATE_INCOMPATIBLE | "A different build of this app is installed, signed with another key (for example Google Play vs a debug build)." | "Uninstall and install…" (confirmation above) |
| VERSION_DOWNGRADE | "The phone has a newer version ({x}) than this file ({y})." | If the installed app is debuggable: "Install the older version" (`-d`). Otherwise "Uninstall and install…" |
| MISSING_SPLIT | "Parts of the app for this phone's CPU, screen or language are missing." | "Use the full .apks or .aab." |
| NO_MATCHING_ABIS | "This app has no native code for {abis}." plus "This phone runs 64-bit apps only." when the ABI list has no 32-bit entry | — |
| OLDER_SDK | "This app needs Android API {n}. This phone has API {m}." | — |
| DEPRECATED_SDK_VERSION | "This app targets an old Android (API {n}). Android blocks it unless you allow it." | "Install anyway" (bypass flag) |
| NO_CERTIFICATES | "This APK isn't signed, so Android refuses it." | "Build it through the helper (debug key)." |
| INVALID_APK | "These APKs don't belong together (different apps, versions or signatures, or no base APK)." | — |
| NOT_APK | "This isn't a valid APK. It may be an .aab, or a download that was cut short." | — |
| DUPLICATE_PERMISSION, CONFLICTING_PROVIDER | "Another installed app ({other}) declares the same permission or provider, usually another flavour of this app." | "Uninstall {other}…" |
| INSUFFICIENT_STORAGE | "Not enough free space on the phone." | — |
| USER_RESTRICTED | "The phone blocks installs over USB." plus the OEM path | — |
| ABORTED | "The install was cancelled on the phone." | "Retry and watch the phone" |
| VERIFICATION_FAILURE, _TIMEOUT | "Play Protect blocked or didn't approve the install." | "Check the phone" |
| CONNECTION_LOST | "The phone disconnected during the install. Nothing was installed." | Retry |
| UNKNOWN | "Android refused the install." plus the raw text | "Copy details" |

**Tests**

- **Unit:**
  - `classifyPmOutput` on every sample string: Success, warnings, every Failure code, `Error: failed to write`, `Exception occurred while executing`, empty output.
  - `parseSessionId`.
  - Flag building by API level.
  - Plan checks: minSdk; ABI (32-bit-only APK vs an arm64-only phone); space thresholds; downgrade with and without debuggable; target SDK 23/24 on API 34/35.
  - Manifest and arsc readers on small committed fixtures (self-made probe APKs of 20–60 KB, so fine for a public repo).
  - Progress counting.
- **Store:** job lifecycle; cancel calls abandon; disconnect gives CONNECTION_LOST; one install per device.
- **Mock lane:** about 20 MB/s of fake progress, plus a file-name trigger for every error code.
- **On a phone (with consent):** §7.5.

**Risks**

- Prompts on the phone (Play Protect, OEM toggles) can stall the commit.
- Throughput is Tango's measured ~30 MB/s, never measured on the test phone [I].
- Shell session installs on Android 17 are assumed to work [I].
- Files must be streamed. Never call `arrayBuffer()` on a whole APK.

**As built**

- Installs need Android 7.0 (§10 Q6); the Android 5–6 push route is not built, and `install-create` is refused below API 24 before anything is sent.
- Open session ids go to **localStorage**, not sessionStorage, keyed by the phone's serial: a tab that was closed or crashed mid-install is the case the record is for, and sessionStorage dies with it. The next connection of that phone abandons them, so Android does not keep their bytes for up to three days.
- "Uninstall and install…" is offered for UPDATE_INCOMPATIBLE and for a downgrade over a non-debuggable copy, only when the installed copy is the one thing in the way (`uninstallFirstGate`): with anything else still Blocking, the data would be gone and the install would still fail. It always confirms first.
- **Open app** is offered after a success; nothing opens by itself (§10 Q7).
- A cable pulled mid-install ends the job with a toast, and replugging does not reopen the dialog. Files dropped while an install runs wait for it to end. Drops on the header, the footer or a dialog are caught, so Chrome never downloads the APK instead.
- The mock lane's outcomes are picked by the file name (`INSTALL_TRIGGERS` in `backends/mock-android.ts`: `-no-space`, `-downgrade`, `-disconnect`, `-slow` and the rest).

### 4.2 Install split sets: `.apks`, `.xapk`, `.apkm`, several APKs (3 dev-days, browser only)

**What the user sees.** The same dialog. The summary adds "{n} of {m} APKs for this phone · arm64-v8a · xxhdpi · en", and a "Why these?" disclosure lists each chosen file with its reason. A folder, or several APKs dropped together, become one set. Asset packs installed with the app are included, and so are listed.

**Technical approach.** File types are detected by content:

| Input | Recognised by | Parts chosen by | Bytes read by |
| --- | --- | --- | --- |
| bundletool `.apks` | `toc.pb` | The ported matchers (detail below) | Zero-copy `Blob.slice`; entries are STORED |
| `.apks` with `universal.apk` | universal variant in toc | — | slice |
| `.apks` without toc (SAI style) or a `.zip` of APKs | loose `base.apk` + `split_*.apk` | Each part's binary manifest (`split`, `configForSplit`), plus names like `config.<abi/dpi/lang>` | slice or inflate |
| `.xapk` | `manifest.json` (`package_name`, `split_apks[]`, `expansions[]`) | file names, then manifests checked | inflate (`deflate-raw`) |
| `.apkm` | `info.json` (`pname`, `versioncode`…); a plain zip | file names, then manifests checked | inflate |
| Several `.apk` files or a folder | — | binary manifests | `File.stream()` |

The matchers for `.apks` follow bundletool:

- variant: the highest matching variant
- SDK
- ABI
- density, by Android's rule
- language, mapping he→iw, id→in and yi→ji
- install-time modules, **plus install-time asset slices** (missing these is the silent-failure trap)

**Rules before any bytes are sent:**

- All parts must share one package and versionCode.
- There must be exactly one base, and split names must be unique.
- Otherwise: "These APKs don't belong together."

**Session details:**

- Parts are named `0.apk`, `1.apk`… in the session, which is safe on the Android 7–9 `cmd` route.
- Each part's `-S` is the exact uncompressed size from the central directory.

**Not evaluated in the browser:** texture-compression, device tier and group, country set, and conditional modules. These show as a note, and the fallback is the helper's `extract-apks --device-spec` (P3).

**ZIP safety:**

- Reject encrypted entries and unknown compression methods with a clear error.
- Cap inflated bytes at the declared size.
- Support ZIP64.

**Tests**

- **Parity with bundletool.** Small `toc.pb` fixtures from the probe sets, with expected picks generated once by `bundletool extract-apks` at dev time. The generator script is in the repo (`backends/archive/__fixtures__/make-picks.mjs`), out of CI.
- Synthetic `.xapk` and `.apkm` built from the probe splits.
- Mismatched manifests.
- Encrypted `.apkm`.
- Asset-slice inclusion.

**Risks.** The `.xapk` and `.apkm` layouts come from third-party docs [I].

**As built.** As planned, with the parts picked from the phone's own device spec (`backends/android/device-spec.ts`, read over WebUSB the way `bundletool get-device-spec` reads it). Two universal APKs of one app (a debug and a release build side by side) are refused as two apps rather than taken for per-ABI builds, and an archive that declares a huge manifest is refused before anything is inflated (both review findings).

### 4.3 Install an `.aab` (2 dev-days in the page, 1.5–2 in the helper; **needs the helper**)

**What the user sees**

- An `.aab` is recognised by `BundleConfig.pb` + `base/manifest/AndroidManifest.xml`, and is never streamed to the phone.
- If a prerequisite is missing, the dialog shows the prerequisite card (§3.4), plus the manual bundletool fallback from §3.3.
- Otherwise the steps are:
  1. "Reading the phone's details"
  2. "Sending app.aab to the helper · 42%"
  3. "Building APKs for Pixel 9 (usually 2–5 s)" (measured at 1.7–4.4 s for 11 KB–137 MB [V])
  4. The normal split-set plan and install.
- A note stays visible throughout: "Signed with this computer's debug key. It can't update a copy installed from Google Play."

**Page side**

- **Device spec over WebUSB.** Read the same sources bundletool's `get-device-spec` uses [S]:
  - getprop: sdk, codename when not REL, abilist, locale properties, brand, device, `ro.soc.*`
  - `wm density`
  - `am get-config`: the `config:` locales and `abi:`
  - `pm list features`
  - the GLES line of `dumpsys SurfaceFlinger` (a constant pipeline with grep)
  - `MemTotal` from `/proc/meminfo`
- Validate the way bundletool does: locales non-empty (falling back to en-US), sdk > 0, density > 0, at least one ABI [V]. Cache the spec per serial and build fingerprint.
- Upload with XHR, for upload progress. Stream the `.apks` back, then follow the `.apks` path.

**Helper side (fits the planned `/api/*` design)**

```
GET  /api/health            + capabilities: ["android.buildApks"]
GET  /api/doctor            + android: { java, bundletool, keystore, adbServer, usbHolders }   (§3.4)
POST /api/android/build-apks?spec=<base64url JSON>   Bearer token; body = .aab (octet-stream)
     → 200 application/zip (.apks) · 422 {code:"BUNDLETOOL_ERROR", message:"[BT:1.18.3] Error: …"}
     · 424 {code:"TOOL_MISSING", tool} · 413 too large
POST /api/android/bundletool     user action: download the pinned 1.18.3 jar, verify sha256 (§1 row 9)
POST /api/android/debug-key      user action: keytool -genkeypair (alias androiddebugkey, pass android,
                                  CN=Android Debug,O=Android,C=US) in the helper's data folder
```

How the helper runs bundletool:

- `execFile(java, ['-jar', jar, 'build-apks', '--bundle=…', '--output=…', '--device-spec=…', '--overwrite', '--ks=…', '--ks-key-alias=…', '--ks-pass=file:…', '--key-pass=file:…'])`, with no shell.
- The environment drops `ANDROID_HOME` and `ANDROID_SDK_ROOT`, and PATH has no platform-tools.
- It never runs `--connected-device`, `--adb`, `install-apks` or `get-device-spec`.
- Timeout 5 minutes, and the process group is killed on abort.
- Temp folder 0700, inputs deleted afterwards.
- Output cached by sha256(aab) + sha256(spec) + signer, LRU 1 GB.
- Keystore: use `~/.android/debug.keystore` when it exists, so the build can update apps installed from Android Studio. Otherwise use the helper's own key, created only after the user agrees.

**Tests**

- **Page:** spec builder on fixtures; validation errors; client error mapping (down, LNA denied, unpaired, too old, 422, 424, aborted).
- **Helper (fake PATH):**
  - Java missing / stub / 8 / 21
  - bundletool download, with good and bad checksums
  - key creation
  - build success (a fake `java` writes a zip) and failure (a `[BT:…] Error` line → 422)
  - the environment is clean: no ANDROID_HOME, no platform-tools on PATH, no `--connected-device`
  - abort kills the JVM
  - an opt-in real run of `probe.aab`
- **On a phone (with consent):** `probe.aab` → install → `pm path` shows base plus config splits.

**Risks**

- It depends on the helper skeleton (server, Host/Origin checks, token, doctor).
- Java must be present on testers' machines.
- Debug-signed builds collide with Play- or CI-signed installs.
- Safari users must use the helper's local page.

**As built: the page half only.** The helper shipped without a bundletool lane (SPEC §0.5: "`.aab` install lane … later"), so:

- An `.aab` is recognised by its content, its summary (package, versions, ABIs) is read from the bundle's own manifest, and the dialog refuses it with `AAB_NEEDS_HELPER`: "… is an app bundle: it has to be built into APKs before a phone can install it, which needs the Device Lab helper. Until then, build an .apks with bundletool and drop that here." The bundletool command is ready to copy (`bundletoolCommand()` in `archive/plan.ts`, `--mode=universal`).
- The device spec builder is built and tested (`backends/android/device-spec.ts`), and installs already use it to pick splits (§4.2).
- The `.aab` card's helper rows read "Not checked" with a note that they are coming (§3.4).
- The helper's checklist reports bundletool and its Java (`android.bundletool`, optional, SPEC §12b), so a tester can prepare.
- None of the helper routes above exist yet, and the signing and download questions (§10 Q3, Q4) wait for them.

### 4.4 Installed apps (3–4 dev-days, browser only)

**What the user sees (Apps tab)**

- **Toolbar:**
  - A filter box.
  - A segmented control, **User · System · All**, in the same look as the platform filter.
  - Sort: "Recently updated" (default) or "Name".
  - The count, and Refresh.
- **Rows:**
  - An initial avatar (real icons in P2).
  - The package name (label added in P2).
  - versionCode.
  - Installer: "Google Play", "Package installer", or "Unknown" for `null`.
  - Last updated.
  - Badges "Disabled" and "Stopped".
- **Row ⋯ menu:** Open · Stop · App info on the phone · Copy package name · Clear data… · Uninstall…. System apps have no Uninstall entry.
- **Row click** opens a Sheet, "App details":
  - versionName and versionCode, min and target SDK
  - installer
  - first installed and last updated, shown with the device's time zone name
  - debuggable
  - splits, APK paths and sizes, data folder
- **Confirmations** (red AlertDialog action):
  - **"Uninstall {pkg} from Pixel 9?"** "This removes the app and all of its data on the phone: accounts, settings and files. It can't be undone."
  - **"Clear all data of {pkg} on Pixel 9?"** "Android deletes the app's accounts, settings, databases and files, as if it were just installed. The app stays installed."
- **Feedback:**
  - Toasts: "Stopped {pkg}." and "Uninstalled {pkg} from Pixel 9."
  - Live-region announcements.
  - The list refreshes after an install or uninstall.
- **Errors:** "Couldn't read the app list from Pixel 9: {message}" with Retry. "Android couldn't open {pkg}: {message}."

**Technical approach**

- **List:** `cmd package list packages -f -U -i --show-versioncode [-3|-s]` over shell v2, through `shellCmd`. Use `pm list packages` below Android 7. Parse it ourselves:
  - keep only `package:` lines
  - strip ` uid:`, `  installer=` (two spaces) and ` versionCode:` from the right
  - split path and name at the **last** `=`, because paths contain `=`
  - `installer=null` means none
  - a multi-user package shows several uids
  - sort on the client, because the order comes from a HashMap [S]
- **Times:** one `dumpsys package --checkin` call [S]. `pkg,` lines give lastUpdate in ms, and `pkg-usr,` lines give firstInstall in ms. If it fails, sort by name only.
- **Details:** the `Packages:` block of `dumpsys package <pkg>` (several pairs per line; times are device-local with no offset), plus `pm path <pkg>` and `sync.lstat` for sizes.
- **Actions** (all through `shellCmd`, package validated):
  - **Open:** resolve the launcher, then `am start -n`.
  - **Stop:** `am force-stop <pkg>`.
  - **App info:** `am start -a android.settings.APPLICATION_DETAILS_SETTINGS -d package:<pkg>`.
  - **Clear:** `pm clear <pkg>`, expect `Success`.
  - **Uninstall:** `pm uninstall <pkg>`, expect `Success` or `Failure [...]`.
- **Mock:** 25 fixture apps, a mix of user and system, with simulated actions and failures.

**Tests**

- **Parser fixtures (synthetic):**
  - path containing `=`
  - two spaces before `installer=`
  - `installer=null`
  - `uid:10234,1010234`
  - an `Error: Unknown option` line ignored
  - `-i` without `--show-versioncode`, which leaves a trailing space
- checkin parser; dumpsys parser (several pairs per line, the user block); installer names; sort and filter.
- Command-builder snapshots, including escaping.
- **Components:** destructive actions need a confirmation that names both the app and the device.

**Risks.** OEM and Android 17 output differences [I]; step 0 records the real output. The cost of `--checkin` is unknown.

**As built**

- **Labels and icons are in P1** (§10 Q9). Rows show the app's label and icon, read out of its installed APKs by `archive/apk-badge.ts`: the manifest names two resources, `resources.arsc` says which string and which file each is for this phone's language and screen, and the icon is read from whichever APK holds it. About 0.7–1.9 MB per app, nearly all of it `resources.arsc`, in four to nine reads. Only rows on screen ask, two apps at a time, newest request first; results are kept in memory for the page's life, keyed by package, version code and update time, so an updated app is read again and keeps its label meanwhile. Until one arrives, or for a vector icon Device Lab doesn't draw, the row shows the package name and an initial.
- **Slices are read with `dd`.** `sync` can't seek, so a piece of an APK goes over the shell as `dd if=<path> bs=4096 skip=<n> count=<n> 2>/dev/null` on whole blocks and is cut to the range in the tab (`readFileRange` in `backends/android/files.ts`). The plan's `tail -c +N | head -c M` failed on Android 7.x and 8.0, whose toybox predates `head -c` (0.7.5, late 2017).
- **Pulling APKs.** The sheet's download reads exactly the files `pm path <pkg>` listed for that app on that device in this session, over sync, one AdbSync per transfer, cancellable. The lane refuses any other path unless it is a media file under `/storage/…` or `/sdcard/…`, so the pull operation can't be pointed at the rest of the phone. Each APK is capped at **1 GiB** (a game's `base.apk` can pass 512 MB; photos and videos stay at 512 MB), checked against the size the phone reports and again while reading.
- **P1 shipped "Download APK(s)"**: one APK saved as `.apk`, several as a stored `.zip` that installs again when dropped on the page.
- **The follow-up replaced it with Export app**, in the row ⋯ menu and the sheet (`backends/archive/xapk.ts`): an app with one APK is saved as `.apk`; a split app as one **`.xapk`**, a stored zip of APKPure's v2 layout (`manifest.json` with `xapk_version` 2 and `split_apks`, an optional `icon.png`, and each APK under the name Android gave it on the phone). It installs again when dropped on Device Lab, or with SAI or APKPure's installer; `adb install` can't take it, and the toast says so. Progress shows on the row, and it can be cancelled. Nothing is copied: the result is a Blob of the zip headers and the pulled Blobs. A plain zip stops just short of 4 GB, and a bigger app is refused with a sentence.
- Rows are memoized and laid out lazily, so dialogs and sheets open smoothly on a long list, and focus returns to the row, to the next row after an uninstall, or to the filter when no row is left (the follow-up change).

### 4.5 Images on the device (3 dev-days, browser only)

**What the user sees (Images tab)**

- **Albums**, as a segmented control: **Screenshots** (default) · **Camera** · **All images**. P2 adds Videos and Downloads.
- **The grid** looks like the Screenshots card, with the same Size slider and the same `zoom` preference. Each item shows a thumbnail, the time taken and the dimensions.
- **Paging:** 60 per page, with "Load more" or infinite scroll. Thumbnails load only for visible items, 3 at a time, cached in memory.
- **The viewer dialog:**
  - The full image is downloaded when opened, with progress for large files.
  - It shows the name, size, dimensions, date taken and folder.
  - Actions: **Save**; **Copy image** (converted to PNG for the clipboard); **Add to Screenshots** (joins this session's captures); **Copy path**.
- **Notes:**
  - "Images are read straight from the phone into this tab. Nothing is uploaded."
  - Nothing loads until the tab is opened.
  - The HEIC note appears in the viewer.
- **Errors:** a blocking card, "Android didn't list the images: …", with Retry. A failed thumbnail shows a placeholder icon, never a toast. No delete in P1.

**Technical approach**

- **Query** (shell v2, `shellCmd`):
  ```
  content query --uri content://media/external/images/media
    --projection _id:_display_name:relative_path:_size:datetaken:date_modified:width:height:mime_type:_data
    --where "relative_path LIKE 'Pictures/Screenshots/%' OR relative_path LIKE 'DCIM/Screenshots/%'"
    --sort 'datetaken DESC'
    --extra 'android\:query-arg-limit:i:60' --extra 'android\:query-arg-offset:i:<n>'
  ```
  - `query` supports `--where`, `--sort` and `--extra` [S Content.java].
  - The column is `datetaken`, not `date_taken`. Strict columns reject unknown names [S].
  - `relative_path` exists only on Android 10+. On older versions, derive it from `_data`.
  - The Camera album uses `relative_path LIKE 'DCIM/Camera/%'`.
- **Parse rows** by the known projection order. Values are not escaped, nulls print as `NULL`, and an empty result prints `No result found.` [S].
- **Thumbnails:**
  - First, one `readdir` of `/sdcard/Pictures/.thumbnails`. Any `<id>.jpg` there is read over sync, with no write.
  - Otherwise, `content read --uri content://media/external/images/media/<id>/thumbnail`. MediaProvider generates the thumbnail and **writes it to its cache** (§10 Q2).
  - In strict mode instead, pull the original when it is ≤ 8 MB and shrink it with `createImageBitmap(blob, {resizeWidth})`.
  - Check the JPEG/PNG magic bytes.
- **Full image:** `sync.read(_data)`, where the path must start with `/storage/emulated/`. One AdbSync per transfer, aborted with `dispose()`.
- **Fallback when MediaStore fails:** `sync.readdir` of Pictures/Screenshots, DCIM/Screenshots, DCIM/Camera and Download, with file times only.

**Tests**

- `parseContentRows`: `, ` inside names, NULLs, an empty result, an error on stderr.
- Query-builder snapshots with escaping (quotes inside `--where`).
- Projection by SDK; album clauses.
- Thumbnail magic-byte checks; paging.
- Mock fixtures: canvas-drawn images, including a HEIC row.

**Risks**

- Shell access to MediaStore on Android 17 [I].
- The thumbnail write policy.
- Every `content` call starts a JVM, likely costing hundreds of ms [I]. Hence paging and throttled thumbnails.
- Very large photo libraries.

**As built**

- **Strict no-write** (§10 Q2). `content read …/thumbnail` is never called. A preview is a thumbnail Android already has (`Pictures/.thumbnails/<id>.jpg`, from one read-only folder listing per album listing), else the original when it is at most 8 MB and the browser can draw it, shrunk in the tab. A tile with neither says why. HEIC has no preview; the viewer offers Save.
- Newest first by the date Android shows: photos without a date taken (downloads, chat images) sort by their file time instead of falling below every camera photo (a review finding).
- The viewer has Save (the original bytes), Copy image and Copy path, and steps through the album with ← and →. "Add to Screenshots" is not built.
- Full images are pulled from media paths only, capped at 512 MB.
- In the follow-up change, the viewer's frame keeps one size, the photo's grid preview shows until the original is decoded, the next photo is read ahead, and focus stays on the button pressed: stepping no longer makes the dialog jump.

---

## 5. P2: most valuable extras (about 21–25 dev-days)

| # | Feature: where and what | How | Effort | Risk |
| --- | --- | --- | --- | --- |
| 2.1 | **Mirroring spike.** No UI. Decides the library stack. | Push scrcpy-server 3.3.3 (90 KB). Run `list_apps` and `list_displays`, then a 10 s 720p mirror on the test phone (Android 17). The result picks either stable 2.x with server 3.3.3 (3.3.4 needs a version override) or the 3.0-beta stack with server 4.1. **Needs consent:** it writes `/data/local/tmp/scrcpy-server.jar`, which the server deletes itself. | 1–2 d | Pixel updates have broken older servers twice [S] |
| 2.2 | **Apps v2: labels and icons, Download APK, details v2.** Real label and icon in rows (initials as fallback); "Download APK" in the row menu (one `.apk`, or a `.zip` of the splits, which Device Lab can install back); the permissions list in the Sheet. | Read APK slices with `tail -c +N \| head -c M` (or toybox `dd`), feeding the §4.1 badge reader. About 0.7–1.9 MB per app over USB [V offline]. Cache in IndexedDB by package + versionCode + lastUpdate. Labels in the phone's language need the `split_config.<lang>` arsc. Vector adaptive icons fall back to initials. Download uses `pm path` + `sync.read` + a ~80-line STORED zip writer. | 4–5 d | Time per app on the device [I] |
| 2.3 | **Screen recording.** A **Record** toggle next to Take Screenshot (`aria-pressed`, red dot, mm:ss); videos join the Screenshots card. | `echo $$; exec screenrecord --bit-rate 8000000 /data/local/tmp/dl-<ts>.mp4`, stopped with `kill -INT <pid>`, then `sync.read` and `adb.rm`. Default cap 180 s; `--time-limit 0` means unlimited on AOSP main [V source; I for 17]. Protected windows record black. | 2 d | Low (a temporary file) |
| 2.4 | **App under test + Logcat v2.** A pinned app (`dvc_prefs`) drives a log filter that survives restarts, a level select, a **Crashes** view with "Copy stack trace", Save .txt, Pause, and "Clear device log…" (confirmation). The Markdown gains an "App under test" line, with parity fixtures updated on purpose. | android-bin `Logcat.binary()` entries carry the uid; filter on the uid. `logcat -b crash -d`; `dumpsys activity exit-info <pkg>` (Android 11+). | 3 d | Low |
| 2.5 | **Bug report.** A header menu "Bug report ▾": **Evidence pack (.zip)** and **Full Android bug report**. | Evidence pack: Markdown, screenshots and recordings, the app's last N log lines, crashes, raw getprop, with optional redaction (the legacy `dvcMask`). Full report: `BugReport.bugReportZ({onProgress})`, then `sync.read`, a save (File System Access API when available), then `adb.rm`. A warning: "takes 1–3 minutes, contains personal data". | 3 d | Privacy |
| 2.6 | **Open link / deep link.** A header ⋯ "Open link…" dialog, with an optional "in app under test", and recent links kept per browser. | `am start -W -a android.intent.action.VIEW -d <escaped url> [-p <pkg>]`. Parse `Status: ok` or `Error:`. | 1 d | Low, once escaped |
| 2.7 | **Files tab.** Places (Download, DCIM, Pictures, Movies, Documents, `Android/data/<app under test>`), a breadcrumb, Download, Upload with progress and a media scan; Delete and Rename behind confirmations. | `sync.readdir/lstat/read/write`, using one AdbSync per transfer; `adb.rm` (escaped); then a `MEDIA_SCANNER_SCAN_FILE` broadcast. | 4–5 d | **High** for delete |
| 2.8 | **Images v2.** Videos and Downloads albums, and Delete (confirmation). | `content://media/external/video/media` and its thumbnails; delete with `content delete --uri …/<id>`. | 1–2 d | High for delete |
| 2.9 | **`.xapk` OBB push.** A second progress phase after the install. | `sync.write` to `/sdcard/Android/obb/<pkg>/…`. | 1 d | Shell write access on Android 17 [I] |
| 2.10 | **Install hardening.** | Abandon sessions left open after a pulled cable (on reconnect); CRC check while streaming. | 1 d | Low |

**As built.** Row 2.2's labels, icons and download moved into P1 (§4.4), with `dd` instead of `tail | head`, an in-memory cache instead of IndexedDB, and, after the follow-up, Export app as `.apk` or `.xapk` instead of a `.zip` of splits; the permissions list in the sheet is not built. Row 2.10's first half shipped with P1: open sessions are abandoned on the next connection (§4.1). When row 2.8's Videos album comes, its previews follow §4.5's no-write rule. Everything else in this table is not started.

## 6. P3 (about 30–50 dev-days, mirroring dominates)

| Feature | Notes | Effort |
| --- | --- | --- |
| **Mirroring and control** (new **Screen** tab: canvas, toolbar with Back/Home/Recents/Rotate/Screen off/Vol±/Screenshot/Record, keyboard capture, Esc releases) | Depends on the stack chosen in the spike. The 2.x line costs +53 KB min / +17 KB gz with the tinyh264 alias shim [V build]. Ship scrcpy's Apache-2.0 LICENSE/NOTICE. Unicode text goes through `setClipboard({paste:true})`. Turn off `clipboardAutosync` and audio by default. | 10–20 d |
| **Controls + Restore ledger + Demo mode** (Controls tab; "Modified by Device Lab · Restore all"; a "Modified" badge on the device row) | `cmd uimode night`, `font_scale`, `wm density` presets, animation scales, show taps, `cmd locale set-app-locales` (Android 13+), DemoMode. The original value is saved per serial before every write. | 4–5 d |
| Multi-device batch: install, screenshot, record on all ready phones | Builds on per-device jobs. | 2–3 d |
| Reboot (normal; other modes behind "Advanced") | `adb.power.reboot()` with a confirmation; reconnects on its own. | 1 d |
| UI hierarchy inspector, interactive shell | `uiautomator dump` drawn over a screenshot; `shellProtocol.pty()` with xterm.js. | 3 d each |
| `.aab` extras | `--local-testing` push for on-demand modules and asset packs; helper `extract-apks` fallback for texture, tier and country targeting. | 2–3 d |
| Performance, WebView devtools, reverse port forwarding (helper bridge) | — | L each |

**As built.** Not started.

---

## 7. Test plan (all phases)

1. **Unit tests** (Vitest, node environment, pure functions):

   - preflight
   - pm output
   - packages and dumpsys parsers
   - `content` rows and query builder
   - device spec
   - zip, toc, select, axml and arsc
   - install-plan checks
   - store jobs

   Fixtures are synthetic or redacted. The repo is public, so no real photo names, no private package lists and no real serial numbers.

2. **Component tests** (jsdom): checklist rows; the Install dialog states (reading, checks, sending, installing, each outcome); destructive confirmations; Tabs keeping `LogConsole` mounted.
3. **Mock lane:** `?mock=1` demonstrates every new state, `&preflight=<scenario>` shows the checklist failures, and file-name triggers produce install errors.
4. **Step 0, a read-only run on the test phone** (before building P1; 0.5–1 d). Plug the phone in, close the Device Lab tab (or press Forget), then run the read-only probe suite (p01–p05, kept with the research outside the repo). It refuses to run while anything holds the interface, and the probes run one at a time:

   | Probe | Covers                                                                   |
   | ----- | ------------------------------------------------------------------------ |
   | p01   | features, latency                                                        |
   | p02   | list formats, `pm path`, dumpsys, `--checkin`, storage stats             |
   | p03   | APK slices                                                               |
   | p04   | MediaStore `datetaken`, paging; reads only thumbnails that already exist |
   | p05   | folders, pull speed                                                      |

   Add these read-only commands:

   - `am get-config`
   - `pm list features`
   - `dumpsys SurfaceFlinger | grep GLES`
   - `head -1 /proc/meminfo`
   - `settings get global verifier_verify_adb_installs`
   - `cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER com.android.settings`
   - `command -v screenrecord bugreportz`
   - `bugreportz -v`
   - `logcat --help`
   - `ls /sdcard/Android/obb`
   - a `readdir` of `/sdcard/Pictures/.thumbnails`

   Expect small fixes on the first run. Record redacted outputs as fixtures.

5. **Install matrix on the test phone (needs consent).** Use the harmless probe app `com.bauloc.bundleprobe`: minSdk 32, targetSdk 35, one activity, no permissions [V aapt2].
   1. the universal APK, as a single install
   2. the phone's `.apks`: `pm path` should show base plus config splits
   3. a set missing xxhdpi: MISSING_SPLIT
   4. `unsigned.apks`: NO_CERTIFICATES
   5. `release.apks` over the debug build: UPDATE_INCOMPATIBLE, then "Uninstall and install"
   6. a v2/v1 build pair: VERSION_DOWNGRADE, then `-d` with a debuggable variant
   7. a targetSdk 23 variant: DEPRECATED_SDK_VERSION, then "Install anyway"
   8. a testOnly variant: `-t` added automatically
   9. Cancel mid-transfer on a padded ~100 MB variant
   10. pulling the cable mid-transfer (manual)
   11. timing for a ~110 MB set
   12. `probe.aab` through the helper
   13. Open, Stop, Clear data and Uninstall on the probe

   The run ends with the probe uninstalled.

6. **Helper tests** (fake PATH): §3.5 and §4.3.
7. **Browser matrix:**
   - Chrome stable and Edge: full.
   - Firefox and Safari: the Gate shows Blocking, and Safari gets the helper-page advice.
   - An insecure LAN URL.
   - LNA denied.
   - Light and dark, keyboard only, screen reader announcements for each job phase.

**As built**

- Items 1 and 2 are in the repo next to the code they test (`*.test.ts`, `*.test.tsx`), with the small probe APKs and `toc.pb` sets under `backends/archive/__fixtures__/` (self-made, so fine for a public repo). The parsers' formats come from AOSP and from synthetic fixtures; comments say where a phone has not confirmed them yet.
- Item 3: `?mock=1` and the file-name triggers are built; `&preflight=` is not (§3.5).
- Items 4 and 5 did not run before P1 shipped: the phone was not connected during the build. The pull request listed the install path as not verified on a real phone. The owner then tested Device Lab on the phone by hand, which produced the follow-up change (§0.1). The scripted install matrix has not run.
- Item 6 is the helper's suite (SPEC §9.2).
- Item 7 ran in headless Chrome in mock mode, light and dark, at 1440 and 390 px.

## 8. Effort and order

| Step | Effort | Depends on |
| --- | --- | --- |
| 0 Read-only phone run, fixtures | 0.5–1 d | phone plugged in, Device Lab tab closed |
| P1.0 Foundation | 3 d | — |
| P1.1 Preflight (page) | 4–5 d | P1.0 |
| P1.1h Doctor rows (helper) | 1 d | helper skeleton |
| P1.2 Install an APK | 3 d | P1.0 |
| P1.3 Split sets | 3 d | P1.2 |
| P1.4 Apps | 3–4 d | P1.0 |
| P1.5 Images | 3 d | P1.0 |
| P1.6 `.aab` (page) | 2 d | P1.3, helper skeleton |
| P1.6h `.aab` (helper) | 1.5–2 d | helper skeleton |
| P1 QA (install matrix, a11y, light and dark, mock parity) | 2 d | all |
| **P1 total** | **about 24–27 d in the page + 2.5–3 d in the helper** |  |
| P2 | about 21–25 d (spike first) | P1 |
| P3 | about 30–50 d | the spike's decision |

If the helper skeleton is late, P1.6 ships last. Until then, an `.aab` shows the prerequisite card and the manual bundletool fallback.

**As built.** P1.0–P1.5 shipped together, with the labels and icons of P2 row 2.2. P1.1h came with the helper (SPEC §12). P1.6 shipped as its page half only, which is the fallback this section foresaw (§4.3); P1.6h waits for the helper's `.aab` lane.

## 9. Not feasible, or only partly

- **`.aab` in the browser alone: not feasible.**
  - Its resources and manifest are in protobuf form, and it is signed only with the upload key. Only bundletool (32.5 MB of Java) converts it and signs the APKs.
  - With the helper it works, but builds are signed with a local key. They can't update a Play- or CI-signed install without an uninstall, which loses the app's data.
  - On-demand modules and asset packs need `--local-testing` (P3).
- **App labels and icons: no shell command prints them.** They are read from each APK (about 1–2 MB per app over USB, cached). The phone's language needs the language split, and vector adaptive icons fall back to initials. As built, this is in P1 (§4.4).
- **App data and cache sizes: partly.** `pm get-package-storage-stats` only works when its feature flags are on [S]. Otherwise only APK sizes are available.
- **Images: listing is feasible; previews are partly feasible.**
  - Previews either use Android's thumbnail cache (which may write cache files) or download the originals (3–5 MB each). As built, only thumbnails that already exist and originals up to 8 MB (§4.5).
  - HEIC originals can't be shown in Chrome; they can only be saved.
  - Not visible at all: app-private images, `Android/data`, Private space, and cloud-only photos.
- **Phone-side policy can't be bypassed.** Play Protect prompts, OEM toggles (Xiaomi "Install via USB") and MDM/work-profile restrictions all need the user to act on the phone.
- **Cancelling after the commit starts: not possible.**
- **Downgrading a non-debuggable app on a user build: not possible** without uninstalling first.
- **Android < 5.0: no installs** (no install sessions). As built, installs need Android 7.0; Android 5–6 would need the untested push route (§10 Q6).
- **Split targeting the browser can't evaluate:** texture compression, device tier, country set, conditional modules. The fallback is the helper's `extract-apks` (P3).
- **Old encrypted `.apkm`:** refused, with "download it again".
- **Physics.** Device Lab and any adb tool (Android Studio, scrcpy, the Tango web app) can't hold the same phone over USB at once: a USB interface has one owner. The helper's way around it is to share Google's adb server instead of fighting it (SPEC §4.6).
- **Not planned:**
  - an adb-based Android lane in the helper for Firefox/Safari users (it would duplicate every feature server-side). As built, the helper does list, detail, screenshot and log Android devices through the adb server, Android TVs over Wi‑Fi included (SPEC §4). Since helper 1.3.0 it also carries this plan's operations (installs, apps, images) unchanged, through an adb tunnel: the page runs the very code WebUSB runs, over a WebSocket per service (SPEC §4.10). Nothing is duplicated in the helper.
  - backup/restore
  - disabling system packages
  - EDL/fastboot reboots
  - wireless ADB from the page itself (no raw TCP in a browser). As built, the helper connects Wi‑Fi devices through the adb server on a click (SPEC §4.7).
  - system-wide language changes

## 10. Open questions, and the answers the build followed

Each question came with a recommended default; the answer is what was built.

1. **Tabs in the detail column.** Overview · Apps · Images, styled like the existing segmented control (reference: https://ui.shadcn.com/docs/components/tabs). This was the one structural change to the locked UI; the alternative was stacking more cards below the log. _Default: Tabs._ **Answer: Tabs.** Overview stays mounted, so the log keeps streaming.
2. **Image previews.** Should Android be allowed to create missing thumbnails in its own cache (`Pictures/.thumbnails`, which Android cleans up)? _Default: yes, with a one-line note._ The alternative was a strict no-write mode: existing thumbnails plus downloaded originals. **Answer: strict no-write** (§4.5).
3. **`.aab` signing.** A per-machine debug key, reusing `~/.android/debug.keystore` when present _(default)_; or a shared team key configured in the helper, so testers can update each other's builds. Release and upload keys stay out of scope. **Open:** it waits for the helper's `.aab` lane (§4.3).
4. **Should the helper download bundletool 1.18.3 automatically?** It is SHA-256-pinned. _Default: yes, after a click._ **Open,** with Q3. Today the helper's checklist suggests `brew install bundletool`.
5. **Uninstall and Clear data in P1**, behind confirmations? Uninstall is also needed for "Uninstall and install". _Default: yes._ **Answer: yes**, with red confirmations that name the app and the phone.
6. **Minimum Android for installs.** _Default: 7.0 (tested path)._ Android 5–6 only if needed. **Answer: 7.0** (`MIN_INSTALL_SDK = 24`).
7. **After a successful install,** offer **Open app** _(default)_, or open the app automatically as STF does? **Answer: offer Open app**; nothing opens by itself.
8. **Consent on the test phone:**
   - (a) the read-only step-0 run
   - (b) the install matrix with `com.bauloc.bundleprobe`, uninstalled at the end
   - (c) the P2 mirroring spike, which writes a temporary jar to `/data/local/tmp`

   **As built:** (a) and (b) did not run, because the phone was not connected during the build; the owner tested by hand after release (§7). (c) waits for P2.

9. **App labels and icons** in P2 as planned, or move them into P1 (+2–3 days)? **Answer: P1** (§4.4).
10. **Will testers use Linux or Windows?** This decides how much to invest in udev and driver guidance and testing. **No answer:** both got real guidance in the checklist (§3.2), untested on those systems.

## 11. Material ported

The research material (prototypes, probe suites, reports, the AOSP and android-bin sources read) stays outside the repo. What came from it, and where it lives now:

- **Archives, selection and `.aab`:** the ZIP, toc, selection, binary-XML and plan prototypes became `backends/archive/{zip,toc,select,axml,plan}.ts`; the probe app and its `.apks` test sets became the fixtures in `backends/archive/__fixtures__/` (with `make-badges.sh` and `make-picks.mjs`, which rebuild them and are kept out of CI).
- **Install sketch:** `classifyPmOutput` became `backends/android/pm-output.ts`; `collectDeviceSpec` became `backends/android/device-spec.ts`.
- **Parsers and the APK badge reader:** the probe parsers became `backends/android/packages.ts` and `media.ts`; the badge reader became `backends/archive/apk-badge.ts` and `arsc.ts`.
- **ya-webadb sketches** (type-checked against TypeScript 6.0.3): the install, sessions, sync, media and device-spec parts became `backends/android/*` and `backends/webusb-ops.ts`; recording, bug report and mirroring wait for P2/P3.
- **android-bin 2.1.0 sources** (`cmd.ts`, `pm.ts`): read to decide §0's "transport only".
- **AOSP references:** `PackageManagerShellCommand.java` (`-p` at line 421, install-create at line 1738, commit warnings at lines 4317–4321) and `Content.java`.
- **Helper design inputs** (the local-server and browser-localhost reports): they became `_app/helper/SPEC.md`.
