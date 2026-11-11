/**
 * 选择、投影、格式转换、栅格处理、矢量合并。
 *
 * 每一项底层都是标准 GP 工具，包一层是因为 GP 的参数容易记错：
 * `SelectLayerByAttribute` 要传图层而不是路径、`Resample` 没有宽高、
 * `MosaicToNewRaster` 的波段数是必填。这里的 description 直接写清这些坑。
 */

import { defineTool, safe, requireWrite } from '../tool-kit.js'

const SELECTION_TYPES = ['NEW_SELECTION', 'ADD_TO_SELECTION', 'REMOVE_FROM_SELECTION', 'SUBSET_SELECTION', 'SWITCH_SELECTION', 'CLEAR_SELECTION']

export function analysisTools(bridge) {
  return [
    defineTool({
      name: 'arcgis_select_by_attribute',
      description:
        '按属性选择要素，返回选中数量。input 可以是地图图层名或数据集路径；选择作用在图层上才会留下"当前选择"状态。' +
        'where 用标准 SQL，例如 "POP > 10000" 或 "名称 = \'上海\'"。',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: '地图图层名或数据集路径。' },
          where: { type: 'string', description: 'SQL 条件，字段名要和数据集完全一致。' },
          selectionType: {
            type: 'string',
            enum: SELECTION_TYPES,
            description: '选择方式，默认 NEW_SELECTION。',
          },
          map: { type: 'string', description: '限定在某个地图里找图层（可选）。' },
        },
        required: ['input', 'where'],
        additionalProperties: false,
      },
      execute: safe(async (args) =>
        bridge.call('select.by_attribute', {
          input: args.input,
          where: args.where,
          selectionType: args.selectionType,
          map: args.map,
        }),
      ),
    }),

    defineTool({
      name: 'arcgis_select_by_location',
      description:
        '按空间关系选择要素：相交、包含、位于内部、指定距离内等。需要距离的关系（WITHIN_A_DISTANCE）必须给 distance，' +
        '例如 "1 Kilometers"。selectFeatures 是被比较的另一个图层或要素类。',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: '要选择的图层/数据集。' },
          overlap: {
            type: 'string',
            enum: [
              'INTERSECT',
              'WITHIN_A_DISTANCE',
              'CONTAINS',
              'COMPLETELY_CONTAINS',
              'WITHIN',
              'COMPLETELY_WITHIN',
              'ARE_IDENTICAL_TO',
              'BOUNDARY_TOUCHES',
              'CROSSED_BY_THE_OUTLINE_OF',
              'HAVE_THEIR_CENTER_IN',
              'SHARE_A_LINE_SEGMENT_WITH',
            ],
            description: '空间关系，默认 INTERSECT。',
          },
          selectFeatures: { type: 'string', description: '与之比较的图层名或路径。' },
          distance: { type: 'string', description: '搜索距离，例如 "1 Kilometers"。' },
          selectionType: { type: 'string', enum: SELECTION_TYPES, description: '选择方式。' },
          map: { type: 'string', description: '限定地图（可选）。' },
        },
        required: ['input', 'selectFeatures'],
        additionalProperties: false,
      },
      execute: safe(async (args) =>
        bridge.call('select.by_location', {
          input: args.input,
          overlap: args.overlap,
          selectFeatures: args.selectFeatures,
          distance: args.distance,
          selectionType: args.selectionType,
          map: args.map,
        }),
      ),
    }),

    defineTool({
      name: 'arcgis_select_clear',
      description: '清除图层上的选择，返回清除后的要素总数。',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: '地图图层名或数据集路径。' },
          map: { type: 'string', description: '限定地图（可选）。' },
        },
        required: ['input'],
        additionalProperties: false,
      },
      execute: safe(async (args) => bridge.call('select.clear', { input: args.input, map: args.map })),
    }),

    defineTool({
      name: 'arcgis_reproject',
      description:
        '投影/重投影一个数据集。矢量和栅格自动判断（矢量走 Project，栅格走 ProjectRaster）。' +
        '跨基准面需要 transformation 名称，同一基准面内不需要。',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: '输入图层名或数据集路径。' },
          output: { type: 'string', description: '输出数据集路径。' },
          spatialReference: {
            type: ['string', 'number', 'object'],
            description: '目标坐标系：4326、"EPSG:3857"，或 {"__arcpy__":"SpatialReference","wkid":4547}。',
          },
          transformation: { type: 'string', description: '基准面转换名称（跨基准面才需要）。' },
          resamplingType: { type: 'string', description: '栅格重采样方式：NEAREST/BILINEAR/CUBIC。' },
          cellSize: { type: 'number', description: '栅格输出像元大小（可选）。' },
          map: { type: 'string', description: '限定地图（可选）。' },
        },
        required: ['input', 'output', 'spatialReference'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_reproject', args)
        return bridge.call('project.data', {
          input: args.input,
          output: args.output,
          spatialReference: args.spatialReference,
          transformation: args.transformation,
          resamplingType: args.resamplingType,
          cellSize: args.cellSize,
          map: args.map,
        })
      }),
    }),

    defineTool({
      name: 'arcgis_define_projection',
      description:
        '只写坐标系定义，不改坐标值。数据本身坐标正确、只是缺 .prj 信息时用这个；' +
        '坐标值需要换算时用 arcgis_reproject。',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: '数据集路径或图层名。' },
          spatialReference: { type: ['string', 'number', 'object'], description: '要写入的坐标系。' },
          map: { type: 'string', description: '限定地图（可选）。' },
        },
        required: ['input', 'spatialReference'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_define_projection', args)
        return bridge.call('project.define', {
          input: args.input,
          spatialReference: args.spatialReference,
          map: args.map,
        })
      }),
    }),

    defineTool({
      name: 'arcgis_convert_data',
      description:
        '把要素类/表转成 shapefile、GeoJSON 或 Excel。format 省略时按 output 扩展名推断。' +
        'shapefile 那条 output 是输出文件夹（shapefile 是多文件，不是一个文件）。',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: '输入图层名或数据集路径。' },
          output: { type: 'string', description: 'shapefile 给文件夹；json/excel 给文件路径。' },
          format: { type: 'string', enum: ['shapefile', 'json', 'excel'], description: '输出格式。' },
          geoJson: { type: 'boolean', description: 'json 格式时是否写成标准 GeoJSON。' },
          map: { type: 'string', description: '限定地图（可选）。' },
        },
        required: ['input', 'output'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_convert_data', args)
        return bridge.call('convert.data', {
          input: args.input,
          output: args.output,
          format: args.format,
          geoJson: args.geoJson,
          map: args.map,
        })
      }),
    }),

    defineTool({
      name: 'arcgis_raster_resample',
      description:
        '改变栅格像元大小（重采样）。注意这个工具没有 width/height——Resample 本身只有 cellSize，' +
        '想得到指定像素数请先算好像元大小。',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: '输入栅格路径。' },
          output: { type: 'string', description: '输出栅格路径。' },
          cellSize: { type: 'number', description: '输出像元大小，例如 30。' },
          resampling: {
            type: 'string',
            enum: ['NEAREST', 'BILINEAR', 'CUBIC', 'MAJORITY'],
            description: '重采样方式，默认 NEAREST。',
          },
          map: { type: 'string', description: '限定地图（可选）。' },
        },
        required: ['input', 'output', 'cellSize'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_raster_resample', args)
        return bridge.call('raster.resample', {
          input: args.input,
          output: args.output,
          cellSize: args.cellSize,
          resampling: args.resampling,
          map: args.map,
        })
      }),
    }),

    defineTool({
      name: 'arcgis_raster_clip',
      description:
        '裁剪栅格。给 rectangle（"xMin yMin xMax yMax"）走矩形裁剪；给 mask（面要素）走不规则裁剪，' +
        '按要素边界裁掉框外像元。',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: '输入栅格路径。' },
          output: { type: 'string', description: '输出栅格路径。' },
          rectangle: { type: 'string', description: '裁剪范围 "xMin yMin xMax yMax"。' },
          mask: { type: 'string', description: '裁剪用的面要素（图层名或路径）。' },
          nodataValue: { type: 'string', description: '裁剪区外的填充值（可选）。' },
          map: { type: 'string', description: '限定地图（可选）。' },
        },
        required: ['input', 'output'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_raster_clip', args)
        return bridge.call('raster.clip', {
          input: args.input,
          output: args.output,
          rectangle: args.rectangle,
          mask: args.mask,
          nodataValue: args.nodataValue,
          map: args.map,
        })
      }),
    }),

    defineTool({
      name: 'arcgis_raster_mosaic',
      description:
        '把多张栅格镶嵌成一张。波段数不给时从第一张探测——MosaicToNewRaster 的波段数其实是必填项，' +
        '这里替你补上。输入栅格的像元类型和坐标系要一致。',
      parameters: {
        type: 'object',
        properties: {
          inputs: { type: 'array', items: { type: 'string' }, description: '输入栅格路径数组。' },
          output: { type: 'string', description: '输出栅格路径，例如 D:/ws/mosaic.tif。' },
          pixelType: {
            type: 'string',
            description: '像元类型内部代码，如 8_BIT_UNSIGNED、32_BIT_FLOAT；不给则沿用输入。',
          },
          cellsize: { type: 'number', description: '输出像元大小（可选）。' },
          numberOfBands: { type: 'number', description: '波段数，默认探测第一个输入。' },
          mosaicMethod: { type: 'string', description: '重叠处取哪张：FIRST/LAST/BLEND/MEAN/MINIMUM/MAXIMUM/SUM。' },
          colormapMode: { type: 'string', description: '色彩映射表处理：FIRST/LAST/MATCH/REJECT。' },
          spatialReference: { type: ['string', 'number', 'object'], description: '输出坐标系（可选）。' },
        },
        required: ['inputs', 'output'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_raster_mosaic', args)
        return bridge.call('raster.mosaic', {
          inputs: args.inputs,
          output: args.output,
          pixelType: args.pixelType,
          cellsize: args.cellsize,
          numberOfBands: args.numberOfBands,
          mosaicMethod: args.mosaicMethod,
          colormapMode: args.colormapMode,
          spatialReference: args.spatialReference,
        })
      }),
    }),

    defineTool({
      name: 'arcgis_raster_calculator',
      description:
        '栅格计算器：rasters 是 {变量名: 栅格路径}，expression 用这些变量名写算式，' +
        '例如 "b1 * 0.5 + b2" 或 "Con(b1 > 100, 1, 0)"。' +
        '可用函数：Con / IsNull / SetNull / Abs / Exp / Ln / Log10 / Sqrt / Int / Float / Sin / Cos / Tan。',
      parameters: {
        type: 'object',
        properties: {
          rasters: {
            type: 'object',
            description: '变量名到栅格路径的映射，例如 {"b1": "D:/r/a.tif", "b2": "D:/r/b.tif"}。',
            additionalProperties: { type: 'string' },
          },
          expression: { type: 'string', description: '算式，例如 "(float(b1) - b2) / (float(b1) + b2)"。' },
          output: { type: 'string', description: '输出栅格路径。' },
        },
        required: ['rasters', 'expression', 'output'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_raster_calculator', args)
        return bridge.call('raster.calculator', {
          rasters: args.rasters,
          expression: args.expression,
          output: args.output,
        })
      }),
    }),

    defineTool({
      name: 'arcgis_raster_extract_mask',
      description: '按掩膜提取栅格：只保留掩膜范围内的像元，其余变 NoData。掩膜可以是面要素或栅格。',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: '输入栅格路径。' },
          mask: { type: 'string', description: '掩膜（图层名或路径）。' },
          output: { type: 'string', description: '输出栅格路径。' },
          map: { type: 'string', description: '限定地图（可选）。' },
        },
        required: ['input', 'mask', 'output'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_raster_extract_mask', args)
        return bridge.call('raster.extract_mask', {
          input: args.input,
          mask: args.mask,
          output: args.output,
          map: args.map,
        })
      }),
    }),

    defineTool({
      name: 'arcgis_raster_surface',
      description:
        '地形派生：坡度（slope）、坡向（aspect）、山体阴影（hillshade）、等高线（contour）。' +
        '需要 3D Analyst。等高线必须给 interval。',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: '输入高程栅格。' },
          output: { type: 'string', description: '输出路径（contour 输出要素类，其余输出栅格）。' },
          method: { type: 'string', enum: ['slope', 'aspect', 'hillshade', 'contour'], description: '派生类型。' },
          units: { type: 'string', description: 'slope 用：DEGREE 或 PERCENT_RISE。' },
          surfaceMethod: { type: 'string', description: 'slope/aspect 用：PLANAR 或 GEODESIC。' },
          zFactor: { type: 'number', description: 'Z 因子（高程单位与平面单位不一致时用）。' },
          azimuth: { type: 'number', description: 'hillshade 用：光源方位角，默认 315。' },
          altitude: { type: 'number', description: 'hillshade 用：光源高度角，默认 45。' },
          modelShadows: { type: 'boolean', description: 'hillshade 用：是否计算阴影。' },
          interval: { type: 'number', description: 'contour 用：等值线间距。' },
          baseContour: { type: 'number', description: 'contour 用：起始等值线（可选）。' },
          map: { type: 'string', description: '限定地图（可选）。' },
        },
        required: ['input', 'output', 'method'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_raster_surface', args)
        return bridge.call('raster.surface', {
          input: args.input,
          output: args.output,
          method: args.method,
          units: args.units,
          surfaceMethod: args.surfaceMethod,
          zFactor: args.zFactor,
          azimuth: args.azimuth,
          altitude: args.altitude,
          modelShadows: args.modelShadows,
          interval: args.interval,
          baseContour: args.baseContour,
          map: args.map,
        })
      }),
    }),

    defineTool({
      name: 'arcgis_data_merge',
      description: '把多个同类要素类合成一个新的。输入的几何类型和坐标系要一致。',
      parameters: {
        type: 'object',
        properties: {
          inputs: { type: 'array', items: { type: 'string' }, description: '要合并的图层名或路径数组。' },
          output: { type: 'string', description: '输出要素类路径。' },
          map: { type: 'string', description: '限定地图（可选）。' },
        },
        required: ['inputs', 'output'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_data_merge', args)
        return bridge.call('data.merge', {
          inputs: args.inputs,
          output: args.output,
          map: args.map,
        })
      }),
    }),

    defineTool({
      name: 'arcgis_data_append',
      description:
        '把多个要素类追加进一个已存在的目标。schemaType 用 TEST 会做字段校验，NO_TEST 直接按位置写。',
      parameters: {
        type: 'object',
        properties: {
          inputs: { type: 'array', items: { type: 'string' }, description: '要追加进来的图层名或路径数组。' },
          output: { type: 'string', description: '目标要素类路径。' },
          schemaType: { type: 'string', enum: ['TEST', 'NO_TEST'], description: '字段校验方式。' },
          map: { type: 'string', description: '限定地图（可选）。' },
        },
        required: ['inputs', 'output'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_data_append', args)
        return bridge.call('data.append', {
          inputs: args.inputs,
          output: args.output,
          schemaType: args.schemaType,
          map: args.map,
        })
      }),
    }),

    defineTool({
      name: 'arcgis_data_dissolve',
      description:
        '按字段融合要素。fields 不给则把所有要素合成一个。statistics 可传 {字段: 统计方式}，' +
        '例如 {"面积": "SUM"}。',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: '输入图层名或要素类路径。' },
          output: { type: 'string', description: '输出要素类路径。' },
          fields: { type: 'array', items: { type: 'string' }, description: '用于分组的字段。' },
          statistics: {
            type: 'object',
            description: '统计字段映射，例如 {"面积": "SUM"}。',
            additionalProperties: { type: 'string' },
          },
          multiPart: { type: 'boolean', description: '是否允许多部件要素，默认 true。' },
          map: { type: 'string', description: '限定地图（可选）。' },
        },
        required: ['input', 'output'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_data_dissolve', args)
        return bridge.call('data.dissolve', {
          input: args.input,
          output: args.output,
          fields: args.fields,
          statistics: args.statistics,
          multiPart: args.multiPart,
          map: args.map,
        })
      }),
    }),
  ]
}
