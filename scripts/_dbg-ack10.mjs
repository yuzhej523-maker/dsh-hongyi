import { loadConfig, loadCredentials } from '../lib/config.js'
import { createMailbox } from '../lib/mailbox/factory.js'
import { createEnvelope } from '../lib/envelope.js'
import { ImapConnection } from '../lib/mailbox/imap.js'
const cfg = await loadConfig(); const cred = await loadCredentials()
const mb = createMailbox(cfg, cred)
async function cnt() {
  const c = new ImapConnection({ host: mb.imapHost, port: 993, user: mb.user, auth: mb.auth, timeoutMs: 20000 })
  await c.connect(); await c.login()
  const r = await c.command('STATUS "Drafts" (MESSAGES)')
  c.logout()
  return /MESSAGES (\d+)/.exec(r)?.[1]
}
const env = createEnvelope({ type:'event', from:'phone', to:'dsh-pc', secret: cred.deviceSecret, ttl: 300, payload: { kind:'probe', marker:'dbg10' } })
await mb.put(env)
console.log('count after put', await cnt())
// 找出新草稿真实 uid
const c = new ImapConnection({ host: mb.imapHost, port: 993, user: mb.user, auth: mb.auth, timeoutMs: 20000 })
await c.connect(); await c.login(); await c.select('Drafts')
const uids = await c.searchAllUids({ limit: 200 })
let hit = null
for (const uid of uids) { const raw = await c.fetchRaw(uid); if (raw && raw.includes(env.id)) { hit = uid; break } }
console.log('real uid for new draft:', hit, 'max uid:', uids[uids.length-1])
c.logout()
const ack = await mb.ack([env.id])
console.log('ack says:', JSON.stringify(ack))
await new Promise(r => setTimeout(r, 2500))
console.log('count after ack (+2.5s)', await cnt())
console.log('count after ack (+8s)', await new Promise(r=>setTimeout(async()=>r(await cnt()),8000)))
