import { useId, type ReactNode, type SVGProps } from 'react'

/*
  The marks in the profile's row of links, all one shape so the row reads as one set: a 24 px
  disc in the current colour with its glyph cut out of it. GitHub's and Telegram's own marks
  are drawn that way (Simple Icons 13.21, CC0). Zalo's wordmark (Simple Icons too), the
  envelope and the CV's download are cut out of a plain disc to match. Decorative: the link
  around one names it.
*/

/** Marks that are a disc already: the path is the whole mark. */
const DISCS = {
  github:
    'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
  telegram:
    'M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z',
} as const

const ZALO =
  'M12.49 10.2722v-.4496h1.3467v6.3218h-.7704a.576.576 0 01-.5763-.5729l-.0006.0005a3.273 3.273 0 01-1.9372.6321c-1.8138 0-3.2844-1.4697-3.2844-3.2823 0-1.8125 1.4706-3.2822 3.2844-3.2822a3.273 3.273 0 011.9372.6321l.0006.0005zM6.9188 7.7896v.205c0 .3823-.051.6944-.2995 1.0605l-.03.0343c-.0542.0615-.1815.206-.2421.2843L2.024 14.8h4.8948v.7682a.5764.5764 0 01-.5767.5761H0v-.3622c0-.4436.1102-.6414.2495-.8476L4.8582 9.23H.1922V7.7896h6.7266zm8.5513 8.3548a.4805.4805 0 01-.4803-.4798v-7.875h1.4416v8.3548H15.47zM20.6934 9.6C22.52 9.6 24 11.0807 24 12.9044c0 1.8252-1.4801 3.306-3.3066 3.306-1.8264 0-3.3066-1.4808-3.3066-3.306 0-1.8237 1.4802-3.3044 3.3066-3.3044zm-10.1412 5.253c1.0675 0 1.9324-.8645 1.9324-1.9312 0-1.065-.865-1.9295-1.9324-1.9295s-1.9324.8644-1.9324 1.9295c0 1.0667.865 1.9312 1.9324 1.9312zm10.1412-.0033c1.0737 0 1.945-.8707 1.945-1.9453 0-1.073-.8713-1.9436-1.945-1.9436-1.0753 0-1.945.8706-1.945 1.9436 0 1.0746.8697 1.9453 1.945 1.9453z'

/** A line inside a cut-out glyph, left in the disc's colour. */
const LINE = {
  fill: 'none',
  stroke: 'white',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

/** Glyphs cut out of a plain disc, centred on it: black is cut out, white stays the disc. */
const CUTOUTS = {
  // The wordmark at three quarters, 18 px wide.
  zalo: <path d={ZALO} transform="translate(12 12) scale(0.75) translate(-12 -12)" />,
  email: (
    <>
      <rect x="5.5" y="7.5" width="13" height="9" rx="1.5" />
      <path d="m6.75 8.75 5.25 3.75 5.25-3.75" {...LINE} />
    </>
  ),
  // A page with its corner turned, an arrow down on it.
  cv: (
    <>
      <path d="M8.5 5.5h5l3.5 3.5v8a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 7 17V7a1.5 1.5 0 0 1 1.5-1.5Z" />
      <path d="M12 9.75v5m-2.25-2.25L12 14.75l2.25-2.25" {...LINE} />
    </>
  ),
} satisfies Record<string, ReactNode>

export type MarkName = keyof typeof DISCS | keyof typeof CUTOUTS

export function MarkIcon({ name, ...props }: { name: MarkName } & SVGProps<SVGSVGElement>) {
  const mask = useId()
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      {name === 'github' || name === 'telegram' ? (
        <path d={DISCS[name]} />
      ) : (
        <>
          <mask id={mask}>
            <circle cx="12" cy="12" r="12" fill="white" />
            <g fill="black">{CUTOUTS[name]}</g>
          </mask>
          <circle cx="12" cy="12" r="12" mask={`url(#${mask})`} />
        </>
      )}
    </svg>
  )
}
