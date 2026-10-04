#!/bin/bash
# Dev script, not run in CI: rebuilds the badge*.apk fixtures with aapt2. They are unsigned
# (a parser never checks a signature) and hold no code (android:hasCode="false").
#
#   AAPT2=~/Library/Android/sdk/build-tools/36.0.0/aapt2 \
#   ANDROID_JAR=~/Library/Android/sdk/platforms/android-36/android.jar ./make-badges.sh
#
# badge.apk + badge-config.vi.apk + badge-config.xxhdpi.apk
#     A label in five languages (one split out to config.vi, one three-letter: fil, one with a
#     region: en-GB) and a drawable icon in three densities (xxhdpi split out). Test-only and
#     debuggable, version 1.4.0 (812).
# badge-adaptive.apk
#     An adaptive icon (bitmap foreground on a colour), and a label that points at another string.
# badge-vector.apk
#     An adaptive icon with a vector foreground, which Device Lab does not draw, and a literal label.
#
# The other fixtures: probe-unsigned.apks and probe.aab are the bundle-install research's probe
# app (com.bauloc.bundleprobe, bundletool 1.18.3); *.toc.pb and picks.json come from
# make-picks.mjs; zip64-*.zip from `zip -fz` (Info-ZIP 3.0) and Python's zipfile force_zip64.
set -euo pipefail
: "${AAPT2:?Set AAPT2 to an aapt2 binary}" "${ANDROID_JAR:?Set ANDROID_JAR to a platform android.jar}"
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"

python3 - <<'EOF'
import os, struct, zlib
def png(path, w, h, rgba):
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    raw = b''.join(b'\x00' + b''.join(bytes(rgba(x, y)) for x in range(w)) for y in range(h))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
                + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))
solid = lambda c: (lambda x, y: c)
png('split/res/drawable-mdpi/ic_launcher.png', 48, 48, solid((200, 30, 30, 255)))
png('split/res/drawable-xhdpi/ic_launcher.png', 96, 96, solid((30, 200, 30, 255)))
png('split/res/drawable-xxhdpi/ic_launcher.png', 144, 144, solid((30, 30, 200, 255)))
dot = lambda x, y: (255, 255, 255, 255) if (x - 81) ** 2 + (y - 81) ** 2 < 40 ** 2 else (0, 0, 0, 0)
png('adaptive/res/mipmap-xxhdpi/ic_fg.png', 162, 162, dot)
EOF

strings() { mkdir -p "$1/res/values$2"; printf '<resources>\n  <string name="app_name">%s</string>\n</resources>\n' "$3" > "$1/res/values$2/strings.xml"; }
strings split '' 'Badge Probe'
strings split -vi 'Huy hiệu'
strings split -fr 'Insigne'
strings split -iw 'תג בדיקה'
strings split -en-rGB 'Badge Probe UK'
strings split -b+fil 'Tsapa'
cat > split/AndroidManifest.xml <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.bauloc.badgeprobe"
    android:versionCode="812" android:versionName="1.4.0">
  <uses-sdk android:minSdkVersion="26" android:targetSdkVersion="35" />
  <application android:hasCode="false" android:label="@string/app_name" android:icon="@drawable/ic_launcher"
      android:testOnly="true" android:debuggable="true" />
</manifest>
EOF

mkdir -p adaptive/res/values adaptive/res/mipmap-anydpi-v26
cat > adaptive/res/values/values.xml <<'EOF'
<resources>
  <string name="app_name">Adaptive Probe</string>
  <item type="string" name="alias">@string/app_name</item>
  <color name="ic_bg">#FF447AEE</color>
</resources>
EOF
cat > adaptive/res/mipmap-anydpi-v26/ic_launcher.xml <<'EOF'
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="@color/ic_bg" />
  <foreground android:drawable="@mipmap/ic_fg" />
</adaptive-icon>
EOF
cat > adaptive/AndroidManifest.xml <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.bauloc.badgeadaptive"
    android:versionCode="7" android:versionName="2.0">
  <uses-sdk android:minSdkVersion="26" android:targetSdkVersion="34" />
  <application android:hasCode="false" android:label="@string/alias" android:icon="@mipmap/ic_launcher" />
</manifest>
EOF

mkdir -p vector/res/values vector/res/drawable vector/res/mipmap-anydpi-v26
printf '<resources>\n  <color name="bg">#FF101010</color>\n</resources>\n' > vector/res/values/colors.xml
cat > vector/res/drawable/ic_fg.xml <<'EOF'
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp"
    android:viewportWidth="108" android:viewportHeight="108">
  <path android:fillColor="#FFFFFFFF" android:pathData="M54,30 L78,78 L30,78 Z" />
</vector>
EOF
cat > vector/res/mipmap-anydpi-v26/ic_launcher.xml <<'EOF'
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="@color/bg" />
  <foreground android:drawable="@drawable/ic_fg" />
</adaptive-icon>
EOF
cat > vector/AndroidManifest.xml <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.bauloc.badgevector"
    android:versionCode="1" android:versionName="1.0">
  <uses-sdk android:minSdkVersion="26" android:targetSdkVersion="35" />
  <application android:hasCode="false" android:label="Vector Probe" android:icon="@mipmap/ic_launcher" />
</manifest>
EOF

for app in split adaptive vector; do
  mkdir -p "$app/compiled"
  "$AAPT2" compile --dir "$app/res" -o "$app/compiled/"
done
# --split moves resources of a configuration into a split APK, as Play's config splits hold them.
# Mipmaps never move (launchers need every density), so the split app's icon is a drawable.
"$AAPT2" link -o "$here/badge.apk" --manifest split/AndroidManifest.xml -I "$ANDROID_JAR" split/compiled/*.flat \
  --split "$here/badge-config.vi.apk:vi" --split "$here/badge-config.xxhdpi.apk:xxhdpi"
"$AAPT2" link -o "$here/badge-adaptive.apk" --manifest adaptive/AndroidManifest.xml -I "$ANDROID_JAR" adaptive/compiled/*.flat
"$AAPT2" link -o "$here/badge-vector.apk" --manifest vector/AndroidManifest.xml -I "$ANDROID_JAR" vector/compiled/*.flat
echo "Rebuilt badge*.apk in $here"
