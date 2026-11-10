import { loadConfig, loadCredentials } from '../lib/config.js'
import { createMailbox } from '../lib/mailbox/factory.js'
import { createEnvelope } from '../lib/envelope.js'
const cfg = await loadConfig(); const cred = await loadCredentials()
const mb = createMailbox(cfg, cred)
async function count() {
  const r = await mb.pull({ limit: 1 })  // 触发一次连接
  const conn = await mb.constructor === null ? null : null
  return null
}
// 直接数：用 ImapConnection
import { ImapConnection } from '../lib/mailbox/imap.js'
const conn = new ImapConnection({ host: mb.imapHost, port: 993, user: mb.user, auth: mb.auth, timeoutMs: 20000 })
await conn.connect(); await conn.login(); await conn.select('Drafts')
const c1 = /MESSAGES (\d+)/.exec(await conn.command('STATUS "Drafts" (MESSAGES)'))?.[1]
console.log('drafts before put:', c1)
const env = createEnvelope({ type:'event', from:'phone', to:'dsh-pc', secret: cred.deviceSecret, ttl: 300, payload: { kind:'probe', marker:'dbg5' } })
await mb.put(env)
await conn.select('Drafts')
const c2 = /MESSAGES (\d+)/.exec(await conn.command('STATUS "Drafts" (MESSAGES)'))?.[1]
console.log('after put:', c2)
const r = await mb.ack([env.id])
console.log('ack:', JSON.stringify(r))
await conn.select('Drafts')
const c3 = /MESSAGES (\d+)/.exec(await conn.command('STATUS "Drafts" (MESSAGES)'))?.[1]
console.log('after ack:', c3)
conn.logout()
