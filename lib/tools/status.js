/**
 * 诊断类工具：桥是否活着、许可怎么样、GP 环境变量。
 *
 * 这三个是模型"动手前先探路"的入口，所以返回要能自解释：不要只给 true/false，
 * 要给出它为什么是这样。
 */

import { defineTool, safe } from '../tool-kit.js'
import { probeInstallation } from '../paths.js'

export function statusTools(bridge) {
  return [
    defineTool({
      name: 'arcgis_status',
      description:
        '检查 ArcGIS Pro 的 arcpy 桥状态：Python 版本、arcpy 版本、许可级别、已注册操作数。' +
        '第一次调用会等 15-20 秒（import arcpy 的真实成本），之后毫秒级。',
      parameters: {
        type: 'object',
        properties: {
          restart: {
            type: 'boolean',
            description: '先关掉现有桥再重新拉起。桥卡死或环境变量改过之后用。',
          },
        },
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        if (args.restart === true) await bridge.stop()
        const installation = await probeInstallation()
        let boot = null
        let license = null
        let error = null
        try {
          boot = await bridge.start()
          license = await bridge.call('license.info', {})
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause)
        }
        return {
          ok: error === null,
          installation,
          bridge: bridge.snapshot(),
          boot,
          product: license?.product ?? null,
          products: license?.products ?? null,
          extensions: license?.available ?? null,
          error,
        }
      }),
    }),

    defineTool({
      name: 'arcgis_license',
      description:
        '查看或变更许可：查看 ArcGIS Pro 的产品级别与各扩展模块可用性，' +
        '检出/归还扩展，或切换产品级别。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['info', 'checkout', 'checkin', 'setProduct'],
            description: 'info 只读；其余三项改当前进程的许可状态。',
          },
          extension: {
            type: 'string',
            description: '扩展模块名，如 Spatial、3D、ImageAnalyst、Network、GeoStats。',
          },
          product: {
            type: 'string',
            description: 'setProduct 用：ArcInfo / ArcEditor / ArcView。',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        const action = String(args.action || 'info')
        if (action === 'info') return bridge.call('license.info', {})
        if (action === 'checkout') {
          return bridge.call('license.checkout', { extension: args.extension })
        }
        if (action === 'checkin') {
          return bridge.call('license.checkin', { extension: args.extension })
        }
        if (action === 'setProduct') {
          return bridge.call('product.set', { product: args.product })
        }
        throw new Error(`未知 action：${action}。可用 info / checkout / checkin / setProduct。`)
      }),
    }),

    defineTool({
      name: 'arcgis_environment',
      description:
        '读写 GP 环境变量（arcpy.env）：workspace、overwriteOutput、outputCoordinateSystem、' +
        'extent、cellSize、parallelProcessingFactor 等 74 项。不传 name 就列出全部当前值。',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '环境变量名（如 overwriteOutput）。留空则读取全部。',
          },
          value: {
            description:
              '要设置的值。数字/布尔/字符串/路径都可以；传 null 表示清空。' +
              '给了 value 才会写，只给 name 是读。',
          },
        },
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        const name = args.name === undefined ? '' : String(args.name).trim()
        if ('value' in args) {
          // 桥那边的 op 叫 env.set，收的是 settings 对象（一次能写多个），
          // 这里只有一个 name/value，包一层再发。
          if (name === '') throw new Error('设置环境变量需要 name（要改哪一项）。')
          return bridge.call('env.set', { settings: { [name]: args.value } })
        }
        if (name === '') return bridge.call('env.get', {})
        return bridge.call('env.get', { name })
      }),
    }),
  ]
}
