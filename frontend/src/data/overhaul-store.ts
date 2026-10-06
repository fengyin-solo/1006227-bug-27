import {
  CURRENT_GRADE_VERSION,
  type BackfillCursor,
  type DutyLedgerEntry,
  type MissingItem,
  type OverhaulTicket,
} from './overhaul-types'

/**
 * 检修工作票域的独立持久化。
 *
 * 与通用示例数据（hydropower-plant-om:entries）分开存放，但同样落 localStorage：
 * 列表页、详情面板、另存清单、技术供水值班台账只能从这里取数，杜绝两套数据。
 *
 * 写库走 commitTransaction：多张表要么一起生效，要么整体回滚，
 * 写不成不留下半条记录。
 */

const TICKETS_KEY = 'hydropower-plant-om:overhaul-tickets'
const LEDGER_KEY = 'hydropower-plant-om:cooling-duty-ledger'
const MISSING_KEY = 'hydropower-plant-om:overhaul-missing'
const CURSOR_KEY = 'hydropower-plant-om:overhaul-backfill-cursor'
const VERSION_KEY = 'hydropower-plant-om:overhaul-grade-version'

type StoreShape = {
  tickets: OverhaulTicket[]
  ledger: DutyLedgerEntry[]
  missing: MissingItem[]
  cursor: BackfillCursor | null
  version: string
}

type TransactionPatch = Partial<StoreShape>

function storage(): Storage | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  return window.localStorage
}

function readJson<T>(key: string, fallback: T): T {
  const ls = storage()
  if (!ls) {
    return fallback
  }
  const raw = ls.getItem(key)
  if (!raw) {
    return fallback
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

const cache: StoreShape = {
  tickets: readJson<OverhaulTicket[]>(TICKETS_KEY, buildSeedTickets()),
  ledger: readJson<DutyLedgerEntry[]>(LEDGER_KEY, []),
  missing: readJson<MissingItem[]>(MISSING_KEY, []),
  cursor: readJson<BackfillCursor | null>(CURSOR_KEY, null),
  version: readJson<string>(VERSION_KEY, CURRENT_GRADE_VERSION),
}

function ensureSeeded(): void {
  const ls = storage()
  if (!ls || ls.getItem(TICKETS_KEY)) {
    return
  }
  // 首次进入：播种后直接落库，保证后续读到的就是这一份。
  ls.setItem(TICKETS_KEY, JSON.stringify(cache.tickets))
}
ensureSeeded()

export function getTickets(): OverhaulTicket[] {
  return cache.tickets
}

export function getLedger(): DutyLedgerEntry[] {
  return cache.ledger
}

export function getMissing(): MissingItem[] {
  return cache.missing
}

export function getCursor(): BackfillCursor | null {
  return cache.cursor
}

export function getGradeVersion(): string {
  return cache.version
}

/**
 * 事务提交：先在内存里组好下一份完整状态并序列化，再逐个 key 写 localStorage。
 * 任何一个 key 写失败，已写入的 key 按快照恢复，内存状态原样不动。
 */
export function commitTransaction(patch: TransactionPatch): StoreShape {
  const next: StoreShape = {
    tickets: patch.tickets ?? cache.tickets,
    ledger: patch.ledger ?? cache.ledger,
    missing: patch.missing ?? cache.missing,
    cursor: patch.cursor !== undefined ? patch.cursor : cache.cursor,
    version: patch.version ?? cache.version,
  }

  // 先序列化：循环引用 / 配额超限之类的问题在这里就暴露，存储一个字节都不动。
  const writes: { key: string; raw: string }[] = [
    { key: TICKETS_KEY, raw: JSON.stringify(next.tickets) },
    { key: LEDGER_KEY, raw: JSON.stringify(next.ledger) },
    { key: MISSING_KEY, raw: JSON.stringify(next.missing) },
    { key: CURSOR_KEY, raw: JSON.stringify(next.cursor) },
    { key: VERSION_KEY, raw: JSON.stringify(next.version) },
  ]

  const ls = storage()
  if (ls) {
    const snapshot = new Map<string, string | null>()
    try {
      for (const item of writes) {
        snapshot.set(item.key, ls.getItem(item.key))
        ls.setItem(item.key, item.raw)
      }
    } catch (error) {
      // 回滚已写入的 key，恢复成事务开始前的样子。
      for (const [key, raw] of snapshot) {
        if (raw === null) {
          ls.removeItem(key)
        } else {
          ls.setItem(key, raw)
        }
      }
      throw new Error(`检修工作票写库失败，已整套退回：${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  // 存储全部成功后才切换内存状态，保证读路径不会看到半成品。
  cache.tickets = next.tickets
  cache.ledger = next.ledger
  cache.missing = next.missing
  cache.cursor = next.cursor
  cache.version = next.version
  return cache
}

export function resetOverhaulStore(): void {
  commitTransaction({
    tickets: buildSeedTickets(),
    ledger: [],
    missing: [],
    cursor: null,
    version: CURRENT_GRADE_VERSION,
  })
}

/* ------------------------------------------------------------------ */
/* 种子数据：覆盖生命周期各档，并特意留了几张早期已完工但缺实际工期、    */
/* 缺验收人员/结论的历史票，供存量回填与缺项补录演示真实规则。           */
/* ------------------------------------------------------------------ */

function seedTicket(
  partial: Partial<OverhaulTicket> & Pick<OverhaulTicket, 'id' | '工作票号' | 'status'>,
): OverhaulTicket {
  const now = '2026-09-30 09:00'
  return {
    pending: partial.status !== '已完工',
    abnormal: false,
    计划开工: '',
    计划完工: '',
    计划工期: '',
    实际开工: '',
    实际完工: '',
    实际工期: '',
    实际工期天数: null,
    工作负责人: '',
    验收人员: '',
    验收结论: '',
    结论版本: '',
    历史结论: [],
    备注: '',
    完工次数: 0,
    完工时间: '',
    已回填: false,
    created_at: now,
    updated_at: now,
    检修机组: '',
    检修级别: '',
    ...partial,
  }
}

function buildSeedTickets(): OverhaulTicket[] {
  return [
    seedTicket({
      id: 1,
      工作票号: 'JX-2026-001',
      status: '待审批',
      检修机组: '1号机组',
      检修级别: 'A级检修',
      工作负责人: '张工',
      计划开工: '2026-11-01',
      计划完工: '2026-11-20',
      计划工期: '2026-11-01 至 2026-11-20（20天）',
      created_at: '2026-09-20 09:00',
    }),
    seedTicket({
      id: 2,
      工作票号: 'JX-2026-002',
      status: '已批准',
      检修机组: '2号机组',
      检修级别: 'B级检修',
      工作负责人: '李工',
      计划开工: '2026-10-10',
      计划完工: '2026-10-22',
      计划工期: '2026-10-10 至 2026-10-22（13天）',
      created_at: '2026-09-22 14:00',
    }),
    seedTicket({
      id: 3,
      工作票号: 'JX-2026-003',
      status: '检修中',
      检修机组: '3号机组',
      检修级别: 'C级检修',
      工作负责人: '王工',
      计划开工: '2026-09-25',
      计划完工: '2026-10-05',
      计划工期: '2026-09-25 至 2026-10-05（11天）',
      created_at: '2026-09-18 10:00',
    }),
    // —— 以下为历史已完工票，模拟早期没有实际工期、验收信息残缺的存量 ——
    seedTicket({
      id: 4,
      工作票号: 'JX-2025-014',
      status: '已完工',
      检修机组: '1号机组',
      检修级别: 'C级检修',
      工作负责人: '赵工',
      计划开工: '2025-03-03',
      计划完工: '2025-03-12',
      计划工期: '2025-03-03 至 2025-03-12（10天）',
      created_at: '2025-02-20 09:00',
    }),
    seedTicket({
      id: 5,
      工作票号: 'JX-2025-009',
      status: '已完工',
      检修机组: '2号机组',
      检修级别: 'C级检修',
      工作负责人: '赵工',
      验收人员: '钱工',
      计划开工: '2025-01-06',
      计划完工: '2025-01-15',
      计划工期: '2025-01-06 至 2025-01-15（10天）',
      created_at: '2024-12-28 09:00',
    }),
    seedTicket({
      id: 6,
      工作票号: 'JX-2024-021',
      status: '已完工',
      检修机组: '4号机组',
      检修级别: 'B级检修',
      工作负责人: '孙工',
      计划开工: '2024-11-05',
      计划完工: '2024-11-20',
      计划工期: '2024-11-05 至 2024-11-20（16天）',
      created_at: '2024-10-20 09:00',
    }),
    seedTicket({
      // 计划工期也缺失的极端早期票：走同级别中位数规则补，并挂缺项。
      id: 7,
      工作票号: 'JX-2023-006',
      status: '已完工',
      检修机组: '3号机组',
      检修级别: 'B级检修',
      工作负责人: '周工',
      计划开工: '',
      计划完工: '',
      计划工期: '',
      created_at: '2023-05-10 09:00',
    }),
  ]
}
