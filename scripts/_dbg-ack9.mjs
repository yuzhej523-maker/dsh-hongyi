import { loadConfig, loadCredentials } from '../lib/config.js'
import { createMailbox } from '../lib/mailbox/factory.js'
import { createEnvelope } from '../lib/envelope.js'
import { ImapConnection } from '../lib/mailbox/imap.js'
const cfg = await loadConfig(); const cred = await loadCredentials()
const mb = createMailbox(cfg, cred)
async function freshCount() {
  const c = new ImapConnection({ host: mb.imapHost, port: 993, user: mb.user, auth: mb.auth, timeoutMs: 20000 })
  await c.connect(); await c.login()
  const r = await c.command('STATUS "Drafts" (MESSAGES)')
  c.logout()
  return /MESSAGES (\d+)/.exec(r)?.[1]
}
const before = await freshCount()
const env = createEnvelope({ type:'event', from:'phone', to:'dsh-pc', secret: cred.deviceSecret, ttl: 300, payload: { kind:'probe', marker:'dbg9' } })
await mb.put(env)
const afterPut = await freshCount()
const ack = await mb.ack([env.id])
const afterAck = await freshCount()
console.log({ before, afterPut, afterAck, ack: JSON.stringify(ack) })
