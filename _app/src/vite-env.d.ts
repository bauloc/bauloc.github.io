/// <reference types="vite/client" />

/** Inlined from package.json `version` by `define` in vite.config.ts. */
declare const __APP_VERSION__: string

/** Optional build-time settings; see .env.example. */
interface ImportMetaEnv {
  readonly VITE_TELEGRAM_BOT_TOKEN?: string
  readonly VITE_TELEGRAM_CHAT_ID?: string
}

/**
 * Written by the Device Lab helper into its own copy of /device/ (local mode): where its API
 * is. Never a token. See src/features/device/helper/env.ts.
 */
interface Window {
  DVC_BOOT?: { mode: 'local'; apiBase: string; protocol: number; version: string }
}
