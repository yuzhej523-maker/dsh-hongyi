import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { Relay } from '../lib/relay/engine.js'
import { MailboxClient } from '../lib/mailbox/client.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dbg-b-'))
const secret = 'a'.repeat(32)
const store = new Map()
const hits = []
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  let body = ''
  for await (const c of req) body += c
  hits.push(`${req.method} ${url.pathname} ${body.slice(0, 80)}`)
  if (url.pathname.endsWith('/ack') && req.method === 'POST') {
    const { ids = [] } = JSON.parse(body || '{}'); ids.forEach(i => store.delete(i))
    res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({ok:true,acked:ids})); return
  }
  if (req.method === 'POST') {
    const env = JSON.parse(body)
    if (store.has(env.id)) { res.writeHead(409,{'content-type':'application/json'}); res.end(JSON.stringify({error:'duplicate id'})); return }
    store.set(env.id, { envelope: env, receivedAt: new Date().toISOString() })
    res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({ok:true,id:env.id})); return
  }
  res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({ok:true,items:[...store.values()]}))
})
await new Promise(r => server.listen(0,'127.0.0.1',r))
const baseUrl = `http://127.0.0.1:${server.address().port}`
const config = { driver:'mock', baseUrl, box:'dsh-hongyi', deviceId:'dsh-pc', phoneId:'phone',
  telemetry:{onChangeOnly:true,minGapSec:0,summaryIntervalSec:600,heartbeatSec:30,offlineAfterSec:180},
  queue:{maxAttempts:4,baseBackoffMs:200,maxBackoffMs:2000} }
const credentials = { deviceSecret: secret }
const buildClient = async () => ({ config, credentials, client: new MailboxClient({ baseUrl, box:config.box, token:'', secret, timeoutMs:2500 }) })
const dir = path.join(root,'home')
const paths = {
  queueFile:()=>path.join(dir,'outbound.json'), journalFile:()=>path.join(dir,'journal.ndjson'),
  inboundLedger:()=>path.join(dir,'inbound.json'), pendingModelFile:()=>path.join(dir,'needs-model.json'),
  inboxDir:()=>path.join(dir,'inbox') }
const relay = new Relay({ buildClient, limits: config.queue, paths })
console.log('tick1', JSON.stringify(await relay.tick()).slice(0,400))
console.log('store', store.size, [...store.keys()])
console.log('hits', hits)
const jr = await fs.readFile(paths.journalFile(),'utf8').catch(()=>'(none)')
console.log('journal first 600:', jr.slice(0,600))
relay.stop(); await new Promise(r=>server.close(r))
