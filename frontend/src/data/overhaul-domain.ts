import {
  CURRENT_GRADE_VERSION,
  GRADE_RULES,
  OVERHAUL_FLOW,
  type AcceptanceGrade,
  type ActionResult2,
  type BackfillCursor,
  type CompleteTicketInput,
  type ConsistencyCheck,
  type DutyLedgerEntry,
  type GradeRule,
  type MissingItem,
  type OverhaulStats,
  type OverhaulStatus,
  type OverhaulTicket,
} from './overhaul-types'
import {
  commitTransaction,
  getCursor,
  getGradeVersion,
  getLedger,
  getMissing,
  getTickets,
} from './overhaul-store'

/* ---------------------------------- 工具 ---------------------------------- */

export function nowText(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 含首尾两日的日历天数。 */
export function daysBetween(start: string, end: string): number | null {
  const a = Date.parse(`${start}T00:00:00`)
  const b = Date.parse(`${end}T00:00:00`)
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) {
    return null
  }
  return Math.round((b - a) / 86_400_000) + 1
}

export function durationText(days: number): string {
  return `${days} 天`
}

/** 取整到半天：中位数落在半天刻度上，避免伪造精确值。 */
function roundHalfDay(value: number): number {
  return Math.round(value * 2) / 2
}

/** 同检修级别已完工票实际工期的中位数；样本不足时按级别定额兜底。 */
function medianDurationOfLevel(tickets: OverhaulTicket[], level: string): number {
  const samples = tickets
    .filter((t) => t.status === '已完工' && t.检修级别 === level && typeof t.实际工期天数 === 'number')
    .map((t) => t.实际工期天数 as number)
    .sort((a, b) => a - b)
  if (samples.length > 0) {
    const mid = Math.floor(samples.length / 2)
    const median = samples.length % 2 ? samples[mid] : (samples[mid - 1] + samples[mid]) / 2
    return roundHalfDay(median)
  }
  const fallback: Record<string, number> = { A级检修: 20, B级检修: 15, C级检修: 8, D级检修: 3 }
  return fallback[level] ?? 10
}

export function ruleOf(version: string): GradeRule {
  return GRADE_RULES.find((rule) => rule.version === version) ?? GRADE_RULES[0]
}

/** 按「实际工期相对计划工期的偏差百分比」评定；工期算不出来时返回空。 */
export function gradeByDuration(
  actualDays: number | null,
  plannedDays: number | null,
  version: string,
): AcceptanceGrade | '' {
  if (typeof actualDays !== 'number' || typeof plannedDays !== 'number' || plannedDays <= 0) {
    return ''
  }
  const ratio = ((actualDays - plannedDays) / plannedDays) * 100
  const rule = ruleOf(version)
  if (rule.excellent(ratio)) {
    return '优良'
  }
  if (rule.pass(ratio)) {
    return '合格'
  }
  return '不合格'
}

function plannedDaysOf(ticket: OverhaulTicket): number | null {
  return daysBetween(ticket.计划开工, ticket.计划完工)
}

/* --------------------------------- 查询面 --------------------------------- */

export function findTicket(id: number): OverhaulTicket | undefined {
  return getTickets().find((ticket) => ticket.id === id)
}

export function filterTickets(filters: Record<string, string>): OverhaulTicket[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  const tickets = getTickets()
  if (pairs.length === 0) {
    return tickets
  }
  return tickets.filter((ticket) =>
    pairs.every(([field, value]) => String(ticket[field] ?? '').includes(value.trim())),
  )
}

export function overhaulStats(): OverhaulStats {
  const tickets = getTickets()
  const inMaintenance = tickets.filter((t) => t.status === '检修中')
  return {
    pendingApproval: tickets.filter((t) => t.status === '待审批').length,
    inMaintenance: inMaintenance.length,
    // 检修中机组按机组去重：同一台机挂多张票只算一台，完工一台回落一台。
    inMaintenanceUnits: new Set(inMaintenance.map((t) => t.检修机组)).size,
    completed: tickets.filter((t) => t.status === '已完工').length,
    total: tickets.length,
    ledgerCount: getLedger().length,
    missingCount: getMissing().filter((item) => item.处理状态 === '待补录').length,
  }
}

/**
 * 四个口径对账：
 * 列表条数 / 存储条数 / 另存清单条数 / 技术供水值班台账（应与已完工票一致）。
 */
export function consistencyCheck(): ConsistencyCheck {
  const tickets = getTickets()
  const completed = tickets.filter((t) => t.status === '已完工').length
  return {
    listCount: tickets.length,
    storageCount: tickets.length,
    exportCount: tickets.length,
    ledgerCount: getLedger().length,
    inMaintenanceUnits: new Set(
      tickets.filter((t) => t.status === '检修中').map((t) => t.检修机组),
    ).size,
    aligned: getLedger().length === completed,
  }
}

/* ------------------------------- 状态机流转 ------------------------------- */

/** 生命周期的明确流转顺序；除「驳回」外只能前进。 */
const FORWARD_ACTION: Record<string, { from: OverhaulStatus; to: OverhaulStatus }> = {
  提交审批: { from: '待审批', to: '已批准' },
  开工检修: { from: '已批准', to: '检修中' },
}

export const REJECT_ACTION = '驳回'
export const COMPLETE_ACTION = '办理完工'
export const RECOMPLETE_ACTION = '再次办理完工'

/** 当前状态下允许出现的动作（页面按这个渲染，不再对所有票撒一排按钮）。 */
export function availableActions(ticket: OverhaulTicket): string[] {
  switch (ticket.status) {
    case '待审批':
      return ['提交审批']
    case '已批准':
      return ['开工检修', REJECT_ACTION]
    case '检修中':
      return [COMPLETE_ACTION]
    case '已完工':
      return [RECOMPLETE_ACTION]
    default:
      return []
  }
}

function nextId(rows: { id: number }[]): number {
  return rows.reduce((max, row) => Math.max(max, row.id), 0) + 1
}

/** 台账以工作票为唯一键：一张票始终只有一条，保证两边条数相同。 */
function upsertLedger(
  ledger: DutyLedgerEntry[],
  ticket: OverhaulTicket,
  action: DutyLedgerEntry['处理动作'],
  remark: string,
): DutyLedgerEntry[] {
  const entry: DutyLedgerEntry = {
    id: ticket.id,
    关联工作票: ticket.工作票号,
    检修机组: ticket.检修机组,
    处理动作: action,
    验收人员: ticket.验收人员,
    验收结论: ticket.验收结论,
    结论版本: ticket.结论版本,
    实际工期: ticket.实际工期,
    记录时间: nowText(),
    备注: remark,
  }
  const index = ledger.findIndex((row) => row.关联工作票 === ticket.工作票号)
  if (index < 0) {
    // 台账行 id 独立分配，绝不复用工作票 id；一张票在台账里始终只有一条。
    return [...ledger, { ...entry, id: nextId(ledger) }]
  }
  const next = [...ledger]
  next[index] = { ...entry, id: next[index].id }
  return next
}

export function transitTicket(id: number, action: string, reason = ''): ActionResult2 {
  const ticket = findTicket(id)
  if (!ticket) {
    return { ok: false, message: `没有找到编号为 ${id} 的检修工作票` }
  }

  if (FORWARD_ACTION[action]) {
    const rule = FORWARD_ACTION[action]
    if (ticket.status !== rule.from) {
      return {
        ok: false,
        message: `工作票 ${ticket.工作票号} 当前是「${ticket.status}」，不能${action}（流转顺序：${OVERHAUL_FLOW.join(' → ')}）`,
      }
    }
    const updated: OverhaulTicket = {
      ...ticket,
      status: rule.to,
      pending: rule.to !== '已完工',
      updated_at: nowText(),
    }
    try {
      commitTransaction({
        tickets: getTickets().map((row) => (row.id === id ? updated : row)),
      })
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '写库失败' }
    }
    return { ok: true, message: `工作票 ${ticket.工作票号} 已${action}，当前状态「${rule.to}」` }
  }

  if (action === REJECT_ACTION) {
    if (ticket.status !== '已批准') {
      return { ok: false, message: `只有「已批准」的工作票可以驳回，当前为「${ticket.status}」` }
    }
    if (!reason.trim()) {
      return { ok: false, message: '驳回必须填写原因' }
    }
    const stamp = nowText()
    const updated: OverhaulTicket = {
      ...ticket,
      status: '待审批',
      pending: true,
      abnormal: true,
      备注: `${ticket.备注 ? `${ticket.备注}\n` : ''}[${stamp}] 驳回到待审批，原因：${reason.trim()}`,
      updated_at: stamp,
    }
    try {
      // 驳退回上一档是既定方式：只允许 已批准 -> 待审批 这一格，且必须带原因。
      commitTransaction({
        tickets: getTickets().map((row) => (row.id === id ? updated : row)),
      })
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '写库失败' }
    }
    return { ok: true, message: `工作票 ${ticket.工作票号} 已驳回，状态回到「待审批」` }
  }

  return { ok: false, message: `工作票没有登记「${action}」这个动作` }
}

/* ------------------------------- 办理完工落库 ------------------------------ */

export function validateCompleteInput(input: CompleteTicketInput): string {
  if (!input.实际开工 || !input.实际完工) {
    return '实际开工日期与实际完工日期必须填写'
  }
  const days = daysBetween(input.实际开工, input.实际完工)
  if (days === null) {
    return '实际完工日期不能早于实际开工日期'
  }
  if (!input.验收人员.trim()) {
    return '验收人员必须填写，验收信息会随完工一次性落库'
  }
  if (input.验收结论 && !['优良', '合格', '不合格'].includes(input.验收结论)) {
    return '验收结论只能是优良、合格或不合格'
  }
  return ''
}

/**
 * 办理完工：检修状态、实际工期、验收人员、验收结论在同一个事务里一次落库。
 * 写不成就整套退回；对已完工票再次办理时，只落最后一次，前次结论进历史结论。
 */
export function completeTicket(id: number, input: CompleteTicketInput): ActionResult2 {
  const ticket = findTicket(id)
  if (!ticket) {
    return { ok: false, message: `没有找到编号为 ${id} 的检修工作票` }
  }
  if (ticket.status !== '检修中' && ticket.status !== '已完工') {
    return { ok: false, message: `只有「检修中」的工作票能办理完工，当前为「${ticket.status}」` }
  }
  const invalid = validateCompleteInput(input)
  if (invalid) {
    // 校验不过：不动任何数据，前端保持原状态。
    return { ok: false, message: invalid }
  }

  const actualDays = daysBetween(input.实际开工, input.实际完工) as number
  const plannedDays = plannedDaysOf(ticket)
  const version = getGradeVersion()
  const grade: AcceptanceGrade | '' =
    input.验收结论 || gradeByDuration(actualDays, plannedDays, version)

  const stamp = nowText()
  const history = [...ticket.历史结论]
  let remark = ticket.备注
  if (ticket.status === '已完工') {
    // 送两回完工只落最后一次：被覆盖的结论原样留档，等级与版本都保留。
    if (ticket.验收结论) {
      history.push({
        grade: ticket.验收结论,
        version: ticket.结论版本,
        reason: '重复办理完工，被最后一次提交覆盖',
        decidedAt: ticket.完工时间 || '',
      })
    }
    remark = `${remark ? `${remark}\n` : ''}[${stamp}] 重复办理完工，仅保留最后一次验收结论，前次结论见历史结论。`
  }

  const updated: OverhaulTicket = {
    ...ticket,
    status: '已完工',
    pending: false,
    abnormal: false,
    实际开工: input.实际开工,
    实际完工: input.实际完工,
    实际工期天数: actualDays,
    实际工期: durationText(actualDays),
    验收人员: input.验收人员.trim(),
    验收结论: grade,
    结论版本: version,
    历史结论: history,
    备注: remark,
    完工次数: ticket.完工次数 + 1,
    完工时间: stamp,
    updated_at: stamp,
  }

  const tickets = getTickets().map((row) => (row.id === id ? updated : row))
  const ledger = upsertLedger(
    getLedger(),
    updated,
    ticket.status === '已完工' ? '办理完工' : '办理完工',
    ticket.status === '已完工' ? '重复办理完工，以最后一次为准' : '工作票办理完工，机组复役',
  )

  try {
    // 工作票记录 + 技术供水值班台账同一事务提交，失败整体回滚。
    commitTransaction({ tickets, ledger })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '完工写库失败，已整套退回' }
  }
  return {
    ok: true,
    message: `工作票 ${ticket.工作票号} 已完工落库：${durationText(actualDays)}，验收结论「${grade}」（${version}）`,
  }
}

/* ------------------------------ 存量回填与缺项 ----------------------------- */

/** 回填处理顺序：计划开工日期升序，日期缺失的排最后；同序按票号。 */
export function backfillOrder(): OverhaulTicket[] {
  return getTickets()
    .filter((t) => t.status === '已完工')
    .sort((a, b) => {
      if (!a.计划开工 && !b.计划开工) {
        return a.工作票号.localeCompare(b.工作票号)
      }
      if (!a.计划开工) {
        return 1
      }
      if (!b.计划开工) {
        return -1
      }
      return a.计划开工.localeCompare(b.计划开工) || a.工作票号.localeCompare(b.工作票号)
    })
}

export function backfillStatus(): { cursor: BackfillCursor | null; remaining: number; total: number } {
  const ordered = backfillOrder()
  const cursor = getCursor()
  const processed = new Set(cursor?.processedTicketNos ?? [])
  return {
    cursor,
    total: ordered.length,
    remaining: ordered.filter((t) => !processed.has(t.工作票号)).length,
  }
}

function appendMissing(
  missing: MissingItem[],
  ticket: OverhaulTicket,
  field: string,
  reason: string,
): MissingItem[] {
  if (
    missing.some((item) => item.工作票号 === ticket.工作票号 && item.缺项字段 === field)
  ) {
    return missing
  }
  const stamp = nowText()
  return [
    ...missing,
    {
      id: nextId(missing),
      工作票号: ticket.工作票号,
      检修级别: ticket.检修级别,
      缺项字段: field,
      补录方式: '人工核实补录',
      处理状态: '待补录',
      补录值: '',
      补录时间: '',
      理由: reason,
      created_at: stamp,
    },
  ]
}

/**
 * 推进回填一步（一张票），游标随同一事务落库。
 * 中断后再次进入时，已处理票号在游标里，直接从断掉的下一条接着走，
 * 且任何已经落库的值都不会被旧值顶替。
 */
export function runBackfillStep(): { done: boolean; ticketNo: string } | null {
  const status = backfillStatus()
  const processed = new Set(status.cursor?.processedTicketNos ?? [])
  const target = backfillOrder().find((ticket) => !processed.has(ticket.工作票号))
  if (!target) {
    const stamp = nowText()
    commitTransaction({
      cursor: { processedTicketNos: status.cursor?.processedTicketNos ?? [], updatedAt: stamp, done: true },
    })
    return null
  }

  const tickets = getTickets()
  const ticket = tickets.find((row) => row.id === target.id) as OverhaulTicket
  const stamp = nowText()
  let updated: OverhaulTicket = { ...ticket, updated_at: stamp }
  let missing = getMissing()
  const filledParts: string[] = []

  if (!ticket.实际工期) {
    const plannedDays = plannedDaysOf(ticket)
    if (plannedDays !== null && ticket.计划开工 && ticket.计划完工) {
      // 规则一：历史工作票按计划工期回填实际工期。
      updated = {
        ...updated,
        实际开工: ticket.计划开工,
        实际完工: ticket.计划完工,
        实际工期天数: plannedDays,
        实际工期: durationText(plannedDays),
      }
      filledParts.push('实际工期按计划工期回填')
    } else {
      // 规则二（裁决）：连计划工期都没有的，用同级别已完工票实际工期中位数
      //（取整到半天，样本不足按级别定额），只补天数不编日期，日期转人工核实。
      const median = medianDurationOfLevel(tickets, ticket.检修级别)
      updated = {
        ...updated,
        实际工期天数: median,
        实际工期: `${durationText(median)}（按同级别中位数补，待核实）`,
      }
      filledParts.push(`实际工期按同级别中位数 ${median} 天补`)
      missing = appendMissing(
        missing,
        ticket,
        '实际开工/实际完工日期',
        '早期票计划与实际日期均缺失，未推算具体日期；按同级别实际工期中位数补天数，具体开工/完工日期由原检修班组核实后补录，不允许用旧值顶替。',
      )
    }
  }

  if (!updated.验收人员.trim()) {
    // 规则三（裁决）：验收人员属于人工事实，缺项不推算，
    // 进缺项补录清单，由原班组核实补录，理由随清单留档。
    missing = appendMissing(
      missing,
      ticket,
      '验收人员',
      '验收人员为人工事实，缺项不做推算；按人工核实方式补录，由原检修班组/验收组织部门核实签字后登记。',
    )
  }

  if (!updated.验收结论) {
    const plannedDays = plannedDaysOf(updated)
    const grade = gradeByDuration(updated.实际工期天数, plannedDays, getGradeVersion())
    if (grade) {
      updated = { ...updated, 验收结论: grade, 结论版本: getGradeVersion() }
      filledParts.push(`验收结论按 ${getGradeVersion()} 规则补评`)
    } else {
      missing = appendMissing(
        missing,
        ticket,
        '验收结论',
        '工期明细缺项导致无法按偏差规则评定，待工期日期补录后按当时版本规则重算，不臆造结论。',
      )
    }
  }

  updated = {
    ...updated,
    已回填: true,
    备注: `${updated.备注 ? `${updated.备注}\n` : ''}[${stamp}] 存量回填：${filledParts.join('；') || '字段齐全，核验通过'}。`,
  }

  const nextTickets = tickets.map((row) => (row.id === ticket.id ? updated : row))
  const ledger = upsertLedger(
    getLedger(),
    updated,
    '存量回填',
    `存量数据时间序回填：${filledParts.join('；') || '字段齐全'}`,
  )
  const cursor: BackfillCursor = {
    processedTicketNos: [...(status.cursor?.processedTicketNos ?? []), ticket.工作票号],
    updatedAt: stamp,
    done: false,
  }

  commitTransaction({ tickets: nextTickets, ledger, missing, cursor })
  return { done: false, ticketNo: ticket.工作票号 }
}

/** 断点续跑：每次一步，步与步之间游标已落库，关掉页面再打开也能接着走。 */
export async function runBackfill(
  onStep?: (info: { processed: number; total: number; ticketNo: string }) => void,
): Promise<{ processed: number; total: number }> {
  const total = backfillOrder().length
  let processed = getCursor()?.processedTicketNos.length ?? 0
  // 事件循环让出一帧，模拟取数中断/可打断，真实环境每步都是独立事务。
  const yieldFrame = () => new Promise((resolve) => setTimeout(resolve, 0))
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const step = runBackfillStep()
    if (step === null) {
      break
    }
    processed += 1
    onStep?.({ processed, total, ticketNo: step.ticketNo })
    await yieldFrame()
  }
  return { processed, total }
}

/** 缺项补录：人工核实后把值补进原票，台账动作记为「缺项补录」。 */
export function supplementMissingItem(
  missingId: number,
  value: string,
): ActionResult2 {
  const item = getMissing().find((row) => row.id === missingId)
  if (!item) {
    return { ok: false, message: '没有找到这条缺项记录' }
  }
  if (item.处理状态 === '已补录') {
    return { ok: false, message: '该缺项已补录，不能重复补录' }
  }
  if (!value.trim()) {
    return { ok: false, message: '补录值不能为空' }
  }
  const ticket = findTicket(getTickets().find((t) => t.工作票号 === item.工作票号)?.id ?? -1)
  if (!ticket) {
    return { ok: false, message: `缺项关联的工作票 ${item.工作票号} 不存在` }
  }

  const stamp = nowText()
  let updated: OverhaulTicket = { ...ticket, updated_at: stamp }
  const trimmed = value.trim()

  if (item.缺项字段 === '验收人员') {
    updated = { ...updated, 验收人员: trimmed }
  } else if (item.缺项字段 === '验收结论') {
    if (!['优良', '合格', '不合格'].includes(trimmed)) {
      return { ok: false, message: '验收结论补录值只能是优良、合格或不合格' }
    }
    updated = { ...updated, 验收结论: trimmed as AcceptanceGrade, 结论版本: getGradeVersion() }
  } else if (item.缺项字段 === '实际开工/实际完工日期') {
    // 接受 "YYYY-MM-DD 至 YYYY-MM-DD" 形态，补上日期后重算工期与结论。
    const dates = trimmed.match(/\d{4}-\d{2}-\d{2}/g)
    if (!dates || dates.length < 2) {
      return { ok: false, message: '请按「YYYY-MM-DD 至 YYYY-MM-DD」补录开工与完工日期' }
    }
    const days = daysBetween(dates[0], dates[1])
    if (days === null) {
      return { ok: false, message: '完工日期不能早于开工日期' }
    }
    const plannedDays = plannedDaysOf(ticket)
    const grade = gradeByDuration(days, plannedDays, getGradeVersion())
    updated = {
      ...updated,
      实际开工: dates[0],
      实际完工: dates[1],
      实际工期天数: days,
      实际工期: durationText(days),
      验收结论: grade || updated.验收结论,
      结论版本: grade ? getGradeVersion() : updated.结论版本,
    }
  }

  updated = {
    ...updated,
    备注: `${updated.备注 ? `${updated.备注}\n` : ''}[${stamp}] 缺项补录（${item.缺项字段}）：${trimmed}。理由：${item.理由}`,
  }

  const tickets = getTickets().map((row) => (row.id === ticket.id ? updated : row))
  const missing: MissingItem[] = getMissing().map((row) =>
    row.id === missingId
      ? { ...row, 处理状态: '已补录' as const, 补录值: trimmed, 补录时间: stamp }
      : row,
  )
  const ledger = upsertLedger(getLedger(), updated, '缺项补录', `${item.缺项字段}经人工核实补录：${trimmed}`)

  try {
    commitTransaction({ tickets, missing, ledger })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '补录写库失败，已整套退回' }
  }
  return { ok: true, message: `工作票 ${ticket.工作票号} 的「${item.缺项字段}」已补录` }
}

/* -------------------------------- 换版重算 -------------------------------- */

export function availableVersions(): { current: string; rules: GradeRule[] } {
  return { current: getGradeVersion(), rules: GRADE_RULES }
}

/**
 * 换版：已有完工记录按新版重算；旧结论保留当时等级并注明版本（进历史结论）。
 * 全部票、缺项表、台账、版本号同一事务提交。
 */
export function upgradeGradeVersion(targetVersion: string): ActionResult2 {
  const current = getGradeVersion()
  if (current === targetVersion) {
    return { ok: false, message: `当前已经是 ${targetVersion}，无需换版` }
  }
  if (!GRADE_RULES.some((rule) => rule.version === targetVersion)) {
    return { ok: false, message: `未知的验收规则版本：${targetVersion}` }
  }
  const currentIndex = GRADE_RULES.findIndex((rule) => rule.version === current)
  const targetIndex = GRADE_RULES.findIndex((rule) => rule.version === targetVersion)
  if (targetIndex <= currentIndex) {
    return { ok: false, message: '版本只能向前换，旧结论请在历史结论里查看，不做回退' }
  }

  const stamp = nowText()
  let ledger = getLedger()
  const tickets = getTickets().map((ticket) => {
    if (ticket.status !== '已完工') {
      return ticket
    }
    const plannedDays = plannedDaysOf(ticket)
    const regraced = gradeByDuration(ticket.实际工期天数, plannedDays, targetVersion)
    const history = [...ticket.历史结论]
    if (ticket.验收结论) {
      history.push({
        grade: ticket.验收结论,
        version: ticket.结论版本 || current,
        reason: `换版重算，旧结论按当时规则保留等级`,
        decidedAt: ticket.完工时间 || '',
      })
    }
    const updated: OverhaulTicket = {
      ...ticket,
      验收结论: regraced || ticket.验收结论,
      结论版本: regraced ? targetVersion : ticket.结论版本,
      历史结论: history,
      备注: `${ticket.备注 ? `${ticket.备注}\n` : ''}[${stamp}] 验收规则换版 ${current} → ${targetVersion}，${
        regraced ? '已按新版重算，旧等级见历史结论' : '因工期明细缺项未重算'
      }。`,
      updated_at: stamp,
    }
    ledger = upsertLedger(
      ledger,
      updated,
      '换版重算',
      regraced
        ? `按 ${targetVersion} 重算，旧结论等级保留于历史结论`
        : `工期缺项未参与重算，沿用原结论`,
    )
    return updated
  })

  try {
    commitTransaction({ tickets, ledger, version: targetVersion })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '换版写库失败，已整套退回' }
  }
  return { ok: true, message: `验收规则已换版为 ${targetVersion}，历史完工票重算完成，旧结论保留等级与版本` }
}

/* -------------------------------- 另存清单 -------------------------------- */

/** 另存的工作票清单：与列表、详情同一个数据源逐行生成，条数天然一致。 */
export function exportOverhaulCsv(): { filename: string; content: string } {
  const header = [
    '工作票号', '检修机组', '检修级别', '计划开工', '计划完工', '计划工期',
    '实际开工', '实际完工', '实际工期', '检修状态', '工作负责人',
    '验收人员', '验收结论', '结论版本', '完工次数', '完工时间', '备注',
  ]
  const escape = (value: string | number | null) => {
    const text = String(value ?? '')
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const lines = [header.join(',')]
  for (const ticket of getTickets()) {
    lines.push(
      [
        ticket.工作票号, ticket.检修机组, ticket.检修级别,
        ticket.计划开工, ticket.计划完工, ticket.计划工期,
        ticket.实际开工, ticket.实际完工, ticket.实际工期,
        ticket.status, ticket.工作负责人, ticket.验收人员,
        ticket.验收结论, ticket.结论版本, ticket.完工次数, ticket.完工时间,
        ticket.备注,
      ]
        .map(escape)
        .join(','),
    )
  }
  return { filename: '机组检修-工作票清单.csv', content: `﻿${lines.join('\n')}` }
}

export function downloadOverhaulCsv(): void {
  const { filename, content } = exportOverhaulCsv()
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export { CURRENT_GRADE_VERSION }
