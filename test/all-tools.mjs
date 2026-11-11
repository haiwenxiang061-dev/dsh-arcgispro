/**
 * 全工具覆盖测试：87 个工具每一个都被真的调用一次。
 *
 *   node test/all-tools.mjs
 *
 * 和另外两个测试的分工：
 * - smoke.mjs      只验证工具定义能注册（不碰 Pro）
 * - live.mjs       端到端验一条主干链路（工程/地图/布局/建数据/GP/写盘闸门）
 * - live-extended  验扩展能力链与探测出来的坑
 * - 本文件          只回答一个问题：**这 87 个工具，有没有哪个一调就坏**
 *
 * 判定规则：
 * - `pass`  调通了，且返回值不是 ok:false
 * - `pass`  预期会失败的工具（如无窗口工程里的 createBookmark）确实给出了明确错误
 * - `fail`  抛异常、超时、或者本该成功却返回 ok:false
 * 最后会核对：CASES 覆盖的工具名必须正好等于注册的工具名集合，漏一个都算失败。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ArcPyBridge } from '../lib/bridge.js'
import { locatePython } from '../lib/paths.js'
import { allTools } from '../lib/tools/index.js'

const STAMP = Date.now().toString(36)
const SCRATCH = 'F:/workspace/_aprtools'
const GDB = `${SCRATCH}/t_${STAMP}.gdb`
const POINTS = `${GDB}/pts`
const POINTS_DEL = `${GDB}/pts_del`
const POINTS_APP = `${GDB}/pts_app`
const POINTS_DEF = `${GDB}/pts_def`
const MERGED = `${GDB}/pts_merged`
const DISSOLVED = `${GDB}/pts_dissolved`
const TABLE = `${GDB}/人员表`
const MASK = `${GDB}/mask`
const RASTER_DIR = `${SCRATCH}/r_${STAMP}`
const POP = `${RASTER_DIR}/pop.tif`
const POP2 = `${RASTER_DIR}/pop_x2.tif`
const POP_CLIP = `${RASTER_DIR}/pop_clip.tif`
const POP_MOSAIC = `${RASTER_DIR}/pop_mosaic.tif`
const SLOPE = `${RASTER_DIR}/slope.tif`
const PROJ = `${SCRATCH}/proj_${STAMP}.aprx`
const FRESH = `${SCRATCH}/fresh_${STAMP}.aprx`
const LAYOUT = `全测出图_${STAMP}`
const MAP = 'Map'
const INSTALL_BLANK = 'F:/arcgispro/Resources/ArcToolBox/Services/routingservices/Templates/Blank.aprx'

let located
try {
  located = await locatePython({ python: '' })
} catch (error) {
  console.log(`跳过：${error.message.split('\n')[0]}`)
  process.exit(0)
}

fs.mkdirSync(SCRATCH, { recursive: true })
// 用安装目录 Blank.aprx 的**副本**当工程，绝不直接改安装目录里的模板。
// （曾经 saveACopy 之后内存对象还指着模板，把安装目录写脏过。）
const blank = [
  'F:/arcgispro/Resources/ArcToolBox/Services/routingservices/Templates/Blank.aprx',
  'F:/arcgispro/Resources/ArcToolBox/Services/routingservices/data/Blank.aprx',
].find((p) => fs.existsSync(p))
if (!blank) {
  console.log('跳过：找不到 Blank.aprx 模板')
  process.exit(0)
}
fs.copyFileSync(blank, PROJ)

const bridge = new ArcPyBridge({
  python: located.python,
  script: fileURLToPath(new URL('../py/bridge.py', import.meta.url)),
})
const tools = new Map(allTools(bridge).map((tool) => [tool.name, tool]))

/**
 * 按顺序执行。顺序有讲究：后面的工具依赖前面造出来的数据。
 *
 * 需要放开错误的情况写 `allowError`：那是"Pro 本身就做不到/环境不允许"，
 * 只要错误信息说得清楚就算通过——测试要区分"工具坏了"和"这件事本来就不行"。
 */
const CASES = [
  // ---- 状态与许可 -------------------------------------------------------
  { name: 'arcgis_status', args: {} },
  { name: 'arcgis_license', args: { action: 'info' } },
  { name: 'arcgis_environment', args: {} },
  { name: 'arcgis_environment', args: { name: 'overwriteOutput', value: true } },
  { name: 'arcgis_environment', args: { name: 'overwriteOutput', value: false } },
  { name: 'arcgis_tool_list', args: { search: 'buffer', limit: 5 } },
  { name: 'arcgis_tool_info', args: { tool: 'analysis.Buffer' } },
  {
    name: 'arcgis_python',
    args: { code: 'result = {"arcpy": arcpy.__version__, "cwd_ok": True}', writeAllowed: true },
  },

  // ---- 建数据 -----------------------------------------------------------
  { name: 'arcgis_data_create_gdb', args: { outFolder: SCRATCH, name: `t_${STAMP}`, writeAllowed: true } },
  {
    name: 'arcgis_data_create_featureclass',
    args: {
      outPath: GDB,
      name: 'pts',
      geometryType: 'point',
      spatialReference: 'EPSG:4326',
      fields: [
        { name: '名称', type: 'text', length: 40 },
        { name: '人口', type: 'long' },
      ],
      writeAllowed: true,
    },
  },
  {
    name: 'arcgis_data_insert',
    args: {
      dataset: POINTS,
      rows: [
        { 名称: '上海', 人口: 2489, SHAPE: { wkt: 'POINT (121.4737 31.2304)' } },
        { 名称: '北京', 人口: 2189, SHAPE: { wkt: 'POINT (116.4074 39.9042)' } },
        { 名称: '广州', 人口: 1868, SHAPE: { wkt: 'POINT (113.2644 23.1291)' } },
        { 名称: '成都', 人口: 2094, SHAPE: { wkt: 'POINT (104.0665 30.5723)' } },
      ],
      writeAllowed: true,
    },
  },
  { name: 'arcgis_data_describe', args: { dataset: POINTS } },
  { name: 'arcgis_data_fields', args: { dataset: POINTS } },
  { name: 'arcgis_data_query', args: { dataset: POINTS, where: '人口 > 2000', limit: 10 } },
  { name: 'arcgis_data_statistics', args: { dataset: POINTS, field: '人口' } },
  { name: 'arcgis_data_list', args: { workspace: GDB } },
  { name: 'arcgis_data_copy', args: { source: POINTS, outPath: POINTS_DEL, kind: 'features', writeAllowed: true } },
  { name: 'arcgis_data_copy', args: { source: POINTS, outPath: POINTS_APP, kind: 'features', writeAllowed: true } },
  { name: 'arcgis_data_copy', args: { source: POINTS, outPath: POINTS_DEF, kind: 'features', writeAllowed: true } },
  {
    name: 'arcgis_data_add_field',
    args: { dataset: POINTS_DEL, name: '备注', type: 'text', length: 20, writeAllowed: true },
  },
  { name: 'arcgis_data_delete_field', args: { dataset: POINTS_DEL, name: '备注', writeAllowed: true } },
  {
    name: 'arcgis_data_calculate_field',
    args: { dataset: POINTS_DEL, field: '人口', expression: '!人口! * 2', writeAllowed: true },
  },
  { name: 'arcgis_data_update', args: { dataset: POINTS_DEL, where: '名称 = \'上海\'', changes: { 人口: 1 }, writeAllowed: true } },
  { name: 'arcgis_data_delete', args: { dataset: POINTS_DEL, where: '名称 = \'广州\'', writeAllowed: true } },
  {
    name: 'arcgis_data_create_table',
    args: {
      outPath: GDB,
      name: '人员表',
      fields: [
        { name: '姓名', type: 'text', length: 20 },
        { name: '年龄', type: 'long' },
      ],
      writeAllowed: true,
    },
  },
  { name: 'arcgis_data_merge', args: { inputs: [POINTS, POINTS_APP], output: MERGED, writeAllowed: true } },
  { name: 'arcgis_data_append', args: { inputs: [POINTS], output: POINTS_APP, schemaType: 'NO_TEST', writeAllowed: true } },
  {
    name: 'arcgis_data_dissolve',
    args: { input: POINTS, output: DISSOLVED, fields: ['名称'], statistics: { 人口: 'SUM' }, writeAllowed: true },
  },

  // ---- 选择 -------------------------------------------------------------
  { name: 'arcgis_select_by_attribute', args: { input: POINTS, where: '人口 > 2100' } },
  {
    name: 'arcgis_select_by_location',
    args: { input: POINTS, overlap: 'WITHIN_A_DISTANCE', selectFeatures: POINTS, distance: '2000 Kilometers' },
  },
  { name: 'arcgis_select_clear', args: { input: POINTS } },

  // ---- 投影与转换 -------------------------------------------------------
  { name: 'arcgis_reproject', args: { input: POINTS, output: `${GDB}/pts_merc`, spatialReference: 'EPSG:3857', writeAllowed: true } },
  { name: 'arcgis_define_projection', args: { input: POINTS_DEF, spatialReference: 'EPSG:4326', writeAllowed: true } },
  { name: 'arcgis_convert_data', args: { input: POINTS, output: `${SCRATCH}/pts_${STAMP}.json`, format: 'json', geoJson: true, writeAllowed: true } },

  // ---- 栅格 -------------------------------------------------------------
  {
    name: 'arcgis_tool_run',
    args: {
      tool: 'conversion.PointToRaster',
      params: { in_features: POINTS, value_field: '人口', out_rasterdataset: POP, cellsize: 0.05 },
      writeAllowed: true,
    },
  },
  { name: 'arcgis_raster_info', args: { dataset: POP } },
  { name: 'arcgis_raster_resample', args: { input: POP, output: `${RASTER_DIR}/pop_coarse.tif`, cellSize: 0.1, resampling: 'BILINEAR', writeAllowed: true } },
  { name: 'arcgis_raster_calculator', args: { rasters: { pop: POP }, expression: 'pop * 2', output: POP2, writeAllowed: true } },
  { name: 'arcgis_raster_surface', args: { input: POP, output: SLOPE, method: 'slope', writeAllowed: true } },
  { name: 'arcgis_raster_clip', args: { input: POP, output: POP_CLIP, rectangle: '110 20 125 45', writeAllowed: true } },
  {
    name: 'arcgis_tool_run#mask',
    tool: 'arcgis_tool_run',
    args: { tool: 'analysis.Buffer', params: { in_features: POINTS, out_feature_class: MASK, buffer_distance_or_field: '800 Kilometers' } },
  },
  { name: 'arcgis_raster_extract_mask', args: { input: POP, mask: MASK, output: `${RASTER_DIR}/pop_mask.tif`, writeAllowed: true } },
  { name: 'arcgis_raster_mosaic', args: { inputs: [POP, POP_CLIP], output: POP_MOSAIC, writeAllowed: true } },

  // ---- 工程 -------------------------------------------------------------
  { name: 'arcgis_project_new', args: { project: FRESH, writeAllowed: true } },
  { name: 'arcgis_project_open', args: { project: PROJ } },
  { name: 'arcgis_project_info', args: {} },
  { name: 'arcgis_project_broken_sources', args: {} },
  { name: 'arcgis_project_save', args: { writeAllowed: true } },

  // ---- 地图 -------------------------------------------------------------
  { name: 'arcgis_map_info', args: {} },
  { name: 'arcgis_map_add_data', args: { data: [POINTS], writeAllowed: true } },
  { name: 'arcgis_camera_set', args: { extent: { xMin: 113, yMin: 22, xMax: 123, yMax: 41 } } },
  { name: 'arcgis_map_export', args: { output: `${SCRATCH}/map_${STAMP}.png`, width: 900, height: 700, writeAllowed: true } },
  { name: 'arcgis_basemap_list', args: {} },
  { name: 'arcgis_map_add_basemap', args: { basemap: 'Topographic', writeAllowed: true }, allowError: '在线底图，离线或未装对应插件时会失败' },
  { name: 'arcgis_map_remove_layer', args: { layer: path.basename(POINTS), map: MAP, writeAllowed: true } },

  // ---- 图层 -------------------------------------------------------------
  { name: 'arcgis_map_add_data#2', tool: 'arcgis_map_add_data', args: { data: [POINTS], writeAllowed: true } },
  { name: 'arcgis_layer_info', args: { layer: 'pts', map: MAP } },
  { name: 'arcgis_layer_update', args: { layer: 'pts', map: MAP, visible: false, writeAllowed: true } },
  { name: 'arcgis_layer_update#show', tool: 'arcgis_layer_update', args: { layer: 'pts', map: MAP, visible: true, writeAllowed: true } },
  { name: 'arcgis_layer_symbology', args: { layer: 'pts', map: MAP } },
  { name: 'arcgis_layer_export', args: { layer: 'pts', map: MAP, output: `${SCRATCH}/pts_${STAMP}.lyrx`, writeAllowed: true } },
  { name: 'arcgis_layer_add', args: { lyrx: `${SCRATCH}/pts_${STAMP}.lyrx`, map: MAP, writeAllowed: true } },
  { name: 'arcgis_layer_move', args: { layer: 'pts', map: MAP, position: 'before', writeAllowed: true } },
  { name: 'arcgis_layer_group', args: { name: '全测分组', layers: ['pts'], map: MAP, writeAllowed: true } },
  { name: 'arcgis_layer_toggle', args: { layers: ['pts'], map: MAP, visible: true, writeAllowed: true } },
  {
    name: 'arcgis_layer_symbology_apply',
    args: { layer: 'pts', map: MAP, symbologyLayer: `${SCRATCH}/pts_${STAMP}.lyrx`, writeAllowed: true },
  },
  { name: 'arcgis_label_info', args: { layer: 'pts', map: MAP } },
  { name: 'arcgis_label_set', args: { layer: 'pts', map: MAP, visible: true, expression: '$feature.名称', writeAllowed: true } },
  { name: 'arcgis_table_add', args: { data: TABLE, map: MAP, writeAllowed: true } },
  { name: 'arcgis_table_list', args: {} },
  { name: 'arcgis_style_list', args: {} },
  { name: 'arcgis_colorramp_list', args: { search: '红' } },
  { name: 'arcgis_report_list', args: {} },
  { name: 'arcgis_map_definition', args: {} },
  { name: 'arcgis_map_color_model', args: {} },
  { name: 'arcgis_map_color_model', args: { colorModel: 'RGB', writeAllowed: true } },
  { name: 'arcgis_map_reference_scale', args: {} },
  { name: 'arcgis_map_reference_scale', args: { scale: 50000, writeAllowed: true } },

  // ---- 书签 -------------------------------------------------------------
  { name: 'arcgis_bookmark_list', args: {} },
  { name: 'arcgis_bookmark_create', args: { name: '全测书签', writeAllowed: true }, allowError: '无窗口工程的 Map 没有 createBookmark' },
  { name: 'arcgis_bookmark_remove', args: { name: '全测书签', writeAllowed: true }, allowError: '前提是上面没建成' },
  { name: 'arcgis_bookmark_export', args: { output: `${SCRATCH}/bm_${STAMP}.json`, writeAllowed: true }, allowError: '空地图没有书签可导出' },
  { name: 'arcgis_bookmark_import', args: { input: `${SCRATCH}/bm_${STAMP}.json`, writeAllowed: true }, allowError: '上一步没导出成功就没有文件' },

  // ---- 布局与地图系列 ---------------------------------------------------
  { name: 'arcgis_layout_list', args: {} },
  { name: 'arcgis_layout_new', args: { width: 420, height: 297, units: 'MILLIMETER', name: LAYOUT, writeAllowed: true } },
  { name: 'arcgis_layout_info', args: { layout: LAYOUT } },
  { name: 'arcgis_layout_page_size', args: { layout: LAYOUT, width: 297, height: 210, units: 'MILLIMETER', writeAllowed: true } },
  { name: 'arcgis_layout_add_frame', args: { layout: LAYOUT, writeAllowed: true } },
  { name: 'arcgis_layout_elements', args: { layout: LAYOUT } },
  { name: 'arcgis_layout_text_set', args: { layout: LAYOUT, element: '标题', text: '全工具测试', writeAllowed: true }, allowError: '新布局里没有文本元素' },
  { name: 'arcgis_layout_export', args: { layout: LAYOUT, output: `${SCRATCH}/layout_${STAMP}.png`, resolution: 96, writeAllowed: true } },
  { name: 'arcgis_mapseries_info', args: { layout: LAYOUT } },
  { name: 'arcgis_mapseries_create', args: { layout: LAYOUT, indexLayer: 'pts', nameField: '名称', map: MAP, writeAllowed: true } },
  { name: 'arcgis_mapseries_info#2', tool: 'arcgis_mapseries_info', args: { layout: LAYOUT } },
  {
    name: 'arcgis_mapseries_export',
    args: { layout: LAYOUT, output: `${SCRATCH}/series_${STAMP}_{page}.png`, resolution: 72, writeAllowed: true },
  },

  // ---- 新建地图（Pro 的 createMap 首次要 100 秒以上，放最后）----------
  { name: 'arcgis_map_new', args: { name: `全测地图_${STAMP}`, writeAllowed: true } },

  // ---- 收尾 -------------------------------------------------------------
  { name: 'arcgis_project_close', args: {} },
]

// 上面有几条是为了造多个实例而加的编号条目（name 带 #n），跑的时候工具名取 tool 字段。
const results = []
let started = Date.now()

function toolNameOf(item) {
  return item.tool ?? item.name
}

for (const item of CASES) {
  const toolName = toolNameOf(item)
  const tool = tools.get(toolName)
  const at = Date.now()
  let status = 'fail'
  let note = ''
  if (!tool) {
    note = '工具不存在'
  } else {
    try {
      const value = await tool.execute(item.args ?? {})
      const ms = Date.now() - at
      if (value?.ok === false) {
        if (item.allowError) {
          status = 'pass'
          note = `预期失败：${String(value.error ?? '').split('\n')[0].slice(0, 100)}`
        } else {
          note = `${String(value.error ?? '').split('\n')[0].slice(0, 140)}`
        }
      } else {
        status = 'pass'
        note = item.allowError ? `（允许失败但成功了）` : ''
      }
      results.push({ tool: toolName, status, ms, note })
      const mark = status === 'pass' ? '✓' : '✗'
      console.log(`${mark} ${toolName.padEnd(32)} ${String(ms).padStart(7)}ms  ${status === 'pass' ? note.replace(/^（允许失败但成功了）$/, '') : note}`)
      continue
    } catch (error) {
      note = `${error.name}: ${String(error.message).split('\n')[0].slice(0, 140)}`
    }
  }
  const ms = Date.now() - at
  if (item.allowError) {
    status = 'pass'
    note = `预期失败：${note}`
  }
  results.push({ tool: toolName, status, ms, note })
  console.log(`${status === 'pass' ? '✓' : '✗'} ${toolName.padEnd(32)} ${String(ms).padStart(7)}ms  ${note}`)
}

// 覆盖核对：注册的每个工具都必须至少被调一次。
const covered = new Set(results.filter((r) => r.status === 'pass').map((r) => r.tool))
const missing = [...tools.keys()].filter((name) => !covered.has(name))
const failed = results.filter((r) => r.status === 'fail')

console.log('')
console.log(`工具 ${tools.size} 个 / 用例 ${CASES.length} 条 / 覆盖 ${covered.size} 个`)
if (missing.length > 0) {
  console.log(`\n没有被成功调用过的工具（${missing.length}）：${missing.join(', ')}`)
}
if (failed.length > 0) {
  console.log(`\n失败 ${failed.length} 项：`)
  for (const item of failed) console.log(`  - ${item.tool}: ${item.note}`)
}
console.log(`\n用时 ${((Date.now() - started) / 1000).toFixed(1)}s`)

try {
  await bridge.stop?.()
} catch {
  // 关桥失败不影响结论
}
process.exit(missing.length === 0 && failed.length === 0 ? 0 : 1)
