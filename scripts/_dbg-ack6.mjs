import { loadConfig, loadCredentials } from '../lib/config.js'
import { createMailbox } from '../lib/mailbox/factory.js'
import { ImapConnection } from '../lib/mailbox/imap.js'
const cfg = await loadConfig(); const cred = await loadCredentials()
const mb = createMailbox(cfg, cred)
const conn = new ImapConnection({ host: mb.imapHost, port: 993, user: mb.user, auth: mb.auth, timeoutMs: 20000 })
await conn.connect(); await conn.login()
await conn.select('Drafts')
const uids = await conn.searchAllUids({ limit: 3 })
console.log('drafts uids tail:', uids)
const target = uids[uids.length - 1]
const before = await conn.command('STATUS "Deleted Messages" (MESSAGES)')
console.log('trash before:', before.trim().split('\r\n')[0])
const mv = await conn.command(`UID MOVE ${target} "Deleted Messages"`)
console.log('MOVE resp:', JSON.stringify(mv.slice(0, 220)))
await conn.select('Deleted Messages')
const after = await conn.command('STATUS "Deleted Messages" (MESSAGES)')
console.log('trash after:', after.trim().split('\r\n')[0])
conn.logout()
