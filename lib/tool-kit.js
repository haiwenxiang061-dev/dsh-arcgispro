/**
 * 工具定义与写盘闸门。
 *
 * 宿主要求每个工具带 `output.render`（把结果转成一段消息），缺了会在注册时
 * 被拒。这里统一收口，业务工具只写 name/description/parameters/execute。
 */

/** 会改磁盘的 op；工具层要用 writeAllowed 放行。 */
export const WRITE_TOOLS = new Set([
  'arcgis_project_new',
  'arcgis_project_save',
  'arcgis_map_add_data',
  'arcgis_map_remove_layer',
  'arcgis_map_export',
  'arcgis_layer_update',
  'arcgis_layer_symbology',
  'arcgis_layout_export',
  'arcgis_data_insert',
  'arcgis_data_update',
  'arcgis_data_delete',
  'arcgis_data_calculate_field',
  'arcgis_data_create_featureclass',
  'arcgis_data_create_gdb',
  'arcgis_data_add_field',
  'arcgis_data_delete_field',
  'arcgis_data_copy',
  'arcgis_data_create_table',
  'arcgis_data_merge',
  'arcgis_data_append',
  'arcgis_data_dissolve',
  'arcgis_reproject',
  'arcgis_define_projection',
  'arcgis_convert_data',
  'arcgis_raster_resample',
  'arcgis_raster_clip',
  'arcgis_raster_mosaic',
  'arcgis_raster_calculator',
  'arcgis_raster_extract_mask',
  'arcgis_raster_surface',
  'arcgis_map_new',
  'arcgis_map_add_basemap',
  'arcgis_layout_new',
  'arcgis_layout_page_size',
  'arcgis_layout_add_frame',
  'arcgis_layout_text_set',
  'arcgis_mapseries_create',
  'arcgis_mapseries_export',
])

/**
 * 写盘闸门。
 *
 * 不做"自动允许"：模型必须显式传 writeAllowed: true 才会落笔。这不是不信任，
 * 而是让"改用户的工程 / 删用户的字段"这两个动作在参数里留下痕迹——事后翻
 * 对话记录能看清谁在什么时候要求写盘。
 */
export function requireWrite(name, args) {
  if (args?.writeAllowed === true) return
  const error = new Error(
    `${name} 会改动磁盘（写工程、改数据、删字段或导出文件），需要 writeAllowed: true。` +
      '确认目标无误后重试。',
  )
  error.name = 'WriteNotAllowed'
  error.code = 'WRITE_NOT_ALLOWED'
  throw error
}

/**
 * 定义一个宿主工具。
 *
 * `summary` 不是工具字段，只用来在这里生成一句短描述，避免每个定义都重复
 * 写 "…返回 JSON。" 之类的尾巴。
 */
export function defineTool({ name, description, parameters, execute }) {
  return {
    name,
    description,
    parameters,
    async execute(args) {
      const value = await execute(args ?? {})
      return value
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        if (typeof value === 'string') return [{ type: 'text', text: value }]
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    // arcpy 在单进程里共享 env / 许可 / 消息缓冲，并行调用只会互相踩。
    isConcurrencySafe: () => false,
  }
}

/** 把 arcpy 抛上来的错误转成模型能照着改的一句话。 */
export function formatError(error) {
  if (error && typeof error.toText === 'function') return error.toText()
  if (error instanceof Error) return error.message
  return String(error)
}

/** 包一层：吞掉异常，转成 {ok:false, error} —— 工具不该因为一次失败就炸掉整轮。 */
export function safe(handler) {
  return async (args) => {
    try {
      const result = await handler(args)
      return result
    } catch (error) {
      return {
        ok: false,
        error: formatError(error),
        code: error?.code ?? error?.type ?? error?.name ?? 'ERROR',
      }
    }
  }
}
