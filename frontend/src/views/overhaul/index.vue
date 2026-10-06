<template>
  <section class="page" data-module="overhaul">
    <header class="page-head">
      <div>
        <h2>机组检修管理</h2>
        <p class="page-desc">检修工作票全生命周期：待审批 → 已批准 → 检修中 → 已完工。办理完工将一次性落库检修状态、实际工期、验收人员与验收结论，并回写技术供水值班台账。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记检修工作票</button>
        <button class="btn" type="button" @click="exportRows">另存工作票清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">待审批工作票</span>
        <strong class="stat-value">{{ stats.pendingApproval }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">检修中机组（按机组去重）</span>
        <strong class="stat-value">{{ stats.inMaintenanceUnits }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已完工检修</span>
        <strong class="stat-value">{{ stats.completed }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">值班台账条数</span>
        <strong class="stat-value" :class="{ 'mismatch': !consistency.aligned }">{{ stats.ledgerCount }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待补录缺项</span>
        <strong class="stat-value" :class="{ 'mismatch': stats.missingCount > 0 }">{{ stats.missingCount }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>工作票号</span>
        <input v-model="filters['工作票号']" placeholder="按工作票号检索" />
      </label>
      <label class="filter-item">
        <span>检修机组</span>
        <input v-model="filters['检修机组']" placeholder="按检修机组检索" />
      </label>
      <label class="filter-item">
        <span>检修级别</span>
        <input v-model="filters['检修级别']" placeholder="按检修级别检索" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>验收结论（版本）</th>
          <th>可执行动作</th>
          <th>详情</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.id">
          <td>{{ row['工作票号'] }}</td>
          <td>{{ row['检修机组'] }}</td>
          <td>{{ row['检修级别'] }}</td>
          <td>{{ row['计划工期'] || '—' }}</td>
          <td>{{ row['实际工期'] || '—' }}</td>
          <td>{{ row['工作负责人'] }}</td>
          <td>{{ row['验收人员'] || '—' }}</td>
          <td>{{ row.status }}</td>
          <td>
            <span v-if="row['验收结论']">{{ row['验收结论'] }}（{{ row['结论版本'] }}）</span>
            <span v-else>—</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
          <td>
            <button class="link" type="button" @click="selectTicket(row.id)">查看</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无机组检修数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>
        共 {{ stats.total }} 条工作票 · 列表 {{ consistency.listCount }} / 存储 {{ consistency.storageCount }} /
        另存清单 {{ consistency.exportCount }} / 技术供水值班台账 {{ consistency.ledgerCount }}
        <strong :class="consistency.aligned ? 'ok-text' : 'error-text'">
          {{ consistency.aligned ? '（条数一致）' : '（条数不一致！）' }}
        </strong>
      </span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>

    <!-- 存量回填 & 换版 -->
    <section class="tool-row">
      <div class="tool-box">
        <h3>存量数据回填</h3>
        <p class="tool-desc">
          按计划开工日期时间序回填历史完工票；实际工期按计划工期回填，计划也缺的按同级别中位数补；
          验收人员/结论缺项进补录清单不推算。断点续跑，已落库的值不会被旧值顶替。
        </p>
        <p class="tool-desc">
          进度：{{ backfillProcessed }} / {{ backfillTotal }}
          <span v-if="backfillRunning">（正在处理 {{ backfillCurrentTicketNo }}…）</span>
          <span v-else-if="backfillTotal > 0 && backfillProcessed === backfillTotal">（回填完成）</span>
        </p>
        <button class="btn" type="button" :disabled="backfillRunning" @click="startBackfill">
          {{ backfillProcessed > 0 && backfillProcessed < backfillTotal ? '从断点继续回填' : '开始存量回填' }}
        </button>
      </div>
      <div class="tool-box">
        <h3>验收规则换版</h3>
        <p class="tool-desc">
          当前版本：<strong>{{ gradeVersionInfo.current }}</strong>。
          换版后已有完工票按新版重算，旧结论保留当时等级并注明版本。
        </p>
        <ul class="rule-list">
          <li v-for="rule in gradeVersionInfo.rules" :key="rule.version">
            {{ rule.version }}：{{ rule.label }}
          </li>
        </ul>
        <button
          class="btn"
          type="button"
          :disabled="!nextVersion"
          @click="doUpgrade"
        >
          换版至 {{ nextVersion || '（已是最新）' }}
        </button>
      </div>
    </section>

    <!-- 缺项补录清单 -->
    <section v-if="missingItems.length" class="tool-box">
      <h3>缺项补录清单（{{ missingItems.length }}）</h3>
      <table class="data-table">
        <thead>
          <tr><th>工作票号</th><th>检修级别</th><th>缺项字段</th><th>补录方式</th><th>理由</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in missingItems" :key="item.id">
            <td>{{ item['工作票号'] }}</td>
            <td>{{ item['检修级别'] }}</td>
            <td>{{ item['缺项字段'] }}</td>
            <td>{{ item['补录方式'] }}</td>
            <td class="reason-cell">{{ item['理由'] }}</td>
            <td>{{ item['处理状态'] }}</td>
            <td>
              <template v-if="item['处理状态'] === '待补录'">
                <input v-model="supplementInputs[item.id]" class="supplement-input" :placeholder="supplementPlaceholder(String(item['缺项字段']))" />
                <button class="link" type="button" @click="doSupplement(item.id)">补录</button>
              </template>
              <span v-else>已补：{{ item['补录值'] }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 详情面板：与列表同一个数据源 -->
    <div v-if="selected" class="modal-mask" @click.self="closeDetail">
      <section class="modal-panel detail-panel">
        <header class="modal-head">
          <h3>工作票详情 · {{ selected['工作票号'] }}</h3>
          <button class="btn ghost" type="button" @click="closeDetail">关闭</button>
        </header>
        <dl class="detail-grid">
          <div v-for="field in detailFields" :key="field" class="detail-item">
            <dt>{{ field }}</dt>
            <dd>{{ selected[field] || '—' }}</dd>
          </div>
          <div class="detail-item">
            <dt>验收结论</dt>
            <dd>{{ selected['验收结论'] ? `${selected['验收结论']}（${selected['结论版本']}）` : '—' }}</dd>
          </div>
          <div class="detail-item detail-wide">
            <dt>备注/流转痕迹</dt>
            <dd class="pre-line">{{ selected['备注'] || '—' }}</dd>
          </div>
          <div class="detail-item detail-wide" v-if="selected['历史结论'].length">
            <dt>历史结论（换版/重复完工留档）</dt>
            <dd>
              <ul class="history-list">
                <li v-for="(item, index) in selected['历史结论']" :key="index">
                  {{ item.decidedAt }} ｜ 等级「{{ item.grade }}」｜ 规则版本 {{ item.version }} ｜ {{ item.reason }}
                </li>
              </ul>
            </dd>
          </div>
        </dl>
      </section>
    </div>

    <!-- 办理完工表单：四项一次性落库 -->
    <div v-if="completing" class="modal-mask" @click.self="cancelComplete">
      <section class="modal-panel">
        <header class="modal-head">
          <h3>办理完工 · {{ completing['工作票号'] }}</h3>
          <button class="btn ghost" type="button" @click="cancelComplete">取消</button>
        </header>
        <div class="form-grid">
          <label>
            <span>实际开工日期 *</span>
            <input type="date" v-model="completeForm['实际开工']" />
          </label>
          <label>
            <span>实际完工日期 *</span>
            <input type="date" v-model="completeForm['实际完工']" />
          </label>
          <label class="form-wide">
            <span>实际工期</span>
            <input :value="computedDuration" readonly placeholder="按开工/完工日期自动计算" />
          </label>
          <label class="form-wide">
            <span>验收人员 *</span>
            <input v-model="completeForm['验收人员']" placeholder="验收人员姓名（落库后次日仍在）" />
          </label>
          <label class="form-wide">
            <span>验收结论（留空按 {{ gradeVersionInfo.current }} 规则依工期偏差自动评定）</span>
            <select v-model="completeForm['验收结论']">
              <option value="">自动评定</option>
              <option value="优良">优良</option>
              <option value="合格">合格</option>
              <option value="不合格">不合格</option>
            </select>
          </label>
        </div>
        <footer class="modal-foot">
          <span v-if="completeError" class="error-text">{{ completeError }}</span>
          <button class="btn primary" type="button" :disabled="submitting" @click="submitComplete">
            {{ submitting ? '提交中…' : '确认完工并落库' }}
          </button>
        </footer>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  availableActions,
  availableVersions,
  backfillStatus,
  completeTicket,
  consistencyCheck,
  daysBetween,
  downloadOverhaulCsv,
  durationText,
  filterTickets,
  findTicket,
  overhaulStats,
  REJECT_ACTION,
  runBackfill,
  supplementMissingItem,
  transitTicket,
  upgradeGradeVersion,
} from '@/data/overhaul-domain'
import { getMissing } from '@/data/overhaul-store'
import type { CompleteTicketInput, MissingItem, OverhaulTicket } from '@/data/overhaul-types'

const columns = ['工作票号', '检修机组', '检修级别', '计划工期', '实际工期', '工作负责人', '验收人员']
const detailFields = [
  '工作票号', '检修机组', '检修级别', '计划工期', '计划开工', '计划完工',
  '实际工期', '实际开工', '实际完工', '工作负责人', '验收人员',
  '完工次数', '完工时间',
]
const statuses = ['待审批', '已批准', '检修中', '已完工']

const rows = ref<OverhaulTicket[]>([])
const stats = ref(overhaulStats())
const consistency = ref(consistencyCheck())
const filters = reactive<Record<string, string>>({ '工作票号': '', '检修机组': '', '检修级别': '' })
const message = ref('')
const messageOk = ref(false)

const selectedId = ref<number | null>(null)
const selected = computed(() => (selectedId.value === null ? null : findTicket(selectedId.value) ?? null))

const missingItems = ref<MissingItem[]>([])
const supplementInputs = reactive<Record<number, string>>({})

const gradeVersionInfo = ref(availableVersions())
const nextVersion = computed(() => {
  const index = gradeVersionInfo.value.rules.findIndex((r) => r.version === gradeVersionInfo.value.current)
  return gradeVersionInfo.value.rules[index + 1]?.version ?? ''
})

const completing = ref<OverhaulTicket | null>(null)
const submitting = ref(false)
const completeError = ref('')
const completeForm = reactive<CompleteTicketInput>({
  实际开工: '',
  实际完工: '',
  验收人员: '',
  验收结论: '',
})
const computedDuration = computed(() => {
  const days = daysBetween(completeForm.实际开工, completeForm.实际完工)
  return days === null ? '' : durationText(days)
})

const backfillRunning = ref(false)
const backfillProcessed = ref(0)
const backfillTotal = ref(0)
const backfillCurrentTicketNo = ref('')

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => row.status === status).length,
  })),
)

function flash(ok: boolean, text: string) {
  messageOk.value = ok
  message.value = text
}

function reload() {
  rows.value = filterTickets(filters)
  stats.value = overhaulStats()
  consistency.value = consistencyCheck()
  missingItems.value = getMissing()
  gradeVersionInfo.value = availableVersions()
  const status = backfillStatus()
  backfillProcessed.value = status.cursor?.processedTicketNos.length ?? 0
  backfillTotal.value = status.total
}

function resetFilters() {
  filters['工作票号'] = ''
  filters['检修机组'] = ''
  filters['检修级别'] = ''
  reload()
}

function exportRows() {
  downloadOverhaulCsv()
  reload()
}

function openCreate() {
  flash(false, '检修工作票登记入口尚未接入审批流')
}

function selectTicket(id: number) {
  selectedId.value = id
}

function closeDetail() {
  selectedId.value = null
}

function runAction(action: string, ticket: OverhaulTicket) {
  if (action === '办理完工' || action === '再次办理完工') {
    openComplete(ticket)
    return
  }
  let reason = ''
  if (action === REJECT_ACTION) {
    reason = window.prompt(`驳回工作票 ${ticket['工作票号']}（已批准 → 待审批），请填写驳回原因：`) ?? ''
    if (!reason.trim()) {
      flash(false, '已取消驳回：驳回必须填写原因')
      return
    }
  }
  const result = transitTicket(ticket.id, action, reason)
  flash(result.ok, result.message)
  reload()
}

function openComplete(ticket: OverhaulTicket) {
  completing.value = ticket
  completeError.value = ''
  completeForm.实际开工 = ticket['实际开工'] || ticket['计划开工']
  completeForm.实际完工 = ticket['实际完工'] || ticket['计划完工']
  completeForm.验收人员 = ticket['验收人员']
  completeForm.验收结论 = ''
}

function cancelComplete() {
  if (submitting.value) {
    return
  }
  completing.value = null
}

function submitComplete() {
  if (!completing.value) {
    return
  }
  submitting.value = true
  completeError.value = ''
  // 原子落库：四项一起写，任何一项失败服务层已整套退回，这里保持原状态。
  const result = completeTicket(completing.value.id, { ...completeForm })
  submitting.value = false
  if (!result.ok) {
    completeError.value = result.message
    return
  }
  completing.value = null
  flash(true, result.message)
  reload()
}

async function startBackfill() {
  backfillRunning.value = true
  flash(true, '存量回填开始，按时间序逐条处理；中断后可从断点继续')
  try {
    await runBackfill((info) => {
      backfillProcessed.value = info.processed
      backfillTotal.value = info.total
      backfillCurrentTicketNo.value = info.ticketNo
    })
    flash(true, '存量回填完成，缺项已列入补录清单')
  } catch (error) {
    flash(false, `回填中断：${error instanceof Error ? error.message : '未知错误'}，游标已保存，可从断点继续`)
  } finally {
    backfillRunning.value = false
    backfillCurrentTicketNo.value = ''
    reload()
  }
}

function supplementPlaceholder(field: string): string {
  if (field === '验收人员') {
    return '核实后的验收人员姓名'
  }
  if (field === '验收结论') {
    return '优良 / 合格 / 不合格'
  }
  return 'YYYY-MM-DD 至 YYYY-MM-DD'
}

function doSupplement(id: number) {
  const value = supplementInputs[id] ?? ''
  const result = supplementMissingItem(id, value)
  flash(result.ok, result.message)
  if (result.ok) {
    supplementInputs[id] = ''
  }
  reload()
}

function doUpgrade() {
  if (!nextVersion.value) {
    return
  }
  const ok = window.confirm(
    `确认将验收规则换版为 ${nextVersion.value}？\n已有完工票将按新版重算，旧结论保留当时等级并注明版本。`,
  )
  if (!ok) {
    return
  }
  const result = upgradeGradeVersion(nextVersion.value)
  flash(result.ok, result.message)
  reload()
}

onMounted(reload)
</script>
