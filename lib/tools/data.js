/**
 * 数据层：要素类 / 表 / 栅格 / 地理数据库。
 *
 * 读的接口尽量宽松（自动找字段、大小写兜底），写的接口尽量严格
 * （删行必须显式 allowAll，改字段必须字段存在）。
 */

import { defineTool, safe, requireWrite } from '../tool-kit.js'

export function dataTools(bridge) {
  return [
    defineTool({
      name: 'arcgis_data_describe',
      description:
        '描述任意数据集：类型、几何类型、范围、坐标系、字段、要素数、索引。' +
        '要素类、shapefile、表、栅格都能喂进来。',
      parameters: {
        type: 'object',
        properties: {
          dataset: {
            type: 'string',
            description: '数据集路径，如 F:/my.gdb/roads 或 F:/data/pts.shp。',
          },
        },
        required: ['dataset'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        if (!args.dataset) throw new Error('需要 dataset。')
        return bridge.call('data.describe', { dataset: args.dataset })
      }),
    }),

    defineTool({
      name: 'arcgis_data_list',
      description:
        '列出一个工作空间（文件夹或 .gdb）里的要素类、栅格、表、数据集。' +
        '不传 workspace 就用当前 GP 环境的工作空间。',
      parameters: {
        type: 'object',
        properties: {
          workspace: { type: 'string', description: '文件夹或 .gdb 路径。' },
          wildcard: { type: 'string', description: '名称通配符，默认 *。' },
        },
        additionalProperties: false,
      },
      execute: safe(async (args) =>
        bridge.call('data.list', { workspace: args.workspace ?? '', wildcard: args.wildcard ?? '*' }),
      ),
    }),

    defineTool({
      name: 'arcgis_data_fields',
      description: '只取字段 schema（比 describe 轻）：字段名、类型、长度、别名、可否为空。',
      parameters: {
        type: 'object',
        properties: {
          dataset: { type: 'string', description: '数据集路径。' },
        },
        required: ['dataset'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        if (!args.dataset) throw new Error('需要 dataset。')
        return bridge.call('data.fields', { dataset: args.dataset })
      }),
    }),

    defineTool({
      name: 'arcgis_data_query',
      description:
        '按 SQL 条件读要素/表的行。rows 是数组的数组，内层顺序与 fields 一致；' +
        '几何字段被转成 {wkt, type, area, length}。limit 默认 100、上限 10000，' +
        'truncated 为 true 说明还有更多行，用 offset 接着取。',
      parameters: {
        type: 'object',
        properties: {
          dataset: { type: 'string', description: '数据集路径。' },
          where: {
            type: 'string',
            description:
              'SQL 条件，如 "POP > 10000" 或 "NAME = \'上海\'"。留空读全部。',
          },
          fields: {
            description: '字段名数组；留空读全部字段。',
            anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          },
          limit: { type: 'number', description: '最多返回行数，默认 100。' },
          offset: { type: 'number', description: '跳过前 N 行。' },
          spatialReference: {
            description: '输出坐标系，如 "EPSG:4326"；几何会被投影到这个坐标系。',
          },
        },
        required: ['dataset'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        if (!args.dataset) throw new Error('需要 dataset。')
        return bridge.call('data.query', {
          dataset: args.dataset,
          where: args.where ?? '',
          fields: args.fields,
          limit: args.limit ?? 100,
          offset: args.offset ?? 0,
          spatialReference: args.spatialReference,
        })
      }),
    }),

    defineTool({
      name: 'arcgis_data_statistics',
      description: '对某个数值字段直接算 min/max/mean/median/count，不落表。',
      parameters: {
        type: 'object',
        properties: {
          dataset: { type: 'string', description: '数据集路径。' },
          field: { type: 'string', description: '数值字段名。' },
        },
        required: ['dataset', 'field'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        if (!args.dataset || !args.field) throw new Error('需要 dataset 和 field。')
        return bridge.call('data.statistics', { dataset: args.dataset, field: args.field })
      }),
    }),

    defineTool({
      name: 'arcgis_data_insert',
      description:
        '批量插入行。rows 可以是对象数组（键＝字段名），也可以是数组的数组配合 fields。' +
        '几何字段接受 WKT 字符串或 GeoJSON。',
      parameters: {
        type: 'object',
        properties: {
          dataset: { type: 'string', description: '目标要素类/表。' },
          rows: {
            type: 'array',
            description: '行数据：[{字段:值}] 或 [[值,值]]。',
            items: {},
          },
          fields: {
            type: 'array',
            items: { type: 'string' },
            description: 'rows 用数组形式时的字段顺序。',
          },
          spatialReference: { description: '几何的坐标系（可选）。' },
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        required: ['dataset', 'rows'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_data_insert', args)
        if (!args.dataset) throw new Error('需要 dataset。')
        return bridge.call('data.insert', {
          dataset: args.dataset,
          rows: args.rows,
          fields: args.fields,
          spatialReference: args.spatialReference,
        })
      }),
    }),

    defineTool({
      name: 'arcgis_data_update',
      description:
        '按条件批量改字段值。changes 是 {字段: 新值}；所有匹配 where 的行都会被改成同一组值。' +
        '要按行算值请用 arcgis_data_calculate_field。',
      parameters: {
        type: 'object',
        properties: {
          dataset: { type: 'string', description: '目标数据集。' },
          where: { type: 'string', description: 'SQL 条件；留空作用于全部行。' },
          changes: {
            type: 'object',
            description: '要改的字段与新值。',
            additionalProperties: true,
          },
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        required: ['dataset', 'changes'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_data_update', args)
        if (!args.dataset) throw new Error('需要 dataset。')
        return bridge.call('data.update', {
          dataset: args.dataset,
          where: args.where ?? '',
          changes: args.changes,
        })
      }),
    }),

    defineTool({
      name: 'arcgis_data_delete',
      description:
        '按条件删除行。where 为空时必须显式传 allowAll: true 才会清空整表——' +
        '这一步是故意拦的，误删要素类内容不可撤销。',
      parameters: {
        type: 'object',
        properties: {
          dataset: { type: 'string', description: '目标数据集。' },
          where: { type: 'string', description: 'SQL 条件。' },
          allowAll: { type: 'boolean', description: '确认要删除全部行。' },
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        required: ['dataset'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_data_delete', args)
        if (!args.dataset) throw new Error('需要 dataset。')
        return bridge.call('data.delete', {
          dataset: args.dataset,
          where: args.where ?? '',
          allowAll: args.allowAll === true,
        })
      }),
    }),

    defineTool({
      name: 'arcgis_data_calculate_field',
      description:
        '用 Python 表达式计算字段（GP 的 CalculateField）。表达式里用 !字段名! 引用其他字段，' +
        '例如 "!area! / 1000000"。',
      parameters: {
        type: 'object',
        properties: {
          dataset: { type: 'string', description: '目标数据集。' },
          field: { type: 'string', description: '要写入的字段。' },
          expression: {
            type: 'string',
            description: 'Python 表达式，如 "!SHAPE.area@SQUAREKILOMETERS!" 或 "1"。',
          },
          expressionType: {
            type: 'string',
            enum: ['PYTHON3', 'ARCADE', 'SQL'],
            description: '默认 PYTHON3。',
          },
          where: { type: 'string', description: '只对符合条件的行计算（可选）。' },
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        required: ['dataset', 'field', 'expression'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_data_calculate_field', args)
        if (!args.dataset || !args.field || !args.expression) {
          throw new Error('需要 dataset、field、expression。')
        }
        return bridge.call('data.calculate_field', {
          dataset: args.dataset,
          field: args.field,
          expression: args.expression,
          expressionType: args.expressionType ?? 'PYTHON3',
          where: args.where ?? '',
        })
      }),
    }),

    defineTool({
      name: 'arcgis_data_create_featureclass',
      description:
        '新建要素类，可同时建字段。outPath 是所在工作空间（文件夹或 .gdb），name 是要素类名。' +
        'geometryType 支持 point / polyline / polygon / multipoint。',
      parameters: {
        type: 'object',
        properties: {
          outPath: { type: 'string', description: '输出工作空间（文件夹或 .gdb）。' },
          name: { type: 'string', description: '要素类名。' },
          geometryType: {
            type: 'string',
            enum: ['point', 'polyline', 'polygon', 'multipoint'],
            description: '默认 point。',
          },
          spatialReference: { description: '坐标系，如 "EPSG:4326" 或 4326。' },
          fields: {
            type: 'array',
            description: '字段定义：[{name,type,length?,alias?}]。type 用 text/long/double/date/short/float。',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                type: { type: 'string' },
                length: { type: 'number' },
                alias: { type: 'string' },
              },
              required: ['name', 'type'],
              additionalProperties: false,
            },
          },
          hasZ: { type: 'boolean' },
          hasM: { type: 'boolean' },
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        required: ['outPath', 'name'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_data_create_featureclass', args)
        if (!args.outPath || !args.name) throw new Error('需要 outPath 和 name。')
        return bridge.call('data.create_featureclass', {
          outPath: args.outPath,
          name: args.name,
          geometryType: args.geometryType ?? 'point',
          spatialReference: args.spatialReference,
          fields: args.fields ?? [],
          hasZ: args.hasZ === true,
          hasM: args.hasM === true,
        })
      }),
    }),

    defineTool({
      name: 'arcgis_data_create_gdb',
      description: '在某个文件夹里新建一个文件地理数据库（.gdb）。',
      parameters: {
        type: 'object',
        properties: {
          outFolder: { type: 'string', description: '放 .gdb 的文件夹。' },
          name: { type: 'string', description: '地理数据库名（可不带 .gdb）。' },
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        required: ['outFolder', 'name'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_data_create_gdb', args)
        if (!args.outFolder || !args.name) throw new Error('需要 outFolder 和 name。')
        return bridge.call('data.create_gdb', { outFolder: args.outFolder, name: args.name })
      }),
    }),

    defineTool({
      name: 'arcgis_data_add_field',
      description:
        '给已有要素类/表加一个字段。text 类型要给 length，其余类型不需要。' +
        '地理数据库里加字段后已有行为空值，要填就接着用 calculate_field。',
      parameters: {
        type: 'object',
        properties: {
          dataset: { type: 'string', description: '数据集路径。' },
          name: { type: 'string', description: '字段名。' },
          type: {
            type: 'string',
            enum: ['text', 'long', 'short', 'double', 'float', 'date', 'blob', 'guid', 'bigint', 'oid'],
            description: '字段类型。',
          },
          length: { type: 'number', description: '文本字段长度。' },
          alias: { type: 'string', description: '字段别名。' },
          nullable: { type: 'boolean', description: '是否允许空值，默认 true。' },
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        required: ['dataset', 'name', 'type'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_data_add_field', args)
        if (!args.dataset || !args.name || !args.type) {
          throw new Error('需要 dataset、name、type。')
        }
        return bridge.call('data.add_field', {
          dataset: args.dataset,
          name: args.name,
          type: args.type,
          length: args.length,
          alias: args.alias,
          nullable: args.nullable,
        })
      }),
    }),

    defineTool({
      name: 'arcgis_data_delete_field',
      description: '删除字段——字段里的数据一起没了，不可撤销。没有专用的兜底参数。',
      parameters: {
        type: 'object',
        properties: {
          dataset: { type: 'string', description: '数据集路径。' },
          name: { type: 'string', description: '字段名。' },
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        required: ['dataset', 'name'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_data_delete_field', args)
        if (!args.dataset || !args.name) throw new Error('需要 dataset 和 name。')
        return bridge.call('data.delete_field', { dataset: args.dataset, name: args.name })
      }),
    }),

    defineTool({
      name: 'arcgis_data_copy',
      description:
        '复制要素类或表到新位置。kind 为 features 走 CopyFeatures（要素），为 table 走 Copy（表）。' +
        '跨工作空间搬数据、或想留一份不动版原数据时用它。',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: '源要素类/表路径。' },
          outPath: { type: 'string', description: '输出路径。' },
          kind: { type: 'string', enum: ['features', 'table'], description: '复制类型，默认 features。' },
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        required: ['source', 'outPath'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_data_copy', args)
        if (!args.source || !args.outPath) throw new Error('需要 source 和 outPath。')
        return bridge.call('data.copy', {
          source: args.source,
          outPath: args.outPath,
          kind: args.kind ?? 'features',
        })
      }),
    }),

    defineTool({
      name: 'arcgis_data_create_table',
      description:
        '在 gdb 里建一张只有属性、没有几何的表，可同时建字段。' +
        '字段 type 用 text/long/double/date/short/float/smallinteger/biginteger。',
      parameters: {
        type: 'object',
        properties: {
          outPath: { type: 'string', description: '所在工作空间（.gdb 路径）。' },
          name: { type: 'string', description: '表名。' },
          fields: {
            type: 'array',
            description: '字段定义数组：[{name,type,length?,alias?}]。',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                type: { type: 'string' },
                length: { type: 'number' },
                alias: { type: 'string' },
              },
              required: ['name', 'type'],
              additionalProperties: false,
            },
          },
          writeAllowed: { type: 'boolean', description: '必须为 true。' },
        },
        required: ['outPath', 'name'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        requireWrite('arcgis_data_create_table', args)
        if (!args.outPath || !args.name) throw new Error('需要 outPath 和 name。')
        return bridge.call('data.create_table', {
          outPath: args.outPath,
          name: args.name,
          fields: args.fields ?? [],
        })
      }),
    }),

    defineTool({
      name: 'arcgis_raster_info',
      description:
        '读栅格详情：波段数、像元类型、像元大小、NoData、各波段统计（min/max/mean/std）、范围。',
      parameters: {
        type: 'object',
        properties: {
          dataset: { type: 'string', description: '栅格路径（.tif、栅格数据集等）。' },
        },
        required: ['dataset'],
        additionalProperties: false,
      },
      execute: safe(async (args) => {
        if (!args.dataset) throw new Error('需要 dataset。')
        return bridge.call('raster.info', { dataset: args.dataset })
      }),
    }),
  ]
}
