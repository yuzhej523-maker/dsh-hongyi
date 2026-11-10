/**
 * Path resolution for 鸿驿 (dsh-hongyi).
 *
 * Every file this plugin writes lives under $DSH_HOME/hongyi/ (default
 * ~/.dsh/hongyi/). Nothing is ever written into the DSH profile directory,
 * the WorkBuddy installation, or WorkBuddy's own credential stores.
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'

/** DSH home: $DSH_HOME when set (the desktop app sets it), else ~/.dsh. */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME?.trim()
  if (fromEnv) return path.resolve(fromEnv)
  return path.join(os.homedir(), '.dsh')
}

/** Root of everything 鸿驿 owns. */
export function hongyiHome() {
  return path.join(dshHome(), 'hongyi')
}

export const paths = {
  home: hongyiHome,
  config: () => path.join(hongyiHome(), 'config.json'),
  credentials: () => path.join(hongyiHome(), 'credentials.json'),
  queueDir: () => path.join(hongyiHome(), 'queue'),
  queueFile: () => path.join(hongyiHome(), 'queue', 'outbound.json'),
  pendingModelFile: () => path.join(hongyiHome(), 'queue', 'needs-model.json'),
  inboxFile: () => path.join(hongyiHome(), 'inbox.json'),
  echoFile: () => path.join(hongyiHome(), 'echo.json'),
  journalFile: () => path.join(hongyiHome(), 'journal.ndjson'),
  inboundLedger: () => path.join(hongyiHome(), 'inbound.json'),
  inboxDir: () => path.join(hongyiHome(), 'inbox'),
  sentinelFile: () => path.join(hongyiHome(), 'sentinel.json'),
}

/** Create the plugin's own directories. Idempotent. */
export async function ensureHome() {
  await fs.mkdir(hongyiHome(), { recursive: true })
  await fs.mkdir(paths.queueDir(), { recursive: true })
  await fs.mkdir(paths.inboxDir(), { recursive: true })
  return hongyiHome()
}
