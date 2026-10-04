import type { Device } from '../model'

/*
  A line's level colours it. Three formats arrive, one per source:
  - logcat `-v threadtime`: "MM-DD HH:MM:SS.mmm  PID  TID L Tag: message";
  - an iPhone's syslog (syslog_relay, idevicesyslog): "… process[pid] <Error>: message";
  - a simulator's `log stream --style compact`: "YYYY-MM-DD HH:MM:SS.mmm E  process[pid:tid] …".
*/
const LOGCAT = /^\S+\s+\S+\s+\d+\s+\d+\s+([VDIWEF])\s/
const SYSLOG = / <(Notice|Info|Debug|Warning|Error|Fault|Critical|Alert|Emergency)>: /i
const SIM = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+ (Df|Db|I|E|F|A)\s/

/** Error, fault (the worst: a crash, an assertion), warning, debug (muted), or '' for the rest. */
export type LogLevel = 'E' | 'F' | 'W' | 'D' | ''

const LOGCAT_LEVEL: Readonly<Record<string, LogLevel>> = { E: 'E', F: 'F', W: 'W', D: 'D', V: 'D' }
const SYSLOG_LEVEL: Readonly<Record<string, LogLevel>> = {
  error: 'E',
  fault: 'F',
  critical: 'F',
  alert: 'F',
  emergency: 'F',
  warning: 'W',
  info: 'D',
  debug: 'D',
}
// Unified logging has no warning level: Df (default) and A (activity) read as plain lines.
const SIM_LEVEL: Readonly<Record<string, LogLevel>> = { E: 'E', F: 'F', Db: 'D', I: 'D' }

/** A log line's level, whichever source it came from. */
export function logLevel(line: string): LogLevel {
  const logcat = LOGCAT.exec(line)?.[1]
  if (logcat) return LOGCAT_LEVEL[logcat] ?? ''
  const sim = SIM.exec(line)?.[1]
  if (sim) return SIM_LEVEL[sim] ?? ''
  const syslog = SYSLOG.exec(line)?.[1]
  if (syslog) return SYSLOG_LEVEL[syslog.toLowerCase()] ?? ''
  return ''
}

/** What the log is called, by where it comes from: an Android phone, a simulator, an iPhone. */
export function logSourceName(device: Pick<Device, 'platform' | 'connection'>): string {
  if (device.platform === 'android') return 'logcat'
  return device.connection === 'simulator' ? 'simulator log' : 'syslog'
}
