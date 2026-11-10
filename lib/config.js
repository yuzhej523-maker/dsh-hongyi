/**
 * Settings persistence for 鸿驿.
 *
 * Where secrets live: the token and the device secret are kept in
 * $DSH_HOME/hongyi/credentials.json (mode 0600 on POSIX), NOT in the profile's
 * cordis.patch.yml and NOT in config.json. That keeps them revocable — deleting
 * the file (or pressing 撤销凭据 in the card) removes them without touching the
 * loader's composition, and they never show up in a config dump.
 *
 * WorkBuddy's own login material is never read or copied.
 */
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { paths, ensureHome } from './paths.js'
import { readJson, writeJson } from './store.js'
import { MAILBOX_DRIVERS } from './mailbox/client.js'

export const DEFAULT_CONFIG = {
  version: 1,
  enabled: true,
  driver: 'mock',
  /** HTTP mailbox base URL (mock / future HTTP transports). */
  baseUrl: 'http://127.0.0.1:7654',
  /**
   * Cloud folder root for the `folder` / `tdrive` transports: an already-synced
   * directory (OneDrive, 坚果云, Tencent Drive local sync, WebDAV mount). The
   * plugin only writes files here; the vendor client does the syncing, which is
   * why 鸿驿 never has to run a server of its own.
   */
  folderRoot: '',
  /**
   * IMAP 通道（driver='imap'）：邮箱地址存在 config 里（非密），授权码存
   * credentials.json（imapAuth，属于密钥）；provider 决定 host 预设（qq/163/gmail/outlook）。
   */
  imapUser: '',
  imapProvider: 'qq',
  /**
   * 静默通道（imap 专用）：信封不写信箱收件箱，而是 APPEND 进 Drafts（草稿箱）。
   * 草稿不触发新邮件提醒，手机邮箱不会弹窗，但机器用 IMAP 照样读得到。
   * 实测（2026-11-10）：QQ IMAP 允许对 Drafts 做 APPEND/UID SEARCH ALL/FETCH/EXPUNGE，
   * 但**不允许** CREATE 自定义文件夹（NO [CANNOT] Invalid folder name），Drafts 里
   * SUBJECT 检索也不可靠 → 只能按 UID 区间枚举。
   */
  imapQuiet: true,
  /** 静默通道读写的文件夹名（空 = 用各服务商默认草稿箱名）。 */
  imapQuietFolder: '',
  box: 'dsh-hongyi',
  wecomWebhook: '',
  deviceId: 'dsh-pc',
  phoneId: 'phone',
  telemetry: {
    /** Only report when the observed state actually changed. */
    onChangeOnly: true,
    /** Never send a state change more often than this, in seconds. */
    minGapSec: 10,
    /** Unchanged-state heartbeat summary interval, in seconds (10 min). */
    summaryIntervalSec: 600,
    /** Heartbeat cadence while running, in seconds. */
    heartbeatSec: 30,
    /** A heartbeat older than this makes the phone show 离线. */
    offlineAfterSec: 180,
  },
  relay: {
    /** How often the relay tick runs, in milliseconds. */
    intervalMs: 15000,
  },
  /**
   * 任务监测（手机看「电脑上跑到哪了」）。
   * 数据源优先本机 `/bgjobs/state`；bgjobs 不在时才扫 workdirs 下的
   * `.dsh/bgjobs/*\/job.json`。workdirs 为空时只扫 DSH 的当前工作目录。
   */
  tasks: {
    /** 磁盘兜底要扫的工作目录（绝对路径）。 */
    workdirs: [],
    /** 运行中的任务多久没写日志就算「疑似卡住」，单位秒。 */
    stallAfterSec: 180,
    /** 一次上报给手机的任务条数上限。 */
    recentLimit: 5,
  },
  link: {
    /** WorkBuddy local link — placeholder for Phase 2/3, deliberately inert. */
    cdpPort: 0,
    cliPath: '',
    enabled: false,
  },
  queue: {
    maxAttempts: 12,
    baseBackoffMs: 2000,
    maxBackoffMs: 300000,
  },
}

function merge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof base?.[key] === 'object') {
      out[key] = merge(base[key] ?? {}, value)
    } else {
      out[key] = value
    }
  }
  return out
}

export async function loadConfig() {
  await ensureHome()
  const stored = await readJson(paths.config(), null)
  const config = merge(DEFAULT_CONFIG, stored ?? {})
  // Guard against a hand-edited file naming a driver this build cannot drive.
  if (!MAILBOX_DRIVERS.some((d) => d.id === config.driver)) config.driver = 'mock'
  return config
}

export async function saveConfig(patch) {
  const current = await loadConfig()
  const next = merge(current, patch ?? {})
  await writeJson(paths.config(), next)
  return next
}

/**
 * Mask a credential for display: keep a 4-character prefix so the user can tell
 * which token is loaded, never enough to reconstruct it.
 */
export function maskSecret(value) {
  const text = String(value ?? '')
  if (text.length === 0) return ''
  if (text.length <= 8) return '••••'
  return `${text.slice(0, 4)}••••${text.slice(-2)}`
}

export async function loadCredentials() {
  const stored = await readJson(paths.credentials(), null)
  return {
    token: typeof stored?.token === 'string' ? stored.token : '',
    imapAuth: typeof stored?.imapAuth === 'string' ? stored.imapAuth : '',
    deviceSecret: typeof stored?.deviceSecret === 'string' ? stored.deviceSecret : '',
    updatedAt: typeof stored?.updatedAt === 'string' ? stored.updatedAt : null,
  }
}

export async function saveCredentials(patch) {
  const current = await loadCredentials()
  const next = {
    ...current,
    ...Object.fromEntries(Object.entries(patch ?? {}).filter(([, value]) => value !== undefined)),
    updatedAt: new Date().toISOString(),
  }
  await writeJson(paths.credentials(), next)
  try {
    await fs.chmod(paths.credentials(), 0o600)
  } catch {
    /* Windows: chmod is a no-op; the file still sits under the user's home. */
  }
  return next
}

/** Revoke: drop both secrets from disk. Envelope signing then degrades to unsigned. */
export async function revokeCredentials() {
  try {
    await fs.rm(paths.credentials(), { force: true })
  } catch {
    /* already gone */
  }
  return { token: '', deviceSecret: '', updatedAt: new Date().toISOString() }
}

/** Generate a device secret when the user has not supplied one. */
export function generateDeviceSecret() {
  return crypto.randomBytes(24).toString('base64url')
}
