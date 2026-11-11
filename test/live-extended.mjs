/**
 * 真机联调（第二批）：选择 / 投影 / 转换 / 栅格 / 矢量分析 / 地图与布局 / 地图系列。
 *
 * 跟 live.mjs 分开是因为这批全部要建工程、建栅格，跑一遍 1–2 分钟；
 * live.mjs 保持"最短可证明链路"的定位。
 *
 * 断言的写法讲究：每一项失败都只记账不抛出，否则一个参数写错就看不到后面
 * 十几项的结果——真机验证一轮要十几秒，不能一次只暴露一个问题。
 *
 *   node test/live-extended.mjs
 */

import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

import { ArcPyBridge } from '../lib/bridge.js'
import { locatePython } from '../lib/paths.js'
import { allTools } from '../lib/tools/index.js'

const STAMP = Date.now().toString(36)
const SCRATCH = 'F:/workspace/_aprprobe_ext'
const GDB = `${SCRATCH}/ext_${STAMP}.gdb`
const RASTER_DIR = `${SCRATCH}/r_${STAMP}`
const PROJECT = `${SCRATCH}/proj_${STAMP}.aprx`
// 测试用自己的一份模板副本，别去动 Pro 安装目录里的 Blank.aprx——上一版
// 就是因为工程对象没重开，把安装目录的模板写成了"分析图/出图"的脏样子。
const TEMPLATE = `${SCRATCH}/template.aprx`
const INSTALL_BLANK = 'F:/arcgispro/Resources/ArcToolBox/Services/routingservices/data/Blank.aprx'

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

let failures = 0
function fail(label, detail) {
  failures += 1
  console.log(`    ✗ ${label}${detail ? `: ${detail}` : ''}`)
}
function check(label, condition, detail) {
  if (!condition) fail(label, detail)
}

/** 跑一项；工具层把异常包成返回值，所以 ok:false 也要算失败。 */
async function step(label, fn) {
  const at = Date.now()
  try {
    const value = await fn()
    if (value?.ok === false) {
      failures += 1
      console.log(`  ✗ ${label} (${Date.now() - at}ms)\n    ${String(value.error).split('\n')[0]}`)
      return null
    }
    console.log(`  ✓ ${label} (${Date.now() - at}ms)`)
    return value
  } catch (error) {
    failures += 1
    console.log(`  ✗ ${label} (${Date.now() - at}ms)\n    ${String(error.message).split('\n')[0]}`)
    return null
  }
}

console.log(`python: ${located.python}  [${located.source}]`)

try {
  console.log('\n== 桥 ==')
  const status = await step('arcgis_status', () => call('arcgis_status', {}))
  if (status) {
    console.log(`    arcpy ${status.boot.arcpyVersion} / ${status.boot.operations} ops / 启动 ${status.boot.bootSeconds}s`)
    check('op 数量应 ≥ 91', status.boot.operations >= 91, String(status.boot.operations))
  }

  console.log('\n== 建数据 ==')
  const gdb = await step('arcgis_data_create_gdb', () =>
    call('arcgis_data_create_gdb', { outFolder: SCRATCH, name: `ext_${STAMP}`, writeAllowed: true }))
  if (gdb) console.log(`    ${gdb.created}`)

  const POINTS = `${GDB}/cities`
  await step('arcgis_data_create_featureclass', () =>
    call('arcgis_data_create_featureclass', {
      outPath: GDB,
      name: 'cities',
      geometryType: 'point',
      spatialReference: 'EPSG:4326',
      fields: [
        { name: '名称', type: 'text', length: 60 },
        { name: '人口', type: 'long' },
      ],
      writeAllowed: true,
    }))

  const ins = await step('arcgis_data_insert 4 城', () =>
    call('arcgis_data_insert', {
      dataset: POINTS,
      rows: [
        { 名称: '上海', 人口: 2487, Shape: 'POINT (121.4737 31.2304)' },
        { 名称: '北京', 人口: 2189, Shape: 'POINT (116.4074 39.9042)' },
        { 名称: '广州', 人口: 1868, Shape: 'POINT (113.2644 23.1291)' },
        { 名称: '成都', 人口: 2094, Shape: 'POINT (104.0665 30.5723)' },
      ],
      writeAllowed: true,
    }))
  if (ins) console.log(`    写入 ${ins.inserted} 行`)

  console.log('\n== 复制与建表 ==')
  const copy = await step('arcgis_data_copy', () =>
    call('arcgis_data_copy', { source: POINTS, outPath: `${GDB}/cities_copy`, kind: 'features', writeAllowed: true }))
  if (copy) console.log(`    ${copy.output}`)

  const table = await step('arcgis_data_create_table', () =>
    call('arcgis_data_create_table', {
      outPath: GDB,
      name: 'notes',
      fields: [{ name: '标题', type: 'text', length: 40 }, { name: '分数', type: 'double' }],
      writeAllowed: true,
    }))
  if (table) console.log(`    ${table.created} / 字段 ${table.fieldsAdded.length}`)

  console.log('\n== 选择 ==')
  const sel = await step('arcgis_select_by_attribute', () =>
    call('arcgis_select_by_attribute', { input: POINTS, where: '人口 > 2100', selectionType: 'NEW_SELECTION' }))
  if (sel) {
    console.log(`    选中 ${sel.selected}`)
    check('人口 > 2100 应选中 2 个', sel.selected === 2, String(sel.selected))
  }

  const selLoc = await step('arcgis_select_by_location', () =>
    call('arcgis_select_by_location', {
      input: POINTS,
      selectFeatures: POINTS,
      overlap: 'WITHIN_A_DISTANCE',
      distance: '1500 Kilometers',
      selectionType: 'NEW_SELECTION',
    }))
  if (selLoc) {
    console.log(`    选中 ${selLoc.selected}`)
    check('1500km 内应选中全部 4 个', selLoc.selected === 4, String(selLoc.selected))
  }

  await step('arcgis_select_clear', () => call('arcgis_select_clear', { input: POINTS }))

  console.log('\n== 投影与转换 ==')
  const proj = await step('arcgis_reproject → EPSG:3857', () =>
    call('arcgis_reproject', {
      input: `${GDB}/cities_copy`,
      output: `${GDB}/cities_3857`,
      spatialReference: 'EPSG:3857',
      writeAllowed: true,
    }))
  if (proj) {
    const d = await call('arcgis_data_describe', { dataset: `${GDB}/cities_3857` })
    console.log(`    坐标系 wkid ${d.spatialReference?.wkid} / count ${d.count}`)
    check('投影后应是 3857', d.spatialReference?.wkid === 3857, String(d.spatialReference?.wkid))
  }

  await step('arcgis_define_projection', () =>
    call('arcgis_define_projection', { input: `${GDB}/cities`, spatialReference: 'EPSG:4326', writeAllowed: true }))

  const conv = await step('arcgis_convert_data → json', () =>
    call('arcgis_convert_data', {
      input: `${GDB}/cities`,
      output: `${SCRATCH}/cities_${STAMP}.json`,
      format: 'json',
      geoJson: true,
      writeAllowed: true,
    }))
  if (conv) console.log(`    ${conv.output ?? JSON.stringify(conv).slice(0, 100)}`)

  console.log('\n== 矢量分析 ==')
  const merged = await step('arcgis_data_merge', () =>
    call('arcgis_data_merge', {
      inputs: [POINTS, `${GDB}/cities_copy`],
      output: `${GDB}/cities_all`,
      writeAllowed: true,
    }))
  if (merged) {
    const d = await call('arcgis_data_describe', { dataset: `${GDB}/cities_all` })
    console.log(`    合并后 ${d.count} 行`)
    check('4 + 4 应得 8 行', d.count === 8, String(d.count))
  }

  const disso = await step('arcgis_data_dissolve', () =>
    call('arcgis_data_dissolve', {
      input: `${GDB}/cities_all`,
      output: `${GDB}/cities_dissolved`,
      fields: ['名称'],
      statistics: [{ field: '人口', stat: 'SUM' }],
      writeAllowed: true,
    }))
  if (disso) {
    const fields = await call('arcgis_data_fields', { dataset: `${GDB}/cities_dissolved` })
    const names = (fields.fields ?? []).map((f) => f.name)
    console.log(`    字段 ${names.join(', ')}`)
    check('应有 SUM_人口 字段', names.some((n) => n.includes('SUM') && n.includes('人口')), names.join(','))
  }

  console.log('\n== 栅格 ==')
  const toRaster = await step('GP conversion.PointToRaster', () =>
    call('arcgis_tool_run', {
      tool: 'conversion.PointToRaster',
      params: {
        in_features: POINTS,
        value_field: '人口',
        out_rasterdataset: `${RASTER_DIR}/pop.tif`,
        cell_assignment: 'MOST_FREQUENT',
        cellsize: 0.05,
      },
      writeAllowed: true,
    }))
  if (toRaster) console.log(`    status ${toRaster.status} → ${(toRaster.outputs ?? []).join(', ')}`)

  // 按位置传参 + 输出落在一个还不存在的 .gdb 里：两条都是实测踩过的坑
  // （位置传参曾绕过建目录逻辑；gdb 不能靠 makedirs 造，得 CreateFileGDB）。
  const nestedGdb = `${SCRATCH}/pos_${STAMP}/nested/auto_${STAMP}.gdb`
  const positional = await step('GP 按位置传参 + 自动建 gdb 容器', () =>
    call('arcgis_tool_run', {
      tool: 'management.CopyFeatures',
      args: [POINTS, `${nestedGdb}/cities_copy`],
      writeAllowed: true,
    }))
  if (positional) console.log(`    status ${positional.status} → ${(positional.outputs ?? []).join(', ')}`)
  check('位置传参的 GP 应成功（status 4）', positional?.status === 4, String(positional?.status))
  const nestedDescribe = await step('回读位置传参的输出', () =>
    call('arcgis_data_describe', { dataset: `${nestedGdb}/cities_copy` }))
  check('不存在的 gdb 容器应被自动创建', nestedDescribe?.count === 4, String(nestedDescribe?.count))

  const rinfo = await step('arcgis_raster_info', () => call('arcgis_raster_info', { dataset: `${RASTER_DIR}/pop.tif` }))
  if (rinfo) console.log(`    ${rinfo.width}×${rinfo.height} / ${rinfo.bandCount} band / cell ${rinfo.meanCellWidth}`)

  const resampled = await step('arcgis_raster_resample', () =>
    call('arcgis_raster_resample', {
      input: `${RASTER_DIR}/pop.tif`,
      output: `${RASTER_DIR}/pop_coarse.tif`,
      cellSize: 0.1,
      resampling: 'BILINEAR',
      writeAllowed: true,
    }))
  if (resampled) {
    const after = await call('arcgis_raster_info', { dataset: `${RASTER_DIR}/pop_coarse.tif` })
    console.log(`    重采样后 ${after.width}×${after.height} / cell ${after.meanCellWidth}`)
    check('像元应变成 0.1', Math.abs(after.meanCellWidth - 0.1) < 1e-6, String(after.meanCellWidth))
  }

  const mask = await step('GP analysis.Buffer 造掩膜面', () =>
    call('arcgis_tool_run', {
      tool: 'analysis.Buffer',
      params: {
        in_features: POINTS,
        out_feature_class: `${GDB}/mask`,
        buffer_distance_or_field: '500 Kilometers',
        dissolve_option: 'ALL',
      },
      writeAllowed: true,
    }))
  if (mask) console.log(`    status ${mask.status}`)

  const clipped = await step('arcgis_raster_clip', () =>
    call('arcgis_raster_clip', {
      input: `${RASTER_DIR}/pop.tif`,
      output: `${RASTER_DIR}/pop_clip.tif`,
      mask: `${GDB}/mask`,
      writeAllowed: true,
    }))
  if (clipped) check('裁剪结果应存在', clipped.exists === true, JSON.stringify(clipped))

  const calc = await step('arcgis_raster_calculator', () =>
    call('arcgis_raster_calculator', {
      rasters: { pop: `${RASTER_DIR}/pop.tif` },
      expression: 'pop * 2 + 1',
      output: `${RASTER_DIR}/pop_x2.tif`,
      writeAllowed: true,
    }))
  if (calc) console.log(`    ${calc.output ?? JSON.stringify(calc).slice(0, 100)}`)

  const slope = await step('arcgis_raster_surface slope', () =>
    call('arcgis_raster_surface', {
      input: `${RASTER_DIR}/pop.tif`,
      output: `${RASTER_DIR}/slope.tif`,
      method: 'slope',
      units: 'DEGREE',
      writeAllowed: true,
    }))
  if (slope) console.log(`    ${slope.output ?? JSON.stringify(slope).slice(0, 100)}`)

  const extracted = await step('arcgis_raster_extract_mask', () =>
    call('arcgis_raster_extract_mask', {
      input: `${RASTER_DIR}/pop.tif`,
      mask: `${GDB}/mask`,
      output: `${RASTER_DIR}/pop_extract.tif`,
      writeAllowed: true,
    }))
  if (extracted) check('掩膜提取结果应存在', extracted.exists === true, JSON.stringify(extracted))

  const mosaic = await step('arcgis_raster_mosaic', () =>
    call('arcgis_raster_mosaic', {
      inputs: [`${RASTER_DIR}/pop.tif`, `${RASTER_DIR}/pop_x2.tif`],
      output: `${RASTER_DIR}/mosaic.tif`,
      numberOfBands: 1,
      writeAllowed: true,
    }))
  if (mosaic) console.log(`    ${mosaic.output ?? JSON.stringify(mosaic).slice(0, 100)}`)

  console.log('\n== 工程 / 地图 / 布局 ==')
  await step('准备自有模板副本', async () => {
    const fs = await import('node:fs')
    if (!fs.existsSync(TEMPLATE)) fs.copyFileSync(INSTALL_BLANK, TEMPLATE)
  })
  await step('arcgis_project_new', () =>
    call('arcgis_project_new', { project: PROJECT, template: TEMPLATE, writeAllowed: true }))

  const newMap = await step('arcgis_map_new', () => call('arcgis_map_new', { name: '分析图', writeAllowed: true }))
  if (newMap) {
    console.log(`    ${newMap.created} / ${newMap.mapType} / 摘掉底图 ${(newMap.droppedBasemap ?? []).join(',') || '(无)'}`)
    // createMap 在 Pro 3.6 上要从模板克隆底图工程，实测首次 ~110s、第二次 ~56s，
    // 跟有没有网无关，摘底图也省不掉。这里只保证结果对，不设耗时上限。
    check('新地图不该带 Topographic 底图', (newMap.layers ?? []).length === 0, JSON.stringify(newMap.layers))
  }

  const added = await step('arcgis_map_add_data', () =>
    call('arcgis_map_add_data', { data: POINTS, map: '分析图', writeAllowed: true }))
  if (added) {
    console.log(`    加入：${(added.added ?? []).join(', ')} / 图层：${(added.layers ?? []).join(', ')}`)
    check('加入列表应是路径字符串', typeof (added.added ?? [])[0] === 'string', JSON.stringify(added.added))
    check('地图里应出现 cities 图层', (added.layers ?? []).includes('cities'), JSON.stringify(added.layers))
  }

  const newLayout = await step('arcgis_layout_new', () =>
    call('arcgis_layout_new', { width: 420, height: 297, units: 'MILLIMETER', name: '出图', writeAllowed: true }))
  if (newLayout) {
    console.log(`    ${newLayout.created} / ${newLayout.pageWidth}×${newLayout.pageHeight} ${newLayout.pageUnits}`)
    check('页面单位应是 MILLIMETER', newLayout.pageUnits === 'MILLIMETER', String(newLayout.pageUnits))
  }

  const resized = await step('arcgis_layout_page_size', () =>
    call('arcgis_layout_page_size', {
      layout: '出图',
      width: 297,
      height: 210,
      units: 'MILLIMETER',
      writeAllowed: true,
    }))
  if (resized) console.log(`    改成 ${resized.pageWidth}×${resized.pageHeight} ${resized.pageUnits}`)

  const frame = await step('arcgis_layout_add_frame', () =>
    call('arcgis_layout_add_frame', {
      layout: '出图',
      map: '分析图',
      x: 10,
      y: 10,
      width: 277,
      height: 170,
      name: '主图框',
      writeAllowed: true,
    }))
  if (frame) {
    console.log(`    ${frame.frame} / ${frame.elementType}`)
    check('元素类型应是 MAPFRAME_ELEMENT', frame.elementType === 'MAPFRAME_ELEMENT', String(frame.elementType))
  }

  const elements = await step('arcgis_layout_elements', () => call('arcgis_layout_elements', { layout: '出图' }))
  if (elements) console.log(`    ${elements.count} 个：${elements.elements.map((e) => `${e.name}(${e.elementType})`).join(', ')}`)

  console.log('\n== 地图系列 ==')
  const msInfo0 = await step('arcgis_mapseries_info（未建）', () => call('arcgis_mapseries_info', { layout: '出图' }))
  if (msInfo0) {
    console.log(`    enabled: ${msInfo0.enabled}`)
    check('新布局不该已有地图系列', msInfo0.enabled === false, String(msInfo0.enabled))
  }

  const msCreate = await step('arcgis_mapseries_create', () =>
    call('arcgis_mapseries_create', {
      layout: '出图',
      mapFrame: '主图框',
      indexLayer: 'cities',
      nameField: '名称',
      map: '分析图',
      writeAllowed: true,
    }))
  if (msCreate) console.log(`    enabled ${msCreate.enabled} / ${msCreate.pageCount} 页`)

  const msInfo1 = await step('arcgis_mapseries_info（已建）', () => call('arcgis_mapseries_info', { layout: '出图' }))
  if (msInfo1) {
    console.log(`    pageCount ${msInfo1.pageCount} / 索引层 ${msInfo1.indexLayer} / 页名字段 ${msInfo1.pageNameField}`)
    check('应启用地图系列', msInfo1.enabled === true, String(msInfo1.enabled))
    check('页数应是 4', msInfo1.pageCount === 4, String(msInfo1.pageCount))
    check('索引层应是 cities', msInfo1.indexLayer === 'cities', String(msInfo1.indexLayer))
  }

  const msExport = await step('arcgis_mapseries_export', () =>
    call('arcgis_mapseries_export', {
      layout: '出图',
      output: `${SCRATCH}/series_${STAMP}/page_{page}.png`,
      resolution: 96,
      writeAllowed: true,
    }))
  if (msExport) {
    console.log(`    ${msExport.files} 页 / 错误 ${msExport.errors.length}`)
    if (msExport.written.length > 0) {
      console.log(`    首页 ${msExport.written[0].output} = ${msExport.written[0].bytes} 字节`)
      check('导出页应大于 1KB', msExport.written[0].bytes > 1000, String(msExport.written[0].bytes))
    }
    check('导出不该有错误', msExport.errors.length === 0, JSON.stringify(msExport.errors).slice(0, 160))
  }

  console.log('\\n== 图层级操作 ==')
  const basemaps = await step('arcgis_basemap_list', () => call('arcgis_basemap_list', {}))
  if (basemaps) {
    console.log(`    ${basemaps.count} 个：${(basemaps.basemaps ?? []).slice(0, 3).join(', ')}`)
    check('底图清单应是非空字符串数组', (basemaps.basemaps ?? []).length > 0 && typeof basemaps.basemaps[0] === 'string', JSON.stringify(basemaps.basemaps))
    // addBasemap 只认在线底图名（Topographic/Streets/…）；本机只装了天地图，
    // 传工程列表里的名字会被 arcpy 拒。这里只验证"拒绝时有明确原因"。
    const target = basemaps.basemaps?.[0]
    if (target) {
      const bm = await call('arcgis_map_add_basemap', { name: target, map: '分析图', writeAllowed: true })
      if (bm?.ok === false) {
        console.log(`    ✓ arcgis_map_add_basemap 明确拒绝（预期，离线/非在线底图）：${String(bm.error).split('\\n')[0].slice(0, 90)}`)
      } else {
        console.log(`    arcgis_map_add_basemap 成功：${JSON.stringify(bm).slice(0, 120)}`)
      }
    }
  }

  const styles = await step('arcgis_style_list', () => call('arcgis_style_list', {}))
  if (styles) {
    console.log(`    ${styles.count} 个：${(styles.styles ?? []).join(', ')}`)
    check('样式库应含 ArcGIS 2D', (styles.styles ?? []).includes('ArcGIS 2D'), JSON.stringify(styles.styles))
    check('样式清单应带 count', typeof styles.count === 'number', String(styles.count))
  }

  const ramps = await step('arcgis_colorramp_list', () => call('arcgis_colorramp_list', {}))
  if (ramps) {
    console.log(`    ${ramps.count} 个色带`)
    check('色带数量应 > 10', (ramps.count ?? 0) > 10, String(ramps.count))
  }
  const rampsFiltered = await step('arcgis_colorramp_list(search)', () => call('arcgis_colorramp_list', { search: '红' }))
  if (rampsFiltered && ramps) {
    console.log(`    过滤「红」→ ${rampsFiltered.count}`)
    check('过滤结果应少于全量', (rampsFiltered.count ?? 0) < (ramps.count ?? 0), `${rampsFiltered.count} vs ${ramps.count}`)
  }

  const reports = await step('arcgis_report_list', () => call('arcgis_report_list', {}))
  if (reports) console.log(`    ${reports.count} 个报表`)

  const tables = await step('arcgis_table_list', () => call('arcgis_table_list', { map: '分析图' }))
  if (tables) console.log(`    ${tables.count} 张表：${(tables.tables ?? []).map((t) => t.name ?? t).join(', ')}`)

  const mapDef = await step('arcgis_map_definition', () => call('arcgis_map_definition', { map: '分析图' }))
  if (mapDef) {
    console.log(`    ${mapDef.definitionType} / ${mapDef.keyCount} 个顶层键${mapDef.note ? ` (${mapDef.note})` : ''}`)
    check('CIM 定义应有键', (mapDef.keyCount ?? 0) > 0, `${mapDef.definitionType} / ${mapDef.preview ?? ''}`)
  }

  const cmRead = await step('arcgis_map_color_model（读）', () => call('arcgis_map_color_model', { map: '分析图' }))
  if (cmRead) console.log(`    当前 ${cmRead.colorModel}`)
  const cmSet = await step('arcgis_map_color_model（写）', () =>
    call('arcgis_map_color_model', { colorModel: 'CMYK', map: '分析图', writeAllowed: true }))
  if (cmSet) check('改为 CMYK 应生效', cmSet.colorModel === 'CMYK', String(cmSet.colorModel))
  await step('arcgis_map_color_model（还原 RGB）', () =>
    call('arcgis_map_color_model', { colorModel: 'RGB', map: '分析图', writeAllowed: true }))

  const rsRead = await step('arcgis_map_reference_scale（读）', () => call('arcgis_map_reference_scale', { map: '分析图' }))
  if (rsRead) console.log(`    当前 ${rsRead.referenceScale}`)
  const rsSet = await step('arcgis_map_reference_scale（写 50000）', () =>
    call('arcgis_map_reference_scale', { scale: 50000, map: '分析图', writeAllowed: true }))
  if (rsSet) check('参考比例尺应变成 50000', Number(rsSet.referenceScale) === 50000, String(rsSet.referenceScale))

  const labelInfo0 = await step('arcgis_label_info', () => call('arcgis_label_info', { layer: 'cities', map: '分析图' }))
  if (labelInfo0) {
    console.log(`    supports ${labelInfo0.supportsLabels} / showLabels ${labelInfo0.showLabels} / ${labelInfo0.labelClasses?.length ?? 0} 个标注类`)
    check('要素图层应支持标注', labelInfo0.supportsLabels === true, String(labelInfo0.supportsLabels))
  }

  const labelSet = await step('arcgis_label_set', () =>
    call('arcgis_label_set', {
      layer: 'cities',
      visible: true,
      expression: '$feature.名称',
      map: '分析图',
      writeAllowed: true,
    }))
  if (labelSet) console.log(`    showLabels ${labelSet.showLabels}`)
  const labelInfo1 = await step('arcgis_label_info（改后）', () => call('arcgis_label_info', { layer: 'cities', map: '分析图' }))
  if (labelInfo1) {
    const expr = (labelInfo1.labelClasses ?? []).map((c) => c.expression).filter(Boolean).join(' | ')
    console.log(`    showLabels ${labelInfo1.showLabels} / 表达式 ${expr || '(空)'}`)
    check('标注应已打开', labelInfo1.showLabels === true, String(labelInfo1.showLabels))
    check('表达式应含 名称', expr.includes('名称'), expr)
  }

  // 样板：把 cities 存成 lyrx，再套回 cities 自己（几何类型一致，必然可套）。
  const LYRX = `${SCRATCH}/cities_${STAMP}.lyrx`
  const lyrExport = await step('arcgis_layer_export', () =>
    call('arcgis_layer_export', { layer: 'cities', output: LYRX, map: '分析图', writeAllowed: true }))
  if (lyrExport) console.log(`    ${JSON.stringify(lyrExport).slice(0, 120)}`)

  const symApply = await step('arcgis_layer_symbology_apply', () =>
    call('arcgis_layer_symbology_apply', {
      layer: 'cities',
      symbologyLayer: LYRX,
      map: '分析图',
      writeAllowed: true,
    }))
  if (symApply) console.log(`    ${JSON.stringify(symApply).slice(0, 140)}`)

  const lyrAdd = await step('arcgis_layer_add', () =>
    call('arcgis_layer_add', { lyrx: LYRX, map: '分析图', writeAllowed: true }))
  if (lyrAdd) console.log(`    ${JSON.stringify(lyrAdd).slice(0, 140)}`)

  const layersNow = await step('arcgis_map_info（加 lyrx 后）', () => call('arcgis_map_info', { map: '分析图' }))
  const layerNames = (layersNow?.layers ?? []).map((l) => l.name).filter(Boolean)
  if (layersNow) console.log(`    图层：${layerNames.join(', ')}`)
  check('加 lyrx 后应有 2 个图层', layerNames.length >= 2, String(layerNames.length))

  if (layerNames.length >= 2) {
    // 两个图层都叫 cities——正好验证"同图内同名不再报错，取最上面那个"。
    // 但它没法验证 moveLayer 的方向（同名时比名字永远相等），方向用下面的 cities2 测。
    const moved = await step('arcgis_layer_move（同名图层，after）', () =>
      call('arcgis_layer_move', {
        layer: layerNames[1],
        referenceLayer: layerNames[0],
        position: 'after',
        map: '分析图',
        writeAllowed: true,
      }))
    if (moved) console.log(`    ${JSON.stringify(moved).slice(0, 200)}`)
    check('同名图层 move 应成功且不报歧义', moved?.moved === true, JSON.stringify(moved ?? {}).slice(0, 120))
  }

  // moveLayer 方向专项：真实签名是 (reference_layer, move_layer)，写反了不报错但方向反。
  // 必须用两个名字不同的图层，否则只能比出 cities,cities。
  await step('arcgis_data_copy（造一个不同名的图层）', () =>
    call('arcgis_data_copy', { source: POINTS, outPath: `${GDB}/cities2`, kind: 'features', writeAllowed: true }))
  const withSecond = await step('arcgis_map_add_data（cities2）', () =>
    call('arcgis_map_add_data', { data: [`${GDB}/cities2`], map: '分析图', writeAllowed: true }))
  if (withSecond) console.log(`    ${JSON.stringify(withSecond).slice(0, 160)}`)

  const ascOrder = await step('arcgis_layer_move（cities2 移到 cities 上方）', () =>
    call('arcgis_layer_move', {
      layer: 'cities2', referenceLayer: 'cities', position: 'before', map: '分析图', writeAllowed: true,
    }))
  const ascLayers = (ascOrder?.layers ?? []);
  check('before 应把 cities2 放到 cities 上方（方向没反）',
    ascLayers.indexOf('cities2') >= 0 && ascLayers.indexOf('cities2') < ascLayers.indexOf('cities'),
    ascLayers.join(','))

  const descOrder = await step('arcgis_layer_move（cities2 移到 cities 下方）', () =>
    call('arcgis_layer_move', {
      layer: 'cities2', referenceLayer: 'cities', position: 'after', map: '分析图', writeAllowed: true,
    }))
  const descLayers = (descOrder?.layers ?? []);
  check('after 应把 cities2 放到 cities 下方', descLayers.indexOf('cities2') > descLayers.indexOf('cities'),
    descLayers.join(','))

  const toTop = await step('arcgis_layer_move（不给参照层＝置顶）', () =>
    call('arcgis_layer_move', { layer: 'cities2', map: '分析图', writeAllowed: true }))
  if (toTop) console.log(`    ${JSON.stringify(toTop).slice(0, 160)}`)
  check('置顶应报告 position=top 且真到第一个', toTop?.position === 'top' && (toTop?.layers ?? [])[0] === 'cities2',
    JSON.stringify({ position: toTop?.position, first: (toTop?.layers ?? [])[0] }))

  const toggled = await step('arcgis_layer_toggle', () =>
    call('arcgis_layer_toggle', { layers: ['cities'], visible: false, map: '分析图', writeAllowed: true }))
  if (toggled) {
    console.log(`    ${JSON.stringify(toggled).slice(0, 200)}`)
    check('应该关掉 1 个图层', (toggled.updated ?? []).length >= 1, JSON.stringify(toggled.updated ?? toggled))
  }
  await step('arcgis_layer_toggle（还原）', () =>
    call('arcgis_layer_toggle', { layers: ['cities'], visible: true, map: '分析图', writeAllowed: true }))

  const grouped = await step('arcgis_layer_group', () =>
    call('arcgis_layer_group', { name: '底图层', layers: ['cities'], map: '分析图', writeAllowed: true }))
  if (grouped) {
    // 无窗口工程里没法真把图层挪进分组（实测 addLayerToGroup / insertLayer
    // 全都返回成功但组内为空），断言只看"分组建出来了 + 状态如实上报"。
    console.log(`    分组 ${grouped.group} / membered=${grouped.membered}`)
    const after = await call('arcgis_map_info', { map: '分析图' })
    const names = (after?.layers ?? []).map((l) => l.name)
    check('应出现「底图层」分组', names.includes('底图层'), JSON.stringify(names))
    check('membered 应为布尔', typeof grouped.membered === 'boolean', String(grouped.membered))
  }

  console.log('\\n== 书签 ==')
  console.log('== arcgis_python（通用出口） ==')
  const pyDenied = await call('arcgis_python', { code: 'print(1)' })
  check('没有 writeAllowed 应被拒', pyDenied?.ok === false && pyDenied?.code === 'WRITE_NOT_ALLOWED',
    JSON.stringify(pyDenied).slice(0, 120))

  const pyRun = await step('arcgis_python 跑一段脚本', () =>
    call('arcgis_python', {
      code: [
        'maps = aprx.listMaps()',
        "print('地图数', len(maps))",
        'result = {"maps": [m.name for m in maps], "layers": len(maps[0].listLayers())}',
      ].join('\n'),
      writeAllowed: true,
    }))
  if (pyRun) {
    console.log(`    ${JSON.stringify(pyRun.result)} | ${String(pyRun.stdout ?? '').trim()}`)
    check('脚本应拿到当前工程对象 aprx', Array.isArray(pyRun.result?.maps) && pyRun.result.maps.length >= 1,
      JSON.stringify(pyRun.result))
    check('stdout 应被捕获', String(pyRun.stdout ?? '').includes('地图数'), String(pyRun.stdout ?? '').slice(0, 60))
  }

  const pyErr = await call('arcgis_python', { code: 'raise RuntimeError("故意失败")', writeAllowed: true })
  check('脚本异常应带回类型与 traceback',
    pyErr?.ok === false && pyErr?.error?.type === 'RuntimeError' && String(pyErr?.error?.traceback ?? '').length > 0,
    JSON.stringify(pyErr?.error ?? {}).slice(0, 120))

  const bm0 = await step('arcgis_bookmark_list', () => call('arcgis_bookmark_list', { map: '分析图' }))
  if (bm0) console.log(`    ${bm0.count} 个书签`)
  const BMJSON = `${SCRATCH}/bookmarks_${STAMP}.json`
  // 无窗口工程里 Map 没有 createBookmark，书签必然是 0 个，导出会明确报错。
  const bmExport = await call('arcgis_bookmark_export', { output: BMJSON, map: '分析图', writeAllowed: true })
  if (bmExport?.ok === false) {
    console.log(`    ✓ arcgis_bookmark_export 明确报错（预期，本来就没有书签）：${String(bmExport.error).split('\\n')[0].slice(0, 90)}`)
  } else {
    console.log(`    arcgis_bookmark_export：${JSON.stringify(bmExport).slice(0, 120)}`)
  }
  // createBookmark 在无窗口工程里不存在，这里必须接受"明确的报错"。
  const bmCreate = await call('arcgis_bookmark_create', { name: '视图1', map: '分析图', writeAllowed: true })
  if (bmCreate?.ok === false) {
    console.log(`    ✓ arcgis_bookmark_create 明确报错（预期）：${String(bmCreate.error).split('\\n')[0].slice(0, 100)}`)
  } else {
    console.log(`    arcgis_bookmark_create 居然成功：${JSON.stringify(bmCreate).slice(0, 120)}`)
  }

  await step('arcgis_project_save', () => call('arcgis_project_save', { writeAllowed: true }))

  const info = await step('arcgis_project_info', () => call('arcgis_project_info', {}))
  if (info) console.log(`    地图 ${info.maps.map((m) => m.name).join('/')} · 布局 ${info.layouts.map((l) => l.name).join('/')}`)
} finally {
  await bridge.stop()
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
