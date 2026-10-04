# Device Lab helper: specification

`device/agent/device-bridge.mjs`, built from `_app/helper/src`, and the page's helper lane in `_app/src/features/device` · helper 1.1.1, protocol 1 · as built, 2026-10-05

**What this is.** The design Device Lab's local helper was built from, kept up to date with what was built. Decisions taken while building it are recorded where they apply, and §0.6 lists them in one place. The code cites this document by section ("§3.3", "spec §12b"), so section numbers are stable: a section that no longer applies says so instead of disappearing.

**Two kinds of § in the code**

- In the helper, each module's header comment opens with its **file section** from §1.2: `§5 usbmuxd`, `§7 iOS lane`, `§9 Android lane`, `§12 Doctor and preflight`. Those number the regions of the built file, in file order, and its table of contents uses them.
- Every other § in the code, in the helper and on the page, is a section of this document.
- `PLAN §…` on the page cites the Android plan that came before the helper (WebUSB installs, apps, images and the first preflight checklist), `_app/src/features/device/PLAN.md`, not this document.

**Evidence tags**

- **[V]** Verified on the build Mac or on the test iPhone: in the research, by read-only probes, while writing the design, or against the built helper (§9.7).
- **[S]** Read in installed source, scripts or binaries.
- **[D]** Primary documentation.
- **[I]** Inferred. Phase 0 (§9.5) or the real-device checklist (§9.6) confirms it.

**Terms**

- **Lane**: one page `Backend` (WebUSB, agent, mock), or one helper platform (`ios`, `android`, `simulators`).
- **LNA**: the browser's Local Network Access permission `loopback-network`.
- **usbmuxd**: macOS's iOS mux daemon, socket `/var/run/usbmuxd`.
- **Lockdown**: the iPhone's `lockdownd`, device port 62078.
- **DDI**: developer disk image.
- **BFU / AFU**: before / after first unlock since boot.
- **Network serial**: how adb lists a device it reaches over the network, `host:port` (`192.168.1.20:5555`, `[fe80::1%en0]:5555`), or an mDNS name (`adb-…._adb-tls-connect._tcp`).
- **WP**: work package (§11).

**Placeholders.** `<UDID>` stands for an iPhone's UDID, `<serial>` for an Android serial, "Tester’s iPhone" for a device name. Real identifiers from the test devices are not part of this document.

---

## 0. Decisions

### 0.1 Decisions

1. **One file for testers, modules for authors.**
   - Testers download `device/agent/device-bridge.mjs`: one readable ESM file, Node built-ins only, no npm dependencies. It listens on `127.0.0.1:8787` only. `main()` runs only when the file is executed directly; it exports `createBridge()` and pure helpers for tests and for `helper:fake`.
   - It is written as TypeScript modules in `_app/helper/src`, one per file section (§1.2), and bundled by rolldown into that one file, with its doc comments, one `//#region` per module and a header with a table of contents (§1.1).
   - Syntax and APIs stay Node-18-safe; the build checks the bundle's syntax tree for anything newer.

2. **iOS is native Node.** The helper talks to usbmuxd and lockdown directly (XML plists, then TLS with the Mac's existing pair record). That covers listing, hot-plug, trust, identifiers, battery, storage, Developer Mode, lock state and the system log on iOS 15–27, with nothing installed but Node.
   - Verified on a real iPhone 12 Pro (iOS 27.0) over Wi‑Fi and USB in the research, and over Wi‑Fi and then USB against the built helper (§9.7) [V].
   - libimobiledevice is an optional fallback. pymobiledevice3 is not run in v1.

3. **Screenshots use each platform's own tool.**
   - iOS: Xcode's `devicectl device capture screenshot`. The helper runs the real binary directly, behind a first-launch gate, with JSON written to a private file (§1.5). It is feature-detected, not version-gated. Phase 0 confirmed it on the real iPhone (P0-5, §9.5).
   - iOS 16 and older: `idevicescreenshot` (best effort).
   - Simulators: `simctl io`.
   - Android: `screencap -p` through the adb server.
   - The root-tunnel lane is specified (§3.12) and stays in v1.1: P0-5 passed, so v1 does not need it.

4. **Logs.**
   - iOS: native `com.apple.syslog_relay`, verified on iOS 27 over Wi‑Fi and USB [V]. Fallback: `idevicesyslog`.
   - Android: `logcat -v threadtime -T 200` over the adb server.
   - Simulators: `simctl spawn … log stream --style compact`.
   - The native `os_trace_relay` parser is deferred (§3.12).
   - On the page a log outlives its console: a device that drops for a moment is waited for and the log resumes (§7.8).

5. **Android shares Google's adb server.**
   - The helper speaks the adb host protocol on `127.0.0.1:5037` and never runs an adb command that can start a server.
   - The server is started only by an explicit "Start adb server" click (§4.5), and the helper never kills it.
   - Devices on the local network (an Android TV, a phone without its cable) are reached through the same server, by three host services sent only on the tester's click, each through its own exact check (§4.7).

6. **Lane merge rule.** This replaces "first lane wins". Per device id:
   - The mock lane never beats a real lane.
   - A `held` row loses to any other lane's row.
   - Otherwise the better `STATE_WEIGHT` wins.
   - Lane order `[webusb, agent, mock]` breaks ties.

7. **Pairing.**
   - The token is 256-bit and new on every run (`--keep-token` keeps it). It is delivered in the `#pair=` fragment of the link the helper auto-opens, or pasted.
   - Before the page sends a token anywhere, the helper must prove it holds it: `GET /api/health?challenge=` returns an HMAC bound to the helper's port (§2.8).
   - `tokenId` (8 hex characters) remains for wording ("helper restarted", fingerprint).
   - One-time pairing codes are deferred (§0.3, G27).

8. **Transport.**
   - Device list: short polling, `GET /api/devices` every 2 s while visible and 10 s while hidden. No event stream.
   - Logs: NDJSON over `fetch`, at most 1 per device and 3 in total.
   - Screenshots: `POST` → `image/png`.
   - Wi‑Fi connect, pair and disconnect: `POST` with a small JSON body (§4.7), the only routes that read one.

9. **Browser modes.**
   - **Hosted** (Chrome, Edge, Firefox): one LNA prompt, never triggered without user intent.
   - **Local** (Safari, or anyone without the permission): the helper proxies the live page and injects a token-free `window.DVC_BOOT`. The hosted page forwards Safari there when it carries a `#pair=` fragment.

10. **Off by default.** iPhones seen only over Wi‑Fi (`--wifi`, because they flap [V]) and booted simulators (`--simulators`, because they defeat one-ready-device auto-select). Android devices on the network are listed whenever the adb server lists them: someone connected them on purpose.

11. **Preflight checklist (§12).**
    - The helper checks host tools and words those items, so the terminal and the page say the same thing.
    - The page checks the browser, the connection and each device, and words those items.
    - The page side extends the checklist Device Lab already had for Android (`src/features/device/preflight/`), rather than adding a second one (§12, §0.6).
    - The checklist appears on the Gate, in the Environment check, and inline next to a blocked capability.

12. **Page contracts kept.** The `Backend` interface, the hint-code rule (backend owns codes, page owns wording), `androidDetail()` and parity are unchanged.
    - No zod: hand-written guards.
    - Four new hint codes.
    - No parity divergence in v1, because `TUNNEL_REQUIRED` and `IOS_NETWORK_ONLY` are never emitted.

13. **Certificate pinning is enforced.** A lockdown session whose peer certificate is not the pair record's `DeviceCertificate` is ended (§3.3, G25). Phase 0 showed the iPhone presents exactly that certificate (P0-6).

14. **Auto-open without the token in argv.** The pairing link reaches the browser through AppleScript's `open location` on `/usr/bin/osascript`'s stdin, never in a process's arguments, which any user on the Mac can read with `ps` (§1.7, T8).

15. **Never.** The helper never runs sudo, sends a lockdown `Pair`, shows Trust prompts itself, mounts or downloads a DDI, installs apps, kills the adb server, sends telemetry, or listens on anything but 127.0.0.1. It changes what the adb server serves only through the three Wi‑Fi services of §4.7, on a click.

### 0.2 Checked while writing the design (2026-10-04)

| Fact | How |
| --- | --- |
| The `devicectl` wrapper (zsh) compares `EXPECTED_VERSION="642.16"` with `PlistBuddy -c "Print :CFBundleVersion" …/CoreDevice.framework/Versions/A/Resources/Info.plist` **exactly**. On a mismatch it runs `xcodebuild -runFirstLaunch` with stdout **not** redirected, then `exec`s `/Library/Developer/PrivateFrameworks/CoreDevice.framework/Versions/A/Resources/bin/devicectl`. | Read the script [V] |
| The `simctl` wrapper (bash) runs first launch (stdout redirected to stderr) when CoreSimulator's `CFBundleVersion` is empty or **older than** `1171.7`, after removing trailing `.0`. It then `exec`s `…/CoreSimulator.framework/Versions/A/Resources/bin/simctl`. | Read the script [V] |
| CoreDevice's `Info.plist` is a **binary** plist (PlistBuddy reads it: `642.16`). CoreSimulator's is XML (`1171.7`). `Xcode.app/Contents/version.plist` is XML (`CFBundleShortVersionString 27.0`, `ProductBuildVersion 27A266a`). `SystemVersion.plist` is XML (`27.0.1`). | `file`, PlistBuddy, plutil [V] |
| `xcodebuild -license check` exits 0 in 0.04 s. `xcodebuild -checkFirstLaunchStatus` exits 0 in 0.12 s. | Ran [V] |
| **Real pair-record certificates (Root, Host, Device) have empty subject and issuer names.** Host and Device are signed by the Root key. `createSecureContext` accepts the Host certificate at default, `@SECLEVEL=0` and `@SECLEVEL=2`. | A read-only script on Node 24.12 and 20.19.6; names and relations only, no key material [V] |
| A **named** SHA-1 chain (`CN=Root` → `CN=Host`) makes `tls.connect` / `createSecureContext` **throw synchronously** `ERR_SSL_CA_MD_TOO_WEAK` with default options. `ciphers:'DEFAULT:@SECLEVEL=0'` connects (TLS 1.3). Comparing the peer certificate's DER with the expected device certificate (pinning) works. | Generated chains, Node 24.12 and 20.19.6 [V] |
| Both local Nodes (20.19.6, 24.12.0) are Homebrew builds linked to Homebrew **OpenSSL 3.6.1**. nodejs.org builds (bundled OpenSSL) are untested. | `otool -L`, `process.versions.openssl` [V] |
| `/usr/bin/openssl` is LibreSSL 3.3.6. It can generate SHA-1 RSA-2048 chains and certificates with an empty subject (`-subj "/"`), which the test fakes need. | Ran [V] |
| `adb version` prints `Android Debug Bridge version 1.0.41` / `Version 36.0.0-13206524` / `Installed as …` / `Running on …` and starts **no** server. | `lsof` and `pgrep` before and after [V] |
| pymobiledevice3 from python.org's Python 3.9: `pymobiledevice3 version` → `9.8.1` in 1.06 s. `/usr/bin/python3` is a shim binary. | Ran [V] |
| `idevicesyslog` 1.4.0 has `-u`, `-n`, `-x`, `--no-colors` and `--syslog-relay`. `ideviceinfo --version` → `ideviceinfo 1.4.0`. | `--help` [V] |
| `/usr/libexec/java_home` → JBR 21.0.11; `java -version` prints `openjdk version "21.0.11"` on stderr. `bundletool` (Homebrew) is a bash script using `${JAVA_HOME:-/opt/homebrew/opt/openjdk/…}`; `bundletool version` → `1.18.3` in 0.19 s. | Ran [V] |
| Xcode's `device_traits.db` has 187 rows (182 distinct `ProductType`). `/usr/bin/sqlite3 -json` reads it; `iPhone13,3` → `iPhone 12 Pro`. | Ran [V] |
| `zod` is in `package.json` but not imported by the device feature. Vendored shadcn parts include `switch`, `label`, `tooltip` and `alert-dialog`. | grep, `ls` [V] |

**Verified by the research and relied on by the design [V]:**

- Native lockdown on a real iPhone 12 Pro (iOS 27.0): over Wi‑Fi and USB, Node 24.12 and 20.19.6.
  - `StartSession` returns `EnableSessionSSL`.
  - TLS 1.2 `ECDHE-RSA-AES256-GCM-SHA384` in 18–49 ms.
  - A session `GetValue` returns 82–84 keys.
  - The battery, disk_usage and international domains answer. The explicit amfi `DeveloperModeStatus` key works (dumping that domain gives `{}`).
- `syslog_relay` with service TLS works over Wi‑Fi (169–468 messages/s) and USB (75 messages in 3 s).
- The no-session `GetValue` returns 8 keys over Wi‑Fi and **26 over USB**, including `BuildVersion`, `DeviceClass`, `UniqueDeviceID`, `WiFiAddress`, `BasebandSerialNumber` and `DieID`.
- The session's `PasswordProtected` is `true` exactly when `devicectl lockState` says `passcodeRequired:true`, and `false` otherwise. Everything above worked while the phone was locked after first unlock.
- usbmuxd Network entries come and go, and `DeviceID` changes on every attach. The build measured how long (§3.9).

### 0.3 Design decisions (G1–G29)

The design compared several candidate designs; these are the parts it took from one or another, and why. The code cites some of them by number.

| # | Decision | Outcome and reason |
| --- | --- | --- |
| G1 | Predict the Xcode first-launch trap without running the wrapper; run the real binaries | **Adopted** for devicectl (exact match) and simctl (not older), §1.5. A start-up `devicectl … -h` through the wrapper and `--json-output -` are out: the wrapper's first-launch output goes to stdout [V]. |
| G2 | `--doctor` with a read-only per-device probe | **Adopted**, §1.9. Its output is the Phase 0 and PR evidence. |
| G3 | `ProductType` → marketing name from `device_traits.db` | **Adopted** on the page (`backends/ios-models.json`), so rows read "iPhone 12 Pro" without Xcode. |
| G4 | The mock lane never beats a real lane, plus a fake mock UDID | **Adopted**, §7.4. |
| G5 | `--keep-token` file 0600 in a 0700 directory, refusing symlinks and files readable by others; `--new-token`; `health.tokenPersistent` | **Adopted.** "Remember on this computer" is shown on the hosted page: with per-run tokens it still keeps new tabs paired during one run, and its note says whether pairing survives a restart. The helper's own page never remembers (§6.5). |
| G6 | Native `os_trace_relay` parser behind syslog_relay | **Deferred to v1.1** (layout kept in §3.12). syslog_relay is verified on iOS 27 over USB and Wi‑Fi; os_trace is not, and it is the largest blind parser. |
| G7 | `X-Screenshot-Source`, `hello.source`, `health.sha256` and an update row | **Adopted.** |
| G8 | Phase 0 spike before code that depends on [I] facts | **Adopted**, §9.5, with three decision gates. |
| G9 | Contract test: helper ↔ `DETAIL_COMMANDS`, blocker coverage, `PROTOCOL` | **Adopted**, §9.1. |
| G10 | A separate "Ask the iPhone to trust this Mac" action | **Deferred.** It needs libimobiledevice or Xcode and writes state. v1 gives Finder guidance (§12); P0-8 decides. |
| G11 | Short polling instead of `/api/events` | **Adopted** for all tabs. It holds no connection, needs no watchdog, and fits the 6-connections-per-host budget. |
| G12 | Map errors by class and raw lockdown string; tunnel command with an absolute path | **Adopted.** Lockdown errors are raw strings in v1. The absolute-path command applies when the tunnel lane ships. |
| G13 | Session `PasswordProtected` as the lock signal; devicectl `lockState` as a cross-check | **Adopted.** `lockState` runs only in `--doctor`. |
| G14 | Proof of possession: `health?challenge=` → HMAC | **Adopted and strengthened.** The HMAC message includes the helper's bound port, so a squatter on another port cannot relay a challenge to the real helper (§2.8, T7). |
| G15 | devicectl JSON written to a private temp file | **Adopted.** |
| G16 | `adb start-server` with stdio ignored, detached and untracked, then poll `host:version` | **Adopted**, §4.5. |
| G17 | Allowlists and "never sent" lists in code, asserted by tests | **Adopted**, §1.2 and §9.2. |
| G18 | Untrusted: poll only `ReadPairRecord` every 3 s | **Adopted**, plus a 5 s full re-probe for "record exists but revoked" (§3.4). |
| G19 | CSP hashes for every inline script; `sandbox` CSP on proxied non-HTML assets | **Adopted**, §2.9. |
| G20 | Streams fit the browser pool: 1 log per device, 3 in total | **Adopted.** |
| G21 | Hand-written guards; the store's contract unchanged | **Adopted.** |
| G22 | Verify a fragment credential before storing it; never overwrite a working token with an unverified one | **Adopted**, §6.5. |
| G23 | Per-code lockout, auto-submit once | **Moot.** No codes in v1. A fragment token is verified at most once per page load. |
| G24 | Infer "start with `--dev`" from a dev origin plus `TypeError` | **Adopted**; the unobservable `origin-refused` phase is dropped. |
| G25 | Pin lockdown TLS to the pair record's `DeviceCertificate` | **Adopted and enforced.** It was gated on Phase 0; P0-6 showed the iPhone presents exactly that certificate in three runs out of three, so a mismatch now ends the session (§3.3). |
| G26 | Always use `@SECLEVEL=0` and catch synchronous TLS throws | **Adopted.** §0.2 shows why: a named SHA-1 chain throws synchronously under defaults. |
| G27 | v1 pairs with the per-run token in `#pair=`; codes, rotation and terminal keys deferred | **Adopted.** A token works only against 127.0.0.1 on this Mac while the helper runs. Same-user processes are out of scope, other macOS users cannot read the terminal or browser profile, and G14 closes the concrete squatter and relay attack. Codes would add about 200 lines plus lockout edge cases. Residuals are in T8. |
| G28 | Minimal merge rule, "held/absent yield, else first lane" | **Rejected.** A WebUSB `offline` or `WEBUSB_CLAIM_FAILED` row would hide the helper's `ready` row. |
| G29 | A lean phase set | **Adopted.** 13 phases (§6.6); `origin-refused` and `pairing` removed. |

### 0.4 Pitfalls fixed

| # | Pitfall | Fix (where) |
| --- | --- | --- |
| P1 | Simulators listed by default | Off; `--simulators` (§5). |
| P2 | Wi‑Fi iPhones listed by default; long gaps | Off; `--wifi` shows a new entry after 2 s and holds a detached one for 120 s (§3.9). |
| P3 | `IOS_NETWORK_ONLY` copy ("logs need a cable") is false | Never emitted; the Wi‑Fi badge is enough. |
| P4 | No syslog_relay lane | syslog_relay is the primary log lane (§3.8). |
| P5, P6 | Depending on Python tools; an untested sidecar | No sidecar; basics need only Node. |
| P7 | Ordinary buttons change device state | Retry is read-only (§3.4, §4.4). No DDI automation. Start adb server, and Wi‑Fi connect, pair and disconnect, are explicit, labelled clicks. |
| P8 | Wrapper first-launch trap, a `-h` probe, JSON on stdout | G1 and G15. The capture `-h` probe runs only after the gate passes and only on the real binary. |
| P9 | First-lane-wins merge | §7.4 rule. |
| P10 | BigInt ECID breaks `JSON.stringify` | Values above 2^53 become decimal strings at the whitelist boundary; `sendJson` has a BigInt replacer; tested (§9.2). |
| P11 | A DDI fix that writes into Xcode.app | v1 never suggests `pymobiledevice3 mounter auto-mount`; the later DDI lane uses a helper cache (§3.12). |
| P12 | The os_trace reply length is little-endian, not big-endian | Noted in §3.12. |
| P13 | TLS on other OpenSSL builds and chain-signed certificates | G26; the test fakes use both an empty-name and a named chain (§9.2). |
| P14 | devicectl on the real device, USB and BFU unverified | Phase 0: P0-2, P0-4, P0-5 (§9.5). P0-5 passed over Wi‑Fi, and capture worked on USB after the build (§9.7); BFU is open. |
| P15 | An 800 ms "dismissed" heuristic | 1 s threshold. The failure mode is wording only, since both phases offer "Connect". Checked in P0-9. |
| P16, P17 | A parallel `store.start` change; zod in the device chunk | Store contract unchanged; hand-written guards (`helper/protocol.ts`). |
| P18 | Auto-open on every start; `host:kill` at exit | Auto-open kept, but TTY and macOS only, with `--no-open`, through osascript's stdin (§1.7). **Never kill the adb server**; exit prints how to stop one the helper started. |
| P19 | MAC addresses whitelisted | `WiFiAddress`, `BluetoothAddress` and `EthernetAddress` are never read out of the plist. |
| P20 | Token printed and in URLs | Accepted residual with reasons (G27, T8). The fragment is stripped before the router exists; `Referrer-Policy: no-referrer`; never in argv (§1.7). |
| P21 | Squatter replays the public `tokenId` | G14, port-bound HMAC proof. |
| P22 | `origin-refused` / `foreign` unobservable (403 without CORS) | `origin-refused` removed; dev-origin inference (G24); `foreign` only when a readable non-helper reply or a failed proof is seen. |
| P23 | pymobiledevice3 writes pair keys to temp files | pymobiledevice3 is not run in v1. The later tunnel lane sets `TMPDIR` to the helper's private directory. |
| P24 | `#pair` token stored before the check | G22. |
| P25, P38 | Pairing-code auto-submit DoS; global closure | Moot (G27). |
| P26 | devicectl `--json-output -` | Private file. |
| P27 | `adb start-server` through a piped runner | G16. |
| P28 | Stream caps exceed the 6-connection pool | Polling plus at most 3 log streams in total. |
| P29 | `?tail=` interpolated into `exec:` | No parameter; fixed `-T 200`. |
| P30 | Id patterns never specified | `ID` patterns in §2.2. |
| P31 | The LNA grant is origin-wide | Stated in T12; local mode avoids the grant. |
| P32 | No device-certificate pinning | G25, enforced. |
| P33 | An out-of-date research claim about native lockdown | Recorded as verified (§0.2). |
| P34 | `TUNNEL_REQUIRED` command variants; `sudo` resets PATH | Lane deferred and hint untouched in v1. When it ships: no `-d`, and the hint defers to the Doctor's absolute-path command (§3.12). |
| P35 | Pre-session `GetValue` over USB includes sensitive keys | The whitelist applies to pre-session reads (§3.5). |
| P36 | Node 20's OpenSSL attribution | Corrected (§0.2); `SECLEVEL=0` is the default. |
| P37 | `IOS_LOCKED` copy is wrong after first unlock | Emitted only when the session is refused (the BFU case); an AFU-locked phone stays `ready`. Pinned copy kept until P0-4. |
| P39 | "Remember" meaning unclear with per-run tokens | Defined in §6.5. |

### 0.5 Scope

| v1 (built) | Later |
| --- | --- |
| Helper core: security pipeline, token + proof, `--keep-token`, local mode, CLI, banner, auto-open, `--doctor`, preflight | One-time pairing codes, token rotation, terminal keys |
| iOS: usbmuxd list and hot-plug; lockdown identity, trust, lock, Developer Mode, detail; pinned TLS; devicectl screenshots; `idevicescreenshot` for iOS ≤ 16 (best effort); syslog_relay plus `idevicesyslog`; `ideviceinfo` fallback; `--wifi` | Root-tunnel screenshots; DDI mount from a helper cache for iOS 15–16; native os_trace; "Ask to trust" action; helper-side log filter; CoreDevice-only Wi‑Fi devices |
| Android: attach-only adb host protocol (list, detail, screenshot, logcat, retry), an explicit start, and Wi‑Fi connect, pair and disconnect (§4.7) | `.aab` install lane (bundletool; its preflight item ships now); apps, images and installs over Wi‑Fi (the page says they need a cable) |
| Simulators (`--simulators`) | — |
| Page: agent lane, connection, pairing, chip, Gate card, notice, pair dialog, Wi‑Fi dialog, Environment check, preflight rows, log levels, log sessions that resume, badges, merge rule, hints, `iosDetail`, model map | — |

### 0.6 Changes since the design

What was decided while building, and where each one now lives in this document.

| Change | Why | Where |
| --- | --- | --- |
| The helper is TypeScript modules in `_app/helper/src`, bundled by rolldown into one readable file, instead of one hand-written `.mjs` checked with JSDoc | Types across 20 modules, one owner per module, and a reviewable output: no minification, doc comments kept, one region per module, a table of contents with real line numbers | §1.1, §1.2 |
| The helper's tests run on Vitest (`npm run test:helper`, `helper/vitest.config.ts`, one process per file), not `node:test` | One test runner for the repo; `forks` because the tests spawn tools and send signals | §9.2 |
| Certificate pinning is enforced | P0-6 passed, three runs out of three | §3.3, G25 |
| Auto-open goes through `osascript` on stdin, not `/usr/bin/open <link>` | The link carries the token, and argv is readable by every user on the Mac | §1.7, T8 |
| The page's checklist extends the Android preflight system in `preflight/` (`checks.ts`, `copy.ts`, `types.ts`, `env.ts`, `components/checklist.tsx`) instead of new `helper/preflight.ts`, `preflight-list.tsx` and `preflight-card.tsx` | One checklist, one wording file, one set of components for every row | §7.1, §12 |
| Android over Wi‑Fi: `POST /api/android/connect`, `/pair`, `/disconnect`, LAN-only addresses, names resolved by the helper before adb sees them | Android TVs have no cable, and a browser cannot open TCP | §4.7 |
| `--wifi` holds a detached iPhone 120 s, not 30 s; a returning row skips the 2 s wait; a cut link never downgrades a ready Wi‑Fi row | Measured: absences of 6–90 s, once 289 s; 30 s dropped the row in about half of them | §3.9 |
| Logs end with `{reason:'device-gone', code:'DEVICE_DROPPED'}` when a Wi‑Fi device drops mid-stream; the page waits as long as the helper holds the row (120 s) and resumes; a row that leaves the list stops the log at once | A log that silently went back to "Press Start" hid the drop | §2.5, §7.8 |
| New error codes: `ANDROID_OFF`, `HELPER_STOPPING`, `STREAM_REPLACED`, `BAD_REQUEST`, `DEVICE_DROPPED`, `ANDROID_CONNECT_FAILED`, `ANDROID_PAIR_FAILED`; `INTERNAL` | Cases the design left unnamed | §2.7 |
| New health feature `android.connect` | The page shows the Wi‑Fi dialog only to a helper that has it | §2.8 |
| Helper 1.1.0: a release that adds a feature bumps the minor version. Where the page would use a feature the running helper lacks, it says "Your helper is older than this page" with the update command; the header chip and the notice strip say "update available" from the published file | Discovery shipped as 1.0.0 like the helper before it. The owner kept running the older file, the page silently hid "On this network", and only the Environment check's update row hinted why | §2.8, §4.8, §6.8 |
| Helper 1.1.1, a fix: the mDNS codec refuses a label that is not UTF-8, so every name it reads can be asked about again; nothing a packet or the transport does throws out of the browser's message handler or follow-up timer; a service type that cannot be written is refused before the socket opens; avahi lines are searched for the type as text; linked signals and their parents take any number of abort listeners; "On this network" shows the page's sentence for a failed request's code | Any host on the network could stop the helper while "On this network" showed: an answer (id 0 is taken) naming an instance of 22 or more 0xFF bytes made the follow-up's `encodeName` throw in a timer. Node 18 and 20 printed a MaxListenersExceededWarning on every dns-sd scan, and the page printed `HELPER_UNREACHABLE` as it was | §1.1, §2.8, §4.8 |
| Discovery: `GET /api/android/nearby`, a zero-dependency mDNS browser (`mdns.ts`), `host:mdns:services` on the allowlist, health feature `android.discover`, a `Wi-Fi:` line in the terminal and `--doctor` | Wi‑Fi devices appeared only after a manual connect; the owner asked for every Android device on the network | §4.8 |
| Discovery also asks the system's resolver (`dns-sd` on macOS, `avahi-browse` on Linux) and reads adbd's TXT (`given_name`, `name`, `serial`, `api`); `blocked` only when no source could look, otherwise a `note` | On the owner's network the dozing Pixel 9 never answered the helper's own queries, while `dns-sd` listed it from mDNSResponder's cache, even from an app without local-network access | §4.8 |
| `HelperError` is exported from the bundle | The bridge maps only its own class to a code; `helper:fake` builds its errors from it | §1.2 |
| `createBridge()` defaults to `local: true`; embedders (`helper:fake`, the page's real-helper tests) pass `local: false` | The CLI's default is local mode on | §1.6 |
| The banner waits, within its 3 s, for the iPhone and simulator lanes to report, and prints `checking…` until they do | It printed "unavailable" for lanes that had not listed anything yet | §1.10 |
| A local-mode upstream error keeps its status (a 404 upstream is 404 `UPSTREAM_STATUS`) | An honest status for a file not yet published | §2.9 |
| The update row reads `const VERSION = "…";` from the built file | That is how the bundler writes it | §2.8 |
| "Page connected" names dev origins ("the dev page http://localhost:7360 (npm run dev)"); "Another client" only without an Origin | Headless Chrome's user agent and dev origins read as unknown clients | §1.10 |
| `--doctor` prints each iPhone's UDID and ProductType, never its name | The output is pasted into PRs | §1.9 |
| Fixtures live in `_app/helper/test/fixtures/` | The helper's suite sits next to its source | §9.1, §9.2 |

---

## 1. Architecture of `device-bridge.mjs`

### 1.1 Shape and constraints

**Source**

- `_app/helper/src/*.ts`: one module per file section (§1.2), about 11,800 lines with their comments. `types.ts` holds the shared types and is erased by the bundler.
- Built-ins only: `node:http`, `net`, `tls`, `crypto`, `child_process`, `fs`, `os`, `path`, `url`, `dns`, `dgram`, `events`, `string_decoder`. No npm package reaches the bundle.

**Bundle** (`helper/build.mjs`, `npm run helper:build`)

- rolldown (1.2.7, a devDependency) bundles `main.ts` into `device/agent/device-bridge.mjs`, about 8,600 lines.
- Readable on purpose, because a tester may review it before running it: no minification, each module in its own `//#region`, a shebang, then the header from `helper/header.txt` with the version and a table of contents carrying real line numbers.
- Only `/** … */` doc comments survive bundling; `//` and `/* */` comments are dropped by the code generator. Anything a reader of the built file should see is therefore a doc comment in the source.
- `main.ts` imports the modules in file-section order, because the bundler lays the file out in import order; the bare imports exist only to place a section. `cli.ts` is imported right after `constants.ts`, so it is the third region.
- Before writing, the build checks the bundle: `node:` built-ins are its only imports, the version guard is its first code, `VERSION` appears once, and no API newer than Node 18 is used.
- `node helper/build.mjs --check` exits 1 when the committed file differs from a fresh build. `npm run verify` runs it.

**Node 18 safety**

- `tsconfig.helper.json` types the source against the ES2022 library, which Node 18 has in full, so `toSorted`, `Object.groupBy` or `Promise.withResolvers` fail the typecheck.
- Node-only APIs newer than 18 are typed by `@types/node`, so the build also walks the bundle's syntax tree (`forbiddenApis`, asserted again by `test/build.test.ts` on the built file). Forbidden: `AbortSignal.any`, `Promise.withResolvers`/`try`, `Object.groupBy`, `Map.groupBy`, `Array.fromAsync`, `URL.canParse`, `process.getBuiltinModule`, `globalThis.crypto` and the bare `crypto` global (use `node:crypto`), `import.meta.dirname`/`filename`, the regex `v` flag, the ES2023+ array and set methods (`toSorted`, `toReversed`, `toSpliced`, `union`, `isSubsetOf`…), named imports Node 18.0 lacks (`fs.glob`, `util.styleText`, `util.parseArgs`, `crypto.hash`, `os.availableParallelism`…), and the modules `node:sqlite`, `node:sea`, `node:test/reporters`.
- `fetch` is used only for the local-mode upstream; Node 18 prints a one-time ExperimentalWarning. The port-in-use probe uses `http.get`.
- Node 18 and 20 cap an AbortSignal at 10 abort listeners and print a MaxListenersExceededWarning past it; Node 24 has no cap. `linkSignals` (`util.ts`) lifts it, with `events.setMaxListeners(0, …)`, on the signal it makes and on its parents, which hold many by design: one per linked operation on the bridge's shutdown signal, two per process on a dns-sd run's signal.

**Version guard**

- `guard.ts` is the first region of the bundle. Because the syntax stays at Node 18 level, an older Node prints the guard's sentence instead of a `SyntaxError`.

**Type checking**

- `_app/tsconfig.helper.json`: ES2022, `types: ["node"]`, `strict` plus `noUncheckedIndexedAccess`, `moduleResolution: bundler`, `noEmit`, `allowJs`/`checkJs` for `build.mjs`. It covers `helper/src`, `helper/test`, `helper/vitest.config.ts` and `helper/build.mjs`.
- Run by `npm run typecheck:helper`, which is part of `verify`.
- `_app/helper/tsconfig.json` only extends it, so editors and ESLint find the helper's settings.

**Publishing**

- `device/agent/device-bridge.mjs` is committed by hand after `npm run helper:build`. `publish.mjs` lists `device/agent` as protected and `required: true`, and never writes it.

### 1.2 Sections, in file order

The **file §** labels number the regions of the built file. Each module's header comment opens with its label, and the built file's table of contents lists them. They are not this document's chapters: `§5 usbmuxd` in `usbmuxd.ts` is file section 5, while §5 of this document is Simulators. Where a module's comment cites a chapter, it is one of this document's.

| File § | Module | Contents | Spec |
| --- | --- | --- | --- |
| §0 | `helper/header.txt` | Header comment: what it does and never does, how to run and stop it, the request pipeline, the source and review links, the table of contents | — |
| — | `guard.ts` | Node version guard | §1.7 |
| §1 | `constants.ts` | Identity, `DEV_ORIGINS`, `LIMITS`, `TIMEOUTS`, `ID`, the allowlists and never-sent lists, `ADB_DETAIL`, `ADB_EXEC`, `EMITTED_BLOCKERS`, `INSTALL` | §1.12, §2.2 |
| §1 | `cli.ts` | Command line: `parseCli()`, help text | §1.9 |
| §2 | `util.ts` | `HelperError(code, status, message, extra)`, `sleep`, `withTimeout`, `createLimiter`, `keyedMutex`, `splitLines` (StringDecoder; strips CR, ANSI and control characters except tab; 8 KiB cap with ` [truncated]`), `clean(str, max)`, `extractPng`, `b64url` | — |
| §3 | `plist.ts` | `buildPlist(value)`, `parsePlist(xml)` (BigInt above 2^53, `<data>` → Buffer, `<date>` → ISO string, `<real>`) | §3.5 |
| §4a | `process.ts` | `runTool`, `streamTool`, `signalTree`, `liveChildren`, `killAll`, `childEnv()` | §1.5 |
| §4b | `tools.ts` | Finding tools: `which()`, `resolveTools()` (Toolbox, 30 s cache), `resolveXcode()`, `resolveSimctl()`, `resolveAdb()`, `resolvePymobiledevice3()`, `resolveJava()`, `resolveBundletool()` | §1.5, §12b |
| §5 | `usbmuxd.ts` | usbmuxd client: frame codec, `request()`, `listDevices()`, `watch()` (Listen + ListDevices, reconnect), `readPairRecord()`, `readBuid()`, `connect(deviceId, port)` | §3.2 |
| §6 | `lockdown.ts` | Lockdown client: u32-BE + plist channel, `queryType`, `getValue`, `startSession` + TLS + pin check, `startService`, `stopSession`, error mapping | §3.3 |
| §7 | `ios-lane.ts` | iOS lane: table keyed by UDID, probe pipeline, `deriveIos`, whitelists, devicectl adapter + `classifyDevicectl`, `idevicescreenshot`, syslog_relay + `idevicesyslog`, Wi‑Fi hold, `probeForDoctor` | §3 |
| §8 | `simulator-lane.ts` | Simulator lane: simctl list/join, screenshot, `log stream`, `SIMCTL_COMMANDS` | §5 |
| §9 | `mdns.ts` | mDNS browser: DNS codec (`parseMessage`, `readName`, `encodeQuery`), `udpTransport()`, `browse()`, `mdnsFailure()`; the system resolver: `systemMdnsTools()`, `systemBrowse()` and the dns-sd/avahi-browse parsers | §4.8 |
| §9 | `android-lane.ts` | Android lane: adb host client, `ADB_HOST_SERVICES` and `assertAdbService`, the Wi‑Fi senders and their checks, discovery (`scanNearby`, `mergeNearby`, `parseAdbMdnsServices`), `parseDevicesL`, `mapAdbState`, identity cache, detail, screencap, logcat, `startAdbServer` | §4 |
| §10 | `registry.ts` | Lane rows → `Snapshot {rev, runId, devices, lanes}`, owner lookup, activity clock, transition lines | §1.3, §2.4 |
| §11 | `auth.ts` | Token (fresh or kept file), `tokenIdOf`, `proofOf`, bearer check, "Page connected" lines | §2.8, §6.5 |
| §12 | `preflight.ts` | Doctor and preflight: `collectPreflight()`, item wording, `formatChecklist()`, `doctorReport()`, `printDoctor()` | §12 |
| §13 | `http.ts` | HTTP API: gate (Host, Origin, Fetch Metadata), CORS, router, JSON and NDJSON writers, endpoints, Wi‑Fi body reader, stream caps, `upgrade` destroy | §2 |
| §14 | `local-mode.ts` | Upstream cache, `bootHtml()`, CSP hashes, asset proxy, redirects | §2.9 |
| §15 | `bridge.ts` | Bridge lifecycle: `createBridge`, `listen`, `close`, health, doctor | §1.6 |
| §15 | `banner.ts` | The start banner and pairing links | §1.10 |
| §15 | `main.ts` | Startup, signals, auto-open, `main`, `isMain`, and the file's exports | §1.7, §1.8 |

**Constants in file §1**

- Identity: `NAME = 'bauloc-device-bridge'`, `VERSION = '1.1.1'`, `PROTOCOL = 1`, `SITE = 'https://bauloc.github.io'`, `DEFAULT_PORT = 8787`, `DOWNLOAD_URL`, `SOURCE_URL`.
- Dev origins: `DEV_ORIGINS` = `http://localhost:7360` and `http://127.0.0.1:7360`, the same for `:4173` and `:8000`.
- Tables: `LIMITS`, `TIMEOUTS`, `ID`, `INSTALL`.
- Allowlists:
  - `LOCKDOWN_REQUESTS = ['QueryType','GetValue','StartSession','StopSession','StartService']`
  - `LOCKDOWN_SERVICES = ['com.apple.syslog_relay']`
  - `MUX_MESSAGES = ['ListDevices','Listen','ReadPairRecord','ReadBUID','Connect']`
  - `DEVICECTL_COMMANDS = [['device','capture','screenshot'], ['device','info','lockState']]` (`lockState` in `--doctor` only)
  - `ADB_EXEC`: the constant strings in §4.3
  - In their lane modules: `ADB_HOST_SERVICES = ['host:version','host:track-devices-l','host:devices-l','host:reconnect-offline','host:mdns:services']` (plus `host:transport:<listed serial>`), and `SIMCTL_COMMANDS`.
- Never-sent lists, each asserted by a test that the client refuses it:
  - Lockdown `LOCKDOWN_NEVER`: `Pair`, `Unpair`, `ValidatePair`, `SetValue`, `RemoveValue`, `EnterRecovery`, `Activate`.
  - usbmuxd `MUX_NEVER`: `SavePairRecord`, `DeletePairRecord`.
  - adb `ADB_HOST_NEVER`: `host:kill`, `host:reconnect`, and `host:connect:`, `host:pair:`, `host:disconnect:`, which only the three Wi‑Fi senders of §4.7 may send, each through its own exact check.
- `EMITTED_BLOCKERS`: every row-blocker code the helper can send.

**Exports of the built file** (for tests, the page's contract test and `helper:fake`): `createBridge`, `NAME`, `VERSION`, `PROTOCOL`, `ID`, `ADB_DETAIL`, `ADB_EXEC`, `EMITTED_BLOCKERS`, `LOCKDOWN_REQUESTS`, `LOCKDOWN_SERVICES`, `tokenIdOf`, `proofOf`, `HelperError`, `parsePlist`, `buildPlist`, `parseDevicesL`, `mapAdbState`, `deriveIos`, `classifyDevicectl`, `splitSyslogRelay`, `which`, `runTool`, `liveChildren`, `bootHtml`, `formatChecklist`. `HelperError` is exported because the bridge maps only its own class to a code: an error built from another copy of the class is an `INTERNAL` bug.

### 1.3 Runtime model

**Lanes**

- `ios` (usbmuxd + lockdown; darwin only).
- `android` (adb host protocol; off with `--no-android`).
- `simulators` (simctl; only with `--simulators`).

**Registry**

- Each lane calls `ctx.publish(laneName, rows, departures?)` with its full row list. `departures` (serial → word) says why a row left, for its terminal line: the Android lane passes `disconnected` for a Wi‑Fi device the tester disconnected (§4.7).
- The registry builds the sorted snapshot. `rev++` when the serialized `devices` or `lanes` change.
- It prints one terminal line per transition (§1.10). A row whose state changes in place prints `~ …`, not a leave and an arrival.

**Push sources, always on (free while idle)**

- The usbmuxd `Listen` socket.
- The adb `host:track-devices-l` socket while a server exists.

**Active** means an authenticated API request arrived in the last 30 s. Timed work while active:

| Work                                                                            | Interval |
| ------------------------------------------------------------------------------- | -------- |
| Simulator list                                                                  | 5 s      |
| `ReadPairRecord` for untrusted iPhones without a record                         | 3 s      |
| Full re-probe of untrusted-with-record, authorizing, locked and offline iPhones | 5 s      |
| adb server presence probe (always, about 1 ms per refused connect)              | 5 s      |

**Concurrency**

- One-shot tools go through a limiter of 4 (`ctx.runTool` is already inside it).
- Probe and detail are single-flight per device.
- Screenshots: one per device (a second request gets 409 `BUSY`).
- Log streams: at most 1 per device (a new one ends the old one with `reason:'replaced'`) and 3 in total (429 `TOO_MANY_STREAMS`).
- Wi‑Fi connect and pair: one per host at a time (a second gets 409 `BUSY`, never queued).
- Lockdown sessions: at most 2 per device.

### 1.4 Lane interface (helper-internal, `types.ts`)

```ts
type LaneName = 'ios' | 'android' | 'simulators'

interface LaneContext {
  publish(lane: LaneName, rows: HelperDevice[], departures?: Record<string, string>): void  // replaces the lane's rows; departures: why a row left (§4.7)
  setLane<K extends LaneName>(lane: K, patch: Partial<Lanes[K]>): void
  tools: { get(): Promise<Toolbox>; refresh(): Promise<Toolbox> }  // §1.5, cached 30 s
  runTool: RunTool                                              // cwd = workDir, childEnv(), already limited (4)
  streamTool: StreamTool
  limit<T>(fn: () => Promise<T>): Promise<T>                    // for one-shot work that is not runTool
  isActive(): boolean
  log(line: string): void                                       // terminal line; never tokens, headers or log text
  timeouts: Timeouts
  workDir: string                                               // 0700, per run
  withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T>   // a private subdirectory, removed afterwards
  signal: AbortSignal                                           // aborts on shutdown
  options: BridgeOptions
  now(): number
  childEnv(extra?: Record<string, string>): NodeJS.ProcessEnv
}

interface Lane<F> {
  name: LaneName
  start(): void                                                 // must not block or throw
  stop(): Promise<void>                                         // closes sockets, aborts work
  rescan(opts?: { signal?: AbortSignal }): Promise<void>        // bounded at 5 s by the bridge
  detail(id: string, signal: AbortSignal): Promise<DetailResponse>
  screenshot(id: string, signal: AbortSignal): Promise<{ png: Buffer; source: ScreenshotSource }>
  logs(id: string, sink: LogSink, signal: AbortSignal): Promise<void>  // resolves when the source ends
  retry(id: string, signal: AbortSignal): Promise<void>         // read-only; bounded at 10 s
  facts(): F                                                    // read-only facts for §12, synchronous
  probeForDoctor?(write: (line: string) => void): Promise<void> // --doctor only
}

interface AndroidLane extends Lane<AndroidLaneFacts> {          // explicit clicks only (§4.5, §4.7)
  startServer(signal: AbortSignal): Promise<void>
  connectNetwork(target: { host: string; port: number }, signal: AbortSignal): Promise<…>
  pairNetwork(target: { host: string; port: number; code: string }, signal: AbortSignal): Promise<…>
  disconnectNetwork(serial: string, signal: AbortSignal): Promise<…>
}

interface LogSink {
  hello(source: LogSource): void           // once, before any line: until then an error is plain JSON
  push(lines: string[]): boolean           // false = back-pressure; await drain()
  drain(): Promise<void>
  notice(text: string): void
}
```

Lanes throw `HelperError`. The HTTP layer (§13 of the file) owns batching, pings, the `end` record, caps and the client-gone signal (`res.on('close')` with `!res.writableFinished` [V]). Each lane factory takes an optional second argument with its cadences or tuning (`IOS_TUNING`, `ANDROID_CADENCE`, `SIMULATOR_CADENCE`), which only tests pass.

### 1.5 Tools: discovery and spawning

**`which(name, {searchPath, extraDirs, reject?})`**

- Searches absolute PATH entries only; `''` and `.` are ignored [V], so a planted `./adb` never runs. Requires `X_OK` and a regular file. `reject` skips a match and keeps looking.
- Extra directories (`extraDirsFor`):
  - Every tool: `/opt/homebrew/bin`, `/usr/local/bin`.
  - adb: also `$ANDROID_HOME/platform-tools`, `$ANDROID_SDK_ROOT/platform-tools`, `~/Library/Android/sdk/platform-tools`.
  - pymobiledevice3 and python3: also `/Library/Frameworks/Python.framework/Versions/Current/bin`, `~/.local/bin`.
- System tools are always called by absolute path, never looked up on PATH: `/usr/bin/xcode-select`, `/usr/libexec/PlistBuddy`, `/usr/libexec/java_home`, `/usr/bin/sw_vers`, `/usr/bin/osascript`.
- Never run `xcrun`, `/usr/bin/python3` or `/usr/bin/java`: they are shims that can open install dialogs [V shims; dialog I]. `isAppleShim()` rejects anything in `/usr/bin` where a real tool is wanted.

**`resolveXcode()`** never runs a wrapper, `xcrun` or `xcodebuild -runFirstLaunch`.

```
devDir   = env.DEVELOPER_DIR (absolute, a directory)  ??  `/usr/bin/xcode-select -p` (2 s, trimmed)  ??  null
selected = devDir ends with ".app/Contents/Developer" && exists(devDir/usr/bin/devicectl)
if !selected:
  apps = readdir(options.applicationsDir='/Applications') matching /^Xcode[^/]*\.app$/ with Contents/Developer/usr/bin/devicectl
  return apps.length ? {state:'not-selected', suggest: 'Xcode.app' if present else highest version} : {state:'not-installed'}
version  = parsePlist(devDir/../version.plist) → CFBundleShortVersionString, ProductBuildVersion        (XML [V])
text     = read(devDir/usr/bin/devicectl, ≤ 64 KiB)
if text starts with "#!":                                               // Xcode 26+ wrapper [V]
  expected = /EXPECTED_VERSION="([^"]+)"/ ; target = /exec "([^"]+)"/   // both required, else state 'needs-first-launch'
  plist    = /PlistBuddy -c "Print :CFBundleVersion" "([^"]+)"/ ?? options.coreDeviceDir+'/Versions/A/Resources/Info.plist'
  current  = `/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" <plist>` (2 s; failure → '')   // binary plist [V]
  if current !== expected → {state:'needs-first-launch', expected, current}                         // exact match, as the wrapper
else target = devDir/usr/bin/devicectl                                 // older Xcode: the binary itself
license  = `<devDir>/usr/bin/xcodebuild -license check` (5 s) exit 0    // informational; never gates
capture  = `<target> device capture screenshot -h` (5 s, env DEVELOPER_DIR=<devDir>)
return {state: capture ? 'ready' : 'no-capture', devDir, version, build, devicectl: target, coreDevice: current, license}
```

As built:

- A pre-15 Xcode that is selected but has no devicectl is `no-capture`, not "not installed".
- A capture `-h` that times out counts as ready; only a non-zero exit turns screenshots off.
- The iOS lane refuses to run any devicectl whose first 64 KiB is a `#!` script mentioning `runFirstLaunch` or `EXPECTED_VERSION`, and treats it as first launch pending: `toolbox.xcode.devicectl` must be the real binary.

**`resolveSimctl()`** works the same way on `<devDir>/usr/bin/simctl`. The rule there is "needs first launch when the current version is empty or older than expected", after removing trailing `.0` and comparing numerically by component, exactly as the wrapper does [V]. It returns the real binary.

**The Toolbox** (`resolveTools`, never rejects) holds Xcode, simctl, adb (path and `adb version`), and the paths of libimobiledevice's tools, pymobiledevice3, Java and bundletool. The slow version checks (pymobiledevice3, Python, Java, bundletool, libimobiledevice) run only for the checklist, so they never delay the banner or the lanes.

**`runTool(file, argv, {timeoutMs, maxBytes, signal, cwd, env})`**

- `spawn(file, argv, {shell:false, detached:true, stdio:['ignore','pipe','pipe'], cwd: <private dir>, env})`.
- Our own timer: SIGTERM to the process group, then SIGKILL after 1.5 s.
- Caps: stdout `LIMITS.text` (8 MiB) or `LIMITS.png` (32 MiB); stderr tail 64 KiB.
- Settles on `'close'`, or 1 s after `'exit'` when a grandchild still holds the pipe [V trap].
- Rejects `ToolError{reason:'not-found'|'spawn-failed'|'timeout'|'aborted'|'too-large'|'exit', code, stdout, stderr}`; the HTTP layer maps it (§2.7).
- Children stay in `liveChildren` until `'close'`. A synchronous `process.on('exit')` SIGKILLs any group still alive.

**`streamTool(file, argv, {signal, cwd, env, onLine, onExit})`** is the same, returning `{pause(), resume(), kill()}`.

**`childEnv(extra)`**

- `process.env` minus `PYMOBILEDEVICE3_UDID`, `PYMOBILEDEVICE3_TUNNEL`, `PYMOBILEDEVICE3_USBMUX` and `ANDROID_SERIAL`.
- Plus `NO_COLOR=1` and `extra` (for example `DEVELOPER_DIR` for devicectl and simctl).

### 1.6 `createBridge(options)`

It has no side effects until `listen()`. Tests replace everything here, so no real tool or socket leaks in.

| Option | Default |
| --- | --- |
| `port` | 8787 (0 in tests) |
| `token`, `keepToken`, `newToken`, `home` | generated / false / false / `os.homedir()` |
| `searchPath`, `extraDirs` | `process.env.PATH` / the §1.5 lists (tests pass `[]`) |
| `platform`, `arch`, `nodeVersion`, `opensslVersion`, `getuid`, `env`, `tmpDir` | `process.*`, `$TMPDIR` |
| `usbmuxdSocket` | `/var/run/usbmuxd` |
| `adbPort` | `ANDROID_ADB_SERVER_PORT` or 5037 |
| `tunneldPort` | 49151 |
| `upstream` | `https://bauloc.github.io` |
| `xcodeSelectPath`, `plistBuddyPath`, `javaHomePath`, `openPath`, `swVersPath` | system paths above |
| `applicationsDir`, `coreDeviceDir`, `coreSimulatorDir`, `systemVersionPlist` | system paths |
| `open`, `wifi`, `simulators`, `android`, `dev`, `verbose` | follow the CLI |
| `local` | **true**, as the CLI. Embedders that serve no page (`helper:fake`, the page's real-helper tests) pass `false`. |
| `timeouts`, `heartbeatMs`, `now`, `log`, `errorLog` | §1.12 / 15000 / `Date.now` / stdout / stderr |
| `lanes`, `resolveTools`, `fetch`, `selfPath` | the real lane factories (null disables one), the real discovery, global `fetch`, this file |
| `mdns`, `dnsSdPath`, `avahiBrowsePath` | the UDP transport / `/usr/bin/dns-sd` / undefined (look up `avahi-browse`); tests: `silentMdns()` and a path in the fake bin directory (§4.8) |

It returns `{ listen(): Promise<{port}>, close(): Promise<void>, port, token, tokenId, runId, registry, lanes, options, health(challenge?), preflight({refresh}), toolbox(), doctor(write) }`.

### 1.7 Startup (`main`)

1. **Node guard** (`guard.ts`, the first code). Major below 18 → print the guard sentence (§1.10) and exit 1.
2. **`parseCli`.** An unknown flag or bad value → exit 64. `--help` and `--version` print and exit 0.
3. **Refuse root.** If `getuid?.() === 0`, print the root sentence and exit 1.
4. **Token.** `randomBytes(32).toString('base64url')` (43 characters). With `--keep-token`, see the file in §1.11; a refused file exits 1.
5. **`createBridge(opts)`.** Terminal lines are held until the banner is out, so the banner always comes first.
6. **`--doctor`.** Collect preflight, run each lane's `probeForDoctor`, print (§1.9), exit 0. No server, no auto-open, no adb start.
7. **`listen(port, '127.0.0.1')`.** On `EADDRINUSE`, run `http.get('http://127.0.0.1:<port>/api/health')` with a 2 s timeout and print one of the two port messages (§1.10). Exit 1. The port is never switched silently: it is part of the local page's origin and of remembered pairings.
8. **Handlers** for SIGINT, SIGTERM and SIGHUP.
9. **Start lanes without awaiting them**, and collect preflight in the background.
10. **Banner (§1.10)** once preflight resolves and the iPhone and simulator lanes have reported, or after 3 s. Anything unfinished prints `checking…`.
11. **Auto-open**, only when `platform === 'darwin'`, `process.stdout.isTTY` and not `--no-open`. The hosted link carries the token, so it is never put in a process's arguments (any user on the Mac can read those with `ps`, even for the moment `/usr/bin/open` would live):
    ```js
    const child = spawn('/usr/bin/osascript', ['-'], {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
    })
    child.stdin.end(`open location ${JSON.stringify(url)}\n`)
    child.unref() // the browser must not become our child or hold our terminal
    ```

### 1.8 Shutdown

**First signal**

1. Print `Stopping… (press Ctrl+C again to force)`.
2. `server.close()`.
3. End every log stream with `{"t":"end","reason":"shutdown"}`; a stream that has not said `hello` yet answers 503 `HELPER_STOPPING`.
4. Close usbmuxd, lockdown, service and adb sockets.
5. `killAll()`: SIGTERM each group, wait at most 1.5 s, then SIGKILL.
6. `closeIdleConnections()`, then `closeAllConnections()` after 100 ms.
7. `rm -rf workDir`.
8. If this run started the adb server, print `The adb server started from Device Lab is still running. Chrome's WebUSB can use Android phones again after: <adb> kill-server`.
9. Exit 0.

**Second signal:** exit 130 at once.

**`process.on('exit')`** (synchronous) SIGKILLs any group still in `liveChildren` and removes `workDir`.

The adb server is never touched: it leads its own process group [V].

### 1.9 CLI

```
node device-bridge.mjs [options]

  --port <n>       Port on 127.0.0.1 (1024–65535, default 8787)
  --no-open        Don't open Device Lab in the browser at start
  --keep-token     Keep one token across restarts (stored 0600); pairs well with
                   "Remember on this computer" on the page
  --new-token      With --keep-token: replace the stored token
  --wifi           Also list iPhones that are only reachable over Wi-Fi
  --simulators     Also list booted iOS Simulators
  --no-android     Never connect to Google's adb server
  --no-local       Don't serve the Device Lab page at http://127.0.0.1:<port>/device/ (Safari needs it)
  --dev            Also allow http://localhost:7360, :4173, :8000 (and 127.0.0.1) for development
  --verbose        One line per request (method, path, status, ms) and per tool run; never headers or tokens
  --doctor         Print the checklist and a read-only probe of each attached device, then exit
  --version        Print the version
  -h, --help       Show this help
```

- **Exit codes:** 0 normal; 1 startup failure (port, root, token file, Node too old); 64 usage; 130 forced.
- **No `--api`, `--host` or `--token`:** no flag can widen exposure or inject a secret.
- The commands the helper prints name the file the way the tester ran it (`node ~/device-bridge.mjs`).

**`--doctor` output**

- First line `bauloc-device-bridge 1.1.1 · doctor`, then the checklist (§12) by group, with a status word ("OK", "Warning", "Needs action", "Not checked"); fixes are printed only for items that are not OK.
- Then per device:
  - **iOS:** the UDID and ProductType (never the device name); usbmuxd entry (connection, DeviceID); pair record yes/no; QueryType; plaintext key count; StartSession result; TLS protocol and cipher; whether the peer certificate equals the pair record's `DeviceCertificate`; session key count; `PasswordProtected`; battery, disk and amfi results; syslog_relay 3 s byte count; `devicectl device info lockState` (only when Xcode is ready).
  - **Android:** server state and the `devices -l` rows, or `Android: no adb server on 127.0.0.1:<port> (the doctor never starts one)`.
- It never prints key material, log text, IMEI or phone numbers.

### 1.10 Printed text

`<T>` is the 43-character token. A port other than 8787 adds `&port=<n>` to both fragments, so a link without `&port` always means 8787: the page reads it that way, never as the port it used last (§6.5).

```
Device Lab helper 1.1.1 · http://127.0.0.1:8787 (this Mac only)

Opening Device Lab in your browser. If nothing opens, use the link for your browser:
  Chrome, Edge, Firefox   https://bauloc.github.io/device/#pair=<T>
  Safari                  http://127.0.0.1:8787/device/#pair=<T>
Or paste this token on the page:  <T>
Fingerprint 4d1566a1 — the page shows the same one once it is paired.

iPhone      ready · screenshots of iOS 17 and newer through Xcode 27.0
Android     adb 36.0.0 · no adb server running, so Android stays with Chrome's WebUSB
Simulators  off (add --simulators to list booted ones)
<one line per blocking or warning item of §12 that is not optional, then its fix indented with "→ ">
Full checklist: node ~/device-bridge.mjs --doctor

Keep this window open while you test. Ctrl+C stops the helper; the token changes on every start.
```

**Line variants**

| Situation | Text |
| --- | --- |
| iPhone, `--no-open` or not a TTY | First line after the header becomes `Open Device Lab with the link for your browser:` |
| iPhone, Xcode missing | `iPhone      ready · screenshots of iOS 17 and newer need Xcode (identifiers and logs work)` |
| iPhone, first launch pending | `iPhone      ready · Xcode must finish setting up before screenshots work: open Xcode once` |
| iPhone, not macOS | `iPhone      unavailable · iPhones need macOS` |
| A lane that has not reported yet | `iPhone      checking…` (and the same for Android and Simulators) |
| Android, server running | `Android     adb 36.0.0 · sharing the running adb server (1 phone)` |
| Android, adb missing | `Android     adb not found · Chrome's WebUSB still works; for Safari or Firefox: brew install --cask android-platform-tools` (no version prefix) |
| Android, `--no-android` | `Android     off (--no-android)` |
| Simulators, on | `Simulators  2 booted` |
| Wi‑Fi, iPhones hidden | `Wi-Fi       1 iPhone seen only over Wi-Fi (add --wifi to list it)`, printed only when `wifiHidden > 0` |
| `--keep-token` | `Or paste this token on the page (kept between runs):  <T>`, and the last line says the token stays the same across restarts |
| `--dev` | Extra line `Dev server              http://localhost:7360/device/#pair=<T>` |

**Transition lines** (local time; never tokens, query strings, headers, pairing codes or log text)

```
08:41:02  Page connected: Chrome on https://bauloc.github.io
08:41:10  + Tester’s iPhone 12 Pro · iOS 27.0 · USB · trusted
08:41:10    Developer Mode is off: screenshots stay off until it is on
08:42:55  - Tester’s iPhone 12 Pro
08:50:12  adb server appeared (protocol 41): sharing it for Android
08:50:13  + Pixel 9 (<serial>) · Android 17 · USB · ready via adb
08:51:40  screenshot 1.4 s (devicectl)
09:02:30  Wi-Fi: connected to 192.168.1.42:5555
09:02:30  + Android device (192.168.1.42:5555) · Android · Wi-Fi · waiting for "Allow debugging?"
09:02:30    Choose Allow on "Allow debugging?" on the device (with the remote on a TV)
09:02:41  ~ Living Room TV (192.168.1.42:5555) · ready via adb
```

- `+` is an arrival, `-` a departure, `~` a row whose state changed in place; an indented line under a row is the advice for a blocker it just gained.
- A newly ready Android device is held back up to 1.5 s while its identity is read, so its one arrival line carries the model name. A device that arrives unauthorized has no identity yet, so it is named after its serial until it is allowed.
- An Android device on the network reads "waiting for "Allow debugging?"" and "not answering over Wi-Fi" instead of the USB wording.
- "Not answering over Wi-Fi" and its advice ("wake it, or connect it again") are for a device the server still lists but can't reach. A device the tester disconnected (`POST /api/android/disconnect`) gets `Wi-Fi: disconnected …` and its departure line, never that wording: the real-device run printed it right after an intentional Disconnect (§9.7), which reads as a fault.
- Wi‑Fi actions print `Wi-Fi: connected to …`, `Wi-Fi: could not connect to …`, `Wi-Fi: paired with …`, `Wi-Fi: disconnected …`; a scan prints `Wi-Fi: 2 Android devices on this network (…)` or `Wi-Fi: could not look for Android devices on the network: …`, only when it changed (§4.8). The pairing code is never printed: the terminal is pasted into bug reports.

**"Page connected"** prints once per (origin, browser family) on the first authorized request. The family is parsed from the User-Agent (Chrome, Edge, Firefox, Safari; `HeadlessChrome` counts as Chrome).

- A dev origin reads `Page connected: Chrome on the dev page http://localhost:7360 (npm run dev)`; `:4173` names `vite preview`, `:8000` names `npm run serve:site`.
- A browser the helper does not recognise reads `A browser`. `Another client` is only for a client that sent no Origin (curl).

**Error texts**

| Situation | Text |
| --- | --- |
| Node too old | `Device Lab helper needs Node 18 or newer (this is v16.20.2). Install the current LTS from https://nodejs.org, then run the same command again.` |
| Running as root | `Don't run the Device Lab helper with sudo; it never needs root. Run it as yourself: node ~/device-bridge.mjs` |
| Port held by our helper | `A Device Lab helper (1.1.1) is already running on port 8787. Use that window, or stop it with Ctrl+C there.` |
| Port held by another program | `Port 8787 is used by another program. Start the helper on another port:` then `  node ~/device-bridge.mjs --port 8788` |
| Token file readable by others | `The token file <path> can be read by other users. Fix it with: chmod 600 '<path>'` |
| Token file is a symlink / not ours | `The token file <path> is a symbolic link or belongs to another user; refusing to use it.` |
| Unknown flag | `Unknown option --foo. Run: node device-bridge.mjs --help` |

### 1.11 Files the helper writes

| Path | What | Lifetime |
| --- | --- | --- |
| `workDir` = `mkdtemp($TMPDIR/device-bridge-)`, mode 0700 | Screenshot files and devicectl JSON, each in its own `mkdtemp` subdirectory used as the child's cwd | Removed in `finally`; the directory at exit |
| `~/Library/Application Support/bauloc-device-bridge/token` (`$XDG_CONFIG_HOME/bauloc-device-bridge/token` off macOS) | Only with `--keep-token` | Persistent |

**Token file rules**

- Directory 0700, file 0600, created with `O_EXCL`.
- Refuse (exit 1) if `lstat` shows a symlink, an owner other than `getuid()`, or any group or other mode bit.
- `--new-token` rewrites it.

The pair record is held only in memory, and only the fields the TLS session needs: `RootPrivateKey`, `EscrowBag` and `WiFiMACAddress` are dropped as it arrives. It is never written, logged or returned.

### 1.12 Limits and timeouts

| Item | Value |
| --- | --- |
| HTTP server | `requestTimeout` 30 s (does not cut streams [V]); `headersTimeout` 10 s; `maxConnections` 64; request body ≤ 1 KiB (413), read only by the Wi‑Fi routes (§4.7) |
| usbmuxd | request 2 s; `Connect` 3 s (USB), 6 s (network); frame cap 4 MiB |
| Lockdown | request 5 s; TLS 5 s; probe total 12 s; detail total 15 s; each domain 3 s; frame cap 4 MiB |
| devicectl | screenshot `--timeout 40` (minimum 5 [V]), hard 45 s; capture `-h` 5 s |
| PlistBuddy / xcode-select / `xcodebuild -license check` | 2 s / 2 s / 5 s |
| libimobiledevice | `ideviceinfo` 8 s per call; `idevicescreenshot` 20 s |
| simctl | list 10 s; screenshot 20 s (only after a `Booted` check) |
| adb | connect 1 s; host request 5 s (2 s in the doctor); `exec:` detail 10 s; screencap 20 s; `start-server` reply poll 8 s |
| adb Wi‑Fi | name lookup 5 s; `host:connect:` 20 s (adb itself waits up to 10 s for the device's handshake, so its answer arrives before our deadline); `host:pair:` 15 s |
| Discovery | mDNS window 2 s (`mdnsWindow`); system resolver: `dns-sd -B` 1.5 s (`systemBrowse`), each `-L`/`-G` 1.5 s (`systemResolve`), the whole run ≤ browse + 2 × resolve (a killed process is not waited for; SIGKILL 250 ms after SIGTERM), 4 resolves at a time with the adb types and lookups first and the name-only types in at most 1, 128 instances per group (adb, names); scan cached 20 s, `?refresh=1` at most every 3 s, one at a time; 64 devices; packets ≤ 9000 bytes, 256 records each (§4.8) |
| Doctor | 5 s per check (pymobiledevice3, bundletool and java 10 s); overall 12 s; unfinished → `unchecked`; report cached 30 s |
| Logs | first byte 10 s, else fallback or `LOGS_UNAVAILABLE`; native silence switch 8 s; lane `hello` within 30 s, else 504; batch ≤ 200 lines, 256 KiB or 100 ms; ping 15 s |
| Output caps | text 8 MiB; PNG 32 MiB; stderr tail 64 KiB; log line 8 KiB; names 200 characters |
| Local mode | upstream 15 s and 16 MiB per file; at most 300 cached files; HTML revalidated every 60 s; `/assets/*` immutable; last good copy reused offline |
| Bounds | rescan 5 s; retry 10 s; banner 3 s; port probe 2 s; tools cache 30 s; active window 30 s |
| Kill grace | 1.5 s |

---

## 2. HTTP protocol v1

### 2.1 Request pipeline (fixed order; every step tested)

1. **Host** must be exactly `127.0.0.1:<port>` or `localhost:<port>` (lower-cased). Otherwise **421** `BAD_HOST`, with no CORS headers.
2. **Origin**, when present, must be exactly one of: `https://bauloc.github.io`, `http://127.0.0.1:<port>`, `http://localhost:<port>`, or the `DEV_ORIGINS` with `--dev`. Otherwise **403** `BAD_ORIGIN`, with no CORS headers. `null`, `http://bauloc.github.io` and look-alikes are refused. A matched origin is echoed in `Access-Control-Allow-Origin`, always with `Vary: Origin`.
3. **Fetch Metadata.** No `Origin` and `Sec-Fetch-Site` of `cross-site` or `same-site` → **403**. The only exception is a top-level navigation (`Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document`) to `/`, `/device`, `/device/` or `/device/index.html`.
4. **Body.** A request body is at most 1 KiB and must come with a `Content-Length`; a larger one, a chunked one or a malformed length → **413** `PAYLOAD_TOO_LARGE` before routing. Only the Wi‑Fi routes read a body (§4.7).
5. **`OPTIONS`** → 204 with:
   - `Access-Control-Allow-Methods: GET, POST, OPTIONS`
   - `Access-Control-Allow-Headers: Authorization, Content-Type` (Authorization is never covered by `*`)
   - `Access-Control-Max-Age: 600`
   - `Access-Control-Allow-Private-Network: true`, only if the request asked for it (Chromium 104–141)
   - No token is required.
6. **`GET /api/health`** is public.
7. **Every other `/api/*`** needs `Authorization: Bearer <token>`.
   - Parsed with `/^Bearer ([A-Za-z0-9_-]{43})$/i`.
   - `timingSafeEqual(sha256(presented), sha256(token))`; fixed 32 bytes, so it never throws.
   - Failure → **401** `UNAUTHORIZED` with `tokenId` in the body and `WWW-Authenticate: Bearer realm="device-bridge"`.
8. **Route.** `upgrade` sockets are destroyed: there is no WebSocket.

**Every `/api/*` response, errors included**

- `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`, `Vary: Origin`.
- `Access-Control-Allow-Origin` (when an allowed Origin was sent).
- `Access-Control-Expose-Headers: X-Screenshot-Source`.
- Errors carry CORS headers too, so the page reads a 401 instead of a bare `TypeError`.

### 2.2 Endpoints

| Method and path | Auth | Answer |
| --- | --- | --- |
| `OPTIONS /api/*` | — | 204 preflight |
| `GET /api/health[?challenge=<22 b64url>]` | none | `Health` (+ `proof` when the challenge is valid) |
| `GET /api/devices` | bearer | `Snapshot`, from memory, no tools run (< 5 ms) |
| `POST /api/rescan` | bearer | `Snapshot` after every lane re-lists (≤ 5 s) |
| `GET /api/devices/:id/detail` | bearer | `DetailResponse` (raw facts; the page formats them) |
| `POST /api/devices/:id/screenshot` | bearer | `200 image/png` (§2.6) |
| `POST /api/devices/:id/retry` | bearer | `{ device: HelperDevice \| null }` after the re-check (≤ 10 s) |
| `GET /api/devices/:id/logs` | bearer | `application/x-ndjson` stream (§2.5) |
| `GET /api/doctor[?refresh=1]` | bearer | `DoctorReport` (§12c); `refresh=1` re-resolves tools. Bearer because paths show the user name. |
| `POST /api/android/start-server` | bearer | `{ android: Lanes['android'] }`, or an error (§4.5) |
| `POST /api/android/connect` `{host, port?}` | bearer | `AndroidConnectResult` (§4.7) |
| `POST /api/android/pair` `{host, port, code}` | bearer | `AndroidPairResult` (§4.7) |
| `POST /api/android/disconnect` `{serial}` | bearer | `AndroidDisconnectResult` (§4.7) |
| `GET /api/android/nearby[?refresh=1]` | bearer | `AndroidNearbyResult` (§4.8) |
| `GET /`, `/device`, `/device/index.html` | Host gate | 302 → `/device/` (query kept) |
| `GET`/`HEAD /device/` | Host gate | Proxied page with boot script and CSP (§2.9) |
| `GET`/`HEAD /assets/<name>.<ext>`, `/device/agent/device-bridge.mjs` | Host gate | Proxied, immutable cache |
| `GET /favicon.ico` | — | 404 (a redirect would trip `img-src` [V]) |
| Any other path | — | 302 → `https://bauloc.github.io<path>`; nothing is read from disk |

With `--no-android`, every `/api/android/*` route answers 409 `ANDROID_OFF`.

**`:id`**

1. The page sends `encodeURIComponent(id)`. The helper decodes it; a malformed escape → 400 `BAD_ID`.
2. It must match a pattern in `ID`. None allows a leading `-`, `/`, `..` or a space:
   ```js
   ios: /^(?:[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}|[0-9a-f]{40})$/
   sim: /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/
   android: /^(?:[A-Za-z0-9][\w.:-]{0,127}|\[[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{0,4}){1,7}(?:%[\w-]{1,32})?\]:\d{1,5})$/
   ```
   The second Android form is a device adb reached over IPv6, `[fe80::1%en0]:5555` (§4.7). The page's `DEVICE_ID` in `helper/protocol.ts` must stay equal to these.
3. It must be in the current snapshot, else 404 `DEVICE_NOT_FOUND`. The owning lane comes from the registry, never from the pattern.

### 2.3 Types (mirrored in `_app/src/features/device/helper/protocol.ts`)

`_app/helper/src/types.ts` is the source of truth; the page mirrors it with hand-written guards. Change both together, and within protocol 1 only ever add.

```ts
type HelperState =
  | 'ready'
  | 'connecting'
  | 'authorizing'
  | 'locked'
  | 'unauthorized'
  | 'untrusted'
  | 'offline'
  | 'recovery'
  | 'unknown' // ⊂ model.ts DeviceState; never held/absent/busy

interface Health {
  name: 'bauloc-device-bridge'
  version: string // semver of this file
  protocol: number // integer major: 1
  features: string[] // optional extras (§2.8)
  port: number // bound port
  tokenId: string // /^[0-9a-f]{8}$/ = sha256hex(utf8(token)).slice(0, 8)
  tokenPersistent: boolean // started with --keep-token
  runId: string // 8 hex, new every start
  startedAt: number // epoch ms
  local: boolean // serves /device/
  platform: string // `${process.platform}-${process.arch}`
  sha256: string // 64 hex of this file as loaded
  proof?: string // base64url HMAC, only for a valid ?challenge= (§2.8)
}

interface Snapshot {
  rev: number
  runId: string
  devices: HelperDevice[]
  lanes: Lanes
}

interface HelperDevice {
  id: string // UDID | simulator UUID | adb serial
  platform: 'ios' | 'android'
  connection: 'usb' | 'network' | 'simulator'
  state: HelperState
  name: string // ≤ 200 chars, control characters stripped; '' allowed
  model: string // marketing name when the helper knows it, else ''
  modelId: string // ProductType | ro.product.device | modelIdentifier
  osVersion: string
  blockers: string[] // codes, most actionable first; all in EMITTED_BLOCKERS
  capabilities: { screenshot: boolean; identifiers: boolean; logs: boolean; install: false }
}

type XcodeState = 'ready' | 'not-installed' | 'not-selected' | 'needs-first-launch' | 'no-capture'
interface Lanes {
  ios: {
    status: 'ok' | 'unavailable' | 'error'
    screenshots: 'devicectl' | 'none'
    xcode: XcodeState
    wifi: boolean
    wifiHidden: number
    reason?: string
  }
  android: {
    status: 'ok' | 'off' | 'stopped' | 'error'
    adb: 'found' | 'missing'
    serverProtocol?: number
    startedByHelper: boolean
    reason?: string
  }
  simulators: { status: 'ok' | 'off' | 'unavailable'; booted: number; reason?: string }
}

interface DetailOutputs {
  getprop: string
  wmSize: string
  wmDensity: string
  battery: string
  df: string
  androidId: string
}

type DetailResponse =
  | {
      platform: 'android'
      kind: 'android'
      serial: string
      connection: 'usb' | 'network' | 'simulator'
      outputs: DetailOutputs
    }
  | { platform: 'ios'; kind: 'ios'; facts: IosFacts }
  | { platform: 'ios'; kind: 'simulator'; facts: SimFacts }

interface IosFacts {
  udid: string
  connection: 'usb' | 'network'
  source: 'lockdown' | 'ideviceinfo' | 'plaintext'
  device: {
    DeviceName?: string
    DeviceClass?: string
    ProductType?: string
    ProductVersion?: string
    BuildVersion?: string
    SerialNumber?: string
    HardwareModel?: string
    ModelNumber?: string
    RegionInfo?: string
    CPUArchitecture?: string
    TimeZone?: string
    UniqueChipID?: string // decimal string (can exceed 2^53)
  }
  battery?: {
    BatteryCurrentCapacity?: number
    BatteryIsCharging?: boolean
    ExternalConnected?: boolean
    FullyCharged?: boolean
  }
  disk?: {
    TotalDiskCapacity?: number
    TotalDataCapacity?: number
    TotalDataAvailable?: number
    AmountDataAvailable?: number
  }
  international?: { Language?: string; Locale?: string }
  developerMode: boolean | null // null below iOS 16 or unreadable
  locked: boolean | null // session PasswordProtected: passcode required right now
  withheld: Array<'battery' | 'disk' | 'international' | 'developerMode'>
}

interface SimFacts {
  udid: string
  name: string
  deviceType: { name: string; modelIdentifier: string }
  runtime: { name: string; version: string; build: string }
  state: 'Booted' | 'Booting'
  dataPathSize?: number
}

type LogMsg =
  | {
      t: 'hello'
      device: string
      source: 'syslog_relay' | 'idevicesyslog' | 'logcat' | 'simctl'
      at: number
    }
  | { t: 'lines'; lines: string[] }
  | { t: 'notice'; text: string }
  | { t: 'ping'; at: number }
  | {
      t: 'end'
      reason: 'eof' | 'device-gone' | 'client-gone' | 'replaced' | 'shutdown' | 'error'
      code?: string
      message?: string
    }

interface ErrorBody {
  error: {
    code: string
    message: string // message: plain English, for codes the page does not know
    tool?: string
    install?: string // TOOL_MISSING
    tokenId?: string // UNAUTHORIZED
    state?: HelperState
    blockers?: string[] // 409s
    reason?: string
    detail?: string // ANDROID_CONNECT_FAILED, ANDROID_PAIR_FAILED (§4.7)
  }
}

// AndroidConnectResult, AndroidPairResult, AndroidDisconnectResult: §4.7.
// DoctorReport and PreflightItem: §12c.
```

### 2.4 Device list contract

- `GET /api/devices` returns the in-memory snapshot.
- `rev` restarts at 1 every run and increases on any change to the serialized `devices` or `lanes`. `runId` identifies the run.
- The page applies a snapshot only when `rev` or `runId` differs from what it holds.
- `POST /api/rescan` re-lists every lane: usbmuxd `ListDevices` resync, adb `host:devices-l`, `simctl list`. It is bounded at 5 s and returns the fresh snapshot. This is what Refresh and the R key mean.

### 2.5 Log stream

`200 application/x-ndjson; charset=utf-8`, chunked, one `LogMsg` per line.

**Order**

1. `hello`.
2. `lines` batches (≤ 200 lines, ≤ 256 KiB, or 100 ms) and `ping` every 15 s.
3. Exactly one `end`, unless the client went away.

**Lines and back-pressure**

- Lines are normalised per source (§3.8, §4.4, §5), capped at 8 KiB, and stripped of ANSI and control characters except tab.
- When `res.write()` returns false, the source is paused (socket or child stdout) until `'drain'`.

**Errors before `hello`** are ordinary JSON errors: 404, 409, 429, 502, 503, 504. A device that left before `hello` is 404 `DEVICE_NOT_FOUND`; a stream replaced before `hello` is 409 `STREAM_REPLACED`; a shutdown is 503 `HELPER_STOPPING`; a lane that never says `hello` within 30 s is 504 `TOOL_TIMEOUT`.

**Ending**

- A client abort (`res 'close'` with `!writableFinished` [V], about 1 ms) destroys the source socket or kills the child's process group.
- A device that leaves ends with `device-gone`.
- A device that drops off mid-stream while still listed (a Wi‑Fi iPhone or Android device whose link went, a phone that stopped answering on its cable) ends with `{t:'end', reason:'device-gone', code:'DEVICE_DROPPED', message}`. The page treats both as a drop to wait out (§7.8), not as a log that simply ended.
- A source that ends on its own ends with `eof`.

### 2.6 Screenshot

```
200 image/png
Content-Length: <n>
Content-Disposition: inline; filename="<id with [^\w.-] replaced by _>.png"
X-Screenshot-Source: devicectl | idevicescreenshot | simctl | adb
```

- The bytes go through `extractPng()`: signature found, cut at the `IEND` chunk; nothing found → 502 `SCREENSHOT_NOT_PNG`.
- A client disconnect aborts the tool.

### 2.7 Errors, and their effect on the device row

The registry is the authority on state. An operation error that reveals a new state updates the row (`rev++`), and the page polls at once after any failed operation.

| Code | HTTP | Raised when | Row effect | Page |
| --- | --- | --- | --- | --- |
| `BAD_HOST` | 421 | Host not allowed | — | never reaches the page |
| `BAD_ORIGIN` | 403 | Origin not allowed, or cross-site without Origin | — | surfaces as `TypeError` (§6.6) |
| `UNAUTHORIZED` | 401 | Bearer missing or wrong (`tokenId` in body) | — | phase `stale` |
| `NOT_FOUND` / `METHOD_NOT_ALLOWED` / `PAYLOAD_TOO_LARGE` / `BAD_ID` | 404 / 405 (`Allow`) / 413 / 400 | Router | — | — |
| `BAD_REQUEST` | 400 | A Wi‑Fi route's body or input is not acceptable (§4.7); a request target that is not origin-form | — | the helper's sentence |
| `DEVICE_NOT_FOUND` | 404 | Id not listed, or gone mid-operation | Row removed | toast |
| `DEVICE_NOT_READY` | 409 (`state`, `blockers`) | Operation on a non-ready row | — | existing wording |
| `DEVICE_DROPPED` | 503 | A listed device dropped off mid-stream (as the `end` record's `code`) | — | log waits and resumes (§7.8) |
| `BUSY` | 409 | A screenshot of that device is in flight; a connect or pairing to that host is in flight | — | toast |
| `TOO_MANY_STREAMS` | 429 | A 4th log stream | — | toast |
| `STREAM_REPLACED` | 409 | A newer stream for the same device replaced this one before `hello` | — | toast ("another tab") |
| `IOS_UNTRUSTED` | 409 | No pair record; `InvalidHostID`, `InvalidConnection` or `UserDeniedPairing`; TLS reset right after `StartSession` | `untrusted` + `IOS_UNTRUSTED` | hint |
| `IOS_LOCKED` | 409 | Session refused with `PasswordProtected` (BFU) | `locked` + `IOS_LOCKED` | hint |
| `IOS_LOCKED` | 409 | One operation refused while AFU-locked (devicectl "device is locked"; `StartService` `PasswordProtected`) | none (stays `ready`) | toast |
| `IOS_DEVELOPER_MODE_OFF` | 409 | amfi false; devicectl "Developer Mode is turned off" | Blocker, `screenshot:false` | hint |
| `IOS_DDI_REQUIRED` | 409 | iOS ≤ 16: `idevicescreenshot` cannot start screenshotr | Sticky blocker until Retry | hint |
| `IOS_UNREACHABLE` | 502 | devicectl 4016 twice; one operation that cannot reach lockdown; a Wi‑Fi iPhone held while away (§3.9) | none; the lane re-probes | toast; logs retry (§7.8) |
| `IOS_LOCKDOWN_FAILED` | 502 | lockdown unreachable 3 times, 1 s apart; the peer certificate is not the pair record's | `offline` + `IOS_LOCKDOWN_FAILED` | hint |
| `XCODE_REQUIRED` / `XCODE_SETUP_REQUIRED` | 503 | No usable devicectl / first launch pending | Blocker, `screenshot:false` | hint |
| `SCREENSHOT_UNSUPPORTED` | 501 | devicectl 1001 and no other lane | — | toast |
| `SCREENSHOT_NOT_PNG` | 502 | PNG check failed | — | existing wording |
| `ANDROID_UNAUTHORIZED` / `ANDROID_OFFLINE` | 409 | adb `FAIL device unauthorized` (or still authorizing) / `device offline` | Tracker is authoritative | hint |
| `ANDROID_OFF` | 409 | An Android route with `--no-android` | — | toast |
| `ANDROID_CONNECT_FAILED` / `ANDROID_PAIR_FAILED` | 502 (`reason`, `detail`) | adb could not connect or pair (§4.7) | — | the Wi‑Fi dialog's wording per `reason` |
| `ADB_SERVER_STOPPED` | 503 | Android operation, or a Wi‑Fi route, with no server | Android rows removed | toast; Start adb server |
| `ADB_START_FAILED` | 502 | No `host:version` within 8 s of `start-server` | — | toast |
| `TOOL_MISSING` | 503 (`tool`, `install`) | Binary not found | Toolbox re-resolved | toast + "Open check" |
| `TOOL_TIMEOUT` | 504 | Our deadline, devicectl `outcome:"timeout"`, or a lane that never said `hello` | — | toast |
| `TOOL_FAILED` | 502 (`message` = last 500 characters of stderr, cleaned) | Non-zero exit, unparsable output, an unexpected adb `FAIL` | — | toast |
| `LOGS_UNAVAILABLE` | 503 | No log lane works | — | toast |
| `HELPER_STOPPING` | 503 | The helper is shutting down | — | toast |
| `UPSTREAM_UNREACHABLE` / `_STATUS` / `_REDIRECT` / `_TOO_LARGE` | 504 / 404 when the upstream says 404, else 502 / 502 / 502 | Local-mode proxy | — | plain error page |
| `INTERNAL` | 500 | Bug (logged to stderr); also a refused send to a device, which no page input can cause | — | toast |

### 2.8 Versioning, `/api/health` and the proof

**Protocol**

- `protocol` is an integer major. The page accepts `DVC_MIN_AGENT (1) ≤ protocol ≤ DVC_MAX_AGENT (1)`.
- Within a major, only additions are allowed: fields, codes, endpoints, `features`.
- The page feature-detects through `features` and per-device `capabilities`. It never compares `version` for behaviour; versions only word the update notices below.

**Version**

- `VERSION` is semver, independent of `protocol`.
- A release that adds a feature (a new `features` entry, endpoint or field) bumps the **minor** version: `android.discover` made 1.0.0 into 1.1.0. A fix alone bumps the **patch**: 1.1.1 is 1.1.0 with discovery safe against hostile mDNS answers (§4.8). The protocol stays 1 while every change is an addition.
- Why: discovery first shipped as 1.0.0, like the helper before it. With both files saying 1.0.0 the page could not say "a newer helper is out", and the tester could not tell which one was running.

**Features in v1** (present only when true):

| Feature | Present when |
| --- | --- |
| `android.start-server` | the Android lane runs (not `--no-android`) |
| `android.connect` | the same: the Wi‑Fi routes of §4.7 exist (since 1.0.0). The page shows its Wi‑Fi dialog's form only to a helper that lists it, and otherwise says the helper is older than this page, with the update command. |
| `android.discover` | the same: `GET /api/android/nearby` exists (§4.8; since 1.1.0). |
| `local` | local mode is on |
| `simulators` | `--simulators` |
| `wifi` | `--wifi` (iPhones over Wi‑Fi) |

Everything else in §2.2 is protocol 1 itself.

**Skew.** The page ships with every deploy while the helper is downloaded once.

- "Helper too old" (protocol) → the download command.
- "Page too old" → "Reload". Pages caches for 600 s.
- **A feature the page would use is missing** (`helper/update.ts` `featureSupport`): running and paired, and the feature not in `features`.
  - Android lane on → `older`. Said where the feature would be, never hidden: "Your helper is older than this page: it can't look for devices on this network yet. Update it: press Ctrl+C in its window, then run:", the download command for the page's port (`downloadCommand(port)`), then "Then reload this page." The feature's words: `android.discover` "look for devices on this network" ("On this network", under the device list and in the Gate's Wi‑Fi part), `android.connect` "connect to devices over Wi‑Fi" (the Wi‑Fi dialog's `wifi.helper` row), `android.start-server` "start Google's adb server" (the Gate's Android card without WebUSB).
  - `lanes.android.status === 'off'` (`--no-android`, which leaves every Android feature out) → `off`: the `--no-android` sentence and how to restart without it, no download.
  - Lanes not read yet (the moment after connecting) → `unknown`: nothing is said until they are.

**Update row, chip and notice**

- Once the helper is connected (once per running helper, keyed by `health.sha256`), and again on the Environment check's Recheck, the page fetches `/device/agent/device-bridge.mjs` (proxied in local mode) with no credentials and no referrer, 10 s at most.
- It reads the version with `/^const VERSION = "([^"]+)";$/m` (the bundler's spelling) and computes the file's SHA-256.
- It compares both with `health.version` and `health.sha256`: the Environment check's `helper.update` row (§12b).
- `helperUpdate()` (`helper/update.ts`) says "update available" on the header chip and the notice strip (§6.8) when the published file is a higher version, or the same version with another SHA-256 (a rebuilt 1.0.0, as when discovery shipped). Never when the running helper is the higher version (built ahead of a deploy), nor when the file couldn't be read.

**Proof of possession (bound to the port)**

- The page sends `GET /api/health?challenge=<c>`, where `c` is 16 random bytes in base64url (`/^[A-Za-z0-9_-]{22}$/`).
- The helper answers:
  ```
  proof = base64url(HMAC-SHA256(key = utf8(token), msg = "bauloc-device-bridge proof v1|" + boundPort + "|" + c))
  ```
- The page computes the same HMAC with `crypto.subtle` using the port it is talking to. It **sends no token until `tokenIdOf(token) === health.tokenId` and the proof matches**.
- A squatter on another port that relays the challenge to the real helper gets an HMAC over the real port, so the check fails.
- `health` itself exposes no device data and no token. It is CORS-readable only by allowed origins.

### 2.9 Local mode routes

**Upstream fetch**

- The upstream is fixed to `https://bauloc.github.io`, fetched with a 15 s timeout and a 16 MiB cap; at most 300 files are kept in memory.
- An off-site redirect → 502 `UPSTREAM_REDIRECT`.
- An upstream error keeps its status: a file that is not published yet is 404 `UPSTREAM_STATUS`.
- `content-encoding` and `content-length` are never copied: `fetch` has already decoded the body [V].

**`/device/`**

- The HTML is revalidated by ETag every 60 s; the last good copy is reused offline.
- This is inserted before the first `<script` (the theme script), with `<` escaped as `<`, and **no token**:
  ```html
  <script>
    window.DVC_BOOT = {
      mode: 'local',
      apiBase: 'http://127.0.0.1:8787',
      protocol: 1,
      version: '1.1.1',
    }
  </script>
  ```
- `apiBase` is built from the allowlisted Host, so a page opened as `localhost` stays same-origin.
- Response headers:
  ```
  Content-Type: text/html; charset=utf-8
  Cache-Control: no-store
  Content-Security-Policy: default-src 'self'; script-src 'self' <'sha256-…' for EVERY inline script>; style-src 'self' 'unsafe-inline';
    img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  ```
- Inline scripts are found with `/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi`, so a future inline module script cannot silently break local mode.
- No `<base href>`: it breaks `pushState`.

**Assets**

- Paths match `/^\/(?:assets\/[\w.-]{1,120}\.(?:js|css|woff2?|png|jpe?g|svg|webp|ico|pdf)|device\/agent\/device-bridge\.mjs)$/`.
- Headers: `Cache-Control: public, max-age=31536000, immutable`, plus `Content-Security-Policy: sandbox; default-src 'none'`.
- Browsers ignore a subresource's CSP for scripts, styles, fonts and images. The sandbox only stops a top-level navigation to an asset (an SVG above all) from running script on the helper's origin [D]. The local-mode browser check (§9.4) asserts zero CSP violations.
- `helper:fake --local-from <origin>` serves local mode from another origin (a dev build), because the real helper only ever fetches the published site.

---

## 3. iOS

### 3.1 Lanes by capability and iOS range

| Capability | iOS 15–16 | iOS 17.0–17.3 | iOS 17.4–27 |
| --- | --- | --- | --- |
| List, hot-plug, connection type | usbmuxd `Listen` + `ListDevices` (native) [V] | same | same [V] |
| Identity before Trust | lockdown `GetValue` without a session (native) | same | same [V: 8 keys over Wi‑Fi, 26 over USB] |
| Trust | `ReadPairRecord` + `StartSession` + TLS outcome | same | same [V] |
| Identifiers, battery, storage, locale | lockdown session (native TLS); fallback `ideviceinfo -x` | same | same [V] |
| Developer Mode | 15: n/a (`null`); 16: amfi `DeveloperModeStatus` | amfi | amfi [V explicit key] |
| Lock | BFU: `StartSession` `PasswordProtected` [I]; AFU: session `PasswordProtected` [V on 27] | same (+ devicectl `lockState` in `--doctor`) | same |
| Screenshot | devicectl if it works for the device [I], else `idevicescreenshot` with a DDI already mounted (best effort) | devicectl [V sim / I device] | devicectl [V on the device, P0-5] |
| Screenshot, later phase | DDI mount from the helper's cache (§3.12) | root tunnel `--tunnel` (USB-NCM; pymobiledevice3 SIGSTOPs `remoted` [S]) | root tunnel (CoreDeviceProxy) |
| Logs | syslog_relay (native); fallback `idevicesyslog` | same | same [V on 27, USB and Wi‑Fi] |

Ranges matter only for the later-phase lanes and for the amfi read (≥ 16). Screenshots are feature-detected, not version-gated: devicectl is tried first whenever `xcode.state === 'ready'`.

### 3.2 usbmuxd client

**Frame:** a 16-byte little-endian header `{u32 total length (header included), u32 version 1, u32 message 8 (plist), u32 tag}`, then an XML plist [V].

- Every request carries `ClientVersionString: 'bauloc-device-bridge 1.1.1'`, `ProgName: 'device-bridge'` and `kLibUSBMuxVersion: 3`. Without `kLibUSBMuxVersion: 3`, `Listen` never pushes network devices [V].
- One connection per request; `Listen` keeps its own. `connect()` hands the socket back paused.

| Message | Reply | Use |
| --- | --- | --- |
| `ListDevices` | `{DeviceList:[{DeviceID, Properties:{ConnectionType:'USB'\|'Network', SerialNumber:<UDID>, …}}]}` | Initial sync; resync after every successful `Listen`; rescan |
| `Listen` | `Result 0`, then pushed `Attached {DeviceID, Properties}`, `Detached {DeviceID}`, `Paired {DeviceID}` | Hot-plug. Whether it replays already-attached devices is [I], so a `ListDevices` is always merged in. `Detached` can arrive for a `DeviceID` never reported attached [V]. |
| `ReadPairRecord {PairRecordID: UDID}` | `{PairRecordData: <data, XML plist>}` or `Result 2` | Trust; TLS material (kept in memory) |
| `ReadBUID` | `{BUID}` | Doctor reachability |
| `Connect {DeviceID, PortNumber: htons(port)}` | `Result 0`, then the socket is a raw pipe | lockdown (62078 → `32498`) and service ports |

**Rules**

- Rows are keyed by UDID, because `DeviceID` changes on every attach [V].
- A UDID with both USB and Network entries uses the USB `DeviceID` and reports `connection:'usb'`. A USB detach leaves only its Wi‑Fi presence, if any.
- Network-only entries are counted in `lanes.ios.wifiHidden` unless `--wifi` (§3.9).
- `Detached` of a USB entry removes the row at once. It aborts the device's probe and its log streams end with `device-gone`.
- Devices are listed only when `DeviceClass` (or `ProductType`) starts with `iPhone`, `iPad` or `iPod`.

**Reconnect.** When the Listen socket closes, retry after 1, 2, 4, 8, then every 10 s, and resync. Meanwhile `lanes.ios.status = 'error'`; iOS rows are kept 10 s, then dropped.

### 3.3 Lockdown client and TLS

**Framing**

- u32 big-endian length, then an XML plist [V].
- Requests carry `Label: 'device-bridge'`. Only names in `LOCKDOWN_REQUESTS` can be sent; `send()` throws before writing anything else (tested).
- A request that times out closes the channel, so a late reply can never be read as the next answer.
- `LockdownError.code` is lockdown's raw error string, or `timeout`, `closed`, `protocol`, `tls-reset`, `tls-failed`.

**TLS** (session, and services with `EnableServiceSSL`):

```js
let sock
try {
  sock = tls.connect({
    socket: raw, // the usbmuxd pipe
    cert: rec.HostCertificate, // PEM Buffer, in memory only
    key: rec.HostPrivateKey, // PEM PKCS#8
    rejectUnauthorized: false, // the device certificate is self-issued: pinned below instead
    ciphers: 'DEFAULT:@SECLEVEL=0', // SHA-1 certificates on any OpenSSL 3.x build (§0.2)
    minVersion: 'TLSv1.2',
    secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT, // older lockdownd, as pymobiledevice3 [S]
  })
} catch (e) {
  /* synchronous ERR_SSL_* → TLS-failed path (§3.4 step 6) */
}
```

- With these options the real iPhone negotiates TLS 1.2 `ECDHE-RSA-AES256-GCM-SHA384` [V].
- **Pinning (G25, enforced).** After `secureConnect`, the client compares `sock.getPeerCertificate(true).raw` with the DER of `rec.DeviceCertificate` (`peerMatches`). A session whose peer is not the pair record's device is ended (`LockdownError('tls-pin')`, raised by the shared `startTls`): the row goes `offline` with `IOS_LOCKDOWN_FAILED` (reason `tls:pin`) and its cached detail is dropped, the log notes it once ("(refused)"), and `--doctor` prints the comparison. This holds for every session the helper opens, the probe's, a detail's and a log's, and for a service's TLS: a detail or a log answers 502 `IOS_LOCKDOWN_FAILED`, and a log never falls back to `idevicesyslog` past a refused certificate. The row is `ready` again once a probe sees the paired certificate. P0-6 showed the iPhone presents exactly that certificate (§9.5). `IOS_TUNING.enforcePinning` exists only so tests can exercise the comparison both ways.

**Services.** `StartService {Service}` → `{Port, EnableServiceSSL}` or `Error`:

- `PasswordProtected` → `IOS_LOCKED` for that operation.
- `InvalidService` → next lane.

Then usbmuxd `Connect` to `htons(Port)`, TLS if asked, then `StopSession` and close the lockdown socket. The service keeps running on its own connection (P0-3 [V]).

### 3.4 Probe pipeline and trust

**Probe** (single-flight per UDID, its own `AbortController`, 12 s total). It runs on `Attached` (USB at once; Wi‑Fi after 2 s stable), `Paired`, Retry, rescan, a trust or lock error from an operation, and the cadences below.

| Step | Deadline | Outcome |
| --- | --- | --- |
| 1. usbmuxd `Connect` 62078 | 3 s USB / 6 s network | Refused or timeout three probes in a row (1 s apart) → `offline` + `IOS_LOCKDOWN_FAILED` |
| 2. `QueryType` | 5 s | Not `com.apple.mobile.lockdown` → `unknown` |
| 3. `GetValue` (no session) | 5 s | Plaintext facts, pre-session whitelist (§3.5) |
| 4. `ReadPairRecord` | 2 s | `Result 2` → `untrusted` (`reason: 'pair-record:none'`), stop |
| 5. `StartSession {HostID, SystemBUID}` from the record | 5 s | `InvalidHostID` / `InvalidConnection` / `UserDeniedPairing` → `untrusted`; `PasswordProtected` → `locked` [I]; `PairingDialogResponsePending` → `authorizing` |
| 6. TLS (when `EnableSessionSSL`) | 5 s | Reset or EOF right after a successful `StartSession` → `untrusted` (`tls:reset`). Peer certificate not the record's → `offline` (`tls:pin`). Any other failure (including a synchronous throw) → TLS-failed path, below. |
| 7. Session `GetValue` (all) | 5 s | Whitelisted; `PasswordProtected` → `locked` field |
| 8. amfi `GetValue {Domain:'com.apple.security.mac.amfi', Key:'DeveloperModeStatus'}` (iOS ≥ 16) | 3 s | `true`/`false`; an error → `null` |
| 9. `StopSession`, close | — | Derive the row (§3.10) |

**As built**

- A new device is listed as `connecting` only if its first probe takes longer than 750 ms, so a fast probe prints one clean arrival line.
- A single operation that cannot reach lockdown answers 502 `IOS_UNREACHABLE` and re-probes; the three-strikes `offline` rule lives in the probe.
- For a Wi‑Fi target, a probe result that only says the link was cut (any `offline`, or `tls:reset`) never downgrades a row that is `ready`: the row stays ready and is probed again. Only the phone's own answers (`InvalidHostID`, `PasswordProtected`, a pending Trust dialog, no pair record, a pin mismatch) change it, whether usbmuxd's `Detached` arrives before or after the probe's result (`linkCut()`).

**TLS-failed path**

- If a pair record exists and `ideviceinfo` is installed: `ideviceinfo -u <udid> [-n] -x` (8 s) → `source: 'ideviceinfo'`. Exit 255 with `Invalid HostID (-21)` → `untrusted`; `Password protected (-17)` → `locked`; `not found` → gone. Developer Mode comes from `-q com.apple.security.mac.amfi -k DeveloperModeStatus`.
- Otherwise: `source: 'plaintext'`, blocker `TOOL_MISSING`, and the iOS lane's `facts().tlsFailures` gets `{node, openssl, code}` for preflight item `ios.session`.
- **`ideviceinfo` never runs without a pair record:** its handshake would show the Trust dialog [I].

**Cadences while active**

- **Untrusted, no record:** `ReadPairRecord` every 3 s (1–5 ms [V]); a record appearing triggers a full probe.
- **Untrusted with a record (revoked), authorizing, locked, or offline:** full probe every 5 s. Offline rows are included so a phone that attached while booting does not stay offline until Retry.
- **Ready:** no periodic probe. Trust revocation surfaces on the next operation (§2.7).

**The helper never initiates pairing.** Plugging an unlocked, untrusted iPhone into a Mac normally makes the phone ask "Trust This Computer?" [I, P0-8]. The pinned `IOS_UNTRUSTED` copy says what to do, and the preflight per-device item adds the Finder fallback (§12).

### 3.5 Identity and detail (whitelists)

**Pre-session read (step 3).** Kept: `DeviceName`, `DeviceClass`, `ProductType`, `ProductVersion`, `BuildVersion`, `HardwareModel`, `CPUArchitecture`. Everything else is dropped, including `UniqueDeviceID` (already the id), `WiFiAddress`, `BasebandSerialNumber` and `DieID` [V present over USB].

**Session default domain.** Kept: `DeviceName`, `DeviceClass`, `ProductType`, `ProductVersion`, `BuildVersion`, `SerialNumber`, `HardwareModel`, `ModelNumber`, `RegionInfo`, `CPUArchitecture`, `TimeZone`, `UniqueChipID` (→ decimal string), `PasswordProtected` (→ `locked`).

**Domains** (detail only, 3 s each; `PasswordProtected`, `GetProhibited` or `MissingValue` → added to `withheld`):

| Domain | Keys kept |
| --- | --- |
| `com.apple.mobile.battery` | `BatteryCurrentCapacity`, `BatteryIsCharging`, `ExternalConnected`, `FullyCharged` [V keys] |
| `com.apple.disk_usage` | `TotalDiskCapacity`, `TotalDataCapacity`, `TotalDataAvailable`, `AmountDataAvailable` (`NANDInfo` dropped) [V keys] |
| `com.apple.international` | `Language`, `Locale` [V keys] |
| amfi | `DeveloperModeStatus` (explicit key required [V]) |

**Never read out of a reply:** IMEI and variants, MEID, `PhoneNumber`, ICCID / `IntegratedCircuitCardIdentity`, IMSI, `WiFiAddress`, `BluetoothAddress`, `EthernetAddress`, `DevicePublicKey`, `EscrowBag`, `NonVolatileRAM`, `BasebandSerialNumber`, `DieID`, any key not listed.

**Storage figures** [V on the iPhone 12 Pro, 2026-10-04]. None of `com.apple.disk_usage`'s keys is the "Available" that Settings → General → About shows. On the test phone, Settings said 74.41 GB available, while:

- `AmountDataAvailable` was 40.30 GB: free right now;
- `TotalDataAvailable` was 161.04 GB: free plus what iOS can purge when it needs room (caches, offloadable data).

Settings' figure lies between the two, counting only part of the purgeable space [I]; no lockdown key carries it. So the detail never shows `TotalDataAvailable` alone as "Available" (it read 161 GB that day, more than twice Settings' figure): each figure is labelled as what it is, `AmountDataAvailable` first (§7.6).

**Integers:** `parsePlist` keeps exact BigInts; whitelisting converts identifiers to decimal strings. `sendJson` uses a replacer that turns any stray BigInt into a string (P10).

**Detail request:** a fresh session reads the default domain, the three domains and amfi, and is cached 5 s. The TLS-failed path uses `ideviceinfo -u <udid> [-n] -q <domain> -x` per domain. On the real iPhone over Wi‑Fi a detail takes 0.4–0.5 s, then 1 ms from the cache [V].

**Row fields**

- `name` = `DeviceName`, else `''`; the page falls back to the model.
- `model` = `''`; the page maps `modelId` (§7.6).
- `modelId` = `ProductType`.
- `osVersion` = `ProductVersion`.

### 3.6 Lock state and Developer Mode

**Lock**

- `locked` + `IOS_LOCKED` only when the session itself is refused with `PasswordProtected`, i.e. before first unlock [I; P0-4].
- After first unlock a passcode-locked iPhone stays `ready`. Identifiers, battery, storage, syslog and devicectl screenshots all worked while locked [V]. The detail shows `Lock: Locked`.
- "Worked" for screenshots means devicectl returns a PNG: with the phone locked and its screen off, that PNG is entirely black, with no error and no hint in the envelope [V on USB]. §3.7 says how Device Lab handles it.
- An operation refused by the lock (devicectl "The operation failed since the device is locked." [S]) returns 409 `IOS_LOCKED` without changing the row.
- `devicectl device info lockState --device <udid> --timeout 8 --json-output <file>` (`{deviceIdentifier, passcodeRequired, unlockedSinceBoot}` [V]) runs only in `--doctor`, and only when Xcode is ready.

**Developer Mode**

- iOS ≥ 16: amfi value. `false` → blocker `IOS_DEVELOPER_MODE_OFF` and `capabilities.screenshot = false`; identifiers and logs are unaffected.
- iOS 15: `null`, no blocker.
- The helper never automates `amfi enable-developer-mode`: it reboots the phone and fails while a passcode is set [S].

### 3.7 Screenshots

**Each lane**

- Writes into its own `mkdtemp` directory, which is also the child's cwd.
- Checks the PNG with `extractPng`.
- Removes the directory in `finally`.

**1. devicectl** (when `xcode.state === 'ready'` and `developerMode !== false`)

```
<real devicectl> device capture screenshot --device <UDID> --destination <dir>/shot.png --timeout 40 --json-output <dir>/out.json
env: DEVELOPER_DIR=<devDir>; our hard limit 45 s
```

- Success: `out.json` `info.outcome === 'success'` and a valid PNG. Read the file after exit; stdout is ignored and capped.
- `classifyDevicectl(envelope, exitCode)`; `userInfo` values are wrapped as `{string}` / `{array}` [V]:

| Signal | Result |
| --- | --- |
| ENOENT / exit 72 | `XCODE_REQUIRED` (toolbox refresh) |
| `outcome:"timeout"` or exit 2 | `TOOL_TIMEOUT` |
| `error.code 1000` | `DEVICE_NOT_FOUND`; the row stays, because usbmuxd decides presence |
| `error.code 1001` (capturescreenshot) | Mark devicectl unsupported for this device this run → next lane, else `SCREENSHOT_UNSUPPORTED` |
| `NSLocalizedDescription` matches `/locked/i` | `IOS_LOCKED` (row unchanged) |
| matches `/Developer Mode/i` | `IOS_DEVELOPER_MODE_OFF` (blocker added) |
| `error.code 4016` | retry once after 2 s; then `IOS_UNREACHABLE` |
| exit 64 (usage) | `xcode.state = 'no-capture'` → `XCODE_REQUIRED` |
| anything else | `TOOL_FAILED` (`message` = description) |

- On the real iPhone over Wi‑Fi the first capture takes 2.2–2.9 s and later ones 0.7–1.0 s (1170×2532 PNG) [V]; over USB, 0.4–0.5 s each [V]. The page toasts after 4 s (§6.8). One first capture failed after 18 s and the next one worked.
- **Locked, screen off.** devicectl reports `success` and writes a valid PNG that is all black [V on USB, 2026-10-04]. Nothing in the envelope, the exit code or the PNG's size tells it apart, so `classifyDevicectl` can't. The row already knows the lock (session `PasswordProtected`, §3.6): a capture taken while the row says locked, or one whose pixels are all black, is still returned, and Device Lab says why next to it, in one plain sentence with the fix (the iPhone is locked or its screen is off: unlock it and take another), instead of showing a black image with no hint. As built (`black-shot.ts`): the page samples the PNG at 96 px at most and calls it black when every channel is 12/255 or less; it keeps the image, marks the thumbnail "All black." with "The screen was off or locked: wake and unlock the device, then take it again.", adds ", all black" to its alt text, and shows the same sentence as a warning toast. It goes by pixels only, so it works for every lane, Android included.

**2. `idevicescreenshot`** (iOS ≤ 16, or after devicectl 1001 on ≤ 16; only when installed)

```
idevicescreenshot -u <UDID> [-n] <dir>/shot.png        (20 s)
```

- Output mentioning `screenshotr` → `IOS_DDI_REQUIRED`, a sticky blocker until Retry [I exact text].

**3. Nothing applies**

- iOS ≥ 17: `XCODE_SETUP_REQUIRED` when the state is `needs-first-launch`, else `XCODE_REQUIRED`.
- iOS ≤ 16: `TOOL_MISSING` (`tool:'idevicescreenshot'`, `install:'brew install libimobiledevice'`).

`capabilities.screenshot` = (devicectl ready, or (≤ 16 and `idevicescreenshot` installed)) and `developerMode !== false` and the state is `ready`.

### 3.8 Logs

**1. Native syslog_relay** [V on 27 over USB and Wi‑Fi]

1. A dedicated session, then `StartService {Service:'com.apple.syslog_relay'}`.
2. Connect the port; TLS if `EnableServiceSSL`; `StopSession`.
3. Read with `splitSyslogRelay`:
   - split on `\0`;
   - drop each message's trailing `\n`;
   - split inner newlines (1.3 % of messages [V]) into continuation lines;
   - clean each line and cap it at 8 KiB.
4. Line shape: `Oct  4 08:19:52 Testers-iPhone locationd[27551] <Notice>: …`.
5. `hello.source = 'syslog_relay'`. There is no history: the relay starts at "now".

**2. Fallback `idevicesyslog -u <UDID> --no-colors -x [-n]`**

- Used when `StartService` fails, when native TLS failed, or when no byte arrives in the first 8 s and `idevicesyslog` is installed. The switch sends `{t:'notice', text:'Switched to idevicesyslog'}`.
- It uses its own TLS stack and service (os_trace by default [V help]).
- `[connected:…]` → notice; `[disconnected:…]` → `end device-gone`; `*** Device is passcode protected…` passes through as a line.

**3. Nothing works** → 503 `LOGS_UNAVAILABLE`.

**Ending**

- `device-gone` when the UDID was detached.
- `device-gone` with `code: 'DEVICE_DROPPED'` ("The iPhone dropped off Wi-Fi.") when a Wi‑Fi link went while the row is held (§3.9).
- Otherwise `eof`.

**Volume.** About 145 lines/s from an idle iPhone over Wi‑Fi through the built helper, 70–130 lines/s over USB, 169–468 messages/s in the research; the first lines arrive 0.25–0.5 s after the request [V]. The page keeps the last 2,000 lines (R5).

**Logs over Wi‑Fi** work [V] and are allowed with `--wifi`.

### 3.9 iPhones seen only over Wi‑Fi (`--wifi`)

- **Off by default.** usbmuxd lists an iPhone on Wi‑Fi in short stretches, each under a new `DeviceID` [V].
- **Measured** (an iPhone 12 Pro on iOS 27, 15 minutes of read-only `Listen`, 2026-10-04): present 1–133 s at a time, away 6–90 s between, once 289 s. About half of the absences were longer than 30 s [V].
- **With `--wifi`:**
  - A Network-only entry is listed as `connection:'network'` once it has stayed 2 s (`wifiStableMs`), using the same lanes as USB.
  - A row already listed is back the moment usbmuxd re-adds it: the 2 s are for a phone first seen, not for each return (otherwise every return hid the row for 2 s).
  - After `Detached` the row is **held 120 s** (`wifiHoldMs`; 30 s in the design, which dropped the row in about half of the measured gaps). While held it stays `ready`; detail and new logs answer 502 `IOS_UNREACHABLE` ("The iPhone dropped off Wi-Fi for now. It usually comes back within a minute; a cable keeps it steady.") at once, and the page retries (§7.8).
  - A cut link never downgrades a ready row (§3.4).
- devicectl over Wi‑Fi is slow (`lockState` 3.3 s, details timed out at 15 s [V]). Screenshots are attempted and errors map as in §3.7; over Wi‑Fi they worked in 2.2–3.0 s [V].

### 3.10 `deriveIos(entry, tools)`

The first matching row wins. `tools` (Xcode state, libimobiledevice) decides whether a ready row can take screenshots and which blocker says why.

| # | Facts | `state` | `blockers` (in order) | screenshot / identifiers / logs |
| --- | --- | --- | --- | --- |
| 1 | Probe running for more than 750 ms, nothing known | `connecting` | — | no / no / no |
| 2 | No pair record | `untrusted` | `IOS_UNTRUSTED` | no / no / no |
| 3 | `InvalidHostID` / `InvalidConnection` / `UserDeniedPairing` / TLS reset after `StartSession` | `untrusted` | `IOS_UNTRUSTED` | no / no / no |
| 4 | `PairingDialogResponsePending` | `authorizing` | `IOS_UNTRUSTED` | no / no / no |
| 5 | Session refused `PasswordProtected` | `locked` | `IOS_LOCKED` | no / no / no |
| 6 | Lockdown unreachable on 3 probes, or the peer certificate is not the pair record's | `offline` | `IOS_LOCKDOWN_FAILED` | no / no / no |
| 7 | `QueryType` is not lockdown | `unknown` | — | no / no / no |
| 8 | Session OK, or `ideviceinfo` fallback OK | `ready` | `IOS_DEVELOPER_MODE_OFF`? → `XCODE_SETUP_REQUIRED` / `XCODE_REQUIRED` / `IOS_DDI_REQUIRED` / `TOOL_MISSING`? | per §3.7 / yes / yes (`idevicesyslog` when native TLS failed) |
| 9 | Plaintext only (TLS failed, no fallback) | `ready` | `TOOL_MISSING`, then the screenshot gap | per §3.7 / yes (partial) / no |

### 3.11 What the helper never does on iOS

- Pair, unpair, `ValidatePair`, `SetValue` or `RemoveValue`.
- Run an auto-pairing tool on an untrusted device.
- Toggle Developer Mode.
- Mount or download a DDI.
- Start a tunnel, or run `sudo`.
- Run `log collect` (it needs root [V]).
- Return the pair record or a non-whitelisted key.

### 3.12 Later-phase lanes (specified, not built in v1)

**Root tunnel screenshots (v1.1; P0-5 passed, so not needed in v1)**

- Detect: `GET http://127.0.0.1:49151/hello` → `{"message":"Hello, I'm alive"}` within 500 ms, and `GET /` lists the UDID [S].
- Run `<abs pymobiledevice3> developer dvt screenshot --tunnel <UDID> <dir>/shot.png` with a 30 s limit, environment minus `PYMOBILEDEVICE3_*`, and `TMPDIR=<private dir>`. Success means a PNG file; the exit code is unreliable [V].
- Blocker `TUNNEL_REQUIRED` only for iOS ≥ 17 with Xcode not ready and pymobiledevice3 installed. Its copy then changes as a documented parity divergence:
  - body: "Without Xcode, iOS 17 and newer take screenshots through a tunnel that runs as root. Start it in its own Terminal window and leave it open; Ctrl+C there stops it."
  - fixes: `[Open check]`. The Doctor shows `sudo <absolute path>/pymobiledevice3 remote tunneld`, because sudo resets PATH, and never `-d`.

**DDI mounting for iOS 15–16**

- Cache the image in `~/Library/Caches/bauloc-device-bridge/ddi/<ver>/`, through pymobiledevice3's `auto_mount_developer(lockdown, xcode=<cache>)` [S signature], so nothing is written into Xcode.app.
- An explicit button only.

**Native `os_trace_relay`** (richer level, subsystem, category)

- Request (XML): `{Request:'StartActivity', MessageFilter:65535, Pid:-1, StreamFlags:60}`.
- Reply: u32 LE `n`, then `n` bytes forming a **little-endian** length `L`, then `L` bytes of plist containing `RequestSuccessful`.
- Then frames: `0x02`, u32 LE `len` (≤ 1 MiB), entry.
- Entry offsets: `pid` u32le @9 · `seconds` @55 · `usec` @63 · `level` u8 @68 (0 Notice, 1 Info, 2 Debug, 3 User Action, 0x10 Error, 0x11 Fault) · `imageNameSize` u16le @107 · `messageSize` u16le @109 · `senderImageOffset` @113 · `subsystemSize` @117 · `categorySize` @121 · filename C string @129, then image name, message, subsystem and category [S pymobiledevice3 9.8.1].
- Self-check: more than 5 bad entries in the first 50 → back to syslog_relay.

**"Ask the iPhone to trust this Mac"**

- A labelled button, user click only, never folded into Retry.
- `devicectl manage pair --device <udid>` (Xcode) or `idevicepair -u <udid> pair` (returns at once; then wait for `Paired`).

**CoreDevice-only Wi‑Fi devices** (not in usbmuxd) and the helper-side log filter `?process=`.

---

## 4. Android via the adb server

### 4.1 Policy

- **Attach only.** Connect to `127.0.0.1:${ANDROID_ADB_SERVER_PORT || 5037}` and send `host:version`.
  - `ECONNREFUSED` → `lanes.android.status = 'stopped'`; re-check every 5 s (a refused connect costs about 1 ms).
  - Something on the port that is not adb → `status: 'error'` with a reason.
  - The adb CLI is never used for device operations: the CLI starts a server when none runs, which takes every phone from Chrome's WebUSB, and it kills a server of a different version. The only adb command the helper runs without a click is `adb version`, which starts nothing [V].
- **Start only on a click.** `POST /api/android/start-server` (§4.5). The Gate shows the button only without WebUSB; the Environment check shows it with a warning.
- **Never stop the server.**
- **Network devices only on a click.** Connecting, pairing and disconnecting a device on the local network change what the server serves, so they are sent only from the three routes of §4.7, each on the tester's click.

### 4.2 Host protocol

- **Request:** 4 lowercase hex digits of length, then the ASCII payload.
- **Reply:** `OKAY`, or `FAIL` + 4-hex length + message.
- Every request passes `assertAdbService()` before a socket opens: `ADB_HOST_SERVICES`, `host:transport:<serial matching ID.android>`, or `exec:<an ADB_EXEC constant>`. The Wi‑Fi services have their own checks (§4.7). `host:mdns:services`, the server's own mDNS list, is read for discovery (§4.8).

| Use | Exchange |
| --- | --- |
| Presence | `host:version` → `OKAY` `0004` + 4 hex (`0029` = 41) [V] |
| Hot-plug | `host:track-devices-l` → `OKAY`, then `<4-hex len><devices -l text>` on every change, the first at once [S strings; format P0-7]. A `FAIL` → poll `host:devices-l` every 2 s; a socket that simply closes → a presence probe at once. |
| Re-list | `host:devices-l` → `OKAY <4-hex len><text>` [V on an empty server] |
| Command | New socket: `host:transport:<serial>` → `OKAY`; then `exec:<constant>` → `OKAY` + raw bytes until EOF. This is the same `exec:` service the WebUSB lane uses, so outputs match. A stream (logcat) completes the handshake first, so a `FAIL` becomes a JSON error before `hello`. |
| Retry | `host:reconnect-offline` (resets offline and unauthorized devices) [S; P0-7] |

**`FAIL` after `host:transport`**

- `device unauthorized.` or `device still authorizing` → `ANDROID_UNAUTHORIZED`
- `device offline` → `ANDROID_OFFLINE`
- `device still connecting` → `DEVICE_NOT_READY`
- `device '<s>' not found` → `DEVICE_NOT_FOUND`
- anything else → `TOOL_FAILED`

**Caps:** text 8 MiB, PNG 32 MiB.

### 4.3 Rows and the constant command table

**Parsing `devices -l` lines**

- First token = serial.
- State = the longest known state at the start of the rest (`no permissions (…)` contains spaces).
- Then `key:value` properties: `usb:`, `product:`, `model:`, `device:`, `transport_id:`, `features:`.

| adb state                                      | `state`        | blockers               |
| ---------------------------------------------- | -------------- | ---------------------- |
| `device`                                       | `ready`        | —                      |
| `unauthorized`                                 | `unauthorized` | `ANDROID_UNAUTHORIZED` |
| `authorizing`                                  | `authorizing`  | `ANDROID_UNAUTHORIZED` |
| `connecting`                                   | `connecting`   | —                      |
| `offline`                                      | `offline`      | `ANDROID_OFFLINE`      |
| `recovery`, `rescue`, `sideload`, `bootloader` | `recovery`     | `ANDROID_RECOVERY`     |
| `host`, `unknown`, `no permissions…`           | `unknown`      | —                      |

**Connection** (`adbConnection`)

- `emulator-\d+` → `simulator`.
- `ip:port` (IPv4, a name, or `[IPv6]:port`), or a serial containing `._adb-tls-connect._tcp` or `._adb._tcp` → `network`.
- Otherwise `usb`.

**Capabilities:** all true only when `ready`.

**Identity.** When a serial first reaches `device` (keyed by serial + `transport_id`), run three `exec:getprop <key>` calls (10 s each): `ro.product.model`, `ro.product.device`, `ro.build.version.release`.

- `name` = `model` = `ro.product.model`, falling back to `model:` with `_` → space.
- `modelId` = `ro.product.device`.
- `osVersion` = release.
- A newly ready device is held back up to 1.5 s while its identity is read, so its single arrival line reads "+ Pixel 9 (<serial>) · Android 17 · USB · ready via adb". After that it is published with the tracker's name. A device already listed that turns ready (the tester tapped Allow) changes in place.
- Retry forgets an identity that failed, so the next look reads it again.

**`ADB_EXEC` (constants only; the serial travels only in `host:transport:`; no page input ever reaches a command):**

```js
export const ADB_DETAIL = [
  // must equal DETAIL_COMMANDS.map(c => c.join(' ')) (contract test)
  ['getprop', 'getprop'],
  ['wmSize', 'wm size'],
  ['wmDensity', 'wm density'],
  ['battery', 'dumpsys battery'],
  ['df', 'df /data'],
  ['androidId', 'settings get secure android_id'],
]
const ADB_EXEC = [
  ...ADB_DETAIL.map(([, c]) => c),
  'getprop ro.product.model',
  'getprop ro.product.device',
  'getprop ro.build.version.release',
  'screencap -p',
  'logcat -v threadtime -T 200',
]
```

### 4.4 Operations

- **Detail.** The six `ADB_DETAIL` commands in parallel (10 s each; a failure gives `''`, as on WebUSB). If all six fail, the first error is thrown instead of a blank pane. Returns `{platform:'android', kind:'android', serial, connection, outputs}`. The page calls `androidDetail(outputs, serial, label)`, so the result is byte-identical to WebUSB except the Connection row.
- **Screenshot.** `exec:screencap -p` (20 s) → `extractPng` (drops the two-display warning) → `X-Screenshot-Source: adb`.
- **Logs.** `exec:logcat -v threadtime -T 200` as a stream (`source:'logcat'`). Abort destroys the socket and adbd ends logcat [I; P0-7]. When logcat ends, the lane waits up to 1 s for the tracker:
  - not listed any more → `device-gone`;
  - still listed but no longer ready (a device that dropped off the network, or stopped answering on its cable) → `device-gone` with `code: 'DEVICE_DROPPED'`, "The device dropped off the network." or "The phone stopped answering.";
  - otherwise `eof`.
  - The tracker ends the stream too: a device it reports offline ends its log at once, even when the logcat socket hangs.
- **Retry.** `offline`, `unauthorized` or `authorizing` → `host:reconnect-offline`; otherwise `host:devices-l`. Then wait up to 3 s for the tracker and return the row.

### 4.5 Starting the server (explicit)

```js
const child = spawn(adbPath, ['start-server'], {
  stdio: 'ignore',
  detached: true,
  env: { ...childEnv(), ANDROID_ADB_SERVER_PORT: String(port) },
})
child.unref() // never in liveChildren: the daemon it forks must not hold our pipes or be group-killed
// poll host:version every 250 ms for up to 8 s → { android: lanes.android } | 502 ADB_START_FAILED
```

- adb missing → 503 `TOOL_MISSING` (`install: 'brew install --cask android-platform-tools'`).
- On success, `startedByHelper = true` (used for the exit advice, §1.8).

### 4.6 Coexistence with WebUSB (with the §7.4 merge rule)

| Situation | WebUSB row | Helper row | Shown |
| --- | --- | --- | --- |
| Chrome, no adb server | `ready` | none (lane `stopped`) | WebUSB |
| Chrome, IDE's adb server running | `held` + `ADB_SERVER_HOLDING` | `ready` / `unauthorized` | **helper** (`held` loses) |
| Chrome, server running, helper not connected | `held` | — | `held` + "Copy adb kill-server" (as before) |
| Safari or Firefox (no WebUSB) | — | needs a server; the Gate offers Start | helper |
| WebUSB owns the phone, server started later | `ready` | `unknown`/`offline` [I] | WebUSB (better state) |
| A device on Wi‑Fi | — | `network` row | helper only: WebUSB never sees it |

The phone may show "Allow USB debugging?" once for the Mac's adb key; the existing `ANDROID_UNAUTHORIZED` hint covers it.

### 4.7 Android devices on the network (Wi‑Fi)

An Android TV across the room has no cable, and a phone may be out of reach of one. A browser cannot open TCP, so only Google's adb server can reach them: `adb connect` (a TV's "Network debugging", or `adb tcpip 5555`) and, for Android 11 and newer phones, "Wireless debugging" with a pairing code. The helper exposes exactly those two operations and their undo, each on the tester's click, through the server it already shares. It never connects anything by itself, not even a device it connected before.

**Endpoints** (bearer, `--no-android` → 409 `ANDROID_OFF`)

| Route | Body | 200 |
| --- | --- | --- |
| `POST /api/android/connect` | `{host, port?}` (port defaults to 5555) | `{result: 'connected' \| 'already-connected', serial, message, device: HelperDevice \| null}` |
| `POST /api/android/pair` | `{host, port, code}` | `{result: 'paired', host, port, message}` |
| `POST /api/android/disconnect` | `{serial}` | `{result: 'disconnected', serial, message}` |

- `message` is adb's own sentence, cleaned (300 characters at most): "connected to 192.168.1.20:5555", "Successfully paired to 192.168.1.20:37123 [guid=adb-…]", "disconnected 192.168.1.20:5555".
- `serial` is the network serial adb lists the device under (`192.168.1.20:5555`, `[fe80::1%en0]:5555`). `device` is its row once the tracker lists it, usually `unauthorized` until the device allows this Mac.

**The body.** `Content-Type: application/json`, a `Content-Length` (the gate refused anything else, §2.1), at most 1 KiB, one JSON object holding only the route's fields. Anything else is 400 `BAD_REQUEST` with one plain sentence, and nothing is sent to adb.

**What the page may name** (checked in this order, each failure a 400 with its own sentence)

- **Host**, trimmed, at most 253 characters:
  - `192.168.1.20:5555` in the host field → "Enter the port on its own: the address is just 192.168.1.20."
  - IPv6, with or without brackets and with an optional zone (`fe80::1%en0`, zone `[A-Za-z0-9_-]{1,32}`): only fc00::/7 (unique local) and fe80::/10 (link-local); never `::…` (unspecified or mapped IPv4) and never a dotted form. Lower-cased.
  - IPv4 in dotted decimal only: 10/8, 172.16/12, 192.168/16, 169.254/16 (link-local) and 100.64/10 (carrier-grade NAT). Octal, hex and integer forms are "not an IP address".
  - A name: lower-cased, a trailing dot dropped, at most 100 characters (so its serial, `name:65535`, still matches `ID.android`), DNS labels only, ending in `.local`, `.lan` or `.home.arpa`.
  - Never loopback (where emulators and the adb server itself listen), never a public address, never anything adb would read as a second argument.
- **Port**: a JSON integer from 1 to 65535; the string `"5555"` is refused.
- **Code**: exactly six digits, as a string.
- **Serial** (disconnect): a device id, and then the lane's own checks below.

**Names are resolved first.** adb resolves a `.local`, `.lan` or `.home.arpa` name itself, so "never public, never loopback" would hold only for typed addresses. The helper looks the name up first (`dns.lookup` with `all`, 5 s), and every address it has must pass the same rules: a name pointing at 127.0.0.1 or a public address is 400 ("… points to 127.0.0.1, which is not on your local network. Use the device’s IP address instead."), and a name that does not resolve is `unresolved` at once. Residual: adb looks the name up again, so a DNS answer that changes between the two lookups is not caught (T22).

**The three host services.** `host:connect:`, `host:pair:` and `host:disconnect:` stay in `ADB_HOST_NEVER`: `assertAdbService()` refuses them, and a test proves it. Only `connectNetwork`, `pairNetwork` and `disconnectNetwork` of the adb client send them, each through its own exact check of the one string it may send:

- `host:connect:<host>:<port>`, where `<host>:<port>` is exactly `networkSerial(host, port)` for a host the rules above keep unchanged (brackets exactly when IPv6, nothing normalised away);
- `host:pair:<6 digits>:<host>:<port>`, the same address rule;
- `host:disconnect:<serial>`, for a serial `isDisconnectableSerial()` accepts: a network serial in the exact `host:port` form connect writes. Never an mDNS serial (`adb-…._adb-tls-connect._tcp`: adb reads it as a host on port 5555 and answers "no such device", so the device would stay while the page said it went), never loopback (`127.0.0.1:5555` is an emulator), never empty (that would drop every network device at once), never a USB serial.

**Connect**

1. The server must be running; the helper never starts one for this. Otherwise 503 `ADB_SERVER_STOPPED` ("… Start it with Start adb server.").
2. One connect or pairing per host at a time: a second is 409 `BUSY`, not queued.
3. Resolve a name (above).
4. `host:connect:<host>:<port>`, 20 s. adb dials the device, then waits up to 10 s for its handshake, so our deadline leaves room for adb's own answer.
5. The answer (adb 30–36) comes as `OKAY` plus a sentence or as `FAIL`; both mean the same:
   - "connected to X" / "already connected to X" → 200.
   - "failed to authenticate to X": adb registered the transport, but the device has not allowed this Mac. The lane re-lists: if the server lists X (a TV with Network debugging, now asking "Allow debugging?"), the answer is 200 `connected` and the page shows the Allow step; if it does not (a phone with Wireless debugging that never paired with this Mac), it is `unpaired`.
   - Anything else → 502 `ANDROID_CONNECT_FAILED` with the reason below.
6. Wait (up to 3 s) for the tracker to list the device, and answer with its row.

**Pair** (Wireless debugging's "Pair device with pairing code")

1. Server running, one per host, name resolved, as for connect.
2. `host:pair:<code>:<host>:<port>`, 15 s.
3. "Successfully paired to …" → 200. "Failed: Wrong password or connection was dropped." → `wrong-code`. "unknown host service" or "invalid pairing request" (an adb older than Wireless debugging) → `unsupported`. Otherwise → the reasons below.
4. The pairing port is not the connect port: after pairing, the device shows its own connect port, which the tester enters next. The page never guesses 5555.
5. The code is never printed or logged: it is a one-time secret, and the terminal is pasted into bug reports.

**Disconnect**

1. Not a network serial → 400 "Only a device connected over Wi-Fi can be disconnected here."; not the exact `host:port` form → 400 "Only a device connected by its address (like 192.168.1.20:5555) can be disconnected here."
2. The server running (else 503 `ADB_SERVER_STOPPED`), and the serial listed now (else 400 "That device isn’t connected over Wi-Fi any more.").
3. `host:disconnect:<serial>`: "disconnected X" → 200, once the tracker no longer lists it (up to 3 s). "no such device 'X'" → 404 `DEVICE_NOT_FOUND`.
4. The row leaves as a disconnect, not as a device that stopped answering (§1.10). The lane marks the serial as leaving _before_ it sends `host:disconnect:`, because adb's tracker may report it `offline` before the reply. A leaving serial that is no longer `device` is not published, so the row leaves `/api/devices` at once and never passes through `offline` + `ANDROID_OFFLINE`; the page must not read that as a drop. The terminal prints `Wi-Fi: disconnected X` and the departure `- <name> (X) · disconnected` (`LaneContext.publish`'s `departures`, §1.4), never "not answering over Wi-Fi". An open log stream ends with `device-gone`, not `DEVICE_DROPPED`. The mark is cleared when the disconnect fails, when the same serial is connected again, and after 10 s: a device adb still lists `offline` then is shown as it is.

**Failures** (`ANDROID_CONNECT_FAILED` / `ANDROID_PAIR_FAILED`, 502, with `reason` and `detail` = what adb said)

| `reason` | adb said | The helper's sentence after "Could not connect to X." |
| --- | --- | --- |
| `refused` | "… Connection refused" | Nothing accepted the connection there. On the device, turn on Network debugging (TV) or Wireless debugging (phone), and check the address and port. |
| `blocked` | "No route to host" | Something on this computer is blocking the local network. If a VPN is on (Cloudflare WARP, a Tailscale exit node, a work VPN), turn it off or allow local network access in it. On a Mac, start the helper from Terminal.app and choose Allow when macOS asks, or allow that app under System Settings → Privacy & Security → Local Network. |
| `unreachable` | "Host is down", "Network is down", "Network is unreachable" | That address cannot be reached from this Mac. Check that the device and this Mac are on the same network. |
| `timeout` | "timed out", or our 20 s / 15 s | The device did not answer in time. Check that it is on, awake and on the same network. |
| `unresolved` | "failed to resolve host", or our own lookup | That name was not found on your network. Use the device’s IP address instead. |
| `unpaired` | "failed to authenticate to X", and X is not listed | The device uses Wireless debugging and has not paired with this Mac yet. Pair it first with the code from “Pair device with pairing code”. |
| `wrong-code` | "Wrong password or connection was dropped" | The pairing code was wrong, or the device closed the pairing screen. Try a new code. |
| `unsupported` | "unknown host service" | This adb is too old for Wireless debugging. Update it: brew upgrade --cask android-platform-tools |
| `failed` | anything else | adb could not reach the device. |

**When this Mac is what blocks the network** [V, 2026-10-04]. Before the first Android TV connected, every connect failed at once with "No route to host" (then read as `unreachable`), for two causes that have nothing to do with the device or the Wi‑Fi:

- **A VPN.** With Cloudflare WARP connected, the Mac could not reach the LAN at all. Disconnecting it fixed the connect. Other VPNs that capture all traffic do the same [I].
- **macOS Local Network privacy.** macOS lets a process reach the local network only if the app it belongs to may. A process started from a terminal belongs to that terminal app, and so does whatever it starts, the adb server included when the helper starts it (§4.5) [I for the adb server]. From Terminal.app the helper worked (macOS asks the first time). From VS Code's integrated terminal every LAN connection failed: macOS had never asked VS Code, so System Settings → Privacy & Security → Local Network had no switch to turn on. An adb server started elsewhere (Android Studio, another terminal) belongs to whatever started it.
- **Discovery is not reachability.** In both cases mDNS discovery (`dns-sd`) still listed the device: the system's mDNS service answers for every app, so a device that shows up can still be unreachable from the helper.

So "No route to host" has its own `reason`, `blocked`: the address can be right and the device awake, and "same network?" misleads. Its sentence (table above) names both causes and their fixes. In the terminal, `Wi-Fi: could not connect to X: no route to host, so this computer can't reach the local network` is followed by an indented VPN line and, only on macOS, an indented Local Network line, the way a blocker is. The page words `blocked` as this computer's doing, not the device's, and adds the checklist row `wifi.localNetwork` ("This computer reaches the local network") after a blocked attempt, with "Device answers" Not checked.

**Rows on the network**

- `connection: 'network'`, named by `ro.product.model` once allowed; detail, screenshot and logs work exactly as over USB.
- Allowing on the device changes the row in place (`~ … ready via adb`); it never leaves and comes back.
- A device that drops off the network ends its log with `DEVICE_DROPPED` (§4.4), then leaves the list once the server lets go of it.
- Terminal wording: "waiting for "Allow debugging?"", "not answering over Wi-Fi", and the advice "Choose Allow on "Allow debugging?" on the device (with the remote on a TV)". The device's own prompt may say more: an Android 10 TV asked "Allow USB debugging?" over the network [V].

**Preflight.** `android.wifi` ("Wi-Fi devices", optional, so never in the banner): OK with the server running, listing the network devices in `detail`; Warning when the server is not running (fixes: Start adb server, and `<adb> start-server` with a note that Chrome's WebUSB then loses phones on a cable); the brew command alone when adb is missing (Start adb server can't work without it); the stuck-server warning of `android.adb-server` when something on the port doesn't answer like adb; Not checked with `--no-android`.

**The page**

- The "+" menu of the device list has "USB device…" (disabled with "Needs Chrome or Edge (WebUSB)" without WebUSB) and "Network device (Wi‑Fi)…"; the Gate's Android card has the second too.
- The Wi‑Fi dialog (`components/wifi-dialog.tsx`, state in `wifi.ts`, input rules in `helper/network.ts`): an address and a port (5555 by default; pasting `IP:port` into the address works), "Pair with a code (Android 11 and newer)", a Recent list for one-click reconnects (localStorage `dvc_wifi_recent`, 6 at most, with Disconnect and Forget), and "How to turn it on" for TVs and phones.
- `helper/network.ts` mirrors the helper's rules so a bad address is explained at once; the helper stays the authority.
- Progress shows as checklist rows (connecting → the device answered → waiting for "Allow debugging?" → allowed, with "Show <name>"). Each `reason` has its own wording, with adb's sentence beside it; a stopped server offers Start adb server.
- Without a running, paired helper the dialog shows the helper card's steps instead of the form; a helper without `android.connect` (Android lane on) gets "Your helper is older than this page: it can't connect to devices over Wi‑Fi yet. Update it: press Ctrl+C in its window, then run:" with the download command and "Then reload this page." (§2.8).
- Wi‑Fi rows carry a Wi‑Fi badge and a Disconnect button (only for `host:port` serials), and say that Apps, Images and installs need a USB cable for now. A gone device's pane offers "Connect again". `DEVICE_NOT_FOUND` from a disconnect counts as success only when the row is gone from the list.
- The Environment check's "Wi‑Fi devices" group (`wifi.helper`, `wifi.adbServer`, `wifi.reachable`, `wifi.authorized`) appears once a connect was tried or a Wi‑Fi device is listed.
- Page deadlines: connect 35 s, pair 25 s, disconnect 10 s.

**Verified on hardware** (2026-10-04, §9.7): an Android 10 TV with Network debugging on, through the built helper: connect, Allow on the TV, Ready in place, detail, screenshots, logcat and Disconnect.

**Not verified on hardware yet:** pairing with a code, and whether a Wireless-debugging phone that never paired is listed `unauthorized` after "failed to authenticate" (then the page shows the Allow step rather than asking for a code).

### 4.8 Discovery: every Android device on the network

§4.7 reaches a device only once the tester types its address. Discovery lists, read-only, every Android device on the local network that advertises adb, so the page can offer each one with a click: the answer to "have you listed every Android device on the Wi‑Fi?". It never connects, pairs or starts anything: those stay the tester's clicks of §4.7.

**What advertises adb** (DNS-SD, measured with `dns-sd` on 2026-10-04 [V])

| `kind` | Service | Means | Example on the owner's network |
| --- | --- | --- | --- |
| `adb` | `_adb._tcp` | Network debugging (a TV, `adb tcpip 5555`): connect to host:port directly | Sony BRAVIA: `adb-b120be004010859` at `Android.local`:5555, 192.168.68.101 |
| `wireless` | `_adb-tls-connect._tcp` | Android 11+ Wireless debugging: connect works only once paired, otherwise the page offers pairing | Pixel 9: `adb-55090DLAQ0026D-nK25Qn` at `Android_ZDKLKP74.local`:39601, 192.168.68.114 |
| `pairing` | `_adb-tls-pairing._tcp` | a pairing port open right now ("Pair device with pairing code" is on screen), for the pair step | the same Pixel, while that screen is open |

Two more services are browsed only to name an address: `_androidtvremote2._tcp` (its instance name, "SONY KD-43X8050H") and `_googlecast._tcp` (its TXT `fn=`, the name the owner gave it; it wins over the Remote's). Either one at a device's address also sets `tv`.

**The mDNS browser** (`mdns.ts`, file §9; no dependency, `node:dgram`)

- One udp4 socket on an **ephemeral port**, never 5353, which mDNSResponder or avahi holds. Queries go to 224.0.0.251:5353 once per non-internal IPv4 interface (`setMulticastInterface`), TTL 255. RFC 6762 §6.7 calls this a legacy unicast query: responders answer straight to the asking port, echoing the id. Every question also carries the QU bit (§5.4). Answers with id 0 (multicast-style) are taken too; any other id is dropped.
- One packet of five PTR questions, sent again halfway through the window. As answers arrive (30 ms debounce): SRV and TXT questions for an instance without an SRV, A and AAAA for an SRV target without an address, each name once, at most 12 questions a packet. Answers and additionals are read alike. A TTL of 0 (a goodbye) removes what it names.
- **Addresses belong to the answer, not to the host name.** adbd and TV Remote call many devices `Android.local` at once, so an instance takes, in order: the A/AAAA records for its SRV target that came in the same packet as its SRV; else those that came from the address the SRV's packet came from (the transport hands that address over); else that address itself; and only when nothing ties an address to it, every address any answer gave for the target. Two TVs that both say `Android.local` are two devices, each at its own address, whichever answers first.
- The window is `mdnsWindow`, 2 s; then the socket is closed and what was learnt is returned.
- **Hostile packets.** Every length, count and pointer is checked against the packet before it is read: at most 9000 bytes and 256 records a packet whatever the counts claim; a compression pointer must point before every place the name was already read from (so no loop exists), at most 32 hops; names at most 255 bytes; label types 01 and 10 refused; a record whose data does not fit its length is skipped, and the first record that overruns the packet ends the reading with the records before it kept. Only class IN; the cache-flush bit is ignored. A label must be UTF-8 (RFC 6762 §16): any other byte would read as U+FFFD and could not be written back as it came (22 bytes of 0xFF come back as 66, past a label's 63), so such a name is malformed too, and every name read can be asked about again. The bytes are checked where they lie, against table 3-7 of the Unicode Standard, never by writing the label back to compare: one packet can hold 1,455 questions about a name of 127 labels, and a copy of each label would double what such a packet costs to read. A PTR counts only when its target is exactly one label under the service asked. What one browse keeps is capped too: 256 instances, 512 names, 8 addresses a host, 32 TXT strings.
- **Nothing throws out of a callback.** Answers arrive in the transport's message event and follow-ups run in a timer, where a throw would stop the helper (`main.ts` catches only rejections): a packet that makes anything there throw is dropped, and so is a follow-up packet that cannot be written or sent. A service type that cannot be written as a name rejects the browse before the socket opens, so nothing is left open.
- **Transport seam.** `BridgeOptions.mdns` (an `OpenMdnsTransport`) is the UDP socket by default. Every isolated test bridge gets `silentMdns()` (`harness.ts`), and the suite's fake network (`fakes/mdns.ts`) answers with real packets, so no test sends a packet to a real network.

**The system resolver** (`mdns.ts`, `systemBrowse()`, file §9) [V, 2026-10-04]

Measured on the owner's network: the Pixel 9 (Android 17, Wireless debugging on) answered neither the helper's queries nor a standard multicast query from port 5353, in four scans (it announces itself when Wireless debugging starts, then dozes). mDNSResponder still had it: `dns-sd -B _adb-tls-connect._tcp local.` listed `adb-55090DLAQ0026D-nK25Qn`, `-L` gave `Android_GWZJSA15.local.:43141` and its TXT, `-G v4` gave 192.168.68.114, and all of it worked from VS Code, an app macOS keeps off the local network, because the daemon does the networking. So the same browse is also asked of the system's daemon, and the helper's own browser stays for Windows and for whatever the daemon lacks.

- **Which tool** (`systemMdnsTools`): macOS: `/usr/bin/dns-sd` at that fixed path (`BridgeOptions.dnsSdPath`), never looked up on PATH. Linux: `avahi-browse` (avahi-utils) from `BridgeOptions.avahiBrowsePath`, or, when that is undefined, the first absolute PATH entry or extra directory (`/usr/bin`, `/usr/local/bin` unless `extraDirs` is given) that has it. Elsewhere, or when it is not installed: nothing.
- **How** (every process through the bridge's `streamTool`: absolute path, no shell, its own process group, tracked for shutdown; read-only: browse, resolve and address lookups, never a register):
  - dns-sd, all five types at once: `dns-sd -B <type> local.` for `systemBrowse` (1.5 s; dns-sd never exits by itself, so it is killed). Each instance it adds is resolved at once with `dns-sd -L <instance> <type> local.`, then its host with `dns-sd -G v4 <host>` (each host once per scan), at most 4 such processes at a time, each killed as soon as it answered (150 ms later, for its TXT line or a second address) or after `systemResolve` (1.5 s). A `Rmv` drops the instance.
    - **The adb devices first.** macOS keeps listing a Cast or TV Remote service whose device has gone to sleep, and its `-L` never answers, so each such entry holds a slot for the whole 1.5 s [V: the owner's BRAVIA, switched off, still listed under `_androidtvremote2._tcp`]. The resolves of the adb types (`_adb`, `_adb-tls-connect`, `_adb-tls-pairing`) and every `-G` lookup go before any queued name-only resolve (`_googlecast`, `_androidtvremote2`), and the name-only ones hold at most one slot in four (`nameSlots`), so a dozen sleeping Chromecasts never delay the phone.
    - **A hard deadline.** The whole run is cut at `systemBrowse + 2 × systemResolve`. A process is never waited for once it is killed: the slot and the run move on at once, and the runner SIGKILLs the group 250 ms later if it ignored SIGTERM (it stays tracked for shutdown meanwhile).
  - avahi-browse, all five types at once: `avahi-browse -r -p -t -k <type>`, which resolves by itself and exits once its cache is dumped; killed after `systemBrowse + systemResolve`. IPv4 answers only.
- **Formats** (each line matched exactly; anything else is ignored):
  - `-B`: `21:00:20.680  Add        2  14 local.               _adb-tls-connect._tcp. adb-55090DLAQ0026D-nK25Qn`: the instance is the rest of the line, raw (spaces included); only domain `local.` and the type asked.
  - `-L`: `21:00:43.125  adb-55090DLAQ0026D-nK25Qn._adb-tls-connect._tcp.local. can be reached at Android_GWZJSA15.local.:43141 (interface 14)` (an optional ` Flags: N` after it), the full name in presentation form (`SONY\032KD-43X8050H`, `\.`, `\\`; its first label must be the instance asked about), then, when the TXT is not empty, one line starting with a space: ` given_name=BAULOC\ Pixel\ 9 serial=55090DLAQ0026D v=2.1 api=37.1 name=Pixel\ 9` (dns-sd's ShowTXTRecord: shell metacharacters and spaces after one backslash, a backslash written as four, bytes below 0x20 as `\\xHH`).
  - `-G v4`: `21:00:50.987  Add  40000002      14  Android_GWZJSA15.local.                192.168.68.114                               120`: an IPv4 address for the host asked; a negative answer (`No Such Record`) does not match.
  - avahi: `+;wlan0;IPv4;<name>;<type>;local`, `-;…` and `=;…;local;<host>;<address>;<port>;"k=v" "k=v"`; the name escaped by `avahi_escape_label` (`\032`, `\.`), found up to `;<type>;local` (a name may hold a `;`), the type compared as text in ASCII case only, never as a pattern; TXT strings in double quotes with `\"`, `\\` and `\DDD`.
- **Untrusted output.** Lines are cleaned (escapes and control characters) and capped as every tool's are; an instance must be 1–63 bytes, a host a `.local` name; neither may start with `-` (never passed as an option); an answer for another instance, another domain or another type is ignored; only IPv4; at most 128 instances per group (the adb types; the name-only types: neither crowds out the other), 32 TXT strings, 8 addresses a host. avahi-browse keeps the same two caps. When two instances of the same type point at one host (`Android.local` on two TVs), a lookup of that name answers for whichever device spoke first, so those instances get no address from this source (the helper's own browser ties addresses to the packet and still finds them).
- **Looked or not.** dns-sd looked when a browse ran until it was stopped or found something; it did not when every browse exited at once (no daemon: `DNSServiceBrowse failed -65563`). avahi-browse looked when it printed a browse line or exited 0; `Daemon not running` (exit 1) is not looking. The reason is kept (`dns-sd exited with code 1: …`). Tests point `dnsSdPath` into the fake bin directory (`harness.ts`), so the real tool never runs in the suite.
- What it finds is a `ServiceInstance` like the helper's own browse, so naming, local-address rules and merging are the same for both.

**adbd's TXT** (`adbTxtDetails`): adbd 13+ advertises Wireless debugging with `given_name=` (the name the owner gave the phone, "BAULOC Pixel 9"), `name=` (the model, "Pixel 9"), `serial=` and `api=` (`37.1`: SDK level 37 → Android 17; levels 21–32 by Android's table, 33 and up as level − 20, beyond 60 not shown). Cleaned like every name; a serial outside `[A-Za-z0-9._-]{1,64}` is dropped.

**Merging the sources** (`android-lane.ts`, `scanNearby`, `uniqueServices` and `mergeNearby`)

- Three sources at once: the helper's own browse, the system resolver, and, when the lane knows a running server, `host:mdns:services` (on `ADB_HOST_SERVICES`, read-only; `<instance>\t<service>\t<address>:<port>` per line, a trailing dot on the type tolerated). No server: no adb request at all, and never a server started for this. They merge in that order; for each service the first source's entry wins and later duplicates fill in what it lacks (a TXT name, model, serial or version).
- **A device only the daemon knows is still offered.** It may be dozing: connecting wakes it, or fails with the usual §4.7 reasons.
- **Only local addresses are offered**, by the rules of `parseNetworkHost` (§4.7): private, link-local and carrier-grade NAT IPv4, unique-local IPv6. Never a name (adbd advertises `Android.local` on many devices at once), never public, loopback or multicast, and never link-local IPv6, which adb could not reach without the interface the answer came in on. An instance without such an address and a valid port is dropped.
- Each service appears once: by `kind` and `host:port`, by `kind` and instance, and by `kind` and serial (the instance's, else TXT `serial=`: Wireless debugging renames its instance each time it is turned on, and adb may still list the old one at an old port; a phone's `wireless` and `pairing` entries are different kinds and both stay). The serial counts only on the **same host**, or when one of the two entries comes from adb's own list (which may keep an old address as well): two cheap TV boxes at different addresses often share one `ro.serialno`. A junk serial (`0123456789ABCDEF`, `0000000000000000`, `unknown`, empty) never counts, neither here nor for matching a listed row. Ordered by address (IPv4 numerically), then `adb`, `wireless`, `pairing`; at most 64 (`LIMITS.nearby`).
- Compared with what adb lists **now** (the tracker's rows at answer time, not at scan time, so a device the tester just connected shows `connected` from the cached scan). A listed row matches by this `host:port`, by its mDNS serial (`<instance>._adb-tls-connect._tcp`, or the same serial inside one), for `wireless` and `pairing` by a network row on the same host (the pairing port is not the connect port), and lastly by the instance's serial over USB.
  - `connected`: a row matched; `deviceId` names it.
  - `paired` (`wireless` and `pairing` only): a **network** row matched. adb lists a Wireless-debugging device over the network only once this Mac is paired with it (and adb connects a paired one it discovers by itself). `false` means "not known to be paired": adb does not tell which keys it has paired.
  - `serial`: what adbd's instance name carries, `adb-<serial>` or `adb-<serial>-<6 characters>`, else TXT `serial=`.
  - `name`: TXT `given_name=` (the device's own name), else Cast's `fn=`, else the Remote's instance name at the same address, else `''`. `model`: TXT `name=`. `osVersion`: the Android version of TXT `api=`.

**`GET /api/android/nearby[?refresh=1]`** (bearer; the §2.1 pipeline; `--no-android` → 409 `ANDROID_OFF`)

```ts
interface AndroidNearbyResult {
  devices: AndroidNearbyDevice[]
  scannedAt: number // when the scan these come from started
  error?: { reason: 'blocked' | 'no-network' | 'failed'; message: string; detail: string }
  // the helper's own queries could not leave but the system resolver looked: no error
  note?: { reason: 'blocked' | 'no-network' | 'failed'; message: string; detail: string }
}
interface AndroidNearbyDevice {
  id: string // `${kind}:${networkSerial(host, port)}`: 'adb:192.168.68.101:5555'
  host: string
  port: number
  kind: 'adb' | 'wireless' | 'pairing'
  instance: string // cleaned, 100 characters at most
  name: string // TXT given_name=, else Cast fn=, else the Remote's instance name, else ''
  model?: string // TXT name=: 'Pixel 9'
  osVersion?: string // the Android version of TXT api=: '17'
  serial?: string
  tv: boolean
  connected: boolean
  deviceId?: string // the /api/devices row, when connected
  paired?: boolean // wireless and pairing only
}
```

- A scan is cached 20 s (`nearbyCacheMs`); a GET within that answers the cached scan, merged afresh. `?refresh=1` starts a new one only 3 s (`nearbyGapMs`) after the last one started. At most one scan runs: a second request joins it. A scan runs on the helper's own signal, never a request's, so a page that leaves does not cut short the scan another request waits for.
- Health advertises `android.discover` with the Android lane.

**When the scan cannot run** [V, 2026-10-04: from VS Code's terminal, `send EHOSTUNREACH 224.0.0.251:5353` at once]

| `reason` | The socket said | `message` |
| --- | --- | --- |
| `blocked` | `EHOSTUNREACH` or `EPERM`/`EACCES`, on the first send | "Could not look for devices on the network." + the §4.7 `blocked` sentence (a VPN such as Cloudflare WARP; on a Mac, start the helper from Terminal.app and choose Allow) |
| `no-network` | `ENETDOWN` (no interface has an IPv4 address), `ENETUNREACH`, `EADDRNOTAVAIL` | "… this computer is not connected to one. Turn on Wi-Fi, or plug in a network cable, on the same network as the device." |
| `failed` | anything else | "Could not look for devices on the network." |

A multicast query fails only when it left on no interface (the first interface's error); one interface refusing while another sends is not a failure.

**`error` only when no source could look**: the helper's queries could not leave **and** the system resolver did not look (none on this computer, no daemon, a tool that fails at once). adb's own list does not count: whether its mDNS works cannot be checked from here. Such a scan still answers 200 with whatever adb's list found, and `error` beside it. When the resolver ran and said why it could not look, `error.detail` carries both: `send EHOSTUNREACH 224.0.0.251:5353; dns-sd exited with code 1: DNSServiceBrowse failed -65563`. When the resolver looked although the helper's queries could not leave, the list is complete: no `error`, and `note` (same `reason` and `detail`, `message` "Looked through this computer's own resolver: the helper's own queries could not reach the network. Connecting may be refused for the same reason; if it is, the helper says how to fix it."). The `blocked` wording and its fixes then wait for a connect that actually fails (§4.7). A scan that sent but heard nothing is not an error: the page's empty state names the likely causes (debugging off, another network, a VPN that drops answers).

**Terminal and `--doctor`**

- After a scan, the terminal prints one line, only when it differs from the last one printed: `Wi-Fi: 2 Android devices on this network (1 TV, 1 with Wireless debugging), 1 already connected` (one device per address; a TV is any device with Remote or Cast), or `Wi-Fi: no Android device on this network advertises Network or Wireless debugging`. A blocked scan prints `Wi-Fi: could not look for Android devices on the network: no route to host, so this computer can't reach the local network` (`not permitted` for EPERM) and the same two indented fixes as a blocked connect (§4.7, `blockedLines`), the macOS one only on a Mac. When the system resolver failed too, one more indented line says why: `  The system resolver could not look either: dns-sd exited with code 1: DNSServiceBrowse failed -65563` (the `no route to host` / `not permitted` cause is read from the socket's words only).
- With a `note`, the summary is preceded by one quiet line, not the blocked fixes: `Wi-Fi: looked through dns-sd; the helper's own mDNS queries could not leave (send EHOSTUNREACH 224.0.0.251:5353), so connecting may be refused too`.
- `--doctor` runs one scan after the adb server's lines, with or without a server, and prints the same line, then one line per service: `SONY KD-43X8050H · 192.168.68.101:5555 · Network debugging · not connected`, `BAULOC Pixel 9 · 192.168.68.114:43141 · Wireless debugging · Android 17 · not connected` (the name, else the model, else the instance; `listed as <serial>` when adb lists it). A blocked scan prints its lines, and the summary only when adb's own list found something; a `note` prints its line.

**The page** (`nearby.ts`, `components/nearby-list.tsx`, the Wi‑Fi dialog)

- `HelperConnection.nearby(refresh)` asks only when health lists `android.discover`; otherwise it throws `DISCOVER_UNSUPPORTED` without a request, and the section says the helper is older than this page (§2.8). Page deadline 12 s (`TIMEOUTS.nearby`: the helper's 2 s window, plus a scan it may be waiting on).
- `parseNearby` checks every host again with `checkHost` (`helper/network.ts`), so only private, link-local or CGNAT addresses ever reach a button; it strips control and direction characters from names, drops repeated ids and keeps 64. Optional `model` and `hostname` are read when a helper sends them.
- `nearby.ts` looks when something first shows the list (the section, the dialog's pick list), then every 30 s while the tab is visible and something still shows it; never while hidden. Refresh sends `?refresh=1` and announces how it ended, once. A blocked or failed reply keeps the devices adb listed.
- `nearbyRows`: one row per device (by serial, else by address), leaving out what is listed already: `connected`, the same serial (a cable too), an adb mDNS serial with the same instance, or the same `host:port`. Named by friendly name, else model, else serial, else address. One action: **Connect** for Network debugging, or Wireless debugging known to be paired; otherwise **Pair…**, with the same device's `pairing` entry as the pairing address when its pairing screen is open (never a guessed port) and its `wireless` port kept for the connect after pairing.
- **"On this network"**, under the device list (and in the Gate's Android card when nothing is plugged in): rows with a TV or phone icon, the address, a "Network debugging" / "Wireless debugging" badge and "Pairing screen open". Connect opens the Wi‑Fi dialog filled in and runs its connect (the device then asks "Allow debugging?"); Pair… opens it filled in, with focus on the pairing code (or the pairing address when the pairing screen isn't open). States: helper not running (one line, "Set up the helper"), helper older than discovery ("Update the helper": "Your helper is older than this page: it can't look for devices on this network yet. Update it: press Ctrl+C in its window, then run:", the download command for its port, "Then reload this page."), started with `--no-android` (that sentence, no download), Looking…, nothing found (how to turn on Network or Wireless debugging; same Wi‑Fi, no VPN), everything found already connected (only after a look that ran), blocked (the `wifi.localNetwork` row "This computer reaches the local network" with the VPN and macOS fixes, the start command and the socket's detail), failed (the helper's sentence, else the page's sentence for the code, such as `HELPER_UNREACHABLE`, `HELPER_BAD_REPLY`, or `HELPER_TIMEOUT` when the page's 12 s ran out).
- **The Wi‑Fi dialog** shows "Found on this network" above the address fields; choosing one only fills the fields, and a blocked look is shown before anything is tried.
- Nothing found is ever connected or paired by itself: every Connect and Pair… is the tester's click.

**Not verified on hardware yet:** a scan from Terminal.app on the owner's network (the TV and the Pixel above are fixtures built from `dns-sd`'s view of them), and how each device answers a legacy unicast query.

---

## 5. Simulators (`--simulators`, off by default)

**Why include them.** They are the end-to-end path on a Mac with no phone (list → detail → screenshot → logs). They are off by default because a Mac often has several booted simulators, which would defeat one-ready-device auto-select.

**Binary.** The real `simctl` binary from `resolveSimctl()` (first-launch gate, §1.5), with env `DEVELOPER_DIR`. No Xcode or a pending first launch → `lanes.simulators.status = 'unavailable'`, plus preflight item `ios.simulators`.

**List**

- `simctl list -j devices booted` every 5 s while active (10 s timeout, about 80 ms [V]).
- `list -j runtimes` and `list -j devicetypes` cached for 10 minutes and on rescan.
- Only `com.apple.CoreSimulator.SimRuntime.iOS-*` runtimes are kept.
- A failed list keeps the current rows (one terminal line per failure streak), so one slow call doesn't end every log stream.

**Row**

| Field          | Value                                        |
| -------------- | -------------------------------------------- |
| `id`           | UDID                                         |
| `platform`     | `'ios'`                                      |
| `connection`   | `'simulator'`                                |
| `state`        | `Booted` → `ready`; `Booting` → `connecting` |
| `name`         | the simulator's name                         |
| `model`        | device type name                             |
| `modelId`      | `modelIdentifier`                            |
| `osVersion`    | runtime version                              |
| `capabilities` | all true except `install`                    |

**Detail:** `SimFacts`.

**Screenshot**

1. Re-check `Booted` from a fresh list: a shut-down simulator **hangs forever** [V]. One that shut down is 404 `DEVICE_NOT_FOUND` without running capture; one still booting is 409.
2. `simctl io <udid> screenshot --type=png <dir>/shot.png` (20 s). Never `-`: it writes a file literally named `-` [V].
3. 0.8–1.5 s on the build Mac [V].

**Logs**

- `simctl spawn <udid> log stream --style compact --level info` (`source:'simctl'`).
- `hello` on the first line; no line within 10 s → `LOGS_UNAVAILABLE`.
- Drop the `Timestamp  Ty Process[PID:TID]` header line and all stderr (`getpwuid_r…`) [V].
- Lines look like `2026-10-04 08:32:26.731 I  UserEventAgent[38363:6797d5] [subsystem:category] message` [V].
- When the stream ends the lane re-lists, so a simulator that shut down ends as `device-gone`.

**Errors:** exit 148 → `DEVICE_NOT_FOUND`; exit 149 → `DEVICE_NOT_READY` [V].

---

## 6. Browser modes, pairing and lifecycle

### 6.1 Mode resolution (`helper/env.ts`, pure)

```ts
interface HelperEnv {
  mode: 'hosted' | 'local'
  apiBase: string
  port: number
  safariLike: boolean
  devOrigin: boolean
}
function resolveHelperEnv(
  loc: Pick<Location, 'origin' | 'protocol' | 'hostname' | 'port'>,
  boot: unknown,
  stored: { pairPort?: number; tokenPort?: number; port?: number },
  ua: string,
  vendor: string,
): HelperEnv
```

- **Local** ⇔ `boot` is a valid `DvcBoot` with `mode === 'local'` and `loc.origin === boot.apiBase`. Then `apiBase = loc.origin`. An http loopback origin alone never counts: that misfired on Vite `:7360` and `serve:site` `:8000` [V].
- **Hosted:** `apiBase = 'http://127.0.0.1:' + port`. `port` is the first valid integer in 1024–65535 from:
  1. the pending pair fragment's `port` (`pairPort`);
  2. the stored token's port (`tokenPort`);
  3. `localStorage.dvc_port` (`port`);
  4. 8787.
- `?api=` and `?port=` are not read: the legacy `?api=` sent stored tokens anywhere [V].
- `safariLike` (`isSafariLike`) is the legacy `dvcIsSafari` rule (WebKit vendor and not CriOS, FxiOS, Edg, OPR, Chrome or Firefox) [V samples]. It only reorders guidance and skips hopeless probes.
- `devOrigin` (`isDevOrigin`) = `http://localhost` or `http://127.0.0.1` on 7360, 4173 or 8000.
- Also here: `localPageUrl(port)`, and `loopbackPermission()` / `queryLoopback()` (§6.3).

### 6.2 Capturing the pair fragment (`helper/pair-fragment.ts`; called from `src/main.tsx`)

`capturePairFragment()` runs before `createRouter`, right after the existing `/index.html` fold. On `/device` or `/device/` paths:

1. Read `new URLSearchParams(location.hash.slice(1))` (`parsePairFragment`).
   - `pair` must match `/^[A-Za-z0-9_-]{43}$/`.
   - `port`, if present, must be an integer in 1024–65535.
   - Otherwise ignore both.
2. **Hosted and `safariLike`:** `location.replace('http://127.0.0.1:<port>/device/#pair=<token>&port=<port>')`. Safari cannot reach the helper from https [V], and the helper's own copy can. Stop here.
3. Otherwise:
   - stash `{token, port}` in `sessionStorage.dvc_pair_pending` (memory fallback);
   - strip the fragment with `history.replaceState(history.state, '', path + search)`. This guarantees the router never sees the token and that StrictMode's double start cannot lose it.

It returns what it did (`CaptureResult`). A pairing link opened in a `/device/` tab that is already running (the router exists, so `capturePairFragment` has run) goes through `takePairFragment()`: the token leaves the address bar at once and the open page pairs with it; Safari still forwards to the helper's page.

`parsePairInput()` reads what the pair dialog is given: a bare token or the whole printed link.

### 6.3 Hosted mode and Local Network Access

- **The only gate** is LNA `loopback-network`. Loopback is not mixed content in Chrome, Edge or Firefox [V].
- **Prompt text** [V strings]: Chrome "bauloc.github.io wants to: Access other apps and services on this device" (site setting "Apps on device"); Firefox "…wants to access other apps and services on this device." (setting "Device apps and services").
- **The prompt appears only after the TCP connect succeeds.** A stopped helper fails in 1–2 ms with no prompt [V].

**Permission query:** `navigator.permissions.query({name:'loopback-network'})`; only if that throws, `'local-network-access'` (Chrome 142–144). Querying the alias first misreports [V]. Both throwing → `'unsupported'`.

**When the page probes on its own** (otherwise phase `off` and nothing is sent):

| Condition at `start()` | Automatic probe? |
| --- | --- |
| Local mode | yes (same origin, no LNA) |
| A pending pair fragment | yes |
| A stored token (session or remembered) | yes |
| Permission `granted` | yes |
| `unsupported` and not `safariLike` (old Chrome or Firefox: no prompt can appear) | yes |
| Permission `prompt`, none of the above | **no**: "Connect helper" |
| `denied` | no: phase `denied` |
| Hosted and `safariLike` | never: phase `safari` |

**Probe rules**

- **One request in flight per kind** (Firefox bug 2033408) [D].
- **The first probe after an intent has no timeout while the permission is `prompt`.** Chrome holds the request while it asks; Firefox times out after 5 min [D]. While waiting, `promptLikely` is true.
- **Later probes** time out after 3 s.
- **Permission changes** (`PermissionStatus.onchange`) and Connect re-run the decision.

### 6.4 Local mode

- The helper serves `http://127.0.0.1:<port>/device/` (§2.9).
- The page is a secure context in Chrome, Firefox and WebKit [V], so WebUSB and `crypto.subtle` work. Same-origin means no CORS and no LNA.
- The token arrives only through `#pair=` (the printed Safari link, or the hosted page's forward) or the pair dialog. `DVC_BOOT` never carries it [V test].

**Costs, stated in the Environment check**

- A separate origin: theme, WebUSB grants and the browser's adb key don't carry over.
- It needs internet access to bauloc.github.io.
- When the helper stops, the page cannot reload itself.

### 6.5 Token, proof, storage and lifecycle

**Token (helper):** 32 random bytes, base64url, per run (or kept with `--keep-token`). `tokenIdOf(t) = sha256hex(utf8(t)).slice(0, 8)`; `example-token` → `4d1566a1` [V].

**Storage (`helper/token.ts`, modelled on `xconsole/repo/token.ts`)**

| Key | Where | Value / rule |
| --- | --- | --- |
| `dvc_token` | sessionStorage, always | `{"v":1,"token":"…","port":8787,"tokenId":"…"}` |
| `dvc_token` | localStorage, only with "Remember on this computer" | same value |
| `dvc_port` | localStorage | written only after a successful pairing on a non-default port |
| `dvc_pair_pending` | sessionStorage | unverified candidate (a link without `&port` is for 8787); deleted after one completed check, or when its port answers nothing or answers as something other than the helper (T7) |
| `dvc_wifi_recent` | localStorage | the Wi‑Fi devices this browser connected to (§4.7); no secret |

- Reads check sessionStorage first. If storage throws, a memory-only fallback is used (`browserStores()` / `memoryStores()`).
- A `storage` event on `dvc_token` makes other tabs re-check.
- The token never sits under or next to `xconsole_pat`.
- On the helper's own page (local mode) nothing is remembered. Its origin is `http://127.0.0.1:<port>`, which belongs to whatever listens on that port after the helper stops, so: nothing is written to localStorage there, and a `dvc_token` an older build left in it is removed at start; a per-run token lives in sessionStorage only; a kept token (`--keep-token`) lives in memory only, so a reload asks for the pairing again. The pair dialog shows no Remember switch there, only a note saying the pairing isn't saved, and the Environment check leaves the switch out.

**Use**

- Only in `Authorization: Bearer`, only to the `apiBase` of the port it was paired on.
- Only after `health.name === 'bauloc-device-bridge'`, `tokenIdOf(t) === health.tokenId`, and a valid proof for a fresh challenge (§2.8).
- **After any connection failure**, the next request is a proof probe, never an authenticated call.

**Verification flow** (`connection.pair(input, remember)` and the pending candidate)

1. `GET /api/health?challenge=c`.
2. Classify:
   - `tokenId` mismatch → the candidate is from another run: discard it; phase `stale` if a token was stored, else `unpaired`.
   - `tokenId` matches but the proof does not → `foreign`; nothing is sent.
   - Both match → save (session, plus local when remember is on or a remembered entry already exists), write `dvc_port` if not 8787, start polling.
3. A pending candidate is checked at most once per page load. **A failed candidate never overwrites a working stored token.** A candidate whose port answers nothing, or answers as something other than the helper, is spent the same way: the page goes back to the stored token's port, else `dvc_port`, else 8787, and decides again (§6.3). A permission prompt closed unanswered keeps it for Connect.
4. A pasted link naming another port switches `apiBase` only after that helper passes the proof.

`PairResult` is `{ok: true}` or `{ok: false, reason: 'format' | 'stale' | 'foreign' | 'unreachable' | 'outdated' | 'newer', tokenId?, port?}`; `tokenId` on `stale` is the running helper's fingerprint, and `port` (on `unreachable` and `foreign`) is the port the attempt tried, which a pasted link may set: the dialog's error names that port, not the page's.

**"Remember on this computer"** (switch in the pair dialog and the Environment check, on the hosted page only; off by default):

- **On:** new tabs and browser restarts reuse the token. A newly paired tab also updates the remembered entry, and other tabs pick it up through `storage`.
- **A stale tab never wipes a newer pairing.** When the proof fails, the page tries the tab's token, then the remembered one if it differs, and keeps whichever passes. Only the token that failed is removed, from the store that held it. (Open: a stale tab that notices a helper restart before another tab re-pairs still drops Remember.)
- **Survival across restarts:** only with `--keep-token`.
- **Note text:**
  - `tokenPersistent` false: "Keeps this browser paired while this helper keeps running. Leave it off on a shared Mac."
  - `tokenPersistent` true: "Keeps this browser paired, even after the helper restarts (it runs with --keep-token). Leave it off on a shared Mac."

**Lifecycle**

| Event | Result |
| --- | --- |
| Helper restarts (per-run token) | `tokenId` differs → `stale`, the stored token is cleared and never sent; the auto-opened tab pairs anew |
| `--keep-token` restart | Same token; `runId` changes; polling continues; the page applies the new snapshot |
| "Forget pairing" (Environment check) | Clears the token from both storages and turns Remember off → `unpaired` |

### 6.6 Phases (`helper/connection.ts`) and how each is detected

```ts
type HelperPhase =
  | 'off'
  | 'checking'
  | 'absent'
  | 'dismissed'
  | 'denied'
  | 'safari'
  | 'foreign'
  | 'outdated'
  | 'newer'
  | 'unpaired'
  | 'stale'
  | 'connected'
  | 'lost'
```

| Observation | Phase |
| --- | --- |
| Hosted and `safariLike` | `safari` |
| Permission `denied` (checked before probing) | `denied` |
| No probe policy satisfied (§6.3) | `off` |
| Probe in flight | `checking` (`promptLikely` while the permission is `prompt`) |
| `TypeError` in under 1 s | `absent` |
| `TypeError` after ≥ 1 s while the permission is still `prompt` | `dismissed` (heuristic; P0-9; both phases offer Connect) |
| 2xx but not JSON, or `name` mismatch, or `tokenId` matches but the proof fails | `foreign` |
| `protocol < DVC_MIN_AGENT` / `> DVC_MAX_AGENT` | `outdated` / `newer` |
| No usable token | `unpaired` |
| Stored token's `tokenId` ≠ `health.tokenId` | `stale` |
| Proof OK | `connected` → polling |
| 401 on any call | re-probe → `stale` |
| 2 consecutive network failures (or timed-out device polls) while connected | `lost` (list emptied) |

**Dev servers:** a 403 `BAD_ORIGIN` reaches the page as a `TypeError` (no CORS headers). On a `devOrigin`, `absent` copy therefore adds "…or it was started without --dev" (G24).

**Page-side codes** (`helper/client.ts`, `HelperError` with `code`, `kind: 'network' | 'timeout' | 'http' | 'protocol'`, `status`, `body`): a 401 becomes `HELPER_UNAUTHORIZED`; a non-helper reply to health `HELPER_FOREIGN`; a network failure `HELPER_UNREACHABLE`; a log with no message for 45 s `HELPER_STREAM_STALLED`; an unreadable reply `HELPER_BAD_REPLY`; our own deadline `TOOL_TIMEOUT`. An operation's timeout does not count towards `lost`; a timed-out device poll does. `message` is the code when `DEVICE_ERRORS` words it, else the helper's sentence.

### 6.7 Polling cadence and timeouts

| Phase | Request | Interval |
| --- | --- | --- |
| `off`, `safari`, `denied`, `dismissed` | none | user action, permission change, `focus` |
| `checking` | the one pending health probe | — |
| `absent` | health (no auth) | 2, 4, 8 s, then 10 s while visible; 60 s hidden; at once on `visibilitychange` and `focus` |
| `lost` | health + challenge | 1, 2, 4, 8 s, then 10 s |
| `unpaired`, `stale`, `outdated`, `newer`, `foreign` | health | 10 s while visible; none while hidden |
| `connected`, visible | `GET /api/devices` | 2 s; at once after Retry, Refresh, a failed operation, a Wi‑Fi action, or becoming visible |
| `connected`, hidden | `GET /api/devices` | 10 s |

- An unchanged `rev`/`runId` notifies nobody.
- Per tab: no held connection, at most 1 log stream, plus short requests.
- The doctor report is cached 30 s on the page, and dropped when `lanes` change, so the tool rows follow an adb server that stopped.

**Page timeouts** (`TIMEOUTS` in `helper/client.ts`)

| Request                           | Timeout                            |
| --------------------------------- | ---------------------------------- |
| health                            | 3 s (none during a pending prompt) |
| devices                           | 5 s                                |
| rescan                            | 8 s                                |
| detail                            | 20 s                               |
| screenshot                        | 60 s                               |
| retry                             | 15 s                               |
| doctor                            | 20 s                               |
| start-server                      | 15 s                               |
| Wi‑Fi connect / pair / disconnect | 35 s / 25 s / 10 s                 |
| log watchdog (no message)         | 45 s → `HELPER_STREAM_STALLED`     |

### 6.8 What the tester sees

The tables below are the design's words. The shipped words live in `helper/status.ts` (chip, card, notice, pair errors, Remember note, announcements; tested phase by phase in `status.test.ts`) and in `preflight/copy.ts`; where they differ, those files are right.

**Header chip** (`components/helper-chip.tsx`; a `Badge` rendered as a `button`; hidden below `md`; the Environment check button reaches the same things on every width):

| Phase | Dot | Text | Click |
| --- | --- | --- | --- |
| `off` | off | Connect helper | connect |
| `checking` | busy | Looking for the helper… | — |
| `checking` + `promptLikely` | warn | Allow in the browser prompt | — |
| `absent` | off | Helper not running | Environment check |
| `dismissed` | warn | Helper needs permission | connect |
| `denied` | bad | Browser blocked the helper | Environment check |
| `safari` | off | Helper: use its own page | open `http://127.0.0.1:<port>/device/` |
| `foreign` | bad | Port 8787 is another app | Environment check |
| `outdated` | warn | Helper outdated | Environment check |
| `newer` | warn | Reload for the new helper | reload |
| `unpaired` | warn | Pair this page | pair dialog |
| `stale` | warn | Helper restarted — pair again | pair dialog |
| `connected`, 0 helper devices | ok | Helper ready · no devices | Environment check |
| `connected`, r/n | ok if r = n, else warn | r/n ready via helper | Environment check |
| `connected`, a newer helper published (§2.8) | warn | Helper ready · update available, or r/n ready via helper · update available; tooltip "Helper 1.1.0 is out; this one is 1.0.0. The Environment check has the command." (same version rebuilt: "A newer build of helper 1.0.0 is out.") | Environment check |
| `lost` | bad | Helper stopped | Environment check |

The WebUSB chip is unchanged: two chips keep "helper unreachable" and "helper up, zero devices" from looking alike.

**Gate iPhone card** (`components/helper-card.tsx`; replaces the disabled "Get the helper" card; shown while nothing is listed):

| Phase | Title | Body and actions |
| --- | --- | --- |
| `off`, `absent`, `dismissed`, `checking` | Needs the helper | "macOS keeps the iPhone's USB connection for itself, so no browser can reach it. A small helper on this Mac bridges the gap: one file, nothing to install, and it runs only while its Terminal window is open." Step 1 `Command`: `curl -fsSL https://bauloc.github.io/device/agent/device-bridge.mjs -o ~/device-bridge.mjs && node ~/device-bridge.mjs`. Step 2: "It opens this page paired. Already running?" **Connect helper** · link "Review the source" (GitHub blob). Hosted note: "Chrome, Edge and Firefox ask once to let this page reach apps on this device. Choose Allow." `absent` adds "Nothing answers on 127.0.0.1:8787. Is the helper running?" (+ the `--dev` clause on a dev origin). `dismissed` adds "The permission prompt was closed. Connect again to see it." `checking` shows "Looking for the helper on 127.0.0.1:8787…" or "Waiting for your answer to the browser's prompt…". |
| `denied` | Blocked by this browser | "This browser stops this page from reaching apps on this device. In Chrome or Edge: Site settings → Apps on device → Allow, then reload. In Firefox: Settings → Privacy & Security → Device apps and services. Or use the helper's own page, which needs no permission." **Open the helper's page** |
| `safari` | Use the helper's page in Safari | "Safari never lets a secure page talk to this Mac's helper, so the helper serves this same page itself. Start the helper; it opens the right page." Command + **Open the helper's page** |
| `foreign` | Port 8787 is taken | "Another program answers on port 8787. Start the helper on another port; it opens the right page." `Command` `node ~/device-bridge.mjs --port 8788` |
| `outdated` | Update the helper | "Your helper (0.9.0) is older than this page needs. Download it again; the command replaces it." Command |
| `newer` | Reload this page | "The helper is newer than this page." **Reload** |
| `unpaired` / `stale` | Pair this page | unpaired: "The helper is running. Open the link it printed, or paste its token." stale: "The helper restarted, so this page's pairing ended. Open the new link it printed, or paste the new token." **Pair…** |
| `connected` | Ready for iPhones | "Plug in an iPhone with a cable and unlock it. If it asks, tap Trust." Plus, when `lanes.ios.screenshots === 'none'`: "Screenshots of iOS 17 and newer need Xcode on this Mac — see the checklist below." |
| `lost` | The helper stopped | "Start it again; this page reconnects by itself." `Command` `node ~/device-bridge.mjs` (local mode: "…then open the link it prints.") |

**Gate Android card without WebUSB** (`helperAndroid()`)

- Not connected: the card's usual copy.
- adb missing: "Install Android's platform tools first:" `brew install --cask android-platform-tools`.
- Server stopped: "The helper reaches Android through Google's adb server, which isn't running." **Start adb server**, with the note "While it runs, Chrome's WebUSB can't use Android phones on this Mac; adb kill-server gives them back." A helper without `android.start-server` gets "Update the helper" instead (§2.8).
- Running: "Ready through the helper. Plug in a phone with USB debugging on."
- With or without WebUSB, the card offers "Network device (Wi‑Fi)…" (§4.7).

**Other Gate text**

- **H1:** "Plug in a phone." when connected; otherwise unchanged.
- **Footer:** "WebUSB needs Chrome, Edge or Opera · USB debugging must be on · the helper needs macOS and Node 18 or newer, plus Xcode for iOS 17+ screenshots".

**Notice strip** (`components/helper-notice.tsx`). It sits above the device grid once devices are listed (the Gate is gone; "update available" alone also sits above the Gate, whose cards say every other phase), only if the tester showed intent (`status.intent`: a token stored, a pairing, a Connect click, or a connection earlier in this page view). Built from `TONE_SURFACE` and `Button`.

| Phase | Text | Action |
| --- | --- | --- |
| `stale` | "The helper restarted. Pair this page again to see iPhones." | **Pair…** |
| `lost` | "The helper stopped at 14:05. Start it again; this page reconnects by itself." | Copy command |
| `outdated` | "The helper is older than this page needs. Download it again." | Copy command |
| `newer` | "The helper is newer than this page." | **Reload** |
| `foreign` | "Port 8787 is used by another program, not the helper." | Open check |
| `connected`, a newer helper published (§2.8) | "Helper update available. Helper 1.1.0 is out; this one is 1.0.0. Press Ctrl+C in its window, run the command, then reload this page." | Copy command (the download command for the page's port) |

**Pair dialog** (`components/pair-dialog.tsx`; `Dialog`, `Input`, `Switch`, `Label`):

- Title "Pair this page with the helper"; description "Paste the token or the link the helper printed in Terminal."
- Input: monospace, `autocomplete=off`, `spellcheck=false`. It accepts the 43-character token or a whole link (`#pair=` is extracted).
- Switch "Remember on this computer" with the §6.5 note.
- Errors (`pairError()`):
  - format: "That isn't a helper token. Copy the whole line the helper printed."
  - stale: "That token is from another helper run. This helper's fingerprint is 4d1566a1."
  - foreign: "Something on port 8787 answered but couldn't prove it is your helper. Nothing was sent."
  - unreachable: "The helper isn't answering on 127.0.0.1:8787."

**Announcements** (once each, through `lab.announce`; `helperAnnouncement()`): "Local helper connected.", "Local helper stopped.", "The local helper restarted. Pair this page again." A toast also appears on `lost`, because the chip is hidden below `md`.

**Screenshots and logs**

- The Take Screenshot button for a ready device without the capability uses `aria-disabled`, so its tooltip and the inline note stay reachable by keyboard. The tooltip names the lane's tool ("Xcode's devicectl", "simctl", "Google's adb server").
- After 4 s of an iOS capture: toast "Still working — the first screenshot of an iPhone can take up to 20 seconds." (`SLOW_CAPTURE_MS`, `slowCapture()`).
- Log card description: "syslog" (iOS device), "simulator log", "logcat".

---

## 7. Page side

### 7.1 Files

All paths are under `_app/src/features/device/` unless noted.

**New**

| Path | Contents |
| --- | --- |
| `helper/protocol.ts` (+ test) | §2.3, §4.7 and §12c types; `HELPER_NAME`, `DVC_MIN_AGENT = 1`, `DVC_MAX_AGENT = 1`, `DEFAULT_PORT`, `DEVICE_ID`, `CODE`; guards `parseHealth`, `parseDevice`, `parseSnapshot`, `parseRetry`, `parseStartServer`, `parseDetail`, `parseLogMsg`, `parseErrorBody`, `parsePreflightItem`, `parseDoctor`, `parseLanes` and the Wi‑Fi replies. Unknown JSON is narrowed, never asserted; strings capped; blockers filtered by `/^[A-Z0-9_]{1,40}$/`; rows whose id fits no pattern dropped; link fixes https only; unknown states → `unknown`. |
| `helper/env.ts` (+ test) | `resolveHelperEnv`, `isSafariLike`, `isDevOrigin`, `isDvcBoot`, `resolvePort`, `localPageUrl`, `queryLoopback`, `loopbackPermission` |
| `helper/pair-fragment.ts` (+ test) | `capturePairFragment()`, `takePairFragment()`, `parsePairFragment`, `parsePairInput`, `stashPendingPair`, `readPendingPair`, `clearPendingPair` |
| `helper/token.ts` (+ test) | `readStoredToken`, `saveToken(entry, remember)`, `setRemembered`, `clearToken`, `readStoredPort`, `saveStoredPort`, `subscribeToken`, `browserStores`, `memoryStores`, `tokenIdOf`, `proofOf(token, port, challenge)`, `newChallenge` |
| `helper/client.ts` (+ test) | `createHelperClient(apiBase, getToken, {fetch})` with `fetch` options `{cache:'no-store', credentials:'omit', referrerPolicy:'no-referrer'}`; `HelperError`; `readNdjson(body, onMsg, {watchdogMs, signal})` (1 MiB line cap); `extractPng`; `TIMEOUTS` |
| `helper/connection.ts` (+ test) | `createHelperConnection(env, deps)` (§7.2), `CADENCE` |
| `helper/status.ts` (+ test) | All helper wording per phase: `helperChip()`, `helperCard()`, `helperAndroid()`, `helperNotice()`, `pairError()`, `rememberNote()`, `helperAnnouncement()`; the download, start and dev commands |
| `helper/network.ts` (+ test) | The Wi‑Fi input rules and the Recent list (§4.7) |
| `helper/update.ts` (+ test), `components/older-helper.tsx` | Whether the running helper is behind this page: `featureSupport()` per gated feature (`ready`, `older`, `off`, `unknown`, `helper`), `helperUpdate()` against the published file, `compareVersions()`; the "Update the helper" notice with the command for the page's port (§2.8) |
| `helper/testing/real-helper.ts`, `helper/real-helper.test.ts` | `startRealHelper()`: the built helper in-process with the helper suite's fake lanes, for tests that pair against the real thing |
| `backends/agent.ts` (+ test, + `agent.contract.test.ts`) | `createAgentBackend(conn): Backend`, `toDevice`, `toDetail`, `connectionLabel`, `streamLogs`, `logEndError` (§7.3) |
| `backends/ios.ts` (+ test) | `iosDetail(facts, connectionLabel)`, `simulatorDetail(facts)`, `fmtDecimalBytes()`, `fmtEcid()`, `iosModelName(modelId)` |
| `backends/ios-models.json` | `{"iPhone13,3":"iPhone 12 Pro", …}` (182 entries) |
| `wifi.ts` (+ test) | Android over Wi‑Fi as state: the last attempt, the Recent list, Disconnect in flight (§4.7) |
| `nearby.ts` (+ test), `components/nearby-list.tsx` (+ test) | "On this network": looking, the rows to offer, the section (§4.8) |
| `log-sessions.ts` (+ test) | Device logs kept apart from the console that shows them; drops waited out and resumed (§7.8) |
| `components/helper-chip.tsx`, `helper-card.tsx`, `helper-notice.tsx`, `pair-dialog.tsx`, `wifi-dialog.tsx` (+ tests) | §6.8, §4.7 |
| `components/log-level.ts` | `logLevel(line)` (§7.8) |
| `_app/scripts/ios-models.mjs` | Generates the JSON from Xcode's `device_traits.db` with `/usr/bin/sqlite3 -json -readonly`; `--check` exits 1 when it is stale |
| `_app/scripts/helper-fake.mjs` | The built helper on 8787 against the helper suite's fakes, for UI work without phones (§9.3); `--helper <file>` runs another built file (an older release), `--no-android` drops the Android lane |
| `_app/helper/**` | The helper's source, tests, fakes and fixtures (§1.1, §9.2) |
| `_app/tsconfig.helper.json` | §1.1 |
| `device/agent/device-bridge.mjs` | The built helper |

**Changed**

| Path | Change |
| --- | --- |
| `model.ts` | `Connection` gains `'simulator'`; merge rule (§7.4); 4 new `DEVICE_HINTS`; Wi‑Fi hint wording for Android on the network |
| `backends/backend.ts` | `DEVICE_ERRORS` additions (§7.5); the header loses "not built yet". Interface unchanged. |
| `backends/android.ts` | `androidDetail(o, serial, connection = 'USB (WebUSB)')`; the default keeps parity |
| `backends/mock.ts` | The mock iPhone gets a fake UDID `00008101-000A1B2C3D4E5F02`, `osVersion '27.0'`, blockers `['XCODE_REQUIRED']`, `screenshot:false` (fixtures gain optional `capabilities`), and syslog-format log lines |
| `store.ts` | Comment ("best state wins, see `model.mergeDevices`"); re-reads the selected device's detail when its blockers change, keeping what it shows if that fails |
| `device-lab-page.tsx` | Wiring (§7.7) |
| `components/gate.tsx` | iPhone card → `HelperCard`; Android card helper states and "Network device (Wi‑Fi)…"; checklist card; footer; H1 |
| `components/doctor-dialog.tsx` | About rows and the checklist's sections; Re-check; Forget pairing; Remember; Copy as text |
| `components/log-console.tsx` | Shows a log session (§7.8); description per source |
| `components/device-list.tsx` | "Simulator" (iOS) / "Emulator" (Android) and Wi‑Fi badges; the "+" menu |
| `components/device-detail.tsx` | Screenshot tooltip; inline checklist rows below the hint card (§12d); Wi‑Fi note, Disconnect and "Connect again" |
| `components/hint-card.tsx` | A ready device's screenshot blocker reads as a warning |
| `preflight/checks.ts`, `copy.ts`, `types.ts`, `env.ts` | The helper's rows join the existing checklist (§12): `helperChecks`, `toolChecks`, `deviceChecks`, `inlineChecks`, `wifiChecks`, `readPublishedHelper` |
| `store.test.ts` | Merge-rule tests |
| `_app/src/main.tsx` | `capturePairFragment()` after the `/index.html` fold, before `createRouter` |
| `_app/src/vite-env.d.ts` | `interface Window { DVC_BOOT?: { mode: 'local'; apiBase: string; protocol: number; version: string } }` |
| `_app/package.json` | Scripts `helper:build`, `test:helper`, `typecheck:helper`, `helper:fake`; `verify` runs the helper's typecheck, tests and `--check`; `rolldown` devDependency |
| `_app/.prettierignore` | `helper/test/fixtures` (byte-exact envelopes) |
| `_app/scripts/publish.mjs` | `device/agent` protected and `required: true` |

### 7.2 `HelperConnection` (`helper/connection.ts`)

```ts
export interface HelperStatus {
  phase: HelperPhase
  promptLikely: boolean
  env: HelperEnv
  permission: 'granted' | 'prompt' | 'denied' | 'unsupported' | 'not-needed'
  health: Health | null // kept for outdated and newer too, for the version
  lanes: Lanes | null
  pairing: { tokenId: string; remembered: boolean; tokenPersistent: boolean } | null
  intent: boolean // the tester showed they want the helper: gates notices and toasts
  since: number // when this phase began
  error: string | null // last error code
}
export interface HelperConnection {
  readonly getStatus: () => HelperStatus // plain functions, never methods (store convention)
  readonly subscribeStatus: (listener: () => void) => () => void
  readonly getDevices: () => readonly HelperDevice[] // [] unless connected
  readonly subscribeDevices: (listener: () => void) => () => void
  readonly start: () => void // non-blocking, idempotent, consumes the pending pair once
  readonly stop: () => void // aborts everything, clears timers; restartable (StrictMode)
  readonly connect: () => void // user gesture only: may show the LNA prompt
  readonly pair: (input: string, remember: boolean) => Promise<PairResult>
  readonly forget: () => void
  readonly setRemember: (on: boolean) => void // a no-op on the helper's own page
  readonly rescan: () => Promise<void> // POST /api/rescan
  readonly pollNow: () => void
  readonly doctor: (refresh?: boolean) => Promise<DoctorReport | null> // cached 30 s
  readonly startAdb: () => Promise<void> // only with the android.start-server feature
  readonly connectNetwork: (target: NetworkTarget) => Promise<ConnectReply> // only with android.connect (§4.7)
  readonly pairNetwork: (target: PairTarget) => Promise<PairReply>
  readonly disconnectNetwork: (serial: string) => Promise<DisconnectReply>
  readonly api: {
    detail: (id: string, signal?: AbortSignal) => Promise<DetailResponse>
    screenshot: (id: string, signal?: AbortSignal) => Promise<Blob>
    capture: (
      id: string,
      signal?: AbortSignal,
    ) => Promise<{ blob: Blob; source: ScreenshotSource | null }>
    retry: (id: string) => Promise<HelperDevice | null>
    logs: (id: string, onMsg: (m: LogMsg) => void, signal: AbortSignal) => Promise<void>
  }
}
export function createHelperConnection(
  env: HelperEnv,
  deps?: {
    fetch?
    now?
    stores?
    permissions?
    document?
    window?
    random?
  },
): HelperConnection
```

- **Constructor:** side-effect free (StrictMode builds it twice).
- **`stop()`:** bumps a generation counter and aborts one shared `AbortController`. Work still in flight changes nothing afterwards. A stop never clears `dvc_pair_pending`: only a completed check does.
- Without the needed feature, `startAdb` rejects with `ANDROID_OFF` and the Wi‑Fi calls with `NETWORK_UNSUPPORTED`, without a request.
- Every authenticated operation is aborted by `stop()` and followed by the §2.7 re-poll; each Wi‑Fi action polls the list once it answers.

### 7.3 The agent backend (`backends/agent.ts`)

```ts
export function createAgentBackend(conn: HelperConnection): Backend {
  return {
    kind: 'agent',
    label: 'Local helper',
    platforms: ['ios', 'android'],
    canRequest: false,
    isAvailable: () => true, // constant: the store subscribes only to lanes available at start()
    start: () => {
      conn.start()
      return Promise.resolve()
    }, // never blocks the store's sequential start
    stop: () => {
      conn.stop()
    },
    subscribe: (listener) => conn.subscribeDevices(listener),
    list: () => conn.getDevices().map(toDevice), // [] unless connected
    detail: async (id) => toDetail(await conn.api.detail(id)),
    screenshot: (id) => conn.api.screenshot(id), // Content-Type check + extractPng defence → Blob('image/png')
    retry: async (id) => {
      await conn.api.retry(id)
    }, // the connection polls once the re-check answered
    refresh: () =>
      conn.getStatus().phase === 'connected'
        ? conn.rescan()
        : ['absent', 'lost'].includes(conn.getStatus().phase)
          ? Promise.resolve(conn.pollNow())
          : Promise.resolve(),
    logs: (id, onLines, signal) => streamLogs(conn, id, onLines, signal),
  }
}
```

- `refresh()` in `off`, `denied`, `safari` or `dismissed` does nothing, so Refresh and the R key never cause an LNA prompt.

**`toDevice(d)`**

```ts
normalizeDevice({ ...d, backend: 'agent', model: d.model || iosModelName(d.modelId) || d.modelId })
```

`iosModelName` is used only for `platform === 'ios'`; `install` is always false.

**`toDetail(r)`** (`connectionLabel(r)`)

| Response | Formatter |
| --- | --- |
| Android | `androidDetail(r.outputs, r.serial, r.connection === 'network' ? 'Wi‑Fi (adb server)' : r.connection === 'simulator' ? 'Emulator (adb server)' : 'USB (adb server)')` |
| iOS device | `iosDetail(r.facts, r.facts.connection === 'network' ? 'Wi‑Fi (local helper)' : 'USB (local helper)')` |
| Simulator | `simulatorDetail(r.facts)` |

**`streamLogs`**

- A non-2xx response rejects with the mapped code.
- `lines` → `onLines`; `notice` → `onLines(['— ' + text])`.

| `end` reason | Result |
| --- | --- |
| `eof` | append "— The log ended.", then resolve (a log that stops over Wi‑Fi must not look frozen) |
| `replaced` | reject `STREAM_REPLACED`: this page aborts its own old stream first, so `replaced` means another tab took over |
| `device-gone` (with or without `code: 'DEVICE_DROPPED'`) | reject `DEVICE_GONE`, which the log session waits out (§7.8) |
| `shutdown` | reject `HELPER_UNREACHABLE` |
| `error` | reject the `code` |
| a body that closes with no `end` | reject `HELPER_UNREACHABLE` |
| watchdog | reject `HELPER_STREAM_STALLED` |

- Every rejection calls `pollNow()`.
- An abort resolves quietly, with no unhandled rejection, keeping the PR #9 guarantee.

**Errors**

- `HelperError.message` is the code when `DEVICE_ERRORS` has wording for it, else the helper's `message`, so `deviceErrorMessage` works unchanged.
- A network `TypeError` → `HELPER_UNREACHABLE`, plus `pollNow()`.

### 7.4 `model.ts`

```ts
export type Connection = 'usb' | 'network' | 'simulator'

/**
 * One row per device id. The mock lane never beats a real lane (its fixtures reuse real ids). A `held`
 * row means another program owns the USB interface, so any other lane listing the same id is the better
 * source whatever its state. Otherwise the more usable state wins; ties keep lane order.
 */
const mockRank = (d: Device) => (d.backend === 'mock' ? 1 : 0)
function better(d: Device, cur: Device): boolean {
  if (mockRank(d) !== mockRank(cur)) return mockRank(d) < mockRank(cur)
  if ((d.state === 'held') !== (cur.state === 'held')) return cur.state === 'held'
  return STATE_WEIGHT[d.state] < STATE_WEIGHT[cur.state]
}
export function mergeDevices(lanes: readonly (readonly Device[])[]): Device[] {
  const best = new Map<string, Device>()
  for (const lane of lanes)
    for (const d of lane) {
      const cur = best.get(d.id)
      if (!cur || better(d, cur)) best.set(d.id, d)
    }
  return sortDevices([...best.values()])
}
```

The existing test "lists a device two lanes can see once, from the first lane" still passes.

**New `DEVICE_HINTS`** (not in `parity.json`, so parity is untouched):

| Code | Title | Body | Fixes | Extra |
| --- | --- | --- | --- | --- |
| `XCODE_REQUIRED` | Screenshots need Xcode on this Mac | On iOS 17 and newer, the helper takes screenshots through Xcode. Install Xcode from the App Store, open it once, then retry. | Open check · Retry | Identifiers and logs work without it. |
| `XCODE_SETUP_REQUIRED` | Xcode needs to finish setting up | Open Xcode once and let it install its components, then retry. The environment check has the command if you prefer Terminal. | Open check · Retry | — |
| `IOS_DDI_REQUIRED` | Screenshots need Apple's developer disk image | iOS 16 and older need the image mounted on the device first, with the device unlocked. Connecting it to Xcode's Devices and Simulators window prepares it. Then retry. [I] | Retry · Open check | — |
| `IOS_LOCKDOWN_FAILED` | The device isn't answering | Unplug it and plug it back in with the device unlocked, then retry. Avoid USB hubs. | Retry | — |

`TUNNEL_REQUIRED`, `IOS_NETWORK_ONLY` and `IOS_LOCKED` keep their pinned copy. The first two have no emitter in v1; `IOS_LOCKED` is emitted only in the BFU case it describes (P37). An Android device on Wi‑Fi gets the same codes with Wi‑Fi wording (`WIFI_HINTS`: the TV remote, the same network), never "reseat the cable".

### 7.5 `DEVICE_ERRORS` additions (`backends/backend.ts`)

The design's list; `backend.ts` holds the shipped words. The contract test (§9.1) fails when a code the built helper can send has no wording.

| Code | Wording |
| --- | --- |
| `HELPER_UNREACHABLE` | The local helper stopped answering. Start it again; this page reconnects by itself. |
| `HELPER_UNAUTHORIZED` | The helper restarted. Open the new link it printed to pair this page again. |
| `HELPER_STREAM_STALLED` | The helper stopped sending the log. Start it again. |
| `DEVICE_NOT_FOUND`, `DEVICE_GONE` | The device is no longer connected. |
| `BUSY` | A screenshot of this device is already being taken. |
| `TOO_MANY_STREAMS` | Too many logs are open. Stop one, then start this one. |
| `TOOL_MISSING` | A required tool is missing. Open the environment check for the install command. |
| `TOOL_TIMEOUT` | The device took too long to answer. Try again. |
| `TOOL_FAILED` | The helper's tool failed. Try again, or reconnect the cable. |
| `IOS_UNTRUSTED` | Tap Trust on the iPhone first. |
| `IOS_LOCKED` | Unlock the device, then try again. |
| `IOS_DEVELOPER_MODE_OFF` | Developer Mode is off on this device. |
| `IOS_DDI_REQUIRED` | Mount the developer disk image first — see the note above. |
| `IOS_UNREACHABLE` | The device isn’t reachable right now. Unlock it, keep it on the cable (or the same Wi‑Fi), and try again. (It comes from lockdown and Wi‑Fi drops too, not only from Xcode.) |
| `IOS_LOCKDOWN_FAILED` | The device isn't answering. |
| `XCODE_REQUIRED` | Screenshots on iOS 17 and newer need Xcode on this Mac. |
| `XCODE_SETUP_REQUIRED` | Xcode needs to finish setting up. Open it once. |
| `SCREENSHOT_UNSUPPORTED` | This device cannot take screenshots. |
| `ANDROID_UNAUTHORIZED` | Allow USB debugging on the phone first. |
| `ANDROID_OFFLINE` | The phone is not answering adb. Reseat the cable. |
| `ADB_SERVER_STOPPED` | Google's adb server stopped. |
| `ADB_START_FAILED` | The adb server did not start. Open the environment check. |
| `LOGS_UNAVAILABLE` | No log source works for this device. |

Also worded: `HELPER_BAD_REPLY`, `HELPER_FOREIGN` (with "Start the helper on another port with --port."), `HELPER_STOPPING`, `UNAUTHORIZED`, `ANDROID_OFF`, `STREAM_REPLACED`, `BAD_REQUEST`, `INTERNAL`, `DEVICE_DROPPED`, the router codes (`BAD_ID`, `NOT_FOUND`, `METHOD_NOT_ALLOWED`, `PAYLOAD_TOO_LARGE`), and the Wi‑Fi codes. Only `BAD_HOST`, `BAD_ORIGIN` and `UPSTREAM_*` are exempt, because they never reach the page.

### 7.6 iOS detail and model names (`backends/ios.ts`)

**`iosDetail(facts, connectionLabel)`**, in Apple's own words. Empty values are `''`, which `DetailGroup` hides.

| Group | Fields |
| --- | --- |
| identity | Device name · Model (`iosModelName(ProductType)` or `ProductType`) · Model identifier · Model number (`ModelNumber + RegionInfo`, e.g. `MGLQ3LL/A`) · Serial · Identifier (UDID) · ECID (`fmtEcid`: `0x` and 16 uppercase hex digits, as Apple's tools print it) |
| software | iOS · Build · Developer Mode (`On`/`Off`/`''`) · Pairing (`Paired`; `Not paired` for `plaintext`) |
| hardware | Hardware model · CPU architecture · Capacity (`fmtDecimalBytes(TotalDiskCapacity)`, e.g. "256 GB") · Language · Locale · Time zone |
| status | Battery (`87% · charging`) · Available (`iosAvailable(disk)`: `AmountDataAvailable` as "40.3 GB free", then " · up to 161 GB as iOS clears caches" from `TotalDataAvailable` when that rounds to more; one figure when only one is known; see the storage note below) · Lock (`Locked`/`Unlocked`) · Connection (label) · `Details note` |

**Storage.** The first build showed `fmtDecimalBytes(TotalDataAvailable ?? AmountDataAvailable)` as "Available", which on the test phone read 161 GB against Settings' 74.41 GB (§3.5). No key equals Settings' figure, so the row shows what each key is: `AmountDataAvailable` as what is free now, and `TotalDataAvailable`, if shown, as the most iOS can free, never under Settings' word "Available" alone. `backends/ios.ts` and its tests are the authority on the exact labels.

`Details note`:

- When `withheld` is non-empty: "Unlock the device to read battery and storage."
- For `source: 'plaintext'`: "Only the basic identifiers are available; the environment check says why."

`fmtDecimalBytes` uses 1000-based units, at most 3 significant figures, and integer GB for capacities ("256 GB"), matching Settings → General → About.

**`simulatorDetail(facts)`**

- identity: Device name, Model (device type), Model identifier, Identifier.
- software: iOS, Build.
- status: Storage (`<fmtBytes(dataPathSize)> used`), Connection `Simulator`.

**`iosModelName(modelId)`** reads `ios-models.json` (safe against prototype keys), generated by `node scripts/ios-models.mjs`:

```
/usr/bin/sqlite3 -json -readonly <Xcode>/Contents/Developer/Platforms/iPhoneOS.platform/usr/standalone/device_traits.db \
  "select distinct ProductType, ProductDescription from Devices"
```

The output is deduplicated and sorted. The script exits 1 with a message when Xcode is missing; `--check` (not in `verify`, because it needs Xcode) exits 1 when the file is stale. The file is committed and regenerated when Xcode updates. Newer devices fall back to the identifier.

### 7.7 Page wiring (`device-lab-page.tsx`)

```ts
function createLabAndHelper() {
  const env = resolveHelperEnv(
    window.location,
    window.DVC_BOOT,
    { pairPort: pending?.port ?? null, tokenPort: stored?.port ?? null, port: readStoredPort() },
    navigator.userAgent,
    navigator.vendor,
  )
  const helper = createHelperConnection(env)
  const lanes: Backend[] = [createWebUsbBackend(), createAgentBackend(helper)]
  if (isMock()) lanes.push(createMockBackend()) // last; the merge rule makes it lose anyway
  return { lab: createDeviceLab(lanes), helper }
}
const [{ lab, helper }] = useState(createLabAndHelper) // constructors side-effect free (StrictMode)
const status = useSyncExternalStore(helper.subscribeStatus, helper.getStatus, helper.getStatus)
```

- **Header:** the static "Helper not detected" badge is replaced by `<HelperChip/>`.
- **Gate:** `<Gate helper={status} helperOn checklist/>`.
- **Notice:** `<HelperNotice/>` above the grid when devices exist.
- **Pair:** `<PairDialog/>`. **Wi‑Fi:** `<WifiDialog/>` over `wifi.ts`.
- **Environment check:** gets about rows, the checklist and the Remember control (§12).
- **Effects:**
  - Announce `connected` and `lost` transitions once.
  - Toast on `lost`.
  - Start a 4 s timer per iOS capture for the slow toast.
  - A pairing link opened in this tab pairs it (`takePairFragment`).
- **The `add()` toast** for `WEBUSB_UNSUPPORTED` regains "…Use Chrome or Edge, or the local helper."
- If the only device's log is waiting for it to come back, the page does not fall back to the Gate meanwhile.

### 7.8 `LogConsole` and log sessions

**Levels** (`components/log-level.ts`; computed once when a line arrives)

```ts
const LOGCAT = /^\S+\s+\S+\s+\d+\s+\d+\s+([VDIWEF])\s/ // unchanged
const SYSLOG = / <(Notice|Info|Debug|Warning|Error|Fault|Critical|Alert|Emergency)>: /i // pymobiledevice3 writes <NOTICE>
const SIM = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+ (Df|Db|I|E|F|A)\s/
export function logLevel(line: string): 'E' | 'F' | 'W' | 'D' | ''
```

| Source    | E     | F                                 | W       | D (muted)   | default |
| --------- | ----- | --------------------------------- | ------- | ----------- | ------- |
| logcat    | E     | F                                 | W       | D, V        | I       |
| syslog    | Error | Fault, Critical, Alert, Emergency | Warning | Info, Debug | Notice  |
| simulator | E     | F                                 | —       | Db, I       | Df, A   |

The description is "syslog" / "simulator log" / "logcat" (from the device's platform and connection), followed by ", newest at the bottom · N lines". `LOG_LIMIT` stays 2,000 (iOS volume is risk R5).

**Log sessions** (`log-sessions.ts`). A log used to live inside its `LogConsole`, so a device that dropped off for a moment unmounted the console and took the log with it: the tester came back to "Press Start" and no word of what happened. A session now outlives its console, and a drop is part of the log:

- The stream ends because the device stopped being ready or the lane said so (`DROP_CODES`: `DEVICE_GONE`, `DEVICE_DROPPED`, `DEVICE_NOT_FOUND`, `DEVICE_NOT_READY`, `DEVICE_DISCONNECTED`, `IOS_UNREACHABLE`, `IOS_LOCKDOWN_FAILED`, …) while its row is still listed. The log says when ("— Lost the connection to <name> at 14:05:12. The log picks up again by itself if it’s back within 2 minutes."), and a screen reader hears it.
- The window (`RESUME_WINDOW_MS`, 120 s) is the helper's hold of a Wi‑Fi iPhone (`IOS_TUNING.wifiHoldMs`, §3.9); a test reads the helper's value so the two can't drift. The same device back and ready within it: the log starts again by itself and says "is back. The log resumed". The listed device is retried with the backoff of 1, 2, 4, then every 8 s, the last try 1 s before the window ends (`LAST_TRY_LEAD_MS`, at 119 s), because a Wi‑Fi link can come back without the row ever leaving the list.
- The row leaves the list (while the log runs, while it waits, or as the stream ends; a pulled cable, or the page losing the helper): the log stops at once and says so ("— <name> left the device list at 14:05:12, so the log stopped. Press Start once it’s connected again."). The `gave-up` event carries `reason: 'unlisted'`.
- The window passes: "— <name> didn’t come back within 2 minutes, so the log stopped. Press Start once it’s connected again." (`reason: 'window'`).
- Stop (or Disconnect) is always the tester's: a stopped log never comes back on its own. One log per tab, as before.
- Anything else (too many logs, no log source, a replaced stream) is a failure the tester has to see, not a drop to wait out.
- The page waits exactly as long as the helper holds a Wi‑Fi iPhone (R15, retired).

---

## 8. Security model and threats

**Principle**

- Local programs can already reach phones through `/var/run/usbmuxd` (mode `srw-rw-rw-` [V]) and adb's `127.0.0.1:5037`.
- The new exposure the helper creates is to **web pages**, so its controls are layered against the web, in this order: loopback only → Host allowlist → Origin allowlist → the browser's LNA → CORS → bearer token → strict ids → allowlisted protocol requests → argv-only spawns with caps, timeouts and group kills.
- The token also keeps other macOS users and sandboxed apps away from what the helper adds.

| # | Threat | Mitigation | Residual |
| --- | --- | --- | --- |
| T1 | LAN or Wi‑Fi attacker | `listen(port, '127.0.0.1')` only; the LAN IP is refused [V test] | — |
| T2 | DNS rebinding | Exact Host allowlist before routing → 421; URLs are never built from Host except the allowlisted `apiBase` | — |
| T3 | Malicious site in Chrome or Firefox | LNA is granted per site; Origin allowlist (403, no ACAO); token required; no `*`, no credentials | — |
| T4 | Malicious **http** site in Safari (no LNA; http → loopback allowed [V]) or in Firefox | Origin check; Fetch Metadata 403; every state-changing route needs `Authorization`, which forms and no-cors cannot send; no WebSocket (upgrades destroyed); CORP `same-origin`; bodies only as `application/json` with a `Content-Length` | Can detect that a server listens (timing) |
| T5 | Other macOS users or sandboxed apps | 256-bit token, constant-time compare; per-run by default; the kept-token file is 0600 in a 0700 directory, and symlinks and foreign owners are refused | Same-user malware is out of scope (it can run the tools directly) |
| T6 | Form or no-cors CSRF | No GET changes state; POSTs need Bearer | — |
| T7 | Port squatting and relay (a fake helper, a crafted `#pair=…&port=9999`) | Token bound to its port; no token is sent before a **port-bound HMAC proof** (§2.8); a crafted link only pairs the page with the attacker's own token (UI spoof only); a link whose port answers nothing, or not as the helper, is spent, so it can't hold the tab on that port across reloads (§6.5); on the helper's own page nothing is remembered and a kept token stays in memory, since the next program on the port owns that origin and its storage | With `--keep-token`, a squatter that binds the port between two polls after the real helper exits could receive the kept token on the next poll. Documented; per-run default; `--new-token` rotates. |
| T8 | Token in a URL, argv or the terminal | Fragment only (never sent to servers [V]); stripped before the router; `Referrer-Policy: no-referrer`; auto-open passes the link to `osascript` on stdin, never in argv (§1.7); never in served HTML [V test], logs, Doctor rows or "Copy as text" (which also strips any bare 43-character token) | Browser history and terminal scrollback keep the per-run link. Usable only from this Mac while that run lives. One-time codes are the v1.1 hardening. |
| T9 | XSS on bauloc.github.io (shares the origin with `xconsole_pat`) | sessionStorage by default; its own key; device strings rendered as text only (no `dangerouslySetInnerHTML`) | An XSS can drive attached phones while the helper runs |
| T10 | Command or option injection | Strict id patterns (no leading `-`) **and** registry membership; `spawn(file, argv)`, never a shell; adb `exec:` strings are constants (`ADB_EXEC`); absolute tool paths; relative PATH entries ignored [V] | — |
| T11 | Protocol misuse on the device | Code allowlists `LOCKDOWN_REQUESTS`, `LOCKDOWN_SERVICES`, `MUX_MESSAGES`, `DEVICECTL_COMMANDS`, `ADB_EXEC`, `ADB_HOST_SERVICES`, and "never sent" lists, all asserted by tests | — |
| T12 | The LNA grant is **origin-wide** | Once allowed, every page on bauloc.github.io, XConsole included, can reach every loopback service on the Mac, not only the helper. The helper still requires its token. The Environment check says so; local mode avoids the grant. | Other loopback services the user runs |
| T13 | Local-mode proxy abuse | Fixed upstream; strict path regex; off-site redirects → 502; never reads disk [V]; caps and timeouts; inline-script hashes; `frame-ancestors 'none'`; `X-Frame-Options: DENY`; `sandbox` CSP on assets | Same trust as hosted mode |
| T14 | Resource exhaustion | `maxConnections` 64; tool limiter 4; per-device single-flight; one Wi‑Fi dial per host; at most 3 log streams; caps; timeouts; body ≤ 1 KiB | A local DoS needs a restart |
| T15 | Orphan processes | `detached` groups; kill on timeout, abort, client gone and shutdown; synchronous `exit` hook; grandchild reaping tested [V] | — |
| T16 | Privilege | Refuses root; never runs sudo; sudo commands are only shown for the user to copy | — |
| T17 | Pair-record secrets | In memory only, and only the fields TLS needs; TLS uses in-memory PEM (no temp files); never logged or returned; `--doctor` prints shapes only | — |
| T18 | Device privacy | Whitelists apply pre-session and in-session (§3.5); no MAC addresses, IMEI, phone number, ICCID or IMSI; no telemetry; `--verbose` never prints headers, queries or tokens; `--doctor` never prints device names | Log contents reach paired pages by design |
| T19 | Unwanted device effects | Never Pair, no auto-pairing tools on untrusted devices, no Developer Mode toggles, no DDI automation; adb started only on a click and never killed; Wi‑Fi connect, pair and disconnect only on a click | — |
| T20 | Lockdown TLS over Wi‑Fi | usbmuxd (root-owned) carries both USB and Wi‑Fi; the peer certificate is pinned to the pair record's `DeviceCertificate` and enforced (G25) | — |
| T21 | Tampered download | HTTPS; `curl -fsSL` refuses to save a 404 page [V]; "Review the source" link; the Environment check compares SHA-256 and VERSION with the published file | Trust in GitHub Pages |
| T22 | The Wi‑Fi routes as a way into the local network (a paired page makes the adb server dial addresses) | Bearer, Origin and the rest of §2.1 first; LAN-only addresses (private, link-local and CGNAT IPv4, ULA and link-local IPv6, `.local`/`.lan`/`.home.arpa` names), never loopback or public; names resolved and every address checked before adb sees them; ports as integers, codes as six digits; one exact string per service; one dial per host at a time; the pairing code never printed | adb resolves a name again, so DNS that changes between the two lookups is not caught; a paired page can make adb try `host:port` pairs on the LAN, one at a time, which is what the feature is |

---

## 9. Testing

### 9.1 Page (Vitest; node environment unless a test needs the DOM)

| File | Covers |
| --- | --- |
| `helper/env.test.ts` | Hosted, local and dev resolution; `:7360` and `:8000` stay hosted; `DVC_BOOT` with a mismatched origin → hosted; port precedence and range; `?api=`/`?port=` ignored; Safari detection on the legacy UA samples |
| `helper/pair-fragment.test.ts` | Valid and invalid tokens and ports; stash and strip; Safari forward URL; non-device paths untouched; a second call does nothing; a link opened in a running tab |
| `helper/token.test.ts` | Session default; remember; storage events; memory fallback; port binding; `tokenIdOf('example-token') === '4d1566a1'`; `proofOf` equals a Node `createHmac` vector |
| `helper/protocol.test.ts` | Guards reject wrong types, cap strings, filter blockers, map unknown states; the Wi‑Fi replies |
| `helper/client.test.ts` | NDJSON split across chunks and mid-UTF-8; bad line skipped; 1 MiB line cap; watchdog; abort resolves with no unhandled rejection; non-PNG → `SCREENSHOT_NOT_PNG`; error-body rules; the Wi‑Fi routes |
| `helper/connection.test.ts` | Fake `fetch`, timers, permissions and visibility. §6.3 table (no request for `prompt` without intent); one probe at a time; `promptLikely`; the 1 s dismissed rule; backoff schedules (exact timings); `tokenId` mismatch → `stale` and **no `Authorization` header ever sent**; proof failure → `foreign` and nothing sent; a pending candidate never overwrites a working token; 401 → `stale`; 2 failures → `lost`; hidden → 10 s; `rev`/`runId` gating; start → stop → start uses the pending pair once and leaves no timers; doctor cache and its drop on a lane change; feature gates |
| `helper/status.test.ts` | Every phase yields its chip, card and notice text (§6.8) |
| `helper/network.test.ts`, `wifi.test.ts` | The Wi‑Fi input rules against the helper's; Recent; connect, pair, disconnect state |
| `helper/real-helper.test.ts` | The **built** helper in-process: the proof equals the helper's HMAC and is bound to the port; list, detail, PNG, NDJSON, doctor; a 409 with state and blockers; pairing through `#pair=` sends no token before the proof; hot-plug; stop → `lost` |
| `preflight/checks.test.ts`, `copy.test.ts`, `env.test.ts` | §12e page half; one test fetches `/api/doctor` from the real built helper and merges it |
| `backends/agent.test.ts` | `toDevice` (model map, simulator connection); detail routing and connection labels; screenshot type check; log `end` mapping; `refresh()` never probes in `off`/`denied`/`safari` |
| `backends/agent.contract.test.ts` | Imports the built helper. Asserts: `ADB_DETAIL` equals `DETAIL_COMMANDS` joined with spaces, in order; `PROTOCOL` is in `[DVC_MIN_AGENT, DVC_MAX_AGENT]`; every `EMITTED_BLOCKERS` code has `DEVICE_HINTS` wording; every `HelperError(...)` and `errorBody(...)` code in the built file has `DEVICE_ERRORS` wording (except `BAD_HOST`, `BAD_ORIGIN`, `UPSTREAM_*`); `_app/helper/test/fixtures/pixel-9.json` equals `DETAIL_FIXTURES['pixel-9']`. Then drives the real backend through `createDeviceLab`: proof → devices → detail (Android equals parity except Connection) → screenshot Blob → logs (eof, abort, `DEVICE_GONE`) → locked row → `BUSY` → Refresh → close → `lost`. |
| `backends/ios.test.ts` | `iosDetail` on full, withheld, plaintext and iOS 15 (`developerMode: null`) facts; decimal capacity "256 GB"; `simulatorDetail`; `iosModelName` |
| `store.test.ts` | WebUSB `held` vs agent `ready` → agent; WebUSB `offline` vs agent `ready` → agent; WebUSB `ready` vs agent `offline` → WebUSB; tie → lane order; mock `ready` vs agent `untrusted` → agent; detail re-read on a blocker change |
| `log-sessions.test.ts`, `components/log-console.test.ts` | Drops, the resume schedule (a device back at 28 s resumes), give-up, Stop; `logLevel` on logcat, syslog and simulator samples |
| `components/*.test.tsx`, `device-lab-page.test.tsx` | Chip, card, notice, pair dialog, Wi‑Fi dialog and add menu, Gate, Environment check, detail pane; the page against a fake `HelperConnection` |
| `parity.test.ts` | Unchanged; `androidDetail` with two arguments still equals `parity.json` |

### 9.2 Helper suite (Vitest, `npm run test:helper`; Node 20 and 24; no network)

**Layout**

- `_app/helper/test/*.test.ts`, run by `helper/vitest.config.ts`: node environment, `pool: 'forks'` (the tests spawn real fake tools and send signals, and the helper installs a process-wide `exit` hook, so each file gets its own process).
- Files: `util`, `process`, `cli`, `auth`, `registry`, `http`, `operations`, `logs`, `local-mode`, `lifecycle`, `banner`, `build`, `context` (core); `ios-codec`, `ios-clients`, `ios-lane`, `ios-screenshot`, `ios-logs` (iOS); `android`, `mdns`, `nearby`, `system-resolver`, `simulators`; `tools`, `preflight`; and the opt-in `android-real`, `simulators-real`.
- Every test builds its bridge with `createBridge({port: 0, searchPath: fakeBin, extraDirs: [], usbmuxdSocket, adbPort, upstream, xcodeSelectPath, plistBuddyPath, javaHomePath, applicationsDir, coreDeviceDir, coreSimulatorDir, home, open: false, timeouts: short})`, or a fixed Toolbox, so no real tool can leak in.
- `test/build.test.ts` checks the built file: shebang and header first, the Node 18 denylist, the exports.

**Fakes (`_app/helper/test/fakes/`)**

- **`bin.ts`** writes `#!/bin/sh` tools that read a scenario file and append their argv and PID to `calls.log`, one line per write so parallel tools never interleave. A "sleeper" variant keeps a grandchild holding stdout. Tools: a fake Xcode tree (wrapper `devicectl` with `EXPECTED_VERSION` and `exec "<fake CoreDevice>/devicectl"`; a fake real `devicectl` that writes fixture JSON to `--json-output` and a PNG to `--destination`; `simctl` wrapper and real binary); `xcode-select`, `PlistBuddy`, `xcodebuild`; `ideviceinfo`, `idevicesyslog`, `idevicescreenshot`, `pymobiledevice3` (+ fake python), `adb` (`version`, `start-server`), `java_home`, `java`, `bundletool`.
- **`mac.ts`**: a fake Mac for the preflight and tools suites (Xcode tree, PlistBuddy, frameworks, Python, JDK, Homebrew).
- **`usbmuxd.ts`**: a Unix socket speaking the 16-byte framing (the helper's own codec). `ListDevices`; `Listen` with scripted `Attached`/`Detached`/`Paired`; `ReadPairRecord` (record or `Result 2`); `ReadBUID`; `Connect` piped to in-process fake devices by port; it closes the pipe on `Detached`, like the real one.
- **`lockdownd.ts`**: the fake phone, plus `startIosRig()` for the lane suites.
  - Plaintext `QueryType`/`GetValue` (the 26 USB keys, including `WiFiAddress`, `BasebandSerialNumber` and `DieID`).
  - `StartSession` modes: trusted, `InvalidHostID`, `PasswordProtected`, TLS reset, slow.
  - Server-side TLS with `requestCert: true`. Session `GetValue` includes IMEI, `PhoneNumber` and a `UniqueChipID` above 2^64−2^53. Domains, amfi, and syslog_relay on a service port (NUL-framed text, inner newlines).
- **`certs.ts`**: at suite start, `/usr/bin/openssl` (LibreSSL 3.3.6 [V]) builds two RSA-2048 SHA-1 chains: **empty-name** (`-subj "/"`, like real records [V]) and **named**. The client must connect with both. TLS tests skip when openssl is missing. No private key is committed.
- **`adb-server.ts`**: TCP on port 0: `host:version`, `track-devices-l` (the test pushes lists: unauthorized, offline, recovery, `no permissions (…)`, emulator, `ip:port`, mDNS serial), `devices-l`, transport + the `ADB_EXEC` commands from fixtures, screencap (warning + PNG + trailing text), endless logcat, `reconnect-offline`, `FAIL` cases, and the network side: `addNetworkDevice`, `connectAnswer`, `accept`, `refuse`, `drop`, `shield()`; a TV that has not allowed this Mac answers "failed to authenticate to X" and is listed `unauthorized`, as adb 36 does.
- **`mdns.ts`**: a fake local network for the mDNS browser, no socket: `fakeMdnsNetwork()` answers each query with real DNS packets (name compression; legacy-unicast style with the query's id, its question and TTL ≤ 10 s, or multicast style with id 0, cache-flush bits and NSEC); `braviaTv()` and `pixel9()` are the two devices measured on 2026-10-04; `sendError`/`openError` play a blocked or absent network; `silentMdns()` is every isolated bridge's network. `adb-server.ts` answers `host:mdns:services` with `mdnsServices`.
- **`dns-sd.ts`**: a fake `dns-sd` and a fake `avahi-browse` written into the bin directory (`fakeDnsSd`, `fakeAvahiBrowse`), answering by argument from fixtures, optionally after a delay, then running on as the real dns-sd does (or exiting with a code and stderr). `REAL_PIXEL` and `REAL_CAST` are byte for byte what the real dns-sd printed on the owner's Mac on 2026-10-04; `browseOutput`, `resolveOutput`, `lookupOutput` write the same formats.
- **`upstream.ts`**: gzip-encoding HTTP server with ETag/304; `/device/` has an inline theme script **and** an inline script with attributes; `/assets/x.js`, `/assets/i.svg`.
- **`lane.ts`**, **`devices.ts`**: scriptable fake lanes and rows, also used by `helper:fake` and the page's real-helper tests.

**Fixtures (`_app/helper/test/fixtures/`, kept byte-exact by `.prettierignore`)**: devicectl envelopes (`success`, `4016`, `1001`, `1000`, `timeout`, `lockstate`) with private paths removed; `pixel-9.json` (a copy of `DETAIL_FIXTURES['pixel-9']`); sanitized and trimmed `simctl` lists.

**Cases**

| Area | Cases |
| --- | --- |
| core | Loopback-only (LAN IP refused); Host 421 via raw `http.request` (Node `fetch` drops a custom Host [V]); Origin 403 for unknown, `null`, `http://bauloc.github.io` and `https://bauloc.github.io.evil.example`, with no ACAO; `--dev` origins only with the flag; Fetch Metadata 403 plus the navigation exception; preflight (with and without the PNA header); health has `tokenId` but never the token; **proof** equals a reference HMAC and changes with the port; challenge validation; 401 variants (missing, short, wrong, wrong scheme) readable with CORS; 413 (large, chunked, malformed length); `upgrade` destroyed; ids (`--help`, `-u`, `..`, `%2e%2e`, `a b`, malformed `%`, unlisted UDID, IPv6 serial); `rev`/`runId`; stream caps (4th → 429; same device → `replaced`); ping cadence; back-pressure pause and resume; client abort reaps group and grandchild; local mode (boot before the first script, CSP hashes cover every inline script, no copied encoding, correct length, **token absent from HTML**, assets immutable plus `sandbox` CSP, redirects, traversal → 302, favicon 404, offline last-good copy); `--keep-token` (0600 created; group-readable, symlink and foreign owner refused; `--new-token`); port-in-use messages (our helper vs another server); root refusal; SIGINT → `end:shutdown`, groups dead, exit 0, second signal 130; `--verbose` never prints Authorization or queries; "Page connected" wording; banner waits for lanes; Node-18 API denylist; no abort-listener warning from `linkSignals` on Node 18 or 20; BigInt replacer |
| ios | Plist round trip (BigInt, data, date, real); `Attached` → `ready` within 500 ms; no record → `untrusted`; record appears via the 3 s `ReadPairRecord` poll → `ready`; `Paired` → re-probe; `InvalidHostID` → `untrusted`; TLS reset → `untrusted`; `PasswordProtected` on `StartSession` → `locked`; AFU (`PasswordProtected: true` in session) → `ready`, `locked: true` in detail; Developer Mode false → blocker + `screenshot:false`; iOS 15 → `developerMode: null`, no amfi request; **whitelists** (no IMEI, PhoneNumber, WiFiAddress, DieID, BasebandSerialNumber in any response); `UniqueChipID` as a decimal string; **TLS succeeds on both certificate chains with the §3.3 options, and a synchronous throw is caught** → `ideviceinfo` fallback or plaintext + `TOOL_MISSING`; pin mismatch ends the session; devicectl success plus every `classifyDevicectl` case; **wrapper never executed** (first-launch mismatch → `XCODE_SETUP_REQUIRED` and the real binary never spawned); `idevicescreenshot` and `screenshotr` → `IOS_DDI_REQUIRED`; nothing applies → `XCODE_REQUIRED`/`TOOL_MISSING`; syslog_relay framing, batching, `device-gone` on detach, abort closes the service socket within 100 ms; 8 s silence → `idevicesyslog` with a notice; Wi‑Fi entry ignored without `--wifi`; with it: 2 s for a new entry, none for a returning one, 120 s hold, a cut link before or after `Detached` keeps a ready row ready, a dropped log ends `DEVICE_DROPPED`, "real rhythm" replays of the measured presence; usbmuxd restart → reconnect and resync; non-phone `DeviceClass` ignored; allowlists (sending `Pair` throws) |
| android | No server → `stopped`, **no adb process spawned at startup**; tracker rows and the state map; identity cache per `transport_id`; a listed phone turning ready changes in place; detail outputs byte-equal to the fixtures; screencap PNG extraction; logcat stream and abort closes the socket; `FAIL` mapping; `reconnect-offline` on Retry; server dies → rows cleared, `ADB_SERVER_STOPPED`; start-server spawns exactly `['start-server']` with ignored stdio, untracked, and waits for `host:version`; `ADB_START_FAILED` after 8 s; `ADB_EXEC` contains only constants; `ADB_HOST_NEVER` refused both ways; Wi‑Fi: host, port and code parsers, adb's reply texts, connect → Allow → ready with detail, screenshot and logs, every failure `reason`, pair, disconnect (mDNS and loopback refused), IPv6, 400 before anything is sent, names resolved (loopback and public answers refused), `BUSY`, server stopped, `--no-android`, a TV that leaves (socket hung and socket closed) |
| discovery | Codec: the TV's answer written byte by byte, QU queries, escaped labels, RFC 5952 addresses, hostile names (pointer loops, forward pointers, overruns, reserved labels, 256 bytes, labels that are not UTF-8, every lead byte against each range's edges as the decoder judges them), counts not trusted, every truncation and 6,000 corrupted packets without a throw; browse: TV and Pixel complete, follow-up SRV/TXT/A for a PTR alone, multicast answers taken and foreign ids dropped, PTR shape, goodbyes, `max`, abort, each errno → `blocked`/`no-network`/`failed`; an instance or host whose name could not be asked about dropped, with nothing thrown from the follow-up timer; a transport handing over a non-packet or throwing from `send` throws nothing out of a callback; a type that cannot be written refused before a socket opens; the real UDP transport against a responder on 127.0.0.1, ENETDOWN and EADDRNOTAVAIL sending nothing; only local addresses offered; Cast name before Remote name; adb's list parsed; connected/paired/deviceId by address, mDNS name, same host and USB serial; dedupe, order, cap; terminal and doctor lines; the endpoint: shape, no server → no adb request, cache/gap/one-at-a-time, merged with adb's list as it is now, blocked with adb's finds and printed once, bearer/Origin/405, `?refresh=1` to the lane, `ANDROID_OFF`, `android.discover` |
| system resolver | dns-sd's `-B`/`-L`/TXT/`-G` lines from the owner's Mac and hostile ones (headers, junk, wrong domain or type, ports out of range, bad escapes, `No Such Record`, IPv6); presentation names (`\032`, `\.`, UTF-8); avahi's `+`/`-`/`=` lines, a `;` in a name, quoted TXT, a type with `(`, `[` or `+` found as text; TXT details and API → Android version; browsing the owner's network through a fake dns-sd (the exact argv, each host looked up once, every process gone afterwards); a resolve that never answers and a lookup past its deadline cut off; 16 Cast entries whose `-L` never answers, with and without a cap of 4, while the Pixel still resolves; a dns-sd that ignores SIGTERM ending the run on its deadline and freeing its slot; avahi's per-group cap; slow answers inside it kept; `Rmv`; options, oversized names, foreign answers and non-`.local` hosts never passed on; two devices on `Android.local` get no address; caps; a dns-sd that fails at once did not look, a missing one never runs, a silent one looked; abort; no MaxListenersExceededWarning from a dns-sd or avahi run, with every AbortController capped at 10 as on Node 18 and 20 (`listenerWarnings`, `harness.ts`); avahi: IPv4 only, no daemon, hanging, removal; which tool per platform; merging: blocked + resolver looked → `note` and no `error`, no resolver → `blocked` as before, each source's finds once, TXT names filled in, dedupe by serial (same host, or adb's list), two boxes sharing a serial or a junk one kept apart, local-address rules and cap; both sources failed → the resolver's words in `error.detail`, the terminal and `--doctor`; the endpoint and `--doctor` with dns-sd while the helper's queries are blocked |
| simulators | List join; filter iOS runtimes; screenshot refused when not Booted (no hang); `-` never used; compact log header and stderr dropped; grandchild reaped on abort; first-launch gate (CoreSimulator older) → `unavailable` |
| tools, preflight | §12e matrix |

**Opt-in real runs** (`DEVICE_BRIDGE_REAL=1`: `android-real.test.ts`, `simulators-real.test.ts`)

- With booted simulators: list, detail, screenshot, first log batch < 3 s, no `simctl`/`log` process after abort.
- adb `host:version` only; skipped when refused, never starts a server.

### 9.3 Simulators and UI without phones

- `npm run helper:fake` + `npm run dev`: the **built** helper on 8787 with `--dev`, the suite's fake lanes, fake usbmuxd and fake adb server. Nothing on the Mac is run: the PATH is empty and the Toolbox fixed. It prints the dev pair link and the token. Flags: `--port`, `--token`, `--source` (run `helper/src` instead of the bundle), `--local-from <origin>` (local mode from a dev build), `--helper <file>` (run another built helper, such as `git show 6ecedd0:device/agent/device-bridge.mjs`, the 1.0.0 from before discovery, to see what the page says to an older helper), `--no-android` (no Android lane, so no `android.*` features). stdin commands:
  - `plug`/`unplug ios|android|sim` (an unplug ends a running log like a real drop), `trust on|off`, `lock bfu|afu|off`, `devmode on|off`, `xcode ready|missing|setup`;
  - `adb on|off|missing`, `android ready|auth|offline`, `simulators on|off`;
  - a fake "Living Room TV" at 192.168.1.42:5555: `tv answer ok|refused|unreachable|timeout|slow`, `tv allow|deny|drop|back|forget`, `tv pairing on|off` (prints a code and a pairing port);
  - `status`, `help`, `quit`.
- `node device/agent/device-bridge.mjs --dev --simulators` + `npm run dev`: real simulators through the hosted logic at `localhost:7360`.

### 9.4 Browsers

**Scripted** (headless Chrome, a throwaway profile):

1. `Browser.setPermission loopback-network granted` → pair via `#pair`, list, screenshot, log Start/Stop.
2. `denied` → phase `denied`, no request reaches the helper.
3. Local mode `http://127.0.0.1:<port>/device/#pair=…` → **zero CSP violations** (with the asset `sandbox` CSP), same-origin API, no LNA.
4. The Wi‑Fi flow against `helper:fake`: connect, Allow, Show, a drop and the log resuming, Disconnect.

Every UI state was also captured in light and dark, at 1440 and 390 px.

**Manual** (§9.6): headed Chrome prompt; Firefox; Safari local mode.

### 9.5 Phase 0 (with the test phones, before the dependent code was merged)

| # | Check | Decides | Result (2026-10-04) |
| --- | --- | --- | --- |
| P0-1 | usbmuxd USB `Properties`; does `Listen` replay attached devices; does `Paired` fire after Trust | §3.2 merge logic | **Open**: the iPhone was only ever on Wi‑Fi during the build. The code merges `ListDevices` after every `Listen` either way. |
| P0-2 | A read-only lockdown probe with the §3.3 options: plaintext key count, `StartSession`, TLS protocol and cipher, `PasswordProtected` locked and unlocked, domains, amfi | Native lockdown go/no-go | **Go over Wi‑Fi**: 8 plaintext keys; session with the existing pair record; TLS 1.2 `ECDHE-RSA-AES256-GCM-SHA384`; 84 session keys; battery, disk, international and amfi answered. **USB:** the built helper's USB row, detail, screenshots and syslog worked in the afternoon run (§9.7); the 26-key plaintext read was not re-checked. |
| P0-3 | syslog_relay: after `StopSession` and closing lockdown, does the service keep streaming? | §3.3 "close after connect" | **Yes**: 800 and 450 lines in 4 s, first batch after 0.24–0.26 s |
| P0-4 | BFU: restart the phone, don't unlock, plug in → `StartSession` / `GetValue` errors | `locked` mapping; `IOS_LOCKED` copy stays or changes | **Open** |
| P0-5 | `devicectl device capture screenshot` on the real iPhone: first and second call; AFU-locked behaviour; error texts (Developer Mode off only with the owner's OK: it reboots) | **Gate:** if capture cannot work, the tunnel lane (§3.12) moves into v1 | **Works** (over Wi‑Fi): 1170×2532 PNG, 2.2 s first, 0.8–1.0 s after; a PNG while locked after first unlock. The tunnel lane stays in v1.1. |
| P0-6 | Does lockdownd present the pair record's `DeviceCertificate` (DER equal)? | **Gate:** enforce pinning | **Yes**, three runs out of three. Pinning is enforced (G25). |
| P0-7 | A Pixel with the Chrome tab closed: `adb start-server`; `host:track-devices-l` lines, `host:transport` + `exec:getprop`, `exec:screencap -p`, `exec:logcat` then close, `host:reconnect-offline`; then `adb kill-server` and WebUSB Reconnect | §4.2 fixtures; retry command | **Open** for a Pixel on USB (needs someone allowed to run adb). An already running server answered `host:version` (protocol 41) and `host:devices-l`. Over Wi‑Fi, an Android 10 TV went through the tracker (unauthorized → ready in place), `exec:getprop`, `exec:screencap -p` and `exec:logcat` through the built helper (§9.7). |
| P0-8 | Untrusted flow (only with the owner's OK: Reset Location & Privacy): does macOS prompt by itself? `Paired` event? | **Gate:** whether "Ask to trust" is needed | **Open** |
| P0-9 | Headed Chrome: prompt timing, Dismiss vs "Never allow", `permissions.query` after each | The 1 s `dismissed` rule | **Open** |

### 9.6 Real-device checklist (after the build; paste `--doctor` output into the PR)

**iPhone (iOS 27, `<UDID>`)**

| # | Step | Expected |
| --- | --- | --- |
| 1 | `node ~/device-bridge.mjs` (Chrome default) | One tab opens; Allow; chip "Helper ready"; fragment gone from the URL; terminal "Page connected"; `lsof` shows only `127.0.0.1:8787` |
| 2 | Plug in unlocked | Row in about 1 s with the device's name (non-ASCII characters such as `’` intact), iOS 27.0, Ready; announced; auto-selected |
| 3 | Detail vs Settings → General → About | Model "iPhone 12 Pro", iPhone13,3, serial, UDID, build, Developer Mode On, Capacity in decimal GB, the storage figures labelled as in §7.6 (none equals Settings' Available), battery %, Lock, "USB (local helper)" |
| 4 | Screenshot twice | 1170×2532 PNG; second call faster; Copy and Save work; slow toast after 4 s on the first |
| 5 | Lock (AFU), then detail, logs, screenshot | Detail and logs keep working; a screenshot gives a PNG or an `IOS_LOCKED` toast, never a hang; with the screen off the PNG is black and Device Lab says why (§3.7) |
| 6 | Logs Start/Stop | Lines within 1 s; levels coloured; Stop leaves no child (`ps`) and no console error |
| 7 | Unplug mid-log and mid-screenshot | "The device disconnected."; row gone; the log waits, then stops; no orphans |
| 8 | (owner OK) Developer Mode off | Hint; screenshot disabled with tooltip |
| 9 | `--wifi` | Wi‑Fi badge; the row stays through the phone's usual absences; logs over Wi‑Fi resume after a drop |

**Android phone (`<serial>`)**

| # | Step | Expected |
| --- | --- | --- |
| 10 | Chrome, no adb server, helper running | WebUSB unchanged; helper starts no adb (`lsof -iTCP:5037` empty); checklist "adb server: not running" ok |
| 11 | `adb start-server` (or Android Studio) | WebUSB `held` replaced by the helper's row (after "Allow USB debugging?" for the Mac's key); "Copy all as Markdown" equals WebUSB's except Connection; screenshot; logcat Start/Stop |
| 12 | `adb kill-server` | Helper row gone; WebUSB `held` → Reconnect → ready |
| 13 | Safari: Start adb server from the Gate | Server up within 8 s; phone listed; exit prints the kill-server advice and leaves the server running |

**Android TV over Wi‑Fi**

| # | Step | Expected |
| --- | --- | --- |
| 14 | Network debugging on; "Network device (Wi‑Fi)…" with its address | "Allow debugging?" on the TV; Allow with the remote; the row turns Ready in place; Show selects it |
| 15 | Detail, screenshot, logs; then turn the TV off | All work; the log says the connection was lost, and resumes if the TV is back within 2 minutes; a TV whose row leaves the list stops the log at once |
| 16 | Disconnect | The row goes; Recent keeps it for a one-click reconnect; the terminal says it was disconnected, not that it stopped answering (§1.10) |
| 16a | The same connect from a terminal inside another app (VS Code), and with a VPN on | Fails at once with `blocked`; the advice names the VPN and Local Network permission, and the Wi‑Fi dialog adds "This computer reaches the local network" (§4.7) |

**Browsers and lifecycle**

| # | Step | Expected |
| --- | --- | --- |
| 17 | Chrome "Never allow" | `denied`; local page works. Dismiss → `dismissed`; Connect asks again. |
| 18 | Safari | The auto-opened hosted tab forwards to the local copy and pairs; screenshot through the `ClipboardItem` path |
| 19 | Firefox | Prompt, Allow, both platforms |
| 20 | Restart the helper | Old tab "Helper restarted — pair again"; with Remember, a new tab re-pairs the others |
| 21 | Ctrl+C | "Helper stopped" within 2 polls; restart reconnects |

**Security spot checks**

| # | Check | Expected |
| --- | --- | --- |
| 22 | `curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example:8787' http://127.0.0.1:8787/api/health` | 421 |
| 23 | Same request with `-H 'Origin: https://evil.example'` | 403, no `access-control-allow-origin` |
| 24 | `curl -s http://127.0.0.1:8787/device/` | Contains `DVC_BOOT`, no token |
| 25 | DevTools, scrollback and `ps` while the tab opens | The token appears only in `Authorization` headers and the banner; never in argv; "Copy as text" shows only the fingerprint |

### 9.7 Real-device results (2026-10-04)

All read-only on the iPhone: no Pair, no `SetValue`, no Trust prompt, no sudo. The iPhone was an iPhone 12 Pro on iOS 27.0, seen **over Wi‑Fi only** during the build and **on USB** in the afternoon run below. The Android TV was connected through the adb server by the helper's own Wi‑Fi routes, on clicks; nobody ran an `adb` command.

**The built helper, on the build Mac (Node 24.12 and 20.19.6)**

- `/api/health` 5 ms; `/api/devices` 0–4 ms over 20 calls; `/api/rescan` 1–392 ms; `/api/doctor` 270–470 ms. `--doctor` 0.5–1.6 s, every item OK (Xcode 27.0 with devicectl 642.16, libimobiledevice 1.4.0, pymobiledevice3 9.8.1, bundletool 1.18.3 with Java 21.0.11, macOS 27.0.1, usbmuxd answering).
- Local mode: `/device/` 640 ms the first time; assets 315–510 ms, then 2 ms from the cache.
- `--keep-token`: the file is created 0600 and the fingerprint survives a restart. After Ctrl+C no child is left, the private folder is gone, and the exit code is 0.

**iPhone over Wi‑Fi** (`--wifi`)

- Row: `+ <name> · iOS 27.0 · Wi-Fi · trusted`, with non-ASCII characters intact.
- Detail: 0.4–0.5 s, then 1 ms from the cache; from lockdown, all 12 whitelisted keys, `UniqueChipID` a string; nothing withheld; no IMEI, phone number, MAC address, DieID or baseband serial. On the page: 1.2 s.
- Screenshots (devicectl): 1170×2532 PNG, 2.2–3.0 s the first time, 0.7–1.0 s after; a parallel request gets `BUSY`; one first call failed after 18.4 s and the next worked; a PNG while locked after first unlock.
- Logs: `hello` at 0.34 s, first lines at 0.46 s, about 145 lines/s (639 lines in 5 s, longest 485 characters).
- Lock after first unlock: session `PasswordProtected` true, devicectl `lockState` agreeing (`passcodeRequired true · unlockedSinceBoot true`); detail, logs and screenshots kept working.
- Presence: listed 1–133 s at a time, away 6–90 s between, once 289 s (§3.9).

**Simulators** (`--simulators`, three booted)

- Detail 0 ms; screenshots 0.8–1.5 s (1206×2622, 1125×2436, 2064×2752); first log lines after 0.9–1.6 s; no `simctl` or `log stream` process afterwards.

**Android**: an already running adb server answered `host:version` (protocol 41) and `host:devices-l` with no phones; with no server the lane reports `stopped`, the checklist offers Start adb server, and nothing listens. During the build the Wi‑Fi flow ran against `helper:fake`; the afternoon run below used a real TV.

**Afternoon run, on hardware** (2026-10-04, after the build)

- **iPhone on USB works.** One row, on USB; detail, screenshots in 0.4–0.5 s, syslog at 70–130 lines/s.
- **Locked with the screen off, every screenshot is an all-black PNG**, and devicectl reports success. Device Lab showed it with no hint (§3.7).
- **Storage.** Settings showed "Available 74.41 GB"; lockdown gave `AmountDataAvailable` 40.30 GB (free now) and `TotalDataAvailable` 161.04 GB (including what iOS can purge). No key equals Settings, and the page showed 161 GB as "Available", which misleads (§3.5, §7.6).
- **Android TV over Wi‑Fi works.** A Sony BRAVIA on Android 10, Network debugging on: connect, then "Allow USB debugging?" on the TV, then Ready in about 40 s; detail in 0.12 s; screenshots 1920×1080 in 3.5 s; logcat about 52 lines/s; Disconnect worked.
- **Before that, every connect failed at once with "No route to host"**, for two reasons on the Mac, not the network: Cloudflare WARP (a VPN) was connected and blocked the LAN, and the helper had been started from VS Code's terminal, which macOS's Local Network privacy kept off the LAN without ever asking. Started from Terminal.app, the same helper worked. mDNS discovery (`dns-sd`) listed the TV in both cases (§4.7).
- **After an intentional Disconnect** the terminal printed "not answering over Wi-Fi: wake it, or connect it again", which is wrong for a disconnect (§1.10, §4.7).
- **The Environment check** showed the WebUSB row "Phone allowed in the browser" as a Warning in a session with only an iPhone (§12a).

---

## 10. Risks and open questions, ranked

| # | Risk | Likelihood / impact | Mitigation / decision |
| --- | --- | --- | --- |
| R1 | devicectl capture on a physical iPhone | — | **Retired** by P0-5 over Wi‑Fi and by the afternoon run on USB (§9.7) |
| R2 | Testers' Node builds (nodejs.org, bundled OpenSSL) differ from Homebrew's 3.6.1 | Low–medium / high | `@SECLEVEL=0` always; sync-throw handling; `ideviceinfo`/`idevicesyslog` fallback; `ios.session` preflight item names the Node and OpenSSL and the fix |
| R3 | BFU behaviour and `IOS_LOCKED` copy [I] | Medium / medium | P0-4; AFU verified to stay usable |
| R4 | LNA UX in headed browsers (dismissal, embargo) | Medium / medium | Probe only after intent; local mode always offered; P0-9 |
| R5 | iOS syslog volume (about 145 lines/s idle over Wi‑Fi, up to 468) against a 2,000-line console | High / medium | v1.1 helper-side `?process=` filter; raise the limit only with measurement |
| R6 | Trust for a phone never paired with this Mac (does macOS prompt?) [I] | Low / medium | Finder guidance in the checklist; P0-8; "Ask to trust" in v1.1 |
| R7 | adb host-protocol details (`track-devices-l` line format, logcat stop on close) [S/I] | Low / medium | `devices-l` polling fallback; P0-7 fixtures |
| R8 | Safari.app itself never driven (engine matched [V]) | Low / medium | §9.6 step 18 |
| R9 | `--keep-token` squat race (T7) | Low / low | Per-run default; documented; v1.1 codes |
| R10 | Local mode depends on the live site; a deploy mid-session mixes assets | Low / low | Last-good copy; 60 s revalidation |
| R11 | Node 18 untested (20 and 24 tested); 18 and 20 are end of life | Low / low | API denylist on the built file; checklist warns below Node 22 |
| R12 | iOS 15–16 screenshots untestable here (no device; Xcode 27 ships no old DDIs) | — / low | Best effort, clean errors; DDI lane later |
| R13 | devicectl JSON envelope changes (jsonVersion 5) | Low / low | Defensive parse; unknown → `TOOL_FAILED` with the text |
| R14 | Device-certificate pinning assumption | — | **Retired** by P0-6; enforced |
| R15 | The page's log waited 30 s while the helper holds a Wi‑Fi iPhone 120 s; about half the measured absences are longer than 30 s | — | **Retired**: the window follows the hold (120 s), and a row that leaves the list stops the log at once (§7.8) |
| R16 | A Wireless-debugging phone that never paired: does adb list it `unauthorized` after "failed to authenticate"? [I] | Medium / low | Both answers are handled (Allow step or pairing code); confirm on a phone |
| R17 | USB checks on the iPhone (P0-1, P0-2 over USB, the 26-key plaintext read, §9.6 steps 1–9) | Low / medium | **Mostly retired** by the afternoon run: USB row, detail, screenshots and syslog work (§9.7). P0-1's `Listen` details and the plaintext read remain |
| R18 | A Wi‑Fi name whose DNS answer changes between the helper's lookup and adb's (T22) | Low / low | Documented; typed addresses are not affected |
| R19 | Wi‑Fi devices unreachable because of this Mac: a VPN, or Local Network privacy for the app the helper was started from | High / high (every connect fails, and the network looks fine) | Seen on the first real run (§9.7); "No route to host" is its own reason, `blocked`, whose advice names both causes and the way out (§4.7) |
| R20 | A screenshot of a locked iPhone with its screen off is all black, and the tools report success | High / medium | Device Lab says why next to the image (§3.7) |
| R21 | iOS storage keys don't match Settings' "Available" | Certain / low | Each figure labelled as what it is (§3.5, §7.6) |

**Decisions for the owner** (current choice in brackets)

- Wi‑Fi iPhones and simulators opt-in [yes].
- Per-run tokens; codes later [yes].
- Never kill the adb server at exit [yes].
- Auto-open a tab at start [yes, `--no-open` to disable].
- Remember off by default [yes].
- Pinning enforced [yes, since P0-6].
- The log's resume window [120 s, the helper's Wi‑Fi hold; R15 retired].

---

## 11. Work packages

How the build was split. The packages ran in parallel after a day-0 skeleton; module ownership was exclusive, so merges touched disjoint files. Some code comments still name their package.

| WP | Scope | Modules and files |
| --- | --- | --- |
| WP1 | Helper core, security and server | `constants`, `util`, `process`, `registry`, `auth`, `http`, `local-mode`, `bridge`, `cli`, `banner`, `main`, `guard`, `types`; `build.mjs`, `header.txt`, `tsconfig.helper.json`, `vitest.config.ts`; the core tests and the `bin`, `upstream`, `lane` fakes |
| WP2 | iOS lanes | `plist`, `usbmuxd`, `lockdown`, `ios-lane`; the iOS tests; `usbmuxd`, `lockdownd`, `certs` fakes; devicectl fixtures |
| WP3 | Android and simulator lanes | `android-lane`, `simulator-lane`; their tests and the real opt-in runs; `adb-server` fake; `pixel-9` and simctl fixtures |
| WP4 | Preflight checklist, helper side and page side | `tools`, `preflight`; their tests and the `mac` fake; on the page, the helper's rows in `preflight/` and the Environment check |
| WP5 | Page agent lane and UI | `helper/*`, `backends/agent.ts`, `backends/ios.ts`, the model map, the merge rule and hints, the helper components, page wiring, `helper:fake` |
| Wi‑Fi | Android over Wi‑Fi, and the Wi‑Fi iPhone hold | `android-lane` (§4.7), `ios-lane` (§3.9), `http`; `wifi.ts`, `helper/network.ts`, `log-sessions.ts`, `wifi-dialog.tsx` |

**Definition of done (all)**

- `npm run verify` green: typecheck, `typecheck:helper`, lint, page tests, `test:helper`, `helper/build.mjs --check`, build.
- §9.3 runs show every phase, hint and Wi‑Fi state; parity unchanged.
- §9.6 checklist with `--doctor` output in the PR.
- Commit `device/agent/device-bridge.mjs` by hand; `npm run deploy`, `npm run check:live`; `curl -fsSL https://bauloc.github.io/device/agent/device-bridge.mjs` returns the file.

---

## 12. Preflight checklist

**Two halves, one checklist.** The helper words the items about this Mac and its tools (`helper/src/preflight.ts`, file §12), so the terminal and the page say the same thing. The page words the items about the browser, the connection and each device. The page half is not a new system: it extends the checklist Device Lab already had for Android over WebUSB (`src/features/device/preflight/`: `types.ts` for the rows, `checks.ts` for the decisions, `copy.ts` for every word, `env.ts` for reading the browser; `components/checklist.tsx` and `doctor-dialog.tsx` to show them). The helper's rows join the same `CheckItem` shape, the same groups and the same components as the phone, feature and `.aab` rows.

### 12a. Items

| Group | Id | Item | Owner |
| --- | --- | --- | --- |
| This browser | `browser.secure` | Secure context | page |
|  | `browser.webusb` | WebUSB | page |
| Helper | `helper.lna` | Reaching the helper: LNA permission state, Safari, local mode (the design's `browser.reach`) | page |
|  | `helper.running` | Helper reachable | page |
|  | `helper.version` | Helper protocol and version | page |
|  | `helper.paired` | Pairing: fingerprint, proof (the design's `helper.pairing`) | page |
|  | `helper.update` | Published file matches (Environment check only) | page |
|  | `mac.tools` | Placeholder for the helper's rows until it can report them | page |
| This Mac | `mac.node` | Node ≥ 18 (current LTS recommended) | helper |
|  | `mac.os` | macOS version / not macOS | helper |
| iPhone tools | `ios.usbmuxd` | usbmuxd socket | helper |
|  | `ios.session` | Native secure session works on this Node (shown only after a TLS failure) | helper |
|  | `ios.xcode` | Full Xcode: selected / CLT only / not installed / first launch / license / devicectl screenshot command | helper |
|  | `ios.libimobiledevice` | libimobiledevice (optional) | helper |
|  | `ios.pymobiledevice3` | pymobiledevice3 + its Python + root tunnel state (optional; later lane) | helper |
|  | `ios.simulators` | Simulator tools (only with `--simulators`) | helper |
| Android tools | `android.adb` | adb binary | helper |
|  | `android.adb-server` | adb server running? which phones it holds | helper |
|  | `android.wifi` | Wi‑Fi devices: the adb server they go through (optional, §4.7) | helper |
|  | `android.bundletool` | bundletool + Java (optional; `.aab` lane later) | helper |
| Devices | `device.<id>.trust`, `.lock`, `.devmode`, `.ios-version`, `.screenshots` | Per iPhone | page |
|  | `device.<id>.android-auth`, `.adb-conflict`, `.offline`, `.wifi` | Per Android device | page |
|  | `device.none.android`, `device.none.ios` | Guidance when nothing is attached | page |
| Wi‑Fi devices | `wifi.helper`, `wifi.adbServer`, `wifi.reachable`, `wifi.authorized` | A connect in progress or a Wi‑Fi device listed (§4.7) | page |

The page's existing groups stay: `phone.*` (the WebUSB phone's own steps), `feature.*` and the `.aab` rows. When an Android phone is ready through the helper, the Phone group reads OK with "Not needed: <name> is ready through the local helper…".

The `phone.*` rows are about an Android phone on this computer's USB, reached by the browser. A session about iPhones has no such phone, and nothing is wrong: there those rows are never a Warning. The first real-device run showed "Phone allowed in the browser" as a Warning in the Environment check next to a ready iPhone (§9.7), which sent the tester looking for a problem that wasn't there. With no Android device and no Android intent (the Android card's Add device, a WebUSB grant, an Android row), they read Not checked, like any step that can't be known yet. As built (`phoneChecks` in `preflight/checks.ts`): when the helper lists a device that is not a ready Android one, there is no WebUSB device and Add device was never tried, the group is one row, `phone.permission`, Not checked: "Not checked: <name> goes through the local helper, which doesn’t use WebUSB. For an Android phone on a cable in this browser, click Add device."

### 12b. Detection, status, wording and fix

The sentences below are the design's. The helper's shipped words are in `helper/src/preflight.ts` and the page's in `preflight/copy.ts`, each tested string by string; where they differ, those files are right.

`<adb>` in a command is `adb` when the tester's PATH reaches the adb the helper found, and its full, shell-quoted path otherwise (an adb only in `~/Library/Android/sdk/platform-tools` is "command not found" when typed bare): `adbCommand()` in `tools.ts`. The same goes for the exit line's `kill-server` advice (§1.8).

**Status meanings**

- **ok:** nothing to do.
- **warning:** something is degraded or an optional tool is missing; the core path works.
- **blocking:** a capability in the item's `neededFor` cannot work until fixed.
- **not checked:** the check could not run (helper not connected, no device, timed out). Honest ignorance, never a softer warning.

**Fix kinds**

- `command`: copyable, never run by the helper.
- `link`.
- `step`: a settings path on the phone or Mac.
- `action`: an in-page button.

**Homebrew rule.** When neither `/opt/homebrew/bin/brew` nor `/usr/local/bin/brew` exists, every `brew install …` fix is preceded by `link https://brew.sh` "Install Homebrew first". When `brew` exists but its directory isn't on PATH (a fresh Apple-silicon install leaves it so), the fix is preceded by `eval "$(<brew> shellenv)"` with a note, so the bare `brew` that follows runs. This can make three fixes (for a blocking `ios.session`: Node LTS, Homebrew, the brew command); the Homebrew rule wins over the "0–2 fixes" guideline.

**Browser and connection items (page; `preflight/checks.ts`)**

| Id | Detection | Status → sentence → fix |
| --- | --- | --- |
| `browser.secure` | `window.isSecureContext` | ok → "This page runs in a secure context." · blocking → "This page isn't in a secure context, so WebUSB and pairing can't work." → link `https://bauloc.github.io/device/` "Open the secure page" |
| `browser.webusb` | `'usb' in navigator` | ok → "This browser reaches Android phones directly over WebUSB." · without WebUSB → "This browser has no WebUSB, so Android needs the helper and Google's adb." → step "Use Chrome or Edge for Android without the helper." |
| `helper.lna` | Mode, `safariLike`, `loopbackPermission()` (§6.3) | local → ok "Not needed: the helper serves this page." · `granted` → ok "Allowed to reach apps on this device." (with a note that the grant covers the whole site, T12) · `unsupported` (not Safari) → ok "This browser doesn't ask for this permission." · `prompt` → not checked "The browser will ask once to let this page reach apps on this device; choose Allow." → action `connect` "Connect helper" · `denied` → blocking "This browser blocks this page from reaching apps on this device." → step "Chrome or Edge: Site settings → Apps on device → Allow. Firefox: Settings → Privacy & Security → Device apps and services." + action `open-local` · hosted Safari → blocking "Safari can't reach the helper from this secure page." → action `open-local` "Open the helper's page" |
| `helper.running` | Phase | `connected` → ok "Helper 1.1.1 answers on 127.0.0.1:8787." · `off`/`checking` → not checked "Not checked yet." → action `connect` · `absent` → blocking "Nothing answers on 127.0.0.1:8787." (+ "…or the helper was started without --dev." on a dev origin) → command `curl -fsSL https://bauloc.github.io/device/agent/device-bridge.mjs -o ~/device-bridge.mjs && node ~/device-bridge.mjs` (dev: `node ../device/agent/device-bridge.mjs --dev`) · `lost` → blocking "The helper stopped." → command `node ~/device-bridge.mjs` · `foreign` → blocking "Another program answers on port 8787." → command `node ~/device-bridge.mjs --port 8788` · `dismissed`/`denied`/`safari` → not checked (see `helper.lna`) |
| `helper.version` | `health.protocol` vs `[1,1]` | ok → "Protocol 1, version 1.1.1." · `outdated` → blocking "This helper (0.9.0) is older than this page needs." → the download command · `newer` → blocking "This page is older than the helper." → action `reload` |
| `helper.paired` | Phase | ok → "Paired · fingerprint 4d1566a1 · this tab only" (or "· remembered on this computer") · `unpaired` → blocking "This page isn't paired with the helper." → action `pair` · `stale` → blocking "The helper restarted, so this page's pairing ended." → action `pair` · `foreign` → blocking "The program on port 8787 couldn't prove it is your helper; nothing was sent." |
| `helper.update` | `readPublishedHelper()`: fetch `/device/agent/device-bridge.mjs`; SHA-256 + `VERSION` vs health | ok → "Matches the published helper (1.1.1)." · warning → "A newer helper (1.2.0) is published." → download command · warning → "This helper differs from the published file." → download command · not checked (offline, or not published yet) |
| `mac.tools` | Until a doctor report exists | not checked → "This Mac's tools aren't checked yet; start the helper to check Xcode, adb and the rest." (running but unpaired: "Checked once this page is paired…") |

**Mac items (helper; §1.5 detection)**

| Id (label) | Detection (command or API · timeout · parse) | Status → sentence → fix |
| --- | --- | --- |
| `mac.node` ("Node 24.12.0") | `process.versions.node` · — · major | ≥ 22 → ok "Node 24.12.0 runs the helper." · 18–21 → warning "Node 20.19.6 works, but it no longer gets security updates." → link `https://nodejs.org/en/download` "Get the current Node LTS" · (< 18 never starts; the terminal guard message covers it) |
| `mac.os` ("macOS 27.0.1") | `platform`; darwin → `parsePlist(/System/Library/CoreServices/SystemVersion.plist).ProductVersion` (fallback `/usr/bin/sw_vers -productVersion` · 2 s) | darwin → ok "macOS 27.0.1." · otherwise → blocking (`neededFor` iOS) "iPhones need a Mac; on linux only Android works through this helper." |
| `ios.usbmuxd` ("usbmuxd") | `lstat(/var/run/usbmuxd).isSocket()` + `ReadBUID` (the lane's own client) · 2 s | ok → "macOS's iPhone service (usbmuxd) answers." · blocking → "macOS's iPhone service (usbmuxd) isn't answering." → step "Unplug the iPhone and plug it back in. If this stays red, restart the Mac." |
| `ios.session` ("Secure session") | iOS lane `facts().tlsFailures` (shown only when non-empty) | warning (libimobiledevice present) → "Node 18.20.4 (OpenSSL 3.0.13) couldn't open an iPhone's secure session, so details and logs come from libimobiledevice." · blocking (absent) → "Node 18.20.4 (OpenSSL 3.0.13) couldn't open an iPhone's secure session, so only basic identifiers are shown." → link nodejs.org LTS + command `brew install libimobiledevice` |
| `ios.xcode` ("Xcode 27.0" / "Xcode") | `resolveXcode()` (§1.5) | `ready` → ok "Screenshots of iOS 17 and newer work through Xcode's devicectl." · `not-installed` → warning "Xcode isn't installed, so screenshots of iOS 17 and newer are off; identifiers and logs still work." → link `https://apps.apple.com/app/xcode/id497799835` "Get Xcode from the App Store" · `not-selected` → warning "Xcode is installed, but the Command Line Tools are selected, so screenshots are off." → command `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` (the path found) · `needs-first-launch` → warning "Xcode hasn't finished installing its components, so screenshots are off." → step "Open Xcode once and let it finish." + command `sudo xcodebuild -runFirstLaunch` · license not accepted (does not gate) → warning "Xcode's license hasn't been accepted, which can stop its tools." → command `sudo xcodebuild -license accept` · `no-capture` → warning "This Xcode's devicectl has no screenshot command; update Xcode." → App Store link. `detail`: "devicectl 642.16 · /Applications/Xcode.app/Contents/Developer". `neededFor: ['ios.screenshot']`. |
| `ios.libimobiledevice` ("libimobiledevice 1.4.0"; optional) | `which` ideviceinfo/idevicesyslog/idevicescreenshot; `ideviceinfo --version` · 5 s · `/ideviceinfo (\d+\.\d+\.\d+)/` | ok → "Installed: a fallback for details and logs, and screenshots of iOS 16 and older." · warning → "Not installed. Only needed for screenshots of iOS 16 and older, or when the helper can't open an iPhone's secure session." → command `brew install libimobiledevice`. `neededFor: ['ios.screenshot.legacy', 'ios.fallback']`. |
| `ios.pymobiledevice3` ("pymobiledevice3 9.8.1"; optional) | `which('pymobiledevice3')` (+ python.org and `~/.local/bin`); shebang `#!(\S+)(?:\s+(\S+))?` (an `env` interpreter is resolved by `which`, never `/usr/bin/python3`); `pymobiledevice3 version` through that Python · 10 s · `/^(\d+\.\d+\.\d+)/m`; `<python> --version` · 5 s; tunnel `GET 127.0.0.1:49151/hello` · 500 ms | ok → "Installed in Python 3.9.6 (<path>). Used only by the optional root tunnel, in a later helper version." (`detail`: "root tunnel: not running") · warning → "Not installed. Only needed for the optional root tunnel (a later helper version)." → command: python.org Python found → `python3 -m pip install -U pymobiledevice3`; Homebrew Python (PEP 668) → `brew install pipx && pipx install pymobiledevice3`; no Python → link `https://www.python.org/downloads/macos/` · bound to Apple's `python3` → not checked |
| `ios.simulators` ("Simulators"; only with `--simulators`) | `resolveSimctl()` gate; simctl list | ok → "2 simulators are booted." / "No simulator is booted." · warning → "Xcode hasn't finished installing simulator components." (same fixes as first launch) / "Simulators need Xcode." → App Store link / "Simulators need Xcode, but the Command Line Tools are selected." → the `xcode-select` fix |
| `android.adb` ("adb 36.0.0") | `which('adb')` (+ SDK dirs) · `adb version` · 5 s · `/^Version (\S+)/m` (never starts a server [V]) | ok → "Google's adb is installed (/opt/homebrew/bin/adb)." · warning → "adb isn't installed. Chrome and Edge don't need it; Safari and Firefox reach Android only through it." → command `brew install --cask android-platform-tools`. `neededFor: ['android.helper']`. |
| `android.adb-server` ("adb server") | TCP connect (1 s) + `host:version` (2 s) → protocol; if running, `host:devices-l` (2 s) | running → ok "Google's adb server is running and holds 1 phone (Pixel 9); the helper shares it." (`detail` lists serial:state) · stopped → ok "Google's adb server isn't running, so Chrome's WebUSB can use Android phones directly." → action `start-adb` "Start adb server" only when adb is installed (the page shows it only per §12c) · something on the port that doesn't answer like adb (often a stuck server) → warning "Something on 127.0.0.1:<port> isn't answering like Google's adb server, usually an adb server that got stuck." → `<adb> kill-server` (when adb is found) and `lsof -nP -iTCP:<port> -sTCP:LISTEN`, no Start · `--no-android` → not checked, and nothing connects |
| `android.wifi` ("Wi-Fi devices"; optional) | The same server facts | running → ok, the network devices in `detail` · stopped → warning "Android TVs and phones on Wi-Fi go through Google's adb server, which isn't running." → action `start-adb` + command `<adb> start-server` (with the note that Chrome's WebUSB then loses phones on a cable, and `<adb> kill-server` gives them back) · adb missing → warning → the brew command, and no Start (it can't work without adb) · stuck server → the adb server row's warning and fixes · `--no-android` → not checked "Not checked: the helper was started with --no-android." `neededFor: ['android.wifi']`. |
| `android.bundletool` ("bundletool 1.18.3"; optional) | `which('bundletool')` · `bundletool version` · 10 s, run only with a verified Java passed as `JAVA_HOME` and first on PATH. Java (`resolveJava`): `$JAVA_HOME/bin/java -version` if set (a broken one is final), else `/usr/libexec/java_home` (5 s), else Android Studio's JBR, else Homebrew's openjdk next to `brew`. **Never run `/usr/bin/java`** (its stub may offer an install [I]). | ok → "Installed (Java 21.0.11). A later helper version uses it to install .aab bundles." · warning (missing) → "Not installed. Only needed to install .aab bundles (a later helper version)." → command `brew install bundletool` (brings its own Java) · warning (present, `JAVA_HOME` points at a Java that doesn't run) → "bundletool is installed, but JAVA_HOME points at a Java that doesn't run." → stop the helper (Ctrl+C), `unset JAVA_HOME` (and remove it from ~/.zshrc), start the helper again; `detail` "<bundletool> · JAVA_HOME=<path>" · warning (present, no Java at all) → "bundletool is installed but can't start Java." → command `brew install openjdk`. `neededFor: ['android.aab']`. |

**Device items (page; derived from rows, lanes and helper facts)**

| Id | Detection | Status → sentence → fix |
| --- | --- | --- |
| `device.none.ios` | No iOS row and the helper is connected | not checked → "Plug in an iPhone with a cable and unlock it." → step "iPhone: when asked, tap Trust and enter the passcode. If nothing asks, open Finder and select the iPhone in the sidebar." [I] |
| `device.none.android` | No Android row | not checked → "Plug in a phone with USB debugging on." → step "Phone: Settings → About phone → tap Build number 7 times, then Settings → System → Developer options → USB debugging." |
| `.trust` | iOS `untrusted`/`authorizing` | blocking → "This iPhone doesn't trust this Mac yet." → step (as above) + action `retry` · else ok "Trusted." |
| `.lock` | iOS `locked` | blocking → "The iPhone hasn't been unlocked since it restarted." → step "iPhone: unlock it with the passcode." · else ok |
| `.devmode` | Blocker `IOS_DEVELOPER_MODE_OFF` (hidden for iOS 15) | warning → "Developer Mode is off, so screenshots are off." → step "iPhone: Settings → Privacy & Security → Developer Mode → On (it restarts)." · else ok "Developer Mode is on." |
| `.ios-version` | Major of `osVersion` | 15–27 → ok "iOS 27.0 is supported." · < 15 → warning "iOS 14 and older are untested; some details may be missing." · > 27 → warning "iOS 28 is newer than this helper knows; update the helper if something fails." → download command |
| `.screenshots` | `capabilities.screenshot`; blockers `XCODE_REQUIRED`, `XCODE_SETUP_REQUIRED`, `IOS_DDI_REQUIRED`, `TOOL_MISSING` | ok → "Screenshots work." · a ready device missing only screenshots → **warning** "Screenshots are off for this device." (the design said blocking; the owner chose warning, to match the Xcode row) + the matching tool item rendered inline |
| `.android-auth` | `unauthorized`/`authorizing` | blocking → "The phone is waiting for you to allow USB debugging." → step "Phone: unlock it and tap Allow on 'Allow USB debugging?' (tick Always allow)." + action `retry`. On Wi‑Fi: "Allow debugging?" with the TV remote. |
| `.adb-conflict` | WebUSB row `held` and no helper row for that id | blocking → "Google's adb server is holding this phone." → command `adb kill-server` + action `connect` "Use the helper instead" · helper serves it → ok "Shared through Google's adb server." |
| `.offline` | `offline` | warning → "The phone isn't answering." → step "Reseat the cable and avoid USB hubs." (on Wi‑Fi: wake it, same network) + action `retry` |

### 12c. Endpoint shape and how the page merges it

```ts
type PreflightStatus = 'ok' | 'warning' | 'blocking' | 'unchecked'
type PreflightAction =
  'connect' | 'pair' | 'open-local' | 'reload' | 'start-adb' | 'retry' | 'recheck'
type PreflightFix =
  | { kind: 'command'; command: string; note?: string }
  | { kind: 'link'; href: string; label: string }
  | { kind: 'step'; text: string }
  | { kind: 'action'; action: PreflightAction; label: string }
type Capability =
  | 'helper'
  | 'ios.list'
  | 'ios.detail'
  | 'ios.screenshot'
  | 'ios.screenshot.legacy'
  | 'ios.logs'
  | 'ios.fallback'
  | 'android.webusb'
  | 'android.helper'
  | 'android.wifi'
  | 'android.aab'
  | 'simulators'
interface PreflightItem {
  id: string
  group: 'browser' | 'helper' | 'mac' | 'ios' | 'android' | 'device'
  label: string // short noun phrase; may carry a version
  status: PreflightStatus
  sentence: string // ONE plain sentence
  fixes: PreflightFix[] // 0–2, most direct first (the Homebrew rule may add one)
  detail?: string // facts: version, path, server rows (helper items only; paths are auth-gated)
  neededFor: Capability[]
  optional?: boolean
  deviceId?: string
}
interface DoctorReport {
  // GET /api/doctor (bearer), cached 30 s helper-side; ?refresh=1 re-resolves
  helper: {
    name: string
    version: string
    protocol: number
    node: string
    openssl: string
    platform: string
    arch: string
    macos: string | null
    port: number
    startedAt: number
    local: boolean
    tokenPersistent: boolean
    flags: string[]
    sha256: string
  }
  lanes: Lanes
  items: PreflightItem[] // groups 'mac' | 'ios' | 'android', helper-worded (§12b)
  checkedAt: number
}
```

**When the page fetches the report** (`connection.doctor()`, page cache 30 s, dropped when `lanes` change)

- Once on entering `connected` while the Gate is visible.
- When the Environment check opens.
- On **Re-check** (`?refresh=1`), which also polls the device list and re-reads the browser.
- Lazily when a row shows `XCODE_*`, `TOOL_MISSING` or `IOS_DDI_REQUIRED` (for inline rows).

**How the page builds the checklist** (`preflight/checks.ts`, pure)

1. `browserChecks(env)`, always.
2. `helperChecks(probe, doctor, ctx)`: the `helper.*` rows from `HelperStatus`, the update row when the published file was read, then `toolChecks(probe, doctor, ctx)`: the helper's own items (`toolFix` turns their fixes into the page's), or the `mac.tools` placeholder while not connected or not paired. `helperChecks(null, null)` still returns the Android plan's `.aab` rows (`aabHelperChecks`).
3. `deviceChecks(devices, ctx)` and, for one device, `inlineChecks(device, tools)`.
4. `wifiChecks({helper, attempt, device})` for the Wi‑Fi dialog and the Environment check (§4.7).
5. **Relevance** (page context adjusts helper items; it never rewrites their wording):
   - `android.adb` missing while `!webusb` → **blocking**.
   - `android.adb-server` stopped while `!webusb` and the helper is connected → **warning** "Without WebUSB, Android goes through Google's adb server, which isn't running." The action `start-adb` is shown only here, only when the helper lists `android.start-server` and `android.adb` is ok, and in the Environment check with the WebUSB warning.
   - An optional item counts as relevant only when its capability is in play:
     - `ios.screenshot.legacy`: an iOS ≤ 16 row exists;
     - `ios.fallback`: `ios.session` is present;
     - `android.wifi`: a Wi‑Fi attempt or device;
     - `android.aab`: never in v1.
   - An irrelevant optional item lives in the Environment check's "Optional tools" group and never on the Gate.
6. **Sort** (`sortChecks`, `GROUP_ORDER`) by group, then blocking, warning, unchecked, ok.
7. **Views:** `gateChecks` and `gateSummary` for the Gate, the sections for the Environment check, `inlineChecks` for a device.

### 12d. Where it appears (locked shadcn console style; existing parts only)

**Rows** (`components/checklist.tsx`: `Checklist`, `InlineChecklist`, `RowBody`, `StatusWord`, `FixButton`, `Command`)

- Each row: a status dot and a status word ("OK", "Warning", "Needs action", "Not checked") in `text-muted-foreground text-xs`. Colour never stands alone.
- Then the label (`font-medium`), the sentence (`text-muted-foreground text-sm`), and the fixes:
  - `command` → the shared `Command` block with its copy button;
  - `link` → `Button variant="link"` with an external-link icon;
  - `step` → a muted line with the steps;
  - `action` → `Button size="sm" variant="outline"`.
- `detail` is a muted monospace line; long paths wrap anywhere.

**Gate.** A checklist card (`Card` / `CardTitle` "Checklist" / a summary such as "2 need attention · 5 passed · 3 not checked yet" / **Re-check**), full width below the platform cards, shown only once the helper is connected or the tester showed intent.

- Non-ok rows are shown; ok rows collapse behind "Show 5 passed checks".
- Optional items are never on the Gate unless relevant.

**Environment check** (`components/doctor-dialog.tsx`; `sm:max-w-2xl`; body `max-h-[70dvh] overflow-y-auto`)

- About rows (`aboutRows`: Page mode, Helper address, UI version, Mock devices, Devices seen), the costs of local mode (§6.4), and the Remember switch.
- Sections: This browser · Phone · Helper · This Mac · iPhone tools · Android tools · Devices · Wi‑Fi devices · Optional tools · Features.
- Footer: Copy as text (`environmentText`: the About block, then `status — label — sentence — fixes` per row; never the token, and any bare 43-character token is stripped), Re-check, Forget pairing (when paired), Close.
- Device rows here have no Retry: Retry is bound to the selected device, inline.

**Inline**

- In `DeviceDetailPane`, directly below the `HintCard`: `inlineChecks(device)` rows for the first blocker's tool (`XCODE_*` → `ios.xcode`; `TOOL_MISSING` → `ios.libimobiledevice` / `ios.session`), with Retry for that device. `IOS_DDI_REQUIRED` has no inline row: the hint card already gives that step, and the Devices section has it.
- In the Gate's Android card without WebUSB: `android.adb` / `android.adb-server` rows replace the Start button when adb is missing.
- The Take Screenshot tooltip points at them.

### 12e. Tests for every missing-tool path

**Helper (`_app/helper/test/preflight.test.ts`, `tools.test.ts`).** Each scenario builds a fresh fake Mac (`fakes/mac.ts`) containing only the listed tools and passes `searchPath: tmpBin, extraDirs: []`, plus fake `xcodeSelectPath`, `plistBuddyPath`, `javaHomePath`, `applicationsDir`, `coreDeviceDir`, `systemVersionPlist`, `usbmuxdSocket`, `home`, `adbPort` (a closed port), `platform` and `nodeVersion`. Each asserts `{status, sentence, fixes}` exactly, and a recording `runTool` proves that **forbidden binaries were never executed**: no `/usr/bin/*`, no `xcrun`, no Xcode wrapper, no `-runFirstLaunch`, and adb only ever as `['version']`.

| # | Scenario | Expect |
| --- | --- | --- |
| 1 | Bare Mac: only Node; `xcode-select` exits 2; empty `/Applications`; no usbmuxd socket; no brew | `ios.usbmuxd` blocking; `ios.xcode` "not installed" + App Store link; `ios.libimobiledevice`, `ios.pymobiledevice3` and `android.bundletool` optional warnings with brew.sh before each brew fix; `android.adb` warning; `android.adb-server` ok "not running" |
| 2 | CLT only (`xcode-select` → `/Library/Developer/CommandLineTools`) | `ios.xcode` not installed |
| 3 | Xcode installed, CLT selected | warning + `sudo xcode-select -s <fake>/Xcode.app/Contents/Developer` |
| 4 | Selected, first launch pending (PlistBuddy prints `641.0`) | warning first-launch; **real devicectl, wrapper and `xcodebuild -runFirstLaunch` never called** |
| 5 | PlistBuddy fails (missing plist) | first-launch (same as the wrapper) |
| 6 | License not accepted (`xcodebuild -license check` exit 69) | warning license; screenshots still `ready` |
| 7 | No capture subcommand (real devicectl `-h` exits 64) | `no-capture` |
| 8 | All ready; `DEVELOPER_DIR` override wins over `xcode-select` | ok "Xcode 27.0" |
| 9 | Older Xcode: devicectl is a binary, not a wrapper | gate skipped, capture probe run |
| 10 | libimobiledevice present | ok, version parsed |
| 11 | pymobiledevice3: python.org shebang / `#!/usr/bin/env python3` / Homebrew Python → pipx fix / no Python → link; `/usr/bin/python3` never run | items and fixes |
| 12 | `pymobiledevice3 version` hangs (timeout shortened) | that item `unchecked` "Check timed out." |
| 13 | adb only in `~/Library/Android/sdk/platform-tools` (fake home) | found |
| 14 | adb present: argv is exactly `['version']`; no `start-server`, no `devices` | — |
| 15 | Fake adb server running with 2 phones | ok sentence and detail |
| 16 | `java_home` exit 1, no `JAVA_HOME`, no bundletool | optional warning; **`/usr/bin/java` never run** |
| 17 | bundletool present, Java OK | ok "bundletool 1.18.3 (Java 21.0.11)" |
| 18 | bundletool present, Java fails | no Java: "can't start Java" + `brew install openjdk`; a broken `JAVA_HOME`: "JAVA_HOME points at a Java that doesn't run" + `unset JAVA_HOME` between stopping and restarting the helper |
| 19 | `nodeVersion` 18.20.4 / 20.19.6 / 24.12.0 | warning, warning, ok |
| 20 | `platform` linux | `mac.os` blocking; no iOS lane; banner "iPhone unavailable" |
| 21 | usbmuxd socket accepts then closes / sends garbage | blocking |
| 22 | Relative PATH entries (`.`, `''`) containing a fake adb | not found |
| 23 | `tlsFailures` recorded, with and without libimobiledevice | `ios.session` warning / blocking |
| 24 | `--doctor` output for scenarios 1 and 8 | text snapshot; no token |
| 25 | `/api/doctor` without bearer → 401; with bearer → a valid report | — |

Also covered: Homebrew present or absent; the JAVA_HOME edge cases; the 12 s total deadline; `--no-android` never connecting; the simulator gate; `android.wifi` in each server state.

**Page (`preflight/checks.test.ts`, pure, plus `copy.test.ts` over every string)**

- `browserChecks` for: secure and insecure; WebUSB yes and no; local mode; permissions `granted`/`prompt`/`denied`/`unsupported`; hosted Safari; dev origin + `absent`.
- Every phase → `helper.*` items; the update row.
- `deviceChecks`: untrusted, locked, devmode off, iOS 14/15/27/28, each screenshot blocker; Android unauthorized, `held` without a helper row (conflict blocking), `held` with a helper row (ok), offline; Wi‑Fi rows; none-attached tips; inline rows.
- `wifiChecks` for every attempt state and failure `reason`.
- Relevance rules (adb blocking only without WebUSB; optional items hidden from the Gate; `start-adb` visibility); sort order; summary counts.
- "Copy as text" never contains a 43-character token.
- One test merges a `/api/doctor` reply from the real built helper.
