/**
 * dsh-arcgispro — 用 arcpy 直接控制 ArcGIS Pro。
 *
 * ## 为什么是一条常驻桥
 *
 * 实测本机 Pro 3.6：`import arcpy` 一次 15–21 秒，之后每次 GP 调用 5–40 毫秒。
 * 每次工具调用起一个新解释器，"读一个字段"就要半分钟，不可用。所以 Node 侧
 * 常驻一个 Python 子进程，用行分隔 JSON 对话；解释器只在第一次真正需要时拉起。
 *
 * ## 为什么不用 MCP
 *
 * DSH 本身就是 Cordis 宿主，工具直接 `ctx.tools.register` 即可。绕一层
 * JSON-RPC 只会多一个进程和一层错误翻译。
 *
 * ## 贡献
 *
 * - 36 个 `arcgis_*` 工具（状态 / GP / 工程 / 数据四组）
 * - `arcgispro` skill：写给模型的用法说明，含真实的踩坑记录
 * - `/arcgis-check` 命令：一条命令自检安装、许可、桥、当前工程
 */

import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

import { ArcPyBridge } from './bridge.js'
import { locatePython } from './paths.js'
import { allTools } from './tools/index.js'

export const name = 'dsh-arcgispro'

/**
 * `tools` 是硬需求。`skills` 刻意不写进 inject —— 技能注册表是可选设施，
 * 没有它的宿主也必须能激活这套工具。
 */
export const inject = ['tools']

const DEFAULTS = {
  /** 显式指定 python.exe；留空则走环境变量 → 注册表 → 常见路径。 */
  python: '',
  /** 桥进程的工作目录；留空继承宿主。 */
  cwd: '',
  /** 也把 `/arcgis-check` 暴露给模型（默认只给人用）。 */
  modelInvocableCommand: false,
  /** 让 skills/**、commands/*.md 保持磁盘可发现。 */
  filesystemFallback: true,
}

/** 读包内资源。 */
function asset(relative) {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

/** 拆 YAML frontmatter，返回 `{ data, body }`。只支持 `key: value` 这种平铺写法。 */
function splitFrontmatter(text) {
  const normalized = text.replace(/^\uFEFF/, '')
  if (!normalized.startsWith('---')) return { data: {}, body: normalized }
  const end = normalized.indexOf('\n---', 3)
  if (end === -1) return { data: {}, body: normalized }
  const head = normalized.slice(3, end)
  const body = normalized.slice(end + 4).replace(/^\r?\n/, '')
  const data = {}
  for (const line of head.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (match === null) continue
    let value = match[2].trim()
    if (
      value.length > 1 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    data[match[1]] = value
  }
  return { data, body }
}

/**
 * 桥的门面：把"定位 python → 起进程 → 握手"推迟到第一次真正调用。
 *
 * 这样 `apply` 是纯同步的（宿主喜欢这样），插件加载不会因为 arcpy 慢启动
 * 而卡住整个会话；同时四个工具组的代码可以照常认为 bridge 有 `call`。
 */
function lazyBridge(config) {
  let inner = null
  let starting = null
  let located = null

  const ensure = async () => {
    if (inner !== null && inner.running) return inner
    if (starting !== null) return starting
    starting = (async () => {
      const found = located ?? (await locatePython({ python: config.python }))
      located = found
      const bridge = new ArcPyBridge({
        python: found.python,
        script: fileURLToPath(new URL('../py/bridge.py', import.meta.url)),
        cwd: config.cwd || undefined,
      })
      await bridge.start()
      inner = bridge
      return bridge
    })()
    try {
      return await starting
    } finally {
      starting = null
    }
  }

  return {
    get running() {
      return inner !== null && inner.running
    },
    get bootInfo() {
      return inner?.bootInfo ?? null
    },
    get stderrTail() {
      return inner?.stderrTail ?? ''
    },
    get python() {
      return located?.python ?? (config.python || null)
    },
    get located() {
      return located
    },
    async start() {
      const bridge = await ensure()
      return bridge.bootInfo
    },
    async stop() {
      if (inner === null) return
      await inner.stop()
      inner = null
    },
    async call(op, params, opts) {
      const bridge = await ensure()
      return bridge.call(op, params, opts)
    },
    snapshot() {
      const base = inner?.snapshot() ?? {
        running: false,
        pending: 0,
        queueDepth: 0,
        python: null,
        script: null,
        boot: null,
        stderrTail: '',
      }
      return {
        ...base,
        python: this.python,
        resolvedFrom: located?.source ?? null,
        installDir: located?.installDir ?? null,
        proVersion: located?.version ?? null,
      }
    },
  }
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) }
  const bridge = lazyBridge(config)

  // 1) 工具 ------------------------------------------------------------------
  for (const tool of allTools(bridge)) {
    const dispose = ctx.tools.register(tool)
    if (typeof dispose === 'function') {
      ctx.effect(() => dispose, `arcgispro: dispose ${tool.name}`)
    }
  }

  // 桥活到宿主关闭为止。这里只登记清理，不主动预热——
  // 没碰过 ArcGIS 的会话不该付出那 20 秒。
  ctx.effect(
    () => () => {
      void bridge.stop()
    },
    'arcgispro: stop arcpy bridge',
  )

  // 2) 技能：arcgispro -------------------------------------------------------
  const { data: skillMeta, body: skillBody } = splitFrontmatter(asset('../skills/arcgispro/SKILL.md'))
  registerSkill(ctx, {
    name: skillMeta.name ?? 'arcgispro',
    description: skillMeta.description ?? '用 arcpy 控制 ArcGIS Pro：跑 GP 工具、改工程与图层、查改数据。',
    ...(skillMeta.whenToUse === undefined ? {} : { whenToUse: skillMeta.whenToUse }),
    source: 'bundle:dsh-arcgispro/skills/arcgispro',
    content: skillBody,
    path: 'skills/arcgispro/SKILL.md',
    invocation: { modelInvocable: true, userInvocable: true },
  })

  // 3) 命令：/arcgis-check ---------------------------------------------------
  const { data: cmdMeta, body: cmdBody } = splitFrontmatter(asset('../commands/arcgis-check.md'))
  registerSkill(ctx, {
    name: 'arcgis-check',
    description: cmdMeta.description ?? '自检 ArcGIS Pro 环境并报告当前工程状态',
    source: 'bundle:dsh-arcgispro/commands/arcgis-check',
    content: cmdBody.replace(/\$ARGUMENTS/g, '').trimEnd(),
    path: 'commands/arcgis-check.md',
    invocation: { modelInvocable: config.modelInvocableCommand, userInvocable: true },
  })

  // 4) 磁盘兜底 --------------------------------------------------------------
  // Markdown 留在磁盘上可改；同名时运行时注册优先，所以磁盘那套只是备份。
  if (config.filesystemFallback) {
    const provider = ctx.get('skillFilesystem')
    if (provider !== undefined && typeof provider.addRoot === 'function') {
      ctx.effect(
        () => provider.addRoot(new URL('../skills', import.meta.url).href, { name: 'dsh-arcgispro', rank: 350 }),
        'arcgispro: skill root',
      )
      ctx.effect(
        () =>
          provider.addRoot(new URL('../commands', import.meta.url).href, {
            name: 'dsh-arcgispro-commands',
            rank: 340,
            pattern: '*.md',
          }),
        'arcgispro: command root',
      )
    }
  }
}

/** 注册一个内存技能；没有挂载注册表时安静降级。 */
function registerSkill(ctx, skill) {
  const skills = ctx.get('skills')
  if (skills === undefined || typeof skills.register !== 'function') {
    ctx.logger?.warn?.(`dsh-arcgispro: 没有技能注册表，"${skill.name}" 未贡献`)
    return
  }
  ctx.effect(() => skills.register(skill), `arcgispro: skill ${skill.name}`)
}
