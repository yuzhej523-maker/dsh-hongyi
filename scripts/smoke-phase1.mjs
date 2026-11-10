#!/usr/bin/env node
/**
 * Phase 1 acceptance script — proves the link end to end with zero model calls.
 *
 *   1. starts mock/server.mjs as a child process;
 *   2. builds a signed ping envelope;
 *   3. writes it to the mailbox, reads it back, verifies the HMAC, acks it;
 *   4. asserts the ack removed it from the pending list;
 *   5. replays the same id and asserts the mailbox rejects the duplicate
 *      (the idempotency guarantee the offline replay queue will depend on);
 *   6. runs the doctor checks against the live mock.
 *
 * Exit code 0 = every assertion passed.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

import { MailboxClient } from '../lib/mailbox/client.js'
import { createEnvelope, createPing, createPong, validateEnvelope, PROTOCOL_VERSION } from '../lib/envelope.js'
import { runDoctor } from '../lib/doctor.js'
import * as pathsModule from '../lib/paths.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const PORT = Number(process.env.HONGYI_MOCK_PORT ?? 7654)
const BASE = `http://127.0.0.1:${PORT}`
const TOKEN = process.env.HONGYI_MOCK_TOKEN ?? 'phase1-demo-token'
const SECRET = 'phase1-demo-device-secret'

const lines = []
function log(line) {
  lines.push(line)
  process.stdout.write(line + '\n')
}
function fail(message) {
  log(`✘ ${message}`)
  process.exitCode = 1
  throw new Error(message)
}
function ok(message) {
  log(`✔ ${message}`)
}

async function waitForHealth(client, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await client.health()
      return true
    } catch {
      await delay(100)
    }
  }
  return false
}

const child = spawn(process.execPath, [path.join(root, 'mock', 'server.mjs'), '--port', String(PORT), '--token', TOKEN], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', (chunk) => process.stdout.write(`  [mock] ${String(chunk).trimEnd()}\n`))
child.stderr.on('data', (chunk) => process.stderr.write(`  [mock:err] ${String(chunk).trimEnd()}\n`))

try {
  log('═══ 鸿驿 · Phase 1 链路实测 ═══')
  const client = new MailboxClient({ baseUrl: BASE, box: 'dsh-hongyi', token: TOKEN, secret: SECRET, driver: 'mock' })

  if (!(await waitForHealth(client))) fail(`mock 信箱未在 ${BASE} 就绪`)
  ok(`mock 信箱已就绪：${BASE}（box=dsh-hongyi）`)

  // ---- 1. ping → mailbox → read-back → verify → ack -------------------------
  const ping = createPing({ from: 'dsh-pc', to: 'phone', secret: SECRET, ttl: 120 })
  log(`  → 写入 ping：id=${ping.id} type=${ping.type} v=${ping.v} sig=${ping.sig.slice(0, 12)}…`)
  const receipt = await client.put(ping)
  ok(`写入成功：${JSON.stringify(receipt.receipt ?? receipt)}`)

  const items = await client.pull({ limit: 50 })
  log(`  ← 拉取到 ${items.length} 条待取信封`)
  const found = items.map((i) => i.envelope).find((env) => env?.id === ping.id)
  if (!found) fail('读回时未找到刚写入的 ping')
  ok(`读回成功：${found.id}`)

  validateEnvelope(found, { secret: SECRET })
  ok(`签名校验通过（HMAC-SHA256，协议 v${PROTOCOL_VERSION}）`)

  await client.ack([found.id])
  ok('ack 成功')

  const after = await client.pull({ limit: 50 })
  if (after.some((i) => i.envelope?.id === found.id)) fail('ack 之后该信封仍出现在待取列表')
  ok('ack 之后不再出现在待取列表（投递标记生效）')

  // ---- 2. pong round trip (the phone's reply travels the same way) ----------
  const pong = createPong(found, { secret: SECRET, ttl: 120 })
  await client.put(pong)
  const reply = (await client.pull({ limit: 50 })).map((i) => i.envelope).find((env) => env?.id === pong.id)
  if (!reply) fail('pong 未读回')
  validateEnvelope(reply, { secret: SECRET })
  if (reply.payload?.echoOf !== found.id) fail('pong 未正确回指 ping')
  ok(`pong 往返成功：echoOf=${reply.payload.echoOf}`)
  await client.ack([reply.id])

  // ---- 3. idempotency: the same id twice must be rejected ------------------
  let duplicateRejected = false
  try {
    await client.put(ping)
  } catch (error) {
    duplicateRejected = error?.status === 409 || String(error?.message ?? '').includes('409')
  }
  if (!duplicateRejected) fail('重复 id 未被拒绝：离线补跑的幂等防护不成立')
  ok('重复 id 被信箱拒绝（409）：补跑时按 id 幂等成立')

  // ---- 4. TTL is measured on the server clock, not the sender's ------------
  // (a) a sender whose clock is an hour fast/slow must not cause data loss:
  const skewed = createEnvelope({
    type: 'event',
    from: 'dsh-pc',
    to: 'phone',
    ttl: 120,
    secret: SECRET,
    payload: { kind: 'skewed-clock-probe' },
    ts: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  })
  await client.put(skewed)
  let ids = (await client.pull({ limit: 100 })).map((i) => i.envelope?.id)
  if (!ids.includes(skewed.id)) fail('寄件方时钟慢 1 小时的信封被误删（TTL 未使用服务器时钟）')
  ok('寄件方时钟慢 1 小时：信封未被误删（TTL 走服务器时钟，防时钟漂移）')
  await client.ack([skewed.id])

  // (b) server-side age past a 1-second TTL really is purged:
  const shortLived = createEnvelope({
    type: 'event', from: 'dsh-pc', to: 'phone', ttl: 1, secret: SECRET,
    payload: { kind: 'short-ttl-probe' },
  })
  await client.put(shortLived)
  await delay(1300)
  ids = (await client.pull({ limit: 100 })).map((i) => i.envelope?.id)
  if (ids.includes(shortLived.id)) fail('超过 TTL 的信封未被清理')
  ok('ttl=1 的信封在 1.3 秒后被信箱清理')

  // ---- 5. doctor against the live mock ------------------------------------
  const report = await runDoctor({
    config: {
      driver: 'mock',
      baseUrl: BASE,
      box: 'dsh-hongyi',
      wecomWebhook: '',
      link: { enabled: false, cliPath: '', cdpPort: 0 },
    },
    credentials: { token: TOKEN, deviceSecret: SECRET },
    client,
    paths: pathsModule.paths,
    hongyiHome: pathsModule.hongyiHome,
  })
  for (const check of report.checks) {
    log(`  ${check.ok ? '✔' : '✘'} ${check.label}：${check.detail}${check.ok ? '' : `（${check.hint}）`}`)
  }
  ok(`doctor 自检：${report.summary}`)

  // ---- 6. bad token must fail loudly, not silently ------------------------
  const badClient = new MailboxClient({ baseUrl: BASE, box: 'dsh-hongyi', token: 'wrong-token', driver: 'mock' })
  try {
    await badClient.health()
    fail('错误 token 竟然通过了鉴权')
  } catch (error) {
    if (error?.code !== 'credential_invalid') fail(`错误 token 的报错不明确：${error?.code} ${error?.message}`)
    ok(`错误 token 报明确错误：${error.message}`)
  }

  log('')
  log('═══ 结果：全部断言通过 ═══')
  log(`积分消耗：本脚本未调用任何模型（0 次）；全部为本地 HTTP + Node 标准库。`)
} catch (error) {
  if (!process.exitCode) process.exitCode = 1
  log(`\n═══ 失败：${error?.message ?? error} ═══`)
} finally {
  child.kill()
}
