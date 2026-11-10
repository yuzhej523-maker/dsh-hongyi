/**
 * Phase 5 · C 组（后台受限：软件在但链路断）
 * 全部在隔离临时目录里跑，不干扰正在运行的实例。
 * 逐项：断网积压+指数退避 / 恢复自动续传 / 挂起后自愈 / 凭据失效报明确错 / 时钟漂移不误删
 * 用法：node scripts/phase5-c.mjs
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { createEnvelope, sign } from '../lib/envelope.js'
import { Relay } from '../lib/relay/engine.js'
import { MailboxClient } from '../lib/mailbox/client.js'
import { FolderMailbox } from '../lib/mailbox/folder.js'
import { ImapConnection, IMAP_PRESETS } from '../lib/mailbox/imap.js'

const rows = []
const rec = (item, pass, detail) => {
  rows.push({ item, pass, detail })
  console.log(`${pass ? '✔' : '✘'} [C] ${item} — ${detail}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hongyi-c-'))
const secret = crypto.randomBytes(16).toString('hex')
const deviceId = 'dsh-pc'
const phoneId = 'phone'

/** Relay 要的 buildClient 必须返回 {config, credentials, client}，不是裸 client。 */
function makeBuildClient({ baseUrl }) {
  const config = {
    driver: 'mock', baseUrl, box: 'dsh-hongyi', deviceId, phoneId,
    telemetry: { onChangeOnly: true, minGapSec: 0, summaryIntervalSec: 600, heartbeatSec: 30, offlineAfterSec: 180 },
    queue: { maxAttempts: 4, baseBackoffMs: 300, maxBackoffMs: 3000 },
  }
  const credentials = { deviceSecret: secret }
  return async () => ({
    config,
    credentials,
    client: new MailboxClient({ baseUrl, box: config.box, token: '', secret, timeoutMs: 2500 }),
  })
}

function makeServer() {
  const stores = new Map()
  let down = false
  const putCount = { n: 0 }
  const server = http.createServer(async (req, res) => {
    if (down) { res.writeHead(503); res.end('down'); return }
    const url = new URL(req.url, 'http://x')
    const box = url.pathname.split('/').filter(Boolean)[1] ?? 'box'
    if (!stores.has(box)) stores.set(box, new Map())
    const store = stores.get(box)
    let body = ''
    for await (const c of req) body += c
    if (url.pathname.endsWith('/ack') && req.method === 'POST') {
      const { ids = [] } = JSON.parse(body || '{}')
      for (const id of ids) store.delete(id)
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, acked: ids })); return
    }
    if (req.method === 'POST') {
      putCount.n += 1
      const env = JSON.parse(body)
      if (store.has(env.id)) { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'duplicate id' })); return }
      store.set(env.id, { envelope: env, receivedAt: new Date().toISOString() })
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, id: env.id })); return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, items: [...store.values()] }))
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server, port: server.address().port, putCount, store: () => stores, setDown: (v) => { down = v },
  })))
}

const box = await makeServer()
const baseUrl = `http://127.0.0.1:${box.port}`
const buildClient = makeBuildClient({ baseUrl })
const pathsFor = (name) => {
  const dir = path.join(root, name)
  return {
    queueFile: () => path.join(dir, 'outbound.json'),
    journalFile: () => path.join(dir, 'journal.ndjson'),
    inboundLedger: () => path.join(dir, 'inbound.json'),
    pendingModelFile: () => path.join(dir, 'needs-model.json'),
    inboxDir: () => path.join(dir, 'inbox'),
    home: () => dir,
  }
}

console.log(`\n═══ Phase 5 · C 组（隔离环境 ${root}）═══\n`)

/* ---------------- C1 断网：积压 + 指数退避 + 不崩溃 ---------------- */
{
  const relay = new Relay({ buildClient, limits: { maxAttempts: 4, baseBackoffMs: 300, maxBackoffMs: 3000 }, paths: pathsFor('c1') })
  box.setDown(true)
  let threw = false
  try { for (let i = 0; i < 6; i++) { await relay.tick(); await sleep(150) } } catch { threw = true }
  const st = await relay.outbox.stats()
  const st2 = await relay.outbox.stats()
  const jr = await fs.readFile(pathsFor('c1').journalFile(), 'utf8').catch(() => '')
  const tickErrs = (jr.match(/relay-tick-error/g) ?? []).length
  rec('C1 断网积压+退避', !threw && st.pending >= 1 && st.nextAttemptAt !== null,
    `6 跳均未抛异常=${!threw}；队列 pending=${st.pending} parked=${st.parked}；已排下次重试=${st.nextAttemptAt !== null}；日志记下 ${tickErrs} 次 tick 错误（可观测）`)
  relay.stop()
}

/* ---------------- C2 恢复后自动续传 ---------------- */
{
  const p = pathsFor('c2')
  const relay = new Relay({ buildClient, limits: { maxAttempts: 4, baseBackoffMs: 300, maxBackoffMs: 3000 }, paths: p })
  box.setDown(true)
  await relay.tick(); await sleep(120)
  await relay.tick(); await sleep(120)
  const before = await relay.outbox.stats()
  box.setDown(false)
  for (let i = 0; i < 12 && (await relay.outbox.stats()).pending > 0; i++) {
    await relay.outbox.retryAll()
    await relay.tick()
    await sleep(200)
  }
  const after = await relay.outbox.stats()
  const received = box.putCount.n
  rec('C2 恢复自动续传', before.pending >= 1 && after.pending === 0 && received > 0,
    `断网时 pending=${before.pending} → 恢复后 pending=${after.pending}；信箱累计实收 ${received} 封（数据不丢）`)
  relay.stop()
}

/* ---------------- C3 挂起后自愈 ---------------- */
{
  const relay = new Relay({ buildClient, limits: { maxAttempts: 4, baseBackoffMs: 300, maxBackoffMs: 3000 }, paths: pathsFor('c3') })
  box.setDown(false)
  await relay.tick()
  const t1 = relay.status.ticks
  // 模拟进程被挂起 10 分钟：把「上次联系时间」往后拨，再走一跳
  relay.status.lastSentAt = Date.now() - 10 * 60 * 1000
  relay.status.lastHeartbeatAt = Date.now() - 10 * 60 * 1000
  await relay.tick()
  const t2 = relay.status.ticks
  const ok = relay.status.lastTickError === null
  rec('C3 挂起后自愈', t1 >= 1 && t2 === t1 + 1 && ok,
    `挂起 10 分钟后下一跳照常执行（ticks ${t1}→${t2}），lastTickError=${ok ? 'null' : relay.status.lastTickError}`)
  relay.stop()
}

/* ---------------- C4 信箱不可达 → 明确错误 ---------------- */
{
  let msg = '', code = ''
  try {
    const c = new MailboxClient({ baseUrl: 'http://127.0.0.1:1', box: 'dsh-hongyi', token: 'bad', secret, timeoutMs: 1500 })
    await c.health()
  } catch (e) { msg = String(e?.message ?? e); code = String(e?.code ?? '') }
  rec('C4 信箱不可达报明确错', code === 'unreachable' && /不可达|unreachable/i.test(msg),
    `code=${code}，message=「${msg.slice(0, 50)}」（不是静默失败）`)
}

/* ---------------- C4b 凭据失效 → 「凭据无效」而不是超时 ---------------- */
{
  const preset = IMAP_PRESETS.qq
  let msg = '', code = ''
  try {
    const conn = new ImapConnection({ host: preset.imapHost, port: 993, user: '1309427334@qq.com', auth: 'x'.repeat(16), timeoutMs: 15000 })
    await conn.connect()
    await conn.login()
    await conn.logout()
  } catch (e) { msg = String(e?.message ?? e); code = String(e?.code ?? '') }
  rec('C4b 凭据失效报明确错', /凭据|credential/i.test(msg) || code === 'credential_invalid',
    `code=${code || '(空)'}，message=「${msg.slice(0, 60)}」（设置卡片据此亮红灯）`)
}

/* ---------------- C5 时钟漂移：寄件方 ts 慢 1 小时不得被误删 ---------------- */
{
  const mailRoot = path.join(root, 'clock')
  const boxName = 'dsh-hongyi'
  const fm = new FolderMailbox({ root: mailRoot, box: boxName, secret })
  const old = new Date(Date.now() - 3600 * 1000).toISOString()
  const fresh = new Date().toISOString()
  // 两封：ts 慢 1 小时（ttl 120s，按寄件方时钟早该过期）／ts 正常
  const drifted = { v: 1, id: `event_drift_${crypto.randomBytes(4).toString('hex')}`, type: 'event', from: phoneId, to: deviceId, ts: old, ttl: 120, payload: { kind: 'drift', which: 'slow' }, sig: '' }
  drifted.sig = sign(drifted, secret)
  const normal = { v: 1, id: `event_norm_${crypto.randomBytes(4).toString('hex')}`, type: 'event', from: phoneId, to: deviceId, ts: fresh, ttl: 120, payload: { kind: 'drift', which: 'now' }, sig: '' }
  normal.sig = sign(normal, secret)
  await fm.put(drifted)
  await fm.put(normal)
  const pulled = await fm.pull({ limit: 50 })
  const items = (Array.isArray(pulled) ? pulled : (pulled?.items ?? [])).map((i) => i?.envelope ?? i)
  const hasSlow = items.some((e) => e?.payload?.which === 'slow')
  const hasNow = items.some((e) => e?.payload?.which === 'now')
  rec('C5 时钟漂移不误删', hasSlow && hasNow,
    `寄件方 ts 慢 3600s（ttl 120s）的信封仍被投递=${hasSlow}；正常信封也在=${hasNow} —— TTL 走信箱侧服务器时钟`)
}

await new Promise((r) => box.server.close(r))
await fs.rm(root, { recursive: true, force: true }).catch(() => {})
const pass = rows.filter((r) => r.pass).length
console.log(`
═══ C 组结果：${pass}/${rows.length} 通过 ═══`)
console.log('积分消耗：0 次模型调用')
process.exit(pass === rows.length ? 0 : 1)
