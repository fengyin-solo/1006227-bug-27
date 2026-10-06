/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type JsonScalar = string | number | boolean | null
// 行内字段只存标量；附属集合（台账、快照等）各自有具名类型，不在行里放嵌套结构，
// 既够用也避免递归联合把 TS 类型推导拖爆。
export type JsonValue = JsonScalar

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: JsonValue
}

/** 一条流转边：动作只能把记录从 from 推到 to。reverse=true 表示这是「退回上一档」的既定入口。 */
export type TransitionRule = {
  from: string
  to: string
  reverse?: boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  /** 不填则沿用旧约定：动作只要目标态存在就允许；填了就按这里的边严格校验，正向只能逐档流转。 */
  transitions?: Record<string, TransitionRule>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

/** 办理完工时一次性落库的业务载荷：缺项在这里就拦下，不允许写进半条记录。 */
export type CompleteTicketPayload = {
  actualDays: number
  inspector: string
  conclusion: '' | '优良' | '合格' | '基本合格' | '不合格'
  remark?: string
}

export type ActionResult = {
  ok: boolean
  message: string
  /** 完工等动作回传最新行，页面直接用这份刷新，不再各算各的。 */
  row?: EntryRow
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 技术供水值班台账里的检修处理结果条目，两个入口同读这一份。 */
export type DutyLedgerEntry = {
  id: number
  ticketId: number
  ticketNo: string
  unit: string
  level: string
  status: string
  actualDays: number
  plannedDays: number
  inspector: string
  conclusion: string
  ruleVersion: string
  completedAt: string
  remark: string
  source: '完工办理' | '历史回填' | '换版重算'
}

/** 「另存工作票清单」生成的快照：列表、详情面板、另存清单永远指向同一份数据。 */
export type TicketSnapshot = {
  id: number
  savedAt: string
  operator: string
  total: number
  inOverhaul: number
  completed: number
  items: EntryRow[]
}

/** 存量回填时缺项单独补录的审计记录，补齐方式与理由写在 remark 里。 */
export type BackfillSupplement = {
  id: number
  ticketId: number
  ticketNo: string
  missingField: '实际工期' | '验收人员' | '验收结论'
  filledValue: string
  ruleVersion: string
  remark: string
  processedAt: string
}

export type BackfillProgress = {
  version: string
  total: number
  processed: number
  lastTicketId: number | null
  finished: boolean
  updatedAt: string
  supplements: BackfillSupplement[]
}

export type ConclusionRule = {
  version: string
  label: string
  effectiveFrom: string
  grade: (ratio: number) => '优良' | '合格' | '基本合格' | '不合格'
}

export type AppSettings = {
  conclusionRuleVersion: string
}
