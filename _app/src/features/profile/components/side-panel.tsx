import { cn } from '@/lib/cn'
import { useMessages } from '@/lib/i18n'
import { useLocale } from '@/lib/locale'

import avatar from '../assets/avatar.jpg'
import { CV_FILE_NAME, CV_PDF } from '../cv'
import { PROFILE_MESSAGES } from '../messages'
import { ELEVATED_BUTTON } from './elevated-button'

/**
 * The teal column with the portrait and the name. Only at `wide`, as in the Flutter build.
 * DOWNLOAD hands over the CV in the language on screen.
 */
export function SidePanel() {
  const t = useMessages(PROFILE_MESSAGES)
  const locale = useLocale()
  return (
    <aside className="bg-profile-panel wide:flex sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-[279px] shrink-0 flex-col items-center self-start pt-12 pb-12 text-white">
      <div className="size-[180px] shrink-0 rounded-full bg-white p-1">
        <img
          src={avatar}
          alt="Nguyen Phuoc Loc"
          width={172}
          height={172}
          className="size-full rounded-full object-cover"
        />
      </div>
      <p className="mt-6 text-center text-[20px] font-black">NGUYEN PHUOC LOC</p>
      <p className="mt-1.5 text-center">{t.role}</p>
      <p className="mt-[3px] text-center">{t.engineer}</p>
      {/* The Flutter build's button did nothing (`onPressed: () {}`); it downloads the CV now. */}
      <a
        href={CV_PDF[locale]}
        download={CV_FILE_NAME[locale]}
        className={cn(ELEVATED_BUTTON, 'mt-auto')}
      >
        {t.download}
      </a>
    </aside>
  )
}
