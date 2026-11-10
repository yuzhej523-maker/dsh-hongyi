import { ImapConnection, IMAP_PRESETS } from '../lib/mailbox/imap.js'
const p = IMAP_PRESETS.qq
const conn = new ImapConnection({ host: p.imapHost, port: 993, user: process.env.U, auth: process.env.A, timeoutMs: 25000 })
await conn.connect(); await conn.login()
console.log('CAP:', String(conn.capabilities).replace(/\r\n/g, ' | ').slice(0, 400))
await conn.select('Drafts')
const before = await conn.command('STATUS "Drafts" (MESSAGES)')
console.log('before:', before.trim().split('\r\n')[0])
const uids = await conn.searchAllUids({ limit: 3 })
const target = uids[uids.length - 1]
console.log('target uid', target)
// 试 1：UID STORE + \Deleted 后 FETCH 看 flags
await conn.command(`UID STORE ${target} +FLAGS.SILENT (\Deleted)`)
const flags = await conn.command(`UID FETCH ${target} (FLAGS)`)
console.log('flags:', JSON.stringify(flags.slice(0, 200)))
// 试 2：CLOSE（会隐式 expunge）
const close = await conn.command('CLOSE')
console.log('CLOSE:', JSON.stringify(close.slice(0, 160)))
await conn.select('Drafts')
const after = await conn.command('STATUS "Drafts" (MESSAGES)')
console.log('after:', after.trim().split('\r\n')[0])
conn.logout()
