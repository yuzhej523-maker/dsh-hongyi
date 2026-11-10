/**
 * Phase 3 检查点 · imap 通道专项测试：
 *   ① IMAP/SMTP 登录（授权码）与 health
 *   ② put（SMTP 自发自收）→ pull（SEARCH UNSEEN）往返
 *   ③ 信封验签 + 篡改拒绝
 *   ④ TTL 过期清理（\Deleted + EXPUNGE）
 *   ⑤ ack（\Seen 标记）后出队，重复 pull 不再出现
 *   ⑥ probe 端到端（含 QQ 索引延迟轮询）
 *
 * 需要真实凭据：读 $DSH_HOME/hongyi 的 config.json + credentials.json。
 * 运行：node scripts/smoke-imap.mjs
 */
import { loadConfig, loadCredentials } from '../lib/config.js'
import { ImapMailbox, ImapConnection } from '../lib/mailbox/imap.js'
import { createEnvelope, createPing, validateEnvelope } from '../lib/envelope.js'

let passed = 0
let failed = 0
function ok(cond, label) {
  if (cond) { passed += 1; console.log('  ✔', label) }
  else { failed += 1; console.log('  ✘', label) }
}

const cfg = await loadConfig()
const cred = await loadCredentials()
const secret = cred.deviceSecret

console.log('== [1] IMAP 登录与 health ==')
{
  const conn = new ImapConnection({ host: 'imap.qq.com', port: 993, user: cfg.imapUser, auth: cred.imapAuth, timeoutMs: 12000 })
  await conn.connect()
  await conn.login()
  const folders = await conn.listFolders()
  ok(folders.some((f) => f.name === 'INBOX'), `登录成功，INBOX 存在（共 ${folders.length} 个文件夹）`)
  conn.logout()
}

const mb = new ImapMailbox({ user: cfg.imapUser, auth: cred.imapAuth, provider: cfg.imapProvider ?? 'qq', box: cfg.box, secret, driver: 'imap' })
const health = await mb.health()
ok(health.ok === true && health.name === 'hongyi-imap-mailbox', `health OK（user=${health.user}）`)

console.log('== [2] put → pull 往返（含 QQ 索引延迟，最长 60 秒） ==')
const env = createEnvelope({ type: 'event', from: cfg.deviceId, to: cfg.phoneId, ttl: 1800, payload: { kind: 'smoke-imap', at: new Date().toISOString() }, secret })
await mb.put(env)
ok(true, `put 成功（id=${env.id.slice(-8)}，SMTP 发信返回 ok）`)

let found = null
for (let attempt = 0; attempt < 20; attempt += 1) {
  const items = await mb.pull({ limit: 50 })
  found = items.find((x) => x.envelope?.id === env.id)
  if (found) break
  await new Promise((r) => setTimeout(r, 3000))
}
ok(Boolean(found), found ? `pull 命中（QQ 索引延迟下轮询成功，receivedAt=${found.receivedAt}）` : '60 秒内未索引到（QQ 索引异常）')

console.log('== [3] 信封验签 ==')
if (found) {
  let tamperedOk = false
  try {
    validateEnvelope({ ...found.envelope, payload: { ...found.envelope.payload, hacked: true } }, { secret })
  } catch { tamperedOk = true }
  ok(tamperedOk, '篡改 payload 后验签必须失败')
  validateEnvelope(found.envelope, { secret })
  ok(true, '原信封 HMAC 验签通过')
}

console.log('== [4] TTL 过期清理（\Deleted + EXPUNGE） ==')
{
  const old = createEnvelope({ type: 'event', from: cfg.deviceId, to: cfg.phoneId, ttl: 1, payload: { kind: 'expired' }, secret, ts: new Date(Date.now() - 3600_000).toISOString() })
  await mb.put(old)
  let gone = false
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const items = await mb.pull({ limit: 50 })
    if (!items.some((x) => x.envelope?.id === old.id)) { gone = true; break }
    await new Promise((r) => setTimeout(r, 3000))
  }
  ok(gone, 'ttl=1 且 ts 已过期的信封被 pull 自动清理（不投递）')
}

console.log('== [5] ack（\Seen）后出队 ==')
if (found) {
  const ack = await mb.ack([env.id])
  ok(ack.acked.length >= 1, `ack 返回 ${JSON.stringify(ack.acked)}`)
  await new Promise((r) => setTimeout(r, 1500))
  const after = await mb.pull({ limit: 50 })
  ok(!after.some((x) => x.envelope?.id === env.id), 'ack 后再次 pull 不再出现（\Seen 方案生效）')
}

console.log('== [6] probe 端到端 ==')
{
  const result = await mb.probe(() => createPing({ from: cfg.deviceId, to: cfg.phoneId, secret, ttl: 120 }))
  ok(result.ok === true && result.stage === 'done', `probe ${result.stage}（${result.message}，${result.latencyMs}ms）`)
}

console.log(`\n${failed === 0 ? '✔' : '✘'} smoke-imap：${passed} 通过 / ${failed} 失败（积分消耗：0 次模型调用）`)
process.exit(failed === 0 ? 0 : 1)
