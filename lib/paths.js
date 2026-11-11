/**
 * 找到能用 arcpy 的那个 python.exe。
 *
 * ArcGIS Pro 的 Python 不在 PATH 里，安装位置由注册表决定。实测本机：
 *   HKLM\SOFTWARE\ESRI\ArcGISPro  InstallDir = F:\arcgispro\
 *   → F:\arcgispro\bin\Python\envs\arcgispro-py3\python.exe
 *
 * 顺序：显式配置 → 环境变量 → 注册表 → 常见安装路径。前者永远优先，
 * 因为开发机可能同时装了多个 Pro 版本，而用户明确指定的那个才算数。
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const REGISTRY_KEYS = [
  'HKLM\\SOFTWARE\\ESRI\\ArcGISPro',
  'HKLM\\SOFTWARE\\WOW6432Node\\ESRI\\ArcGISPro',
]

/** Pro 里 arcpy 所在的环境，相对于安装目录。 */
const ENV_SUFFIX = ['bin', 'Python', 'envs', 'arcgispro-py3', 'python.exe']

/** 注册表读不到时的兜底路径。 */
const COMMON_ROOTS = [
  'C:\\Program Files\\ArcGIS\\Pro',
  'C:\\Program Files (x86)\\ArcGIS\\Pro',
  'D:\\Program Files\\ArcGIS\\Pro',
  'F:\\arcgispro',
  'E:\\arcgispro',
  'D:\\arcgispro',
]

/**
 * 解析 `reg query` 的输出，取 REG_SZ 的值。
 * 输出形如：
 *   HKEY_LOCAL_MACHINE\SOFTWARE\ESRI\ArcGISPro
 *       InstallDir    REG_SZ    F:\arcgispro\
 */
function parseRegValue(stdout, valueName) {
  for (const raw of String(stdout).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const match = line.match(/^(\S+)\s+REG_\w+\s+(.*)$/)
    if (!match) continue
    if (valueName && match[1].toLowerCase() !== valueName.toLowerCase()) continue
    const value = match[2].trim()
    if (value) return value
  }
  return null
}

async function readInstallDir() {
  for (const key of REGISTRY_KEYS) {
    try {
      const { stdout } = await execFileAsync('reg', ['query', key, '/v', 'InstallDir'], {
        windowsHide: true,
        timeout: 5000,
      })
      const value = parseRegValue(stdout, 'InstallDir')
      if (value) return value
    } catch {
      // 这个键不存在，换下一个
    }
  }
  return null
}

async function readVersion() {
  for (const key of REGISTRY_KEYS) {
    try {
      const { stdout } = await execFileAsync('reg', ['query', key, '/v', 'Version'], {
        windowsHide: true,
        timeout: 5000,
      })
      const value = parseRegValue(stdout, 'Version')
      if (value) return value
    } catch {
      // 同上
    }
  }
  return null
}

function candidateFrom(installDir) {
  if (!installDir) return null
  const trimmed = String(installDir).replace(/[\\/]+$/, '')
  return join(trimmed, ...ENV_SUFFIX)
}

/**
 * 定位 python.exe。
 * @param {{python?: string}} options 显式指定的解释器路径
 * @returns {Promise<{python: string, source: string, installDir: string|null, version: string|null}>}
 */
export async function locatePython(options = {}) {
  const explicit = options.python || process.env.DSH_ARCGISPRO_PYTHON
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(
        `指定的 ArcGIS Pro Python 不存在：${explicit}\n` +
          '检查 DSH_ARCGISPRO_PYTHON 或插件配置里的 python 路径。',
      )
    }
    const installDir = await readInstallDir()
    return { python: explicit, source: 'configured', installDir, version: await readVersion() }
  }

  const installDir = await readInstallDir()
  const version = await readVersion()
  const fromRegistry = candidateFrom(installDir)
  if (fromRegistry && existsSync(fromRegistry)) {
    return { python: fromRegistry, source: 'registry', installDir, version }
  }

  for (const root of COMMON_ROOTS) {
    const candidate = candidateFrom(root)
    if (candidate && existsSync(candidate)) {
      return { python: candidate, source: 'common-path', installDir: root, version }
    }
  }

  const tried = [fromRegistry, ...COMMON_ROOTS.map(candidateFrom)].filter(Boolean)
  throw new Error(
    '找不到 ArcGIS Pro 的 Python 环境（arcgispro-py3）。\n' +
      `已尝试：\n${tried.map((one) => `  - ${one}`).join('\n')}\n` +
      '请安装 ArcGIS Pro，或用 DSH_ARCGISPRO_PYTHON 环境变量 / 插件配置指定 python.exe。',
  )
}

/** 只读探测，不抛错：给状态工具用。 */
export async function probeInstallation() {
  const installDir = await readInstallDir()
  const version = await readVersion()
  const python = candidateFrom(installDir)
  return {
    installDir,
    version,
    python,
    pythonExists: python ? existsSync(python) : false,
  }
}
