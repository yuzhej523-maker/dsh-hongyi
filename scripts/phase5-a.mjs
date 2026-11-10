/**
 * Phase 5 · A 组（正常场景，dsh 运行中）
 * 遥测上报 / 指令下发 / 双向文件传输 / 长任务期间指令不丢
 * 用法：node scripts/phase5-a.mjs
 */
import { createMailbox } from '../lib/mailbox/factory.js'
import { createEnvelope, validateEnvelope } from '../lib/envelope.js'
import { loadConfig, loadCredentials } from '../lib/config.js'
import { paths } from '../lib/paths.js'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'

const GUI = process.env.HONGYI_GUI ?? 'http://127.0.0.1:49153'
const rows = []
const rec = (item, pass, detail) => {
  rows.push({ item, pass, detail })
  console.log(`${pass ? '✔' : '✘'} [A] ${item} — ${detail}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function api(p, init) {
  const r = await fetch(GUI + p, init)
  return { status: r.status, json: await r.json().catch(() => null) }
}
const post = (p, body) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })

const config = await loadConfig()
const credentials = await loadCredentials()
const mailbox = createMailbox(config, credentials)

/** 关键：IMAP 驱动的 pull() 返回数组，HTTP 驱动返回 {items}，这里统一。 */
async function pullAll(limit = 150) {
  const r = await mailbox.pull({ limit })
  const arr = Array.isArray(r) ? r : (r?.items ?? [])
  return arr.map((i) => i?.envelope ?? i).filter((e) => e && e.id)
}

console.log(`\n═══ Phase 5 · A 组 ═══`)
console.log(`driver=${config.driver}  GUI=${GUI}\n`)

// ---------- A1 遥测上报 ----------
// 注意：本机同时在跑后台任务（bgjobs），任务签名每跳都可能变，所以「无变化不发」在这里
// 没法当干净对照 —— 那条规则由 smoke-phase2 的 decide() 单测覆盖（五种 reason 全断言）。
// 这里只验端到端：遥测真的到了信箱、字段完整、签名可验、状态变化时会立即补发。
{
  const s0 = (await api('/hongyi/relay')).json.status.sent
  const r = await sendCmd({ kind: 'command', cmd: 'status' })
  await sleep(1500)
  await post('/hongyi/relay-tick', {})
  await sleep(1500)
  const s1 = (await api('/hongyi/relay')).json.status.sent
  const reacted = s1 > s0

  const all = await pullAll()
  const tele = all.filter((e) => e.type === 'telemetry')
  const newest = tele[tele.length - 1]
  let sigOk = false
  let sigErr = ''
  try { if (newest) { validateEnvelope(newest, credentials.deviceSecret); sigOk = true } } catch (e) { sigErr = String(e?.message ?? e) }
  const snap = newest?.payload?.snapshot
  const fields = ['online', 'driver', 'box', 'queuePending', 'lastCommand']
  const complete = !!snap && fields.every((f) => f in snap)
  rec('A1 遥测上报', reacted && tele.length > 0 && sigOk && complete,
    `指令执行后状态变化 → 立即补发（sent ${s0}→${s1}）；信箱内 telemetry ${tele.length} 条；` +
    `最新一条验签${sigOk ? '通过' : '失败 ' + sigErr}；快照字段完整=${complete}（${fields.join('/')}）`)
}

// ---------- 指令下发 ----------
async function sendCmd(payload, timeoutSec = 110) {
  const env = createEnvelope({ type: 'command', from: config.phoneId, to: config.deviceId, secret: credentials.deviceSecret, ttl: 900, payload })
  await mailbox.put(env)
  const t0 = Date.now()
  let ack = null
  while (Date.now() - t0 < timeoutSec * 1000) {
    await sleep(3000)
    const all = await pullAll()
    ack = all.find((e) => e.type === 'ack' && e.payload?.ackOf === env.id)
    if (ack) return { id: env.id, ack, sec: ((Date.now() - t0) / 1000).toFixed(1) }
  }
  return { id: env.id, ack: null, sec: ((Date.now() - t0) / 1000).toFixed(1) }
}

{
  const r = await sendCmd({ kind: 'command', cmd: 'status' })
  rec('A2a 指令 status', !!r.ack && r.ack.payload?.ok === true,
    r.ack ? `${r.sec}s 回执 ok=true：${String(r.ack.payload.result ?? '').slice(0, 56)}…` : `${r.sec}s 超时（${r.id}）`)
}
{
  const r = await sendCmd({ kind: 'command', cmd: 'tasks' })
  rec('A2b 指令 tasks', !!r.ack && r.ack.payload?.ok === true,
    r.ack ? `${r.sec}s 回执首行「${String(r.ack.payload.result ?? '').split('\n')[0]}」` : `${r.sec}s 超时（${r.id}）`)
}
{
  const r = await sendCmd({ kind: 'command', cmd: 'help' })
  rec('A2c 指令 help', !!r.ack && r.ack.payload?.ok === true,
    r.ack ? `${r.sec}s 回执「${String(r.ack.payload.result ?? '').slice(0, 40)}…」` : `${r.sec}s 超时（${r.id}）`)
}
{
  const s = await sendCmd({ kind: 'command', cmd: 'stop' })
  const st = await sendCmd({ kind: 'command', cmd: 'start' })
  const ok = !!s.ack && s.ack.payload?.ok === true && !!st.ack && st.ack.payload?.ok === true
  rec('A2d 指令 stop/start', ok, `stop ok=${s.ack?.payload?.ok === true}，start ok=${st.ack?.payload?.ok === true}（顺序执行互不吞）`)
}
{
  // download 目标用活实例自己的 /hongyi/state（一定可达），且顺带验证
  // 「目标不可达时也要回执」——用 joker 端口各测一次。
  const okUrl = `${GUI}/hongyi/state`
  const r = await sendCmd({ kind: 'command', cmd: 'download', arg: okUrl })
  const badUrl = 'http://127.0.0.1:1/nope'
  const r2 = await sendCmd({ kind: 'command', cmd: 'download', arg: badUrl })
  const ok = !!r.ack && r.ack.payload?.ok === true
  const ok2 = !!r2.ack && r2.ack.payload?.ok === false
  rec('A2e 指令 download', ok && ok2,
    `可达：${r.ack ? `${r.sec}s ok=${r.ack.payload?.ok}` : `${r.sec}s 超时`}；不可达：${r2.ack ? `${r2.sec}s ok=${r2.ack.payload?.ok}（${String(r2.ack.payload?.result ?? r2.ack.payload?.error ?? '').slice(0, 40)}）` : `${r2.sec}s 超时`}`)
}

// ---------- A3 双向文件传输 ----------
{
  const dir = paths.inboxDir()
  const before = await fs.readdir(dir).catch(() => [])
  const body = `Phase 5 A 组文件传输\n${new Date().toISOString()}\n${crypto.randomBytes(8).toString('hex')}\n`
  const src = 'D:/hongyi-build/phase5-a.txt'
  await fs.writeFile(src, body, 'utf8')
  const want = crypto.createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex')

  const r1 = await post('/hongyi/send-file', { path: src })
  rec('A3a 文件 PC→手机', r1.json?.ok === true && r1.json?.sha256 === want,
    `tid=${r1.json?.tid ?? '-'} ${r1.json?.total ?? '-'} 片，sha256 与源一致=${r1.json?.sha256 === want}`)

  const buf = Buffer.from(body, 'utf8')
  const chunk = 128 * 1024
  const tid = `file_p5a_${crypto.randomBytes(4).toString('hex')}`
  const total = Math.ceil(buf.length / chunk)
  for (let i = 0; i < total; i++) {
    await mailbox.put(createEnvelope({
      type: 'file', from: config.phoneId, to: config.deviceId, secret: credentials.deviceSecret, ttl: 1800,
      payload: { kind: 'file', tid, name: 'phase5-from-phone.txt', size: buf.length, sha256: want, idx: i, total, data: buf.subarray(i * chunk, (i + 1) * chunk).toString('base64') },
    }))
  }
  let got = null
  for (let i = 0; i < 18; i++) {
    await sleep(5000)
    const now = await fs.readdir(dir).catch(() => [])
    const fresh = now.filter((f) => !before.includes(f) && f.includes('phase5-from-phone'))
    if (fresh.length) { got = fresh[0]; break }
  }
  let recvOk = false
  if (got) {
    const data = await fs.readFile(`${dir}/${got}`)
    recvOk = crypto.createHash('sha256').update(data).digest('hex') === want
  }
  rec('A3b 文件 手机→PC', recvOk, got ? `收到 ${got}，sha256 与源一致=${recvOk}` : '90s 内未收到完整文件')
}

// ---------- A4 长任务期间新指令不丢 ----------
{
  const big = 'D:/hongyi-build/phase5-big.bin'
  await fs.writeFile(big, crypto.randomBytes(384 * 1024))
  const fileP = post('/hongyi/send-file', { path: big, chunkBytes: 32 * 1024 })
  await sleep(120)
  const cmdP = sendCmd({ kind: 'command', cmd: 'status' }, 110)
  const [f, c] = await Promise.all([fileP, cmdP])
  rec('A4 长任务期间指令不丢', f.json?.ok === true && c.ack?.payload?.ok === true,
    `文件 ${f.json?.total ?? '-'} 片发送${f.json?.ok ? '成功' : '失败'}；期间 status ${c.ack ? `${c.sec}s 正常回执` : '丢失'}`)
}

const pass = rows.filter((r) => r.pass).length
console.log(`\n═══ A 组结果：${pass}/${rows.length} 通过 ═══`)
console.log('积分消耗：0 次模型调用（IMAP + 本地 HTTP）')
process.exit(pass === rows.length ? 0 : 1)
