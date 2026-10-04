/**
 * The sentence an old Node prints instead of starting, or null when this Node is new enough.
 * An unparsable version passes: refusing a Node we cannot read would be worse than trying.
 */
export function nodeTooOld(version: string): string | null {
  const major = Number(/^v?(\d+)\./.exec(version)?.[1])
  if (!Number.isFinite(major) || major >= 18) return null
  return (
    `Device Lab helper needs Node 18 or newer (this is ${version}). ` +
    'Install the current LTS from https://nodejs.org, then run the same command again.'
  )
}

/**
 * The first code in the built file. Its imports are hoisted above it, but they are all
 * node: built-ins that Node 16 also has, and the syntax stays at Node 18 level, so an old
 * Node reaches this sentence instead of dying on a SyntaxError.
 */
const tooOld = nodeTooOld(process.version)
if (tooOld) {
  process.stderr.write(tooOld + '\n')
  process.exit(1)
}
