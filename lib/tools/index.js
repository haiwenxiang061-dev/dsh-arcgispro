/**
 * 工具汇总。每个分组都是一个 `(bridge) => Tool[]` 工厂，
 * 由 `lib/index.js` 在 apply 时统一注册。
 */

import { statusTools } from './status.js'
import { gpTools } from './gp.js'
import { projectTools } from './project.js'
import { layerTools } from './layer.js'
import { dataTools } from './data.js'
import { analysisTools } from './analysis.js'

export { statusTools, gpTools, projectTools, layerTools, dataTools, analysisTools }

/** 全量工具。顺序即模型目录里的展示顺序：状态 → 工具 → 工程 → 图层 → 数据 → 分析。 */
export function allTools(bridge) {
  return [
    ...statusTools(bridge),
    ...gpTools(bridge),
    ...projectTools(bridge),
    ...layerTools(bridge),
    ...dataTools(bridge),
    ...analysisTools(bridge),
  ]
}
