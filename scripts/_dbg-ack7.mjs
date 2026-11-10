import { loadConfig, loadCredentials } from '../lib/config.js'
import { createMailbox } from '../lib/mailbox/factory.js'
import { createEnvelope } from '../lib/envelope.js'
import { ImapConnection } from '../lib/mailbox/imap.js'
const cfg = await loadConfig(); const cred = await loadCredentials()
const mb = createMailbox(cfg, cred)
const conn = new ImapConnection({ host: mb.imapHost, port: 993, user: mb.user, auth: mb.auth, timeoutMs: 20000 })
async function count() {
  await conn.select('Drafts')
  return /MESSAGES (\d+)/.exec(await conn.command('STATUS "Drafts" (MESSAGES)'))?.[1]
}
await conn.connect(); await conn.login()
console.log('before:', await count())
const env = createEnvelope({ type:'event', from:'phone', to:'dsh-pc', secret: cred.deviceSecret, ttl: 300, payload: { kind:'probe', marker:'dbg7' } })
await mb.put(env)
console.log('after put:', await count())
// 手动走 ack 的内部步骤
await conn.select(mb.quietFolder)
const uids = await conn.searchAllUids({ limit: 100 })
console.log('uids count', uids.length, 'tail', uids.slice(-3))
let hit = null
for (const uid of uids) {
  const raw = await conn.fetchRaw(uid)
  if (!raw) continue
  if (raw.includes(env.id)) { hit = uid; break }
}
console.log('hit uid', hit)
if (hit) {
  const mv = await conn.moveToTrash([hit], mb.trashFolder)
  console.log('moveToTrash ->', mv)
}
console.log('after ack:', await count())
conn.logout()
