---
description: 自检 ArcGIS Pro 环境：安装位置、Python 环境、许可、arcpy 桥、当前工程
---

跑一次完整自检，把诊断结果摊开给我看。按顺序做：

1. `arcgis_status` —— 一次拿到安装信息、Python 与 arcpy 版本、产品许可级别、可用扩展、桥的启动耗时。如果 `ok` 是 false，直接把 `error` 原文报出来，不要继续往下猜。
2. 检查返回里 `installation.pythonExists`。如果是 false，说明注册表指向的安装目录里没有 `arcgispro-py3`，告诉我实际找到的路径和应该设的 `DSH_ARCGISPRO_PYTHON`。
3. `arcgis_project_info` —— 看当前会话有没有已经打开的工程。有就报工程路径、地图数、布局数、每个地图的图层数和数据源缺失数；没有就明说"当前没有打开工程"。
4. 如果有打开的工程且存在数据源缺失的图层，列出那些图层名和它们的 `dataSource`——这类断链是工程迁移后最常见的问题。
5. `arcgis_environment`（不传 name，读全部）—— 只挑出 `workspace`、`overwriteOutput`、`outputCoordinateSystem`、`addOutputsToMap` 这几个报，其余不用漫天列。

最后给一段简短结论：能不能干活、缺什么、下一步该做什么。别把原始 JSON 直接贴给我。
