"""
地理处理、能力发现、环境与许可。

## 一个反直觉的事实

`arcpy.ListTools("*")` 返回的是 **`Tool_alias`** 形式（如 `Buffer_analysis`），
而不是 IDE/文档里常见的 `analysis.Buffer`。两者都能被 `GetParameterInfo`
解析，也都存在可调用对象，所以插件必须同时接受三种写法——否则模型从文档里
抄来的名字会全部判为"工具不存在"（实测 1977 个工具全部是 `Tool_alias` 形态）。
"""

import os

import arcutil

# arcpy Result.status 的取值（GP 的作业状态机）
STATUS_TEXT = {
    0: "new",
    1: "submitted",
    2: "waiting",
    3: "executing",
    4: "succeeded",
    5: "failed",
    6: "timedOut",
    7: "canceling",
    8: "canceled",
}

# 实测在本机返回 Available 的扩展编码。CheckExtension 对拼错的编码返回
# "无法识别扩展编码 X"，这与"没装/没许可"是两件事，必须分开报告。
KNOWN_EXTENSIONS = [
    "3D", "Spatial", "ImageAnalyst", "GeoStats", "Network", "Tracking",
    "DataInteroperability", "Airports", "Bathymetry", "Defense", "Indoors",
    "LocateXT", "Publisher", "JTX", "Nautical", "Foundation",
    "Aviation", "BusinessAnalyst", "Maritime", "Production", "RoadsAndHighways",
    "Schematics", "WorkflowManager", "CrimeAnalysis", "Studio", "GeoAI",
]

PRODUCTS = ["ArcInfo", "ArcEditor", "ArcView", "ArcGISPro"]


def _base_name(tool_alias):
    """`Buffer_analysis` -> `Buffer`；`ASCII3DToFeatureClass_3d` -> `ASCII3DToFeatureClass`。"""
    text = str(tool_alias)
    return text.rsplit("_", 1)[0] if "_" in text else text


def _toolbox_of(tool_alias):
    text = str(tool_alias)
    return text.rsplit("_", 1)[1] if "_" in text else ""


def resolve_tool(name):
    """
    把用户/模型给的工具名解析成 (可调用对象, 规范名)。

    接三级写法，逐一尝试：
      1. `analysis.Buffer`  —— 命名空间形式（文档与 IDE 常见）
      2. `Buffer_analysis`  —— ListTools 原生形式
      3. `Buffer`           —— 裸名，要求 ListTools 里唯一匹配
    解析不了就报错并给出最接近的候选，避免模型反复试错。
    """
    mod = arcutil.api()
    text = str(name or "").strip()
    if text == "":
        raise ValueError("工具名不能为空。用 arcgis_tools 查看可用的工具名。")

    if "." in text:
        namespace, _, rest = text.partition(".")
        holder = getattr(mod, namespace, None)
        if holder is not None and hasattr(holder, rest):
            return getattr(holder, rest), "%s.%s" % (namespace, rest)

    candidate = getattr(mod, text, None)
    if callable(candidate) and not text.startswith("_"):
        return candidate, text

    catalog = list(mod.ListTools("*"))
    exact = [t for t in catalog if _base_name(t) == text]
    if len(exact) == 1:
        return getattr(mod, exact[0]), exact[0]

    lowered = text.lower()
    loose = [t for t in catalog if _base_name(t).lower() == lowered]
    if len(loose) == 1:
        return getattr(mod, loose[0]), loose[0]

    # 模糊匹配：把用户给的名字当片段找，返回候选而不是猜一个
    fuzzy = [t for t in catalog if lowered in t.lower().replace("_", "")]
    suggestion = ", ".join(sorted(fuzzy)[:12]) if fuzzy else "(无相近项)"
    raise ValueError(
        "找不到工具 %r。arcpy 的工具名格式是 `Tool_alias`（如 Buffer_analysis）"
        "或 `alias.Tool`（如 analysis.Buffer）。相近的候选：%s" % (text, suggestion)
    )


def _apply_environment(environment):
    """
    在调用前设置 arcpy.env。

    环境名写错时 arcpy 只会静默忽略（setattr 对任意名字都成功），导致一次
    "成功"的运行用了错的坐标系或覆盖策略——这是最难查的一类问题，所以这里
    先按 ListEnvironments 校验键名。
    """
    mod = arcutil.api()
    if not environment:
        return []
    valid = set(mod.ListEnvironments("*"))
    applied = []
    unknown = []
    for key, value in environment.items():
        if key == "workspace" or key in valid:
            setattr(mod.env, key, arcutil.coerce(value) if isinstance(value, dict) else value)
            applied.append(key)
        else:
            unknown.append(key)
    if unknown:
        raise ValueError(
            "未知的 arcpy 环境变量：%s。用 arcgis_env 列出全部 %d 个环境变量名。"
            % (", ".join(unknown), len(valid))
        )
    return applied


# 早期版本用它判断"看起来像文件的输出值"，现在改为按参数 direction 判断 + 按
# 路径形态分流（见 _ensure_output_container）。保留这份清单只为将来排查时对照
# 哪些扩展名曾被当成文件处理。
_PATH_SUFFIXES = (
    ".tif", ".tiff", ".img", ".jp2", ".png", ".jpg", ".jpeg", ".bmp", ".gif", ".pdf",
    ".svg", ".shp", ".json", ".geojson", ".xlsx", ".xls", ".csv", ".txt", ".xml",
    ".lyrx", ".lyr", ".gdb", ".mdb", ".aprx", ".atbx", ".tbx", ".dbf", ".hdf", ".nc",
)


def _ensure_parent(path):
    text = str(path or "").strip()
    if text == "" or "\n" in text:
        return
    if not any(ch in text for ch in ("/", "\\")):
        return
    parent = os.path.dirname(os.path.abspath(text))
    if parent and not os.path.isdir(parent):
        os.makedirs(parent, exist_ok=True)


def _ensure_output_container(path):
    """给输出路径准备好"容器"：普通文件夹或 .gdb。

    两种失败形态实测过：
    - 输出 `F:\\out\\new dir\\slope.tif` → `ERROR 000800: 参数无效`（讨厌的是报错
      完全不提目录）。
    - 输出 `F:\\out\\new.gdb\\cities` → `ERROR 000210: 无法创建输出`。gdb 不能靠
      makedirs 造，得调 CreateFileGDB。

    只建"容器"（父目录 / gdb 本身），不碰数据集；输入路径从不经过这里。
    """
    text = str(path or "").strip()
    if text == "" or "\n" in text:
        return
    if not any(ch in text for ch in ("/", "\\")):
        return
    lower = text.lower()
    mark = lower.find(".gdb")
    if mark != -1:
        gdb_path = text[: mark + 4]
        if os.path.isdir(gdb_path):
            return
        parent = os.path.dirname(gdb_path)
        base = os.path.basename(gdb_path)
        if not base:
            return
        try:
            if parent and not os.path.isdir(parent):
                os.makedirs(parent, exist_ok=True)
            arcutil.api().management.CreateFileGDB(parent or ".", base)
        except Exception:
            # 建不出来就交给 GP 自己报错，比在这里抛一手信息更少。
            pass
        return
    _ensure_parent(text)


def _prepare_output_paths(resolved, keyword):
    """给 GP 工具的输出路径建父目录。

    GP 不建目录，报出来的却是 "ERROR 000800: 参数无效"——跟目录毫无关系的
    错误。实测 PointToRaster 输出到一个不存在的文件夹就是这个报错，改半天
    参数也改不出来。这里只对 direction 为 Output 的参数动手，输入路径一律
    不碰（输入不存在就该失败，而且要失败得清楚）。
    """
    mod = arcutil.api()
    try:
        parameters = mod.GetParameterInfo(_base_name(resolved))
    except Exception:
        try:
            parameters = mod.GetParameterInfo(resolved)
        except Exception:
            return
    for parameter in parameters:
        try:
            name = str(parameter.name)
            if name not in keyword:
                continue
            if str(getattr(parameter, "direction", "")).lower() != "output":
                continue
            value = keyword[name]
        except Exception:
            continue
        if not isinstance(value, str):
            continue
        _ensure_output_container(value)


def _positional_to_keyword(resolved, positional):
    """把按位置的参数折成 参数名 -> 值。

    为什么值得折：按位置传时原来直接 fn(*args)，绕过了 _prepare_output_paths，
    输出目录不存在就报 "ERROR 000800: 参数无效"（跟目录毫无关系的错误）。折成
    关键字之后输出路径的父目录就能统一建好，两种传法行为一致。
    """
    mod = arcutil.api()
    try:
        parameters = mod.GetParameterInfo(_base_name(resolved))
    except Exception:
        try:
            parameters = mod.GetParameterInfo(resolved)
        except Exception:
            return None
    names = []
    for parameter in parameters:
        try:
            names.append(str(parameter.name))
        except Exception:
            names.append("")
    if len(positional) > len(names):
        raise ValueError(
            "%s 只接受 %d 个参数，传了 %d 个。" % (resolved, len(names), len(positional)))
    keyword = {}
    for index, value in enumerate(positional):
        name = names[index] if index < len(names) else ""
        if name == "":
            return None
        keyword[name] = value
    return keyword


def _result_summary(result, resolved_name):
    """把 GP 的 Result 对象摊平成模型能读的结构。"""
    status = getattr(result, "status", None)
    summary = {
        "tool": resolved_name,
        "status": status,
        "statusText": STATUS_TEXT.get(status, "unknown") if isinstance(status, int) else "unknown",
    }
    outputs = []
    try:
        count = int(getattr(result, "outputCount", 0) or 0)
    except Exception:
        count = 0
    for index in range(count):
        try:
            outputs.append(arcutil.to_jsonable(result.getOutput(index)))
        except Exception as exc:
            outputs.append({"outputError": "%s: %s" % (type(exc).__name__, exc)})
    summary["outputs"] = outputs
    if len(outputs) == 1:
        summary["output"] = outputs[0]

    messages = []
    try:
        message_count = int(getattr(result, "messageCount", 0) or 0)
    except Exception:
        message_count = 0
    for index in range(message_count):
        try:
            messages.append(str(result.getMessage(index)).strip())
        except Exception:
            break
    if messages:
        summary["messages"] = messages

    # 磁盘落地校验：GP 报成功但输出文件不存在，几乎总是路径落到了意外的
    # workspace 里（arcpy.env.workspace 的默认值），早报比让下游工具报
    # "数据集不存在" 更容易定位。
    landed = []
    for item in outputs:
        if isinstance(item, str) and ("\\" in item or "/" in item) and not item.startswith("{") and "://" not in item:
            landed.append({"path": item, "exists": os.path.exists(item)})
    if landed:
        summary["outputPaths"] = landed
    return summary


# ---------------------------------------------------------------------------
# 操作
# ---------------------------------------------------------------------------

def op_gp_execute(params):
    """跑一个地理处理工具。"""
    mod = arcutil.api()
    fn, resolved = resolve_tool(params.get("tool"))
    _apply_environment(params.get("environment"))
    if isinstance(params.get("workspace"), str) and params["workspace"].strip() != "":
        mod.env.workspace = params["workspace"].strip()

    positional = params.get("args")
    if positional is not None:
        if not isinstance(positional, list):
            raise ValueError("args 必须是数组；要按参数名传请用 params。")
        keyword = _positional_to_keyword(resolved, positional)
        if keyword is None:
            # 拿不到参数契约（工具来自自定义工具箱之类）就只能原样按位置调。
            result = fn(*[arcutil.coerce(v) for v in positional])
        else:
            _prepare_output_paths(resolved, keyword)
            result = fn(**{k: arcutil.coerce(v) for k, v in keyword.items()})
    else:
        keyword = params.get("params") or {}
        if not isinstance(keyword, dict):
            raise ValueError("params 必须是对象（参数名 -> 值）。")
        _prepare_output_paths(resolved, keyword)
        result = fn(**{k: arcutil.coerce(v) for k, v in keyword.items()})
    return _result_summary(result, resolved)


def op_gp_list(params):
    """工具目录：1977 个工具，按 alias / 关键字 / 通配符过滤。"""
    mod = arcutil.api()
    pattern = str(params.get("pattern") or "*").strip() or "*"
    toolbox = str(params.get("toolbox") or "").strip().lower()
    search = str(params.get("search") or "").strip().lower()
    limit = params.get("limit")
    limit = 400 if limit is None else max(1, min(int(limit), 2000))

    everything = list(mod.ListTools(pattern))
    if toolbox != "":
        everything = [t for t in everything if _toolbox_of(t).lower() == toolbox]
    if search != "":
        everything = [t for t in everything if search in t.lower()]

    toolboxes = {}
    for item in mod.ListToolboxes("*"):
        # "Analysis Tools(analysis)" -> ("analysis", "Analysis Tools")
        label = str(item)
        alias = label.rsplit("(", 1)[-1].rstrip(")") if "(" in label else label
        name = label.rsplit("(", 1)[0].strip() if "(" in label else label
        toolboxes[alias] = name

    return {
        "total": len(everything),
        "shown": min(len(everything), limit),
        "truncated": len(everything) > limit,
        "tools": sorted(everything)[:limit],
        "toolboxes": dict(sorted(toolboxes.items())),
        "catalogSize": len(mod.ListTools("*")),
    }


def _parameter_spec(parameter, index):
    """把 arcpy 的 Parameter 摊平成 JSON。字段名取实测可用的那些。"""
    entry = {"index": index}
    for key in ("name", "displayName", "direction", "parameterType", "category",
                "defaultEnvironmentName"):
        try:
            entry[key] = arcutil.to_jsonable(getattr(parameter, key))
        except Exception:
            continue
    try:
        entry["enabled"] = bool(parameter.enabled)
    except Exception:
        pass
    try:
        entry["multiValue"] = bool(parameter.multiValue)
    except Exception:
        pass
    try:
        entry["datatype"] = arcutil.to_jsonable(parameter.datatype)
    except Exception:
        pass
    try:
        dependencies = parameter.parameterDependencies
        if dependencies is not None:
            entry["dependsOn"] = arcutil.to_jsonable(dependencies)
    except Exception:
        pass
    # filter 携带枚举候选值——模型选参数时最需要的就是这个
    try:
        flt = parameter.filter
        if flt is not None:
            spec = {}
            for attr in ("type", "list"):
                try:
                    value = getattr(flt, attr)
                except Exception:
                    continue
                if value is None:
                    continue
                if attr == "list":
                    try:
                        value = list(value)
                    except TypeError:
                        value = str(value)
                spec[attr] = arcutil.to_jsonable(value)
            if spec:
                entry["filter"] = spec
    except Exception:
        pass
    return entry


def op_gp_info(params):
    """一个工具的参数契约。"""
    mod = arcutil.api()
    fn, resolved = resolve_tool(params.get("tool"))
    try:
        parameters = mod.GetParameterInfo(_base_name(resolved))
    except Exception:
        try:
            parameters = mod.GetParameterInfo(resolved)
        except Exception:
            parameters = []
    specs = [_parameter_spec(p, i) for i, p in enumerate(parameters)]
    inputs = [s for s in specs if str(s.get("direction", "")).lower() in ("input", "")]
    outputs = [s for s in specs if str(s.get("direction", "")).lower() == "output"]
    return {
        "tool": resolved,
        "callable": "%s.%s" % (_toolbox_of(resolved), _base_name(resolved)) if "_" in resolved else resolved,
        "parameterCount": len(specs),
        "inputs": inputs,
        "outputs": outputs,
        "requiredInputs": [s.get("name") for s in inputs if str(s.get("parameterType", "")).lower() == "required"],
        "note": "按参数名传：arcgis_tool_run 的 params 用这里的 name 作键。"
                "空间参考可写 {\"__arcpy__\":\"SpatialReference\",\"wkid\":4326}，"
                "也可直接写 \"EPSG:4326\"。",
    }


def op_env_get(params):
    """读 arcpy.env；不指定名字就返回全部 74 个。"""
    mod = arcutil.api()
    names = params.get("names")
    if isinstance(names, str):
        names = [names]
    if not names:
        names = list(mod.ListEnvironments("*"))
    values = {}
    for name in names:
        try:
            values[name] = arcutil.to_jsonable(getattr(mod.env, name))
        except Exception as exc:
            values[name] = "ERR: %s" % exc
    return {"count": len(values), "environments": values}


def op_env_set(params):
    """写 arcpy.env，并对未知名字直接报错。"""
    mod = arcutil.api()
    settings = params.get("settings") or {}
    if not isinstance(settings, dict) or not settings:
        raise ValueError("settings 必须是非空对象（环境变量名 -> 值）。")
    applied = _apply_environment(settings)
    current = {}
    for name in applied:
        try:
            current[name] = arcutil.to_jsonable(getattr(mod.env, name))
        except Exception:
            continue
    return {"applied": applied, "current": current}


def op_license_info(params):
    """产品级别与扩展许可状态。"""
    mod = arcutil.api()
    info = {
        "product": arcutil.to_jsonable(mod.ProductInfo()),
        "products": {},
        "extensions": {},
    }
    for product in PRODUCTS:
        try:
            info["products"][product] = arcutil.to_jsonable(mod.CheckProduct(product))
        except Exception as exc:
            info["products"][product] = "ERR: %s" % exc
    for ext in KNOWN_EXTENSIONS:
        try:
            state = mod.CheckExtension(ext)
        except Exception as exc:
            state = "ERR: %s" % exc
        text = str(state)
        # "无法识别扩展编码 X" = 编码拼写不对，不是缺许可；两者必须区分开
        recognized = "无法识别" not in text and "not recognized" not in text.lower()
        info["extensions"][ext] = {"state": text, "recognized": recognized}
    info["available"] = sorted(k for k, v in info["extensions"].items()
                               if v.get("recognized") and v.get("state") == "Available")
    return info


def op_license_checkout(params):
    """检出扩展许可。"""
    mod = arcutil.api()
    extensions = params.get("extensions") or ([params.get("extension")] if params.get("extension") else [])
    if not extensions:
        raise ValueError("需要 extensions（数组）或 extension（单个）。")
    result = {}
    for ext in extensions:
        try:
            result[str(ext)] = str(mod.CheckOutExtension(str(ext)))
        except Exception as exc:
            result[str(ext)] = "ERR: %s" % exc
    return {"checkedOut": result}


def op_license_checkin(params):
    """归还扩展许可。"""
    mod = arcutil.api()
    extensions = params.get("extensions") or ([params.get("extension")] if params.get("extension") else [])
    if not extensions:
        raise ValueError("需要 extensions（数组）或 extension（单个）。")
    result = {}
    for ext in extensions:
        try:
            result[str(ext)] = str(mod.CheckInExtension(str(ext)))
        except Exception as exc:
            result[str(ext)] = "ERR: %s" % exc
    return {"checkedIn": result}


def op_product_set(params):
    """切换产品级别（Basic/Standard/Advanced -> ArcView/ArcEditor/ArcInfo）。"""
    mod = arcutil.api()
    product = str(params.get("product") or "").strip()
    if product == "":
        raise ValueError("需要 product，例如 ArcInfo。")
    mod.SetProduct(product)
    return {"product": arcutil.to_jsonable(mod.ProductInfo())}


HANDLERS = {
    "gp.execute": op_gp_execute,
    "gp.list": op_gp_list,
    "gp.info": op_gp_info,
    "env.get": op_env_get,
    "env.set": op_env_set,
    "license.info": op_license_info,
    "license.checkout": op_license_checkout,
    "license.checkin": op_license_checkin,
    "product.set": op_product_set,
}
