/**
 * 鸿驿 (dsh-hongyi) — Host half.
 *
 * What this file owns:
 *   - the plugin's own state files under $DSH_HOME/hongyi/;
 *   - one named HTTP prefix route `/hongyi` so the settings card (and the APK's
 *     own diagnostics) can read and change that state without inventing a second
 *     RPC layer;
 *   - one human command `/hongyi` for the same operations from the composer;
 *   - the relay engine (lib/relay/): a periodic tick that pushes throttled
 *     telemetry up and executes structured commands coming down.
 *
 * Why an HTTP route rather than a Remote service: the settings section lives in
 * the browser and there is no host-remote binding for this plugin's own data, so
 * a plain `fetch('/hongyi/…')` keeps the UI and the command on exactly one
 * implementation. Every handler returns JSON; failures return a JSON body with a
 * `reason` the UI shows verbatim.
 *
 * The relay is started by `apply()` and stopped by the cleanup function, so it
 * follows the plugin's own lifetime instead of leaking a timer into the host.
 */
import { ensureHome, paths, hongyiHome } from './lib/paths.js'
import { loadConfig, saveConfig, loadCredentials, saveCredentials, revokeCredentials, generateDeviceSecret, maskSecret, DEFAULT_CONFIG } from './lib/config.js'
import { MailboxClient, MAILBOX_DRIVERS, MailboxError } from './lib/mailbox/client.js'
import { createMailbox } from './lib/mailbox/factory.js'
import { createPing, PROTOCOL_VERSION, validateEnvelope } from './lib/envelope.js'
import { journal, readJson, readText } from './lib/store.js'
import { Relay } from './lib/relay/engine.js'
import { collectTasks, describeTasks } from './lib/tasks.js'
import { listInbox, listPartial, sendFile as sendFileToMailbox } from './lib/transfer.js'
import * as doctorModule from './lib/doctor.js'

export const name = 'dsh-hongyi'

/** A stable id prefix so our route can never collide with another plugin's. */
/** 只为 sendFile 判断「是不是文件」，避免为一次 stat 引入整套 fs/promises。 */
async function statFile(filePath) {
  const { stat } = await import('node:fs/promises')
  return stat(filePath)
}

const ROUTE_PREFIX = '/hongyi'

/** Actions with side effects: POST only (a GET must never mutate anything). */
const ACTIONS_POST_ONLY = ['ping', 'probe', 'save', 'token', 'imap-auth', 'revoke', 'secret', 'secret-reveal', 'relay-tick', 'relay-start', 'relay-stop', 'outbox-retry', 'send-file']

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

function readJsonBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw.length === 0) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

/** Build the mailbox client from the persisted config + credentials. */
async function buildClient() {
  const config = await loadConfig()
  const credentials = await loadCredentials()
  const client = createMailbox(config, credentials)
  return { config, credentials, client }
}

function publicState(config, credentials, relayStatus = null) {
  return {
    ok: true,
    plugin: 'dsh-hongyi',
    version: '1.1.0',
    protocol: PROTOCOL_VERSION,
    phase: 5,
    home: hongyiHome(),
    config: {
      enabled: config.enabled,
      driver: config.driver,
      baseUrl: config.baseUrl,
      folderRoot: config.folderRoot,
      imapUser: config.imapUser ?? '',
      imapProvider: config.imapProvider ?? 'qq',
      imapQuiet: config.imapQuiet !== false,
      box: config.box,
      wecomWebhook: config.wecomWebhook,
      deviceId: config.deviceId,
      phoneId: config.phoneId,
      telemetry: config.telemetry,
      relay: config.relay,
      tasks: config.tasks,
      link: config.link,
      queue: config.queue,
    },
    credentials: {
      token: maskSecret(credentials.token),
      tokenSet: credentials.token.length > 0,
      imapAuth: maskSecret(credentials.imapAuth ?? ''),
      imapAuthSet: (credentials.imapAuth ?? '').length > 0,
      deviceSecretSet: credentials.deviceSecret.length > 0,
      updatedAt: credentials.updatedAt,
    },
    drivers: MAILBOX_DRIVERS,
    defaults: DEFAULT_CONFIG,
    relay: relayStatus,
  }
}

/**
 * The operations, each one a plain async function so the HTTP route and the
 * `/hongyi` command call the same code (see references/user-actions.md: one
 * operation, two callers).
 *
 * `relay` is created by `apply()` and injected here, so an operation can drive
 * the same engine the timer drives — no second implementation, no second timer.
 */
function createOperations(relay = null) {
  const relayState = () => (relay ? relay.status : null)

  return {
    async state() {
      const { config, credentials } = await buildClient()
      return publicState(config, credentials, relayState())
    },

    async save(patch) {
      const allowed = ['enabled', 'driver', 'baseUrl', 'folderRoot', 'imapUser', 'imapProvider', 'imapQuiet', 'imapQuietFolder', 'tasks', 'box', 'wecomWebhook', 'deviceId', 'phoneId', 'telemetry', 'relay', 'link', 'queue']
      const filtered = Object.fromEntries(
        Object.entries(patch ?? {}).filter(([key]) => allowed.includes(key)),
      )
      const config = await saveConfig(filtered)
      const credentials = await loadCredentials()
      await journal(paths.journalFile(), { kind: 'config-saved', fields: Object.keys(filtered) })
      return publicState(config, credentials, relayState())
    },

    async setToken(token) {
      const value = String(token ?? '').trim()
      const credentials = value.length === 0 ? await revokeCredentials() : await saveCredentials({ token: value })
      await journal(paths.journalFile(), { kind: value ? 'token-saved' : 'token-revoked' })
      const config = await loadConfig()
      return publicState(config, credentials, relayState())
    },

    /** 保存邮箱授权码（imap 通道专用，属于密钥，存 credentials.json）。 */
    async setImapAuth(auth) {
      const value = String(auth ?? '').trim()
      const credentials = value.length === 0
        ? await revokeCredentials()
        : await saveCredentials({ imapAuth: value })
      await journal(paths.journalFile(), { kind: value ? 'imap-auth-saved' : 'imap-auth-revoked' })
      const config = await loadConfig()
      return publicState(config, credentials, relayState())
    },

    async revoke() {
      const credentials = await revokeCredentials()
      await journal(paths.journalFile(), { kind: 'credentials-revoked' })
      const config = await loadConfig()
      return publicState(config, credentials, relayState())
    },

    async generateSecret() {
      const credentials = await saveCredentials({ deviceSecret: generateDeviceSecret() })
      await journal(paths.journalFile(), { kind: 'device-secret-generated' })
      const config = await loadConfig()
      return publicState(config, credentials, relayState())
    },

    /**
     * [显示密钥] — 回传设备密钥明文，供用户在设置卡片里照抄到手机 APK。
     *
     * 为什么必须是单独一次请求、而不是一直放在 state 里：state 会被设置页
     * 轮询（卡片每次刷新都拿一遍），把明文长期挂在响应里等于把它写进任何
     * 一次网络抓包/日志。这里只在用户点「显示」时要一次，卡片用完即弃。
     * 同时只在 POST 上开放：GET 可能被浏览器预取或缓存。
     */
    async revealSecret() {
      const credentials = await loadCredentials()
      const secret = credentials.deviceSecret ?? ''
      await journal(paths.journalFile(), { kind: 'device-secret-revealed' })
      return {
        ok: secret.length > 0,
        deviceSecret: secret,
        length: secret.length,
        message: secret.length > 0
          ? `设备密钥共 ${secret.length} 位，照抄到手机「设置 → 设备密钥」即可`
          : '尚未生成设备密钥：先点「生成新密钥」，再把新密钥填到手机端',
      }
    },

    /** [测试连接] — health + write + read-back + signature check + ack. */
    async probe() {
      const { config, credentials, client } = await buildClient()
      const result = await client.probe(() =>
        createPing({ from: config.deviceId, to: config.phoneId, secret: credentials.deviceSecret, ttl: 120 }),
      )
      await journal(paths.journalFile(), {
        kind: 'probe',
        ok: result.ok,
        stage: result.stage,
        message: result.message,
      })
      return { ...result, state: publicState(config, credentials, relayState()) }
    },

    /** One end-to-end ping/pong through whatever mailbox is configured. */
    async ping() {
      const { config, credentials, client } = await buildClient()
      const unsupported = client.unsupported()
      if (unsupported) return { ok: false, stage: 'config', message: unsupported }
      const ping = createPing({
        from: config.deviceId,
        to: config.phoneId,
        secret: credentials.deviceSecret,
        ttl: 120,
      })
      try {
        await client.put(ping)
        const items = await client.pull({ limit: 50 })
        const envelopes = items.map((item) => item.envelope ?? item)
        const found = envelopes.find((env) => env?.id === ping.id)
        if (!found) {
          return { ok: false, stage: 'readback', message: '写入成功但读回失败', pingId: ping.id }
        }
        validateEnvelope(found, { secret: credentials.deviceSecret })
        await client.ack([found.id])
        return {
          ok: true,
          stage: 'done',
          pingId: ping.id,
          message: 'ping 已写入并成功读回，签名校验通过，已 ack',
          envelope: found,
        }
      } catch (error) {
        const message = error instanceof MailboxError || error instanceof Error ? error.message : String(error)
        const code = error instanceof MailboxError ? error.code : 'ping_failed'
        return { ok: false, stage: 'io', code, message, pingId: ping.id }
      }
    },

    async doctor() {
      const { config, credentials, client } = await buildClient()
      return doctorModule.runDoctor({ config, credentials, client, paths, hongyiHome })
    },

    /* ------------------------------------------------------------------ relay */

    /** Liveness of the relay loop itself: is the timer alive, when did it last run. */
    async relay() {
      if (!relay) return { ok: false, reason: '中转引擎未启动（插件未激活或已被清理）' }
      const queue = await relay.outbox.stats()
      const pendingModel = await readJson(paths.pendingModelFile(), { items: [] })
      return {
        ok: true,
        running: relay.running,
        paused: relay.paused,
        intervalMs: relay.intervalMs ?? null,
        status: relay.status,
        outbox: queue,
        needsModel: Array.isArray(pendingModel?.items) ? pendingModel.items.length : 0,
      }
    },

    /** Force one tick now (the card's「立即同步」button and `/hongyi relay-tick`). */
    async relayTick() {
      if (!relay) return { ok: false, reason: '中转引擎未启动' }
      const result = await relay.tick()
      return { ...result, status: relay.status }
    },

    async relayStart() {
      if (!relay) return { ok: false, reason: '中转引擎未启动' }
      relay.start()
      relay.pause(false)
      return { ok: true, running: relay.running, paused: relay.paused }
    },

    async relayStop() {
      if (!relay) return { ok: false, reason: '中转引擎未启动' }
      relay.pause(true)
      return { ok: true, running: relay.running, paused: relay.paused, hint: '已暂停上行；定时器仍在跑下行，可用 relay-start 恢复' }
    },

    async outbox() {
      if (!relay) return { ok: false, reason: '中转引擎未启动' }
      await relay.outbox.load()
      return {
        ok: true,
        stats: await relay.outbox.stats(),
        entries: relay.outbox.entries.map((entry) => ({
          id: entry.envelope?.id,
          type: entry.envelope?.type,
          ts: entry.envelope?.ts,
          state: entry.state,
          attempts: entry.attempts,
          nextAt: entry.nextAt ? new Date(entry.nextAt).toISOString() : null,
          lastError: entry.lastError,
        })),
      }
    },

    async outboxRetry(id) {
      if (!relay) return { ok: false, reason: '中转引擎未启动' }
      const one = typeof id === 'string' && id.length > 0 ? await relay.outbox.retry(id) : false
      const all = one ? 0 : await relay.outbox.retryAll()
      return { ok: true, retriedOne: one, retriedAll: all, stats: await relay.outbox.stats() }
    },

    /**
     * 文件传输（电脑 → 手机）：把本地文件切成 type=file 的信封丢进信箱。
     * 手机端把同 tid 的片拼回来即可 —— 不依赖任何一端常驻服务。
     */
    async sendFile(filePath, options = {}) {
      const config = await loadConfig()
      const credentials = await loadCredentials()
      if (!credentials.deviceSecret) return { ok: false, reason: '设备密钥未设置：先在卡片里点「生成新密钥」' }
      if (typeof filePath !== 'string' || filePath.trim().length === 0) {
        return { ok: false, reason: '需要文件的绝对路径' }
      }
      let info
      try {
        info = await statFile(filePath)
      } catch (error) {
        return { ok: false, reason: `读不到文件：${error?.code ?? error?.message ?? error}` }
      }
      if (!info.isFile()) return { ok: false, reason: `不是文件：${filePath}` }
      const client = createMailbox(config, credentials)
      const chunkBytes = Number(options.chunkBytes) > 0 ? Number(options.chunkBytes) : undefined
      const result = await sendFileToMailbox({
        filePath,
        client,
        outbox: relay?.outbox ?? null,
        from: config.deviceId,
        to: config.phoneId,
        secret: credentials.deviceSecret,
        ttl: Number(options.ttl) > 0 ? Number(options.ttl) : 3600,
        chunkBytes,
      })
      await journal(paths.journalFile(), {
        kind: result.done ? 'file-sent' : 'file-send-failed',
        tid: result.tid,
        name: result.name,
        size: result.size,
        sent: result.sent,
        total: result.total,
        error: result.firstError,
      })
      return {
        ok: result.done,
        tid: result.tid,
        name: result.name,
        size: result.size,
        sha256: result.sha256,
        total: result.total,
        sent: result.sent,
        reason: result.done ? null : (result.firstError ?? `只发出 ${result.sent}/${result.total} 片`),
      }
    },

    /** 已收到的文件 + 还没拼齐的分片。 */
    async inbox() {
      const dir = paths.inboxDir()
      return {
        ok: true,
        dir,
        files: await listInbox(dir, { limit: 20 }),
        partial: await listPartial(dir),
      }
    },

    /**
     * 任务监测：卡片的「任务」分区与手机的 `tasks` 指令读的就是这里。
     * `force` 会跳过快照缓存，立刻重新扫一遍（卡片上的刷新按钮用）。
     */
    async tasks(force = false) {
      if (!relay) {
        const direct = await collectTasks({ origin: '', workdirs: [process.cwd()] })
        return { ...direct, description: describeTasks(direct) }
      }
      const result = await relay.tasks({ push: true, maxAgeMs: force ? 0 : 10000 })
      return { ...result, description: describeTasks(result) }
    },
    /**
     * 手机指令流水：桌面端也要看见「手机刚才让我干了什么、成没成」。
     *
     * 数据源就是 journal.ndjson —— 它本来就在记 command-executed / command-rejected，
     * 这里只做倒序切片。刻意不另建存储：一份真相、两个出口（手机看 ack 邮件，桌面看这张卡）。
     */
    async commands(limit = 20) {
      const raw = await readText(paths.journalFile(), '')
      const lines = String(raw).split(/\r?\n/).filter((line) => line.trim().length > 0)
      const wanted = new Set(['command-executed', 'command-rejected', 'command-needs-model'])
      const size = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 20
      const entries = []
      for (let index = lines.length - 1; index >= 0 && entries.length < size; index -= 1) {
        let record
        try {
          record = JSON.parse(lines[index])
        } catch {
          continue
        }
        if (!wanted.has(record?.kind)) continue
        entries.push({
          ts: record.ts ?? null,
          kind: record.kind,
          ok: record.kind === 'command-executed' ? record.ok !== false : false,
          id: record.id ?? null,
          detail: record.detail ?? record.error ?? '',
        })
      }
      return { ok: true, total: entries.length, entries }
    },
  }
}

export function apply(ctx, config) {
  /**
   * The relay owns the timer, the outbox and the inbound ledger. It is created
   * here (not at module load) so it follows this plugin's lifetime, and it is
   * handed to `createOperations` so HTTP, the command and the timer all drive the
   * same engine.
   *
   * `buildClient` re-reads config + credentials on every tick on purpose: the
   * settings card can change the mailbox address or revoke the token at any time,
   * and the next tick must pick that up without a restart.
   */
  /** 任务监测的运行时环境：webServer 注入后才知道 origin，工作目录取自配置。 */
  const taskEnv = { origin: '', workdirs: [], stallAfterSec: 180, recentLimit: 5 }
  const relay = new Relay({
    buildClient,
    /**
     * 任务监测：只有插件自己知道「本机 webServer 的 origin」和「该扫哪些工作目录」，
     * 所以在这里注入采集器。采不到 HTTP 时会自动退回磁盘扫描（见 lib/tasks.js）。
     */
    collectTasks: () =>
      collectTasks({
        origin: taskEnv.origin,
        workdirs: taskEnv.workdirs,
        stallAfterSec: taskEnv.stallAfterSec,
        recentLimit: taskEnv.recentLimit,
      }),
  })
  const operations = createOperations(relay)

  /**
   * Register a resource so BOTH owners can release it: Cordis (through
   * `ctx.effect`, its normal lifetime owner) and this plugin's own returned
   * cleanup. Double release is safe — every disposer here removes one entry from
   * a registry and tolerates an entry that is already gone — and it means the
   * plugin still cleans up on a host that does not provide `ctx.effect`.
   */
  const loose = []
  /**
   * Turn whatever a registration returned into a plain disposer:
   * - a function is already one;
   * - `ctx.inject(...)` returns a fiber, whose `dispose()` tears down the plugin
   *   (and therefore the route/command it registered).
   * Anything else is treated as "nothing to release".
   */
  const toDisposer = (value) => {
    if (typeof value === 'function') return value
    if (value && typeof value.dispose === 'function') return () => value.dispose()
    return undefined
  }
  const track = (register) => {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => {
        const dispose = toDisposer(register())
        if (dispose) loose.push(dispose)
        return dispose
      })
    } else {
      const dispose = toDisposer(register())
      if (dispose) loose.push(dispose)
    }
  }

  /**
   * Cordis reads a service off `ctx` ONLY when the fiber declared it in `inject`;
   * touching `ctx.webServer` from an un-injected fiber throws
   * `cannot get property "webServer" without inject` and kills the whole entry
   * (that is exactly how this plugin first failed to activate). `ctx.logger` is a
   * service too, so even logging goes through this guard.
   */
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(message)
    } catch {
      /* logger itself is an un-injected service on some hosts */
    }
  }

  // The mailbox needs directories to exist before anything else touches disk.
  ensureHome().catch((error) => {
    warn(`[hongyi] 无法创建 ${hongyiHome()}：${error?.message ?? error}`)
  })

  const handler = async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const action = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '')
      try {
        if (req.method === 'GET' && (action === '' || action === 'state')) {
          return json(res, 200, await operations.state())
        }
        if (req.method === 'GET' && action === 'doctor') {
          return json(res, 200, await operations.doctor())
        }
        if (req.method === 'GET' && (action === 'relay' || action === 'outbox')) {
          return json(res, 200, action === 'relay' ? await operations.relay() : await operations.outbox())
        }
        if (req.method === 'GET' && action === 'commands') {
          return json(res, 200, await operations.commands(Number(url.searchParams.get('limit') ?? 20)))
        }
        if (req.method === 'GET' && action === 'tasks') {
          return json(res, 200, await operations.tasks(url.searchParams.get('force') === '1'))
        }
        if (req.method === 'GET' && action === 'inbox') {
          return json(res, 200, await operations.inbox())
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req)
          if (action === 'save') return json(res, 200, await operations.save(body))
          if (action === 'token') return json(res, 200, await operations.setToken(body.token))
          if (action === 'imap-auth') return json(res, 200, await operations.setImapAuth(body.auth))
          if (action === 'revoke') return json(res, 200, await operations.revoke())
          if (action === 'secret') return json(res, 200, await operations.generateSecret())
          if (action === 'secret-reveal') return json(res, 200, await operations.revealSecret())
          if (action === 'probe') return json(res, 200, await operations.probe())
          if (action === 'ping') return json(res, 200, await operations.ping())
          if (action === 'relay-tick') return json(res, 200, await operations.relayTick())
          if (action === 'relay-start') return json(res, 200, await operations.relayStart())
          if (action === 'relay-stop') return json(res, 200, await operations.relayStop())
          if (action === 'outbox-retry') return json(res, 200, await operations.outboxRetry(body.id))
          if (action === 'send-file') return json(res, 200, await operations.sendFile(body.path, body))
          if (action === 'state') return json(res, 200, await operations.state())
          return json(res, 404, { ok: false, reason: `未知的鸿驿操作：${action || '(空)'}` })
        }
        // A GET on an action name is a caller bug (side effects must not ride GET);
        // answer with the exact hint instead of a bare 405.
        if (ACTIONS_POST_ONLY.includes(action)) {
          return json(res, 405, { ok: false, reason: `「${action}」必须用 POST 调用（GET 只读 state/doctor/relay/outbox/tasks/commands/inbox）` })
        }
        return json(res, 404, { ok: false, reason: `未知的鸿驿操作：${action || '(空)'}` })
      } catch (error) {
        return json(res, 500, { ok: false, reason: error?.message ?? String(error) })
      }
    }
  /**
   * Every host service is resolved through `ctx.inject([...], cb)`. Cordis only
   * answers `ctx.<name>` for a fiber that declared that name in its inject list;
   * a bare `ctx.webServer` throws `cannot get property "webServer" without inject`
   * and fails the whole entry (exactly how this plugin first failed to activate).
   * `inject` returns the child fiber, so `track` can release it with its route.
   */
  track(() => ctx.inject(['webServer'], (webCtx) => {
    /**
     * 记下本机 origin，任务监测才能去问 `/bgjobs/state`
     * （bgjobs 与本插件共用同一个 webServer，不需要知道端口号）。
     * getOrigin() 在 listen 之前会抛，所以试一下兜底为空 —— 采集器会自动退回磁盘扫描。
     */
    try {
      taskEnv.origin = webCtx.webServer.getOrigin()
    } catch {
      taskEnv.origin = ''
    }
    return webCtx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
  }))

  track(() => ctx.inject(['commands'], (cmdCtx) => cmdCtx.commands.register({
      name: 'hongyi',
      description: '鸿驿：查看/测试 DSH 与云端信箱的链路，并控制中转（status | ping | probe | doctor | relay | relay-tick | outbox | tasks | commands | secret）',
      input: { hint: 'status | ping | probe | doctor | relay | relay-tick | relay-start | relay-stop | outbox | tasks | secret' },
      handler: async (invocation) => {
        const sub = String(invocation.rawInput ?? '').trim().split(/\\s+/)[0] || 'status'
        try {
          if (sub === 'ping') {
            const result = await operations.ping()
            return { kind: result.ok ? 'success' : 'error', text: `鸿驿 ping：${result.message}` }
          }
          if (sub === 'probe') {
            const result = await operations.probe()
            return {
              kind: result.ok ? 'success' : 'error',
              text: `鸿驿 测试连接：${result.ok ? '✔' : '✘'} ${result.message}${result.latencyMs ? `（${result.latencyMs}ms）` : ''}`,
            }
          }
          if (sub === 'doctor') {
            const report = await operations.doctor()
            const lines = report.checks.map((c) => `${c.ok ? '✔' : '✘'} ${c.label}：${c.detail}`)
            return { kind: report.ok ? 'success' : 'error', text: ['鸿驿自检：', ...lines].join('\n') }
          }
          if (sub === 'relay-tick') {
            const result = await operations.relayTick()
            const decision = result.up?.decision ? `${result.up.decision.reason}` : '未发送'
            return {
              kind: result.ok ? 'success' : 'error',
              text: `鸿驿 立即同步：${result.ok ? '✔' : '✘'} 上行 ${decision}，下行 ${result.down?.handled ?? 0} 条${result.reason ? `（${result.reason}）` : ''}`,
            }
          }
          if (sub === 'relay-start') {
            const result = await operations.relayStart()
            return { kind: result.ok ? 'success' : 'error', text: result.ok ? '鸿驿 中转已恢复上行' : `鸿驿 中转启动失败：${result.reason}` }
          }
          if (sub === 'relay-stop') {
            const result = await operations.relayStop()
            return { kind: result.ok ? 'success' : 'error', text: result.ok ? '鸿驿 中转已暂停上行（下行仍在轮询）' : `鸿驿 中转暂停失败：${result.reason}` }
          }
          if (sub === 'outbox') {
            const result = await operations.outbox()
            if (!result.ok) return { kind: 'error', text: `鸿驿 队列不可读：${result.reason}` }
            const head = (result.entries ?? []).slice(0, 5).map((e) => `  ${e.state} ${e.type} ${e.id}${e.lastError ? `（${e.lastError}）` : ''}`)
            return {
              kind: 'success',
              text: [
                `鸿驿 外发队列：待发 ${result.stats.pending} / 暂停 ${result.stats.parked} / 共 ${result.stats.total}`,
                result.stats.nextAttemptAt ? `下次重试：${result.stats.nextAttemptAt}` : '下次重试：无',
                ...head,
              ].join('\n'),
            }
          }
          if (sub === 'commands') {
            const result = await operations.commands(20)
            if (!result.ok) return { kind: 'error', text: '鸿驿 指令流水不可读' }
            const lines = result.entries.slice(0, 10).map((e) => `${e.ok ? '✔' : '✘'} ${new Date(e.ts ?? 0).toLocaleString('zh-CN')} ${e.id ?? ''}：${String(e.detail).split('\n')[0]}`)
            return {
              kind: 'success',
              text: [`鸿驿 手机指令流水（最近 ${result.entries.length} 条）：`, ...lines].join('\n'),
            }
          }
          if (sub === 'secret') {
            const result = await operations.revealSecret()
            return {
              kind: result.ok ? 'success' : 'error',
              text: result.ok ? `鸿驿 设备密钥：${result.deviceSecret}` : `鸿驿：${result.message}`,
            }
          }
          if (sub === 'relay') {
            const result = await operations.relay()
            if (!result.ok) return { kind: 'error', text: `鸿驿 中转：${result.reason}` }
            return {
              kind: 'success',
              text: [
                `鸿驿 中转：${result.running ? '运行中' : '已停止'}${result.paused ? '（上行已暂停）' : ''}，间隔 ${result.intervalMs ?? '—'}ms`,
                `已发 ${result.status.sent} 条 / 已收 ${result.status.received} 条 / 已执行 ${result.status.executed} 条 / 幂等跳过 ${result.status.skippedDuplicate} 条`,
                `待发 ${result.outbox.pending} / 暂停 ${result.outbox.parked} / 待云端解析 ${result.needsModel}`,
                result.status.lastTickError ? `最近错误：${result.status.lastTickError}` : '最近错误：无',
              ].join('\n'),
            }
          }
          const state = await operations.state()
          return {
            kind: 'success',
            text: [
              `鸿驿 v${state.version}（协议 v${state.protocol}，Phase ${state.phase}）`,
              `驱动：${state.config.driver}　信箱：${state.config.baseUrl}　BOX：${state.config.box}`,
              `令牌：${state.credentials.tokenSet ? state.credentials.token : '未设置'}　设备密钥：${state.credentials.deviceSecretSet ? '已设置' : '未设置'}`,
              `目录：${state.home}`,
            ].join('\n'),
          }
        } catch (error) {
          return { kind: 'error', text: `鸿驿命令失败：${error?.message ?? String(error)}` }
        }
      },
    })))

  /**
   * Start the relay. `enabled` in the config is the user's switch; when it is
   * false the engine still exists (so the card can show its state and the user can
   * start it by hand) but no timer is armed.
   */
  loadConfig()
    .then((current) => {
      /**
       * 任务监测的搜索范围：配置里显式给了就只扫那些目录；没给就扫 DSH 的当前
       * 工作目录（大多数 bgjob 都提交在会话工作区里）。扫不到也不要紧 ——
       * 优先走的还是本机 `/bgjobs/state`，磁盘扫描只是兜底。
       */
      const configured = Array.isArray(current.tasks?.workdirs) ? current.tasks.workdirs.filter(Boolean) : []
      taskEnv.workdirs = configured.length > 0 ? configured : [process.cwd()]
      taskEnv.stallAfterSec = Number(current.tasks?.stallAfterSec ?? 180)
      taskEnv.recentLimit = Number(current.tasks?.recentLimit ?? 5)
      if (current.enabled === false) {
        warn('[hongyi] config.enabled=false：中转未启动（可在设置卡片里开启）')
        return
      }
      const info = relay.start(current.relay?.intervalMs ?? 15000)
      const where = current.driver === 'imap'
        ? `${current.imapUser || '（未填邮箱）'} 草稿箱（静默通道）`
        : `${current.baseUrl}/${current.box}`
      warn(`[hongyi] 中转已启动，间隔 ${info.intervalMs}ms，驱动 ${current.driver} → ${where}`)
    })
    .catch((error) => {
      warn(`[hongyi] 读取配置失败，中转未启动：${error?.message ?? error}`)
    })

  return () => {
    // Stop the timer before releasing anything else: a tick must never fire
    // against a route or a client that is being torn down.
    try {
      relay.stop()
    } catch {
      /* stopping an already-stopped relay is fine */
    }
    for (const dispose of loose.splice(0)) {
      try {
        dispose()
      } catch {
        /* disposal is best-effort */
      }
    }
  }
}

export { MailboxClient, createOperations }
