import type { ReactNode } from 'react'

/** A module's title row: what it is on the left, its main action on the right. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description: string
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-muted-foreground mt-1">{description}</p>
      </div>
      {actions !== undefined && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

/** A small figure card for the top of a module, after shadcn's dashboard. */
export function StatCard({
  label,
  value,
  hint,
  icon,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  icon: ReactNode
}) {
  return (
    <div className="bg-card text-card-foreground rounded-xl border p-4 shadow-xs sm:p-5">
      <div className="text-muted-foreground flex items-center justify-between text-sm font-medium">
        {label}
        <span className="[&_svg]:size-4">{icon}</span>
      </div>
      <div className="mt-1 text-xl font-semibold tracking-tight tabular-nums sm:mt-2 sm:text-2xl">
        {value}
      </div>
      {hint !== undefined && <p className="text-muted-foreground mt-1 text-xs">{hint}</p>}
    </div>
  )
}
