<template>
  <section class="page" data-module="cooling">
    <header class="page-head">
      <div>
        <h2>技术供水管理</h2>
        <p class="page-desc">维护供水系统，围绕系统编号、供水类型、供水压力、供水流量做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记供水系统</button>
        <button class="btn" type="button" @click="exportRows">导出技术供水清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
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
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无技术供水数据，可先登记供水系统</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条技术供水记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <section class="duty-ledger">
      <header class="ledger-head">
        <h3>检修处理结果值班台账（机组检修完工回写）</h3>
        <span class="ledger-count" :class="{ 'mismatch': !ledgerAligned }">
          台账 {{ ledgerRows.length }} 条 ｜ 已完工工作票 {{ completedTicketCount }} 条
          <strong :class="ledgerAligned ? 'ok-text' : 'error-text'">
            {{ ledgerAligned ? '（条数一致）' : '（条数不一致！）' }}
          </strong>
        </span>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>工作票号</th>
            <th>检修机组</th>
            <th>处理动作</th>
            <th>实际工期</th>
            <th>验收人员</th>
            <th>验收结论</th>
            <th>结论版本</th>
            <th>记录时间</th>
            <th>备注</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in ledgerRows" :key="String(entry.id)">
            <td>{{ entry['关联工作票'] }}</td>
            <td>{{ entry['检修机组'] }}</td>
            <td>{{ entry['处理动作'] }}</td>
            <td>{{ entry['实际工期'] }}</td>
            <td>{{ entry['验收人员'] || '—' }}</td>
            <td>{{ entry['验收结论'] || '—' }}</td>
            <td>{{ entry['结论版本'] || '—' }}</td>
            <td>{{ entry['记录时间'] }}</td>
            <td class="reason-cell">{{ entry['备注'] }}</td>
          </tr>
          <tr v-if="!ledgerRows.length">
            <td colspan="9" class="empty-state">暂无检修处理结果回写记录</td>
          </tr>
        </tbody>
      </table>
    </section>
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
import { getLedger, getTickets } from '@/data/overhaul-store'
import type { DutyLedgerEntry } from '@/data/overhaul-types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('cooling')
const columns = ["系统编号", "供水类型", "供水压力", "供水流量", "水温数值", "滤水器压差", "检查日期", "系统状态"]
const actions = ["提交检查", "标记异常", "停运系统"]
const statuses = ["待检查", "运行中", "异常", "已停运"]
const stats = [{"label": "运行系统", "value": 0}, {"label": "异常系统", "value": 0}, {"label": "待检查系统", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const ledgerRows = ref<DutyLedgerEntry[]>([])
const completedTicketCount = ref(0)
const ledgerAligned = ref(true)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '供水系统登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '技术供水列表读取失败'
  }
  // 值班台账直接读检修域的同一份存储：另一个入口里的条数必须相同。
  ledgerRows.value = [...getLedger()].sort((a, b) => b.记录时间.localeCompare(a.记录时间))
  completedTicketCount.value = getTickets().filter((ticket) => ticket.status === '已完工').length
  ledgerAligned.value = ledgerRows.value.length === completedTicketCount.value
}

onMounted(reload)
</script>
