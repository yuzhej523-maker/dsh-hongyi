import { loadConfig, loadCredentials } from '../lib/config.js'
import { createMailbox } from '../lib/mailbox/factory.js'
import { createEnvelope } from '../lib/envelope.js'

const config = await loadConfig()
const cred = await loadCredentials()
const mb = createMailbox(config, cred)

const env = createEnvelope({ type: 'command', from: config.phoneId, to: config.deviceId, ttl: 600,
  secret: cred.deviceSecret, payload: { kind: 'command', cmd: 'status' } })
console.log('PUT', env.id)
await mb.put(env)

for (let i = 0; i < 15; i++) {
  await new Promise(r => setTimeout(r, 4000))
  const items = await mb.pull({ limit: 60 })
  const lines = items.map(it => { const e = it.envelope ?? it
    return `${it.uid ?? '?'} ${e.type}/${e.from}>${e.to} ${e.id}${e.payload?.ackOf ? ' ackOf=' + e.payload.ackOf : ''}` })
  console.log(`[+${(i+1)*4}s] n=${items.length}`)
  for (const l of lines) console.log('   ', l)
  const got = items.find(it => (it.envelope ?? it).payload?.ackOf === env.id)
  if (got) { console.log('=== ACK SEEN at +' + (i+1)*4 + 's'); break }
}
await mb.close?.()
