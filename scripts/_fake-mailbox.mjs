/**
 * 测试用的假信箱：与 mock/server.mjs 同契约
 *   POST /mailbox/:box       body 是 { envelope }    → 200 {ok,id} / 409 duplicate
 *   GET  /mailbox/:box       → { ok, items: [{ envelope, receivedAt }] }
 *   POST /mailbox/:box/ack   body 是 { ids }         → { ok, acked }
 * 额外能力：setDown(true) 让所有请求返回 503（模拟断网）。
 */
import http from 'node:http'

export async function startFakeMailbox({ ttlSec = 3600 } = {}) {
  const stores = new Map()
  let down = false
  const stats = { posts: 0, gets: 0, acks: 0, conflicts: 0 }

  const server = http.createServer(async (req, res) => {
    if (down) { res.writeHead(503); res.end('down'); return }
    const url = new URL(req.url, 'http://x')
    const parts = url.pathname.split('/').filter(Boolean)      // ['mailbox', box, 'ack'?]
    const box = parts[1] ?? 'dsh-hongyi'
    if (!stores.has(box)) stores.set(box, new Map())
    const store = stores.get(box)
    let body = ''
    for await (const c of req) body += c

    if (parts[2] === 'ack' && req.method === 'POST') {
      stats.acks += 1
      const { ids = [] } = JSON.parse(body || '{}')
      for (const id of ids) store.delete(id)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, acked: ids }))
      return
    }

    if (req.method === 'POST') {
      stats.posts += 1
      const parsed = JSON.parse(body || '{}')
      const env = parsed.envelope ?? parsed           // 两种写法都认
      if (!env?.id) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'missing id' })); return }
      if (store.has(env.id)) {
        stats.conflicts += 1
        res.writeHead(409, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'duplicate id' }))
        return
      }
      store.set(env.id, { envelope: env, receivedAt: new Date().toISOString() })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, id: env.id }))
      return
    }

    stats.gets += 1
    const limit = Number(url.searchParams.get('limit') ?? 200)
    const now = Date.now()
    const items = []
    for (const [id, item] of store) {
      const ageSec = (now - Date.now(item.receivedAt)) / 1000
      const ttl = Number(item.envelope?.ttl ?? ttlSec)
      if (ttl > 0 && ageSec > ttl) { store.delete(id); continue }   // TTL 用服务器时钟
      items.push(item)
    }
    items.sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, items: items.slice(-limit) }))
  })

  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    port: server.address().port,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    stats,
    all: (box = 'dsh-hongyi') => [...(stores.get(box)?.values() ?? [])].map((i) => i.envelope),
    inject: (env, box = 'dsh-hongyi') => {
      if (!stores.has(box)) stores.set(box, new Map())
      stores.get(box).set(env.id, { envelope: env, receivedAt: new Date().toISOString() })
    },
    setDown: (v) => { down = v },
    close: () => new Promise((r) => server.close(r)),
  }
}
