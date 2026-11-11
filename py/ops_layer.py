"""图层级与地图级的细操作：底图、书签、标注、分组、表、样式、报表。

这些能力全在 arcpy.mp 里，GP 层根本不存在——所以只能一组组对着实测成员
写。凡是文档里有、Pro 3.6 实际没有的属性（`Symbology.type`、`MapSeries.type`、
`LabelClass` 的字体设置），这里一律按 dir() 探到的真实结构来。
"""

import json
import os

import arcutil
from ops_project import (
    _find_layer,
    _find_map,
    _project,
    _walk_layers,
)


def _mod():
    return arcutil.api().mp


def _list_names(items):
    """把"对象数组 / 字符串数组"统一成字符串名字数组。

    `listBasemaps()` / `styles` 返回的是纯字符串数组，`listColorRamps()` /
    `listReports()` 返回对象。两种都得吃，所以先判 str。
    """
    names = []
    for item in items or []:
        try:
            names.append(item if isinstance(item, str) else item.name)
        except Exception:
            continue
    return names


def _names_payload(key, items, extra=None):
    """统一形状：`{count, <key>}`。count 必须有——工具层和测试都靠它判断。"""
    names = _list_names(items)
    payload = {"count": len(names), key: names}
    if extra:
        payload.update(extra)
    return payload


# ---------------------------------------------------------------------------
# 底图
# ---------------------------------------------------------------------------

def op_basemap_list(params):
    """列出工程可用的底图名。

    不同机器/许可拿到的是不同集合：装了天地图插件的工程会给「天地图-地形
    （CGCS2000）」这类中文名，纯在线底图环境给 Topographic/Streets。所以
    不要凭记忆写底图名，先查。
    """
    aprx, _path = _project(params)
    return _names_payload("basemaps", aprx.listBasemaps())


# ---------------------------------------------------------------------------
# 图层：加/删/移/分组/表
# ---------------------------------------------------------------------------

def _layer_count(one_map):
    return len(list(_walk_layers(one_map)))


def op_layer_add(params):
    """往地图里加一个已经存在的图层对象（来自另一个地图或 .lyrx 文件）。"""
    aprx, _path = _project(params)
    one_map = _find_map(aprx, params.get("map"))
    source = str(params.get("lyrx") or "").strip()
    if source == "":
        raise ValueError("需要 lyrx（要加的 .lyrx 图层文件路径）。")
    if not os.path.exists(source):
        raise FileNotFoundError("图层文件不存在：%s" % source)
    before = _layer_count(one_map)
    try:
        one_map.addLayer(_mod().LayerFile(source))
    except Exception as exc:
        raise RuntimeError("添加图层失败：%s。.lyrx 要能在这个 Pro 版本里打开。" % exc)
    return {"map": one_map.name, "source": source, "layers": _list_names(
        layer for layer, _parent in _walk_layers(one_map)), "layerCountBefore": before}


def op_layer_move(params):
    """把图层挪到指定位置，或挪进/挪出一个分组。"""
    aprx, _path = _project(params)
    one_map, layer, _parent = _find_layer(aprx, params.get("layer"), params.get("map"))
    reference = params.get("referenceLayer")
    position = str(params.get("position") or "before").strip().lower()
    if position not in ("before", "after"):
        raise ValueError("position 只接受 before / after。")
    try:
        to_top = not reference
        if reference:
            _m, ref_layer, _p = _find_layer(aprx, reference, one_map.name)
        else:
            # 不给参照层 = 挪到最上层。Pro 没有"置顶"接口，只能拿当前第一层作参照、
            # 把目标插到它上面；reference_layer 传 None 会直接 ValueError。
            ref_layer = (list(one_map.listLayers()) or [None])[0]
            if ref_layer is None:
                raise RuntimeError("地图里没有图层，无从移动。")
            if ref_layer.name == layer.name:
                return {"map": one_map.name, "position": "top", "moved": False,
                        "layers": _list_names(l for l, _p in _walk_layers(one_map))}
        # 真实签名是 moveLayer(reference_layer, move_layer, insert_position)——
        # 先参照、后被移动的层，顺序反了会把"参照层"挪走。BEFORE=上方，AFTER=下方。
        one_map.moveLayer(ref_layer, layer, position.upper())
    except Exception as exc:
        raise RuntimeError("移动图层失败：%s" % exc)
    return {"map": one_map.name,
            "moved": True,
            "position": "top" if to_top else position,
            "layers": _list_names(l for l, _p in _walk_layers(one_map))}


def op_layer_group(params):
    """新建分组图层，并尽量把指定图层挪进去。

    实测结论（Pro 3.6 无窗口工程，逐个试过）：
    - `map.addLayerToGroup(layer, group)` / `(layer, group.name)`：抛
      `ValueError`，参数被 arcpy 包成 MappingLayerObject 冒出来，等于没信息；
    - `map.insertLayer(layer, group, "AFTER"/"BEFORE")`：返回成功但**每次
      都会克隆出一个新分组**，图层还是留在外面；
    - `group.setDefinition(gd)` 塞 `gd.layers=[layerDef]`：返回成功，组内仍是空。

    所以这里只保证"分组建出来"。要给成员，得在有窗口的 Pro 里拖，或者改
    工程的 CIM（还没找到可靠写法）。返回 `membered: false` 和 `note` 让调用方
    知道这不是漏做。
    """
    aprx, _path = _project(params)
    one_map = _find_map(aprx, params.get("map"))
    name = str(params.get("name") or "").strip()
    if name == "":
        raise ValueError("需要 name（分组名）。")
    try:
        one_map.createGroupLayer(name)
    except Exception as exc:
        raise RuntimeError("新建分组失败：%s" % exc)

    members = params.get("layers") or []
    moved = []
    errors = []
    for member in members:
        try:
            _m, layer, _p = _find_layer(aprx, member, one_map.name)
            group = next((one for one in _walk_layers(one_map)
                          if one[0].isGroupLayer and one[0].name == name), None)
            if group is None:
                raise ValueError("刚建的分组 %r 找不到了。" % name)
            one_map.addLayerToGroup(layer, group[0])
            moved.append(member)
        except Exception as exc:
            errors.append("%s: %s" % (member, repr(exc.args or str(exc))))

    return {
        "map": one_map.name,
        "group": name,
        "moved": moved,
        "membered": bool(moved),
        "errors": errors,
        "layers": _list_names(l for l, _p in _walk_layers(one_map)),
        "note": (None if moved else
                 "分组已建好，但无窗口工程里没法把图层挪进去（addLayerToGroup/"
                 "insertLayer 都不生效）。要成员请在 Pro 窗口里拖，或者用 "
                 "arcgis_map_definition + CIM 直接改。"),
    }


def op_layer_toggle(params):
    """批量开关一组图层的可见性——比一个个 layer.update 快得多，也不误伤别人。"""
    aprx, _path = _project(params)
    one_map = _find_map(aprx, params.get("map"))
    names = params.get("layers")
    if not isinstance(names, list) or not names:
        raise ValueError("需要 layers（图层名数组）。")
    visible = bool(params.get("visible", True))
    done = []
    for name in names:
        _m, layer, _p = _find_layer(aprx, name, one_map.name)
        layer.visible = visible
        done.append(name)
    return {"map": one_map.name, "visible": visible, "changed": done, "updated": done}


def op_layer_export(params):
    """把图层存成 .lyrx 图层文件（符号、定义查询、标注都带走）。"""
    aprx, _path = _project(params)
    _m, layer, _p = _find_layer(aprx, params.get("layer"), params.get("map"))
    target = str(params.get("output") or "").strip()
    if target == "":
        raise ValueError("需要 output（.lyrx 路径）。")
    parent = os.path.dirname(os.path.abspath(target))
    if parent and not os.path.isdir(parent):
        os.makedirs(parent, exist_ok=True)
    try:
        layer.saveACopy(target)
    except Exception as exc:
        raise RuntimeError("导出图层文件失败：%s" % exc)
    return {"layer": layer.name, "output": target,
            "bytes": os.path.getsize(target) if os.path.exists(target) else None}


def op_table_list(params):
    """列出地图里的独立表（不带几何的表也能进地图）。"""
    aprx, _path = _project(params)
    one_map = _find_map(aprx, params.get("map"))
    tables = []
    try:
        for table in one_map.listTables():
            tables.append({"name": table.name, "dataSource": getattr(table, "dataSource", None)})
    except Exception:
        pass
    return {"map": one_map.name, "tables": tables, "count": len(tables)}


def op_table_add(params):
    """把一张表加进地图（之后 layout 里可以放表框）。"""
    aprx, _path = _project(params)
    one_map = _find_map(aprx, params.get("map"))
    source = str(params.get("data") or "").strip()
    if source == "":
        raise ValueError("需要 data（表的路径，gdb 内路径也算）。")
    if not arcutil.exists(source):
        raise FileNotFoundError("表不存在：%s" % source)
    try:
        # 两个坑叠在一起：
        # 1) 必须传 arcpy.mp.Table 对象，传路径字符串会抛一句没信息量的
        #    SystemError: "... returned a result with an exception set"（GetMessages 还是空的）。
        # 2) Table() 只认反斜杠。传 "F:/x.gdb/表" 会抛
        #    SystemError: "<class 'MappingTableObject'> returned NULL without setting an exception"。
        #    我们内部一律用正斜杠，所以这里要换回来。
        one_map.addTable(_mod().Table(source.replace("/", os.sep)))
    except Exception as exc:
        raise RuntimeError("加表失败：%s" % exc)
    return {"map": one_map.name, "tables": _list_names(one_map.listTables())}


# ---------------------------------------------------------------------------
# 标注
# ---------------------------------------------------------------------------

def op_label_info(params):
    aprx, _path = _project(params)
    _m, layer, _p = _find_layer(aprx, params.get("layer"), params.get("map"))
    return _label_info(layer)


def _label_info(layer):
    info = {
        "layer": layer.name,
        "supportsLabels": arcutil.to_jsonable(layer.supports("SHOWLABELS")),
        "showLabels": arcutil.to_jsonable(getattr(layer, "showLabels", None)),
        "classes": [],
    }
    # 上报数组时同时给 labelClasses 别名：工具描述和测试都按这个名字找。
    try:
        for klass in layer.listLabelClasses():
            info["classes"].append({
                "name": klass.name,
                "visible": arcutil.to_jsonable(getattr(klass, "visible", None)),
                "expression": arcutil.to_jsonable(getattr(klass, "expression", None)),
                "SQLQuery": arcutil.to_jsonable(getattr(klass, "SQLQuery", None)),
            })
    except Exception:
        pass
    info["labelClasses"] = info["classes"]
    info["expression"] = next(
        (c["expression"] for c in info["classes"] if c.get("expression")), None)
    return info


def op_label_set(params):
    """开关标注、改标注表达式。

    `LabelClass` 只有 6 个成员（SQLQuery / expression / getDefinition /
    setDefinition / name / visible）——字体、字号、偏移都不在这层，那要走
    CIM（getDefinition/setDefinition）。所以这里只做"开标注、换字段、加过滤"。
    """
    aprx, _path = _project(params)
    _one_map, layer, _parent = _find_layer(aprx, params.get("layer"), params.get("map"))
    if not layer.supports("SHOWLABELS"):
        raise RuntimeError("图层 %r 不支持标注。" % layer.name)

    changed = {}
    if params.get("visible") is not None:
        layer.showLabels = bool(params["visible"])
        changed["showLabels"] = layer.showLabels

    classes = list(layer.listLabelClasses())
    if not classes:
        # 要素图层默认没有标注类。要给表达式就得先建一个，否则下面
        # targets 为空会一直报"找不到标注类"。CIM 引擎下这个图层级开关
        # 必须打开，createLabelClass 才不会抛。
        try:
            layer.showLabels = True
            klass = layer.createLabelClass(str(params.get("labelClass") or "Class 1"))
        except Exception as exc:
            raise RuntimeError(
                "图层 %r 还没有标注类，自动创建也失败了：%s。"
                "先把标注引擎切成 CIM（工程设置 → 标注），或手动建一个标注类。" % (layer.name, exc))
        classes = [klass]

    wanted = str(params.get("labelClass") or "").strip()
    targets = [c for c in classes if not wanted or c.name == wanted]
    if not targets:
        raise ValueError("找不到标注类 %r。现有：%s"
                         % (wanted, ", ".join(c.name for c in classes) or "(无)"))

    expression = params.get("expression")
    query = params.get("where")
    touched = []
    for klass in targets:
        if expression is not None:
            klass.expression = str(expression)
        if query is not None:
            klass.SQLQuery = str(query)
        if params.get("labelVisible") is not None:
            klass.visible = bool(params["labelVisible"])
        touched.append(klass.name)

    info = _label_info(layer)
    info["changed"] = changed
    info["touched"] = touched
    return info


# ---------------------------------------------------------------------------
# 书签
# ---------------------------------------------------------------------------

def op_bookmark_list(params):
    aprx, _path = _project(params)
    one_map = _find_map(aprx, params.get("map"))
    items = []
    for bookmark in one_map.listBookmarks():
        items.append({
            "name": bookmark.name,
            "description": arcutil.to_jsonable(getattr(bookmark, "description", None)),
        })
    return {"map": one_map.name, "bookmarks": items, "count": len(items)}


def op_bookmark_create(params):
    """把当前视图存为书签（之后可以跳回去）。"""
    aprx, _path = _project(params)
    one_map = _find_map(aprx, params.get("map"))
    name = str(params.get("name") or "").strip()
    if name == "":
        raise ValueError("需要 name（书签名）。")
    if not callable(getattr(one_map, "createBookmark", None)):
        raise RuntimeError(
            "这个 Pro 版本的 Map 对象没有 createBookmark。实测 Map 成员里没有它，"
            "书签只能在有窗口的工程里从视图存；无窗口工程用 bookMark.import 导入现成的 json。"
        )
    try:
        created = one_map.createBookmark(name)
    except Exception as exc:
        raise RuntimeError("建书签失败：%s" % exc)
    return {"map": one_map.name, "bookmark": getattr(created, "name", name)}


def op_bookmark_remove(params):
    aprx, _path = _project(params)
    one_map = _find_map(aprx, params.get("map"))
    name = str(params.get("name") or "").strip()
    if name == "":
        raise ValueError("需要 name（书签名）。")
    try:
        one_map.removeBookmark(name)
    except Exception as exc:
        raise RuntimeError("删书签 %r 失败：%s。现有：%s"
                           % (name, exc, ", ".join(b.name for b in one_map.listBookmarks()) or "(无)"))
    return {"map": one_map.name, "removed": name,
            "bookmarks": [b.name for b in one_map.listBookmarks()]}


def op_bookmark_export(params):
    aprx, _path = _project(params)
    one_map = _find_map(aprx, params.get("map"))
    target = str(params.get("output") or "").strip()
    if target == "":
        raise ValueError("需要 output（.json 路径）。")
    parent = os.path.dirname(os.path.abspath(target))
    if parent and not os.path.isdir(parent):
        os.makedirs(parent, exist_ok=True)
    try:
        one_map.exportBookmarks(target)
    except Exception as exc:
        raise RuntimeError("导出书签失败：%s" % exc)
    return {"map": one_map.name, "output": target,
            "bytes": os.path.getsize(target) if os.path.exists(target) else None}


def op_bookmark_import(params):
    aprx, _path = _project(params)
    one_map = _find_map(aprx, params.get("map"))
    source = str(params.get("input") or "").strip()
    if source == "":
        raise ValueError("需要 input（.json 路径）。")
    if not os.path.exists(source):
        raise FileNotFoundError("书签文件不存在：%s" % source)
    try:
        one_map.importBookmarks(source)
    except Exception as exc:
        raise RuntimeError("导入书签失败：%s" % exc)
    return {"map": one_map.name, "bookmarks": [b.name for b in one_map.listBookmarks()]}


# ---------------------------------------------------------------------------
# 样式 / 符号
# ---------------------------------------------------------------------------

def op_style_list(params):
    """列工程里挂着的样式库。"""
    aprx, _path = _project(params)
    return _names_payload("styles", aprx.styles)


def op_colorramp_list(params):
    """列色带名（唯一值/分级符号要用）。"""
    aprx, _path = _project(params)
    names = _list_names(aprx.listColorRamps())
    keyword = str(params.get("search") or "").strip().lower()
    total = len(names)
    if keyword:
        names = [n for n in names if keyword in n.lower()]
    return {"colorRamps": names, "count": len(names), "total": total}


def op_layer_symbology_apply(params):
    """从 .lyrx 或样式库条目套用符号系统。

    `ApplySymbologyFromLayer` 是真 GP 工具；但也支持直接用样板图层对象。
    """
    aprx, _path = _project(params)
    _m, layer, _p = _find_layer(aprx, params.get("layer"), params.get("map"))
    source = str(params.get("symbologyLayer") or "").strip()
    if source == "":
        raise ValueError("需要 symbologyLayer（.lyrx 或图层文件的路径）。")
    if not os.path.exists(source):
        raise FileNotFoundError("符号模板不存在：%s" % source)
    try:
        import arcpy

        arcpy.management.ApplySymbologyFromLayer(layer, source)
    except Exception as exc:
        raise RuntimeError("套用符号失败：%s。样板图层要和目标图层几何类型一致。" % exc)
    return {"layer": layer.name, "applied": source}


# ---------------------------------------------------------------------------
# 报表
# ---------------------------------------------------------------------------

def op_report_list(params):
    aprx, _path = _project(params)
    items = []
    try:
        for report in aprx.listReports():
            items.append({"name": report.name})
    except Exception:
        pass
    return {"reports": items, "count": len(items)}


# ---------------------------------------------------------------------------
# 地图文档级
# ---------------------------------------------------------------------------

def op_map_definition(params):
    """读地图的 CIM 定义（要动 Pro 没暴露的东西时，从这里下手）。

    坑：`Map.getDefinition("V3")` 返回的是 **CIMMap 对象**——
    既没有 `toJSON()` 也不是 dict，`arcutil.to_jsonable()` 直接把它折成了
    地图名字符串。真实结构只能按 `dir()` 的公开成员名取，每个成员就是定义
    里的一个键（实测 60+ 个：layers / defaultCamera / referenceScale / …）。
    """
    aprx, _path = _project(params)
    one_map = _find_map(aprx, params.get("map"))
    try:
        definition = one_map.getDefinition("V3")
    except Exception as exc:
        raise RuntimeError("取地图定义失败：%s" % exc)

    payload = {"map": one_map.name, "definitionType": type(definition).__name__}
    # CIM 对象既没有 toJSON() 也不是 dict，但每个属性就是定义里的一个键。
    # 所以直接按公开成员名取键——这才是唯一可靠的键清单。
    members = [a for a in dir(definition) if not a.startswith("_")]
    if members:
        payload["keyCount"] = len(members)
        payload["keys"] = members
        if params.get("full"):
            payload["definition"] = {k: arcutil.to_jsonable(
                getattr(definition, k, None)) for k in members}
        return payload
    text = arcutil.to_jsonable(definition)
    payload["preview"] = repr(text)[:200]
    return payload


def op_map_color_model(params):
    """读或改地图色彩模式（RGB / CMYK）。出印刷品时用 CMYK。"""
    aprx, _path = _project(params)
    one_map = _find_map(aprx, params.get("map"))
    want = params.get("colorModel")
    if want is None:
        return {"map": one_map.name,
                "colorModel": arcutil.to_jsonable(getattr(one_map, "colorModel", None))}
    text = str(want).strip().upper()
    if text not in ("RGB", "CMYK"):
        raise ValueError("colorModel 只接受 RGB / CMYK。")
    try:
        one_map.setColorModel(text)
    except Exception as exc:
        raise RuntimeError("设置色彩模式失败：%s" % exc)
    return {"map": one_map.name, "colorModel": text}


def op_map_reference_scale(params):
    aprx, _path = _project(params)
    one_map = _find_map(aprx, params.get("map"))
    scale = params.get("scale")
    if scale is None:
        return {"map": one_map.name,
                "referenceScale": arcutil.to_jsonable(getattr(one_map, "referenceScale", None))}
    try:
        one_map.referenceScale = float(scale)
    except Exception as exc:
        raise RuntimeError("设置参考比例尺失败：%s" % exc)
    return {"map": one_map.name, "referenceScale": float(scale)}


def _layer_target(params):
    aprx, _path = _project(params)
    return _find_layer(aprx, params.get("layer"), params.get("map"))


HANDLERS = {
    "basemap.list": op_basemap_list,
    "layer.add": op_layer_add,
    "layer.move": op_layer_move,
    "layer.group": op_layer_group,
    "layer.toggle": op_layer_toggle,
    "layer.export": op_layer_export,
    "table.list": op_table_list,
    "table.add": op_table_add,
    "label.info": op_label_info,
    "label.set": op_label_set,
    "bookmark.list": op_bookmark_list,
    "bookmark.create": op_bookmark_create,
    "bookmark.remove": op_bookmark_remove,
    "bookmark.export": op_bookmark_export,
    "bookmark.import": op_bookmark_import,
    "style.list": op_style_list,
    "colorramp.list": op_colorramp_list,
    "layer.symbology_apply": op_layer_symbology_apply,
    "report.list": op_report_list,
    "map.definition": op_map_definition,
    "map.color_model": op_map_color_model,
    "map.reference_scale": op_map_reference_scale,
}
