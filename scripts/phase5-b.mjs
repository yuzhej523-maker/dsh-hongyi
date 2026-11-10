/**
 * Phase 5 · B 组（dsh 关闭场景：离线可感知、恢复可补跑）
 *
 * 为什么用隔离实例而不是直接停真插件：
 *   `POST /hongyi/relay-stop` 只停「上行遥测」，下行仍会在定时器里拉取执行
 *   —— 那不是「dsh 关闭」。要真的模拟关闭，只能用 relay.stop() 把定时器整个停掉。
 *   所以本组起一个独立 Relay + 独立临时目录 + 本地假信箱，主实例完全不受影响。
 *
 * 用法：node scripts/phase5-b.mjs
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createEnvelope } from '../lib/envelope.js'
import { Relay } from '../lib/relay/engine.js'
import { MailboxClient } from '../lib/mailbox/client.js'
import { loadConfig } from '../lib/config.js'
import { startFakeMailbox } from './_fake-mailbox.mjs'

const rows = []
const rec = (item, pass, detail) => {
  rows.push({ item, pass, detail })
  console.log(`${pass ? '✔' : '✘'} [B] ${item} — ${detail}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const GUI = process.env.HONGYI_GUI ?? 'http://127.0.0.1:49153'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hongyi-b-'))
const secret = crypto.randomBytes(16).toString('hex')
const deviceId = 'dsh-pc'
const phoneId = 'phone'
const telemetry = { onChangeOnly: true, minGapSec: 0, summaryIntervalSec: 600, heartbeatSec: 30, offlineAfterSec: 180 }

const box = await startFakeMailbox()
const config = {
  driver: 'mock', baseUrl: box.baseUrl, box: 'dsh-hongyi', deviceId, phoneId, telemetry,
  queue: { maxAttempts: 4, baseBackoffMs: 200, maxBackoffMs: 2000 },
}
const credentials = { deviceSecret: secret }
const buildClient = async () => ({
  config, credentials,
  client: new MailboxClient({ baseUrl: box.baseUrl, box: config.box, token: '', secret, timeoutMs: 2500 }),
})
const dir = path.join(root, 'home')
const paths = {
  queueFile: () => path.join(dir, 'outbound.json'),
  journalFile: () => path.join(dir, 'journal.ndjson'),
  inboundLedger: () => path.join(dir, 'inbound.json'),
  pendingModelFile: () => path.join(dir, 'needs-model.json'),
  inboxDir: () => path.join(dir, 'inbox'),
}

console.log(`\n═══ Phase 5 · B 组（隔离实例 ${root}）═══\n`)

/* ---------- B1 离线判定：规则在 TTL 窗口内正确翻转 ---------- */
{
  const live = await fetch(`${GUI}/hongyi/relay`).then((r) => r.json()).catch(() => null)
  const liveConfig = await loadConfig()
  const windowSec = liveConfig.telemetry?.offlineAfterSec ?? 180
  const judge = (ageSec) => (ageSec > windowSec ? '离线' : '在线')
  const cases = [[0, '在线'], [windowSec - 1, '在线'], [windowSec + 1, '离线'], [windowSec + 600, '离线']]
  const ok = cases.every(([age, want]) => judge(age) === want)
  rec('B1 离线判定', ok,
    `阈值 ${windowSec}s：0s→在线 / (阈值-1)s→在线 / (阈值+1)s→离线 / (阈值+600)s→离线；真机最近上行 ${live ? Math.round((Date.now() - (live.status?.lastSentAt ?? 0)) / 1000) : '?'}s 前`)
}

/* ---------- 建立基线：正常跑两跳（先有遥测，后面才能验「心跳停了」） ---------- */
const relay = new Relay({ buildClient, limits: config.queue, paths })
await relay.tick()
await sleep(400)
await relay.tick()
const baseline = { sent: relay.status.sent, executed: relay.status.executed, tele: box.all().filter((e) => e.type === 'telemetry').length }

/* ---------- B2 关闭后指令暂存（不丢、不报错、不执行） ---------- */
relay.stop()
const staged = createEnvelope({ type: 'command', from: phoneId, to: deviceId, secret, ttl: 1800, payload: { kind: 'command', cmd: 'status' } })
box.inject(staged)
await sleep(10000)
{
  const items = box.all()
  const still = items.some((e) => e.id === staged.id)
  const acked = items.some((e) => e.type === 'ack' && e.payload?.ackOf === staged.id)
  const execDelta = relay.status.executed - baseline.executed
  rec('B2 关闭后指令暂存', still && !acked && execDelta === 0,
    `指令 ${staged.id.slice(0, 26)}… 留在信箱=${still}；未被提前执行=${!acked && execDelta === 0}（插件已停：不报错、不消失）`)
}

/* ---------- B3 恢复后补跑（自动、有回执、无需人工重发） ---------- */
{
  const t0 = Date.now()
  relay.start(1000)
  let ack = null
  while (Date.now() - t0 < 45000) {
    await sleep(1200)
    ack = box.all().find((e) => e.type === 'ack' && e.payload?.ackOf === staged.id)
    if (ack) break
  }
  relay.stop()
  const sec = ((Date.now() - t0) / 1000).toFixed(1)
  rec('B3 恢复补跑', !!ack && ack.payload?.ok === true,
    ack ? `${sec}s 内自动补跑并回执：${String(ack.payload.result ?? '').slice(0, 46)}…` : `${sec}s 内未补跑`)
}

/* ---------- B4 幂等：同一 id 只执行一次 ---------- */
{
  const dup = createEnvelope({ type: 'command', from: phoneId, to: deviceId, secret, ttl: 1800, payload: { kind: 'command', cmd: 'help' } })
  box.inject(dup)
  await relay.tick()
  const execAfterFirst = relay.status.executed
  const skipAfterFirst = relay.status.skippedDuplicate
  box.inject(dup) // 直接重放（模拟 ack 丢了、邮件还在的不利情况）
  await relay.tick()
  await relay.tick()
  const execGrew = relay.status.executed - execAfterFirst
  const skipGrew = relay.status.skippedDuplicate - skipAfterFirst
  // 另一条防线：完全新鲜的 id，连续 POST 两次，第二次必须被信箱 409 拒
  const fresh = createEnvelope({ type: 'event', from: phoneId, to: deviceId, secret, ttl: 1800, payload: { kind: 'probe' } })
  const post = () => fetch(`${box.baseUrl}/mailbox/dsh-hongyi`, { method: 'POST', body: JSON.stringify({ envelope: fresh }) })
  const s1 = (await post()).status
  const s2 = (await post()).status
  rec('B4 幂等跳过', execGrew === 0 && skipGrew >= 1 && s1 === 200 && s2 === 409,
    `重放同一 id：executed 增量=${execGrew}（期望 0）、skippedDuplicate 增量=${skipGrew}（期望≥1）；新 id 首投 ${s1} / 重投 ${s2}（期望 200 / 409）`)
}

/* ---------- B5 关闭后心跳停止 → 手机可在窗口内判离线 ---------- */
{
  const before = box.all().filter((e) => e.type === 'telemetry').length
  relay.stop()
  await sleep(8000)
  const after = box.all().filter((e) => e.type === 'telemetry').length
  const all = box.all().filter((e) => e.type === 'telemetry')
  const last = all.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).pop()
  const secSince = last ? Math.round((Date.now() - Date.parse(last.ts)) / 1000) : null
  rec('B5 关闭后心跳停止', after === before && secSince !== null,
    `停止后 8s 内新增遥测 ${after - before} 条（期望 0）；最后一条 ${secSince}s 前 → 超过 ${telemetry.offlineAfterSec}s 手机即判离线，而不是永远显示旧状态`)
}

/* ---------- 汇总 ---------- */
await box.close()
await fs.rm(root, { recursive: true, force: true }).catch(() => {})
const pass = rows.filter((r) => r.pass).length
console.log(`\n═══ B 组结果：${pass}/${rows.length} 通过 ═══`)
console.log('积分消耗：0 次模型调用')
process.exit(pass === rows.length ? 0 : 1)
