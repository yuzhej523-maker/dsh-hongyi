/**
 * 分片文件传输探针：用真实信箱（默认读 DSH_HOME 配置）跑一次
 *   造文件 → 切分片 → put → pull → 拼回 → 比对 sha256
 * 用法：node scripts/probe-file.mjs [--size 300000] [--chunk 262144] [--keep]
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

import { loadConfig, loadCredentials } from '../lib/config.js'
import { createMailbox } from '../lib/mailbox/factory.js'
import { buildFileEnvelopes, receiveChunk, listInbox, listPartial, prunePartials } from '../lib/transfer.js'

const argv = process.argv.slice(2)
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const SIZE = Number(arg('size', 300_000))
const CHUNK = Number(arg('chunk', 262_144))
const KEEP = argv.includes('--keep')

const config = await loadConfig()
const credentials = await loadCredentials()
if (!credentials.deviceSecret) throw new Error('设备密钥未设置：先在设置卡片点「生成新密钥」')

const client = createMailbox(config, credentials)
const where = config.driver === 'imap'
  ? `${config.imapUser}/草稿箱（${config.imapProvider}）`
  : `${config.baseUrl}/${config.box}`
console.log(`通道 ${config.driver} → ${where}`)
console.log(`分片 ${(CHUNK / 1024).toFixed(0)}KB，文件 ${(SIZE / 1024).toFixed(0)}KB`)

const work = await fs.mkdtemp(path.join(os.tmpdir(), 'hongyi-file-'))
const src = path.join(work, '样例文件.bin')
const buf = crypto.randomBytes(SIZE)
await fs.writeFile(src, buf)
const srcSha = crypto.createHash('sha256').update(buf).digest('hex')
console.log(`源文件 ${src}  ${buf.length}B  sha256 ${srcSha.slice(0, 16)}…`)

const built = await buildFileEnvelopes(src, {
  from: config.deviceId,
  to: config.phoneId,
  secret: credentials.deviceSecret,
  chunkBytes: CHUNK,
  ttl: 600,
})
console.log(`切出 ${built.total} 片，tid=${built.tid}`)

let putOk = 0
const t0 = Date.now()
for (const env of built.envelopes) {
  const bytes = Buffer.byteLength(JSON.stringify(env))
  const started = Date.now()
  try {
    await client.put(env)
    putOk += 1
    console.log(`  ✔ 片 ${env.payload.idx}/${built.total - 1}  信封 ${(bytes / 1024).toFixed(0)}KB  ${Date.now() - started}ms`)
  } catch (error) {
    console.log(`  ✘ 片 ${env.payload.idx}  ${(bytes / 1024).toFixed(0)}KB  ${error?.message ?? error}`)
    break
  }
}
console.log(`写入 ${putOk}/${built.total} 片，共 ${((Date.now() - t0) / 1000).toFixed(1)}s`)

// 回收：从信箱拉回来重新拼
const inbox = path.join(work, 'inbox')
await fs.mkdir(inbox, { recursive: true })
let got = 0
let result = null
for (let round = 0; round < 12; round += 1) {
  const items = await client.pull({ limit: 40 })
  let handled = 0
  for (const item of items) {
    const env = item?.envelope ?? item
    if (env?.type !== 'file' || env.payload?.tid !== built.tid) continue
    const res = await receiveChunk(env, { inboxDir: inbox })
    handled += 1
    got += 1
    if (res.state === 'done') result = res
    if (res.state === 'bad') console.log(`  ! ${res.reason}`)
  }
  if (result) break
  if (handled > 0) console.log(`  第 ${round + 1} 轮收到 ${handled} 片（累计 ${got}）`)
  await new Promise((r) => setTimeout(r, 3000))
}

console.log('— 分片目录', JSON.stringify(await listPartial(inbox)))
if (!result) {
  console.log('✘ 没有拼齐')
  process.exitCode = 1
} else {
  const out = await fs.readFile(result.path)
  const outSha = crypto.createHash('sha256').update(out).digest('hex')
  const same = outSha === srcSha
  console.log(`${same ? '✔' : '✘'} 拼回 ${result.name}  ${out.length}B  sha256 ${outSha.slice(0, 16)}…`)
  console.log(`  来源文件 sha256 ${srcSha.slice(0, 16)}…  ${same ? '完全一致' : '不一致！'}`)
  console.log('— inbox', JSON.stringify(await listInbox(inbox)))
  if (!same) process.exitCode = 1
}

// 清理：把自己写进去的信封 ack 掉（草稿箱模式=删草稿），并清过期分片
try {
  const ids = []
  for (const env of built.envelopes) ids.push(env.id)
  await client.ack(ids)
  console.log(`已清理 ${ids.length} 条信封`)
} catch (error) {
  console.log(`清理失败（不影响结论）：${error?.message ?? error}`)
}
console.log('过期分片清理', await prunePartials(inbox))
if (!KEEP) await fs.rm(work, { recursive: true, force: true })
else console.log(`保留临时目录 ${work}`)
