import { loadConfig, loadCredentials } from '../lib/config.js'
import { createMailbox } from '../lib/mailbox/factory.js'
import { createEnvelope } from '../lib/envelope.js'
import { ImapConnection } from '../lib/mailbox/imap.js'
const cfg = await loadConfig(); const cred = await loadCredentials()
const mb = createMailbox(cfg, cred)
const env = createEnvelope({ type:'event', from:'phone', to:'dsh-pc', secret: cred.deviceSecret, ttl: 300, payload: { kind:'probe', marker:'dbg8' } })
await mb.put(env)
// 打补丁：包一层 moveToTrash 打印 resp
const origProto = Object.getPrototypeOf(mb).constructor
const conn = new ImapConnection({ host: mb.imapHost, port: 993, user: mb.user, auth: mb.auth, timeoutMs: 20000 })
await conn.connect(); await conn.login()
await conn.select('Drafts')
const uids = await conn.searchAllUids({ limit: 100 })
let hit = null
for (const uid of uids) { const raw = await conn.fetchRaw(uid); if (raw && raw.includes(env.id)) { hit = uid; break } }
console.log('hit', hit, 'of', uids.length)
const resp = await conn.command(`UID MOVE ${hit} "Deleted Messages"`)
console.log('raw resp:', JSON.stringify(resp))
console.log('NO test:', /\bNO\b/i.test(resp.slice(0, 200)))
conn.logout()
// 再用 mb 数
await new Promise(r => setTimeout(r, 1500))
const after = await mb.pull({ limit: 100 })
const arr = Array.isArray(after) ? after : (after.items ?? [])
console.log('still visible after move?', arr.some(x => (x?.envelope ?? x)?.id === env.id))
