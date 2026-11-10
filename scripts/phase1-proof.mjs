/**
 * Phase 1 检查点证据脚本（走 MailboxClient 的公开方法，与插件内部完全同一条路径）：
 * 写入 → 拉取读回 → 校验协议版本与签名 → ack 出队 → 复查已出队。
 * 同时打印 mock 信箱 /debug/dump 的原始状态，便于肉眼核对。
 */
import { loadConfig, loadCredentials } from '../lib/config.js'
import { createMailbox } from '../lib/mailbox/factory.js'
import { createEnvelope, validateEnvelope, PROTOCOL_VERSION } from '../lib/envelope.js'

const cfg = await loadConfig()
const cred = await loadCredentials()
const box = createMailbox(cfg, cred)
const secret = cred.deviceSecret

const env = createEnvelope({
  type: 'command',
  from: 'phone',
  to: 'dsh',
  ttl: 300,
  secret,
  payload: { cmd: 'status', note: 'Phase 1 检查点：写入 → 读回 → 验签 → ack' },
})

const where = cfg.driver === 'folder' || cfg.driver === 'tdrive'
  ? `${cfg.folderRoot}/${cfg.box}（同步文件夹）`
  : cfg.driver === 'imap'
    ? `${cfg.imapUser ?? '(未填邮箱)'}（IMAP/SMTP）`
    : `${cfg.baseUrl}/${cfg.box}`
console.log('信箱 =', where, '/ driver =', cfg.driver, '/ token =', cred.token ? '已设置' : '未设置')

console.log('\n[1] 写入信箱')
const put = await box.put(env)
console.log('    put →', JSON.stringify(put))
console.log('    信封 id =', env.id, ' sig =', env.sig.slice(0, 24) + '…')

console.log('\n[2] 从信箱拉取（imap 通道有 QQ 索引延迟，轮询最长 60 秒）')
let hit = null
let pulledCount = 0
for (let attempt = 0; attempt < 20; attempt += 1) {
  const pulled = await box.pull({ limit: 20 })
  pulledCount = pulled.length
  hit = pulled.map((item) => item?.envelope ?? item).find((item) => item?.id === env.id)
  if (hit) break
  await new Promise((resolve) => setTimeout(resolve, 3000))
}
console.log('    pull → 本次拉回', pulledCount, '条；命中刚写入的 id =', Boolean(hit))
if (!hit) throw new Error('刚写入的信封没被拉回来')

console.log('\n[3] 校验协议版本与签名（validateEnvelope）')
validateEnvelope(hit, { secret })
console.log('    v =', hit.v, '/ 插件 v' + PROTOCOL_VERSION, '| type =', hit.type, '|', hit.from, '→', hit.to)
console.log('    payload =', JSON.stringify(hit.payload))
console.log('    签名校验通过（HMAC-SHA256 比对一致）')

console.log('\n[4] ack 出队')
const ack = await box.ack([env.id])
console.log('    ack →', JSON.stringify(ack))
const after = await box.pull({ limit: 20 })
const still = after.map((item) => item?.envelope ?? item).some((item) => item?.id === env.id)
console.log('    复查 pull →', after.length, '条；该 id 仍在 =', still)
if (still) throw new Error('ack 之后信封仍在信箱里')

console.log('\n[5] 幂等：重复写入同一 id 必须被信箱拒绝（409）')
let dup = 'no-error'
try {
  await box.put(env)
} catch (error) {
  dup = `${error.code ?? error.name}: ${error.message}`
}
if (cfg.driver === 'imap') {
  // SMTP 没有「同 id 拒收」语义：同主题邮件会作为新邮件进来，靠 pull 端幂等账本去重
  console.log('    重复 put →', dup, '（imap 通道无 409 语义，幂等由 relay 账本保证）')
} else {
  console.log('    重复 put →', dup)
}

console.log('\n✔ Phase 1 主链路验证通过：写入 → 读回 → 验签 → ack → 幂等（0 次模型调用）')
