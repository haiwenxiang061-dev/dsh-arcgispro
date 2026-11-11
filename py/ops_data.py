"""
数据层：要素类 / 表格 / 栅格 / 地理数据库。

这里做的是"从外部看数据"和"从外部改数据"——读取 schema、按条件取行、
写行、算字段、建要素类。符号系统、地图排版那类属于 ops_project。

写入类操作（insert / update / delete / calculate / create / delete_fields）
在 Node 侧有写盘闸门；Python 侧不做额外限制，否则桥和宿主会出现两套规则。
"""

import datetime
import os

import arcutil

_MAX_ROWS = 10000
_DEFAULT_ROWS = 100

# 编辑类处理器：Node 侧的写入闸门按这些名字放行
WRITE_OPS = frozenset([
    "data.insert", "data.update", "data.delete", "data.calculate_field",
    "data.create_featureclass", "data.add_field", "data.delete_field",
    "data.create_table", "data.delete_rows", "data.copy",
])


def api():
    return arcutil.api()


def _require(value, what):
    text = str(value or "").strip()
    if text == "":
        raise ValueError("需要 %s。" % what)
    return text


def _dataset(path):
    """
    校验数据集存在，并返回规范路径。

    不能用 `os.path.exists` 判断：地理数据库里的要素类不是文件系统路径
    （`x.gdb/点要素` 在磁盘上并不存在这个目录项），只有 `arcpy.Exists`
    认得它。shp、.tif 这类单文件两种判断都成立，所以先问 arcpy。
    """
    text = _require(path, "数据集路径（dataset）")
    mod = api()
    try:
        exists = bool(mod.Exists(text))
    except Exception:
        exists = os.path.exists(text)
    if not exists:
        raise FileNotFoundError("数据集不存在：%s" % text)
    return text


# ---------------------------------------------------------------------------
# 值序列化
# ---------------------------------------------------------------------------

def _serialize(value):
    """把游标里取出来的值转成可 JSON 化、且不丢信息的形式。"""
    if value is None:
        return None
    if isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        # 非有限浮点会让 JSON 校验失败，统一转 null 并保留原值文本
        if value != value or value in (float("inf"), float("-inf")):
            return None
        return value
    if isinstance(value, datetime.datetime):
        return value.isoformat()
    if isinstance(value, datetime.date):
        return value.isoformat()
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8")
        except Exception:
            return value.hex()
    # 几何：WKT 比 GeoJSON 短，且足够重建
    try:
        wkt = value.WKT
        if isinstance(wkt, str) and wkt:
            return {"wkt": wkt, "type": arcutil.to_jsonable(getattr(value, "type", None)),
                    "area": arcutil.to_jsonable(getattr(value, "area", None)),
                    "length": arcutil.to_jsonable(getattr(value, "length", None))}
    except Exception:
        pass
    converted = arcutil.to_jsonable(value)
    if isinstance(converted, (dict, list, str, int, float, bool)) or converted is None:
        return converted
    return str(converted)


def _to_geometry(value, spatial_reference=None):
    """把模型给的几何描述变成 arcpy 几何对象。

    接受三种写法：WKT 字符串、GeoJSON 风格的 dict（带 type/coordinates）、
    以及 {"__arcpy__":"Point","x":..,"y":..} 这种显式标记。
    """
    mod = api()
    if value is None:
        return None
    if isinstance(value, str):
        text = value.strip()
        if text == "":
            return None
        try:
            return mod.FromWKT(text, spatial_reference)
        except Exception as exc:
            raise ValueError("无法把这段文本解析成几何（需要 WKT）：%s" % exc)
    if isinstance(value, dict):
        if value.get("__arcpy__"):
            return arcutil.coerce(value)
        if "wkt" in value:
            return mod.FromWKT(str(value["wkt"]), spatial_reference)
        if "type" in value and "coordinates" in value:
            shape = arcutil.coerce(value)
            geom = mod.AsShape(shape, True)
            if spatial_reference is not None:
                geom.spatialReference = spatial_reference
            return geom
        if "x" in value and "y" in value:
            point = mod.Point(float(value["x"]), float(value["y"]))
            return mod.PointGeometry(point, spatial_reference)
        if "points" in value:
            array = mod.Array()
            for pair in value["points"]:
                array.add(mod.Point(float(pair[0]), float(pair[1])))
            return mod.Polyline(array, spatial_reference)
    raise ValueError("无法识别的几何描述：%r" % (value,))


# ---------------------------------------------------------------------------
# 描述与 schema
# ---------------------------------------------------------------------------

_DESCRIBE_KEYS = [
    "dataType", "shapeType", "hasZ", "hasM", "hasSpatialIndex",
    "baseName", "name", "catalogPath", "file", "path", "workspaceType",
    "childrenType", "extension", "isInteger", "isRasterDataset",
    "canVersion", "changeTracked", "editorTrackingEnabled",
]


def op_data_describe(params):
    dataset = _dataset(params.get("dataset") or params.get("path"))
    mod = api()
    described = mod.Describe(dataset)
    result = {"dataset": dataset}
    for key in _DESCRIBE_KEYS:
        try:
            result[key] = arcutil.to_jsonable(getattr(described, key))
        except Exception:
            continue
    for key in ("extent", "spatialReference", "spatialIndex", "domain",
                "rasterBandInfo", "pixelType", "pixelSizeX", "pixelSizeY",
                "bandCount", "meanCellHeight", "meanCellWidth", "format"):
        try:
            value = getattr(described, key)
            if value is not None:
                result[key] = arcutil.to_jsonable(value)
        except Exception:
            continue
    try:
        result["fields"] = [
            {"name": f.name, "type": f.type,
             "length": arcutil.to_jsonable(f.length),
             "alias": arcutil.to_jsonable(getattr(f, "aliasName", None)),
             "nullable": arcutil.to_jsonable(getattr(f, "isNullable", None)),
             "editable": arcutil.to_jsonable(getattr(f, "editable", None))}
            for f in mod.ListFields(dataset)
        ]
    except Exception as exc:
        result["fieldsError"] = "%s: %s" % (type(exc).__name__, exc)
    try:
        result["count"] = int(mod.management.GetCount(dataset)[0])
    except Exception:
        pass
    try:
        result["indexes"] = [
            {"name": idx.name, "fields": arcutil.to_jsonable(idx.fields),
             "isUnique": arcutil.to_jsonable(getattr(idx, "isUnique", None)),
             "isAscending": arcutil.to_jsonable(getattr(idx, "isAscending", None))}
            for idx in mod.ListIndexes(dataset)
        ]
    except Exception:
        pass
    return result


def op_data_list(params):
    """
    列出工作空间里的内容；不给 workspace 就用当前 env.workspace。

    ListFeatureClasses / ListRasters / ListTables / ListDatasets 只接受
    (wild_card, type) 两个参数——工作空间必须通过 `arcpy.env.workspace` 交给
    它们，直接当第三参数传会 TypeError。所以这里临时改 env 再还原。
    """
    mod = api()
    workspace = str(params.get("workspace") or "").strip() or None
    wildcard = str(params.get("wildcard") or "*")
    if workspace is not None and not mod.Exists(workspace) and not os.path.isdir(workspace):
        raise FileNotFoundError("工作空间不存在：%s" % workspace)

    previous = None
    if workspace is not None:
        previous = mod.env.workspace
        mod.env.workspace = workspace
    try:
        out = {}
        # Pro 3.6 实测没有 arcpy.ListTopologies —— 版本间函数名有增删，
        # 用 getattr 探测而不是硬编码，缺的函数直接不出现，别把整个列举拖挂。
        for key, attr in (
            ("featureClasses", "ListFeatureClasses"),
            ("rasterDatasets", "ListRasters"),
            ("tables", "ListTables"),
            ("datasets", "ListDatasets"),
            ("topologies", "ListTopologies"),
            ("workspaces", "ListWorkspaces"),
        ):
            lister = getattr(mod, attr, None)
            if lister is None:
                continue
            try:
                values = lister(wildcard)
                out[key] = list(values) if values is not None else []
            except Exception as exc:
                out[key] = []
                out[key + "Error"] = "%s: %s" % (type(exc).__name__, exc)
    finally:
        if previous is not None:
            mod.env.workspace = previous

    out["workspace"] = workspace if workspace is not None else arcutil.to_jsonable(mod.env.workspace)
    out["counts"] = {key: len(value) for key, value in out.items() if isinstance(value, list)}
    return out


def op_data_fields(params):
    dataset = _dataset(params.get("dataset") or params.get("path"))
    mod = api()
    fields = []
    for f in mod.ListFields(dataset):
        entry = {"name": f.name, "type": f.type}
        for attr in ("length", "aliasName", "isNullable", "editable", "precision",
                     "scale", "required", "domain", "defaultValue"):
            try:
                entry[attr] = arcutil.to_jsonable(getattr(f, attr))
            except Exception:
                continue
        fields.append(entry)
    return {"dataset": dataset, "count": len(fields), "fields": fields}


# ---------------------------------------------------------------------------
# 读行
# ---------------------------------------------------------------------------

def _resolve_fields(dataset, requested):
    mod = api()
    available = [f.name for f in mod.ListFields(dataset)]
    if not requested:
        return available, available
    if isinstance(requested, str):
        requested = [requested]
    chosen = []
    lookup = {name.lower(): name for name in available}
    for name in requested:
        text = str(name).strip()
        if text in available:
            chosen.append(text)
        elif text.lower() in lookup:
            chosen.append(lookup[text.lower()])
        else:
            raise ValueError("字段 %r 不存在。可用字段：%s" % (name, ", ".join(available)))
    return chosen, available


def op_data_query(params):
    """
    按条件读行。

    fields 不传就读全部字段；geometry 字段会被转成 WKT + 类型/面积/长度。
    limit 默认 100，上限 10000——不做分页是因为 Pro 侧游标本身就要顺序扫，
    真需要全量时让模型自己用 where 收窄。
    """
    dataset = _dataset(params.get("dataset") or params.get("path"))
    mod = api()
    fields, available = _resolve_fields(dataset, params.get("fields"))
    where = params.get("where") or params.get("whereClause") or ""
    where = str(where).strip()

    limit = int(params.get("limit") or _DEFAULT_ROWS)
    if limit <= 0:
        limit = _DEFAULT_ROWS
    limit = min(limit, _MAX_ROWS)
    offset = max(0, int(params.get("offset") or 0))

    sr = None
    if params.get("spatialReference") is not None:
        sr = arcutil.spatial_reference(params["spatialReference"])

    cursor_kwargs = {}
    if sr is not None:
        cursor_kwargs["spatial_reference"] = sr

    # 实测 Pro 3.6：把 Shape 字段的普通名字喂给 SearchCursor 只会拿回一个坐标
    # 元组（点）或元组列表（面），不是几何对象，WKT 全丢。必须用 "SHAPE@"
    # 这个显式 token，输出里再换回原字段名，模型那边看不出区别。
    shape_field = None
    try:
        shape_field = mod.Describe(dataset).shapeFieldName
    except Exception:
        shape_field = None
    tokens = ["SHAPE@" if (shape_field and f == shape_field) else f for f in fields]

    rows = []
    truncated = False
    with mod.da.SearchCursor(dataset, tokens, where, **cursor_kwargs) as cursor:
        for index, row in enumerate(cursor):
            if index < offset:
                continue
            if len(rows) >= limit:
                truncated = True
                break
            rows.append([_serialize(value) for value in row])

    result = {
        "dataset": dataset,
        "fields": fields,
        "availableFields": available,
        "where": where,
        "limit": limit,
        "offset": offset,
        "returned": len(rows),
        "truncated": truncated,
        "rows": rows,
    }
    if not truncated:
        # 只有确定没截断时才报总数，避免多扫一遍全表
        try:
            result["total"] = int(mod.management.GetCount(dataset)[0])
        except Exception:
            pass
    return result


def op_data_statistics(params):
    """对某个字段做基本统计（不落表，直接算）。"""
    dataset = _dataset(params.get("dataset") or params.get("path"))
    mod = api()
    field = _require(params.get("field"), "字段名（field）")
    values = []
    with mod.da.SearchCursor(dataset, [field]) as cursor:
        for row in cursor:
            value = row[0]
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                values.append(float(value))
            if len(values) >= _MAX_ROWS * 10:
                break
    if not values:
        return {"dataset": dataset, "field": field, "count": 0,
                "note": "该字段没有数值。"}
    values.sort()
    total = len(values)
    return {
        "dataset": dataset,
        "field": field,
        "count": total,
        "min": values[0],
        "max": values[-1],
        "mean": sum(values) / total,
        "median": values[total // 2] if total % 2 else (values[total // 2 - 1] + values[total // 2]) / 2.0,
        "truncated": total >= _MAX_ROWS * 10,
    }


# ---------------------------------------------------------------------------
# 写行
# ---------------------------------------------------------------------------

def _normalize_rows(rows, fields):
    if not isinstance(rows, list) or not rows:
        raise ValueError("需要 rows（非空数组）。")
    prepared = []
    for index, row in enumerate(rows):
        if isinstance(row, dict):
            missing = [name for name in fields if name not in row]
            if missing:
                raise ValueError("第 %d 行缺少字段：%s" % (index, ", ".join(missing)))
            prepared.append([row[name] for name in fields])
        elif isinstance(row, list):
            if len(row) != len(fields):
                raise ValueError("第 %d 行有 %d 个值，但 fields 有 %d 个。"
                                 % (index, len(row), len(fields)))
            prepared.append(list(row))
        else:
            raise ValueError("第 %d 行既不是对象也不是数组。" % index)
    return prepared


def op_data_insert(params):
    dataset = _dataset(params.get("dataset") or params.get("path"))
    mod = api()
    rows = params.get("rows")
    requested = params.get("fields")
    if isinstance(rows, list) and rows and isinstance(rows[0], dict):
        fields = [str(name) for name in rows[0].keys()]
    else:
        fields = [str(name) for name in (requested or [])]
    if not fields:
        raise ValueError("需要 fields（要写入的字段顺序），或让 rows 用对象形式给出行。")

    sr = None
    if params.get("spatialReference") is not None:
        sr = arcutil.spatial_reference(params["spatialReference"])
    else:
        try:
            sr = mod.Describe(dataset).spatialReference
        except Exception:
            sr = None

    geometry_fields = set()
    for name in fields:
        lowered = name.lower()
        if lowered in ("shape", "geometry", "shape@", "shape@"):
            geometry_fields.add(name)
        elif lowered.endswith("@") or "@" in lowered:
            geometry_fields.add(name)

    prepared = _normalize_rows(rows, fields)
    converted = []
    for row in prepared:
        out = []
        for name, value in zip(fields, row):
            if name in geometry_fields or (isinstance(value, dict) and
                                           ("wkt" in value or "coordinates" in value
                                            or value.get("__arcpy__"))):
                out.append(_to_geometry(value, sr))
            else:
                out.append(arcutil.coerce(value))
        converted.append(out)

    with mod.da.InsertCursor(dataset, fields) as cursor:
        for row in converted:
            cursor.insertRow(row)
    return {"dataset": dataset, "inserted": len(converted), "fields": fields}


def op_data_update(params):
    dataset = _dataset(params.get("dataset") or params.get("path"))
    mod = api()
    where = str(params.get("where") or params.get("whereClause") or "").strip()
    changes = params.get("changes") or params.get("values")
    if not isinstance(changes, dict) or not changes:
        raise ValueError("需要 changes（{字段: 新值}）。")
    fields = list(changes.keys())
    existing = [f.name for f in mod.ListFields(dataset)]
    geometry_fields = {name for name in fields if "@" in name or name.lower() == "shape"}
    for name in fields:
        if name not in existing and name not in geometry_fields:
            raise ValueError("字段 %r 不存在。可用字段：%s" % (name, ", ".join(existing)))

    sr = None
    try:
        sr = mod.Describe(dataset).spatialReference
    except Exception:
        pass

    cursor_fields = list(fields)
    if not any(f.lower() == "shape" or "@" in f for f in cursor_fields):
        cursor_fields.append("OID@")

    updated = 0
    with mod.da.UpdateCursor(dataset, cursor_fields, where) as cursor:
        for row in cursor:
            values = list(row)
            for index, name in enumerate(fields):
                raw = changes[name]
                if name in geometry_fields:
                    values[index] = _to_geometry(raw, sr)
                else:
                    values[index] = arcutil.coerce(raw)
            cursor.updateRow(values)
            updated += 1
    return {"dataset": dataset, "where": where, "updated": updated, "fields": fields}


def op_data_delete(params):
    """按条件删行。where 为空且 allow_all 不为真时拒绝——防手滑清表。"""
    dataset = _dataset(params.get("dataset") or params.get("path"))
    mod = api()
    where = str(params.get("where") or params.get("whereClause") or "").strip()
    if where == "" and params.get("allowAll") is not True:
        raise ValueError("where 为空会删掉整张表。确实要清空请传 allowAll: true。")
    deleted = 0
    with mod.da.UpdateCursor(dataset, ["OID@"], where) as cursor:
        for _row in cursor:
            cursor.deleteRow()
            deleted += 1
    return {"dataset": dataset, "where": where, "deleted": deleted}


def op_data_calculate_field(params):
    dataset = _dataset(params.get("dataset") or params.get("path"))
    mod = api()
    field = _require(params.get("field"), "字段名（field）")
    expression = _require(params.get("expression"), "表达式（expression）")
    expression_type = str(params.get("expressionType") or "PYTHON3")
    where = params.get("where") or None
    if where is not None and str(where).strip() == "":
        where = None
    mod.management.CalculateField(dataset, field, expression, expression_type, where)
    return {"dataset": dataset, "field": field, "expression": expression,
            "expressionType": expression_type, "where": where}


# ---------------------------------------------------------------------------
# 建 / 删 schema
# ---------------------------------------------------------------------------

_GEOMETRY_TYPES = {
    "point": "POINT", "multipoint": "MULTIPOINT", "polyline": "POLYLINE",
    "polygon": "POLYGON", "line": "POLYLINE", "poly": "POLYGON",
}

_FIELD_TYPES = {
    "text": "TEXT", "string": "TEXT", "long": "LONG", "integer": "LONG",
    "short": "SHORT", "double": "DOUBLE", "float": "FLOAT", "date": "DATE",
    "blob": "BLOB", "guid": "GUID", "oid": "OID", "bigint": "BIGINT",
    "raster": "RASTER", "timestamp": "TIMESTAMP_OFFSET",
}


def op_data_create_featureclass(params):
    mod = api()
    out_path = _require(params.get("outPath") or params.get("path"), "输出路径（outPath）")
    name = _require(params.get("name"), "要素类名（name）")
    geometry = str(params.get("geometryType") or "POINT").strip().lower()
    geometry_type = _GEOMETRY_TYPES.get(geometry, geometry.upper())

    parent = os.path.dirname(os.path.abspath(out_path))
    if parent and not os.path.isdir(parent):
        raise FileNotFoundError("输出工作空间不存在：%s" % out_path)

    template = params.get("template") or None
    if template is not None and not os.path.exists(str(template)):
        raise FileNotFoundError("模板不存在：%s" % template)

    sr = None
    if params.get("spatialReference") is not None:
        sr = arcutil.spatial_reference(params["spatialReference"])

    has_m = bool(params.get("hasM") or False)
    has_z = bool(params.get("hasZ") or False)

    created = mod.management.CreateFeatureclass(
        out_path, name, geometry_type, template,
        "DISABLED" if not has_m else "ENABLED",
        "DISABLED" if not has_z else "ENABLED",
        sr,
    )
    created_path = str(created)
    added = []
    for spec in (params.get("fields") or []):
        field_name = spec.get("name")
        raw_type = str(spec.get("type") or "TEXT").strip()
        field_type = _FIELD_TYPES.get(raw_type.lower(), raw_type.upper())
        length = spec.get("length")
        alias = spec.get("alias")
        kwargs = {}
        if length is not None:
            kwargs["field_length"] = int(length)
        if alias:
            kwargs["field_alias"] = str(alias)
        mod.management.AddField(created_path, field_name, field_type, **kwargs)
        added.append({"name": field_name, "type": field_type})
    return {"created": created_path, "geometryType": geometry_type,
            "spatialReference": arcutil.to_jsonable(getattr(created, "spatialReference", None)),
            "fieldsAdded": added}


def op_data_create_table(params):
    mod = api()
    out_path = _require(params.get("outPath") or params.get("path"), "输出路径（outPath）")
    name = _require(params.get("name"), "表名（name）")
    created = mod.management.CreateTable(out_path, name)
    created_path = str(created)
    added = []
    for spec in (params.get("fields") or []):
        raw_type = str(spec.get("type") or "TEXT").strip()
        field_type = _FIELD_TYPES.get(raw_type.lower(), raw_type.upper())
        kwargs = {}
        if spec.get("length") is not None:
            kwargs["field_length"] = int(spec["length"])
        if spec.get("alias"):
            kwargs["field_alias"] = str(spec["alias"])
        mod.management.AddField(created_path, spec.get("name"), field_type, **kwargs)
        added.append({"name": spec.get("name"), "type": field_type})
    return {"created": created_path, "fieldsAdded": added}


def op_data_add_field(params):
    dataset = _dataset(params.get("dataset") or params.get("path"))
    mod = api()
    name = _require(params.get("name") or params.get("field"), "字段名（name）")
    raw_type = str(params.get("type") or "TEXT").strip()
    field_type = _FIELD_TYPES.get(raw_type.lower(), raw_type.upper())
    kwargs = {}
    if params.get("length") is not None:
        kwargs["field_length"] = int(params["length"])
    if params.get("alias"):
        kwargs["field_alias"] = str(params["alias"])
    if params.get("nullable") is False:
        kwargs["field_is_nullable"] = "NON_NULLABLE"
    mod.management.AddField(dataset, name, field_type, **kwargs)
    return {"dataset": dataset, "added": {"name": name, "type": field_type}}


def op_data_delete_field(params):
    dataset = _dataset(params.get("dataset") or params.get("path"))
    mod = api()
    name = _require(params.get("name") or params.get("field"), "字段名（name）")
    mod.management.DeleteField(dataset, name)
    return {"dataset": dataset, "deleted": name}


def op_data_create_gdb(params):
    mod = api()
    out_folder = _require(params.get("outFolder") or params.get("path"), "输出文件夹（outFolder）")
    name = _require(params.get("name"), "地理数据库名（name）")
    if not os.path.isdir(out_folder):
        # 目标文件夹是这次调用自己要产出的位置，缺了就建——让模型多写一步
        # mkdir 只是噪音，CreateFileGDB 本身也不会因此更安全。
        os.makedirs(out_folder, exist_ok=True)
    if not name.lower().endswith(".gdb"):
        name = name + ".gdb"
    created = mod.management.CreateFileGDB(out_folder, name)
    return {"created": str(created)}


def op_data_copy(params):
    mod = api()
    source = _dataset(params.get("source") or params.get("inData"))
    out_path = _require(params.get("outPath") or params.get("outData"), "输出路径（outPath）")
    result = mod.management.CopyFeatures(source, out_path) \
        if str(params.get("kind") or "features").lower() == "features" \
        else mod.management.Copy(source, out_path)
    return {"source": source, "output": str(result)}


# ---------------------------------------------------------------------------
# 栅格
# ---------------------------------------------------------------------------

def op_raster_info(params):
    dataset = _dataset(params.get("dataset") or params.get("path"))
    mod = api()
    described = mod.Describe(dataset)
    result = {"dataset": dataset}
    for key in ("dataType", "format", "bandCount", "pixelType", "noDataValue",
                "compressionType", "isInteger", "hasRAT", "hasColormap"):
        try:
            result[key] = arcutil.to_jsonable(getattr(described, key))
        except Exception:
            continue
    for key in ("extent", "spatialReference", "meanCellWidth", "meanCellHeight"):
        try:
            result[key] = arcutil.to_jsonable(getattr(described, key))
        except Exception:
            continue
    try:
        raster = mod.Raster(dataset)
        result["width"] = arcutil.to_jsonable(raster.width)
        result["height"] = arcutil.to_jsonable(raster.height)
        result["bands"] = [
            {"index": band.index,
             "minimum": arcutil.to_jsonable(getattr(band, "minimum", None)),
             "maximum": arcutil.to_jsonable(getattr(band, "maximum", None)),
             "mean": arcutil.to_jsonable(getattr(band, "mean", None)),
             "standardDeviation": arcutil.to_jsonable(getattr(band, "standardDeviation", None))}
            for band in (raster.bands or [])
        ]
    except Exception as exc:
        result["rasterError"] = "%s: %s" % (type(exc).__name__, exc)
    return result


HANDLERS = {
    "data.describe": op_data_describe,
    "data.list": op_data_list,
    "data.fields": op_data_fields,
    "data.query": op_data_query,
    "data.statistics": op_data_statistics,
    "data.insert": op_data_insert,
    "data.update": op_data_update,
    "data.delete": op_data_delete,
    "data.calculate_field": op_data_calculate_field,
    "data.create_featureclass": op_data_create_featureclass,
    "data.create_table": op_data_create_table,
    "data.create_gdb": op_data_create_gdb,
    "data.add_field": op_data_add_field,
    "data.delete_field": op_data_delete_field,
    "data.copy": op_data_copy,
    "raster.info": op_raster_info,
}
