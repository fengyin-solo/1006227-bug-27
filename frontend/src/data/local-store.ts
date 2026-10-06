import { SEED_ROWS } from './seed'
import { DEFAULT_RULE_VERSION } from './conclusion-rules'
import type {
  AppSettings,
  BackfillProgress,
  DutyLedgerEntry,
  EntryRow,
  TicketSnapshot,
} from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const LEGACY_ROWS_KEY = 'hydropower-plant-om:entries'
const DB_KEY = 'hydropower-plant-om:db:v2'

export type Database = {
  rows: Record<string, EntryRow[]>
  dutyLedger: DutyLedgerEntry[]
  snapshots: TicketSnapshot[]
  backfill: BackfillProgress | null
  settings: AppSettings
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function defaultDatabase(): Database {
  return {
    rows: clone(SEED_ROWS),
    dutyLedger: [],
    snapshots: [],
    backfill: null,
    settings: { conclusionRuleVersion: DEFAULT_RULE_VERSION },
  }
}

function readLegacyRows(): Record<string, EntryRow[]> | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  const raw = window.localStorage.getItem(LEGACY_ROWS_KEY)
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...clone(SEED_ROWS), ...parsed }
  } catch {
    return null
  }
}

function readDatabase(): Database {
  const fallback = defaultDatabase()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(DB_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<Database>
      // 种子里新增的模块也要补进老存档，缺的附属集合给默认值。
      return {
        rows: { ...clone(SEED_ROWS), ...(parsed.rows ?? {}) },
        dutyLedger: parsed.dutyLedger ?? [],
        snapshots: parsed.snapshots ?? [],
        backfill: parsed.backfill ?? null,
        settings: { ...fallback.settings, ...(parsed.settings ?? {}) },
      }
    } catch {
      // v2 存档损坏：落到下面的老存档迁移逻辑，不直接吞掉用户在旧版里的数据。
    }
  }
  const legacy = readLegacyRows()
  if (legacy) {
    fallback.rows = legacy
  }
  return fallback
}

let cache: Database | null = null

export function db(): Database {
  if (cache === null) {
    cache = readDatabase()
  }
  return cache
}

export function allRows(): Record<string, EntryRow[]> {
  return db().rows
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function dutyLedger(): DutyLedgerEntry[] {
  return db().dutyLedger
}

export function snapshots(): TicketSnapshot[] {
  return db().snapshots
}

export function backfillProgress(): BackfillProgress | null {
  return db().backfill
}

export function settings(): AppSettings {
  return db().settings
}

/**
 * 唯一的写入口：在 draft 上做的所有改动要么整套落盘、要么整套退回。
 * 先写 localStorage：抛异常就把内存缓存恢复到提交前快照并原样抛出，
 * 调用方拿到失败结果时存储里不会留下半条记录。
 */
export function commit(mutator: (draft: Database) => void): Database {
  const snapshot = clone(db())
  const draft = clone(snapshot)
  mutator(draft)
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(DB_KEY, JSON.stringify(draft))
    } catch (error) {
      cache = snapshot
      throw error
    }
  }
  cache = draft
  return draft
}

/** 兼容旧调用方的整模块覆盖；现在也走事务入口。 */
export function saveRows(key: string, rows: EntryRow[]): void {
  commit((draft) => {
    draft.rows[key] = rows
  })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return DB_KEY
}

export function legacyStorageKey(): string {
  return LEGACY_ROWS_KEY
}
