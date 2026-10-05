import { cn } from '@/lib/cn'
import { useMessages } from '@/lib/i18n'

import { MaterialIcon } from '../components/material-icon'
import { Spinner } from '../components/spinner'
import { RESUME } from '../resume'

/*
  The Flutter build's `timelines_plus` timeline, connected: a 20 px teal dot per entry, centred
  on it, joined by a 3 px teal line that starts at the first dot and ends at the last. Past
  entries carry a check; the last, still running, a small spinner.
*/

function Connector({ hidden }: { hidden: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn('bg-profile-teal w-[3px] flex-1', hidden && 'invisible')}
    />
  )
}

export function ResumePage() {
  const resume = useMessages(RESUME)
  const last = resume.length - 1
  return (
    <ol className="wide:p-12 text-profile-ink p-6">
      {resume.map((entry, index) => (
        <li key={entry.when} className="flex">
          <div className="flex w-5 shrink-0 flex-col items-center">
            <Connector hidden={index === 0} />
            <span className="bg-profile-teal grid size-5 shrink-0 place-items-center rounded-full text-white">
              {index === last ? (
                <Spinner size={10} stroke={1.5} />
              ) : (
                <MaterialIcon name="check" size={10} />
              )}
            </span>
            <Connector hidden={index === last} />
          </div>
          <div className="wide:px-8 wide:py-4 min-w-0 flex-1 p-3">
            <p className="text-[14px]">{entry.when}</p>
            <p className="mt-1.5 text-[16px] font-medium">{entry.what}</p>
            {entry.details && (
              <ul className="mt-1.5 text-[16px]">
                {entry.details.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </div>
        </li>
      ))}
    </ol>
  )
}
