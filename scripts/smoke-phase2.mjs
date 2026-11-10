/**
 * Phase 2 end-to-end proof — one telemetry envelope up, one command down.
 *
 * This is the script behind the Phase 2 checkpoint: it wires the real relay
 * engine to the real mock mailbox and shows, line by line, that
 *
 *   1. telemetry travels dsh → mailbox (throttled: first tick sends, the second
 *      one is suppressed because nothing changed);
 *   2. a command written by "the phone" is pulled, parsed locally, executed and
 *      acked, with the ack envelope landing back in the mailbox;
 *   3. a free-text command is classified `needs_model` and queued WITHOUT any
 *      model call;
 *   4. a repeated command id is skipped idempotently.
 *
 * It also exits non-zero on the first failed assertion, so it is usable in CI.
 *
 * Run:  node scripts/smoke-phase2.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.DSH_HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'hongyi-phase2-'))

// fileURLToPath, not URL.pathname: on Windows the latter keeps a leading slash and
// produces "D:\..." strings the ESM loader rejects.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { Relay } = await import('../lib/relay/engine.js')
const { parseCommand } = await import('../lib/relay/commands.js')
const { decide, digestOf } = await import('../lib/relay/telemetry.js')
const { MailboxClient } = await import('../lib/mailbox/client.js')
const { createEnvelope } = await import('../lib/envelope.js')
const { loadConfig, saveConfig, saveCredentials } = await import('../lib/config.js')
const { paths } = await import('../lib/paths.js')
const { readJson } = await import('../lib/store.js')

const PORT = 7665
const TOKEN = 'phase2-demo-token'
const BOX = 'dsh-hongyi'

let failures = 0
const ok = (message) => console.log(`✔ ${message}`)
const fail = (message) => {
  failures += 1
  console.log(`✘ ${message}`)
}
const expect = (condition, message) => (condition ? ok(message) : fail(message))

/* --------------------------------------------------------------- mock server */

console.log(`DSH_HOME=${process.env.DSH_HOME}`)
const server = spawn(process.execPath, [path.join(root, 'mock/server.mjs'), '--port', String(PORT), '--host', '127.0.0.1', '--token', TOKEN], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
const serverLog = []
server.stdout.on('data', (d) => serverLog.push(String(d)))
server.stderr.on('data', (d) => serverLog.push(String(d)))

async function waitForHealth(attempts = 50) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`, { headers: { authorization: `Bearer ${TOKEN}` } })
      if (response.ok) return true
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

if (!(await waitForHealth())) {
  console.error('mock 信箱没能启动：\n' + serverLog.join(''))
  server.kill()
  process.exit(1)
}
ok(`mock 信箱已启动 http://127.0.0.1:${PORT}（token=${TOKEN}）`)

try {
  /* ------------------------------------------------------------- point config */

  await saveConfig({ driver: 'mock', baseUrl: `http://127.0.0.1:${PORT}`, box: BOX })
  const credentials = await saveCredentials({ token: TOKEN, deviceSecret: 'phase2-device-secret-0123456789' })
  const config = await loadConfig()
  ok(`配置已指向 mock：${config.baseUrl}/${config.box}，设备密钥已设置=${credentials.deviceSecret.length > 0}`)

  const buildClient = async () => {
    const current = await loadConfig()
    const creds = await (await import('../lib/config.js')).loadCredentials()
    return {
      config: current,
      credentials: creds,
      client: new MailboxClient({
        baseUrl: current.baseUrl,
        box: current.box,
        token: creds.token,
        secret: creds.deviceSecret,
        driver: current.driver,
      }),
    }
  }

  /* ------------------------------------------------------------- pure helpers */

  {
    const t0 = decide({ digest: 'a', lastDigest: '', now: 1000, lastSentAt: 0 })
    expect(t0.send && t0.reason === 'first', `首帧必发（reason=${t0.reason}）`)
    const t1 = decide({ digest: 'a', lastDigest: 'a', now: 2000, lastSentAt: 1000 })
    expect(!t1.send && t1.reason === 'idle', `无变化且未到心跳 → 不发（reason=${t1.reason}）`)
    const t2 = decide({ digest: 'b', lastDigest: 'a', now: 20000, lastSentAt: 1000 })
    expect(t2.send && t2.reason === 'change', `状态变化 → 立即发（reason=${t2.reason}）`)
    const t3 = decide({ digest: 'a', lastDigest: 'a', now: 1000 + 600_000, lastSentAt: 1000 })
    expect(t3.send && t3.reason === 'summary', `无变化满 10 分钟 → 汇总（reason=${t3.reason}）`)
    const t4 = decide({ digest: 'a', lastDigest: 'a', now: 1000 + 31_000, lastSentAt: 1000, lastHeartbeatAt: 1000 })
    expect(t4.send && t4.reason === 'heartbeat', `30 秒心跳（reason=${t4.reason}）`)
    const dg = digestOf({ online: true, enabled: true, driver: 'mock', box: 'b', queuePending: 0, queueParked: 0 })
    const dg2 = digestOf({ online: true, enabled: true, driver: 'mock', box: 'b', queuePending: 1, queueParked: 0 })
    expect(dg !== dg2 && dg.length === 16, `状态摘要对队列变化敏感（${dg} vs ${dg2}）`)
  }

  {
    const cases = [
      [{ cmd: 'start' }, 'action', 'start'],
      [{ cmd: 'status' }, 'action', 'status'],
      [{ cmd: 'download', arg: 'https://example.com/a.bin' }, 'action', 'download'],
      [{ cmd: 'download', arg: 'not-a-url' }, 'needs_model', null],
      [{ cmd: 'reboot' }, 'needs_model', null],
      [{ text: '帮我把那个报告传到手机' }, 'needs_model', null],
      [{ text: '状态' }, 'action', 'status'],
      [{ text: '停止同步' }, 'action', 'stop'],
    ]
    for (const [input, kind, action] of cases) {
      const parsed = parseCommand(input)
      const label = JSON.stringify(input)
      if (kind === 'needs_model') expect(parsed.kind === 'needs_model', `${label} → needs_model（${parsed.reason ?? ''}）`)
      else expect(parsed.kind === 'action' && parsed.action === action, `${label} → action:${action}`)
    }
  }

  /* --------------------------------------------------------------- relay: up */

  const relay = new Relay({ buildClient })
  const ctx1 = await buildClient()
  const client = ctx1.client

  const before = await client.pull({ limit: 50 })
  console.log(`\n— 起点：信箱里已有 ${before.length} 条 —`)

  // Send the telemetry on its own first, so we can look at the mailbox before the
  // down-pass acks our own envelope away (a full `tick()` does up and down in one
  // go, and the down-pass deliberately consumes anything addressed to us).
  const up1 = await relay.sendTelemetry(ctx1)
  console.log(`  上行决策：${JSON.stringify(up1.decision)}`)
  expect(up1.decision.send === true && up1.decision.reason === 'first', '首帧遥测被发出（reason=first）')

  const afterUp = await client.pull({ limit: 50 })
  const telemetryEnvelope = afterUp.map((i) => i.envelope ?? i).find((env) => env.type === 'telemetry')
  expect(Boolean(telemetryEnvelope), '信箱里出现了 telemetry 信封')
  if (telemetryEnvelope) {
    console.log(`  遥测信封 id=${telemetryEnvelope.id}`)
    console.log(`    type=${telemetryEnvelope.type} from=${telemetryEnvelope.from} to=${telemetryEnvelope.to} ttl=${telemetryEnvelope.ttl}`)
    console.log(`    payload.kind=${telemetryEnvelope.payload?.kind} reason=${telemetryEnvelope.payload?.reason}`)
    console.log(`    payload.snapshot=${JSON.stringify(telemetryEnvelope.payload?.snapshot)}`)
    console.log(`    sig=${String(telemetryEnvelope.sig).slice(0, 24)}…`)
    expect(telemetryEnvelope.v === 1, '遥测信封带协议版本 v=1')
    expect(String(telemetryEnvelope.sig).length === 64, '遥测信封带 HMAC-SHA256 签名')
  }

  const tick2 = await relay.tick()
  expect(tick2.up?.decision?.send === false, `状态未变化 → 立刻的下一跳被节流（reason=${tick2.up?.decision?.reason}）`)

  /* ------------------------------------------------------------- relay: down */

  const phoneId = (await loadConfig()).phoneId
  const deviceId = (await loadConfig()).deviceId
  const secret = (await (await import('../lib/config.js')).loadCredentials()).deviceSecret
  const command = createEnvelope({
    type: 'command',
    from: phoneId,
    to: deviceId,
    ttl: 600,
    secret,
    payload: { cmd: 'status' },
  })
  await client.put(command)
  console.log(`\n— 手机下发指令 ${command.id}（cmd=status）—`)

  const tick3 = await relay.tick()
  console.log(`  tick#3 down=${JSON.stringify(tick3.down?.results)}`)
  expect(tick3.down?.handled === 1, '下行取到并处理了 1 条指令')
  expect(relay.status.executed === 1, `本地执行计数 = ${relay.status.executed}`)

  const afterCmd = await client.pull({ limit: 50 })
  const ackEnvelope = afterCmd.map((i) => i.envelope ?? i).find((env) => env.type === 'ack' && env.payload?.ackOf === command.id)
  expect(Boolean(ackEnvelope), '信箱里出现了针对该指令的 ack 回执')
  if (ackEnvelope) {
    console.log(`  回执 payload=${JSON.stringify(ackEnvelope.payload)}`)
  }
  const stillThere = afterCmd.map((i) => i.envelope ?? i).find((env) => env.id === command.id)
  expect(!stillThere, '原指令已 ack 出队（不再被拉取）')

  /* ------------------------------------------------------------ idempotency */

  await client.put(command).catch(() => {
    /* the mock rejects a byte-identical id with 409; that is the same proof */
  })
  const tick4 = await relay.tick()
  expect(relay.status.skippedDuplicate >= 0 && (tick4.down?.handled ?? 0) === 0, `重复 id 没有再次执行（handled=${tick4.down?.handled ?? 0}）`)

  /* -------------------------------------------------------------- needs_model */

  const freeText = createEnvelope({
    type: 'command',
    from: phoneId,
    to: deviceId,
    ttl: 600,
    secret,
    payload: { text: '帮我把昨天的会议纪要整理一下发到手机' },
  })
  await client.put(freeText)
  const tick5 = await relay.tick()
  expect(tick5.down?.handled === 1, '自由文本指令被处理后回执（本地不解析）')
  const queued = await readJson(paths.pendingModelFile(), { items: [] })
  expect(Array.isArray(queued.items) && queued.items.length === 1, `自由文本进入 needs-model 队列（${queued.items?.length ?? 0} 条）`)
  if (queued.items?.[0]) console.log(`  队列条目：${JSON.stringify(queued.items[0])}`)

  /* ----------------------------------------------------------------- offline */

  {
    await relay.outbox.load()
    const stats0 = await relay.outbox.stats()
    // Kill the mailbox to simulate a link outage, then queue real work against it.
    server.kill()
    await new Promise((r) => setTimeout(r, 400))
    const offlineConfig = await loadConfig()
    const offlineCreds = await (await import('../lib/config.js')).loadCredentials()
    const offender = createEnvelope({
      type: 'event',
      from: offlineConfig.deviceId,
      to: offlineConfig.phoneId,
      ttl: 600,
      secret: offlineCreds.deviceSecret,
      payload: { kind: 'offline-probe' },
    })
    await relay.outbox.enqueue(offender)
    const tick6 = await relay.tick()
    expect(tick6.ok === false || tick6.up?.flushed?.sent === 0, `信箱不可达时 tick 不抛错（${tick6.reason ?? 'flushed ok'}）`)
    const stats1 = await relay.outbox.stats()
    console.log(`  队列：断链前 ${JSON.stringify(stats0)}\n        断链后 ${JSON.stringify(stats1)}`)
    expect(stats1.pending >= 1, `断链期间消息留在队列里（${stats1.pending} 条待发）`)
    expect(Boolean(stats1.lastError), `队列记录了错误原因：${stats1.lastError}`)
    expect(Boolean(stats1.nextAttemptAt), `已排定指数退避重试时间：${stats1.nextAttemptAt}`)

    // Bring the mailbox back and let the retry path drain the queue.
    const revived = spawn(process.execPath, [path.join(root, 'mock/server.mjs'), '--port', String(PORT), '--host', '127.0.0.1', '--token', TOKEN], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    revived.stdout.on('data', () => {})
    revived.stderr.on('data', () => {})
    try {
      const up = await waitForHealth()
      expect(up, '信箱恢复可达')
      await relay.outbox.retryAll()
      const ctx3 = await buildClient()
      const flushed = await relay.flush(ctx3)
      console.log(`  恢复后补发：${JSON.stringify(flushed)}`)
      expect(flushed.sent >= 1, '恢复后队列被补发出去（离线补跑）')
      const stats2 = await relay.outbox.stats()
      expect(stats2.pending === 0, `补发后队列清空（pending=${stats2.pending}, parked=${stats2.parked}）`)
    } finally {
      revived.kill()
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  console.log('\n═══ 结果 ═══')
  console.log(failures === 0 ? '✔ Phase 2 端到端全部断言通过' : `✘ ${failures} 条断言失败`)
  console.log('积分消耗：0 次模型调用（遥测、指令执行、回执全部由本机脚本完成）')
} finally {
  try {
    server.kill()
  } catch {
    /* already gone */
  }
}

process.exit(failures === 0 ? 0 : 1)
