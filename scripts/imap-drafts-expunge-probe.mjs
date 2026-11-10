/**
 * 为什么草稿箱没被清空？—— 单点排查。
 *
 * 只做一件事：SELECT Drafts → 列出 UID 与主题 → 对一个已知 UID 逐步执行
 * `UID STORE +FLAGS.SILENT (\Deleted)`、`EXPUNGE`、`UID EXPUNGE`，
 * 每一步都把服务器的原始响应打出来，并在每步之后重新数一遍草稿。
 *
 * 用法：HONGYI_MAIL_USER=... HONGYI_MAIL_AUTH=... node scripts/imap-drafts-expunge-probe.mjs
 */
import { ImapConnection } from '../lib/mailbox/imap.js'

const user = process.env.HONGYI_MAIL_USER ?? ''
const auth = process.env.HONGYI_MAIL_AUTH ?? ''
const folder = process.env.HONGYI_QUIET_FOLDER ?? 'Drafts'

if (!user || !auth) {
  console.error('缺 HONGYI_MAIL_USER / HONGYI_MAIL_AUTH')
  process.exit(2)
}

const conn = new ImapConnection({ host: 'imap.qq.com', port: 993, user, auth, timeoutMs: 15000 })
await conn.connect()
await conn.login()

const show = (label, resp) => console.log(`${label}: ${resp.split('\r\n').filter(Boolean).slice(-2).join(' | ')}`)

show('SELECT', await conn.select(folder))
let uids = await conn.searchAllUids({ limit: 100 })
console.log(`草稿 UID：${uids.join(',') || '(空)'}`)

for (const uid of uids) {
  const raw = await conn.fetchRaw(uid)
  const subject = /subject:[^\r\n]*/iu.exec(raw?.split('\r\n\r\n')[0] ?? '')?.[0] ?? '(无主题)'
  console.log(`  uid=${uid}  ${subject.slice(0, 80)}`)
}

if (uids.length === 0) {
  console.log('草稿箱是空的，没什么可删的')
  conn.logout()
  process.exit(0)
}

const target = uids[uids.length - 1]
console.log(`\n准备删除最后一个草稿 uid=${target}`)

show('STORE \\Deleted', await conn.command(`UID STORE ${target} +FLAGS.SILENT (\\Deleted)`))
show('EXPUNGE', await conn.command('EXPUNGE'))
uids = await conn.searchAllUids({ limit: 100 })
console.log(`EXPUNGE 之后：${uids.join(',') || '(空)'}`)

if (uids.includes(target)) {
  console.log('plain EXPUNGE 没删掉，改用 UID EXPUNGE（需要 UIDPLUS）')
  try {
    show('UID EXPUNGE', await conn.command(`UID EXPUNGE ${target}`))
  } catch (error) {
    console.log(`UID EXPUNGE 失败：${error?.message}`)
  }
  uids = await conn.searchAllUids({ limit: 100 })
  console.log(`UID EXPUNGE 之后：${uids.join(',') || '(空)'}`)
}

if (uids.includes(target)) {
  console.log('仍然在 → 再试一次：(SELECT → STORE \\Deleted → CLOSE)')
  await conn.select(folder)
  show('STORE again', await conn.command(`UID STORE ${target} +FLAGS (\\Deleted)`))
  show('CLOSE', await conn.command('CLOSE'))
  uids = await conn.searchAllUids({ limit: 100 })
  console.log(`CLOSE 之后：${uids.join(',') || '(空)'}`)
}

console.log(uids.includes(target) ? '\n结论：这封草稿删不掉（服务端拒绝）' : '\n结论：已删除')
conn.logout()
