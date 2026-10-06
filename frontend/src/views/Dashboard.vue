<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">重新统计</button>
      </div>
    </header>
    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>
    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>记录条数</th><th>待处理</th><th>异常量</th><th>检修中机组</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in moduleRows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td>{{ row.pending }}</td>
          <td>{{ row.abnormal }}</td>
          <td>{{ row.inOverhaul ?? '—' }}</td>
        </tr>
      </tbody>
    </table>
    <p class="reconcile">
      对帐：机组检修记录 {{ reconcile.overhaulTotal }} 条（各状态合计 {{ reconcile.sumByStatus }} 条），
      检修中机组 {{ reconcile.inOverhaul }} 台，技术供水值班台账回写 {{ reconcile.ledger }} 条。
      概览页与列表页同源读取，条数一致。
    </p>
    <footer class="page-foot">
      <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { loadOverview } from '@/api/local-service'
import { listDutyLedger, overhaulStats } from '@/api/overhaul-service'
import { listRows } from '@/data/local-store'
import type { OverviewResult } from '@/data/types'

type ModuleRow = OverviewResult['modules'][number] & { inOverhaul?: number }
type Reconcile = { overhaulTotal: number; sumByStatus: number; inOverhaul: number; ledger: number }

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<ModuleRow[]>([])
// 对账数字随「重新统计」显式重算，与列表页读同一份存储。
const reconcile = ref<Reconcile>({ overhaulTotal: 0, sumByStatus: 0, inOverhaul: 0, ledger: 0 })

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  const stats = overhaulStats()
  moduleRows.value = payload.modules.map((row) =>
    row.name === '机组检修' ? { ...row, inOverhaul: stats.inOverhaul } : row,
  )
  const overhaul = listRows('overhaul')
  reconcile.value = {
    overhaulTotal: overhaul.length,
    sumByStatus: overhaul.filter((row) =>
      ['待审批', '已批准', '检修中', '已完工'].includes(String(row.status))).length,
    inOverhaul: stats.inOverhaul,
    ledger: listDutyLedger().length,
  }
}

onMounted(refresh)
</script>

<style scoped>
.reconcile { margin-top: 10px; font-size: 12px; color: var(--muted); }
</style>
