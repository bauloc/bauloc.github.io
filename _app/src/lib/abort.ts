/**
 * `work`, or a rejection with the signal's reason as soon as it aborts: for a read that takes
 * no signal itself, or ignores it (a lane listing an app's APKs, a slow thumbnail), so Cancel
 * answers at once and the work stops holding whatever slot or spinner was waiting on it.
 */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as Error)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(signal.reason as Error)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort)
    })
  })
}
