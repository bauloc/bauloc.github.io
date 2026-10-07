import { ICON_FILE, binaryUrl, buildFileUrl } from '../paths'
import type { BuildEntry } from '../types'

/*
  The iOS over-the-air manifest at build/<id>/manifest.plist: what the Install button's
  itms-services:// link points iOS at. iOS reads it, shows "<site> would like to install <title>",
  then downloads the software-package URL and installs it. Laid out as Xcode's own export
  ("Include manifest for over-the-air installation") writes one.

  Every URL is absolute on the live site, whatever origin the console runs on: iOS fetches the
  manifest and the IPA itself, over https with a trusted certificate, or not at all. An IPA of
  100 MiB or more is a GitHub Release's asset, and the software-package URL is its address on
  github.com, also https; iOS follows GitHub's redirect to the file.
*/

/** Text for an XML string or attribute: all five predefined entities, so nothing can close a tag. */
function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** One file iOS downloads: the IPA itself, or the icon it shows while it does. */
function asset(kind: string, url: string): string {
  return `				<dict>
					<key>kind</key>
					<string>${xml(kind)}</string>
					<key>url</key>
					<string>${xml(url)}</string>
				</dict>`
}

/** The iOS OTA manifest at build/<id>/manifest.plist. */
export function manifestPlist(entry: BuildEntry): string {
  // The id, the file name and a release's tag go into the URLs percent-encoded (binaryUrl does
  // it for the binary). All are validated long before a manifest is written, and encoding
  // leaves valid ones as they are, but a hand-edited index must not be able to point iOS at a
  // different path.
  const id = encodeURIComponent(entry.id)
  // The icon is what iOS draws on the Home Screen while the app downloads. There is only one
  // icon file a build can have, so its name comes from paths.ts rather than from the entry.
  const icon = buildFileUrl(id, ICON_FILE)
  const assets = [
    asset('software-package', binaryUrl(entry)),
    ...(entry.icon ? [asset('display-image', icon), asset('full-size-image', icon)] : []),
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>items</key>
	<array>
		<dict>
			<key>assets</key>
			<array>
${assets.join('\n')}
			</array>
			<key>metadata</key>
			<dict>
				<key>bundle-identifier</key>
				<string>${xml(entry.bundle_id)}</string>
				<key>bundle-version</key>
				<string>${xml(entry.version)}</string>
				<key>kind</key>
				<string>software</string>
				<key>platform-identifier</key>
				<string>com.apple.platform.iphoneos</string>
				<key>title</key>
				<string>${xml(entry.name)}</string>
			</dict>
		</dict>
	</array>
</dict>
</plist>
`
}
