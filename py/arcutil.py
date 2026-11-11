"""
arcpy 客体与 JSON 之间的转换层。

单独成模块是因为 bridge.py（协议）和 ops_*.py（操作）都要用它，而 ops 又被
bridge 导入——放在任一侧都会形成循环导入。`import arcpy` 在同一进程里只真正
执行一次，重复导入不付第二次成本。
"""

import os
import sys

try:
    import arcpy
except Exception:  # pragma: no cover
    arcpy = None
    _IMPORT_ERROR = sys.exc_info()
else:
    _IMPORT_ERROR = None


def api():
    """返回 arcpy 模块；不可用时抛出可读错误。"""
    if arcpy is None:
        raise RuntimeError("arcpy 不可用：" + repr(_IMPORT_ERROR))
    return arcpy


def available():
    return arcpy is not None


def exists(path):
    """数据集是否真的存在。

    不能用 os.path.exists 判断：gdb 里的要素类（x.gdb/点要素）不是文件系统
    路径，会一律判成缺失。arcpy.Exists 认这些，异常时才退回文件检查。
    """
    if not isinstance(path, str) or path == "":
        return False
    try:
        return bool(api().Exists(path))
    except Exception:
        return os.path.exists(path)


def is_available():
    return arcpy is not None


def to_jsonable(value):
    """
    转成能过 `json.dumps(allow_nan=False)` 的结构。

    GP 输出出现 NaN/Infinity 是常态（空栅格统计、除零比例），而 JSON 没有这两个
    字面量；Python 的 dumps 默认会写出非法 JSON `NaN`，JS 侧 JSON.parse 直接报错。
    非有限浮点一律转 null：用 0 代替等于伪装成一次真实测量，null 才是"未知"。
    """
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            return None
        return value
    if isinstance(value, (list, tuple)):
        return [to_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {str(k): to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (bytes, bytearray)):
        return bytes(value).decode("utf-8", "replace")
    if arcpy is not None:
        for probe in (_spatial_ref_summary, _extent_summary, _geometry_summary):
            summarized = probe(value)
            if summarized is not None:
                return summarized
        for attr in ("name", "label", "path"):
            try:
                text = getattr(value, attr)
            except Exception:
                continue
            if isinstance(text, str) and text != "":
                return text
    try:
        return str(value)
    except Exception:
        return "<unserializable %s>" % type(value).__name__


def _spatial_ref_summary(value):
    """空间参考摘要。

    不能只靠 isinstance：Describe(...).spatialReference 拿到的是
    "geoprocessing spatial reference object"，isinstance 判不出真，于是会掉进
    兜底分支只返回一个坐标系名字（wkid 全丢）。这里改成鸭子类型——有
    exportToString 和 factoryCode 就按空间参考处理。

    wkid 也走 factoryCode：实测投影坐标系（如 EPSG:3857）的 .wkid 是 None，
    真正带码的是 .factoryCode。
    """
    try:
        looks_like_sr = isinstance(value, arcpy.SpatialReference) or (
            hasattr(value, "exportToString") and hasattr(value, "factoryCode")
        )
        if looks_like_sr:
            summary = {
                "name": value.name,
                "wkid": value.factoryCode,
                "type": getattr(value, "type", None),
                "wkt": value.exportToString(),
            }
            if summary["wkid"] is None:
                summary["wkid"] = getattr(value, "PCSCode", None) or getattr(value, "GCSCode", None)
            return summary
    except Exception:
        return None
    return None


def _extent_summary(value):
    try:
        if isinstance(value, arcpy.Extent):
            return {
                "xMin": value.XMin, "yMin": value.YMin,
                "xMax": value.XMax, "yMax": value.YMax,
                "spatialReference": _spatial_ref_summary(value.spatialReference) or value.spatialReference.name,
            }
    except Exception:
        return None
    return None


def _geometry_summary(value):
    try:
        if isinstance(value, arcpy.Geometry):
            return {
                "type": value.type,
                "area": value.area,
                "length": value.length,
                "extent": _extent_summary(value.extent),
            }
    except Exception:
        return None
    return None


def coerce(value):
    """
    把 JSON 值转成 arcpy 接受的参数对象。

    用 `__arcpy__` 显式标记需要构造的类型；其余原样透传——arcpy 本身能吃路径
    字符串、数字、字符串和 list，过度转换反而会毁掉 "10 Meters"、SQL 表达式
    这类依赖原始字面量的参数。
    """
    if isinstance(value, dict):
        kind = value.get("__arcpy__")
        if kind is not None:
            return _construct(kind, value)
        return {k: coerce(v) for k, v in value.items() if k != "__arcpy__"}
    if isinstance(value, list):
        return [coerce(v) for v in value]
    return value


def _construct(kind, spec):
    mod = api()
    if kind == "SpatialReference":
        return spatial_reference(spec)
    if kind == "Point":
        return mod.Point(
            spec.get("x", 0.0), spec.get("y", 0.0),
            spec.get("z"), spec.get("m"),
        )
    if kind == "Array":
        arr = mod.Array()
        for pt in spec.get("points") or []:
            arr.add(mod.Point(pt[0], pt[1]))
        return arr
    if kind == "Extent":
        return mod.Extent(spec["xMin"], spec["yMin"], spec["xMax"], spec["yMax"],
                          spatial_reference(spec["spatialReference"])
                          if isinstance(spec.get("spatialReference"), dict) else None)
    if kind == "ValueTable":
        columns = int(spec.get("columns") or 2)
        table = mod.ValueTable(columns)
        for row in spec.get("rows") or []:
            table.addRow(row)
        return table
    raise ValueError("未知的 __arcpy__ 类型：%r" % (kind,))


def spatial_reference(spec):
    """
    SpatialReference 的几种写法。

    实测这些都能被 arcpy 接受：wkid/epsg 数字、WKT 文本、坐标系名称、以及
    "EPSG:3857" 这种带前缀字符串（arcpy 自己解析）。
    """
    mod = api()
    if spec is None:
        return None
    if isinstance(spec, str):
        text = spec.strip()
        if text == "":
            return None
        if text.upper().startswith("EPSG:"):
            return mod.SpatialReference(int(text.split(":", 1)[1]))
        if text.isdigit():
            return mod.SpatialReference(int(text))
        return mod.SpatialReference(text=text)
    if isinstance(spec, int):
        return mod.SpatialReference(spec)
    if not isinstance(spec, dict):
        return mod.SpatialReference(spec)
    for key in ("wkid", "epsg", "factoryCode"):
        if spec.get(key) is not None:
            return mod.SpatialReference(int(spec[key]))
    if spec.get("wkt"):
        return mod.SpatialReference(text=str(spec["wkt"]))
    if spec.get("name"):
        return mod.SpatialReference(text=str(spec["name"]))
    raise ValueError("SpatialReference 需要 wkid / epsg / wkt / name 之一")


def drain_messages():
    """取走本次调用累积的 GP 消息；失败时返回空串而不是再抛一次。"""
    if arcpy is None:
        return ""
    try:
        text = arcpy.GetMessages()
    except Exception:
        return ""
    return "" if text is None else str(text)
