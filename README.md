# dsh-arcgispro

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-0e7490)](https://github.com/topics/dsh-plugin)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4d6bfe)](https://github.com/deepseek-ai/deepseek-harness)

让 DeepSeek Harness 直接操作 ArcGIS Pro：1977 个 GP 工具、`.aprx` 工程、地图、图层、布局出图、要素类读写、许可与环境变量。

## 为什么是一个常驻 Python 桥

`import arcpy` 实测 **7–20 秒**（冷启动 20.6s，warm 7.2s），而之后任何一次调用都是 5–40ms。
所以这里不采用「每次执行都 spawn 一个 python」的做法——那样每个工具调用都要付一次 import 成本。
插件启动一个常驻进程，用 JSON Lines 通信，第一次工具调用付一次 import 成本，之后全走热进程。

桥把 **fd1 重定向为协议通道**（`os.dup2(2, 1)`），`sys.stdout` 指向 stderr。
原因：GP 工具会往 stdout 打印中文进度消息，混进协议流就会毁掉 JSON 解析。现在所有 GP 打印都进 stderr，只有协议 JSON 走 fd1。

## 安装

### 方式一：从 npm 安装

```bash
dsh plugin --profile web add dsh-arcgispro
dsh plugin --profile desktop add dsh-arcgispro
```

`desktop` 是带窗口的 ArcGIS Pro 桌面 profile，`web` 是浏览器 profile；把 profile 名换成你实际要装的那个。
装完刷新页面即生效，插件出现在「设置 → 插件」里，行内标注 **ArcGIS Pro 桥**。
需要宿主里已有 `plugin_manager`（`dsh-base` 自带）。

> 该包当前**尚未发布到 npm**，上面的命令会解析失败。现在要装请用方式二。

### 方式二：从 GitHub 安装（现在可用）

钉住 tag 的 tarball 地址，下载后直接解包安装，不需要 git 传输：

```bash
dsh plugin --profile web add https://codeload.github.com/haiwenxiang061-dev/dsh-arcgispro/tar.gz/refs/tags/v0.1.0
dsh plugin --profile desktop add https://codeload.github.com/haiwenxiang061-dev/dsh-arcgispro/tar.gz/refs/tags/v0.1.0
```

Release 里也挂了同一份 `.tgz` 附件，想用 GitHub 的下载页可以换成：

```bash
dsh plugin --profile desktop add https://github.com/haiwenxiang061-dev/dsh-arcgispro/releases/download/v0.1.0/dsh-arcgispro-0.1.0.tgz
```

两点实测注意：
- `dsh plugin` 会把参数转发给 profile 目录里的 pnpm，所以本机需要能调到 `pnpm`（`npm i -g pnpm` 即可）。
- 不建议用 `github:haiwenxiang061-dev/dsh-arcgispro` 这种简写：它走 git 传输协议，在国内网络下经常被 reset；上面的 codeload 地址走 HTTPS 下载，稳定得多。

### 源码链接安装（开发用）

profile 目录 `C:\Users\下雪了\.dsh\profiles\desktop\`：

```jsonc
// package.json
"dependencies": { "dsh-arcgispro": "file:../../../workplace/dsh-arcgispro" },
"dsh": { "profile": { "bundles": [ /* ... */ "dsh-arcgispro" ] } }
```

`node_modules/dsh-arcgispro` 指向源码目录即可（junction 或 symlink 都行）。

Python 定位顺序：配置项 `python` → 环境变量 `DSH_ARCGISPRO_PYTHON` → 注册表 `HKLM\SOFTWARE\ESRI\ArcGISPro` 的 `InstallDir` → 常见安装根目录。
默认环境是 `<InstallDir>\bin\Python\envs\arcgispro-py3\python.exe`。

## 工具（87 个）

**状态与许可**
`arcgis_status`（含 `restart`）· `arcgis_license`（info/checkout/checkin/setProduct）· `arcgis_environment`（读写 74 项 GP 环境变量）

**GP 工具目录**
`arcgis_tool_list` · `arcgis_tool_info` · `arcgis_tool_run`（`params` 按名字 / `args` 按位置二选一）

**任意 arcpy 代码**
`arcgis_python`——在桥进程里执行 Python，命名空间里已备好 `arcpy`、`arcutil` 和当前工程对象 `aprx`，脚本的 `result` 变量与 stdout/stderr 一并带回。
所有工具都盖不住的能力（`arcpy.da` 游标、`arcpy.metadata`、CIM 深度定制、第三方扩展）从这里进；要求 `writeAllowed: true`，无参数校验、无回滚。

**工程 / 地图 / 图层 / 布局**
`arcgis_project_open` · `arcgis_project_info` · `arcgis_project_new` · `arcgis_project_save` · `arcgis_project_close` · `arcgis_project_broken_sources`
`arcgis_map_new` · `arcgis_map_info` · `arcgis_map_add_data` · `arcgis_map_add_basemap` · `arcgis_map_remove_layer` · `arcgis_map_export` · `arcgis_camera_set`
`arcgis_layer_info` · `arcgis_layer_update` · `arcgis_layer_symbology`
`arcgis_layout_list` · `arcgis_layout_info` · `arcgis_layout_new` · `arcgis_layout_page_size` · `arcgis_layout_add_frame` · `arcgis_layout_elements` · `arcgis_layout_text_set` · `arcgis_layout_export`

**地图系列**
`arcgis_mapseries_info` · `arcgis_mapseries_create` · `arcgis_mapseries_export`

**选择**
`arcgis_select_by_attribute` · `arcgis_select_by_location` · `arcgis_select_clear`

**数据**
`arcgis_data_describe` · `arcgis_data_list` · `arcgis_data_fields` · `arcgis_data_query` · `arcgis_data_statistics`
`arcgis_data_insert` · `arcgis_data_update` · `arcgis_data_delete` · `arcgis_data_calculate_field`
`arcgis_data_create_featureclass` · `arcgis_data_create_gdb` · `arcgis_data_create_table` · `arcgis_data_copy`
`arcgis_data_add_field` · `arcgis_data_delete_field` · `arcgis_data_merge` · `arcgis_data_append` · `arcgis_data_dissolve`

**投影与格式转换**
`arcgis_reproject`（矢量与栅格自动分流）· `arcgis_define_projection` · `arcgis_convert_data`（shapefile / json / excel）

**栅格**
`arcgis_raster_info` · `arcgis_raster_resample` · `arcgis_raster_clip` · `arcgis_raster_mosaic`
`arcgis_raster_calculator` · `arcgis_raster_extract_mask` · `arcgis_raster_surface`（slope/aspect/hillshade/contour）

**图层级细操作**
`arcgis_basemap_list` · `arcgis_layer_add`（.lyrx）· `arcgis_layer_move` · `arcgis_layer_group` · `arcgis_layer_toggle` · `arcgis_layer_export`
`arcgis_layer_symbology_apply` · `arcgis_label_info` · `arcgis_label_set`（Arcade 表达式）
`arcgis_table_list` · `arcgis_table_add` · `arcgis_style_list` · `arcgis_colorramp_list` · `arcgis_report_list`

**书签与地图文档**
`arcgis_bookmark_list` · `arcgis_bookmark_create` · `arcgis_bookmark_remove` · `arcgis_bookmark_export` · `arcgis_bookmark_import`
`arcgis_map_definition`（CIM）· `arcgis_map_color_model` · `arcgis_map_reference_scale`

## 典型流程

```
arcgis_tool_info analysis.Buffer        # 先看参数契约，params 的键就是这里的 name
arcgis_tool_run  analysis.Buffer        # params: {in_features, out_feature_class, buffer_distance_or_field}
```

```
arcgis_data_create_gdb      → arcgis_data_create_featureclass → arcgis_data_insert
arcgis_data_query           → 几何字段回 {wkt, type, area, length}
arcgis_tool_run analysis.Buffer → 输出要素类落地
```

```
arcgis_project_open  → arcgis_layer_update（定义查询/可见性）→ arcgis_project_save
                     → arcgis_layout_export（带图例比例尺的正式出图）
```

## 三条设计约束

**改动只在内存，`project_save` 才落盘。** 图层可见性、符号、定义查询、加删数据都作用于内存工程对象。这样一系列操作要么整体保存，要么整体丢弃，不会出现半个状态写进 `.aprx`。

**调用串行。** arcpy 不是线程安全的：`arcpy.env.*`、当前工作空间、许可检出状态、GP 消息缓冲全是进程级全局。桥内部用队列串行化，并发调用会排队而不是互相污染。

**写操作要显式 `writeAllowed: true`。** 磁盘改动（写工程、改数据、删字段、导出文件）必须显式授权，缺了直接拒绝。`arcgis_data_delete` 另有一层：空 `where` 必须再给 `allowAll: true`。

## 实测踩坑（已内建处理）

- **`da.SearchCursor` 传 `Shape` 只返回坐标元组**，必须传 `"SHAPE@"` 才拿几何对象。`arcgis_data_query` 内部按 `Describe().shapeFieldName` 自动换 token，输出字段名保持原样。
- **`ListFeatureClasses` 只接受 2 个位置参数**，工作空间必须走 `arcpy.env.workspace`；`arcgis_data_list` 临时设环境并在 `finally` 还原。
- **`os.path.exists` 对 gdb 内要素类永远假**（`x.gdb/点要素` 不是文件系统路径），存在性判断一律走 `arcpy.Exists`。
- **`Camera` 没有 `spatialReference`**，坐标系取地图对象的。
- **`SimpleRenderer` 没有 `groups`**，符号系统读取要按 `hasattr(renderer, "groups")` 分流。
- **`MapView.exportToPNG` 的宽高是必需位置参数**，`layout.exportToPDF` 不是。
- **GP 消息缓冲是全局残留**：一次失败调用后面会挂着上一条无关的「行计数 = 5」。桥在每次调用前先排空。
- **中文** 全程 UTF-8：路径、要素类名、字段名、属性值、GP 消息。桥进程固定 `PYTHONIOENCODING=utf-8`、`PYTHONUTF8=1`，否则 cp936 会把输出毁成乱码。
- **工程搬机器后图层数据源会断链**，`arcgis_map_info` 每个图层带 `dataSource` 与 `dataSourceMissing`，一眼看出哪个没了。
- **`createMap` 在 Pro 3.6 上极慢**：从模板克隆底图工程，实测首次 102–115 秒、再次 56 秒，与有没有网络无关，摘掉底图也省不掉。`arcgis_map_new` 建完会把默认的 `Topographic` 底图摘掉（离线时它必然是断链的），要底图单独调 `arcgis_map_add_basemap`。
- **`MapSeries` 只有 16 个成员**（`clipToIndexFeature / currentPageNumber / enabled / export / exportToPDF / getDefinition / getPageNumberFromName / indexLayer / mapFrame / pageCount / pageNameField / pageRow / refresh / selectedIndexFeatures / setDefinition`），没有 `type / nameField / sortField / startingPageNumber`；`getDefinition()` 必须传 `cim_version`。
- **栅格计算器的 `eval` 不能给空 `__builtins__`**：`arcpy.sa.Raster` 重载了算术运算，`pop * 2` 内部要 `__import__`，空内建直接 `KeyError: '__import__'`。只放计算必需的内建。
- **`SelectLayerByAttribute` 用 `NON_INVERT`，`SelectLayerByLocation` 用 `NOT_INVERT`**，两边不通用，写错报 `ERROR 000800`。
- **`Dissolve` 的 `statistics_fields` 只吃 `[[字段, 统计]]`**，`[{field, stat}]` 报一个指不到参数位置的 `Object: 执行工具时出错`。
- **GP 不建输出目录**，报的却是 `ERROR 000800: 参数无效`。桥在 `gp.execute` 前按 `GetParameterInfo` 的 `direction == Output` 准备好输出容器，输入路径不碰。
- **输出到还不存在的 `.gdb` 报 `ERROR 000210: 无法创建输出`**，而 gdb 不能靠 `makedirs` 造。桥检出路径里的 `.gdb` 就用 `CreateFileGDB` 建出来（父目录一并建）。
- **`arcgis_tool_run` 支持按位置传参**（`args: [...]`，顺序同 `arcgis_tool_info` 的 `index`），与 `params` 二选一。位置传参也会走同一套输出容器准备——早期版本直接 `fn(*args)` 绕过了它，于是同样的输出路径按名字传能成、按位置传就报 000800。
- **`listBasemaps()` / `styles` 返回字符串数组**，`listColorRamps()` / `listReports()` 返回对象。同一族接口两种形状，统一按 `isinstance(x, str)` 分流。
- **`Map.getDefinition("V3")` 返回 CIMMap**：既没有 `toJSON()` 也不是 dict，`arcpy` 的通用序列化会把它折成地图名字符串。真实结构只能按 `dir()` 的公开成员名取（实测 60+ 个：`layers / defaultCamera / referenceScale / colorModel / …`）。`arcgis_map_definition` 默认只回键名，`full: true` 才取全部值。
- **`LabelClass` 只有 6 个成员**（`SQLQuery / expression / getDefinition / setDefinition / name / visible`），字体字号偏移要走 CIM。要素图层默认**没有**标注类，`arcgis_label_set` 会自动 `createLabelClass` 补一个。
- **无窗口工程里分组没法填成员**：`addLayerToGroup(layer, group)` 抛 `ValueError`（内容被包成 `MappingLayerObject` 对象，等于没信息）；`insertLayer(layer, group, "AFTER")` 返回成功但**每次克隆出一个新组**；组的 `setDefinition` 塞 `layers=[layerDef]` 也返回成功而组内仍为空。`arcgis_layer_group` 因此只保证"分组建出来"，返回 `membered: false` + `note` 如实说明。
- **`Map` 没有 `createBookmark`**（只有 `copyBookmark`）。书签只能在有窗口的工程里从视图存；无窗口工程要书签就用 `arcgis_bookmark_import` 导入现成 json。空地图导出书签也会明确报「此地图中不存在书签」。
- **底图名不能想当然**：`addBasemap` 只认在线底图名（Topographic / Streets / Imagery…）。装了天地图插件的机器 `listBasemaps()` 给的是「天地图-地形（CGCS2000）」这类中文名，拿去 `addBasemap` 会被拒。先 `arcgis_basemap_list` 查，加不上时按报错换名字。
- **`Map.moveLayer` 的第一个参数是参照层，第二个才是要移动的层**：真实签名 `moveLayer(reference_layer, move_layer, insert_position='BEFORE')`。顺序写反**不报错**，但会把参照层挪走——症状是 `before` 看起来像 `after`（实测把 `school` 挪到 `Marketplace` 之前，结果变成 `Marketplace, school`）。`insert_position` 只认 `BEFORE`（参照层上方）/ `AFTER`（下方），与内容列表顺序一致。`reference_layer` 传 `None` 直接 `ValueError`（且没有信息），所以"置顶"要拿当前第一层当参照、目标插到它上面。
- **`Map.addTable()` 两个坑叠在一起**：必须传 `arcpy.mp.Table` 对象（传路径字符串只抛一句 `SystemError: ... returned a result with an exception set`，连 `GetMessages()` 都是空的）；而 `Table()` 又只认**反斜杠**路径，传 `F:/x.gdb/表` 报 `SystemError: <class 'MappingTableObject'> returned NULL without setting an exception`。我们内部路径一律正斜杠，所以 `op_table_add` 里要 `source.replace("/", os.sep)`。
- **`removeLayer` 之后 Layer 对象就脱离了地图**，再读 `.name` 直接 `AttributeError: The attribute 'name' is not supported on this instance of Layer`。要报"移除了谁"，名字得在移除**之前**读下来。
- **`arcpy.env` 的写入口收的是 `settings` 对象**（一次能写多项），不是 `name`/`value` 两个字段。工具层传错了会得到一句 `settings 必须是非空对象`，看起来像参数没给——这个错在 `all-tools.mjs` 里才被抓到（之前只测过读）。

## 兼容与权限

| 项 | 值 |
| --- | --- |
| DSH 版本 | 0.2.x，`dsh.bundle.patch` + 导出 `apply(ctx)` |
| 平台 | Windows（arcpy 与 ArcGIS Pro 仅 Windows 版） |
| 外部依赖 | 本机已安装 ArcGIS Pro 3.x；Python 解释器由插件按 `python` 配置 → `DSH_ARCGISPRO_PYTHON` → 注册表 → 常见安装路径自动定位 |
| 权限 | 启动一个常驻 Python 子进程执行 arcpy；写盘与改工程类工具（`arcgis_python`、`arcgis_data_*`、`arcgis_layout_export`、`arcgis_project_save` 等）要求 `writeAllowed: true`，缺省只读 |
| 网络 | 插件自身不联网；只有 ArcGIS 加载在线底图时由 Pro 联网 |
| 许可证 | MIT |

## 测试
```
node test/smoke.mjs                                    # 工具定义契约，秒级
node test/all-tools.mjs                                # 87 个工具逐个真调一遍，约 4 分钟
node test/live.mjs --project <path.aprx>               # 真桥实机，13-21 秒
node test/live-extended.mjs                            # 全能力链路，2-3 分钟（含 createMap 的 ~110s）
```

`all-tools.mjs` 是"有没有哪个工具一调就坏"的兜底：每条用例按顺序造数据、调工具，最后核对**注册的 87 个工具是否都至少成功调用过一次**，漏一个就退出码 1。Pro 本身做不到的事（无窗口工程里 `createBookmark`、空地图导出书签）用 `allowError` 标出来——只要错误说得清楚就算通过，测试要能区分"工具坏了"和"这件事本来就不行"。

`live.mjs` 覆盖：桥启动参数、工具目录检索、中文 gdb 往返、真实工程打开与布局导出、建库→建要素类→插中文点→回读→跑 Buffer、两条写盘闸门拒绝用例。

`live-extended.mjs` 覆盖：建库建表 → 插点 → 复制 → 属性/空间选择 → 投影与重定义 → 转 json → 合并 → 融合 → 点转栅格 → 重采样 → 掩膜裁剪 → 栅格计算 → 坡度 → 掩膜提取 → 镶嵌 → 新建工程/地图/加数据 → 布局新建/改页/加图框/列元素 → 地图系列建/查/逐页导出 → 存盘。断言只记账不抛出，一轮跑完能看到全部失败项。
它会往 `F:/workspace/_aprprobe_ext` 写测试数据（每次用唯一库名，不会撞 ERROR 000258）。

## 许可

MIT。详见 [LICENSE](LICENSE)。
