"""
dsh-arcgispro — 常驻 arcpy 执行桥。

## 为什么必须常驻

实测（Pro 3.6 / Python 3.13.7）：`import arcpy` 耗时 **20.6 秒**，之后单次
GP 调用只有几十毫秒。若每次请求起一个新进程，"查一个字段"会从毫秒级变成
半分钟，所以桥只在启动时付一次 import 成本，此后走 stdin/stdout 上的
JSON Lines 请求-响应循环。

## 协议

一行一个 JSON，UTF-8，无 BOM：

    请求  {"id":"1","op":"gp.execute","params":{...}}
    响应  {"id":"1","ok":true,"result":{...},"elapsedMs":12}
          {"id":"1","ok":false,"error":{"type":"RuntimeError","message":"...",
                                        "messages":"...","traceback":"..."}}

## 一个必须做对的地方

arcpy 及其调用的 GP 工具会往 **stdout** 打印大量消息（许可提示、进度、警告）。
任何一条混进协议流，整条 JSON 行就解析失败，而且失败点常常离真正的原因很远
（读起来像工具参数错）。所以启动后第一件事是把 fd 1 复制成协议通道，再把
fd 1 本身指向 stderr：GP 的一切打印落进 stderr（宿主侧收进日志），协议通道
只剩响应。Python 层的 `print` 同步改道，因为 dup2 只改 C 层 fd。
"""

import json
import os
import sys
import time
import traceback

# --- 协议通道与 stdout 隔离 ------------------------------------------------
# 必须在 import arcpy 之前完成：arcpy 导入期自己就会打印许可信息。
_PROTOCOL_FD = os.dup(1)
os.dup2(2, 1)
_PROTOCOL = os.fdopen(_PROTOCOL_FD, "w", encoding="utf-8", newline="\n")
sys.stdout = sys.stderr
try:
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BOOT_AT = time.time()

import arcutil  # noqa: E402  （在 stdout 隔离之后导入，其 import arcpy 的打印也会落进 stderr）


def handle(request):
    """执行一条请求，永远返回可序列化的 dict。"""
    req_id = request.get("id")
    op = str(request.get("op") or "")
    params = request.get("params") or {}
    started = time.time()

    if not arcutil.available():
        return {
            "id": req_id, "ok": False,
            "error": {
                "type": "ArcPyUnavailable",
                "message": "无法导入 arcpy，ArcGIS Pro 的 Python 环境不可用。",
                "messages": "",
                "traceback": repr(arcutil._IMPORT_ERROR),
            },
        }

    handler = HANDLERS.get(op)
    if handler is None:
        return {
            "id": req_id, "ok": False,
            "error": {
                "type": "UnknownOp",
                "message": "未知操作 %r。可用操作：%s" % (op, ", ".join(sorted(HANDLERS))),
                "messages": "",
                "traceback": "",
            },
        }
    try:
        # 先排空：GP 消息缓冲是进程级全局，上一次调用的残留会挂在这次头上，
        # 让 "文件夹不存在" 这种错后面跟着一段无关的 "行计数 = 5"。
        arcutil.drain_messages()
        result = handler(params if isinstance(params, dict) else {})
        return {
            "id": req_id, "ok": True,
            "result": arcutil.to_jsonable(result),
            "elapsedMs": int((time.time() - started) * 1000),
        }
    except Exception as exc:
        return {
            "id": req_id, "ok": False,
            "elapsedMs": int((time.time() - started) * 1000),
            "error": {
                "type": type(exc).__name__,
                "message": str(exc),
                # GP 的真实错误常在 messages 里，而 str(exc) 往往只有一句话。
                "messages": arcutil.drain_messages(),
                "traceback": traceback.format_exc(limit=8),
            },
        }


def serve():
    """JSON Lines 主循环。EOF 即退出。"""
    for raw in sys.stdin.buffer:
        line = raw.decode("utf-8", "replace").strip()
        if line == "":
            continue
        try:
            request = json.loads(line)
        except Exception as exc:
            _emit({"id": None, "ok": False,
                   "error": {"type": "BadRequest",
                             "message": "请求不是合法 JSON：%s" % exc,
                             "messages": "", "traceback": ""}})
            continue
        if not isinstance(request, dict):
            _emit({"id": None, "ok": False,
                   "error": {"type": "BadRequest",
                             "message": "请求必须是 JSON 对象",
                             "messages": "", "traceback": ""}})
            continue
        if request.get("op") == "shutdown":
            _emit({"id": request.get("id"), "ok": True, "result": {"bye": True}})
            return
        _emit(handle(request))


def _emit(payload):
    text = json.dumps(payload, ensure_ascii=False, allow_nan=False, default=str)
    _PROTOCOL.write(text + "\n")
    _PROTOCOL.flush()


# --- 操作表 ----------------------------------------------------------------
# 各模块把自己的 handler 并进同一张表；导入放在函数定义之后，避免循环引用。
from ops_core import HANDLERS as _CORE        # noqa: E402
from ops_project import HANDLERS as _PROJECT  # noqa: E402
from ops_data import HANDLERS as _DATA        # noqa: E402
from ops_analysis import HANDLERS as _ANALYSIS  # noqa: E402
from ops_layer import HANDLERS as _LAYER  # noqa: E402
from ops_python import HANDLERS as _PYTHON  # noqa: E402

HANDLERS = {}
HANDLERS.update(_CORE)
HANDLERS.update(_PROJECT)
HANDLERS.update(_DATA)
HANDLERS.update(_ANALYSIS)
HANDLERS.update(_LAYER)
HANDLERS.update(_PYTHON)


def _boot_info(params):
    return {
        "python": sys.version,
        "executable": sys.executable,
        "arcpyVersion": getattr(arcutil.arcpy, "__version__", None),
        "bootSeconds": round(time.time() - BOOT_AT, 1),
        "operations": len(HANDLERS),
    }


HANDLERS["boot"] = _boot_info


if __name__ == "__main__":
    try:
        serve()
    except (KeyboardInterrupt, BrokenPipeError):
        pass
