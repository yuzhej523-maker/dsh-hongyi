#!/usr/bin/env node
/**
 * Local mock mailbox for 鸿驿 — zero model calls, zero network egress.
 *
 * Implements the four calls MailboxClient uses:
 *   POST /mailbox/:box                { envelope }      -> { ok, id, receipt }
 *   GET  /mailbox/:box?since=&limit=                   -> { items: [{ envelope, receivedAt }] }
 *   POST /mailbox/:box/ack            { ids }          -> { acked: [...] }
 *   GET  /health                                        -> { ok, box, protocol, ... }
 * Plus /debug/dump for eyeballing state and /debug/reset to clear it.
 *
 * Behaviour worth knowing:
 *   - acked ids stay in the store but are hidden from GET (that is the TTL-free
 *     "delivered" marker), so acking twice is harmless;
 *   - TTL is evaluated against the SERVER clock, never the envelope's own `ts`,
 *     so a machine with a skewed clock cannot make the mailbox drop good data
 *     (C 组「时钟漂移」的预防设计);
 *   - duplicate ids are rejected with 409 rather than double-stored, which is
 *     what makes client-side retries safe.
 *
 * Usage: node mock/server.mjs [--port 7654] [--host 127.0.0.1] [--token <t>]
 */
import http from 'node:http'

function parseArgs(argv) {
  const out = { port: 7654, host: '127.0.0.1', token: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--port') out.port = Number(argv[++i]) || out.port
    else if (arg === '--host') out.host = argv[++i] || out.host
    else if (arg === '--token') out.token = argv[++i] || ''
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

/** box -> Map<id, { envelope, receivedAt, acked }> */
const boxes = new Map()
const stats = { started: new Map(), delivered: new Map(), rejected: new Map() }

function boxStore(box) {
  let store = boxes.get(box)
  if (!store) {
    store = new Map()
    boxes.set(box, store)
  }
  return store
}

function bump(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function send(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim().length === 0) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

/** Server-clock TTL: an envelope is expired only when it outlived its ttl by our clock. */
function expired(entry, now) {
  const ttl = Number(entry.envelope?.ttl ?? 0)
  if (!Number.isFinite(ttl) || ttl <= 0) return false
  return now - entry.receivedAt > ttl * 1000
}

function purge(store) {
  const now = Date.now()
  let removed = 0
  for (const [id, entry] of store) {
    if (expired(entry, now)) {
      store.delete(id)
      removed += 1
    }
  }
  return removed
}

function authorized(req) {
  if (!args.token) return true
  const header = req.headers.authorization ?? ''
  return header === `Bearer ${args.token}`
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const { pathname } = url

  if (pathname === '/health') {
    // Auth applies here too, on purpose: the settings card's 测试连接 must prove
    // the credential works, not merely that a socket opened.
    if (!authorized(req)) return send(res, 401, { error: 'invalid token' })
    return send(res, 200, {
      ok: true,
      service: 'hongyi-mock-mailbox',
      protocol: 1,
      boxes: [...boxes.keys()],
      time: new Date().toISOString(),
      authRequired: args.token.length > 0,
    })
  }

  if (pathname === '/debug/dump' && req.method === 'GET') {
    const dump = {}
    for (const [box, store] of boxes) {
      dump[box] = [...store.values()].map((entry) => ({
        id: entry.envelope?.id,
        type: entry.envelope?.type,
        ts: entry.envelope?.ts,
        acked: entry.acked,
        receivedAt: new Date(entry.receivedAt).toISOString(),
      }))
    }
    return send(res, 200, { boxes: dump, stats: Object.fromEntries(stats.started) })
  }

  if (pathname === '/debug/reset' && req.method === 'POST') {
    boxes.clear()
    return send(res, 200, { ok: true })
  }

  const match = /^\/mailbox\/([^/]+)(\/ack)?$/.exec(pathname)
  if (!match) return send(res, 404, { error: 'not found' })
  if (!authorized(req)) return send(res, 401, { error: 'invalid token' })

  const box = decodeURIComponent(match[1])
  const isAck = match[2] === '/ack'

  if (isAck && req.method === 'POST') {
    let body
    try {
      body = await readBody(req)
    } catch (error) {
      return send(res, 400, { error: error.message })
    }
    const store = boxStore(box)
    const acked = []
    for (const id of Array.isArray(body.ids) ? body.ids : []) {
      const entry = store.get(String(id))
      if (!entry) continue
      entry.acked = true
      acked.push(String(id))
    }
    bump(stats.delivered, box)
    return send(res, 200, { ok: true, acked })
  }

  if (!isAck && req.method === 'POST') {
    let body
    try {
      body = await readBody(req)
    } catch (error) {
      return send(res, 400, { error: error.message })
    }
    const env = body?.envelope
    if (env === null || typeof env !== 'object' || typeof env.id !== 'string') {
      return send(res, 400, { error: 'body.envelope with a string id is required' })
    }
    const store = boxStore(box)
    if (store.has(env.id)) {
      bump(stats.rejected, box)
      return send(res, 409, { error: 'duplicate id', id: env.id })
    }
    store.set(env.id, { envelope: env, receivedAt: Date.now(), acked: false })
    bump(stats.started, box)
    return send(res, 200, { ok: true, id: env.id, receipt: { box, at: new Date().toISOString() } })
  }

  if (!isAck && req.method === 'GET') {
    const store = boxStore(box)
    const purged = purge(store)
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 200)
    const since = url.searchParams.get('since')
    const sinceMs = since ? Date.parse(since) : Number.NaN
    const items = []
    for (const entry of store.values()) {
      if (entry.acked) continue
      if (Number.isFinite(sinceMs) && entry.receivedAt <= sinceMs) continue
      items.push({ envelope: entry.envelope, receivedAt: new Date(entry.receivedAt).toISOString() })
    }
    items.sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt))
    return send(res, 200, { ok: true, box, items: items.slice(0, limit), purged })
  }

  return send(res, 405, { error: 'method not allowed', allow: ['GET', 'POST'] })
})

server.listen(args.port, args.host, () => {
  process.stdout.write(
    `hongyi mock mailbox listening on http://${args.host}:${args.port} (box: any; auth: ${args.token ? 'on' : 'off'})\n`,
  )
})

function shutdown() {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
