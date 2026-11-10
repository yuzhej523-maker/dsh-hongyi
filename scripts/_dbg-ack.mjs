import { ImapConnection, IMAP_PRESETS } from '../lib/mailbox/imap.js'
const p = IMAP_PRESETS.qq
const conn = new ImapConnection({ host: p.imapHost, port: 993, user: process.env.U, auth: process.env.A, timeoutMs: 25000 })
await conn.connect(); await conn.login()
await conn.select('Drafts')
const stat = await conn.command('STATUS "Drafts" (MESSAGES)')
console.log('STATUS before:', stat.trim().replace(/\r\n/g, ' | '))
const uids = await conn.searchAllUids({ limit: 5 })
console.log('last uids:', uids)
const target = uids[uids.length - 1]
const raw = await conn.fetchRaw(target)
console.log('fetched bytes', raw?.length)
const store = await conn.command(`UID STORE ${target} +FLAGS.SILENT (\Deleted)`)
console.log('STORE resp:', JSON.stringify(store.slice(0, 200)))
const exp = await conn.command('EXPUNGE')
console.log('EXPUNGE resp:', JSON.stringify(exp.slice(0, 300)))
const stat2 = await conn.command('STATUS "Drafts" (MESSAGES)')
console.log('STATUS after:', stat2.trim().replace(/\r\n/g, ' | '))
conn.logout()
