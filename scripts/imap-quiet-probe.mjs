/**
 * 静默通道实测：走真实的 QQ 邮箱草稿箱（Drafts）。
 *
 * 验证四件事：
 *   1. put 之后**收件箱**里没有新邮件（这才叫「不弹提醒」）；
 *   2. 同一个信封能从草稿箱读回来，且签名有效（机器能读）；
 *   3. ack 之后草稿被删掉，草稿箱回到原来的数量（不污染用户的草稿）；
 *   4. 另一个直连收件箱的 ImapMailbox（quiet=false）看到的未读数不变。
 *
 * 用法：HONGYI_MAIL_USER=... HONGYI_MAIL_AUTH=... node scripts/imap-quiet-probe.mjs
 */
import { ImapMailbox, ImapConnection } from '../lib/mailbox/imap.js'
import { createEnvelope, validateEnvelope } from '../lib/envelope.js'

const user = process.env.HONGYI_MAIL_USER ?? ''
const auth = process.env.HONGYI_MAIL_AUTH ?? ''
const provider = process.env.HONGYI_MAIL_PROVIDER ?? 'qq'
const secret = process.env.HONGYI_DEVICE_SECRET ?? ''

let pass = 0
let fail = 0
const ok = (message, extra = '') => {
  pass += 1
  console.log(`✔ ${message}${extra ? ` — ${extra}` : ''}`)
}
const bad = (message, extra = '') => {
  fail += 1
  console.log(`✘ ${message}${extra ? ` — ${extra}` : ''}`)
}

if (!user || !auth || !secret) {
  console.error('缺环境变量：HONGYI_MAIL_USER / HONGYI_MAIL_AUTH / HONGYI_DEVICE_SECRET')
  process.exit(2)
}

const quiet = new ImapMailbox({ user, auth, provider, secret, quiet: true })
const loud = new ImapMailbox({ user, auth, provider, secret, quiet: false })

/** 数一下收件箱的未读邮件（用来证明「没弹新邮件」）。 */
async function inboxUnreadCount() {
  const conn = new ImapConnection({ host: quiet.imapHost, port: 993, user, auth, timeoutMs: 15000 })
  try {
    await conn.connect()
    await conn.login()
    const resp = await conn.command('STATUS INBOX (UNSEEN MESSAGES)')
    const unseen = /UNSEEN (\d+)/u.exec(resp)
    const messages = /MESSAGES (\d+)/u.exec(resp)
    return { unseen: unseen ? Number(unseen[1]) : null, messages: messages ? Number(messages[1]) : null }
  } finally {
    conn.logout()
  }
}

/** 数一下草稿箱里的邮件数量。 */
async function draftCount() {
  const conn = new ImapConnection({ host: quiet.imapHost, port: 993, user, auth, timeoutMs: 15000 })
  try {
    await conn.connect()
    await conn.login()
    await conn.select(quiet.quietFolder)
    const uids = await conn.searchAllUids({ limit: 500 })
    return uids.length
  } finally {
    conn.logout()
  }
}

const started = Date.now()
console.log(`═══ 静默通道实测（${provider} / 草稿箱 ${quiet.quietFolder}） ═══`)

const before = await inboxUnreadCount()
const draftsBefore = await draftCount()
console.log(`起点：收件箱未读 ${before.unseen} / 共 ${before.messages} · 草稿箱 ${draftsBefore} 封`)

const envelope = createEnvelope({
  type: 'event',
  from: 'dsh-pc',
  to: 'phone',
  ttl: 300,
  secret,
  payload: { kind: 'quiet-probe', marker: `probe-${Date.now()}` },
})
console.log(`准备写入信封 ${envelope.id}`)

const putResult = await quiet.put(envelope)
if (putResult.ok && putResult.quiet) ok('put 走静默通道（草稿箱 APPEND）', `folder=${putResult.folder}`)
else bad('put 未走静默通道', JSON.stringify(putResult))

// 草稿列表 +1
const draftsAfterPut = await draftCount()
if (draftsAfterPut === draftsBefore + 1) ok('草稿箱多了一封', `${draftsBefore} → ${draftsAfterPut}`)
else bad('草稿箱数量不对', `${draftsBefore} → ${draftsAfterPut}`)

// 收件箱未读不变 —— 这就是「不弹提醒」的硬证据
const after = await inboxUnreadCount()
if (after.unseen === before.unseen) ok('收件箱未读没有变化（不会弹新邮件提醒）', `UNSEEN ${before.unseen} → ${after.unseen}`)
else bad('收件箱未读变了，说明还在走收件箱', `UNSEEN ${before.unseen} → ${after.unseen}`)

// 读回 + 验签
const pulled = await quiet.pull({ limit: 50 })
const found = pulled.map((item) => item.envelope).find((env) => env?.id === envelope.id)
if (found) ok('从草稿箱读回了该信封', `${pulled.length} 封里命中`)
else bad('草稿箱里没读到该信封', `只读到 ${pulled.length} 封`)
if (found) {
  try {
    validateEnvelope(found, { secret })
    ok('读回的信封签名有效（机器可读且可信）')
  } catch (error) {
    bad('读回的信封验签失败', error?.message)
  }
}

// ack = 删草稿
const acked = await quiet.ack([envelope.id])
if (acked.acked.length > 0) ok('ack 执行完成', acked.acked.join(','))
else bad('ack 没有删掉任何草稿')
const draftsAfterAck = await draftCount()
if (draftsAfterAck === draftsBefore) ok('草稿箱回到原来数量（没污染用户草稿）', `${draftsBefore} → ${draftsAfterAck}`)
else bad('草稿箱没清干净', `${draftsBefore} → ${draftsAfterAck}`)

// 对照：非静默模式的 describe 文案不同
if (quiet.describe().quiet === true && loud.describe().quiet === false) ok('describe 正确区分静默/普通模式', quiet.describe().label)
else bad('describe 没有区分静默模式')

console.log(`\n结果：${pass} 通过 / ${fail} 失败（耗时 ${Math.round((Date.now() - started) / 1000)}s）`)
console.log('积分消耗：0 次模型调用（纯 IMAP 协议操作）')
process.exit(fail === 0 ? 0 : 1)
