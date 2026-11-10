/**
 * 云端文件夹信箱（folder transport）。
 *
 * 设计前提：鸿驿不自建任何云端服务。所以「真实信箱」不是一台我们自己的服务器，
 * 而是一个**已经在同步的云文件夹** —— 腾讯网盘（tdrive）同步目录、OneDrive、
 * 坚果云、任意 WebDAV 挂载盘都算。插件只在这个目录里读写 JSON 文件，云端同步
 * 由用户已有的客户端负责。
 *
 * 目录布局（`<root>` = 用户选的云文件夹，`<box>` = 信箱名，默认 dsh-hongyi）：
 *
 *   <root>/<box>/<id>.json          一条信封 = 一个文件（写文件即投递）
 *   <root>/<box>/.ack/<id>.json     ack 标记（存在即已送达）
 *   <root>/<box>/.health            health 探测（不存在也能工作，只在 probe 时写）
 *
 * 语义与 mock/HTTP 信箱完全一致：
 *   put(env)      → 写 <id>.json（已存在则报 duplicate id，等价 HTTP 409）
 *   pull(...)     → 列出未 ack、未过期的信封，按写入时间升序
 *   ack(ids)      → 写 ack 标记（幂等）
 *   health()      → 目录存在且可写
 *
 * TTL：以**文件 mtime**为服务器时间基准（云同步会把 mtime 带过来），
 * 所以本机时钟漂移不会误删远端数据 —— 与 HTTP 信箱「TTL 走服务器时钟」同一条设计。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { PROTOCOL_VERSION, validateEnvelope } from '../envelope.js'

const DEFAULT_TTL_SEC = 3600
const ACK_DIR = '.ack'

function isMissing(error) {
  return error?.code === 'ENOENT'
}

export class FolderMailboxError extends Error {
  constructor(message, { code = 'folder_error', details = null } = {}) {
    super(message)
    this.name = 'FolderMailboxError'
    this.code = code
    this.details = details
  }
}

export class FolderMailbox {
  /**
   * @param {object} options
   * @param {string} options.root  云文件夹绝对路径（同步根）
   * @param {string} [options.box] 信箱名，建成 <root>/<box> 子目录
   * @param {string} [options.secret] 设备密钥，用于信封验签
   * @param {string} [options.driver] 驱动 id，仅用于 describe()
   */
  constructor(options = {}) {
    this.root = String(options.root ?? '').trim().replace(/[\\/]+$/, '')
    this.box = String(options.box ?? 'dsh-hongyi').trim() || 'dsh-hongyi'
    this.secret = options.secret ?? ''
    this.driver = options.driver ?? 'folder'
    this.token = options.token ?? ''
    this.timeoutMs = 8000
  }

  get boxDir() {
    return path.join(this.root, this.box)
  }

  get ackDir() {
    return path.join(this.boxDir, ACK_DIR)
  }

  unsupported() {
    if (this.root.length === 0) return '云文件夹路径为空：请填一个正在同步的云文件夹（腾讯网盘/OneDrive/坚果云均可）。'
    if (!path.isAbsolute(this.root)) return `云文件夹路径必须是绝对路径：${this.root}`
    return ''
  }

  get configured() {
    return this.unsupported() === ''
  }

  /** 确保 <root>/<box> 与 .ack 存在；不可写则抛 unreachable。 */
  async ensureDirs() {
    if (!this.configured) throw new FolderMailboxError(this.unsupported(), { code: 'no_base_url' })
    try {
      await fs.mkdir(this.ackDir, { recursive: true })
    } catch (error) {
      throw new FolderMailboxError(`云文件夹不可写：${this.root}（${error?.code ?? error?.message}）`, {
        code: 'unreachable',
        details: { root: this.root },
      })
    }
  }

  async put(env) {
    await this.ensureDirs()
    const file = path.join(this.boxDir, `${env.id}.json`)
    try {
      await fs.access(file)
      // 已存在：与 HTTP 信箱的 409 duplicate id 对齐
      throw new FolderMailboxError(`信封 ${env.id} 已存在（duplicate id）`, {
        code: 'http_error',
        details: { status: 409, id: env.id },
      })
    } catch (error) {
      if (error instanceof FolderMailboxError) throw error
      if (!isMissing(error)) throw error
    }
    const tmp = `${file}.tmp-${process.pid}`
    await fs.writeFile(tmp, `${JSON.stringify({ envelope: env, receivedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
    await fs.rename(tmp, file)
    return { ok: true, id: env.id, box: this.box }
  }

  /** @returns {Array<{envelope:object, receivedAt:string}>} */
  async pull({ since = null, limit = 20 } = {}) {
    await this.ensureDirs()
    let names = []
    try {
      names = (await fs.readdir(this.boxDir)).filter((name) => name.endsWith('.json'))
    } catch (error) {
      if (isMissing(error)) return []
      throw new FolderMailboxError(`读取云文件夹失败：${error?.message ?? error}`, { code: 'unreachable' })
    }
    const acked = new Set(
      await fs
        .readdir(this.ackDir)
        .then((list) => list.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)))
        .catch(() => []),
    )
    const sinceMs = since ? Date.parse(since) : 0
    const items = []
    for (const name of names) {
      const id = name.slice(0, -5)
      if (acked.has(id)) continue
      const file = path.join(this.boxDir, name)
      let stat
      let raw
      try {
        stat = await fs.stat(file)
        raw = await fs.readFile(file, 'utf8')
      } catch (error) {
        if (isMissing(error)) continue
        throw new FolderMailboxError(`读取信封失败：${name}（${error?.message ?? error}）`, { code: 'unreachable' })
      }
      if (sinceMs > 0 && stat.mtimeMs <= sinceMs) continue
      let parsed = null
      try {
        parsed = JSON.parse(raw)
      } catch {
        continue // 半写入/损坏文件跳过，不阻塞整批
      }
      const envelope = parsed?.envelope ?? parsed
      if (!envelope?.id) continue
      const ttlSec = Number(envelope.ttl)
      const ttl = Number.isFinite(ttlSec) && ttlSec > 0 ? ttlSec : DEFAULT_TTL_SEC
      const ageSec = (Date.now() - stat.mtimeMs) / 1000
      if (ageSec > ttl) {
        // 过期：静默清理，不投递给上层
        await fs.rm(file, { force: true }).catch(() => {})
        continue
      }
      items.push({ envelope, receivedAt: stat.mtime.toISOString(), mtimeMs: stat.mtimeMs })
    }
    items.sort((a, b) => a.mtimeMs - b.mtimeMs)
    return items.slice(0, Math.max(1, Number(limit) || 20)).map(({ mtimeMs, ...rest }) => rest)
  }

  async ack(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return { acked: [] }
    await this.ensureDirs()
    const acked = []
    for (const id of ids) {
      const file = path.join(this.ackDir, `${id}.json`)
      try {
        await fs.writeFile(file, `${JSON.stringify({ id, ackedAt: new Date().toISOString() })}\n`, 'utf8')
        acked.push(id)
        // ack 之后把正文移走，别让信箱文件无限增长（云端同步也能少传一半）
        await fs.rm(path.join(this.boxDir, `${id}.json`), { force: true }).catch(() => {})
      } catch {
        // ack 幂等：单个失败不影响其它
      }
    }
    return { acked }
  }

  async health() {
    await this.ensureDirs()
    return {
      ok: true,
      name: 'hongyi-folder-mailbox',
      protocol: PROTOCOL_VERSION,
      root: this.root,
      box: this.box,
      authRequired: false,
    }
  }

  /** 设置卡片 [测试连接]：写一条 ping → 读回 → 验签 → ack。 */
  async probe(sendPing) {
    const started = Date.now()
    if (!this.configured) {
      return { ok: false, stage: 'config', message: this.unsupported(), mailbox: this.describe(), latencyMs: 0 }
    }
    let health = null
    try {
      health = await this.health()
    } catch (error) {
      return {
        ok: false,
        stage: 'health',
        message: error instanceof Error ? error.message : String(error),
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
          message: '写入成功但读回时未找到该 ping（云文件夹同步/读接口异常）',
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
        message: ping ? '写入并读回成功，签名校验通过' : '云文件夹可读写',
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
        code: error?.code ?? 'probe_failed',
        mailbox: this.describe(),
        latencyMs: Date.now() - started,
        health,
      }
    }
  }

  describe() {
    return {
      driver: this.driver,
      label: this.driver === 'tdrive' ? '腾讯网盘同步文件夹' : '云端文件夹（通用）',
      baseUrl: this.root,
      box: this.box,
      tokenSet: false,
      secretSet: this.secret.length > 0,
      protocol: PROTOCOL_VERSION,
      configured: this.configured,
    }
  }
}
