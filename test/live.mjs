/**
 * 真机联调：真的起 Python 桥，真的跑 arcpy。
 *
 * 这是唯一能证明"工具定义 → 桥 → arcpy → 结果"整条链没断的测试。
 * 需要本机装了 ArcGIS Pro；没有 Pro 的机器上它会自己跳过。
 *
 *   node test/live.mjs
 *   node test/live.mjs --project "C:/path/to/x.aprx"   # 额外验一个真实工程
 */

import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

import { ArcPyBridge } from '../lib/bridge.js'
import { locatePython } from '../lib/paths.js'
import { allTools } from '../lib/tools/index.js'

const GDB = 'F:/workspace/_aprprobe.gdb'
const CN_GDB = 'F:/workspace/_apr中文测试/测试.gdb'

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? null : process.argv[index + 1]
}

const started = Date.now()

let located
try {
  located = await locatePython({ python: '' })
} catch (error) {
  console.log(`跳过实机测试：${error.message.split('\n')[0]}`)
  process.exit(0)
}

const bridge = new ArcPyBridge({
  python: located.python,
  script: fileURLToPath(new URL('../py/bridge.py', import.meta.url)),
})

const tools = new Map(allTools(bridge).map((tool) => [tool.name, tool]))
const call = (name, args) => {
  const tool = tools.get(name)
  assert.ok(tool !== undefined, `没有这个工具：${name}`)
  return tool.execute(args)
}

/** 断言结果没带 ok:false。工具层把异常包成了返回值，不是抛出。 */
function ok(label, result) {
  assert.notEqual(result?.ok, false, `${label} 失败：${result?.error ?? JSON.stringify(result)}`)
  return result
}

let failures = 0
async function step(label, fn) {
  const at = Date.now()
  try {
    const value = await fn()
    console.log(`  ✓ ${label} (${Date.now() - at}ms)`)
    return value
  } catch (error) {
    failures += 1
    console.log(`  ✗ ${label} (${Date.now() - at}ms)\n    ${error.message}`)
    return null
  }
}

console.log(`python: ${located.python}  [${located.source}]`)

try {
  console.log('\n== 状态 ==')
  const status = await step('arcgis_status', () => call('arcgis_status', {}))
  if (status) {
    ok('arcgis_status', status)
    assert.equal(status.ok, true, `桥起不来：${status.error}`)
    assert.ok(status.boot.python.startsWith('3.'), `Python 版本异常：${status.boot.python}`)
    assert.ok(status.product, '拿不到产品许可级别')
    console.log(`    python ${status.boot.python.split(' ')[0]} / arcpy ${status.boot.arcpyVersion} / ${status.product} / ${status.boot.operations} ops`)
    console.log(`    启动耗时 ${status.boot.bootSeconds}s`)
  }

  console.log('\n== GP 目录 ==')
  const list = await step('arcgis_tool_list buffer', () => call('arcgis_tool_list', { search: 'buffer', limit: 8 }))
  if (list) {
    ok('arcgis_tool_list', list)
    assert.ok(list.total > 0, '搜 buffer 应该有结果')
    console.log(`    命中 ${list.total} 个，示例：${list.tools.slice(0, 3).join(', ')}`)
  }

  const info = await step('arcgis_tool_info analysis.Buffer', () => call('arcgis_tool_info', { tool: 'analysis.Buffer' }))
  if (info) {
    ok('arcgis_tool_info', info)
    assert.equal(info.parameterCount, 8, `Buffer 应有 8 个参数，实际 ${info.parameterCount}`)
    const required = info.requiredInputs
    assert.ok(required.includes('in_features'), `必填参数里没有 in_features：${required.join(',')}`)
    console.log(`    必填：${required.join(', ')}`)
  }

  console.log('\n== 数据 ==')
  const described = await step('arcgis_data_describe', () => call('arcgis_data_describe', { dataset: `${GDB}/pts` }))
  if (described) {
    ok('arcgis_data_describe', described)
    assert.ok(described.fields.length >= 2, '要素类应至少有 OBJECTID 和 Shape')
    console.log(`    ${described.shapeType} / ${described.count} 行 / ${described.spatialReference?.name ?? '无坐标系'}`)
  }

  const queried = await step('arcgis_data_query', () =>
    call('arcgis_data_query', { dataset: `${GDB}/pts`, limit: 3 }),
  )
  if (queried) {
    ok('arcgis_data_query', queried)
    assert.ok(Array.isArray(queried.rows), 'query 应返回 rows 数组')
    console.log(`    取到 ${queried.rows.length} 行，truncated=${queried.truncated}`)
    if (queried.rows.length > 0) {
      const geometryAt = queried.fields.findIndex((one) => /^(shape|geom)$/i.test(one))
      const geometry = geometryAt === -1 ? null : queried.rows[0][geometryAt]
      console.log(`    字段：${queried.fields.join(', ')}`)
      console.log(`    首行几何：${JSON.stringify(geometry).slice(0, 140)}`)
    }
  }

  const cn = await step('中文路径往返', async () => {
    const found = ok('data.fields', await call('arcgis_data_fields', { dataset: `${CN_GDB}/点要素` }))
    assert.ok(found.ok !== false, `中文 gdb 打不开：${found.error}`)
    return found
  })
  if (cn) {
    console.log(`    字段：${cn.fields.map((one) => one.name).join(', ')}`)
  }

  console.log('\n== 工程 ==')
  const projectPath = argValue('--project')
  if (projectPath) {
    const opened = await step('arcgis_project_open', () => call('arcgis_project_open', { project: projectPath }))
    if (opened) {
      ok('arcgis_project_open', opened)
      assert.ok(opened.maps.length >= 1, '工程里没有地图')
      console.log(`    ${opened.maps.length} 个地图 / ${opened.layouts.length} 个布局`)
      const mapInfo = await step('arcgis_map_info', () => call('arcgis_map_info', { map: opened.maps[0].name }))
      if (mapInfo) {
        ok('arcgis_map_info', mapInfo)
        const missing = mapInfo.layers.filter((one) => one.dataSourceMissing).length
        console.log(`    ${mapInfo.layers.length} 个图层，${missing} 个数据源缺失`)
      }
      if (opened.layouts.length > 0) {
        const target = process.env.DSH_TEST_EXPORT || 'F:/workspace/_dgtest/layout-live.pdf'
        const exported = await step('arcgis_layout_export', () =>
          call('arcgis_layout_export', {
            layout: opened.layouts[0].name,
            output: target,
            resolution: 120,
            writeAllowed: true,
          }),
        )
        if (exported) {
          ok('arcgis_layout_export', exported)
          assert.ok(exported.bytes > 10000, `导出的 PDF 太小：${exported.bytes} 字节`)
          console.log(`    ${exported.bytes} 字节 → ${exported.output}`)
        }
      }
      await step('arcgis_project_close', () => call('arcgis_project_close', {}))
    }
  } else {
    console.log('  - 跳过（传 --project <aprx> 可验真实工程）')
  }

  console.log('\n== 建库 / 写数据 / 跑 GP ==')
  const workDir = 'F:/workspace/_dgtest'
  // 每次跑用独立名字：CreateFileGDB 对已存在的输出会报 ERROR 000258，
  // 用固定名字会让第二次运行假失败。
  const stamp = `live_${Date.now().toString(36)}`
  const gdb = `${workDir}/${stamp}.gdb`
  const created = await step('arcgis_data_create_gdb', () =>
    call('arcgis_data_create_gdb', { outFolder: workDir, name: `${stamp}.gdb`, writeAllowed: true }),
  )
  if (created) ok('arcgis_data_create_gdb', created)

  const fc = `${gdb}/cities`
  const fcMade = await step('arcgis_data_create_featureclass', () =>
    call('arcgis_data_create_featureclass', {
      outPath: gdb,
      name: 'cities',
      geometryType: 'point',
      spatialReference: 'EPSG:4326',
      fields: [
        { name: 'name', type: 'text', length: 64 },
        { name: 'pop', type: 'long' },
      ],
      writeAllowed: true,
    }),
  )
  if (fcMade) ok('arcgis_data_create_featureclass', fcMade)

  const inserted = await step('arcgis_data_insert', () =>
    call('arcgis_data_insert', {
      dataset: fc,
      rows: [
        { Shape: 'POINT (121.4737 31.2304)', name: '上海', pop: 24870000 },
        { Shape: 'POINT (116.4074 39.9042)', name: '北京', pop: 21540000 },
      ],
      writeAllowed: true,
    }),
  )
  if (inserted) {
    ok('arcgis_data_insert', inserted)
    assert.equal(inserted.inserted, 2, `应插入 2 行，实际 ${inserted.inserted}`)
  }

  const readBack = await step('回读中文属性 + 几何', () =>
    call('arcgis_data_query', { dataset: fc, fields: ['name', 'pop', 'Shape'], limit: 10 }),
  )
  if (readBack) {
    ok('arcgis_data_query 回读', readBack)
    assert.equal(readBack.rows.length, 2, `回读应有 2 行，实际 ${readBack.rows.length}`)
    const names = readBack.rows.map((row) => row[0]).sort()
    assert.deepEqual(names, ['上海', '北京'], `中文属性往返失败：${names.join(',')}`)
    const geometry = readBack.rows[0][2]
    assert.ok(geometry?.wkt?.startsWith('POINT'), `几何应带 WKT：${JSON.stringify(geometry)}`)
    console.log(`    ${readBack.rows.map((row) => row[0]).join(' / ')}，首行 ${geometry.wkt}`)
  }

  const buffered = await step('arcgis_tool_run analysis.Buffer', () =>
    call('arcgis_tool_run', {
      tool: 'analysis.Buffer',
      params: {
        in_features: fc,
        out_feature_class: `${gdb}/cities_buf`,
        buffer_distance_or_field: '10 Kilometers',
      },
    }),
  )
  if (buffered) {
    ok('arcgis_tool_run', buffered)
    assert.equal(buffered.outputs.length, 1, 'Buffer 应有一个输出')
    console.log(`    输出 ${buffered.outputs[0]}，status=${buffered.status}`)
  }

  console.log('\n== 写盘闸门 ==')
  const refused = await call('arcgis_data_insert', { dataset: `${GDB}/pts`, rows: [{ OBJECTID: 999999 }] })
  assert.equal(refused.ok, false, '没有 writeAllowed 的写入必须被拒')
  assert.equal(refused.code, 'WRITE_NOT_ALLOWED')
  console.log('  ✓ 未授权写入被拒（WRITE_NOT_ALLOWED）')

  const refusedAll = await call('arcgis_data_delete', { dataset: `${GDB}/pts`, where: '', writeAllowed: true })
  assert.equal(refusedAll.ok, false, '空 where 的清表必须被拒')
  console.log('  ✓ 空 where 清表被拒')
} finally {
  await bridge.stop()
}

const total = ((Date.now() - started) / 1000).toFixed(1)
if (failures > 0) {
  console.log(`\n${failures} 项失败，用时 ${total}s`)
  process.exit(1)
}
console.log(`\n实机测试通过，用时 ${total}s`)
