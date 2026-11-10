/**
 * 任务监测（task monitor）—— 让手机看到「电脑上正在跑什么、跑到哪、有没有卡壳」。
 *
 * 数据源选择（按优先级）：
 *   1. 本机 bgjobs 插件的 `/bgjobs/state`（同一个 webServer 上就有，最全）：
 *      返回 `{ ok, ready, jobs: [{ id, name, status, exitCode, logPath, tail,
 *      workdir, engine, createdAt, finishedAt }] }`。
 *   2. 磁盘直读 `<workdir>/.dsh/bgjobs/<id>/job.json`（bgjobs 没装/被禁用时的兜底）。
 *
 * 只用文件与本地 HTTP，**不调用任何模型**（省积分铁律）。
 *
 * 「卡壳」判定：任务 status=running 且它的日志文件超过 `stallAfterSec` 秒没变化，
 * 就算 stalled。这不是绝对正确（一个安静的长任务也会命中），所以它只是给手机
 * 的一个提示位，而不是自动处置的依据。
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import { digestTail } from './relay/telemetry.js'

const DEFAULT_STALL_AFTER_SEC = 180

/** 读一个文件的 mtime（读不到返回 null，绝不抛）。 */
async function mtimeMs(file) {
  try {
    const stat = await fs.stat(file)
    return stat.mtimeMs
  } catch {
    return null
  }
}

/** 从磁盘兜底读任务：<workdir>/.dsh/bgjobs/<id>/job.json */
async function readJobsFromDisk(workdirs) {
  const jobs = []
  for (const dir of workdirs) {
    if (!dir) continue
    const root = path.join(dir, '.dsh', 'bgjobs')
    let entries = []
    try {
      entries = await fs.readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      try {
        const raw = await fs.readFile(path.join(root, entry.name, 'job.json'), 'utf8')
        const job = JSON.parse(raw.replace(/^\uFEFF/u, ''))
        jobs.push({ ...job, logPath: job.logPath ?? path.join(root, entry.name, 'stdout.log') })
      } catch {
        /* 一个坏 job.json 不该毁掉整个列表 */
      }
    }
  }
  return jobs
}

/**
 * 时间字段转毫秒。
 *
 * bgjobs 的 `/bgjobs/state` 里 `createdAt`/`finishedAt` 是**数字毫秒**，
 * 磁盘上的 job.json 也可能是 ISO 字符串。`Date.parse()` 只认字符串，喂数字
 * 会返回 NaN —— 于是 `ageSec` 变成 null、手机端显示「已跑 nulls」。这里
 * 两种都接，认不出来才返回 null。
 */
function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** 把 bgjobs 的 job 记录压成手机要看的那几个字段。 */
async function summarize(job, { now, stallAfterSec }) {
  const createdAt = toMs(job.createdAt) ?? toMs(job.finishedAt)
  const finishedAt = toMs(job.finishedAt)
  const logMtime = job.logPath ? await mtimeMs(job.logPath) : null
  const lastActivity = logMtime ?? finishedAt ?? createdAt
  const idleSec = lastActivity ? Math.max(0, Math.round((now - lastActivity) / 1000)) : null
  const running = job.status === 'running'
  const stalled = running && idleSec !== null && idleSec >= stallAfterSec
  return {
    id: job.id,
    name: job.name ?? job.id,
    status: job.status ?? 'unknown',
    exitCode: job.exitCode ?? null,
    engine: job.engine ?? null,
    ageSec: createdAt ? Math.round((now - createdAt) / 1000) : null,
    idleSec,
    stalled,
    tail: typeof job.tail === 'string' ? job.tail.slice(-240) : '',
  }
}

/**
 * 采集任务快照。
 *
 * @param {object} options
 * @param {string} [options.origin]       本机 DSH 的 webServer origin（取 /bgjobs/state 用）
 * @param {string[]} [options.workdirs]   磁盘兜底要扫的工作目录
 * @param {number} [options.recentLimit]  返回给手机的任务条数上限（默认 5）
 * @param {number} [options.stallAfterSec] 多久没日志算卡壳（默认 180）
 * @param {number} [options.timeoutMs]    取 HTTP 的超时
 */
export async function collectTasks({
  origin = '',
  workdirs = [],
  recentLimit = 5,
  stallAfterSec = DEFAULT_STALL_AFTER_SEC,
  timeoutMs = 4000,
} = {}) {
  const now = Date.now()
  let source = 'none'
  let all = []

  if (origin) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const response = await fetch(`${origin.replace(/\/+$/, '')}/bgjobs/state`, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      })
      clearTimeout(timer)
      if (response.ok) {
        const body = await response.json()
        if (Array.isArray(body?.jobs)) {
          all = body.jobs
          source = 'bgjobs'
        }
      }
    } catch {
      /* bgjobs 不在/未启用：退回磁盘 */
    }
  }

  if (source === 'none') {
    const fromDisk = await readJobsFromDisk(workdirs)
    if (fromDisk.length > 0) {
      all = fromDisk
      source = 'disk'
    }
  }

  const summarized = []
  for (const job of all) {
    try {
      summarized.push(await summarize(job, { now, stallAfterSec }))
    } catch {
      /* 单条坏数据跳过 */
    }
  }

  // 排序：running 优先，其次按开始时间倒序 —— 手机上最关心「现在跑着什么」。
  summarized.sort((a, b) => {
    const ra = a.status === 'running' ? 0 : 1
    const rb = b.status === 'running' ? 0 : 1
    if (ra !== rb) return ra - rb
    return (b.ageSec ?? 0) === (a.ageSec ?? 0) ? 0 : (a.ageSec ?? Infinity) - (b.ageSec ?? Infinity)
  })

  const running = summarized.filter((t) => t.status === 'running')
  const failed = summarized.filter((t) => t.status === 'done' && t.exitCode !== null && t.exitCode !== 0)
  const stalled = running.filter((t) => t.stalled)

  const recent = summarized.slice(0, recentLimit)
  const signature = digestTail(
    running.map((t) => `${t.id}:${t.status}:${t.stalled ? 'S' : ''}`).sort().join(','),
    failed.map((t) => `${t.id}:${t.exitCode}`).sort().join(','),
    recent[0]?.id ?? '',
  )

  return {
    ok: true,
    source,
    total: summarized.length,
    running: running.length,
    failed: failed.length,
    stalled: stalled.length,
    /** 只用于节流比较的短指纹，不进信封。 */
    signature,
    recent,
    updatedAt: new Date(now).toISOString(),
  }
}

/** 给「tasks」指令生成一段人能读的中文摘要（回执正文）。 */
export function describeTasks(tasks) {
  if (!tasks || !tasks.ok) return '任务监测不可用'
  if (tasks.total === 0) return '没有后台任务记录'
  const head = `${tasks.running} 个运行中 · ${tasks.failed} 个失败 · 共 ${tasks.total} 个`
  const lines = tasks.recent.map((t) => {
    const flag = t.status === 'running' ? (t.stalled ? '⏸ 疑似卡住' : '▶ 运行中') : t.exitCode === 0 ? '✔ 完成' : `✘ 退出 ${t.exitCode}`
    const idle = t.idleSec === null ? '' : ` · 静止 ${t.idleSec}s`
    return `· ${t.name} [${flag}]${idle}`
  })
  return [head, ...lines].join('\n')
}

/**
 * 回执里带的任务摘要 —— 手机不用再发一次 `tasks` 就能直接渲染卡片。
 * 只留手机画卡片要用的字段（控制信封体积，一封邮件别塞几十 KB）。
 */
export function summarizeForAck(tasks) {
  if (!tasks || !tasks.ok) return null
  return {
    running: tasks.running,
    failed: tasks.failed,
    stalled: tasks.stalled,
    total: tasks.total,
    recent: tasks.recent.map((t) => ({
      id: t.id,
      name: t.name,
      status: t.status,
      exitCode: t.exitCode,
      idleSec: t.idleSec,
      stalled: t.stalled,
    })),
  }
}
