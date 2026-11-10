/**
 * Mailbox HTTP client.
 *
 * The plugin never runs its own server. The mailbox is one of the facilities
 * WorkBuddy / Tencent already provide, so `MailboxClient` only speaks to a
 * base URL with a token:
 *
 *   POST   {base}/mailbox/{box}            publish one envelope
 *   GET    {base}/mailbox/{box}?since=&limit=   pull undelivered envelopes
 *   POST   {base}/mailbox/{box}/ack       mark ids delivered (idempotent)
 *   GET    {base}/health                  reachability probe
 *
 * Phase 1 ships the `mock` driver only (mock/server.mjs speaks exactly this
 * contract). The other drivers are declared so the settings card can show them
 * as "未接入" instead of pretending, and Phase 3 fills in the real transport
 * without touching the relay code above this interface.
 */
import { PROTOCOL_VERSION, validateEnvelope } from '../envelope.js'

export const MAILBOX_DRIVERS = [
  {
    id: 'mock',
    label: '本地模拟信箱',
    labelEn: 'Local mock mailbox',
    hint: 'mock/server.mjs · 零积分、零网络依赖，用来端到端验证链路',
    ready: true,
  },
  {
    id: 'folder',
    label: '云端文件夹（通用）',
    labelEn: 'Cloud folder (generic)',
    hint: '填一个正在同步的云文件夹绝对路径：OneDrive / 坚果云 / 任意 WebDAV 挂载盘',
    ready: true,
  },
  {
    id: 'tdrive',
    label: '腾讯网盘同步文件夹',
    labelEn: 'Tencent Drive synced folder',
    hint: '同上协议，仅标签不同 · 指向腾讯网盘的本地同步目录即可',
    ready: true,
  },
  {
    id: 'workbuddy-library',
    label: 'WorkBuddy 资料库',
    labelEn: 'WorkBuddy library',
    hint: '账号自带云空间；本机版本无公开 API，需经同步文件夹落地',
    ready: false,
  },
  {
    id: 'tencent-docs',
    label: '腾讯文档 API',
    labelEn: 'Tencent Docs API',
    hint: '需扫码创建应用拿凭据（备选通道）',
    ready: false,
  },
  {
    id: 'imap',
    label: '邮箱 IMAP/SMTP',
    labelEn: 'Mailbox IMAP/SMTP',
    hint: '任何现有邮箱即可（QQ/163/Gmail…），授权码登录，手机端同样直连',
    ready: true,
  },
]

/**
 * Drivers that read/write files in a synced cloud folder instead of speaking
 * HTTP. They share one implementation (`lib/mailbox/folder.js`) and differ only
 * in the label the card shows.
 */
export const FOLDER_DRIVERS = ['folder', 'tdrive']

export function isFolderDriver(id) {
  return FOLDER_DRIVERS.includes(id)
}

export class MailboxError extends Error {
  constructor(message, { status = 0, code = 'mailbox_error', details = null } = {}) {
    super(message)
    this.name = 'MailboxError'
    this.status = status
    this.code = code
    this.details = details
  }
}

const DEFAULT_TIMEOUT_MS = 8000

function trimBase(base) {
  return String(base ?? '').trim().replace(/\/+$/, '')
}

function driverOf(id) {
  return MAILBOX_DRIVERS.find((d) => d.id === id) ?? null
}

export class MailboxClient {
  /**
   * @param {object} options
   * @param {string} options.baseUrl  mailbox base URL, e.g. http://127.0.0.1:7654
   * @param {string} options.box      mailbox name, e.g. dsh-hongyi
   * @param {string} [options.token]  bearer credential
   * @param {string} [options.secret] device secret used to verify envelope HMAC
   * @param {string} [options.driver] one of MAILBOX_DRIVERS ids
   * @param {number} [options.timeoutMs]
   */
  constructor(options = {}) {
    this.baseUrl = trimBase(options.baseUrl)
    this.box = String(options.box ?? 'dsh-hongyi').trim() || 'dsh-hongyi'
    this.token = options.token ?? ''
    this.secret = options.secret ?? ''
    this.driver = options.driver ?? 'mock'
    this.timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS
    this.lastStatus = null
  }

  /** Human-readable reason this client cannot work yet, or '' when it can. */
  unsupported() {
    const driver = driverOf(this.driver)
    if (driver === null) return `未知的信箱驱动：${this.driver}`
    if (!driver.ready) return `${driver.label} 通道尚未接入（当前构建只提供本地模拟信箱），请先切到「本地模拟信箱」。`
    if (this.baseUrl.length === 0) return '信箱地址为空，请填写 mock 服务地址（如 http://127.0.0.1:7654）。'
    return ''
  }

  get configured() {
    return this.unsupported() === ''
  }

  headers(extra = {}) {
    const headers = { accept: 'application/json', ...extra }
    if (this.token) headers.authorization = `Bearer ${this.token}`
    return headers
  }

  async request(pathname, { method = 'GET', body, timeoutMs } = {}) {
    if (this.baseUrl.length === 0) {
      throw new MailboxError('信箱地址未配置', { code: 'no_base_url' })
    }
    const url = `${this.baseUrl}${pathname}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs)
    let response
    try {
      response = await fetch(url, {
        method,
        headers: this.headers(body === undefined ? {} : { 'content-type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      const aborted = error?.name === 'AbortError'
      throw new MailboxError(
        aborted ? `信箱请求超时（${timeoutMs ?? this.timeoutMs}ms）：${url}` : `信箱不可达：${error?.message ?? error}`,
        { code: aborted ? 'timeout' : 'unreachable', details: { url } },
      )
    } finally {
      clearTimeout(timer)
    }
    this.lastStatus = response.status
    const text = await response.text()
    let data = null
    if (text.length > 0) {
      try {
        data = JSON.parse(text)
      } catch {
        data = { raw: text }
      }
    }
    if (!response.ok) {
      const code = response.status === 401 || response.status === 403 ? 'credential_invalid' : 'http_error'
      const message =
        code === 'credential_invalid'
          ? `凭据无效（HTTP ${response.status}）：信箱拒绝了当前 token`
          : `信箱返回 HTTP ${response.status}：${data?.error ?? text.slice(0, 200)}`
      throw new MailboxError(message, { status: response.status, code, details: data })
    }
    return data ?? {}
  }

  /** Publish one envelope. Returns the server's receipt. */
  async put(env) {
    return this.request(`/mailbox/${encodeURIComponent(this.box)}`, { method: 'POST', body: { envelope: env } })
  }

  /** Pull pending envelopes newer than `since` (ISO string or null). */
  async pull({ since = null, limit = 20 } = {}) {
    const params = new URLSearchParams({ limit: String(limit) })
    if (since) params.set('since', since)
    const data = await this.request(`/mailbox/${encodeURIComponent(this.box)}?${params.toString()}`)
    return Array.isArray(data.items) ? data.items : []
  }

  /** Acknowledge ids as delivered. Idempotent on the server. */
  async ack(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return { acked: [] }
    return this.request(`/mailbox/${encodeURIComponent(this.box)}/ack`, {
      method: 'POST',
      body: { ids },
    })
  }

  async health() {
    return this.request('/health')
  }

  /**
   * Round-trip probe used by the settings card's [测试连接] button: publish a
   * ping, read it back, verify it, acknowledge it. Proves write + read + auth in
   * one call without needing the phone.
   */
  async probe(sendPing) {
    const started = Date.now()
    if (!this.configured) {
      return {
        ok: false,
        stage: 'config',
        message: this.unsupported(),
        mailbox: this.describe(),
        latencyMs: 0,
      }
    }
    let health = null
    try {
      health = await this.health()
    } catch (error) {
      return {
        ok: false,
        stage: 'health',
        message: error instanceof MailboxError ? error.message : String(error),
        mailbox: this.describe(),
        latencyMs: Date.now() - started,
      }
    }
    let ping = null
    try {
      ping = sendPing ? await sendPing() : null
    } catch (error) {
      return {
        ok: false,
        stage: 'sign',
        message: error instanceof Error ? error.message : String(error),
        mailbox: this.describe(),
        latencyMs: Date.now() - started,
      }
    }
    try {
      if (ping) await this.put(ping)
      const items = await this.pull({ limit: 50 })
      const envelopes = items.map((item) => item.envelope ?? item)
      const found = ping ? envelopes.find((env) => env?.id === ping.id) : null
      if (ping && !found) {
        return {
          ok: false,
          stage: 'readback',
          message: '写入成功但读回时未找到该 ping（信箱读接口异常）',
          mailbox: this.describe(),
          latencyMs: Date.now() - started,
          health,
        }
      }
      if (found) {
        validateEnvelope(found, { secret: this.secret })
        await this.ack([found.id])
      }
      return {
        ok: true,
        stage: 'done',
        message: ping ? '写入并读回成功，签名校验通过' : '信箱可达',
        mailbox: this.describe(),
        latencyMs: Date.now() - started,
        health,
        pingId: ping?.id ?? null,
      }
    } catch (error) {
      return {
        ok: false,
        stage: 'io',
        message: error instanceof Error ? error.message : String(error),
        code: error instanceof MailboxError ? error.code : 'probe_failed',
        mailbox: this.describe(),
        latencyMs: Date.now() - started,
        health,
      }
    }
  }

  describe() {
    return {
      driver: this.driver,
      label: driverOf(this.driver)?.label ?? this.driver,
      baseUrl: this.baseUrl,
      box: this.box,
      tokenSet: this.token.length > 0,
      secretSet: this.secret.length > 0,
      protocol: PROTOCOL_VERSION,
      configured: this.configured,
    }
  }
}
