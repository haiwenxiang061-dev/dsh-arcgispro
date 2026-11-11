/**
 * 图层级与地图级的细操作：底图清单、图层加删移分组、标注、书签、表、样式、报表。
 *
 * 这批全部落在 arcpy.mp 上——GP 层没有对应工具。名字统一用 arcgis_layer_* /
 * arcgis_map_* / arcgis_bookmark_* / arcgis_label_* / arcgis_table_*，跟已有的
 * 工程类工具不冲突。
 */
import { defineTool, safe, requireWrite } from '../tool-kit.js'

/**
 * @param {{ call: (op: string, args?: object) => Promise<any> }} bridge
 */
export function layerTools(bridge) {
  const mapArg = { type: 'string', description: '地图名（可选，留空取第一个）。' }

  return [
    defineTool({
      name: 'arcgis_basemap_list',
      description:
        '列出这个工程可用的底图名。不同机器拿到的集合不一样（装了天地图插件的工程给「天地图-地形（CGCS2000）」这类中文名，' +
        '纯在线环境给 Topographic/Streets）。加底图之前先查一次，别凭记忆写名字。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: safe(async () => bridge.call('basemap.list', {})),
    }),

    defineTool({
      name: 'arcgis_layer_add',
      description:
        '把一个 .lyrx 图层文件加进地图。符号、定义查询、标注都随文件带来。' +
        '加数据集本身用 arcgis_map_add_data；这个是加"已经调好的图层"。',
      parameters: {
        type: 'object',
        properties: {
          lyrx: { type: 'string', description: '.lyrx 图层文件路径。' },
          map: mapArg,
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        required: ['lyrx'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_layer_add', args)
        return bridge.call('layer.add', { lyrx: args.lyrx, map: args.map ?? '' })
      }),
    }),

    defineTool({
      name: 'arcgis_layer_move',
      description:
        '调整图层在内容列表里的顺序：给 referenceLayer 就挪到它前面/后面，不给就挪到最上层。' +
        '绘制顺序就是列表顺序，压盖关系靠这个调。',
      parameters: {
        type: 'object',
        properties: {
          layer: { type: 'string', description: '要移动的图层名。' },
          referenceLayer: { type: 'string', description: '参照图层名（可选）。' },
          position: { type: 'string', enum: ['before', 'after'], description: '默认 before。' },
          map: mapArg,
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        required: ['layer'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_layer_move', args)
        return bridge.call('layer.move', {
          layer: args.layer,
          referenceLayer: args.referenceLayer ?? '',
          position: args.position ?? 'before',
          map: args.map ?? '',
        })
      }),
    }),

    defineTool({
      name: 'arcgis_layer_group',
      description:
        '新建分组图层，并可选地把若干已有图层挪进去。' +
        '注意实测：无窗口工程里 Pro 的 addLayerToGroup / insertLayer 都不生效（返回成功但组内是空的），' +
        '所以这条只保证分组建出来；返回 membered:false 时别当成失败——要成员得在 Pro 窗口里拖。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '分组名。' },
          layers: {
            type: 'array',
            items: { type: 'string' },
            description: '要放进分组的图层名（可选）。',
          },
          map: mapArg,
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_layer_group', args)
        return bridge.call('layer.group', {
          name: args.name,
          layers: args.layers ?? [],
          map: args.map ?? '',
        })
      }),
    }),

    defineTool({
      name: 'arcgis_layer_toggle',
      description:
        '一次开关多个图层的可见性。图层多的时候比一个个 arcgis_layer_update 快，也不会漏。',
      parameters: {
        type: 'object',
        properties: {
          layers: { type: 'array', items: { type: 'string' }, description: '图层名数组。' },
          visible: { type: 'boolean', description: '默认 true（显示）。' },
          map: mapArg,
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        required: ['layers'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_layer_toggle', args)
        return bridge.call('layer.toggle', {
          layers: args.layers,
          visible: args.visible ?? true,
          map: args.map ?? '',
        })
      }),
    }),

    defineTool({
      name: 'arcgis_layer_export',
      description:
        '把图层存成 .lyrx 图层文件——符号、定义查询、标注配置一起带走，换工程可以直接 arcgis_layer_add。' +
        '"这套符号调好了，以后都这么画"就该存成 lyrx。',
      parameters: {
        type: 'object',
        properties: {
          layer: { type: 'string', description: '图层名。' },
          output: { type: 'string', description: '输出 .lyrx 路径。' },
          map: mapArg,
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        required: ['layer', 'output'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_layer_export', args)
        return bridge.call('layer.export', {
          layer: args.layer,
          output: args.output,
          map: args.map ?? '',
        })
      }),
    }),

    defineTool({
      name: 'arcgis_table_list',
      description: '列出地图里的独立表（没有几何、只当图表用的那种）。独立的表在这里，要素类的属性表用 arcgis_layer_info 看。',
      parameters: {
        type: 'object',
        properties: { map: mapArg },
        additionalProperties: false,
      },
      execute: safe(async (args) => bridge.call('table.list', { map: args.map ?? '' })),
    }),

    defineTool({
      name: 'arcgis_table_add',
      description: '往地图里加一张表。加了之后布局里能放表框，也能当连接源。',
      parameters: {
        type: 'object',
        properties: {
          data: { type: 'string', description: '表路径（gdb 内路径也算）。' },
          map: mapArg,
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        required: ['data'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_table_add', args)
        return bridge.call('table.add', { data: args.data, map: args.map ?? '' })
      }),
    }),

    defineTool({
      name: 'arcgis_label_info',
      description:
        '读图层的标注状态：支持不支持标注、开没开、有几个标注类、每个类的表达式与过滤条件。',
      parameters: {
        type: 'object',
        properties: {
          layer: { type: 'string', description: '图层名。' },
          map: mapArg,
        },
        required: ['layer'],
        additionalProperties: false,
      },
      execute: safe(async (args) =>
        bridge.call('label.info', { layer: args.layer, map: args.map ?? '' })),
    }),

    defineTool({
      name: 'arcgis_label_set',
      description:
        '开关标注、换标注字段、给标注加 SQL 过滤。' +
        '表达式的写法是 Arcade：`$feature.名称`，或者拼接 `$feature.名称 + "（" + $feature.人口 + "人"）`。' +
        '注意字体/字号/偏移不在这层（LabelClass 只有 6 个成员），这里只管"标什么、开不开"。',
      parameters: {
        type: 'object',
        properties: {
          layer: { type: 'string', description: '图层名。' },
          visible: { type: 'boolean', description: '是否显示标注（图层级）。' },
          labelClass: { type: 'string', description: '只改指定标注类（可选，留空改全部）。' },
          expression: { type: 'string', description: '标注表达式（Arcade）。' },
          where: { type: 'string', description: '标注的 SQL 过滤条件。' },
          labelVisible: { type: 'boolean', description: '标注类自身的可见性。' },
          map: mapArg,
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        required: ['layer'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_label_set', args)
        return bridge.call('label.set', {
          layer: args.layer,
          visible: args.visible,
          labelClass: args.labelClass ?? '',
          expression: args.expression,
          where: args.where,
          labelVisible: args.labelVisible,
          map: args.map ?? '',
        })
      }),
    }),

    defineTool({
      name: 'arcgis_bookmark_list',
      description: '列出地图里的书签（存好的视图范围）。',
      parameters: { type: 'object', properties: { map: mapArg }, additionalProperties: false },
      execute: safe(async (args) => bridge.call('bookmark.list', { map: args.map ?? '' })),
    }),

    defineTool({
      name: 'arcgis_bookmark_create',
      description:
        '把当前视图存成书签。注意无窗口工程里 Map 没有 createBookmark，这条会明确报错——' +
        '那种情况用 arcgis_bookmark_import 导入现成的书签 json。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '书签名。' },
          map: mapArg,
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_bookmark_create', args)
        return bridge.call('bookmark.create', { name: args.name, map: args.map ?? '' })
      }),
    }),

    defineTool({
      name: 'arcgis_bookmark_remove',
      description: '删一个书签。名字写错时会列出当前已有的书签名，照着挑一个。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '书签名。' },
          map: mapArg,
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_bookmark_remove', args)
        return bridge.call('bookmark.remove', { name: args.name, map: args.map ?? '' })
      }),
    }),

    defineTool({
      name: 'arcgis_bookmark_export',
      description: '把地图的全部书签导出成 json（换工程/给同事复用）。',
      parameters: {
        type: 'object',
        properties: {
          output: { type: 'string', description: '输出 .json 路径。' },
          map: mapArg,
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        required: ['output'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_bookmark_export', args)
        return bridge.call('bookmark.export', { output: args.output, map: args.map ?? '' })
      }),
    }),

    defineTool({
      name: 'arcgis_bookmark_import',
      description: '从 json 导入书签。',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: '书签 json 路径。' },
          map: mapArg,
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        required: ['input'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_bookmark_import', args)
        return bridge.call('bookmark.import', { input: args.input, map: args.map ?? '' })
      }),
    }),

    defineTool({
      name: 'arcgis_style_list',
      description: '列出工程挂着的样式库（ArcGIS 2D / ColorBrewer 之类）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: safe(async () => bridge.call('style.list', {})),
    }),

    defineTool({
      name: 'arcgis_colorramp_list',
      description:
        '列色带名（这张机器上 512 个）。做唯一值/分级符号时先查名字，再拿去 arcgis_layer_symbology。' +
        '可以用 search 过滤，例如 search: "红" 或 search: "Brewer"。',
      parameters: {
        type: 'object',
        properties: { search: { type: 'string', description: '名字片段过滤（可选）。' } },
        additionalProperties: false,
      },
      execute: safe(async (args) => bridge.call('colorramp.list', { search: args.search ?? '' })),
    }),

    defineTool({
      name: 'arcgis_layer_symbology_apply',
      description:
        '用 .lyrx 图层文件当样板，把符号系统套到目标图层上（GP 的 ApplySymbologyFromLayer）。' +
        '样板和目标几何类型要一致：拿点符号套面图层会失败。',
      parameters: {
        type: 'object',
        properties: {
          layer: { type: 'string', description: '目标图层名。' },
          symbologyLayer: { type: 'string', description: '样板 .lyrx 路径。' },
          map: mapArg,
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        required: ['layer', 'symbologyLayer'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_layer_symbology_apply', args)
        return bridge.call('layer.symbology_apply', {
          layer: args.layer,
          symbologyLayer: args.symbologyLayer,
          map: args.map ?? '',
        })
      }),
    }),

    defineTool({
      name: 'arcgis_report_list',
      description: '列出工程里的报表（Pro 的 Report 功能做的那种）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: safe(async () => bridge.call('report.list', {})),
    }),

    defineTool({
      name: 'arcgis_map_definition',
      description:
        '读地图的 CIM 定义。Pro 没在 arcpy.mp 上暴露的设置（标注引擎细节、自定义渲染）都藏在这里。' +
        '默认只返回顶层键名，要全文传 full: true——定义可能有上万个键。',
      parameters: {
        type: 'object',
        properties: {
          map: mapArg,
          full: { type: 'boolean', description: '是否返回完整定义（很大会截断）。' },
        },
        additionalProperties: false,
      },
      execute: safe(async (args) =>
        bridge.call('map.definition', { map: args.map ?? '', full: args.full === true })),
    }),

    defineTool({
      name: 'arcgis_map_color_model',
      description: '读或改地图色彩模式。出印刷品用 CMYK，屏幕看用 RGB。不传 colorModel 就是读。',
      parameters: {
        type: 'object',
        properties: {
          colorModel: { type: 'string', enum: ['RGB', 'CMYK'], description: '要设的模式；留空只读。' },
          map: mapArg,
          writeAllowed: { type: 'boolean', description: '改的时候必须为 true。' },
        },
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        if (args.colorModel) requireWrite('arcgis_map_color_model', args)
        return bridge.call('map.color_model', { colorModel: args.colorModel, map: args.map ?? '' })
      }),
    }),

    defineTool({
      name: 'arcgis_map_reference_scale',
      description:
        '读或改参考比例尺。符号大小、标注密度都以这个比例尺为基准——定下来图在不同缩放下的观感才一致。' +
        '不传 scale 就是读。',
      parameters: {
        type: 'object',
        properties: {
          scale: { type: 'number', description: '参考比例尺，例如 50000；留空只读。' },
          map: mapArg,
          writeAllowed: { type: 'boolean', description: '改的时候必须为 true。' },
        },
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        if (args.scale !== undefined) requireWrite('arcgis_map_reference_scale', args)
        return bridge.call('map.reference_scale', { scale: args.scale, map: args.map ?? '' })
      }),
    }),
  ]
}
