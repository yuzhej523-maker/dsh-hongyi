import { loadConfig, loadCredentials } from '../lib/config.js'
import { createMailbox } from '../lib/mailbox/factory.js'
import { ImapConnection } from '../lib/mailbox/imap.js'
const cfg = await loadConfig(); const cred = await loadCredentials()
const mb = createMailbox(cfg, cred)
const c = new ImapConnection({ host: mb.imapHost, port: 993, user: mb.user, auth: mb.auth, timeoutMs: 30000 })
await c.connect(); await c.login()
for (const f of ['Drafts', 'Deleted Messages']) {
  const r = await c.command(`STATUS "${f}" (MESSAGES)`)
  console.log(f, '→', /MESSAGES (\d+)/.exec(r)?.[1])
}
c.logout()
console.time('pull40')
const r = await mb.pull({ limit: 40 })
console.timeEnd('pull40')
const arr = Array.isArray(r) ? r : (r.items ?? [])
console.log('returned', arr.length)
const now = Date.now()
const ages = arr.map(x => Math.round((now - Date.parse((x?.envelope ?? x)?.ts ?? 0)) / 1000))
console.log('age(s) of returned:', ages.slice(0, 8), '... max', Math.max(...ages))
