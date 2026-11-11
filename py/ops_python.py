"""在桥进程里直接跑 arcpy 代码。

为什么需要这个：桥只包了 90 个操作，而 arcpy 的 API 面比这宽得多——arcpy.da 的
游标、arcpy.metadata、CIM 深度定制、第三方扩展（geoai / parcel 之类）都够不着。
GP 工具那条路（arcgis_tool_run）能覆盖 1977 个工具，但覆盖不了 Python 层的东西。

与其继续一个一个包工具（包不完，而且每加一个就多一处要维护的契约），不如给一个
能直达的入口——这是"能调用所有功能"唯一诚实的实现方式。

代价必须讲清楚：这里执行的是任意代码，没有参数校验、没有回滚、没有 dry-run。
工具层强制要求 writeAllowed，并且描述里写明了这一点。
"""

import contextlib
import io
import traceback

import arcutil
import ops_project


def op_python_run(params):
    code = params.get("code")
    if not isinstance(code, str) or code.strip() == "":
        raise ValueError("需要 code：要执行的 Python 源码。")

    # arcpy 已经在桥进程里导入好了，直接给出去，省掉每次 import 的十几秒。
    namespace = {
        "__name__": "__arcgis_python__",
        "arcpy": arcutil.api(),
        "arcutil": arcutil,
        # 当前工程对象：不给的话脚本里还得自己 ArcGISProject(path)，拿到的会是
        # 另一个实例，和后续工具的内存状态对不上（两份 aprx 各改各的）。
        "aprx": ops_project._STATE.get("aprx"),
        "print": print,
        "__builtins__": __builtins__,
    }
    injected = params.get("globals")
    if isinstance(injected, dict):
        for key, value in injected.items():
            namespace[str(key)] = arcutil.coerce(value)

    stdout, stderr = io.StringIO(), io.StringIO()
    failure = None
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            exec(compile(code, "<arcgis_python>", "exec"), namespace)  # noqa: S102
    except Exception as exc:  # noqa: BLE001 - 用户代码的异常要原样带回去
        failure = {
            "type": type(exc).__name__,
            "message": str(exc),
            "traceback": traceback.format_exc(limit=12),
        }

    payload = {
        "ok": failure is None,
        "stdout": stdout.getvalue(),
        "stderr": stderr.getvalue(),
    }
    if failure is not None:
        payload["error"] = failure
        # GP 的报错细节常在消息队列里，str(exc) 只有一句话。
        payload["messages"] = arcutil.drain_messages()

    # 约定：脚本把要返回的东西放进 result 变量。用 `in` 而不是 `is not None`，
    # 这样显式 `result = None` 也会被当成"我就是要返回 None"。
    if "result" in namespace:
        payload["result"] = arcutil.to_jsonable(namespace["result"])
    if "aprx" in namespace and namespace["aprx"] is not None:
        payload["project"] = ops_project._STATE.get("path")
    return payload


HANDLERS = {
    "python.run": op_python_run,
}
