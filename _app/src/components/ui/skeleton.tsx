import { cn } from "@/lib/cn"

/*
  shadcn's skeleton pulsed the opacity of a very light `bg-accent`, which read as a static
  grey block. Here a soft band sweeps across a slightly stronger base instead: the band is
  the ::after, moved by `transform` alone so the compositor runs it however many skeletons
  are on screen, and clipped to the skeleton's own radius by `overflow-hidden`. With reduced
  motion the band is gone and the skeleton pulses its opacity, which globals.css lets
  through its reduced-motion rule. Colours and keyframes: theme.css and globals.css.
*/
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "relative overflow-hidden rounded-md bg-skeleton",
        "after:absolute after:inset-0 after:bg-linear-to-r after:from-transparent after:from-20% after:via-skeleton-highlight after:via-50% after:to-transparent after:to-80% after:animate-skeleton-sweep",
        "motion-reduce:animate-skeleton-pulse motion-reduce:after:hidden",
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
