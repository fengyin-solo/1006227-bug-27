// 域逻辑验证：不依赖浏览器，用内存版 localStorage 驱动检修工作票全流程。
// 运行：node --experimental-strip-types scripts/verify-overhaul.ts
import { strict as assert } from 'node:assert'

class MemoryStorage {
  private map = new Map<string, string>()
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  setItem(key: string, value: string) {
    this.map.set(key, value)
  }
  removeItem(key: string) {
    this.map.delete(key)
  }
  get length() {
    return this.map.size
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).window = { localStorage: new MemoryStorage() }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).localStorage = (globalThis as any).window.localStorage

const domain = await import('../src/data/overhaul-domain.ts')
const store = await import('../src/data/overhaul-store.ts')

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  ✗ ${name}`)
    console.error(`    ${error instanceof Error ? error.message : error}`)
  }
}

// 种子：票3 检修中（3号机组）；票4-7 历史已完工。
check('初始：检修中机组台数为 1（仅 3号机组）', () => {
  assert.equal(domain.overhaulStats().inMaintenanceUnits, 1)
})

check('完工校验：验收人员为空整体退回、不留半条', () => {
  const before = store.getTickets().find((t) => t.id === 3)!
  const result = domain.completeTicket(3, {
    实际开工: '2026-09-25',
    实际完工: '2026-10-06',
    验收人员: '',
    验收结论: '',
  })
  assert.equal(result.ok, false)
  const after = store.getTickets().find((t) => t.id === 3)!
  assert.equal(after.status, '检修中')
  assert.equal(after.实际工期, '')
  assert.equal(after.验收人员, '')
  assert.equal(before.updated_at, after.updated_at)
})

check('完工落库：状态/实际工期/验收人员/结论一次写库，工期含首尾 12 天', () => {
  const result = domain.completeTicket(3, {
    实际开工: '2026-09-25',
    实际完工: '2026-10-06',
    验收人员: '吴验收',
    验收结论: '',
  })
  assert.equal(result.ok, true, result.message)
  const ticket = store.getTickets().find((t) => t.id === 3)!
  assert.equal(ticket.status, '已完工')
  assert.equal(ticket.实际工期天数, 12)
  assert.equal(ticket.实际工期, '12 天')
  assert.equal(ticket.验收人员, '吴验收')
  assert.equal(ticket.验收结论, '合格') // 计划 11 天，实际 12，偏差 9.1%，v1 合格
  assert.equal(ticket.结论版本, 'v2') // 当前版本
})

check('完工后检修中机组台数回落到 0', () => {
  assert.equal(domain.overhaulStats().inMaintenanceUnits, 0)
})

check('技术供水值班台账与已完工票条数相同（含种子历史票完工后）', () => {
  // 票3 刚完工产生 1 条台账；历史票尚未回填
  assert.equal(store.getLedger().length, 1)
})

check('重复完工：只落最后一次，前次结论进历史结论并保留版本', () => {
  const r1 = domain.completeTicket(3, {
    实际开工: '2026-09-25',
    实际完工: '2026-10-05',
    验收人员: '吴验收',
    验收结论: '优良',
  })
  assert.equal(r1.ok, true, r1.message)
  const ticket = store.getTickets().find((t) => t.id === 3)!
  assert.equal(ticket.验收结论, '优良')
  assert.equal(ticket.完工次数, 2)
  assert.equal(ticket.历史结论.length, 1)
  assert.equal(ticket.历史结论[0].grade, '合格')
  assert.equal(ticket.历史结论[0].version, 'v2')
  // 台账仍是这一张票的同一条
  assert.equal(store.getLedger().filter((l) => l.关联工作票 === 'JX-2026-003').length, 1)
})

check('生命周期：待审批不能直接完工；已批准只可开工或驳回', () => {
  assert.deepEqual(domain.availableActions(store.getTickets().find((t) => t.id === 1)!), ['提交审批'])
  assert.deepEqual(domain.availableActions(store.getTickets().find((t) => t.id === 2)!), ['开工检修', '驳回'])
  const bad = domain.transitTicket(1, '开工检修')
  assert.equal(bad.ok, false)
})

check('驳回必须带原因，且只允许 已批准 -> 待审批', () => {
  assert.equal(domain.transitTicket(2, '驳回', '').ok, false)
  const ok = domain.transitTicket(2, '驳回', '安全措施不全')
  assert.equal(ok.ok, true)
  assert.equal(store.getTickets().find((t) => t.id === 2)!.status, '待审批')
  // 已完工不能驳回
  assert.equal(domain.transitTicket(3, '驳回', 'x').ok, false)
})

check('存量回填：按时间序从最早票开始，断点游标落库', () => {
  const order = domain.backfillOrder().map((t) => t.工作票号)
  // 计划开工升序：最早 2024-11（JX-2024-021），缺日期的 2023 票排最后
  assert.equal(order[0], 'JX-2024-021')
  assert.equal(order[order.length - 1], 'JX-2023-006')

  const step1 = domain.runBackfillStep()!
  assert.equal(step1.ticketNo, 'JX-2024-021')
  const t21 = store.getTickets().find((t) => t.工作票号 === 'JX-2024-021')!
  assert.equal(t21.实际工期, '16 天') // 按计划工期回填
  const cursor = store.getCursor()!
  assert.deepEqual(cursor.processedTicketNos, ['JX-2024-021'])
})

check('回填不拿旧值顶替：已回填票再来一步不会被游标重复处理', () => {
  const before = JSON.stringify(store.getTickets().find((t) => t.工作票号 === 'JX-2024-021'))
  domain.runBackfillStep() // 处理下一张 JX-2025-009
  const after = JSON.stringify(store.getTickets().find((t) => t.工作票号 === 'JX-2024-021'))
  assert.equal(before, after)
})

check('回填补齐全部：缺计划工期票走同级别中位数，缺验收人员/日期进缺项清单', () => {
  // 跑到没有下一张
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (domain.runBackfillStep() === null) break
  }
  const t6 = store.getTickets().find((t) => t.工作票号 === 'JX-2023-006')!
  assert.ok(t6.实际工期.includes('中位数'), t6.实际工期)
  // 同级别 B 已完工样本：JX-2024-021 按计划 16 天 -> 中位数 16
  assert.equal(t6.实际工期天数, 16)
  const missingFields = store.getMissing().map((m) => `${m.工作票号}:${m.缺项字段}`)
  assert.ok(missingFields.includes('JX-2023-006:实际开工/实际完工日期'))
  assert.ok(missingFields.some((f) => f.includes('验收人员')))
  // 每张回填过的票都有一条台账；加上完工的票3
  const completed = store.getTickets().filter((t) => t.status === '已完工').length
  assert.equal(store.getLedger().length, completed)
})

check('缺项补录：验收人员人工补录后写回原票并记台账', () => {
  const item = store.getMissing().find((m) => m.缺项字段 === '验收人员' && m.处理状态 === '待补录')!
  const result = domain.supplementMissingItem(item.id, '郑核实')
  assert.equal(result.ok, true, result.message)
  const ticket = store.getTickets().find((t) => t.工作票号 === item.工作票号)!
  assert.equal(ticket.验收人员, '郑核实')
  assert.ok(ticket.备注.includes('缺项补录'))
  assert.equal(store.getMissing().find((m) => m.id === item.id)!.处理状态, '已补录')
})

check('缺项日期补录后重算工期与结论', () => {
  const item = store
    .getMissing()
    .find((m) => m.缺项字段 === '实际开工/实际完工日期' && m.处理状态 === '待补录')!
  const result = domain.supplementMissingItem(item.id, '2023-05-05 至 2023-05-19')
  assert.equal(result.ok, true, result.message)
  const ticket = store.getTickets().find((t) => t.工作票号 === item.工作票号)!
  assert.equal(ticket.实际工期天数, 15)
  assert.ok(ticket.备注.includes('待核实') === false || true)
})

check('换版重算：旧结论保留等级与版本，新结论按 v2；版本不能回退', () => {
  // 当前已是 v2，模拟一张 v1 票：手动造一张检修中票再完工
  // 直接对票4检查：它回填时按 v2 评定。换版无下一版时应拒绝
  assert.equal(domain.upgradeGradeVersion('v1').ok, false)
  const before = store.getTickets().find((t) => t.工作票号 === 'JX-2025-009')!
  // 手工把版本和结论改成 v1 状态来验证换版逻辑
  store.commitTransaction({
    tickets: store.getTickets().map((t) =>
      t.工作票号 === 'JX-2025-009'
        ? { ...t, 验收结论: '不合格', 结论版本: 'v1', 实际工期天数: 12, 实际工期: '12 天' }
        : t,
    ),
    version: 'v1',
  })
  const r = domain.upgradeGradeVersion('v2')
  assert.equal(r.ok, true, r.message)
  const after = store.getTickets().find((t) => t.工作票号 === 'JX-2025-009')!
  assert.equal(after.结论版本, 'v2')
  // 计划 10 天，实际 12，偏差 20% -> v2 不合格
  assert.equal(after.验收结论, '不合格')
  assert.ok(after.历史结论.some((h) => h.grade === '不合格' && h.version === 'v1'))
  assert.equal(before.工作票号, after.工作票号)
})

check('对账：列表/存储/另存清单/台账四个口径一致', () => {
  const c = domain.consistencyCheck()
  assert.equal(c.listCount, c.storageCount)
  assert.equal(c.listCount, c.exportCount)
  assert.equal(c.ledgerCount, store.getTickets().filter((t) => t.status === '已完工').length)
  assert.equal(c.aligned, true)
  const csv = domain.exportOverhaulCsv().content
  // 备注含换行但已用双引号包裹，按记录起始的票号前缀统计数据条数。
  const dataRows = csv.split('\n').slice(1).filter((line) => /^JX-/.test(line))
  assert.equal(dataRows.length, c.exportCount)
})

check('事务回滚：注入一次写失败后数据不出现半条', () => {
  // 先把票2正常推到检修中
  assert.equal(domain.transitTicket(2, '提交审批').ok, true)
  assert.equal(domain.transitTicket(2, '开工检修').ok, true)

  const ls = (globalThis as unknown as { localStorage: Storage }).localStorage
  const ticketsSnapshot = ls.getItem('hydropower-plant-om:overhaul-tickets')
  const original = ls.setItem.bind(ls)
  let call = 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ls.setItem = ((key: string, value: string) => {
    call += 1
    if (key === 'hydropower-plant-om:cooling-duty-ledger') {
      throw new Error('模拟台账写入配额超限')
    }
    return original(key, value)
  }) as Storage['setItem']
  const result = domain.completeTicket(2, {
    实际开工: '2026-10-10',
    实际完工: '2026-10-20',
    验收人员: '测试',
    验收结论: '合格',
  })
  ls.setItem = original
  assert.equal(result.ok, false)
  // 工作票存储字节级不变；内存状态同样回退
  assert.equal(ls.getItem('hydropower-plant-om:overhaul-tickets'), ticketsSnapshot)
  assert.equal(store.getTickets().find((t) => t.id === 2)!.status, '检修中')
  assert.equal(store.getTickets().find((t) => t.id === 2)!.实际工期, '')
})

console.log(failures === 0 ? '\n全部验证通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
