/**
 * 文件传输 —— 走同一条信箱通道（草稿箱/IMAP、HTTP、同步文件夹都适用）。
 *
 * 为什么不直接用邮件附件：
 *   · 附件要写 MIME multipart，QQ 草稿箱 APPEND 的体积/编码行为未验证；
 *   · 我们的信箱本来就是「一条消息 = 一个 JSON 信封」，附件要多写一套解析。
 * 所以走**分块**：文件切成 N 片，每片一个 type='file' 的信封，payload 里带
 *   { tid, name, size, sha256, idx, total, data(base64) }
 * 接收端把同 tid 的片存进 inbox/.partial/<tid>/，齐了拼回原文件并校验 sha256，
 * 再删掉分片。好处：
 *   · 复用现成的幂等（信封 id）、TTL、重试（Outbox）、ack（删草稿）机制；
 *   · 每个信封都很小，不会撞任何通道的单条大小限制；
 *   · 单向浏览器/手机/电脑都能收，不依赖任何一端常驻服务。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

import { createEnvelope, isExpired } from './envelope.js'
import { journal } from './store.js'

/** 每片原始字节。base64 后约 1.37 倍，256KB → 350KB 一条信封。 */
export const DEFAULT_CHUNK_BYTES = 256 * 1024

/** 单文件上限（防止误传一个 4GB 镜像把信箱塞满）。 */
export const MAX_FILE_BYTES = 200 * 1024 * 1024

export function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** 把文件名压成安全的单段名字（防止 ../ 与非法字符）。 */
export function safeName(name) {
  const base = path.basename(String(name ?? '').trim() || 'file.bin')
  const cleaned = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_')
  return cleaned.slice(0, 120) || 'file.bin'
}

/**
 * 把文件切成信封数组。
 * @returns {Promise<{tid, name, size, sha256, total, envelopes}>}
 */
export async function buildFileEnvelopes(filePath, {
  from,
  to,
  secret,
  ttl = 3600,
  chunkBytes = DEFAULT_CHUNK_BYTES,
  now = Date.now(),
} = {}) {
  const stat = await fs.stat(filePath)
  if (!stat.isFile()) throw new Error(`不是文件：${filePath}`)
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`文件太大（${(stat.size / 1048576).toFixed(1)}MB），上限 ${MAX_FILE_BYTES / 1048576}MB`)
  }
  const buf = await fs.readFile(filePath)
  const name = safeName(path.basename(filePath))
  const digest = sha256Hex(buf)
  const total = Math.max(1, Math.ceil(buf.length / chunkBytes))
  const tid = `file_${now.toString(36)}_${crypto.randomBytes(5).toString('hex')}`
  const envelopes = []
  for (let idx = 0; idx < total; idx += 1) {
    const slice = buf.subarray(idx * chunkBytes, Math.min(buf.length, (idx + 1) * chunkBytes))
    envelopes.push(createEnvelope({
      type: 'file',
      from,
      to,
      ts: new Date(now + idx).toISOString(),
      ttl,
      secret,
      payload: {
        kind: 'file',
        tid,
        name,
        size: buf.length,
        sha256: digest,
        idx,
        total,
        data: slice.toString('base64'),
      },
    }))
  }
  return { tid, name, size: buf.length, sha256: digest, total, envelopes }
}

/** 通过 Outbox 逐片投递（失败的那片会被安排重试，不丢）。 */
export async function sendFile({ filePath, client, outbox, from, to, secret, ttl, chunkBytes, now }) {
  const built = await buildFileEnvelopes(filePath, { from, to, secret, ttl, chunkBytes, now })
  // outbox 可以为空（例如 relay 还没起来）：那样就直接投递，失败的片只在返回值里报。
  if (outbox?.enqueue) {
    await outbox.load?.()
    for (const env of built.envelopes) await outbox.enqueue(env)
  }
  let sent = 0
  let firstError = null
  for (const env of built.envelopes) {
    try {
      await client.put(env)
      await outbox?.markSent?.(env.id)
      sent += 1
    } catch (error) {
      if (error?.status === 409 || error?.details?.status === 409) {
        await outbox?.markSent?.(env.id)
        sent += 1
        continue
      }
      await outbox?.markFailed?.(env.id, error)
      firstError = error
      break
    }
  }
  return { ...built, envelopes: undefined, sent, firstError: firstError?.message ?? null, done: sent === built.total }
}

/** 分片目录。 */
export function partialDir(inboxDir, tid) {
  return path.join(inboxDir, '.partial', sanitizeTid(tid))
}

export function sanitizeTid(tid) {
  return String(tid ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'unknown'
}

/**
 * 收一片。返回 {state:'partial'|'done'|'bad', ...}。
 * 齐了就把拼好的文件写到 inboxDir/<name>，sha256 不符则拒收并删掉分片。
 */
export async function receiveChunk(env, { inboxDir, journalFile = null }) {
  const p = env?.payload ?? {}
  if (p.kind !== 'file' || typeof p.tid !== 'string' || typeof p.data !== 'string') {
    return { state: 'bad', reason: 'payload 不是文件分片' }
  }
  const tid = sanitizeTid(p.tid)
  const total = Number(p.total)
  const idx = Number(p.idx)
  if (!Number.isInteger(total) || total <= 0 || !Number.isInteger(idx) || idx < 0 || idx >= total) {
    return { state: 'bad', reason: `分片序号非法 idx=${p.idx} total=${p.total}` }
  }
  const dir = partialDir(inboxDir, tid)
  await fs.mkdir(dir, { recursive: true })
  const chunkFile = path.join(dir, `${String(idx).padStart(6, '0')}.bin`)
  await fs.writeFile(chunkFile, Buffer.from(p.data, 'base64'))
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({
    tid, name: safeName(p.name), size: p.size, sha256: p.sha256, total, updatedAt: new Date().toISOString(),
  }), 'utf8')

  const present = (await fs.readdir(dir)).filter((f) => f.endsWith('.bin'))
  if (present.length < total) {
    if (journalFile) await journal(journalFile, { kind: 'file-chunk', tid, idx, have: present.length, total })
    return { state: 'partial', tid, name: safeName(p.name), have: present.length, total }
  }

  const parts = []
  for (let i = 0; i < total; i += 1) {
    parts.push(await fs.readFile(path.join(dir, `${String(i).padStart(6, '0')}.bin`)))
  }
  const buf = Buffer.concat(parts)
  const name = safeName(p.name)
  const expectedSize = Number(p.size)
  const digest = sha256Hex(buf)
  if (Number.isFinite(expectedSize) && buf.length !== expectedSize) {
    await fs.rm(dir, { recursive: true, force: true })
    if (journalFile) await journal(journalFile, { kind: 'file-rejected', tid, reason: 'size-mismatch', want: expectedSize, got: buf.length })
    return { state: 'bad', tid, reason: `大小不符：期望 ${expectedSize}，实收 ${buf.length}` }
  }
  if (p.sha256 && digest !== p.sha256) {
    await fs.rm(dir, { recursive: true, force: true })
    if (journalFile) await journal(journalFile, { kind: 'file-rejected', tid, reason: 'sha256-mismatch', want: p.sha256, got: digest })
    return { state: 'bad', tid, reason: 'sha256 校验失败' }
  }
  await fs.mkdir(inboxDir, { recursive: true })
  let target = path.join(inboxDir, name)
  try {
    await fs.access(target)
    const stem = name.replace(/(\.[^.]+)?$/, '')
    const ext = name.slice(stem.length)
    target = path.join(inboxDir, `${stem}-${tid.slice(-6)}${ext}`)
  } catch { /* 不存在就用原名 */ }
  await fs.writeFile(target, buf)
  await fs.rm(dir, { recursive: true, force: true })
  if (journalFile) await journal(journalFile, { kind: 'file-received', tid, name: path.basename(target), size: buf.length, sha256: digest })
  return { state: 'done', tid, name: path.basename(target), path: target, size: buf.length, sha256: digest }
}

/** 列出 inbox 里的文件（给卡片/手机看）。 */
export async function listInbox(inboxDir, { limit = 20 } = {}) {
  try {
    const entries = await fs.readdir(inboxDir, { withFileTypes: true })
    const files = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const full = path.join(inboxDir, entry.name)
      const stat = await fs.stat(full)
      files.push({ name: entry.name, size: stat.size, mtime: stat.mtime.toISOString() })
    }
    files.sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
    return files.slice(0, limit)
  } catch {
    return []
  }
}

/** 列出没拼完的分片。 */
export async function listPartial(inboxDir) {
  const base = path.join(inboxDir, '.partial')
  try {
    const dirs = await fs.readdir(base, { withFileTypes: true })
    const out = []
    for (const d of dirs) {
      if (!d.isDirectory()) continue
      const dir = path.join(base, d.name)
      let meta = {}
      try { meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8')) } catch { /* 忽略 */ }
      const have = (await fs.readdir(dir)).filter((f) => f.endsWith('.bin')).length
      out.push({ tid: d.name, name: meta.name ?? '?', have, total: meta.total ?? null, updatedAt: meta.updatedAt ?? null })
    }
    return out
  } catch {
    return []
  }
}

/** 过期分片清理（信封 TTL 到了还没凑齐就丢掉，避免占盘）。 */
export async function prunePartials(inboxDir, { maxAgeMs = 24 * 3600 * 1000, now = Date.now() } = {}) {
  const partials = await listPartial(inboxDir)
  let removed = 0
  for (const p of partials) {
    const at = p.updatedAt ? Date.parse(p.updatedAt) : NaN
    if (Number.isFinite(at) && now - at > maxAgeMs) {
      await fs.rm(partialDir(inboxDir, p.tid), { recursive: true, force: true })
      removed += 1
    }
  }
  return removed
}

export { isExpired }
