/**
 * 检修工作票领域模型。
 *
 * 这一块不再走通用模块的「只改 status 显示」逻辑：完工必须把
 * 检修状态、实际工期、验收人员、验收结论一次性落库，列表页、
 * 详情面板、另存清单、概览统计、技术供水值班台账读的都是同一份记录。
 */

/** 工作票生命周期：只能沿流转顺序前进；唯一的回退是「驳回」（已批准 -> 待审批）。 */
export type OverhaulStatus = '待审批' | '已批准' | '检修中' | '已完工'

export const OVERHAUL_FLOW: OverhaulStatus[] = ['待审批', '已批准', '检修中', '已完工']

export type AcceptanceGrade = '优良' | '合格' | '不合格'

/** 历史结论：每次换版重算或重复完工时，上一版结论原样保留等级与版本，不覆盖。 */
export type HistoricalVerdict = {
  grade: AcceptanceGrade
  version: string
  reason: string
  decidedAt: string
}

export type OverhaulTicket = {
  id: number
  status: OverhaulStatus
  /** 通用概览仍读 pending：除「已完工」外都算在途。 */
  pending: boolean
  /** 驳回、缺项等需要看板关注时置 true。 */
  abnormal: boolean

  工作票号: string
  检修机组: string
  检修级别: string
  /** 计划开工日期 YYYY-MM-DD。 */
  计划开工: string
  /** 计划完工日期 YYYY-MM-DD。 */
  计划完工: string
  计划工期: string
  /** 实际开工日期 YYYY-MM-DD；完工落库前为空。 */
  实际开工: string
  /** 实际完工日期 YYYY-MM-DD；完工落库前为空。 */
  实际完工: string
  /** 实际工期文案，如「6 天」；未完工为空。 */
  实际工期: string
  实际工期天数: number | null

  工作负责人: string
  /** 验收人员：完工表单落库，不再只存在前端表单里。 */
  验收人员: string
  /** 验收结论：优良/合格/不合格；未完工为空。 */
  验收结论: AcceptanceGrade | ''
  /** 得出当前结论时所用的验收规则版本，如 v1/v2。 */
  结论版本: string
  历史结论: HistoricalVerdict[]

  /** 驳回/完工/回填/缺项补录全部在这里留痕。 */
  备注: string
  完工次数: number
  完工时间: string
  /** 回填游标用：未参与过存量回填为 false。 */
  已回填: boolean
  created_at: string
  updated_at: string

  [field: string]: string | number | boolean | null | HistoricalVerdict[]
}

export type CompleteTicketInput = {
  实际开工: string
  实际完工: string
  验收人员: string
  /** 留空表示按当前版本规则按工期偏差自动评定。 */
  验收结论: AcceptanceGrade | ''
}

export type ActionResult2 = {
  ok: boolean
  message: string
}

/** 验收等级规则：换版只新增版本，老结论带着当时的版本号保留。 */
export type GradeRule = {
  version: string
  label: string
  /** 实际工期相对计划工期的偏差区间（百分比，含边界）。 */
  excellent: (ratio: number) => boolean
  pass: (ratio: number) => boolean
}

/**
 * v1（原始版）：按期或提前为优良，超期 10% 以内合格。
 * v2（现行版）：结合检修实际，允许 5% 的提前裕量与 15% 的超期窗口。
 */
export const GRADE_RULES: GradeRule[] = [
  {
    version: 'v1',
    label: '按期即优良，超期 10% 以内合格',
    excellent: (ratio) => ratio <= 0,
    pass: (ratio) => ratio <= 10,
  },
  {
    version: 'v2',
    label: '提前不超过 5% 至按期为优良，超期 15% 以内合格',
    excellent: (ratio) => ratio <= 5,
    pass: (ratio) => ratio <= 15,
  },
]

export const CURRENT_GRADE_VERSION = GRADE_RULES[GRADE_RULES.length - 1].version

/** 技术供水值班台账：完工、回填、换版的处理结果都回写一份到这里。 */
export type DutyLedgerEntry = {
  id: number
  关联工作票: string
  检修机组: string
  处理动作: '办理完工' | '驳回' | '存量回填' | '缺项补录' | '换版重算'
  验收人员: string
  验收结论: AcceptanceGrade | ''
  结论版本: string
  实际工期: string
  记录时间: string
  备注: string
  [field: string]: string | number
}

/** 缺项补录清单：历史票里推算不出来的字段单列，由人工核实后补录。 */
export type MissingItem = {
  id: number
  工作票号: string
  检修级别: string
  缺项字段: string
  补录方式: '人工核实补录'
  处理状态: '待补录' | '已补录'
  补录值: string
  补录时间: string
  理由: string
  created_at: string
  [field: string]: string | number
}

/** 存量回填游标：中断后从断掉的那一条接着走。 */
export type BackfillCursor = {
  /** 已处理到的工作票号；严格按计划开工+票号排序。 */
  processedTicketNos: string[]
  updatedAt: string
  done: boolean
}

export type OverhaulStats = {
  pendingApproval: number
  inMaintenance: number
  inMaintenanceUnits: number
  completed: number
  total: number
  ledgerCount: number
  missingCount: number
}

export type ConsistencyCheck = {
  listCount: number
  storageCount: number
  exportCount: number
  ledgerCount: number
  inMaintenanceUnits: number
  /** 四个口径全部一致。 */
  aligned: boolean
}
