/**
 * Self-check ("doctor") for 鸿驿.
 *
 * Every check answers one question and carries its own fix hint, so a red row
 * in the settings card is actionable instead of decorative. The checks never
 * call a model and never reach past the configured mailbox — the whole point of
 * the design is that the data plane is plain HTTP against facilities the user
 * already owns.
 */
import fs from 'node:fs/promises'
import { PROTOCOL_VERSION } from './envelope.js'

function check(id, label, ok, detail, hint = '') {
  return { id, label, ok, detail, hint }
}

async function writable(dir, probeFile) {
  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(probeFile, 'ok', 'utf8')
    await fs.rm(probeFile, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * @param {object} input
 * @param {object} input.config      resolved config
 * @param {object} input.credentials { token, deviceSecret }
 * @param {import('./mailbox/client.js').MailboxClient} input.client
 * @param {object} input.paths       paths helper from lib/paths.js
 * @param {() => string} input.hongyiHome
 */
export async function runDoctor({ config, credentials, client, paths, hongyiHome }) {
  const checks = []
  const home = hongyiHome()

  // 1. Node runtime
  const nodeMajor = Number(process.versions.node.split('.')[0])
  checks.push(
    check(
      'node',
      'Node 运行时',
      nodeMajor >= 20,
      `Node ${process.versions.node}`,
      nodeMajor >= 20 ? '' : '鸿驿要求 Node ≥ 20',
    ),
  )

  // 2. Plugin home is writable
  const homeWritable = await writable(home, `${home}/.write-probe`)
  checks.push(
    check('home', '工作目录可写', homeWritable, home, homeWritable ? '' : '检查 ~/.dsh/hongyi 的权限'),
  )

  // 3. Queue directory exists (Phase 2 writes here; the check proves the layout)
  const queueWritable = await writable(paths.queueDir(), `${paths.queueDir()}/.write-probe`)
  checks.push(
    check('queue', '离线队列目录', queueWritable, paths.queueDir(), queueWritable ? '' : '无法创建 queue/ 子目录'),
  )

  // 4. Mailbox driver is one this build can actually drive
  const folderMode = config.driver === 'folder' || config.driver === 'tdrive'
  const target = folderMode ? `${config.folderRoot || '（未填）'}/${config.box}` : `${config.baseUrl}/${config.box}`
  checks.push(
    check(
      'driver',
      '信箱驱动',
      client.configured,
      client.unsupported() || `${config.driver}（${target}）`,
      client.configured ? '' : '切到「本地模拟信箱」，或填一个正在同步的云文件夹路径',
    ),
  )

  // 5. Device secret (envelope HMAC)
  checks.push(
    check(
      'secret',
      '设备密钥（信封签名）',
      credentials.deviceSecret.length > 0,
      credentials.deviceSecret.length > 0 ? '已设置' : '未设置：信封不带签名，仅建议在本地 mock 阶段接受',
      credentials.deviceSecret.length > 0 ? '' : '在设置卡片点「生成设备密钥」',
    ),
  )

  // 6. Mailbox reachability + auth
  if (client.configured) {
    try {
      const health = await client.health()
      checks.push(
        check(
          'reachable',
          '信箱可达',
          true,
          folderMode
            ? `文件夹可读写 · ${health?.name ?? 'folder-mailbox'} · 协议 v${health?.protocol ?? '?'}`
            : `HTTP 200 · ${health?.name ?? health?.service ?? 'mailbox'} · 协议 v${health?.protocol ?? '?'}`,
        ),
      )
      checks.push(
        check(
          'protocol',
          '信箱协议版本',
          Number(health?.protocol ?? 0) === PROTOCOL_VERSION,
          `信箱 v${health?.protocol ?? '?'} / 插件 v${PROTOCOL_VERSION}`,
          Number(health?.protocol ?? 0) === PROTOCOL_VERSION ? '' : '两端协议不一致，升级较旧的一侧',
        ),
      )
    } catch (error) {
      checks.push(
        check(
          'reachable',
          '信箱可达',
          false,
          error?.message ?? String(error),
          folderMode ? '确认该目录存在、已登录云盘客户端、且当前用户可写' : '确认 mock 服务已启动：node mock/server.mjs',
        ),
      )
    }
  } else {
    checks.push(check('reachable', '信箱可达', false, '跳过（驱动未就绪）', '先修复「信箱驱动」一项'))
  }

  // 7. Optional push channel — declared, not required.
  checks.push(
    check(
      'wecom',
      '企业微信推送（可选）',
      true,
      config.wecomWebhook.trim().length > 0 ? '已填写 webhook' : '未配置：仅影响实时提醒，不影响收发',
      '',
    ),
  )

  // 8. WorkBuddy local link — placeholder this phase, so it must not be reported red.
  checks.push(
    check(
      'link',
      'WorkBuddy 本地联动（占位）',
      true,
      config.link.enabled ? `已启用 · CLI=${config.link.cliPath || '未填'}` : '本期未启用',
      '',
    ),
  )

  const ok = checks.every((c) => c.ok)
  return {
    ok,
    at: new Date().toISOString(),
    protocol: PROTOCOL_VERSION,
    home,
    checks,
    summary: `${checks.filter((c) => c.ok).length}/${checks.length} 通过`,
  }
}
