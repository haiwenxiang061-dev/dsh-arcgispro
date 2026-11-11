/**
 * 通用 GP 工具通道：1977 个工具全从这里进。
 *
 * 不逐个封装（那会变成 1977 个定义），而是：先 list 找名字，再 info 看参数，
 * 最后 run。三步都能给出可直接照抄的参数结构，模型不需要记 arcpy 的别名规则。
 */

import { defineTool, safe } from '../tool-kit.js'

export function gpTools(bridge) {
  return [
    defineTool({
      name: 'arcgis_tool_list',
      description:
        '搜索 GP 工具目录（共 1977 个）。tools 是 `Tool_alias` 形式的字符串数组（如 Buffer_analysis），' +
        'toolboxes 是 别名 → 工具箱显示名 的映射。搜索命中数超过 limit 时 truncated 为 true。',
      parameters: {
        type: 'object',
        properties: {
          search: {
            type: 'string',
            description: '名称片段，如 buffer / clip / 投影 / 栅格。留空返回前若干个。',
          },
          toolbox: {
            type: 'string',
            description: '只列某个工具箱，如 analysis、management、conversion、sa。',
          },
          pattern: {
            type: 'string',
            description: 'arcpy 通配符（默认 *）。一般用 search 就够，需要时再上通配。',
          },
          limit: { type: 'number', description: '最多返回多少个，默认 60，上限 2000。' },
        },
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        return bridge.call('gp.list', {
          search: args.search ?? '',
          toolbox: args.toolbox ?? '',
          pattern: args.pattern ?? '*',
          limit: args.limit ?? 60,
        })
      }),
    }),

    defineTool({
      name: 'arcgis_tool_info',
      description:
        '查一个 GP 工具的参数契约。返回 inputs / outputs 两组，每项含 name、datatype、' +
        'parameterType（Required 或 Optional）、enabled（当前条件下是否生效）、filter.list（可选值）。' +
        'arcgis_tool_run 的 params 就用这里的 name 作键；requiredInputs 是必填清单。',
      parameters: {
        type: 'object',
        properties: {
          tool: {
            type: 'string',
            description: '工具名。analysis.Buffer / Buffer_analysis / Buffer 三种写法都接受。',
          },
        },
        required: ['tool'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        if (!args.tool) throw new Error('需要 tool。')
        return bridge.call('gp.info', { tool: args.tool })
      }),
    }),

    defineTool({
      name: 'arcgis_tool_run',
      description:
        '执行任意 GP 工具。params 用 arcgis_tool_info 里的参数名作键；' +
        'SpatialReference 可写 "EPSG:4326" 或 {"__arcpy__":"SpatialReference","wkid":4326}。' +
        '返回执行状态、输出路径、GP 消息。',
      parameters: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: '工具名，如 analysis.Buffer。' },
          params: {
            type: 'object',
            description: '参数对象，键为参数名（in_features、out_feature_class……）。',
            additionalProperties: true,
          },
          args: {
            type: 'array',
            description:
              '按位置传参（可选），给了它就忽略 params。顺序与 arcgis_tool_info 里 inputs 的 index 一致，' +
              '例如 CopyFeatures 是 [in_features, out_feature_class]。',
            items: {},
          },
        },
        required: ['tool'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        if (!args.tool) throw new Error('需要 tool。')
        const positional = Array.isArray(args.args)
        if (positional && args.params && Object.keys(args.params).length > 0) {
          throw new Error('args（按位置）和 params（按名字）只能给一个。')
        }
        return bridge.call(
          'gp.execute',
          positional
            ? { tool: args.tool, args: args.args }
            : { tool: args.tool, params: args.params ?? {} },
          { timeoutMs: 15 * 60 * 1000 },
        )
      }),
    }),

    defineTool({
      name: 'arcgis_python',
      description:
        '在桥进程里直接执行 arcpy 代码，兜住所有没被包成工具的能力（arcpy.da 游标、' +
        'arcpy.metadata、CIM 深度定制、第三方扩展……）。命名空间里已备好 arcpy、arcutil 和' +
        '当前工程对象 aprx（跟后续工具是同一个实例，改了不用重新 open）；要返回数据就把值赋给 ' +
        'result 变量，脚本的 stdout/stderr 会一并带回。' +
        '注意：这是任意代码执行，没有参数校验也没有回滚，必须显式写 writeAllowed: true。' +
        '能用一个专用工具解决的就别用这个——专用工具有校验、返回结构稳定。',
      parameters: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description:
              'Python 源码。例：`result = [m.name for m in aprx.listMaps()]`。' +
              '要落盘的内容自己调 arcpy；改动 aprx 后仍需 arcgis_project_save 才写回 .aprx。',
          },
          globals: {
            type: 'object',
            description: '可选：注入到脚本命名空间的变量（键 → 值）。',
            additionalProperties: true,
          },
          writeAllowed: {
            type: 'boolean',
            description: '必须为 true。代码可能改动任意数据。',
          },
        },
        required: ['code'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        if (!args.code || String(args.code).trim() === '') throw new Error('需要 code。')
        if (args.writeAllowed !== true) {
          const error = new Error(
            'arcgis_python 执行的是任意代码，可能改动工程、数据或文件，需要 writeAllowed: true。' +
              '确认代码内容后重试。',
          )
          error.name = 'WriteNotAllowed'
          error.code = 'WRITE_NOT_ALLOWED'
          throw error
        }
        return bridge.call(
          'python.run',
          { code: args.code, globals: args.globals ?? {} },
          { timeoutMs: 15 * 60 * 1000 },
        )
      }),
    }),
  ]
}
