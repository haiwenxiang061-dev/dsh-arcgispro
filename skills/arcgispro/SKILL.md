---
name: arcgispro
description: 用 arcpy 直接操作 ArcGIS Pro：跑任意地理处理工具、读写工程/地图/图层/布局、查改要素类与栅格。
whenToUse: 用户提到 ArcGIS Pro、arcpy、.aprx 工程、.gdb 地理数据库、shapefile、要素类、栅格、布局出图、Buffer/Clip/Intersect 等 GP 工具，或要让 DSH 去动本机 GIS 数据时。
---

# 控制 ArcGIS Pro

这套工具背后是一个常驻的 `arcgispro-py3` Python 进程，通过 `arcpy` 干活。不要假设装了 `arcgis` 包（那个是 Pro 之外的 Python API），这里走的是 Pro 自带环境。

## 先探路，别硬猜

第一次真要动 Pro 时先 `arcgis_status`。它会告诉你 Python 版本、arcpy 版本、许可级别、当前工程。**第一次调用要等 8–21 秒**，那正是 `import arcpy` 的成本（实测冷启动 20.6s、warm 7.2s）；之后每次调用都在 5–40 毫秒量级。不要因为慢就重复调用，桥只在第一次拉起。

许可不够时，GP 工具会以 `ERROR 000824` 之类的形式失败。先 `arcgis_license` 看扩展模块，缺了就 `action: "checkout"`。

## GP 工具的两件事

**名字有三种写法，都认**：`analysis.Buffer`（信箱.工具名）、`Buffer_analysis`（别名形式）、`Buffer`（裸名，仅在全局唯一时可用）。不确定就直接用 `arcgis_tool_list` 搜：`search: "buffer"`。

**参数必须先查。** 1977 个工具，参数名不能凭记忆写。流程永远是：

```
arcgis_tool_info({ tool: "analysis.Buffer" })
```

返回的每个参数带 `name`（这是 `arcgis_tool_run` 里 `parameters` 要用的键）、`datatype`、`direction`（Input/Output）、`parameterType`（Required/Optional）、`filter.list`（可选值，中文）、`enabled`（条件参数是否生效）。注意 `enabled: false` 的参数是当前条件下不生效的——比如 `Buffer` 的 `line_side` 只在 `line_end_type` 选了特定值时才起作用。

然后：

```
arcgis_tool_run({
  tool: "analysis.Buffer",
  params: { in_features: "...", out_feature_class: "...", buffer_distance_or_field: "500 Meters" }
})
```

也可以按位置传（`args: [in, out, ...]`，顺序与 `arcgis_tool_info` 里 `inputs` 的 `index` 一致），但 `args` 与 `params` **只能给一个**。工具参数多时按名字传更稳；位置传适合参数少、顺序无歧义的（如 `CopyFeatures` 的 `[in_features, out_feature_class]`）。

输出参数（`direction: "Output"`）**不用传**，`arcpy` 会返回；但如果你要指定落盘路径，也可以显式给它。返回里有 `outputs`、`messages`、`outputPaths`（每个输出是不是真的落地了），失败时 `ok: false` 并附 GP 消息全文。输出指向还不存在的文件夹或 `.gdb` 时桥会自动建好（gdb 走 `CreateFileGDB`），不用先建库。

距离和字段值要带单位：`"500 Meters"`、`"10 Kilometers"`，光写 `500` 会被按输入数据的坐标系单位解释。

## 兜底：直接跑 arcpy 代码

GP 工具通道覆盖 1977 个工具，但覆盖不了 Python 层的东西——`arcpy.da` 的游标、`arcpy.metadata`、CIM 深度定制、第三方扩展。这些用 `arcgis_python`：

```
arcgis_python({
  code: [
    'maps = aprx.listMaps()',
    'result = [{"name": m.name, "layers": len(m.listLayers())} for m in maps]',
  ].join('\n'),
  writeAllowed: true,
})
```

命名空间里已经有 `arcpy`、`arcutil`，以及**当前工程对象 `aprx`**——和我们其他工具用的是同一个实例，所以在这里改了 `aprx`，后续工具立刻能看到（不用重新 `project_open`）。要返回数据就把值赋给 `result`；`print` 的内容进 `stdout`，异常带回 `type` / `message` / `traceback`。

几条使用纪律：

- **能用一个专用工具解决就别用它**。专用工具有参数校验、返回结构稳定、写盘闸门；`arcgis_python` 三样都没有。
- 改完 `aprx` 仍然要 `arcgis_project_save` 才落盘——内存里改了不等于存了。
- 代码跑在常驻桥进程里，写死循环会把后续所有调用卡住（Node 侧 15 分钟超时）。
- 要建 `arcpy` 对象（`SpatialReference`、`Extent`）直接建，不要传字典给其他工具再指望它转。

## 工程是有状态的
`arcgis_project_open` 之后，后续所有 `map_*` / `layer_*` / `layout_*` / `camera_*` 都作用在那个工程上——不用每次传路径。要换工程就再 open 一次，或者给单次调用传 `project` 参数。

**改动只在内存里。** 加图层、改符号、调镜头、改字段，全都不会自己写回 `.aprx`。要落盘必须显式 `arcgis_project_save`。这是故意的：模型可以放开手试，最后一步由人决定要不要存。

同名图层、同名地图会报错并列出候选，不会瞎猜。组图层会递归展开，`layer.info` 能进到组里面。

### 移动视图：优先用 extent

`arcgis_camera_set` 有两个入口，可靠程度不一样：

`extent: {xMin, yMin, xMax, yMax}` 是可靠的那条。设完立刻能读回，`arcgis_map_export` 也真的按这个范围出图（实测同一工程两次导出字节数从 20791 降到 7091）。

`x` / `y` / `scale` 是 API 允诺、但在无窗口工程里读不回的那条。赋值不报错，`camera.X` 也能读到新值，但 `getExtent()` 会抛 `RuntimeError`，返回里 `current` 就是 `null` 并附一句说明。要可验证的结果就用 `extent`。

另外两条实测事实：`setExtent` 之后 `camera.X`/`camera.Y` 不会跟着变（还是旧值），中心点要看 `camera.center`（由范围算出来的）；`camera.scale` 在无窗口工程里恒为 0，`map_info` 会标 `scaleUninitialized: true`——这不代表视图坏了，只是没有窗口给它算比例尺。

## 写盘要 writeAllowed

会改磁盘的工具（`project_save`、`map_add_data`、`map_export`、`layer_update`、`data_insert/update/delete`、`data_add_field`、`data_delete_field`、`*_export` 等）必须传 `writeAllowed: true`，否则报 `WRITE_NOT_ALLOWED`。这不是权限系统，是让"删字段"这种动作在参数里留下痕迹。

`arcgis_data_delete` 的 `where` 为空时还要额外传 `allowAll: true`——清空整表不该是一个顺手就能发生的事。

## 数据读写

`arcgis_data_describe` 是万用入口：要素类、shapefile、表、栅格都给得出类型、范围、坐标系、字段、要素数。比它轻的只有 `arcgis_data_fields`。

`arcgis_data_query` 支持 SQL where、字段投影、分页（`limit` 默认 100、上限 10000）、`spatialReference` 投影输出。**几何字段返回 `{wkt, type, area, length}`**——要坐标就自己从 WKT 里读，别指望拿回数字数组。返回 `truncated: true` 就说明还有行，用 `offset` 接着要。

`arcgis_data_insert` 两种写法：`rows: [{字段: 值}]`，或者 `rows: [[...]]` + `fields: [...]`。几何字段喂 WKT 字符串或 GeoJSON 都行。

改值用 `arcgis_data_update`（所有匹配行改成同一组值），要按行算就用 `arcgis_data_calculate_field`，表达式是 Python 语法，`!字段!` 引字段名，例如 `"!area! / 1000000"`。日期字段用 `datetime`，别塞字符串。

建库建表：`arcgis_data_create_gdb({ outFolder, name })` → `arcgis_data_create_featureclass({ outPath: <那个gdb>, name, geometryType, spatialReference, fields })`。字段类型写小写：`text`、`long`、`double`、`date`、`short`、`float`。复制数据用 `arcgis_data_copy`（`kind: features | table`），纯属性表用 `arcgis_data_create_table`。

## 选择

`arcgis_select_by_attribute({ input, where })` → 返回 `count`（选中几个）。SQL 用标准写法：`"人口 > 2100"`、`"名称 = '上海'"`，字段名要和数据集里完全一致。

`arcgis_select_by_location({ input, overlap, selectFeatures, distance })` 按空间关系选。`overlap` 有 16 种，常用的 `INTERSECT`、`WITHIN`、`CONTAINS`、`HAVE_THEIR_CENTER_IN`；要距离时必须同时给 `distance`，且**带单位**（`"1500 Kilometers"`）。

`selectionType` 两处都支持 `NEW_SELECTION`（默认）/ `ADD_TO_SELECTION` / `REMOVE_FROM_SELECTION` / `SUBSET_SELECTION` / `SWITCH_SELECTION` / `CLEAR_SELECTION`。清选择用 `arcgis_select_clear`。选择结果留在图层上，后续 `arcgis_tool_run` 会尊重它——这是"只处理选中的那些要素"的标准做法。

## 投影与格式转换

`arcgis_reproject({ input, output, spatialReference })` 自己判断矢量还是栅格，走 `Project` 或 `ProjectRaster`。`spatialReference` 写 `"EPSG:3857"` 或 `{__arcpy__: "SpatialReference", wkid: 3857}`。跨基准面才需要 `transformation`。

「坐标值不对、只是缺坐标系定义」用 `arcgis_define_projection`——它**只写定义，不动坐标**。两个工具搞混是最常见的坐标系事故。

`arcgis_convert_data({ input, output, format })`：`shapefile`（`output` 给**文件夹**，shapefile 是好几个文件）、`json`（`output` 给 `.json`，`geoJson: true` 写标准 GeoJSON；实测 4 个点约 2 秒）、`excel`（`.xlsx`）。

## 矢量分析

`arcgis_data_merge`（合并成新数据集）· `arcgis_data_append`（追加进已有，`schemaType: TEST | NO_TEST`）· `arcgis_data_dissolve`（按字段融合，`statistics: {字段: SUM|MEAN|…}`）。融合的 `statistics` 内部会折算成 GP 要的 `[[字段, 统计]]`，直接传 `{人口: "sum"}` 就行，输出字段名是 `SUM_人口`。

## 栅格

`arcgis_raster_info` 读波段数、像元类型、像元大小、每波段 min/max/mean。处理类工具都吃 `input` / `output`：

`arcgis_raster_resample`（`cellSize`，**没有 width/height**，要指定像素数得自己算像元大小）· `arcgis_raster_clip`（矩形给 `rectangle: "xMin yMin xMax yMax"`，不规则给 `mask` 面要素）· `arcgis_raster_mosaic`（多张镶嵌成一张，波段数不传就从第一张探测）· `arcgis_raster_extract_mask`（按掩膜保留）· `arcgis_raster_surface`（`method: slope | aspect | hillshade | contour`，等高线必须给 `interval`）。

`arcgis_raster_calculator` 是唯一有"语言"的一个：`rasters` 给 `{变量名: 路径}`，`expression` 用这些变量名写算式：

```
arcgis_raster_calculator({
  rasters: { pop: "F:/ws/pop.tif", park: "F:/ws/park.tif" },
  expression: "(pop - park) / (pop + park)",
  output: "F:/ws/ndvi.tif"
})
```

可用函数：`Con / IsNull / SetNull / Abs / Exp / Ln / Log10 / Sqrt / Int / Float / Sin / Cos / Tan`，另外 `abs / min / max / round` 这些内建也在。变量是 `arcpy.sa.Raster` 对象，加减乘除直接写。

## 地图 / 布局 / 地图系列

`arcgis_map_new` 建空地图。**这一步慢**：`createMap` 在 Pro 3.6 上要从模板克隆底图工程，实测首次 102–115 秒、再次 56 秒，跟有没有网络无关。工具建完会把自带的 `Topographic` 底图摘掉（离线时它本来就是断链的），所以得到的是干净空白地图。真要底图，单独调 `arcgis_map_add_basemap`。

`arcgis_layout_new({ width, height, units })` —— `units` **只接受单数**：`INCH / MILLIMETER / CENTIMETER / POINT`，写 `INCHES` 会报 `ValueError`。`arcgis_layout_page_size` 改尺寸，`arcgis_layout_add_frame` 放地图框（内部把 x/y/宽高换成 `arcpy.Extent`——`createMapFrame` 只吃几何对象，吃 tuple 会 `TypeError`），`arcgis_layout_elements` 列元素，`arcgis_layout_text_set` 改已有文本元素的文字（**不能新建文本**：`createTextElement` 的 `text_type` 只认 `CIRCLE/ELLIPSE/LINE/POINT/POLYGON`，没有 `TEXT`）。

地图系列：先有地图框，再

```
arcgis_mapseries_create({ layout: "出图", mapFrame: "主图框", indexLayer: "cities", nameField: "名称" })
arcgis_mapseries_export({ layout: "出图", output: "F:/out/page_{page}.pdf", resolution: 300 })
```

`{page}` 是页号占位符，目录不存在会自动建。返回 `files`（页数）、`written`（每页路径与字节数）、`errors`。实测 4 页 96dpi PNG 用 2.8 秒。

## 图层级细操作

图层不止"开关 + 符号 + 定义查询"，还有一批细节：

| 想做的事 | 用哪个 |
| --- | --- |
| 换顺序（压盖关系） | `arcgis_layer_move`，绘制顺序就是列表顺序 |
| 一次开关多个 | `arcgis_layer_toggle`，比逐个 `layer_update` 快也不漏 |
| 加一个调好的图层 | `arcgis_layer_add`（.lyrx 文件，符号/查询/标注一起带来） |
| 把符号存下来复用 | `arcgis_layer_export` 存 .lyrx，再 `arcgis_layer_symbology_apply` 套回去 |
| 标注 | `arcgis_label_info` 看，`arcgis_label_set` 改（表达式是 Arcade：`$feature.名称`） |
| 底图 | 先 `arcgis_basemap_list` 查名字，再 `arcgis_map_add_basemap` |
| 色带 / 样式库 / 报表 | `arcgis_colorramp_list` / `arcgis_style_list` / `arcgis_report_list` |
| 书签 | `arcgis_bookmark_list` / `_import` / `_export` |

**`arcgis_layer_group` 只能建出空分组。** 无窗口工程里 `addLayerToGroup` 抛 `ValueError`（内容被包成对象，等于没信息）、`insertLayer` 返回成功但每次克隆一个新组、组的 `setDefinition` 塞 `layers` 也返回成功而组内仍空。工具因此返回 `membered: false` + `note`，别当失败。要成员得在 Pro 窗口里拖。

**`moveLayer` 的第一个参数是参照层，第二个才是要移动的层**——`Map.moveLayer(reference_layer, move_layer, insert_position)`。写反了不会报错，会把参照层挪走，症状是"`before` 看起来像 `after`"。`insert_position` 只认 `BEFORE`（挪到参照层上方）/ `AFTER`（下方），语义与内容列表顺序一致。`reference_layer` 不能传 `None`（直接 `ValueError`），所以"置顶"要拿当前第一层当参照、目标插到它上面。

**标注类不是天生就有的。** 要素图层默认 `listLabelClasses()` 是空列表，所以 `arcgis_label_set` 会先 `createLabelClass` 补一个；如果这个也失败（比如标注引擎不是 CIM），会明确告诉你先切引擎。

## 书签与地图文档

**`Map` 没有 `createBookmark`**（只有 `copyBookmark`）。无窗口工程存不了新书签——要书签就 `arcgis_bookmark_export` / `_import` 走 json，或者在有窗口的 Pro 里从视图存。空地图导出书签也会报「此地图中不存在书签」，这是数据状态不是工具问题。

`arcgis_map_definition` 读地图的 CIM 定义，Pro 没在 `arcpy.mp` 上暴露的设置都藏这里。默认只回键名（实测 60+ 个键），`full: true` 才取全部值。**`getDefinition("V3")` 返回的是 CIMMap 对象**，没有 `toJSON()` 也不是 dict——通用序列化会把它折成地图名字符串，所以只能按 `dir()` 的公开成员取键。

`arcgis_map_color_model` 读/改 RGB↔CMYK（出印刷品用 CMYK），`arcgis_map_reference_scale` 读/改参考比例尺（符号大小和标注密度都以它为准，定下来图在不同缩放下观感才一致）。

## 出图

布局：`arcgis_layout_list` → `arcgis_layout_export`。**没有 `format` 参数**——格式由 `output` 的扩展名决定：`.pdf`、`.png`、`.jpg`、`.tif`、`.svg`、`.ai`、`.eps` 等。`resolution` 默认 300，矢量格式给 300 起。实测 A1（594×841 mm）布局导 PDF 是 1 秒 / 3.8 MB。

地图视图：`arcgis_map_export`，同样**没有 `format` 参数**，扩展名决定格式（`.png`、`.jpg`、`.tif`、`.bmp`、`.gif`、`.pdf`、`.svg`）。位图默认 1200×900 像素——`MapView` 的位图导出 **width/height 是必需参数**，工具已经帮你填了默认值。

## 真实存在的坑

**中文路径完全没问题，但编码必须显式 UTF-8。** 桥已经设好 `PYTHONIOENCODING=utf-8`。如果哪天看到 `Ҫ��ͼ��` 这种乱码，说明有东西绕过了协议通道进了 stdout。中文的 gdb 名、要素类名、字段名、属性值都实测往返无损。

**gdb 里的要素类不能用 `os.path.exists` 判断。** `x.gdb/点要素` 不是文件系统路径。工具内部用 `arcpy.Exists`，你自己写 SQL 或路径时也别混。

**`arcpy.env.workspace` 是进程级全局。** 所以 `arcgis_data_list` 会临时设、用完还原；也所以所有调用在桥里串行排队——并行调只会互相踩 `env`、许可和 GP 消息缓冲。

**工程里图层的数据源可能已经断了。** 工程从别的机器拷过来时，`layer.info` 会给出 `dataSourceMissing: true` 和原始 `dataSource`。这不是工具的问题，去把数据放到那个路径或者重新 `map_add_data`。

**`simpleRenderer` 没有 `groups`。** `arcgis_layer_symbology` 已经分流：SimpleRenderer 返回单个 `symbol`，UniqueValue/Graduated 才返回分组。

**GP 不建输出目录，却报 `ERROR 000800: 参数无效`。** 实测 `PointToRaster` 往一个不存在的文件夹写就是这么报的，跟目录毫无关系的错误。桥在 `gp.execute` 前按 `GetParameterInfo` 只给 `direction == Output` 的参数建父目录，输入路径一律不碰。

**`SelectLayerByAttribute` 用 `NON_INVERT`，`SelectLayerByLocation` 用 `NOT_INVERT`。** 两边不通用，写错报 `ERROR 000800`。

**`management.Resample` 没有 width/height**，只有 `cell_size`。想得到指定像素数，自己用范围除。

**`arcpy.SpatialReference(...).wkid` 对投影坐标系是 `None`**，真值在 `factoryCode`。`Describe().spatialReference` 拿回来的是 "geoprocessing spatial reference object"，`isinstance` 判不出真——工具里用鸭子类型判定（`exportToString` + `factoryCode`）。

**`MapSeries` 只有 16 个成员**，没有 `type / nameField / sortField / startingPageNumber`；`getDefinition()` 必须传 `cim_version`。`arcgis_mapseries_info` 返回的是真实存在的那些 + `members` 全表。

**`Map.addTable()` 要 `arcpy.mp.Table` 对象 + 反斜杠路径。** 传路径字符串抛一句 `SystemError: ... returned a result with an exception set`（`GetMessages()` 还是空的）；传正斜杠的 `Table("F:/x.gdb/表")` 抛 `SystemError: <class 'MappingTableObject'> returned NULL without setting an exception`。两样都踩过，`arcgis_table_add` 里已经处理好。

**`removeLayer` 之后 Layer 对象就废了**，再读 `.name` 是 `AttributeError: The attribute 'name' is not supported on this instance of Layer`。

## 环境

`arcgis_environment` 读写 `arcpy.env`，74 项。最常用的几个：`workspace`、`overwriteOutput`（默认 false，覆盖输出会报错）、`outputCoordinateSystem`、`extent`、`cellSize`、`parallelProcessingFactor`、`addOutputsToMap`（默认 true，跑工具会自动往地图里塞图层——不想污染地图就设 false）。
