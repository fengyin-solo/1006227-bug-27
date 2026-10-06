// 业务逻辑端到端校验：用内存 localStorage mock 跑真实数据层代码。
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'src')

function resolveAlias(spec) {
  const base = path.join(root, spec.slice(2))
  for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate)) return candidate
  }
  return base
}

const memory = new Map()
const localStorageMock = {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => { memory.set(k, String(v)) },
  removeItem: (k) => { memory.delete(k) },
}
globalThis.window = { localStorage: localStorageMock }
globalThis.localStorage = localStorageMock

const aliasPlugin = {
  name: 'alias',
  setup(b) {
    b.onResolve({ filter: /^@\// }, (args) => ({
      path: resolveAlias(args.path),
    }))
  },
}

const virtualEntryPlugin = {
  name: 'virtual-entry',
  setup(b) {
    b.onResolve({ filter: /^virtual:test-entry$/ }, () => ({ path: 'virtual:test-entry', namespace: 'v' }))
    b.onLoad({ filter: /.*/, namespace: 'v' }, () => ({
      contents: `
        export * from '${path.join(root, 'api', 'overhaul-service.ts').replaceAll('\\\\', '/')}'
        export { runAction, listEntries, loadOverview } from '${path.join(root, 'api', 'local-service.ts').replaceAll('\\\\', '/')}'
      `,
      resolveDir: root,
    }))
  },
}

async function load() {
  const result = await build({
    entryPoints: ['virtual:test-entry'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    plugins: [aliasPlugin, virtualEntryPlugin],
  })
  const blob = new Blob([result.outputFiles[0].text]); void blob
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`)
}

const assert = (cond, msg) => {
  if (!cond) {
    console.error('❌ FAIL:', msg)
    process.exitCode = 1
  } else {
    console.log('✅', msg)
  }
}

const mod = await load()
const svc = mod
const { listEntries, runAction } = mod

const TICKET_IN_OVERHAUL = 3 // JX-2026-006 检修中
const TICKET_APPROVED = 2

// 1. 状态机：检修中的票不能提交审批/开工；待审批才能提交审批
let r = runAction('overhaul', TICKET_IN_OVERHAUL, '开工检修')
assert(r.ok === false, '跳档动作被拒（检修中票不能开工检修）')
r = runAction('overhaul', TICKET_APPROVED, '提交审批')
assert(r.ok === false, '已批准票不能再提交审批')
// 退回：已批准 -> 待审批（既定方式）
r = runAction('overhaul', TICKET_APPROVED, '退回申报')
assert(r.ok === true, '已批准 →(退回申报) 待审批 成功')
r = runAction('overhaul', TICKET_APPROVED, '暂停退回')
assert(r.ok === false, '待审批不能暂停退回到已批准')
// 恢复现场
r = runAction('overhaul', TICKET_APPROVED, '提交审批')
assert(r.ok === true, '重新提交审批恢复已批准')

// 2. 完工校验：空验收人/非法工期必须整套退回
r = svc.completeTicket(TICKET_IN_OVERHAUL, { actualDays: 0, inspector: '', conclusion: '' })
assert(r.ok === false && r.message.includes('实际工期'), '实际工期为0被拒')
r = svc.completeTicket(TICKET_IN_OVERHAUL, { actualDays: 5, inspector: '   ', conclusion: '' })
assert(r.ok === false && r.message.includes('验收人员'), '验收人员为空被拒')
let t = svc.getTicket(TICKET_IN_OVERHAUL)
assert(String(t.status) === '检修中' && t['实际工期'] === '' && t['验收人员'] === '',
  '校验失败后工作票原样未动（未留下半条记录）')
assert(svc.listDutyLedger().length === 0, '校验失败后台账仍为空')

// 3. 正常完工：状态/实际工期/验收人/结论一次落库 + 台账回写 + 检修中台数回落
const statsBefore = svc.overhaulStats()
r = svc.completeTicket(TICKET_IN_OVERHAUL, { actualDays: 18, inspector: '周明远', conclusion: '', remark: '转轮处理顺利' })
assert(r.ok === true, `完工成功：${r.message}`)
t = svc.getTicket(TICKET_IN_OVERHAUL)
assert(String(t.status) === '已完工', '状态落库为已完工')
assert(Number(t['实际工期']) === 18, '实际工期落库 18 天')
assert(t['验收人员'] === '周明远', '验收人员落库')
assert(t['验收结论'] === '优良', `v1 自动定级：计划20/实际18=1.111 ≥1.1 → 优良（得「${t['验收结论']}」）`)
assert(t['完工时间'] !== '', '完工时间已写')
assert(t['规则版本'] === 'v1', '规则版本标记 v1')
const statsAfter = svc.overhaulStats()
assert(statsBefore.inOverhaul - statsAfter.inOverhaul === 1 && statsAfter.completed - statsBefore.completed === 1,
  `检修中机组台数回落（${statsBefore.inOverhaul} → ${statsAfter.inOverhaul}），已完工+1`)
assert(svc.listDutyLedger().length === 1, '台账回写 1 条')
assert(svc.listDutyLedger()[0].ticketNo === 'JX-2026-006', '台账票号正确')

// 4. 列表 / 详情 / 另存清单同源
const list = listEntries('overhaul').items
assert(list.find((x) => Number(x.id) === TICKET_IN_OVERHAUL)['验收人员'] === '周明远',
  '列表读到的验收人与落库一致')
const detail = svc.getTicket(TICKET_IN_OVERHAUL)
assert(detail['验收人员'] === list.find((x) => Number(x.id) === TICKET_IN_OVERHAUL)['验收人员'],
  '详情与列表是同一份数据')
r = svc.saveSnapshot('值班管理员')
assert(r.ok === true && r.snapshot.total === list.length, `另存清单条数=${list.length} 与列表一致`)
assert(svc.listSnapshots()[0].items.find((x) => Number(x.id) === TICKET_IN_OVERHAUL)['验收结论'] === '优良',
  '快照内容与当前存储一致')

// 5. 二次完工只落最后一次，台账条数不增
r = svc.completeTicket(TICKET_IN_OVERHAUL, { actualDays: 16, inspector: '陈志国', conclusion: '优良', remark: '复核查验' })
assert(r.ok === true, `二次完工被接受：${r.message}`)
t = svc.getTicket(TICKET_IN_OVERHAUL)
assert(Number(t['实际工期']) === 16 && t['验收人员'] === '陈志国' && t['验收结论'] === '优良',
  '二次完工覆盖为最后一次的数据')
assert(svc.listDutyLedger().length === 1, '台账仍是 1 条（upsert，不新增）')
assert(svc.listDutyLedger()[0].conclusion === '优良' && Number(svc.listDutyLedger()[0].actualDays) === 16,
  '台账条目同步为最后一次')

// 6. 已完工不能再回退状态（终态）
r = runAction('overhaul', TICKET_IN_OVERHAUL, '暂停退回')
assert(r.ok === false, '已完工是终态，状态回退被拒')

// 7. 历史回填：按时间顺序 + 断点续跑 + 缺项补录
// 已完工票：id 5,6,7,8,9,10 + 3（刚完工，已在台账） = 7 张
r = svc.backfillHistorical(2)
assert(r.ok === true, `回填前2条：${r.message}`)
let p = r.progress
assert(p.processed === 2 && p.finished === false, `校验点 processed=2（得${p.processed}），未结束`)
const orderedFirstTwo = [] // 2024-12-27(id10), 2025-06-20(id9) 最早
assert(p.lastTicketId === 9, `断点停在第二早的票 id=9（得 ${p.lastTicketId}）`)
const ledgerAfter2 = svc.listDutyLedger().length
r = svc.backfillHistorical(Infinity)
assert(r.ok === true, `继续回填至完：${r.message}`)
p = r.progress
assert(p.finished === true && p.processed === 7, `全部 7 张已完工票处理完（得 processed=${p.processed}）`)
assert(svc.listDutyLedger().length === 7, `台账最终 7 条（完工1+历史6，得 ${svc.listDutyLedger().length}）`)
// 票 id=7 缺实际工期 → 按计划25补；id=8 缺验收人；id=9 三项全缺
t = svc.getTicket(7)
assert(Number(t['实际工期']) === 25, 'id=7 缺实际工期按计划工期(25)回填')
t = svc.getTicket(8)
assert(t['验收人员'] === '值班负责人（历史补签）', 'id=8 缺验收人按裁决补签')
assert(t['验收结论'] === '合格', `id=8 计划4/实际4=1.0 v1 合格（得${t['验收结论']}）`)
t = svc.getTicket(9)
assert(Number(t['实际工期']) === 6 && t['验收人员'] === '值班负责人（历史补签）' && t['验收结论'] === '合格',
  'id=9 三项缺项全部补齐')
assert(p.supplements.length >= 5, `缺项补录记录条数=${p.supplements.length}（含实际工期/验收人/结论）`)
assert(p.supplements.every((s) => s.remark.length > 10), '每条补录都写明了补齐方式与理由')
// 不拿旧值顶替：id=5 实际工期4（与计划5不同）回填后仍是4
t = svc.getTicket(5)
assert(Number(t['实际工期']) === 4, '已有实际工期不被回填顶替（id=5 保持4天）')

// 8. 换版重算：v1 → v2，旧等级保留并注明
r = svc.upgradeConclusionRule('v2')
assert(r.ok === true, `换版：${r.message}`)
t = svc.getTicket(5)
// id=5: 计划5/实际4=1.25，v2 阈值 1.25 → 优良
assert(t['验收结论'] === '优良', `id=5 v2 重算为优良（得${t['验收结论']}）`)
assert(t['规则版本'] === 'v2' && String(t['备注']).includes('v1版结论'), '规则版本=v2 且备注保留v1旧等级')
t = svc.getTicket(6)
// id=6: 10/12=0.833，v1 是基本合格；v2: ≥0.8 仍基本合格
assert(t['验收结论'] === '基本合格', `id=6 v2 仍基本合格（得${t['验收结论']}）`)
const led6 = svc.listDutyLedger().find((x) => x.ticketId === 6)
assert(led6.ruleVersion === 'v2' && led6.remark.includes('换版重算'), '台账同步换版留痕')
assert(svc.listDutyLedger().length === 7, '换版重算不改变台账条数')
r = svc.upgradeConclusionRule('v2')
assert(r.ok === false, '重复换版被拒')

// 9. 另一个入口条数相同（模拟 cooling 页读取）
assert(svc.listDutyLedger().length === listEntries('overhaul').items.filter((x) => x.status === '已完工').length,
  '台账条数 == 已完工工作票条数（两个入口对账一致）')

// 10. 刷新后（重新加载模块 = 重开页面）数据仍在，且从同一 localStorage 读
const svc2 = await load()
const t3 = svc2.getTicket(TICKET_IN_OVERHAUL)
assert(t3['验收人员'] === '陈志国' && t3['验收结论'] === '优良', '重进页面后完工数据仍在（真正落库）')
assert(svc2.listDutyLedger().length === 7, '重进页面后台账仍 7 条')
assert(svc2.overhaulStats().inOverhaul === 1, `检修中仍剩 1 台（4号机组，得 ${svc2.overhaulStats().inOverhaul}）`)

// 11. 存储写入失败（模拟配额异常）：整套退回，内存与持久层都不留半条记录
const TICKET_OTHER = 4 // JX-2026-009 检修中
const beforeLedger = svc2.listDutyLedger().length
const storageBefore = memory.get('hydropower-plant-om:db:v2')
const originalSetItem = localStorageMock.setItem
localStorageMock.setItem = () => { throw new Error('QuotaExceededError') }
const failResult = svc2.completeTicket(TICKET_OTHER, { actualDays: 5, inspector: '测试验收人', conclusion: '' })
// 故障瞬间：Map 未被写入任何新值（抛在 setItem 内）
const storageDuringFailure = memory.get('hydropower-plant-om:db:v2')
localStorageMock.setItem = originalSetItem
assert(failResult.ok === false && failResult.message.includes('整套退回'), `存储失败被整套退回：${failResult.message}`)
const afterTicket = svc2.getTicket(TICKET_OTHER)
assert(String(afterTicket.status) === '检修中' && afterTicket['验收人员'] === '',
  '写入失败后内存中的工作票也未被改动')
assert(svc2.listDutyLedger().length === beforeLedger, '写入失败后台账条数不变')
assert(storageDuringFailure === storageBefore, '故障期间 localStorage 维持最后一次成功落盘的内容（无半条记录）')

console.log(process.exitCode ? '\n存在失败用例' : '\n🎉 全部业务校验通过')
