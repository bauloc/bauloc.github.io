#!/usr/bin/env node
/*
 * Device Lab helper 1.3.0 (bauloc-device-bridge)
 *
 * Device Lab (https://bauloc.github.io/device/) shows identifiers, screenshots and logs for
 * the phones plugged into this Mac. Android works straight from Chrome over WebUSB. macOS
 * keeps the iPhone's USB connection for itself, so no browser can reach it: this helper
 * bridges that gap, and Android too when the browser has no WebUSB. It is one file with no
 * dependencies, and it runs only while its Terminal window is open.
 *
 * Run it    node ~/device-bridge.mjs            (Node 18 or newer; --help lists the options)
 * Stop it   Ctrl+C in that window. Nothing it started keeps running, except an adb server
 *           you asked it to start: it never kills one, and says how to stop it.
 *
 * What it does
 *   - Listens on 127.0.0.1 only (port 8787), and serves the live Device Lab page there too,
 *     for Safari, which never lets a secure page reach this Mac.
 *   - iPhones: lists them through macOS's own usbmuxd and reads them through lockdown with
 *     the pairing this Mac already has; screenshots through Xcode's devicectl; logs through
 *     syslog_relay. iOS Simulators with --simulators.
 *   - Android: shares Google's adb server when one is running. It starts one only when you
 *     click "Start adb server" on the page, and never stops it. It looks for Android TVs and
 *     phones on the Wi-Fi with read-only mDNS questions, and never connects one by itself.
 *   - Android, when the page asks: carries the page's own adb commands to a device the adb
 *     server lists (installs, the Apps and Images tabs), one WebSocket per command, so a TV on
 *     the Wi-Fi gets what a phone on a cable gets in Chrome. Only the kinds of command those
 *     need get through: never a port forward, a reverse tunnel, or a restart of adbd.
 *   - On this network: when you open the list or press Refresh, it lists every device on this
 *     computer's own network so you can pick one to work with. It only reads what devices
 *     announce about themselves (mDNS, SSDP), the names this computer already knows, the
 *     neighbour table, and the answer to one harmless datagram per address of its own subnet;
 *     it changes nothing, logs in to nothing, and nothing runs in the background.
 *   - Devices on this network, only when the page asks: what devices on this computer's own
 *     network say about themselves (mDNS, SSDP), the names this computer already knows, and
 *     one UDP datagram to each address of its own subnet to see what answers. No port scan.
 *
 * What it never does
 *   - Listen on anything but 127.0.0.1, or send telemetry.
 *   - Run sudo, pair or unpair a device, show a Trust prompt itself, change a device
 *     setting, mount or download a developer disk image, install an app by itself, or kill
 *     adb.
 *   - Return the pair record, IMEI, phone numbers, MAC addresses (for a network device: only
 *     whether its address is private, and its maker's 3-byte prefix) or any key not on its
 *     allowlists.
 *
 * Every request meets these checks, in this order
 *   1. Host must be 127.0.0.1:<port> or localhost:<port>              (DNS rebinding: 421)
 *   2. Origin, when sent, must be https://bauloc.github.io or this helper
 *      (or the dev servers with --dev)                                (other sites: 403)
 *   3. A cross-site request without Origin is refused, except a top-level navigation to
 *      /device/ (an <img> or a form from another site: 403)
 *   4. OPTIONS answers the CORS preflight; GET /api/health is public and holds no secret
 *   5. Every other /api/* needs "Authorization: Bearer <token>". The token is new on every
 *      start (unless --keep-token), printed in the terminal only, and compared in constant
 *      time. Before sending it, the page makes the helper prove it holds the token.
 *   6. A device id must have a strict shape AND be in the live device list. Tools run as
 *      spawn(file, argv), never through a shell, with timeouts, output caps and their whole
 *      process group killed when the page stops waiting.
 *   7. The one WebSocket, the adb tunnel, needs an allowed Origin and the token too (sent as
 *      a subprotocol); every other upgrade is refused.
 *
 * The source is TypeScript in _app/helper/src, bundled into this file by rolldown; each
 * "//#region" below is one of those modules. A "§" in the comments is a section of the design,
 * _app/helper/SPEC.md; the "§" that opens a module's own comment numbers this file's sections
 * (the contents below, and SPEC §1.2).
 *   Review the source  https://github.com/bauloc/bauloc.github.io/tree/master/_app/helper/src
 *   The design         https://github.com/bauloc/bauloc.github.io/blob/master/_app/helper/SPEC.md
 *   This file          https://github.com/bauloc/bauloc.github.io/blob/master/device/agent/device-bridge.mjs
 *
 * Contents (line numbers in this file)
 *     112  Node version guard                   src/guard.ts
 *     134  §1 Constants, limits and allowlists  src/constants.ts
 *     396  §1 Command line                      src/cli.ts
 *     526  §2 Utilities                         src/util.ts
 *     780  §3 Property lists                    src/plist.ts
 *     904  §4a Running tools                    src/process.ts
 *    1223  §4b Finding tools                    src/tools.ts
 *    1897  §5 usbmuxd client                    src/usbmuxd.ts
 *    2242  §6 Lockdown client                   src/lockdown.ts
 *    2550  §7 iOS lane                          src/ios-lane.ts
 *    4245  §8 Simulator lane                    src/simulator-lane.ts
 *    4661  §9 mDNS browser                      src/mdns.ts
 *    6400  §9 Android lane                      src/android-lane.ts
 *    8457  §10 Device registry                  src/registry.ts
 *    8748  §11 Token, proof and pairing         src/auth.ts
 *    8922  §12 Doctor and preflight             src/preflight.ts
 *    9635  §13a WebSocket frames                src/websocket.ts
 *    9799  §13b adb tunnel                      src/adb-tunnel.ts
 *    9970  §13 HTTP API                         src/http.ts
 *   10803  §14 Local mode                       src/local-mode.ts
 *   11070  §15 LAN sources                      src/lan-net.ts
 *   11788  §16 Every device on this network     src/lan.ts
 *   12531  §17 Bridge lifecycle                 src/bridge.ts
 *   12987  §17 Banner                           src/banner.ts
 *   13069  §17 Startup, signals and exports     src/main.ts
 */
import path from "node:path";
import { setMaxListeners } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";
import { accessSync, chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import os from "node:os";
import { lstat, mkdtemp, open, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import net, { Socket } from "node:net";
import { X509Certificate, constants as constants$1, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import tls from "node:tls";
import dgram from "node:dgram";
import dns from "node:dns/promises";
import http, { STATUS_CODES } from "node:http";
import { fileURLToPath } from "node:url";

//#region src/guard.ts
/**
 * The sentence an old Node prints instead of starting, or null when this Node is new enough.
 * An unparsable version passes: refusing a Node we cannot read would be worse than trying.
 */
function nodeTooOld(version) {
	const major = Number(/^v?(\d+)\./.exec(version)?.[1]);
	if (!Number.isFinite(major) || major >= 18) return null;
	return `Device Lab helper needs Node 18 or newer (this is ${version}). Install the current LTS from https://nodejs.org, then run the same command again.`;
}
/**
 * The first code in the built file. Its imports are hoisted above it, but they are all
 * node: built-ins that Node 16 also has, and the syntax stays at Node 18 level, so an old
 * Node reaches this sentence instead of dying on a SyntaxError.
 */
const tooOld = nodeTooOld(process.version);
if (tooOld) {
	process.stderr.write(tooOld + "\n");
	process.exit(1);
}

//#endregion
//#region src/constants.ts
/** What answers on 127.0.0.1: the page checks `health.name` before it trusts anything else. */
const NAME = "bauloc-device-bridge";
/** Semver of this file. The page shows it and compares it with the published file. */
const VERSION = "1.3.0";
/**
 * The wire protocol's integer major. Within a major only additions are allowed (fields,
 * codes, endpoints, `features`); the page accepts DVC_MIN_AGENT ≤ PROTOCOL ≤ DVC_MAX_AGENT.
 */
const PROTOCOL = 1;
const SITE = "https://bauloc.github.io";
const DEFAULT_PORT = 8787;
/**
 * `npm run dev` (Vite, 7360), `vite preview` (4173) and `npm run serve:site` (8000), on both
 * loopback names. Allowed only with --dev: on a normal run no local web server may drive
 * the phones.
 */
const DEV_ORIGINS = [
	"http://localhost:7360",
	"http://127.0.0.1:7360",
	"http://localhost:4173",
	"http://127.0.0.1:4173",
	"http://localhost:8000",
	"http://127.0.0.1:8000"
];
/** Where testers download this file, and where the "Review the source" links point. */
const DOWNLOAD_URL = `${SITE}/device/agent/device-bridge.mjs`;
const KiB = 1024;
const MiB = 1024 * KiB;
/** Caps (§1.12). Every one bounds something a device, a tool or a page could make unbounded. */
const LIMITS = {
	/** A tool's text output: devicectl JSON, getprop, simctl lists. */
	text: 8 * MiB,
	/** A screenshot: the largest iPad PNG is far below this. */
	png: 32 * MiB,
	/** Only the tail of stderr is kept, for TOOL_FAILED messages. */
	stderr: 64 * KiB,
	/** One log line, after which ` [truncated]` is appended. */
	line: 8 * KiB,
	/** Request bodies: only the Wi-Fi routes read one, a small JSON object (§4.7). */
	body: KiB,
	/** One upstream file in local mode. */
	upstream: 16 * MiB,
	/** usbmuxd and lockdown frames. */
	frame: 4 * MiB,
	/** A `lines` record carries at most this many lines… */
	batchLines: 200,
	/** …and stays far below the page's 1 MiB per-record cap even with 8 KiB lines. */
	batchBytes: 256 * KiB,
	/** Three streams leave room in the browser's six connections per host for polling. */
	streamsTotal: 3,
	maxConnections: 64,
	/** One-shot tools at a time (devicectl, simctl, ideviceinfo…). */
	tools: 4,
	/** Device names, models and versions as listed. */
	name: 200,
	field: 100,
	/** Upstream responses kept in memory by local mode. */
	upstreamEntries: 300,
	/** Devices one Wi-Fi scan reports (§4.8). */
	nearby: 64,
	/** Devices one look at this computer's network reports (§4.9). */
	lanDevices: 256,
	/** Addresses one presence check covers: two /24 networks (§4.9). */
	lanTargets: 512,
	/** Presence sockets open at once (§4.9): a /24 in one go, far below Node's file limit. */
	lanSockets: 256,
	/**
	 * adb tunnels open at once (§4.10), in all and per device. The page reads at most three
	 * previews and two app icons at a time, beside a listing and an install; these leave room
	 * for two tabs, and for the HTTP requests that share `maxConnections`.
	 */
	tunnels: 32,
	tunnelsPerDevice: 16,
	/** One frame from the page: it sends at most 256 KiB at a time. */
	tunnelFrame: 4 * MiB,
	/** The tunnel's opening message, and the service it names (a command line). */
	tunnelHello: 64 * KiB,
	tunnelService: 32 * KiB,
	/** Features one `host:features` answer may list. */
	adbFeatures: 64
};
/** §1.12 timeouts in milliseconds. Tests pass shorter ones through createBridge(). */
const TIMEOUTS = {
	requestTimeout: 3e4,
	headersTimeout: 1e4,
	muxRequest: 2e3,
	muxConnectUsb: 3e3,
	muxConnectNetwork: 6e3,
	lockdownRequest: 5e3,
	lockdownTls: 5e3,
	probeTotal: 12e3,
	detailTotal: 15e3,
	domain: 3e3,
	devicectlScreenshot: 45e3,
	devicectlHelp: 5e3,
	plistBuddy: 2e3,
	xcodeSelect: 2e3,
	xcodebuildLicense: 5e3,
	ideviceinfo: 8e3,
	idevicescreenshot: 2e4,
	simctlList: 1e4,
	simctlScreenshot: 2e4,
	adbConnect: 1e3,
	adbRequest: 5e3,
	adbExec: 1e4,
	adbScreencap: 2e4,
	adbStartPoll: 8e3,
	tunnelHello: 1e4,
	adbNetworkConnect: 2e4,
	adbPair: 15e3,
	mdnsWindow: 2e3,
	systemBrowse: 1500,
	systemResolve: 1500,
	lanPresence: 1e3,
	lanSsdp: 3e3,
	lanDescription: 2e3,
	lanReverse: 1200,
	lanScan: 7e3,
	lanCache: 3e4,
	lanGap: 3e3,
	doctorCheck: 5e3,
	doctorSlowCheck: 1e4,
	doctorTotal: 12e3,
	logFirstByte: 1e4,
	logSilenceSwitch: 8e3,
	logBatch: 100,
	logHello: 3e4,
	upstream: 15e3,
	htmlRevalidate: 6e4,
	killGrace: 1500,
	rescan: 5e3,
	retry: 1e4,
	banner: 3e3,
	portProbe: 2e3,
	toolsCache: 3e4,
	doctorCache: 3e4,
	active: 3e4
};
/**
 * Device id shapes (§2.2). None allows a leading `-`, so an id can never be read as an
 * option by a tool, and none allows `/`, `..` or a space. Matching a shape is necessary,
 * never sufficient: the id must also be in the live device list, and the owning lane
 * comes from the registry, never from which pattern matched.
 */
const ID = {
	ios: /^(?:[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}|[0-9a-f]{40})$/,
	sim: /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/,
	/** An adb serial, or a Wi-Fi device reached over IPv6: `[fe80::1%en0]:5555` (§4.7). */
	android: /^(?:[A-Za-z0-9][\w.:-]{0,127}|\[[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{0,4}){1,7}(?:%[\w-]{1,32})?\]:\d{1,5})$/
};
function isDeviceId(id) {
	return ID.ios.test(id) || ID.sim.test(id) || ID.android.test(id);
}
/** The only lockdown requests a client may send. */
const LOCKDOWN_REQUESTS = [
	"QueryType",
	"GetValue",
	"StartSession",
	"StopSession",
	"StartService"
];
/** The only lockdown services a client may start. */
const LOCKDOWN_SERVICES = ["com.apple.syslog_relay"];
/** The only usbmuxd messages a client may send. */
const MUX_MESSAGES = [
	"ListDevices",
	"Listen",
	"ReadPairRecord",
	"ReadBUID",
	"Connect"
];
/**
 * The Android detail commands, in the order the page's androidDetail() takes their outputs.
 * Must equal DETAIL_COMMANDS.map(c => c.join(' ')) in src/features/device/backends/android.ts
 * (asserted by the page's contract test), so the helper's detail is byte-identical to WebUSB's.
 */
const ADB_DETAIL = [
	["getprop", "getprop"],
	["wmSize", "wm size"],
	["wmDensity", "wm density"],
	["battery", "dumpsys battery"],
	["df", "df /data"],
	["androidId", "settings get secure android_id"]
];
/**
 * Every `exec:` service string the helper sends to adbd: constants only. The serial travels
 * in `host:transport:<serial>` alone, so no page input ever reaches a device command.
 */
const ADB_EXEC = [
	...ADB_DETAIL.map(([, command]) => command),
	"getprop ro.product.model",
	"getprop ro.product.device",
	"getprop ro.build.version.release",
	"screencap -p",
	"logcat -v threadtime -T 200"
];
/**
 * Every row-blocker code the helper can send. The page's contract test checks each one has
 * DEVICE_HINTS wording, so a new code cannot ship without its hint.
 */
const EMITTED_BLOCKERS = [
	"IOS_UNTRUSTED",
	"IOS_LOCKED",
	"IOS_LOCKDOWN_FAILED",
	"IOS_DEVELOPER_MODE_OFF",
	"XCODE_REQUIRED",
	"XCODE_SETUP_REQUIRED",
	"IOS_DDI_REQUIRED",
	"TOOL_MISSING",
	"ANDROID_UNAUTHORIZED",
	"ANDROID_OFFLINE",
	"ANDROID_RECOVERY"
];
/** Install commands named in TOOL_MISSING errors and in the banner. */
const INSTALL = {
	adb: "brew install --cask android-platform-tools",
	libimobiledevice: "brew install libimobiledevice"
};
/** The search targets of each SSDP M-SEARCH: every device and service, and every root device. */
const LAN_SSDP_TARGETS = ["ssdp:all", "upnp:rootdevice"];
/**
 * The only TXT keys a service passes on (§4.9): models, makers, the names owners give their
 * devices, HomeKit's category and Android's API level. Never an id, a serial, a key or an
 * address: `deviceid`, `id`, `pk`, `authTag`, `identifier`, `mac`, `UUID` and the rest stay out.
 */
const LAN_TXT_KEYS = [
	"model",
	"md",
	"fn",
	"ty",
	"product",
	"usb_MFG",
	"usb_MDL",
	"mfg",
	"mdl",
	"am",
	"rpMd",
	"ci",
	"n",
	"given_name",
	"name",
	"api",
	"manufacturer",
	"friendly_name"
];
/**
 * Service types asked about on every look, besides those the network lists: Device Lab's
 * own. macOS's daemon leaves `_adb-tls-connect._tcp` out of its list of types even while it
 * knows a phone that advertises it [V 2026-10-04].
 */
const LAN_STATIC_TYPES = [
	"_adb._tcp",
	"_adb-tls-connect._tcp",
	"_adb-tls-pairing._tcp",
	"_androidtvremote2._tcp",
	"_googlecast._tcp",
	"_apple-mobdev2._tcp",
	"_remotepairing._tcp"
];

//#endregion
//#region src/cli.ts
/** A bad command line, worded for the terminal; exit 64. */
var UsageError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "UsageError";
	}
};
/**
 * Boolean flags. There is deliberately no --host, --api or --token: no flag may widen who can
 * reach the helper, and no secret is ever passed on a command line (other users can read
 * process arguments).
 */
const FLAGS = {
	"--no-open": (o) => {
		o.open = false;
	},
	"--keep-token": (o) => {
		o.keepToken = true;
	},
	"--new-token": (o) => {
		o.newToken = true;
	},
	"--wifi": (o) => {
		o.wifi = true;
	},
	"--simulators": (o) => {
		o.simulators = true;
	},
	"--no-android": (o) => {
		o.android = false;
	},
	"--no-local": (o) => {
		o.local = false;
	},
	"--dev": (o) => {
		o.dev = true;
	},
	"--verbose": (o) => {
		o.verbose = true;
	},
	"--doctor": (o) => {
		o.doctor = true;
	},
	"--version": (o) => {
		o.version = true;
	},
	"--help": (o) => {
		o.help = true;
	},
	"-h": (o) => {
		o.help = true;
	}
};
/**
 * How to show this file in a command the tester can paste back: `~/device-bridge.mjs` when
 * it lives under the home folder, otherwise the path as it was typed, quoted for the shell
 * when it needs to be.
 */
function scriptHint(scriptPath, home, cwd) {
	if (!scriptPath) return "~/device-bridge.mjs";
	const absolute = path.resolve(cwd, scriptPath);
	const inHome = path.relative(home, absolute);
	const plain = (text) => /^[\w@%+=:,./-]+$/.test(text);
	const quote = (text) => `'${text.replace(/'/g, `'\\''`)}'`;
	if (home && inHome && !inHome.startsWith("..") && !path.isAbsolute(inHome)) return plain(inHome) ? `~/${inHome}` : `~/${quote(inHome)}`;
	const relative = path.relative(cwd, absolute);
	const shown = relative && relative.length < absolute.length ? relative : absolute;
	return plain(shown) ? shown : quote(shown);
}
function parsePort(value, script) {
	const port = value !== void 0 && /^\d{1,5}$/.test(value) ? Number(value) : NaN;
	if (!(port >= 1024 && port <= 65535)) throw new UsageError(`--port needs a whole number from 1024 to 65535${value === void 0 ? "" : ` (got "${value}")`}. Run: node ${script} --help`);
	return port;
}
/** Parse argv (without node and the script). Throws UsageError for anything unknown. */
function parseCli(argv, script = "device-bridge.mjs") {
	const options = {
		port: DEFAULT_PORT,
		open: true,
		keepToken: false,
		newToken: false,
		wifi: false,
		simulators: false,
		android: true,
		local: true,
		dev: false,
		verbose: false,
		doctor: false,
		help: false,
		version: false
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg === "--port") {
			options.port = parsePort(argv[++i], script);
			continue;
		}
		if (arg.startsWith("--port=")) {
			options.port = parsePort(arg.slice(7), script);
			continue;
		}
		const flag = FLAGS[arg];
		if (!flag) throw new UsageError(`Unknown option ${arg}. Run: node ${script} --help`);
		flag(options);
	}
	if (options.newToken && !options.keepToken) throw new UsageError(`--new-token works only with --keep-token. Run: node ${script} --help`);
	return options;
}
function helpText(script) {
	return `node ${script} [options]

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
`;
}

//#endregion
//#region src/util.ts
/**
 * An error the helper raises on purpose. `code` is what the page maps to wording, `status`
 * the HTTP status, and `extra` lands next to them in the error body (tool, install, state,
 * blockers). Lanes throw these; anything else that reaches the HTTP layer is a bug (500).
 */
var HelperError = class extends Error {
	code;
	status;
	extra;
	constructor(code, status, message, extra = {}) {
		super(message);
		this.name = "HelperError";
		this.code = code;
		this.status = status;
		this.extra = extra;
	}
};
/** The error an aborted wait rejects with, recognisable by isAbortError(). */
function abortError() {
	const error = new Error("The operation was aborted.");
	error.name = "AbortError";
	return error;
}
function isAbortError(error) {
	return error instanceof Error && error.name === "AbortError";
}
function errorText(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
 * At most `n` tasks at once; the rest wait in order. One-shot tools go through one of these
 * (4), so a page hammering Refresh cannot fork forty devicectl processes.
 */
function createLimiter(n) {
	let active = 0;
	const queue = [];
	const next = () => {
		if (active >= n) return;
		const run = queue.shift();
		if (!run) return;
		active++;
		run();
	};
	return (fn) => new Promise((resolve, reject) => {
		queue.push(() => {
			Promise.resolve().then(fn).then(resolve, reject).finally(() => {
				active--;
				next();
			});
		});
		next();
	});
}
/**
 * Concurrent callers for one key share the task in flight instead of starting another:
 * "probe and detail are single-flight per device" (§1.3).
 */
function singleFlight() {
	const inflight = new Map();
	return {
		run(key, fn) {
			const current = inflight.get(key);
			if (current) return current;
			const task = Promise.resolve().then(fn).finally(() => {
				if (inflight.get(key) === task) inflight.delete(key);
			});
			inflight.set(key, task);
			return task;
		},
		has: (key) => inflight.has(key)
	};
}
/** Rejects with `onTimeout()` when `promise` has not settled within `ms`. */
function withTimeout(promise, ms, onTimeout) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(onTimeout()), ms);
		promise.then((value) => {
			clearTimeout(timer);
			resolve(value);
		}, (error) => {
			clearTimeout(timer);
			reject(error instanceof Error ? error : new Error(String(error)));
		});
	});
}
/** Resolves after `ms`; rejects with an AbortError as soon as `signal` aborts. */
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(abortError());
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError());
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
/** Resolves (never rejects) once `signal` aborts: for racing work against a deadline. */
function aborted(signal) {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		signal.addEventListener("abort", () => resolve(), { once: true });
	});
}
/**
 * One AbortSignal that aborts when any parent does, after `timeoutMs`, or on abort().
 * AbortSignal.any() would do this, but it arrived in Node 20 and this file runs on 18.
 *
 * Neither it nor its parents cap their abort listeners, as no AbortSignal does on Node 24:
 * a parent holds one per signal linked to it (every request and adb exchange links to the
 * bridge's shutdown signal), and a linked signal one per process, socket or wait of its work
 * (a dns-sd run: two per process). Node 18 and 20 cap them at 10 and print a
 * MaxListenersExceededWarning, in the tester's terminal, past it.
 */
function linkSignals(parents, timeoutMs) {
	const controller = new AbortController();
	const abort = () => controller.abort();
	const live = parents.filter((parent) => parent !== void 0);
	setMaxListeners(0, controller.signal, ...live);
	let timer;
	const dispose = () => {
		for (const parent of live) parent.removeEventListener("abort", abort);
		if (timer) clearTimeout(timer);
	};
	for (const parent of live) if (parent.aborted) controller.abort();
	else parent.addEventListener("abort", abort, { once: true });
	if (timeoutMs !== void 0 && !controller.signal.aborted) {
		timer = setTimeout(abort, timeoutMs);
		timer.unref();
	}
	controller.signal.addEventListener("abort", dispose, { once: true });
	return {
		signal: controller.signal,
		abort,
		dispose
	};
}
/**
 * ANSI escape sequences (CSI, OSC, and two-character escapes), then every control character
 * but tab, including the C1 range a decoded byte stream can contain. Log lines and device
 * names come from devices and tools: they reach a terminal and a page, and must not be
 * able to move a cursor, ring a bell or hide text in either.
 */
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g;
const CONTROL = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/g;
/** Strip escape sequences and control characters (tab survives), then cap at `max`. */
function clean(text, max) {
	const out = text.replace(ANSI, "").replace(CONTROL, "");
	return out.length > max ? out.slice(0, max) : out;
}
/**
 * Bytes in, clean lines out, one callback per chunk. UTF-8 safe across chunk boundaries
 * (StringDecoder), CR stripped, escapes and control characters removed. A line longer than
 * `maxLine` is cut there with ` [truncated]` and the rest of it is dropped up to the next
 * newline, so one runaway line cannot become many.
 */
function splitLines(onLines, maxLine = LIMITS.line) {
	const decoder = new StringDecoder("utf8");
	let carry = "";
	let skipping = false;
	/** CR goes with the other control characters; the cap is judged on what is left. */
	const emit = (raw, out, cut) => {
		const text = clean(raw, Number.MAX_SAFE_INTEGER);
		out.push(text.length > maxLine || cut ? text.slice(0, maxLine) + " [truncated]" : text);
	};
	const take = (text, out) => {
		let start = 0;
		for (let nl = text.indexOf("\n"); nl >= 0; nl = text.indexOf("\n", start)) {
			const piece = text.slice(start, nl);
			start = nl + 1;
			if (skipping) skipping = false;
			else emit(carry + piece, out, false);
			carry = "";
		}
		if (skipping) return;
		carry += text.slice(start);
		/** Raw length bounds memory; four times the cap leaves room for escapes clean() drops. */
		if (carry.length > maxLine * 4) {
			emit(carry, out, true);
			carry = "";
			skipping = true;
		}
	};
	return {
		write(chunk) {
			const out = [];
			take(typeof chunk === "string" ? chunk : decoder.write(chunk), out);
			if (out.length) onLines(out);
		},
		end() {
			const out = [];
			take(decoder.end(), out);
			if (carry && !skipping) emit(carry, out, false);
			carry = "";
			skipping = false;
			if (out.length) onLines(out);
		}
	};
}
const PNG_SIGNATURE = Buffer.from([
	137,
	80,
	78,
	71,
	13,
	10,
	26,
	10
]);
/** The IEND chunk every complete PNG ends with: zero length, the type, and its CRC. */
const PNG_END = Buffer.from([
	0,
	0,
	0,
	0,
	73,
	69,
	78,
	68,
	174,
	66,
	96,
	130
]);
/**
 * The PNG inside a tool's output, or null when there is none: the same rule as the page's
 * extractPng() in backends/android.ts. Text can come first (screencap warns about phones
 * with two displays) and after; an image cut short by a pulled cable has no IEND chunk and
 * is refused rather than served as a broken file.
 */
function extractPng(bytes) {
	const start = bytes.indexOf(PNG_SIGNATURE);
	if (start < 0) return null;
	const end = bytes.lastIndexOf(PNG_END);
	if (end <= start) return null;
	return bytes.subarray(start, end + PNG_END.length);
}
/** `08:41:02`, local time: the prefix of every terminal line. */
function timeOfDay(epochMs) {
	return new Date(epochMs).toTimeString().slice(0, 8);
}
/** `1.4` for 1 400 ms: how the terminal reports durations. */
function seconds(ms) {
	return (ms / 1e3).toFixed(1);
}
function plural(n, one, many = one + "s") {
	return `${String(n)} ${n === 1 ? one : many}`;
}

//#endregion
//#region src/plist.ts
/**
 * XML property lists: what usbmuxd and lockdownd speak, and what `ideviceinfo -x` prints.
 * Only the XML form: both daemons answer in the form they are asked in, and binary plists
 * reach the helper nowhere it parses one (CoreDevice's Info.plist is read by PlistBuddy).
 */
const ENTITIES$1 = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: "\"",
	apos: "'"
};
function unescapeXml(text) {
	return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, entity) => {
		if (entity.startsWith("#")) {
			const hex = entity[1]?.toLowerCase() === "x";
			const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
			return code >= 0 && code <= 1114111 ? String.fromCodePoint(code) : match;
		}
		return ENTITIES$1[entity] ?? match;
	});
}
function escapeXml(text) {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
/** A plist the helper cannot read: a protocol error, never a crash. */
function malformed(why) {
	return new HelperError("INTERNAL", 500, `A device sent a malformed property list (${why}).`);
}
/** `<integer>`: exact as a BigInt beyond 2^53 (ECIDs reach 2^64), a number otherwise. */
function parseInteger(raw) {
	const text = raw.trim();
	if (!/^[+-]?\d{1,40}$/.test(text)) throw malformed(`integer ${JSON.stringify(text.slice(0, 20))}`);
	const big = BigInt(text);
	return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
}
/**
 * An XML plist as plain values. Integers beyond 2^53 stay exact as BigInt, <data> becomes a
 * Buffer, <date> stays an ISO string, <real> a number. Returns undefined when there is no
 * root value; throws HelperError on an integer or nesting it cannot read.
 *
 * It scans tags rather than building a DOM: plists from devices are small, flat and
 * well-formed, and every value is escaped, so a `<` never appears inside a string.
 */
function parsePlist(xml) {
	const tags = /<(\/?)(dict|array|key|string|integer|real|true|false|data|date)(\s*\/)?>/g;
	const stack = [];
	let root;
	let key = null;
	let textStart = 0;
	const put = (value) => {
		const top = stack[stack.length - 1];
		if (!top) {
			if (root === void 0) root = value;
			return;
		}
		if (Array.isArray(top)) top.push(value);
		else if (key !== null) {
			top[key] = value;
			key = null;
		}
	};
	for (let m = tags.exec(xml); m; m = tags.exec(xml)) {
		const [, close, tag, selfClose] = m;
		if (!close && (tag === "dict" || tag === "array")) {
			const value = tag === "dict" ? {} : [];
			put(value);
			if (!selfClose) {
				/** A hostile depth would only cost recursion elsewhere; nothing real nests this deep. */
				if (stack.length >= 64) throw malformed("nested too deeply");
				stack.push(value);
			}
		} else if (close && (tag === "dict" || tag === "array")) stack.pop();
		else if (tag === "true" || tag === "false") put(tag === "true");
		else if (!close) {
			if (selfClose) {
				if (tag === "key") key = "";
				else put(tag === "data" ? Buffer.alloc(0) : tag === "integer" ? 0 : tag === "real" ? 0 : "");
				continue;
			}
			textStart = tags.lastIndex;
		} else {
			const raw = xml.slice(textStart, m.index);
			if (tag === "key") key = unescapeXml(raw);
			else if (tag === "string") put(unescapeXml(raw));
			else if (tag === "integer") put(parseInteger(raw));
			else if (tag === "real") put(parseFloat(raw.trim()));
			else if (tag === "data") put(Buffer.from(raw.replace(/\s+/g, ""), "base64"));
			else if (tag === "date") put(raw.trim());
		}
	}
	return root;
}
/** One value as XML. Dictionary keys keep their insertion order, as Apple's writers do. */
function encode(value) {
	if (typeof value === "string") return `<string>${escapeXml(value)}</string>`;
	if (typeof value === "boolean") return value ? "<true/>" : "<false/>";
	if (typeof value === "bigint") return `<integer>${value.toString()}</integer>`;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("A plist cannot hold NaN or Infinity.");
		return Number.isInteger(value) ? `<integer>${String(value)}</integer>` : `<real>${String(value)}</real>`;
	}
	if (Buffer.isBuffer(value)) return `<data>${value.toString("base64")}</data>`;
	if (value instanceof Date) return `<date>${value.toISOString().replace(/\.\d{3}Z$/, "Z")}</date>`;
	if (Array.isArray(value)) return `<array>${value.map(encode).join("")}</array>`;
	return `<dict>${Object.entries(value).filter((entry) => entry[1] !== void 0).map(([k, v]) => `<key>${escapeXml(k)}</key>${encode(v)}`).join("")}</dict>`;
}
/**
 * An XML plist document for `value`, in the shape usbmuxd and lockdownd expect (the same
 * prologue and DOCTYPE libimobiledevice sends). Numbers that are whole become <integer>,
 * others <real>; a BigInt is always an <integer>.
 */
function buildPlist(value) {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">${encode(value)}</plist>\n`;
}
/** A dictionary, or null: replies are only ever read through this guard. */
function asDict(value) {
	return value !== void 0 && typeof value === "object" && !Array.isArray(value) && !Buffer.isBuffer(value) ? value : null;
}

//#endregion
//#region src/process.ts
/**
 * Every child still holding a pipe, across the process. The synchronous `exit` hook
 * SIGKILLs whatever is left in here, so no tool outlives the helper however it ends.
 */
const liveChildren = new Set();
/**
 * Variables that would silently point a device tool at another device or tunnel than the
 * one the page asked for. A tester's shell may have them set from earlier work.
 */
const REDIRECTING_ENV = [
	"PYMOBILEDEVICE3_UDID",
	"PYMOBILEDEVICE3_TUNNEL",
	"PYMOBILEDEVICE3_USBMUX",
	"ANDROID_SERIAL"
];
/** The environment every tool runs with: `base` minus REDIRECTING_ENV, plus NO_COLOR and `extra`. */
function childEnv(extra = {}, base = process.env) {
	const env = { ...base };
	for (const name of REDIRECTING_ENV) delete env[name];
	return {
		...env,
		NO_COLOR: "1",
		...extra
	};
}
/**
 * Signal the child's whole process group. Tools run detached, so each leads its own group:
 * a grandchild (simctl's log, a Python tool's helper) dies with it, and the terminal's
 * Ctrl+C, which only reaches the foreground group, never reaches them; the helper must.
 */
function signalTree(child, signal) {
	if (child.pid) try {
		process.kill(-child.pid, signal);
		return;
	} catch (error) {
		if (error.code === "ESRCH") return;
	}
	try {
		child.kill(signal);
	} catch {}
}
/** Why a tool run failed, with what it printed. The HTTP layer maps `reason` to a code. */
var ToolError = class extends Error {
	reason;
	file;
	code;
	signal;
	stdout;
	stderr;
	constructor(reason, file, detail = {}) {
		super(`${path.basename(file)}: ${reason}`, { cause: detail.cause });
		this.name = "ToolError";
		this.reason = reason;
		this.file = file;
		this.code = detail.code ?? null;
		this.signal = detail.signal ?? null;
		this.stdout = detail.stdout ?? "";
		this.stderr = detail.stderr ?? "";
	}
};
function runTool(file, argv, opts = {}) {
	const { timeoutMs = 15e3, maxBytes = opts.encoding === "buffer" ? LIMITS.png : LIMITS.text, maxStderr = LIMITS.stderr, signal, cwd = os.tmpdir(), env = childEnv(), killGraceMs = TIMEOUTS.killGrace, encoding = "utf8", track } = opts;
	return new Promise((resolve, reject) => {
		if (!path.isAbsolute(file)) return reject(new ToolError("not-found", file));
		if (signal?.aborted) return reject(new ToolError("aborted", file));
		let child;
		try {
			child = spawn(file, argv, {
				shell: false,
				detached: true,
				stdio: [
					"ignore",
					"pipe",
					"pipe"
				],
				cwd,
				env
			});
		} catch (error) {
			return reject(new ToolError("spawn-failed", file, { cause: error }));
		}
		liveChildren.add(child);
		track?.add(child);
		const out = [];
		let outLength = 0;
		const err = [];
		let errLength = 0;
		let stopped = null;
		let spawnError = null;
		let settled = false;
		let escalate;
		let lingering;
		const stop = (why) => {
			if (stopped) return;
			stopped = why;
			signalTree(child, "SIGTERM");
			escalate = setTimeout(() => signalTree(child, "SIGKILL"), killGraceMs);
			escalate.unref();
		};
		const timer = setTimeout(() => stop("timeout"), timeoutMs);
		const onAbort = () => stop("aborted");
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout?.on("data", (chunk) => {
			outLength += chunk.length;
			if (outLength > maxBytes) stop("too-large");
			else out.push(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			err.push(chunk);
			errLength += chunk.length;
			while (errLength - (err[0]?.length ?? 0) >= maxStderr && err.length > 1) errLength -= err.shift()?.length ?? 0;
		});
		child.on("error", (error) => {
			spawnError = error;
		});
		const settle = (code, sig) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(lingering);
			signal?.removeEventListener("abort", onAbort);
			/** A tool we stopped may have left members in its group; finish them. */
			if (stopped) signalTree(child, "SIGKILL");
			if (escalate) clearTimeout(escalate);
			const stdoutBuffer = Buffer.concat(out);
			const detail = {
				code,
				signal: sig,
				stdout: encoding === "buffer" ? stdoutBuffer : stdoutBuffer.toString("utf8"),
				stderr: Buffer.concat(err).toString("utf8").slice(-maxStderr)
			};
			if (spawnError) {
				const reason = spawnError.code === "ENOENT" ? "not-found" : "spawn-failed";
				return reject(new ToolError(reason, file, {
					...detail,
					cause: spawnError
				}));
			}
			if (stopped) return reject(new ToolError(stopped, file, detail));
			if (code !== 0) return reject(new ToolError("exit", file, detail));
			resolve({
				code,
				stdout: detail.stdout,
				stderr: detail.stderr
			});
		};
		child.on("exit", (code, sig) => {
			lingering = setTimeout(() => {
				/**
				 * The tool is gone but something it started still holds stdout: kill the group,
				 * stop waiting for the pipe, and settle with what arrived.
				 */
				signalTree(child, "SIGKILL");
				child.stdout?.destroy();
				child.stderr?.destroy();
				settle(code, sig);
			}, 1e3);
			lingering.unref();
		});
		child.on("close", (code, sig) => {
			liveChildren.delete(child);
			track?.delete(child);
			settle(code, sig);
		});
	});
}
/**
 * A long-running tool (a log stream) under the same rules as runTool, read line by line.
 * The caller owns the lifetime: abort the signal or call kill(), and the group dies.
 */
function streamTool(file, argv, opts) {
	const { signal, cwd = os.tmpdir(), env = childEnv(), onLines, onStderrLines, track } = opts;
	const maxLine = opts.maxLine ?? LIMITS.line;
	const killGraceMs = opts.killGraceMs ?? TIMEOUTS.killGrace;
	if (!path.isAbsolute(file)) return idleHandle(new ToolError("not-found", file));
	let child;
	try {
		child = spawn(file, argv, {
			shell: false,
			detached: true,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			cwd,
			env
		});
	} catch (error) {
		return idleHandle(new ToolError("spawn-failed", file, { cause: error }));
	}
	liveChildren.add(child);
	track?.add(child);
	let stopped = false;
	let escalate;
	const kill = () => {
		if (stopped) return;
		stopped = true;
		signalTree(child, "SIGTERM");
		escalate = setTimeout(() => signalTree(child, "SIGKILL"), killGraceMs);
		escalate.unref();
	};
	const onAbort = () => kill();
	if (signal?.aborted) kill();
	else signal?.addEventListener("abort", onAbort, { once: true });
	const stdoutLines = splitLines(onLines, maxLine);
	child.stdout?.on("data", (chunk) => stdoutLines.write(chunk));
	child.stdout?.on("end", () => stdoutLines.end());
	let stderrTail = "";
	const stderrLines = onStderrLines ? splitLines(onStderrLines, maxLine) : null;
	child.stderr?.on("data", (chunk) => {
		if (stderrLines) stderrLines.write(chunk);
		else stderrTail = (stderrTail + chunk.toString("utf8")).slice(-LIMITS.stderr);
	});
	child.stderr?.on("end", () => stderrLines?.end());
	const done = new Promise((resolve, reject) => {
		let spawnError = null;
		let settled = false;
		let lingering;
		const settle = (code, sig) => {
			if (settled) return;
			settled = true;
			clearTimeout(lingering);
			if (escalate) clearTimeout(escalate);
			signal?.removeEventListener("abort", onAbort);
			if (stopped) signalTree(child, "SIGKILL");
			if (spawnError) {
				const reason = spawnError.code === "ENOENT" ? "not-found" : "spawn-failed";
				return reject(new ToolError(reason, file, {
					stderr: stderrTail,
					cause: spawnError
				}));
			}
			resolve({
				code,
				signal: sig,
				stderr: stderrTail,
				stopped
			});
		};
		child.on("error", (error) => {
			spawnError = error;
		});
		child.on("exit", (code, sig) => {
			lingering = setTimeout(() => {
				signalTree(child, "SIGKILL");
				child.stdout?.destroy();
				child.stderr?.destroy();
				settle(code, sig);
			}, 1e3);
			lingering.unref();
		});
		child.on("close", (code, sig) => {
			liveChildren.delete(child);
			track?.delete(child);
			settle(code, sig);
		});
	});
	/** A lane that never awaits `done` must not turn a failed start into a crash of the helper. */
	done.catch(() => void 0);
	return {
		pid: child.pid,
		pause: () => child.stdout?.pause(),
		resume: () => child.stdout?.resume(),
		kill,
		done
	};
}
/** A handle for a tool that never started: nothing to pause or kill. */
function idleHandle(error) {
	const done = Promise.reject(error);
	done.catch(() => void 0);
	return {
		pid: void 0,
		pause() {},
		resume() {},
		kill() {},
		done
	};
}
/**
 * TERM every group in `children`, wait until they are gone or the grace period ends, then
 * KILL what is left. Shutdown uses it on its own children; the exit hook is the backstop.
 */
async function killAll(graceMs = TIMEOUTS.killGrace, children = liveChildren) {
	for (const child of children) signalTree(child, "SIGTERM");
	const deadline = Date.now() + graceMs;
	while (children.size > 0 && Date.now() < deadline) await sleep(25);
	for (const child of children) signalTree(child, "SIGKILL");
}
const exitDirs = new Set();
let exitHooked = false;
/**
 * The last line of defence, synchronous because nothing async runs in an `exit` handler:
 * however the process ends (a return, process.exit, an uncaught exception), every tool
 * group still alive is SIGKILLed and every registered work directory is removed.
 * Returns the function that unregisters `dir`.
 */
function cleanUpOnExit(dir) {
	if (!exitHooked) {
		exitHooked = true;
		process.on("exit", () => {
			for (const child of liveChildren) signalTree(child, "SIGKILL");
			for (const each of exitDirs) try {
				rmSync(each, {
					recursive: true,
					force: true
				});
			} catch {}
		});
	}
	if (dir) exitDirs.add(dir);
	return () => {
		if (dir) exitDirs.delete(dir);
	};
}

//#endregion
//#region src/tools.ts
/**
 * §4b Finding tools: which binaries this Mac has, which of them the helper may run, and in
 * what state Xcode is, without ever running something that changes the Mac.
 *
 * Three rules shape everything here:
 * - Only absolute paths run. which() skips relative PATH entries, and system tools are
 *   called by their fixed paths (the options), never looked up.
 * - Apple's shims never run: `xcrun`, `/usr/bin/python3` and `/usr/bin/java` can open an
 *   "install the developer tools" or "install Java" dialog on a Mac without them.
 * - Xcode's `devicectl` and `simctl` are wrapper scripts that run `xcodebuild
 *   -runFirstLaunch` when CoreDevice or CoreSimulator is out of date. The helper reads the
 *   wrapper instead of running it, predicts its verdict exactly, and runs the real binary.
 *
 * resolveTools() is the fast part every lane reads (the bridge caches it 30 s); the slow,
 * optional checks (pymobiledevice3, bundletool, Java) run only for the checklist (§12).
 */
/** The ToolOptions part of the bridge's options (§1.6), with the runner to use. */
function toolOptionsFrom(options, runTool) {
	return {
		searchPath: options.searchPath,
		extraDirs: options.extraDirs,
		home: options.home,
		env: options.env,
		platform: options.platform,
		xcodeSelectPath: options.xcodeSelectPath,
		plistBuddyPath: options.plistBuddyPath,
		javaHomePath: options.javaHomePath,
		applicationsDir: options.applicationsDir,
		coreDeviceDir: options.coreDeviceDir,
		coreSimulatorDir: options.coreSimulatorDir,
		runTool,
		timeouts: options.timeouts,
		now: options.now
	};
}
/** Where Homebrew puts its commands on Apple silicon and on Intel Macs. */
const BREW_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];
/** python.org's installer links its commands here, whichever version is current. */
const PYTHON_ORG_BIN = "/Library/Frameworks/Python.framework/Versions/Current/bin";
/**
 * Where to look besides PATH (§1.5). A helper started from an IDE task or a launch agent
 * often has a thin PATH; Homebrew, the Android SDK and python.org still live in these places.
 */
function extraDirsFor(name, opts) {
	const dirs = [...BREW_DIRS];
	if (name === "adb") {
		for (const root of [opts.env.ANDROID_HOME, opts.env.ANDROID_SDK_ROOT]) if (root) dirs.push(path.join(root, "platform-tools"));
		dirs.push(path.join(opts.home, "Library/Android/sdk/platform-tools"));
	}
	if (name === "pymobiledevice3" || name === "python3") {
		dirs.push(PYTHON_ORG_BIN);
		dirs.push(path.join(opts.home, ".local/bin"));
	}
	return dirs;
}
/**
 * An executable regular file named `name` in an absolute PATH entry or an extra directory,
 * or null. Empty and relative entries ('' and '.') are skipped: they resolve against the
 * working directory, often ~/Downloads, where a planted `adb` would otherwise run.
 * `reject` passes over a match and keeps looking (Apple's python3 shim, say).
 */
function which(name, opts) {
	const seen = new Set();
	for (const dir of [...opts.searchPath.split(path.delimiter), ...opts.extraDirs]) {
		if (!dir || !path.isAbsolute(dir) || seen.has(dir)) continue;
		seen.add(dir);
		const file = path.join(dir, name);
		if (isExecutable$1(file) && !opts.reject?.(file)) return file;
	}
	return null;
}
function isExecutable$1(file) {
	try {
		accessSync(file, constants.X_OK);
		return statSync(file).isFile();
	} catch {
		return false;
	}
}
/** which() with the §1.5 search rules for `name`. */
function find(name, opts, reject) {
	const extraDirs = opts.extraDirs ?? extraDirsFor(name, opts);
	return which(name, {
		searchPath: opts.searchPath,
		extraDirs,
		reject
	});
}
function found(name, opts) {
	const file = find(name, opts);
	return file ? {
		path: file,
		version: null
	} : null;
}
/**
 * Apple's stand-ins in /usr/bin (python3, java, xcrun): each is a shim that may open an
 * install dialog instead of running anything, so a tool found there is never started.
 */
function isAppleShim(file) {
	return path.dirname(file) === "/usr/bin";
}
/** Homebrew's `brew`, which decides whether a fix may start with `brew install`. */
function findBrew(opts) {
	return which("brew", {
		searchPath: opts.searchPath,
		extraDirs: opts.extraDirs ?? BREW_DIRS
	});
}
async function isFile(file) {
	try {
		return (await stat(file)).isFile();
	} catch {
		return false;
	}
}
async function isDirectory(dir) {
	try {
		return (await stat(dir)).isDirectory();
	} catch {
		return false;
	}
}
/** The start of a file (a wrapper script, a shebang); null when it cannot be read. */
async function readHead(file, bytes) {
	let handle;
	try {
		handle = await open(file, "r");
		const buffer = Buffer.alloc(bytes);
		const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} catch {
		return null;
	} finally {
		await handle?.close();
	}
}
/** Shell-quotes a path for a command the tester copies, only when it needs it. */
function shellQuote(arg) {
	return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}
/**
 * Whether `file` sits in a directory of `searchPath`. which() looks there before its extra
 * directories, so then the bare name, typed in the tester's terminal, runs this very file.
 */
function onSearchPath(file, searchPath) {
	return searchPath.split(path.delimiter).filter((dir) => path.isAbsolute(dir)).some((dir) => path.resolve(dir) === path.dirname(file));
}
/**
 * `adb` as a command the tester copies names it: bare when their PATH reaches the adb found,
 * else its full path (one in ~/Library/Android/sdk/platform-tools, say, is found by the
 * helper but is "command not found" in the terminal).
 */
function adbCommand(adb, searchPath) {
	return !adb || onSearchPath(adb.path, searchPath) ? "adb" : shellQuote(adb.path);
}
/** `1107.0.0` → `1107`: the simctl wrapper's canonical form before it compares. */
function canonicalVersion(version) {
	let v = version;
	while (v.endsWith(".0")) v = v.slice(0, -2);
	return v;
}
/** Compares dotted versions numerically by component (`1171.10` > `1171.9`): -1, 0 or 1. */
function compareVersions(a, b) {
	const pa = a.split(".");
	const pb = b.split(".");
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const x = parseInt(pa[i] ?? "0", 10) || 0;
		const y = parseInt(pb[i] ?? "0", 10) || 0;
		if (x !== y) return x < y ? -1 : 1;
	}
	return 0;
}
/**
 * Reads Xcode 26+'s devicectl/simctl wrapper (zsh/bash) as text. These three lines are all
 * it decides on [V]; the target is the real binary in CoreDevice or CoreSimulator.
 */
function parseWrapper(text) {
	return {
		expected: /EXPECTED_VERSION="([^"]+)"/.exec(text)?.[1] ?? null,
		plist: /PlistBuddy -c "Print :CFBundleVersion" "([^"]+)"/.exec(text)?.[1] ?? null,
		target: /exec "([^"]+)"/.exec(text)?.[1] ?? null
	};
}
/** `…/Xcode.app/Contents/Developer`, as opposed to the Command Line Tools' directory. */
function isXcodeDevDir(dir) {
	return /\.app\/Contents\/Developer\/?$/.test(dir);
}
/**
 * The developer directory the wrappers would use: DEVELOPER_DIR when it names a directory,
 * else `xcode-select -p`. Null when neither answers (xcode-select exits 2 with nothing set).
 */
async function developerDir(opts) {
	const fromEnv = opts.env.DEVELOPER_DIR;
	if (fromEnv && path.isAbsolute(fromEnv) && await isDirectory(fromEnv)) return fromEnv;
	try {
		const { stdout } = await opts.runTool(opts.xcodeSelectPath, ["-p"], { timeoutMs: opts.timeouts.xcodeSelect });
		const dir = stdout.trim();
		return path.isAbsolute(dir) ? dir : null;
	} catch {
		return null;
	}
}
/** Xcode's version.plist (XML [V]): `27.0` and `27A266a`. */
async function xcodeVersion(devDir) {
	try {
		const plist = asDict(parsePlist(await readFile(path.join(devDir, "../version.plist"), "utf8")));
		const version = plist?.CFBundleShortVersionString;
		const build = plist?.ProductBuildVersion;
		return {
			version: typeof version === "string" ? version : null,
			build: typeof build === "string" ? build : null
		};
	} catch {
		return {
			version: null,
			build: null
		};
	}
}
/**
 * Xcodes in /Applications that ship `tool`, best first: `Xcode.app` (what the App Store
 * installs, so what the tester expects), then the highest version (Xcode-beta, Xcode_26.app).
 */
async function installedXcodes(opts, tool) {
	let names;
	try {
		names = await readdir(opts.applicationsDir);
	} catch {
		return [];
	}
	const apps = [];
	for (const name of names.filter((n) => /^Xcode[^/]*\.app$/.test(n)).sort()) {
		const devDir = path.join(opts.applicationsDir, name, "Contents/Developer");
		if (await isFile(path.join(devDir, "usr/bin", tool))) apps.push({
			name,
			devDir,
			...await xcodeVersion(devDir)
		});
	}
	return apps.sort((a, b) => {
		if (a.name === "Xcode.app" || b.name === "Xcode.app") return a.name === "Xcode.app" ? -1 : 1;
		return compareVersions(b.version ?? "0", a.version ?? "0");
	});
}
/** CFBundleVersion through PlistBuddy (CoreDevice's plist is binary [V]); '' on any failure. */
async function bundleVersion(opts, plist) {
	try {
		const { stdout } = await opts.runTool(opts.plistBuddyPath, [
			"-c",
			"Print :CFBundleVersion",
			plist
		], { timeoutMs: opts.timeouts.plistBuddy });
		return stdout.trim();
	} catch {
		return "";
	}
}
/**
 * Predicts whether a wrapper would run `xcodebuild -runFirstLaunch`, without running it.
 * devicectl's wrapper wants an exact CoreDevice version; simctl's wants CoreSimulator not
 * to be older (trailing `.0`s removed). A failed PlistBuddy reads as '' and fails both, as
 * it does in the wrappers. A file that is not a script is an older Xcode's real binary.
 */
async function firstLaunchGate(opts, wrapper, defaultPlist, rule) {
	const text = await readHead(wrapper, 65536);
	if (text !== null && !text.startsWith("#!")) return {
		ready: true,
		target: wrapper,
		current: null,
		expected: null
	};
	const facts = parseWrapper(text ?? "");
	if (!facts.expected || !facts.target || !path.isAbsolute(facts.target)) return {
		ready: false,
		target: wrapper,
		current: null,
		expected: facts.expected
	};
	const current = await bundleVersion(opts, facts.plist ?? defaultPlist);
	return {
		ready: rule === "exact" ? current === facts.expected : current !== "" && compareVersions(canonicalVersion(current), canonicalVersion(facts.expected)) >= 0,
		target: facts.target,
		current,
		expected: facts.expected
	};
}
const NO_XCODE = {
	state: "not-installed",
	devDir: null,
	version: null,
	build: null,
	devicectl: null,
	coreDevice: null,
	expected: null,
	license: null,
	suggest: null
};
const NO_SIMCTL = {
	state: "not-installed",
	devDir: null,
	simctl: null,
	coreSimulator: null,
	expected: null,
	suggest: null
};
/** A Toolbox with nothing found: the starting point, and what a failed resolve falls back to. */
function emptyToolbox(checkedAt) {
	return {
		checkedAt,
		xcode: { ...NO_XCODE },
		simctl: { ...NO_SIMCTL },
		ideviceinfo: null,
		idevicesyslog: null,
		idevicescreenshot: null,
		adb: null,
		pymobiledevice3: null,
		bundletool: null
	};
}
/**
 * `xcodebuild -license check`: true when accepted, false when it says no, null when it
 * could not tell (missing, too slow). It only ever words a warning.
 */
async function licenseAccepted(opts, devDir) {
	try {
		await opts.runTool(path.join(devDir, "usr/bin/xcodebuild"), ["-license", "check"], {
			timeoutMs: opts.timeouts.xcodebuildLicense,
			env: childEnv({ DEVELOPER_DIR: devDir }, opts.env)
		});
		return true;
	} catch (error) {
		return error instanceof ToolError && error.reason === "exit" ? false : null;
	}
}
/**
 * Whether the real devicectl has `device capture screenshot` (Xcode 15+ [V]). Only a clear
 * "no" (a non-zero exit) turns screenshots off; a slow answer is not held against it, the
 * screenshot itself reports what goes wrong.
 */
async function canCapture(opts, devicectl, devDir) {
	try {
		await opts.runTool(devicectl, [
			"device",
			"capture",
			"screenshot",
			"-h"
		], {
			timeoutMs: opts.timeouts.devicectlHelp,
			env: childEnv({ DEVELOPER_DIR: devDir }, opts.env)
		});
		return true;
	} catch (error) {
		return !(error instanceof ToolError) || error.reason === "timeout";
	}
}
/**
 * Xcode for iOS 17+ screenshots (§1.5). Runs xcode-select, PlistBuddy, `xcodebuild -license
 * check` and the real devicectl's `-h`, all read-only; never the wrapper, never xcrun, never
 * `-runFirstLaunch`. `dev` lets resolveTools() ask xcode-select once for Xcode and simctl.
 */
async function resolveXcode(opts, dev = developerDir(opts)) {
	if (opts.platform !== "darwin") return { ...NO_XCODE };
	const devDir = await dev;
	const wrapper = devDir ? path.join(devDir, "usr/bin/devicectl") : null;
	if (!devDir || !wrapper || !isXcodeDevDir(devDir) || !await isFile(wrapper)) {
		const [best] = await installedXcodes(opts, "devicectl");
		if (best) return {
			...NO_XCODE,
			state: "not-selected",
			devDir,
			version: best.version,
			build: best.build,
			suggest: best.devDir
		};
		/** An Xcode older than 15 is selected: it is there, it just cannot take screenshots. */
		if (devDir && isXcodeDevDir(devDir) && await isDirectory(devDir)) return {
			...NO_XCODE,
			state: "no-capture",
			devDir,
			...await xcodeVersion(devDir)
		};
		return {
			...NO_XCODE,
			devDir
		};
	}
	const [{ version, build }, gate] = await Promise.all([xcodeVersion(devDir), firstLaunchGate(opts, wrapper, path.join(opts.coreDeviceDir, "Versions/A/Resources/Info.plist"), "exact")]);
	const base = {
		...NO_XCODE,
		devDir,
		version,
		build,
		coreDevice: gate.current,
		expected: gate.expected
	};
	if (!gate.ready) return {
		...base,
		state: "needs-first-launch"
	};
	const [license, capture] = await Promise.all([licenseAccepted(opts, devDir), canCapture(opts, gate.target, devDir)]);
	return capture ? {
		...base,
		state: "ready",
		devicectl: gate.target,
		license
	} : {
		...base,
		state: "no-capture",
		license
	};
}
/**
 * The real simctl behind the same kind of gate (§5): CoreSimulator must not be older than
 * the wrapper expects, or the wrapper would start a first launch.
 */
async function resolveSimctl(opts, dev = developerDir(opts)) {
	if (opts.platform !== "darwin") return { ...NO_SIMCTL };
	const devDir = await dev;
	const wrapper = devDir ? path.join(devDir, "usr/bin/simctl") : null;
	if (!devDir || !wrapper || !isXcodeDevDir(devDir) || !await isFile(wrapper)) {
		const [best] = await installedXcodes(opts, "simctl");
		return best ? {
			...NO_SIMCTL,
			state: "not-selected",
			devDir,
			suggest: best.devDir
		} : {
			...NO_SIMCTL,
			devDir
		};
	}
	const gate = await firstLaunchGate(opts, wrapper, path.join(opts.coreSimulatorDir, "Versions/A/Resources/Info.plist"), "not-older");
	return {
		...NO_SIMCTL,
		state: gate.ready ? "ready" : "needs-first-launch",
		devDir,
		simctl: gate.ready ? gate.target : null,
		coreSimulator: gate.current,
		expected: gate.expected
	};
}
/** A version out of a tool's output, or null. */
function versionIn(text, pattern) {
	return pattern.exec(text)?.[1] ?? null;
}
function isTimeout(error) {
	return error instanceof ToolError && error.reason === "timeout";
}
/**
 * A check's tool run: any failure is an answer (null), but running out of time is not, so a
 * timeout rejects and the checklist can say "Check timed out." instead of guessing.
 */
async function attempt(run) {
	try {
		return await run;
	} catch (error) {
		if (isTimeout(error)) throw error;
		return null;
	}
}
/**
 * Google's adb with its version. `adb version` prints and exits: it starts no server [V],
 * and it is the only adb command the helper runs at all without a click (§4.1).
 */
async function resolveAdb(opts) {
	const file = find("adb", opts);
	if (!file) return null;
	const run = await opts.runTool(file, ["version"], { timeoutMs: opts.timeouts.doctorCheck }).catch(() => null);
	return {
		path: file,
		version: run ? versionIn(run.stdout, /^Version (\d+(?:\.\d+)*)/m) : null
	};
}
/** `ideviceinfo --version` → `1.4.0`; null when it does not say. */
async function libimobiledeviceVersion(opts, ideviceinfo) {
	const run = await attempt(opts.runTool(ideviceinfo, ["--version"], { timeoutMs: opts.timeouts.doctorCheck }));
	return run ? versionIn(run.stdout + run.stderr, /ideviceinfo (\d+\.\d+\.\d+)/) : null;
}
/**
 * How a Python installs packages. PEP 668 marks an externally managed one with a file next
 * to its standard library, which is where Homebrew puts it [V]; python.org's never has it.
 * Only files are read: no Python is started to ask.
 */
async function classifyPython(file) {
	const real = await realpath(file).catch(() => file);
	if (real.startsWith("/Library/Frameworks/Python.framework/")) return "python.org";
	const lib = path.join(path.dirname(real), "../lib");
	const names = await readdir(lib).catch(() => []);
	for (const name of names.filter((n) => /^python3(\.\d+)?$/.test(n))) if (await isFile(path.join(lib, name, "EXTERNALLY-MANAGED"))) return "externally-managed";
	return "other";
}
/** The first python3 on the search path that is not Apple's shim. Found, never run. */
async function findPython(opts) {
	const file = find("python3", opts, isAppleShim);
	return file ? {
		path: file,
		kind: await classifyPython(file)
	} : null;
}
/** `#!/usr/bin/env python3` → interpreter `/usr/bin/env`, argument `python3`. */
function parseShebang(head) {
	const match = /^#![ \t]*(\S+)(?:[ \t]+(\S+))?/.exec(head);
	return match?.[1] ? {
		interpreter: match[1],
		arg: match[2] ?? null
	} : null;
}
/**
 * The Python a script's shebang would start, decided here rather than by the kernel: for
 * `#!/usr/bin/env python3`, env would search the child's PATH, where /usr/bin may come first.
 * Null when the file is not a script (a self-contained binary runs as it is).
 */
async function scriptPython(file, opts) {
	const shebang = parseShebang(await readHead(file, 512) ?? "");
	if (!shebang) return null;
	let python = shebang.interpreter;
	if (path.basename(shebang.interpreter) === "env") {
		const name = shebang.arg && !shebang.arg.startsWith("-") ? shebang.arg : null;
		python = name ? find(name, opts, isAppleShim) ?? find(name, opts) : null;
		if (!python) return {
			path: name ?? shebang.interpreter,
			version: null,
			state: "missing"
		};
	}
	if (isAppleShim(python)) return {
		path: python,
		version: null,
		state: "shim"
	};
	if (!isExecutable$1(python)) return {
		path: python,
		version: null,
		state: "missing"
	};
	return {
		path: python,
		version: null,
		state: "ok"
	};
}
/**
 * pymobiledevice3 and the Python it lives in (§12b): `pymobiledevice3 version`, run through
 * that Python so Apple's shim can never be the one that starts, and `python --version`.
 * Rejects with ToolError 'timeout' when either runs out of time.
 */
async function resolvePymobiledevice3(opts) {
	const file = find("pymobiledevice3", opts);
	if (!file) return null;
	const python = await scriptPython(file, opts);
	if (python && python.state !== "ok") return {
		path: file,
		version: null,
		python
	};
	const slow = { timeoutMs: opts.timeouts.doctorSlowCheck };
	const [own, interpreter] = await Promise.all([attempt(python ? opts.runTool(python.path, [file, "version"], slow) : opts.runTool(file, ["version"], slow)), python ? attempt(opts.runTool(python.path, ["--version"], { timeoutMs: opts.timeouts.doctorCheck })) : null]);
	return {
		path: file,
		version: own ? versionIn(own.stdout, /^(\d+\.\d+\.\d+)/m) : null,
		python: python && {
			...python,
			version: interpreter ? versionIn(interpreter.stdout + interpreter.stderr, /Python (\d+\.\d+\.\d+)/) : null
		}
	};
}
/** `<home>/bin/java -version` (stderr [V]) → `21.0.11`; null unless it runs and says so. */
async function javaVersion(opts, home) {
	const java = path.join(home, "bin/java");
	if (!path.isAbsolute(home) || !isExecutable$1(java)) return null;
	/** /usr/bin/java is Apple's stub; JAVA_HOME=/usr, or a link to it, would reach it. */
	if (isAppleShim(java) || isAppleShim(await realpath(java).catch(() => java))) return null;
	const run = await attempt(opts.runTool(java, ["-version"], { timeoutMs: opts.timeouts.doctorSlowCheck }));
	return run ? versionIn(run.stderr + run.stdout, /version "([^"]+)"/) : null;
}
/** `/usr/libexec/java_home` → the default JDK's home; null when there is none (exit 1). */
async function javaHomeTool(opts) {
	return (await attempt(opts.runTool(opts.javaHomePath, [], { timeoutMs: opts.timeouts.doctorCheck })))?.stdout.trim() || null;
}
/** Homebrew's openjdk, next to the `brew` found: what Homebrew's bundletool falls back to. */
function brewJavaHome(opts) {
	const brew = findBrew(opts);
	return brew ? path.join(path.dirname(path.dirname(brew)), "opt/openjdk/libexec/openjdk.jdk/Contents/Home") : null;
}
/**
 * A Java that runs. JAVA_HOME when set: bundletool uses it, so a broken one IS the answer.
 * Otherwise `/usr/libexec/java_home`, Android Studio's bundled JBR, then Homebrew's openjdk.
 * Never `/usr/bin/java`: on a Mac without Java it offers to install one.
 */
async function resolveJava(opts) {
	const fromEnv = opts.env.JAVA_HOME;
	if (fromEnv) {
		const version = await javaVersion(opts, fromEnv);
		return version ? {
			home: fromEnv,
			version,
			source: "JAVA_HOME"
		} : null;
	}
	const candidates = [
		["java_home", () => javaHomeTool(opts)],
		["Android Studio", () => Promise.resolve(path.join(opts.applicationsDir, "Android Studio.app/Contents/jbr/Contents/Home"))],
		["Homebrew", () => Promise.resolve(brewJavaHome(opts))]
	];
	for (const [source, homeOf] of candidates) {
		const home = await homeOf();
		const version = home ? await javaVersion(opts, home) : null;
		if (home && version) return {
			home,
			version,
			source
		};
	}
	return null;
}
/**
 * bundletool and the Java it needs (§12b; the .aab lane comes later). It is started only
 * with a Java found above, set as JAVA_HOME and first on PATH, so neither Homebrew's script
 * nor any other can fall through to Apple's java stub. Rejects with ToolError 'timeout'.
 */
async function resolveBundletool(opts) {
	const file = find("bundletool", opts);
	if (!file) return null;
	const java = await resolveJava(opts);
	if (!java) return {
		path: file,
		version: null,
		java: null,
		works: false,
		brokenJavaHome: opts.env.JAVA_HOME || null
	};
	const PATH = [path.join(java.home, "bin"), opts.env.PATH].filter(Boolean).join(path.delimiter);
	const run = await attempt(opts.runTool(file, ["version"], {
		timeoutMs: opts.timeouts.doctorSlowCheck,
		env: childEnv({
			JAVA_HOME: java.home,
			PATH
		}, opts.env)
	}));
	return {
		path: file,
		version: run ? versionIn(run.stdout, /^(\d+\.\d+\.\d+)/m) : null,
		java,
		works: run !== null,
		brokenJavaHome: null
	};
}
/**
 * The fast discovery every lane and the banner read (§4b): Xcode and simctl with their
 * first-launch gates, adb with its version, and where the other tools are. Never rejects.
 */
async function resolveTools(opts) {
	const dev = opts.platform === "darwin" ? developerDir(opts) : Promise.resolve(null);
	const [xcode, simctl, adb] = await Promise.all([
		resolveXcode(opts, dev),
		resolveSimctl(opts, dev),
		resolveAdb(opts)
	]);
	return {
		checkedAt: opts.now(),
		xcode,
		simctl,
		ideviceinfo: found("ideviceinfo", opts),
		idevicesyslog: found("idevicesyslog", opts),
		idevicescreenshot: found("idevicescreenshot", opts),
		adb,
		pymobiledevice3: found("pymobiledevice3", opts),
		bundletool: found("bundletool", opts)
	};
}

//#endregion
//#region src/usbmuxd.ts
/**
 * §5 usbmuxd: macOS's iPhone multiplexer, a root-owned Unix socket every iPhone tool goes
 * through. The helper asks it which iPhones are attached (and is told when that changes),
 * reads the Mac's existing pairing with one, and opens a raw pipe to a port on the phone.
 *
 * One connection per request, `Listen` on its own; only MUX_MESSAGES are ever sent. The
 * helper never writes or deletes a pair record: that is what pairing tools do, and the
 * helper never pairs.
 */
var MuxError = class extends Error {
	code;
	/** The Result Number for 'result': 2 no such record, 3 connection refused by the device. */
	result;
	constructor(code, message, result = null) {
		super(message);
		this.name = "MuxError";
		this.code = code;
		this.result = result;
	}
};
/** version 1 = plist framing; message 8 = plist payload (§3.2 [V]). */
const MUX_VERSION = 1;
const MUX_PLIST = 8;
const MUX_HEADER = 16;
/**
 * One usbmuxd frame: a 16-byte little-endian header {total length including the header,
 * version 1, message 8, tag}, then the XML plist.
 */
function encodeMuxFrame(body, tag) {
	const payload = Buffer.from(buildPlist(body), "utf8");
	const header = Buffer.alloc(16);
	header.writeUInt32LE(16 + payload.length, 0);
	header.writeUInt32LE(MUX_VERSION, 4);
	header.writeUInt32LE(MUX_PLIST, 8);
	header.writeUInt32LE(tag, 12);
	return Buffer.concat([header, payload]);
}
/**
 * Bytes in, frames out. Throws MuxError('protocol') on a length below the header or above
 * the 4 MiB cap: a confused peer is closed, never buffered without bound. `rest()` returns
 * what arrived after the last whole frame (a Connect reply can be followed at once by the
 * device's first bytes).
 */
function createMuxReader(onFrame) {
	let buffer = Buffer.alloc(0);
	let stopped = false;
	return {
		push(chunk) {
			if (stopped) return;
			buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
			while (!stopped && buffer.length >= 16) {
				const length = buffer.readUInt32LE(0);
				if (length < 16 || length > LIMITS.frame) throw new MuxError("protocol", `usbmuxd sent a frame of ${String(length)} bytes.`);
				if (buffer.length < length) return;
				const tag = buffer.readUInt32LE(12);
				const payload = buffer.subarray(16, length);
				buffer = buffer.subarray(length);
				const body = asDict(parsePlist(payload.toString("utf8")));
				if (!body) throw new MuxError("protocol", "usbmuxd sent a reply that is not a dictionary.");
				onFrame({
					tag,
					body
				});
			}
		},
		rest: () => buffer,
		stop: () => {
			stopped = true;
		}
	};
}
/** `PortNumber` travels in network byte order inside a little-endian integer (htons). */
function htons(port) {
	return (port & 255) << 8 | port >> 8 & 255;
}
/** Refuses anything not in MUX_MESSAGES before a byte is written (T11). */
function assertMuxMessage(type) {
	if (!MUX_MESSAGES.includes(type)) throw new Error(`The helper never sends the usbmuxd message ${JSON.stringify(type)}.`);
}
/** Fields libusbmuxd sends with every request; usbmuxd logs them as the client's name. */
const CLIENT = {
	ClientVersionString: `${NAME} ${VERSION}`,
	ProgName: "device-bridge",
	kLibUSBMuxVersion: 3
};
function socketError(error, what) {
	if (error.code === "ENOENT") return new MuxError("missing", "usbmuxd is not running.");
	if (error.code === "ECONNREFUSED") return new MuxError("refused", "usbmuxd refused to answer.");
	return new MuxError("closed", `usbmuxd closed the connection during ${what}.`);
}
/** A device entry as listed or announced, or null for one the helper cannot address. */
function toMuxDevice(value) {
	const entry = asDict(value);
	const properties = asDict(entry?.Properties);
	const id = entry?.DeviceID ?? properties?.DeviceID;
	const serial = properties?.SerialNumber;
	const type = properties?.ConnectionType;
	if (typeof id !== "number" || typeof serial !== "string") return null;
	if (type !== "USB" && type !== "Network") return null;
	return {
		DeviceID: id,
		Properties: {
			...properties,
			ConnectionType: type,
			SerialNumber: serial
		}
	};
}
/**
 * The fields of a pair record the helper uses; everything else in it (the root private key,
 * the escrow bag, the Wi-Fi MAC) is dropped on arrival so it cannot leak anywhere later.
 */
function toPairRecord(data) {
	if (data.subarray(0, 6).toString("latin1") === "bplist") throw new MuxError("protocol", "The pair record is a binary plist, which the helper cannot read.");
	const record = asDict(parsePlist(data.toString("utf8")));
	const { HostID, SystemBUID, HostCertificate, HostPrivateKey, DeviceCertificate } = record ?? {};
	if (typeof HostID !== "string" || typeof SystemBUID !== "string" || !Buffer.isBuffer(HostCertificate) || !Buffer.isBuffer(HostPrivateKey) || !Buffer.isBuffer(DeviceCertificate)) throw new MuxError("protocol", "The pair record is missing a field the helper needs.");
	const root = record?.RootCertificate;
	return {
		HostID,
		SystemBUID,
		HostCertificate,
		HostPrivateKey,
		DeviceCertificate,
		...Buffer.isBuffer(root) ? { RootCertificate: root } : {}
	};
}
function createUsbmux(opts) {
	const { socketPath, timeouts } = opts;
	const reconnectMs = opts.reconnectMs ?? [
		1e3,
		2e3,
		4e3,
		8e3,
		1e4
	];
	/**
	 * Opens a connection, sends `message`, and hands every frame to `onFrame` until it returns
	 * a value (resolve) or throws (reject). The deadline and the signal destroy the socket.
	 */
	function exchange(message, what, timeoutMs, onFrame, signal) {
		return new Promise((resolve, reject) => {
			const socket = net.connect(socketPath);
			let settled = false;
			const finish = (error, value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				if (error) {
					socket.destroy();
					reject(error);
				} else resolve(value);
			};
			const timer = setTimeout(() => finish(new MuxError("timeout", `usbmuxd did not answer ${what} in time.`)), timeoutMs);
			const onAbort = () => finish(new MuxError("closed", `${what} was cancelled.`));
			if (signal?.aborted) return onAbort();
			signal?.addEventListener("abort", onAbort, { once: true });
			const reader = createMuxReader((frame) => {
				if (settled) return;
				const value = onFrame(frame, socket, reader.rest);
				if (value !== void 0) {
					reader.stop();
					finish(null, value);
				}
			});
			const onData = (chunk) => {
				try {
					reader.push(chunk);
				} catch (error) {
					finish(error instanceof MuxError ? error : new MuxError("protocol", String(error)));
				}
			};
			socket.on("data", onData);
			socket.on("error", (error) => finish(socketError(error, what)));
			socket.on("close", () => finish(new MuxError("closed", `usbmuxd closed during ${what}.`)));
			socket.once("connect", () => socket.write(encodeMuxFrame({
				...CLIENT,
				...message
			}, 1)));
		});
	}
	const request = (message) => {
		assertMuxMessage(message.MessageType);
		return exchange(message, message.MessageType, timeouts.muxRequest, (frame, socket) => {
			socket.destroy();
			return frame.body;
		});
	};
	async function listDevices() {
		const reply = await request({ MessageType: "ListDevices" });
		return (Array.isArray(reply.DeviceList) ? reply.DeviceList : []).map(toMuxDevice).filter((device) => device !== null);
	}
	async function readPairRecord(udid) {
		const reply = await request({
			MessageType: "ReadPairRecord",
			PairRecordID: udid
		});
		const data = reply.PairRecordData;
		if (Buffer.isBuffer(data)) return toPairRecord(data);
		const number = typeof reply.Number === "number" ? reply.Number : -1;
		/** 2 is "no such record"; the helper reads any other refusal the same way: not trusted. */
		if (reply.MessageType === "Result" && number !== 0) return null;
		throw new MuxError("protocol", "usbmuxd answered ReadPairRecord without a record.");
	}
	async function readBuid() {
		const reply = await request({ MessageType: "ReadBUID" });
		if (typeof reply.BUID !== "string") throw new MuxError("protocol", "usbmuxd sent no BUID.");
		return reply.BUID;
	}
	/**
	 * usbmuxd answers Connect with `Result 0`, and from then on the same socket is a raw pipe
	 * to the device's port. Bytes that arrived with the reply are put back for the next reader.
	 */
	function connect(deviceId, port, connectOpts = {}) {
		return exchange({
			MessageType: "Connect",
			DeviceID: deviceId,
			PortNumber: htons(port)
		}, "Connect", connectOpts.timeoutMs ?? timeouts.muxConnectUsb, (frame, socket, rest) => {
			const number = frame.body.Number;
			if (frame.body.MessageType !== "Result" || number !== 0) {
				const code = typeof number === "number" ? number : -1;
				throw new MuxError("result", `The device refused port ${String(port)} (${String(code)}).`, code);
			}
			socket.removeAllListeners("data");
			socket.removeAllListeners("close");
			socket.removeAllListeners("error");
			/** The pipe's owner attaches its own error handler; until then errors must not crash. */
			socket.on("error", () => void 0);
			/**
			 * Paused, so no byte is emitted before the new owner listens: it calls resume() (or
			 * hands the socket to TLS). Bytes that came with the reply go back in front.
			 */
			socket.pause();
			const leftover = rest();
			if (leftover.length) socket.unshift(leftover);
			return socket;
		}, connectOpts.signal).catch((error) => {
			throw error instanceof MuxError ? error : new MuxError("protocol", String(error));
		});
	}
	/**
	 * Hot-plug. Listen answers Result 0 and then pushes Attached, Detached and Paired on the
	 * same socket. When it closes (usbmuxd restarted, the Mac woke up) the client reconnects
	 * after 1, 2, 4… up to 10 s, and says `listening` again so the lane resyncs with
	 * ListDevices: whether Listen replays attached devices is not something to rely on.
	 */
	function watch(onEvent) {
		let stopped = false;
		let socket = null;
		let timer;
		let attempt = 0;
		let reported = false;
		const schedule = (error) => {
			socket = null;
			if (stopped) return;
			if (!reported) {
				reported = true;
				onEvent({
					type: "disconnected",
					error
				});
			}
			const delay = reconnectMs[Math.min(attempt, reconnectMs.length - 1)] ?? 1e4;
			attempt++;
			timer = setTimeout(open, delay);
			timer.unref();
		};
		const handle = (frame) => {
			const { body } = frame;
			switch (body.MessageType) {
				case "Result":
					if (body.Number !== 0) throw new MuxError("result", "usbmuxd refused Listen.");
					attempt = 0;
					reported = false;
					onEvent({ type: "listening" });
					return;
				case "Attached": {
					const device = toMuxDevice(body);
					if (device) onEvent({
						type: "attached",
						device
					});
					return;
				}
				case "Detached":
					if (typeof body.DeviceID === "number") onEvent({
						type: "detached",
						deviceId: body.DeviceID
					});
					return;
				case "Paired":
					if (typeof body.DeviceID === "number") onEvent({
						type: "paired",
						deviceId: body.DeviceID
					});
					return;
				default:
 /** Newer usbmuxd builds announce more; ignoring them is forward compatible. */
				return;
			}
		};
		function open() {
			if (stopped) return;
			const s = net.connect(socketPath);
			socket = s;
			let failure = new MuxError("closed", "usbmuxd closed the Listen connection.");
			const reader = createMuxReader(handle);
			s.on("connect", () => s.write(encodeMuxFrame({
				...CLIENT,
				MessageType: "Listen"
			}, 1)));
			s.on("data", (chunk) => {
				try {
					reader.push(chunk);
				} catch (error) {
					failure = error instanceof MuxError ? error : new MuxError("protocol", String(error));
					s.destroy();
				}
			});
			s.on("error", (error) => {
				failure = socketError(error, "Listen");
			});
			s.on("close", () => schedule(failure));
		}
		open();
		return () => {
			stopped = true;
			clearTimeout(timer);
			socket?.destroy();
		};
	}
	return {
		request,
		listDevices,
		watch,
		readPairRecord,
		readBuid,
		connect
	};
}

//#endregion
//#region src/lockdown.ts
/**
 * §6 lockdownd: the iPhone's own front desk on port 62078, reached through a usbmuxd pipe.
 * Before a session it answers a few plaintext questions (what it is, its name and version);
 * with the Mac's existing pair record it opens a TLS session that reads identifiers, battery,
 * storage and Developer Mode, and starts the system log relay.
 *
 * Only LOCKDOWN_REQUESTS and LOCKDOWN_SERVICES are ever sent: send() throws before writing
 * anything else, so a bug cannot pair, unpair or change a setting on a tester's phone.
 */
/** The port lockdownd listens on, on every iPhone. */
const LOCKDOWN_PORT = 62078;
/**
 * A refusal or failure. `code` is lockdownd's own Error string (`InvalidHostID`,
 * `PasswordProtected`, `MissingValue`…), passed through raw as the spec asks (G12), or one
 * of the client's: 'timeout', 'closed', 'protocol', 'tls-reset' (the phone hung up on the
 * handshake: it no longer trusts this Mac), 'tls-failed' (this Node could not do the
 * handshake at all; `detail` names why, such as ERR_SSL_CA_MD_TOO_WEAK), 'tls-pin' (pinning
 * is on and the phone presented a certificate other than the pair record's, G25).
 */
var LockdownError = class extends Error {
	code;
	detail;
	constructor(code, message, detail = "") {
		super(message);
		this.name = "LockdownError";
		this.code = code;
		this.detail = detail;
	}
};
/** A u32 big-endian length, then that many bytes of XML plist [V]. */
function encodeLockdownFrame(body) {
	const payload = Buffer.from(buildPlist(body), "utf8");
	const header = Buffer.alloc(4);
	header.writeUInt32BE(payload.length, 0);
	return Buffer.concat([header, payload]);
}
/** Bytes in, dictionaries out; throws LockdownError('protocol') past the 4 MiB frame cap. */
function createLockdownReader(onFrame) {
	let buffer = Buffer.alloc(0);
	return { push(chunk) {
		buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
		while (buffer.length >= 4) {
			const length = buffer.readUInt32BE(0);
			if (length > LIMITS.frame) throw new LockdownError("protocol", `lockdownd sent a frame of ${String(length)} bytes.`);
			if (buffer.length < 4 + length) return;
			const body = asDict(parsePlist(buffer.subarray(4, 4 + length).toString("utf8")));
			buffer = buffer.subarray(4 + length);
			if (!body) throw new LockdownError("protocol", "lockdownd sent a reply that is not a dictionary.");
			onFrame(body);
		}
	} };
}
/** Refuses anything outside the allowlists before a byte is written (T11). */
function assertLockdownRequest(message) {
	if (!LOCKDOWN_REQUESTS.includes(message.Request)) throw new Error(`The helper never sends the lockdown request ${JSON.stringify(message.Request)}.`);
	if (message.Request === "StartService" && !LOCKDOWN_SERVICES.includes(String(message.Service))) throw new Error(`The helper never starts the service ${JSON.stringify(message.Service)}.`);
}
/**
 * The client side of lockdown's TLS (§3.3), the same for the session and for services:
 * - the pair record's host certificate and key, from memory only;
 * - no verification of the phone's certificate: it is self-issued (pinning is separate);
 * - `@SECLEVEL=0`, because pair-record chains are SHA-1, which OpenSSL 3 refuses by default
 *   (a named SHA-1 chain even throws synchronously, before any byte is sent [V]);
 * - TLS 1.2 or newer, and legacy renegotiation for older lockdownd, as pymobiledevice3 does.
 */
function tlsOptions(record, socket) {
	return {
		socket,
		cert: record.HostCertificate,
		key: record.HostPrivateKey,
		rejectUnauthorized: false,
		ciphers: "DEFAULT:@SECLEVEL=0",
		minVersion: "TLSv1.2",
		secureOptions: constants$1.SSL_OP_LEGACY_SERVER_CONNECT
	};
}
/** Codes Node gives a handshake the phone cut short: an untrusted Mac, not a broken Node. */
const RESET_CODES = new Set([
	"ECONNRESET",
	"EPIPE",
	"ERR_SSL_SSL_HANDSHAKE_FAILURE"
]);
function isReset(error) {
	return RESET_CODES.has(error.code ?? "") || /socket disconnected before secure TLS connection|socket hang up/i.test(error.message);
}
/** Whether the phone presented exactly the pair record's DeviceCertificate (G25). */
function peerMatches(socket, record) {
	try {
		const peer = socket.getPeerCertificate(true);
		const expected = derOf(record.DeviceCertificate);
		return peer.raw && expected ? peer.raw.equals(expected) : null;
	} catch {
		return null;
	}
}
function derOf(pem) {
	try {
		return new X509Certificate(pem).raw;
	} catch {
		return null;
	}
}
/**
 * Wraps `raw` in TLS with the pair record. A synchronous throw (OpenSSL refusing the
 * certificates outright) and every handshake failure become LockdownError: 'tls-reset' when
 * the phone hung up, 'tls-failed' otherwise. With `pin`, a phone whose certificate is not the
 * pair record's ends it as 'tls-pin': every lockdown session and every service handshake goes
 * through here, so this is the one place pinning is enforced (G25).
 */
function startTls(raw, record, timeoutMs, opts = {}) {
	return new Promise((resolve, reject) => {
		let socket;
		try {
			socket = tls.connect(tlsOptions(record, raw));
		} catch (error) {
			const code = error.code ?? "ERR_TLS";
			raw.destroy();
			return reject(new LockdownError("tls-failed", `This Node could not start TLS with the iPhone (${code}).`, code));
		}
		let settled = false;
		const fail = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			raw.destroy();
			reject(error);
		};
		const timer = setTimeout(() => fail(new LockdownError("tls-failed", "The TLS handshake took too long.", "timeout")), timeoutMs);
		socket.once("secureConnect", () => {
			if (settled) return;
			const matches = peerMatches(socket, record);
			if (opts.pin && matches === false) {
				fail(new LockdownError("tls-pin", "The iPhone presented a certificate other than the one it was paired with."));
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve({
				socket,
				protocol: socket.getProtocol(),
				cipher: socket.getCipher()?.name ?? null,
				peerMatches: matches
			});
		});
		socket.once("error", (error) => {
			const code = error.code ?? "ERR_TLS";
			fail(isReset(error) ? new LockdownError("tls-reset", "The iPhone ended the secure session.", code) : new LockdownError("tls-failed", `TLS with the iPhone failed (${code}).`, code));
		});
		socket.once("close", () => fail(new LockdownError("tls-reset", "The iPhone closed the secure session.", "EOF")));
	});
}
/**
 * A lockdown channel over a usbmuxd pipe to port 62078. Requests run one at a time, as
 * lockdownd answers them in order; a request that times out closes the channel, because a
 * late reply would otherwise be read as the answer to the next question.
 */
function createLockdown(raw, opts) {
	const { timeouts } = opts;
	let transport = raw;
	let tlsSocket = null;
	let sessionId = null;
	let closed = null;
	const waiters = [];
	let queue = Promise.resolve();
	const failAll = (error) => {
		closed ??= error;
		for (const waiter of waiters.splice(0)) {
			clearTimeout(waiter.timer);
			waiter.reject(closed);
		}
	};
	const reader = createLockdownReader((body) => {
		const waiter = waiters.shift();
		if (!waiter) return;
		clearTimeout(waiter.timer);
		waiter.resolve(body);
	});
	const onData = (chunk) => {
		try {
			reader.push(chunk);
		} catch (error) {
			failAll(error instanceof LockdownError ? error : new LockdownError("protocol", String(error)));
			transport.destroy();
		}
	};
	const onClose = () => failAll(new LockdownError("closed", "lockdownd closed the connection."));
	const onError = () => void 0;
	const attach = (socket) => {
		transport = socket;
		socket.on("data", onData);
		socket.on("close", onClose);
		socket.on("error", onError);
		socket.resume();
	};
	const detach = (socket) => {
		socket.off("data", onData);
		socket.off("close", onClose);
	};
	attach(raw);
	function exchange(name, message, timeoutMs) {
		return new Promise((resolve, reject) => {
			if (closed) return reject(closed);
			const timer = setTimeout(() => {
				failAll(new LockdownError("timeout", `lockdownd did not answer ${name} in time.`));
				transport.destroy();
			}, timeoutMs);
			waiters.push({
				resolve,
				reject,
				timer
			});
			transport.write(encodeLockdownFrame({
				Label: "device-bridge",
				...message
			}));
		});
	}
	const send = (message, sendOpts = {}) => {
		assertLockdownRequest(message);
		const run = queue.then(async () => {
			const reply = await exchange(message.Request, message, sendOpts.timeoutMs ?? timeouts.lockdownRequest);
			if (typeof reply.Error === "string") throw new LockdownError(reply.Error, `lockdownd refused ${message.Request}: ${reply.Error}.`);
			return reply;
		});
		queue = run.catch(() => void 0);
		return run;
	};
	async function queryType() {
		const reply = await send({ Request: "QueryType" });
		return typeof reply.Type === "string" ? reply.Type : "";
	}
	async function getValue(domain, key, valueOpts = {}) {
		return (await send({
			Request: "GetValue",
			Domain: domain,
			Key: key
		}, valueOpts)).Value;
	}
	async function startSession(record) {
		const reply = await send({
			Request: "StartSession",
			HostID: record.HostID,
			SystemBUID: record.SystemBUID
		});
		sessionId = typeof reply.SessionID === "string" ? reply.SessionID : "";
		if (reply.EnableSessionSSL !== true) return {
			sessionId,
			tls: null,
			protocol: null,
			cipher: null,
			peerMatches: null
		};
		/** From here on every byte is TLS: the plaintext reader lets go of the raw pipe. */
		detach(raw);
		const secured = await startTls(raw, record, timeouts.lockdownTls, { pin: opts.pin }).catch((error) => {
			const failure = error instanceof LockdownError ? error : new LockdownError("tls-failed", errorText(error));
			failAll(failure);
			throw failure;
		});
		tlsSocket = secured.socket;
		attach(secured.socket);
		return {
			sessionId,
			tls: secured.socket,
			protocol: secured.protocol,
			cipher: secured.cipher,
			peerMatches: secured.peerMatches
		};
	}
	async function startService(name) {
		const reply = await send({
			Request: "StartService",
			Service: name
		});
		if (typeof reply.Port !== "number") throw new LockdownError("protocol", `lockdownd started ${name} without a port.`);
		return {
			port: reply.Port,
			ssl: reply.EnableServiceSSL === true
		};
	}
	async function stopSession() {
		if (sessionId === null) return;
		const id = sessionId;
		sessionId = null;
		await send({
			Request: "StopSession",
			SessionID: id
		});
	}
	function close() {
		failAll(new LockdownError("closed", "The lockdown connection was closed."));
		tlsSocket?.destroy();
		raw.destroy();
	}
	return {
		send,
		queryType,
		getValue,
		startSession,
		startService,
		stopSession,
		close
	};
}

//#endregion
//#region src/ios-lane.ts
/**
 * §7 iOS lane: iPhones and iPads over usbmuxd and lockdown, in plain Node.
 *
 * - Listing and hot-plug come from usbmuxd's Listen socket; rows are keyed by UDID.
 * - A probe per device (§3.4) reads what lockdownd says before a session, checks the Mac's
 *   pair record, opens a TLS session with it, and derives the row (§3.10).
 * - Identifiers come only through whitelists (§3.5): IMEI, phone number, MAC addresses and
 *   every key not listed are never read out of a reply, let alone sent to the page.
 * - Screenshots use Xcode's real devicectl binary (never its first-launch wrapper), or
 *   idevicescreenshot for iOS 16 and older; logs use the phone's syslog_relay, or
 *   idevicesyslog when that is not possible.
 *
 * Everything here is read-only towards the phone: no Pair, no SetValue, no Developer Mode
 * toggle, no disk image mount, and ideviceinfo never runs without an existing pair record
 * (its handshake would show the Trust dialog).
 */
/** §3.5: what a pre-session GetValue may contribute. Over USB it answers 26 keys [V]. */
const PLAINTEXT_KEYS = [
	"DeviceName",
	"DeviceClass",
	"ProductType",
	"ProductVersion",
	"BuildVersion",
	"HardwareModel",
	"CPUArchitecture"
];
/** §3.5: what the session's default domain may contribute (UniqueChipID as a decimal string). */
const SESSION_KEYS = [
	...PLAINTEXT_KEYS,
	"SerialNumber",
	"ModelNumber",
	"RegionInfo",
	"TimeZone"
];
/** §3.5 domains for the detail, each with the only keys kept from it. */
const DOMAINS = {
	battery: {
		domain: "com.apple.mobile.battery",
		keys: {
			BatteryCurrentCapacity: "number",
			BatteryIsCharging: "boolean",
			ExternalConnected: "boolean",
			FullyCharged: "boolean"
		}
	},
	disk: {
		domain: "com.apple.disk_usage",
		keys: {
			TotalDiskCapacity: "number",
			TotalDataCapacity: "number",
			TotalDataAvailable: "number",
			AmountDataAvailable: "number"
		}
	},
	international: {
		domain: "com.apple.international",
		keys: {
			Language: "string",
			Locale: "string"
		}
	}
};
/** Developer Mode lives here; the domain dumps as {} unless the key is named [V]. */
const AMFI = {
	domain: "com.apple.security.mac.amfi",
	key: "DeveloperModeStatus"
};
/** Lockdown refusals that mean "not now" for one domain: listed in `withheld`, not errors. */
const WITHHELD_CODES = new Set([
	"PasswordProtected",
	"GetProhibited",
	"MissingValue"
]);
/**
 * The whitelisted identity from one GetValue reply. Strings only, except UniqueChipID,
 * which becomes a decimal string because ECIDs exceed 2^53 (P10). Nothing else survives.
 */
function whitelistDevice(value, phase) {
	const dict = asDict(value);
	const out = {};
	if (!dict) return out;
	for (const key of phase === "plaintext" ? PLAINTEXT_KEYS : SESSION_KEYS) {
		const v = dict[key];
		if (typeof v === "string") out[key] = clean(v, LIMITS.name);
	}
	const chip = dict.UniqueChipID;
	if (phase === "session" && (typeof chip === "bigint" || typeof chip === "number")) out.UniqueChipID = chip.toString();
	return out;
}
/** The listed keys of one domain reply, each only with its expected type. */
function pickTyped(value, keys) {
	const dict = asDict(value);
	if (!dict) return void 0;
	const out = {};
	for (const key of Object.keys(keys)) {
		const v = dict[key];
		const want = keys[key];
		if (want === "number" && typeof v === "number") out[key] = v;
		else if (want === "number" && typeof v === "bigint") out[key] = Number(v);
		else if (want === "boolean" && typeof v === "boolean") out[key] = v;
		else if (want === "string" && typeof v === "string") out[key] = clean(v, LIMITS.field);
	}
	return out;
}
/** The major iOS version, or 0 when unknown. */
function iosMajor(version) {
	const major = Number.parseInt(version ?? "", 10);
	return Number.isFinite(major) && major > 0 ? major : 0;
}
/** usbmuxd also carries Apple TVs and Watches; the Device Lab lists phones and tablets. */
function isHandheld(device) {
	const kind = device.DeviceClass ?? device.ProductType;
	return kind === void 0 || /^(?:iPhone|iPad|iPod)/.test(kind);
}
const NO_IOS_TOOLS = {
	xcode: "not-installed",
	idevicescreenshot: false,
	idevicesyslog: false
};
/** §3.7 for one row: can it take screenshots, and if not, which blocker says why. */
function screenshotGap(entry, tools) {
	const legacy = iosMajor(entry.device.ProductVersion) > 0 && iosMajor(entry.device.ProductVersion) <= 16;
	const devicectl = tools.xcode === "ready" && !entry.devicectlUnsupported;
	const fallback = legacy && tools.idevicescreenshot;
	if (entry.ddiRequired) return {
		possible: false,
		blocker: "IOS_DDI_REQUIRED"
	};
	if (devicectl || fallback) return {
		possible: true,
		blocker: null
	};
	if (legacy) return {
		possible: false,
		blocker: "TOOL_MISSING"
	};
	/** devicectl answered "not supported" for this phone: no tool the tester could add helps. */
	if (entry.devicectlUnsupported) return {
		possible: false,
		blocker: null
	};
	return {
		possible: false,
		blocker: tools.xcode === "needs-first-launch" ? "XCODE_SETUP_REQUIRED" : "XCODE_REQUIRED"
	};
}
const NOTHING = {
	screenshot: false,
	identifiers: false,
	logs: false,
	install: false
};
/** §3.10: the row for one entry. The first matching case wins. */
function deriveIos(entry, tools = NO_IOS_TOOLS) {
	const base = {
		id: entry.udid,
		platform: "ios",
		connection: entry.connection,
		name: entry.device.DeviceName ?? "",
		model: "",
		modelId: entry.device.ProductType ?? "",
		osVersion: entry.device.ProductVersion ?? ""
	};
	const blocked = (state, blockers) => ({
		...base,
		state,
		blockers,
		capabilities: { ...NOTHING }
	});
	switch (entry.status) {
		case null: return blocked("connecting", []);
		case "untrusted": return blocked("untrusted", ["IOS_UNTRUSTED"]);
		case "authorizing": return blocked("authorizing", ["IOS_UNTRUSTED"]);
		case "locked": return blocked("locked", ["IOS_LOCKED"]);
		case "offline": return blocked("offline", ["IOS_LOCKDOWN_FAILED"]);
		case "unknown": return blocked("unknown", []);
		case "ready": {
			const gap = screenshotGap(entry, tools);
			const blockers = [];
			if (entry.source === "plaintext") blockers.push("TOOL_MISSING");
			if (entry.developerMode === false) blockers.push("IOS_DEVELOPER_MODE_OFF");
			if (gap.blocker) blockers.push(gap.blocker);
			return {
				...base,
				state: "ready",
				blockers: [...new Set(blockers)],
				capabilities: {
					screenshot: gap.possible && entry.developerMode !== false,
					identifiers: true,
					logs: entry.source === "lockdown" || entry.source === "ideviceinfo" && tools.idevicesyslog,
					install: false
				}
			};
		}
	}
}
function wrapped(value) {
	if (typeof value === "string") return value;
	const dict = value && typeof value === "object" ? value : null;
	return typeof dict?.string === "string" ? dict.string : "";
}
/**
 * §3.7: devicectl's verdict from its JSON envelope (written with --json-output) and exit
 * code, as the HelperError the page gets, or null for a success. `userInfo` values come
 * wrapped as {string} / {array} [V]. The lane reads two codes as "try something else":
 * SCREENSHOT_UNSUPPORTED (1001: next lane) and IOS_UNREACHABLE (4016: once more after 2 s).
 */
function classifyDevicectl(envelope, exitCode) {
	const root = envelope && typeof envelope === "object" ? envelope : {};
	const info = root.info ?? {};
	const error = root.error ?? null;
	const outcome = typeof info.outcome === "string" ? info.outcome : null;
	if (exitCode === 0 && outcome === "success" && !error) return null;
	if (exitCode === 72) return new HelperError("XCODE_REQUIRED", 503, "Screenshots of this iPhone need Xcode.");
	if (exitCode === 64) return new HelperError("XCODE_REQUIRED", 503, "This Xcode's devicectl has no screenshot command; update Xcode.");
	if (outcome === "timeout" || exitCode === 2) return new HelperError("TOOL_TIMEOUT", 504, "devicectl took too long to take the screenshot.");
	const code = typeof error?.code === "number" ? error.code : null;
	const userInfo = error?.userInfo ?? {};
	const description = clean(wrapped(userInfo.NSLocalizedDescription), 500);
	if (code === 1e3) return new HelperError("DEVICE_NOT_FOUND", 404, "Xcode does not see this iPhone.");
	if (code === 1001) return new HelperError("SCREENSHOT_UNSUPPORTED", 501, "Xcode cannot take screenshots of this device.");
	if (/locked/i.test(description)) return new HelperError("IOS_LOCKED", 409, "Unlock the iPhone, then take the screenshot again.");
	if (/Developer Mode/i.test(description)) return new HelperError("IOS_DEVELOPER_MODE_OFF", 409, "Developer Mode is off on this iPhone, so screenshots are off.");
	if (code === 4016) return new HelperError("IOS_UNREACHABLE", 502, "Xcode could not reach the iPhone.");
	return new HelperError("TOOL_FAILED", 502, description || `devicectl failed (exit code ${String(exitCode)}).`);
}
/**
 * Xcode 26 and newer install devicectl as a zsh wrapper that, when CoreDevice's version does
 * not match the one it expects, runs `xcodebuild -runFirstLaunch` (installing packages)
 * before the real binary [V]. Tool discovery hands lanes the real binary; this is the last
 * check before running one, so the helper never installs anything by accident.
 */
function isFirstLaunchWrapper(file) {
	let fd = null;
	try {
		fd = openSync(file, "r");
		const head = Buffer.alloc(65536);
		const read = readSync(fd, head, 0, head.length, 0);
		const text = head.subarray(0, read).toString("latin1");
		return text.startsWith("#!") && /runFirstLaunch|EXPECTED_VERSION/.test(text);
	} catch {
		/** Unreadable: treat it as unsafe, so it is not run. */
		return true;
	} finally {
		if (fd !== null) closeSync(fd);
	}
}
/** A message without a NUL after this many bytes is cut, so a broken stream cannot grow without bound. */
const MAX_CARRY = LIMITS.line * 4;
function capLine(raw) {
	const text = clean(raw, Number.MAX_SAFE_INTEGER);
	return text.length > LIMITS.line ? text.slice(0, LIMITS.line) + " [truncated]" : text;
}
function messageLines(bytes, out, cut = false) {
	let text = bytes.toString("utf8");
	if (text.endsWith("\n")) text = text.slice(0, -1);
	const parts = text.split("\n");
	parts.forEach((part, i) => {
		const line = capLine(part);
		if (!line) return;
		out.push(cut && i === parts.length - 1 && !line.endsWith(" [truncated]") ? line + " [truncated]" : line);
	});
}
/**
 * §3.8: syslog_relay sends each message followed by a NUL byte; a message ends with a
 * newline, and about 1 % carry inner newlines [V], which become continuation lines. Lines
 * are cleaned (no escapes, no control characters but tab) and capped at 8 KiB. `carry`
 * holds a message whose NUL has not arrived yet; splitting on the NUL byte keeps UTF-8
 * intact, because a NUL never occurs inside a multi-byte character.
 */
function splitSyslogRelay(chunk, carry) {
	const buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk;
	const lines = [];
	let start = 0;
	for (let nul = buffer.indexOf(0); nul >= 0; nul = buffer.indexOf(0, start)) {
		messageLines(buffer.subarray(start, nul), lines);
		start = nul + 1;
	}
	const rest = buffer.subarray(start);
	if (rest.length > MAX_CARRY) {
		messageLines(rest, lines, true);
		return {
			lines,
			carry: Buffer.alloc(0)
		};
	}
	return {
		lines,
		carry: Buffer.from(rest)
	};
}
const IOS_TUNING = {
	pairPollMs: 3e3,
	reprobeMs: 5e3,
	wifiStableMs: 2e3,
	wifiHoldMs: 12e4,
	muxGraceMs: 1e4,
	unreachableTries: 3,
	unreachableGapMs: 1e3,
	devicectlRetryMs: 2e3,
	connectingGraceMs: 750,
	detailCacheMs: 5e3,
	tickMs: 250,
	reconnectMs: [
		1e3,
		2e3,
		4e3,
		8e3,
		1e4
	],
	doctorSyslogMs: 3e3,
	enforcePinning: true
};
/** StartSession refusals and what they mean for the row (§3.4 step 5, §3.10). */
function sessionVerdict(code) {
	switch (code) {
		case "InvalidHostID":
		case "InvalidConnection":
		case "UserDeniedPairing":
		case "tls-reset": return "untrusted";
		case "PasswordProtected": return "locked";
		case "PairingDialogResponsePending": return "authorizing";
		case "tls-failed": return "tls-failed";
		default: return "offline";
	}
}
/** The row's reason for a StartSession refusal: the client's own codes read as `tls:…`. */
function sessionReason(code) {
	if (code === "tls-reset") return "tls:reset";
	if (code === "tls-pin") return "tls:pin";
	return code;
}
function connectTimeout(io, target) {
	return target.network ? io.timeouts.muxConnectNetwork : io.timeouts.muxConnectUsb;
}
/** A lockdown channel over a fresh usbmuxd pipe, closed when `signal` aborts. */
async function openLockdown(io, target, signal) {
	const raw = await io.mux.connect(target.deviceId, LOCKDOWN_PORT, {
		timeoutMs: connectTimeout(io, target),
		signal
	});
	const lockdown = createLockdown(raw, {
		timeouts: io.timeouts,
		pin: io.tuning.enforcePinning
	});
	const untrack = io.track(lockdown.close);
	const onAbort = () => lockdown.close();
	signal.addEventListener("abort", onAbort, { once: true });
	raw.once("close", () => {
		untrack();
		signal.removeEventListener("abort", onAbort);
	});
	return lockdown;
}
async function readAmfi(lockdown, timeoutMs) {
	try {
		const value = await lockdown.getValue(AMFI.domain, AMFI.key, { timeoutMs });
		return typeof value === "boolean" ? value : null;
	} catch {
		return null;
	}
}
/**
 * §3.4 steps 1–9 for one attachment. It never throws for something the phone said: every
 * outcome is a report. It throws only when aborted (detach, shutdown, the 12 s budget).
 */
async function probeOnce(io, target, signal, opts = {}) {
	const report = {
		status: "offline",
		reason: "",
		source: null,
		device: {},
		queryType: null,
		plaintextKeys: 0,
		hasRecord: null,
		session: null,
		tls: null,
		sessionKeys: null,
		locked: null,
		developerMode: null,
		tlsFailure: null,
		domains: {}
	};
	const done = (status, reason = "") => {
		report.status = status;
		report.reason = reason;
		return report;
	};
	/** Step 1: three tries, a second apart, before the phone counts as not answering. */
	let lockdown = null;
	for (let attempt = 1; !lockdown; attempt++) try {
		lockdown = await openLockdown(io, target, signal);
	} catch (error) {
		if (signal.aborted) throw abortError();
		if (attempt >= io.tuning.unreachableTries) return done("offline", `connect:${error instanceof MuxError ? error.code : "error"}`);
		await sleep(io.tuning.unreachableGapMs, signal);
	}
	try {
		report.queryType = await lockdown.queryType();
		if (report.queryType !== "com.apple.mobile.lockdown") return done("unknown", "query-type");
		const plain = await lockdown.getValue().catch(() => void 0);
		report.plaintextKeys = Object.keys(asDict(plain) ?? {}).length;
		report.device = whitelistDevice(plain, "plaintext");
		const record = await io.mux.readPairRecord(target.udid);
		report.hasRecord = record !== null;
		if (!record) return done("untrusted", "pair-record:none");
		let session;
		try {
			session = await lockdown.startSession(record);
		} catch (error) {
			if (signal.aborted) throw abortError();
			if (!(error instanceof LockdownError)) throw error;
			report.session = error.code;
			if (error.code === "tls-pin") report.tls = {
				protocol: null,
				cipher: null,
				peerMatches: false
			};
			const verdict = sessionVerdict(error.code);
			if (verdict !== "tls-failed") return done(verdict, sessionReason(error.code));
			report.tlsFailure = error.detail || error.code;
			return await ideviceinfoProbe(io, target, report, signal);
		}
		report.session = "ok";
		report.tls = session.tls ? {
			protocol: session.protocol,
			cipher: session.cipher,
			peerMatches: session.peerMatches
		} : null;
		const all = await lockdown.getValue();
		report.sessionKeys = Object.keys(asDict(all) ?? {}).length;
		report.device = {
			...report.device,
			...whitelistDevice(all, "session")
		};
		const passcode = asDict(all)?.PasswordProtected;
		report.locked = typeof passcode === "boolean" ? passcode : null;
		if (iosMajor(report.device.ProductVersion) >= 16) report.developerMode = await readAmfi(lockdown, io.timeouts.domain);
		if (opts.domains) for (const [name, spec] of Object.entries(DOMAINS)) try {
			const kept = pickTyped(await lockdown.getValue(spec.domain, void 0, { timeoutMs: io.timeouts.domain }), spec.keys);
			report.domains[name] = `ok (${String(Object.keys(kept ?? {}).length)} keys kept)`;
		} catch (error) {
			report.domains[name] = error instanceof LockdownError ? error.code : "failed";
		}
		await lockdown.stopSession().catch(() => void 0);
		report.source = "lockdown";
		return done("ready");
	} catch (error) {
		if (signal.aborted || isAbortError(error)) throw abortError();
		if (error instanceof LockdownError || error instanceof MuxError) return done("offline", `lockdown:${error.code}`);
		throw error;
	} finally {
		lockdown.close();
	}
}
/**
 * A probe that ended because the link went, not because the phone said something: offline for
 * any reason (no connect, lockdown's pipe closing mid-request), or a TLS handshake reset.
 */
function linkCut(report) {
	if (report.reason === "tls:pin") return false;
	return report.status === "offline" || report.reason === "tls:reset";
}
/** ideviceinfo prints lockdown's refusals as text; these two decide the row (§3.4). */
function ideviceinfoVerdict(error) {
	if (!(error instanceof ToolError)) return null;
	const text = `${error.stderr}\n${String(error.stdout)}`;
	if (/Invalid HostID|\(-21\)/i.test(text)) return "untrusted";
	if (/Password protected|\(-17\)/i.test(text)) return "locked";
	return null;
}
function ideviceinfoArgs(target, extra) {
	return [
		"-u",
		target.udid,
		...target.network ? ["-n"] : [],
		...extra,
		"-x"
	];
}
/**
 * The TLS-failed path (§3.4): this Node could not do the handshake, so libimobiledevice's
 * own TLS stack reads the facts instead, if it is installed. It runs only here, after a
 * pair record was found: without one its handshake would ask the phone to trust the Mac.
 */
async function ideviceinfoProbe(io, target, report, signal) {
	const tool = (await io.tools()).ideviceinfo?.path;
	if (!tool) {
		report.status = "ready";
		report.source = "plaintext";
		return report;
	}
	try {
		const { stdout } = await io.runTool(tool, ideviceinfoArgs(target, []), {
			timeoutMs: io.timeouts.ideviceinfo,
			signal
		});
		const all = parsePlist(stdout);
		report.sessionKeys = Object.keys(asDict(all) ?? {}).length;
		report.device = {
			...report.device,
			...whitelistDevice(all, "session")
		};
		const passcode = asDict(all)?.PasswordProtected;
		report.locked = typeof passcode === "boolean" ? passcode : null;
		if (iosMajor(report.device.ProductVersion) >= 16) report.developerMode = await io.runTool(tool, ideviceinfoArgs(target, [
			"-q",
			AMFI.domain,
			"-k",
			AMFI.key
		]), {
			timeoutMs: io.timeouts.ideviceinfo,
			signal
		}).then(({ stdout: out }) => {
			const value = parsePlist(out);
			return typeof value === "boolean" ? value : null;
		}).catch(() => null);
		report.status = "ready";
		report.source = "ideviceinfo";
		return report;
	} catch (error) {
		if (signal.aborted) throw abortError();
		const verdict = ideviceinfoVerdict(error);
		if (verdict) {
			report.status = verdict;
			report.reason = verdict === "untrusted" ? "InvalidHostID" : "PasswordProtected";
			return report;
		}
		report.status = "ready";
		report.source = "plaintext";
		return report;
	}
}
/** Session-holding work per device: at most two at once (§1.3). */
const SESSIONS_PER_DEVICE = 2;
function createIosLane(ctx, tuning = {}) {
	const t = {
		...IOS_TUNING,
		...tuning
	};
	const { timeouts, options } = ctx;
	const mux = createUsbmux({
		socketPath: options.usbmuxdSocket,
		timeouts,
		reconnectMs: t.reconnectMs
	});
	const entries = new Map();
	const closers = new Set();
	const probes = singleFlight();
	const details = singleFlight();
	let entrySerial = 0;
	const sessionLimits = new Map();
	const tlsFailures = [];
	const wrapperChecks = new Map();
	let toolbox = null;
	let started = false;
	let stopped = false;
	/** 'pending' until Listen first answers or fails, so startup reports no false outage. */
	let mux_ = "pending";
	let muxDownSince = null;
	let muxReason;
	/** devicectl exited 64 (no capture subcommand) this run: read as 'no-capture' until tools change. */
	let captureBroken = false;
	let unwatch = () => void 0;
	let ticker;
	let lastToolsCheck = 0;
	const track = (close) => {
		closers.add(close);
		return () => closers.delete(close);
	};
	const io = {
		mux,
		timeouts,
		tuning: t,
		tools: () => ctx.tools.get(),
		runTool: ctx.runTool,
		track
	};
	const sessions = (udid) => {
		let limit = sessionLimits.get(udid);
		if (!limit) {
			limit = createLimiter(SESSIONS_PER_DEVICE);
			sessionLimits.set(udid, limit);
		}
		return limit;
	};
	const wrapper = (file) => {
		let known = wrapperChecks.get(file);
		if (known === void 0) {
			known = isFirstLaunchWrapper(file);
			wrapperChecks.set(file, known);
		}
		return known;
	};
	/** The Xcode state as screenshots see it: discovery's verdict, then this run's own findings. */
	function xcodeState(box) {
		const xcode = box?.xcode;
		if (!xcode) return "not-installed";
		if (xcode.state !== "ready") return xcode.state;
		if (captureBroken) return "no-capture";
		if (!xcode.devicectl || wrapper(xcode.devicectl)) return "needs-first-launch";
		return "ready";
	}
	function iosTools() {
		return {
			xcode: xcodeState(toolbox),
			idevicescreenshot: !!toolbox?.idevicescreenshot,
			idevicesyslog: !!toolbox?.idevicesyslog
		};
	}
	async function loadTools(refresh = false) {
		const box = await (refresh ? ctx.tools.refresh() : ctx.tools.get());
		if (box !== toolbox) {
			if (refresh || box.xcode.devicectl !== toolbox?.xcode.devicectl) {
				captureBroken = false;
				wrapperChecks.clear();
			}
			toolbox = box;
			publish();
		}
		return box;
	}
	/**
	 * Whether an entry may be listed at all: a USB attachment, or (with --wifi) a Wi-Fi one
	 * that has stayed 2 s or is being held after it left (§3.9). A row already listed is back
	 * the moment usbmuxd re-adds it: the 2 s are for a phone first seen, not for each of its
	 * returns (otherwise every return hid the row for 2 s).
	 */
	function reachable(e, now) {
		if (e.ignored) return false;
		if (e.usbId !== null) return true;
		if (!options.wifi) return false;
		if (e.heldUntil !== null) return true;
		if (e.networkSince === null) return false;
		return e.shown || now - e.networkSince >= t.wifiStableMs;
	}
	function publish() {
		if (stopped || !started) return;
		const now = ctx.now();
		const tools = iosTools();
		const rows = [];
		let wifiHidden = 0;
		for (const e of entries.values()) {
			if (e.ignored) continue;
			e.connection = e.usbId !== null ? "usb" : "network";
			if (!options.wifi && e.usbId === null && e.networkId !== null) wifiHidden++;
			if (!reachable(e, now)) continue;
			if (!e.shown) {
				const waiting = e.firstProbeAt === null || now - e.firstProbeAt < t.connectingGraceMs;
				if (e.status === null && waiting) continue;
				e.shown = true;
			}
			rows.push(deriveIos(e, tools));
		}
		ctx.publish("ios", rows);
		ctx.setLane("ios", {
			...mux_ === "pending" ? {} : { status: mux_ === "ok" ? "ok" : "error" },
			screenshots: tools.xcode === "ready" ? "devicectl" : "none",
			xcode: tools.xcode,
			wifi: options.wifi,
			wifiHidden,
			reason: mux_ === "ok" || mux_ === "pending" ? void 0 : muxReason
		});
	}
	function newEntry(udid) {
		return {
			udid,
			connection: "usb",
			probing: false,
			status: null,
			reason: "",
			source: null,
			device: {},
			developerMode: null,
			locked: null,
			ddiRequired: false,
			devicectlUnsupported: false,
			usbId: null,
			networkId: null,
			abort: new AbortController(),
			firstProbeAt: null,
			networkSince: null,
			heldUntil: null,
			shown: false,
			ignored: false,
			hasRecord: null,
			needsProbe: false,
			polling: false,
			lastPoll: 0,
			lastProbe: 0,
			pinLogged: false,
			detail: null,
			flight: `${udid}#${String(++entrySerial)}`
		};
	}
	function remove(e) {
		entries.delete(e.udid);
		sessionLimits.delete(e.udid);
		e.abort.abort();
	}
	function attach(device) {
		const udid = device.Properties.SerialNumber;
		if (!ID.ios.test(udid)) return;
		let e = entries.get(udid);
		if (!e) {
			e = newEntry(udid);
			entries.set(udid, e);
		}
		e.heldUntil = null;
		if (device.Properties.ConnectionType === "USB") {
			if (e.usbId === device.DeviceID) return;
			e.usbId = device.DeviceID;
			probe(e);
		} else {
			if (e.networkId === device.DeviceID) return;
			e.networkId = device.DeviceID;
			e.networkSince ??= ctx.now();
			/** Wi-Fi presence flaps every few seconds [V]: probed once it has stayed (tick). */
			if (e.usbId === null) e.needsProbe = true;
		}
	}
	function detach(deviceId) {
		for (const e of entries.values()) if (e.usbId === deviceId) {
			e.usbId = null;
			/** §3.2: a USB detach removes the row at once (or leaves only its Wi-Fi presence). */
			if (e.networkId === null) remove(e);
			else {
				/** Whatever ran over the cable is gone with it; Wi-Fi gets a fresh probe. */
				e.abort.abort();
				e.abort = new AbortController();
				e.needsProbe = true;
			}
		} else if (e.networkId === deviceId) {
			e.networkId = null;
			e.networkSince = null;
			if (e.usbId !== null) continue;
			if (options.wifi && e.shown) e.heldUntil = ctx.now() + t.wifiHoldMs;
			else remove(e);
		}
	}
	function targetOf(e) {
		const deviceId = e.usbId ?? e.networkId;
		if (deviceId === null) throw new HelperError("IOS_UNREACHABLE", 502, "The iPhone dropped off Wi-Fi for now. It usually comes back within a minute; a cable keeps it steady.");
		return {
			udid: e.udid,
			deviceId,
			network: e.usbId === null
		};
	}
	function entryFor(id) {
		const e = entries.get(id);
		if (!e || e.ignored) throw new HelperError("DEVICE_NOT_FOUND", 404, "The device is no longer connected.");
		return e;
	}
	function noteTlsFailure(code) {
		if (tlsFailures.some((failure) => failure.code === code)) return;
		tlsFailures.push({
			node: options.nodeVersion,
			openssl: options.opensslVersion,
			code
		});
		ctx.log(`Node ${options.nodeVersion} (OpenSSL ${options.opensslVersion}) could not open an iPhone's secure session (${code})`);
	}
	function apply(e, report) {
		e.status = report.status;
		e.reason = report.reason;
		e.hasRecord = report.hasRecord ?? e.hasRecord;
		e.device = {
			...e.device,
			...report.device
		};
		if (!isHandheld(e.device)) e.ignored = true;
		if (report.status === "ready") {
			e.source = report.source;
			e.locked = report.locked;
			e.developerMode = report.developerMode;
		}
		if (report.tlsFailure) noteTlsFailure(report.tlsFailure);
		if (report.tls?.peerMatches === false) notePin(e);
	}
	/** Once per entry: the phone's certificate is not the pair record's (G25). */
	function notePin(e) {
		if (e.pinLogged) return;
		e.pinLogged = true;
		ctx.log(`${e.device.DeviceName ?? "iPhone"}: its certificate differs from the pair record (${t.enforcePinning ? "refused" : "not enforced"})`);
	}
	/** §3.4: single-flight per entry, its own abort, 12 s at most. */
	function probe(e) {
		return probes.run(e.flight, async () => {
			if (stopped || entries.get(e.udid) !== e) return;
			let target;
			try {
				target = targetOf(e);
			} catch {
				return;
			}
			e.probing = true;
			e.firstProbeAt ??= ctx.now();
			const op = linkSignals([ctx.signal, e.abort.signal], timeouts.probeTotal);
			try {
				const report = await sessions(e.udid)(() => probeOnce(io, target, op.signal));
				if (!(target.network && e.networkId !== target.deviceId) && !(target.network && e.status === "ready" && linkCut(report))) apply(e, report);
			} catch (error) {
				if (!op.signal.aborted && !isAbortError(error)) ctx.log(`iPhone probe failed: ${errorText(error)}`);
				/** The 12 s budget ran out with nothing known: the phone is not answering. */
				if (!e.abort.signal.aborted && !ctx.signal.aborted && e.status === null) {
					e.status = "offline";
					e.reason = "probe:timeout";
				}
			} finally {
				op.dispose();
				e.probing = false;
				e.lastProbe = ctx.now();
				/** The row's screenshot gap depends on the tools: read them (cached 30 s) first. */
				await loadTools().catch(() => void 0);
				publish();
			}
		});
	}
	async function pollRecord(e) {
		if (e.polling) return;
		e.polling = true;
		e.lastPoll = ctx.now();
		try {
			if (await mux.readPairRecord(e.udid)) await probe(e);
		} catch {} finally {
			e.polling = false;
		}
	}
	/** ListDevices after Listen (re)connects and on rescan: attach first, then drop the rest. */
	async function resync() {
		const list = await mux.listDevices();
		const seen = new Set();
		for (const device of list) {
			seen.add(device.DeviceID);
			attach(device);
		}
		for (const e of [...entries.values()]) {
			if (e.usbId !== null && !seen.has(e.usbId)) detach(e.usbId);
			if (e.networkId !== null && !seen.has(e.networkId)) detach(e.networkId);
		}
		publish();
	}
	function onMux(event) {
		switch (event.type) {
			case "listening":
				mux_ = "ok";
				muxDownSince = null;
				muxReason = void 0;
				resync().catch((error) => {
					ctx.log(`usbmuxd ListDevices failed: ${errorText(error)}`);
				});
				return;
			case "disconnected":
				mux_ = event.error.code === "missing" ? "missing" : "error";
				muxReason = event.error.code === "missing" ? `there is no usbmuxd socket at ${options.usbmuxdSocket}` : void 0;
				muxDownSince ??= ctx.now();
				publish();
				return;
			case "attached":
				attach(event.device);
				publish();
				return;
			case "detached":
				detach(event.deviceId);
				publish();
				return;
			case "paired":
				for (const e of entries.values()) if (e.usbId === event.deviceId || e.networkId === event.deviceId) probe(e);
				return;
		}
	}
	/** §1.3 cadences, Wi-Fi stability, grace periods: cheap, and only timed work while active. */
	function tick() {
		const now = ctx.now();
		let changed = false;
		const active = ctx.isActive();
		if (active && now - lastToolsCheck >= 5e3) {
			lastToolsCheck = now;
			loadTools().catch(() => void 0);
		}
		for (const e of [...entries.values()]) {
			if (e.ignored) continue;
			if (e.heldUntil !== null && now >= e.heldUntil) {
				remove(e);
				changed = true;
				continue;
			}
			if (!reachable(e, now)) continue;
			if (!e.shown && e.firstProbeAt !== null && now - e.firstProbeAt >= t.connectingGraceMs) changed = true;
			if (e.usbId === null) {
				if (e.heldUntil !== null) continue;
				if (e.needsProbe && !e.probing) {
					e.needsProbe = false;
					changed = true;
					probe(e);
					continue;
				}
			}
			if (!active || e.probing) continue;
			if (e.status === "untrusted" && e.hasRecord === false) {
				if (now - e.lastPoll >= t.pairPollMs) pollRecord(e);
			} else if (e.status !== "ready" && e.status !== "unknown" && e.status !== null) {
				/**
				 * Revoked trust, a lock, a pending Trust dialog, or a phone that attached while still
				 * booting (offline): all clear up on the phone, so look again every 5 s.
				 */
				if (now - e.lastProbe >= t.reprobeMs) probe(e);
			}
		}
		if (muxDownSince !== null && now - muxDownSince >= t.muxGraceMs && entries.size) {
			for (const e of [...entries.values()]) remove(e);
			changed = true;
		}
		if (changed) publish();
	}
	/** A trust or lock refusal during an operation updates the row and re-probes (§2.7). */
	function refusal(e, status, reason) {
		e.status = status;
		e.reason = reason;
		publish();
		probe(e);
		if (status === "locked") return new HelperError("IOS_LOCKED", 409, "The iPhone has not been unlocked since it restarted.", {
			state: "locked",
			blockers: ["IOS_LOCKED"]
		});
		return new HelperError("IOS_UNTRUSTED", 409, "This iPhone does not trust this Mac.", {
			state: status === "authorizing" ? "authorizing" : "untrusted",
			blockers: ["IOS_UNTRUSTED"]
		});
	}
	/**
	 * G25 during an operation: the phone (or something answering for it) presented a certificate
	 * other than the pair record's. Nothing it said is used; the row goes offline until a probe
	 * sees the paired phone again.
	 */
	function pinRefused(e) {
		e.status = "offline";
		e.reason = "tls:pin";
		e.detail = null;
		notePin(e);
		publish();
		return new HelperError("IOS_LOCKDOWN_FAILED", 502, "The iPhone presented a certificate other than the one it was paired with, so the helper stopped talking to it.");
	}
	/**
	 * A lockdown or usbmuxd failure during an operation, as the page should see it: a trust or
	 * lock refusal updates the row, anything else is IOS_UNREACHABLE and a fresh probe.
	 */
	function sessionFailure(e, error, signal) {
		if (signal.aborted) return abortError();
		if (error instanceof HelperError) return error;
		if (!(error instanceof LockdownError) && !(error instanceof MuxError)) return error instanceof Error ? error : new Error(String(error));
		if (error.code === "tls-pin") return pinRefused(e);
		const verdict = sessionVerdict(error.code);
		if (verdict === "untrusted" || verdict === "locked" || verdict === "authorizing") return refusal(e, verdict, sessionReason(error.code));
		probe(e);
		return new HelperError("IOS_UNREACHABLE", 502, `The iPhone did not answer (${errorText(error)}).`);
	}
	/**
	 * A session for one operation. Trust and lock refusals become the matching HelperError
	 * (and update the row); a TLS failure is rethrown as LockdownError('tls-failed') for the
	 * caller's fallback; a pinning mismatch is IOS_LOCKDOWN_FAILED; anything else is
	 * IOS_UNREACHABLE.
	 */
	async function openSession(e, signal) {
		const target = targetOf(e);
		let lockdown;
		try {
			lockdown = await openLockdown(io, target, signal);
		} catch (error) {
			if (signal.aborted) throw abortError();
			probe(e);
			throw new HelperError("IOS_UNREACHABLE", 502, `The iPhone did not answer (${errorText(error)}).`);
		}
		try {
			const record = await mux.readPairRecord(e.udid);
			if (!record) {
				e.hasRecord = false;
				throw refusal(e, "untrusted", "pair-record:none");
			}
			const session = await lockdown.startSession(record);
			return {
				lockdown,
				session,
				record,
				target
			};
		} catch (error) {
			lockdown.close();
			if (!signal.aborted && error instanceof LockdownError && error.code === "tls-failed") {
				noteTlsFailure(error.detail || error.code);
				throw error;
			}
			throw sessionFailure(e, error, signal);
		}
	}
	/** An operation's signal: the request's, the device's and shutdown's, plus a deadline. */
	function opSignal(e, signal, timeoutMs) {
		return linkSignals([
			signal,
			e.abort.signal,
			ctx.signal
		], timeoutMs);
	}
	/** An aborted operation: the client left (null reply) or our own deadline (504). */
	function abortedError(signal, what) {
		return signal.aborted ? abortError() : new HelperError("TOOL_TIMEOUT", 504, `The iPhone took too long to ${what}.`);
	}
	async function lockdownDetail(e, signal) {
		const s = await openSession(e, signal);
		try {
			const all = await s.lockdown.getValue();
			const device = { ...whitelistDevice(all, "session") };
			const passcode = asDict(all)?.PasswordProtected;
			const withheld = [];
			const facts = {
				udid: e.udid,
				connection: s.target.network ? "network" : "usb",
				source: "lockdown",
				device,
				developerMode: null,
				locked: typeof passcode === "boolean" ? passcode : null,
				withheld
			};
			for (const name of [
				"battery",
				"disk",
				"international"
			]) {
				const spec = DOMAINS[name];
				try {
					const kept = pickTyped(await s.lockdown.getValue(spec.domain, void 0, { timeoutMs: timeouts.domain }), spec.keys);
					if (kept) Object.assign(facts, { [name]: kept });
				} catch (error) {
					if (error instanceof LockdownError && WITHHELD_CODES.has(error.code)) withheld.push(name);
				}
			}
			if (iosMajor(device.ProductVersion) >= 16) try {
				const value = await s.lockdown.getValue(AMFI.domain, AMFI.key, { timeoutMs: timeouts.domain });
				facts.developerMode = typeof value === "boolean" ? value : null;
			} catch (error) {
				if (error instanceof LockdownError && WITHHELD_CODES.has(error.code)) withheld.push("developerMode");
			}
			await s.lockdown.stopSession().catch(() => void 0);
			return facts;
		} catch (error) {
			/** The link dropped or lockdownd refused mid-session: never a raw LockdownError. */
			throw sessionFailure(e, error, signal);
		} finally {
			s.lockdown.close();
		}
	}
	async function ideviceinfoDetail(e, signal) {
		const tool = (await loadTools()).ideviceinfo?.path;
		if (!tool) return plaintextFacts(e);
		const target = targetOf(e);
		const read = async (extra) => {
			const { stdout } = await ctx.runTool(tool, ideviceinfoArgs(target, extra), {
				timeoutMs: timeouts.ideviceinfo,
				signal
			});
			return parsePlist(stdout);
		};
		let all;
		try {
			all = await read([]);
		} catch (error) {
			if (signal.aborted) throw abortError();
			const verdict = ideviceinfoVerdict(error);
			if (verdict) throw refusal(e, verdict, verdict === "untrusted" ? "InvalidHostID" : "PasswordProtected");
			throw error;
		}
		const device = whitelistDevice(all, "session");
		const passcode = asDict(all)?.PasswordProtected;
		const withheld = [];
		const facts = {
			udid: e.udid,
			connection: target.network ? "network" : "usb",
			source: "ideviceinfo",
			device,
			developerMode: null,
			locked: typeof passcode === "boolean" ? passcode : null,
			withheld
		};
		for (const name of [
			"battery",
			"disk",
			"international"
		]) {
			const spec = DOMAINS[name];
			try {
				const kept = pickTyped(await read(["-q", spec.domain]), spec.keys);
				if (kept) Object.assign(facts, { [name]: kept });
			} catch (error) {
				if (signal.aborted) throw abortError();
				if (ideviceinfoVerdict(error) === "locked") withheld.push(name);
			}
		}
		if (iosMajor(device.ProductVersion) >= 16) try {
			const value = await read([
				"-q",
				AMFI.domain,
				"-k",
				AMFI.key
			]);
			facts.developerMode = typeof value === "boolean" ? value : null;
		} catch {
			if (signal.aborted) throw abortError();
		}
		return facts;
	}
	function plaintextFacts(e) {
		return {
			udid: e.udid,
			connection: e.connection,
			source: "plaintext",
			device: { ...e.device },
			developerMode: e.developerMode,
			locked: null,
			withheld: []
		};
	}
	async function detail(id, signal) {
		const e = entryFor(id);
		const cached = e.detail;
		if (cached && ctx.now() - cached.at < t.detailCacheMs) return {
			platform: "ios",
			kind: "ios",
			facts: cached.facts
		};
		return {
			platform: "ios",
			kind: "ios",
			facts: await details.run(id, async () => {
				const op = opSignal(e, signal, timeouts.detailTotal);
				try {
					let result;
					if (e.source === "plaintext") result = plaintextFacts(e);
					else if (e.source === "ideviceinfo") result = await ideviceinfoDetail(e, op.signal);
					else try {
						result = await sessions(e.udid)(() => lockdownDetail(e, op.signal));
					} catch (error) {
						if (!(error instanceof LockdownError) || error.code !== "tls-failed") throw error;
						result = await ideviceinfoDetail(e, op.signal);
					}
					e.detail = {
						at: ctx.now(),
						facts: result
					};
					/** The detail is the freshest read of these: the row follows it. */
					const before = JSON.stringify([e.developerMode, e.device]);
					e.device = {
						...e.device,
						...result.device
					};
					if (result.developerMode !== null) e.developerMode = result.developerMode;
					if (JSON.stringify([e.developerMode, e.device]) !== before) publish();
					return result;
				} catch (error) {
					if (op.signal.aborted && !(error instanceof HelperError)) throw abortedError(signal, "answer");
					throw error;
				} finally {
					op.dispose();
				}
			})
		};
	}
	async function readJson(file) {
		try {
			if ((await stat(file)).size > LIMITS.text) return null;
			return JSON.parse(await readFile(file, "utf8"));
		} catch {
			return null;
		}
	}
	async function readPng(file, what) {
		try {
			if ((await stat(file)).size > LIMITS.png) throw new HelperError("TOOL_FAILED", 502, `${what} wrote an image larger than the helper accepts.`);
			return await readFile(file);
		} catch (error) {
			if (error instanceof HelperError) throw error;
			throw new HelperError("TOOL_FAILED", 502, `${what} reported success but wrote no image.`);
		}
	}
	/** One devicectl capture (§3.7 lane 1), in its own private folder. */
	async function devicectlOnce(e, box, signal) {
		const xcode = box.xcode;
		const file = xcode.devicectl;
		if (!file) throw new HelperError("XCODE_REQUIRED", 503, "Screenshots of this iPhone need Xcode.");
		return ctx.withTempDir(async (dir) => {
			const png = path.join(dir, "shot.png");
			const json = path.join(dir, "out.json");
			const deviceTimeout = Math.max(5, Math.round(timeouts.devicectlScreenshot / 1e3) - 5);
			let exitCode = 0;
			try {
				await ctx.runTool(file, [
					"device",
					"capture",
					"screenshot",
					"--device",
					e.udid,
					"--destination",
					png,
					"--timeout",
					String(deviceTimeout),
					"--json-output",
					json
				], {
					timeoutMs: timeouts.devicectlScreenshot,
					signal,
					cwd: dir,
					env: ctx.childEnv(xcode.devDir ? { DEVELOPER_DIR: xcode.devDir } : {}),
					maxBytes: LIMITS.text
				});
			} catch (error) {
				if (!(error instanceof ToolError)) throw error;
				if (error.reason === "not-found") exitCode = 72;
				else if (error.reason === "exit") exitCode = error.code;
				else throw error;
			}
			if (exitCode === 64) {
				captureBroken = true;
				publish();
			}
			if (exitCode === 72) loadTools(true).catch(() => void 0);
			const verdict = classifyDevicectl(await readJson(json), exitCode);
			if (verdict) throw verdict;
			return readPng(png, "devicectl");
		});
	}
	async function devicectlShot(e, box, signal) {
		try {
			return await devicectlOnce(e, box, signal);
		} catch (error) {
			if (!(error instanceof HelperError) || error.code !== "IOS_UNREACHABLE") throw error;
			await sleep(t.devicectlRetryMs, signal);
			return devicectlOnce(e, box, signal);
		}
	}
	/** §3.7 lane 2: iOS 16 and older, with a disk image already mounted. */
	async function idevicescreenshotShot(e, tool, signal) {
		const target = targetOf(e);
		return ctx.withTempDir(async (dir) => {
			const png = path.join(dir, "shot.png");
			const ddi = (text) => /screenshotr/i.test(text);
			const required = () => {
				e.ddiRequired = true;
				publish();
				return new HelperError("IOS_DDI_REQUIRED", 409, "Screenshots of this iPhone need its developer disk image mounted first.");
			};
			let said;
			try {
				const run = await ctx.runTool(tool, [
					"-u",
					target.udid,
					...target.network ? ["-n"] : [],
					png
				], {
					timeoutMs: timeouts.idevicescreenshot,
					signal,
					cwd: dir
				});
				said = `${run.stdout}\n${run.stderr}`;
			} catch (error) {
				if (error instanceof ToolError && error.reason === "exit") {
					if (ddi(`${error.stderr}\n${String(error.stdout)}`)) throw required();
				}
				throw error;
			}
			if (!existsSync(png) && ddi(said)) throw required();
			return readPng(png, "idevicescreenshot");
		});
	}
	/** §3.7 lane 3: nothing applies, and the error names what would. */
	function nothingApplies(e, box) {
		if (iosMajor(e.device.ProductVersion) > 0 && iosMajor(e.device.ProductVersion) <= 16) return new HelperError("TOOL_MISSING", 503, "Screenshots of iOS 16 and older need libimobiledevice.", {
			tool: "idevicescreenshot",
			install: INSTALL.libimobiledevice
		});
		if (e.devicectlUnsupported) return new HelperError("SCREENSHOT_UNSUPPORTED", 501, "Xcode cannot take screenshots of this device.");
		return xcodeState(box) === "needs-first-launch" ? new HelperError("XCODE_SETUP_REQUIRED", 503, "Xcode must finish setting up before screenshots work.") : new HelperError("XCODE_REQUIRED", 503, "Screenshots of iOS 17 and newer need Xcode.");
	}
	async function screenshot(id, signal) {
		const e = entryFor(id);
		const box = await loadTools();
		if (e.developerMode === false) throw new HelperError("IOS_DEVELOPER_MODE_OFF", 409, "Developer Mode is off on this iPhone, so screenshots are off.");
		if (e.ddiRequired) throw new HelperError("IOS_DDI_REQUIRED", 409, "Screenshots of this iPhone need its developer disk image mounted first.");
		const op = opSignal(e, signal);
		try {
			const fallback = iosMajor(e.device.ProductVersion) > 0 && iosMajor(e.device.ProductVersion) <= 16 ? box.idevicescreenshot?.path ?? null : null;
			if (xcodeState(box) === "ready" && !e.devicectlUnsupported) try {
				return {
					png: await devicectlShot(e, box, op.signal),
					source: "devicectl"
				};
			} catch (error) {
				if (!(error instanceof HelperError)) throw error;
				if (error.code === "IOS_DEVELOPER_MODE_OFF") {
					e.developerMode = false;
					publish();
				}
				if (error.code !== "SCREENSHOT_UNSUPPORTED") throw error;
				e.devicectlUnsupported = true;
				publish();
				if (!fallback) throw error;
			}
			if (fallback) return {
				png: await idevicescreenshotShot(e, fallback, op.signal),
				source: "idevicescreenshot"
			};
			throw nothingApplies(e, box);
		} finally {
			op.dispose();
		}
	}
	/**
	 * §3.8 lane 1: a session, StartService syslog_relay, a pipe to its port (TLS when asked),
	 * then StopSession and close: the relay keeps streaming on its own connection. null means
	 * "use the fallback": the service is missing, or this Node could not do TLS.
	 */
	async function openSyslogRelay(e, signal) {
		let s;
		try {
			s = await sessions(e.udid)(() => openSession(e, signal));
		} catch (error) {
			if (error instanceof LockdownError) return null;
			throw error;
		}
		try {
			let service;
			try {
				service = await s.lockdown.startService("com.apple.syslog_relay");
			} catch (error) {
				if (error instanceof LockdownError && error.code === "PasswordProtected") throw new HelperError("IOS_LOCKED", 409, "Unlock the iPhone, then start the log again.");
				return null;
			}
			let socket;
			try {
				socket = await mux.connect(s.target.deviceId, service.port, {
					timeoutMs: connectTimeout(io, s.target),
					signal
				});
			} catch {
				if (signal.aborted) throw abortError();
				return null;
			}
			/** A stream that ends during the handshake must not leave the relay behind (§3.8). */
			const raw = socket;
			const onAbort = () => {
				raw.destroy();
			};
			signal.addEventListener("abort", onAbort, { once: true });
			try {
				if (service.ssl) socket = (await startTls(socket, s.record, timeouts.lockdownTls, { pin: t.enforcePinning })).socket;
			} catch (error) {
				if (signal.aborted) throw abortError();
				if (error instanceof LockdownError && error.code === "tls-pin") throw pinRefused(e);
				if (error instanceof LockdownError && error.code === "tls-failed") noteTlsFailure(error.detail || error.code);
				return null;
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
			await s.lockdown.stopSession().catch(() => void 0);
			if (signal.aborted) {
				socket.destroy();
				throw abortError();
			}
			return socket;
		} finally {
			s.lockdown.close();
		}
	}
	/**
	 * Reads the relay until it ends, with back-pressure. 'silent' when nothing arrived in the
	 * first `logSilenceSwitch` and a fallback exists: the caller switches to idevicesyslog.
	 */
	function pumpRelay(socket, sink, signal, canSwitch) {
		return new Promise((resolve) => {
			/** An abort that came first would never fire the listener below. */
			if (signal.aborted) {
				socket.destroy();
				resolve("ended");
				return;
			}
			const untrack = track(() => socket.destroy());
			let carry = Buffer.alloc(0);
			let heard = false;
			let outcome = "ended";
			const silence = canSwitch ? setTimeout(() => {
				if (heard) return;
				outcome = "silent";
				socket.destroy();
			}, timeouts.logSilenceSwitch) : void 0;
			const onAbort = () => {
				socket.destroy();
			};
			signal.addEventListener("abort", onAbort, { once: true });
			socket.on("data", (chunk) => {
				heard = true;
				const { lines, carry: rest } = splitSyslogRelay(chunk, carry);
				carry = rest;
				if (lines.length && !sink.push(lines)) {
					socket.pause();
					sink.drain().then(() => socket.resume());
				}
			});
			socket.on("error", () => void 0);
			socket.once("close", () => {
				clearTimeout(silence);
				signal.removeEventListener("abort", onAbort);
				untrack();
				if (carry.length && outcome === "ended" && !signal.aborted) {
					const { lines } = splitSyslogRelay(Buffer.from([0]), carry);
					if (lines.length) sink.push(lines);
				}
				resolve(outcome);
			});
			sink.hello("syslog_relay");
			socket.resume();
		});
	}
	/**
	 * §3.8 lane 2: `idevicesyslog -u <UDID> --no-colors -x [-n]`, its own TLS stack and service.
	 * `[connected:…]` becomes a notice, `[disconnected:…]` ends the stream as device-gone, and
	 * nothing within `logFirstByte` means the lane does not work for this phone.
	 */
	function runIdevicesyslog(e, tool, sink, signal, switched) {
		const target = targetOf(e);
		return new Promise((resolve, reject) => {
			let started = switched;
			let gone = false;
			let firstByte;
			const handle = ctx.streamTool(tool, [
				"-u",
				target.udid,
				"--no-colors",
				"-x",
				...target.network ? ["-n"] : []
			], {
				signal,
				onLines(lines) {
					if (!started) {
						started = true;
						clearTimeout(firstByte);
						sink.hello("idevicesyslog");
					}
					const out = [];
					for (const line of lines) if (/^\[connected:/.test(line)) {
						if (!switched) sink.notice("Connected through idevicesyslog");
					} else if (/^\[disconnected:/.test(line)) {
						gone = true;
						handle.kill();
					} else out.push(line);
					if (out.length && !sink.push(out)) {
						handle.pause();
						sink.drain().then(() => handle.resume());
					}
				}
			});
			if (!started) firstByte = setTimeout(() => {
				handle.kill();
			}, timeouts.logFirstByte);
			handle.done.then((result) => {
				clearTimeout(firstByte);
				if (signal.aborted) return reject(abortError());
				if (gone) return reject(new HelperError("DEVICE_NOT_FOUND", 404, "The device disconnected."));
				if (!started) return reject(new HelperError("LOGS_UNAVAILABLE", 503, clean(result.stderr.trim(), 500) || "idevicesyslog printed nothing."));
				resolve();
			}, (error) => {
				clearTimeout(firstByte);
				reject(error instanceof Error ? error : new Error(String(error)));
			});
		});
	}
	/**
	 * A log over Wi-Fi that ends without being asked to is a link that dropped: syslog_relay
	 * and idevicesyslog never end on their own. The row stays (the hold), so without this the
	 * stream would end as a plain `eof` and the page could not tell a drop from a finish.
	 */
	function dropped() {
		return new HelperError("DEVICE_DROPPED", 503, "The iPhone dropped off Wi-Fi.");
	}
	async function logs(id, sink, signal) {
		const e = entryFor(id);
		const network = targetOf(e).network;
		const op = opSignal(e, signal);
		try {
			const fallback = (await loadTools()).idevicesyslog?.path ?? null;
			if (e.source === "lockdown") {
				const relay = await openSyslogRelay(e, op.signal);
				if (relay) {
					const outcome = await pumpRelay(relay, sink, op.signal, fallback !== null);
					if (op.signal.aborted) return;
					if (outcome === "ended") {
						if (network) throw dropped();
						return;
					}
					sink.notice("Switched to idevicesyslog");
					if (fallback) await runIdevicesyslog(e, fallback, sink, op.signal, true);
					if (network && !op.signal.aborted) throw dropped();
					return;
				}
			}
			if (fallback) {
				await runIdevicesyslog(e, fallback, sink, op.signal, false);
				if (network && !op.signal.aborted) throw dropped();
				return;
			}
			throw new HelperError("LOGS_UNAVAILABLE", 503, "No log source works for this iPhone.");
		} finally {
			op.dispose();
		}
	}
	/**
	 * --doctor (§1.9): a read-only probe of every attached iPhone, printed as facts: counts,
	 * protocol names and yes/no. Never key material, log text, IMEI or phone numbers, and
	 * not the device name either: this output is pasted into pull requests.
	 */
	async function probeForDoctor(write) {
		const deadline = linkSignals([ctx.signal], timeouts.doctorTotal);
		const say = (line) => write(line);
		try {
			try {
				await mux.readBuid();
				say("iPhone: usbmuxd answers");
			} catch (error) {
				say(`iPhone: usbmuxd is not answering (${error instanceof MuxError ? error.code : errorText(error)})`);
				return;
			}
			const list = await mux.listDevices();
			const byUdid = new Map();
			for (const device of list) {
				const udid = device.Properties.SerialNumber;
				if (!ID.ios.test(udid)) continue;
				const usb = device.Properties.ConnectionType === "USB";
				const known = byUdid.get(udid);
				const label = `${usb ? "USB" : "Wi-Fi"} DeviceID ${String(device.DeviceID)}`;
				if (!known) byUdid.set(udid, {
					udid,
					deviceId: device.DeviceID,
					network: !usb,
					deviceIds: [label]
				});
				else {
					known.deviceIds.push(label);
					if (usb) Object.assign(known, {
						deviceId: device.DeviceID,
						network: false
					});
				}
			}
			say(`iPhone: ${String(byUdid.size)} device(s) listed by usbmuxd`);
			for (const target of byUdid.values()) {
				if (deadline.signal.aborted) {
					say("  (stopped: the doctor ran out of time)");
					break;
				}
				await doctorDevice(target, say, deadline.signal);
			}
		} finally {
			deadline.dispose();
		}
	}
	async function doctorDevice(target, say, signal) {
		say(`  ${target.udid} · ${target.deviceIds.join(" · ")}`);
		let report;
		try {
			report = await probeOnce(io, target, signal, { domains: true });
		} catch {
			say("    probe: did not finish");
			return;
		}
		const yesNo = (value) => value === null ? "unknown" : value ? "yes" : "no";
		const d = report.device;
		say(`    model: ${d.ProductType ?? "?"} · ${d.DeviceClass ?? "?"} · iOS ${d.ProductVersion ?? "?"} (${d.BuildVersion ?? "?"})`);
		say(`    QueryType: ${report.queryType ?? "no answer"} · plaintext GetValue: ${String(report.plaintextKeys)} keys`);
		say(`    pair record: ${yesNo(report.hasRecord)}`);
		say(`    StartSession: ${report.session ?? "not tried"}`);
		if (report.tls) say(`    TLS: ${report.tls.protocol ?? "?"} ${report.tls.cipher ?? "?"}`);
		if (report.tlsFailure) say(`    TLS failed on this Node: ${report.tlsFailure}`);
		if (report.sessionKeys !== null) say(`    session GetValue: ${String(report.sessionKeys)} keys · PasswordProtected ${yesNo(report.locked)}`);
		for (const [name, result] of Object.entries(report.domains)) say(`    ${name}: ${result}`);
		if (report.source === "lockdown") {
			say(`    amfi DeveloperModeStatus: ${report.developerMode === null ? "unreadable" : String(report.developerMode)}`);
			say(`    peer certificate equals the pair record's DeviceCertificate: ${yesNo(report.tls?.peerMatches ?? null)}`);
		}
		say(`    row: ${report.status}${report.reason ? ` (${report.reason})` : ""}${report.source ? ` · source ${report.source}` : ""}`);
		if (report.source === "lockdown") await doctorSyslog(target, say, signal);
		await doctorLockState(target, say, signal);
	}
	async function doctorSyslog(target, say, signal) {
		const e = newEntry(target.udid);
		if (target.network) e.networkId = target.deviceId;
		else e.usbId = target.deviceId;
		const op = linkSignals([signal], t.doctorSyslogMs + timeouts.lockdownRequest * 2);
		try {
			const socket = await openSyslogRelay(e, op.signal);
			if (!socket) {
				say("    syslog_relay: not available");
				return;
			}
			let bytes = 0;
			socket.on("data", (chunk) => {
				bytes += chunk.length;
			});
			socket.on("error", () => void 0);
			socket.resume();
			await Promise.race([sleep(t.doctorSyslogMs, op.signal).catch(() => void 0), aborted(op.signal)]);
			socket.destroy();
			say(`    syslog_relay ${String(t.doctorSyslogMs / 1e3)} s: ${String(bytes)} bytes`);
		} catch (error) {
			say(`    syslog_relay: ${error instanceof HelperError ? error.code : errorText(error)}`);
		} finally {
			op.dispose();
		}
	}
	/** devicectl `device info lockState`: --doctor only (§3.6), and only with a ready Xcode. */
	async function doctorLockState(target, say, signal) {
		const box = await loadTools().catch(() => null);
		if (!box || xcodeState(box) !== "ready" || !box.xcode.devicectl) {
			say("    devicectl lockState: skipped (Xcode is not ready)");
			return;
		}
		const file = box.xcode.devicectl;
		const devDir = box.xcode.devDir;
		try {
			const value = (await ctx.withTempDir(async (dir) => {
				const json = path.join(dir, "lock.json");
				await ctx.runTool(file, [
					"device",
					"info",
					"lockState",
					"--device",
					target.udid,
					"--timeout",
					"8",
					"--json-output",
					json
				], {
					timeoutMs: timeouts.doctorSlowCheck,
					signal,
					cwd: dir,
					env: ctx.childEnv(devDir ? { DEVELOPER_DIR: devDir } : {})
				});
				return readJson(json);
			}))?.result ?? {};
			say(`    devicectl lockState: passcodeRequired ${String(value.passcodeRequired)} · unlockedSinceBoot ${String(value.unlockedSinceBoot)}`);
		} catch (error) {
			say(`    devicectl lockState: ${error instanceof ToolError ? error.reason : errorText(error)}`);
		}
	}
	return {
		name: "ios",
		start() {
			if (started) return;
			started = true;
			ticker = setInterval(tick, t.tickMs);
			ticker.unref();
			unwatch = mux.watch(onMux);
			loadTools().catch(() => void 0);
		},
		async stop() {
			stopped = true;
			unwatch();
			clearInterval(ticker);
			for (const e of entries.values()) e.abort.abort();
			for (const close of [...closers]) close();
			closers.clear();
			return Promise.resolve();
		},
		async rescan(opts = {}) {
			const signal = opts.signal ?? ctx.signal;
			await loadTools().catch(() => void 0);
			await Promise.race([resync(), aborted(signal)]);
			await Promise.race([Promise.allSettled([...entries.values()].filter((e) => !e.ignored).map((e) => probe(e))), aborted(signal)]);
		},
		detail,
		screenshot,
		logs,
		async retry(id, signal) {
			const e = entryFor(id);
			e.ddiRequired = false;
			await Promise.race([Promise.allSettled([loadTools(true), probe(e)]), aborted(signal)]);
		},
		facts: () => ({
			usbmuxd: mux_ === "pending" ? existsSync(options.usbmuxdSocket) ? "ok" : "missing" : mux_,
			tlsFailures: tlsFailures.map((failure) => ({ ...failure })),
			devices: [...entries.values()].filter((e) => e.shown && !e.ignored).length
		}),
		probeForDoctor
	};
}

//#endregion
//#region src/simulator-lane.ts
/**
 * §8 Simulator lane: booted iOS Simulators through simctl, only with --simulators (§5).
 *
 * Why it exists: it is the whole path (list → detail → screenshot → logs) on a Mac with no
 * phone at hand. Why it is off by default: a Mac often has several simulators booted, and
 * listing them would defeat the page's "one ready device" auto-select.
 *
 * Read-only by construction. The lane lists, screenshots and streams the log of simulators
 * that are ALREADY booted; it never boots, shuts down, erases or installs anything, and the
 * only simctl subcommands it runs are `list`, `io <udid> screenshot` and `spawn <udid> log
 * stream` (SIMCTL_COMMANDS). It runs the real simctl binary that resolveSimctl() found behind
 * its first-launch gate (§1.5), never the `xcrun`/Xcode wrapper that could start a first
 * launch, with DEVELOPER_DIR pointing at the same Xcode.
 *
 * The traps from the research, each handled where it bites:
 * - `io screenshot` on a simulator that is not booted hangs forever: a fresh `Booted` check
 *   first, and a hard timeout anyway;
 * - `io screenshot -` writes a file literally named `-` (and /dev/stdout is refused): always a
 *   file in a private temp folder, which is also the tool's working directory;
 * - `log stream` prints a column header first and `getpwuid_r…` noise on stderr: both dropped;
 * - simctl's own exit codes: 148 is an unknown device, 149 one that is not booted.
 */
/** Every simctl subcommand this lane runs (the argv prefix before any udid or path). */
const SIMCTL_COMMANDS = [
	[
		"list",
		"-j",
		"devices",
		"booted"
	],
	[
		"list",
		"-j",
		"runtimes"
	],
	[
		"list",
		"-j",
		"devicetypes"
	],
	[
		"io",
		"<udid>",
		"screenshot"
	],
	[
		"spawn",
		"<udid>",
		"log",
		"stream"
	]
];
/** Only iOS simulators: watchOS, tvOS and visionOS ones are not phones the page can show. */
const IOS_RUNTIME = /^com\.apple\.CoreSimulator\.SimRuntime\.iOS-(\d+)-(\d+)(?:-(\d+))?$/;
/** The column header `log stream --style compact` prints before the first line. */
const LOG_HEADER = /^Timestamp\s+Ty\s+Process\[PID:TID\]\s*$/;
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value, max = LIMITS.field) => typeof value === "string" ? clean(value, max) : "";
/** `{runtimes:[…]}` or `{devicetypes:[…]}` → identifier → entry. */
function byIdentifier(list, key) {
	const out = new Map();
	const items = isObject(list) ? list[key] : void 0;
	if (!Array.isArray(items)) return out;
	for (const item of items) if (isObject(item) && typeof item.identifier === "string") out.set(item.identifier, item);
	return out;
}
/**
 * `simctl list -j devices` joined with `list -j runtimes` and `list -j devicetypes`: the
 * booted and booting iOS simulators. Runtimes or device types it cannot find (a stale cache,
 * a runtime being deleted) leave their fields to what the identifiers say. Only the fields
 * in SimEntry are read: dataPath and logPath carry the user's name and are never kept.
 */
function simEntries(devices, runtimes, devicetypes) {
	const runtimeIndex = byIdentifier(runtimes, "runtimes");
	const typeIndex = byIdentifier(devicetypes, "devicetypes");
	const groups = isObject(devices) && isObject(devices.devices) ? devices.devices : {};
	const out = [];
	for (const [identifier, list] of Object.entries(groups)) {
		const match = IOS_RUNTIME.exec(identifier);
		if (!match || !Array.isArray(list)) continue;
		const runtime = runtimeIndex.get(identifier);
		if (runtime && typeof runtime.platform === "string" && runtime.platform !== "iOS") continue;
		const fromId = [
			match[1],
			match[2],
			match[3]
		].filter((part) => part !== void 0).join(".");
		for (const device of list) {
			if (!isObject(device)) continue;
			const state = device.state;
			if (state !== "Booted" && state !== "Booting") continue;
			const udid = typeof device.udid === "string" ? device.udid : "";
			if (!ID.sim.test(udid)) continue;
			const typeId = text(device.deviceTypeIdentifier, 200);
			const type = typeIndex.get(typeId);
			const size = device.dataPathSize;
			out.push({
				udid,
				name: text(device.name, LIMITS.name),
				state,
				runtime: {
					identifier,
					name: text(runtime?.name) || `iOS ${fromId}`,
					version: text(runtime?.version) || fromId,
					build: text(runtime?.buildversion)
				},
				deviceType: {
					identifier: typeId,
					name: text(type?.name),
					modelIdentifier: text(type?.modelIdentifier)
				},
				...typeof size === "number" && Number.isFinite(size) && size >= 0 ? { dataPathSize: size } : {}
			});
		}
	}
	return out;
}
/** One simulator as the page sees it (§5 Row). */
function simulatorRow(entry) {
	const ready = entry.state === "Booted";
	return {
		id: entry.udid,
		platform: "ios",
		connection: "simulator",
		state: ready ? "ready" : "connecting",
		name: entry.name,
		model: entry.deviceType.name,
		modelId: entry.deviceType.modelIdentifier,
		osVersion: entry.runtime.version,
		blockers: [],
		capabilities: {
			screenshot: ready,
			identifiers: ready,
			logs: ready,
			install: false
		}
	};
}
/** The facts the detail pane shows; nothing that names the Mac's user. */
function simFacts(entry) {
	return {
		udid: entry.udid,
		name: entry.name,
		deviceType: {
			name: entry.deviceType.name,
			modelIdentifier: entry.deviceType.modelIdentifier
		},
		runtime: {
			name: entry.runtime.name,
			version: entry.runtime.version,
			build: entry.runtime.build
		},
		state: entry.state,
		...entry.dataPathSize !== void 0 ? { dataPathSize: entry.dataPathSize } : {}
	};
}
/** Why the lane cannot run, in words that follow "Simulators  unavailable · " in the banner. */
function simctlReason(info) {
	switch (info.state) {
		case "needs-first-launch": return "Xcode must finish setting up before simulators work: open Xcode once";
		case "not-selected": return "simulators need the Xcode app selected (see --doctor)";
		default: return "simulators need Xcode";
	}
}
/** simctl's own exit codes for "no such device" and "not booted" [V]. */
function simctlError(error) {
	if (error instanceof ToolError && error.reason === "exit") {
		if (error.code === 148) return new HelperError("DEVICE_NOT_FOUND", 404, "The simulator is no longer there.");
		if (error.code === 149) return new HelperError("DEVICE_NOT_READY", 409, "The simulator is not booted.", {
			state: "offline",
			blockers: []
		});
	}
	return error;
}
const SIMULATOR_CADENCE = {
	listMs: 5e3,
	catalogMs: 6e5
};
/** The lane (§5). `cadence` exists for tests. */
function createSimulatorLane(ctx, cadence = {}) {
	const pace = {
		...SIMULATOR_CADENCE,
		...cadence
	};
	const { timeouts } = ctx;
	const flights = singleFlight();
	let entries = [];
	let simctl = null;
	let catalog = null;
	let failing = false;
	let timer;
	let stopped = false;
	/** The real binary and its environment, or null (the lane is unavailable, and says why). */
	const binary = async () => {
		simctl = (await ctx.tools.get()).simctl;
		if (simctl.state !== "ready" || !simctl.simctl) return null;
		return {
			file: simctl.simctl,
			env: ctx.childEnv(simctl.devDir ? { DEVELOPER_DIR: simctl.devDir } : {})
		};
	};
	const requireBinary = async () => {
		const bin = await binary();
		if (bin) return bin;
		throw new HelperError("DEVICE_NOT_FOUND", 404, "Simulators are unavailable right now.");
	};
	const json = async (bin, argv) => {
		const { stdout } = await ctx.runTool(bin.file, argv, {
			timeoutMs: timeouts.simctlList,
			env: bin.env,
			signal: ctx.signal
		});
		try {
			return JSON.parse(stdout);
		} catch {
			throw new HelperError("TOOL_FAILED", 502, "simctl printed something that is not JSON.");
		}
	};
	const unavailable = (reason) => {
		entries = [];
		ctx.publish("simulators", []);
		ctx.setLane("simulators", {
			status: "unavailable",
			booted: 0,
			reason
		});
	};
	/**
	 * Re-list (single-flight, under the lane's own signal: one caller leaving must not cancel
	 * the list another is waiting for). A failure keeps the rows as they are, so one slow
	 * simctl does not end every log stream, and says so once in the terminal.
	 */
	const list = (refreshCatalog = false) => flights.run(refreshCatalog ? "list+catalog" : "list", async () => {
		if (stopped) return;
		const bin = await binary();
		if (stopped) return;
		if (!bin) return unavailable(simctl ? simctlReason(simctl) : "simulators need Xcode");
		try {
			const stale = !catalog || refreshCatalog || ctx.now() - catalog.at > pace.catalogMs;
			const [devices, runtimes, devicetypes] = await Promise.all([
				json(bin, SIMCTL_COMMANDS[0]),
				stale ? json(bin, SIMCTL_COMMANDS[1]) : Promise.resolve(catalog?.runtimes),
				stale ? json(bin, SIMCTL_COMMANDS[2]) : Promise.resolve(catalog?.devicetypes)
			]);
			if (stale) catalog = {
				runtimes,
				devicetypes,
				at: ctx.now()
			};
			if (stopped) return;
			entries = simEntries(devices, runtimes, devicetypes);
			failing = false;
			ctx.publish("simulators", entries.map(simulatorRow));
			ctx.setLane("simulators", {
				status: "ok",
				booted: entries.filter((e) => e.state === "Booted").length,
				reason: void 0
			});
		} catch (error) {
			if (stopped || ctx.signal.aborted) return;
			if (error instanceof ToolError && error.reason === "not-found") return unavailable("simctl is missing from the selected Xcode");
			if (!failing) ctx.log(`simctl list failed: ${clean(errorText(error), 200)}`);
			failing = true;
		}
	});
	const entryOf = (id) => {
		const entry = entries.find((e) => e.udid === id);
		if (!entry) throw new HelperError("DEVICE_NOT_FOUND", 404, "The simulator is no longer there.");
		return entry;
	};
	/** Booted right now, by a fresh list: `io screenshot` on any other state hangs forever. */
	const requireBooted = async (id) => {
		await list();
		const entry = entryOf(id);
		if (entry.state !== "Booted") throw new HelperError("DEVICE_NOT_READY", 409, "The simulator is still booting.", {
			state: "connecting",
			blockers: []
		});
		return entry;
	};
	function schedule() {
		if (stopped) return;
		timer = setTimeout(() => {
			/** Only while a page is looking: an idle helper forks nothing. */
			(ctx.isActive() ? list() : Promise.resolve()).finally(schedule);
		}, pace.listMs);
		timer.unref();
	}
	return {
		name: "simulators",
		start() {
			list(true).finally(schedule);
		},
		async stop() {
			stopped = true;
			clearTimeout(timer);
			await Promise.resolve();
		},
		rescan: () => list(true),
		detail(id) {
			/** From the last list: the row is ready (the HTTP layer checked), so it is fresh enough. */
			return Promise.resolve().then(() => ({
				platform: "ios",
				kind: "simulator",
				facts: simFacts(entryOf(id))
			}));
		},
		async screenshot(id, signal) {
			const bin = await requireBinary();
			const entry = await requireBooted(id);
			return ctx.withTempDir(async (dir) => {
				/** Never `-`: simctl writes a file named `-` instead of stdout. */
				const file = path.join(dir, "shot.png");
				await ctx.runTool(bin.file, [
					"io",
					entry.udid,
					"screenshot",
					"--type=png",
					file
				], {
					timeoutMs: timeouts.simctlScreenshot,
					cwd: dir,
					env: bin.env,
					signal
				}).catch((error) => {
					throw simctlError(error);
				});
				const size = await stat(file).then((s) => s.size, () => -1);
				if (size < 0) throw new HelperError("TOOL_FAILED", 502, "simctl saved no screenshot.");
				if (size > LIMITS.png) throw new HelperError("TOOL_FAILED", 502, "The screenshot is larger than the helper accepts.");
				return {
					png: await readFile(file),
					source: "simctl"
				};
			});
		},
		async logs(id, sink, signal) {
			const bin = await requireBinary();
			const entry = entryOf(id);
			if (entry.state !== "Booted") throw new HelperError("DEVICE_NOT_READY", 409, "The simulator is still booting.", {
				state: "connecting",
				blockers: []
			});
			let said = false;
			let waiting = false;
			let silent = false;
			const handle = ctx.streamTool(bin.file, [
				"spawn",
				entry.udid,
				"log",
				"stream",
				"--style",
				"compact",
				"--level",
				"info"
			], {
				signal,
				env: bin.env,
				onLines(lines) {
					if (!said) {
						said = true;
						clearTimeout(firstByte);
						sink.hello("simctl");
					}
					const kept = lines.filter((line) => !LOG_HEADER.test(line));
					if (!kept.length || sink.push(kept) || waiting) return;
					/** Back-pressure: stop reading the tool until the page has taken what it has. */
					waiting = true;
					handle.pause();
					sink.drain().then(() => {
						waiting = false;
						handle.resume();
					});
				}
			});
			/** The header arrives at once; total silence means the stream never started. */
			const firstByte = setTimeout(() => {
				silent = true;
				handle.kill();
			}, timeouts.logFirstByte);
			let result;
			try {
				result = await handle.done;
			} finally {
				clearTimeout(firstByte);
			}
			if (signal.aborted) return;
			if (!said) {
				if (silent) throw new HelperError("LOGS_UNAVAILABLE", 503, "The simulator log did not start.");
				const known = simctlError(new ToolError("exit", bin.file, {
					code: result.code,
					stderr: result.stderr
				}));
				if (known instanceof HelperError) throw known;
				const why = clean(result.stderr.split("\n").filter((line) => line && !line.startsWith("getpwuid_r")).join(" "), 500);
				throw new HelperError("TOOL_FAILED", 502, why || "simctl could not start the log stream.");
			}
			/**
			 * The stream ended by itself: the simulator most likely shut down. Re-list now, so its
			 * row goes and the stream ends as `device-gone` rather than a plain `eof`.
			 */
			await list();
		},
		async retry() {
			await list();
		},
		facts: () => ({
			simctl: simctl?.simctl ?? null,
			booted: entries.filter((e) => e.state === "Booted").length
		})
	};
}

//#endregion
//#region src/mdns.ts
/**
 * §9 mDNS: a small one-shot DNS-SD browser (RFC 6762, RFC 6763), for finding the Android
 * devices on the local network (§4.8). No dependency: node:dgram, and a codec of its own.
 *
 * Why a codec here at all: a browser cannot see the network, and the adb server lists only
 * the devices it already knows, so "which TVs and phones on this Wi-Fi have debugging on"
 * needs someone to ask the network. A TV with Network debugging advertises `_adb._tcp`, a
 * phone with Wireless debugging `_adb-tls-connect._tcp` (and `_adb-tls-pairing._tcp` while
 * its pairing screen is open). Asking is read-only: queries, never an announcement, and
 * nothing here ever opens a connection to a device.
 *
 * How it asks, so it never competes with the system's own responder (mDNSResponder,
 * avahi) for port 5353: one UDP socket on an ephemeral port, queries sent to
 * 224.0.0.251:5353 on every IPv4 interface. RFC 6762 §6.7 calls that a legacy unicast query:
 * responders answer it straight to the asking port, with the query's id. The questions also
 * carry the QU bit (§5.4), which asks for a unicast answer where a responder would otherwise
 * multicast one. Answers whose id is 0 are taken too: a responder that multicasts anyway is
 * still answering.
 *
 * Everything that arrives is untrusted: every length, count and compression pointer is
 * checked against the packet before it is read (a pointer may only go backwards, and the
 * hops are counted), names are capped at 255 bytes and must be UTF-8, what is kept is
 * capped too, and nothing an answer carries can throw out of a socket event or a timer.
 *
 * The second half, systemBrowse(), asks the same question of the computer's own mDNS daemon
 * through its tool (dns-sd on macOS, avahi-browse on Linux): see "system resolver" below.
 */
const MDNS_ADDRESS = "224.0.0.251";
const MDNS_PORT = 5353;
/** The record types this browser reads; every other type is skipped by its length. */
const RR = {
	A: 1,
	PTR: 12,
	TXT: 16,
	AAAA: 28,
	SRV: 33
};
const CLASS_IN = 1;
/** A UDP payload larger than this is not an mDNS answer (RFC 6762 §17: 9000 bytes). */
const MAX_PACKET = 9e3;
/** Records read from one packet, whatever its counts claim. */
const MAX_RECORDS = 256;
/** Compression pointers followed in one name. */
const MAX_HOPS = 32;
/** Questions in one query packet, so a query stays far below 512 bytes. */
const MAX_QUESTIONS = 12;
/**
 * A name as text: labels joined by dots, a dot or a backslash inside a label escaped with a
 * backslash (RFC 6763 §4.3: an instance name may hold both, "Living Room TV v2.0"). Compared
 * case-insensitively, through nameKey().
 */
function joinName(labels) {
	return labels.map((label) => label.replace(/\\/g, "\\\\").replace(/\./g, "\\.")).join(".");
}
/** The labels of a name joinName() wrote. */
function splitName(name) {
	const labels = [];
	let label = "";
	for (let i = 0; i < name.length; i++) {
		const char = name[i];
		if (char === "\\" && i + 1 < name.length) label += name[++i];
		else if (char === ".") {
			labels.push(label);
			label = "";
		} else label += char;
	}
	if (label || labels.length) labels.push(label);
	return labels;
}
/** DNS names compare case-insensitively (ASCII). */
function nameKey(name) {
	return name.replace(/[A-Z]/g, (c) => c.toLowerCase());
}
/** The wire form of a name; throws for an empty label, a label over 63 bytes or a name over 255. */
function encodeName(name) {
	const parts = [];
	let total = 1;
	for (const label of splitName(name)) {
		const bytes = Buffer.from(label, "utf8");
		if (!bytes.length || bytes.length > 63) throw new Error(`Bad DNS label in ${name}.`);
		total += bytes.length + 1;
		parts.push(Buffer.from([bytes.length]), bytes);
	}
	if (total > 255) throw new Error(`DNS name too long: ${name}.`);
	parts.push(Buffer.from([0]));
	return Buffer.concat(parts);
}
/**
 * A name at `offset`, following compression pointers, or null when the packet is malformed:
 * a label or pointer past the end, a reserved label type, a pointer that does not go back
 * before every place this name was already read from (so no loop is possible), more than
 * 32 hops, or more than 255 bytes. `next` is where the record goes on after the name.
 *
 * A label must be UTF-8, as mDNS names are (RFC 6762 §16). Any other byte would read as
 * U+FFFD, three bytes where it was one, and encodeName() could not write the name back as
 * it came, or at all once a label passes 63 bytes (22 bytes of 0xFF come back as 66). So a
 * name this returns can always be asked about again: the follow-ups never meet one that
 * encodeName() refuses.
 */
function readName(buf, offset) {
	const labels = [];
	let pos = offset;
	let lowest = offset;
	let next = -1;
	let hops = 0;
	let length = 1;
	for (;;) {
		if (pos >= buf.length) return null;
		const byte = buf[pos] ?? 0;
		if ((byte & 192) === 192) {
			if (pos + 1 >= buf.length) return null;
			const target = (byte & 63) << 8 | (buf[pos + 1] ?? 0);
			if (target >= lowest || ++hops > MAX_HOPS) return null;
			if (next < 0) next = pos + 2;
			lowest = target;
			pos = target;
			continue;
		}
		if (byte & 192) return null;
		if (byte === 0) {
			if (next < 0) next = pos + 1;
			break;
		}
		const end = pos + 1 + byte;
		if (end > buf.length) return null;
		length += byte + 1;
		if (length > 255) return null;
		const label = buf.toString("utf8", pos + 1, end);
		if (!Buffer.from(label, "utf8").equals(buf.subarray(pos + 1, end))) return null;
		labels.push(label);
		pos = end;
	}
	return {
		name: joinName(labels),
		next
	};
}
const TYPE_NAMES = new Map(Object.entries(RR).map(([name, code]) => [code, name]));
/** An IPv6 address from 16 bytes, in its compressed text form (RFC 5952). */
function ipv6Text(bytes) {
	const groups = [];
	for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i));
	let best = -1;
	let bestLength = 1;
	for (let i = 0; i < 8;) {
		if (groups[i] !== 0) {
			i++;
			continue;
		}
		let j = i;
		while (j < 8 && groups[j] === 0) j++;
		if (j - i > bestLength) {
			best = i;
			bestLength = j - i;
		}
		i = j;
	}
	const hex = groups.map((g) => g.toString(16));
	if (best < 0) return hex.join(":");
	return `${hex.slice(0, best).join(":")}::${hex.slice(best + bestLength).join(":")}`;
}
/** One record's data, or null when it does not fit its length (the record is skipped). */
function readRdata(buf, type, start, end) {
	switch (type) {
		case "A": return end - start === 4 ? { address: [...buf.subarray(start, end)].join(".") } : null;
		case "AAAA": return end - start === 16 ? { address: ipv6Text(buf.subarray(start, end)) } : null;
		case "PTR": {
			const target = readName(buf, start);
			return target && target.next <= end ? { target: target.name } : null;
		}
		case "SRV": {
			if (end - start < 7) return null;
			const target = readName(buf, start + 6);
			if (!target || target.next > end) return null;
			return {
				priority: buf.readUInt16BE(start),
				weight: buf.readUInt16BE(start + 2),
				port: buf.readUInt16BE(start + 4),
				target: target.name
			};
		}
		case "TXT": {
			const strings = [];
			for (let pos = start; pos < end && strings.length < 64;) {
				const length = buf[pos] ?? 0;
				if (pos + 1 + length > end) return null;
				strings.push(buf.toString("utf8", pos + 1, pos + 1 + length));
				pos += 1 + length;
			}
			return { strings };
		}
	}
}
/**
 * A DNS message, or null when even its header or questions are malformed. Records are read
 * one by one, each bounds-checked; the first one that does not fit ends the reading, and
 * the records before it are kept. Only class IN; the cache-flush bit is ignored.
 */
function parseMessage(buf) {
	if (buf.length < 12 || buf.length > 9e3) return null;
	const id = buf.readUInt16BE(0);
	const flags = buf.readUInt16BE(2);
	/** Opcode 0 (QUERY) only, in a question or an answer. */
	if (flags & 30720) return null;
	const qdcount = buf.readUInt16BE(4);
	const rrcount = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
	const questions = [];
	let pos = 12;
	for (let i = 0; i < qdcount; i++) {
		const name = readName(buf, pos);
		if (!name || name.next + 4 > buf.length) return null;
		const type = TYPE_NAMES.get(buf.readUInt16BE(name.next));
		if (type && questions.length < 24) questions.push({
			name: name.name,
			type
		});
		pos = name.next + 4;
	}
	const records = [];
	for (let i = 0; i < Math.min(rrcount, MAX_RECORDS); i++) {
		const name = readName(buf, pos);
		if (!name || name.next + 10 > buf.length) break;
		const code = buf.readUInt16BE(name.next);
		const rrclass = buf.readUInt16BE(name.next + 2) & -32769;
		const ttl = buf.readUInt32BE(name.next + 4);
		const start = name.next + 10;
		const end = start + buf.readUInt16BE(name.next + 8);
		if (end > buf.length) break;
		pos = end;
		const type = TYPE_NAMES.get(code);
		if (!type || rrclass !== CLASS_IN) continue;
		const data = readRdata(buf, type, start, end);
		if (data) records.push({
			name: name.name,
			type,
			ttl,
			...data
		});
	}
	return {
		id,
		response: (flags & 32768) !== 0,
		questions,
		records
	};
}
/** A query: `id`, no flags, each question with the QU bit set (RFC 6762 §5.4). */
function encodeQuery(id, questions) {
	const header = Buffer.alloc(12);
	header.writeUInt16BE(id, 0);
	header.writeUInt16BE(questions.length, 4);
	const parts = [header];
	for (const question of questions) {
		const tail = Buffer.alloc(4);
		tail.writeUInt16BE(RR[question.type], 0);
		tail.writeUInt16BE(32769, 2);
		parts.push(encodeName(question.name), tail);
	}
	return Buffer.concat(parts);
}
/** Every non-internal IPv4 address of this computer: one query goes out on each. */
function ipv4Interfaces() {
	const out = [];
	for (const list of Object.values(os.networkInterfaces())) for (const entry of list ?? []) {
		/** Node 18.0–18.3 says 4 rather than 'IPv4'. */
		const family = entry.family;
		if ((family === "IPv4" || family === 4) && !entry.internal) out.push(entry.address);
	}
	return [...new Set(out)];
}
function errnoError(code, message) {
	return Object.assign(new Error(message), { code });
}
/**
 * Closes a dgram socket that may be half set up: one whose bind failed still holds its handle
 * (and keeps the process alive) until it is closed, and close() throws on one already closed.
 */
function closeSocket(socket) {
	try {
		socket.close();
	} catch {}
}
/**
 * The real transport: a udp4 socket on an ephemeral port (never 5353, which the system's
 * responder holds), TTL 255 as RFC 6762 §11 asks. A multicast query goes out once per
 * interface, waiting for each send before choosing the next interface; it fails only when it
 * left on none, with the first interface's error. With no interface at all it fails with
 * ENETDOWN: this computer is on no network. A socket whose bind fails is closed before the
 * open rejects.
 */
function udpTransport(o = {}) {
	const address = o.address ?? "224.0.0.251";
	const port = o.port ?? 5353;
	const multicast = /^2(?:2[4-9]|3\d)\./.test(address);
	return (onPacket) => new Promise((resolve, reject) => {
		const socket = dgram.createSocket({ type: "udp4" });
		let closed = false;
		socket.on("message", (packet, from) => {
			if (!closed && packet.length <= 9e3) onPacket(packet, from.address);
		});
		const unbound = (error) => {
			closed = true;
			closeSocket(socket);
			reject(error);
		};
		socket.once("error", unbound);
		const sendOnce = (packet) => new Promise((done, failed) => {
			socket.send(packet, port, address, (error) => error ? failed(error) : done());
		});
		socket.bind(0, () => {
			socket.off("error", unbound);
			/** From here on a socket error is a send that failed: send() reports it. */
			socket.on("error", () => void 0);
			if (multicast) socket.setMulticastTTL(255);
			resolve({
				async send(packet) {
					if (closed) return;
					if (!multicast) return sendOnce(packet);
					const interfaces = (o.interfaces ?? ipv4Interfaces)();
					if (!interfaces.length) throw errnoError("ENETDOWN", "no network interface has an IPv4 address");
					let first = null;
					let sent = 0;
					for (const local of interfaces) try {
						socket.setMulticastInterface(local);
						await sendOnce(packet);
						sent++;
					} catch (error) {
						first ??= error;
					}
					if (!sent) throw first;
				},
				close() {
					if (closed) return;
					closed = true;
					closeSocket(socket);
				}
			});
		});
	});
}
function mdnsFailure(error) {
	const code = String(error?.code ?? "");
	return {
		reason: [
			"EHOSTUNREACH",
			"EPERM",
			"EACCES"
		].includes(code) ? "blocked" : [
			"ENETDOWN",
			"ENETUNREACH",
			"EADDRNOTAVAIL"
		].includes(code) ? "no-network" : "failed",
		code,
		detail: clean(errorText(error), 200)
	};
}
/** Caps on what one browse keeps, whatever the network sends. */
const KEEP$1 = {
	instances: 256,
	names: 512,
	addresses: 8,
	txt: 32,
	sources: 8
};
/** `list` in pieces of at most `size`; an empty list is one empty piece. */
function inPieces(list, size) {
	const pieces = [];
	for (let i = 0; i === 0 || i < list.length; i += size) pieces.push(list.slice(i, i + size));
	return pieces;
}
/**
 * One browse: PTR questions for `services` (12 to a packet), sent again halfway through the
 * window; as answers arrive, SRV and TXT questions for instances whose SRV is missing, and A
 * and AAAA questions for SRV targets without an address, each name asked once. After
 * `windowMs` the socket is closed and what was learnt is returned. A record with TTL 0 (a
 * goodbye) removes what it names. A signal that has aborted before the socket opens, or while
 * it opens, ends the browse with nothing sent.
 */
async function browse(o) {
	const wanted = new Map(o.services.map((service) => [nameKey(service), service]));
	/** service key → instance name key → instance name */
	const pointers = new Map();
	const srv = new Map();
	const txt = new Map();
	const addresses = new Map();
	/** host name key → the address a packet came from → the addresses it gave for the name */
	const sourced = new Map();
	/** instance name key → the addresses that came with its SRV, and where the SRV came from */
	const bound = new Map();
	const asked = new Set();
	const id = 1 + Math.floor(Math.random() * 65534);
	let transport = null;
	let followTimer;
	let done = false;
	const remember = (map, key, value) => {
		if (map.has(key) || map.size < KEEP$1.names) map.set(key, value);
	};
	/** `list` with `address` added (within the cap) or, for a goodbye, removed. */
	const withAddress = (list, address, gone) => gone ? list.filter((a) => a !== address) : list.includes(address) || list.length >= KEEP$1.addresses ? list : [...list, address];
	const take = (record, from) => {
		const key = nameKey(record.name);
		const gone = record.ttl === 0;
		switch (record.type) {
			case "PTR": {
				const service = wanted.get(key);
				const labels = splitName(record.target);
				/** Only `<one label>.<the service browsed>`. */
				if (!service || labels.length < 2 || !labels[0]) return;
				if (nameKey(joinName(labels.slice(1))) !== key) return;
				let set = pointers.get(key);
				if (!set) pointers.set(key, set = new Map());
				const target = nameKey(record.target);
				if (gone) set.delete(target);
				else if (set.has(target) || set.size < KEEP$1.instances) set.set(target, record.target);
				return;
			}
			case "SRV": {
				if (gone) {
					srv.delete(key);
					bound.delete(key);
					return;
				}
				const known = srv.get(key);
				/** Lowest priority wins (RFC 2782); a device lists one anyway. */
				if (known && known.priority < record.priority) return;
				remember(srv, key, {
					target: record.target,
					port: record.port,
					priority: record.priority
				});
				return;
			}
			case "TXT":
				if (gone) return void txt.delete(key);
				remember(txt, key, record.strings.slice(0, KEEP$1.txt));
				return;
			case "A":
			case "AAAA": {
				const next = withAddress(addresses.get(key) ?? [], record.address, gone);
				if (next.length) remember(addresses, key, next);
				else addresses.delete(key);
				if (from === void 0) return;
				let bySource = sourced.get(key);
				if (!bySource) {
					if (gone || sourced.size >= KEEP$1.names) return;
					sourced.set(key, bySource = new Map());
				}
				const mine = withAddress(bySource.get(from) ?? [], record.address, gone);
				if (mine.length && (bySource.has(from) || bySource.size < KEEP$1.sources)) bySource.set(from, mine);
				else if (!mine.length) bySource.delete(from);
				return;
			}
		}
	};
	/**
	 * SRV and TXT for instances without an SRV, A and AAAA for targets without an address. It
	 * runs in a timer, where a throw would stop the helper, so a packet that cannot be written
	 * or sent is dropped (readName() returns no name encodeName() would refuse).
	 */
	const followUp = () => {
		if (done || !transport) return;
		const questions = [];
		const ask = (name, type) => {
			const tag = `${type} ${nameKey(name)}`;
			if (asked.has(tag) || asked.size >= KEEP$1.names) return;
			asked.add(tag);
			questions.push({
				name,
				type
			});
		};
		for (const set of pointers.values()) for (const [key, name] of set) {
			const record = srv.get(key);
			if (!record) {
				ask(name, "SRV");
				if (!txt.has(key)) ask(name, "TXT");
			} else if (!addresses.has(nameKey(record.target))) {
				ask(record.target, "A");
				ask(record.target, "AAAA");
			}
		}
		for (let i = 0; i < questions.length; i += MAX_QUESTIONS) try {
			const packet = encodeQuery(id, questions.slice(i, i + MAX_QUESTIONS));
			transport.send(packet).catch(() => void 0);
		} catch {}
	};
	/**
	 * Ties each SRV in a packet to the addresses that came with it: the A and AAAA records for
	 * its target in the same packet, and the address the packet came from. Two devices may both
	 * call themselves `Android.local`; their answers are still two packets.
	 */
	const bind = (records, from) => {
		const here = new Map();
		for (const r of records) {
			if (r.type !== "A" && r.type !== "AAAA" || r.ttl === 0) continue;
			const key = nameKey(r.name);
			here.set(key, withAddress(here.get(key) ?? [], r.address, false));
		}
		for (const r of records) {
			if (r.type !== "SRV" || r.ttl === 0) continue;
			const key = nameKey(r.name);
			const kept = srv.get(key);
			/** Only the SRV take() kept (the lowest priority). */
			if (!kept || nameKey(kept.target) !== nameKey(r.target) || kept.port !== r.port) continue;
			const known = bound.get(key);
			const came = here.get(nameKey(r.target)) ?? [];
			/** Addresses that came with the SRV win over a later packet that brought none. */
			const next = came.length ? {
				addresses: came,
				from
			} : {
				addresses: known?.addresses ?? [],
				from: known?.from ?? from
			};
			if (bound.has(key) || bound.size < KEEP$1.names) bound.set(key, next);
		}
	};
	/** An instance's addresses, by what ties them to it (ServiceInstance.addresses). */
	const addressesOf = (key, target) => {
		const tied = bound.get(key);
		if (tied?.addresses.length) return tied.addresses;
		if (tied?.from !== void 0) return sourced.get(nameKey(target))?.get(tied.from) ?? [tied.from];
		return addresses.get(nameKey(target)) ?? [];
	};
	/**
	 * Every answer, from the transport's message event, where a throw would stop the helper: a
	 * packet that makes anything here throw is dropped, as a malformed one is.
	 */
	const onPacket = (packet, from) => {
		if (done) return;
		try {
			const message = parseMessage(packet);
			/** Ours (legacy unicast echoes the id) or a multicast answer (id 0). */
			if (!message?.response || message.id !== id && message.id !== 0) return;
			for (const record of message.records) take(record, from);
			bind(message.records, from);
		} catch {
			return;
		}
		clearTimeout(followTimer);
		followTimer = setTimeout(followUp, 30);
	};
	/** Written before the socket opens: a type encodeName() refuses throws with nothing open. */
	const browseQueries = inPieces(o.services, MAX_QUESTIONS).map((names) => encodeQuery(id, names.map((name) => ({
		name,
		type: "PTR"
	}))));
	/** Each piece once; the first one's error is the browse's (the rest leave the same way). */
	const ask = async () => {
		const [first, ...rest] = browseQueries;
		if (first) await transport?.send(first);
		for (const packet of rest) try {
			transport?.send(packet).catch(() => void 0);
		} catch {}
	};
	if (o.signal?.aborted) return { instances: [] };
	try {
		transport = await o.open(onPacket);
	} catch (error) {
		return {
			instances: [],
			failure: mdnsFailure(error)
		};
	}
	/** Shutdown while the socket opened: nothing is sent. */
	if (o.signal?.aborted) {
		done = true;
		transport.close();
		return { instances: [] };
	}
	const window = linkSignals([o.signal]);
	try {
		try {
			await ask();
		} catch (error) {
			return {
				instances: [],
				failure: mdnsFailure(error)
			};
		}
		const half = Math.floor(o.windowMs / 2);
		await sleep(half, window.signal).catch(() => void 0);
		if (!window.signal.aborted) {
			ask().catch(() => void 0);
			await sleep(o.windowMs - half, window.signal).catch(() => void 0);
		}
	} finally {
		done = true;
		clearTimeout(followTimer);
		window.dispose();
		transport.close();
	}
	const instances = [];
	const max = o.max ?? KEEP$1.instances;
	for (const [serviceKey, service] of wanted) for (const [key, name] of pointers.get(serviceKey) ?? []) {
		if (instances.length >= max) break;
		const record = srv.get(key);
		const found = record ? addressesOf(key, record.target) : [];
		const from = record ? bound.get(key)?.from : void 0;
		instances.push({
			service,
			instance: splitName(name)[0] ?? "",
			target: record?.target ?? null,
			port: record?.port ?? null,
			addresses: [...found.filter((a) => !a.includes(":")), ...found.filter((a) => a.includes(":"))],
			txt: txt.get(key) ?? [],
			...from !== void 0 ? { from } : {}
		});
	}
	return { instances };
}
/** RFC 6763 §9: asking this name lists every service type on the network. */
const SERVICE_TYPES_NAME = "_services._dns-sd._udp.local";
/** A service type as the tools take it (RFC 6763 §7): `_ipp._tcp`, at most 63 bytes a label. */
const SERVICE_TYPE = /^_[A-Za-z0-9][A-Za-z0-9_-]{0,61}\._(?:tcp|udp)$/;
/** Types one look asks about, at most, besides the fixed ones. */
const MAX_SERVICE_TYPES = 48;
/**
 * `_ipp._tcp` from what a device or a tool said (`_ipp._tcp.local.` and the like), or null
 * when it is not a service type the helper asks about. One whose label holds 12 hex digits in
 * a row is refused too: that is how a hardware address reads (`_FC9F5ED42C8A._tcp` was on
 * the owner's network), and a type is passed on to the page as it is.
 */
function serviceType(text) {
	const type = text.trim().replace(/\.$/, "").replace(/\.local$/i, "");
	return SERVICE_TYPE.test(type) && !/[0-9A-Fa-f]{12}/.test(type) ? type : null;
}
/**
 * The service types the network lists (§4.9): one PTR question for `_services._dns-sd._udp`
 * from the helper's own socket, sent again halfway through the window, the same way browse()
 * asks (legacy unicast, the QU bit, id 0 taken). Only a PTR to `<type>.local` with a valid
 * type counts; nothing is asked next, and nothing an answer carries can throw.
 */
async function browseServiceTypes(o) {
	const id = 1 + Math.floor(Math.random() * 65534);
	const max = o.max ?? 48;
	const types = new Map();
	const meta = nameKey(SERVICE_TYPES_NAME);
	let done = false;
	const onPacket = (packet) => {
		if (done) return;
		try {
			const message = parseMessage(packet);
			if (!message?.response || message.id !== id && message.id !== 0) return;
			for (const record of message.records) {
				if (record.type !== "PTR" || record.ttl === 0 || nameKey(record.name) !== meta) continue;
				const labels = splitName(record.target);
				if (labels.length !== 3 || nameKey(labels[2] ?? "") !== "local") continue;
				const type = serviceType(`${labels[0] ?? ""}.${labels[1] ?? ""}`);
				if (type && (types.has(nameKey(type)) || types.size < max)) types.set(nameKey(type), type);
			}
		} catch {
			return;
		}
	};
	const query = encodeQuery(id, [{
		name: SERVICE_TYPES_NAME,
		type: "PTR"
	}]);
	if (o.signal?.aborted) return { types: [] };
	let transport;
	try {
		transport = await o.open(onPacket);
	} catch (error) {
		return {
			types: [],
			failure: mdnsFailure(error)
		};
	}
	if (o.signal?.aborted) {
		done = true;
		transport.close();
		return { types: [] };
	}
	const window = linkSignals([o.signal]);
	try {
		try {
			await transport.send(query);
		} catch (error) {
			return {
				types: [],
				failure: mdnsFailure(error)
			};
		}
		const half = Math.floor(o.windowMs / 2);
		await sleep(half, window.signal).catch(() => void 0);
		if (!window.signal.aborted) {
			try {
				transport.send(query).catch(() => void 0);
			} catch {}
			await sleep(o.windowMs - half, window.signal).catch(() => void 0);
		}
	} finally {
		done = true;
		window.dispose();
		transport.close();
	}
	return { types: [...types.values()] };
}
/** Caps on what one run keeps, whatever the tools print (instances: per group). */
const SYSTEM_KEEP = {
	instances: 128,
	txt: 32,
	addresses: 8
};
/** The service types that advertise adb itself; the others only name an address. */
const ADB_TYPES$1 = new Set([
	"_adb._tcp",
	"_adb-tls-connect._tcp",
	"_adb-tls-pairing._tcp"
]);
/**
 * How many of `concurrency` slots the name-only services' resolves may hold at once: one in
 * four (one of the default four), at least one. macOS keeps listing a Cast or TV Remote service
 * whose device went to sleep, and its `-L` then never answers: each such entry holds its slot
 * for the whole resolve deadline, so these must never take the slots the adb devices need.
 */
function nameSlots(concurrency) {
	return Math.max(1, Math.floor(concurrency / 4));
}
/**
 * A limiter with two queues: `first` tasks (adb resolves, address lookups) always run before
 * queued `names` tasks, and at most `nameCap` `names` tasks run at once. FIFO within a queue.
 */
function priorityLimiter(n, nameCap) {
	let active = 0;
	let activeNames = 0;
	const queues = {
		first: [],
		names: []
	};
	const next = () => {
		while (active < n) {
			const priority = queues.first.length ? "first" : queues.names.length && activeNames < nameCap ? "names" : null;
			if (!priority) return;
			const run = queues[priority].shift();
			if (!run) return;
			active++;
			if (priority === "names") activeNames++;
			run();
		}
	};
	return (priority, fn) => new Promise((resolve, reject) => {
		queues[priority].push(() => {
			Promise.resolve().then(fn).then(resolve, reject).finally(() => {
				active--;
				if (priority === "names") activeNames--;
				next();
			});
		});
		next();
	});
}
/** After a resolve's answer, how long its TXT line (or a second address) may take. */
const AFTER_ANSWER_MS = 150;
function isExecutable(file) {
	try {
		accessSync(file, constants.X_OK);
		return statSync(file).isFile();
	} catch {
		return false;
	}
}
/**
 * One of avahi-utils' tools: at `given` when that is set (absolute and executable, or none),
 * else the first absolute PATH entry or extra directory (/usr/bin, /usr/local/bin unless
 * `extraDirs` says otherwise) that has it.
 */
function avahiTool(name, given, o) {
	if (given !== void 0) return path.isAbsolute(given) && isExecutable(given) ? given : null;
	const dirs = [...o.searchPath.split(path.delimiter), ...o.extraDirs ?? ["/usr/bin", "/usr/local/bin"]];
	for (const dir of dirs) {
		if (!dir || !path.isAbsolute(dir)) continue;
		const file = path.join(dir, name);
		if (isExecutable(file)) return file;
	}
	return null;
}
/**
 * The tools to ask on `platform`: dns-sd at its fixed path on macOS (never looked up: a
 * planted `dns-sd` on PATH must not run), avahi-browse on Linux from `avahiBrowsePath` or,
 * when that is undefined, the first absolute PATH entry or extra directory that has it.
 */
function systemMdnsTools(o) {
	if (o.platform === "darwin") return {
		dnsSd: path.isAbsolute(o.dnsSdPath) && isExecutable(o.dnsSdPath) ? o.dnsSdPath : null,
		avahiBrowse: null
	};
	if (o.platform !== "linux") return {
		dnsSd: null,
		avahiBrowse: null
	};
	return {
		dnsSd: null,
		avahiBrowse: avahiTool("avahi-browse", o.avahiBrowsePath, o)
	};
}
function reverseTools(o) {
	if (o.platform === "darwin") return {
		dnsSd: path.isAbsolute(o.dnsSdPath) && isExecutable(o.dnsSdPath) ? o.dnsSdPath : null,
		avahiResolve: null
	};
	if (o.platform !== "linux") return {
		dnsSd: null,
		avahiResolve: null
	};
	return {
		dnsSd: null,
		avahiResolve: avahiTool("avahi-resolve", o.avahiResolvePath, o)
	};
}
/**
 * A name in DNS presentation form (`SONY\032KD-43X8050H._androidtvremote2._tcp.local.`, as
 * dns-sd -L and avahi-browse print them) as labels: `\DDD` is the byte DDD (decimal), `\X`
 * is X, and raw bytes above 0x7F are UTF-8. Null for a malformed escape.
 */
function presentationLabels(text) {
	const labels = [];
	let bytes = [];
	const raw = Buffer.from(text, "utf8");
	for (let i = 0; i < raw.length; i++) {
		const byte = raw[i] ?? 0;
		if (byte === 92) {
			const digits = raw.toString("latin1", i + 1, i + 4);
			if (/^\d{3}$/.test(digits)) {
				const value = Number(digits);
				if (value > 255) return null;
				bytes.push(value);
				i += 3;
			} else if (i + 1 < raw.length) bytes.push(raw[++i] ?? 0);
			else return null;
		} else if (byte === 46) {
			labels.push(Buffer.from(bytes).toString("utf8"));
			bytes = [];
		} else bytes.push(byte);
	}
	if (bytes.length || !labels.length) labels.push(Buffer.from(bytes).toString("utf8"));
	/** `name.local.` ends with an empty root label. */
	if (labels.length > 1 && labels[labels.length - 1] === "") labels.pop();
	return labels;
}
/**
 * dns-sd's TXT line (ShowTXTRecord): a space before each string, shell metacharacters and
 * spaces escaped with one backslash, a backslash written as four, and bytes below 0x20 as
 * `\\xHH`. ` given_name=BAULOC\ Pixel\ 9 serial=55090DLAQ0026D` → two strings.
 */
function parseDnsSdTxt(line) {
	const out = [];
	let current = null;
	for (let i = 0; i < line.length; i++) {
		const char = line[i] ?? "";
		if (char === " ") {
			if (current !== null) out.push(current);
			current = null;
			continue;
		}
		current ??= "";
		if (char !== "\\") {
			current += char;
			continue;
		}
		if (line.startsWith("\\\\\\\\", i)) {
			current += "\\";
			i += 3;
		} else if (/^\\\\x[0-9A-Fa-f]{2}/.test(line.slice(i, i + 5))) {
			current += String.fromCharCode(parseInt(line.slice(i + 3, i + 5), 16));
			i += 4;
		} else if (i + 1 < line.length) current += line[++i] ?? "";
	}
	if (current !== null) out.push(current);
	return out.slice(0, SYSTEM_KEEP.txt);
}
/**
 * avahi-browse's TXT field (avahi_string_list_to_string): each string in double quotes,
 * separated by spaces, `"` and `\` escaped with a backslash, other bytes as `\DDD`.
 */
function parseAvahiTxt(field) {
	const out = [];
	let i = 0;
	while (i < field.length && out.length < SYSTEM_KEEP.txt) {
		if (field[i] !== "\"") {
			i++;
			continue;
		}
		const bytes = [];
		i++;
		let closed = false;
		while (i < field.length) {
			const char = field[i] ?? "";
			if (char === "\"") {
				closed = true;
				i++;
				break;
			}
			if (char === "\\" && /^\d{3}$/.test(field.slice(i + 1, i + 4))) {
				bytes.push(Number(field.slice(i + 1, i + 4)) & 255);
				i += 4;
				continue;
			}
			if (char === "\\" && i + 1 < field.length) i++;
			bytes.push(...Buffer.from(field[i] ?? "", "utf8"));
			i++;
		}
		if (!closed) break;
		out.push(Buffer.from(bytes).toString("utf8"));
	}
	return out;
}
/** `_adb._tcp.local` → `_adb._tcp`, lower case: how the tools write a type. */
function bareType(service) {
	return service.trim().toLowerCase().replace(/\.$/, "").replace(/\.local$/, "");
}
const sameName = (a, b) => a.toLowerCase().replace(/\.$/, "") === b.toLowerCase().replace(/\.$/, "");
/** An instance label the tools may be asked about: 1–63 bytes, not an option. */
function usableInstance(instance) {
	const bytes = Buffer.byteLength(instance, "utf8");
	return bytes >= 1 && bytes <= 63 && !instance.startsWith("-");
}
/** A host to look up: a `.local` name in presentation form, no spaces, not an option. */
function usableHost(host) {
	return host.length <= 1009 && /^[^\s-][^\s]*\.local\.?$/i.test(host);
}
/** `HH:MM:SS.mmm  Add  2  14 local.  _adb._tcp.  adb-b120be004010859` (dns-sd -B). */
const BROWSE_LINE = /^\d{1,2}:\d{2}:\d{2}\.\d{3}\s+(Add|Rmv)\s+[0-9A-Fa-f]+\s+-?\d+\s+(\S+)\s+(\S+)\s+(.+)$/;
function parseDnsSdBrowseLine(line) {
	const m = BROWSE_LINE.exec(line);
	if (!m?.[1] || !m[2] || !m[3] || !m[4]) return null;
	return {
		op: m[1],
		domain: m[2],
		type: m[3],
		instance: m[4].trimEnd()
	};
}
/**
 * `HH:MM:SS.mmm  <full name> can be reached at <host>:<port> (interface 14)` (dns-sd -L),
 * optionally followed by ` Flags: 1`. The full name is in presentation form, so a space in
 * it is `\032` and the phrase cannot occur inside it.
 */
const REACHED_LINE = /^(?:\d{1,2}:\d{2}:\d{2}\.\d{3}\s+)?(\S.*?) can be reached at (\S+):(\d{1,5})(?: \(interface -?\d+\))?(?: Flags: [0-9A-Fa-f]+)?\s*$/;
function parseDnsSdReached(line) {
	const m = REACHED_LINE.exec(line);
	if (!m?.[1] || !m[2] || !m[3]) return null;
	const labels = presentationLabels(m[1]);
	const port = Number(m[3]);
	if (!labels?.[0] || port < 1 || port > 65535) return null;
	return {
		instance: labels[0],
		host: m[2],
		port
	};
}
/** `HH:MM:SS.mmm  Add  40000002  14  Android_GWZJSA15.local.  192.168.68.114  120` (dns-sd -G). */
const ADDRESS_LINE = /^\d{1,2}:\d{2}:\d{2}\.\d{3}\s+(Add|Rmv)\s+[0-9A-Fa-f]+\s+-?\d+\s+(\S+)\s+(\S+)(?:\s+\d+)?\s*$/;
function parseDnsSdAddressLine(line) {
	const m = ADDRESS_LINE.exec(line);
	if (!m?.[1] || !m[2] || !m[3] || !net.isIPv4(m[3])) return null;
	return {
		op: m[1],
		host: m[2],
		address: m[3]
	};
}
/**
 * One `avahi-browse -p` line for `type`: `+;eth0;IPv4;<name>;<type>;local`, the same with
 * `-`, or `=;…;local;<host>;<address>;<port>;<txt>` once resolved. The name may hold a `;`
 * (only `.`, `\` and control bytes are escaped), so the fields after it are found from the
 * type, which is known.
 */
function parseAvahiLine(line, type) {
	const op = line[0];
	if (op !== "+" && op !== "-" && op !== "=" || line[1] !== ";") return null;
	const second = line.indexOf(";", 2);
	const third = second < 0 ? -1 : line.indexOf(";", second + 1);
	if (third < 0) return null;
	const protocol = line.slice(second + 1, third);
	/**
	 * Found as text, never as a pattern (a type holding `(` or `+` would be one), and in ASCII
	 * case only, as DNS compares names: nameKey() keeps the line's length, so positions in it
	 * stay valid.
	 */
	const marker = `;${nameKey(type)};local`;
	const at = nameKey(line).indexOf(marker, third);
	if (at < 0) return null;
	const labels = presentationLabels(line.slice(third + 1, at));
	const instance = labels?.length === 1 ? labels[0] : void 0;
	if (!instance) return null;
	const rest = line.slice(at + marker.length);
	if (op !== "=") return rest === "" ? {
		op,
		protocol,
		instance,
		type
	} : null;
	const m = /^;([^;]*);([^;]*);(\d{1,5});(.*)$/.exec(rest);
	if (!m?.[1] || !m[2] || !m[3]) return null;
	const port = Number(m[3]);
	if (port < 1 || port > 65535) return null;
	return {
		op,
		protocol,
		instance,
		type,
		host: m[1],
		address: m[2],
		port,
		txt: parseAvahiTxt(m[4] ?? "")
	};
}
/**
 * A `dns-sd -B _services._dns-sd._udp local.` line, as the type it lists, or null:
 * `22:56:04.523  Add  3  14 .  _tcp.local.  _ipp` → `_ipp._tcp`. The daemon lists each
 * type once per interface; this computer's own (lo0) are among them.
 */
function parseDnsSdTypeLine(line) {
	const entry = parseDnsSdBrowseLine(line);
	if (entry?.op !== "Add" || entry.domain !== ".") return null;
	const proto = /^(_(?:tcp|udp))\.local\.?$/i.exec(entry.type)?.[1];
	return proto ? serviceType(`${entry.instance}.${proto}`) : null;
}
/** One record of `dns-sd -Z <type> local.`: `<owner>  PTR|SRV|TXT  <data>`, names relative to `local.`. */
const ZONE_LINE = /^(\S+)\s+(PTR|SRV|TXT)(?:\s+(.*))?$/;
/** An SRV's data: priority and weight (dns-sd prints 0 0), the port, the host, then a comment. */
const ZONE_SRV = /^\d{1,5}\s+\d{1,5}\s+(\d{1,5})\s+(\S+)(?:\s+;.*)?$/;
/** `<instance>.<type>` in presentation form, `.local` optional, as the instance, or null. */
function zoneInstance(name, type) {
	const labels = presentationLabels(name);
	if (labels && nameKey(labels[labels.length - 1] ?? "") === "local") labels.pop();
	if (labels?.length !== 3 || !labels[0]) return null;
	return sameName(`${labels[1] ?? ""}.${labels[2] ?? ""}`, type) ? labels[0] : null;
}
/**
 * One line of `dns-sd -Z <type> local.` (dns-sd's zone-file listing of a type: the PTR, SRV
 * and TXT of every instance, without addresses) for `type`, or null:
 *
 *   _ipp._tcp  PTR  HP\032Neverstop\032Laser._ipp._tcp
 *   HP\032Neverstop\032Laser._ipp._tcp  SRV  0 0 631 NPIF25F81.local. ; Replace with unicast FQDN of target host
 *   HP\032Neverstop\032Laser._ipp._tcp  TXT  "txtvers=1" "ty=HP Neverstop Laser MFP 120x"
 *
 * Owners are in presentation form (`\032`, `\.`, raw UTF-8); TXT strings are double-quoted
 * with `\"` and `\\` escaped, as avahi writes them. The `lb._dns-sd._udp PTR @` line, the
 * comments and the headers do not match.
 */
function parseDnsSdZoneLine(line, type) {
	const m = ZONE_LINE.exec(line);
	if (!m?.[1] || !m[2]) return null;
	const rr = m[2];
	const data = (m[3] ?? "").trim();
	if (rr === "PTR") {
		if (nameKey(serviceType(m[1]) ?? "") !== nameKey(type)) return null;
		const instance = zoneInstance(data, type);
		return instance ? {
			instance,
			type: rr
		} : null;
	}
	const instance = zoneInstance(m[1], type);
	if (!instance) return null;
	if (rr === "TXT") return {
		instance,
		type: rr,
		txt: parseAvahiTxt(data)
	};
	const srv = ZONE_SRV.exec(data);
	const port = Number(srv?.[1]);
	if (!srv?.[2] || port < 1 || port > 65535) return null;
	return {
		instance,
		type: rr,
		host: srv[2],
		port
	};
}
/**
 * `HH:MM:SS.mmm  Add  40000002  14  113.68.168.192.in-addr.arpa.  PTR  IN  BAULOCs-MacBook-Pro.local.`
 * (dns-sd -q): the name asked and its answer. A negative answer prints `0.0.0.0` and then
 * `No Such Record`.
 */
const QUERY_LINE = /^\d{1,2}:\d{2}:\d{2}\.\d{3}\s+(Add|Rmv)\s+[0-9A-Fa-f]+\s+(?:\S\s+)?-?\d+\s+(\S+)\s+PTR\s+IN\s+(\S+)(\s+No Such Record)?\s*$/;
function parseDnsSdQueryLine(line) {
	const m = QUERY_LINE.exec(line);
	if (!m?.[1] || !m[2] || !m[3]) return null;
	return {
		op: m[1],
		name: m[2],
		answer: m[4] ? null : m[3]
	};
}
/**
 * The type of an `avahi-browse -a -p` browse line (`+;eth0;IPv4;<name>;_ipp._tcp;local`, or
 * `-`), from its last two fields, which cannot hold a `;`; null for anything else.
 */
function avahiLineType(line) {
	if (line[0] !== "+" && line[0] !== "-" || line[1] !== ";") return null;
	const fields = line.split(";");
	if (fields.length < 6 || fields[fields.length - 1] !== "local") return null;
	return serviceType(fields[fields.length - 2] ?? "");
}
/** `avahi-resolve -a <address>`: `<address>\t<host>` for the address asked, or null. */
function parseAvahiResolveLine(line, address) {
	const m = /^(\S+)\t(\S+)$/.exec(line.trim());
	return m?.[1] === address && m[2] && usableHost(m[2]) ? m[2] : null;
}
/**
 * How long a dns-sd or avahi-browse that ignores SIGTERM may linger before SIGKILL. collect()
 * does not wait for it: the run's deadline holds whatever the process does with the signal.
 */
const SYSTEM_KILL_GRACE_MS = 250;
/**
 * Run `file argv` until `finish()` (called from `onLine`), `ms`, or `signal`; every stdout
 * line goes to `onLine` as it arrives. Never rejects.
 *
 * Returns as soon as it ends the process, without waiting for it to exit: a tool that ignores
 * SIGTERM must not hold a resolve slot, or the whole run, past its deadline. The runner still
 * SIGKILLs the group `SYSTEM_KILL_GRACE_MS` later, and tracks it for shutdown meanwhile.
 */
async function collect(streamTool, file, argv, ms, signal, onLine) {
	if (signal.aborted) return {
		stopped: true,
		code: null,
		stderr: ""
	};
	let finished = false;
	let kill = () => void 0;
	let ended = () => void 0;
	const stoppedByUs = new Promise((resolve) => {
		ended = () => resolve({
			stopped: true,
			code: null,
			stderr: ""
		});
	});
	const finish = () => {
		if (finished) return;
		finished = true;
		kill();
		ended();
	};
	const handle = streamTool(file, argv, {
		signal,
		killGraceMs: SYSTEM_KILL_GRACE_MS,
		onLines: (lines) => {
			for (const line of lines) {
				if (finished) return;
				onLine(line, finish);
			}
		}
	});
	kill = handle.kill;
	if (finished) handle.kill();
	const timer = setTimeout(finish, ms);
	signal.addEventListener("abort", finish, { once: true });
	const exited = handle.done.then((result) => ({
		stopped: result.stopped || finished,
		code: result.code,
		stderr: result.stderr
	}), (error) => ({
		stopped: false,
		code: null,
		stderr: "",
		error
	}));
	try {
		return await Promise.race([exited, stoppedByUs]);
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", finish);
	}
}
/** Why a tool could not look, in one line. */
function whyNot(tool, run) {
	if (run.error instanceof ToolError) return `${tool}: ${run.error.reason}`;
	if (run.error) return clean(`${tool}: ${errorText(run.error)}`, 200);
	const said = run.stderr.split("\n").map((line) => line.trim()).find(Boolean);
	return clean(`${tool} exited with code ${String(run.code)}${said ? `: ${said}` : ""}`, 200);
}
/** In the order of `services`, then as found: the same answer whatever process spoke first. */
function inServiceOrder(instances, services) {
	const rank = (i) => services.indexOf(i.service);
	return instances.map((instance, index) => ({
		instance,
		index
	})).sort((a, b) => rank(a.instance) - rank(b.instance) || a.index - b.index).map(({ instance }) => instance);
}
/**
 * Instances whose host another instance of the SAME service type also points at lose their
 * addresses: adbd calls itself `Android.local` on many devices at once, and a lookup of that
 * name answers with whichever device spoke first. The helper's own browser (browse()) ties
 * addresses to the packet that carried them and still finds those devices.
 */
function dropSharedHosts(instances) {
	const users = new Map();
	for (const i of instances) {
		if (!i.target) continue;
		const key = `${i.service.toLowerCase()}|${i.target.toLowerCase().replace(/\.$/, "")}`;
		const set = users.get(key) ?? new Set();
		set.add(i.instance.toLowerCase());
		users.set(key, set);
	}
	const shared = new Set();
	for (const [key, set] of users) if (set.size > 1) shared.add(key.slice(key.indexOf("|") + 1));
	return instances.map((i) => i.target && shared.has(i.target.toLowerCase().replace(/\.$/, "")) ? {
		...i,
		addresses: []
	} : i);
}
/**
 * `dns-sd -G v4 <host>`: its IPv4 addresses, once per host per run, each lookup in a `slot`
 * of the run's limiter and ended `AFTER_ANSWER_MS` after its first address (or `resolveMs`).
 */
function addressLookups(o, file, signal, slot) {
	const lookups = new Map();
	return (host) => {
		const key = host.toLowerCase().replace(/\.$/, "");
		let promise = lookups.get(key);
		if (!promise) {
			promise = slot(async () => {
				const addresses = [];
				let grace;
				await collect(o.streamTool, file, [
					"-G",
					"v4",
					host
				], o.resolveMs, signal, (line, finish) => {
					const answer = parseDnsSdAddressLine(line);
					if (!answer || !sameName(answer.host, host)) return;
					if (answer.op === "Rmv") {
						const at = addresses.indexOf(answer.address);
						if (at >= 0) addresses.splice(at, 1);
						return;
					}
					if (!addresses.includes(answer.address) && addresses.length < SYSTEM_KEEP.addresses) addresses.push(answer.address);
					grace ??= setTimeout(finish, AFTER_ANSWER_MS);
				});
				clearTimeout(grace);
				return addresses;
			});
			lookups.set(key, promise);
		}
		return promise;
	};
}
async function dnsSdBrowse(o, file) {
	const max = o.max ?? SYSTEM_KEEP.instances;
	const run = linkSignals([o.signal], o.browseMs + 2 * o.resolveMs);
	const concurrency = o.concurrency ?? 4;
	const pool = priorityLimiter(concurrency, nameSlots(concurrency));
	/** service|instance key → what was learnt, in the order browses added them. */
	const found = new Map();
	/** Instances taken per group (adb, names): each capped at `max` on its own. */
	const taken = {
		adb: 0,
		names: 0
	};
	const resolved = new Map();
	const pending = [];
	const lookUp = addressLookups(o, file, run.signal, (fn) => pool("first", fn));
	/** `dns-sd -L <instance> <type> local.`, then its host's addresses. */
	const resolve = (key, service, instance) => pool(ADB_TYPES$1.has(bareType(service)) ? "first" : "names", async () => {
		let reached = null;
		let txt = [];
		let grace;
		await collect(o.streamTool, file, [
			"-L",
			instance,
			bareType(service),
			"local."
		], o.resolveMs, run.signal, (line, finish) => {
			if (!reached) {
				const answer = parseDnsSdReached(line);
				/** Only the instance asked about; the first answer (one per interface) wins. */
				if (!answer || answer.instance.toLowerCase() !== instance.toLowerCase()) return;
				reached = answer;
				grace = setTimeout(finish, AFTER_ANSWER_MS);
				return;
			}
			/** The TXT line follows its answer, starting with a space; absent when empty. */
			if (line.startsWith(" ")) txt = parseDnsSdTxt(line);
			finish();
		});
		clearTimeout(grace);
		return {
			reached,
			txt
		};
	}).then(async ({ reached, txt }) => {
		if (!reached || !usableHost(reached.host) || run.signal.aborted) return;
		const addresses = await lookUp(reached.host);
		const labels = presentationLabels(reached.host) ?? [reached.host];
		resolved.set(key, {
			service,
			instance,
			target: labels.join("."),
			port: reached.port,
			addresses,
			txt
		});
	});
	const browses = o.services.map((service) => collect(o.streamTool, file, [
		"-B",
		bareType(service),
		"local."
	], o.browseMs, run.signal, (line) => {
		const entry = parseDnsSdBrowseLine(line);
		if (!entry || !sameName(entry.domain, "local") || !sameName(entry.type, bareType(service))) return;
		const key = `${bareType(service)}|${entry.instance.toLowerCase()}`;
		const known = found.get(key);
		if (entry.op === "Rmv") {
			if (known) known.gone = true;
			return;
		}
		if (known) {
			known.gone = false;
			return;
		}
		const group = ADB_TYPES$1.has(bareType(service)) ? "adb" : "names";
		if (taken[group] >= max || !usableInstance(entry.instance)) return;
		taken[group]++;
		found.set(key, {
			service,
			instance: entry.instance,
			gone: false
		});
		pending.push(resolve(key, service, entry.instance));
	}).then((outcome) => ({
		outcome,
		adds: [...found.keys()].some((k) => k.startsWith(`${bareType(service)}|`))
	})));
	try {
		const outcomes = await Promise.all(browses);
		/** Resolves may still be starting from the last lines; wait for every one. */
		let waited = 0;
		while (waited < pending.length) {
			const batch = pending.slice(waited);
			waited = pending.length;
			await Promise.all(batch);
		}
		const looked = outcomes.some(({ outcome, adds }) => adds || outcome.stopped && !outcome.error);
		const instances = [];
		for (const [key, entry] of found) {
			const instance = resolved.get(key);
			if (instance && !entry.gone) instances.push(instance);
		}
		const failed = outcomes.find(({ outcome }) => !outcome.stopped);
		return {
			tool: "dns-sd",
			looked,
			instances: dropSharedHosts(inServiceOrder(instances, o.services)),
			...looked || !failed ? {} : { detail: whyNot("dns-sd", failed.outcome) }
		};
	} finally {
		run.dispose();
	}
}
async function avahiBrowse(o, file) {
	const max = o.max ?? SYSTEM_KEEP.instances;
	const run = linkSignals([o.signal], o.browseMs + o.resolveMs);
	const byKey = new Map();
	const gone = new Set();
	/** Instances kept per group (adb, names): each capped at `max` on its own. */
	const taken = {
		adb: 0,
		names: 0
	};
	try {
		const outcomes = await Promise.all(o.services.map(async (service) => {
			const type = bareType(service);
			let lines = 0;
			return {
				outcome: await collect(o.streamTool, file, [
					"-r",
					"-p",
					"-t",
					"-k",
					type
				], o.browseMs + o.resolveMs, run.signal, (line) => {
					const entry = parseAvahiLine(line, type);
					if (!entry) return;
					lines++;
					const key = `${type}|${entry.instance.toLowerCase()}`;
					if (entry.op === "-") return void gone.add(key);
					if (entry.op === "+") return void gone.delete(key);
					/** IPv4 answers only: a link-local IPv6 one carries no interface adb could use. */
					if (entry.protocol !== "IPv4" || !entry.address || !net.isIPv4(entry.address)) return;
					if (!usableInstance(entry.instance) || entry.port === void 0) return;
					const known = byKey.get(key);
					if (known) {
						if (!known.addresses.includes(entry.address) && known.addresses.length < SYSTEM_KEEP.addresses) known.addresses.push(entry.address);
						return;
					}
					const group = ADB_TYPES$1.has(type) ? "adb" : "names";
					if (taken[group] >= max) return;
					taken[group]++;
					const labels = presentationLabels(entry.host ?? "") ?? [];
					byKey.set(key, {
						service,
						instance: entry.instance,
						target: labels.join(".") || null,
						port: entry.port,
						addresses: [entry.address],
						txt: entry.txt ?? []
					});
				}),
				lines
			};
		}));
		const looked = outcomes.some(({ outcome, lines }) => lines > 0 || !outcome.error && !outcome.stopped && outcome.code === 0);
		const instances = [...byKey.entries()].filter(([key]) => !gone.has(key)).map(([, i]) => i);
		const failed = outcomes.find(({ outcome }) => outcome.error || outcome.code !== 0);
		return {
			tool: "avahi-browse",
			looked,
			instances: dropSharedHosts(inServiceOrder(instances, o.services)),
			...looked || !failed ? {} : { detail: whyNot("avahi-browse", failed.outcome) }
		};
	} finally {
		run.dispose();
	}
}
/** One browse through the system's daemon, with whichever tool this computer has. */
async function systemBrowse(o) {
	if (o.tools.dnsSd) return dnsSdBrowse(o, o.tools.dnsSd);
	if (o.tools.avahiBrowse) return avahiBrowse(o, o.tools.avahiBrowse);
	return {
		tool: null,
		looked: false,
		instances: []
	};
}
/** How long a `dns-sd -Z` that printed records may stay quiet before it is ended. */
const ZONE_QUIET_MS = 200;
/** `dns-sd -Z` processes at a time. */
const ZONE_SLOTS = 6;
/** `dns-sd -G` lookups at a time. */
const LOOKUP_SLOTS = 4;
/** What one whole-network run keeps: instances in all, of one type, and hosts looked up. */
const ALL_KEEP = {
	instances: 256,
	perType: 64,
	hosts: 128
};
/**
 * Every service on the network through the system's daemon (§4.9), as ServiceInstances whose
 * `service` is `<type>.local`.
 *
 * dns-sd: the daemon's list of types (`dns-sd -B _services._dns-sd._udp local.`, for
 * `browseMs`), and for each type it lists (at most MAX_SERVICE_TYPES) and each of `services`
 * one `dns-sd -Z <type> local.`, the zone listing of every instance of the type in one
 * process: 6 at a time, ended 200 ms after its last record, else after `resolveMs`. Each host
 * an SRV names is looked up once with `dns-sd -G v4`, 4 at a time. The whole run is cut at
 * `browseMs + 2 × resolveMs`, and no killed process is waited for.
 *
 * avahi: one `avahi-browse -a -r -p -t -k`, cut at `browseMs + resolveMs`, its types learnt
 * from its own browse lines before its resolved lines are read; IPv4 answers only.
 *
 * Addresses are as the daemon gives them for a host name: whether a name ties a service to
 * one address (two TVs both say `Android.local`) is the caller's to decide.
 */
async function systemBrowseAll(o) {
	if (o.tools.dnsSd) return dnsSdBrowseAll(o, o.tools.dnsSd);
	if (o.tools.avahiBrowse) return avahiBrowseAll(o, o.tools.avahiBrowse);
	return {
		tool: null,
		looked: false,
		instances: []
	};
}
async function dnsSdBrowseAll(o, file) {
	const run = linkSignals([o.signal], o.browseMs + 2 * o.resolveMs);
	const zoneSlot = createLimiter(ZONE_SLOTS);
	const lookUp = addressLookups(o, file, run.signal, createLimiter(LOOKUP_SLOTS));
	/** type key → its `-Z` run. */
	const zones = new Map();
	/** `type|instance` → what its records said, in the order they came. */
	const found = new Map();
	const perType = new Map();
	/** host key → its addresses, once per host. */
	const hosts = new Map();
	const hostKey = (host) => host.toLowerCase().replace(/\.$/, "");
	let listed = 0;
	const take = (type, record) => {
		if (!usableInstance(record.instance)) return;
		const key = `${nameKey(type)}|${record.instance.toLowerCase()}`;
		let entry = found.get(key);
		if (!entry) {
			const count = perType.get(nameKey(type)) ?? 0;
			if (found.size >= ALL_KEEP.instances || count >= ALL_KEEP.perType) return;
			perType.set(nameKey(type), count + 1);
			found.set(key, entry = {
				type,
				instance: record.instance,
				txt: []
			});
		}
		/** One block per interface: the first SRV and the first TXT stand. */
		if (record.type === "SRV" && entry.host === void 0 && record.host) {
			if (!usableHost(record.host)) return;
			const host = hostKey(record.host);
			if (!hosts.has(host) && hosts.size >= ALL_KEEP.hosts) return;
			entry.host = record.host;
			entry.port = record.port;
			if (!hosts.has(host)) hosts.set(host, lookUp(record.host));
		}
		if (record.type === "TXT" && record.txt && !entry.txt.length) entry.txt = record.txt.slice(0, SYSTEM_KEEP.txt);
	};
	const zone = (type) => {
		const key = nameKey(type);
		if (zones.has(key)) return;
		const ran = zoneSlot(async () => {
			let quiet;
			const outcome = await collect(o.streamTool, file, [
				"-Z",
				type,
				"local."
			], o.resolveMs, run.signal, (line, finish) => {
				const record = parseDnsSdZoneLine(line, type);
				if (!record) return;
				take(type, record);
				clearTimeout(quiet);
				quiet = setTimeout(finish, ZONE_QUIET_MS);
			});
			clearTimeout(quiet);
			return outcome;
		});
		zones.set(key, ran);
	};
	try {
		for (const service of o.services) {
			const type = serviceType(service);
			if (type) zone(type);
		}
		const listing = await collect(o.streamTool, file, [
			"-B",
			"_services._dns-sd._udp",
			"local."
		], o.browseMs, run.signal, (line) => {
			const type = parseDnsSdTypeLine(line);
			if (!type || zones.has(nameKey(type)) || listed >= 48) return;
			listed++;
			zone(type);
		});
		/** No `-Z` starts once the listing has ended: every run is in `zones` now. */
		const outcomes = await Promise.all(zones.values());
		const addresses = new Map();
		for (const [key, lookup] of hosts) addresses.set(key, await lookup);
		const instances = [];
		for (const entry of found.values()) {
			if (entry.host === void 0 || entry.port === void 0) continue;
			instances.push({
				service: `${entry.type}.local`,
				instance: entry.instance,
				target: (presentationLabels(entry.host) ?? [entry.host]).join("."),
				port: entry.port,
				addresses: addresses.get(hostKey(entry.host)) ?? [],
				txt: entry.txt
			});
		}
		const looked = listing.stopped && !listing.error || found.size > 0 || outcomes.some((z) => z.stopped && !z.error);
		return {
			tool: "dns-sd",
			looked,
			instances,
			...looked ? {} : { detail: whyNot("dns-sd", listing) }
		};
	} finally {
		run.dispose();
	}
}
async function avahiBrowseAll(o, file) {
	const run = linkSignals([o.signal], o.browseMs + o.resolveMs);
	/** Learnt from the browse lines (`+`, `-`), which come before a service's resolved lines. */
	const types = new Map();
	for (const service of o.services) {
		const type = serviceType(service);
		if (type) types.set(nameKey(type), type);
	}
	const most = types.size + 48;
	const byKey = new Map();
	const gone = new Set();
	const perType = new Map();
	let lines = 0;
	try {
		const outcome = await collect(o.streamTool, file, [
			"-a",
			"-r",
			"-p",
			"-t",
			"-k"
		], o.browseMs + o.resolveMs, run.signal, (line) => {
			const learnt = avahiLineType(line);
			if (learnt && !types.has(nameKey(learnt)) && types.size < most) types.set(nameKey(learnt), learnt);
			for (const type of types.values()) {
				const entry = parseAvahiLine(line, type);
				if (!entry) continue;
				lines++;
				const key = `${nameKey(type)}|${entry.instance.toLowerCase()}`;
				if (entry.op === "-") return void gone.add(key);
				if (entry.op === "+") return void gone.delete(key);
				if (entry.protocol !== "IPv4" || !entry.address || !net.isIPv4(entry.address)) return;
				if (!usableInstance(entry.instance) || entry.port === void 0) return;
				const known = byKey.get(key);
				if (known) {
					if (!known.addresses.includes(entry.address) && known.addresses.length < SYSTEM_KEEP.addresses) known.addresses.push(entry.address);
					return;
				}
				const count = perType.get(nameKey(type)) ?? 0;
				if (byKey.size >= ALL_KEEP.instances || count >= ALL_KEEP.perType) return;
				perType.set(nameKey(type), count + 1);
				const labels = presentationLabels(entry.host ?? "") ?? [];
				byKey.set(key, {
					service: `${type}.local`,
					instance: entry.instance,
					target: labels.join(".") || null,
					port: entry.port,
					addresses: [entry.address],
					txt: entry.txt ?? []
				});
				return;
			}
		});
		const looked = lines > 0 || !outcome.error && !outcome.stopped && outcome.code === 0;
		const failed = !!outcome.error || !outcome.stopped && outcome.code !== 0;
		return {
			tool: "avahi-browse",
			looked,
			instances: [...byKey.entries()].filter(([key]) => !gone.has(key)).map(([, i]) => i),
			...looked || !failed ? {} : { detail: whyNot("avahi-browse", outcome) }
		};
	} finally {
		run.dispose();
	}
}
/** `192.168.68.110` → `110.68.168.192.in-addr.arpa`: where an address's reverse name lives. */
function reverseName(address) {
	return `${address.split(".").reverse().join(".")}.in-addr.arpa`;
}
/** Reverse lookups at a time. */
const REVERSE_SLOTS = 8;
/** A `.local` name an answer gave, without its root dot, or null. */
function localName(text) {
	const labels = presentationLabels(text);
	const name = labels?.join(".") ?? "";
	return labels && labels.length >= 2 && usableHost(name) ? name.replace(/\.$/, "") : null;
}
/**
 * The `.local` name of each address that has one (§4.9): the reverse PTR every mDNS
 * responder publishes for the addresses it holds (RFC 6762 §4), which names a phone or a
 * computer that announces no service at all. macOS: `dns-sd -fmc -q <d.c.b.a>.in-addr.arpa.
 * PTR` (`-fmc` keeps it on mDNS: the router's DNS knows none of these names), Linux:
 * `avahi-resolve -a <address>`, each ended at its first answer or `timeoutMs`, 8 at a time;
 * elsewhere, one set of questions from the helper's own socket, answered within `timeoutMs`.
 * The whole step is cut at `2 × timeoutMs`. Only a `.local` name counts; nothing throws.
 */
async function reverseNames(o) {
	const names = new Map();
	const addresses = o.addresses.filter((address) => net.isIPv4(address));
	if (!addresses.length || o.signal?.aborted) return names;
	const run = linkSignals([o.signal], 2 * o.timeoutMs);
	try {
		const { dnsSd, avahiResolve } = o.tools;
		if (!dnsSd && !avahiResolve) {
			await ownReverse(o, addresses, names, run.signal);
			return names;
		}
		const slot = createLimiter(REVERSE_SLOTS);
		await Promise.all(addresses.map((address) => slot(async () => {
			if (run.signal.aborted) return;
			let name = null;
			if (dnsSd) {
				const asked = `${reverseName(address)}.`;
				await collect(o.streamTool, dnsSd, [
					"-fmc",
					"-q",
					asked,
					"PTR"
				], o.timeoutMs, run.signal, (line, finish) => {
					const answer = parseDnsSdQueryLine(line);
					if (answer?.op !== "Add" || !sameName(answer.name, asked)) return;
					name = answer.answer === null ? null : localName(answer.answer);
					finish();
				});
			} else if (avahiResolve) await collect(o.streamTool, avahiResolve, ["-a", address], o.timeoutMs, run.signal, (line, finish) => {
				const host = parseAvahiResolveLine(line, address);
				if (!host) return;
				name = localName(host);
				finish();
			});
			if (name) names.set(address, name);
		})));
		return names;
	} finally {
		run.dispose();
	}
}
/** Reverse names asked from the helper's own socket: one query set, then `timeoutMs` of answers. */
async function ownReverse(o, addresses, names, signal) {
	const id = 1 + Math.floor(Math.random() * 65534);
	const byName = new Map(addresses.map((address) => [nameKey(reverseName(address)), address]));
	const queries = inPieces(addresses, MAX_QUESTIONS).map((piece) => encodeQuery(id, piece.map((address) => ({
		name: reverseName(address),
		type: "PTR"
	}))));
	let done = false;
	const onPacket = (packet) => {
		if (done) return;
		try {
			const message = parseMessage(packet);
			if (!message?.response || message.id !== id && message.id !== 0) return;
			for (const record of message.records) {
				const address = byName.get(nameKey(record.name));
				if (record.type !== "PTR" || record.ttl === 0 || !address || names.has(address)) continue;
				const name = splitName(record.target).join(".");
				if (/\.local$/i.test(name) && usableHost(name)) names.set(address, name);
			}
		} catch {
			return;
		}
	};
	if (signal.aborted) return;
	let transport;
	try {
		transport = await o.open(onPacket);
	} catch {
		return;
	}
	try {
		if (signal.aborted) return;
		for (const packet of queries) try {
			transport.send(packet).catch(() => void 0);
		} catch {}
		await sleep(o.timeoutMs, signal).catch(() => void 0);
	} finally {
		done = true;
		transport.close();
	}
}

//#endregion
//#region src/android-lane.ts
/**
 * §9 Android lane: Google's adb server, attach-only, over its host protocol (§4).
 *
 * The helper never runs an adb command to reach a phone. The adb CLI starts a server whenever
 * none runs, and a running server claims every phone's USB interface, which takes the phones
 * away from Chrome's WebUSB lane: the tester's working setup would break because the helper
 * looked. So the helper only TALKS to a server that is already there, on 127.0.0.1:5037, and
 * starts one solely when the tester clicks "Start adb server" (§4.5). It never stops one:
 * the tester's IDE may be using it, and `adb kill-server` is one command away.
 *
 * Coexistence with WebUSB (§4.6) follows from that, with the page's merge rule doing the rest:
 * - no server: this lane reports `stopped` and lists nothing, so WebUSB rows stand alone;
 * - a server (an IDE's, or one started here): this lane lists what the server holds, and the
 *   page prefers those rows to WebUSB's `held` ones;
 * - a phone WebUSB still holds shows up here as `offline` or `unknown`, and loses to WebUSB.
 *
 * Every exchange is a fresh socket with its own deadline, except the hot-plug tracker, which
 * is one long-lived socket while a server exists. What may be sent is an allowlist (T10, T11):
 * four host services, `host:transport:<serial>` with a serial of the listed shape, and the
 * constant `exec:` strings in ADB_EXEC. No page input ever reaches a device command.
 *
 * The one exception is Wi-Fi (§4.7): `host:connect:`, `host:pair:` and `host:disconnect:`
 * carry an address, a code or a serial the tester typed. They never pass assertAdbService;
 * each has its own sender and its own exact-format check, and is sent only on a click.
 */
/**
 * The host services the client may send, besides `host:transport:<serial>`. All read-only
 * except `host:reconnect-offline`, which resets transports the server already has.
 * `host:mdns:services` is the server's own mDNS list (`adb mdns services`), read for §4.8.
 * `host:features` is sent only after `host:transport:<serial>`, which makes it that device's
 * feature list (§4.10).
 */
const ADB_HOST_SERVICES = [
	"host:version",
	"host:track-devices-l",
	"host:devices-l",
	"host:reconnect-offline",
	"host:mdns:services",
	"host:features"
];
const TRANSPORT = "host:transport:";
const EXEC = "exec:";
/** Throws unless `service` is on the allowlist. The one gate every request passes. */
function assertAdbService(service) {
	if (ADB_HOST_SERVICES.includes(service)) return;
	if (service.startsWith(TRANSPORT) && ID.android.test(service.slice(15))) return;
	if (service.startsWith(EXEC) && ADB_EXEC.includes(service.slice(5))) return;
	throw new HelperError("INTERNAL", 500, `Refusing to send "${service}" to the adb server.`);
}
/**
 * The device services the page's adb tunnel may open, by prefix: exactly what Device Lab's
 * Android operations use over WebUSB (installs, apps, images), so they run unchanged over
 * the adb server. `shell,v2,raw:` and `exec:` run a command without a terminal, `abb_exec:`
 * is the package manager's binder shell (Android 10+), and `sync:` reads files and lists
 * folders. Each command is the page's, as over WebUSB: the tunnel exists to carry them.
 *
 * Nothing else passes, so a tunnel never reaches a socket: no `reverse:` (the device would
 * reach this Mac's loopback), no `tcp:` or `local*:` (a socket on the device), no `jdwp:`, no
 * terminal (`shell:`, `shell,v2,pty`), and no service that restarts adbd or the device
 * (`root:`, `remount:`, `reboot:`, `tcpip:`, `usb:`). Host services never reach a tunnel at
 * all: the helper sends `host:transport:` itself, with the serial of a listed device.
 */
const ADB_TUNNEL_SERVICES = [
	"shell,v2,raw:",
	"exec:",
	"abb_exec:",
	"sync:"
];
/** Throws BAD_REQUEST unless `service` may open through the tunnel. */
function assertTunnelService(service) {
	if (service.length <= LIMITS.tunnelService) {
		if (service === "sync:") return;
		for (const prefix of ADB_TUNNEL_SERVICES) if (prefix !== "sync:" && service.startsWith(prefix) && service.length > prefix.length) return;
	}
	throw new HelperError("BAD_REQUEST", 400, "The helper doesn’t open that adb service.");
}
/** A request: four lowercase hex digits of length, then the ASCII payload. */
function encodeAdbRequest(service) {
	const body = Buffer.from(service, "utf8");
	return Buffer.concat([Buffer.from(body.length.toString(16).padStart(4, "0"), "ascii"), body]);
}
function serverStopped() {
	return new HelperError("ADB_SERVER_STOPPED", 503, "Google's adb server isn't running.");
}
function garbled() {
	return new HelperError("TOOL_FAILED", 502, "The adb server answered something unexpected.");
}
/**
 * A `FAIL` reply as the page's error codes (§4.2). adbd's texts are stable across versions:
 * "device unauthorized.\nThis adb server's $ADB_VENDOR_KEYS is not set…", "device offline",
 * "device 'X' not found", "device still authorizing", "device still connecting".
 */
function adbFailError(message) {
	const text = message.trim();
	if (/^device (?:unauthorized|still authorizing)/i.test(text)) return new HelperError("ANDROID_UNAUTHORIZED", 409, "The phone is waiting for you to allow USB debugging.");
	if (/^device offline/i.test(text)) return new HelperError("ANDROID_OFFLINE", 409, "The phone is not answering adb.");
	if (/^device (?:'.*' )?not found/i.test(text)) return new HelperError("DEVICE_NOT_FOUND", 404, "The device is no longer connected.");
	if (/^device still connecting/i.test(text)) return new HelperError("DEVICE_NOT_READY", 409, "The phone is still connecting.", {
		state: "connecting",
		blockers: []
	});
	return new HelperError("TOOL_FAILED", 502, `adb: ${clean(text, 500) || "request refused"}`);
}
/**
 * Length-prefixed reads over a socket, for the handshake part of every exchange. The socket
 * flows only while a read is waiting: between reads it is paused, so the bytes after the
 * handshake (and the end of the stream) stay in the socket for whoever takes it over, and
 * cannot slip past before that code has attached its listeners.
 */
function createReader(socket) {
	let buffered = Buffer.alloc(0);
	let ended = null;
	let waiter = null;
	const settle = () => {
		if (!waiter) return;
		if (buffered.length >= waiter.n) {
			const { n, resolve } = waiter;
			waiter = null;
			socket.pause();
			const out = buffered.subarray(0, n);
			buffered = buffered.subarray(n);
			resolve(out);
		} else if (ended) {
			const { reject } = waiter;
			waiter = null;
			reject(ended);
		}
	};
	const onData = (chunk) => {
		buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
		settle();
	};
	const onEnd = () => {
		ended ??= garbled();
		settle();
	};
	const onError = (error) => {
		ended = error;
		settle();
	};
	socket.pause();
	socket.on("data", onData);
	socket.on("end", onEnd);
	socket.on("close", onEnd);
	socket.on("error", onError);
	return {
		read(n) {
			return new Promise((resolve, reject) => {
				waiter = {
					n,
					resolve,
					reject
				};
				settle();
				if (waiter) socket.resume();
			});
		},
		detach() {
			socket.pause();
			socket.off("data", onData);
			socket.off("end", onEnd);
			socket.off("close", onEnd);
			socket.off("error", onError);
			const rest = buffered;
			buffered = Buffer.alloc(0);
			return rest;
		}
	};
}
const HEX4 = /^[0-9a-fA-F]{4}$/;
async function readLength(reader) {
	const text = (await reader.read(4)).toString("latin1");
	if (!HEX4.test(text)) throw garbled();
	return parseInt(text, 16);
}
/** Errors made from a FAIL reply, as opposed to a socket that broke: the tracker needs to know. */
const refusals = new WeakSet();
/** The server answered FAIL (it refused), rather than going away or talking nonsense. */
function isAdbRefusal(error) {
	return error instanceof Error && refusals.has(error);
}
/** `OKAY`, or the `FAIL` message as an error. */
async function readStatus(reader) {
	const status = (await reader.read(4)).toString("latin1");
	if (status === "OKAY") return;
	if (status === "FAIL") {
		const error = adbFailError((await reader.read(await readLength(reader))).toString("utf8"));
		refusals.add(error);
		throw error;
	}
	throw garbled();
}
/**
 * An Android TV across the room has no cable, and a browser cannot open TCP: only the adb
 * server can reach a device on the network. Three host services do it, and they are exactly
 * the ones ADB_HOST_NEVER lists, because they change what the server serves. They are sent
 * for one purpose only, on the tester's explicit click: never through assertAdbService (which
 * still refuses them), only through the three senders of createAdbClient below, each with its
 * own exact-format check of the one string it may send.
 *
 * What the page may name is narrow: an address on the local network (private, link-local or
 * carrier-grade NAT IPv4, unique-local or link-local IPv6, or a `.local`, `.lan` or
 * `.home.arpa` name), a port, and a six-digit pairing code. Never a public address, never
 * loopback (that is where emulators and the adb server itself listen), never anything adb
 * would read as a second argument. Anything else is 400 BAD_REQUEST before a socket opens.
 */
/** adb's default port for `adb connect` (`adb tcpip 5555`, most TVs' "network debugging"). */
const ADB_NETWORK_PORT = 5555;
function badRequest(message) {
	return new HelperError("BAD_REQUEST", 400, message);
}
const IPV4$1 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
/** 10/8, 172.16/12, 192.168/16, 169.254/16 (link-local) and 100.64/10 (carrier-grade NAT). */
function isLocalIpv4(address) {
	if (!IPV4$1.test(address)) return false;
	const [a = 0, b = 0] = address.split(".").map(Number);
	return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 169 && b === 254 || a === 100 && b >= 64 && b <= 127;
}
/** fc00::/7 (unique local) and fe80::/10 (link-local), written out or compressed. */
function isLocalIpv6(address) {
	/** Never `::…` (unspecified, mapped IPv4) and never dotted (adb's serial could not carry it). */
	if (!net.isIPv6(address) || address.startsWith(":") || address.includes(".")) return false;
	const first = parseInt(address.split(":")[0] ?? "", 16);
	return (first & 65024) === 64512 || (first & 65472) === 65152;
}
const ZONE = /^[A-Za-z0-9_-]{1,32}$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LOCAL_SUFFIXES = [
	".home.arpa",
	".local",
	".lan"
];
/** A name this long still makes a serial (`name:65535`) that ID.android accepts. */
const NAME_MAX = 100;
const NOT_LOCAL = "Only devices on your local network: an address like 192.168.1.20, or a name ending in .local, .lan or .home.arpa.";
/**
 * The host of a Wi-Fi device as the page typed it, normalised, or 400. IPv6 may come with
 * or without brackets and with a zone (`fe80::1%en0`); names are lower-cased.
 */
function parseNetworkHost(value) {
	if (typeof value !== "string" || !value.trim()) throw badRequest("Enter the device’s address.");
	let host = value.trim();
	if (host.length > 253) throw badRequest("That address is too long.");
	if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
	/** `192.168.1.20:5555` or `tv.local:5555` in the address field: the port goes on its own. */
	const withPort = /^([^:[\]]+):\d{1,5}$/.exec(host);
	if (withPort?.[1]) throw badRequest(`Enter the port on its own: the address is just ${clean(withPort[1], 60)}.`);
	if (host.includes(":")) {
		const at = host.indexOf("%");
		const address = at < 0 ? host : host.slice(0, at);
		const zone = at < 0 ? null : host.slice(at + 1);
		if (zone !== null && !ZONE.test(zone)) throw badRequest("That IPv6 zone is not valid.");
		if (!isLocalIpv6(address)) throw badRequest("Only devices on your local network: an IPv6 address in fc00::/7 or fe80::/10.");
		return address.toLowerCase() + (zone === null ? "" : `%${zone}`);
	}
	if (/^[\d.]+$/.test(host)) {
		if (!isLocalIpv4(host)) throw badRequest(IPV4$1.test(host) ? "Only devices on your local network: 10.x, 172.16–31.x, 192.168.x, 169.254.x or 100.64–127.x." : "That is not an IP address.");
		return host;
	}
	const name = host.toLowerCase().replace(/\.$/, "");
	if (name.length > NAME_MAX) throw badRequest("That name is too long; use the IP address.");
	const suffix = LOCAL_SUFFIXES.find((s) => name.endsWith(s));
	const labels = suffix ? name.slice(0, -suffix.length).split(".") : [];
	if (!suffix || !labels.length || !labels.every((label) => LABEL.test(label))) throw badRequest(NOT_LOCAL);
	return name;
}
/** An integer port, 1–65535, as a JSON number; `fallback` when the page sent none. */
function parseNetworkPort(value, fallback) {
	if (value === void 0 && fallback !== void 0) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) throw badRequest("The port must be a whole number from 1 to 65535.");
	return value;
}
/** The six digits Android's "Pair device with pairing code" shows. */
function parsePairingCode(value) {
	if (typeof value !== "string" || !/^\d{6}$/.test(value)) throw badRequest("The pairing code is the six digits the device shows.");
	return value;
}
const systemLookup = async (name) => (await dns.lookup(name, {
	all: true,
	verbatim: true
})).map((a) => a.address);
/**
 * adb resolves a `.local`, `.lan` or `.home.arpa` name itself, so "never public, never
 * loopback" holds for a name only if the helper looks first: a router's DNS (or /etc/hosts)
 * that maps `tv.lan` to 127.0.0.1 would otherwise send adb to an emulator's port. Every
 * address the name has must be one parseNetworkHost would take. A name that does not resolve
 * here would not resolve for adb either: `unresolved` at once, nothing sent.
 */
async function checkResolvedName(host, lookup, timeoutMs, fail) {
	if (IPV4$1.test(host) || host.includes(":")) return;
	let addresses;
	const deadline = new AbortController();
	try {
		addresses = await Promise.race([lookup(host), sleep(timeoutMs, deadline.signal).then(() => Promise.reject(new Error("lookup timed out")))]);
	} catch {
		throw fail("unresolved");
	} finally {
		deadline.abort();
	}
	if (!addresses.length) throw fail("unresolved");
	for (const address of addresses) {
		const bare = address.split("%")[0] ?? "";
		if (!isLocalIpv4(bare) && !isLocalIpv6(bare)) throw badRequest(`${host} points to ${clean(address, 60)}, which is not on your local network. Use the device’s IP address instead.`);
	}
}
/** `host:port` as adb writes a network serial: IPv6 in brackets (`[fe80::1%en0]:5555`). */
function networkSerial(host, port) {
	return `${host.includes(":") ? `[${host}]` : host}:${String(port)}`;
}
/** A serial the server lists for a device it reaches over the network (§4.3). */
function isNetworkSerial(serial) {
	return ID.android.test(serial) && adbConnection(serial) === "network";
}
/** `<host>:<port>` with a host parseNetworkHost keeps unchanged and a valid port, or null. */
function exactAddress(text) {
	const match = /^(\[[^\]]+\]|[^:[\]]+):(\d{1,5})$/.exec(text);
	if (!match?.[1] || !match[2]) return null;
	const raw = match[1].startsWith("[") ? match[1].slice(1, -1) : match[1];
	try {
		const host = parseNetworkHost(raw);
		const port = parseNetworkPort(Number(match[2]));
		/** Only the canonical spelling: brackets exactly when IPv6, nothing normalised away. */
		return networkSerial(host, port) === text ? {
			host,
			port
		} : null;
	} catch {
		return null;
	}
}
function refuseToSend(service) {
	return new HelperError("INTERNAL", 500, `Refusing to send "${service}" to the adb server.`);
}
/** `host:connect:<host>:<port>`, and nothing else, or it throws. */
function assertConnectService(service) {
	if (service.startsWith("host:connect:") && exactAddress(service.slice(13))) return;
	throw refuseToSend(service);
}
/** `host:pair:<6 digits>:<host>:<port>`, and nothing else, or it throws. */
function assertPairService(service) {
	const match = /^host:pair:(\d{6}):(.+)$/.exec(service);
	if (match?.[2] && exactAddress(match[2])) return;
	throw refuseToSend(service);
}
/**
 * A serial `host:disconnect:` can drop: `<host>:<port>` exactly as connect writes it. Not an
 * mDNS serial (`adb-…._adb-tls-connect._tcp`): adb reads that as a host on port 5555 and
 * answers "no such device", so the device would stay while the page said it went. Not
 * loopback either (`127.0.0.1:5555` is an emulator), which connect never reaches.
 */
function isDisconnectableSerial(serial) {
	return isNetworkSerial(serial) && exactAddress(serial) !== null;
}
/**
 * `host:disconnect:<host>:<port>`, and nothing else, or it throws. An empty serial would make
 * the server drop every network device at once; a USB serial is not adb's to drop.
 */
function assertDisconnectService(service) {
	if (service.startsWith("host:disconnect:") && isDisconnectableSerial(service.slice(16))) return;
	throw refuseToSend(service);
}
function failureOf(text) {
	if (/failed to authenticate/i.test(text)) return "unpaired";
	if (/refused/i.test(text)) return "refused";
	/**
	 * EHOSTUNREACH to a local address, at once: this computer never sent a packet. A VPN that
	 * takes all traffic (Cloudflare WARP) answers that way, and so does macOS for a process
	 * whose app has no local-network access (one started from VS Code). The address can be
	 * right and the device awake: it is not `unreachable`, and "same network?" misleads.
	 */
	if (/no route to host/i.test(text)) return "blocked";
	if (/no route|unreachable|host is down|network is down/i.test(text)) return "unreachable";
	if (/timed? ?out/i.test(text)) return "timeout";
	if (/resolve|nodename nor servname|name or service not known/i.test(text)) return "unresolved";
	return "failed";
}
/**
 * adb 36 answers "failed to authenticate to X" when the device has not allowed this Mac yet:
 * the transport is registered, but unauthorized. A TV with Network debugging is then listed
 * `unauthorized` and shows "Allow debugging?"; a phone with Wireless debugging that never
 * paired drops the link instead, and is not listed.
 */
function isAuthenticateReply(reply) {
	return /^failed to authenticate to /i.test(reply.text.trim());
}
/** One plain sentence each: what to do about it. */
const NETWORK_HINT = {
	refused: "Nothing accepted the connection there. On the device, turn on Network debugging (TV) or Wireless debugging (phone), and check the address and port.",
	blocked: "Something on this computer is blocking the local network. If a VPN is on (Cloudflare WARP, a Tailscale exit node, a work VPN), turn it off or allow local network access in it. On a Mac, start the helper from Terminal.app and choose Allow when macOS asks, or allow that app under System Settings → Privacy & Security → Local Network.",
	unreachable: "That address cannot be reached from this Mac. Check that the device and this Mac are on the same network.",
	timeout: "The device did not answer in time. Check that it is on, awake and on the same network.",
	unresolved: "That name was not found on your network. Use the device’s IP address instead.",
	unpaired: "The device uses Wireless debugging and has not paired with this Mac yet. Pair it first with the code from “Pair device with pairing code”.",
	"wrong-code": "The pairing code was wrong, or the device closed the pairing screen. Try a new code.",
	unsupported: "This adb is too old for Wireless debugging. Update it: brew upgrade --cask android-platform-tools",
	failed: "adb could not reach the device."
};
function connectFailed(target, reason, said = "") {
	return new HelperError("ANDROID_CONNECT_FAILED", 502, `Could not connect to ${target}. ${NETWORK_HINT[reason]}`, {
		reason,
		...said ? { detail: clean(said, 300) } : {}
	});
}
function pairFailed(target, reason, said = "") {
	return new HelperError("ANDROID_PAIR_FAILED", 502, `Could not pair with ${target}. ${NETWORK_HINT[reason]}`, {
		reason,
		...said ? { detail: clean(said, 300) } : {}
	});
}
/**
 * The terminal lines for a failed connect or pairing: `head` alone, except for `blocked`,
 * whose two likely causes each get an indented line with its fix, the way a blocker does.
 * The macOS one only on a Mac.
 */
function networkFailureLines(head, error, platform) {
	if (error.extra.reason !== "blocked") return [head];
	return blockedLines(head, "no route to host", platform);
}
/**
 * `head`, what the socket said (`cause`), and the two likely culprits with their fixes, each
 * on an indented line: shared by a connect or pairing that was refused at once (§4.7) and a
 * scan whose queries could not leave (§4.8).
 */
function blockedLines(head, cause, platform) {
	return [
		`${head}: ${cause}, so this computer can't reach the local network`,
		"  If a VPN is on (Cloudflare WARP, a Tailscale exit node, a work VPN), turn it off or allow local network access in it",
		...platform === "darwin" ? ["  macOS may not let the app that started the helper (VS Code, some terminals) use the local network: start the helper from Terminal.app and choose Allow when macOS asks, or allow that app under System Settings → Privacy & Security → Local Network"] : []
	];
}
/**
 * The server's answer to `host:connect:` (adb 30–36): "connected to X", "already connected to
 * X", or a failure in one of several spellings ("failed to connect to 'X': Connection refused",
 * "cannot connect to X: No route to host (65)", "unable to connect to X", "failed to
 * authenticate to X", "failed to resolve host…"). Failures arrive as OKAY with that text, or
 * as FAIL; both mean the same here.
 */
function parseConnectReply(reply, target) {
	const said = reply.text.trim();
	const ok = reply.ok ? /^(already )?connected to (\S+)$/.exec(said) : null;
	if (ok?.[2]) {
		const serial = ID.android.test(ok[2]) ? ok[2] : target;
		return {
			result: ok[1] ? "already-connected" : "connected",
			serial,
			message: clean(said, 300)
		};
	}
	throw connectFailed(target, failureOf(said), said);
}
/**
 * The answer to `host:pair:` (adb 30+): "Successfully paired to X [guid=adb-…]", or
 * "Failed: Wrong password or connection was dropped." and other "Failed: …" texts. A server
 * older than Wireless debugging answers FAIL "unknown host service".
 */
function parsePairReply(reply, target) {
	const said = reply.text.trim();
	if (reply.ok && /^Successfully paired to /.test(said)) return { message: clean(said, 300) };
	if (/wrong password|connection was dropped/i.test(said)) throw pairFailed(target, "wrong-code", said);
	if (/unknown host service|invalid pairing request/i.test(said)) throw pairFailed(target, "unsupported", said);
	throw pairFailed(target, failureOf(said), said);
}
/** The answer to `host:disconnect:`: OKAY "disconnected X", or FAIL "no such device 'X'". */
function parseDisconnectReply(reply) {
	const said = reply.text.trim();
	if (reply.ok && /^disconnected /.test(said)) return { message: clean(said, 300) };
	if (/^no such device/i.test(said)) throw new HelperError("DEVICE_NOT_FOUND", 404, "The device is no longer connected.");
	throw new HelperError("TOOL_FAILED", 502, `adb: ${clean(said, 500) || "request refused"}`);
}
/**
 * The adb host protocol (§4.2). Each call opens its own socket: the server answers one host
 * service per connection, and a transport switch binds the socket to one device for good.
 */
function createAdbClient(opts) {
	const { port, timeouts } = opts;
	const open = new Set();
	/**
	 * One exchange on a fresh socket, under a deadline and the caller's signal. The socket is
	 * destroyed afterwards unless `talk` hands it over (`keep`). A refused connect means no
	 * server: ADB_SERVER_STOPPED, which version() turns into null.
	 */
	function exchange(talk, o) {
		const deadline = linkSignals([o.signal], o.timeoutMs);
		const socket = net.connect({
			host: "127.0.0.1",
			port
		});
		open.add(socket);
		socket.once("close", () => open.delete(socket));
		let kept = false;
		const failure = () => o.signal?.aborted ? abortError() : new HelperError("TOOL_TIMEOUT", 504, "The adb server took too long to answer.");
		const connectTimer = setTimeout(() => {
			if (socket.connecting) socket.destroy(failure());
		}, timeouts.adbConnect);
		const onAbort = () => {
			socket.destroy(failure());
		};
		deadline.signal.addEventListener("abort", onAbort, { once: true });
		/** The handshake is done and the socket lives on (tracker, logcat): no deadline any more. */
		const keep = () => {
			kept = true;
			clearTimeout(connectTimer);
			deadline.signal.removeEventListener("abort", onAbort);
			deadline.dispose();
		};
		const connected = new Promise((resolve, reject) => {
			socket.once("connect", () => {
				clearTimeout(connectTimer);
				resolve();
			});
			socket.once("error", (error) => {
				reject(error.code === "ECONNREFUSED" ? serverStopped() : error);
			});
		});
		connected.catch(() => void 0);
		const reader = createReader(socket);
		if (deadline.signal.aborted) onAbort();
		return connected.then(() => talk(socket, reader, keep)).catch((error) => {
			/** A destroyed socket rejects with the reason it was destroyed for, or a plain close. */
			if (deadline.signal.aborted) throw failure();
			if (error instanceof HelperError || error instanceof Error && error.name === "AbortError") throw error;
			const code = error.code;
			if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE") throw serverStopped();
			throw new HelperError("TOOL_FAILED", 502, `adb server: ${errorText(error)}`);
		}).finally(() => {
			clearTimeout(connectTimer);
			deadline.signal.removeEventListener("abort", onAbort);
			deadline.dispose();
			if (!kept) socket.destroy();
		});
	}
	const send = (socket, service) => {
		assertAdbService(service);
		socket.write(encodeAdbRequest(service));
	};
	/** A host service whose OKAY carries one length-prefixed payload. */
	const query = (service, signal) => exchange(async (socket, reader) => {
		send(socket, service);
		await readStatus(reader);
		return (await reader.read(await readLength(reader))).toString("utf8");
	}, {
		signal,
		timeoutMs: timeouts.adbRequest
	});
	/**
	 * One of the three Wi-Fi services (§4.7): checked by its own assert, never by
	 * assertAdbService, and answered with a length-prefixed text after OKAY or FAIL alike.
	 */
	const hostText = (service, check, o) => {
		try {
			check(service);
		} catch (error) {
			return Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}
		return exchange(async (socket, reader) => {
			socket.write(encodeAdbRequest(service));
			const status = (await reader.read(4)).toString("latin1");
			if (status !== "OKAY" && status !== "FAIL") throw garbled();
			const text = (await reader.read(await readLength(reader))).toString("utf8");
			return {
				ok: status === "OKAY",
				text
			};
		}, o);
	};
	/** `host:transport:<serial>` then `exec:<cmd>`, both answered OKAY. */
	const handshake = async (socket, reader, serial, cmd) => {
		send(socket, TRANSPORT + serial);
		await readStatus(reader);
		send(socket, EXEC + cmd);
		await readStatus(reader);
	};
	return {
		async version(signal) {
			try {
				const payload = await query("host:version", signal);
				if (!HEX4.test(payload)) throw garbled();
				return parseInt(payload, 16);
			} catch (error) {
				if (error instanceof HelperError && error.code === "ADB_SERVER_STOPPED") return null;
				throw error;
			}
		},
		track(onList, onEnd) {
			const stop = new AbortController();
			let ended = false;
			const finish = (error) => {
				if (ended) return;
				ended = true;
				onEnd(error);
			};
			exchange(async (socket, reader, keep) => {
				send(socket, "host:track-devices-l");
				await readStatus(reader);
				/** From here on the socket lives as long as the server, or until close(). */
				keep();
				stop.signal.addEventListener("abort", () => socket.destroy(), { once: true });
				try {
					for (;;) {
						const text = (await reader.read(await readLength(reader))).toString("utf8");
						if (stop.signal.aborted) return;
						onList(text);
					}
				} catch {} finally {
					socket.destroy();
				}
			}, { timeoutMs: timeouts.adbRequest }).then(() => finish(null), (error) => {
				if (stop.signal.aborted) return finish(null);
				finish(error instanceof Error ? error : new Error(String(error)));
			});
			return () => {
				stop.abort();
				finish(null);
			};
		},
		devicesL: (signal) => query("host:devices-l", signal),
		exec(serial, cmd, o = {}) {
			const maxBytes = o.maxBytes ?? LIMITS.text;
			/** Refused before any socket opens: an off-list command never reaches the server. */
			try {
				assertAdbService(TRANSPORT + serial);
				assertAdbService(EXEC + cmd);
			} catch (error) {
				return Promise.reject(error instanceof Error ? error : new Error(String(error)));
			}
			return exchange(async (socket, reader) => {
				await handshake(socket, reader, serial, cmd);
				const chunks = [];
				let length = 0;
				return new Promise((resolve, reject) => {
					const take = (chunk) => {
						length += chunk.length;
						if (length > maxBytes) socket.destroy(new HelperError("TOOL_FAILED", 502, "The phone sent more than the helper accepts."));
						else chunks.push(chunk);
					};
					/** Bytes that came with the handshake's last packet count against the cap too. */
					take(reader.detach());
					socket.on("data", take);
					socket.on("end", () => resolve(Buffer.concat(chunks)));
					socket.on("error", reject);
					socket.on("close", () => reject(garbled()));
					socket.resume();
				});
			}, {
				signal: o.signal,
				timeoutMs: o.timeoutMs ?? timeouts.adbExec
			});
		},
		execStream(serial, cmd, signal) {
			try {
				assertAdbService(TRANSPORT + serial);
				assertAdbService(EXEC + cmd);
			} catch (error) {
				return Promise.reject(error instanceof Error ? error : new Error(String(error)));
			}
			return exchange(async (socket, reader, keep) => {
				await handshake(socket, reader, serial, cmd);
				const rest = reader.detach();
				if (rest.length) socket.unshift(rest);
				/** Until the caller listens, an error must not become an uncaught exception. */
				socket.on("error", () => void 0);
				keep();
				if (signal.aborted) socket.destroy();
				else signal.addEventListener("abort", () => socket.destroy(), { once: true });
				return socket;
			}, {
				signal,
				timeoutMs: timeouts.adbRequest
			});
		},
		reconnectOffline(signal) {
			return exchange(async (socket, reader) => {
				send(socket, "host:reconnect-offline");
				await readStatus(reader);
			}, {
				signal,
				timeoutMs: timeouts.adbRequest
			});
		},
		tunnel(serial, service, signal) {
			try {
				assertAdbService(TRANSPORT + serial);
				assertTunnelService(service);
			} catch (error) {
				return Promise.reject(error instanceof Error ? error : new Error(String(error)));
			}
			return exchange(async (socket, reader, keep) => {
				send(socket, TRANSPORT + serial);
				await readStatus(reader);
				/** Checked by assertTunnelService above, not by send()'s host allowlist. */
				socket.write(encodeAdbRequest(service));
				await readStatus(reader);
				const rest = reader.detach();
				if (rest.length) socket.unshift(rest);
				/** Until the tunnel listens, an error must not become an uncaught exception. */
				socket.on("error", () => void 0);
				keep();
				if (signal.aborted) socket.destroy();
				else signal.addEventListener("abort", () => socket.destroy(), { once: true });
				return socket;
			}, {
				signal,
				timeoutMs: timeouts.adbRequest
			});
		},
		features(serial, signal) {
			try {
				assertAdbService(TRANSPORT + serial);
			} catch (error) {
				return Promise.reject(error instanceof Error ? error : new Error(String(error)));
			}
			return exchange(async (socket, reader) => {
				send(socket, TRANSPORT + serial);
				await readStatus(reader);
				send(socket, "host:features");
				await readStatus(reader);
				return (await reader.read(await readLength(reader))).toString("utf8").split(",").map((f) => clean(f.trim(), LIMITS.field)).filter(Boolean).slice(0, LIMITS.adbFeatures);
			}, {
				signal,
				timeoutMs: timeouts.adbRequest
			});
		},
		mdnsServices: (signal) => query("host:mdns:services", signal),
		connectNetwork: (host, port, o) => hostText(`host:connect:${networkSerial(host, port)}`, assertConnectService, o),
		pairNetwork: (code, host, port, o) => hostText(`host:pair:${code}:${networkSerial(host, port)}`, assertPairService, o),
		disconnectNetwork: (serial, signal) => hostText(`host:disconnect:${serial}`, assertDisconnectService, {
			signal,
			timeoutMs: timeouts.adbRequest
		}),
		close() {
			for (const socket of open) socket.destroy();
			open.clear();
		}
	};
}
/** Longest first, so `no permissions` wins over a shorter word it might start with. */
const ADB_STATES = [
	"no permissions",
	"unauthorized",
	"authorizing",
	"connecting",
	"bootloader",
	"recovery",
	"sideload",
	"detached",
	"offline",
	"unknown",
	"rescue",
	"device",
	"host"
];
/** Where the `key:value` properties begin after a state with spaces in it. */
const FIRST_PROP = /\s(?:usb|product|model|device|transport_id|features):/;
/**
 * `adb devices -l` text, as the server sends it (no "List of devices attached" header):
 * `<serial padded to 22> <state> usb:1-1 product:tokay model:Pixel_9 device:tokay transport_id:3`.
 * The state is the longest known one the rest starts with: `no permissions (…); see […]`
 * has spaces, parentheses and even a URL in it, and is cut where the properties begin.
 */
function parseDevicesL(text) {
	const rows = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("*") || line.startsWith("List of devices")) continue;
		const match = /^(\S+)\s+(.*)$/.exec(line);
		if (!match) continue;
		const serial = match[1] ?? "";
		const rest = match[2] ?? "";
		const known = ADB_STATES.find((s) => rest === s || rest.startsWith(s + " "));
		let state;
		let props;
		if (known === "no permissions") {
			const at = rest.search(FIRST_PROP);
			state = (at < 0 ? rest : rest.slice(0, at)).trim();
			props = at < 0 ? "" : rest.slice(at);
		} else if (known) {
			state = known;
			props = rest.slice(known.length);
		} else {
			/** A state this helper does not know yet: its first word, mapped to `unknown`. */
			state = rest.split(/\s+/)[0] ?? "";
			props = rest.slice(state.length);
		}
		const record = {};
		for (const token of props.trim().split(/\s+/)) {
			const colon = token.indexOf(":");
			if (colon > 0) record[token.slice(0, colon)] = token.slice(colon + 1);
		}
		rows.push({
			serial,
			state,
			props: record
		});
	}
	return rows;
}
/** §4.3: adb's state → the row's state and its blockers. */
function mapAdbState(state) {
	switch (state) {
		case "device": return {
			state: "ready",
			blockers: []
		};
		case "unauthorized": return {
			state: "unauthorized",
			blockers: ["ANDROID_UNAUTHORIZED"]
		};
		case "authorizing": return {
			state: "authorizing",
			blockers: ["ANDROID_UNAUTHORIZED"]
		};
		case "connecting": return {
			state: "connecting",
			blockers: []
		};
		case "offline": return {
			state: "offline",
			blockers: ["ANDROID_OFFLINE"]
		};
		case "recovery":
		case "rescue":
		case "sideload":
		case "bootloader": return {
			state: "recovery",
			blockers: ["ANDROID_RECOVERY"]
		};
		default: return {
			state: "unknown",
			blockers: []
		};
	}
}
/** §4.3: emulators are the Android side of `simulator`; `ip:port` and mDNS serials are Wi-Fi. */
function adbConnection(serial) {
	if (/^emulator-\d+$/.test(serial)) return "simulator";
	if (/:\d+$/.test(serial) || /\._adb(?:-tls-connect)?\._tcp/.test(serial)) return "network";
	return "usb";
}
/** One devices -l row as the page sees it. */
function androidRow(entry, identity) {
	const { state, blockers } = mapAdbState(entry.state);
	const ready = state === "ready";
	/** The tracker's `model:` has spaces turned into underscores (adb sanitises it). */
	const listed = (entry.props.model ?? "").replace(/_/g, " ");
	const model = identity?.model || listed;
	return {
		id: entry.serial,
		platform: "android",
		connection: adbConnection(entry.serial),
		state,
		name: model,
		model,
		modelId: identity?.device || entry.props.device || "",
		osVersion: identity?.release ?? "",
		blockers,
		capabilities: {
			screenshot: ready,
			identifiers: ready,
			logs: ready,
			install: false
		}
	};
}
/**
 * Which Android devices on this network offer adb, before anything connects to them: the
 * answer to "have you listed every Android device on the Wi-Fi?". adb lists only what it is
 * connected to, so the helper asks the network itself (mdns.ts, read-only queries) and adds
 * what the adb server found on its own (`host:mdns:services`), then marks each one adb
 * already lists. It never connects, pairs or starts a server for this: the page offers those
 * as the tester's own clicks (§4.7).
 *
 * What is offered goes through the same rules as POST /api/android/connect: an address on
 * the local network (parseNetworkHost), never a name (adbd advertises `Android.local` on
 * many devices at once), never public or loopback, and never a link-local IPv6 address,
 * which adb could not reach without the interface the answer came in on.
 */
/** The services that offer adb, by the kind the page shows (§4.8). */
const ADB_SERVICES = {
	adb: "_adb._tcp.local",
	wireless: "_adb-tls-connect._tcp.local",
	pairing: "_adb-tls-pairing._tcp.local"
};
/**
 * Browsed only to put a name on an address: Android TV Remote's instance name is the TV's
 * name ("SONY KD-43X8050H"), and Cast's TXT `fn=` is the name the owner gave it.
 */
const NAME_SERVICES = {
	remote: "_androidtvremote2._tcp.local",
	cast: "_googlecast._tcp.local"
};
/** Everything one scan asks for. */
const NEARBY_SERVICES = [
	...Object.values(ADB_SERVICES),
	NAME_SERVICES.remote,
	NAME_SERVICES.cast
];
const KIND_OF_SERVICE = new Map(Object.entries(ADB_SERVICES).map(([kind, s]) => [s, kind]));
/** `_adb-tls-connect._tcp`, with or without `.local` and a trailing dot, as a kind. */
function kindOfService(service) {
	let name = service.trim().toLowerCase().replace(/\.$/, "");
	if (!name.endsWith(".local")) name += ".local";
	return KIND_OF_SERVICE.get(name);
}
/**
 * An address a device may be offered at: an IP address parseNetworkHost takes, minus
 * link-local IPv6 (no zone travels in an mDNS answer). Normalised, or null.
 */
function offerableAddress(address) {
	if (!IPV4$1.test(address) && !net.isIPv6(address)) return null;
	if (/^fe[89ab]/i.test(address)) return null;
	try {
		return parseNetworkHost(address);
	} catch {
		return null;
	}
}
const validPort = (port) => port !== null && Number.isInteger(port) && port >= 1 && port <= 65535;
const cleanInstance = (instance) => clean(instance, LIMITS.field).trim();
const nameOf = (service) => service.toLowerCase().replace(/\.$/, "");
/** Android's version names by API level, before the version became the level minus 20 (33 → 13). */
const ANDROID_RELEASE = {
	21: "5.0",
	22: "5.1",
	23: "6.0",
	24: "7.0",
	25: "7.1",
	26: "8.0",
	27: "8.1",
	28: "9",
	29: "10",
	30: "11",
	31: "12",
	32: "12L"
};
/** TXT `api=37.1` (adbd's SDK level and minor) as the Android version: "17". */
function androidVersionOfApi(api) {
	const m = /^(\d{2})(?:\.\d{1,3})?$/.exec(api.trim());
	const level = Number(m?.[1]);
	if (!m || level < 21 || level > 60) return void 0;
	return ANDROID_RELEASE[level] ?? String(level - 20);
}
/**
 * What an adb service's TXT says about the device. adbd 13+ advertises Wireless debugging
 * with `given_name=BAULOC Pixel 9 serial=55090DLAQ0026D v=2.1 api=37.1 name=Pixel 9`: the
 * name its owner gave it, the serial, and the model.
 */
function adbTxtDetails(txt) {
	const value = (key) => {
		const entry = txt.find((t) => t.slice(0, key.length + 1).toLowerCase() === `${key}=`);
		return entry === void 0 ? "" : clean(entry.slice(key.length + 1), LIMITS.name).trim();
	};
	const name = value("given_name");
	const model = value("name");
	const serial = value("serial");
	const osVersion = androidVersionOfApi(value("api"));
	return {
		...name ? { name } : {},
		...model ? { model } : {},
		.../^[A-Za-z0-9._-]{1,64}$/.test(serial) ? { serial } : {},
		...osVersion ? { osVersion } : {}
	};
}
/** The adb services a browse found, with an address to offer, and names by address. */
function nearbyFromBrowse(instances) {
	const found = [];
	const names = new Map();
	for (const entry of instances) {
		const service = nameOf(entry.service);
		if (service === NAME_SERVICES.cast || service === NAME_SERVICES.remote) {
			const fn = entry.txt.find((t) => /^fn=/i.test(t))?.slice(3);
			const name = clean(service === NAME_SERVICES.cast ? fn ?? "" : entry.instance, LIMITS.name);
			for (const address of entry.addresses) {
				const host = offerableAddress(address);
				if (!host) continue;
				const known = names.get(host)?.name ?? "";
				/** Cast's fn= is the owner's own name for it: it wins over the Remote's model name. */
				const better = !known || service === NAME_SERVICES.cast && !!name.trim();
				names.set(host, {
					name: better ? name.trim() : known,
					tv: true
				});
			}
			continue;
		}
		const kind = KIND_OF_SERVICE.get(service);
		const instance = cleanInstance(entry.instance);
		const host = entry.addresses.map(offerableAddress).find((a) => a !== null);
		if (!kind || !instance || !host || !validPort(entry.port)) continue;
		found.push({
			kind,
			host,
			port: entry.port,
			instance,
			...adbTxtDetails(entry.txt)
		});
	}
	return {
		found,
		names
	};
}
/**
 * `adb mdns services` as the server sends it, after OKAY and the length: one service per
 * line, `<instance>\t<service type>\t<address>:<port>` (adb 30–36; some versions end the
 * type with a dot). Only the adb services, at an address offerableAddress() takes.
 */
function parseAdbMdnsServices(text) {
	const found = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || /^List of/i.test(line)) continue;
		const tabbed = line.split("	");
		const parts = tabbed.length >= 3 ? tabbed : line.split(/\s+/);
		const instance = cleanInstance(parts[0] ?? "");
		const kind = kindOfService(parts[1] ?? "");
		const match = /^(\[[^\]]+\]|[^\s[\]]+):(\d{1,5})$/.exec((parts[parts.length - 1] ?? "").trim());
		if (!kind || !instance || parts.length < 3 || !match?.[1] || !match[2]) continue;
		const host = offerableAddress(match[1].startsWith("[") ? match[1].slice(1, -1) : match[1]);
		const port = Number(match[2]);
		if (host && validPort(port)) found.push({
			kind,
			host,
			port,
			instance,
			fromAdb: true
		});
	}
	return found;
}
/**
 * The serial an adb instance name carries: adbd names its services `adb-<ro.serialno>`,
 * with `-<6 random characters>` for Wireless debugging (`adb-55090DLAQ0026D-nK25Qn`).
 */
function serialOfInstance(instance) {
	return /^adb-([A-Za-z0-9]{4,64})(?:-[A-Za-z0-9]{6})?$/.exec(instance)?.[1];
}
/**
 * Serials many devices share, so they tell nothing apart: the placeholder ro.serialno cheap
 * TV boxes ship with, and what a build without one reports.
 */
const JUNK_SERIALS = new Set([
	"0123456789abcdef",
	"0000000000000000",
	"unknown"
]);
/** A serial that names one device (lower case), else undefined. */
function distinctSerial(serial) {
	const key = serial?.trim().toLowerCase();
	return key && !JUNK_SERIALS.has(key) ? key : void 0;
}
/** The instance in an mDNS serial adb lists (`adb-…._adb-tls-connect._tcp`), else null. */
function instanceOfSerial(serial) {
	return /^(.+?)\._adb(?:-tls-connect)?\._tcp\.?$/i.exec(serial)?.[1] ?? null;
}
/** The host of a `host:port` network serial (IPv6 without its brackets), else null. */
function hostOfSerial(serial) {
	const match = /^(\[[^\]]+\]|[^:[\]]+):\d{1,5}$/.exec(serial);
	if (!match?.[1]) return null;
	return match[1].startsWith("[") ? match[1].slice(1, -1).toLowerCase() : match[1].toLowerCase();
}
const KIND_ORDER = {
	adb: 0,
	wireless: 1,
	pairing: 2
};
/** IPv4 by number, then IPv6 as text: the order a tester reads a network in. */
function hostOrder(host) {
	if (!IPV4$1.test(host)) return `1${host}`;
	return `0${host.split(".").map((n) => n.padStart(3, "0")).join(".")}`;
}
/**
 * Each service once, the first source's entry winning: by kind and address, by kind and
 * instance, and by kind and serial (Wireless debugging renames its instance each time it is
 * turned on, and adb may still list the old one). The serial counts only on the same host,
 * or when one of the two comes from adb's own list (which may keep an old address too):
 * two cheap TV boxes at different addresses may share one ro.serialno, and a junk serial
 * (`0123456789ABCDEF`, `unknown`) never counts. What a later duplicate adds (a TXT name the
 * first source lacked) fills in what the first one left empty.
 */
function uniqueServices(found) {
	const out = [];
	const byKey = new Map();
	/** kind#serial → the first entry with it from any source / from adb's list. */
	const anySerial = new Map();
	const adbSerial = new Map();
	for (const f of found) {
		const serial = distinctSerial(serialOfInstance(f.instance) ?? f.serial);
		const wide = serial ? `${f.kind}#${serial}` : null;
		const keys = [
			`${f.kind}@${networkSerial(f.host, f.port)}`,
			`${f.kind}|${f.instance.toLowerCase()}`,
			...wide ? [`${wide}@${f.host.toLowerCase()}`] : []
		];
		const kept = keys.map((key) => byKey.get(key)).find((k) => k !== void 0) ?? (wide ? (f.fromAdb ? anySerial : adbSerial).get(wide) : void 0);
		const entry = kept ?? { ...f };
		if (kept) {
			kept.name ||= f.name;
			kept.model ||= f.model;
			kept.serial ||= f.serial;
			kept.osVersion ||= f.osVersion;
		} else out.push(entry);
		for (const key of keys) if (!byKey.has(key)) byKey.set(key, entry);
		if (wide && !anySerial.has(wide)) anySerial.set(wide, entry);
		if (wide && f.fromAdb && !adbSerial.has(wide)) adbSerial.set(wide, entry);
	}
	/** `||=` may have written `undefined` or '' into an optional field. */
	for (const f of out) {
		for (const key of [
			"name",
			"model",
			"serial",
			"osVersion"
		]) if (!f[key]) delete f[key];
		delete f.fromAdb;
	}
	return out;
}
/**
 * What the page gets: each found service once (uniqueServices), named, and compared with
 * the rows adb lists now. A row matches by this host:port, by its mDNS name, by the serial
 * (a phone on a cable is "connected" too, and its row is named), or, for Wireless debugging,
 * by a network row on the same host (the pairing port is not the connect port). Ordered by
 * address, at most `max`.
 */
function mergeNearby(found, names, listed, max = LIMITS.nearby) {
	const rows = listed.filter((row) => ID.android.test(row.serial));
	const out = [];
	for (const f of uniqueServices(found)) {
		const address = networkSerial(f.host, f.port);
		const id = `${f.kind}:${address}`;
		const serial = serialOfInstance(f.instance) ?? f.serial;
		/** A junk serial (shared by many boxes) never matches a row. */
		const matchSerial = distinctSerial(serial) ? serial : void 0;
		const network = rows.filter((row) => adbConnection(row.serial) === "network");
		const mdnsMatch = (row) => {
			const instance = instanceOfSerial(row.serial);
			if (!instance) return false;
			return instance.toLowerCase() === f.instance.toLowerCase() || !!matchSerial && serialOfInstance(instance) === matchSerial;
		};
		const overNetwork = network.find((row) => row.serial === address) ?? network.find(mdnsMatch) ?? (f.kind === "adb" ? void 0 : network.find((row) => hostOfSerial(row.serial) === f.host));
		const row = overNetwork ?? (matchSerial ? rows.find((r) => r.serial === matchSerial) : void 0);
		const named = names.get(f.host);
		out.push({
			id,
			host: f.host,
			port: f.port,
			kind: f.kind,
			instance: f.instance,
			/** The device's own name (TXT given_name) first: Cast's fn= is for a TV without one. */
			name: f.name || (named?.name ?? ""),
			...f.model ? { model: f.model } : {},
			...f.osVersion ? { osVersion: f.osVersion } : {},
			...serial ? { serial } : {},
			tv: named?.tv ?? false,
			connected: !!row,
			...row ? { deviceId: row.serial } : {},
			...f.kind === "adb" ? {} : { paired: !!overNetwork }
		});
	}
	out.sort((a, b) => hostOrder(a.host).localeCompare(hostOrder(b.host)) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.port - b.port);
	return out.slice(0, max);
}
/** The page's wording for a scan that could not run, when it has none of its own. */
const NEARBY_MESSAGE = {
	blocked: `Could not look for devices on the network. ${NETWORK_HINT.blocked}`,
	"no-network": "Could not look for devices on the network: this computer is not connected to one. Turn on Wi-Fi, or plug in a network cable, on the same network as the device.",
	failed: "Could not look for devices on the network."
};
/** The page's wording for a scan the system resolver did instead of the helper's own queries. */
const NEARBY_NOTE = "Looked through this computer's own resolver: the helper's own queries could not reach the network. Connecting may be refused for the same reason; if it is, the helper says how to fix it.";
const NO_SYSTEM$1 = {
	tool: null,
	looked: false,
	instances: []
};
/**
 * Three sources at once: the helper's own queries (mdns.ts), the system's resolver
 * (mdns.ts systemBrowse(): dns-sd, avahi-browse) and adb's own mDNS list, merged in that order
 * (mergeNearby keeps the first of each service and fills in names from the others).
 *
 * `error` only when no source could look: neither the helper's queries left nor the system
 * resolver reached its daemon. adb's list does not count: whether its own mDNS works says
 * nothing that can be checked from here. When the resolver looked although the helper's
 * queries could not leave, the scan is complete and `note` says that connecting may still be
 * refused; a connect that is says so itself, with the `blocked` wording (§4.7).
 */
async function scanNearby(o) {
	const startedAt = o.now();
	const [browsed, system, adbText] = await Promise.all([
		browse({
			services: NEARBY_SERVICES,
			open: o.open,
			windowMs: o.windowMs,
			signal: o.signal
		}),
		(o.system?.(o.signal) ?? Promise.resolve(NO_SYSTEM$1)).catch(() => NO_SYSTEM$1),
		o.adbList().catch(() => "")
	]);
	const { found, names } = nearbyFromBrowse([...browsed.instances, ...system.instances]);
	const failure = browsed.failure;
	const said = failure ? {
		reason: failure.reason,
		message: system.looked ? NEARBY_NOTE : NEARBY_MESSAGE[failure.reason],
		detail: failure.detail
	} : null;
	/** Both sources failed: the resolver's own words go beside the socket's. */
	const systemDetail = said && !system.looked && system.detail ? system.detail : void 0;
	return {
		startedAt,
		found: [...found, ...parseAdbMdnsServices(adbText)],
		names,
		system: system.looked ? system.tool : null,
		...said && !system.looked ? { error: systemDetail ? {
			...said,
			detail: `${said.detail}; ${systemDetail}`
		} : said } : {},
		...systemDetail ? { systemDetail } : {},
		...said && system.looked ? { note: said } : {}
	};
}
/** The system resolver for a lane: the tool this computer has, through the bridge's runner. */
function systemResolver(ctx) {
	return (signal) => systemBrowse({
		services: NEARBY_SERVICES,
		tools: systemMdnsTools(ctx.options),
		streamTool: ctx.streamTool,
		browseMs: ctx.timeouts.systemBrowse,
		resolveMs: ctx.timeouts.systemResolve,
		signal
	});
}
/** The terminal's one line for what a scan found: one device per address. */
function nearbySummary(devices) {
	const hosts = new Map();
	for (const d of devices) {
		const entry = hosts.get(d.host) ?? {
			tv: false,
			wireless: false,
			connected: false
		};
		entry.tv ||= d.tv;
		entry.wireless ||= d.kind !== "adb";
		entry.connected ||= d.connected;
		hosts.set(d.host, entry);
	}
	if (!hosts.size) return "Wi-Fi: no Android device on this network advertises Network or Wireless debugging";
	const all = [...hosts.values()];
	const tvs = all.filter((h) => h.tv).length;
	const wireless = all.filter((h) => !h.tv && h.wireless).length;
	const network = all.length - tvs - wireless;
	const parts = [
		tvs ? plural(tvs, "TV") : "",
		wireless ? `${String(wireless)} with Wireless debugging` : "",
		network ? `${String(network)} with Network debugging` : ""
	].filter(Boolean);
	const connected = all.filter((h) => h.connected).length;
	return `Wi-Fi: ${plural(hosts.size, "Android device")} on this network (${parts.join(", ")})${connected ? `, ${String(connected)} already connected` : ""}`;
}
const KIND_LABEL = {
	adb: "Network debugging",
	wireless: "Wireless debugging",
	pairing: "pairing screen open"
};
/**
 * --doctor: one indented line per found service, named by its model, else its instance
 * (`adb-<serial>…`), never by the name its owner gave it (T18: the output is pasted into PRs).
 */
function nearbyLines(devices) {
	return devices.map((d) => clean(`  ${[
		d.model || d.instance,
		networkSerial(d.host, d.port),
		KIND_LABEL[d.kind],
		...d.osVersion ? [`Android ${d.osVersion}`] : [],
		d.connected ? `listed as ${String(d.deviceId)}` : "not connected"
	].join(" · ")}`, 300));
}
/**
 * The terminal's line when the system resolver looked although the helper's own queries could
 * not leave: not an error, and not the blocked wording, which waits for a connect that fails.
 */
function nearbyNoteLine(note, tool) {
	return clean(`Wi-Fi: looked through ${tool ?? "the system resolver"}; the helper's own mDNS queries could not leave (${note.detail}), so connecting may be refused too`, 300);
}
/**
 * The terminal lines for a scan that could not run: `blocked` names its causes and fixes.
 * `systemDetail` (NearbyScan): why the system resolver could not look either, on its own line.
 */
function nearbyFailureLines(error, platform, systemDetail) {
	const head = "Wi-Fi: could not look for Android devices on the network";
	/** What the socket said, without the resolver's words that scanNearby appended. */
	const tail = systemDetail ? `; ${systemDetail}` : "";
	const socket = tail && error.detail.endsWith(tail) ? error.detail.slice(0, -tail.length) : error.detail;
	const resolver = systemDetail ? [clean(`  The system resolver could not look either: ${systemDetail}`, 300)] : [];
	if (error.reason === "blocked") return [...blockedLines(head, /EPERM|EACCES/.test(socket) ? "not permitted" : "no route to host", platform), ...resolver];
	if (error.reason === "no-network") return [`${head}: this computer is not on a network`, ...resolver];
	return [`${head}: ${socket}`, ...resolver];
}
/**
 * §4.5, on an explicit click only: `adb start-server`, then wait for `host:version`.
 *
 * The CLI forks the server as a daemon and exits. It runs detached, with stdio ignored and
 * without being tracked, on purpose: the daemon must not inherit our pipes (it would hold
 * them open for its whole life) and must never be in a process group the helper kills at
 * exit. The server outlives the helper, as the exit message tells the tester.
 */
async function startAdbServer(adbPath, opts) {
	const { port, timeouts, signal } = opts;
	let spawnError = null;
	const child = spawn(adbPath, ["start-server"], {
		stdio: "ignore",
		detached: true,
		env: {
			...opts.env,
			ANDROID_ADB_SERVER_PORT: String(port)
		}
	});
	child.on("error", (error) => {
		spawnError = error;
	});
	child.unref();
	opts.onSpawned?.();
	const client = createAdbClient({
		port,
		timeouts
	});
	const deadline = Date.now() + timeouts.adbStartPoll;
	for (;;) {
		if (spawnError !== null) {
			const error = spawnError;
			if (error.code === "ENOENT") throw new HelperError("TOOL_MISSING", 503, "adb is not installed.", {
				tool: "adb",
				install: INSTALL.adb
			});
			throw new HelperError("TOOL_FAILED", 502, `adb could not be started: ${error.message}`);
		}
		if (await client.version(signal).catch(() => null) !== null) return;
		if (signal?.aborted) throw abortError();
		if (Date.now() >= deadline) break;
		await sleep(Math.min(opts.pollMs ?? 250, Math.max(0, deadline - Date.now())), signal);
	}
	throw new HelperError("ADB_START_FAILED", 502, `adb start-server ran, but no adb server answered within ${seconds(timeouts.adbStartPoll)} s.`);
}
const ANDROID_CADENCE = {
	presenceMs: 5e3,
	pollMs: 2e3,
	identityGraceMs: 1500,
	retryWaitMs: 3e3,
	goneWaitMs: 1e3,
	startPollMs: 250,
	lookupMs: 5e3,
	leavingMs: 1e4,
	nearbyCacheMs: 2e4,
	nearbyGapMs: 3e3
};
const LOGCAT = "logcat -v threadtime -T 200";
const IDENTITY_PROPS = {
	model: "getprop ro.product.model",
	device: "getprop ro.product.device",
	release: "getprop ro.build.version.release"
};
/**
 * The Android lane (§4): presence probe, hot-plug tracker, identity cache, and the four
 * operations, all over the host protocol. `cadence` exists for tests.
 */
function createAndroidLane(ctx, options = {}) {
	const { lookup = systemLookup, ...cadence } = options;
	const pace = {
		...ANDROID_CADENCE,
		...cadence
	};
	const { timeouts } = ctx;
	const port = ctx.options.adbPort;
	const client = createAdbClient({
		port,
		timeouts
	});
	const flights = singleFlight();
	let running = false;
	let protocol = null;
	let startedByHelper = false;
	/** We ran `adb start-server`: a server that appears from now on is the helper's doing. */
	let spawned = false;
	let toolbox = null;
	let entries = [];
	let closeTracker = null;
	/** The server refused `track-devices-l`: poll `devices-l` instead. */
	let polling = false;
	let timer;
	let graceTimer;
	let stopped = false;
	/** The serials of the rows published last. */
	let published = new Set();
	/** Keyed by serial + transport_id: a phone that reconnects gets a new id and a fresh look. */
	const identities = new Map();
	/**
	 * Network serials the tester disconnected (POST /api/android/disconnect), each until when.
	 * adb lists such a device `offline` for a moment before it lets go: that is not a device
	 * that stopped answering, so its row goes at once, and its line says "disconnected".
	 */
	const leaving = new Map();
	let leavingTimer;
	/** The last Wi-Fi scan (§4.8), and the terminal lines last printed for one. */
	let lastScan = null;
	let scanReported = "";
	/** Called after every list the lane takes in: open streams watch their device's state. */
	const watchers = new Set();
	const watch = (watcher) => {
		watchers.add(watcher);
		return () => watchers.delete(watcher);
	};
	const identityKey = (entry) => `${entry.serial}#${entry.props.transport_id ?? ""}`;
	const identityOf = (entry) => {
		const slot = identities.get(identityKey(entry));
		return slot?.status === "done" ? slot.identity : null;
	};
	/** Three getprop calls, 10 s each; any that fails leaves its field to the tracker's value. */
	const fetchIdentity = async (entry) => {
		const key = identityKey(entry);
		identities.set(key, {
			status: "pending",
			since: ctx.now()
		});
		const read = (cmd) => client.exec(entry.serial, cmd, {
			signal: ctx.signal,
			timeoutMs: timeouts.adbExec
		}).then((bytes) => clean(bytes.toString("utf8").trim(), LIMITS.field));
		const [model, device, release] = await Promise.allSettled([
			read(IDENTITY_PROPS.model),
			read(IDENTITY_PROPS.device),
			read(IDENTITY_PROPS.release)
		]);
		const value = (r) => r.status === "fulfilled" ? r.value : "";
		const identity = {
			model: value(model),
			device: value(device),
			release: value(release)
		};
		if (stopped || !identities.has(key)) return;
		identities.set(key, identity.model || identity.device || identity.release ? {
			status: "done",
			identity
		} : { status: "failed" });
		render();
	};
	/**
	 * Publish what the server lists. A phone that just became ready is held back until its
	 * identity arrives (or the grace period ends), so its one arrival line reads
	 * "+ Pixel 9 (…) · Android 17 · USB · ready via adb" instead of the tracker's "Pixel_9".
	 * Only one not listed yet: a row already shown (a TV that was `unauthorized` until the
	 * tester chose Allow) stays, rather than vanishing for the grace period and coming back.
	 */
	function render() {
		if (stopped) return;
		const listed = new Set(entries.map(identityKey));
		for (const key of [...identities.keys()]) if (!listed.has(key)) identities.delete(key);
		for (const [serial, until] of leaving) if (until <= ctx.now()) leaving.delete(serial);
		const rows = [];
		let waitMs = Infinity;
		for (const entry of entries) {
			/** Ids no request could address (Linux's `????????????` for a phone without permission). */
			if (!ID.android.test(entry.serial)) continue;
			if (leaving.has(entry.serial) && entry.state !== "device") continue;
			if (entry.state === "device") {
				const shown = published.has(entry.serial);
				const slot = identities.get(identityKey(entry));
				if (!slot) {
					fetchIdentity(entry);
					if (!shown) {
						waitMs = Math.min(waitMs, pace.identityGraceMs);
						continue;
					}
				} else if (slot.status === "pending" && !shown) {
					const left = slot.since + pace.identityGraceMs - ctx.now();
					if (left > 0) {
						waitMs = Math.min(waitMs, left);
						continue;
					}
				}
			}
			rows.push(androidRow(entry, identityOf(entry)));
		}
		const shown = new Set(rows.map((row) => row.id));
		const departures = {};
		for (const serial of published) if (!shown.has(serial) && leaving.has(serial)) departures[serial] = "disconnected";
		published = shown;
		/** adb let go of it: a later connect to the same address is a new device. */
		for (const serial of leaving.keys()) if (!entries.some((e) => e.serial === serial)) leaving.delete(serial);
		clearTimeout(graceTimer);
		if (waitMs !== Infinity) {
			graceTimer = setTimeout(render, waitMs + 5);
			graceTimer.unref();
		}
		ctx.publish("android", rows, departures);
		for (const watcher of [...watchers]) watcher();
	}
	const adbState = () => ({ adb: toolbox?.adb ? "found" : "missing" });
	const loadTools = () => ctx.tools.get().then((t) => {
		toolbox = t;
	}, () => void 0);
	/**
	 * The tools again (cached 30 s by the bridge): adb installed or removed since tells the page
	 * at once, rather than when the tester next presses Refresh or restarts the helper.
	 */
	const syncTools = async () => {
		const before = adbState().adb;
		await loadTools();
		if (!stopped && adbState().adb !== before) ctx.setLane("android", adbState());
	};
	function serverUp(version) {
		running = true;
		protocol = version;
		if (spawned) startedByHelper = true;
		if (!closeTracker && !polling) openTracker();
		ctx.setLane("android", {
			status: "ok",
			serverProtocol: version,
			startedByHelper,
			reason: void 0,
			...adbState()
		});
	}
	function serverGone() {
		closeTracker?.();
		closeTracker = null;
		polling = false;
		running = false;
		protocol = null;
		startedByHelper = false;
		spawned = false;
		entries = [];
		render();
		ctx.setLane("android", {
			status: "stopped",
			serverProtocol: void 0,
			startedByHelper: false,
			reason: void 0,
			...adbState()
		});
	}
	function serverOdd(error) {
		closeTracker?.();
		closeTracker = null;
		running = false;
		protocol = null;
		entries = [];
		render();
		ctx.setLane("android", {
			status: "error",
			serverProtocol: void 0,
			reason: `something on port ${String(port)} answers, but not as an adb server (${errorText(error)})`,
			...adbState()
		});
	}
	function openTracker() {
		let opened = true;
		const openedAt = Date.now();
		closeTracker = client.track((text) => {
			entries = parseDevicesL(text);
			render();
		}, (error) => {
			if (!opened) return;
			opened = false;
			closeTracker = null;
			if (stopped) return;
			/** FAIL: an old or odd server without the tracker; poll devices-l every 2 s instead. */
			if (isAdbRefusal(error) && running) {
				polling = true;
				relist();
				return;
			}
			/**
			 * The socket ended: most likely the server stopped, so find out now rather than in
			 * 5 s. A tracker that died at once is left to the presence probe, so a server that
			 * keeps dropping it cannot spin this lane in a loop.
			 */
			if (Date.now() - openedAt > 1e3) probe();
		});
	}
	/** `host:version`: is a server there, and what speaks on the port. */
	const probe = () => flights.run("probe", async () => {
		if (stopped) return;
		let version;
		try {
			/** Never a request's signal: a page that leaves must not make the server look odd. */
			version = await client.version(ctx.signal);
		} catch (error) {
			if (!stopped && !ctx.signal.aborted) serverOdd(error);
			return;
		}
		if (stopped) return;
		if (version === null) {
			if (running || entries.length) serverGone();
			else if (protocol === null) ctx.setLane("android", {
				status: "stopped",
				...adbState()
			});
			return;
		}
		serverUp(version);
	});
	/** `host:devices-l` now: Refresh, Retry, and the tracker-less fallback. */
	const relist = () => flights.run("relist", async () => {
		if (stopped) return;
		try {
			entries = parseDevicesL(await client.devicesL(ctx.signal));
			render();
		} catch (error) {
			if (error instanceof HelperError && error.code === "ADB_SERVER_STOPPED") serverGone();
		}
	});
	function schedule() {
		if (stopped) return;
		const ms = polling && running ? pace.pollMs : pace.presenceMs;
		timer = setTimeout(() => {
			/**
			 * A live tracker needs nothing; otherwise poll the list, or look for a server. Every
			 * tick also re-reads the tools, so `adb` follows an install.
			 */
			const work = closeTracker ? Promise.resolve() : polling && running ? relist() : probe();
			Promise.all([work, syncTools()]).finally(schedule);
		}, ms);
		timer.unref();
	}
	/** An operation that found the server gone makes the lane find out at once. */
	const noticeServer = (error) => {
		if (error instanceof HelperError && error.code === "ADB_SERVER_STOPPED") probe();
		throw error;
	};
	const entryOf = (id) => {
		const entry = entries.find((e) => e.serial === id);
		if (!entry) throw new HelperError("DEVICE_NOT_FOUND", 404, "The device is no longer connected.");
		return entry;
	};
	/** Resolves once `check` holds, or after `ms`, or when `signal` aborts. */
	const waitFor = async (check, ms, signal) => {
		const until = Date.now() + ms;
		while (!check() && Date.now() < until && !signal?.aborted && !stopped) await sleep(25, signal).catch(() => void 0);
	};
	/** Listed by the tracker and, when ready, published (its identity settled or given up). */
	const settledRow = (serial) => {
		const now = entries.find((e) => e.serial === serial);
		if (!now) return false;
		return now.state !== "device" || identities.get(identityKey(now))?.status !== "pending";
	};
	/** The tracker reports changes by itself; without one (polling), ask now. */
	const freshList = async () => {
		if (!closeTracker) await relist();
	};
	/**
	 * The Wi-Fi services go only to a server this lane knows: never a guess at whatever answers
	 * on the port, and never one started for them (starting one is the tester's own click).
	 */
	const requireServer = async () => {
		if (!running) await probe();
		if (running) return;
		throw new HelperError("ADB_SERVER_STOPPED", 503, "Google's adb server isn't running, and Wi-Fi devices go through it. Start it with Start adb server.");
	};
	/**
	 * "failed to authenticate to X" on a first connect: a TV with Network debugging is listed
	 * `unauthorized` and asks "Allow debugging?" — connected, as far as the tester is concerned,
	 * and the page shows the Allow step. Only a device the server does not list (Wireless
	 * debugging, never paired with this Mac) needs a pairing code first.
	 */
	const awaitingAllow = async (reply, target) => {
		const said = reply.text.trim();
		const named = /^failed to authenticate to (\S+)$/i.exec(said)?.[1];
		const serial = named && ID.android.test(named) ? named : target;
		await relist();
		if (!entries.some((e) => e.serial === serial)) throw connectFailed(target, "unpaired", said);
		return {
			result: "connected",
			serial,
			message: clean(said, 300)
		};
	};
	/** One connect or pairing per host at a time (§4.7); a second one is refused, not queued. */
	const dialling = new Set();
	const dial = async (host, fn) => {
		const key = host.toLowerCase();
		if (dialling.has(key)) throw new HelperError("BUSY", 409, `The helper is already connecting to ${host}.`);
		dialling.add(key);
		try {
			return await fn();
		} finally {
			dialling.delete(key);
		}
	};
	/**
	 * One scan at a time (a second caller joins it). Never a request's signal: a page that
	 * leaves must not cut short the scan another request is waiting for.
	 */
	const scanNow = () => flights.run("nearby", async () => {
		const scan = await scanNearby({
			open: ctx.options.mdns,
			windowMs: timeouts.mdnsWindow,
			signal: ctx.signal,
			now: ctx.now,
			adbList: () => running ? client.mdnsServices(ctx.signal) : Promise.resolve(""),
			system: systemResolver(ctx)
		});
		if (!stopped) lastScan = scan;
		return scan;
	});
	/** The scan's lines in the terminal, when they differ from the last ones printed. */
	const reportScan = (result, scan) => {
		const lines = result.error ? [...nearbyFailureLines(result.error, ctx.options.platform, scan.systemDetail), ...result.devices.length ? [nearbySummary(result.devices)] : []] : [...result.note ? [nearbyNoteLine(result.note, scan.system)] : [], nearbySummary(result.devices)];
		const key = lines.join("\n");
		if (key === scanReported) return;
		scanReported = key;
		for (const line of lines) ctx.log(line);
	};
	return {
		name: "android",
		start() {
			/**
			 * One combined first report: the registry prints nothing for a lane's first state, so
			 * a server already running at startup is described by the banner, not a log line.
			 */
			Promise.all([loadTools(), client.version(ctx.signal).catch((error) => error)]).then(([, version]) => {
				if (stopped) return;
				if (typeof version === "number") serverUp(version);
				else if (version === null) ctx.setLane("android", {
					status: "stopped",
					...adbState()
				});
				else serverOdd(version);
			}).finally(schedule);
		},
		async stop() {
			stopped = true;
			clearTimeout(timer);
			clearTimeout(graceTimer);
			clearTimeout(leavingTimer);
			closeTracker?.();
			closeTracker = null;
			client.close();
			await Promise.resolve();
		},
		async rescan() {
			await loadTools();
			if (running) {
				ctx.setLane("android", adbState());
				await relist();
			} else await probe();
		},
		async detail(id, signal) {
			const entry = entryOf(id);
			/** Six constant commands in parallel; one that fails reads as '', exactly as on WebUSB. */
			const results = await Promise.allSettled(ADB_DETAIL.map(([, cmd]) => client.exec(id, cmd, {
				signal,
				timeoutMs: timeouts.adbExec
			}).then((b) => b.toString("utf8"))));
			if (signal.aborted) throw abortError();
			if (results.every((r) => r.status === "rejected")) {
				/** Nothing answered: say why (unplugged, unauthorized, no server) instead of a blank pane. */
				const first = results[0];
				if (first?.status === "rejected") noticeServer(first.reason);
			}
			const outputs = Object.fromEntries(ADB_DETAIL.map(([key], i) => {
				const r = results[i];
				return [key, r?.status === "fulfilled" ? r.value : ""];
			}));
			return {
				platform: "android",
				kind: "android",
				serial: id,
				connection: adbConnection(entry.serial),
				outputs
			};
		},
		async screenshot(id, signal) {
			entryOf(id);
			const bytes = await client.exec(id, "screencap -p", {
				signal,
				maxBytes: LIMITS.png,
				timeoutMs: timeouts.adbScreencap
			}).catch(noticeServer);
			/** screencap warns about phones with two displays before the image: cut it out. */
			const png = extractPng(bytes);
			if (!png) throw new HelperError("SCREENSHOT_NOT_PNG", 502, "The phone returned something that is not a PNG.");
			return {
				png,
				source: "adb"
			};
		},
		async logs(id, sink, signal) {
			entryOf(id);
			const socket = await client.execStream(id, LOGCAT, signal).catch(noticeServer);
			sink.hello("logcat");
			const listedReady = () => entries.find((e) => e.serial === id)?.state === "device";
			/**
			 * A TV that leaves the Wi-Fi goes `offline` first, and its logcat socket can stay open,
			 * silent, until adb gives up on it. End the stream as soon as the tracker says so.
			 */
			const unwatch = watch(() => {
				if (!listedReady()) socket.destroy();
			});
			try {
				await new Promise((resolve) => {
					let waiting = false;
					const lines = splitLines((batch) => {
						if (sink.push(batch) || waiting) return;
						/** Back-pressure: stop reading the phone until the page has taken what it has. */
						waiting = true;
						socket.pause();
						sink.drain().then(() => {
							waiting = false;
							if (!socket.destroyed) socket.resume();
						});
					});
					socket.on("data", (chunk) => lines.write(chunk));
					socket.on("end", () => lines.end());
					socket.on("error", () => void 0);
					socket.on("close", () => resolve());
					socket.resume();
				});
			} finally {
				unwatch();
			}
			if (signal.aborted) return;
			/**
			 * adbd ends logcat when the phone goes away, a moment before the tracker says so. Wait
			 * for the tracker, so the stream ends as `device-gone` (the registry tells the HTTP
			 * layer) rather than a plain `eof`.
			 */
			await waitFor(() => !listedReady(), pace.goneWaitMs, signal);
			const now = entries.find((e) => e.serial === id);
			/**
			 * Still listed, but no longer ready: a device that dropped off the network (or stopped
			 * answering on its cable) before the server lets go of it. That is a drop too, and
			 * the page words it as one, not as a log that simply ended.
			 */
			if (now && now.state !== "device" && !leaving.has(id) && !signal.aborted) throw new HelperError("DEVICE_DROPPED", 503, adbConnection(id) === "network" ? "The device dropped off the network." : "The phone stopped answering.");
		},
		async adbInfo(id, signal) {
			entryOf(id);
			return {
				serial: id,
				features: await client.features(id, signal).catch(noticeServer)
			};
		},
		async openTunnel(id, service, signal) {
			entryOf(id);
			return client.tunnel(id, service, signal).catch(noticeServer);
		},
		async retry(id, signal) {
			const entry = entries.find((e) => e.serial === id);
			if (!running) return probe();
			/** A phone whose identity failed gets a fresh look on Retry. */
			for (const [key, slot] of identities) if (key.startsWith(`${id}#`) && slot.status === "failed") identities.delete(key);
			if (entry && [
				"offline",
				"unauthorized",
				"authorizing"
			].includes(entry.state))
 /** Resets offline and unauthorized transports: the phone asks "Allow USB debugging?" again. */
			await client.reconnectOffline(signal).catch(noticeServer);
			else await relist();
			render();
			/** Until the tracker lists the phone as ready and published (its identity settled). */
			const settled = () => {
				const now = entries.find((e) => e.serial === id);
				if (now?.state !== "device") return false;
				return identities.get(identityKey(now))?.status !== "pending";
			};
			await waitFor(settled, pace.retryWaitMs, signal);
		},
		async connectNetwork({ host, port }, signal) {
			const target = networkSerial(host, port);
			return dial(host, async () => {
				await requireServer();
				leaving.delete(target);
				let outcome;
				try {
					await checkResolvedName(host, lookup, pace.lookupMs, (reason) => connectFailed(target, reason));
					const reply = await client.connectNetwork(host, port, {
						signal,
						timeoutMs: timeouts.adbNetworkConnect
					}).catch((error) => {
						if (error instanceof HelperError && error.code === "TOOL_TIMEOUT") throw connectFailed(target, "timeout");
						return noticeServer(error);
					});
					outcome = isAuthenticateReply(reply) ? await awaitingAllow(reply, target) : parseConnectReply(reply, target);
				} catch (error) {
					if (error instanceof HelperError && error.code === "ANDROID_CONNECT_FAILED") {
						const head = `Wi-Fi: could not connect to ${target}`;
						for (const line of networkFailureLines(head, error, ctx.options.platform)) ctx.log(line);
					}
					throw error;
				}
				ctx.log(`Wi-Fi: ${outcome.result === "connected" ? "connected to" : "already connected to"} ${outcome.serial}`);
				/** The tracker lists it a moment later, usually `unauthorized` until the TV allows it. */
				await freshList();
				await waitFor(() => settledRow(outcome.serial), pace.retryWaitMs, signal);
				return outcome;
			});
		},
		async pairNetwork({ host, port, code }, signal) {
			const target = networkSerial(host, port);
			return dial(host, async () => {
				await requireServer();
				let outcome;
				try {
					await checkResolvedName(host, lookup, pace.lookupMs, (reason) => pairFailed(target, reason));
					outcome = parsePairReply(await client.pairNetwork(code, host, port, {
						signal,
						timeoutMs: timeouts.adbPair
					}).catch((error) => {
						if (error instanceof HelperError && error.code === "TOOL_TIMEOUT") throw pairFailed(target, "timeout");
						return noticeServer(error);
					}), target);
				} catch (error) {
					/** Never the code: it is a one-time secret, and the terminal is pasted into bug reports. */
					if (error instanceof HelperError && error.code === "ANDROID_PAIR_FAILED") {
						const head = `Wi-Fi: could not pair with ${target}`;
						for (const line of networkFailureLines(head, error, ctx.options.platform)) ctx.log(line);
					}
					throw error;
				}
				ctx.log(`Wi-Fi: paired with ${target}`);
				return outcome;
			});
		},
		async disconnectNetwork(serial, signal) {
			if (!isNetworkSerial(serial)) throw badRequest("Only a device connected over Wi-Fi can be disconnected here.");
			if (!isDisconnectableSerial(serial)) throw badRequest("Only a device connected by its address (like 192.168.1.20:5555) can be disconnected here.");
			await requireServer();
			if (!entries.some((e) => e.serial === serial)) throw badRequest("That device isn’t connected over Wi-Fi any more.");
			/** Before it is sent: the tracker may say `offline` before the answer arrives. */
			leaving.set(serial, ctx.now() + pace.leavingMs);
			let outcome;
			try {
				outcome = parseDisconnectReply(await client.disconnectNetwork(serial, signal).catch(noticeServer));
			} catch (error) {
				leaving.delete(serial);
				render();
				throw error;
			}
			ctx.log(`Wi-Fi: disconnected ${serial}`);
			/** A device adb still lists `offline` when the time is up is shown again, as it is. */
			clearTimeout(leavingTimer);
			leavingTimer = setTimeout(render, pace.leavingMs + 5);
			leavingTimer.unref();
			await freshList();
			await waitFor(() => !entries.some((e) => e.serial === serial), pace.retryWaitMs, signal);
			return outcome;
		},
		async nearby(refresh, signal) {
			const age = lastScan ? ctx.now() - lastScan.startedAt : Infinity;
			const stale = age >= pace.nearbyCacheMs || refresh && age >= pace.nearbyGapMs;
			if (flights.has("nearby") || stale) {
				await Promise.race([scanNow(), aborted(signal)]);
				if (signal.aborted) throw abortError();
			}
			const scan = lastScan;
			if (!scan) throw abortError();
			/** Compared with what adb lists now, not when the scan ran: a connect shows at once. */
			const result = {
				devices: mergeNearby(scan.found, scan.names, entries),
				scannedAt: scan.startedAt,
				...scan.error ? { error: scan.error } : {},
				...scan.note ? { note: scan.note } : {}
			};
			reportScan(result, scan);
			return result;
		},
		async startServer(signal) {
			await loadTools();
			const adb = toolbox?.adb?.path;
			if (!adb) throw new HelperError("TOOL_MISSING", 503, "adb is not installed.", {
				tool: "adb",
				install: INSTALL.adb
			});
			/** Already there (an IDE started one meanwhile): share it, start nothing. */
			if (await client.version(signal) !== null) return probe();
			await startAdbServer(adb, {
				port,
				timeouts,
				env: ctx.childEnv(),
				signal,
				pollMs: pace.startPollMs,
				onSpawned: () => {
					spawned = true;
				}
			});
			await probe();
		},
		/**
		 * --doctor (§1.9): the server's state and its `devices -l` rows, asked directly, since
		 * the lane is not running in that mode. Read-only: two host services, nothing started.
		 */
		async probeForDoctor(write) {
			const where = `127.0.0.1:${String(port)}`;
			const deadline = linkSignals([ctx.signal], timeouts.doctorTotal);
			/** Its own client: closing it must never touch a running lane's tracker. */
			const doctor = createAdbClient({
				port,
				timeouts
			});
			let rows = [];
			let server = false;
			try {
				const version = await doctor.version(deadline.signal).catch((error) => error);
				if (version === null) write(`Android: no adb server on ${where} (the doctor never starts one)`);
				else if (typeof version !== "number") write(`Android: something on ${where} answers, but not as an adb server`);
				else {
					server = true;
					write(`Android: adb server on ${where}, protocol ${String(version)}`);
					rows = parseDevicesL(await doctor.devicesL(deadline.signal));
					write(`Android: ${String(rows.length)} device(s) listed by the adb server`);
					for (const row of rows) {
						const props = Object.entries(row.props).map(([key, value]) => `${key}:${value}`);
						write(clean(`  ${[
							row.serial,
							row.state,
							...props
						].join(" · ")}`, 300));
					}
				}
				/** §4.8: what advertises adb on the network, with or without a server. */
				const scan = await scanNearby({
					open: ctx.options.mdns,
					windowMs: timeouts.mdnsWindow,
					signal: deadline.signal,
					now: ctx.now,
					adbList: () => server ? doctor.mdnsServices(deadline.signal) : Promise.resolve(""),
					system: systemResolver(ctx)
				});
				const devices = mergeNearby(scan.found, scan.names, rows);
				if (scan.error) for (const line of nearbyFailureLines(scan.error, ctx.options.platform, scan.systemDetail)) write(line);
				if (scan.note) write(nearbyNoteLine(scan.note, scan.system));
				if (!scan.error || devices.length) {
					write(nearbySummary(devices));
					for (const line of nearbyLines(devices)) write(line);
				}
			} finally {
				deadline.dispose();
				doctor.close();
			}
		},
		facts: () => ({
			adb: toolbox?.adb?.path ?? null,
			version: toolbox?.adb?.version ?? null,
			server: running ? "running" : "stopped",
			serverProtocol: protocol,
			devices: entries.map((entry) => ({
				serial: entry.serial,
				state: entry.state,
				model: androidRow(entry, identityOf(entry)).model
			})),
			startedByHelper
		})
	};
}

//#endregion
//#region src/registry.ts
/** Lane order breaks ties when two lanes list one id (they never should). */
const LANE_ORDER = [
	"ios",
	"android",
	"simulators"
];
/** The page's STATE_WEIGHT order, so `curl /api/devices` reads the way the page sorts. */
const STATE_ORDER = {
	ready: 10,
	connecting: 30,
	authorizing: 40,
	locked: 50,
	unauthorized: 60,
	untrusted: 60,
	offline: 70,
	recovery: 80,
	unknown: 90
};
/** Lanes before any lane has reported: off when not started, unavailable off macOS. */
function initialLanes(opts) {
	const darwin = opts.platform === "darwin";
	return {
		ios: {
			status: "unavailable",
			screenshots: "none",
			xcode: "not-installed",
			wifi: opts.wifi,
			wifiHidden: 0,
			...darwin ? {} : { reason: "iPhones need macOS." }
		},
		android: opts.android ? {
			status: "stopped",
			adb: "missing",
			startedByHelper: false
		} : {
			status: "off",
			adb: "missing",
			startedByHelper: false
		},
		simulators: opts.simulators && darwin ? {
			status: "unavailable",
			booted: 0
		} : opts.simulators ? {
			status: "unavailable",
			booted: 0,
			reason: "Simulators need macOS."
		} : {
			status: "off",
			booted: 0
		}
	};
}
/**
 * A row as the page may see it: text cleaned and capped (names come from devices), blocker
 * codes well-formed and unique, `install` always false in protocol 1. null for an id no
 * request could ever address: that is a lane bug, reported once and dropped.
 */
function normalizeRow(row) {
	if (typeof row.id !== "string" || !isDeviceId(row.id)) return null;
	return {
		id: row.id,
		platform: row.platform,
		connection: row.connection,
		state: row.state,
		name: clean(row.name, LIMITS.name),
		model: clean(row.model, LIMITS.field),
		modelId: clean(row.modelId, LIMITS.field),
		osVersion: clean(row.osVersion, LIMITS.field),
		blockers: [...new Set(row.blockers.filter((code) => /^[A-Z0-9_]{1,40}$/.test(code)))],
		capabilities: {
			screenshot: row.capabilities.screenshot === true,
			identifiers: row.capabilities.identifiers === true,
			logs: row.capabilities.logs === true,
			install: false
		}
	};
}
function sortRows(rows) {
	return rows.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
const IOS_WORDS = {
	ready: "trusted",
	connecting: "connecting",
	authorizing: "waiting for Trust",
	locked: "locked since it restarted",
	unauthorized: "waiting for Trust",
	untrusted: "waiting for Trust",
	offline: "not answering",
	recovery: "in recovery",
	unknown: "not answering as an iPhone"
};
const ANDROID_WORDS = {
	ready: "ready via adb",
	connecting: "connecting",
	authorizing: "waiting for \"Allow USB debugging?\"",
	locked: "locked",
	unauthorized: "waiting for \"Allow USB debugging?\"",
	untrusted: "waiting for \"Allow USB debugging?\"",
	offline: "offline",
	recovery: "in recovery or bootloader mode",
	unknown: "state unknown"
};
/** An Android device on Wi-Fi (§4.7) is asked "Allow debugging?", and has no cable to reseat. */
const ANDROID_NETWORK_WORDS = {
	authorizing: "waiting for \"Allow debugging?\"",
	unauthorized: "waiting for \"Allow debugging?\"",
	untrusted: "waiting for \"Allow debugging?\"",
	offline: "not answering over Wi-Fi"
};
const ANDROID_NETWORK_BLOCKER_LINES = {
	ANDROID_UNAUTHORIZED: "Choose Allow on \"Allow debugging?\" on the device (with the remote on a TV)",
	ANDROID_OFFLINE: "The device is not answering over Wi-Fi: wake it, or connect it again"
};
/** The second line under a device that gained a blocker, in the terminal's own words. */
const BLOCKER_LINES = {
	IOS_UNTRUSTED: "Unlock it and tap Trust on the iPhone",
	IOS_LOCKED: "Unlock it with the passcode: it has not been unlocked since it restarted",
	IOS_LOCKDOWN_FAILED: "It is not answering: unplug it and plug it back in, unlocked",
	IOS_DEVELOPER_MODE_OFF: "Developer Mode is off: screenshots stay off until it is on",
	XCODE_REQUIRED: "Screenshots need Xcode on this Mac (identifiers and logs work)",
	XCODE_SETUP_REQUIRED: "Xcode must finish setting up before screenshots work: open Xcode once",
	IOS_DDI_REQUIRED: "Screenshots need the developer disk image mounted on the device first",
	TOOL_MISSING: "A tool is missing for this device: run the helper with --doctor",
	ANDROID_UNAUTHORIZED: "Tap Allow on \"Allow USB debugging?\" on the phone",
	ANDROID_OFFLINE: "The phone is not answering adb: reseat the cable",
	ANDROID_RECOVERY: "The phone is in recovery or bootloader mode"
};
function label(row) {
	if (row.platform === "android") {
		const fallback = row.connection === "network" ? "Android device" : "Android phone";
		return `${row.name || row.modelId || fallback} (${row.id})`;
	}
	return row.name || row.model || row.modelId || (row.connection === "simulator" ? "Simulator" : "iPhone");
}
function words(row) {
	if (row.platform === "android") return (row.connection === "network" ? ANDROID_NETWORK_WORDS[row.state] : void 0) ?? ANDROID_WORDS[row.state];
	if (row.connection === "simulator") {
		if (row.state === "ready") return "booted";
		if (row.state === "connecting") return "booting";
	}
	return IOS_WORDS[row.state];
}
function arrivalLine(row) {
	const os = (row.platform === "ios" ? "iOS" : "Android") + (row.osVersion ? ` ${row.osVersion}` : "");
	const via = row.connection === "usb" ? "USB" : row.connection === "network" ? "Wi-Fi" : row.platform === "ios" ? "Simulator" : "Emulator";
	return `+ ${label(row)} · ${os} · ${via} · ${words(row)}`;
}
function blockerLines(row, codes) {
	const network = row.platform === "android" && row.connection === "network";
	return codes.flatMap((code) => {
		const line = (network ? ANDROID_NETWORK_BLOCKER_LINES[code] : void 0) ?? BLOCKER_LINES[code];
		return line ? [`  ${line}`] : [];
	});
}
/**
 * The terminal lines for one lane's rows going from `before` to `after`. A row that left
 * with a `departures` entry says why: "- BRAVIA 4K UR3 (192.168.1.20:5555) · disconnected".
 */
function transitionLines(before, after, departures = {}) {
	const lines = [];
	const old = new Map(before.map((row) => [row.id, row]));
	const now = new Set(after.map((row) => row.id));
	for (const row of after) {
		const previous = old.get(row.id);
		if (!previous) {
			lines.push(arrivalLine(row), ...blockerLines(row, row.blockers));
			continue;
		}
		if (previous.state !== row.state) lines.push(`~ ${label(row)} · ${words(row)}`);
		const added = row.blockers.filter((code) => !previous.blockers.includes(code));
		lines.push(...blockerLines(row, added));
	}
	for (const row of before) {
		if (now.has(row.id)) continue;
		const why = Object.hasOwn(departures, row.id) ? departures[row.id] : void 0;
		lines.push(`- ${label(row)}${why ? ` · ${why}` : ""}`);
	}
	return lines;
}
/**
 * Lane-level transitions worth a line. A lane's first report only settles its state (the
 * banner already describes it); later changes are news.
 */
function laneLines(lane, before, after) {
	if (lane === "android") {
		const a = before;
		const b = after;
		if (a.status !== "ok" && b.status === "ok") return [`adb server ${b.startedByHelper ? "started from Device Lab" : "appeared"}${b.serverProtocol === void 0 ? "" : ` (protocol ${String(b.serverProtocol)})`}: sharing it for Android`];
		if (a.status === "ok" && b.status === "stopped") return ["adb server stopped: Android phones are back with Chrome's WebUSB"];
	}
	if (lane === "ios") {
		const a = before;
		const b = after;
		if (a.status === "ok" && b.status === "error") return [`macOS's iPhone service (usbmuxd) stopped answering${b.reason ? `: ${b.reason}` : ""}`];
		if (a.status === "error" && b.status === "ok") return ["macOS's iPhone service (usbmuxd) is back"];
	}
	return [];
}
/**
 * The single source of truth for what the helper lists (§1.3, §2.4). Lanes publish their
 * whole row list; the registry merges, sorts and serialises, bumps `rev` only when the JSON
 * the page sees changes, prints one terminal line per transition, and tells subscribers
 * (log streams) which devices left.
 */
function createRegistry(opts) {
	const rows = new Map();
	const settled = new Set();
	const listeners = new Set();
	let lanes = JSON.parse(JSON.stringify(opts.lanes));
	let devices = [];
	let rev = 1;
	let serialized = JSON.stringify({
		devices,
		lanes
	});
	let lastActive = Number.NEGATIVE_INFINITY;
	const rebuild = (removed) => {
		const merged = new Map();
		for (const lane of LANE_ORDER) for (const row of rows.get(lane) ?? []) if (!merged.has(row.id)) merged.set(row.id, row);
		const next = sortRows([...merged.values()]);
		const json = JSON.stringify({
			devices: next,
			lanes
		});
		if (json !== serialized) {
			serialized = json;
			devices = next;
			rev++;
		}
		const gone = removed.filter((id) => !merged.has(id));
		if (gone.length) for (const listener of [...listeners]) listener({ removed: gone });
	};
	return {
		publish(lane, incoming, departures) {
			const previous = rows.get(lane) ?? [];
			const next = [];
			const seen = new Set();
			for (const row of incoming) {
				const normal = normalizeRow(row);
				if (!normal) {
					opts.bug(`The ${lane} lane listed a device id no request can address: ${JSON.stringify(row.id)}`);
					continue;
				}
				if (seen.has(normal.id)) continue;
				seen.add(normal.id);
				next.push(normal);
			}
			rows.set(lane, next);
			for (const line of transitionLines(previous, next, departures)) opts.log(line);
			rebuild(previous.map((row) => row.id).filter((id) => !seen.has(id)));
		},
		setLane(lane, patch) {
			const before = lanes[lane];
			const after = {
				...before,
				...patch
			};
			lanes = {
				...lanes,
				[lane]: after
			};
			if (settled.has(lane)) for (const line of laneLines(lane, before, after)) opts.log(line);
			else settled.add(lane);
			rebuild([]);
		},
		snapshot: () => ({
			rev,
			runId: opts.runId,
			devices,
			lanes
		}),
		lanes: () => lanes,
		devices: () => devices,
		device: (id) => devices.find((row) => row.id === id) ?? null,
		owner(id) {
			for (const lane of LANE_ORDER) if (rows.get(lane)?.some((row) => row.id === id)) return lane;
			return null;
		},
		touch() {
			lastActive = opts.now();
		},
		isActive: () => opts.now() - lastActive < opts.activeMs,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}
	};
}

//#endregion
//#region src/auth.ts
/** 32 random bytes in base64url: 256 bits, 43 characters, safe in a URL fragment. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** 16 random bytes in base64url, from the page's crypto.getRandomValues. */
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{22}$/;
function generateToken() {
	return randomBytes(32).toString("base64url");
}
/**
 * The token's public fingerprint: 8 hex of its SHA-256. The page shows it to say which run
 * it is paired with, and compares it with health.tokenId before it sends the token anywhere.
 */
function tokenIdOf(token) {
	return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 8);
}
/**
 * Proof that whoever answers on this port holds the token, without revealing it (§2.8):
 * HMAC-SHA256 keyed with the token over the port the helper is bound to and the page's
 * challenge. A squatter on another port that relays the challenge here gets a proof over
 * THIS port, which the page, computing over the port it talks to, rejects.
 */
function proofOf(token, port, challenge) {
	return createHmac("sha256", Buffer.from(token, "utf8")).update(`${NAME} proof v1|${String(port)}|${challenge}`, "utf8").digest("base64url");
}
/**
 * `Authorization: Bearer <token>`, compared in constant time over the SHA-256 of each side:
 * both are always 32 bytes, so timingSafeEqual never throws and the length of a wrong
 * guess leaks nothing.
 */
function createBearerCheck(token) {
	const expected = createHash("sha256").update(token, "utf8").digest();
	return (header) => {
		const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(header ?? "");
		if (!match?.[1]) return false;
		return timingSafeEqual(createHash("sha256").update(match[1], "utf8").digest(), expected);
	};
}
/** A refusal to use the kept token, worded for the terminal (§1.10); exit 1. */
var TokenFileError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "TokenFileError";
	}
};
/** ~/Library/Application Support on macOS, $XDG_CONFIG_HOME (or ~/.config) elsewhere. */
function tokenFilePath(home, platform, env) {
	const base = platform === "darwin" ? path.join(home, "Library", "Application Support") : env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, ".config");
	return path.join(base, NAME, "token");
}
const quoteForShell = (file) => `'${file.replace(/'/g, `'\\''`)}'`;
/**
 * Refuse a path another user could have planted or can read: a symbolic link (it could
 * point anywhere), an owner other than us, or any group or other permission bit.
 */
function assertPrivate(file, uid, mode) {
	const stats = lstatSync(file);
	if (stats.isSymbolicLink() || uid !== void 0 && stats.uid !== uid) throw new TokenFileError(`The token file ${file} is a symbolic link or belongs to another user; refusing to use it.`);
	if (mode === 448 && !stats.isDirectory()) throw new TokenFileError(`The token file's folder ${file} is not a folder; refusing to use it.`);
	if (mode === 384 && !stats.isFile()) throw new TokenFileError(`The token file ${file} is a symbolic link or belongs to another user; refusing to use it.`);
	if ((stats.mode & 63) !== 0) {
		if (mode === 448) {
			/** Our own folder with loose permissions: tightening it is safe and expected. */
			chmodSync(file, 448);
			return;
		}
		throw new TokenFileError(`The token file ${file} can be read by other users. Fix it with: chmod 600 ${quoteForShell(file)}`);
	}
}
/** Write `token` to a new file next to `file` (O_EXCL, 0600), then move it into place. */
function writeTokenFile(file, token) {
	const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
	const fd = openSync(temporary, "wx", 384);
	try {
		writeSync(fd, token + "\n");
	} finally {
		closeSync(fd);
	}
	try {
		renameSync(temporary, file);
	} catch (error) {
		unlinkSync(temporary);
		throw error;
	}
}
/**
 * The token kept across restarts with --keep-token (§1.11): created on first use in a 0700
 * folder as a 0600 file, replaced with --new-token, refused when it is not provably ours
 * and private. A corrupt file is replaced rather than trusted.
 */
function loadKeptToken(opts) {
	const file = tokenFilePath(opts.home, opts.platform, opts.env);
	const dir = path.dirname(file);
	const uid = opts.getuid?.();
	try {
		mkdirSync(dir, {
			recursive: true,
			mode: 448
		});
		assertPrivate(dir, uid, 448);
		let existing = null;
		try {
			assertPrivate(file, uid, 384);
			existing = readFileSync(file, "utf8").trim();
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		if (existing !== null && TOKEN_PATTERN.test(existing) && !opts.newToken) return {
			token: existing,
			path: file,
			created: false
		};
		const token = generateToken();
		writeTokenFile(file, token);
		return {
			token,
			path: file,
			created: true
		};
	} catch (error) {
		if (error instanceof TokenFileError) throw error;
		/** A folder we may not write, a full disk: still a sentence, never a stack trace. */
		const reason = error.code ?? error.message;
		throw new TokenFileError(`The token file ${file} could not be used (${String(reason)}).`);
	}
}
/** The browser family for the terminal, from the User-Agent; never the whole string. */
function browserFamily(userAgent) {
	const ua = userAgent ?? "";
	if (/\bEdg(?:e|A|iOS)?\//.test(ua)) return "Edge";
	if (/\b(?:Firefox|FxiOS)\//.test(ua)) return "Firefox";
	if (/\b(?:OPR|Opera)\//.test(ua)) return "Opera";
	if (/\b(?:Chrome|CriOS|Chromium|HeadlessChrome)\//.test(ua)) return "Chrome";
	if (/\bSafari\//.test(ua) && /\bVersion\//.test(ua)) return "Safari";
	return "Another client";
}
/** The dev origins (--dev) by the command that serves them, so the terminal names the page. */
const DEV_PAGES = {
	"7360": "npm run dev",
	"4173": "vite preview",
	"8000": "npm run serve:site"
};
/**
 * Where an authorised request came from, for the terminal. A page names itself by its
 * Origin: the dev origins as "the dev page", so a tester running `npm run dev` recognises
 * it. A client without an Origin (curl, or the helper's own page fetching same-origin) is
 * named by the Host it used.
 */
function pageWhere(origin, host) {
	if (origin === void 0) return `http://${host}`;
	if (DEV_ORIGINS.includes(origin)) {
		const command = DEV_PAGES[origin.slice(origin.lastIndexOf(":") + 1)];
		return `the dev page ${origin}${command ? ` (${command})` : ""}`;
	}
	return origin;
}
/**
 * "Page connected: Chrome on https://bauloc.github.io", once per page and browser family, on
 * the first authorised request from it. "Another client" is only for a client that sent no
 * Origin and no browser User-Agent; a page with an Origin is always a browser.
 */
function createPageLog(log) {
	const seen = new Set();
	return (origin, host, userAgent) => {
		const known = browserFamily(userAgent);
		const family = known === "Another client" && origin !== void 0 ? "A browser" : known;
		const where = pageWhere(origin, host);
		const key = `${family} ${where}`;
		if (seen.has(key)) return;
		seen.add(key);
		log(`Page connected: ${family} on ${where}`);
	};
}

//#endregion
//#region src/preflight.ts
/**
 * §12 Doctor and preflight: the Mac, iPhone-tool and Android-tool items of the checklist,
 * worded here so the terminal and the page say the same thing (§12b, exact strings).
 *
 * The bridge calls four functions:
 * - collectPreflight(): in the background at start (for the banner) and for /api/doctor;
 * - doctorReport(): the body of GET /api/doctor (the bridge caches it 30 s);
 * - formatChecklist(): the banner's lines ({all: false}) and --doctor's ({all: true});
 * - printDoctor(): everything `--doctor` prints, including each lane's probeForDoctor().
 *
 * Every check is read-only and bounded: each tool run has its own timeout (§1.12, Doctor),
 * and the whole collection stops waiting after 12 s, so one hung tool turns its own item
 * "Not checked" instead of holding the checklist back. Fixes are text for the tester to
 * copy; the helper never runs one.
 */
function item(base, status, sentence, fixes = [], extra = {}) {
	return {
		id: base.id,
		group: base.group,
		label: extra.label ?? base.label,
		status,
		sentence,
		fixes,
		...extra.detail ? { detail: extra.detail } : {},
		neededFor: base.neededFor,
		...base.optional ? { optional: true } : {}
	};
}
const IOS_ALL = [
	"ios.list",
	"ios.detail",
	"ios.screenshot",
	"ios.logs"
];
const ITEMS = {
	node: {
		id: "mac.node",
		group: "mac",
		label: "Node",
		neededFor: ["helper"]
	},
	os: {
		id: "mac.os",
		group: "mac",
		label: "macOS",
		neededFor: IOS_ALL
	},
	usbmuxd: {
		id: "ios.usbmuxd",
		group: "ios",
		label: "usbmuxd",
		neededFor: [
			"ios.list",
			"ios.detail",
			"ios.logs"
		]
	},
	session: {
		id: "ios.session",
		group: "ios",
		label: "Secure session",
		neededFor: ["ios.detail", "ios.logs"]
	},
	xcode: {
		id: "ios.xcode",
		group: "ios",
		label: "Xcode",
		neededFor: ["ios.screenshot"]
	},
	libimobiledevice: {
		id: "ios.libimobiledevice",
		group: "ios",
		label: "libimobiledevice",
		neededFor: ["ios.screenshot.legacy", "ios.fallback"],
		optional: true
	},
	pymobiledevice3: {
		id: "ios.pymobiledevice3",
		group: "ios",
		label: "pymobiledevice3",
		neededFor: [],
		optional: true
	},
	simulators: {
		id: "ios.simulators",
		group: "ios",
		label: "Simulators",
		neededFor: ["simulators"]
	},
	adb: {
		id: "android.adb",
		group: "android",
		label: "adb",
		neededFor: ["android.helper"]
	},
	adbServer: {
		id: "android.adb-server",
		group: "android",
		label: "adb server",
		neededFor: ["android.helper"]
	},
	wifi: {
		id: "android.wifi",
		group: "android",
		label: "Wi-Fi devices",
		neededFor: ["android.wifi"],
		optional: true
	},
	bundletool: {
		id: "android.bundletool",
		group: "android",
		label: "bundletool",
		neededFor: ["android.aab"],
		optional: true
	}
};
const NODE_LTS = {
	kind: "link",
	href: "https://nodejs.org/en/download",
	label: "Get the current Node LTS"
};
const APP_STORE_XCODE = {
	kind: "link",
	href: "https://apps.apple.com/app/xcode/id497799835",
	label: "Get Xcode from the App Store"
};
const HOMEBREW = {
	kind: "link",
	href: "https://brew.sh",
	label: "Install Homebrew first"
};
const FIRST_LAUNCH = [{
	kind: "step",
	text: "Open Xcode once and let it finish."
}, {
	kind: "command",
	command: "sudo xcodebuild -runFirstLaunch"
}];
/**
 * A `brew install …` fix. Without Homebrew (§12b: neither /opt/homebrew/bin/brew nor
 * /usr/local/bin/brew) the command would only print "command not found", so the way to
 * get Homebrew comes first. Homebrew found only in its own folder (a fresh install whose
 * "Next steps" were skipped) puts itself on the terminal's PATH first, for `brew` and for
 * what it installs (pipx).
 */
function brewFix(command, brew) {
	const install = {
		kind: "command",
		command
	};
	if (!brew) return [HOMEBREW, install];
	if (brew.onPath) return [install];
	return [{
		kind: "command",
		command: `eval "$(${shellQuote(brew.path)} shellenv)"`,
		note: "Homebrew is installed but not on this terminal's PATH yet; this adds it"
	}, install];
}
/** findBrew(), and whether its folder is on the PATH the helper (and its terminal) uses. */
function brewOf(opts) {
	const file = findBrew(opts);
	if (!file) return null;
	return {
		path: file,
		onPath: onSearchPath(file, opts.searchPath)
	};
}
const selectXcode = (devDir) => ({
	kind: "command",
	command: `sudo xcode-select -s ${shellQuote(devDir)}`
});
function nodeItem(version) {
	const major = parseInt(version, 10);
	const label = `Node ${version}`;
	if (major >= 22) return item(ITEMS.node, "ok", `Node ${version} runs the helper.`, [], { label });
	if (major >= 18) return item(ITEMS.node, "warning", `Node ${version} works, but it no longer gets security updates.`, [NODE_LTS], { label });
	return item(ITEMS.node, "blocking", `Node ${version} is too old for the helper.`, [NODE_LTS], { label });
}
function macosItem(platform, version) {
	if (platform !== "darwin") return item(ITEMS.os, "blocking", `iPhones need a Mac; on ${platform} only Android works through this helper.`, [], { label: platform });
	return version ? item(ITEMS.os, "ok", `macOS ${version}.`, [], { label: `macOS ${version}` }) : item(ITEMS.os, "ok", "macOS (its version couldn't be read).");
}
function usbmuxdItem(answers) {
	return answers ? item(ITEMS.usbmuxd, "ok", "macOS's iPhone service (usbmuxd) answers.") : item(ITEMS.usbmuxd, "blocking", "macOS's iPhone service (usbmuxd) isn't answering.", [{
		kind: "step",
		text: "Unplug the iPhone and plug it back in. If this stays red, restart the Mac."
	}]);
}
/** Shown only after the native TLS session failed on this Node (§3.3, R2). */
function sessionItem(failure, libimobiledevice, brew) {
	const lead = `Node ${failure.node} (OpenSSL ${failure.openssl}) couldn't open an iPhone's secure session`;
	return libimobiledevice ? item(ITEMS.session, "warning", `${lead}, so details and logs come from libimobiledevice.`, [NODE_LTS]) : item(ITEMS.session, "blocking", `${lead}, so only basic identifiers are shown.`, [NODE_LTS, ...brewFix(INSTALL.libimobiledevice, brew)]);
}
function xcodeItem(x) {
	const label = x.version ? `Xcode ${x.version}` : "Xcode";
	const where = x.devDir ?? "";
	switch (x.state) {
		case "ready": {
			const detail = [x.coreDevice ? `devicectl ${x.coreDevice}` : null, where].filter(Boolean).join(" · ");
			return x.license === false ? item(ITEMS.xcode, "warning", "Xcode's license hasn't been accepted, which can stop its tools.", [{
				kind: "command",
				command: "sudo xcodebuild -license accept"
			}], {
				label,
				detail
			}) : item(ITEMS.xcode, "ok", "Screenshots of iOS 17 and newer work through Xcode's devicectl.", [], {
				label,
				detail
			});
		}
		case "not-selected": return item(ITEMS.xcode, "warning", "Xcode is installed, but the Command Line Tools are selected, so screenshots are off.", x.suggest ? [selectXcode(x.suggest)] : [], {
			label,
			detail: where ? `selected: ${where}` : void 0
		});
		case "needs-first-launch": return item(ITEMS.xcode, "warning", "Xcode hasn't finished installing its components, so screenshots are off.", FIRST_LAUNCH, {
			label,
			detail: [x.expected ? `devicectl needs CoreDevice ${x.expected}, found ${x.coreDevice || "none"}` : null, where].filter(Boolean).join(" · ")
		});
		case "no-capture": return item(ITEMS.xcode, "warning", "This Xcode's devicectl has no screenshot command; update Xcode.", [APP_STORE_XCODE], {
			label,
			detail: where
		});
		case "not-installed": return item(ITEMS.xcode, "warning", "Xcode isn't installed, so screenshots of iOS 17 and newer are off; identifiers and logs still work.", [APP_STORE_XCODE], { detail: where ? `selected: ${where}` : void 0 });
	}
}
/** `ideviceinfo, idevicesyslog in /opt/homebrew/bin`: one folder named once. */
function toolsByFolder(tools) {
	const folders = new Map();
	for (const t of tools) {
		const dir = path.dirname(t.path);
		folders.set(dir, [...folders.get(dir) ?? [], path.basename(t.path)]);
	}
	return [...folders].map(([dir, names]) => `${names.join(", ")} in ${dir}`).join(" · ");
}
function libimobiledeviceItem(tools, version, brew) {
	const present = tools.filter((t) => t !== null);
	if (!present.length) return item(ITEMS.libimobiledevice, "warning", "Not installed. Only needed for screenshots of iOS 16 and older, or when the helper can't open an iPhone's secure session.", brewFix(INSTALL.libimobiledevice, brew));
	return item(ITEMS.libimobiledevice, "ok", "Installed: a fallback for details and logs, and screenshots of iOS 16 and older.", [], {
		label: version ? `libimobiledevice ${version}` : "libimobiledevice",
		detail: toolsByFolder(present)
	});
}
/** The way to install pymobiledevice3 into the Python this Mac has (§12b). */
function pymobiledevice3Fixes(python, brew) {
	if (!python) return [{
		kind: "link",
		href: "https://www.python.org/downloads/macos/",
		label: "Get Python from python.org"
	}];
	return python.kind === "externally-managed" ? brewFix("brew install pipx && pipx install pymobiledevice3", brew) : [{
		kind: "command",
		command: "python3 -m pip install -U pymobiledevice3"
	}];
}
function pymobiledevice3Item(info, tunnel, fixes) {
	const later = "Used only by the optional root tunnel, in a later helper version.";
	if (!info) return item(ITEMS.pymobiledevice3, "warning", "Not installed. Only needed for the optional root tunnel (a later helper version).", fixes);
	const label = info.version ? `pymobiledevice3 ${info.version}` : "pymobiledevice3";
	const python = info.python;
	if (python?.state === "shim") return item(ITEMS.pymobiledevice3, "unchecked", `Installed for Apple's ${python.path}, which the helper never starts, so it wasn't checked.`, [], {
		label,
		detail: info.path
	});
	if (python?.state === "missing") return item(ITEMS.pymobiledevice3, "warning", `Installed, but the Python it needs (${python.path}) is gone.`, fixes, {
		label,
		detail: info.path
	});
	const where = python ? `Installed in ${python.version ? `Python ${python.version}` : "Python"} (${python.path}).` : "Installed.";
	return item(ITEMS.pymobiledevice3, "ok", `${where} ${later}`, [], {
		label,
		detail: tunnel === null ? void 0 : `root tunnel: ${tunnel ? "running" : "not running"}`
	});
}
function simulatorsItem(s, booted) {
	switch (s.state) {
		case "ready": return item(ITEMS.simulators, "ok", booted ? `${plural(booted, "simulator")} ${booted === 1 ? "is" : "are"} booted.` : "No simulator is booted.", [], { detail: s.simctl ?? void 0 });
		case "needs-first-launch": return item(ITEMS.simulators, "warning", "Xcode hasn't finished installing simulator components.", FIRST_LAUNCH);
		case "not-selected": return item(ITEMS.simulators, "warning", "Simulators need Xcode, but the Command Line Tools are selected.", s.suggest ? [selectXcode(s.suggest)] : []);
		case "not-installed": return item(ITEMS.simulators, "warning", "Simulators need Xcode.", [APP_STORE_XCODE]);
	}
}
function adbItem(adb, brew) {
	return adb ? item(ITEMS.adb, "ok", `Google's adb is installed (${adb.path}).`, [], { label: adb.version ? `adb ${adb.version}` : "adb" }) : item(ITEMS.adb, "warning", "adb isn't installed. Chrome and Edge don't need it; Safari and Firefox reach Android only through it.", brewFix(INSTALL.adb, brew));
}
const isStuck = (server) => typeof server === "object" && server !== null && "stuck" in server;
const stuckSentence = (port) => `Something on 127.0.0.1:${String(port)} isn't answering like Google's adb server, usually an adb server that got stuck.`;
/** Stop the stuck server (adb by its full path, when found); else find what holds the port. */
function stuckFixes(adb, port) {
	const lsof = {
		kind: "command",
		command: `lsof -nP -iTCP:${String(port)} -sTCP:LISTEN`,
		note: "shows what holds the port; quit that app"
	};
	if (!adb) return [lsof];
	return [{
		kind: "command",
		command: `${shellQuote(adb.path)} kill-server`
	}, lsof];
}
/** Offered only with adb installed: the helper starts the server with that adb, else it fails. */
const START_ADB = {
	kind: "action",
	action: "start-adb",
	label: "Start adb server"
};
function adbServerItem(server, adb) {
	if (server === "off") return item(ITEMS.adbServer, "unchecked", "Not checked: the helper was started with --no-android.");
	if (isStuck(server)) return item(ITEMS.adbServer, "warning", stuckSentence(server.port), stuckFixes(adb, server.port), { detail: server.why });
	if (!server) return item(ITEMS.adbServer, "ok", "Google's adb server isn't running, so Chrome's WebUSB can use Android phones directly.", adb ? [START_ADB] : []);
	const phones = server.devices;
	const holds = phones.length ? `${plural(phones.length, "phone")} (${phones.map((p) => p.model || p.serial).join(", ")})` : "no phones";
	return item(ITEMS.adbServer, "ok", `Google's adb server is running and holds ${holds}; the helper shares it.`, [], { detail: [`protocol ${String(server.protocol)}`, ...phones.map((p) => `${p.serial}:${p.state}`)].join(" · ") });
}
/**
 * §4.7: Android TVs and phones on the network are reached only through Google's adb server,
 * so this row is about that server, for Wi-Fi's sake. Optional: a tester who never uses
 * Wi-Fi must not see a warning for it in the banner, and the server not running is what
 * Chrome's WebUSB wants (the adb server row says so). `searchPath` is the PATH the tester's
 * terminal has: an adb found off it is named by its full path in the commands.
 */
function wifiItem(adb, server, brew, searchPath) {
	if (server === "off") return item(ITEMS.wifi, "unchecked", "Not checked: the helper was started with --no-android.");
	if (isStuck(server)) return item(ITEMS.wifi, "warning", stuckSentence(server.port), stuckFixes(adb, server.port), { detail: server.why });
	if (!server && !adb) return item(ITEMS.wifi, "warning", "Android TVs and phones on Wi-Fi go through Google's adb server, and adb isn't installed.", brewFix(INSTALL.adb, brew));
	if (!server) {
		const adbCmd = adbCommand(adb, searchPath);
		return item(ITEMS.wifi, "warning", "Android TVs and phones on Wi-Fi go through Google's adb server, which isn't running.", [START_ADB, {
			kind: "command",
			command: `${adbCmd} start-server`,
			note: `while it runs, Chrome's WebUSB can't use Android phones on a cable; ${adbCmd} kill-server gives them back`
		}]);
	}
	const onWifi = server.devices.filter((d) => adbConnection(d.serial) === "network");
	return item(ITEMS.wifi, "ok", "Google's adb server is running: connect a TV or phone by its address.", [], onWifi.length ? { detail: onWifi.map((d) => `${d.serial}:${d.state}`).join(" · ") } : {});
}
function bundletoolItem(info, brew) {
	if (!info) return item(ITEMS.bundletool, "warning", "Not installed. Only needed to install .aab bundles (a later helper version).", brewFix("brew install bundletool", brew));
	const label = info.version ? `bundletool ${info.version}` : "bundletool";
	if (info.brokenJavaHome) return item(ITEMS.bundletool, "warning", "bundletool is installed, but JAVA_HOME points at a Java that doesn't run.", [
		{
			kind: "step",
			text: "Stop the helper (Ctrl+C) and, in the same window, clear JAVA_HOME:"
		},
		{
			kind: "command",
			command: "unset JAVA_HOME",
			note: "delete the JAVA_HOME line in ~/.zshrc too, or a new window sets it again"
		},
		{
			kind: "step",
			text: "Start the helper again from that window."
		}
	], {
		label,
		detail: `${info.path} · JAVA_HOME=${info.brokenJavaHome}`
	});
	if (!info.java || !info.works) return item(ITEMS.bundletool, "warning", "bundletool is installed but can't start Java.", brewFix("brew install openjdk", brew), {
		label,
		detail: info.path
	});
	return item(ITEMS.bundletool, "ok", `Installed (Java ${info.java.version}). A later helper version uses it to install .aab bundles.`, [], {
		label,
		detail: `${info.path} · Java ${info.java.version} (${info.java.home})`
	});
}
/** macOS's ProductVersion from SystemVersion.plist (XML [V]), else `sw_vers -productVersion`. */
async function macosVersion(ctx) {
	try {
		const version = asDict(parsePlist(await readFile(ctx.options.systemVersionPlist, "utf8")))?.ProductVersion;
		if (typeof version === "string" && version) return version;
	} catch {}
	try {
		const { stdout } = await ctx.runTool(ctx.options.swVersPath, ["-productVersion"], { timeoutMs: ctx.timeouts.xcodeSelect });
		return stdout.trim() || null;
	} catch {
		return null;
	}
}
/**
 * usbmuxd answers when its socket exists and a `ReadBUID` comes back (2 s). A socket that
 * accepts and then closes, or sends garbage, is not answering.
 */
async function usbmuxdAnswers(ctx) {
	const socketPath = ctx.options.usbmuxdSocket;
	try {
		if (!(await lstat(socketPath)).isSocket()) return false;
		const buid = await withTimeout(createUsbmux({
			socketPath,
			timeouts: ctx.timeouts
		}).readBuid(), ctx.timeouts.muxRequest + 500, () => new Error("usbmuxd did not answer"));
		return typeof buid === "string" && buid.length > 0;
	} catch {
		return false;
	}
}
/**
 * `host:version` on the adb server (attach only: a refused connect costs about 1 ms and
 * starts nothing), then `host:devices-l` when one answers. Only a refused connect means "not
 * running"; anything else on the port that doesn't answer in time, or not as adb, is stuck.
 */
async function adbServer(ctx) {
	/** §12b gives this check 2 s per request, not the lanes' 5 s: it must not hold up the banner. */
	const timeouts = {
		...ctx.timeouts,
		adbRequest: Math.min(ctx.timeouts.adbRequest, 2e3)
	};
	const client = createAdbClient({
		port: ctx.options.adbPort,
		timeouts
	});
	try {
		const protocol = await client.version(ctx.signal);
		if (protocol === null) return null;
		const text = await client.devicesL(ctx.signal).catch(() => "");
		return {
			protocol,
			devices: parseDevicesL(text).map((row) => ({
				serial: row.serial,
				state: row.state,
				model: (row.props.model ?? "").replace(/_/g, " ")
			}))
		};
	} catch (error) {
		return {
			stuck: true,
			port: ctx.options.adbPort,
			why: clean(errorText(error), 200)
		};
	} finally {
		client.close();
	}
}
/** pymobiledevice3's root tunnel (`tunneld`) answers `GET /hello` on 127.0.0.1:49151. */
function tunnelRunning(port, timeoutMs) {
	return new Promise((resolve) => {
		const req = http.get({
			host: "127.0.0.1",
			port,
			path: "/hello",
			timeout: timeoutMs
		}, (res) => {
			res.resume();
			resolve(true);
		});
		req.on("timeout", () => req.destroy());
		req.on("error", () => resolve(false));
	});
}
/** Booted iOS simulators from the real simctl (`list -j devices booted`, about 80 ms [V]). */
async function bootedSimulators(ctx, s) {
	if (s.state !== "ready" || !s.simctl || !s.devDir) return null;
	const { stdout } = await ctx.runTool(s.simctl, [
		"list",
		"-j",
		"devices",
		"booted"
	], {
		timeoutMs: ctx.timeouts.doctorCheck,
		env: childEnv({ DEVELOPER_DIR: s.devDir }, ctx.options.env)
	});
	const devices = asRecord(asRecord(JSON.parse(stdout))?.devices);
	let booted = 0;
	for (const [runtime, list] of Object.entries(devices ?? {})) {
		if (!runtime.includes("SimRuntime.iOS-") || !Array.isArray(list)) continue;
		booted += list.filter((d) => asRecord(d)?.state === "Booted").length;
	}
	return booted;
}
function asRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
const TIMED_OUT = "Check timed out.";
/**
 * One check, bounded by the collection's deadline. Out of time (its own tool's timeout or
 * the 12 s for everything) → "Check timed out."; a bug → "This check couldn't run.". Either
 * way the item is there, so the page never shows a gap where a tool should be.
 */
async function settle(check, deadline) {
	try {
		const result = await Promise.race([check.run(), deadline]);
		return result === "late" ? item(check.base, "unchecked", TIMED_OUT) : result;
	} catch (error) {
		if (isTimeout(error)) return item(check.base, "unchecked", TIMED_OUT);
		return item(check.base, "unchecked", "This check couldn't run.", [], { detail: clean(errorText(error), 200) });
	}
}
function toolOptionsOf(ctx) {
	return toolOptionsFrom({
		...ctx.options,
		timeouts: ctx.timeouts,
		now: ctx.now
	}, ctx.runTool);
}
/** The checks for this Mac, in the order §12a lists them. */
function checks(ctx, toolbox) {
	const o = ctx.options;
	const opts = toolOptionsOf(ctx);
	const brew = brewOf(opts);
	const darwin = o.platform === "darwin";
	const list = [{
		base: ITEMS.node,
		run: () => Promise.resolve(nodeItem(o.nodeVersion))
	}, {
		base: ITEMS.os,
		run: async () => macosItem(o.platform, darwin ? await macosVersion(ctx) : null)
	}];
	if (darwin) {
		list.push({
			base: ITEMS.usbmuxd,
			run: async () => usbmuxdItem(await usbmuxdAnswers(ctx))
		}, {
			base: ITEMS.session,
			run: async () => {
				const failure = ctx.lanes.ios?.facts().tlsFailures[0];
				if (!failure) return null;
				return sessionItem(failure, (await toolbox).ideviceinfo !== null, brew);
			}
		}, {
			base: ITEMS.xcode,
			run: async () => xcodeItem((await toolbox).xcode)
		}, {
			base: ITEMS.libimobiledevice,
			run: async () => {
				const t = await toolbox;
				const version = t.ideviceinfo ? await libimobiledeviceVersion(opts, t.ideviceinfo.path) : null;
				return libimobiledeviceItem([
					t.ideviceinfo,
					t.idevicesyslog,
					t.idevicescreenshot
				], version, brew);
			}
		}, {
			base: ITEMS.pymobiledevice3,
			run: async () => {
				const info = await resolvePymobiledevice3(opts);
				const runs = info !== null && (!info.python || info.python.state === "ok");
				const fixes = runs ? [] : pymobiledevice3Fixes(await findPython(opts), brew);
				return pymobiledevice3Item(info, runs ? await tunnelRunning(o.tunneldPort, 500) : null, fixes);
			}
		});
		if (o.simulators) list.push({
			base: ITEMS.simulators,
			run: async () => {
				const s = (await toolbox).simctl;
				return simulatorsItem(s, await bootedSimulators(ctx, s));
			}
		});
	}
	/** Asked once for both rows that read it. */
	let server = null;
	const serverFacts = async () => o.android ? await (server ??= adbServer(ctx)) : "off";
	list.push({
		base: ITEMS.adb,
		run: async () => adbItem((await toolbox).adb, brew)
	}, {
		base: ITEMS.adbServer,
		run: async () => adbServerItem(await serverFacts(), (await toolbox).adb)
	}, {
		base: ITEMS.wifi,
		run: async () => wifiItem((await toolbox).adb, await serverFacts(), brew, opts.searchPath)
	}, {
		base: ITEMS.bundletool,
		run: async () => bundletoolItem(await resolveBundletool(opts), brew)
	});
	return list;
}
async function gather(ctx, opts) {
	const toolbox = opts.refresh ? ctx.tools.refresh() : ctx.tools.get();
	/** Unhandled until a check awaits it; a rejection then lands in that check's item. */
	toolbox.catch(() => void 0);
	let timer;
	const deadline = new Promise((resolve) => {
		timer = setTimeout(() => resolve("late"), ctx.timeouts.doctorTotal);
	});
	try {
		const items = (await Promise.all(checks(ctx, toolbox).map((c) => settle(c, deadline)))).filter((i) => i !== null);
		const os = items.find((i) => i.id === ITEMS.os.id);
		return {
			items,
			macos: ctx.options.platform === "darwin" && os?.label.startsWith("macOS ") ? os.label.slice(6) : null
		};
	} finally {
		clearTimeout(timer);
	}
}
/**
 * Every Mac, iPhone-tool and Android-tool item of §12b, helper-worded. `refresh` re-resolves
 * the tools first (the tester just installed something: Re-check, `?refresh=1`).
 */
async function collectPreflight(ctx, opts) {
	return (await gather(ctx, opts)).items;
}
/** GET /api/doctor (§12c): the helper's facts, the lanes, and the checklist. */
async function doctorReport(ctx, opts) {
	const gathered = gather(ctx, opts);
	/**
	 * Re-check also has the Android lane re-read the tools gather() just refreshed, so the
	 * report's `lanes.android.adb` agrees with its adb row (the tester just installed adb).
	 */
	const lane = opts.refresh ? ctx.lanes.android?.rescan().catch(() => void 0) : void 0;
	const [{ items, macos }] = await Promise.all([gathered, lane]);
	return {
		helper: {
			...ctx.about(),
			macos
		},
		lanes: ctx.lanesState(),
		items,
		checkedAt: ctx.now()
	};
}
const STATUS_WORD = {
	ok: "OK",
	warning: "Warning",
	blocking: "Needs action",
	unchecked: "Not checked"
};
const GROUP_TITLE = {
	browser: "This browser",
	helper: "Local helper",
	mac: "This Mac",
	ios: "iPhone tools",
	android: "Android tools",
	device: "Devices"
};
/** A fix as one terminal line: the command itself, so it can be copied as it stands. */
function fixText(fix) {
	switch (fix.kind) {
		case "command": return fix.note ? `${fix.command}  (${fix.note})` : fix.command;
		case "link": return `${fix.label}: ${fix.href}`;
		case "step": return fix.text;
		case "action": return `${fix.label} (a button on the Device Lab page)`;
	}
}
/**
 * Terminal lines for `items`.
 *
 * {all: false} is the banner's part: only the blocking and warning items that are not
 * optional, in the banner's twelve-column layout, each fix on its own line after "→ ".
 * {all: true} is --doctor's: every item under its group, with its status in words (colour
 * never carries meaning alone), the detail line, and the fixes of anything not OK.
 */
function formatChecklist(items, opts) {
	const lines = [];
	if (!opts.all) {
		for (const i of items) {
			if (i.optional || i.status !== "blocking" && i.status !== "warning") continue;
			lines.push(`${i.label.padEnd(11)} ${i.sentence}`);
			for (const fix of i.fixes) lines.push(`${" ".repeat(12)}→ ${fixText(fix)}`);
		}
		return lines;
	}
	const indent = " ".repeat(16);
	let group = null;
	for (const i of items) {
		if (i.group !== group) {
			group = i.group;
			lines.push(GROUP_TITLE[i.group]);
		}
		const label = i.optional ? `${i.label} (optional)` : i.label;
		lines.push(`  ${STATUS_WORD[i.status].padEnd(14)}${label} — ${i.sentence}`);
		if (i.detail) lines.push(indent + i.detail);
		if (i.status !== "ok") for (const fix of i.fixes) lines.push(`${indent}→ ${fixText(fix)}`);
	}
	return lines;
}
/**
 * The whole `--doctor` output (§1.9): who is running, the full checklist, each lane's
 * read-only probe of its attached devices, then one look at this computer's network (§4.9).
 * Paste it into a PR or a bug report: it never holds the token, key material, log text, IMEI,
 * phone numbers, a hardware address or a device's name.
 */
async function printDoctor(ctx, write) {
	const { items, macos } = await gather(ctx, { refresh: true });
	const about = ctx.about();
	write(`${NAME} ${about.version} · doctor`);
	write([
		`Node ${about.node} (OpenSSL ${about.openssl})`,
		`${about.platform}-${about.arch}`,
		macos ? `macOS ${macos}` : null,
		about.flags.length ? about.flags.join(" ") : null
	].filter(Boolean).join(" · "));
	write("");
	for (const line of formatChecklist(items, { all: true })) write(line);
	write("");
	write("Devices");
	let probed = false;
	for (const lane of [
		ctx.lanes.ios,
		ctx.lanes.android,
		ctx.lanes.simulators
	]) {
		if (!lane?.probeForDoctor) continue;
		probed = true;
		try {
			await lane.probeForDoctor((line) => write(`  ${line}`));
		} catch (error) {
			write(`  The ${lane.name} probe stopped early: ${clean(errorText(error), 200)}`);
		}
	}
	if (!probed) write("  No lane can probe devices in this run.");
	if (!ctx.lan) return;
	write("");
	write("Network");
	try {
		await ctx.lan.probeForDoctor((line) => write(`  ${line}`));
	} catch (error) {
		write(`  The network probe stopped early: ${clean(errorText(error), 200)}`);
	}
}

//#endregion
//#region src/websocket.ts
/**
 * §13a WebSocket frames (RFC 6455), the server's half, and only as much of it as the adb
 * tunnel needs (§4.10): the opening handshake's accept key, frames written unmasked and
 * unfragmented, and a decoder for what a browser sends (masked frames, possibly fragmented,
 * pings and a close). No extensions: `permessage-deflate` is never negotiated, so a frame
 * with an RSV bit set is a protocol error.
 *
 * Node has no WebSocket server built in, and the helper has no dependencies, hence this
 * module. A browser cannot open TCP, and fetch() cannot stream a request body over HTTP/1.1,
 * so a WebSocket is the one way a page gets a two-way byte stream to the helper.
 */
/** RFC 6455 §1.3: appended to the client's key before hashing. */
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** A client key is 16 random bytes in base64. */
const WS_KEY = /^[A-Za-z0-9+/]{22}==$/;
/** `Sec-WebSocket-Accept` for a client's `Sec-WebSocket-Key`. */
function acceptKey(key) {
	return createHash("sha1").update(key + GUID, "latin1").digest("base64");
}
const OPCODE = {
	continuation: 0,
	text: 1,
	binary: 2,
	close: 8,
	ping: 9,
	pong: 10
};
/** Close codes the helper sends (RFC 6455 §7.4.1). */
const CLOSE = {
	normal: 1e3,
	goingAway: 1001,
	protocolError: 1002,
	unsupportedData: 1003,
	policyViolation: 1008,
	tooBig: 1009,
	internalError: 1011
};
/** One frame from server to client: never masked (§5.1), always final. */
function encodeFrame(opcode, payload = Buffer.alloc(0)) {
	const length = payload.length;
	let header;
	if (length < 126) {
		header = Buffer.alloc(2);
		header[1] = length;
	} else if (length < 65536) {
		header = Buffer.alloc(4);
		header[1] = 126;
		header.writeUInt16BE(length, 2);
	} else {
		header = Buffer.alloc(10);
		header[1] = 127;
		header.writeUInt32BE(Math.floor(length / 4294967296), 2);
		header.writeUInt32BE(length >>> 0, 6);
	}
	header[0] = 128 | opcode;
	return Buffer.concat([header, payload]);
}
/** A close frame: the code, then a reason of at most 123 bytes. */
function encodeClose(code, reason = "") {
	const text = Buffer.from(reason, "utf8").subarray(0, 123);
	const payload = Buffer.alloc(2 + text.length);
	payload.writeUInt16BE(code, 0);
	text.copy(payload, 2);
	return encodeFrame(OPCODE.close, payload);
}
/** A frame the decoder refused: the connection closes with `code`. */
var WsProtocolError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.name = "WsProtocolError";
		this.code = code;
	}
};
/**
 * Frames from a client, as they complete. `maxPayload` caps one frame (a browser sends a
 * message as one frame, and the page sends at most 256 KiB at a time); larger ones close
 * the connection with 1009 before their payload is buffered.
 */
function createFrameDecoder(maxPayload) {
	let buffered = Buffer.alloc(0);
	/** The opcode of a fragmented message in progress, or null. */
	let message = null;
	/** One frame from the front of `buffered`, or null until it has all arrived. */
	const next = () => {
		if (buffered.length < 2) return null;
		const b0 = buffered[0] ?? 0;
		const b1 = buffered[1] ?? 0;
		const fin = (b0 & 128) !== 0;
		if ((b0 & 112) !== 0) throw new WsProtocolError(CLOSE.protocolError, "No extension was agreed.");
		const opcode = b0 & 15;
		/** §5.1: every frame a client sends is masked. */
		if ((b1 & 128) === 0) throw new WsProtocolError(CLOSE.protocolError, "Client frames are masked.");
		let length = b1 & 127;
		let offset = 2;
		if (length === 126) {
			if (buffered.length < 4) return null;
			length = buffered.readUInt16BE(2);
			offset = 4;
		} else if (length === 127) {
			if (buffered.length < 10) return null;
			if (buffered.readUInt32BE(2) !== 0) throw new WsProtocolError(CLOSE.tooBig, "Frame too large.");
			length = buffered.readUInt32BE(6);
			offset = 10;
		}
		if (opcode >= 8 && (!fin || length > 125)) throw new WsProtocolError(CLOSE.protocolError, "A control frame is short and unfragmented.");
		if (length > maxPayload) throw new WsProtocolError(CLOSE.tooBig, "Frame too large.");
		if (buffered.length < offset + 4 + length) return null;
		const mask = buffered.subarray(offset, offset + 4);
		const payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length));
		for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] ?? 0) ^ (mask[i & 3] ?? 0);
		buffered = buffered.subarray(offset + 4 + length);
		switch (opcode) {
			case OPCODE.text:
			case OPCODE.binary:
				if (message !== null) throw new WsProtocolError(CLOSE.protocolError, "A new message began inside another.");
				if (!fin) message = opcode;
				return {
					kind: "data",
					opcode,
					fin,
					payload
				};
			case OPCODE.continuation: {
				if (message === null) throw new WsProtocolError(CLOSE.protocolError, "Nothing to continue.");
				const of = message;
				if (fin) message = null;
				return {
					kind: "data",
					opcode: of,
					fin,
					payload
				};
			}
			case OPCODE.close: return {
				kind: "close",
				code: payload.length >= 2 ? payload.readUInt16BE(0) : null
			};
			case OPCODE.ping: return {
				kind: "ping",
				payload
			};
			case OPCODE.pong: return { kind: "pong" };
			default: throw new WsProtocolError(CLOSE.protocolError, "Unknown opcode.");
		}
	};
	return { push(chunk) {
		buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
		const frames = [];
		for (let frame = next(); frame; frame = next()) frames.push(frame);
		return frames;
	} };
}
/**
 * The client's `Sec-WebSocket-Protocol` offers, in order. A browser cannot set headers on a
 * WebSocket, so the page sends its token as one of these (`bearer.<token>`, as Kubernetes
 * does); the helper answers with the tunnel's own protocol name only, never the token.
 */
function offeredProtocols(header) {
	return (header ?? "").split(",").map((p) => p.trim()).filter(Boolean);
}

//#endregion
//#region src/adb-tunnel.ts
/** The opening message: `{"service": "<an adb service>"}`. */
function parseHello(text) {
	try {
		const value = JSON.parse(text);
		if (typeof value !== "object" || value === null) return null;
		const service = value.service;
		return typeof service === "string" && service.length > 0 ? service : null;
	} catch {
		return null;
	}
}
/**
 * Serves one upgraded socket. `head` is whatever arrived with the upgrade request after its
 * headers: the start of the page's first frame, possibly.
 */
function serveTunnel(ws, head, o) {
	const decoder = createFrameDecoder(LIMITS.tunnelFrame);
	const life = linkSignals([o.signal]);
	let phase = "hello";
	let hello = [];
	let helloBytes = 0;
	let adb = null;
	let resolveDone = () => void 0;
	const done = new Promise((resolve) => {
		resolveDone = resolve;
	});
	const send = (frame) => ws.writable ? ws.write(frame) : false;
	const sendText = (reply) => {
		send(encodeFrame(OPCODE.text, Buffer.from(JSON.stringify(reply), "utf8")));
	};
	/** Close frame, then the TCP connection; the device's socket goes with it. */
	const close = (code, reason = "") => {
		if (phase === "closed") return;
		phase = "closed";
		clearTimeout(helloTimer);
		life.abort();
		life.dispose();
		if (ws.writable) {
			ws.end(encodeClose(code, reason));
			/** A page that never answers the close frame doesn't keep the socket. */
			setTimeout(() => ws.destroy(), 1e3).unref();
		} else ws.destroy();
		adb?.destroy();
	};
	const helloTimer = setTimeout(() => {
		close(CLOSE.policyViolation, "No service was named.");
	}, o.helloMs);
	helloTimer.unref();
	/** Whether a side waits for the other's 'drain': one listener at a time, however many writes. */
	let pageFull = false;
	let deviceFull = false;
	/** The device's bytes go to the page as binary frames, paused while the page lags. */
	const pipeFromDevice = (device) => {
		device.on("data", (chunk) => {
			if (phase !== "open") return;
			if (!send(encodeFrame(OPCODE.binary, chunk)) && !pageFull) {
				pageFull = true;
				device.pause();
				ws.once("drain", () => {
					pageFull = false;
					if (phase === "open") device.resume();
				});
			}
		});
		/** The service ended (a command finished, a file was read): the tunnel ends with it. */
		device.on("end", () => close(CLOSE.normal));
		device.on("close", () => close(CLOSE.normal));
		device.on("error", () => close(CLOSE.normal));
		device.resume();
	};
	const opening = (service) => {
		phase = "opening";
		clearTimeout(helloTimer);
		/** A refusal thrown before any promise exists still becomes the error message. */
		Promise.resolve().then(() => o.open(service, life.signal)).then((device) => {
			if (phase !== "opening") {
				device.destroy();
				return;
			}
			adb = device;
			sendText({ t: "ok" });
			phase = "open";
			pipeFromDevice(device);
		}, (error) => {
			if (phase !== "opening") return;
			const said = o.describe(error);
			if (said) sendText({
				t: "error",
				code: said.code,
				message: said.message
			});
			close(CLOSE.normal);
		});
	};
	const onFrames = (chunk) => {
		let frames;
		try {
			frames = decoder.push(chunk);
		} catch (error) {
			close(error instanceof WsProtocolError ? error.code : CLOSE.protocolError);
			return;
		}
		for (const frame of frames) {
			if (phase === "closed") return;
			switch (frame.kind) {
				case "ping":
					send(encodeFrame(OPCODE.pong, frame.payload));
					break;
				case "pong": break;
				case "close":
					/** Echo the page's code, as RFC 6455 §5.5.1 asks; none means a normal close. */
					close(frame.code !== null && frame.code >= 1e3 && frame.code < 5e3 ? frame.code : 1e3);
					return;
				case "data": if (phase === "hello") {
					if (frame.opcode !== OPCODE.text) {
						close(CLOSE.unsupportedData, "Name the service first.");
						return;
					}
					helloBytes += frame.payload.length;
					if (helloBytes > LIMITS.tunnelHello) {
						close(CLOSE.tooBig);
						return;
					}
					hello.push(frame.payload);
					if (!frame.fin) break;
					const service = parseHello(Buffer.concat(hello).toString("utf8"));
					hello = [];
					if (service === null) {
						close(CLOSE.unsupportedData, "Name the service first.");
						return;
					}
					opening(service);
				} else if (phase === "opening" || frame.opcode !== OPCODE.binary) {
					/** The page waits for "ok" before it writes, and writes bytes only. */
					close(CLOSE.protocolError);
					return;
				} else if (adb && frame.payload.length > 0 && !adb.write(frame.payload) && !deviceFull) {
					deviceFull = true;
					ws.pause();
					adb.once("drain", () => {
						deviceFull = false;
						if (phase === "open") ws.resume();
					});
				}
			}
		}
	};
	ws.on("data", onFrames);
	ws.on("error", () => void 0);
	/** The HTTP server's sockets are half-open: a page that went away only ends its side. */
	ws.on("end", () => close(CLOSE.normal));
	ws.on("close", () => {
		if (phase !== "closed") {
			phase = "closed";
			clearTimeout(helloTimer);
			life.abort();
			life.dispose();
			adb?.destroy();
		}
		resolveDone();
	});
	if (head.length) onFrames(head);
	if (o.signal.aborted) close(CLOSE.goingAway);
	return {
		close,
		done
	};
}

//#endregion
//#region src/http.ts
/** The adb tunnel's WebSocket subprotocol (§4.10); the helper answers with this one only. */
const TUNNEL_PROTOCOL = "device-bridge.adb.v1";
/** The page's token, offered as a second subprotocol: `bearer.<token>`. */
const BEARER_PROTOCOL = "bearer.";
/** ECIDs and other identifiers can exceed 2^53; a stray BigInt must never crash a reply. */
function bigintReplacer(_key, value) {
	return typeof value === "bigint" ? value.toString() : value;
}
function toJson(body) {
	return JSON.stringify(body, bigintReplacer);
}
/** A JSON reply with a Content-Length. Silently skipped when the client already left. */
function sendJson(res, status, body, headers) {
	if (res.headersSent || res.destroyed) return;
	const bytes = Buffer.from(toJson(body), "utf8");
	res.writeHead(status, {
		...headers,
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": String(bytes.length)
	});
	res.end(bytes);
}
function errorBody(code, message, extra = {}) {
	return { error: {
		...extra,
		code,
		message
	} };
}
/** What a failure looks like on the wire, or null when nobody is left to tell (an abort). */
function describeError(error) {
	if (error instanceof HelperError) return {
		status: error.status,
		body: errorBody(error.code, error.message, { ...error.extra })
	};
	if (error instanceof ToolError) {
		const tool = path.basename(error.file);
		switch (error.reason) {
			case "aborted": return null;
			case "not-found": return {
				status: 503,
				body: errorBody("TOOL_MISSING", `${tool} is not installed.`, { tool })
			};
			case "timeout": return {
				status: 504,
				body: errorBody("TOOL_TIMEOUT", `${tool} took too long to answer.`)
			};
			case "too-large": return {
				status: 502,
				body: errorBody("TOOL_FAILED", `${tool} printed more than the helper accepts.`)
			};
			case "exit":
			case "spawn-failed": {
				const said = clean(error.stderr.trim(), LIMITS.stderr).slice(-500);
				const fallback = error.reason === "exit" ? `${tool} failed (exit code ${String(error.code)}).` : `${tool} could not be started.`;
				return {
					status: 502,
					body: errorBody("TOOL_FAILED", said || fallback)
				};
			}
		}
	}
	if (isAbortError(error)) return null;
	return {
		status: 500,
		body: errorBody("INTERNAL", "The helper hit a bug. Its terminal window says more.")
	};
}
const PAGE_PATHS = new Set([
	"/",
	"/device",
	"/device/",
	"/device/index.html"
]);
/** `/api/x?y` → ['/api/x', '?y'], without normalising: ids are checked exactly as sent. */
function splitTarget(target) {
	const q = target.indexOf("?");
	return q < 0 ? {
		pathname: target,
		search: ""
	} : {
		pathname: target.slice(0, q),
		search: target.slice(q)
	};
}
/** Headers on every /api/* reply, errors included, so the page can read a 401 or a 409. */
function apiHeaders(origin) {
	return {
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
		"Cross-Origin-Resource-Policy": "same-origin",
		Vary: "Origin",
		"Access-Control-Expose-Headers": "X-Screenshot-Source",
		...origin ? { "Access-Control-Allow-Origin": origin } : {}
	};
}
/** For refusals before the Origin is accepted: no CORS header, so no page can read them. */
const BARE = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
	Vary: "Origin"
};
function bodyTooLarge(req) {
	const length = req.headers["content-length"];
	if (length !== void 0) return !/^\d+$/.test(length) || Number(length) > LIMITS.body;
	/** A chunked body has no length to check; the Wi-Fi routes' JSON always comes with one. */
	return req.headers["transfer-encoding"] !== void 0;
}
/** A top-level navigation to the local page: the one cross-site request without Origin let in. */
function isPageNavigation(req, pathname) {
	return req.headers["sec-fetch-mode"] === "navigate" && req.headers["sec-fetch-dest"] === "document" && PAGE_PATHS.has(pathname);
}
const ROUTES = {
	"/api/health": "GET",
	"/api/devices": "GET",
	"/api/rescan": "POST",
	"/api/doctor": "GET",
	"/api/android/start-server": "POST",
	"/api/android/connect": "POST",
	"/api/android/pair": "POST",
	"/api/android/disconnect": "POST",
	"/api/android/nearby": "GET",
	"/api/lan/devices": "GET"
};
const DEVICE_ROUTE = /^\/api\/devices\/([^/]*)\/(detail|screenshot|retry|logs|adb)$/;
const DEVICE_ACTIONS = {
	detail: "GET",
	screenshot: "POST",
	retry: "POST",
	logs: "GET",
	adb: "GET"
};
/** The adb tunnel's WebSocket (§4.10): the same path as its GET, upgraded. */
const TUNNEL_ROUTE = /^\/api\/devices\/([^/]*)\/adb$/;
/** A log stream that ends before hello answers with an ordinary JSON error (§2.5). */
const OPENING_ERRORS = {
	"device-gone": () => new HelperError("DEVICE_NOT_FOUND", 404, "The device is no longer connected."),
	replaced: () => new HelperError("STREAM_REPLACED", 409, "A newer log stream for this device replaced this one."),
	shutdown: () => new HelperError("HELPER_STOPPING", 503, "The helper is stopping.")
};
/** A stream whose lane failed with one of these ends as device-gone: the device left or dropped. */
const DEVICE_GONE_CODES = new Set(["DEVICE_NOT_FOUND", "DEVICE_DROPPED"]);
/**
 * The HTTP API (§2): every request goes through the pipeline of §2.1 in its fixed order —
 * Host, Origin, Fetch Metadata, body cap, preflight, public health, bearer token — and
 * only then reaches a route. Device routes find their lane through the registry, never
 * through the shape of the id, and every operation gets a signal that aborts when the
 * client leaves or the helper stops, so no tool outlives the request that started it.
 */
function createApi(deps) {
	const { options, registry, lanes } = deps;
	const shots = new Set();
	const streams = new Map();
	const tunnels = new Set();
	/** Open adb tunnels per device id (§4.10). */
	const tunnelsOf = new Map();
	let hostsFor = -1;
	let hosts = new Set();
	let origins = new Set();
	/** Host and Origin allowlists, rebuilt when the port is known (listen) or changes (tests). */
	const allowlists = () => {
		const port = deps.port();
		if (port !== hostsFor) {
			hostsFor = port;
			hosts = new Set([`127.0.0.1:${String(port)}`, `localhost:${String(port)}`]);
			origins = new Set([
				SITE,
				`http://127.0.0.1:${String(port)}`,
				`http://localhost:${String(port)}`,
				...options.dev ? DEV_ORIGINS : []
			]);
		}
		return {
			hosts,
			origins
		};
	};
	const fail = (res, error, headers) => {
		const described = describeError(error);
		if (!described) {
			if (!res.headersSent) res.destroy();
			return;
		}
		if (described.status >= 500 && described.body.error.code === "INTERNAL") deps.bug(error);
		if (described.body.error.code === "TOOL_MISSING") deps.tools.refresh().catch(() => void 0);
		if (res.headersSent) {
			res.destroy();
			return;
		}
		sendJson(res, described.status, described.body, headers);
	};
	function handle(req, res) {
		const started = Date.now();
		const { pathname, search } = splitTarget(req.url ?? "/");
		if (options.verbose) {
			/** Method, path and status only: never a header, a query string or a token. */
			let logged = false;
			const line = () => {
				if (logged) return;
				logged = true;
				deps.log(`${req.method ?? "?"} ${pathname} ${String(res.statusCode)} ${String(Date.now() - started)} ms`);
			};
			res.on("finish", line);
			res.on("close", line);
		}
		pipeline(req, res, pathname, search).catch((error) => fail(res, error, BARE));
	}
	/** §2.1, in this order, every step tested. */
	async function pipeline(req, res, pathname, search) {
		const { hosts, origins } = allowlists();
		/** 1. Host: a DNS-rebound evil.example still says `Host: evil.example:8787`. */
		const host = (req.headers.host ?? "").toLowerCase();
		if (!hosts.has(host)) return sendJson(res, 421, errorBody("BAD_HOST", "This helper answers only to 127.0.0.1 and localhost."), BARE);
		if (!pathname.startsWith("/")) return sendJson(res, 400, errorBody("BAD_REQUEST", "Only origin-form request targets."), BARE);
		/** 2. Origin, when sent: exact match, never echoed unless allowed. */
		const origin = req.headers.origin;
		if (origin !== void 0 && !origins.has(origin)) return sendJson(res, 403, errorBody("BAD_ORIGIN", "This page may not use the helper."), BARE);
		/** 3. Fetch Metadata: <img>, forms and no-cors requests from other sites carry no Origin. */
		const site = req.headers["sec-fetch-site"];
		if (origin === void 0 && (site === "cross-site" || site === "same-site") && !isPageNavigation(req, pathname)) return sendJson(res, 403, errorBody("BAD_ORIGIN", "Cross-site requests need an allowed Origin."), BARE);
		const isApi = pathname === "/api" || pathname.startsWith("/api/");
		const headers = isApi ? apiHeaders(origin) : {
			"X-Content-Type-Options": "nosniff",
			Vary: "Origin",
			...origin ? { "Access-Control-Allow-Origin": origin } : {}
		};
		if (bodyTooLarge(req)) return sendJson(res, 413, errorBody("PAYLOAD_TOO_LARGE", "Request bodies are at most 1 KiB, sent with a Content-Length."), {
			...headers,
			Connection: "close"
		});
		/** 4. The CORS preflight: no token needed; Authorization is never covered by `*`. */
		if (req.method === "OPTIONS") {
			if (!isApi) return sendJson(res, 405, errorBody("METHOD_NOT_ALLOWED", "GET only."), {
				...headers,
				Allow: "GET, HEAD"
			});
			const preflight = {
				...headers,
				"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
				"Access-Control-Allow-Headers": "Authorization, Content-Type",
				"Access-Control-Max-Age": "600",
				Vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network"
			};
			/** Chromium 104–141's Private Network Access preflight; LNA (142+) asks the user instead. */
			if (req.headers["access-control-request-private-network"] === "true") preflight["Access-Control-Allow-Private-Network"] = "true";
			res.writeHead(204, preflight);
			res.end();
			return;
		}
		if (!isApi) {
			if (!deps.local) return sendJson(res, 404, errorBody("NOT_FOUND", "Nothing here."), headers);
			return deps.local.handle(req, res, pathname, search, host);
		}
		/** 5. Health is public: it carries no device data and never the token. */
		if (pathname === "/api/health") {
			if (req.method !== "GET") return methodNotAllowed(res, "GET", headers);
			const challenge = new URLSearchParams(search).get("challenge");
			return sendJson(res, 200, deps.health(challenge), headers);
		}
		/** 6. Every other /api/* needs the bearer token. */
		if (!deps.bearer(req.headers.authorization)) return sendJson(res, 401, errorBody("UNAUTHORIZED", "Missing or wrong token. Open the link the helper printed.", { tokenId: deps.tokenId }), {
			...headers,
			"WWW-Authenticate": "Bearer realm=\"device-bridge\""
		});
		registry.touch();
		deps.pageConnected(origin, host, req.headers["user-agent"]);
		/** 7. Route. */
		try {
			await route(req, res, pathname, search, headers);
		} catch (error) {
			fail(res, error, headers);
		}
	}
	function methodNotAllowed(res, allow, headers) {
		sendJson(res, 405, errorBody("METHOD_NOT_ALLOWED", `${allow} only.`), {
			...headers,
			Allow: allow
		});
	}
	/** An AbortSignal for one operation: the client leaving, shutdown, or an optional deadline. */
	function operation(res, timeoutMs) {
		const op = linkSignals([deps.signal], timeoutMs);
		/**
		 * `res` 'close' before the response finished is the one reliable "client went away"
		 * signal (req 'close' fires as soon as the request body is read).
		 */
		res.on("close", () => {
			if (!res.writableFinished) op.abort();
		});
		return op;
	}
	async function route(req, res, pathname, search, headers) {
		const method = req.method ?? "GET";
		const fixed = ROUTES[pathname];
		if (fixed) {
			if (method !== fixed) return methodNotAllowed(res, fixed, headers);
			if (pathname === "/api/devices") return sendJson(res, 200, registry.snapshot(), headers);
			if (pathname === "/api/rescan") return rescan(res, headers);
			if (pathname === "/api/doctor") {
				const refresh = new URLSearchParams(search).get("refresh") === "1";
				return sendJson(res, 200, await deps.doctor(refresh), headers);
			}
			if (pathname === "/api/android/connect") return connectNetwork(req, res, headers);
			if (pathname === "/api/android/pair") return pairNetwork(req, res, headers);
			if (pathname === "/api/android/disconnect") return disconnectNetwork(req, res, headers);
			if (pathname === "/api/android/nearby") return nearby(res, search, headers);
			if (pathname === "/api/lan/devices") return lanDevices(res, search, headers);
			/** The last fixed route: every one above has its own line, or it would land here. */
			return startAdbServer(res, headers);
		}
		const match = DEVICE_ROUTE.exec(pathname);
		if (!match) return sendJson(res, 404, errorBody("NOT_FOUND", "No such endpoint."), headers);
		const action = match[2];
		if (method !== DEVICE_ACTIONS[action]) return methodNotAllowed(res, DEVICE_ACTIONS[action], headers);
		const { id, lane, row } = resolveDevice(match[1] ?? "");
		if (action === "retry") return retry(res, headers, id, lane);
		assertReady(row);
		if (action === "adb") {
			const android = tunnelLane(id);
			const op = operation(res);
			try {
				return sendJson(res, 200, await android.adbInfo(id, op.signal), headers);
			} finally {
				op.dispose();
			}
		}
		if (action === "detail") {
			const op = operation(res);
			try {
				return sendJson(res, 200, await lane.detail(id, op.signal), headers);
			} finally {
				op.dispose();
			}
		}
		if (action === "screenshot") return screenshot(res, headers, id, lane);
		return openLogStream(res, headers, id, lane);
	}
	function assertReady(row) {
		if (row.state !== "ready") throw new HelperError("DEVICE_NOT_READY", 409, "The device is not ready yet.", {
			state: row.state,
			blockers: row.blockers
		});
	}
	/** §4.10: only the Android lane's devices have an adb tunnel. */
	function tunnelLane(id) {
		if (registry.owner(id) !== "android") throw new HelperError("BAD_REQUEST", 400, "Only an Android device has an adb tunnel.");
		return androidLane();
	}
	/**
	 * §4.10, the adb tunnel's WebSocket. The gate of §2.1, stricter where a WebSocket differs:
	 * CORS never applies to one, so an allowed Origin is required (a browser always sends it),
	 * and the token comes as a subprotocol, `bearer.<token>`, since a page can't set headers on
	 * a WebSocket. Refusals until then are bare HTTP replies, which a page can't read. Once the
	 * token is right the WebSocket opens, and a tunnel that can't open says why in its first
	 * message, which the page can read.
	 */
	function upgrade(req, socket, head) {
		socket.on("error", () => void 0);
		const started = Date.now();
		const { pathname } = splitTarget(req.url ?? "/");
		const refuse = (status, code, message, extra = {}) => {
			const body = toJson(errorBody(code, message));
			const lines = [
				`HTTP/1.1 ${String(status)} ${STATUS_CODES[status] ?? "Error"}`,
				"Connection: close",
				"Content-Type: application/json; charset=utf-8",
				`Content-Length: ${String(Buffer.byteLength(body))}`,
				...Object.entries({
					...BARE,
					...extra
				}).map(([name, value]) => `${name}: ${value}`)
			];
			socket.end(`${lines.join("\r\n")}\r\n\r\n${body}`);
			if (options.verbose) deps.log(`WS ${pathname} ${String(status)}`);
		};
		const { hosts, origins } = allowlists();
		const host = (req.headers.host ?? "").toLowerCase();
		if (!hosts.has(host)) return refuse(421, "BAD_HOST", "This helper answers only to 127.0.0.1 and localhost.");
		const origin = req.headers.origin;
		if (origin === void 0 || !origins.has(origin)) return refuse(403, "BAD_ORIGIN", "This page may not use the helper.");
		const match = TUNNEL_ROUTE.exec(pathname);
		if (!match || req.method !== "GET") return refuse(404, "NOT_FOUND", "No such endpoint.");
		const key = req.headers["sec-websocket-key"];
		if ((req.headers.upgrade ?? "").toLowerCase() !== "websocket" || typeof key !== "string" || !WS_KEY.test(key)) return refuse(400, "BAD_REQUEST", "Not a WebSocket handshake.");
		if (req.headers["sec-websocket-version"] !== "13") return refuse(426, "BAD_REQUEST", "WebSocket version 13 only.", { "Sec-WebSocket-Version": "13" });
		const offered = offeredProtocols(req.headers["sec-websocket-protocol"]);
		const bearer = offered.find((p) => p.startsWith(BEARER_PROTOCOL));
		if (!offered.includes("device-bridge.adb.v1") || !deps.bearer(bearer ? `Bearer ${bearer.slice(7)}` : void 0)) return refuse(401, "UNAUTHORIZED", "Missing or wrong token. Open the link the helper printed.", { "WWW-Authenticate": "Bearer realm=\"device-bridge\"" });
		registry.touch();
		deps.pageConnected(origin, host, req.headers["user-agent"]);
		socket.write([
			"HTTP/1.1 101 Switching Protocols",
			"Upgrade: websocket",
			"Connection: Upgrade",
			`Sec-WebSocket-Accept: ${acceptKey(key)}`,
			`Sec-WebSocket-Protocol: ${TUNNEL_PROTOCOL}`,
			"",
			""
		].join("\r\n"));
		if (socket instanceof Socket) socket.setNoDelay(true);
		let counted = null;
		const tunnel = serveTunnel(socket, head, {
			open: (service, signal) => {
				const { id, row } = resolveDevice(match[1] ?? "");
				const android = tunnelLane(id);
				assertReady(row);
				/** Refused here with a clear answer; the adb client checks it again before sending. */
				assertTunnelService(service);
				const mine = tunnelsOf.get(id) ?? 0;
				if (tunnels.size > LIMITS.tunnels || mine >= LIMITS.tunnelsPerDevice) throw new HelperError("TUNNEL_LIMIT", 429, "Too many operations are open on the helper at once. Try again in a moment.");
				counted = id;
				tunnelsOf.set(id, mine + 1);
				return android.openTunnel(id, service, signal);
			},
			describe(error) {
				const described = describeError(error);
				if (!described) return null;
				if (described.status >= 500 && described.body.error.code === "INTERNAL") deps.bug(error);
				return {
					code: described.body.error.code,
					message: described.body.error.message
				};
			},
			helloMs: options.timeouts.tunnelHello,
			signal: deps.signal,
			bug: deps.bug
		});
		tunnels.add(tunnel);
		tunnel.done.then(() => {
			tunnels.delete(tunnel);
			if (counted !== null) {
				const left = (tunnelsOf.get(counted) ?? 1) - 1;
				if (left > 0) tunnelsOf.set(counted, left);
				else tunnelsOf.delete(counted);
			}
			/** The path only: never the service, which is a command line. */
			if (options.verbose) deps.log(`WS ${pathname} ${String(Date.now() - started)} ms`);
		});
	}
	/** §2.2 `:id`: decoded, shape-checked, and listed right now; its lane comes from the registry. */
	function resolveDevice(raw) {
		let id;
		try {
			id = decodeURIComponent(raw);
		} catch {
			throw new HelperError("BAD_ID", 400, "That device id is malformed.");
		}
		if (!isDeviceId(id)) throw new HelperError("BAD_ID", 400, "That is not a device id.");
		const owner = registry.owner(id);
		const lane = owner ? lanes[owner] : void 0;
		const row = registry.device(id);
		if (!lane || !row) throw new HelperError("DEVICE_NOT_FOUND", 404, "The device is no longer connected.");
		return {
			id,
			lane,
			row
		};
	}
	async function rescan(res, headers) {
		const op = operation(res, options.timeouts.rescan);
		try {
			const all = Promise.allSettled([
				lanes.ios,
				lanes.android,
				lanes.simulators
			].map((lane) => Promise.resolve().then(() => lane?.rescan({ signal: op.signal }))));
			/** Bounded even if a lane ignores its signal: the page gets the snapshot as it stands. */
			await Promise.race([all, aborted(op.signal)]);
		} finally {
			op.dispose();
		}
		sendJson(res, 200, registry.snapshot(), headers);
	}
	async function retry(res, headers, id, lane) {
		const op = operation(res, options.timeouts.retry);
		try {
			await Promise.race([lane.retry(id, op.signal), aborted(op.signal)]);
		} catch (error) {
			if (!op.signal.aborted) throw error;
		} finally {
			op.dispose();
		}
		if (res.destroyed) return;
		sendJson(res, 200, { device: registry.device(id) }, headers);
	}
	function androidLane() {
		const android = lanes.android;
		if (!android) throw new HelperError("ANDROID_OFF", 409, "The helper was started with --no-android.");
		return android;
	}
	async function startAdbServer(res, headers) {
		const android = androidLane();
		const op = operation(res);
		try {
			await android.startServer(op.signal);
		} finally {
			op.dispose();
		}
		sendJson(res, 200, { android: registry.lanes().android }, headers);
	}
	/**
	 * The JSON object a Wi-Fi route reads (§4.7): application/json, at most 1 KiB (the gate
	 * checked the Content-Length), an object holding only the named fields. A request whose
	 * client leaves mid-body is aborted quietly.
	 */
	function readJson(req, fields) {
		if ((req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() !== "application/json") return Promise.reject(new HelperError("BAD_REQUEST", 400, "Send the request as JSON (application/json)."));
		return new Promise((resolve, reject) => {
			const chunks = [];
			let length = 0;
			req.on("data", (chunk) => {
				length += chunk.length;
				if (length <= LIMITS.body) chunks.push(chunk);
			});
			req.on("error", () => reject(abortError()));
			req.on("close", () => {
				if (!req.complete) reject(abortError());
			});
			req.on("end", () => {
				if (length > LIMITS.body) return reject(new HelperError("PAYLOAD_TOO_LARGE", 413, "The request is too large."));
				let value;
				try {
					value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				} catch {
					return reject(new HelperError("BAD_REQUEST", 400, "The request is not valid JSON."));
				}
				if (typeof value !== "object" || value === null || Array.isArray(value)) return reject(new HelperError("BAD_REQUEST", 400, "The request must be a JSON object."));
				if (Object.keys(value).some((key) => !fields.includes(key))) return reject(new HelperError("BAD_REQUEST", 400, `Only these fields are allowed: ${fields.join(", ")}.`));
				resolve(value);
			});
		});
	}
	/** POST /api/android/connect {host, port?}: `host:connect:` on the tester's click (§4.7). */
	async function connectNetwork(req, res, headers) {
		const android = androidLane();
		const body = await readJson(req, ["host", "port"]);
		const host = parseNetworkHost(body.host);
		const port = parseNetworkPort(body.port, ADB_NETWORK_PORT);
		const op = operation(res);
		try {
			const outcome = await android.connectNetwork({
				host,
				port
			}, op.signal);
			sendJson(res, 200, {
				...outcome,
				device: registry.device(outcome.serial)
			}, headers);
		} finally {
			op.dispose();
		}
	}
	/** POST /api/android/pair {host, port, code}: Wireless debugging's pairing code (§4.7). */
	async function pairNetwork(req, res, headers) {
		const android = androidLane();
		const body = await readJson(req, [
			"host",
			"port",
			"code"
		]);
		const host = parseNetworkHost(body.host);
		const port = parseNetworkPort(body.port);
		const code = parsePairingCode(body.code);
		const op = operation(res);
		try {
			const { message } = await android.pairNetwork({
				host,
				port,
				code
			}, op.signal);
			sendJson(res, 200, {
				result: "paired",
				host,
				port,
				message
			}, headers);
		} finally {
			op.dispose();
		}
	}
	/** POST /api/android/disconnect {serial}: only a network serial the server lists (§4.7). */
	async function disconnectNetwork(req, res, headers) {
		const android = androidLane();
		const serial = (await readJson(req, ["serial"])).serial;
		if (typeof serial !== "string" || !serial) throw new HelperError("BAD_REQUEST", 400, "Name the Wi-Fi device to disconnect.");
		if (!isDeviceId(serial)) throw new HelperError("BAD_REQUEST", 400, "That is not a device id.");
		const op = operation(res);
		try {
			const { message } = await android.disconnectNetwork(serial, op.signal);
			sendJson(res, 200, {
				result: "disconnected",
				serial,
				message
			}, headers);
		} finally {
			op.dispose();
		}
	}
	/**
	 * GET /api/android/nearby[?refresh=1]: the Android devices advertising adb on the local
	 * network (§4.8). Read-only: nothing is connected, paired or started.
	 */
	async function nearby(res, search, headers) {
		const android = androidLane();
		const refresh = new URLSearchParams(search).get("refresh") === "1";
		const op = operation(res);
		try {
			sendJson(res, 200, await android.nearby(refresh, op.signal), headers);
		} finally {
			op.dispose();
		}
	}
	/**
	 * GET /api/lan/devices[?refresh=1]: every device on this computer's network (§4.9). Read-only,
	 * and the bridge's own: it needs no lane, so `--no-android` leaves it on. A look runs on the
	 * helper's signal; this request only stops waiting when its client leaves.
	 */
	async function lanDevices(res, search, headers) {
		const refresh = new URLSearchParams(search).get("refresh") === "1";
		const op = operation(res);
		try {
			sendJson(res, 200, await deps.lan.devices(refresh, op.signal), headers);
		} finally {
			op.dispose();
		}
	}
	async function screenshot(res, headers, id, lane) {
		if (shots.has(id)) throw new HelperError("BUSY", 409, "A screenshot of this device is already being taken.");
		shots.add(id);
		const op = operation(res);
		const started = Date.now();
		try {
			const shot = await lane.screenshot(id, op.signal);
			const png = extractPng(shot.png);
			if (!png) throw new HelperError("SCREENSHOT_NOT_PNG", 502, "The device returned something that is not a PNG.");
			if (res.destroyed) return;
			res.writeHead(200, {
				...headers,
				"Content-Type": "image/png",
				"Content-Length": String(png.length),
				"Content-Disposition": `inline; filename="${id.replace(/[^\w.-]/g, "_")}.png"`,
				"X-Screenshot-Source": shot.source
			});
			res.end(png);
			deps.log(`screenshot ${seconds(Date.now() - started)} s (${shot.source})`);
		} finally {
			shots.delete(id);
			op.dispose();
		}
	}
	/**
	 * §2.5. The reply stays a plain JSON error until the lane says hello; from then on it is
	 * NDJSON and ends with exactly one `end` record, unless the client went away first.
	 */
	function openLogStream(res, headers, id, lane) {
		const previous = streams.get(id);
		if (!previous && streams.size >= LIMITS.streamsTotal) throw new HelperError("TOO_MANY_STREAMS", 429, "Too many logs are open. Stop one, then start this one.");
		/** One per device: the new stream replaces the old one, which frees the device's log source. */
		previous?.end("replaced");
		const op = linkSignals([deps.signal]);
		const { batchLines, batchBytes, line: maxLine } = LIMITS;
		let phase = "opening";
		let pending = [];
		let pendingBytes = 0;
		let flushTimer;
		let ping;
		let needDrain = false;
		const write = (message) => {
			if (res.destroyed || res.writableEnded) return;
			if (!res.write(toJson(message) + "\n")) needDrain = true;
		};
		res.on("drain", () => {
			needDrain = false;
		});
		const flush = () => {
			clearTimeout(flushTimer);
			flushTimer = void 0;
			while (pending.length) {
				let count = 0;
				let bytes = 0;
				while (count < pending.length && count < batchLines && bytes < batchBytes) {
					bytes += (pending[count]?.length ?? 0) + 4;
					count++;
				}
				write({
					t: "lines",
					lines: pending.slice(0, count)
				});
				pending = pending.slice(count);
			}
			pendingBytes = 0;
		};
		/** Settles once: when the lane says hello (no error), or with the error for a JSON reply. */
		let settleOpening = () => void 0;
		const opened = new Promise((resolve) => {
			settleOpening = resolve;
		});
		/**
		 * The one way a stream ends. While streaming it writes the `end` record (unless the
		 * client is gone); before hello it settles the request with `openingError`, or the
		 * JSON error that matches `reason`.
		 */
		const end = (reason, extra = {}, openingError) => {
			if (phase === "ended") return;
			const wasStreaming = phase === "streaming";
			phase = "ended";
			clearTimeout(flushTimer);
			clearInterval(ping);
			clearTimeout(helloTimer);
			if (streams.get(id) === stream) streams.delete(id);
			unsubscribe();
			op.abort();
			if (wasStreaming) {
				if (reason !== "client-gone") {
					flush();
					write({
						t: "end",
						reason,
						...extra
					});
					res.end();
				}
				return;
			}
			const error = openingError ?? OPENING_ERRORS[reason]?.() ?? null;
			settleOpening({ error: error === null || error instanceof Error ? error : new Error(errorText(error)) });
		};
		const stream = { end };
		streams.set(id, stream);
		const unsubscribe = registry.subscribe(({ removed }) => {
			if (removed.includes(id)) end("device-gone");
		});
		res.on("close", () => {
			if (!res.writableFinished) end("client-gone");
		});
		const helloTimer = setTimeout(() => {
			end("error", {}, new HelperError("TOOL_TIMEOUT", 504, "The log source did not start."));
		}, options.timeouts.logHello);
		const sink = {
			hello(source) {
				if (phase !== "opening") return;
				phase = "streaming";
				clearTimeout(helloTimer);
				res.writeHead(200, {
					...headers,
					"Content-Type": "application/x-ndjson; charset=utf-8"
				});
				write({
					t: "hello",
					device: id,
					source,
					at: Date.now()
				});
				ping = setInterval(() => write({
					t: "ping",
					at: Date.now()
				}), options.heartbeatMs);
				settleOpening({ error: null });
			},
			push(lines) {
				if (phase !== "streaming") return phase !== "ended";
				for (const raw of lines) {
					const text = clean(raw, maxLine);
					pending.push(text);
					pendingBytes += text.length + 4;
				}
				if (pending.length >= batchLines || pendingBytes >= batchBytes) flush();
				else flushTimer ??= setTimeout(flush, options.timeouts.logBatch);
				return !needDrain;
			},
			drain() {
				if (phase === "ended" || !needDrain) return Promise.resolve();
				return new Promise((resolve) => {
					const done = () => {
						res.off("drain", done);
						res.off("close", done);
						op.signal.removeEventListener("abort", done);
						resolve();
					};
					res.on("drain", done);
					res.on("close", done);
					op.signal.addEventListener("abort", done, { once: true });
				});
			},
			notice(text) {
				if (phase !== "streaming") return;
				flush();
				write({
					t: "notice",
					text: clean(text, 500)
				});
			}
		};
		/** Promise.resolve().then: a lane that throws synchronously still ends this stream. */
		Promise.resolve().then(() => lane.logs(id, sink, op.signal)).then(() => {
			if (phase === "opening") {
				const none = new HelperError("LOGS_UNAVAILABLE", 503, "No log source works for this device.");
				return end("error", {}, none);
			}
			end(registry.device(id) ? "eof" : "device-gone");
		}, (error) => {
			if (phase === "opening") return end("error", {}, error);
			const described = describeError(error);
			if (!described) return end("client-gone");
			const { code, message } = described.body.error;
			if (code === "INTERNAL") deps.bug(error);
			end(DEVICE_GONE_CODES.has(code) ? "device-gone" : "error", {
				code,
				message
			});
		});
		return opened.then(({ error }) => {
			if (error) throw error;
		});
	}
	return {
		handle,
		upgrade,
		endStreams(reason) {
			for (const stream of [...streams.values()]) stream.end(reason);
			for (const tunnel of [...tunnels]) tunnel.close(CLOSE.goingAway, "The helper is stopping.");
		},
		openStreams: () => streams.size,
		openTunnels: () => tunnels.size
	};
}
/** For INTERNAL errors: the stack on stderr, never in a reply. */
function bugText(error) {
	return error instanceof Error ? error.stack ?? errorText(error) : errorText(error);
}

//#endregion
//#region src/local-mode.ts
/**
 * The only upstream files local mode serves (§2.9): hashed build assets, and this helper's
 * own published file for the Environment check's update row. Everything else redirects to
 * the live site; nothing is ever read from this Mac's disk.
 */
const LOCAL_ASSET = /^\/(?:assets\/[\w.-]{1,120}\.(?:js|css|woff2?|png|jpe?g|svg|webp|ico|pdf)|device\/agent\/device-bridge\.mjs)$/;
/** Old and short page URLs that land on /device/, query kept. */
const PAGE_REDIRECTS = new Set([
	"/",
	"/device",
	"/device/index.html"
]);
/**
 * Every inline script, so the CSP can hash each one: a future inline module script cannot
 * silently break local mode the way a hash-the-first-script rule would.
 */
const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
/** By extension, never from upstream: a proxied file can't arrive with a surprising type. */
const TYPES = {
	js: "text/javascript; charset=utf-8",
	mjs: "text/javascript; charset=utf-8",
	css: "text/css; charset=utf-8",
	woff: "font/woff",
	woff2: "font/woff2",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	svg: "image/svg+xml",
	webp: "image/webp",
	ico: "image/x-icon",
	pdf: "application/pdf"
};
/**
 * The boot record the local page reads before its bundle runs. It never carries the token:
 * that arrives only through `#pair=` or the pair dialog. `<` is escaped so no value can end
 * the script element.
 */
function bootScript(apiBase) {
	return `<script>window.DVC_BOOT=${JSON.stringify({
		mode: "local",
		apiBase,
		protocol: 1,
		version: VERSION
	}).replace(/</g, "\\u003c")}<\/script>`;
}
/**
 * The page's CSP: scripts from this origin plus the hash of every inline script in `html`.
 * `apiBase` (`http://127.0.0.1:8787`) adds its WebSocket address to connect-src, for the adb
 * tunnel (§4.10): older Safari doesn't count `ws:` as 'self'.
 */
function cspFor(html, apiBase) {
	return [
		"default-src 'self'",
		["script-src 'self'", ...[...html.matchAll(INLINE_SCRIPT)].map((match) => `'sha256-${createHash("sha256").update(match[1] ?? "", "utf8").digest("base64")}'`)].join(" "),
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' blob: data:",
		"font-src 'self'",
		["connect-src 'self'", ...apiBase ? [apiBase.replace(/^http/, "ws")] : []].join(" "),
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'none'"
	].join("; ");
}
/**
 * The live /device/ HTML with the boot script inserted before its first script (the theme
 * script, which must still run before first paint), and the CSP that admits exactly the
 * inline scripts now in it. No <base href>: it would break the router's pushState URLs.
 */
function bootHtml(html, apiBase) {
	const text = typeof html === "string" ? html : html.toString("utf8");
	const at = text.search(/<script\b/i);
	if (at < 0) throw new HelperError("UPSTREAM_STATUS", 502, "The Device Lab page has no script to start.");
	const out = text.slice(0, at) + bootScript(apiBase) + "\n    " + text.slice(at);
	return {
		body: Buffer.from(out, "utf8"),
		csp: cspFor(out, apiBase)
	};
}
function sendPlain(res, status, text, extra = {}) {
	if (res.headersSent || res.destroyed) return;
	const body = Buffer.from(text + "\n", "utf8");
	res.writeHead(status, {
		"Content-Type": "text/plain; charset=utf-8",
		"Content-Length": String(body.length),
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
		...extra
	});
	res.end(body);
}
/** A decoded body, refused as soon as it grows past `cap`. */
async function readCapped$1(response, cap) {
	/** content-length counts the compressed bytes: over the cap means the decoded body is too. */
	if (Number(response.headers.get("content-length")) > cap) {
		await response.body?.cancel();
		throw new HelperError("UPSTREAM_TOO_LARGE", 502, "The upstream file is too large.");
	}
	const chunks = [];
	let total = 0;
	if (!response.body) return Buffer.alloc(0);
	const reader = response.body.getReader();
	for (let read = await reader.read(); !read.done; read = await reader.read()) {
		const chunk = Buffer.from(read.value);
		total += chunk.length;
		if (total > cap) {
			await reader.cancel();
			throw new HelperError("UPSTREAM_TOO_LARGE", 502, "The upstream file is too large.");
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}
/**
 * Local mode (§2.9, §6.4): the helper serves the live Device Lab page from its own origin,
 * for Safari (which never lets a secure page reach loopback) and for anyone without the
 * Local Network Access grant. The upstream is fixed; this is not a general proxy.
 */
function createLocalMode(opts) {
	const upstream = new URL(opts.upstream).origin;
	const cache = new Map();
	const flights = singleFlight();
	const remember = (pathname, entry) => {
		cache.delete(pathname);
		cache.set(pathname, entry);
		if (cache.size > LIMITS.upstreamEntries) {
			const oldest = cache.keys().next().value;
			if (oldest !== void 0) cache.delete(oldest);
		}
	};
	/**
	 * One upstream GET. Redirects are followed by hand and only within the upstream origin,
	 * so an off-site redirect is refused before anything off-site is contacted. `fetch` has
	 * already decoded the body: its content-encoding and content-length are never copied.
	 */
	async function fetchFrom(pathname, previous) {
		let target = new URL(pathname, upstream);
		for (let hops = 0;; hops++) {
			const headers = { "user-agent": `${NAME}/${VERSION}` };
			if (previous?.etag && hops === 0) headers["if-none-match"] = previous.etag;
			let response;
			try {
				response = await opts.fetch(target, {
					headers,
					redirect: "manual",
					signal: AbortSignal.timeout(opts.timeouts.upstream)
				});
			} catch (error) {
				const timedOut = error instanceof Error && error.name === "TimeoutError";
				throw new HelperError("UPSTREAM_UNREACHABLE", timedOut ? 504 : 502, `Could not reach ${upstream}.`);
			}
			if (response.status === 304 && previous) {
				await response.body?.cancel();
				return {
					...previous,
					checkedAt: opts.now()
				};
			}
			if (response.status >= 300 && response.status < 400) {
				await response.body?.cancel();
				const location = response.headers.get("location");
				const next = location ? new URL(location, target) : null;
				if (!next || next.origin !== upstream || hops >= 3) throw new HelperError("UPSTREAM_REDIRECT", 502, `${upstream}${pathname} redirected off-site.`);
				target = next;
				continue;
			}
			if (!response.ok) {
				await response.body?.cancel();
				throw new HelperError("UPSTREAM_STATUS", response.status === 404 ? 404 : 502, `${upstream}${pathname} answered ${String(response.status)}.`);
			}
			try {
				return {
					body: await readCapped$1(response, LIMITS.upstream),
					etag: response.headers.get("etag"),
					checkedAt: opts.now()
				};
			} catch (error) {
				if (error instanceof HelperError) throw error;
				throw new HelperError("UPSTREAM_UNREACHABLE", 504, `Could not read ${upstream}${pathname}.`);
			}
		}
	}
	/** The cached copy while fresh; else a revalidation; offline, the last good copy. */
	function load(pathname, maxAgeMs) {
		const hit = cache.get(pathname);
		if (hit && opts.now() - hit.checkedAt < maxAgeMs) return Promise.resolve(hit);
		return flights.run(pathname, async () => {
			try {
				const entry = await fetchFrom(pathname, hit);
				remember(pathname, entry);
				return entry;
			} catch (error) {
				if (hit) return hit;
				throw error;
			}
		});
	}
	async function page(req, res, host) {
		/**
		 * apiBase comes from the Host header, which the gate has already allowlisted: a page
		 * opened as localhost stays same-origin with the API it calls.
		 */
		const { body, csp } = bootHtml((await load("/device/", opts.timeouts.htmlRevalidate)).body, `http://${host}`);
		res.writeHead(200, {
			"Content-Type": "text/html; charset=utf-8",
			"Content-Length": String(body.length),
			"Cache-Control": "no-store",
			"Content-Security-Policy": csp,
			"X-Frame-Options": "DENY",
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff"
		});
		res.end(req.method === "HEAD" ? void 0 : body);
	}
	async function asset(req, res, pathname) {
		const helperFile = pathname.startsWith("/device/");
		/** Build assets are content-hashed and never change; the helper file keeps its name. */
		const entry = await load(pathname, helperFile ? opts.timeouts.htmlRevalidate : Number.POSITIVE_INFINITY);
		const extension = pathname.slice(pathname.lastIndexOf(".") + 1);
		res.writeHead(200, {
			"Content-Type": TYPES[extension] ?? "application/octet-stream",
			"Content-Length": String(entry.body.length),
			"Cache-Control": helperFile ? "no-cache" : "public, max-age=31536000, immutable",
			/**
			 * Ignored for subresources; stops a top-level visit to, say, an SVG from running script here.
			 */
			"Content-Security-Policy": "sandbox; default-src 'none'",
			"X-Content-Type-Options": "nosniff"
		});
		res.end(req.method === "HEAD" ? void 0 : entry.body);
	}
	return { async handle(req, res, pathname, search, host) {
		if (req.method !== "GET" && req.method !== "HEAD") return sendPlain(res, 405, "GET only.", { Allow: "GET, HEAD" });
		if (PAGE_REDIRECTS.has(pathname)) {
			res.writeHead(302, {
				Location: `/device/${search}`,
				"Cache-Control": "no-store"
			});
			res.end();
			return;
		}
		/** Browsers ask for it on their own; redirecting it off-site would trip img-src 'self'. */
		if (pathname === "/favicon.ico") return sendPlain(res, 404, "Not found.");
		try {
			if (pathname === "/device/") return await page(req, res, host);
			if (LOCAL_ASSET.test(pathname)) return await asset(req, res, pathname);
		} catch (error) {
			if (!(error instanceof HelperError)) throw error;
			const advice = pathname === "/device/" ? `\nThis copy of Device Lab loads the live page from ${upstream}, so it needs internet access.` : "";
			return sendPlain(res, error.status, `Device Lab could not load ${pathname}: ${error.message} (${error.code})${advice}`);
		}
		/**
		 * The rest of the site lives upstream. Concatenating (never resolving) keeps a path
		 * such as //evil.example on the upstream host.
		 */
		const target = new URL(upstream + pathname + search);
		if (target.origin !== upstream) return sendPlain(res, 400, "Bad path.");
		res.writeHead(302, {
			Location: target.href,
			"Cache-Control": "no-store"
		});
		res.end();
	} };
}

//#endregion
//#region src/lan-net.ts
/**
 * §15 LAN sources: what the helper may learn about this computer's own network (§4.9), each
 * source on its own, read-only, bounded, and fed only by what the helper derives itself. A
 * page names nothing here: no address, range or port ever comes from a request.
 *
 * - Interfaces: the networks looked at are this computer's own private IPv4 networks on real
 *   interfaces (never a VPN tunnel, a VM or container bridge, AirDrop or loopback), at most
 *   the /24 around this computer on a larger one, at most 512 addresses in all.
 * - Presence: one byte in one UDP datagram to port 9 of each of those addresses, from a
 *   connected socket. A host that is there answers with ICMP port unreachable, which the
 *   socket reports as ECONNREFUSED: the one sign of life that needs no privilege and no
 *   process, and that phones dropping TCP and ping still give [V 2026-10-04: 15–615 ms on
 *   the owner's network, the dozing Pixel included]. Silence says nothing.
 * - The neighbour (ARP) table, where the system shares it (macOS 27 shows the helper an empty
 *   one), and the default gateway, through fixed system paths or Linux's /proc files.
 * - SSDP: one M-SEARCH socket, and the UPnP description a device points to in its answer,
 *   fetched only from that device's own address: the one HTTP request the helper makes.
 *
 * Every answer is untrusted: tables and answers are matched line by line against their exact
 * shape, sizes are capped before anything is parsed, and a hardware address is only ever
 * turned into the two facts macFacts() allows, never passed on.
 */
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const toInt = (address) => address.split(".").reduce((n, part) => (n << 8 | Number(part)) >>> 0, 0);
const fromInt = (n) => [
	n >>> 24,
	n >>> 16 & 255,
	n >>> 8 & 255,
	n & 255
].map(String).join(".");
/** 255.255.255.0 → 24; null for a mask whose ones are not contiguous. */
function prefixOf(netmask) {
	if (!IPV4.test(netmask)) return null;
	const mask = toInt(netmask);
	for (let prefix = 0; prefix <= 32; prefix++) if ((prefix === 0 ? 0 : 4294967295 << 32 - prefix >>> 0) === mask) return prefix;
	return null;
}
/** 10/8, 172.16/12 and 192.168/16: the networks a home or an office is on. */
function isPrivateIpv4(address) {
	const [a = 0, b = 0] = address.split(".").map(Number);
	return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168;
}
/** os.networkInterfaces(), flattened: BridgeOptions.lanInterfaces' default. */
function systemInterfaces() {
	const out = [];
	for (const [name, list] of Object.entries(os.networkInterfaces())) for (const entry of list ?? []) out.push({
		name,
		address: entry.address,
		netmask: entry.netmask,
		family: entry.family,
		internal: entry.internal
	});
	return out;
}
/**
 * Interfaces that are not a local network of their own: VPN tunnels (utun, tun, tap, WireGuard,
 * Tailscale, ZeroTier, PPP, IPsec), VM and container bridges, AirDrop's, loopback.
 */
const VIRTUAL_INTERFACE = /^(?:utun|tun|tap|wg|tailscale|zt|ppp|ipsec|gif|stf|awdl|llw|bridge|vmnet|vboxnet|docker|br-|veth|virbr|lo)/i;
/** At most this many networks are listed, whatever the interfaces say. */
const MAX_NETWORKS = 16;
/**
 * The networks to look at (§4.9): each non-internal IPv4 address in 10/8, 172.16/12 or
 * 192.168/16 on an interface that is not virtual (169.254/16 and 100.64/10 never are: link-local,
 * and carrier-grade NAT or Tailscale), with a prefix from 8 to 30. The presence check covers
 * the whole network when it is a /24 or smaller, else the /24 around this computer's address;
 * a network's own network and broadcast addresses, and this computer's, are never targets.
 * `scanned` counts the host addresses covered (this computer's included), so a whole /24 reads
 * 254 of 254. Once `maxTargets` addresses are planned, a network that does not fit is listed
 * with `scanned: 0`; one whose addresses another interface already covers adds none.
 */
function lanNetworks(interfaces, maxTargets = LIMITS.lanTargets) {
	const lan = interfaces.filter((i) => (i.family === "IPv4" || i.family === 4) && !i.internal && IPV4.test(i.address) && isPrivateIpv4(i.address) && !VIRTUAL_INTERFACE.test(i.name)).slice(0, MAX_NETWORKS);
	const own = new Map();
	for (const i of lan) if (!own.has(i.address)) own.set(i.address, clean(i.name, 40));
	const networks = [];
	const targets = [];
	const ranges = [];
	const planned = new Set();
	for (const i of lan) {
		const prefix = prefixOf(i.netmask);
		if (prefix === null || prefix < 8 || prefix > 30) continue;
		const self = toInt(i.address);
		const block = 2 ** (32 - prefix);
		const network = self - self % block >>> 0;
		const broadcast = network + block - 1;
		const start = prefix >= 24 ? network : self - self % 256;
		const end = prefix >= 24 ? broadcast : start + 255;
		const fresh = [];
		let covered = 0;
		for (let n = start; n <= end; n++) {
			if (n === network || n === broadcast) continue;
			covered++;
			if (!own.has(fromInt(n)) && !planned.has(n)) fresh.push(n);
		}
		ranges.push({
			network,
			broadcast
		});
		const fits = targets.length + fresh.length <= maxTargets;
		if (fits) for (const n of fresh) {
			planned.add(n);
			targets.push(fromInt(n));
		}
		networks.push({
			interface: clean(i.name, 40),
			address: i.address,
			prefix,
			size: block - 2,
			scanned: fits ? covered : 0
		});
	}
	return {
		networks,
		targets,
		own,
		ranges
	};
}
/** On one of `ranges`, and neither its network nor its broadcast address. */
function onLan(address, ranges) {
	if (!IPV4.test(address)) return false;
	const n = toInt(address);
	return ranges.some((r) => n > r.network && n < r.broadcast);
}
const PROBE = Buffer.from([0]);
/** The real presence check: BridgeOptions.lanPresence's default. */
function presenceTransport() {
	return (address, o) => new Promise((resolve, reject) => {
		if (o.signal.aborted) return resolve("silent");
		const socket = dgram.createSocket({ type: "udp4" });
		let settled = false;
		let sent = false;
		const settle = (outcome) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			o.signal.removeEventListener("abort", onAbort);
			closeSocket(socket);
			if (outcome instanceof Error) reject(outcome);
			else resolve(outcome);
		};
		const onAbort = () => settle("silent");
		const timer = setTimeout(() => settle("silent"), o.windowMs);
		o.signal.addEventListener("abort", onAbort, { once: true });
		/** Port unreachable is the answer; after the byte left, any other error means nobody. */
		socket.on("error", (error) => {
			if (error.code === "ECONNREFUSED") settle("refused");
			else settle(sent ? "silent" : error);
		});
		/** Node passes connect's error to its callback, though its types leave the argument out. */
		socket.connect(o.port, address, (error) => {
			if (error) return settle(error);
			if (settled) return;
			socket.send(PROBE, (sendError) => {
				if (sendError) settle(sendError);
				else sent = true;
			});
		});
	});
}
/** New sockets per tick, and the tick: at most 400 a second, so replies are not dropped. */
const PRESENCE_PACE = {
	perTick: 4,
	tickMs: 10
};
/**
 * The presence check of every target (§4.9): one socket each, at most `pool` open at once,
 * opened at most 4 every 10 ms, each closed at its answer or after `windowMs`. With the
 * defaults a /24 is done in about 1.7 s and two in about 2.7 s. When the signal aborts no
 * socket is opened any more and every open one is closed at once. The sockets wait on a signal
 * of its own, linked to `o.signal`, which takes their 256 abort listeners without Node 18 and
 * 20's warning, whatever signal the caller passed.
 */
function checkPresence(targets, o) {
	const run = linkSignals([o.signal]);
	return new Promise((resolve) => {
		const present = new Set();
		let sent = 0;
		let first = null;
		let next = 0;
		let open = 0;
		let timer;
		let ended = false;
		const end = () => {
			if (ended || open > 0 || timer !== void 0) return;
			if (next < targets.length && !run.signal.aborted) return;
			ended = true;
			run.signal.removeEventListener("abort", onAbort);
			resolve({
				present,
				sent,
				...sent === 0 && first !== null ? { failure: mdnsFailure(first) } : {}
			});
		};
		const launch = (address) => {
			open++;
			Promise.resolve().then(() => o.open(address, {
				port: o.port,
				windowMs: o.windowMs,
				signal: run.signal
			})).then((answer) => {
				sent++;
				if (answer === "refused") present.add(address);
			}, (error) => {
				first ??= error;
			}).finally(() => {
				open--;
				end();
			});
		};
		const tick = () => {
			timer = void 0;
			if (!run.signal.aborted) {
				for (let n = 0; n < PRESENCE_PACE.perTick && open < o.pool; n++) {
					const address = targets[next];
					if (address === void 0) break;
					next++;
					launch(address);
				}
				if (next < targets.length) timer = setTimeout(tick, PRESENCE_PACE.tickMs);
			}
			end();
		};
		const onAbort = () => {
			clearTimeout(timer);
			timer = void 0;
			end();
		};
		run.signal.addEventListener("abort", onAbort, { once: true });
		tick();
	}).finally(() => run.dispose());
}
/** `6c:2:e0:f2:5f:81` (macOS drops leading zeros), `6C-02-E0-F2-5F-81` → `6c:02:e0:f2:5f:81`. */
function normalizeMac(text) {
	const parts = text.trim().split(/[:-]/);
	if (parts.length !== 6 || !parts.every((p) => /^[0-9A-Fa-f]{1,2}$/.test(p))) return null;
	return parts.map((p) => p.padStart(2, "0").toLowerCase()).join(":");
}
/** A hardware address of one device: not all zeros, not multicast, not broadcast. */
function unicastMac(mac) {
	return (parseInt(mac.slice(0, 2), 16) & 1) === 0 && mac !== "00:00:00:00:00:00";
}
/**
 * All a hardware address may tell (§4.9): whether it is a private one (the locally
 * administered bit: phones, tablets and laptops make one up per network), and, only when it
 * is not, its maker's 3-byte prefix. The address itself goes no further.
 */
function macFacts(mac) {
	const privateAddress = (parseInt(mac.slice(0, 2), 16) & 2) !== 0;
	return privateAddress ? { privateAddress } : {
		privateAddress,
		maker: mac.slice(0, 8).replace(/:/g, "").toUpperCase()
	};
}
/** Entries kept from one table, whatever it holds. */
const MAX_NEIGHBOURS = 1024;
/** A table or a route listing larger than this is not read past it. */
const MAX_TABLE = 262144;
function neighbour(address, mac) {
	const normal = normalizeMac(mac ?? "");
	return address && IPV4.test(address) && normal && unicastMac(normal) ? {
		address,
		mac: normal
	} : null;
}
function neighbours(text, read) {
	const out = [];
	for (const line of text.split("\n")) {
		const entry = read(line);
		if (entry) out.push(entry);
		if (out.length >= MAX_NEIGHBOURS) break;
	}
	return out;
}
/**
 * macOS `arp -an`: `? (192.168.68.1) at 14:eb:b6:97:cd:50 on en0 ifscope [ethernet]`, octets
 * without leading zeros; `(incomplete)` and multicast entries are no device.
 */
function parseArpDarwin(text) {
	return neighbours(text, (line) => {
		const m = /^\S*\s*\((\S+)\) at ([0-9A-Fa-f]{1,2}(?::[0-9A-Fa-f]{1,2}){5}) on \S/.exec(line);
		return neighbour(m?.[1], m?.[2]);
	});
}
/**
 * Linux /proc/net/arp: `IP address  HW type  Flags  HW address  Mask  Device` rows; only flags
 * 0x2 (complete) and 0x6 (permanent) carry an address that answered.
 */
function parseProcNetArp(text) {
	return neighbours(text, (line) => {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 6 || !/^0x[0-9A-Fa-f]+$/.test(fields[2] ?? "")) return null;
		const flags = parseInt(fields[2] ?? "", 16);
		return flags === 2 || flags === 6 ? neighbour(fields[0], fields[3]) : null;
	});
}
/**
 * Windows `ARP.EXE -a`: under each `Interface: … --- 0x4` header, rows of an address, a
 * hyphenated hardware address and a type word. The headers and the word are translated
 * (`dynamisch`), so neither is read: the row's shape and the address decide.
 */
function parseArpWindows(text) {
	return neighbours(text, (line) => {
		const m = /^\s*(\S+)\s+([0-9A-Fa-f]{2}(?:-[0-9A-Fa-f]{2}){5})\s+\S+\s*$/.exec(line);
		return neighbour(m?.[1], m?.[2]);
	});
}
/** At most `max` bytes of a file (a /proc file reports no size), or a rejection. */
async function readCapped(file, max) {
	if (!path.isAbsolute(file)) throw new Error(`${file} is not an absolute path.`);
	const handle = await open(file, "r");
	try {
		const buffer = Buffer.alloc(max);
		let length = 0;
		while (length < max) {
			const { bytesRead } = await handle.read(buffer, length, max - length, null);
			if (!bytesRead) break;
			length += bytesRead;
		}
		return buffer.toString("utf8", 0, length);
	} finally {
		await handle.close();
	}
}
/** How long the neighbour table's tool may take, and the route's. */
const TABLE_MS = 3e3;
const ROUTE_MS = 2e3;
/**
 * The neighbour table (§4.9): `ok` with its complete entries, `hidden` when it was read and
 * held none (what macOS 27 shows a process like the helper: `arp -an` prints nothing),
 * `none` when it could not be read. Never throws.
 */
async function readNeighbours(o) {
	try {
		let entries;
		if (o.platform === "linux") entries = parseProcNetArp(await readCapped(o.procNetArpPath, MAX_TABLE));
		else if (o.platform === "darwin" || o.platform === "win32") {
			const { stdout } = await o.runTool(o.arpPath, o.platform === "win32" ? ["-a"] : ["-an"], {
				timeoutMs: TABLE_MS,
				maxBytes: MAX_TABLE,
				signal: o.signal
			});
			entries = o.platform === "win32" ? parseArpWindows(stdout) : parseArpDarwin(stdout);
		} else return {
			entries: [],
			state: "none"
		};
		return {
			entries,
			state: entries.length ? "ok" : "hidden"
		};
	} catch {
		return {
			entries: [],
			state: "none"
		};
	}
}
/** macOS `route -n get default`: its `gateway:` line, when that is an IPv4 address. */
function parseRouteGetDefault(text) {
	const m = /^\s*gateway:\s*(\S+)\s*$/m.exec(text);
	return m?.[1] && IPV4.test(m[1]) ? m[1] : null;
}
/**
 * Linux /proc/net/route: of the default routes (Destination 00000000, flags RTF_UP and
 * RTF_GATEWAY), the gateway of the one with the lowest metric, written in hex in network
 * order read as a little-endian number: `0102A8C0` is 192.168.2.1.
 */
function parseProcNetRoute(text) {
	let best = null;
	for (const line of text.split("\n").slice(1)) {
		const f = line.trim().split(/\s+/);
		if (f.length < 8 || f[1] !== "00000000" || !/^[0-9A-Fa-f]{8}$/.test(f[2] ?? "")) continue;
		if ((parseInt(f[3] ?? "", 16) & 3) !== 3) continue;
		const address = (f[2]?.match(/../g) ?? []).reverse().map((hex) => String(parseInt(hex, 16))).join(".");
		const metric = Number(f[6]);
		if (IPV4.test(address) && address !== "0.0.0.0" && (!best || metric < best.metric)) best = {
			address,
			metric
		};
	}
	return best?.address ?? null;
}
/**
 * Windows `ROUTE.EXE print -4 0.0.0.0`: rows of `0.0.0.0  0.0.0.0  <gateway>  <interface>
 * <metric>`, the gateway of the lowest metric. Columns by position; no translated word read.
 */
function parseRouteWindows(text) {
	let best = null;
	for (const line of text.split("\n")) {
		const m = /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\S+)\s+(\S+)\s+(\d{1,9})\s*$/.exec(line);
		if (!m?.[1] || !IPV4.test(m[1]) || !IPV4.test(m[2] ?? "")) continue;
		const metric = Number(m[3]);
		if (!best || metric < best.metric) best = {
			address: m[1],
			metric
		};
	}
	return best?.address ?? null;
}
/** The default gateway's IPv4 address, or null. Never throws. */
async function readGateway(o) {
	try {
		if (o.platform === "linux") return parseProcNetRoute(await readCapped(o.procNetRoutePath, MAX_TABLE));
		if (o.platform !== "darwin" && o.platform !== "win32") return null;
		const argv = o.platform === "win32" ? [
			"print",
			"-4",
			"0.0.0.0"
		] : [
			"-n",
			"get",
			"default"
		];
		const { stdout } = await o.runTool(o.routePath, argv, {
			timeoutMs: ROUTE_MS,
			maxBytes: MAX_TABLE,
			signal: o.signal
		});
		return o.platform === "win32" ? parseRouteWindows(stdout) : parseRouteGetDefault(stdout);
	} catch {
		return null;
	}
}
const SSDP_ADDRESS = "239.255.255.250";
const SSDP_PORT = 1900;
/** An SSDP answer is a few hundred bytes (UDA 2.0 §1.3.3); a larger datagram is dropped. */
const MAX_SSDP_PACKET = 2048;
/**
 * The real SSDP socket: udp4, bound to 0.0.0.0 on an ephemeral port (never 1900, which the
 * system's own SSDP service may hold), multicast TTL 2 (UDA 2.0 §1.3.2). Answers come back
 * unicast to it. A socket whose bind fails is closed before the open rejects.
 */
function ssdpTransport(o = {}) {
	const address = o.address ?? "239.255.255.250";
	const port = o.port ?? 1900;
	const multicast = /^2(?:2[4-9]|3\d)\./.test(address);
	return (onPacket) => new Promise((resolve, reject) => {
		const socket = dgram.createSocket({ type: "udp4" });
		let closed = false;
		socket.on("message", (packet, from) => {
			if (!closed && packet.length <= MAX_SSDP_PACKET) onPacket(packet, from.address);
		});
		const unbound = (error) => {
			closed = true;
			closeSocket(socket);
			reject(error);
		};
		socket.once("error", unbound);
		socket.bind(0, () => {
			socket.off("error", unbound);
			/** From here on a socket error is a send that failed: send() reports it. */
			socket.on("error", () => void 0);
			if (multicast) socket.setMulticastTTL(2);
			resolve({
				send: (packet, local) => new Promise((done, failed) => {
					if (closed) return done();
					try {
						if (multicast) socket.setMulticastInterface(local);
					} catch (error) {
						return failed(error instanceof Error ? error : new Error(String(error)));
					}
					socket.send(packet, port, address, (error) => error ? failed(error) : done());
				}),
				close() {
					if (closed) return;
					closed = true;
					closeSocket(socket);
				}
			});
		});
	});
}
/** One M-SEARCH (UDA 2.0 §1.3.2): MX 2, the blank line that ends it. */
function mSearch(target) {
	return Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDRESS}:${String(SSDP_PORT)}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${target}\r\n\r\n`, "latin1");
}
/**
 * An SSDP answer's headers (`HTTP/1.1 200 OK`, then `NAME: value` lines; names in any case),
 * or null for anything else. Each value is cleaned and capped; a line break cannot hide inside
 * one, as lines are split first. The first of each header stands.
 */
function parseSsdpResponse(packet) {
	if (packet.length > MAX_SSDP_PACKET) return null;
	const lines = packet.toString("utf8").split(/\r?\n/);
	if (!/^HTTP\/1\.[01] 200(?: |$)/i.test(lines[0] ?? "")) return null;
	const out = {};
	for (const line of lines.slice(1, 33)) {
		if (!line.trim()) break;
		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		const name = line.slice(0, colon).trim().toLowerCase();
		const value = clean(line.slice(colon + 1), 512).trim();
		if (!value) continue;
		if (name === "st") out.st ??= value;
		else if (name === "usn") out.usn ??= value;
		else if (name === "server") out.server ??= value;
		else if (name === "location") out.location ??= value;
	}
	return out;
}
/** A UPnP device type (`urn:schemas-upnp-org:device:MediaRenderer:1`), or DIAL's service type. */
const DEVICE_URN = /^urn:[A-Za-z0-9.-]{1,64}:device:[A-Za-z0-9_.-]{1,64}:\d{1,4}$|^urn:dial-multiscreen-org:service:dial:\d{1,4}$/i;
/** The device type an ST or USN names (`uuid:…::urn:…:device:…:1`), or null. */
function deviceTypeOf(text) {
	const urn = text.includes("::") ? text.slice(text.lastIndexOf("::") + 2) : text;
	return DEVICE_URN.test(urn) ? urn : null;
}
/** Answers taken from one search, whatever arrives. */
const MAX_SSDP_ANSWERS = 256;
/** Device types kept per address. */
const MAX_SSDP_TYPES = 8;
/** After this long every M-SEARCH is sent once more (UDP is lossy; UDA asks for more than one). */
const SSDP_AGAIN_MS = 500;
/**
 * One SSDP search (§4.9): each of `targets`, out of each interface, twice 500 ms apart, then
 * answers until `windowMs`. Only an answer from an address on the local network
 * (offerableAddress) is taken, at most 256 of them. The socket is closed when the window ends
 * or the signal aborts.
 */
async function searchSsdp(o) {
	const devices = new Map();
	let answers = 0;
	let done = false;
	const onPacket = (packet, from) => {
		if (done || answers >= MAX_SSDP_ANSWERS) return;
		try {
			const answer = parseSsdpResponse(packet);
			const address = offerableAddress(from);
			if (!answer || !address || !IPV4.test(address)) return;
			answers++;
			let device = devices.get(address);
			if (!device) {
				if (devices.size >= MAX_SSDP_ANSWERS) return;
				devices.set(address, device = { types: [] });
			}
			if (answer.server && device.server === void 0) device.server = answer.server;
			if (answer.location && device.location === void 0) device.location = answer.location;
			for (const text of [answer.st, answer.usn]) {
				const type = text ? deviceTypeOf(text) : null;
				if (type && !device.types.includes(type) && device.types.length < MAX_SSDP_TYPES) device.types.push(type);
			}
		} catch {
			return;
		}
	};
	if (o.signal.aborted || !o.interfaces.length) return { devices };
	let transport;
	try {
		transport = await o.open(onPacket);
	} catch (error) {
		return {
			devices,
			failure: mdnsFailure(error)
		};
	}
	const window = linkSignals([o.signal], o.windowMs);
	/** Every search out of every interface, in turn; the number that left. */
	const searchAll = async () => {
		let sent = 0;
		let first = null;
		for (const local of o.interfaces) for (const target of o.targets) {
			if (window.signal.aborted) return {
				sent,
				first
			};
			try {
				await transport.send(mSearch(target), local);
				sent++;
			} catch (error) {
				first ??= error;
			}
		}
		return {
			sent,
			first
		};
	};
	try {
		const { sent, first } = await searchAll();
		if (!sent && !window.signal.aborted) return {
			devices,
			failure: mdnsFailure(first)
		};
		await sleepUntil(SSDP_AGAIN_MS, window.signal);
		if (!window.signal.aborted) await searchAll();
		await sleepUntil(o.windowMs, window.signal);
		return { devices };
	} finally {
		done = true;
		window.dispose();
		transport.close();
	}
}
/** Waits `ms`, or less when `signal` aborts; never rejects. */
function sleepUntil(ms, signal) {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const stop = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", stop);
			resolve();
		}, ms);
		signal.addEventListener("abort", stop, { once: true });
	});
}
/** A description document larger than this is not read. */
const MAX_DESCRIPTION = 65536;
/**
 * Where an SSDP answer's LOCATION may be fetched from, or null (§4.9). Only `http:` (never
 * https or another scheme), no user or password, and a host that is an IPv4 address equal to
 * the address the answer came from and on the local network: a device may point at itself
 * only, never at this computer, another device or the internet. The port must be 1–65535.
 */
function descriptionTarget(location, from) {
	let url;
	try {
		url = new URL(location);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" || url.username || url.password) return null;
	if (url.hostname !== from || !IPV4.test(from) || offerableAddress(from) !== from) return null;
	const port = url.port ? Number(url.port) : 80;
	if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
	return {
		host: from,
		port,
		path: `${url.pathname}${url.search}`
	};
}
/** The real fetch: node:http, never fetch(), which follows redirects (and warns on Node 18). */
const fetchDescription = (target, o) => new Promise((resolve, reject) => {
	if (o.signal.aborted) return reject(abortError());
	const deadline = linkSignals([o.signal], o.timeoutMs);
	let settled = false;
	const settle = (error, body = "") => {
		if (settled) return;
		settled = true;
		deadline.dispose();
		if (error) {
			request.destroy();
			reject(error);
		} else resolve(body);
	};
	const request = http.get({
		host: target.host,
		port: target.port,
		path: target.path || "/",
		headers: { Accept: "text/xml" },
		agent: false,
		signal: deadline.signal
	}, (res) => {
		const type = String(res.headers["content-type"] ?? "");
		const length = Number(res.headers["content-length"] ?? 0);
		if (res.statusCode !== 200 || type && !/xml/i.test(type) || length > o.maxBytes) {
			res.resume();
			return settle(new Error(`Not a description: ${String(res.statusCode)} ${type}`));
		}
		const chunks = [];
		let size = 0;
		res.on("data", (chunk) => {
			size += chunk.length;
			if (size > o.maxBytes) settle(new Error("The description is too large."));
			else chunks.push(chunk);
		});
		res.on("end", () => settle(null, Buffer.concat(chunks).toString("utf8")));
		res.on("error", (error) => settle(error));
		/** After 'end' this changes nothing; before it, the answer was cut short. */
		res.on("close", () => settle(new Error("The description was cut short.")));
	});
	request.on("error", (error) => settle(error));
});
/** The fields read from a description: the root device's own, nothing else. */
const DESCRIPTION_FIELDS = [
	"deviceType",
	"friendlyName",
	"manufacturer",
	"modelName",
	"modelNumber"
];
const ENTITIES = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: "\"",
	apos: "'"
};
/**
 * The root device's fields from a UPnP description (§4.9), by a tag scanner, not an XML
 * parser: a document with a DOCTYPE or an ENTITY is refused whole (no entity is ever
 * expanded), the first `<device>` is found, and each field is read only up to that device's
 * own `<deviceList>` or end, as plain text (`&amp; &lt; &gt; &quot; &apos;` decoded, a field
 * holding markup or CDATA skipped), cleaned and capped.
 */
function parseDescription(xml) {
	if (xml.length > 65536 || /<!(?:DOCTYPE|ENTITY)/i.test(xml)) return {};
	const start = xml.search(/<device(?:\s[^>]*)?>/);
	if (start < 0) return {};
	const body = xml.slice(start);
	const stop = body.search(/<deviceList(?:\s[^>]*)?>|<\/device\s*>/);
	const own = stop < 0 ? body : body.slice(0, stop);
	const out = {};
	for (const field of DESCRIPTION_FIELDS) {
		const m = new RegExp(`<${field}\\s*>([^<]*)</${field}\\s*>`).exec(own);
		if (!m) continue;
		const text = clean((m[1] ?? "").replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ENTITIES[name] ?? ""), LIMITS.field).trim();
		if (text) out[field] = text;
	}
	return out;
}

//#endregion
//#region src/lan.ts
/**
 * §16 Every device on this network (§4.9): one look at this computer's own network, merged
 * device by device, for "Devices on this network" on the page. It answers the owner's "list
 * ALL the devices currently on the local network": the router, phones, tablets, TVs,
 * computers, printers, speakers, smart-home things.
 *
 * A look runs only when the page asks (GET /api/lan/devices, and --doctor): never at startup,
 * never on a timer. It gathers, at once and each bounded on its own (lan-net.ts, mdns.ts):
 * the presence check of this computer's own subnets, the neighbour table and the default
 * gateway, every mDNS service through the system's daemon and the helper's own socket, SSDP and
 * the UPnP descriptions it points to, then the reverse names of what is there but still
 * unnamed. The whole look is cut at `lanScan` (7 s); what arrived by then is the answer.
 *
 * The helper says what each device is called and announces, never what it is: kinds and names
 * are the page's (lan-kinds.ts). And it never passes on a hardware address. One it reads (the
 * neighbour table, an iPhone's `_apple-mobdev2` instance, a printer's TXT `mac=`, avahi's
 * `_workstation`) becomes two facts, a private address or not and the maker's prefix of one
 * that is not, and every text sent beside them loses whatever carries that address or a part
 * of it (a printer's `(F25F81)`, its host `NPIF25F81`), as well as any UUID, run of 12 hex
 * digits or written-out hardware address: with the maker's prefix in the same row, the last
 * three bytes would give the whole address away.
 */
/** Per device, as the wire caps them (§4.9, mirrored by the page). */
const KEEP = {
	hostnames: 4,
	names: 8,
	services: 24,
	txt: 8
};
/** UPnP descriptions fetched in one look, and at once. */
const DESCRIPTIONS = {
	max: 16,
	slots: 4
};
/** Addresses asked for a reverse name in one look. */
const MAX_REVERSE = 64;
/** Instance names that are the device's own name (the page names a device by them first). */
const NAME_TYPES = new Set([
	"_companion-link._tcp",
	"_airplay._tcp",
	"_raop._tcp",
	"_androidtvremote2._tcp",
	"_ipp._tcp",
	"_ipps._tcp",
	"_printer._tcp",
	"_privet._tcp",
	"_hap._tcp",
	"_spotify-connect._tcp",
	"_sonos._tcp",
	"_smb._tcp",
	"_workstation._tcp"
]);
/** adbd names its services `adb-<serial>`: a serial, never passed on. */
const ADB_TYPES = new Set([
	"_adb._tcp",
	"_adb-tls-connect._tcp",
	"_adb-tls-pairing._tcp"
]);
/** LAN_TXT_KEYS by lower case: TXT keys compare case-insensitively (RFC 6763 §6.4). */
const TXT_KEYS = new Map(LAN_TXT_KEYS.map((key) => [key.toLowerCase(), key]));
/** A UUID, a hardware address written out, a run of 12 hex digits: ids, never names. */
const UUID_TEXT = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g;
const MAC_TEXT = /(?<![0-9A-Fa-f])[0-9A-Fa-f]{1,2}(?:[:-][0-9A-Fa-f]{1,2}){5}(?![0-9A-Fa-f])/g;
const HEX_RUN = /[0-9A-Fa-f]{12,}/g;
/** `6c02e0f25f81`'s whole and its last three bytes, as patterns, with or without `:`/`-`. */
function idPatterns(id) {
	const bytes = (hex) => (hex.match(/../g) ?? []).join("[:-]?");
	return [new RegExp(bytes(id), "gi"), new RegExp(bytes(id.slice(6)), "gi")];
}
/**
 * `text` without anything that carries a hardware address or an id (§4.9): UUIDs, written-out
 * hardware addresses, runs of 12 hex digits, and every one of `hidden` (12 hex digits each,
 * the addresses read for this device) whole or by its last three bytes. Brackets left empty
 * and separators left dangling go too: `HP Neverstop Laser MFP 1200w (F25F81)` → `HP
 * Neverstop Laser MFP 1200w`.
 */
function scrub(text, hidden = new Set()) {
	let out = text.replace(UUID_TEXT, " ").replace(MAC_TEXT, " ").replace(HEX_RUN, " ");
	for (const id of hidden) for (const pattern of idPatterns(id)) out = out.replace(pattern, " ");
	return out.replace(/\(\s*\)|\[\s*\]|\{\s*\}|<\s*>/g, " ").replace(/\s+/g, " ").replace(/^[\s\-_.:@,;]+|[\s\-_.:@,;]+$/g, "");
}
/** Whether `text` holds anything scrub() would take out. */
function carriesId(text, hidden = new Set()) {
	const found = (pattern) => {
		pattern.lastIndex = 0;
		return pattern.test(text);
	};
	return found(UUID_TEXT) || found(MAC_TEXT) || found(HEX_RUN) || [...hidden].some((id) => idPatterns(id).some(found));
}
/** A hardware address (or AirPlay's device id, written like one) as 12 lower-case hex digits. */
function idOf(text) {
	const mac = normalizeMac(text);
	if (mac) return mac.replace(/:/g, "");
	return /^[0-9A-Fa-f]{12}$/.test(text.trim()) ? text.trim().toLowerCase() : null;
}
/** The fixed order of LanSource, the order `found` lists them in. */
const SOURCES = [
	"reply",
	"neighbors",
	"mdns",
	"ssdp",
	"reverse",
	"gateway",
	"self"
];
function createDrafts() {
	const drafts = new Map();
	return {
		at(address) {
			let draft = drafts.get(address);
			if (!draft) {
				draft = {
					address,
					self: false,
					gateway: false,
					found: new Set(),
					hostnames: [],
					names: [],
					services: [],
					macs: [],
					hidden: new Set()
				};
				drafts.set(address, draft);
			}
			return draft;
		},
		get: (address) => drafts.get(address),
		all: () => [...drafts.values()]
	};
}
/** A hardware address read for `draft`: a fact source, and something to keep out of its texts. */
function readMac(draft, mac) {
	const id = idOf(mac);
	if (!id) return;
	draft.hidden.add(id);
	const normal = normalizeMac(mac);
	if (normal && !draft.macs.includes(normal)) draft.macs.push(normal);
}
/** A `.local` name for `draft` (an SRV target, a reverse name), without its root dot. */
function addHostname(draft, host) {
	const name = host.replace(/\.$/, "");
	if (!usableHost(name) || name.length > 253) return;
	if (draft.hostnames.some((h) => h.toLowerCase() === name.toLowerCase())) return;
	draft.hostnames.push(name);
}
/**
 * What an instance name may say (§4.9): `_apple-mobdev2`'s is `<hardware address>@<IPv6>…`
 * (read, never passed on), `_raop`'s `<AirPlay id>@<name>` (the name only), avahi's
 * `_workstation` `<name> [<hardware address>]` (the name only), and adbd's `adb-<serial>`
 * nothing at all.
 */
function instanceName(type, instance, draft) {
	const key = type.toLowerCase();
	if (ADB_TYPES.has(key)) return void 0;
	if (key === "_apple-mobdev2._tcp") {
		const at = instance.indexOf("@");
		if (at > 0) readMac(draft, instance.slice(0, at));
		return;
	}
	let name = instance;
	if (key === "_raop._tcp") {
		const at = instance.indexOf("@");
		if (at > 0) {
			const id = idOf(instance.slice(0, at));
			if (id) draft.hidden.add(id);
			name = instance.slice(at + 1);
		}
	}
	if (key === "_workstation._tcp") {
		const m = /^(.*?)\s*\[([^\]]*)\]\s*$/.exec(instance);
		if (m) {
			readMac(draft, m[2] ?? "");
			name = m[1] ?? "";
		}
	}
	return name;
}
/** One mDNS service on `draft`: its type, port, instance name and TXT, as raw as they came. */
function addService(draft, instance) {
	const type = serviceType(instance.service);
	if (!type) return;
	const name = instanceName(type, instance.instance, draft);
	for (const text of instance.txt) {
		const eq = text.indexOf("=");
		const key = eq < 0 ? "" : text.slice(0, eq).toLowerCase();
		/** A printer's `mac=` is its hardware address; AirPlay's `deviceid=` reads like one. */
		if (key === "mac") readMac(draft, text.slice(eq + 1));
		if (key === "deviceid") {
			const id = idOf(text.slice(eq + 1));
			if (id) draft.hidden.add(id);
		}
	}
	if (name !== void 0 && NAME_TYPES.has(type.toLowerCase())) draft.names.push({
		text: name,
		source: "mdns"
	});
	/** The daemon's and the helper's own browse often find the same instance: once. */
	const same = draft.services.find((s) => s.type.toLowerCase() === type.toLowerCase() && s.instance.toLowerCase() === instance.instance.toLowerCase());
	if (same) {
		if (!same.txt.length) same.txt = instance.txt;
		return;
	}
	draft.services.push({
		type,
		instance: instance.instance,
		...instance.port !== null ? { port: instance.port } : {},
		...name !== void 0 ? { name } : {},
		txt: instance.txt
	});
}
/** An IPv4 address a device may be listed at: a local one, as offerableAddress() writes it. */
function lanAddress(address) {
	const offered = offerableAddress(address);
	return offered && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(offered) ? offered : null;
}
/**
 * The addresses mDNS ties `instance` to (§4.9). Its IPv4 addresses on the local network, those
 * on the networks looked at when it has some. A host name that resolves to more than one of
 * them, or `Android.local` (adbd's and Android TV's name on many devices at once), ties nothing
 * by itself: only the helper's own browse, which heard the answer come from the device
 * (`from`), still ties those.
 */
function tiedAddresses(instance, plan, shared) {
	const local = instance.addresses.map(lanAddress).filter((a) => a !== null).filter((a, i, all) => all.indexOf(a) === i);
	const onOurs = local.filter((a) => onLan(a, plan.ranges));
	const addresses = onOurs.length ? onOurs : local;
	const from = instance.from === void 0 ? null : lanAddress(instance.from);
	/** An answer that brought only IPv6 addresses still came from the device's IPv4 one. */
	if (from) return addresses.length ? addresses : [from];
	if (!instance.target || shared(instance.target)) return [];
	return addresses.length === 1 ? addresses : [];
}
/** The fields a page may get from one draft, every text cleaned, scrubbed and capped. */
function finish(draft) {
	const text = (value, max = LIMITS.field) => scrub(clean(value, 4 * max), draft.hidden).slice(0, max).trim();
	const hostnames = draft.hostnames.filter((h) => !carriesId(h, draft.hidden)).slice(0, KEEP.hostnames);
	const names = [];
	for (const name of draft.names) {
		const cleaned = text(name.text);
		if (!cleaned || names.some((n) => n.text.toLowerCase() === cleaned.toLowerCase())) continue;
		names.push({
			text: cleaned,
			source: name.source
		});
		if (names.length >= KEEP.names) break;
	}
	const services = [];
	for (const s of draft.services) {
		const name = s.name === void 0 ? "" : text(s.name);
		const txt = {};
		let keys = 0;
		for (const entry of s.txt) {
			const eq = entry.indexOf("=");
			const key = eq < 0 ? void 0 : TXT_KEYS.get(entry.slice(0, eq).toLowerCase());
			if (!key || key in txt || keys >= KEEP.txt) continue;
			const value = text(entry.slice(eq + 1));
			if (!value) continue;
			txt[key] = value;
			keys++;
		}
		services.push({
			type: s.type,
			...s.port !== void 0 ? { port: s.port } : {},
			...name ? { name } : {},
			...keys ? { txt } : {}
		});
		if (services.length >= KEEP.services) break;
	}
	let upnp;
	if (draft.upnp) {
		const u = draft.upnp;
		const fields = {};
		const pairs = [
			["deviceType", u.deviceType ?? u.types.find((t) => /:device:/i.test(t)) ?? u.types[0]],
			["friendlyName", u.friendlyName],
			["manufacturer", u.manufacturer],
			["modelName", u.modelName],
			["modelNumber", u.modelNumber],
			["server", u.server]
		];
		for (const [key, value] of pairs) {
			const cleaned = value === void 0 ? "" : text(value);
			if (cleaned) fields[key] = cleaned;
		}
		if (Object.keys(fields).length) upnp = fields;
	}
	const mac = draft.macs[0];
	const facts = mac ? macFacts(mac) : null;
	return {
		address: draft.address,
		self: draft.self,
		gateway: draft.gateway,
		hostnames,
		names,
		services,
		...upnp ? { upnp } : {},
		...facts?.maker ? { maker: facts.maker } : {},
		...facts ? { privateAddress: facts.privateAddress } : {},
		found: SOURCES.filter((source) => draft.found.has(source))
	};
}
/** 192.168.68.2 before 192.168.68.10: addresses as numbers. */
function addressOrder(a, b) {
	const n = (address) => address.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
	return n(a) - n(b);
}
/**
 * Every source's finds, merged by IPv4 address (§4.9). A device exists where any source puts
 * one: this computer's own addresses, the gateway, an address that answered the presence
 * check, a complete neighbour entry, an mDNS service tied to an address, an SSDP answer. A
 * reverse name only names one that exists. The gateway comes first, then by address; at most
 * LIMITS.lanDevices. `unnamed`: what is there on the networks looked at with no `.local` name
 * yet, at most 64, for the reverse names.
 */
function mergeLan(read) {
	const { plan } = read;
	const drafts = createDrafts();
	for (const address of plan.own.keys()) {
		const draft = drafts.at(address);
		draft.self = true;
		draft.found.add("self");
	}
	if (read.gateway && onLan(read.gateway, plan.ranges)) {
		const draft = drafts.at(read.gateway);
		draft.gateway = true;
		draft.found.add("gateway");
	}
	for (const address of read.presence?.present ?? []) if (lanAddress(address)) drafts.at(address).found.add("reply");
	for (const entry of read.neighbours.entries) {
		if (!onLan(entry.address, plan.ranges) || plan.own.has(entry.address)) continue;
		if (!lanAddress(entry.address)) continue;
		const draft = drafts.at(entry.address);
		draft.found.add("neighbors");
		readMac(draft, entry.mac);
	}
	/** Host names that tie nothing (§4.9): Android.local, and a name with several addresses. */
	const byHost = new Map();
	for (const instance of [...read.system.instances, ...read.own.instances]) {
		if (!instance.target) continue;
		const key = instance.target.toLowerCase().replace(/\.$/, "");
		const set = byHost.get(key) ?? new Set();
		for (const a of instance.addresses) {
			const local = lanAddress(a);
			if (local && onLan(local, plan.ranges)) set.add(local);
		}
		byHost.set(key, set);
	}
	const shared = (host) => {
		const key = host.toLowerCase().replace(/\.$/, "");
		return key === "android.local" || (byHost.get(key)?.size ?? 0) > 1;
	};
	for (const instance of [...read.system.instances, ...read.own.instances]) for (const address of tiedAddresses(instance, plan, shared)) {
		const draft = drafts.at(address);
		draft.found.add("mdns");
		if (instance.target) addHostname(draft, instance.target);
		addService(draft, instance);
	}
	for (const [address, device] of read.ssdp.devices) {
		if (!lanAddress(address)) continue;
		const draft = drafts.at(address);
		draft.found.add("ssdp");
		const description = read.descriptions.get(address) ?? {};
		draft.upnp = {
			...description,
			server: device.server,
			types: device.types
		};
		if (description.friendlyName) draft.names.push({
			text: description.friendlyName,
			source: "ssdp"
		});
	}
	for (const [address, host] of read.reverse) {
		const draft = drafts.get(address);
		/** A name that carries its hardware address (`ESP_AABBCC.local`) names nothing here. */
		if (!draft || carriesId(host, draft.hidden)) continue;
		draft.found.add("reverse");
		addHostname(draft, host);
	}
	const all = drafts.all().sort((a, b) => Number(b.gateway) - Number(a.gateway) || addressOrder(a.address, b.address));
	const unnamed = all.filter((d) => !d.hostnames.length && onLan(d.address, plan.ranges)).map((d) => d.address).slice(0, MAX_REVERSE);
	return {
		devices: all.slice(0, LIMITS.lanDevices).map(finish),
		truncated: all.length > LIMITS.lanDevices,
		unnamed
	};
}
/** The page's wording, for a page with none of its own. */
const LAN_MESSAGE = {
	blocked: `Could not look for devices on this network. ${NETWORK_HINT.blocked}`,
	"no-network": "Could not look for devices: this computer is not on a network. Turn on Wi-Fi, or plug in a network cable.",
	failed: "Could not look for devices on this network."
};
const LAN_NOTE = "Listed through this computer's own resolver: the helper's own packets could not reach the network, so only devices that announce themselves are here.";
const NO_SYSTEM = {
	tool: null,
	looked: false,
	instances: []
};
/**
 * The helper's own mDNS (§4.9): the types the network lists (half of `windowMs`), then every
 * one of them and of LAN_STATIC_TYPES in one browse() (`windowMs`, 256 instances).
 */
async function ownBrowse(open, windowMs, signal) {
	const listed = await browseServiceTypes({
		open,
		windowMs: Math.floor(windowMs / 2),
		signal
	});
	if (listed.failure) return {
		instances: [],
		failure: listed.failure
	};
	if (signal.aborted) return { instances: [] };
	const types = new Map();
	for (const type of [...LAN_STATIC_TYPES, ...listed.types]) types.set(type.toLowerCase(), type);
	return browse({
		services: [...types.values()].map((type) => `${type}.local`),
		open,
		windowMs,
		signal,
		max: LIMITS.lanDevices
	});
}
/** Up to 16 UPnP descriptions, 4 at a time, each only where descriptionTarget() allows it. */
async function describe(ssdp, o) {
	const out = new Map();
	const jobs = [];
	for (const [address, device] of ssdp.devices) {
		const target = device.location ? descriptionTarget(device.location, address) : null;
		if (target && jobs.length < DESCRIPTIONS.max) jobs.push([address, target]);
	}
	const slot = createLimiter(DESCRIPTIONS.slots);
	await Promise.all(jobs.map(([address, target]) => slot(async () => {
		if (o.signal.aborted) return;
		try {
			const xml = await o.lanDescription(target, {
				timeoutMs: o.timeoutMs,
				maxBytes: MAX_DESCRIPTION,
				signal: o.signal
			});
			out.set(address, parseDescription(xml));
		} catch {}
	})));
	return out;
}
/** `lanInterfaces()`, or none when it throws. */
function interfacesOf(options) {
	try {
		return options.lanInterfaces();
	} catch {
		return [];
	}
}
/**
 * One look at this computer's network (§4.9): BridgeOptions.lanScan's default. Every source
 * starts at once, except the neighbour table (after the presence check, which fills it), the
 * UPnP descriptions (after SSDP) and the reverse names (after the presence check, the table,
 * mDNS and SSDP, for what is there but unnamed). The look is cut at `lanScan`: sockets closed,
 * tools killed, and what arrived is the answer. Never rejects: a source that fails says so in
 * `sources`, `error` or `note`.
 */
async function scanLan(ctx) {
	const { options: o, timeouts } = ctx;
	const scannedAt = ctx.now();
	const plan = lanNetworks(interfacesOf(o));
	if (!plan.networks.length) return {
		devices: [],
		networks: [],
		sources: {
			presence: "off",
			neighbors: "none",
			resolver: "none",
			ssdp: "ok"
		},
		scannedAt,
		durationMs: Math.max(0, ctx.now() - scannedAt),
		error: {
			reason: "no-network",
			message: LAN_MESSAGE["no-network"],
			detail: "no network interface has a private IPv4 address"
		}
	};
	const look = linkSignals([ctx.signal], timeouts.lanScan);
	try {
		const signal = look.signal;
		const tables = {
			platform: o.platform,
			arpPath: o.arpPath,
			procNetArpPath: o.procNetArpPath,
			procNetRoutePath: o.procNetRoutePath,
			routePath: o.routePath,
			runTool: ctx.runTool,
			signal
		};
		const presence = o.platform === "win32" || !plan.targets.length ? Promise.resolve(null) : checkPresence(plan.targets, {
			open: o.lanPresence,
			port: 9,
			windowMs: timeouts.lanPresence,
			pool: LIMITS.lanSockets,
			signal
		}).catch(() => null);
		const neighbours = presence.then(() => readNeighbours(tables));
		const gateway = readGateway(tables);
		const system = systemBrowseAll({
			services: LAN_STATIC_TYPES,
			tools: systemMdnsTools(o),
			streamTool: ctx.streamTool,
			browseMs: timeouts.systemBrowse,
			resolveMs: timeouts.systemResolve,
			signal
		}).catch(() => NO_SYSTEM);
		const own = ownBrowse(o.mdns, timeouts.mdnsWindow, signal).catch((error) => ({
			instances: [],
			failure: {
				reason: "failed",
				code: "",
				detail: clean(errorText(error), 200)
			}
		}));
		const ssdp = searchSsdp({
			open: o.lanSsdp,
			interfaces: [...plan.own.keys()],
			targets: LAN_SSDP_TARGETS,
			windowMs: timeouts.lanSsdp,
			signal
		}).catch(() => ({ devices: new Map() }));
		const descriptions = ssdp.then((found) => describe(found, {
			lanDescription: o.lanDescription,
			timeoutMs: timeouts.lanDescription,
			signal
		}));
		const [p, n, g, s, m, ss] = await Promise.all([
			presence,
			neighbours,
			gateway,
			system,
			own,
			ssdp
		]);
		const sources = {
			plan,
			presence: p,
			neighbours: n,
			gateway: g,
			system: s,
			own: m,
			ssdp: ss
		};
		const reverse = await reverseNames({
			addresses: mergeLan({
				...sources,
				descriptions: new Map(),
				reverse: new Map()
			}).unnamed,
			tools: reverseTools(o),
			streamTool: ctx.streamTool,
			open: o.mdns,
			timeoutMs: timeouts.lanReverse,
			signal
		}).catch(() => new Map());
		const read = {
			...sources,
			descriptions: await descriptions,
			reverse
		};
		const merged = mergeLan(read);
		return {
			devices: merged.devices,
			networks: plan.networks,
			sources: sourcesOf(read, o.platform),
			scannedAt,
			durationMs: Math.max(0, ctx.now() - scannedAt),
			...merged.truncated ? { truncated: true } : {},
			...problemOf(read)
		};
	} finally {
		look.dispose();
	}
}
function sourcesOf(read, platform) {
	const { presence } = read;
	return {
		presence: platform === "win32" || !presence || !read.plan.targets.length ? "off" : presence.sent === 0 && presence.failure ? "blocked" : "ok",
		neighbors: read.neighbours.state,
		resolver: !read.system.looked ? "none" : read.system.tool === "avahi-browse" ? "avahi" : "dns-sd",
		ssdp: read.ssdp.failure ? "blocked" : "ok"
	};
}
/**
 * `error` only when nothing could look (§4.9): not one of the helper's own packets left (the
 * presence check, its mDNS question, its M-SEARCH) and the system's resolver did not look
 * either. When the resolver looked, `note` instead, with the same reason and detail: what it
 * found is listed, and what announces nothing is missing.
 */
function problemOf(read) {
	if ((read.presence?.sent ?? 0) > 0 || !read.own.failure || !read.ssdp.failure) return {};
	const failure = read.presence?.failure ?? read.own.failure;
	const said = {
		reason: failure.reason,
		detail: failure.detail
	};
	if (read.system.looked) return { note: {
		...said,
		message: LAN_NOTE
	} };
	return { error: {
		...said,
		message: LAN_MESSAGE[failure.reason],
		detail: read.system.detail ? `${said.detail}; ${read.system.detail}` : said.detail
	} };
}
/** `192.168.68.0/24`: a network as people write it. */
function networkName(network) {
	const n = network.address.split(".").map(Number).reduce((sum, part) => sum * 256 + part, 0);
	const base = n - n % 2 ** (32 - network.prefix);
	return `${[
		base >>> 24,
		base >>> 16 & 255,
		base >>> 8 & 255,
		base & 255
	].join(".")}/${String(network.prefix)}`;
}
/** `Network: 11 devices on 192.168.68.0/24 (en0)`: counts and networks, never a name. */
function lanSummary(result) {
	const networks = result.networks.map((n) => `${networkName(n)} (${n.interface}${n.scanned < n.size ? `, ${String(n.scanned)} of ${String(n.size)} addresses checked` : ""})`);
	const count = `${plural(result.devices.length, "device")}${result.truncated ? " or more" : ""}`;
	return clean(`Network: ${count}${networks.length ? ` on ${networks.join(", ")}` : ""}`, 300);
}
/**
 * The terminal's lines for a look (§4.9), printed only when they differ from the last ones:
 * the summary, after a note's quiet line; or why it could not look, `blocked` with its causes
 * and fixes (the macOS one only on a Mac), and the summary only when something was found.
 */
function lanLines(result, platform) {
	const head = "Network: could not look for devices";
	if (result.error) {
		const { reason, detail } = result.error;
		const lines = reason === "blocked" ? blockedLines(head, /EPERM|EACCES/.test(detail) ? "not permitted" : "no route to host", platform) : reason === "no-network" ? [`${head}: this computer is not on a network`] : [clean(`${head}: ${detail}`, 300)];
		return result.devices.length ? [...lines, lanSummary(result)] : lines;
	}
	if (result.note) {
		const tool = result.sources.resolver === "none" ? "the system resolver" : result.sources.resolver;
		return [clean(`Network: listed through ${tool} only; the helper's own packets could not leave (${result.note.detail})`, 300), lanSummary(result)];
	}
	return [lanSummary(result)];
}
const FOUND_WORDS = {
	reply: "reply",
	neighbors: "neighbour table",
	mdns: "mDNS",
	ssdp: "SSDP",
	reverse: "reverse name",
	gateway: "gateway",
	self: "this computer"
};
/**
 * --doctor's Network section (§1.9, T18): the terminal's lines, what could look, then one line
 * per device with its address, how it was found and the service types it announces. Never a
 * name, a host name, a model or a hardware address: this output is pasted into PRs.
 */
function lanDoctorLines(result, platform) {
	const s = result.sources;
	const sources = [
		`presence ${s.presence === "off" && platform === "win32" ? "off (Windows)" : s.presence}`,
		s.neighbors === "ok" ? "neighbour table ok" : s.neighbors === "hidden" ? platform === "darwin" ? "neighbour table hidden by macOS" : "neighbour table empty" : "no neighbour table",
		s.resolver === "none" ? "no resolver" : `resolver ${s.resolver}`,
		`SSDP ${s.ssdp}`
	].join(" · ");
	return [
		...lanLines(result, platform),
		sources,
		...result.devices.map((d) => clean([
			d.address,
			`found by ${d.found.map((source) => FOUND_WORDS[source]).join(", ")}`,
			...d.services.length ? [[...new Set(d.services.map((service) => service.type))].join(", ")] : []
		].join(" · "), 300))
	];
}
/**
 * The bridge's LAN scanner (§4.9), built always (it needs no lane, and `--no-android` leaves
 * it on). One look at a time, a second caller joins it; a look answers for `lanCache` (30 s,
 * from its start), and `?refresh=1` starts a new one only `lanGap` (3 s) after the last one
 * started. A look runs on the helper's shutdown signal, never a request's: a page that leaves
 * stops waiting, the look goes on for whoever else waits. Nothing runs before a request, and
 * nothing starts once the helper is stopping.
 */
function createLanScanner(ctx) {
	const flights = singleFlight();
	const scanContext = {
		options: ctx.options,
		timeouts: ctx.timeouts,
		runTool: ctx.runTool,
		streamTool: ctx.streamTool,
		signal: ctx.signal,
		now: ctx.now
	};
	let last = null;
	let reported = "";
	let stopped = false;
	const scanNow = () => flights.run("lan", async () => {
		const startedAt = ctx.now();
		const result = await ctx.options.lanScan(scanContext);
		if (!stopped) last = {
			result,
			startedAt
		};
		return result;
	});
	/** The look's lines in the terminal, when they differ from the last ones printed. */
	const report = (result) => {
		const lines = lanLines(result, ctx.options.platform);
		const key = lines.join("\n");
		if (key === reported) return;
		reported = key;
		for (const line of lines) ctx.log(line);
	};
	return {
		async devices(refresh, signal) {
			if (stopped || ctx.signal.aborted) throw abortError();
			const age = last ? ctx.now() - last.startedAt : Infinity;
			const stale = age >= ctx.timeouts.lanCache || refresh && age >= ctx.timeouts.lanGap;
			if (flights.has("lan") || stale) {
				await Promise.race([scanNow(), aborted(signal)]);
				if (signal.aborted) throw abortError();
			}
			const result = last?.result;
			if (!result) throw abortError();
			report(result);
			return result;
		},
		async probeForDoctor(write) {
			const result = await ctx.options.lanScan(scanContext);
			for (const line of lanDoctorLines(result, ctx.options.platform)) write(line);
		},
		stop() {
			stopped = true;
		}
	};
}

//#endregion
//#region src/bridge.ts
/** ANDROID_ADB_SERVER_PORT when it is a valid port, as adb itself reads it; else 5037. */
function adbPortFrom(env) {
	const port = Number(env.ANDROID_ADB_SERVER_PORT);
	return Number.isInteger(port) && port > 0 && port < 65536 ? port : 5037;
}
/** `%SystemRoot%\System32\<file>`: where Windows keeps ARP.EXE and ROUTE.EXE. */
function system32(env, file) {
	return path.win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", "System32", file);
}
/** §1.6: every option filled. Tests replace the paths and ports so no real tool leaks in. */
function resolveOptions(input = {}) {
	const env = input.env ?? process.env;
	const platform = input.platform ?? process.platform;
	return {
		port: input.port ?? 8787,
		token: input.token,
		keepToken: input.keepToken ?? false,
		newToken: input.newToken ?? false,
		home: input.home ?? os.homedir(),
		searchPath: input.searchPath ?? env.PATH ?? "",
		extraDirs: input.extraDirs,
		platform,
		arch: input.arch ?? process.arch,
		nodeVersion: input.nodeVersion ?? process.versions.node,
		opensslVersion: input.opensslVersion ?? process.versions.openssl,
		getuid: "getuid" in input ? input.getuid : process.getuid?.bind(process),
		usbmuxdSocket: input.usbmuxdSocket ?? "/var/run/usbmuxd",
		adbPort: input.adbPort ?? adbPortFrom(env),
		tunneldPort: input.tunneldPort ?? 49151,
		upstream: input.upstream ?? "https://bauloc.github.io",
		xcodeSelectPath: input.xcodeSelectPath ?? "/usr/bin/xcode-select",
		plistBuddyPath: input.plistBuddyPath ?? "/usr/libexec/PlistBuddy",
		javaHomePath: input.javaHomePath ?? "/usr/libexec/java_home",
		openPath: input.openPath ?? "/usr/bin/open",
		swVersPath: input.swVersPath ?? "/usr/bin/sw_vers",
		applicationsDir: input.applicationsDir ?? "/Applications",
		coreDeviceDir: input.coreDeviceDir ?? "/Library/Developer/PrivateFrameworks/CoreDevice.framework",
		coreSimulatorDir: input.coreSimulatorDir ?? "/Library/Developer/PrivateFrameworks/CoreSimulator.framework",
		systemVersionPlist: input.systemVersionPlist ?? "/System/Library/CoreServices/SystemVersion.plist",
		open: input.open ?? true,
		wifi: input.wifi ?? false,
		simulators: input.simulators ?? false,
		android: input.android ?? true,
		local: input.local ?? true,
		dev: input.dev ?? false,
		verbose: input.verbose ?? false,
		timeouts: {
			...TIMEOUTS,
			...input.timeouts
		},
		heartbeatMs: input.heartbeatMs ?? 15e3,
		now: input.now ?? Date.now,
		log: input.log ?? ((line) => void process.stdout.write(line + "\n")),
		errorLog: input.errorLog ?? ((line) => void process.stderr.write(line + "\n")),
		env,
		tmpDir: input.tmpDir ?? os.tmpdir(),
		selfPath: input.selfPath,
		lanes: input.lanes ?? {},
		resolveTools: input.resolveTools ?? resolveTools,
		/**
		 * Resolved on first use: Node 18 warns once when fetch is first called, and only local
		 * mode ever calls it.
		 */
		fetch: input.fetch ?? ((url, init) => fetch(url, init)),
		mdns: input.mdns ?? udpTransport(),
		dnsSdPath: input.dnsSdPath ?? "/usr/bin/dns-sd",
		avahiBrowsePath: input.avahiBrowsePath,
		lanInterfaces: input.lanInterfaces ?? systemInterfaces,
		lanPresence: input.lanPresence ?? presenceTransport(),
		lanSsdp: input.lanSsdp ?? ssdpTransport(),
		lanDescription: input.lanDescription ?? fetchDescription,
		arpPath: input.arpPath ?? (platform === "win32" ? system32(env, "ARP.EXE") : "/usr/sbin/arp"),
		procNetArpPath: input.procNetArpPath ?? "/proc/net/arp",
		procNetRoutePath: input.procNetRoutePath ?? "/proc/net/route",
		routePath: input.routePath ?? (platform === "win32" ? system32(env, "ROUTE.EXE") : "/sbin/route"),
		avahiResolvePath: input.avahiResolvePath,
		lanScan: input.lanScan ?? scanLan
	};
}
/** The flags a run was started with, for the doctor report; never a token. */
function flagsOf(o) {
	const flags = [];
	if (o.port !== 8787 && o.port !== 0) flags.push(`--port ${String(o.port)}`);
	if (!o.open) flags.push("--no-open");
	if (o.keepToken) flags.push("--keep-token");
	if (o.wifi) flags.push("--wifi");
	if (o.simulators) flags.push("--simulators");
	if (!o.android) flags.push("--no-android");
	if (!o.local) flags.push("--no-local");
	if (o.dev) flags.push("--dev");
	if (o.verbose) flags.push("--verbose");
	return flags;
}
/**
 * The helper, assembled (§1.6). Nothing happens until listen() (or doctor()): no socket, no
 * file, no child process, so tests can build one with every path pointed at fakes.
 */
function createBridge(input = {}) {
	const options = resolveOptions(input);
	const { timeouts } = options;
	const token = options.token ?? (options.keepToken ? loadKeptToken({
		home: options.home,
		platform: options.platform,
		env: options.env,
		getuid: options.getuid,
		newToken: options.newToken
	}).token : generateToken());
	const tokenId = tokenIdOf(token);
	const runId = randomBytes(4).toString("hex");
	const shutdown = new AbortController();
	/** This bridge's own children, so closing one bridge never kills another's (tests run many). */
	const children = new Set();
	const limit = createLimiter(LIMITS.tools);
	let boundPort = 0;
	let startedAt = 0;
	let workDir = "";
	let workDirReady = null;
	let unregisterExit = () => void 0;
	let server = null;
	let closing = null;
	let selfHash = null;
	const logLine = (text) => options.log(`${timeOfDay(options.now())}  ${text}`);
	const bug = (error) => options.errorLog(`Device Lab helper hit a bug: ${bugText(error)}`);
	const factories = {
		ios: options.lanes.ios !== void 0 ? options.lanes.ios : options.platform === "darwin" ? createIosLane : null,
		android: options.lanes.android !== void 0 ? options.lanes.android : options.android ? createAndroidLane : null,
		simulators: options.lanes.simulators !== void 0 ? options.lanes.simulators : options.simulators && options.platform === "darwin" ? createSimulatorLane : null
	};
	const registry = createRegistry({
		runId,
		lanes: initialLanes({
			platform: options.platform,
			wifi: options.wifi,
			android: factories.android !== null,
			simulators: factories.simulators !== null || options.simulators
		}),
		now: options.now,
		activeMs: timeouts.active,
		log: logLine,
		bug: (line) => options.errorLog(line)
	});
	/** This run's private directory: mkdtemp (0700), removed at close and by the exit hook. */
	const ensureWorkDir = () => {
		workDirReady ??= mkdtemp(path.join(options.tmpDir, "device-bridge-")).then((dir) => {
			workDir = dir;
			unregisterExit = cleanUpOnExit(dir);
			return dir;
		});
		return workDirReady;
	};
	const withTempDir = async (fn) => {
		const dir = await mkdtemp(path.join(await ensureWorkDir(), "op-"));
		try {
			return await fn(dir);
		} finally {
			await rm(dir, {
				recursive: true,
				force: true
			});
		}
	};
	/** --verbose: one line per tool run, its name and outcome only. */
	const timed = (file, run) => {
		if (!options.verbose) return run;
		const started = Date.now();
		const report = (outcome) => logLine(`tool ${path.basename(file)} ${outcome} ${seconds(Date.now() - started)} s`);
		run.then(() => report("ok"), (error) => report(error instanceof Error && "reason" in error ? String(error.reason) : "failed"));
		return run;
	};
	/**
	 * Every one-shot tool a lane or preflight runs: in this run's private folder, with the
	 * cleaned environment, tracked for shutdown, and through the 4-at-a-time limiter (§1.3),
	 * so a page hammering Refresh cannot fork forty devicectl processes.
	 */
	const boundRunTool = ((file, argv, opts = {}) => limit(() => timed(file, runTool(file, argv, {
		cwd: workDir || options.tmpDir,
		env: childEnv({}, options.env),
		killGraceMs: timeouts.killGrace,
		track: children,
		...opts
	}))));
	const boundStreamTool = ((file, argv, opts) => {
		if (options.verbose) logLine(`tool ${path.basename(file)} streaming`);
		return streamTool(file, argv, {
			cwd: workDir || options.tmpDir,
			env: childEnv({}, options.env),
			killGraceMs: timeouts.killGrace,
			track: children,
			...opts
		});
	});
	let toolsAt = 0;
	let toolsPromise = null;
	const resolveFresh = () => {
		toolsAt = options.now();
		toolsPromise = options.resolveTools(toolOptionsFrom({
			...options,
			timeouts
		}, boundRunTool)).catch((error) => {
			bug(error);
			return emptyToolbox(options.now());
		});
		return toolsPromise;
	};
	const tools = {
		get: () => toolsPromise && options.now() - toolsAt < timeouts.toolsCache ? toolsPromise : resolveFresh(),
		refresh: resolveFresh
	};
	const laneContext = {
		publish: (lane, rows, departures) => registry.publish(lane, rows, departures),
		setLane: (lane, patch) => registry.setLane(lane, patch),
		tools,
		runTool: boundRunTool,
		streamTool: boundStreamTool,
		limit,
		isActive: () => registry.isActive(),
		log: logLine,
		timeouts,
		get workDir() {
			return workDir;
		},
		withTempDir,
		signal: shutdown.signal,
		options,
		now: options.now,
		childEnv: (extra) => childEnv(extra, options.env)
	};
	/** Every device on this network (§4.9): the bridge's own, whichever lanes run. */
	const lan = createLanScanner({
		options,
		timeouts,
		runTool: boundRunTool,
		streamTool: boundStreamTool,
		signal: shutdown.signal,
		now: options.now,
		log: logLine
	});
	const lanes = {};
	if (factories.ios) lanes.ios = factories.ios(laneContext);
	if (factories.android) lanes.android = factories.android(laneContext);
	if (factories.simulators) lanes.simulators = factories.simulators(laneContext);
	const laneList = () => [
		lanes.ios,
		lanes.android,
		lanes.simulators
	].filter((lane) => !!lane);
	const sha256 = () => {
		if (selfHash === null) try {
			const file = options.selfPath ?? fileURLToPath(import.meta.url);
			selfHash = createHash("sha256").update(readFileSync(file)).digest("hex");
		} catch {
			selfHash = "";
		}
		return selfHash;
	};
	const about = () => ({
		name: NAME,
		version: VERSION,
		protocol: 1,
		node: options.nodeVersion,
		openssl: options.opensslVersion,
		platform: options.platform,
		arch: options.arch,
		port: boundPort,
		startedAt,
		local: options.local,
		tokenPersistent: options.keepToken,
		flags: flagsOf(options),
		sha256: sha256()
	});
	const health = (challenge = null) => {
		const features = [
			lanes.android ? "android.start-server" : null,
			lanes.android ? "android.connect" : null,
			lanes.android ? "android.discover" : null,
			lanes.android ? "android.adb" : null,
			options.local ? "local" : null,
			lanes.simulators ? "simulators" : null,
			options.wifi ? "wifi" : null,
			"lan.discover"
		].filter((feature) => feature !== null);
		return {
			name: NAME,
			version: VERSION,
			protocol: 1,
			features,
			port: boundPort,
			tokenId,
			tokenPersistent: options.keepToken,
			runId,
			startedAt,
			local: options.local,
			platform: `${options.platform}-${options.arch}`,
			sha256: sha256(),
			...challenge !== null && CHALLENGE_PATTERN.test(challenge) ? { proof: proofOf(token, boundPort, challenge) } : {}
		};
	};
	const preflightContext = {
		options,
		tools,
		lanes,
		lanesState: () => registry.lanes(),
		devices: () => registry.devices(),
		runTool: boundRunTool,
		timeouts,
		get workDir() {
			return workDir;
		},
		signal: shutdown.signal,
		now: options.now,
		about,
		lan
	};
	let preflightPromise = null;
	const preflight = (opts = {}) => {
		if (opts.refresh || !preflightPromise) preflightPromise = collectPreflight(preflightContext, { refresh: opts.refresh === true }).catch((error) => {
			bug(error);
			return [];
		});
		return preflightPromise;
	};
	/** GET /api/doctor, cached 30 s; ?refresh=1 starts over. */
	let doctorAt = 0;
	let doctorPromise = null;
	const doctor = (refresh) => {
		if (!refresh && doctorPromise && options.now() - doctorAt < timeouts.doctorCache) return doctorPromise;
		doctorAt = options.now();
		const report = doctorReport(preflightContext, { refresh });
		doctorPromise = report;
		report.catch(() => {
			if (doctorPromise === report) doctorPromise = null;
		});
		return report;
	};
	const api = createApi({
		options,
		registry,
		lanes,
		tools,
		tokenId,
		bearer: createBearerCheck(token),
		health,
		doctor,
		local: options.local ? createLocalMode({
			upstream: options.upstream,
			timeouts,
			now: options.now,
			fetch: options.fetch
		}) : null,
		port: () => boundPort,
		pageConnected: createPageLog(logLine),
		log: logLine,
		bug,
		signal: shutdown.signal,
		lan
	});
	async function listen() {
		if (server) throw new Error("This bridge is already listening.");
		await ensureWorkDir();
		const s = http.createServer((req, res) => api.handle(req, res));
		s.requestTimeout = timeouts.requestTimeout;
		s.headersTimeout = timeouts.headersTimeout;
		s.maxConnections = LIMITS.maxConnections;
		/**
		 * One WebSocket only, the adb tunnel (§4.10), behind the same checks as every request;
		 * any other upgrade, and every CONNECT, is refused by the API or destroyed here.
		 */
		s.on("upgrade", (req, socket, head) => api.upgrade(req, socket, head));
		s.on("connect", (_req, socket) => socket.destroy());
		s.on("clientError", (_error, socket) => {
			if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
			else socket.destroy();
		});
		await new Promise((resolve, reject) => {
			s.once("error", reject);
			/**
			 * 127.0.0.1 only: never ::, never the LAN. The port is never switched silently: it is
			 * part of the local page's origin and of every remembered pairing.
			 */
			s.listen(options.port, "127.0.0.1", () => {
				s.off("error", reject);
				resolve();
			});
		});
		server = s;
		boundPort = s.address().port;
		startedAt = options.now();
		for (const lane of laneList()) try {
			lane.start();
		} catch (error) {
			bug(error);
		}
		preflight();
		return { port: boundPort };
	}
	/**
	 * §1.8 in order: stop accepting, end every log stream with `shutdown`, abort the lanes'
	 * work and let them close their sockets, TERM then KILL every tool group, close the
	 * remaining connections, and remove the private folder. Idempotent.
	 */
	function close() {
		closing ??= (async () => {
			server?.close();
			api.endStreams("shutdown");
			shutdown.abort();
			lan.stop();
			await Promise.race([Promise.allSettled(laneList().map((lane) => Promise.resolve().then(() => lane.stop()))), sleep(timeouts.killGrace)]);
			await killAll(timeouts.killGrace, children);
			if (server && typeof server.closeIdleConnections === "function") server.closeIdleConnections();
			await sleep(100);
			if (server && typeof server.closeAllConnections === "function") server.closeAllConnections();
			if (workDir) await rm(workDir, {
				recursive: true,
				force: true
			}).catch(() => void 0);
			unregisterExit();
		})();
		return closing;
	}
	async function doctorCommand(write) {
		await ensureWorkDir();
		try {
			await printDoctor(preflightContext, write);
		} catch (error) {
			write(`The doctor stopped early: ${errorText(error)}`);
		} finally {
			shutdown.abort();
			await killAll(timeouts.killGrace, children);
			await rm(workDir, {
				recursive: true,
				force: true
			}).catch(() => void 0);
			unregisterExit();
		}
	}
	return {
		listen,
		close,
		get port() {
			return boundPort;
		},
		token,
		tokenId,
		runId,
		registry,
		lanes,
		options,
		health,
		preflight,
		toolbox: () => tools.get(),
		doctor: doctorCommand
	};
}

//#endregion
//#region src/banner.ts
/** The links that pair a page, each carrying this run's token in the fragment (§6.2). */
function pairLinks(port, token) {
	const fragment = `#pair=${token}${port === 8787 ? "" : `&port=${String(port)}`}`;
	return {
		hosted: `${SITE}/device/${fragment}`,
		local: `http://127.0.0.1:${String(port)}/device/${fragment}`,
		dev: `http://localhost:7360/device/${fragment}`
	};
}
/** Twelve columns, so the lane lines read as a table. */
const column = (name) => name.padEnd(12);
function iphoneLine(b) {
	const ios = b.lanes.ios;
	if (b.platform !== "darwin") return `${column("iPhone")}unavailable · iPhones need macOS`;
	if (ios.status === "error") return `${column("iPhone")}not answering · ${ios.reason ?? "macOS's iPhone service (usbmuxd) isn't answering"}`;
	if (ios.status === "unavailable") return `${column("iPhone")}${ios.reason ? `unavailable · ${ios.reason}` : "checking…"}`;
	const xcode = b.toolbox?.xcode;
	if (!xcode) return `${column("iPhone")}ready · checking Xcode…`;
	if (xcode.state === "ready") {
		const which = xcode.version ? `Xcode ${xcode.version}` : "Xcode";
		return `${column("iPhone")}ready · screenshots of iOS 17 and newer through ${which}`;
	}
	if (xcode.state === "needs-first-launch") return `${column("iPhone")}ready · Xcode must finish setting up before screenshots work: open Xcode once`;
	return `${column("iPhone")}ready · screenshots of iOS 17 and newer need Xcode (identifiers and logs work)`;
}
function androidLine(b) {
	const android = b.lanes.android;
	if (android.status === "off") return `${column("Android")}off (--no-android)`;
	const adb = b.toolbox?.adb;
	const named = adb ? adb.version ? `adb ${adb.version}` : "adb" : null;
	if (android.status === "ok") {
		const lead = named ? `${named} · ` : "";
		return `${column("Android")}${lead}sharing the running adb server (${plural(b.androidDevices, "phone")})`;
	}
	if (!b.toolbox) return `${column("Android")}checking…`;
	if (!named) return `${column("Android")}adb not found · Chrome's WebUSB still works; for Safari or Firefox: ${INSTALL.adb}`;
	if (android.status === "error") return `${column("Android")}${named} · ${android.reason ?? "the adb server isn't answering"}`;
	return `${column("Android")}${named} · no adb server running, so Android stays with Chrome's WebUSB`;
}
/**
 * A lane still in its initial state, 'unavailable' with no reason, has not reported yet:
 * every real 'unavailable' a lane sets carries a reason (§1.3, initialLanes).
 */
const pending = (lane) => lane.status === "unavailable" && lane.reason === void 0;
/** True once the iPhone and simulator lanes have each reported at least once. */
function lanesReported(lanes) {
	return !pending(lanes.ios) && !pending(lanes.simulators);
}
function simulatorsLine(b) {
	const simulators = b.lanes.simulators;
	if (simulators.status === "off") return `${column("Simulators")}off (add --simulators to list booted ones)`;
	if (simulators.status === "ok") return `${column("Simulators")}${simulators.booted ? String(simulators.booted) : "none"} booted`;
	if (pending(simulators)) return `${column("Simulators")}checking…`;
	return `${column("Simulators")}unavailable · ${simulators.reason ?? "simulators need Xcode"}`;
}
/** §1.10, exact: what the tester reads first, and the links that pair a page. */
function bannerText(b) {
	const links = pairLinks(b.port, b.token);
	const hidden = b.lanes.ios.wifiHidden;
	return [
		`Device Lab helper ${b.version} · http://127.0.0.1:${String(b.port)} (this Mac only)`,
		"",
		b.opening ? "Opening Device Lab in your browser. If nothing opens, use the link for your browser:" : "Open Device Lab with the link for your browser:",
		`  Chrome, Edge, Firefox   ${links.hosted}`,
		`  Safari                  ${links.local}`,
		...b.dev ? [`  Dev server              ${links.dev}`] : [],
		b.keepToken ? `Or paste this token on the page (kept between runs):  ${b.token}` : `Or paste this token on the page:  ${b.token}`,
		`Fingerprint ${b.tokenId} — the page shows the same one once it is paired.`,
		"",
		iphoneLine(b),
		androidLine(b),
		simulatorsLine(b),
		...hidden > 0 ? [`${column("Wi-Fi")}${plural(hidden, "iPhone")} seen only over Wi-Fi (add --wifi to list ${hidden === 1 ? "it" : "them"})`] : [],
		...b.checklist ?? [`${column("Checks")}checking…`],
		`Full checklist: node ${b.script} --doctor`,
		"",
		b.keepToken ? "Keep this window open while you test. Ctrl+C stops the helper; the token stays the same across restarts (--keep-token)." : "Keep this window open while you test. Ctrl+C stops the helper; the token changes on every start."
	].join("\n");
}

//#endregion
//#region src/main.ts
/** The real process. */
function processEnv() {
	return {
		argv: process.argv.slice(2),
		scriptPath: process.argv[1],
		stdout: (text) => void process.stdout.write(text),
		stderr: (text) => void process.stderr.write(text),
		isTTY: process.stdout.isTTY === true,
		platform: process.platform,
		home: os.homedir(),
		cwd: process.cwd(),
		getuid: process.getuid?.bind(process),
		onSignal: (signal, handler) => void process.on(signal, handler),
		exit: (code) => process.exit(code),
		openUrl(url) {
			/**
			 * The link carries the token, so it goes to AppleScript's `open location` on stdin, not in
			 * argv: any user on the Mac can read a process's arguments with `ps`, even for the moment
			 * `/usr/bin/open` would live (threat T8). Detached and unref'd: the browser must not become
			 * our child or hold our terminal.
			 */
			const child = spawn("/usr/bin/osascript", ["-"], {
				stdio: [
					"pipe",
					"ignore",
					"ignore"
				],
				detached: true
			});
			child.on("error", () => void 0);
			child.stdin.on("error", () => void 0);
			child.stdin.end(`open location ${JSON.stringify(url)}\n`);
			child.unref();
		}
	};
}
/** Terminal lines are held until the banner is out, so the banner always comes first. */
function heldLines(write) {
	let held = [];
	return {
		line(text) {
			if (held) held.push(text);
			else write(text + "\n");
		},
		release() {
			const lines = held ?? [];
			held = null;
			for (const text of lines) write(text + "\n");
		}
	};
}
/** What answers on `port`, when something does: our own helper, or another program. */
function probeHealth(port, timeoutMs) {
	return new Promise((resolve) => {
		const req = http.get({
			host: "127.0.0.1",
			port,
			path: "/api/health",
			timeout: timeoutMs
		}, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => {
				body += chunk;
				if (body.length > 65536) req.destroy();
			});
			res.on("end", () => {
				try {
					resolve(JSON.parse(body));
				} catch {
					resolve(null);
				}
			});
			res.on("error", () => resolve(null));
		});
		req.on("timeout", () => req.destroy());
		req.on("error", () => resolve(null));
	});
}
/** §1.10's two port messages: never switch ports silently (it is part of every pairing). */
async function portInUseText(port, script, timeoutMs) {
	const health = await probeHealth(port, timeoutMs);
	if (health?.name === "bauloc-device-bridge" && typeof health.version === "string") return `A Device Lab helper (${health.version}) is already running on port ${String(port)}. Use that window, or stop it with Ctrl+C there.\n`;
	const next = port === 65535 ? port - 1 : port + 1;
	return `Port ${String(port)} is used by another program. Start the helper on another port:\n  node ${script} --port ${String(next)}\n`;
}
function bridgeInputFrom(cli, env, log) {
	return {
		port: cli.port,
		open: cli.open,
		keepToken: cli.keepToken,
		newToken: cli.newToken,
		wifi: cli.wifi,
		simulators: cli.simulators,
		android: cli.android,
		local: cli.local,
		dev: cli.dev,
		verbose: cli.verbose,
		platform: env.platform,
		home: env.home,
		getuid: env.getuid,
		log,
		errorLog: (line) => env.stderr(line + "\n"),
		...env.bridge
	};
}
/** Waits for `work` at most `ms`; null when it did not finish (the banner prints "checking…"). */
async function within(work, ms) {
	const late = sleep(ms).then(() => null);
	return Promise.race([work.catch(() => null), late]);
}
/** §1.7. Returns once the helper is serving, or after env.exit() was called. */
async function main(env) {
	const script = scriptHint(env.scriptPath, env.home, env.cwd);
	let cli;
	try {
		cli = parseCli(env.argv, script);
	} catch (error) {
		if (!(error instanceof UsageError)) throw error;
		env.stderr(error.message + "\n");
		return env.exit(64);
	}
	if (cli.help) {
		env.stdout(helpText(script));
		return env.exit(0);
	}
	if (cli.version) {
		env.stdout(VERSION + "\n");
		return env.exit(0);
	}
	if (env.getuid?.() === 0) {
		env.stderr(`Don't run the Device Lab helper with sudo; it never needs root. Run it as yourself: node ${script}\n`);
		return env.exit(1);
	}
	const out = heldLines(env.stdout);
	let bridge;
	try {
		bridge = createBridge(bridgeInputFrom(cli, env, out.line));
	} catch (error) {
		if (!(error instanceof TokenFileError)) throw error;
		env.stderr(error.message + "\n");
		return env.exit(1);
	}
	const { timeouts } = bridge.options;
	if (cli.doctor) {
		await bridge.doctor((line) => env.stdout(line + "\n"));
		return env.exit(0);
	}
	try {
		await bridge.listen();
	} catch (error) {
		if (error.code === "EADDRINUSE") env.stderr(await portInUseText(cli.port, script, timeouts.portProbe));
		else env.stderr(`The Device Lab helper could not listen on 127.0.0.1:${String(cli.port)}: ${bugText(error)}\n`);
		await bridge.close();
		return env.exit(1);
	}
	let stopping = false;
	const stop = () => {
		if (stopping) return env.exit(130);
		stopping = true;
		out.release();
		env.stdout("\nStopping… (press Ctrl+C again to force)\n");
		bridge.close().then(() => {
			if (bridge.registry.lanes().android.startedByHelper) {
				const facts = bridge.lanes.android?.facts();
				const adb = facts?.adb ? {
					path: facts.adb,
					version: facts.version
				} : null;
				const kill = `${adbCommand(adb, bridge.options.searchPath)} kill-server`;
				env.stdout(`The adb server started from Device Lab is still running. Chrome's WebUSB can use Android phones again after: ${kill}\n`);
			}
			env.exit(0);
		}, (error) => {
			env.stderr(bugText(error) + "\n");
			env.exit(1);
		});
	};
	env.onSignal("SIGINT", stop);
	env.onSignal("SIGTERM", stop);
	env.onSignal("SIGHUP", stop);
	const bannerBy = Date.now() + timeouts.banner;
	const [items, toolbox] = await Promise.all([within(bridge.preflight(), timeouts.banner), within(bridge.toolbox(), timeouts.banner)]);
	/**
	 * A lane's first report prints no terminal line, so the banner is the only place the
	 * tester learns "3 booted": give the lanes the rest of the same budget to report.
	 */
	while (!stopping && !lanesReported(bridge.registry.lanes()) && Date.now() < bannerBy) await sleep(50);
	if (stopping) return;
	const opening = env.platform === "darwin" && env.isTTY && cli.open;
	const lanes = bridge.registry.lanes();
	env.stdout(bannerText({
		version: VERSION,
		port: bridge.port,
		token: bridge.token,
		tokenId: bridge.tokenId,
		keepToken: cli.keepToken,
		dev: cli.dev,
		opening,
		script,
		platform: env.platform,
		lanes,
		androidDevices: bridge.registry.devices().filter((d) => d.platform === "android").length,
		toolbox,
		checklist: items ? formatChecklist(items, { all: false }) : null
	}) + "\n\n");
	out.release();
	if (opening) env.openUrl(pairLinks(bridge.port, bridge.token).hosted);
}
/** True when this file is the one Node was asked to run (not imported by a test). */
function isMain(scriptPath = process.argv[1], moduleUrl = import.meta.url) {
	try {
		return !!scriptPath && realpathSync(scriptPath) === realpathSync(fileURLToPath(moduleUrl));
	} catch {
		return false;
	}
}
if (isMain()) {
	/**
	 * A lane bug must not take the helper down mid-test; it is reported and the rest keeps working.
	 */
	process.on("unhandledRejection", (error) => {
		process.stderr.write(`Device Lab helper hit a bug: ${bugText(error)}\n`);
	});
	/** `node device-bridge.mjs | head` closes stdout early; that is not a reason to crash. */
	process.stdout.on("error", () => void 0);
	main(processEnv()).catch((error) => {
		process.stderr.write(`Device Lab helper hit a bug: ${bugText(error)}\n`);
		process.exit(1);
	});
}

//#endregion
export { ADB_DETAIL, ADB_EXEC, EMITTED_BLOCKERS, HelperError, ID, LOCKDOWN_REQUESTS, LOCKDOWN_SERVICES, NAME, PROTOCOL, VERSION, bootHtml, buildPlist, classifyDevicectl, createBridge, deriveIos, formatChecklist, isMain, liveChildren, main, mapAdbState, parseDevicesL, parsePlist, portInUseText, processEnv, proofOf, runTool, splitSyslogRelay, tokenIdOf, which };
