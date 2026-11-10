import { loadConfig, loadCredentials } from '../lib/config.js'
import { createMailbox } from '../lib/mailbox/factory.js'
import { createEnvelope } from '../lib/envelope.js'
import { ImapConnection } from '../lib/mailbox/imap.js'

const cfg = await loadConfig(); const cred = await loadCredentials()
const mb = createMailbox(cfg, cred)
const env = createEnvelope({ type:'event', from:'phone', to:'dsh-pc', secret: cred.deviceSecret, ttl: 300, payload: { kind:'probe', marker:'dbg11' } })
await mb.put(env)
const c = new ImapConnection({ host: mb.imapHost, port: 993, user: mb.user, auth: mb.auth, timeoutMs: 20000 })
await c.connect(); await c.login(); await c.select('Drafts')
const uids = await c.searchAllUids({ limit: 100 })
console.log('uids in ack-window:', uids.length, 'tail', uids.slice(-3))
let byInclude = null, byParse = null
for (const uid of uids) {
  const raw = await c.fetchRaw(uid)
  if (!raw) continue
  if (raw.includes(env.id)) byInclude = uid
}
console.log('byInclude:', byInclude)
c.logout()
