/**
 * Phone-side simulator for the live instance.
 *
 * Writes one command envelope into the mailbox the running DSH instance is
 * watching (its real DSH_HOME, real config), then waits and reports whether the
 * instance picked it up, executed it and acked it.
 *
 * Run: node scripts/send-command.mjs "status"
 *      node scripts/send-command.mjs --cmd download --arg https://example.com/x.bin
 */
import { createMailbox } from '../lib/mailbox/factory.js'
import { createEnvelope } from '../lib/envelope.js'
import { loadConfig, loadCredentials } from '../lib/config.js'

const argv = process.argv.slice(2)
let payload
if (argv[0] === '--cmd') {
  payload = { cmd: argv[1] }
  const argIndex = argv.indexOf('--arg')
  if (argIndex >= 0) payload.arg = argv[argIndex + 1]
} else {
  payload = { text: argv.join(' ') || 'status' }
}

const config = await loadConfig()
const credentials = await loadCredentials()
const where = config.driver === 'folder' || config.driver === 'tdrive'
  ? `${config.folderRoot}/${config.box}（同步文件夹）`
  : `${config.baseUrl}/${config.box}`
console.log(`信箱：${where}`)
console.log(`通道：${config.driver}`)
console.log(`本机 id：${config.deviceId}　手机 id：${config.phoneId}`)
console.log(`payload：${JSON.stringify(payload)}`)

const client = createMailbox(config, credentials)

const envelope = createEnvelope({
  type: 'command',
  from: config.phoneId,
  to: config.deviceId,
  ttl: 600,
  secret: credentials.deviceSecret,
  payload,
})
await client.put(envelope)
console.log(`\n✔ 已写入指令 id=${envelope.id}`)

const started = Date.now()
let lastSeen = null
for (let i = 0; i < 40; i += 1) {
  await new Promise((r) => setTimeout(r, 3000))
  const items = await client.pull({ limit: 100 })
  const envelopes = items.map((item) => item.envelope ?? item)
  const ack = envelopes.find((env) => env.type === 'ack' && env.payload?.ackOf === envelope.id)
  const still = envelopes.find((env) => env.id === envelope.id)
  if (ack) {
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    console.log(`\n✔ ${seconds}s 后收到回执`)
    console.log(`  回执 id=${ack.id}`)
    console.log(`  payload=${JSON.stringify(ack.payload)}`)
    console.log(`  ack 已取代原指令（原指令仍在信箱=${Boolean(still)}）`)
    process.exit(0)
  }
  if (still && lastSeen !== 'pending') {
    console.log(`  …指令仍在信箱，等待实例轮询（第 ${i + 1} 次检查）`)
    lastSeen = 'pending'
  }
}
console.log('\n✘ 120 秒内没有收到回执')
process.exit(1)
