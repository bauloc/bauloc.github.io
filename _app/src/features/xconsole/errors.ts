import { toast } from 'sonner'

import { currentLocale } from '@/lib/locale'

import { XCONSOLE_MESSAGES } from './messages'
import { AuthError } from './repo/github'

/**
 * A failed GitHub call, as a toast. A refused token offers the way to replace it. `title` is
 * the caller's, already in the language on screen; the rest is worded here, at the same moment.
 */
export function toastFailure(
  title: string,
  error: unknown,
  openSettings: () => void,
  id?: string | number,
) {
  const t = XCONSOLE_MESSAGES[currentLocale()]
  if (error instanceof AuthError) {
    toast.error(t.refused, {
      id,
      description: t.refusedDetail,
      action: { label: t.updateToken, onClick: openSettings },
    })
    return
  }
  toast.error(title, { id, description: error instanceof Error ? error.message : t.unknownError })
}
