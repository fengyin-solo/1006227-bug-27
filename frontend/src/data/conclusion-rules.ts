import type { ConclusionRule } from './types'

// 验收结论按「计划工期 / 实际工期」的比值（工期兑现率）自动定级：
// 比值越高说明越按计划甚至提前完成；人工也可在办理完工时直接指定等级。
// 换版时只改阈值，不重写历史；旧结论保留当时等级并在备注里注明版本。
export const CONCLUSION_RULES: ConclusionRule[] = [
  {
    version: 'v1',
    label: '初版验收规则（2024版）',
    effectiveFrom: '2024-01-01',
    grade(ratio: number) {
      if (ratio >= 1.1) return '优良'
      if (ratio >= 0.9) return '合格'
      if (ratio >= 0.75) return '基本合格'
      return '不合格'
    },
  },
  {
    // v2 收紧了「优良」门槛（提前完工才给），并把基本合格的下限抬到 0.8。
    version: 'v2',
    label: '现行验收规则（2026修订版）',
    effectiveFrom: '2026-01-01',
    grade(ratio: number) {
      if (ratio >= 1.25) return '优良'
      if (ratio >= 1.0) return '合格'
      if (ratio >= 0.8) return '基本合格'
      return '不合格'
    },
  },
]

export const DEFAULT_RULE_VERSION = 'v1'

export function ruleOf(version: string): ConclusionRule {
  return CONCLUSION_RULES.find((rule) => rule.version === version) ?? CONCLUSION_RULES[0]
}

export function gradeByRule(plannedDays: number, actualDays: number, version: string): string {
  if (!plannedDays || !actualDays) {
    return ''
  }
  return ruleOf(version).grade(plannedDays / actualDays)
}
