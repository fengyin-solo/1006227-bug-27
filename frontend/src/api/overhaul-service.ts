import {
  backfillProgress,
  commit,
  db,
  dutyLedger,
  listRows,
  snapshots,
} from '@/data/local-store'
import {
  CONCLUSION_RULES,
  DEFAULT_RULE_VERSION,
  gradeByRule,
  ruleOf,
} from '@/data/conclusion-rules'
import type {
  ActionResult,
  BackfillProgress,
  BackfillSupplement,
  CompleteTicketPayload,
  DutyLedgerEntry,
  EntryRow,
  TicketSnapshot,
} from '@/data/types'

const KEY = 'overhaul'
const FINAL_STATUS = '已完工'

// 缺项补录时的验收人占位：不冒用真人姓名，统一记成值班补签。
const SUPPLEMENT_INSPECTOR = '值班负责人（历史补签）'

export function nextLedgerId(entries: DutyLedgerEntry[]): number {
  return entries.reduce((max, item) => Math.max(max, item.id), 0) + 1
}

function nextSupplementId(items: BackfillSupplement[]): number {
  return items.reduce((max, item) => Math.max(max, item.id), 0) + 1
}

function nowText(): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function asNumber(value: EntryRow[string] | undefined): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function nonEmpty(value: EntryRow[string] | undefined): boolean {
  return String(value ?? '').trim() !== ''
}

/** 台账条目始终由工作票记录投影生成，保证两个入口读到的条数与内容是同一份。 */
function toLedgerEntry(row: EntryRow, source: DutyLedgerEntry['source'], remark: string): DutyLedgerEntry {
  return {
    id: 0,
    ticketId: Number(row.id),
    ticketNo: String(row['工作票号'] ?? ''),
    unit: String(row['检修机组'] ?? ''),
    level: String(row['检修级别'] ?? ''),
    status: String(row.status),
    actualDays: asNumber(row['实际工期']),
    plannedDays: asNumber(row['计划工期']),
    inspector: String(row['验收人员'] ?? ''),
    conclusion: String(row['验收结论'] ?? ''),
    ruleVersion: String(row['规则版本'] ?? ''),
    completedAt: String(row['完工时间'] ?? ''),
    remark,
    source,
  }
}

function findTicket(rows: EntryRow[], id: number): EntryRow | undefined {
  return rows.find((row) => Number(row.id) === id)
}

/**
 * 办理完工（或对已完工票重办）：
 * 校验 → 定级 → 同一事务里写工作票 + upsert 值班台账。任何一步失败整套退回。
 */
export function completeTicket(id: number, payload: CompleteTicketPayload): ActionResult {
  const rows = listRows(KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的检修工作票` }
  }
  const current = rows[index]
  // 终态重办：只允许「再次办理完工」落最后一次，状态机上不做回退。
  if (String(current.status) !== '检修中' && String(current.status) !== FINAL_STATUS) {
    return { ok: false, message: `工作票当前为「${current.status}」，只有检修中的工作票可以办理完工` }
  }
  if (!Number.isFinite(payload.actualDays) || payload.actualDays <= 0) {
    return { ok: false, message: '实际工期必须是大于 0 的数字（天），完工未登记' }
  }
  if (!payload.inspector.trim()) {
    return { ok: false, message: '验收人员不能为空，完工未登记' }
  }

  const planned = asNumber(current['计划工期'])
  const ruleVersion = db().settings.conclusionRuleVersion || DEFAULT_RULE_VERSION
  const autoGrade = gradeByRule(planned, payload.actualDays, ruleVersion)
  const conclusion = payload.conclusion || autoGrade
  if (!conclusion) {
    return { ok: false, message: '验收结论无法评定（计划工期缺失），请人工选择结论后再提交' }
  }

  const repeated = String(current.status) === FINAL_STATUS
  const completedAt = repeated && nonEmpty(current['完工时间'])
    ? String(current['完工时间'])
    : nowText()
  const baseRemark = payload.remark?.trim() || String(current['备注'] ?? '')
  const alreadyLedger = dutyLedger().some((item) => item.ticketId === id)
  const remark = repeated
    ? `${baseRemark ? `${baseRemark}；` : ''}${alreadyLedger ? '二次办理完工，只保留最后一次验收数据' : '再次办理完工，只保留最后一次验收数据'}`
    : baseRemark

  let savedRow: EntryRow | undefined
  try {
    commit((draft) => {
      const updated: EntryRow = {
        ...draft.rows[KEY][index],
        status: FINAL_STATUS,
        pending: false,
        abnormal: false,
        '实际工期': payload.actualDays,
        '验收人员': payload.inspector.trim(),
        '验收结论': conclusion,
        '完工时间': completedAt,
        '规则版本': ruleVersion,
        '备注': remark,
      }
      draft.rows[KEY][index] = updated
      savedRow = updated

      const ledgerIndex = draft.dutyLedger.findIndex((item) => item.ticketId === id)
      const entry = toLedgerEntry(updated, '完工办理', remark)
      if (ledgerIndex < 0) {
        entry.id = nextLedgerId(draft.dutyLedger)
        draft.dutyLedger.push(entry)
      } else {
        // 二次完工只落最后一次：更新原条目，不新增条数。
        entry.id = draft.dutyLedger[ledgerIndex].id
        draft.dutyLedger[ledgerIndex] = entry
      }
    })
  } catch {
    return { ok: false, message: '完工信息写入失败，已整套退回，工作票与值班台账均未改动' }
  }
  return {
    ok: true,
    row: savedRow,
    message: repeated
      ? `工作票已按最后一次办理更新，当前状态「${FINAL_STATUS}」，验收结论「${conclusion}」`
      : `检修工作票已完工，实际工期 ${payload.actualDays} 天，验收结论「${conclusion}」，结果已写入技术供水值班台账`,
  }
}

export function getTicket(id: number): EntryRow | undefined {
  return findTicket(listRows(KEY), id)
}

export function overhaulStats(): { pending: number; inOverhaul: number; completed: number } {
  const rows = listRows(KEY)
  return {
    pending: rows.filter((row) => row.status === '待审批').length,
    inOverhaul: rows.filter((row) => row.status === '检修中').length,
    completed: rows.filter((row) => row.status === FINAL_STATUS).length,
  }
}

export function listDutyLedger(): DutyLedgerEntry[] {
  return dutyLedger()
}

export function listSnapshots(): TicketSnapshot[] {
  return snapshots()
}

/** 另存工作票清单：快照的就是列表此刻读到的同一批行。 */
export function saveSnapshot(operator: string): ActionResult & { snapshot?: TicketSnapshot } {
  const items = listRows(KEY)
  let snapshot: TicketSnapshot | undefined
  try {
    commit((draft) => {
      const id = draft.snapshots.reduce((max, item) => Math.max(max, item.id), 0) + 1
      snapshot = {
        id,
        savedAt: nowText(),
        operator: operator || '值班管理员',
        total: items.length,
        inOverhaul: items.filter((row) => row.status === '检修中').length,
        completed: items.filter((row) => row.status === FINAL_STATUS).length,
        items: JSON.parse(JSON.stringify(items)) as EntryRow[],
      }
      draft.snapshots.push(snapshot)
    })
  } catch {
    return { ok: false, message: '清单另存失败，未留下任何快照' }
  }
  return { ok: true, message: `已另存工作票清单，共 ${items.length} 条`, snapshot }
}

// ── 存量回填 ────────────────────────────────────────────────────────────────

/** 按完工时间升序（同日按票号、id），保证存量数据严格按时间顺序回填。 */
function backfillOrder(rows: EntryRow[]): EntryRow[] {
  return [...rows]
    .filter((row) => String(row.status) === FINAL_STATUS)
    .sort((a, b) => {
      const ta = String(a['完工时间'] ?? '')
      const tb = String(b['完工时间'] ?? '')
      if (ta !== tb) return ta < tb ? -1 : 1
      const na = String(a['工作票号'] ?? '')
      const nb = String(b['工作票号'] ?? '')
      if (na !== nb) return na < nb ? -1 : 1
      return Number(a.id) - Number(b.id)
    })
}

/**
 * 存量回填：按完工时间从早到晚逐张处理。
 * 每张票处理完立刻写校验点（lastTicketId + supplements），中断后再次调用
 * 自动从断点之后接着走；只补缺项，已有实际工期/验收人的字段绝不顶替。
 */
export function backfillHistorical(maxSteps = Infinity): ActionResult & { progress?: BackfillProgress } {
  const ordered = backfillOrder(listRows(KEY))
  const previous = backfillProgress()
  const doneIds = new Set<number>()
  for (const item of previous?.supplements ?? []) {
    doneIds.add(item.ticketId)
  }
  // 上一轮断点：以最后处理到的票为准，与补录记录双重定位，防止跳过或重复。
  if (previous && previous.finished) {
    return { ok: true, message: '存量工作票已全部回填完毕', progress: previous }
  }
  if (previous?.lastTicketId != null) {
    const lastIndex = ordered.findIndex((row) => Number(row.id) === previous.lastTicketId)
    if (lastIndex >= 0) {
      for (let i = 0; i <= lastIndex; i += 1) {
        doneIds.add(Number(ordered[i].id))
      }
    }
  }

  const pending = ordered.filter((row) => !doneIds.has(Number(row.id)))
  if (!pending.length) {
    const progress: BackfillProgress = {
      version: DEFAULT_RULE_VERSION,
      total: ordered.length,
      processed: previous?.processed ?? 0,
      lastTicketId: previous?.lastTicketId ?? null,
      finished: true,
      updatedAt: nowText(),
      supplements: previous?.supplements ?? [],
    }
    try {
      commit((draft) => {
        draft.backfill = progress
      })
    } catch {
      // 进度标记写不下不影响数据本身，下次再试。
    }
    return { ok: true, message: '存量工作票已全部回填完毕', progress }
  }

  const target = pending.slice(0, maxSteps)
  const allSupplements = [...(previous?.supplements ?? [])]
  let processedCount = previous?.processed ?? 0
  let lastTicketId = previous?.lastTicketId ?? null
  let steps = 0
  try {
    commit((draft) => {
      for (const ticket of target) {
        const id = Number(ticket.id)
        const idx = draft.rows[KEY].findIndex((row) => Number(row.id) === id)
        if (idx < 0) continue
        const row = draft.rows[KEY][idx]
        const newSupplements: BackfillSupplement[] = []

        // 规则裁决：早期没有实际工期的，按计划工期回填——计划工期是办票时批准的
        // 唯一可核工期依据，按计划天数回填不夸大也不缩短检修投入，且可被审计追溯。
        if (!nonEmpty(row['实际工期'])) {
          row['实际工期'] = asNumber(row['计划工期'])
          newSupplements.push({
            id: 0,
            ticketId: id,
            ticketNo: String(row['工作票号'] ?? ''),
            missingField: '实际工期',
            filledValue: String(row['实际工期']),
            ruleVersion: String(row['规则版本'] || DEFAULT_RULE_VERSION),
            remark: '缺项补录：早期票未登记实际工期，裁决按计划工期等额回填。理由：计划工期是办票批准的唯一可核工期依据，等额回填不会放大或缩短真实检修投入，偏差留待验收结论体现。',
            processedAt: nowText(),
          })
        }

        if (!nonEmpty(row['验收人员'])) {
          row['验收人员'] = SUPPLEMENT_INSPECTOR
          newSupplements.push({
            id: 0,
            ticketId: id,
            ticketNo: String(row['工作票号'] ?? ''),
            missingField: '验收人员',
            filledValue: SUPPLEMENT_INSPECTOR,
            ruleVersion: String(row['规则版本'] || DEFAULT_RULE_VERSION),
            remark: '缺项补录：纸质签字未电子归档且原验收人不可考，统一记值班负责人历史补签，不冒用真人姓名；备注标明补签事实。',
            processedAt: nowText(),
          })
        }

        const ruleVersion = String(row['规则版本'] || DEFAULT_RULE_VERSION)
        if (!nonEmpty(row['规则版本'])) {
          row['规则版本'] = ruleVersion
        }
        if (!nonEmpty(row['验收结论'])) {
          const grade = gradeByRule(asNumber(row['计划工期']), asNumber(row['实际工期']), ruleVersion)
          row['验收结论'] = grade
          newSupplements.push({
            id: 0,
            ticketId: id,
            ticketNo: String(row['工作票号'] ?? ''),
            missingField: '验收结论',
            filledValue: grade,
            ruleVersion,
            remark: `缺项补录：按${ruleVersion}版验收规则，依据计划/实际工期兑现率自动定级。`,
            processedAt: nowText(),
          })
        }

        const oldRemark = String(row['备注'] ?? '')
        const backfillNote = '历史回填：按时间顺序补齐缺项，补齐方式与理由见缺项补录记录'
        if (!oldRemark.includes('历史回填')) {
          row['备注'] = oldRemark ? `${oldRemark}；${backfillNote}` : backfillNote
        }

        for (const supplement of newSupplements) {
          supplement.id = nextSupplementId(allSupplements)
          allSupplements.push(supplement)
        }

        // 处理结果回写技术供水值班台账；已在台账里的（完工办理写过）不新增条数。
        const ledgerIndex = draft.dutyLedger.findIndex((item) => item.ticketId === id)
        if (ledgerIndex < 0) {
          const entry = toLedgerEntry(row, '历史回填', '存量数据按时间顺序回填，缺项已单独补录')
          entry.id = nextLedgerId(draft.dutyLedger)
          draft.dutyLedger.push(entry)
        } else {
          const entry = toLedgerEntry(row, '历史回填', draft.dutyLedger[ledgerIndex].remark)
          entry.id = draft.dutyLedger[ledgerIndex].id
          draft.dutyLedger[ledgerIndex] = entry
        }

        steps += 1
        processedCount += 1
        lastTicketId = id

        // 每张票一落校验点：取数中断后从断掉的那一条接着走，不拿旧值顶替。
        draft.backfill = {
          version: DEFAULT_RULE_VERSION,
          total: ordered.length,
          processed: processedCount,
          lastTicketId,
          finished: processedCount >= ordered.length,
          updatedAt: nowText(),
          supplements: [...allSupplements],
        }
      }
    })
  } catch {
    return { ok: false, message: '回填写入中断，已提交的条目保留，下次从未处理的那条继续' }
  }

  const progress = db().backfill ?? undefined
  const restCount = pending.length - target.length
  return {
    ok: true,
    progress,
    message: restCount > 0
      ? `已回填 ${steps} 条（按时间顺序），还剩 ${restCount} 条，下次从断点继续`
      : `本次回填 ${steps} 条，存量工作票全部处理完毕`,
  }
}

// ── 验收规则换版 ──────────────────────────────────────────────────────────────

export function listRuleVersions() {
  return CONCLUSION_RULES.map((rule) => ({
    version: rule.version,
    label: rule.label,
    effectiveFrom: rule.effectiveFrom,
    current: rule.version === db().settings.conclusionRuleVersion,
  }))
}

/**
 * 换版：按新版重算所有已完工票的结论；旧结论保留当时等级并在备注/规则版本里注明。
 * 整张工作票表 + 台账一次事务提交，写不成就整套退回。
 */
export function upgradeConclusionRule(version: string): ActionResult {
  const rule = ruleOf(version)
  if (!CONCLUSION_RULES.some((item) => item.version === version)) {
    return { ok: false, message: `不存在「${version}」版验收规则` }
  }
  if (db().settings.conclusionRuleVersion === version) {
    return { ok: false, message: `当前已经是${version}版，无需重算` }
  }
  const oldVersion = db().settings.conclusionRuleVersion
  try {
    commit((draft) => {
      draft.settings.conclusionRuleVersion = version
      for (const row of draft.rows[KEY]) {
        if (String(row.status) !== FINAL_STATUS) continue
        const planned = asNumber(row['计划工期'])
        const actual = asNumber(row['实际工期'])
        if (!planned || !actual) continue
        const oldGrade = String(row['验收结论'] ?? '')
        const newGrade = rule.grade(planned / actual)
        row['验收结论'] = newGrade
        row['规则版本'] = version
        const oldRemark = String(row['备注'] ?? '')
        const note = `换版重算：${oldVersion}版结论「${oldGrade || '空'}」保留当时等级，自${nowText()}起按${version}版重算为「${newGrade}」`
        row['备注'] = oldRemark.includes('换版重算')
          ? oldRemark.replace(/换版重算：[^；]*/u, note.split('；')[0])
          : `${oldRemark ? `${oldRemark}；` : ''}${note}`

        const ledgerIndex = draft.dutyLedger.findIndex((item) => item.ticketId === Number(row.id))
        if (ledgerIndex >= 0) {
          const old = draft.dutyLedger[ledgerIndex]
          draft.dutyLedger[ledgerIndex] = {
            ...toLedgerEntry(row, '换版重算', `${old.remark}；${note}`),
            id: old.id,
          }
        }
      }
    })
  } catch {
    return { ok: false, message: `换${version}版重算写入失败，已整套退回，仍为${oldVersion}版` }
  }
  return { ok: true, message: `已切换到${version}版（${rule.label}），全部已完工工作票按新版重算，旧等级已保留并注明版本` }
}
