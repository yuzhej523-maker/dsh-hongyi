#!/usr/bin/env node
/**
 * Host-half smoke test: exercises `apply()` against a stub Cordis context.
 *
 * This proves three things the browser card cannot show on its own:
 *   1. `apply()` registers exactly one `/hongyi` prefix route and one `/hongyi`
 *      command, through `ctx.effect` (so Cordis can dispose them);
 *   2. the route answers every action the card calls, with the JSON shape the
 *      card expects;
 *   3. the command handler returns a CommandResult (`{kind, text}`).
 *
 * It runs the real host half — same imports the DSH profile will load — against
 * a throwaway $DSH_HOME so it never touches the user's live config.
 */
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { fileURLToPath, pathToFileURL } from 'node:url'

// Point the plugin at a scratch home BEFORE importing it.
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'hongyi-host-'))
process.env.DSH_HOME = scratch

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const PORT = Number(process.env.HONGYI_MOCK_PORT ?? 7655)

const lines = []
const log = (line) => { lines.push(line); process.stdout.write(line + '\n') }
const ok = (line) => log(`✔ ${line}`)
function fail(message) { log(`✘ ${message}`); throw new Error(message) }

// A watchdog so a stuck probe reports instead of hanging the terminal.
const watchdog = setTimeout(() => {
  log('✘ 超时：步骤 60 秒未完成')
  process.exit(2)
}, 60000)
watchdog.unref?.()

const mock = spawn(process.execPath, [path.join(root, 'mock', 'server.mjs'), '--port', String(PORT)], { stdio: 'ignore' })

/** Set once the route is mounted, so `finally` can always release the socket. */
let routeServer = null

try {
  await delay(400)
  log('═══ 鸿驿 · Host 半边实测（桩 ctx） ═══')

  const plugin = await import(pathToFileURL(path.join(root, 'index.js')).href)
  if (typeof plugin.apply !== 'function') fail('index.js 未导出 apply()')
  ok('index.js 导出 apply()')

  // ---- stub context --------------------------------------------------------
  const routes = []
  const commands = []
  const effects = []
  const disposed = []

  const services = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    commands: {
      register(definition) {
        commands.push(definition)
        return () => {
          const index = commands.indexOf(definition)
          if (index >= 0) commands.splice(index, 1)
        }
      },
    },
  }

  /**
   * Cordis's real `ctx.inject(deps, cb)`: start `cb` only once every name in
   * `deps` exists, and give it a context that can read exactly those names.
   * The return value is a fiber (`{ dispose() }`), which is what the plugin now
   * tracks — so the stub must speak that shape or the disposal assertion below
   * is meaningless.
   */
  const inject = (deps, callback) => {
    const child = {
      ...ctx,
      inject,
      effect(factory) {
        effects.push(factory())
      },
    }
    for (const dep of deps) {
      if (services[dep] === undefined) throw new Error(`stub: missing service ${dep}`)
      child[dep] = services[dep]
    }
    const returned = callback(child)
    const dispose = () => {
      disposed.push(deps.join(','))
      if (typeof returned === 'function') returned()
    }
    return { dispose }
  }

  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    inject,
    effect(factory) {
      effects.push(factory())
    },
  }

  const dispose = plugin.apply(ctx, {})
  if (typeof dispose !== 'function') fail('apply() 未返回清理函数')
  ok('apply() 返回清理函数')

  if (routes.length !== 1) fail(`期望注册 1 条路由，实际 ${routes.length}`)
  const route = routes[0]
  if (route.kind !== 'prefix' || route.path !== '/hongyi') fail(`路由形状不符：${route.kind} ${route.path}`)
  ok(`注册路由：${route.kind} ${route.path}`)

  if (commands.length !== 1) fail(`期望注册 1 条命令，实际 ${commands.length}`)
  const command = commands[0]
  if (command.name !== 'hongyi') fail(`命令名不符：${command.name}`)
  ok(`注册命令：/${command.name}（${command.description}）`)

  if (effects.length !== 2) fail(`期望 2 个 effect，实际 ${effects.length}`)
  ok('两条资源都通过 ctx.effect 注册（Cordis 可回收）')

  // ---- drive the route over a real socket --------------------------------
  const server = http.createServer((req, res) => route.handler(req, res))
  routeServer = server
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`

  const call = async (pathname, body) => {
    const init = body === undefined
      ? { method: 'GET' }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    const response = await fetch(`${base}/hongyi/${pathname}`, init)
    const text = await response.text()
    return { status: response.status, data: text ? JSON.parse(text) : {} }
  }

  const state = await call('state')
  if (state.status !== 200 || state.data.plugin !== 'dsh-hongyi') fail('GET /hongyi/state 未返回插件状态')
  ok(`GET /hongyi/state → v${state.data.version} 协议 v${state.data.protocol}（${state.data.home}）`)

  const saved = await call('save', { baseUrl: `http://127.0.0.1:${PORT}`, driver: 'mock', box: 'dsh-hongyi' })
  if (saved.status !== 200 || saved.data.config.baseUrl !== `http://127.0.0.1:${PORT}`) fail('POST /hongyi/save 未生效')
  ok(`POST /hongyi/save → 信箱地址=${saved.data.config.baseUrl}`)

  const withToken = await call('token', { token: 'host-smoke-token' })
  if (!withToken.data.credentials.tokenSet) fail('POST /hongyi/token 未保存凭据')
  ok(`POST /hongyi/token → 已保存（显示为 ${withToken.data.credentials.token}）`)

  const secret = await call('secret', {})
  if (!secret.data.credentials?.deviceSecretSet) fail('POST /hongyi/secret 未生成设备密钥')
  ok('POST /hongyi/secret → 已生成设备密钥')

  const probe = await call('probe', {})
  if (!probe.data.ok) fail(`POST /hongyi/probe 失败：${probe.data.message}`)
  ok(`POST /hongyi/probe → ${probe.data.message}（${probe.data.latencyMs}ms）`)

  const ping = await call('ping', {})
  if (!ping.data.ok) fail(`POST /hongyi/ping 失败：${ping.data.message}`)
  ok(`POST /hongyi/ping → ${ping.data.message}`)

  const doctor = await call('doctor')
  ok(`GET /hongyi/doctor → ${doctor.data.summary}`)
  for (const check of doctor.data.checks) {
    log(`   ${check.ok ? '✔' : '✘'} ${check.label}：${check.detail}`)
  }
  if (!doctor.data.ok) fail('doctor 未全绿')

  const revoked = await call('revoke', {})
  if (revoked.data.credentials?.tokenSet) fail('POST /hongyi/revoke 未清除凭据')
  ok('POST /hongyi/revoke → 凭据与设备密钥均已删除')

  const getOnAction = await call('ping')
  if (getOnAction.status !== 405) fail(`GET 调用有副作用的操作应返回 405，实际 ${getOnAction.status}`)
  ok(`GET /hongyi/ping → 405 ${getOnAction.data.reason}`)

  const unknown = await call('nope')
  if (unknown.status !== 404) fail('未知操作未返回 404')
  ok(`未知操作返回 404：${unknown.data.reason}`)

  // ---- command handler ----------------------------------------------------
  const status = await command.handler({ rawInput: 'status', agent: { id: 's' }, signal: new AbortController().signal })
  if (status.kind !== 'success' || !status.text.includes('鸿驿')) fail('命令 status 输出异常')
  log(status.text.split('\n').map((l) => `   ${l}`).join('\n'))
  ok('/hongyi status 返回 CommandResult(success)')

  const doctorCmd = await command.handler({ rawInput: 'doctor', agent: { id: 's' }, signal: new AbortController().signal })
  if (!doctorCmd.text.includes('自检')) fail('命令 doctor 输出异常')
  ok('/hongyi doctor 返回自检明细')

  // ---- disposal -----------------------------------------------------------
  dispose()
  if (routes.length !== 0) fail('清理后路由仍在')
  if (commands.length !== 0) fail('清理后命令仍在')
  ok('清理函数释放了路由与命令')

  log('')
  log('═══ 结果：Host 半边全部断言通过 ═══')
  log('积分消耗：0 次模型调用（纯本机 HTTP + 文件读写）。')
} catch (error) {
  process.exitCode = 1
  log(`\n═══ 失败：${error?.message ?? error} ═══`)
} finally {
  clearTimeout(watchdog)
  // Release the listening socket first: an open handle keeps the process alive
  // even after every assertion has settled.
  if (routeServer !== null) {
    await new Promise((resolve) => routeServer.close(() => resolve()))
    routeServer.closeAllConnections?.()
  }
  mock.kill()
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {})
}
