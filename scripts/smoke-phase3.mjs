/**
 * Phase 3 冒烟测试：云端文件夹信箱（folder / tdrive 驱动）。
 *
 * 这里不碰网络，只用临时目录模拟「用户的云盘同步文件夹」，逐条验证它与
 * mock 信箱语义等价：
 *   写 → 读回 → 验签 → ack → 幂等 409 → TTL 按文件 mtime → 坏 JSON 不阻塞
 *   → 目录不可写报明确错误 → relay 端到端（遥测上行 + 指令下行 + 离线补发）
 *
 * 全部零模型调用。用法：node scripts/smoke-phase3.mjs
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = path.join(os.tmpdir(), `hongyi-folder-${process.pid}`)
const box = 'dsh-hongyi'
const SECRET = 'phase3-device-secret-xxxxxxxx'

let passed = 0
let failed = 0

function ok(label, detail = '') {
  passed += 1
  console.log(`✔ ${label}${detail ? ` — ${detail}` : ''}`)
}

function bad(label, detail = '') {
  failed += 1
  console.log(`✘ ${label}${detail ? ` — ${detail}` : ''}`)
}

function expect(label, condition, detail = '') {
  if (condition) ok(label, detail)
  else bad(label, detail)
}

const { FolderMailbox, FolderMailboxError } = await import('../lib/mailbox/folder.js')
const { createEnvelope, newId, PROTOCOL_VERSION } = await import('../lib/envelope.js')
const { Outbox } = await import('../lib/relay/outbox.js')
const { Relay } = await import('../lib/relay/engine.js')

function envelope(overrides = {}) {
  return createEnvelope({
    type: 'command',
    from: 'phone',
    to: 'dsh-pc',
    secret: SECRET,
    ttl: 120,
    payload: { cmd: 'status' },
    ...overrides,
  })
}

async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

const cleanup = []
try {
  /* ---------- 1. 配置校验 ---------- */
  const blank = new FolderMailbox({ root: '', secret: SECRET })
  expect('空路径 → 明确的中文提示', !blank.configured && blank.unsupported().includes('云文件夹路径为空'), blank.unsupported())

  const relative = new FolderMailbox({ root: 'relative/dir', secret: SECRET })
  expect('相对路径被拒', !relative.configured && relative.unsupported().includes('绝对路径'), relative.unsupported())

  /* ---------- 2. 正常读写 ---------- */
  const mailbox = new FolderMailbox({ root, box, secret: SECRET })
  cleanup.push(root)

  const health = await mailbox.health()
  expect('health：目录自动创建且可写', health.ok && health.name === 'hongyi-folder-mailbox', `protocol v${health.protocol} · ${health.root}`)
  expect('health 协议与插件一致', health.protocol === PROTOCOL_VERSION, `v${health.protocol}`)
  expect('.ack 目录已建立', await exists(path.join(root, box, '.ack')))

  const env1 = envelope()
  const receipt = await mailbox.put(env1)
  expect('put 写入信封', receipt.ok && receipt.id === env1.id, env1.id)
  expect('信封落成 <id>.json', await exists(path.join(root, box, `${env1.id}.json`)))

  const pulled = await mailbox.pull({ limit: 10 })
  expect('pull 读回一封', pulled.length === 1, `${pulled.length} 条`)
  expect('读回的信封 id 一致', pulled[0]?.envelope?.id === env1.id)
  expect('读回带 receivedAt', typeof pulled[0]?.receivedAt === 'string')

  /* ---------- 3. 验签 ---------- */
  let signOk = true
  let signError = ''
  try {
    const { validateEnvelope } = await import('../lib/envelope.js')
    validateEnvelope(pulled[0].envelope, { secret: SECRET })
  } catch (error) {
    signOk = false
    signError = error.message
  }
  expect('HMAC 验签通过', signOk, signError)

  let tampered = false
  try {
    const { validateEnvelope } = await import('../lib/envelope.js')
    const forged = { ...pulled[0].envelope, payload: { cmd: 'stop' } }
    validateEnvelope(forged, { secret: SECRET })
  } catch {
    tampered = true
  }
  expect('篡改 payload 被拒收', tampered)

  /* ---------- 4. ack ---------- */
  const ackResult = await mailbox.ack([env1.id])
  expect('ack 返回已确认 id', ackResult.acked.includes(env1.id))
  expect('ack 标记文件已写', await exists(path.join(root, box, '.ack', `${env1.id}.json`)))
  expect('ack 后正文已移除（省同步流量）', !(await exists(path.join(root, box, `${env1.id}.json`))))
  const afterAck = await mailbox.pull({ limit: 10 })
  expect('ack 后 pull 不再返回该信封', afterAck.length === 0, `${afterAck.length} 条`)
  const ackAgain = await mailbox.ack([env1.id])
  expect('ack 幂等（重复 ack 不报错）', ackAgain.acked.includes(env1.id))

  /* ---------- 5. 幂等写 ---------- */
  const env2 = envelope({ payload: { cmd: 'start' } })
  await mailbox.put(env2)
  let duplicate = null
  try {
    await mailbox.put(env2)
  } catch (error) {
    duplicate = error
  }
  expect(
    '重复 id → 409（与 HTTP 信箱同义）',
    duplicate instanceof FolderMailboxError && duplicate.details?.status === 409,
    duplicate?.message ?? '没有抛错',
  )

  /* ---------- 6. TTL 走文件 mtime ---------- */
  const shortLived = envelope({ ttl: 1 })
  await mailbox.put(shortLived)
  // 把文件 mtime 拨回 5 秒前，模拟「服务器侧已过期」
  const shortFile = path.join(root, box, `${shortLived.id}.json`)
  const past = new Date(Date.now() - 5000)
  await fs.utimes(shortFile, past, past)
  const afterTtl = await mailbox.pull({ limit: 50 })
  const stillThere = afterTtl.some((item) => item.envelope.id === shortLived.id)
  expect('过期的信封不再投递', !stillThere)
  expect('过期的信封被静默清理', !(await exists(shortFile)))

  // 反向：寄件方时钟比本机慢 1 小时，但只要文件 mtime 是新的，就不得被误删
  const drift = envelope({ ts: new Date(Date.now() - 3600_000).toISOString(), ttl: 120 })
  await mailbox.put(drift)
  const afterDrift = await mailbox.pull({ limit: 50 })
  expect(
    '寄件方时钟漂移不影响保留（TTL 用文件时间）',
    afterDrift.some((item) => item.envelope.id === drift.id),
    drift.id,
  )

  /* ---------- 7. 坏文件不阻塞 ---------- */
  await fs.writeFile(path.join(root, box, 'corrupt.json'), '{not json', 'utf8')
  const mixed = await mailbox.pull({ limit: 50 })
  expect('坏 JSON 被跳过、整批仍可读', Array.isArray(mixed) && mixed.length >= 1, `${mixed.length} 条`)
  const stillHasDrift = mixed.some((item) => item.envelope.id === drift.id)
  expect('坏文件之后的正常信封仍能读到', stillHasDrift)

  /* ---------- 8. probe 往返 ---------- */
  const probe = await mailbox.probe(() => envelope({ type: 'event', payload: { kind: 'ping' } }))
  expect('probe 成功', probe.ok && probe.stage === 'done', `${probe.message}（${probe.latencyMs}ms）`)
  expect('probe 做完了完整往返', typeof probe.pingId === 'string' && probe.pingId.startsWith('event_'), probe.pingId)

  /* ---------- 9. 不可写目录 ---------- */
  const bogus = new FolderMailbox({ root: path.join(root, 'no-such', '\u0000bad'), box, secret: SECRET })
  let unreachable = null
  try {
    await bogus.health()
  } catch (error) {
    unreachable = error
  }
  expect(
    '不可写路径 → code=unreachable + 中文说明',
    unreachable instanceof FolderMailboxError && unreachable.code === 'unreachable',
    unreachable?.message ?? '没有抛错',
  )

  /* ---------- 10. relay 端到端（文件夹当信箱） ---------- */
  const relayRoot = path.join(root, 'relay-home')
  const relayConfig = {
    enabled: true,
    driver: 'folder',
    folderRoot: relayRoot,
    baseUrl: '',
    box: 'relay-box',
    deviceId: 'dsh-pc',
    phoneId: 'phone',
    telemetry: { onChangeOnly: true, minGapSec: 0, summaryIntervalSec: 600, heartbeatSec: 30, offlineAfterSec: 180 },
    relay: { intervalMs: 15000 },
    queue: { maxAttempts: 12, baseBackoffMs: 10, maxBackoffMs: 1000 },
  }
  const relayBox = new FolderMailbox({ root: relayRoot, box: relayConfig.box, secret: SECRET, driver: 'folder' })
  const outbox = new Outbox({ file: path.join(relayRoot, 'outbound.json'), limits: relayConfig.queue })
  const relay = new Relay({
    limits: relayConfig.queue,
    buildClient: async () => ({ config: relayConfig, credentials: { deviceSecret: SECRET }, client: relayBox }),
  })
  relay.outbox = outbox

  await relay.tick()
  const telemetryFiles = (await fs.readdir(path.join(relayRoot, relayConfig.box))).filter((n) => n.endsWith('.json'))
  expect('relay 第一跳写出遥测', telemetryFiles.length === 1, `${telemetryFiles.length} 个文件`)

  const upItems = await relayBox.pull({ limit: 20 })
  const telemetry = upItems.map((i) => i.envelope).find((e) => e.type === 'telemetry')
  expect('信箱里能读到 telemetry 信封', Boolean(telemetry), telemetry?.id)
  expect('遥测带状态快照', typeof telemetry?.payload?.snapshot?.online === 'boolean')
  await relayBox.ack(upItems.map((i) => i.envelope.id))

  // 手机往同一个文件夹丢一条指令
  const command = envelope({ payload: { cmd: 'status' } })
  await relayBox.put(command)
  const ticksBefore = relay.status.ticks
  await relay.tick()
  expect('relay 拉到了指令', relay.status.received >= 1, `received=${relay.status.received}`)
  expect('指令被本地执行（0 次模型调用）', relay.status.executed >= 1, `lastCommand=${relay.status.lastCommand}`)
  expect('执行结果 ok', relay.status.lastCommandOk === true)
  expect('tick 计数在推进', relay.status.ticks > ticksBefore, `${ticksBefore} → ${relay.status.ticks}`)

  const ackItems = await relayBox.pull({ limit: 50 })
  const ackEnvelope = ackItems.map((i) => i.envelope).find((e) => e.type === 'ack' && e.payload?.ackOf === command.id)
  expect('回执 ack 已写进信箱', Boolean(ackEnvelope), ackEnvelope?.id)
  expect('回执内容可读', ackEnvelope?.payload?.ok === true, String(ackEnvelope?.payload?.result ?? '').slice(0, 60))

  // 文件夹不可达 → 队列积压，不抛错
  await fs.rm(path.join(relayRoot, relayConfig.box), { recursive: true, force: true })
  const blocker = path.join(relayRoot, relayConfig.box)
  await fs.writeFile(blocker, 'not a directory', 'utf8') // 让 mkdir 失败
  const queued = createEnvelope({ type: 'event', from: 'dsh-pc', to: 'phone', secret: SECRET, ttl: 600, payload: { kind: 'probe' } })
  await relay.outbox.enqueue(queued)
  await relay.tick()
  const stuck = await relay.outbox.stats()
  expect('信箱不可用时 tick 不抛错', typeof relay.status.lastTickError === 'string' && relay.status.lastTickError.length > 0, relay.status.lastTickError)
  expect('离线信件留在队列里（不丢）', stuck.pending + stuck.parked >= 1, `pending=${stuck.pending} parked=${stuck.parked}`)
  expect('记录了重试时间', typeof stuck.nextAttemptAt === 'string' && Number.isFinite(Date.parse(stuck.nextAttemptAt)), String(stuck.nextAttemptAt))

  // 恢复信箱 → retryAll + flush → 队列清空
  await fs.rm(blocker, { force: true })
  await relay.outbox.retryAll()
  await relay.tick()
  const recovered = await relay.outbox.stats()
  expect('恢复后自动补发成功', recovered.pending === 0, `pending=${recovered.pending} parked=${recovered.parked}`)

  const finalFiles = (await fs.readdir(path.join(relayRoot, relayConfig.box))).filter((n) => n.endsWith('.json'))
  expect('补发的信封真的落进了信箱', finalFiles.length >= 1, `${finalFiles.length} 个文件`)

  /* ---------- 11. describe / 驱动注册表 ---------- */
  const { MAILBOX_DRIVERS, isFolderDriver } = await import('../lib/mailbox/client.js')
  const folderDriver = MAILBOX_DRIVERS.find((x) => x.id === 'folder')
  expect('驱动表里有 folder 且 ready', folderDriver?.ready === true)
  expect('驱动表里有 tdrive 且 ready', MAILBOX_DRIVERS.find((x) => x.id === 'tdrive')?.ready === true)
  expect('isFolderDriver 判定正确', isFolderDriver('folder') && isFolderDriver('tdrive') && !isFolderDriver('mock'))
  const described = mailbox.describe()
  expect('describe 反映真实配置', described.driver === 'folder' && described.configured === true, `${described.label} · ${described.baseUrl}`)
} catch (error) {
  failed += 1
  console.error(`✘ 未捕获异常：${error?.stack ?? error}`)
} finally {
  for (const target of cleanup) {
    await fs.rm(target, { recursive: true, force: true }).catch(() => {})
  }
}

console.log('')
console.log(`结果：${passed} 通过 / ${failed} 失败`)
console.log('积分消耗：0 次模型调用（纯本地文件读写）')
process.exit(failed === 0 ? 0 : 1)
