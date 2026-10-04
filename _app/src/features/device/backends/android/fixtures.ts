/*
  Phone output for the Android tests, in the exact shapes AOSP main prints it (the formats the
  read-only probe documented; its first run on the Pixel will bring recorded output to compare).
  Every package, path, photo and serial here is made up: the repo is public, and a real app list
  or photo name says more about its owner than it should.
*/

/* ---------------------------------------------------------------- *
 * pm list packages
 * ---------------------------------------------------------------- */

/**
 * `cmd package list packages -f -i -U --show-versioncode -3`: HashMap order, `=` inside the
 * paths, two spaces before installer=, a null installer, a package in two users, and a
 * versionCode past 2^31 (versionCodeMajor).
 */
export const PM_LIST_USER = [
  'package:/data/app/~~bm9TZWNyZXQ=/com.example.shop-cD4xYQ==/base.apk=com.example.shop versionCode:4294967338  installer=com.google.android.packageinstaller uid:10288',
  'package:/data/app/~~Ab1x9QzT0pL3==/com.example.notes-Zz9_QwErTy==/base.apk=com.example.notes versionCode:42  installer=com.android.vending uid:10234',
  'package:/data/app/~~Q2Fv==/org.sample.reader-AA==/base.apk=org.sample.reader versionCode:7  installer=null uid:10301,1010301',
  '',
].join('\n')

/** The same app twice: two users on different versions print two lines. */
export const PM_LIST_TWO_USERS = [
  'package:/data/app/~~Q2Fv==/org.sample.reader-AA==/base.apk=org.sample.reader versionCode:7  installer=null uid:10301',
  'package:/data/app/~~Q2Fv==/org.sample.reader-AA==/base.apk=org.sample.reader versionCode:6  installer=null uid:1010301',
].join('\n')

/** `-s`, with the framework itself: the one package name without a dot. */
export const PM_LIST_SYSTEM = [
  'package:/system/framework/framework-res.apk=android versionCode:37  installer=null uid:1000',
  'package:/system_ext/priv-app/SettingsExample/SettingsExample.apk=com.android.settings versionCode:37  installer=null uid:1000',
  'package:/data/app/~~cHJvZA==/com.android.chrome-bW9yZQ==/base.apk=com.android.chrome versionCode:695112333  installer=com.android.vending uid:10140',
].join('\n')

/** `-f -i` only (the retry): no versionCode, so the name sits right before the two spaces. */
export const PM_LIST_MINIMAL =
  'package:/data/app/~~Ab1x9QzT0pL3==/com.example.notes-Zz9_QwErTy==/base.apk=com.example.notes  installer=com.android.vending\n'

/** What a pm that does not know a flag prints instead of the list. */
export const PM_LIST_UNKNOWN_OPTION = 'Error: Unknown option: --show-versioncode\n'

/* ---------------------------------------------------------------- *
 * dumpsys package --checkin
 * ---------------------------------------------------------------- */

/** AOSP main: last update on the pkg line, first install per user; installer, uid and owner glued. */
export const CHECKIN_MAIN = [
  'vers,1',
  'pkg,com.example.notes,10234,42,1790000000000,com.android.vending10123com.android.vending,2',
  'pkg-splt,base,0',
  'pkg-splt,config.arm64_v8a,0',
  'pkg-splt,config.xxhdpi,3',
  'pkg-usr,0,IbsusLiavpiqha,0,?,1780000000000,',
  'pkg-usr,10,ibsuSliavpiqha,0,?,0,',
  'pkg,org.sample.reader,10301,7,1791000000000,?-1?,0',
  'pkg-splt,base,0',
  'pkg-usr,0,IbsuSLiavpiqha,3,com.android.settings,1785000000000,',
  'pkg,com.example.shop,10288,4294967338,1792000000000,com.google.android.packageinstaller10055?,4',
  'pkg-splt,base,0',
  'pkg-usr,0,IbsusLiavpiqha,2,?,1786000000000,',
  '',
].join('\n')

/** Older Android: first install and last update both on the pkg line, the installer plain. */
export const CHECKIN_OLDER = [
  'vers,1',
  'pkg,com.example.notes,10234,42,1780000000000,1790000000000,com.android.vending',
  'pkg-splt,base,0',
  'pkg-usr,0,IbsusLiavpi,0,?',
  'pkg,org.sample.reader,10301,7,1781000000000,1791000000000,?',
  'pkg-splt,base,0',
  'pkg-usr,0,IbsuSLiavpi,3,com.android.settings',
].join('\n')

/** Android 6: no suspended pair in the user flags. */
export const CHECKIN_MARSHMALLOW = [
  'pkg,com.example.notes,10234,42,1780000000000,1790000000000,com.android.vending',
  'pkg-usr,0,IbSL,0,?',
].join('\n')

/* ---------------------------------------------------------------- *
 * dumpsys package <pkg>
 * ---------------------------------------------------------------- */

const MAIN_BLOCK = [
  '  Package [com.example.notes] (3f2a1b0):',
  '    appId=10234',
  '    pkg=Package{9a8b7c6 com.example.notes}',
  '    codePath=/data/app/~~Ab1x9QzT0pL3==/com.example.notes-Zz9_QwErTy==',
  '    resourcePath=/data/app/~~Ab1x9QzT0pL3==/com.example.notes-Zz9_QwErTy==',
  '    legacyNativeLibraryDir=/data/app/~~Ab1x9QzT0pL3==/com.example.notes-Zz9_QwErTy==/lib',
  '    extractNativeLibs=false',
  '    primaryCpuAbi=arm64-v8a',
  '    secondaryCpuAbi=null',
  '    cpuAbiOverride=null',
  '    versionCode=42 minSdk=24 targetSdk=36',
  '    minExtensionVersions=[]',
  '    versionName=1.4.0 (beta 2)',
  '    hiddenApiEnforcementPolicy=2',
  '    usesNonSdkApi=false',
  '    splits=[base, config.arm64_v8a, config.xxhdpi:3]',
  '    apkSigningVersion=3',
  '    flags=[ HAS_CODE ALLOW_CLEAR_USER_DATA ALLOW_BACKUP DEBUGGABLE ]',
  '    privateFlags=[ PRIVATE_FLAG_ACTIVITIES_RESIZE_MODE_RESIZEABLE ]',
  '    forceQueryable=false',
  '    timeStamp=2026-09-20 09:29:58',
  '    lastUpdateTime=2026-09-20 09:30:00',
  '    installerPackageName=com.android.vending',
  '    installerPackageUid=10123',
  '    initiatingPackageName=com.android.vending',
  '    originatingPackageName=null',
  '    packageSource=2',
  '    pkgFlags=[ HAS_CODE ALLOW_CLEAR_USER_DATA ALLOW_BACKUP ]',
  '    requested permissions:',
  '      android.permission.INTERNET',
  '    install permissions:',
  '      android.permission.INTERNET: granted=true',
  '    User 0: ceDataInode=123456 deDataInode=0 installed=true hidden=false suspended=false distractionFlags=0 stopped=false notLaunched=false enabled=0 instant=false virtual=false quarantined=false',
  '      installReason=4',
  '      dataDir=/data/user/0/com.example.notes',
  '      firstInstallTime=2026-08-01 08:00:00',
  '      uninstallReason=0',
  '    User 10: ceDataInode=0 deDataInode=0 installed=false hidden=false suspended=false distractionFlags=0 stopped=true notLaunched=true enabled=0 instant=false virtual=false quarantined=false',
  '      installReason=0',
  '      dataDir=/data/user/10/com.example.notes',
  '      firstInstallTime=1970-01-01 07:00:00',
  '      uninstallReason=0',
]

/** AOSP main, with the sections that come before `Packages:` and one after it. */
export const DUMPSYS_PACKAGE = [
  'Activity Resolver Table:',
  '  Non-Data Actions:',
  '      android.intent.action.MAIN:',
  '        2b3c4d5 com.example.notes/.MainActivity filter 6e7f809',
  '',
  'Key Set Manager:',
  '  [com.example.notes]',
  '      Signing KeySets: 52',
  '',
  'Packages:',
  ...MAIN_BLOCK,
  '',
  'Queries:',
  '  system apps queryable: false',
  '',
].join('\n')

/** An updated system app: the factory copy follows under `Hidden system packages:`. */
export const DUMPSYS_UPDATED_SYSTEM_APP = [
  'Packages:',
  '  Package [com.android.chrome] (1a2b3c4):',
  '    versionCode=695112333 minSdk=29 targetSdk=36',
  '    versionName=140.0.7339.51',
  '    flags=[ SYSTEM HAS_CODE ALLOW_CLEAR_USER_DATA UPDATED_SYSTEM_APP ]',
  '    lastUpdateTime=2026-09-28 18:00:00',
  '    installerPackageName=com.android.vending',
  '',
  'Hidden system packages:',
  '  Package [com.android.chrome] (5d6e7f8):',
  '    versionCode=600000000 minSdk=29 targetSdk=35',
  '    versionName=128.0.6613.0',
  '',
].join('\n')

/** Android 9: times and the data folder at package level, no splits beyond base. */
export const DUMPSYS_PACKAGE_OLDER = [
  'Packages:',
  '  Package [com.example.notes] (3f2a1b0):',
  '    userId=10234',
  '    codePath=/data/app/com.example.notes-1',
  '    primaryCpuAbi=null',
  '    versionCode=42 minSdk=21 targetSdk=28',
  '    versionName=1.4.0',
  '    splits=[base]',
  '    flags=[ HAS_CODE ALLOW_CLEAR_USER_DATA ALLOW_BACKUP TEST_ONLY ]',
  '    dataDir=/data/user/0/com.example.notes',
  '    timeStamp=2019-05-01 10:00:00',
  '    firstInstallTime=2019-04-01 08:00:00',
  '    lastUpdateTime=2019-05-01 10:00:05',
  '    installerPackageName=null',
  '    User 0: ceDataInode=123 installed=true hidden=false suspended=false stopped=true notLaunched=false enabled=3 instant=false virtual=false',
  '      gids=[3003]',
  '',
].join('\n')

/** `pm path`: base first, then the splits Play installed. */
export const PM_PATH = [
  'package:/data/app/~~Ab1x9QzT0pL3==/com.example.notes-Zz9_QwErTy==/base.apk',
  'package:/data/app/~~Ab1x9QzT0pL3==/com.example.notes-Zz9_QwErTy==/split_config.arm64_v8a.apk',
  'package:/data/app/~~Ab1x9QzT0pL3==/com.example.notes-Zz9_QwErTy==/split_config.xxhdpi.apk',
  '',
].join('\n')

/* ---------------------------------------------------------------- *
 * Launcher activities
 * ---------------------------------------------------------------- */

export const RESOLVE_ONE = [
  'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false',
  'com.example.notes/.MainActivity',
  '',
].join('\n')

/** Two launcher activities: resolve-activity names Android's chooser, not the app. */
export const RESOLVE_CHOOSER = [
  'priority=0 preferredOrder=0 match=0x0 specificIndex=-1 isDefault=false',
  'android/com.android.internal.app.ResolverActivity',
  '',
].join('\n')

export const QUERY_TWO_LAUNCHERS = [
  '2 activities found:',
  '  Activity #0:',
  '    priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false',
  '    com.example.notes/.MainActivity',
  '  Activity #1:',
  '    priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false',
  '    com.example.notes/leakcanary.internal.activity.LeakLauncherActivity',
  '',
].join('\n')

/* ---------------------------------------------------------------- *
 * pm install sessions
 * ---------------------------------------------------------------- */

export const PM_OUTPUT = {
  created: 'Success: created install session [1234567]\n',
  streamed: 'Success: streamed 3000 bytes\n',
  success: 'Success\n',
  dexWarningThenSuccess: 'Warning [Could not validate the dex paths: base.dm]\nSuccess\n',
  warnings:
    'Warning: Package com.example.notes uses a deprecated API.\nWarning: Package com.example.notes was installed for user 0 only.\nCompleted with warning(s)\n',
  updateIncompatible:
    'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package com.example.notes signatures do not match newer version; ignoring!]\n',
  downgrade:
    'Failure [INSTALL_FAILED_VERSION_DOWNGRADE: Downgrade detected: Update version code 7 is older than current 9]\n',
  missingSplit: 'Failure [INSTALL_FAILED_MISSING_SPLIT: Missing split for com.example.notes]\n',
  noMatchingAbis:
    'Failure [INSTALL_FAILED_NO_MATCHING_ABIS: Failed to extract native libraries, res=-113]\n',
  olderSdk:
    'Failure [INSTALL_FAILED_OLDER_SDK: Requires newer sdk version #38 (current version is #37)]\n',
  deprecatedSdk:
    'Failure [INSTALL_FAILED_DEPRECATED_SDK_VERSION: App package must target at least SDK version 24, but found 22]\n',
  noCertificates:
    'Failure [INSTALL_PARSE_FAILED_NO_CERTIFICATES: No signature found in package of version 2 or newer for package com.example.notes]\n',
  invalidApk:
    'Failure [INSTALL_FAILED_INVALID_APK: Split config.xxhdpi was defined multiple times]\n',
  inconsistentCertificates:
    'Failure [INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES: Split config.en signatures are inconsistent with base]\n',
  notApk:
    'Failure [INSTALL_PARSE_FAILED_NOT_APK: Failed to parse /data/app/vmdl1234567.tmp/0.apk: Failed to load asset path /data/app/vmdl1234567.tmp/0.apk]\n',
  duplicatePermission:
    'Failure [INSTALL_FAILED_DUPLICATE_PERMISSION: Package com.example.notes.debug attempting to redeclare permission com.example.notes.permission.C2D_MESSAGE already owned by com.example.notes]\n',
  conflictingProvider:
    "Failure [INSTALL_FAILED_CONFLICTING_PROVIDER: Can't install because provider name com.example.notes.files (in package com.example.notes.debug) is already used by com.example.notes]\n",
  insufficientStorage: 'Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]\n',
  userRestricted: 'Failure [INSTALL_FAILED_USER_RESTRICTED: Install canceled by user]\n',
  aborted: 'Failure [INSTALL_FAILED_ABORTED: User rejected permissions]\n',
  verificationFailure: 'Failure [INSTALL_FAILED_VERIFICATION_FAILURE]\n',
  verificationTimeout: 'Failure [INSTALL_FAILED_VERIFICATION_TIMEOUT]\n',
  testOnly:
    'Failure [INSTALL_FAILED_TEST_ONLY: Failed to install test-only apk. Did you forget to add -t?]\n',
  bracketsInMessage:
    'Failure [INSTALL_FAILED_INVALID_APK: Full install must include a base package: splits=[config.en]]\n',
  writeFailed: 'Error: failed to write; write failed: ENOSPC (No space left on device)\n',
  exception:
    "Exception occurred while executing 'install-create':\njava.lang.IllegalArgumentException: Unknown option --bypass-low-target-sdk-block\n\tat com.android.server.pm.PackageManagerShellCommand.makeInstallParams(PackageManagerShellCommand.java:3612)\n",
  notInstalled: 'Failure [not installed for 0]\n',
  deleteFailed: 'Failure [DELETE_FAILED_INTERNAL_ERROR]\n',
} as const

/* ---------------------------------------------------------------- *
 * MediaStore: content query
 * ---------------------------------------------------------------- */

/**
 * Android 11+ projection. Row 1's name holds ", " and "=", which a naive split would break on;
 * its datetaken is NULL, as for most downloads; row 2 is a HEIC.
 */
export const CONTENT_ROWS = [
  'Row: 0 _id=1000012345, _display_name=Screenshot_20261001-101010.png, relative_path=Pictures/Screenshots/, _size=3215801, datetaken=1790000000000, date_modified=1790000000, width=1080, height=2424, mime_type=image/png, _data=/storage/emulated/0/Pictures/Screenshots/Screenshot_20261001-101010.png',
  'Row: 1 _id=1000012344, _display_name=menu, final, v2=ok.jpg, relative_path=DCIM/Camera/, _size=4123456, datetaken=NULL, date_modified=1789990000, width=4080, height=3072, mime_type=image/jpeg, _data=/storage/emulated/0/DCIM/Camera/menu, final, v2=ok.jpg',
  'Row: 2 _id=1000012343, _display_name=IMG_20260930_080000.heic, relative_path=DCIM/Camera/, _size=2500000, datetaken=1789900000000, date_modified=1789900000, width=4000, height=3000, mime_type=image/heic, _data=/storage/emulated/0/DCIM/Camera/IMG_20260930_080000.heic',
  '',
].join('\n')

/** Android 9: no relative_path column; the folder comes from _data. */
export const CONTENT_ROWS_OLDER =
  'Row: 0 _id=4711, _display_name=IMG_0001.jpg, _size=2048000, datetaken=1550000000000, date_modified=1550000000, width=3024, height=4032, mime_type=image/jpeg, _data=/storage/emulated/0/DCIM/Camera/IMG_0001.jpg\n'

/** A name with a newline in it: the value carries on to the next line. */
export const CONTENT_ROW_MULTILINE = [
  'Row: 0 _id=7, _display_name=two',
  'lines.png, relative_path=Pictures/, _size=10, datetaken=NULL, date_modified=1, width=NULL, height=NULL, mime_type=image/png, _data=/storage/emulated/0/Pictures/two',
  'lines.png',
  '',
].join('\n')

export const CONTENT_EMPTY = 'No result found.\n'

/** A column MediaProvider does not know (the trap: `date_taken`), on stderr. */
export const CONTENT_INVALID_COLUMN_STDERR = [
  'Error while accessing provider:media',
  'java.lang.IllegalArgumentException: Invalid column date_taken',
  '\tat android.database.DatabaseUtils.readExceptionFromParcel(DatabaseUtils.java:172)',
  '\tat android.content.ContentProviderProxy.query(ContentProviderNative.java:483)',
  '',
].join('\n')

/** An argument `content` does not take: the usage, then [ERROR], on stdout. */
export const CONTENT_UNSUPPORTED_EXTRA = [
  'usage: adb shell content [subcommand] [options]',
  '',
  '[ERROR] Unsupported argument: --extra',
  '',
].join('\n')

/* ---------------------------------------------------------------- *
 * Device spec
 * ---------------------------------------------------------------- */

export const SPEC_GETPROP = [
  '[persist.sys.locale]: [en-US]',
  '[ro.build.characteristics]: [nosdcard]',
  '[ro.build.version.codename]: [REL]',
  '[ro.build.version.sdk]: [37]',
  '[ro.product.brand]: [google]',
  '[ro.product.cpu.abi]: [arm64-v8a]',
  '[ro.product.cpu.abilist]: [arm64-v8a]',
  '[ro.product.device]: [tokay]',
  '[ro.product.locale]: [en-US]',
  '[ro.sf.lcd_density]: [420]',
  '[ro.soc.manufacturer]: [Google]',
  '[ro.soc.model]: [Tensor G4]',
].join('\n')

export const AM_GET_CONFIG = [
  'config: mcc452-mnc04-en-rUS,vi-rVN-ldltr-sw411dp-w411dp-h842dp-normal-long-notround-lowdr-nowidecg-port-notnight-420dpi-finger-keysexposed-nokeys-navhidden-nonav-v37',
  'abi: arm64-v8a',
  '',
].join('\n')

export const PM_FEATURES = [
  'feature:reqGlEsVersion=0x30002',
  'feature:android.hardware.bluetooth',
  'feature:android.hardware.camera',
  'feature:android.software.webview',
  '',
].join('\n')

/** `dumpsys SurfaceFlinger` through the grep: the header, its next line, then GLES and its next. */
export const SURFACE_FLINGER_GREP = [
  'SurfaceFlinger global state:',
  'EGL implementation : 1.5 Android META-EGL',
  '--',
  'GLES: ARM, Mali-G715, OpenGL ES 3.2 v1.r46p0',
  'GL_EXT_debug_marker GL_ARM_rgba8 GL_OES_depth24 GL_KHR_texture_compression_astc_ldr',
  '',
].join('\n')

export const MEMINFO = 'MemTotal:       11765412 kB\nMemFree:          301234 kB\n'
