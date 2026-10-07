import { Upload } from 'lucide-react'
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'

import { cn } from '@/lib/cn'

/**
 * Where a file is dropped, or chosen with the picker it opens. A button, so it takes focus and
 * opens the picker from the keyboard like any other control; the file input itself stays hidden.
 * One file at a time: the first of several dropped is taken.
 */
export function DropZone({
  accept,
  onFile,
  label,
  hint,
  icon,
  disabled = false,
  className,
}: {
  /** The picker's filter, as the input's `accept` (`.apk,.ipa`). A drop is not filtered: the caller checks. */
  accept: string
  onFile: (file: File) => void
  label: ReactNode
  hint?: ReactNode
  icon?: ReactNode
  disabled?: boolean
  className?: string
}) {
  const input = useRef<HTMLInputElement>(null)
  /** Drag events fire for every child the pointer crosses, so entering and leaving are counted. */
  const depth = useRef(0)
  const [dragging, setDragging] = useState(false)

  const take = (files: FileList | null) => {
    const file = files?.[0]
    if (file && !disabled) onFile(file)
  }

  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files')

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        data-dragging={dragging || undefined}
        onClick={() => input.current?.click()}
        onDragEnter={(event) => {
          if (!hasFiles(event) || disabled) return
          event.preventDefault()
          depth.current++
          setDragging(true)
        }}
        onDragOver={(event) => {
          if (!hasFiles(event) || disabled) return
          // Without this the browser opens the dropped file instead of handing it over.
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }}
        onDragLeave={() => {
          depth.current = Math.max(0, depth.current - 1)
          if (depth.current === 0) setDragging(false)
        }}
        onDrop={(event) => {
          if (!hasFiles(event)) return
          event.preventDefault()
          depth.current = 0
          setDragging(false)
          take(event.dataTransfer.files)
        }}
        className={cn(
          'border-border hover:border-primary/50 hover:bg-muted/40 focus-visible:ring-ring/50 flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors outline-none focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50',
          'data-[dragging]:border-primary data-[dragging]:bg-primary/5',
          className,
        )}
      >
        <span className="bg-primary/10 text-primary grid size-10 place-items-center rounded-full [&_svg]:size-5">
          {icon ?? <Upload />}
        </span>
        <span className="text-sm font-medium">{label}</span>
        {hint !== undefined && <span className="text-muted-foreground text-xs">{hint}</span>}
      </button>
      <input
        ref={input}
        type="file"
        accept={accept}
        hidden
        tabIndex={-1}
        onChange={(event) => {
          take(event.currentTarget.files)
          // Cleared, so choosing the same file again (after fixing it) still counts as a change.
          event.currentTarget.value = ''
        }}
      />
    </>
  )
}

/**
 * For as long as a sheet that takes files is open: a file let go anywhere but on its DropZone —
 * the title field, the preview, the dimmed page behind — must not make the browser open it, which
 * leaves the console (or opens a tab over it) and loses what was typed. With `onStray`, such a file
 * is taken as if dropped on the zone (the caller decides whether it can take one now); without it,
 * the drop is simply refused. A drop the zone took itself arrives here already handled.
 */
export function useFileDropGuard(onStray?: (file: File) => void) {
  const latest = useRef(onStray)
  useEffect(() => {
    latest.current = onStray
  })

  useEffect(() => {
    const hasFiles = (event: globalThis.DragEvent) =>
      event.dataTransfer?.types.includes('Files') ?? false
    const over = (event: globalThis.DragEvent) => {
      if (!hasFiles(event) || event.defaultPrevented) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = latest.current ? 'copy' : 'none'
    }
    const drop = (event: globalThis.DragEvent) => {
      if (!hasFiles(event) || event.defaultPrevented) return
      event.preventDefault()
      const file = event.dataTransfer?.files[0]
      if (file) latest.current?.(file)
    }
    window.addEventListener('dragenter', over)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', over)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [])
}
