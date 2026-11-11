"""选择、投影、格式转换、栅格处理。

这些能力 GP 本来就有，缺的不是功能而是"记得住"：`SelectLayerByAttribute_management`
要传图层不是路径、`Project` 与 `ProjectRaster` 是两个工具、栅格计算器要求表达式里的
名字能在 workspace 里解析。这里把每件事包成一个参数直白、报错中文的操作。

参数命名统一：`input` 既接受地图图层名，也接受磁盘上的数据集路径。前者优先——因为
选择类操作只有作用在图层上才有"当前选择"这个状态可言。
"""

import os

import arcutil

# GP 的 selection_type 取值，写错时列出来比抛一个看不懂的 GEOPROCESSING 错误好。
_SELECTION_TYPES = {
    "NEW_SELECTION": "新建选择（替换原有选择）",
    "ADD_TO_SELECTION": "加入现有选择",
    "REMOVE_FROM_SELECTION": "从现有选择里移除",
    "SUBSET_SELECTION": "与现有选择取交集",
    "SWITCH_SELECTION": "反选",
    "CLEAR_SELECTION": "清除选择",
}

_OVERLAP_TYPES = {
    "INTERSECT": "相交",
    "INTERSECT_3D": "三维相交",
    "WITHIN_A_DISTANCE": "在指定距离内",
    "WITHIN_A_DISTANCE_3D": "三维距离内",
    "CONTAINS": "包含",
    "COMPLETELY_CONTAINS": "完全包含",
    "CONTAINS_CLEMENTINI": "包含（Clementini）",
    "WITHIN": "位于内部",
    "COMPLETELY_WITHIN": "完全位于内部",
    "WITHIN_CLEMENTINI": "位于内部（Clementini）",
    "ARE_IDENTICAL_TO": "完全相同",
    "BOUNDARY_TOUCHES": "边界相接",
    "SHARE_A_LINE_SEGMENT_WITH": "共享线段",
    "CROSSED_BY_THE_OUTLINE_OF": "轮廓穿过",
    "HAVE_THEIR_CENTER_IN": "中心点落在其中",
}

_SURFACE_METHODS = {
    "slope": "Slope_3d",
    "aspect": "Aspect_3d",
    "hillshade": "Hillshade_3d",
    "contour": "Contour_3d",
}


def _ensure_parent(path):
    """输出路径的父目录不存在就建。

    GP 工具不会替你建目录，报出来的是 "参数无效" 这种跟目录毫无关系的错误——
    模型会去改参数，改十次也改不出来。输出位置是这次调用自己要产出的地方，
    提前建好不降低任何安全性。
    """
    text = str(path or "").strip()
    if text == "":
        return
    parent = os.path.dirname(os.path.abspath(text))
    if parent and not os.path.isdir(parent):
        os.makedirs(parent, exist_ok=True)


def _mod(alias):
    """取 arcpy 的某个子模块；缺了就明确说哪个模块不可用。"""
    mod = arcutil.api()
    sub = getattr(mod, alias, None)
    if sub is None:
        raise RuntimeError("arcpy.%s 不可用，请确认 ArcGIS Pro 安装完整。" % alias)
    return sub


def _selection_type(params):
    value = str(params.get("selectionType") or "NEW_SELECTION").strip().upper()
    if value not in _SELECTION_TYPES:
        raise ValueError(
            "未知的 selectionType：%s。可用值：%s"
            % (value, ", ".join(sorted(_SELECTION_TYPES)))
        )
    return value


def _count(target):
    """数目标里的要素/行。图层和数据集路径都接受。"""
    mod = arcutil.api()
    try:
        result = mod.management.GetCount(target)
        return int(result.getOutput(0))
    except Exception:
        try:
            return int(mod.GetCount_management(target).getOutput(0))
        except Exception:
            return None


def _layer_in_map(params, key="input"):
    """在地图里找同名图层；找不到返回 None。不报错——调用方决定要不要当路径用。"""
    from ops_project import _find_layer, _project

    wanted = str(params.get(key) or "").strip()
    if wanted == "":
        return None
    try:
        aprx, _path = _project(params)
    except Exception:
        return None
    try:
        _one_map, layer, _parent = _find_layer(aprx, wanted, params.get("map"))
        return layer
    except Exception:
        return None


def _target(params, key="input"):
    """解析输入：地图图层优先，其次磁盘路径。"""
    wanted = str(params.get(key) or "").strip()
    if wanted == "":
        raise ValueError("需要 %s（地图图层名或数据集路径）。" % key)

    layer = _layer_in_map(params, key)
    if layer is not None:
        return layer

    if arcutil.exists(wanted):
        return wanted
    raise ValueError(
        "找不到 %r：既不是当前工程里的图层名，也不是存在的数据集路径。" % wanted
    )


# ---------------------------------------------------------------------------
# 选择
# ---------------------------------------------------------------------------

def op_select_by_attribute(params):
    """按属性选择要素，返回选中数量。"""
    mod = arcutil.api()
    target = _target(params)
    where = str(params.get("where") or "").strip()
    if where == "":
        raise ValueError('需要 where，例如 "POP > 10000" 或 "名称 = \'上海\'"。')
    selection = _selection_type(params)

    try:
        result = mod.management.SelectLayerByAttribute(
            target, selection, where, "NON_INVERT"
        )
    except Exception as exc:
        raise RuntimeError(
            "按属性选择失败：%s。where 里的字段名要和数据集字段完全一致（注意中文/大小写）。"
            % exc
        )
    out = {
        "where": where,
        "selectionType": selection,
        "selectionTypeText": _SELECTION_TYPES[selection],
        "selected": _count(result) if result is not None else None,
    }
    messages = getattr(result, "messageCount", 0) if result is not None else 0
    if messages:
        notes = []
        for index in range(messages):
            try:
                notes.append(str(result.getMessage(index)).strip())
            except Exception:
                break
        if notes:
            out["messages"] = notes
    return out


def op_select_by_location(params):
    """按空间关系选择要素。"""
    mod = arcutil.api()
    target = _target(params)
    overlap = str(params.get("overlap") or "INTERSECT").strip().upper()
    if overlap not in _OVERLAP_TYPES:
        raise ValueError(
            "未知的 overlap：%s。可用值：%s" % (overlap, ", ".join(sorted(_OVERLAP_TYPES)))
        )
    selection = _selection_type(params)
    select_features = ""
    if params.get("selectFeatures"):
        select_features = _target(params, "selectFeatures")
    distance = params.get("distance")
    if distance is None and "DISTANCE" in overlap:
        distance = "0 Meters"
    if distance is None:
        distance = ""

    try:
        result = mod.management.SelectLayerByLocation(
            target,
            overlap,
            select_features,
            str(distance) if distance != "" else "",
            selection,
            "NOT_INVERT",
        )
    except Exception as exc:
        raise RuntimeError(
            "按位置选择失败：%s。WITHIN_A_DISTANCE 这类关系需要 distance。" % exc
        )
    return {
        "overlap": overlap,
        "overlapText": _OVERLAP_TYPES[overlap],
        "selectionType": selection,
        "distance": str(distance) if distance != "" else None,
        "selected": _count(result) if result is not None else None,
    }


def op_select_clear(params):
    """清除图层上的选择。"""
    mod = arcutil.api()
    target = _target(params)
    mod.management.SelectLayerByAttribute(target, "CLEAR_SELECTION")
    return {"cleared": True, "count": _count(target)}


# ---------------------------------------------------------------------------
# 投影
# ---------------------------------------------------------------------------

def _sr(spec):
    if not spec:
        raise ValueError(
            "需要 spatialReference，例如 4326、\"EPSG:3857\"，或 "
            '{"__arcpy__":"SpatialReference","wkid":4547} 这种完整写法。'
        )
    return arcutil.spatial_reference(spec)


def op_project_data(params):
    """投影/重投影。矢量走 Project，栅格走 ProjectRaster——自动判断。"""
    mod = arcutil.api()
    target = _target(params)
    out = str(params.get("output") or "").strip()
    if out == "":
        raise ValueError("需要 output（输出数据集路径）。")
    sr = _sr(params.get("spatialReference"))
    transform = str(params.get("transformation") or "").strip()

    kind = ""
    try:
        kind = str(mod.Describe(target).dataType or "")
    except Exception:
        kind = ""
    is_raster = "Raster" in kind

    try:
        if is_raster:
            kwargs = {}
            if params.get("resamplingType"):
                kwargs["resampling_type"] = str(params["resamplingType"]).upper()
            if params.get("cellSize"):
                kwargs["cell_size"] = params["cellSize"]
            if transform:
                kwargs["geographic_transform"] = transform
            result = mod.management.ProjectRaster(target, out, sr, **kwargs)
        else:
            kwargs = {}
            if transform:
                kwargs["transform_method"] = transform
            result = mod.management.Project(target, out, sr, **kwargs)
    except Exception as exc:
        raise RuntimeError(
            "投影失败：%s。跨基准面时需要 transformation（例如 "
            '"WGS_1984_(ITRF00)_To_NAD_1983"），同一基准面内不需要。' % exc
        )

    return {
        "kind": "raster" if is_raster else "vector",
        "output": out,
        "exists": arcutil.exists(out),
        "status": getattr(result, "status", None),
    }


def op_project_define(params):
    """只写坐标系定义，不动坐标值（数据本身坐标是对的时候用这个）。"""
    mod = arcutil.api()
    target = _target(params)
    sr = _sr(params.get("spatialReference"))
    mod.management.DefineProjection(target, sr)
    described = mod.Describe(target)
    return {
        "defined": True,
        "spatialReference": arcutil.to_jsonable(described.spatialReference),
    }


# ---------------------------------------------------------------------------
# 格式转换
# ---------------------------------------------------------------------------

_CONVERT_FORMATS = {
    "shapefile": "要素类 → shapefile 文件夹",
    "json": "要素 → GeoJSON / Esri JSON",
    "excel": "表 → .xlsx",
}


def op_convert_data(params):
    """把要素类/表转成 shapefile、JSON 或 Excel。"""
    mod = arcutil.api()
    target = _target(params)
    out = str(params.get("output") or "").strip()
    if out == "":
        raise ValueError("需要 output（输出路径）。")
    fmt = str(params.get("format") or "").strip().lower()
    if fmt == "":
        ext = os.path.splitext(out)[1].lower()
        fmt = {".json": "json", ".geojson": "json", ".xlsx": "excel", ".xls": "excel"}.get(ext, "shapefile")
    if fmt not in _CONVERT_FORMATS:
        raise ValueError(
            "未知的 format：%s。可用值：%s" % (fmt, ", ".join(sorted(_CONVERT_FORMATS)))
        )

    parent = os.path.dirname(os.path.abspath(out))
    if parent and not os.path.isdir(parent) and fmt != "shapefile":
        os.makedirs(parent, exist_ok=True)

    try:
        if fmt == "shapefile":
            folder = out if not out.lower().endswith(".shp") else os.path.dirname(os.path.abspath(out))
            if folder and not os.path.isdir(folder):
                os.makedirs(folder, exist_ok=True)
            result = mod.conversion.FeatureClassToShapefile(target, folder)
            produced = out
        elif fmt == "json":
            kwargs = {"format_json": "FORMATTED"}
            if params.get("geoJson") is not None:
                kwargs["geoJSON"] = "GEOJSON" if params["geoJson"] else "NO_GEOJSON"
            result = mod.conversion.FeaturesToJSON(target, out, **kwargs)
            produced = out
        else:
            result = mod.conversion.TableToExcel(target, out)
            produced = out
    except Exception as exc:
        raise RuntimeError(
            "转换失败（%s）：%s" % (_CONVERT_FORMATS.get(fmt, fmt), exc)
        )

    return {
        "format": fmt,
        "formatText": _CONVERT_FORMATS[fmt],
        "output": produced,
        "exists": os.path.exists(produced),
        "status": getattr(result, "status", None),
    }


# ---------------------------------------------------------------------------
# 栅格
# ---------------------------------------------------------------------------

def op_raster_resample(params):
    """改像元大小 / 重采样。

    Resample 这个 GP 工具只有四个参数，没有宽高——想指定输出像素数得先算
    像元大小，这里只暴露 cellSize，避免给出一个传了没用的参数。
    """
    mod = arcutil.api()
    target = _target(params)
    out = str(params.get("output") or "").strip()
    if out == "":
        raise ValueError("需要 output（输出栅格路径）。")
    resampling = str(params.get("resampling") or "NEAREST").strip().upper()
    cellsize = params.get("cellSize")
    if cellsize is None:
        raise ValueError(
            "需要 cellSize（输出像元大小，如 30 或 \"30 30\"）。"
            "这个工具没有 width/height 参数。"
        )

    try:
        result = mod.management.Resample(
            in_raster=target,
            out_raster=out,
            cell_size=cellsize,
            resampling_type=resampling,
        )
    except Exception as exc:
        raise RuntimeError(
            "重采样失败：%s。resampling 可取 NEAREST / BILINEAR / CUBIC / MAJORITY。" % exc
        )
    return {
        "output": out,
        "exists": arcutil.exists(out),
        "resampling": resampling,
        "status": getattr(result, "status", None),
    }


def op_raster_clip(params):
    """裁剪栅格：给矩形范围，或给掩膜要素做不规则裁剪。"""
    mod = arcutil.api()
    target = _target(params)
    out = str(params.get("output") or "").strip()
    if out == "":
        raise ValueError("需要 output（输出栅格路径）。")

    rectangle = params.get("rectangle")
    mask = params.get("mask")
    if not rectangle and not mask:
        raise ValueError(
            "需要 rectangle（\"xMin yMin xMax yMax\"）或 mask（抠图用的要素/栅格），二者给一个。"
        )

    if mask:
        mask_path = _target(params, "mask")
        # 不规则裁剪走 in_template_dataset + clipping_geometry：rectangle 位
        # 虽然必填，但传掩膜本身即可，真实边界由 clipping_geometry 决定。
        try:
            result = mod.management.Clip(
                in_raster=target,
                rectangle=mask_path,
                out_raster=out,
                in_template_dataset=mask_path,
                clipping_geometry="ClippingGeometry",
                maintain_clipping_extent="NO_MAINTAIN_EXTENT",
            )
        except Exception as exc:
            raise RuntimeError("按掩膜裁剪失败：%s" % exc)
        return {"output": out, "exists": arcutil.exists(out), "mask": str(params.get("mask")),
                "status": getattr(result, "status", None)}

    if isinstance(rectangle, (list, tuple)):
        rect_value = " ".join(str(item) for item in rectangle)
    else:
        rect_value = str(rectangle)
    try:
        result = mod.management.Clip(
            in_raster=target,
            rectangle=rect_value,
            out_raster=out,
            nodata_value=params.get("nodataValue"),
        )
    except Exception as exc:
        raise RuntimeError("按范围裁剪失败：%s（rectangle 要写成 \"xMin yMin xMax yMax\"）" % exc)
    return {"output": out, "exists": arcutil.exists(out), "rectangle": rect_value,
            "status": getattr(result, "status", None)}


_PIXEL_TYPES = {
    "1_BIT", "2_BIT", "4_BIT", "8_BIT_UNSIGNED", "8_BIT_SIGNED",
    "16_BIT_UNSIGNED", "16_BIT_SIGNED", "32_BIT_UNSIGNED", "32_BIT_SIGNED",
    "32_BIT_FLOAT", "64_BIT",
}


def op_raster_mosaic(params):
    """把多张栅格镶嵌成一张。

    MosaicToNewRaster 的波段数是必填项，而调用方通常并不知道——这里从第一个
    输入栅格探测，省掉一次试错。
    """
    mod = arcutil.api()
    inputs = params.get("inputs")
    if not isinstance(inputs, list) or len(inputs) < 1:
        raise ValueError("需要 inputs（至少一个栅格路径的数组）。")
    out = str(params.get("output") or "").strip()
    if out == "":
        raise ValueError("需要 output（输出栅格数据集路径，例如 D:/ws/mosaic.tif）。")

    resolved = []
    for item in inputs:
        resolved.append(_target({"input": item}, "input"))

    bands = params.get("numberOfBands")
    if bands is None:
        try:
            bands = int(mod.Describe(resolved[0]).bandCount)
        except Exception:
            bands = 1

    pixel_type = str(params.get("pixelType") or "").strip().upper()
    if pixel_type and pixel_type not in _PIXEL_TYPES:
        raise ValueError(
            "未知的 pixelType：%s。可用值：%s" % (pixel_type, ", ".join(sorted(_PIXEL_TYPES)))
        )

    out_abs = os.path.abspath(out)
    location = os.path.dirname(out_abs) or "."
    name = os.path.basename(out_abs)
    if not os.path.isdir(location):
        os.makedirs(location, exist_ok=True)

    kwargs = {
        "input_rasters": resolved,
        "output_location": location,
        "raster_dataset_name_with_extension": name,
        "number_of_bands": bands,
        "mosaic_colormap_mode": str(params.get("colormapMode") or "FIRST").upper(),
    }
    if pixel_type:
        kwargs["pixel_type"] = pixel_type
    if params.get("cellsize") is not None:
        kwargs["cellsize"] = params["cellsize"]
    if params.get("mosaicMethod"):
        kwargs["mosaic_method"] = str(params["mosaicMethod"]).upper()
    if params.get("spatialReference"):
        kwargs["coordinate_system_for_the_raster"] = arcutil.spatial_reference(
            params["spatialReference"]
        )

    try:
        result = mod.management.MosaicToNewRaster(**kwargs)
    except Exception as exc:
        raise RuntimeError(
            "镶嵌失败：%s。输入栅格的像元类型/波段数/坐标系要一致；"
            "pixelType 用 8_BIT_UNSIGNED 这种内部代码写法。" % exc
        )
    return {
        "inputs": len(resolved),
        "output": out,
        "exists": arcutil.exists(out),
        "bands": bands,
        "status": getattr(result, "status", None),
    }


def _eval_globals():
    """栅格计算器表达式求值用的全局命名空间。

    不能传空的 __builtins__：arcpy.sa.Raster 重载算术运算符之后，一加一减就要
    走 numpy 与 arcpy 的内部导入，`x + 1` 会直接抛 KeyError '__import__'（实测）。
    这里只开计算必需的那几个内建，其余照样关掉。
    """
    return {
        "__builtins__": {
            "__import__": __import__,
            "abs": abs,
            "min": min,
            "max": max,
            "round": round,
            "int": int,
            "float": float,
            "bool": bool,
            "len": len,
            "str": str,
            "True": True,
            "False": False,
            "None": None,
        }
    }


def op_raster_calculator(params):
    """栅格计算器：给变量名到栅格的映射，再给一个表达式。"""
    mod = arcutil.api()
    out = str(params.get("output") or "").strip()
    if out == "":
        raise ValueError("需要 output（输出栅格路径）。")
    expr = str(params.get("expression") or "").strip()
    if expr == "":
        raise ValueError('需要 expression，例如 "b1 * 0.5 + b2" 或 "Con(b1 > 100, 1, 0)"。')
    bindings = params.get("rasters")
    if not isinstance(bindings, dict) or not bindings:
        raise ValueError("需要 rasters：{变量名: 栅格路径}，表达式里就用这些变量名。")

    sa = getattr(mod, "sa", None)
    if sa is None:
        raise RuntimeError("arcpy.sa 不可用（Spatial Analyst 许可未检出）。")

    namespace = {}
    for name, path in bindings.items():
        target = _target({"input": path}, "input")
        namespace[str(name)] = sa.Raster(target)
    # Con / IsNull / math 这些函数也放进命名空间，表达式才能写得像文档里那样。
    for helper in ("Con", "IsNull", "SetNull", "Abs", "Exp", "Ln", "Log10", "Sqrt", "Int", "Float", "Sin", "Cos", "Tan"):
        func = getattr(sa, helper, None)
        if func is not None:
            namespace[helper] = func

    try:
        value = eval(expr, _eval_globals(), namespace)  # noqa: S307 - 本地工具，表达式由调用方给出
    except Exception as exc:
        raise RuntimeError(
            "表达式求值失败：%s。可用的变量：%s；可用函数：Con/IsNull/SetNull/Abs/Exp/Ln/Log10/Sqrt/Int/Float/Sin/Cos/Tan。"
            % (exc, ", ".join(sorted(bindings)))
        )
    try:
        value.save(out)
    except Exception as exc:
        raise RuntimeError("写出栅格失败：%s" % exc)
    return {
        "expression": expr,
        "variables": sorted(bindings),
        "output": out,
        "exists": arcutil.exists(out),
    }


def op_raster_extract_mask(params):
    """按掩膜提取（掩膜是面要素或栅格）。"""
    mod = arcutil.api()
    target = _target(params)
    out = str(params.get("output") or "").strip()
    if out == "":
        raise ValueError("需要 output（输出栅格路径）。")
    mask = _target(params, "mask")
    sa = getattr(mod, "sa", None)
    if sa is None:
        raise RuntimeError("arcpy.sa 不可用（Spatial Analyst 许可未检出）。")
    try:
        value = sa.ExtractByMask(target, mask)
        value.save(out)
    except Exception as exc:
        raise RuntimeError("按掩膜提取失败：%s" % exc)
    return {"output": out, "exists": arcutil.exists(out), "mask": str(params.get("mask"))}


def op_raster_surface(params):
    """坡度 / 坡向 / 山体阴影 / 等高线。"""
    mod = arcutil.api()
    method = str(params.get("method") or "slope").strip().lower()
    if method not in _SURFACE_METHODS:
        raise ValueError(
            "未知的 method：%s。可用值：%s" % (method, ", ".join(sorted(_SURFACE_METHODS)))
        )
    target = _target(params)
    out = str(params.get("output") or "").strip()
    if out == "":
        raise ValueError("需要 output（输出路径）。")

    tool_name = _SURFACE_METHODS[method]
    tool = getattr(mod, tool_name, None)
    if tool is None:
        raise RuntimeError("找不到 GP 工具 %s（需要 3D Analyst）。" % tool_name)

    kwargs = {}
    if method == "slope":
        if params.get("units"):
            kwargs["output_measurement"] = str(params["units"]).upper()
        if params.get("surfaceMethod"):
            kwargs["method"] = str(params["surfaceMethod"]).upper()
        if params.get("zFactor") is not None:
            kwargs["z_factor"] = params["zFactor"]
    if method == "aspect":
        if params.get("surfaceMethod"):
            kwargs["method"] = str(params["surfaceMethod"]).upper()
        if params.get("zFactor") is not None:
            kwargs["z_factor"] = params["zFactor"]
    if method == "hillshade":
        if params.get("azimuth") is not None:
            kwargs["azimuth"] = params["azimuth"]
        if params.get("altitude") is not None:
            kwargs["altitude"] = params["altitude"]
        if params.get("zFactor") is not None:
            kwargs["z_factor"] = params["zFactor"]
        kwargs["model_shadows"] = "MODEL_SHADOWS" if params.get("modelShadows") else "NO_SHADOWS"
    if method == "contour":
        if params.get("interval") is None:
            raise ValueError("等高线需要 interval（等值线间距）。")
        kwargs["interval"] = params["interval"]
        if params.get("baseContour") is not None:
            kwargs["base_contour"] = params["baseContour"]
        kwargs["z_factor"] = params.get("zFactor") or 1

    try:
        result = tool(target, out, **kwargs)
    except Exception as exc:
        raise RuntimeError("%s 失败：%s" % (method, exc))
    return {
        "method": method,
        "output": out,
        "exists": arcutil.exists(out),
        "status": getattr(result, "status", None) if hasattr(result, "status") else None,
    }


# ---------------------------------------------------------------------------
# 矢量分析：最常用那三个，参数比 GP 少一半
# ---------------------------------------------------------------------------

def _multi_inputs(params, key="inputs"):
    items = params.get(key)
    if not isinstance(items, list) or len(items) < 1:
        raise ValueError("需要 %s（至少一个图层名或路径的数组）。" % key)
    return [_target({"input": item}, "input") for item in items]


def op_data_merge(params):
    """把多个同类要素类合成一个。"""
    mod = arcutil.api()
    resolved = _multi_inputs(params)
    out = str(params.get("output") or "").strip()
    if out == "":
        raise ValueError("需要 output（输出要素类路径）。")
    try:
        result = mod.management.Merge(resolved, out)
    except Exception as exc:
        raise RuntimeError("合并失败：%s（输入的几何类型和坐标系要一致）" % exc)
    return {"inputs": len(resolved), "output": out, "exists": arcutil.exists(out), "status": getattr(result, "status", None)}


def op_data_append(params):
    """把多个要素类追加进已有的一个。"""
    mod = arcutil.api()
    resolved = _multi_inputs(params)
    out = str(params.get("output") or "").strip()
    if out == "":
        raise ValueError("需要 output（要追加进去的目标要素类）。")
    schema = str(params.get("schemaType") or "NO_TEST").upper()
    try:
        result = mod.management.Append(resolved, out, schema)
    except Exception as exc:
        raise RuntimeError("追加失败：%s（schemaType=TEST 会做字段校验）" % exc)
    return {"inputs": len(resolved), "output": out, "status": getattr(result, "status", None)}


def op_data_dissolve(params):
    """按字段融合。"""
    mod = arcutil.api()
    target = _target(params)
    out = str(params.get("output") or "").strip()
    if out == "":
        raise ValueError("需要 output（输出要素类路径）。")
    fields = params.get("fields") or []
    if isinstance(fields, str):
        fields = [fields]
    kwargs = {}
    if params.get("statistics"):
        stats = params["statistics"]
        if isinstance(stats, dict):
            kwargs["statistics_fields"] = [[field, str(stat).upper()] for field, stat in stats.items()]
        elif isinstance(stats, list):
            # GP 要的是 [[字段, 统计类型], …] 的值表。传 [{field, stat}] 这种
            # 字典型态会被 Dissolve 拒掉，报的是 "Object: 执行工具时出错"——
            # 一条完全指不到参数上的错误。这里统一折成对。
            pairs = []
            for item in stats:
                if isinstance(item, dict):
                    pairs.append([str(item.get("field")), str(item.get("stat") or "SUM").upper()])
                elif isinstance(item, (list, tuple)) and len(item) >= 2:
                    pairs.append([str(item[0]), str(item[1]).upper()])
                else:
                    pairs.append([str(item), "SUM"])
            kwargs["statistics_fields"] = pairs
    kwargs["multi_part"] = "MULTI_PART" if params.get("multiPart", True) else "SINGLE_PART"
    try:
        result = mod.management.Dissolve(target, out, fields, **kwargs)
    except Exception as exc:
        raise RuntimeError("融合失败：%s" % exc)
    return {
        "fields": fields,
        "output": out,
        "exists": arcutil.exists(out),
        "count": _count(out),
        "status": getattr(result, "status", None),
    }


HANDLERS = {
    "select.by_attribute": op_select_by_attribute,
    "select.by_location": op_select_by_location,
    "select.clear": op_select_clear,
    "project.data": op_project_data,
    "project.define": op_project_define,
    "convert.data": op_convert_data,
    "raster.resample": op_raster_resample,
    "raster.clip": op_raster_clip,
    "raster.mosaic": op_raster_mosaic,
    "raster.calculator": op_raster_calculator,
    "raster.extract_mask": op_raster_extract_mask,
    "raster.surface": op_raster_surface,
    "data.merge": op_data_merge,
    "data.append": op_data_append,
    "data.dissolve": op_data_dissolve,
}


def _prepare_output(handler):
    """给带 output 的操作统一补父目录。

    在分发这一层做，而不是每个 op 里各写一行：11 个 op 有 11 份 output 校验，
    漏一个就重现一次 "参数无效" 这种毫无指向性的报错。没有 output 参数的
    op（选择类）进来等于空转。
    """
    def run(params):
        _ensure_parent((params or {}).get("output"))
        return handler(params)

    run.__name__ = getattr(handler, "__name__", "handler")
    return run


HANDLERS = {name: _prepare_output(fn) for name, fn in HANDLERS.items()}
