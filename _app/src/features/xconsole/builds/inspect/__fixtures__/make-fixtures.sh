#!/bin/bash
# Dev script, not run in CI: rebuilds the fixtures beside it with the Mac's own tools (plutil,
# and Xcode's pngcrush and actool) and Node. The tests only read the files, so they run
# anywhere; this script needs macOS with Xcode.
#
#   ./make-fixtures.sh
#
# values.xml.plist, values.binary.plist
#     Every kind of value a property list holds, written below by hand and then by Apple's own
#     writers: `plutil -convert xml1` and `plutil -convert binary1`. Strings in ASCII, UTF-16
#     (Vietnamese, an emoji) and with entities; integers of every width, 2^64 - 1 among them
#     (a 16-byte integer in the binary form); reals, dates before and after 2001, data, nested
#     and empty containers, more than 15 of everything (a count after the marker), and the keys
#     "__proto__" and "constructor".
# info.xml.plist, info.binary.plist
#     An app's Info.plist as Xcode writes one for a device build, its icon entries as actool
#     writes them (see appicon*.png).
# icon.png
#     120×120 RGBA drawn by the Node script below: a gradient through every channel, in rings
#     of alpha 255, 230, 200, 160 and 128 with transparent corners. Alphas of 128 and up keep
#     every channel within ±1 through premultiplying and back.
# icon-cgbi.png, icon-cgbi-average.png
#     icon.png through `xcrun -sdk iphoneos pngcrush -iphone`: an Apple "CgBI" PNG (raw DEFLATE,
#     BGRA, premultiplied alpha). `-f 5` filters each row its own way (None, Sub, Up and Paeth
#     all appear), `-f 3` every row with Average. pngcrush splits the 120 rows into two IDAT
#     chunks behind an iDOT chunk.
# appicon.png, appicon-cgbi.png
#     AppIcon60x60@2x.png as actool writes it from a 1024×1024 icon (a two-colour disc with a
#     soft edge, drawn below), without and with --compress-pngs, which Xcode passes when
#     "Compress PNG Files" is on, as it is by default for iOS. The CgBI one carries gAMA, sRGB,
#     cHRM, eXIf and iDOT chunks; the plain one has the same pixels un-premultiplied by Apple:
#     the reference for rounding.
# adhoc.mobileprovision
#     SYNTHETIC, never a real profile (those hold device UDIDs and certificates): the XML plist
#     below between the opening bytes of the CMS envelope a real one is signed in and junk that
#     is not UTF-8. Ad Hoc: three made-up devices, get-task-allow false.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cat > "$work/values.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>ascii</key><string>plain</string>
  <key>long ascii</key><string>A string longer than fifteen characters</string>
  <key>entities</key><string>Tom &amp; Jerry &lt;3 "quoted" 'apos'</string>
  <key>unicode</key><string>Tiếng Việt — 日本語 😀</string>
  <key>empty string</key><string></string>
  <key>zero</key><integer>0</integer>
  <key>byte</key><integer>255</integer>
  <key>short</key><integer>65535</integer>
  <key>int</key><integer>4294967295</integer>
  <key>long</key><integer>4294967296</integer>
  <key>minus one</key><integer>-1</integer>
  <key>max safe</key><integer>9007199254740991</integer>
  <key>beyond safe</key><integer>9007199254740993</integer>
  <key>below safe</key><integer>-9007199254740993</integer>
  <key>int64 max</key><integer>9223372036854775807</integer>
  <key>uint64 max</key><integer>18446744073709551615</integer>
  <key>half</key><real>0.5</real>
  <key>negative real</key><real>-2.25</real>
  <key>huge real</key><real>1e+300</real>
  <key>yes</key><true/>
  <key>no</key><false/>
  <key>date</key><date>2026-10-07T08:15:00Z</date>
  <key>old date</key><date>1999-12-31T23:59:59Z</date>
  <key>data</key><data>AAEC/w==</data>
  <key>empty data</key><data></data>
  <key>empty array</key><array/>
  <key>empty dict</key><dict/>
  <key>sixteen</key>
  <array>
    <integer>1</integer><integer>2</integer><integer>3</integer><integer>4</integer>
    <integer>5</integer><integer>6</integer><integer>7</integer><integer>8</integer>
    <integer>9</integer><integer>10</integer><integer>11</integer><integer>12</integer>
    <integer>13</integer><integer>14</integer><integer>15</integer><integer>16</integer>
  </array>
  <key>nested</key>
  <array>
    <dict>
      <key>name</key><string>plain</string>
      <key>list</key><array><string>plain</string><true/></array>
    </dict>
  </array>
  <key>__proto__</key><string>an own key</string>
  <key>constructor</key><integer>7</integer>
</dict>
</plist>
EOF

cat > "$work/info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>BuildMachineOSBuild</key><string>26A434</string>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>Thử Nghiệm</string>
  <key>CFBundleExecutable</key><string>Probe</string>
  <key>CFBundleIcons</key>
  <dict>
    <key>CFBundlePrimaryIcon</key>
    <dict>
      <key>CFBundleIconFiles</key><array><string>AppIcon60x60</string></array>
      <key>CFBundleIconName</key><string>AppIcon</string>
    </dict>
  </dict>
  <key>CFBundleIcons~ipad</key>
  <dict>
    <key>CFBundlePrimaryIcon</key>
    <dict>
      <key>CFBundleIconFiles</key><array><string>AppIcon60x60</string><string>AppIcon76x76</string></array>
      <key>CFBundleIconName</key><string>AppIcon</string>
    </dict>
  </dict>
  <key>CFBundleIdentifier</key><string>com.bauloc.probe</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Probe</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.2.0</string>
  <key>CFBundleSupportedPlatforms</key><array><string>iPhoneOS</string></array>
  <key>CFBundleVersion</key><string>45</string>
  <key>DTPlatformName</key><string>iphoneos</string>
  <key>DTPlatformVersion</key><string>26.0</string>
  <key>LSRequiresIPhoneOS</key><true/>
  <key>MinimumOSVersion</key><string>15.0</string>
  <key>UIDeviceFamily</key><array><integer>1</integer><integer>2</integer></array>
  <key>UILaunchScreen</key><dict/>
  <key>UIRequiredDeviceCapabilities</key><array><string>arm64</string></array>
  <key>UISupportedInterfaceOrientations</key>
  <array><string>UIInterfaceOrientationPortrait</string></array>
</dict>
</plist>
EOF

# Made up from end to end: the team id, the UUID and every device are zeros and counters.
cat > "$work/profile.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>AppIDName</key><string>Probe</string>
  <key>ApplicationIdentifierPrefix</key><array><string>ABCDE12345</string></array>
  <key>CreationDate</key><date>2026-09-01T10:00:00Z</date>
  <key>Platform</key><array><string>iOS</string></array>
  <key>IsXcodeManaged</key><false/>
  <key>DeveloperCertificates</key><array><data>U1lOVEhFVElDLCBOT1QgQSBDRVJUSUZJQ0FURQ==</data></array>
  <key>Entitlements</key>
  <dict>
    <key>application-identifier</key><string>ABCDE12345.com.bauloc.probe</string>
    <key>keychain-access-groups</key><array><string>ABCDE12345.*</string></array>
    <key>get-task-allow</key><false/>
    <key>com.apple.developer.team-identifier</key><string>ABCDE12345</string>
  </dict>
  <key>ExpirationDate</key><date>2027-09-01T10:00:00Z</date>
  <key>Name</key><string>Probe Ad Hoc</string>
  <key>ProvisionedDevices</key>
  <array>
    <string>00000000-0000000000000001</string>
    <string>00000000-0000000000000002</string>
    <string>0000000000000000000000000000000000000003</string>
  </array>
  <key>TeamIdentifier</key><array><string>ABCDE12345</string></array>
  <key>TeamName</key><string>Probe Team &amp; Co.</string>
  <key>TimeToLive</key><integer>365</integer>
  <key>UUID</key><string>00000000-0000-4000-8000-000000000000</string>
  <key>Version</key><integer>1</integer>
</dict>
</plist>
EOF

for name in values info profile; do plutil -lint "$work/$name.plist" >/dev/null; done
for name in values info; do
  plutil -convert xml1 -o "$here/$name.xml.plist" "$work/$name.plist"
  plutil -convert binary1 -o "$here/$name.binary.plist" "$work/$name.plist"
done
plutil -convert xml1 "$work/profile.plist"

# The images, and the profile's envelope. PNGs are written with zlib and a CRC by hand, Sub
# filtering every row, so the gradients compress to almost nothing.
HERE="$here" WORK="$work" node --input-type=module - <<'EOF'
import { readFileSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const { HERE, WORK } = process.env
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(bytes) {
  let c = 0xffffffff
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
function png(path, size, pixel) {
  const stride = size * 4
  const raw = Buffer.alloc(size * (1 + stride))
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(stride)
    for (let x = 0; x < size; x++) row.set(pixel(x, y), x * 4)
    const at = y * (1 + stride)
    raw[at] = 1
    for (let i = 0; i < stride; i++) raw[at + 1 + i] = (row[i] - (i >= 4 ? row[i - 4] : 0)) & 0xff
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const idat = deflateSync(raw, { level: 9 })
  const parts = [signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]
  writeFileSync(path, Buffer.concat(parts))
}

const RINGS = [[56, 0], [48, 128], [40, 160], [32, 200], [24, 230]]
png(`${HERE}/icon.png`, 120, (x, y) => {
  const d = Math.hypot(x - 59.5, y - 59.5)
  const alpha = RINGS.find(([r]) => d > r)?.[1] ?? 255
  return [Math.round((x * 255) / 119), Math.round((y * 255) / 119), Math.round(((x + y) * 255) / 238), alpha]
})

png(`${WORK}/appicon-1024.png`, 1024, (x, y) => {
  const d = Math.hypot(x - 511.5, y - 511.5)
  const alpha = d < 400 ? 255 : d < 440 ? Math.round((255 * (440 - d)) / 40) : 0
  return y < 512 ? [79, 70, 229, alpha] : [5, 150, 105, alpha]
})

// Not a real CMS structure: a SignedData's opening bytes (its OID, 1.2.840.113549.1.7.2), then
// junk from a fixed generator, bytes of 0x80 and up included, so the reader has to search bytes.
let seed = 0x2545f491
const junk = (n) =>
  Buffer.from(
    Array.from({ length: n }, () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 16) & 0xff),
  )
const envelope = Buffer.from([
  0x30, 0x82, 0x1f, 0x3c, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02, 0xa0,
])
const plist = readFileSync(`${WORK}/profile.plist`)
writeFileSync(`${HERE}/adhoc.mobileprovision`, Buffer.concat([envelope, junk(48), plist, junk(96)]))
EOF

pngcrush() { xcrun -sdk iphoneos pngcrush -q -iphone "$@" >/dev/null; }
pngcrush -f 5 "$here/icon.png" "$here/icon-cgbi.png"
pngcrush -f 3 "$here/icon.png" "$here/icon-cgbi-average.png"

catalog="$work/Assets.xcassets"
mkdir -p "$catalog/AppIcon.appiconset" "$work/plain" "$work/cgbi"
cp "$work/appicon-1024.png" "$catalog/AppIcon.appiconset/icon-1024.png"
printf '{ "info" : { "author" : "xcode", "version" : 1 } }\n' > "$catalog/Contents.json"
cat > "$catalog/AppIcon.appiconset/Contents.json" <<'EOF'
{
  "images" : [
    { "filename" : "icon-1024.png", "idiom" : "universal", "platform" : "ios", "size" : "1024x1024" }
  ],
  "info" : { "author" : "xcode", "version" : 1 }
}
EOF
actool() {
  xcrun actool --compile "$1" --platform iphoneos --minimum-deployment-target 15.0 \
    --target-device iphone --app-icon AppIcon --output-partial-info-plist "$1/partial.plist" \
    "${@:2}" "$catalog" >/dev/null
}
actool "$work/plain"
actool "$work/cgbi" --compress-pngs
cp "$work/plain/AppIcon60x60@2x.png" "$here/appicon.png"
cp "$work/cgbi/AppIcon60x60@2x.png" "$here/appicon-cgbi.png"
echo "Rebuilt the fixtures in $here"
