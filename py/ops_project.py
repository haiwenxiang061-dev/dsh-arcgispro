"""
工程（.aprx）、地图、图层、布局 —— "控制 ArcGIS Pro" 的实体层。

## 会话模型

桥持有**一个**当前工程（`_STATE`）。任何操作都可以：
  * 不传 `project`：作用于当前已打开的工程
  * 传 `project`：若与当前一致就复用，否则切过去并行打开

这样一次 `arcgis_project_open` 之后的几十次查询/改符号/导出都不用重复打开，
而临时查询别的工程又不必先 close。

## 修改是否落盘

改图层、改符号、加数据都只改内存中的 ArcGISProject；只有 `project.save`
（或 `project.save a copy`）才写文件。这是故意的：模型可以反复试，觉得对了
再提交，工程文件不会被中途的半成品覆盖。
"""

import os

import arcutil

try:
    import arcpy.mp as _mp
except Exception:  # pragma: no cover
    _mp = None

_STATE = {"aprx": None, "path": None}

# 布局/地图的导出格式 -> arcpy.mp 的导出方法名
_LAYOUT_EXPORTERS = {
    "pdf": "exportToPDF", "png": "exportToPNG", "jpeg": "exportToJPEG",
    "jpg": "exportToJPEG", "tiff": "exportToTIFF", "tif": "exportToTIFF",
    "svg": "exportToSVG", "ai": "exportToAI", "eps": "exportToEPS",
    "bmp": "exportToBMP", "gif": "exportToGIF", "emf": "exportToEMF",
}

_MAP_EXPORTERS = {
    "png": "exportToPNG", "jpeg": "exportToJPEG", "jpg": "exportToJPEG",
    "pdf": "exportToPDF", "tiff": "exportToTIFF", "tif": "exportToTIFF",
    "svg": "exportToSVG", "bmp": "exportToBMP", "gif": "exportToGIF",
}


def _mp_module():
    if _mp is None:
        raise RuntimeError("arcpy.mp 不可用：ArcGIS Pro 安装不完整。")
    return _mp


def _view(one_map):
    """取（并缓存）地图的默认视图。

    无窗口模式下 `map.defaultView` 每次访问都会重建一个视图代理，相机状态
    不跨对象保留——实测 setExtent 之后重新 listMaps()[0].defaultView 读回来
    还是旧范围。所以相机必须作用在同一个视图对象上才有意义，这里按地图名
    缓存，project.open/close 时清空。
    """
    views = _STATE.setdefault("views", {})
    key = one_map.name
    view = views.get(key)
    if view is None:
        view = getattr(one_map, "defaultView", None)
        if view is not None:
            views[key] = view
    return view


def _norm(path):
    return os.path.normcase(os.path.abspath(str(path)))


def _project(params):
    """取工程：优先用 params.project，其次用会话里的当前工程。"""
    path = str(params.get("project") or "").strip()
    current = _STATE.get("aprx")
    current_path = _STATE.get("path")

    if path != "":
        if current is not None and current_path is not None and _norm(path) == _norm(current_path):
            return current, current_path
        if not os.path.exists(path):
            raise FileNotFoundError("工程文件不存在：%s" % path)
        aprx = _mp_module().ArcGISProject(path)
        _STATE["aprx"] = aprx
        _STATE["path"] = path
        return aprx, path

    if current is None:
        raise ValueError(
            "还没有打开工程。先调 arcgis_project_open 打开一个 .aprx，"
            "或在本调用里传 project 路径。"
        )
    return current, current_path


def _summary(aprx, path=None):
    """工程的骨架：地图、图层、布局、默认地理数据库。"""
    maps = []
    for one in aprx.listMaps():
        try:
            layers = [layer.name for layer in one.listLayers()]
        except Exception:
            layers = []
        try:
            tables = [table.name for table in one.listTables()]
        except Exception:
            tables = []
        maps.append({
            "name": one.name,
            "mapType": arcutil.to_jsonable(getattr(one, "mapType", None)),
            "layers": layers,
            "tables": tables,
            "layerCount": len(layers),
        })
    layouts = []
    for layout in aprx.listLayouts():
        layouts.append({
            "name": layout.name,
            "pageWidth": arcutil.to_jsonable(getattr(layout, "pageWidth", None)),
            "pageHeight": arcutil.to_jsonable(getattr(layout, "pageHeight", None)),
            "pageUnits": arcutil.to_jsonable(getattr(layout, "pageUnits", None)),
        })
    return {
        "project": path if path is not None else arcutil.to_jsonable(getattr(aprx, "filePath", None)),
        "defaultGeodatabase": arcutil.to_jsonable(getattr(aprx, "defaultGeodatabase", None)),
        "defaultToolbox": arcutil.to_jsonable(getattr(aprx, "defaultToolbox", None)),
        "maps": maps,
        "layouts": layouts,
        "mapCount": len(maps),
        "layoutCount": len(layouts),
    }


def _find_map(aprx, name):
    wanted = str(name or "").strip()
    if wanted == "":
        maps = aprx.listMaps()
        if not maps:
            raise ValueError("工程里没有地图。")
        return maps[0]
    for one in aprx.listMaps():
        if one.name == wanted:
            return one
    available = [one.name for one in aprx.listMaps()]
    raise ValueError("找不到地图 %r。现有地图：%s" % (name, ", ".join(available) if available else "(无)"))


def _walk_layers(container):
    """递归展开 group layer，返回 (layer, parentGroupName)。"""
    found = []
    for layer in container.listLayers():
        parent = None
        try:
            if layer.isGroupLayer:
                parent = layer.name
        except Exception:
            parent = None
        found.append((layer, None))
        try:
            if layer.isGroupLayer:
                for child in layer.listLayers():
                    found.append((child, layer.name))
        except Exception:
            continue
    return found


def _find_layer(aprx, name, map_name=None):
    """按名字找图层。

    同名策略：给了 map 时先只看那张图；还重名就取第一个（分组里叠两层同名
    图层是常见情形，报错等于把活儿推回给调用方）。只有在没给 map、跨地图
    重名时才要求限定——那时候确实不知道该动哪张图的。
    """
    wanted = str(name or "").strip()
    if wanted == "":
        raise ValueError("需要图层名。")
    scoped = bool(map_name)
    maps = [ _find_map(aprx, map_name) ] if scoped else aprx.listMaps()
    matches = []
    for one_map in maps:
        for layer, parent in _walk_layers(one_map):
            if layer.name == wanted:
                matches.append((one_map, layer, parent))
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        if scoped:
            # 同一张图内同名：取最上面那个（listLayers 顺序即绘制顺序）。
            return matches[0]
        distinct_maps = []
        for one_map, _l, _p in matches:
            if one_map.name not in distinct_maps:
                distinct_maps.append(one_map.name)
        where = "多张地图里" if len(distinct_maps) > 1 else "同一张地图里"
        raise ValueError(
            "图层名 %r 在%s有 %d 个同名图层，请用 map 参数限定（给了 map 就取最上面那个）。候选：%s"
            % (wanted, where, len(matches),
               "; ".join("%s/%s" % (m.name, l.name) for m, l, _ in matches))
        )    # 大小写不敏感兜底
    lowered = wanted.lower()
    for one_map in maps:
        for layer, parent in _walk_layers(one_map):
            if layer.name.lower() == lowered:
                return one_map, layer, parent
    available = []
    for one_map in maps:
        for layer, _parent in _walk_layers(one_map):
            available.append("%s/%s" % (one_map.name, layer.name))
    raise ValueError("找不到图层 %r。可用图层：%s" % (wanted, "; ".join(available) if available else "(无)"))


# ---------------------------------------------------------------------------
# 工程
# ---------------------------------------------------------------------------

def op_project_open(params):
    path = str(params.get("project") or params.get("path") or "").strip()
    if path == "":
        raise ValueError("需要 project 路径（.aprx）。")
    if not os.path.exists(path):
        raise FileNotFoundError("工程文件不存在：%s" % path)
    aprx = _mp_module().ArcGISProject(path)
    _STATE["aprx"] = aprx
    _STATE["path"] = path
    # 视图代理绑定在具体工程实例上，换工程必须丢弃。
    _STATE["views"] = {}
    info = _summary(aprx, path)
    info["opened"] = True
    return info


def op_project_info(params):
    aprx, path = _project(params)
    return _summary(aprx, path)


def op_project_new(params):
    """
    从模板复制出一个新工程。

    Pro 没有"编程创建空工程"的 API：必须从一个已存在的 .aprx 复制。模板默认
    用 Pro 安装目录里的 Blank.aprx，找不到就必须显式传 template。
    """
    target = str(params.get("project") or params.get("path") or "").strip()
    if target == "":
        raise ValueError("需要目标路径（project）。")
    template = str(params.get("template") or "").strip()
    if template == "":
        template = _default_template()
    if template == "":
        raise ValueError(
            "找不到可用的工程模板。请用 template 参数指定一个 .aprx 路径"
            "（任意已有工程都可以当模板，内容会被原样复制）。"
        )
    if not os.path.exists(template):
        raise FileNotFoundError("模板不存在：%s" % template)
    if os.path.exists(target):
        raise FileExistsError(
            "目标工程已存在：%s。换一个路径，或先手动删除。" % target
        )
    parent = os.path.dirname(os.path.abspath(target))
    if parent and not os.path.isdir(parent):
        os.makedirs(parent, exist_ok=True)

    aprx = _mp_module().ArcGISProject(template)
    aprx.saveACopy(target)
    # 必须重新打开副本。saveACopy 只写文件，内存里这个对象仍然指向模板；继续在
    # 它上面 createMap / createLayout，到 project.save 时就会把改动写回模板——
    # 实测把 ArcGIS Pro 安装目录里的 Blank.aprx 写脏了，还导致之后每次
    # createMap 因重名变成 "分析图1"。
    aprx = _mp_module().ArcGISProject(target)
    _STATE["aprx"] = aprx
    _STATE["path"] = target
    _STATE["views"] = {}
    return {"created": target, "template": template}


def _default_template():
    mod = arcutil.api()
    install = ""
    try:
        install = str(mod.GetInstallInfo().get("InstallDir") or "")
    except Exception:
        install = ""
    for candidate in (
        os.path.join(install, "Resources", "ArcGISProTemplates", "Map.aprx"),
        os.path.join(install, "Resources", "ArcGISProTemplates", "Blank.aprx"),
        os.path.join(install, "Resources", "ArcToolBox", "Services", "routingservices",
                     "data", "Blank.aprx"),
    ):
        if candidate and os.path.exists(candidate):
            return candidate
    return ""


def op_project_save(params):
    aprx, path = _project(params)
    target = str(params.get("as") or params.get("saveAs") or "").strip()
    if target != "":
        if os.path.exists(target) and params.get("overwrite") is not True:
            raise FileExistsError(
                "目标已存在：%s。要覆盖请传 overwrite: true。" % target
            )
        aprx.saveACopy(target)
        # 跟 project_new 同理：saveACopy 之后内存对象仍指向旧文件，不重开的话
        # 后面一次 save() 会把改动写回旧工程，而调用方以为已经另存了。
        _STATE["aprx"] = _mp_module().ArcGISProject(target)
        _STATE["path"] = target
        _STATE["views"] = {}
        return {"saved": True, "asCopy": target, "note": "已另存为新工程，当前会话指向新路径。"}
    aprx.save()
    return {"saved": True, "path": path}


def op_project_close(params):
    had = _STATE.get("aprx") is not None
    _STATE["aprx"] = None
    _STATE["path"] = None
    _STATE["views"] = {}
    return {"closed": had}


# ---------------------------------------------------------------------------
# 地图与图层
# ---------------------------------------------------------------------------

def op_map_info(params):
    aprx, _path = _project(params)
    one_map = _find_map(aprx, params.get("map"))
    layers = []
    for layer, parent in _walk_layers(one_map):
        entry = {
            "name": layer.name,
            "group": parent,
            "isFeatureLayer": arcutil.to_jsonable(getattr(layer, "isFeatureLayer", None)),
            "isRasterLayer": arcutil.to_jsonable(getattr(layer, "isRasterLayer", None)),
            "isGroupLayer": arcutil.to_jsonable(getattr(layer, "isGroupLayer", None)),
            "visible": arcutil.to_jsonable(getattr(layer, "visible", None)),
            "definitionQuery": arcutil.to_jsonable(getattr(layer, "definitionQuery", None)),
        }
        # 地图总览也要能看出哪层断了数据源——只列名字的话，模型得逐个
        # layer_info 才能发现工程搬过机器。
        try:
            source = layer.dataSource
        except Exception:
            source = None
        if isinstance(source, str) and source != "":
            entry["dataSource"] = source
            if not _source_exists(source):
                entry["dataSourceMissing"] = True
        layers.append(entry)
    view = _view(one_map)
    camera = None
    camera_error = None
    if view is not None:
        try:
            cam = view.camera
            # Camera 没有 spatialReference 属性（实测 3.6），坐标系在地图对象上。
            camera = {"x": cam.X, "y": cam.Y, "scale": cam.scale}
            # 比例尺为 0 说明这个视图还没初始化过范围，导出会得到空图——
            # 把当前范围一并报出来，省得靠猜。
            try:
                now = cam.getExtent()
                camera["extent"] = {"xMin": now.XMin, "yMin": now.YMin,
                                    "xMax": now.XMax, "yMax": now.YMax}
                # setExtent 之后 camera.X/Y 不会同步（实测仍是旧值），
                # 中心点以范围为准才算得准。
                camera["center"] = {"x": (now.XMin + now.XMax) / 2.0,
                                    "y": (now.YMin + now.YMax) / 2.0}
            except Exception:
                pass
            if camera.get("scale") == 0:
                camera["scaleUninitialized"] = True
        except Exception as exc:
            camera_error = "%s: %s" % (type(exc).__name__, exc)
    result = {
        "map": one_map.name,
        "mapType": arcutil.to_jsonable(getattr(one_map, "mapType", None)),
        "spatialReference": arcutil.to_jsonable(getattr(one_map, "spatialReference", None)),
        "layerCount": len(layers),
        "layers": layers,
        "tables": [t.name for t in one_map.listTables()],
        "camera": camera,
    }
    if camera_error is not None:
        result["cameraError"] = camera_error
    return result


def op_map_add_data(params):
    aprx, _path = _project(params)
    one_map = _find_map(aprx, params.get("map"))
    data = params.get("data") or params.get("path")
    items = data if isinstance(data, list) else [data]
    if not items or items[0] in (None, ""):
        raise ValueError("需要 data（一个或多个数据路径）。")
    added = []
    failed = []
    for item in items:
        text = str(item)
        # gdb 里的要素类不是文件系统路径，os.path.exists 会判 False——必须用 arcpy 的 Exists。
        if arcutil.exists(text) or "://" in text or text.startswith("{"):
            one_map.addDataFromPath(text)
            added.append(text)
        else:
            failed.append(text)
    return {"map": one_map.name,
            "added": added,
            "failed": failed,
            "layers": [layer.name for layer, _parent in _walk_layers(one_map)]}


def op_map_remove_layer(params):
    aprx, _path = _project(params)
    one_map, layer, _parent = _find_layer(aprx, params.get("layer"), params.get("map"))
    # 名字要在移除**之前**读：removeLayer 之后这个 Layer 对象就脱离地图了，
    # 再读 layer.name 直接 AttributeError（"The attribute 'name' is not supported
    # on this instance of Layer"）。
    removed = layer.name
    one_map.removeLayer(layer)
    return {"removed": removed, "map": one_map.name}


def op_map_add_basemap(params):
    """给地图挂一张在线底图。

    底图要从 ArcGIS Online 取，离线或网络差时会等很久才失败——所以这一项
    单独成 op，别塞进 map.new 里让"新建地图"变得不可预期。
    """
    aprx, _path = _project(params)
    one_map = _find_map(aprx, params.get("map"))
    name = str(params.get("basemap") or "").strip()
    if name == "":
        raise ValueError("需要 basemap，例如 Topographic / Streets / Imagery / Dark Gray Canvas。")
    try:
        one_map.addBasemap(name)
    except Exception as exc:
        raise RuntimeError(
            "加底图 %s 失败：%s。底图名要在在线底图列表里；离线时这一步必然失败，"
            "可以先拿本地矢量/栅格数据顶上。" % (name, exc)
        )
    return {
        "map": one_map.name,
        "basemap": name,
        "layers": [layer.name for layer, _parent in _walk_layers(one_map)],
    }


def op_layer_info(params):
    aprx, _path = _project(params)
    one_map, layer, parent = _find_layer(aprx, params.get("layer"), params.get("map"))
    info = {
        "map": one_map.name,
        "name": layer.name,
        "group": parent,
        "isFeatureLayer": arcutil.to_jsonable(getattr(layer, "isFeatureLayer", None)),
        "isRasterLayer": arcutil.to_jsonable(getattr(layer, "isRasterLayer", None)),
        "isGroupLayer": arcutil.to_jsonable(getattr(layer, "isGroupLayer", None)),
        "visible": arcutil.to_jsonable(getattr(layer, "visible", None)),
        "definitionQuery": arcutil.to_jsonable(getattr(layer, "definitionQuery", None)),
        "transparency": arcutil.to_jsonable(getattr(layer, "transparency", None)),
        "longName": arcutil.to_jsonable(getattr(layer, "longName", None)),
    }
    try:
        info["dataSource"] = arcutil.to_jsonable(layer.dataSource)
    except Exception:
        info["dataSource"] = None
    try:
        info["workspacePath"] = arcutil.to_jsonable(layer.workspacePath)
    except Exception:
        pass
    try:
        info["connectionProperties"] = arcutil.to_jsonable(layer.connectionProperties)
    except Exception:
        pass
    try:
        info["supports"] = arcutil.to_jsonable(layer.supports("DEFINITIONQUERY"))
    except Exception:
        pass

    # 字段与范围：读数据源的 Describe，图层本身不暴露这两项
    source = info.get("dataSource")
    if isinstance(source, str) and source != "":
        if not _source_exists(source):
            # 工程在别的机器上做的、数据目录没跟过来时就是这个状态。
            # 不标出来，模型会以为 Describe 报错是自己参数写错了。
            info["dataSourceMissing"] = True
        else:
            _describe_into(info, source)
    try:
        sym = layer.symbology
        renderer = sym.renderer
        info["symbology"] = {
            "renderer": type(renderer).__name__,
            "fields": arcutil.to_jsonable(getattr(renderer, "fields", None)),
        }
    except Exception as exc:
        info["symbologyError"] = "%s: %s" % (type(exc).__name__, exc)
    return info


def _source_exists(path):
    """图层数据源是否真的在。判定逻辑见 arcutil.exists。"""
    return arcutil.exists(path)


def _describe_into(info, source):
    mod = arcutil.api()
    try:
        described = mod.Describe(source)
        if described.dataType in ("FeatureClass", "FeatureLayer", "Shapefile"):
            info["shapeType"] = arcutil.to_jsonable(getattr(described, "shapeType", None))
        extent = getattr(described, "extent", None)
        if extent is not None:
            info["extent"] = arcutil.to_jsonable(extent)
        info["spatialReference"] = arcutil.to_jsonable(getattr(described, "spatialReference", None))
        info["fields"] = [{"name": f.name, "type": f.type,
                           "length": arcutil.to_jsonable(f.length),
                           "alias": arcutil.to_jsonable(getattr(f, "aliasName", None))}
                          for f in mod.ListFields(source)]
        try:
            info["featureCount"] = int(mod.management.GetCount(source)[0])
        except Exception:
            pass
    except Exception as exc:
        info["describeError"] = "%s: %s" % (type(exc).__name__, exc)


def op_layer_update(params):
    """
    改图层的开关性属性：可见、名称、定义查询、透明度、标注。

    只赋值模型显式给出的字段——把没提到的属性也"顺手恢复默认"是最容易毁掉
    用户工程的写法。
    """
    aprx, _path = _project(params)
    _one_map, layer, _parent = _find_layer(aprx, params.get("layer"), params.get("map"))
    changed = {}
    if "visible" in params:
        layer.visible = bool(params["visible"])
        changed["visible"] = layer.visible
    if "name" in params and str(params["name"]).strip() != "":
        new_name = str(params["name"]).strip()
        layer.name = new_name
        changed["name"] = new_name
    if "definitionQuery" in params:
        query = params["definitionQuery"]
        query = "" if query is None else str(query)
        if not layer.supports("DEFINITIONQUERY") and query != "":
            raise ValueError("图层 %r 不支持定义查询。" % layer.name)
        layer.definitionQuery = query
        changed["definitionQuery"] = query
    if "transparency" in params:
        if not layer.supports("TRANSPARENCY"):
            raise ValueError("图层 %r 不支持透明度。" % layer.name)
        layer.transparency = max(0, min(100, int(params["transparency"])))
        changed["transparency"] = layer.transparency
    if "showLabels" in params:
        if not layer.supports("SHOWLABELS"):
            raise ValueError("图层 %r 不支持标注。" % layer.name)
        layer.showLabels = bool(params["showLabels"])
        changed["showLabels"] = layer.showLabels
    return {"layer": layer.name, "changed": changed,
            "note": "改动只在内存里，需要 arcgis_project_save 才写回 .aprx。"}


def op_layer_symbology(params):
    """
    读/改图层符号系统。

    改符号的通用做法是把 `layer.symbology` 取出、改 renderer、再整体赋回——
    arcpy 没有"改一个颜色"的细粒度 API。这里覆盖三种最常见的渲染器。
    """
    aprx, _path = _project(params)
    _one_map, layer, _parent = _find_layer(aprx, params.get("layer"), params.get("map"))
    if not layer.isFeatureLayer:
        raise ValueError("图层 %r 不是要素图层，符号系统不适用。" % layer.name)

    sym = layer.symbology
    renderer = sym.renderer
    action = str(params.get("action") or "read").strip().lower()

    if action == "read" or action == "":
        result = {"layer": layer.name, "rendererType": type(renderer).__name__}
        for attr in ("fields", "colorRamp", "classificationMethod", "breakCount"):
            try:
                result[attr] = arcutil.to_jsonable(getattr(renderer, attr))
            except Exception:
                continue
        try:
            # SimpleRenderer 只有单个 symbol，没有 groups；唯一值/分级才有。
            if hasattr(renderer, "groups"):
                groups = []
                for group in renderer.groups:
                    items = []
                    for item in group.items:
                        entry = {}
                        for attr in ("label", "value", "visible"):
                            try:
                                entry[attr] = arcutil.to_jsonable(getattr(item, attr))
                            except Exception:
                                continue
                        try:
                            entry["symbolType"] = type(item.symbol).__name__
                            entry["color"] = arcutil.to_jsonable(item.symbol.color)
                        except Exception:
                            pass
                        items.append(entry)
                    groups.append({"heading": arcutil.to_jsonable(getattr(group, "heading", None)),
                                   "items": items})
                result["groups"] = groups
            else:
                symbol = renderer.symbol
                result["symbol"] = {
                    "type": type(symbol).__name__,
                    "color": arcutil.to_jsonable(getattr(symbol, "color", None)),
                }
                for attr in ("outlineColor", "size", "width", "style"):
                    try:
                        result["symbol"][attr] = arcutil.to_jsonable(getattr(symbol, attr))
                    except Exception:
                        continue
        except Exception as exc:
            result["groupsError"] = "%s: %s" % (type(exc).__name__, exc)
        return result

    if action == "single":
        color = params.get("color") or [130, 130, 130, 100]
        symType = str(params.get("symbolType") or "solid")
        if type(renderer).__name__ != "SimpleRenderer":
            raise ValueError("图层 %r 当前不是单一符号渲染器（%s），无法直接改成单一符号。"
                             % (layer.name, type(renderer).__name__))
        symbol = renderer.symbol
        symbol.color = arcutil.Color(*color)
        try:
            symbol.type = symType
        except Exception:
            pass
        layer.symbology = sym
        return {"layer": layer.name, "action": "single", "color": color,
                "note": "需要 arcgis_project_save 才写回工程。"}

    if action == "unique":
        field = str(params.get("field") or "").strip()
        if field == "":
            raise ValueError("unique 需要 field。")
        if type(renderer).__name__ != "UniqueValueRenderer":
            raise ValueError("图层 %r 当前不是唯一值渲染器（%s）。" % (layer.name, type(renderer).__name__))
        renderer.fields = [field]
        layer.symbology = sym
        return {"layer": layer.name, "action": "unique", "field": field,
                "note": "需要 arcgis_project_save 才写回工程。"}

    if action == "graduated":
        field = str(params.get("field") or "").strip()
        if field == "":
            raise ValueError("graduated 需要 field。")
        break_count = int(params.get("breakCount") or 5)
        if type(renderer).__name__ not in ("GraduatedColorsRenderer", "GraduatedSymbolsRenderer"):
            raise ValueError("图层 %r 当前不是分级渲染器（%s）。" % (layer.name, type(renderer).__name__))
        renderer.classificationField = field
        renderer.breakCount = break_count
        layer.symbology = sym
        return {"layer": layer.name, "action": "graduated", "field": field,
                "breakCount": break_count,
                "note": "需要 arcgis_project_save 才写回工程。"}

    raise ValueError("未知 action %r。可用：read / single / unique / graduated。" % action)


def op_map_export(params):
    aprx, _path = _project(params)
    one_map = _find_map(aprx, params.get("map"))
    target = str(params.get("output") or "").strip()
    if target == "":
        raise ValueError("需要 output 路径。")
    ext = os.path.splitext(target)[1].lstrip(".").lower()
    method_name = _MAP_EXPORTERS.get(ext)
    if method_name is None:
        raise ValueError("不支持的导出格式 %r。可用：%s" % (ext, ", ".join(sorted(_MAP_EXPORTERS))))

    view = _view(one_map)
    if view is None:
        raise ValueError("地图 %r 没有可导出的视图。" % one_map.name)
    exporter = getattr(view, method_name, None)
    if exporter is None:
        raise ValueError("该 Pro 版本的地图视图不支持 %s。" % method_name)

    parent = os.path.dirname(os.path.abspath(target))
    if parent and not os.path.isdir(parent):
        os.makedirs(parent, exist_ok=True)

    kwargs = {}
    if params.get("resolution") is not None:
        kwargs["resolution"] = int(params["resolution"])
    # 实测 Pro 3.6：MapView 的位图导出把 width/height 当必需位置参数
    # （layout.exportToPDF 则完全不需要），所以按方法名分两条路径。
    if method_name in ("exportToPNG", "exportToJPEG", "exportToBMP", "exportToGIF"):
        width = int(params.get("width") or 1200)
        height = int(params.get("height") or 900)
        exporter(target, width, height, **kwargs)
    else:
        exporter(target, **kwargs)
    return {"map": one_map.name, "output": target,
            "bytes": os.path.getsize(target) if os.path.exists(target) else None}


# ---------------------------------------------------------------------------
# 布局
# ---------------------------------------------------------------------------

def op_layout_list(params):
    aprx, _path = _project(params)
    layouts = []
    for layout in aprx.listLayouts():
        layouts.append({
            "name": layout.name,
            "pageWidth": arcutil.to_jsonable(getattr(layout, "pageWidth", None)),
            "pageHeight": arcutil.to_jsonable(getattr(layout, "pageHeight", None)),
            "pageUnits": arcutil.to_jsonable(getattr(layout, "pageUnits", None)),
        })
    return {"count": len(layouts), "layouts": layouts}


def _find_layout(aprx, name):
    wanted = str(name or "").strip()
    layouts = aprx.listLayouts()
    if not layouts:
        raise ValueError("工程里没有布局。")
    if wanted == "":
        return layouts[0]
    for layout in layouts:
        if layout.name == wanted:
            return layout
    raise ValueError("找不到布局 %r。现有布局：%s"
                     % (name, ", ".join(l.name for l in layouts)))


def op_layout_info(params):
    aprx, _path = _project(params)
    layout = _find_layout(aprx, params.get("layout"))
    info = {
        "name": layout.name,
        "pageWidth": arcutil.to_jsonable(getattr(layout, "pageWidth", None)),
        "pageHeight": arcutil.to_jsonable(getattr(layout, "pageHeight", None)),
        "pageUnits": arcutil.to_jsonable(getattr(layout, "pageUnits", None)),
    }
    try:
        elements = []
        for element in layout.listElements():
            elements.append({
                "name": arcutil.to_jsonable(getattr(element, "name", None)),
                "type": type(element).__name__,
                "elementType": arcutil.to_jsonable(getattr(element, "type", None)),
            })
        info["elements"] = elements
    except Exception as exc:
        info["elementsError"] = "%s: %s" % (type(exc).__name__, exc)
    try:
        maps = []
        for frame in layout.listElements("MAPFRAME_ELEMENT"):
            frame_info = {"name": arcutil.to_jsonable(getattr(frame, "name", None))}
            try:
                frame_info["map"] = frame.map.name
            except Exception:
                pass
            maps.append(frame_info)
        info["mapFrames"] = maps
    except Exception:
        pass
    return info


def op_layout_export(params):
    aprx, _path = _project(params)
    layout = _find_layout(aprx, params.get("layout"))
    target = str(params.get("output") or "").strip()
    if target == "":
        raise ValueError("需要 output 路径。")
    ext = os.path.splitext(target)[1].lstrip(".").lower()
    method_name = _LAYOUT_EXPORTERS.get(ext)
    if method_name is None:
        raise ValueError("不支持的导出格式 %r。可用：%s" % (ext, ", ".join(sorted(_LAYOUT_EXPORTERS))))
    exporter = getattr(layout, method_name, None)
    if exporter is None:
        raise ValueError("该 Pro 版本的布局对象不支持 %s。" % method_name)

    parent = os.path.dirname(os.path.abspath(target))
    if parent and not os.path.isdir(parent):
        os.makedirs(parent, exist_ok=True)

    kwargs = {}
    if params.get("resolution") is not None:
        kwargs["resolution"] = int(params["resolution"])
    if params.get("imageQuality") is not None and "PDF" not in method_name:
        kwargs["image_quality"] = str(params["imageQuality"])
    exporter(target, **kwargs)
    return {"layout": layout.name, "output": target, "format": ext,
            "bytes": os.path.getsize(target) if os.path.exists(target) else None}


def op_camera_set(params):
    """设置地图视图的相机（中心点/比例尺/范围）——"把地图移到这里"的直接控制。"""
    aprx, _path = _project(params)
    one_map = _find_map(aprx, params.get("map"))
    view = _view(one_map)
    if view is None:
        raise ValueError("地图 %r 没有可用视图。" % one_map.name)
    cam = view.camera
    changed = {}
    if params.get("x") is not None and params.get("y") is not None:
        cam.X = float(params["x"])
        cam.Y = float(params["y"])
        changed["x"] = cam.X
        changed["y"] = cam.Y
    if params.get("scale") is not None:
        cam.scale = float(params["scale"])
        changed["scale"] = cam.scale
    if params.get("extent") is not None:
        ext = params["extent"]
        # Camera 没有 spatialReference 属性，范围坐标系只能从地图或调用方取。
        # Extent(xmin,ymin,xmax,ymax,sr) 的第 5 个位置参数不是空间参考（会
        # 报 float() argument must be ... not 'geoprocessing spatial reference
        # object'），必须用关键字 spatial_reference= 传。
        spec = ext.get("spatialReference") or params.get("spatialReference")
        sr = arcutil.spatial_reference(spec) if spec else getattr(one_map, "spatialReference", None)
        kwargs = {"spatial_reference": sr} if sr is not None else {}
        frame = arcutil.api().Extent(float(ext["xMin"]), float(ext["yMin"]),
                                     float(ext["xMax"]), float(ext["yMax"]), **kwargs)
        cam.setExtent(frame)
        changed["extent"] = ext
    try:
        now = cam.getExtent()
        changed["current"] = {"xMin": now.XMin, "yMin": now.YMin,
                              "xMax": now.XMax, "yMax": now.YMax}
    except Exception:
        # 无窗口（headless）工程里，给 camera.X/Y/scale 赋值之后 getExtent()
        # 会抛 RuntimeError：视图本身动了，但没有可读回的范围。这不是失败。
        changed["current"] = None
        changed["note"] = ("视图已按 X/Y/scale 移动，但这个无窗口工程读不回范围"
                           "（getExtent 抛错）。需要可验证的范围就用 extent 参数。")
    return {"map": one_map.name, "changed": changed}


_PAGE_UNITS = ("CENTIMETER", "INCH", "MILLIMETER", "POINT")


def _page_units(value):
    units = str(value or "MILLIMETER").strip().upper()
    if units not in _PAGE_UNITS:
        raise ValueError(
            "未知的 units：%s。只接受单数形式：%s" % (units, ", ".join(_PAGE_UNITS))
        )
    return units


def op_map_new(params):
    """在工程里新建一个地图。

    createMap 会顺手挂一张默认底图 Topographic，而它要去 ArcGIS Online 取
    tiled 服务：实测同样的调用在这台机器上要 110 秒，离线时还会失败。所以
    建完立刻把这张底图摘掉——想加底图自己调 map.add_basemap，不想加就别加。
    """
    aprx, _path = _project(params)
    name = str(params.get("name") or "").strip()
    map_type = str(params.get("mapType") or "Map").strip()
    basemap = str(params.get("basemap") or "").strip()
    drop_default = params.get("dropDefaultBasemap")
    if drop_default is None:
        drop_default = basemap == ""
    try:
        one_map = aprx.createMap(name or None, map_type)
    except Exception as exc:
        raise RuntimeError(
            "新建地图失败：%s。mapType 可用 Map / Scene（三维）。" % exc
        )

    dropped = []
    if drop_default:
        for layer in list(one_map.listLayers()):
            try:
                removed = getattr(layer, "name", "?")
                one_map.removeLayer(layer)
                dropped.append(removed)
            except Exception:
                pass
    if basemap:
        try:
            one_map.addBasemap(basemap)
        except Exception as exc:
            raise RuntimeError(
                "新建地图成功，但加底图 %s 失败：%s（底图名要能在在线底图列表里找到，"
                "例如 Topographic / Streets / Imagery；离线时这一步会失败）。"
                % (basemap, exc)
            )

    return {
        "created": getattr(one_map, "name", name),
        "mapType": arcutil.to_jsonable(getattr(one_map, "mapType", None)),
        "droppedBasemap": dropped,
        "basemap": basemap or None,
        "layers": [layer.name for layer, _parent in _walk_layers(one_map)],
        "note": "新地图只在内存里，要写回 .aprx 需要 arcgis_project_save。",
    }


def op_layout_new(params):
    """新建布局。尺寸用页面单位（单数：INCH / MILLIMETER / CENTIMETER / POINT）。"""
    aprx, _path = _project(params)
    width = params.get("width")
    height = params.get("height")
    if width is None or height is None:
        raise ValueError("需要 width 与 height（页面尺寸，按 units 指定的单位）。")
    units = _page_units(params.get("units"))
    name = str(params.get("name") or "").strip()
    try:
        layout = aprx.createLayout(float(width), float(height), units, name or None)
    except Exception as exc:
        raise RuntimeError("新建布局失败：%s" % exc)
    return {
        "created": getattr(layout, "name", name),
        "pageWidth": arcutil.to_jsonable(getattr(layout, "pageWidth", None)),
        "pageHeight": arcutil.to_jsonable(getattr(layout, "pageHeight", None)),
        "pageUnits": units,
        "note": "新布局只在内存里，要写回 .aprx 需要 arcgis_project_save。",
    }


def op_layout_page_size(params):
    """改布局页面尺寸。"""
    aprx, _path = _project(params)
    layout = _find_layout(aprx, params.get("layout"))
    width = params.get("width")
    height = params.get("height")
    if width is None or height is None:
        raise ValueError("需要 width 与 height。")
    units = _page_units(params.get("units") or getattr(layout, "pageUnits", None))
    try:
        layout.changePageSize(float(width), float(height), units)
    except Exception as exc:
        raise RuntimeError("改页面尺寸失败：%s" % exc)
    return {
        "layout": layout.name,
        "pageWidth": arcutil.to_jsonable(getattr(layout, "pageWidth", None)),
        "pageHeight": arcutil.to_jsonable(getattr(layout, "pageHeight", None)),
        "pageUnits": units,
    }


def op_layout_add_frame(params):
    """往布局里放一个地图框。

    geometry 必须是真的 arcpy.Extent——实测传 tuple / list / dict 都会报
    "布局：几何必须为有效的几何对象"，只有 Extent 对象认。
    """
    aprx, _path = _project(params)
    layout = _find_layout(aprx, params.get("layout"))
    one_map = _find_map(aprx, params.get("map"))
    x = float(params.get("x", 0.5))
    y = float(params.get("y", 0.5))
    width = float(params.get("width", 6.0))
    height = float(params.get("height", 4.0))
    name = str(params.get("name") or "").strip()
    try:
        extent = arcutil.api().Extent(x, y, x + width, y + height)
        frame = layout.createMapFrame(extent, one_map, name or None)
    except Exception as exc:
        raise RuntimeError("创建地图框失败：%s" % exc)
    return {
        "layout": layout.name,
        "frame": getattr(frame, "name", name),
        "elementType": arcutil.to_jsonable(getattr(frame, "type", None)),
        "extent": {"x": x, "y": y, "width": width, "height": height},
        "map": one_map.name,
    }


def op_layout_elements(params):
    """读布局元素及其位置尺寸。改布局之前先用它看清有什么。"""
    aprx, _path = _project(params)
    layout = _find_layout(aprx, params.get("layout"))
    wanted = str(params.get("type") or "").strip().upper()
    try:
        raw = layout.listElements(wanted) if wanted else layout.listElements()
    except Exception as exc:
        raise RuntimeError(
            "枚举元素失败：%s。type 可写 MAPFRAME_ELEMENT / TEXT_ELEMENT / "
            "LEGEND_ELEMENT / MAPSURROUND_ELEMENT。" % exc
        )
    items = []
    for element in raw:
        item = {
            "name": arcutil.to_jsonable(getattr(element, "name", None)),
            "elementType": arcutil.to_jsonable(getattr(element, "type", None)),
            "className": type(element).__name__,
        }
        for attr in ("elementPositionX", "elementPositionY", "elementWidth", "elementHeight"):
            try:
                item[attr] = arcutil.to_jsonable(getattr(element, attr))
            except Exception:
                continue
        if item["elementType"] == "TEXT_ELEMENT":
            item["text"] = arcutil.to_jsonable(getattr(element, "text", None))
        items.append(item)
    return {
        "layout": layout.name,
        "count": len(items),
        "pageUnits": arcutil.to_jsonable(getattr(layout, "pageUnits", None)),
        "elements": items,
    }


def op_layout_text_set(params):
    """改布局里某个文本元素的文字（按元素名找）。"""
    aprx, _path = _project(params)
    layout = _find_layout(aprx, params.get("layout"))
    name = str(params.get("element") or params.get("name") or "").strip()
    if name == "":
        raise ValueError("需要 element（文本元素的名字，先从 arcgis_layout_elements 查）。")
    text = params.get("text")
    if text is None:
        raise ValueError("需要 text（新的文字内容）。")

    target = None
    for element in layout.listElements():
        try:
            if str(element.name) == name:
                target = element
                break
        except Exception:
            continue
    if target is None:
        available = []
        for element in layout.listElements():
            try:
                if getattr(element, "type", "") == "TEXT_ELEMENT":
                    available.append(str(element.name))
            except Exception:
                continue
        raise ValueError(
            "布局 %r 里没有名为 %r 的元素。现有文本元素：%s"
            % (layout.name, name, ", ".join(available) if available else "(无)")
        )

    old = arcutil.to_jsonable(getattr(target, "text", None))
    try:
        target.text = str(text)
    except Exception as exc:
        raise RuntimeError("改文字失败：%s（%r 可能不是文本元素）" % (exc, name))
    return {"layout": layout.name, "element": name, "old": old, "new": str(text)}


def op_map_broken_sources(params):
    """列出断链的数据源。工程换机器之后第一步就该跑这个。"""
    aprx, path = _project(params)
    try:
        broken = aprx.listBrokenDataSources()
    except Exception as exc:
        raise RuntimeError("读取断链清单失败：%s" % exc)
    items = []
    for layer in broken:
        item = {"name": arcutil.to_jsonable(getattr(layer, "name", None))}
        try:
            item["dataSource"] = arcutil.to_jsonable(layer.dataSource)
        except Exception:
            pass
        try:
            item["isBroken"] = True
        except Exception:
            pass
        items.append(item)
    return {
        "project": path,
        "brokenCount": len(items),
        "broken": items,
        "note": "断链的图层在导出时会画不出来。修法：arcgis_layer_update 改 dataSource，或把数据拷到原路径。",
    }


def op_mapseries_info(params):
    """读地图系列状态。没启用时返回 enabled: false 而不是报错。"""
    aprx, _path = _project(params)
    layout = _find_layout(aprx, params.get("layout"))
    series = getattr(layout, "mapSeries", None)
    if series is None:
        return {
            "layout": layout.name,
            "enabled": False,
            "note": "这个布局还没有地图系列。用 arcgis_mapseries_create 建一个（按索引图层或按书签）。",
        }
    info = {"layout": layout.name, "enabled": arcutil.to_jsonable(getattr(series, "enabled", None))}
    # MapSeries 的真实成员就这 16 个（实测 dir()）：没有 type / nameField / sortField /
    # startingPageNumber，硬读只会静默丢字段。这里只读确实存在的。
    info["members"] = sorted(
        name for name in dir(series) if not name.startswith("_")
    )
    for attr in ("pageCount", "currentPageNumber", "clipToIndexFeature"):
        try:
            info[attr] = arcutil.to_jsonable(getattr(series, attr))
        except Exception:
            continue
    for attr in ("indexLayer", "mapFrame", "pageNameField"):
        try:
            obj = getattr(series, attr)
            info[attr] = arcutil.to_jsonable(
                getattr(obj, "name", None) or getattr(obj, "longName", None) or str(obj)
            )
        except Exception:
            continue
    try:
        # getDefinition() 没有默认参数，必须给 cim_version——不给就 TypeError。
        definition = series.getDefinition("V3")
        if isinstance(definition, dict):
            info["definition"] = arcutil.to_jsonable(definition)
    except Exception:
        pass
    return info


def op_mapseries_create(params):
    """按索引图层建空间地图系列。"""
    aprx, _path = _project(params)
    layout = _find_layout(aprx, params.get("layout"))
    mapframe_name = str(params.get("mapFrame") or "").strip()
    frame = None
    for element in layout.listElements("MAPFRAME_ELEMENT"):
        if mapframe_name == "" or str(getattr(element, "name", "")) == mapframe_name:
            frame = element
            break
    if frame is None:
        raise ValueError(
            "布局 %r 里找不到地图框 %r。先用 arcgis_layout_elements 看有哪些。"
            % (layout.name, mapframe_name)
        )
    index_layer = str(params.get("indexLayer") or "").strip()
    if index_layer == "":
        raise ValueError("需要 indexLayer（用作分页索引的图层名，每页一个要素）。")
    name_field = str(params.get("nameField") or "").strip()
    if name_field == "":
        raise ValueError("需要 nameField（页名字段）。")

    try:
        _one_map, layer, _parent = _find_layer(aprx, index_layer, params.get("map"))
    except Exception as exc:
        raise RuntimeError("索引图层解析失败：%s" % exc)
    try:
        series = layout.createSpatialMapSeries(
            frame, layer, name_field, str(params.get("sortField") or "") or None
        )
        series.enabled = True
    except Exception as exc:
        raise RuntimeError("建地图系列失败：%s" % exc)
    return {
        "layout": layout.name,
        "enabled": arcutil.to_jsonable(getattr(series, "enabled", None)),
        "indexLayer": index_layer,
        "nameField": name_field,
        "pageCount": arcutil.to_jsonable(getattr(series, "pageCount", None)),
    }


def op_mapseries_export(params):
    """把地图系列逐页导出成一堆文件。"""
    aprx, _path = _project(params)
    layout = _find_layout(aprx, params.get("layout"))
    series = getattr(layout, "mapSeries", None)
    if series is None or not getattr(series, "enabled", False):
        raise ValueError(
            "布局 %r 没有启用的地图系列。先 arcgis_mapseries_create。" % layout.name
        )
    pattern = str(params.get("output") or "").strip()
    if pattern == "":
        raise ValueError(
            "需要 output 模板路径，页号用 {page} 占位，例如 D:/out/page_{page}.pdf。"
        )
    directory = os.path.dirname(os.path.abspath(pattern))
    if directory and not os.path.isdir(directory):
        os.makedirs(directory, exist_ok=True)

    count = int(getattr(series, "pageCount", 0) or 0)
    if count <= 0:
        raise ValueError("地图系列页数是 %d，没有可导出的页。" % count)

    ext = os.path.splitext(pattern)[1].lstrip(".").lower()
    method_name = _LAYOUT_EXPORTERS.get(ext)
    if method_name is None:
        raise ValueError(
            "不认识的导出格式：%s。可用：%s" % (ext, ", ".join(sorted(_LAYOUT_EXPORTERS)))
        )
    exporter = getattr(layout, method_name, None)
    if exporter is None:
        raise RuntimeError("这个布局不支持 %s 导出。" % ext)

    resolution = params.get("resolution")
    written = []
    errors = []
    for page in range(1, count + 1):
        try:
            series.currentPageNumber = page
        except Exception as exc:
            errors.append({"page": page, "error": "切页失败：%s" % exc})
            continue
        path = pattern.replace("{page}", str(page))
        kwargs = {}
        if resolution is not None and ext in ("pdf", "png", "jpeg", "jpg", "tiff", "tif"):
            kwargs["resolution"] = int(resolution)
        try:
            exporter(path, **kwargs)
            written.append({"page": page, "output": path, "bytes": os.path.getsize(path)})
        except Exception as exc:
            errors.append({"page": page, "error": "%s: %s" % (type(exc).__name__, exc)})
    return {
        "layout": layout.name,
        "pageCount": count,
        "written": written,
        "errors": errors,
        "files": len(written),
    }


HANDLERS = {
    "project.open": op_project_open,
    "project.info": op_project_info,
    "project.new": op_project_new,
    "project.save": op_project_save,
    "project.close": op_project_close,
    "project.broken_sources": op_map_broken_sources,
    "map.info": op_map_info,
    "map.add_data": op_map_add_data,
    "map.remove_layer": op_map_remove_layer,
    "map.add_basemap": op_map_add_basemap,
    "map.export": op_map_export,
    "map.new": op_map_new,
    "layer.info": op_layer_info,
    "layer.update": op_layer_update,
    "layer.symbology": op_layer_symbology,
    "layout.list": op_layout_list,
    "layout.info": op_layout_info,
    "layout.export": op_layout_export,
    "layout.new": op_layout_new,
    "layout.page_size": op_layout_page_size,
    "layout.add_frame": op_layout_add_frame,
    "layout.elements": op_layout_elements,
    "layout.text_set": op_layout_text_set,
    "mapseries.info": op_mapseries_info,
    "mapseries.create": op_mapseries_create,
    "mapseries.export": op_mapseries_export,
    "camera.set": op_camera_set,
}
