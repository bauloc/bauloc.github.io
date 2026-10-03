import avatar from '../assets/avatar.jpg'
import { ElevatedButton } from './elevated-button'

/** The teal column with the portrait and the name. Only at `wide`, as in the Flutter build. */
export function SidePanel() {
  return (
    <aside className="bg-profile-teal wide:flex sticky top-0 hidden h-dvh w-[279px] shrink-0 flex-col items-center self-start pt-12 pb-12 text-white">
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
      <p className="mt-1.5 text-center">Software Developer</p>
      <p className="mt-[3px] text-center">Electrical &amp; Electronic Engineer</p>
      {/*
        Kept from the Flutter build, where it also does nothing yet (`onPressed: () {}`): it is
        waiting for a CV to download.
      */}
      <ElevatedButton className="mt-auto">DOWNLOAD</ElevatedButton>
    </aside>
  )
}
