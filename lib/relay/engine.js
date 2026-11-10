/**
 * The relay engine: one tick does two directions.
 *
 *   up   telemetry → Outbox → mailbox   (throttled; see telemetry.js)
 *   down mailbox → dedupe → parse → act → ack + reply
 *
 * Design rules worth keeping when this file grows:
 *
 * - **Never call a model.** Only `commands.js` may classify something as
 *   `needs_model`, and nothing in `run()` acts on that classification beyond
 *   writing the text into $DSH_HOME/hongyi/queue/needs-model.json.
 * - **Idempotent by envelope id.** The inbound ledger records every id we acted
 *   on, BEFORE the action runs, so a crash mid-action cannot double-execute on
 *   the next tick (an ack may be lost, which only causes a harmless replay).
 * - **Never throw out of `tick()`.** A broken mailbox must degrade to "retry on
 *   the next tick" and a visible红/黄 status, not a crashed plugin.
 * - **No surprises on disk.** Files this plugin touches live under
 *   $DSH_HOME/hongyi/ only.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { paths } from '../paths.js'
import { readJson, writeJson, journal } from '../store.js'
import { createEnvelope, validateEnvelope, isExpired } from '../envelope.js'
import { Outbox } from './outbox.js'
import { parseCommand, LOCAL_ACTIONS } from './commands.js'
import { decide, digestOf } from './telemetry.js'
import { describeTasks, summarizeForAck } from '../tasks.js'
import { receiveChunk, prunePartials } from '../transfer.js'

const MAX_INBOX_FILE_BYTES = 32 * 1024 * 1024

/** Where the envelopes physically land — differs between HTTP, folder and mail transports. */
function mailboxWhere(config) {
  if (config.driver === 'folder' || config.driver === 'tdrive') {
    return `${config.folderRoot}/${config.box}（同步文件夹）`
  }
  if (config.driver === 'imap') {
    const who = config.imapUser || '（未填邮箱）'
    return `${who}/草稿箱（${config.imapProvider || 'qq'} · 静默通道）`
  }
  return `${config.baseUrl}/${config.box}`
}

/** What the relay can actually do locally, without a model. */
async function runAction(action, arg, { config, entryDir }) {
  switch (action) {
    case 'start':
      return { ok: true, detail: `遥测已开启（driver=${config.driver}，${mailboxWhere(config)}）；上行按「变化即报 / 无变化 10 分钟汇总」节流` }
    case 'stop':
      return { ok: true, detail: '遥测已暂停；插件仍在运行，随时可用 start 恢复' }
    case 'status':
      return {
        ok: true,
        detail: `在线；driver=${config.driver}；信箱=${mailboxWhere(config)}；节流：变化即报 / 汇总 ${config.telemetry.summaryIntervalSec}s`,
      }
    case 'help':
      return { ok: true, detail: `本地可执行：${LOCAL_ACTIONS.join(' / ')}。自然语言指令只会被排队（needs_model），不会在此解析。` }
    case 'download': {
      if (!/^https?:\/\//i.test(arg)) return { ok: false, detail: '需要一个 http(s) 地址' }
      const name = path.basename(new URL(arg).pathname) || 'download.bin'
      const target = path.join(entryDir, `${Date.now()}-${name.replace(/[^\w.\-]/g, '_')}`)
      const response = await fetch(arg, { redirect: 'follow' })
      if (!response.ok) return { ok: false, detail: `下载失败：HTTP ${response.status}` }
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length > MAX_INBOX_FILE_BYTES) return { ok: false, detail: `文件过大（${buffer.length} 字节）` }
      await fs.mkdir(entryDir, { recursive: true })
      await fs.writeFile(target, buffer)
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex')
      return { ok: true, detail: `已下载 ${buffer.length} 字节到 ${target}（sha256 ${sha256.slice(0, 16)}…）`, file: { path: target, size: buffer.length, sha256 } }
    }
    default:
      return { ok: false, detail: `未实现的动作：${action}` }
  }
}

export class Relay {
  /**
   * @param {object} input
   * @param {() => Promise<{config:object, credentials:object, client:import('../mailbox/client.js').MailboxClient}>} input.buildClient
   * @param {object} [input.limits]
   */
  constructor({ buildClient, limits = {}, paths: pathsIn = paths, collectTasks = null }) {
    this.buildClient = buildClient
    this.paths = pathsIn
    /**
     * 任务监测的采集器（`lib/tasks.js` 的 collectTasks）。由 `apply()` 注入，
     * 因为它需要两个只有在插件里才知道的东西：本机 webServer origin 和要扫的工作目录。
     * 不注入时快照里就没有 tasks 字段，引擎照常工作。
     */
    this.collectTasks = collectTasks
    this.lastTasks = null
    this.outbox = new Outbox({ file: pathsIn.queueFile(), journalFile: pathsIn.journalFile(), limits })
    this.timer = null
    this.running = false
    this.ticking = false
    this.paused = false
    this.status = {
      lastTickAt: null,
      lastTickError: null,
      lastSentAt: 0,
      lastHeartbeatAt: 0,
      lastDigest: '',
      lastPullAt: null,
      lastPullCount: 0,
      lastCommand: null,
      lastCommandOk: null,
      ticks: 0,
      sent: 0,
      received: 0,
      executed: 0,
      skippedDuplicate: 0,
      needsModel: 0,
      tasksAt: null,
      filesReceived: 0,
      fileChunks: 0,
      lastFile: null,
      tasksError: null,
    }
    this.ledger = null
  }

  /* ------------------------------------------------------------------ ledger */

  async loadLedger() {
    if (this.ledger) return this.ledger
    const stored = await readJson(this.paths.inboundLedger(), { ids: [] })
    this.ledger = { ids: Array.isArray(stored?.ids) ? stored.ids : [] }
    return this.ledger
  }

  async rememberId(id) {
    const ledger = await this.loadLedger()
    if (ledger.ids.includes(id)) return false
    ledger.ids.push(id)
    // Keep the ledger bounded; 5000 recent ids is weeks of traffic and still
    // small enough to rewrite on every tick.
    if (ledger.ids.length > 5000) ledger.ids = ledger.ids.slice(-5000)
    await writeJson(this.paths.inboundLedger(), { version: 1, updatedAt: new Date().toISOString(), ids: ledger.ids })
    return true
  }

  /* ------------------------------------------------------------------- state */

  async snapshot() {
    const queue = await this.outbox.stats()
    const pendingModel = await readJson(this.paths.pendingModelFile(), { items: [] })
    const tasks = await this.tasks({ push: false })
    return {
      online: true,
      running: this.running,
      paused: this.paused,
      enabled: true,
      driver: '',
      box: '',
      queuePending: queue.pending,
      queueParked: queue.parked,
      queueLastError: queue.lastError,
      nextAttemptAt: queue.nextAttemptAt,
      needsModel: Array.isArray(pendingModel.items) ? pendingModel.items.length : 0,
      lastCommand: this.status.lastCommand,
      lastCommandOk: this.status.lastCommandOk,
      tasks: tasks.ok
        ? {
            signature: tasks.signature,
            running: tasks.running,
            failed: tasks.failed,
            stalled: tasks.stalled,
            total: tasks.total,
            recent: tasks.recent.map((t) => ({
              id: t.id,
              name: t.name,
              status: t.status,
              exitCode: t.exitCode,
              ageSec: t.ageSec,
              idleSec: t.idleSec,
              stalled: t.stalled,
              tail: t.tail,
            })),
          }
        : null,
    }
  }

  /**
   * 采集任务快照（带 10 秒缓存）。
   *
   * 每 15 秒一跳、每跳都可能问到它，而采集要 stat 一堆日志文件；缓存让
   * 「一次 tick 里 snapshot 被调多次」不重复扫盘。`push: true` 时用新的
   * `collectTasks()` 拿到手机可见的全部字段。失败只记 status.tasksError，永不抛。
   */
  async tasks({ push = true, maxAgeMs = 10000 } = {}) {
    if (!this.collectTasks) return { ok: false, reason: '未配置任务采集器' }
    const now = Date.now()
    if (this.lastTasks && now - (this.status.tasksAt ?? 0) < maxAgeMs) {
      return { ...this.lastTasks, cached: true }
    }
    try {
      const result = await this.collectTasks({ push })
      this.lastTasks = result
      this.status.tasksAt = now
      this.status.tasksError = null
      return result
    } catch (error) {
      const reason = error?.message ?? String(error)
      this.status.tasksError = reason
      await journal(this.paths.journalFile(), { kind: 'tasks-collect-error', error: reason })
      return { ok: false, reason }
    }
  }

  /* -------------------------------------------------------------------- loop */

  start(intervalMs = 15000) {
    if (this.running) return { ok: true, already: true, intervalMs }
    this.running = true
    this.paused = false
    this.intervalMs = intervalMs
    this.timer = setInterval(() => {
      this.tick().catch(() => {})
    }, intervalMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
    // One immediate tick so the phone sees state within seconds, not one period.
    this.tick().catch(() => {})
    return { ok: true, intervalMs }
  }

  stop() {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    return { ok: true }
  }

  pause(paused = true) {
    this.paused = paused
    return { ok: true, paused }
  }

  async tick() {
    if (this.ticking) return { ok: true, skipped: 'already-ticking' }
    this.ticking = true
    try {
      const result = { up: null, down: null }
      const { config, credentials, client } = await this.buildClient()
      const unsupported = typeof client.unsupported === 'function' ? client.unsupported() : ''
      if (unsupported) {
        this.status.lastTickError = unsupported
        return { ok: false, reason: unsupported }
      }
      if (!this.paused) result.up = await this.sendTelemetry({ config, credentials, client })
      result.down = await this.receiveCommands({ config, credentials, client })
      this.status.ticks += 1
      this.status.lastTickAt = new Date().toISOString()
      this.status.lastTickError = null
      return { ok: true, ...result }
    } catch (error) {
      this.status.lastTickError = error?.message ?? String(error)
      await journal(this.paths.journalFile(), { kind: 'relay-tick-error', error: this.status.lastTickError })
      return { ok: false, reason: this.status.lastTickError }
    } finally {
      this.ticking = false
    }
  }

  /* --------------------------------------------------------------------- up */

  async sendTelemetry({ config, credentials, client }) {
    const now = Date.now()
    const snapshot = await this.snapshot()
    snapshot.driver = config.driver
    snapshot.box = config.box
    const digest = digestOf(snapshot)
    const decision = decide({
      digest,
      lastDigest: this.status.lastDigest,
      now,
      lastSentAt: this.status.lastSentAt,
      lastHeartbeatAt: this.status.lastHeartbeatAt,
      summaryIntervalSec: config.telemetry.summaryIntervalSec,
      heartbeatSec: config.telemetry.heartbeatSec,
      minGapSec: config.telemetry.minGapSec ?? 10,
    })
    if (!decision.send) {
      // Nothing to say; still try to drain anything the phone cannot see yet.
      const flushed = await this.flush({ config, credentials, client })
      return { decision, flushed }
    }

    const envelope = createEnvelope({
      type: 'telemetry',
      from: config.deviceId,
      to: config.phoneId,
      ttl: Math.max(60, config.telemetry.summaryIntervalSec * 2),
      secret: credentials.deviceSecret,
      payload: {
        kind: decision.reason === 'summary' ? 'summary' : 'state',
        reason: decision.reason,
        online: true,
        heartbeatAt: new Date(now).toISOString(),
        offlineAfterSec: config.telemetry.offlineAfterSec,
        protocol: 1,
        snapshot,
      },
    })
    if (decision.reason === 'heartbeat') this.status.lastHeartbeatAt = now
    await this.outbox.enqueue(envelope)
    this.status.lastDigest = digest
    this.status.lastSentAt = now
    const flushed = await this.flush({ config, credentials, client })
    return { decision, id: envelope.id, flushed }
  }

  /** Push every due queued envelope; stop at the first failure (it is a link problem). */
  async flush({ config, credentials, client }) {
    const due = await this.outbox.due()
    const sent = []
    for (const entry of due) {
      const env = entry.envelope
      try {
        if (isExpired(env, Date.now())) {
          await this.outbox.markSent(env.id)
          await journal(this.paths.journalFile(), { kind: 'outbox-drop-expired', id: env.id })
          continue
        }
        await client.put(env)
        await this.outbox.markSent(env.id)
        sent.push(env.id)
        this.status.sent += 1
      } catch (error) {
        // A duplicate means an earlier attempt DID land — that is success.
        // HTTP transports surface it as `status`, the folder transport as
        // `details.status`; both mean "the mailbox already has this id".
        if (error?.status === 409 || error?.details?.status === 409) {
          await this.outbox.markSent(env.id)
          sent.push(env.id)
          continue
        }
        const info = await this.outbox.markFailed(env.id, error)
        await journal(this.paths.journalFile(), { kind: 'outbox-fail', id: env.id, error: error?.message, ...info })
        break
      }
    }
    return { attempted: due.length, sent: sent.length }
  }

  /* ------------------------------------------------------------------- down */

  async receiveCommands({ config, credentials, client }) {
    const items = await client.pull({ limit: 20 })
    this.status.lastPullAt = new Date().toISOString()
    this.status.lastPullCount = items.length
    const results = []
    for (const item of items) {
      const env = item?.envelope ?? item
      if (!env || typeof env.id !== 'string') continue
      if (env.from === config.deviceId) {
        // Our own telemetry / acks echoed back. A driver that does not filter by
        // `to` hands them to us too, but they belong to the phone: acking here
        // would delete them from the shared mailbox before the phone ever read
        // them. Leave them alone.
        continue
      }
      if (env.to !== config.deviceId && env.to !== '*') {
        // Addressed to another device that shares the box — not ours to consume.
        continue
      }
      const result = await this.handleOne(env, { config, credentials, client })
      results.push(result)
    }
    return { pulled: items.length, handled: results.length, results }
  }

  async handleOne(env, { config, credentials, client }) {
    this.status.received += 1
    if (!(await this.rememberId(env.id))) {
      this.status.skippedDuplicate += 1
      await client.ack([env.id]).catch(() => {})
      return { id: env.id, skipped: 'duplicate' }
    }

    let accepted = env
    try {
      validateEnvelope(env, { secret: credentials.deviceSecret })
    } catch (error) {
      // A bad signature or an incompatible protocol version is reported, never
      // silently dropped: the phone must learn why its command did nothing.
      const ack = createEnvelope({
        type: 'ack',
        from: config.deviceId,
        to: env.from ?? config.phoneId,
        ttl: config.telemetry.summaryIntervalSec * 2,
        secret: credentials.deviceSecret,
        payload: { ackOf: env.id, ok: false, error: error?.message ?? String(error), stage: 'validate' },
      })
      await this.outbox.enqueue(ack)
      await client.ack([env.id]).catch(() => {})
      await journal(this.paths.journalFile(), { kind: 'command-rejected', id: env.id, error: error?.message })
      return { id: env.id, rejected: error?.message ?? String(error) }
    }

    if (env.type === 'file') {
      // 分片落地：不调用模型、不回 ack（回执会把 200 条邮件变成 400 条），
      // 只在最后一片凑齐时记一条 file-received。
      try {
        const result = await receiveChunk(env, { inboxDir: this.paths.inboxDir(), journalFile: this.paths.journalFile() })
        if (result.state === 'partial') this.status.fileChunks = (this.status.fileChunks ?? 0) + 1
        if (result.state === 'done') {
          this.status.filesReceived = (this.status.filesReceived ?? 0) + 1
          this.status.lastFile = { name: result.name, size: result.size, at: new Date().toISOString() }
        }
        await client.ack([env.id]).catch(() => {})
        return { id: env.id, file: result.state, detail: result.reason ?? result.name }
      } catch (error) {
        await journal(this.paths.journalFile(), {
          kind: 'file-chunk-error', id: env.id, error: error?.message ?? String(error),
        })
        await client.ack([env.id]).catch(() => {})
        return { id: env.id, error: error?.message ?? String(error) }
      }
    }

    if (env.type !== 'command') {
      await client.ack([env.id]).catch(() => {})
      return { id: env.id, ignored: `type=${env.type}` }
    }

    // 顺手清理超过 24 小时还没凑齐的分片（每次收到非文件消息时最多做一次）
    prunePartials(this.paths.inboxDir()).catch(() => {})

    const parsed = parseCommand(env.payload ?? {})
    let outcome
    if (parsed.kind === 'action') {
      if (parsed.action === 'stop') this.pause(true)
      if (parsed.action === 'start') this.pause(false)
      if (parsed.action === 'tasks') {
        // 任务监测要问到 Relay 自己的采集器，所以不能走纯函数 runAction。
        const tasks = await this.tasks({ push: true })
        outcome = { ok: Boolean(tasks.ok), detail: describeTasks(tasks), tasks: tasks.ok ? summarizeForAck(tasks) : null }
      } else {
        outcome = await runAction(parsed.action, parsed.arg, { config, entryDir: this.paths.inboxDir() })
      }
      this.status.executed += 1
      this.status.lastCommand = `${parsed.action}${parsed.arg ? ' ' + parsed.arg : ''}`
      this.status.lastCommandOk = Boolean(outcome.ok)
    } else {
      // Queue for the optional cloud task. Never executed here.
      const pending = await readJson(this.paths.pendingModelFile(), { items: [] })
      const items = Array.isArray(pending?.items) ? pending.items : []
      if (!items.some((entry) => entry.id === env.id)) {
        items.push({ id: env.id, text: parsed.text, reason: parsed.reason, at: new Date().toISOString(), handled: false })
        await writeJson(this.paths.pendingModelFile(), { version: 1, updatedAt: new Date().toISOString(), items })
      }
      this.status.needsModel += 1
      this.status.lastCommand = `needs_model: ${parsed.text.slice(0, 40)}`
      this.status.lastCommandOk = null
      outcome = { ok: true, detail: `已排队等待云端解析（${parsed.reason}）；本地不调用模型` }
    }

    const ack = createEnvelope({
      type: 'ack',
      from: config.deviceId,
      to: env.from ?? config.phoneId,
      ttl: config.telemetry.summaryIntervalSec * 2,
      secret: credentials.deviceSecret,
      payload: { ackOf: env.id, ok: Boolean(outcome.ok), result: outcome.detail, file: outcome.file ?? null },
    })
    await this.outbox.enqueue(ack)
    await client.ack([env.id]).catch(() => {})
    await journal(this.paths.journalFile(), { kind: 'command-executed', id: env.id, ok: Boolean(outcome.ok), detail: outcome.detail })
    // Try to deliver the ack right away rather than on the next tick.
    await this.flush({ config, credentials, client })
    return { id: env.id, ok: Boolean(outcome.ok), detail: outcome.detail }
  }
}

export { Outbox, parseCommand, decide, digestOf, runAction }
