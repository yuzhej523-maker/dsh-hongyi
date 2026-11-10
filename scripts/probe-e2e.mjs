import { loadConfig, loadCredentials } from '../lib/config.js'
import { createMailbox } from '../lib/mailbox/factory.js'
import { createEnvelope } from '../lib/envelope.js'

const config = await loadConfig()
const cred = await loadCredentials()
const mb = createMailbox(config, cred)
console.log('driver', config.driver, 'quiet', mb.quiet, 'quietFolder', mb.quietFolder)

const env = createEnvelope({ type: 'command', from: config.phoneId, to: config.deviceId, ttl: 600,
  secret: cred.deviceSecret, payload: { kind: 'command', cmd: 'status' } })
console.log('put cmd', env.id)
await mb.put(env)

for (let i = 0; i < 12; i++) {
  await new Promise(r => setTimeout(r, 5000))
  const items = await mb.pull({ limit: 30 })
  const ids = items.map(it => {
    const e = it.envelope ?? it
    return `${e.type}:${e.from}>${e.to}:${String(e.id).slice(0, 26)} ackOf=${e.payload?.ackOf ? String(e.payload.ackOf).slice(0,26) : '-'}`
  })
  console.log(`[+${(i+1)*5}s] pull=${items.length}`, ids.slice(0, 6))
  if (items.some(it => (it.envelope ?? it).payload?.ackOf === env.id)) { console.log('GOT ACK at +' + (i+1)*5 + 's'); break }
}
await mb.close?.()
