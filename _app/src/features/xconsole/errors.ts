import { toast } from 'sonner'

import { AuthError } from './repo/github'

/** A failed GitHub call, as a toast. A refused token offers the way to replace it. */
export function toastFailure(
  title: string,
  error: unknown,
  openSettings: () => void,
  id?: string | number,
) {
  if (error instanceof AuthError) {
    toast.error('GitHub refused the token', {
      id,
      description: 'It may have expired or lost the repo scope.',
      action: { label: 'Update token', onClick: openSettings },
    })
    return
  }
  toast.error(title, { id, description: error instanceof Error ? error.message : 'Unknown error' })
}
