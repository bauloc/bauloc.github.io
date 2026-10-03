import { Link } from '@tanstack/react-router'

import { ContactPrompt } from '../components/contact-prompt'
import { MaterialIcon } from '../components/material-icon'

/*
  Written to bring in work: what Loc does, the proof (FPT Play, Tevi, his own apps), and the
  way to reach him. Every claim is backed by the Resume page, the 2016 CV, or a live store
  listing; nothing here is a number or a promise that has not been checked.
*/

const SERVICES = [
  'Native iOS apps in Swift and Objective-C, including Apple TV (tvOS)',
  'Android apps',
  'Cross-platform apps in Flutter: iOS, Android and the web from one codebase',
  'Video and audio streaming: live TV, video on demand, DRM-protected content and casting',
  'Taking over existing apps: fixing crashes, updating for new OS versions, adding features',
  'Getting to the stores: TestFlight betas, App Store and Google Play submissions, privacy policy and terms pages',
]

const H2 = 'mt-8 text-[18px] font-semibold wide:text-[22px]'

export function AboutMePage() {
  return (
    <div className="wide:p-8 max-w-[760px] p-3 text-[16px] text-black">
      <p className="wide:text-[26px] text-[20px] leading-snug font-medium">
        I build mobile apps, and I see them all the way through to the App Store and Google Play.
      </p>

      <div className="mt-6 space-y-4">
        <p>
          I&apos;m Nguyen Phuoc Loc, a mobile developer based in Ho Chi Minh City, Vietnam, with
          more than ten years of building apps that people use every day. For nearly seven years at
          FPT Telecom I built and developed FPT Play, its TV and video streaming service, for iOS
          and Apple TV. Since 2022 I have been a software developer at Tevi, a platform where
          content creators earn directly from their fans.
        </p>
        <p>
          Alongside that, I publish apps of my own under my own developer account: audio, utility
          and game apps for iOS and Android. Doing every part myself means I know the whole road a
          product travels: the idea, the design, the build, store review, the launch, and the
          updates that come after it.
        </p>
        <p>
          I started out as an electrical and electronic engineer: automatic control at Ho Chi Minh
          City University of Technology, then PLC and embedded programming in industry. That
          background still shows in how I work. I am systematic, careful with details, and focused
          on software that keeps running.
        </p>
      </div>

      <h2 className={H2}>What I can help with</h2>
      <ul className="mt-3 space-y-2">
        {SERVICES.map((service) => (
          <li key={service} className="flex gap-3">
            <MaterialIcon name="check" className="text-profile-teal mt-[-1px] shrink-0" />
            {service}
          </li>
        ))}
      </ul>

      <ContactPrompt>
        <Link
          to="/profile/portfolio"
          className="text-profile-primary text-[16px] font-medium underline-offset-4 hover:underline"
        >
          See my work
        </Link>
      </ContactPrompt>
    </div>
  )
}
