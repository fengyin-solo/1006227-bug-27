<template>
  <section class="page" data-module="overhaul">
    <header class="page-head">
      <div>
        <h2>机组检修管理</h2>
        <p class="page-desc">检修工作票全生命周期：待审批 → 已批准 → 检修中 → 已完工。办理完工一次性落库验收四要素，结果回写技术供水值班台账。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记检修工作票</button>
        <button class="btn" type="button" @click="exportRows">导出工作票清单</button>
        <button class="btn" type="button" @click="storeList">另存工作票清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in liveStats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in tableColumns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
          <th>详情</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in tableColumns" :key="column">{{ display(row, column) }}</td>
          <td>
            <span :class="['status-tag', `st-${row.status}`]">{{ row.status }}</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in allowedActions(row.status)"
              :key="action.name"
              class="link"
              :class="{ reverse: action.reverse }"
              type="button"
              @click="handleAction(action.name, row)"
            >
              {{ action.name }}
            </button>
            <span v-if="!allowedActions(row.status).length" class="muted-text">—</span>
          </td>
          <td>
            <button class="link" type="button" @click="openDetail(row)">查看</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="tableColumns.length + 3" class="empty-state">暂无符合条件的检修工作票</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>列表共 {{ total }} 条（与概览页「机组检修」条数同源：{{ allCount }} 条）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-if="infoMessage" class="info-text">{{ infoMessage }}</span>
    </footer>

    <!-- 存量数据回填 / 规则换版 -->
    <section class="tool-panel">
      <h3>存量数据治理</h3>
      <div class="tool-row">
        <div class="tool-block">
          <strong>历史工作票回填</strong>
          <p class="tool-desc">
            已完工历史票按完工时间从早到晚回填：缺实际工期按计划工期等额补，缺验收人记「值班负责人（历史补签）」，
            缺结论按当时规则版本自动定级；缺项单独补录，理由写入备注。每条处理完即落校验点，中断后从断点继续。
          </p>
          <p class="tool-desc" v-if="progress">
            进度：{{ progress.processed }}/{{ progress.total }}，最后处理到票号 #{{ progress.lastTicketId ?? '—' }}，
            缺项补录 {{ progress.supplements.length }} 条，{{ progress.finished ? '已完成' : '可继续' }}。
          </p>
          <div class="tool-actions">
            <button class="btn" type="button" :disabled="!!progress?.finished" @click="runBackfill(2)">回填2条（模拟中断）</button>
            <button class="btn primary" type="button" :disabled="!!progress?.finished" @click="runBackfill(Infinity)">从断点继续/全部回填</button>
            <button class="btn ghost" type="button" @click="showSupplements = !showSupplements">
              {{ showSupplements ? '收起' : '查看' }}缺项补录记录
            </button>
          </div>
          <table v-if="showSupplements" class="data-table sub-table">
            <thead>
              <tr><th>票号</th><th>缺项</th><th>补录值</th><th>规则版本</th><th>补齐方式与理由</th><th>时间</th></tr>
            </thead>
            <tbody>
              <tr v-for="item in progress?.supplements ?? []" :key="item.id">
                <td>{{ item.ticketNo }}</td>
                <td>{{ item.missingField }}</td>
                <td>{{ item.filledValue }}</td>
                <td>{{ item.ruleVersion }}</td>
                <td>{{ item.remark }}</td>
                <td>{{ item.processedAt }}</td>
              </tr>
              <tr v-if="!(progress?.supplements.length)">
                <td colspan="6" class="empty-state">暂无缺项补录记录</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="tool-block">
          <strong>验收规则换版</strong>
          <p class="tool-desc">
            换版后按新版重算全部已完工票；旧结论保留当时等级，在备注与规则版本栏注明。
          </p>
          <div v-for="rule in rules" :key="rule.version" class="rule-line">
            <span :class="['status-tag', rule.current ? 'st-已完工' : '']">
              {{ rule.version }}（{{ rule.current ? '当前生效' : `自 ${rule.effectiveFrom}` }}）
            </span>
            <span class="muted-text">{{ rule.label }}</span>
            <button
              v-if="!rule.current"
              class="btn"
              type="button"
              @click="switchRule(rule.version)"
            >
              切换到{{ rule.version }}并重算
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- 技术供水值班台账（另一个入口在技术供水页，同一份数据） -->
    <section class="tool-panel">
      <div class="panel-head">
        <h3>技术供水值班台账 · 检修处理结果回写</h3>
        <span class="muted-text">共 {{ ledger.length }} 条，与「技术供水」页台账入口同源同条数</span>
      </div>
      <table class="data-table sub-table">
        <thead>
          <tr>
            <th>工作票号</th><th>机组</th><th>级别</th><th>计划/实际工期(天)</th>
            <th>验收人员</th><th>验收结论</th><th>规则版本</th><th>完工时间</th><th>来源</th><th>备注</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in ledger" :key="item.id">
            <td>{{ item.ticketNo }}</td>
            <td>{{ item.unit }}</td>
            <td>{{ item.level }}</td>
            <td>{{ item.plannedDays }} / {{ item.actualDays }}</td>
            <td>{{ item.inspector }}</td>
            <td>{{ item.conclusion }}</td>
            <td>{{ item.ruleVersion }}</td>
            <td>{{ item.completedAt }}</td>
            <td>{{ item.source }}</td>
            <td>{{ item.remark }}</td>
          </tr>
          <tr v-if="!ledger.length">
            <td colspan="10" class="empty-state">台账暂无检修处理结果，办理完工或执行历史回填后写入</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 另存的工作票清单快照 -->
    <section v-if="snapshotList.length" class="tool-panel">
      <h3>另存的工作票清单（{{ snapshotList.length }} 份）</h3>
      <table class="data-table sub-table">
        <thead><tr><th>序号</th><th>另存时间</th><th>操作人</th><th>总条数</th><th>检修中</th><th>已完工</th></tr></thead>
        <tbody>
          <tr v-for="snap in snapshotList" :key="snap.id">
            <td>{{ snap.id }}</td><td>{{ snap.savedAt }}</td><td>{{ snap.operator }}</td>
            <td>{{ snap.total }}</td><td>{{ snap.inOverhaul }}</td><td>{{ snap.completed }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 办理完工弹窗 -->
    <div v-if="completeTarget" class="modal-mask" @click.self="closeComplete">
      <div class="modal-box">
        <h3>办理完工 · {{ completeTarget['工作票号'] }}</h3>
        <p class="tool-desc">
          {{ completeTarget.status === '已完工'
            ? '该票已是「已完工」终态，再次办理将只落最后一次，台账原条目同步更新、不新增条数。'
            : '检修状态、实际工期、验收人员、验收结论将在同一事务里一次性落库；任一项不合规整套退回。' }}
        </p>
        <div class="form-grid">
          <label class="form-item">
            <span>实际工期（天）*</span>
            <input v-model.number="completeForm.actualDays" type="number" min="1" step="1"
              :placeholder="`计划工期 ${completeTarget['计划工期']} 天`" />
          </label>
          <label class="form-item">
            <span>验收人员 *</span>
            <input v-model="completeForm.inspector" placeholder="签字验收人姓名" />
          </label>
          <label class="form-item">
            <span>验收结论（留空按 {{ currentRuleVersion }} 版自动定级）</span>
            <select v-model="completeForm.conclusion">
              <option value="">按工期兑现率自动评定</option>
              <option value="优良">优良</option>
              <option value="合格">合格</option>
              <option value="基本合格">基本合格</option>
              <option value="不合格">不合格</option>
            </select>
          </label>
          <label class="form-item form-wide">
            <span>完工备注</span>
            <input v-model="completeForm.remark" placeholder="可填验收遗留事项" />
          </label>
        </div>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeComplete">取消</button>
          <button class="btn primary" type="button" @click="submitComplete">确认办理完工</button>
        </div>
      </div>
    </div>

    <!-- 详情面板 -->
    <div v-if="detailRow" class="modal-mask" @click.self="detailRow = null">
      <div class="modal-box detail-box">
        <h3>工作票详情 · {{ detailRow['工作票号'] }}</h3>
        <table class="data-table sub-table">
          <tbody>
            <tr v-for="field in detailFields" :key="field">
              <th>{{ field }}</th>
              <td>{{ detailRow[field] === '' || detailRow[field] == null ? '—' : detailRow[field] }}</td>
            </tr>
            <tr><th>生命周期状态</th><td>{{ detailRow.status }}</td></tr>
          </tbody>
        </table>
        <div v-if="detailLedger.length" class="detail-ledger">
          <strong>技术供水值班台账回写：</strong>
          <span v-for="item in detailLedger" :key="item.id">
            {{ item.source }} · 结论「{{ item.conclusion }}」（{{ item.ruleVersion }}）· {{ item.completedAt }}；
          </span>
        </div>
        <div class="modal-actions">
          <button class="btn" type="button" @click="detailRow = null">关闭</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  backfillHistorical,
  completeTicket,
  getTicket,
  listDutyLedger,
  listRuleVersions,
  listSnapshots,
  saveSnapshot,
  upgradeConclusionRule,
} from '@/api/overhaul-service'
import type {
  BackfillProgress,
  CompleteTicketPayload,
  DutyLedgerEntry,
  EntryRow,
  TicketSnapshot,
} from '@/data/types'
import { backfillProgress as readBackfillProgress } from '@/data/local-store'
import { useSessionStore } from '@/stores/session'

const session = useSessionStore()
const meta = moduleMeta('overhaul')
const tableColumns = ["工作票号", "检修机组", "检修级别", "计划工期", "实际工期", "工作负责人", "验收人员", "验收结论", "完工时间", "规则版本", "备注"]
const detailFields = tableColumns
const filterFields = ["工作票号", "检修机组", "检修级别"]
const statuses = ["待审批", "已批准", "检修中", "已完工"]

// 每档状态在页面上开放的动作；与 modules.ts 里登记的流转边保持一致。
const ACTIONS_BY_STATUS: Record<string, { name: string; reverse?: boolean }[]> = {
  '待审批': [{ name: '提交审批' }],
  '已批准': [{ name: '退回申报', reverse: true }, { name: '开工检修' }],
  '检修中': [{ name: '暂停退回', reverse: true }, { name: '办理完工' }],
  '已完工': [{ name: '办理完工' }],
}

const rows = ref<EntryRow[]>([])
const allRowsCache = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})

const ledger = ref<DutyLedgerEntry[]>([])
const snapshotList = ref<TicketSnapshot[]>([])
const progress = ref<BackfillProgress | null>(null)
const rules = ref(listRuleVersions())
const showSupplements = ref(false)

const completeTarget = ref<EntryRow | null>(null)
const completeForm = ref<CompleteTicketPayload>({ actualDays: 0, inspector: '', conclusion: '', remark: '' })
const detailRow = ref<EntryRow | null>(null)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: allRowsCache.value.filter((row) => String(row.status) === status).length,
  })),
)

// 统计卡片直接由同一份列表数据现算，检修中机组台数随完工动作实时回落。
// 必须基于响应式的 allRowsCache 计算，直接调非响应式的 store 不会触发刷新。
const liveStats = computed(() => {
  const all = allRowsCache.value
  return [
    { label: '待审批工作票', value: all.filter((row) => row.status === '待审批').length },
    { label: '检修中机组（台）', value: all.filter((row) => row.status === '检修中').length },
    { label: '已完工检修', value: all.filter((row) => row.status === '已完工').length },
  ]
})

const allCount = computed(() => allRowsCache.value.length)
const currentRuleVersion = computed(() => rules.value.find((rule) => rule.current)?.version ?? 'v1')
const detailLedger = computed(() =>
  detailRow.value ? ledger.value.filter((item) => item.ticketId === Number(detailRow.value!.id)) : [],
)

function allowedActions(status: string) {
  return ACTIONS_BY_STATUS[status] ?? []
}

function display(row: EntryRow, column: string): string {
  const value = row[column]
  if (value === '' || value == null) return '—'
  return String(value)
}

function flashInfo(message: string) {
  infoMessage.value = message
  window.setTimeout(() => {
    if (infoMessage.value === message) infoMessage.value = ''
  }, 6000)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function storeList() {
  const result = saveSnapshot(session.operator)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  refreshAuxiliary()
  flashInfo(result.message)
}

function openCreate() {
  errorMessage.value = '检修工作票登记入口尚未接入审批流'
}

function openDetail(row: EntryRow) {
  // 详情永远回读存储里的最新行，杜绝「列表一套、详情另一套」。
  detailRow.value = getTicket(Number(row.id)) ?? row
}

function handleAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  if (action === '办理完工') {
    openComplete(row)
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function openComplete(row: EntryRow) {
  completeTarget.value = getTicket(Number(row.id)) ?? row
  const target = completeTarget.value!
  completeForm.value = {
    actualDays: Number(target['实际工期']) || 0,
    inspector: String(target['验收人员'] ?? ''),
    conclusion: '',
    remark: '',
  }
}

function closeComplete() {
  completeTarget.value = null
}

function submitComplete() {
  if (!completeTarget.value) return
  const result = completeTicket(Number(completeTarget.value.id), { ...completeForm.value })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  flashInfo(result.message)
  completeTarget.value = null
  reload()
}

function runBackfill(steps: number) {
  errorMessage.value = ''
  const result = backfillHistorical(steps)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  flashInfo(result.message)
  reload()
}

function switchRule(version: string) {
  const result = upgradeConclusionRule(version)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  flashInfo(result.message)
  reload()
}

function refreshAuxiliary() {
  ledger.value = listDutyLedger()
  snapshotList.value = listSnapshots()
  progress.value = readBackfillProgress()
  rules.value = listRuleVersions()
}

function reload() {
  errorMessage.value = ''
  try {
    const unfiltered = listEntries(meta.key).items
    allRowsCache.value = unfiltered
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    refreshAuxiliary()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '机组检修列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.muted-text { color: var(--muted); font-size: 12px; }
.info-text { color: #1769aa; }
.status-tag { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; background: #eef2f7; }
.st-待审批 { background: #fef3c7; }
.st-已批准 { background: #dbeafe; }
.st-检修中 { background: #ffedd5; }
.st-已完工 { background: #dcfce7; }
.link.reverse { color: #b45309; }
.tool-panel { margin-top: 18px; background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
.tool-panel h3 { margin: 0 0 8px; font-size: 14px; }
.panel-head { display: flex; justify-content: space-between; align-items: center; }
.tool-row { display: flex; gap: 16px; }
.tool-block { flex: 1; }
.tool-desc { font-size: 12px; color: var(--muted); margin: 6px 0; }
.tool-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.sub-table { margin-top: 8px; font-size: 12px; }
.rule-line { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
.modal-mask { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex; align-items: center; justify-content: center; z-index: 50; }
.modal-box { background: #fff; border-radius: 10px; padding: 18px 20px; width: 640px; max-width: 92vw; max-height: 88vh; overflow: auto; }
.detail-box { width: 760px; }
.modal-box h3 { margin: 0 0 10px; font-size: 15px; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px; }
.form-item span { display: block; font-size: 12px; color: var(--muted); margin-bottom: 3px; }
.form-item input, .form-item select { width: 100%; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; }
.form-wide { grid-column: 1 / -1; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.detail-ledger { margin-top: 10px; font-size: 12px; color: var(--muted); }
</style>
