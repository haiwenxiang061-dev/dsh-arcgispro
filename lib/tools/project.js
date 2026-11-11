/**
 * 工程实体：.aprx、地图、图层、布局、视图相机。
 *
 * 这里改的都是内存中的 ArcGISProject。只有 arcgis_project_save 才写文件——
 * 模型可以反复试符号、试着调图层顺序，不确认就不落盘。
 */

import { defineTool, safe, requireWrite } from '../tool-kit.js'

export function projectTools(bridge) {
  return [
    defineTool({
      name: 'arcgis_project_open',
      description:
        '打开一个 .aprx 工程并设为当前工程。之后所有图层/布局操作默认作用于它。' +
        '工程可以带中文路径——桥侧全程 UTF-8。',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: '.aprx 文件的绝对路径。' },
        },
        required: ['project'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        if (!args.project) throw new Error('需要 project（.aprx 路径）。')
        return bridge.call('project.open', { project: args.project })
      }),
    }),

    defineTool({
      name: 'arcgis_project_info',
      description:
        '读工程骨架：地图列表、每个地图的图层名、布局列表、默认地理数据库与工具箱。' +
        '不传 project 就读当前已打开的工程。',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: '指定别的工程路径（可选）。' },
        },
        additionalProperties: false,
      },
      execute: safe(async (args) => bridge.call('project.info', { project: args.project ?? '' })),
    }),

    defineTool({
      name: 'arcgis_project_new',
      description:
        '从模板复制出一个新 .aprx。ArcGIS Pro 没有编程创建空工程的 API，' +
        '必须由已有工程复制；不给 template 就自动找 Pro 自带的空白模板。',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: '新工程的保存路径（.aprx）。' },
          template: { type: 'string', description: '模板 .aprx 路径（可选）。' },
        },
        required: ['project'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_project_new', args)
        if (!args.project) throw new Error('需要 project（新工程路径）。')
        return bridge.call('project.new', {
          project: args.project,
          template: args.template ?? '',
        })
      }),
    }),

    defineTool({
      name: 'arcgis_project_save',
      description:
        '把当前工程写回磁盘。传 as 则另存为新工程（当前会话转到新路径）。' +
        '这是唯一会让图层/符号改动生效的入口。',
      parameters: {
        type: 'object',
        properties: {
          as: { type: 'string', description: '另存为的路径（可选）。' },
          overwrite: { type: 'boolean', description: '另存目标已存在时是否覆盖。' },
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_project_save', args)
        return bridge.call('project.save', {
          as: args.as ?? '',
          overwrite: args.overwrite === true,
        })
      }),
    }),

    defineTool({
      name: 'arcgis_project_close',
      description: '关闭当前工程并释放它（未保存的改动会丢失）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: safe(async () => bridge.call('project.close', {})),
    }),

    defineTool({
      name: 'arcgis_map_info',
      description:
        '读一个地图的详情：坐标系、全部图层（含分组层级与可见性）、表、当前视图相机位置。',
      parameters: {
        type: 'object',
        properties: {
          map: { type: 'string', description: '地图名；留空取第一个。' },
          project: { type: 'string', description: '指定工程路径（可选）。' },
        },
        additionalProperties: false,
      },
      execute: safe(async (args) =>
        bridge.call('map.info', { map: args.map ?? '', project: args.project ?? '' }),
      ),
    }),

    defineTool({
      name: 'arcgis_map_add_data',
      description:
        '往地图加数据：要素类、shapefile、栅格、.lyrx 图层文件，或文件地理数据库内的数据集路径。' +
        '可以一次传多个。',
      parameters: {
        type: 'object',
        properties: {
          data: {
            description: '一个路径，或路径数组。',
            anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          },
          map: { type: 'string', description: '目标地图名（可选）。' },
        },
        required: ['data'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_map_add_data', args)
        return bridge.call('map.add_data', { data: args.data, map: args.map ?? '' })
      }),
    }),

    defineTool({
      name: 'arcgis_map_remove_layer',
      description: '从地图移除一个图层（只影响工程，不删数据源）。',
      parameters: {
        type: 'object',
        properties: {
          layer: { type: 'string', description: '图层名。' },
          map: { type: 'string', description: '地图名（可选）。' },
        },
        required: ['layer'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_map_remove_layer', args)
        if (!args.layer) throw new Error('需要 layer。')
        return bridge.call('map.remove_layer', { layer: args.layer, map: args.map ?? '' })
      }),
    }),

    defineTool({
      name: 'arcgis_map_export',
      description:
        '把地图视图导出成图片/PDF。位图格式（png/jpeg/bmp/gif）需要 width/height，' +
        '默认 1200×900；pdf/svg 不需要。',
      parameters: {
        type: 'object',
        properties: {
          output: { type: 'string', description: '输出文件路径，扩展名决定格式。' },
          map: { type: 'string', description: '地图名（可选）。' },
          width: { type: 'number', description: '像素宽（位图用）。' },
          height: { type: 'number', description: '像素高（位图用）。' },
          resolution: { type: 'number', description: 'DPI，默认 96。' },
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        required: ['output'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_map_export', args)
        if (!args.output) throw new Error('需要 output。')
        return bridge.call('map.export', {
          output: args.output,
          map: args.map ?? '',
          width: args.width,
          height: args.height,
          resolution: args.resolution,
        })
      }),
    }),

    defineTool({
      name: 'arcgis_camera_set',
      description:
        '移动地图视图。优先用 extent：给一个范围最可靠，设完立刻能读回，' +
        'arcgis_map_export 也真的按它出图。x/y/scale 在无窗口工程里赋值不报错但读不回' +
        '范围（getExtent 抛错），只在需要顺手挪一下时用。',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: '中心点 X。无窗口工程里改完读不回范围。' },
          y: { type: 'number', description: '中心点 Y。无窗口工程里改完读不回范围。' },
          scale: { type: 'number', description: '比例尺，如 50000。无窗口工程里 camera.scale 恒为 0。' },
          extent: {
            type: 'object',
            description: '直接给范围：{xMin,yMin,xMax,yMax}。给了它就忽略 x/y/scale，这是可靠的那条。',
            properties: {
              xMin: { type: 'number' },
              yMin: { type: 'number' },
              xMax: { type: 'number' },
              yMax: { type: 'number' },
            },
            required: ['xMin', 'yMin', 'xMax', 'yMax'],
            additionalProperties: false,
          },
          map: { type: 'string', description: '地图名（可选）。' },
        },
        additionalProperties: false,
      },
      execute: safe(async (args) =>
        bridge.call('camera.set', {
          x: args.x,
          y: args.y,
          scale: args.scale,
          extent: args.extent,
          map: args.map ?? '',
        }),
      ),
    }),

    defineTool({
      name: 'arcgis_layer_info',
      description:
        '读图层详情：数据源路径、坐标系、范围、字段列表、要素数、当前符号系统。' +
        '数据源丢失时会明确标 dataSourceMissing，而不是丢一个看不懂的 Describe 错误。',
      parameters: {
        type: 'object',
        properties: {
          layer: { type: 'string', description: '图层名。' },
          map: { type: 'string', description: '限定在某个地图里找（可选）。' },
        },
        required: ['layer'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        if (!args.layer) throw new Error('需要 layer。')
        return bridge.call('layer.info', { layer: args.layer, map: args.map ?? '' })
      }),
    }),

    defineTool({
      name: 'arcgis_layer_update',
      description:
        '改图层的开关性属性：可见性、名称、定义查询（相当于按条件过滤显示）、' +
        '透明度、是否标注。只改传入的字段，其余保持原样。',
      parameters: {
        type: 'object',
        properties: {
          layer: { type: 'string', description: '图层名。' },
          map: { type: 'string', description: '地图名（可选）。' },
          visible: { type: 'boolean' },
          name: { type: 'string', description: '改名。' },
          definitionQuery: { type: 'string', description: 'SQL 过滤条件；空串表示清除。' },
          transparency: { type: 'number', description: '0-100。' },
          showLabels: { type: 'boolean', description: '是否显示标注。' },
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        required: ['layer'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_layer_update', args)
        if (!args.layer) throw new Error('需要 layer。')
        const params = { layer: args.layer, map: args.map ?? '' }
        for (const key of ['visible', 'name', 'definitionQuery', 'transparency', 'showLabels']) {
          if (key in args) params[key] = args[key]
        }
        return bridge.call('layer.update', params)
      }),
    }),

    defineTool({
      name: 'arcgis_layer_symbology',
      description:
        '读或改图层符号系统。action=read 看当前渲染器；single 改单一符号颜色；' +
        'unique 按字段做唯一值；graduated 按字段分级设色。改完需要 project_save 落盘。',
      parameters: {
        type: 'object',
        properties: {
          layer: { type: 'string', description: '图层名。' },
          map: { type: 'string', description: '地图名（可选）。' },
          action: {
            type: 'string',
            enum: ['read', 'single', 'unique', 'graduated'],
            description: '默认 read。',
          },
          field: { type: 'string', description: 'unique / graduated 用的字段。' },
          color: {
            type: 'array',
            items: { type: 'number' },
            description: 'single 用：RGBA 0-255，如 [200,60,60,100]。',
          },
          breakCount: { type: 'number', description: 'graduated 用的分级数，默认 5。' },
          writeAllowed: { type: 'boolean', description: '改符号时必须为 true。' },
        },
        required: ['layer'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        if (!args.layer) throw new Error('需要 layer。')
        const action = String(args.action || 'read')
        if (action !== 'read') requireWrite('arcgis_layer_symbology', args)
        return bridge.call('layer.symbology', {
          layer: args.layer,
          map: args.map ?? '',
          action,
          field: args.field ?? '',
          color: args.color,
          breakCount: args.breakCount,
        })
      }),
    }),

    defineTool({
      name: 'arcgis_layout_list',
      description: '列出工程里所有布局及其页面尺寸。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: safe(async () => bridge.call('layout.list', {})),
    }),

    defineTool({
      name: 'arcgis_layout_info',
      description: '读布局详情：页面尺寸、元素清单（文本框/图例/比例尺/地图框）。',
      parameters: {
        type: 'object',
        properties: {
          layout: { type: 'string', description: '布局名；留空取第一个。' },
        },
        additionalProperties: false,
      },
      execute: safe(async (args) => bridge.call('layout.info', { layout: args.layout ?? '' })),
    }),

    defineTool({
      name: 'arcgis_layout_export',
      description:
        '导出布局为 pdf/png/jpeg/tiff/svg/ai/eps 等。这是出图的正式通道——' +
        '布局带图例、比例尺、指北针，跟地图视图导出不是一回事。',
      parameters: {
        type: 'object',
        properties: {
          output: { type: 'string', description: '输出路径，扩展名决定格式。' },
          layout: { type: 'string', description: '布局名（可选）。' },
          resolution: { type: 'number', description: 'DPI，矢量格式用 300 起步。' },
          imageQuality: { type: 'string', description: 'BEST / BETTER / NORMAL_JPEG 等。' },
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        required: ['output'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_layout_export', args)
        if (!args.output) throw new Error('需要 output。')
        return bridge.call('layout.export', {
          output: args.output,
          layout: args.layout ?? '',
          resolution: args.resolution,
          imageQuality: args.imageQuality,
        })
      }),
    }),

    defineTool({
      name: 'arcgis_project_broken_sources',
      description:
        '列出工程里数据源断链的图层。工程换机器、或从别人那拷来之后第一步就跑这个——' +
        '断链图层在导出时画不出来，但不会报错，只会悄悄变空白。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: safe(async () => bridge.call('project.broken_sources', {})),
    }),

    defineTool({
      name: 'arcgis_map_new',
      description:
        '在工程里新建一个空地图。mapType 用 Map（二维）或 Scene（三维）。' +
        'createMap 会顺手挂一张 Topographic 底图（要联网去 ArcGIS Online 取，离线或网络差时能卡一两分钟），' +
        '所以这里默认建完就把那张底图摘掉，得到一张干净的空白地图。' +
        '真想要底图就传 basemap（它会去联网，慢且可能失败）。' +
        '新地图只在内存里，要写回 .aprx 得调 arcgis_project_save。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '地图名；留空由 Pro 自动命名。' },
          mapType: { type: 'string', enum: ['Map', 'Scene'], description: '默认 Map。' },
          basemap: {
            type: 'string',
            description:
              '可选。新建后要挂的在线底图，例如 Topographic / Streets / Imagery。' +
              '不传就得到空白地图（推荐，快且离线可用）。',
          },
          dropDefaultBasemap: {
            type: 'boolean',
            description: '是否摘掉 createMap 自带的 Topographic 底图。默认 = 没传 basemap 时为 true。',
          },
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_map_new', args)
        return bridge.call('map.new', {
          name: args.name ?? '',
          mapType: args.mapType ?? 'Map',
          basemap: args.basemap ?? '',
          dropDefaultBasemap: args.dropDefaultBasemap,
        })
      }),
    }),

    defineTool({
      name: 'arcgis_map_add_basemap',
      description:
        '给地图挂一张在线底图（Topographic / Streets / Imagery 等）。' +
        '底图从 ArcGIS Online 拉瓦片，离线时会等很久再失败——所以它是单独一步，不会拖累新建地图。',
      parameters: {
        type: 'object',
        properties: {
          basemap: { type: 'string', description: '底图名，如 Topographic / Streets / Imagery / Dark Gray Canvas。' },
          map: { type: 'string', description: '地图名（可选，留空取第一个）。' },
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        required: ['basemap'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_map_add_basemap', args)
        return bridge.call('map.add_basemap', { basemap: args.basemap, map: args.map ?? '' })
      }),
    }),

    defineTool({
      name: 'arcgis_layout_new',
      description:
        '新建布局。页面尺寸按 units 指定的单位给——units 只接受单数形式' +
        '（INCH / MILLIMETER / CENTIMETER / POINT），写 INCHES 会被拒。' +
        '新布局只在内存里，要写回 .aprx 得调 arcgis_project_save。',
      parameters: {
        type: 'object',
        properties: {
          width: { type: 'number', description: '页面宽。' },
          height: { type: 'number', description: '页面高。' },
          units: {
            type: 'string',
            enum: ['INCH', 'MILLIMETER', 'CENTIMETER', 'POINT'],
            description: '页面单位，默认 MILLIMETER。',
          },
          name: { type: 'string', description: '布局名；留空自动命名。' },
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        required: ['width', 'height'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_layout_new', args)
        return bridge.call('layout.new', {
          width: args.width,
          height: args.height,
          units: args.units ?? 'MILLIMETER',
          name: args.name ?? '',
        })
      }),
    }),

    defineTool({
      name: 'arcgis_layout_page_size',
      description: '改已有布局的页面尺寸。units 留空则沿用布局当前单位。',
      parameters: {
        type: 'object',
        properties: {
          layout: { type: 'string', description: '布局名；留空取第一个。' },
          width: { type: 'number', description: '新页宽。' },
          height: { type: 'number', description: '新页高。' },
          units: {
            type: 'string',
            enum: ['INCH', 'MILLIMETER', 'CENTIMETER', 'POINT'],
            description: '页面单位，留空沿用当前单位。',
          },
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        required: ['width', 'height'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_layout_page_size', args)
        return bridge.call('layout.page_size', {
          layout: args.layout ?? '',
          width: args.width,
          height: args.height,
          units: args.units,
        })
      }),
    }),

    defineTool({
      name: 'arcgis_layout_add_frame',
      description:
        '往布局里放一个地图框。x/y/width/height 用页面单位（跟页面尺寸同一套单位）' +
        '定位。布局里没地图框就等于没有内容，新建的布局第一步就得放它。',
      parameters: {
        type: 'object',
        properties: {
          layout: { type: 'string', description: '布局名；留空取第一个。' },
          map: { type: 'string', description: '地图名；留空取第一个。' },
          x: { type: 'number', description: '左边界，默认 0.5。' },
          y: { type: 'number', description: '下边界，默认 0.5。' },
          width: { type: 'number', description: '宽，默认 6.0。' },
          height: { type: 'number', description: '高，默认 4.0。' },
          name: { type: 'string', description: '地图框名（可选）。' },
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_layout_add_frame', args)
        return bridge.call('layout.add_frame', {
          layout: args.layout ?? '',
          map: args.map ?? '',
          x: args.x,
          y: args.y,
          width: args.width,
          height: args.height,
          name: args.name ?? '',
        })
      }),
    }),

    defineTool({
      name: 'arcgis_layout_elements',
      description:
        '列出布局里的元素及位置尺寸。type 可过滤 MAPFRAME_ELEMENT / TEXT_ELEMENT / ' +
        'LEGEND_ELEMENT / MAPSURROUND_ELEMENT。改布局之前先用它看清有什么、叫什么名字。',
      parameters: {
        type: 'object',
        properties: {
          layout: { type: 'string', description: '布局名；留空取第一个。' },
          type: {
            type: 'string',
            description: '元素类型过滤，留空列出全部。',
          },
        },
        additionalProperties: false,
      },
      execute: safe(async (args) =>
        bridge.call('layout.elements', { layout: args.layout ?? '', type: args.type ?? '' }),
      ),
    }),

    defineTool({
      name: 'arcgis_layout_text_set',
      description:
        '改布局里某个文本元素的文字，按元素名精确定位。名字先用 arcgis_layout_elements 查；' +
        '找不到时会列出现有文本元素名。Pro 的 createTextElement 不接受 TEXT 类型，所以只能改不能新建。',
      parameters: {
        type: 'object',
        properties: {
          layout: { type: 'string', description: '布局名；留空取第一个。' },
          element: { type: 'string', description: '文本元素名。' },
          text: { type: 'string', description: '新的文字内容。' },
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        required: ['element', 'text'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_layout_text_set', args)
        return bridge.call('layout.text_set', {
          layout: args.layout ?? '',
          element: args.element,
          text: args.text,
        })
      }),
    }),

    defineTool({
      name: 'arcgis_mapseries_info',
      description:
        '读布局的地图系列状态：是否启用、类型、总页数、当前页、索引图层与页名字段。' +
        '没启用时返回 enabled: false，不报错。',
      parameters: {
        type: 'object',
        properties: {
          layout: { type: 'string', description: '布局名；留空取第一个。' },
        },
        additionalProperties: false,
      },
      execute: safe(async (args) => bridge.call('mapseries.info', { layout: args.layout ?? '' })),
    }),

    defineTool({
      name: 'arcgis_mapseries_create',
      description:
        '按索引图层建空间地图系列：索引图层每个要素生成一页。' +
        '需要布局里已有地图框（mapFrame 留空取第一个）。建完可用 arcgis_mapseries_export 批量出图。',
      parameters: {
        type: 'object',
        properties: {
          layout: { type: 'string', description: '布局名；留空取第一个。' },
          mapFrame: { type: 'string', description: '地图框名；留空取第一个。' },
          indexLayer: { type: 'string', description: '索引图层名（每要素一页）。' },
          nameField: { type: 'string', description: '页名字段。' },
          sortField: { type: 'string', description: '排序字段（可选）。' },
          map: { type: 'string', description: '索引图层所在地图名（可选）。' },
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        required: ['indexLayer', 'nameField'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_mapseries_create', args)
        return bridge.call('mapseries.create', {
          layout: args.layout ?? '',
          mapFrame: args.mapFrame ?? '',
          indexLayer: args.indexLayer,
          nameField: args.nameField,
          sortField: args.sortField ?? '',
          map: args.map ?? '',
        })
      }),
    }),

    defineTool({
      name: 'arcgis_mapseries_export',
      description:
        '逐页导出地图系列。output 是模板路径，页号用 {page} 占位，' +
        '例如 D:/out/page_{page}.pdf。格式由扩展名决定，目录不存在会自动建。',
      parameters: {
        type: 'object',
        properties: {
          layout: { type: 'string', description: '布局名；留空取第一个。' },
          output: { type: 'string', description: '输出模板路径，含 {page} 占位。' },
          resolution: { type: 'number', description: 'DPI（位图/PDF 用）。' },
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        required: ['output'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_mapseries_export', args)
        return bridge.call('mapseries.export', {
          layout: args.layout ?? '',
          output: args.output,
          resolution: args.resolution,
        })
      }),
    }),
  ]
}
