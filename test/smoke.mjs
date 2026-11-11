/**
 * 冒烟测试：不需要 ArcGIS Pro，也不需要真 ctx。
 *
 * 验证的是"注册契约"——工具长得对不对、名字有没有撞、技能有没有被贡献。
 * 真正的 arcpy 行为由 `test/live.mjs` 负责。
 */

import assert from 'node:assert/strict'
import { apply, name, inject } from '../lib/index.js'

/** 假 ctx：只实现 apply 会碰到的东西，多余的一概不给。 */
function makeContext() {
  const tools = new Map()
  const skills = []
  const roots = []
  const effects = []
  const services = {
    tools: {
      register(tool) {
        assert.equal(tools.has(tool.name), false, `工具重名：${tool.name}`)
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
    skills: {
      register(skill) {
        skills.push(skill)
        return () => {}
      },
    },
    skillFilesystem: {
      addRoot(url, options) {
        roots.push({ url, options })
        return () => {}
      },
    },
  }
  return {
    // 宿主看到的 tools 是注册表；测试自己拿 Map 做断言。
    tools: services.tools,
    registered: tools,
    skills,
    roots,
    effects,
    get(key) {
      return services[key]
    },
    logger: { warn() {}, info() {}, debug() {} },
    // Cordis 的 effect 会立刻执行回调，并把返回值当析构函数。假 ctx 必须照做，
    // 否则技能看起来"没注册"。
    effect(fn, label) {
      const disposer = fn()
      effects.push({ disposer, label })
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    on() {
      return () => {}
    },
  }
}

const ctx = makeContext()
const dispose = apply(ctx, {})

// --- 模块形状 ---------------------------------------------------------------
assert.equal(name, 'dsh-arcgispro')
assert.deepEqual(inject, ['tools'], 'inject 必须只含 tools')

// --- 工具 -------------------------------------------------------------------
const toolNames = [...ctx.registered.keys()]
assert.ok(toolNames.length >= 30, `工具太少：${toolNames.length}`)

for (const [toolName, tool] of ctx.registered) {
  assert.equal(typeof tool.description, 'string', `${toolName} 缺 description`)
  assert.ok(tool.description.length > 10, `${toolName} 的 description 太短`)
  assert.equal(typeof tool.parameters, 'object', `${toolName} 缺 parameters`)
  assert.equal(tool.parameters.type, 'object', `${toolName} 的 parameters.type 应为 object`)
  assert.equal(typeof tool.execute, 'function', `${toolName} 缺 execute`)
  assert.equal(typeof tool.isConcurrencySafe, 'function', `${toolName} 缺 isConcurrencySafe`)
  // 宿主在注册时校验这个，缺了直接拒。
  assert.equal(typeof tool.output, 'object', `${toolName} 缺 output`)
  assert.equal(typeof tool.output.render, 'function', `${toolName} 的 output 缺 render`)
  const rendered = tool.output.render({}, { ok: true, value: 1 })
  assert.ok(Array.isArray(rendered) && rendered.length > 0, `${toolName} 的 render 没返回内容`)
  assert.equal(rendered[0].type, 'text', `${toolName} 的 render 首项应为 text`)
  // required 里的名字必须真的存在于 properties。
  const required = tool.parameters.required ?? []
  assert.ok(Array.isArray(required), `${toolName} 的 required 不是数组`)
  for (const key of required) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(tool.parameters.properties ?? {}, key),
      `${toolName} 的 required 引用了不存在的参数：${key}`,
    )
  }
  assert.equal(
    tool.parameters.additionalProperties,
    false,
    `${toolName} 应关闭 additionalProperties，参数面才可控`,
  )
}

// 前缀统一，方便模型按名字发现这一族。
for (const toolName of toolNames) {
  assert.ok(
    toolName === 'arcgis_status' || toolName.startsWith('arcgis_'),
    `工具名应以 arcgis_ 开头：${toolName}`,
  )
}

// --- 技能与命令 -------------------------------------------------------------
const skillNames = ctx.skills.map((one) => one.name)
assert.ok(skillNames.includes('arcgispro'), `缺 arcgispro 技能：${skillNames.join(',')}`)
assert.ok(skillNames.includes('arcgis-check'), `缺 arcgis-check 命令：${skillNames.join(',')}`)

const skill = ctx.skills.find((one) => one.name === 'arcgispro')
assert.ok(skill.content.length > 1000, '技能正文太短，应该是真内容')
assert.equal(skill.invocation.modelInvocable, true)
assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true })

const command = ctx.skills.find((one) => one.name === 'arcgis-check')
assert.equal(command.invocation.modelInvocable, false, '命令默认不该进模型目录')
assert.equal(command.invocation.userInvocable, true)
assert.ok(command.content.includes('arcgis_status'), '命令正文应指导模型调用工具')
assert.equal(command.content.includes('$ARGUMENTS'), false, '$ARGUMENTS 应被剥掉')

// --- 磁盘兜底 ---------------------------------------------------------------
assert.equal(ctx.roots.length, 2, `应注册 2 个磁盘根，实际 ${ctx.roots.length}`)
assert.ok(ctx.roots[0].url.includes('/skills'), '第一个根应是 skills')
assert.ok(ctx.roots[1].url.includes('/commands'), '第二个根应是 commands')

// --- 清理 -------------------------------------------------------------------
assert.equal(typeof dispose, 'undefined', 'apply 不该返回东西，清理走 ctx.effect')

console.log(`smoke ok — ${toolNames.length} 个工具，技能：${skillNames.join(', ')}`)
