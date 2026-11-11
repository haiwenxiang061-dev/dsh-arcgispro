/**
 * 常驻 arcpy 桥的 Node 侧客户端。
 *
 * ## 为什么要常驻
 *
 * 实测 Pro 3.6 / Python 3.13.7：`import arcpy` 一次 15-21 秒，之后每次 GP 调用
 * 5-40 毫秒。若每个工具调用起一个新进程，"读一个字段"会从毫秒变半分钟。
 * 所以桥进程活到宿主关闭为止，每次调用只写一行 JSON。
 *
 * ## 串行
 *
 * arcpy 不是线程安全的（`env.workspace`、当前许可、GP 消息缓冲全是进程级全局
 * 状态），并发调用会互相污染。所有请求排成一条链，前一个 settle 再发下一个。
 * 单个调用本身在 Python 侧同步执行，Node 侧排队不会额外增加延迟。
 */

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

/** 单次调用默认超时。GP 工具跑长任务很正常，给足 5 分钟。 */
const DEFAULT_TIMEOUT_MS = 300_000

/** 启动要等 `import arcpy`，实测 15-21 秒，留足余量。 */
const START_TIMEOUT_MS = 180_000

/** stderr 只留最近这么多行做诊断，arcpy 打印量可能很大。 */
const STDERR_TAIL = 80

export class ArcPyError extends Error {
  constructor(payload) {
    const info = payload?.error ?? {}
    super(info.message || 'arcpy 调用失败')
    this.name = 'ArcPyError'
    this.type = info.type || 'Error'
    this.op = payload?.op
    this.messages = info.messages || ''
    this.traceback = info.traceback || ''
    this.elapsedMs = payload?.elapsedMs
  }

  /** 拼成一段模型能直接读懂的错误描述。 */
  toText() {
    const parts = [`${this.type}: ${this.message}`]
    if (this.messages && this.messages.trim() !== '') parts.push(`GP 消息:\n${this.messages.trim()}`)
    return parts.join('\n')
  }
}

export class ArcPyBridge extends EventEmitter {
  #proc = null
  #closed = false
  #starting = null
  #bootInfo = null
  #nextId = 1
  #pending = new Map()
  #queue = Promise.resolve()
  #buffer = ''
  #stderr = []
  #python
  #script

  /**
   * @param {{python: string, script: string, cwd?: string}} options
   *   python — arcgispro-py3 的 python.exe
   *   script — bridge.py 的绝对路径
   */
  constructor(options) {
    super()
    this.#python = options.python
    this.#script = options.script
    this.cwd = options.cwd
  }

  get running() {
    return this.#proc !== null && !this.#closed
  }

  get bootInfo() {
    return this.#bootInfo
  }

  /** 最近的一段 stderr，用于把 arcpy 的底层抱怨暴露给模型。 */
  get stderrTail() {
    return this.#stderr.join('')
  }

  async start() {
    if (this.#closed) {
      // 之前 stop 过，允许重新拉起
      this.#closed = false
    }
    if (this.running && this.#bootInfo) return this.#bootInfo
    if (this.#starting) return this.#starting
    this.#starting = this.#spawnAndBoot()
    try {
      this.#bootInfo = await this.#starting
      return this.#bootInfo
    } finally {
      this.#starting = null
    }
  }

  async #spawnAndBoot() {
    const proc = spawn(this.#python, [this.#script], {
      cwd: this.cwd,
      // windowsHide：不弹黑框。桥是纯 stdio 的，不需要控制台。
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // 桥自己会 reconfigure，但这两个能让 arcpy 早期打印也用 UTF-8。
        // 中文路径和中文属性值在 cp936 下会变成 Ҫ��ͼ�� 这种乱码。
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        PYTHONUNBUFFERED: '1',
      },
    })

    this.#proc = proc
    this.#buffer = ''
    this.#stderr = []

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => this.#onStdout(chunk))
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk) => this.#onStderr(chunk))

    proc.on('error', (error) => {
      this.#failAll(new Error(`无法启动 arcpy 桥（${this.#python}）：${error.message}`))
    })

    proc.on('exit', (code, signal) => {
      const wasRunning = this.#proc === proc
      this.#proc = null
      if (!wasRunning) return
      const detail = signal ? `signal ${signal}` : `exit code ${code}`
      const tail = this.#stderr.join('').trim()
      this.#failAll(
        new Error(`arcpy 桥已退出（${detail}）。${tail ? `\nstderr:\n${tail.slice(-2000)}` : ''}`),
      )
      this.emit('exit', { code, signal })
    })

    // 启动握手：boot 会返回 python/arcpy 版本和操作表大小。
    const info = await this.#transmit('boot', {}, START_TIMEOUT_MS)
    return info
  }

  #onStdout(chunk) {
    this.#buffer += chunk
    let index = this.#buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.#buffer.slice(0, index)
      this.#buffer = this.#buffer.slice(index + 1)
      this.#onLine(line)
      index = this.#buffer.indexOf('\n')
    }
  }

  #onLine(line) {
    const text = line.trim()
    if (text === '') return
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      // 协议流里出现非 JSON，说明有东西绕过了 stdout 重定向。
      // 不抛错——把原文塞进 stderr 尾部，最后会用得上。
      this.#pushStderr(`[bridge 非协议输出] ${text}\n`)
      return
    }
    const id = payload?.id == null ? null : String(payload.id)
    if (id === null) return
    const entry = this.#pending.get(id)
    if (!entry) return
    this.#pending.delete(id)
    clearTimeout(entry.timer)
    if (payload.ok === false) {
      entry.reject(new ArcPyError({ ...payload, op: entry.op }))
    } else {
      entry.resolve(payload.result)
    }
  }

  #onStderr(chunk) {
    this.#pushStderr(chunk)
  }

  #pushStderr(text) {
    this.#stderr.push(text)
    // 按行裁剪，不按字节——半行日志切断了反而误导。
    if (this.#stderr.length > STDERR_TAIL * 4) {
      this.#stderr = this.#stderr.slice(-STDERR_TAIL * 2)
    }
  }

  #failAll(error) {
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.#pending.clear()
  }

  /**
   * 调一次桥。返回 result（失败抛 ArcPyError）。
   * 用 opts.timeoutMs 覆盖默认超时。
   */
  async call(op, params = {}, opts = {}) {
    if (!this.running) await this.start()
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const run = () => this.#transmit(op, params, timeoutMs)
    // 串行：把这次调用接在队尾，无论前一个成功还是失败都继续。
    const settled = this.#queue.then(run, run)
    this.#queue = settled.then(
      () => undefined,
      () => undefined,
    )
    return settled
  }

  #transmit(op, params, timeoutMs) {
    if (!this.running || this.#proc === null) {
      return Promise.reject(new Error('arcpy 桥未运行。'))
    }
    const id = String(this.#nextId++)
    const request = JSON.stringify({ id, op, params: params ?? {} })

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(
          new Error(
            `arcpy 调用超时（${Math.round(timeoutMs / 1000)}s）：${op}。` +
              '长任务可以调大 timeoutMs；若工具本身卡住，先 arcgis_status 看桥是否还活着。',
          ),
        )
      }, timeoutMs)
      timer.unref?.()
      this.#pending.set(id, { resolve, reject, timer, op })
      try {
        this.#proc.stdin.write(request + '\n', 'utf8')
      } catch (error) {
        this.#pending.delete(id)
        clearTimeout(timer)
        reject(new Error(`向 arcpy 桥写入请求失败：${error.message}`))
      }
    })
  }

  /** 优雅关闭：先让 Python 侧退出循环，超时再强杀。 */
  async stop() {
    const proc = this.#proc
    if (!proc) {
      this.#closed = true
      return
    }
    this.#closed = true
    const exited = new Promise((resolve) => proc.once('exit', resolve))
    try {
      proc.stdin.write(JSON.stringify({ id: 'shutdown', op: 'shutdown' }) + '\n', 'utf8')
    } catch {
      // stdin 已关，直接走 kill
    }
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        // 已经死了
      }
    }, 3000)
    timer.unref?.()
    await exited
    clearTimeout(timer)
    this.#proc = null
    this.#bootInfo = null
    this.#failAll(new Error('arcpy 桥已关闭。'))
  }

  /** 诊断快照：给 arcgis_status 用。 */
  snapshot() {
    return {
      running: this.running,
      pending: this.#pending.size,
      queueDepth: this.#pending.size,
      python: this.#python,
      script: this.#script,
      boot: this.#bootInfo,
      stderrTail: this.stderrTail.trim().split('\n').slice(-20).join('\n'),
    }
  }
}
