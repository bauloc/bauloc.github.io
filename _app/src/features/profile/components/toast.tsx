import { useEffect, useState } from 'react'

/** Long enough for toastify's 3 s on screen plus its 0.4 s fade (`--animate-toast`). */
const LIFETIME_MS = 3400

export interface ToastMessage {
  readonly text: string
  /** A new id restarts the toast, even for the same text twice in a row. */
  readonly id: number
}

/** Hand out toasts: `show(text)` replaces whatever is up. */
export function useToast() {
  const [toast, setToast] = useState<ToastMessage | null>(null)

  useEffect(() => {
    if (toast === null) return
    const timer = window.setTimeout(() => {
      setToast(null)
    }, LIFETIME_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [toast])

  const show = (text: string) => {
    setToast((previous) => ({ text, id: (previous?.id ?? 0) + 1 }))
  }
  return { toast, show }
}

/**
 * The toast fluttertoast puts up on the web — toastify, bottom right, in its green gradient.
 *
 * The live region is always mounted, empty between toasts: a region inserted together with
 * its text is often not announced.
 */
export function Toast({ toast }: { toast: ToastMessage | null }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed right-[15px] bottom-[15px] z-50 flex max-w-[calc(50%-20px)] justify-end max-[360px]:inset-x-0 max-[360px]:mx-auto max-[360px]:max-w-fit"
    >
      {toast !== null && (
        <p
          key={toast.id}
          className="animate-toast from-profile-toast-from to-profile-toast-to shadow-profile-toast rounded-[2px] bg-linear-to-r px-5 py-3 text-white"
        >
          {toast.text}
        </p>
      )}
    </div>
  )
}
