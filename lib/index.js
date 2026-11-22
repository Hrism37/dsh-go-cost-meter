// dsh-go 原生费用插件。
//
// 数据来自宿主机上的 dsh-cost-meter：优先调用它注册的 `costMeter` 服务，服务
// 不可用时直接读 $DSH_HOME/storages/cost-meter/ledger.json 账本。本插件只在
// dsh-go 手机 App 的原生界面里显示：
//   - 输入框上方的「费用」胶囊（点开费用面板，与「插件」并排）
//   - 每条回复下方的本轮费用
//   - 费用面板：本会话 / 今日 / 近 7 天、预算、峰谷倒计时、模型排行、Token 构成
// 不改 Harness 网页端。

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'local-cost-meter'

const TICK_MS = 45_000
const REFRESH_GAP_MS = 1_200
const SESSION_TTL_MS = 5_000
const DAY_MS = 86_400_000
const TURNS_PAGE = 25
const MAX_TURN_PAGES = 12
const MAX_NOTE_TURNS = 40
const CURRENCIES = new Set(['CNY', 'USD', 'EUR'])
const SYMBOL = { CNY: '¥', USD: '$', EUR: '€' }
const EPS = 1e-9

let ledgerCache = { mtime: -1, value: null }

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const round = (v, digits = 6) => Number(v.toFixed(digits))
const isZh = (locale) => !String(locale ?? '').toLowerCase().startsWith('en')

function home() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function ledgerFile() {
  return join(home(), 'storages', 'cost-meter', 'ledger.json')
}

/** 账本按 mtime 缓存：轮询时不做重复解析（文件可达数百 KB）。 */
function readLedger() {
  const file = ledgerFile()
  let mtime = -1
  try { mtime = statSync(file).mtimeMs } catch { return ledgerCache.value }
  if (mtime === ledgerCache.mtime) return ledgerCache.value
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    ledgerCache = { mtime, value }
    return value
  } catch {
    return ledgerCache.value
  }
}

/** 币种、符号、小数位、计费口径、预算与峰谷配置都沿用 dsh-cost-meter 的账本配置。 */
function settings() {
  const cfg = readLedger()?.config ?? {}
  let currency = CURRENCIES.has(cfg.currency) ? cfg.currency : 'USD'
  let symbol = typeof cfg.symbol === 'string' && cfg.symbol !== '' ? cfg.symbol : (SYMBOL[currency] ?? '$')
  const decimals = Number.isFinite(cfg.decimals) ? Math.min(8, Math.max(2, Math.trunc(cfg.decimals))) : 4
  const basis = ['api', 'plan', 'total'].includes(cfg.statisticsBasis)
    ? cfg.statisticsBasis
    : cfg.showTotalWithPlan === true ? 'total' : 'api'
  const rate = currency === 'CNY'
    ? num(cfg.fxRates?.CNY) || num(cfg.exchangeRate) || null
    : currency === 'EUR' ? num(cfg.fxRates?.EUR) || 1 : 1
  // 汇率缺失时不能把美元金额贴上 ¥ 符号：降级为美元展示，并显式覆盖 cfg.symbol 带来的符号。
  if (currency === 'CNY' && rate === null) {
    currency = 'USD'
    symbol = '$'
  }
  const budget = cfg.budget?.enabled === true && cfg.hideBudget !== true && num(cfg.budget.amount) > 0
    ? { amount: num(cfg.budget.amount), period: cfg.budget.period === 'day' || cfg.budget.period === 'week' ? cfg.budget.period : 'month' }
    : null
  let tz = 'Asia/Shanghai'
  try { tz = cfg.peakTimeZone && cfg.peakTimeZone !== 'auto' ? cfg.peakTimeZone : Intl.DateTimeFormat().resolvedOptions().timeZone || tz } catch { /* 用默认时区 */ }
  const peak = {
    enabled: cfg.peakEnabled === true,
    windows: Array.isArray(cfg.peakWindows) ? cfg.peakWindows : [],
    holidays: Array.isArray(cfg.peakHolidays) ? cfg.peakHolidays : [],
    effectiveAt: Date.parse(cfg.peakEffectiveAt),
  }
  return { currency, symbol, decimals, basis, rate, budget, peak, tz }
}

function basisAmount(total, api, basis) {
  if (basis === 'total') return total
  if (basis === 'plan') return Math.max(0, total - api)
  return api
}

/**
 * 与网页端 displayCostOf + formatMoneyUsd 同口径：costMeter 服务返回的金额一律是
 * 「美元等值」（currencyLedger 的约定），展示 CNY/EUR 时要乘回汇率；条目自带冻结的
 * costCny/costEur 字段时优先用它（与网页端一致）。
 */
function converted(entry, s, key) {
  const usd = num(entry?.[key])
  if (s.currency === 'CNY') {
    const cny = entry?.[`${key}Cny`]
    if (Number.isFinite(cny) && !(cny === 0 && usd > 0)) return cny
    return usd * s.rate
  }
  if (s.currency === 'EUR') {
    const eur = entry?.[`${key}Eur`]
    if (Number.isFinite(eur) && !(eur === 0 && usd > 0)) return eur
    return usd * s.rate
  }
  return usd
}

function pricingFlagFile() {
  return join(home(), 'cache', 'local-cost-meter', 'official-cny.json')
}

/** 计价口径：pricingCurrency 是意图，prices.currency 是价格表实际币种。 */
function pricingState() {
  const cfg = readLedger()?.config ?? {}
  const declared = cfg.pricingCurrency === 'CNY' ? 'CNY' : 'USD'
  const tableCurrency = cfg.prices?.currency === 'CNY' ? 'CNY' : 'USD'
  return { declared, tableCurrency, isCny: declared === 'CNY' && tableCurrency === 'CNY' }
}

/**
 * 把 dsh-cost-meter 切成「官方人民币价」：pricingCurrency=CNY + 抓官方中文价格页同步价表，
 * 这样计费直接按 DeepSeek 官方人民币单价折算，不再依赖美元价 × 汇率。
 * 成功后写标记文件，之后不再自动切换（尊重用户手动改回美元价）。
 */
async function syncOfficialCnyPricing(ctx) {
  const svc = ctx.get('costMeter')
  if (!svc || typeof svc.updateConfig !== 'function') {
    return { ok: false, message: '未检测到 dsh-cost-meter 服务' }
  }
  try {
    if (readLedger()?.config?.pricingCurrency !== 'CNY') await svc.updateConfig({ pricingCurrency: 'CNY' })
  } catch (error) {
    return { ok: false, message: `切换计价币种失败：${error?.message ?? error}` }
  }
  let result = { ok: false, message: '官方价格同步失败' }
  try {
    if (typeof svc.fetchPrices === 'function') {
      const synced = await svc.fetchPrices()
      result = {
        ok: synced?.ok === true,
        message: typeof synced?.message === 'string' ? synced.message : synced?.ok === true ? '已同步官方人民币价' : '官方价格同步失败',
      }
    } else {
      result = { ok: false, message: '当前宿主不支持价格同步' }
    }
  } catch (error) {
    result = { ok: false, message: `官方价格同步失败：${error?.message ?? error}` }
  }
  if (result.ok) {
    try {
      const file = pricingFlagFile()
      mkdirSync(join(home(), 'cache', 'local-cost-meter'), { recursive: true })
      writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), ok: true, message: result.message }))
    } catch { /* 标记只用于免打扰，写不进也不影响本次同步 */ }
  }
  sessionCache.clear()
  turnCostCache.clear()
  return result
}

/** 首次运行自动切一次官方人民币价；已有标记或已是人民币价则跳过。 */
async function ensureOfficialCnyOnce(ctx) {
  try {
    if (existsSync(pricingFlagFile())) return
    if (pricingState().isCny) return
    const result = await syncOfficialCnyPricing(ctx)
    console.log(`[local-cost-meter] 官方人民币计价${result.ok ? '已启用' : '未完成'}${result.ok ? '' : `: ${result.message}`}`)
  } catch { /* 自动切换失败不影响手动面板操作 */ }
}

function dayKey(offset = 0) {
  const d = new Date(Date.now() + offset * DAY_MS)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function periodStart(period) {
  if (period === 'day') return dayKey(0)
  if (period === 'week') return dayKey(-((new Date().getDay() + 6) % 7))
  return dayKey(1 - new Date().getDate())
}

function clockText() {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function money(value, s) {
  const v = Number(value)
  if (!Number.isFinite(v)) return '—'
  const abs = Math.abs(v)
  let digits = s.decimals
  if (abs > 0 && abs < 0.01) digits = Math.max(digits, 4)
  if (abs > 0 && abs < 0.0001) digits = 8
  let text = v.toFixed(digits)
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '')
  if (text === '-0') text = '0'
  return `${s.symbol}${text}`
}

function tokensText(value) {
  const v = Math.max(0, Math.round(num(value)))
  if (v < 1000) return String(v)
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}k`
  return `${(v / 1_000_000).toFixed(2)}M`
}

function cacheRate(cacheRead, promptTokens) {
  if (!(promptTokens > 0)) return '—'
  return `${((100 * cacheRead) / promptTokens).toFixed(1)}%`
}

// ── 峰谷时段（与 dsh-cost-meter 的 peakPhaseAt 同口径）────────────────────

const WEEKEND_EFFECTIVE_AT = Date.parse('2026-08-22T16:00:00Z')

const beijingDay = (ms) => Math.floor((ms + 8 * 3_600_000) / DAY_MS)

function weekendAt(ms) {
  if (!Number.isFinite(ms) || ms < WEEKEND_EFFECTIVE_AT) return false
  const weekday = (beijingDay(ms) + 4) % 7
  return weekday === 6 || weekday === 0
}

function holidayAt(ms, holidays) {
  if (!holidays.length || ms < WEEKEND_EFFECTIVE_AT) return false
  const key = new Date(beijingDay(ms) * DAY_MS).toISOString().slice(0, 10)
  return holidays.includes(key)
}

/** 窗口是 UTC 小时的半开区间；周末与中国的公众假期全天谷价。 */
function isPeakAt(ms, windows, holidays) {
  if (holidayAt(ms, holidays) || weekendAt(ms)) return false
  const hour = new Date(ms).getUTCHours()
  return windows.some((w) => {
    const start = Number(w?.start)
    const end = Number(w?.end)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false
    if (start < end) return hour >= start && hour < end
    return hour >= start || hour < end
  })
}

/** 当前相位与下一次切换；窗口为空或峰谷没开时返回 null。 */
export function peakInfo(peak, now) {
  if (!peak?.enabled) return null
  const windows = (peak.windows ?? []).filter((w) => Number.isFinite(Number(w?.start)) && Number.isFinite(Number(w?.end)) && Number(w?.start) !== Number(w?.end))
  if (windows.length === 0) return null
  const holidays = peak.holidays ?? []
  if (Number.isFinite(peak.effectiveAt) && now < peak.effectiveAt) {
    return { phase: 'base', windows, holidays, inPeak: false, next: null, nextIntoPeak: null }
  }
  const inPeak = isPeakAt(now, windows, holidays)
  let next = null
  const first = Math.floor(now / 60_000) * 60_000 + 60_000
  for (let t = first; t <= now + 10 * DAY_MS; t += 60_000) {
    if (isPeakAt(t, windows, holidays) !== inPeak) { next = t; break }
  }
  return {
    phase: inPeak ? 'peak' : 'offpeak',
    inPeak,
    windows,
    holidays,
    weekend: weekendAt(now),
    holiday: holidayAt(now, holidays),
    next,
    nextIntoPeak: next === null ? null : isPeakAt(next, windows, holidays),
  }
}

function durationText(ms) {
  const total = Math.max(0, Math.round(ms / 60_000))
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  if (hours > 0 && minutes > 0) return `${hours} 小时 ${minutes} 分`
  if (hours > 0) return `${hours} 小时`
  return `${minutes} 分`
}

function zonedTime(ms, tz) {
  try {
    return new Intl.DateTimeFormat('zh-CN', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms)
  } catch {
    return clockText()
  }
}

function zonedDay(ms, tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)
  } catch {
    return new Date(ms).toISOString().slice(0, 10)
  }
}

function switchLabel(ms, tz, now) {
  const day = zonedDay(ms, tz)
  const today = zonedDay(now, tz)
  const tomorrow = zonedDay(now + DAY_MS, tz)
  const prefix = day === today ? '今天' : day === tomorrow ? '明天' : day.slice(5).replace('-', '/')
  return `${prefix} ${zonedTime(ms, tz)}`
}

/** 本地时间下的峰时窗口文字，例如 09:00–12:00、14:00–18:00。 */
function windowText(windows, tz) {
  const hour = (h) => zonedTime(Date.UTC(2000, 0, 1, ((h % 24) + 24) % 24), tz)
  return windows
    .filter((w) => Number.isFinite(Number(w?.start)) && Number.isFinite(Number(w?.end)))
    .map((w) => `${hour(Number(w.start))}–${hour(Number(w.end) <= Number(w.start) ? Number(w.end) + 24 : Number(w.end))}`)
    .join('、')
}

// ── 数据来源 ──────────────────────────────────────────────────────────────

const sessionCache = new Map()

/** 逐轮费用缓存：key = sessionId，值为 Map(turn -> { cost, apiCost })。 */
const turnCostCache = new Map()

/** 会话的实时事件快照（用于找每轮的 turn/start 与 turn/end 的 seq 边界）。 */
function sessionEvents(ctx, sessionId) {
  try {
    const session = ctx.get('sessions')?.get?.(sessionId)
    const events = session?.snapshotEvents?.()
    return Array.isArray(events) ? events : null
  } catch {
    return null
  }
}

/**
 * 与 dsh-cost-meter 网页端「本轮费用」同口径：对每一轮按 [turn/start, turn/end]
 * 的 seq 区间调用 costMeter.getTurnCost 重放计价（含该轮时间段内的搜索/抓取请求费，
 * 不含子代理会话与继承的历史用量）。会话日志只增不改，算出的结果在会话内缓存，
 * 收到 turn/end 时再失效重算。
 */
async function turnCostMap(ctx, sessionId, s) {
  const cached = turnCostCache.get(sessionId)
  if (cached && cached.currency === s.currency) return cached.values
  const svc = ctx.get('costMeter')
  if (!svc || typeof svc.getTurnCost !== 'function') return null
  const events = sessionEvents(ctx, sessionId)
  if (!events) return null
  const bounds = new Map()
  for (const ev of events) {
    const turn = ev?.data?.turn
    if (!Number.isSafeInteger(turn) || turn < 0) continue
    if (ev.type === 'turn/start') bounds.set(turn, { start: Number(ev.seq) })
    else if (ev.type === 'turn/end') {
      const b = bounds.get(turn)
      if (b) b.end = Number(ev.seq)
    }
  }
  const values = new Map()
  for (const [turn, b] of bounds) {
    if (!Number.isSafeInteger(b?.start) || !Number.isSafeInteger(b?.end) || b.end <= b.start) continue
    try {
      const row = await svc.getTurnCost(sessionId, b.start, b.end, s.currency)
      if (row && row.found) values.set(turn, row)
    } catch { /* 这一轮读不到就跳过，不整页报错 */ }
  }
  const entry = { at: Date.now(), currency: s.currency, values }
  turnCostCache.set(sessionId, entry)
  return values
}

function emptySession() {
  return { found: true, amount: 0, calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, plan: false, turns: [] }
}

/** 账本兜底：没有 costMeter 服务时按会话汇总账本里的每日记录。 */
function ledgerSession(sessionId, s) {
  const days = readLedger()?.days ?? {}
  let total = 0
  let api = 0
  let calls = 0
  let cacheRead = 0
  let input = 0
  let cacheWrite = 0
  let output = 0
  let reasoning = 0
  let found = false
  for (const day of Object.values(days)) {
    for (const entry of Array.isArray(day?.sessions) ? day.sessions : []) {
      if (entry?.id !== sessionId) continue
      found = true
      total += converted(entry, s, 'cost')
      api += converted(entry, s, 'apiCost')
      calls += num(entry.calls)
      cacheRead += num(entry.cacheRead)
      input += num(entry.input)
      cacheWrite += num(entry.cacheWrite)
      output += num(entry.output)
      reasoning += num(entry.reasoning)
    }
  }
  if (!found) return null
  return {
    found: true,
    amount: basisAmount(total, api, s.basis),
    calls,
    input,
    cacheRead,
    cacheWrite,
    output,
    reasoning,
    plan: total - api > EPS,
    turns: [],
  }
}

/** 分页取全某会话的逐轮费用（服务默认一页 25 轮）。 */
async function billingTurns(ctx, sessionId, s) {
  const svc = ctx.get('costMeter')
  const turns = []
  let billing = null
  for (let page = 0; page < MAX_TURN_PAGES; page += 1) {
    let partial
    try {
      partial = await svc.getSessionBilling({ sessionId, displayCurrency: s.currency, turnOffset: page * TURNS_PAGE, offset: 0 })
    } catch {
      return null
    }
    if (!partial) return null
    billing = partial
    const rows = Array.isArray(partial.turns) ? partial.turns : []
    for (const row of rows) {
      if (row?.turn === null || row?.turn === undefined) continue
      // 只取主会话自己的轮次，子代理会话的轮次不并进来。
      if (row.sessionId !== undefined && row.sessionId !== sessionId) continue
      if (turns.some((item) => item.turn === row.turn)) continue
      turns.push(row)
    }
    const total = Number(partial.totalTurns)
    if (!Number.isFinite(total) || turns.length >= total || rows.length < TURNS_PAGE) break
  }
  return billing === null ? null : { billing, turns }
}

async function sessionStats(ctx, sessionId, s) {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  const cached = sessionCache.get(sessionId)
  if (cached && cached.currency === s.currency && Date.now() - cached.at < SESSION_TTL_MS) return cached.value
  const svc = ctx.get('costMeter')
  if (svc && typeof svc.getSessionBilling === 'function') {
    const data = await billingTurns(ctx, sessionId, s)
    if (data && data.billing && data.billing.found !== false) {
      const b = data.billing
      const total = converted(b, s, 'cost')
      const api = converted(b, s, 'apiCost')
      const recorded = b.recorded ?? {}
      const value = {
        found: true,
        amount: basisAmount(total, api, s.basis),
        calls: num(b.totalCalls) || num(recorded.calls) || num(b.calls),
        input: num(recorded.input),
        cacheRead: num(recorded.cacheRead),
        cacheWrite: num(recorded.cacheWrite),
        output: num(recorded.output),
        reasoning: num(recorded.reasoning),
        plan: total - api > EPS,
        turns: data.turns,
      }
      sessionCache.set(sessionId, { at: Date.now(), currency: s.currency, value })
      return value
    }
  }
  const value = ledgerSession(sessionId, s)
  if (value) sessionCache.set(sessionId, { at: Date.now(), currency: s.currency, value })
  return value
}

function ledgerRange(from, to, s) {
  const days = readLedger()?.days ?? {}
  const rows = []
  const models = new Map()
  for (const [date, day] of Object.entries(days)) {
    if (date < from || date > to) continue
    const row = {
      date,
      cost: num(day.cost),
      apiCost: num(day.apiCost),
      costCny: num(day.costCny),
      apiCostCny: num(day.apiCostCny),
      costEur: num(day.costEur),
      apiCostEur: num(day.apiCostEur),
      calls: num(day.calls),
      input: num(day.input),
      cacheRead: num(day.cacheRead),
      cacheWrite: num(day.cacheWrite),
      output: num(day.output),
      reasoning: num(day.reasoning),
    }
    rows.push(row)
    for (const [key, value] of Object.entries(day.byProviderModel ?? {})) {
      const colon = key.indexOf(':')
      const current = models.get(key) ?? {
        key,
        provider: colon === -1 ? '' : key.slice(0, colon),
        model: colon === -1 ? key : key.slice(colon + 1),
        cost: 0,
        apiCost: 0,
        costCny: 0,
        apiCostCny: 0,
        costEur: 0,
        apiCostEur: 0,
        calls: 0,
      }
      current.cost += num(value.cost)
      current.apiCost += num(value.apiCost)
      current.costCny += num(value.costCny)
      current.apiCostCny += num(value.apiCostCny)
      current.costEur += num(value.costEur)
      current.apiCostEur += num(value.apiCostEur)
      current.calls += num(value.calls)
      models.set(key, current)
    }
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : 1))
  return { days: rows, models: [...models.values()] }
}

async function rangeStats(ctx, from, to, s) {
  const svc = ctx.get('costMeter')
  if (svc && typeof svc.getBillingStatistics === 'function') {
    try {
      const stats = await svc.getBillingStatistics({ from, to, displayCurrency: s.currency })
      if (stats && Array.isArray(stats.days)) return stats
    } catch { /* 服务暂时不可用：回落到账本 */ }
  }
  return ledgerRange(from, to, s)
}

// ── 面板数据与视图 ────────────────────────────────────────────────────────

function moneyOfRow(row, s) {
  return basisAmount(converted(row, s, 'cost'), converted(row, s, 'apiCost'), s.basis)
}

function peakLines(s) {
  const now = Date.now()
  const peak = peakInfo(s.peak, now)
  if (peak === null) {
    return { enabled: false, title: '峰时时段未配置', rows: [] }
  }
  const windows = windowText(peak.windows, s.tz)
  if (peak.phase === 'base') {
    return { enabled: true, title: '峰谷计价尚未生效，当前按基础价计费', rows: [{ label: '峰时时段', value: windows }] }
  }
  const label = peak.inPeak ? '峰时' : peak.weekend ? '周末谷价' : peak.holiday ? '假期谷价' : '谷时'
  const target = peak.nextIntoPeak === true ? '峰时' : '谷时'
  const title = peak.next === null
    ? `现在${label}`
    : `现在${label}，${durationText(peak.next - now)}后（${switchLabel(peak.next, s.tz, now)}）转${target}`
  return {
    enabled: true,
    title,
    rows: [
      { label: '峰时时段', value: windows },
      ...(peak.next === null ? [] : [{ label: '下次切换', value: `${switchLabel(peak.next, s.tz, now)} → ${target}` }]),
    ],
  }
}

async function panelData(ctx, sessionId) {
  const s = settings()
  const today = dayKey(0)
  const from = s.budget ? periodStart(s.budget.period) : dayKey(-6)
  const start = from < dayKey(-6) ? from : dayKey(-6)
  const stats = await rangeStats(ctx, start, today, s)
  const byDate = new Map((stats?.days ?? []).map((row) => [row.date, row]))
  const week = []
  for (let i = 6; i >= 0; i -= 1) week.push(dayKey(-i))
  const weekRows = week.map((date) => byDate.get(date)).filter(Boolean)
  const weekAmount = weekRows.reduce((sum, row) => sum + moneyOfRow(row, s), 0)
  const weekCalls = weekRows.reduce((sum, row) => sum + num(row.calls), 0)
  const todayRow = byDate.get(today)
  const todayAmount = todayRow ? moneyOfRow(todayRow, s) : 0
  const todayPrompt = todayRow ? num(todayRow.input) + num(todayRow.cacheRead) + num(todayRow.cacheWrite) : 0
  const todayCache = todayRow ? cacheRate(num(todayRow.cacheRead), todayPrompt) : ''

  const session = await sessionStats(ctx, sessionId, s)

  let budgetPct = null
  let budgetCap = ''
  if (s.budget) {
    const budgetFrom = periodStart(s.budget.period)
    const spent = [...byDate.values()].filter((row) => row.date >= budgetFrom)
      .reduce((sum, row) => sum + moneyOfRow(row, s), 0)
    budgetPct = Math.min(100, Math.round((spent / s.budget.amount) * 100))
    const periodText = s.budget.period === 'day' ? '今日' : s.budget.period === 'week' ? '本周' : '本月'
    budgetCap = `${periodText} ${money(spent, s)} / ${money(s.budget.amount, s)}`
  }

  const models = (stats?.models ?? [])
    .map((row) => ({ row, amount: moneyOfRow(row, s) }))
    .filter((item) => item.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5)
  const modelRows = models.length > 0
    ? models.map(({ row, amount }) => ({
        title: String(row.model || row.key || '未知模型'),
        subtitle: `${num(row.calls)} 次 · ${row.provider || '—'}`,
        trailing: money(amount, s),
      }))
    : [{ title: '暂无费用记录', subtitle: '这个范围内还没有可统计的调用' }]

  const promptTokens = session ? num(session.input) + num(session.cacheRead) + num(session.cacheWrite) : 0
  const tokenRows = session && session.calls > 0
    ? [
        { label: '输入', value: tokensText(num(session.input)) },
        { label: '缓存读', value: tokensText(num(session.cacheRead)) },
        { label: '输出', value: tokensText(num(session.output)) },
        { label: '缓存命中', value: cacheRate(num(session.cacheRead), promptTokens) },
        { label: '调用', value: `${num(session.calls)} 次` },
      ]
    : [{ label: '本会话', value: '暂无记录' }]

  const peak = peakLines(s)
  const sessionTokens = session
    ? `${tokensText(promptTokens + num(session.output))} tok · ${num(session.calls)} 次调用`
    : '暂无记录'

  // 数据源不可用（costMeter 服务缺失且账本读不到）时显示 “—”，不要把缺失渲染成 ¥0.00。
  const unavailable = !ctx.get('costMeter') && readLedger() === null

  return {
    session: unavailable ? '—' : money(session?.amount ?? 0, s),
    sessionCap: sessionTokens + (session?.plan ? ' · 含 Plan 等值' : ''),
    today: unavailable ? '—' : money(todayAmount, s),
    todayCap: todayRow ? `${num(todayRow.calls)} 次调用${todayCache ? ` · 缓存 ${todayCache}` : ''}` : '暂无记录',
    week: unavailable ? '—' : money(weekAmount, s),
    weekCap: `近 7 天 · ${weekCalls} 次调用`,
    days: week.map((date) => date.slice(5)),
    costs: week.map((date) => round(moneyOfRow(byDate.get(date) ?? {}, s))),
    chartCap: `${start} – ${today}`,
    tokenRows,
    modelRows,
    peakEnabled: peak.enabled,
    peakTitle: peak.title,
    peakRows: peak.rows,
    budgetEnabled: s.budget !== null,
    budgetPct: budgetPct ?? 0,
    budgetCap,
    pricingLabel: (() => {
      const pricing = pricingState()
      if (pricing.isCny) return '计价：官方人民币价（DeepSeek 官方 ¥/百万 token）'
      if (pricing.declared === 'CNY' && pricing.tableCurrency === 'USD') return '计价：价格表仍是美元价，点下方「同步官方人民币价」'
      return '计价：官方美元价 × 汇率折算'
    })(),
    updated: `更新于 ${clockText()} · 数据来自 dsh-cost-meter 账本`,
  }
}

function buildView(locale) {
  const zh = isZh(locale)
  const s = settings()
  const children = [
    {
      type: 'row',
      children: [
        { type: 'metric', label: zh ? '本会话' : 'Session', value: { $: 'data.session' }, caption: { $: 'data.sessionCap' } },
        { type: 'metric', label: zh ? '今日' : 'Today', value: { $: 'data.today' }, caption: { $: 'data.todayCap' } },
      ],
    },
    { type: 'metric', label: zh ? '近 7 天' : 'Last 7 days', value: { $: 'data.week' }, caption: { $: 'data.weekCap' } },
  ]
  if (s.budget) {
    const label = s.budget.period === 'day' ? (zh ? '今日预算' : 'Daily budget') : s.budget.period === 'week' ? (zh ? '本周预算' : 'Weekly budget') : (zh ? '本月预算' : 'Monthly budget')
    children.push({ type: 'progress', value: { $: 'data.budgetPct' }, max: 100, label, caption: { $: 'data.budgetCap' } })
  }
  if (s.peak.enabled && s.peak.windows.length > 0) {
    children.push(
      { type: 'callout', text: { $: 'data.peakTitle' }, tone: 'info' },
      { type: 'keyValue', items: { $: 'data.peakRows' } },
    )
  }
  children.push(
    { type: 'chart', kind: 'bar', categories: { $: 'data.days' }, series: [{ name: zh ? '费用' : 'Cost', values: { $: 'data.costs' } }], caption: { $: 'data.chartCap' } },
    { type: 'text', text: zh ? '本会话 Token' : 'Session tokens' },
    { type: 'keyValue', items: { $: 'data.tokenRows' } },
    { type: 'text', text: zh ? '模型费用' : 'Cost by model' },
    { type: 'list', items: { $: 'data.modelRows' } },
    { type: 'text', text: { $: 'data.pricingLabel' }, tone: 'muted' },
    { type: 'text', text: { $: 'data.updated' }, tone: 'muted' },
    { type: 'actions', items: [
      { label: zh ? '刷新' : 'Refresh', action: 'refresh' },
      { label: zh ? '同步官方人民币价' : 'Sync CNY prices', action: 'sync-cny' },
    ] },
  )
  return { type: 'stack', title: zh ? '费用' : 'Costs', children }
}

// ── 插件 ──────────────────────────────────────────────────────────────────

function refreshFeeds(ctx, sessionId) {
  for (const id of ['turn-cost', 'billing']) {
    try { ctx.dshGo.refresh(id, { sessionId }) } catch { /* 面板没打开过时忽略 */ }
  }
}

export function apply(ctx) {
  ctx.inject(['dshGo'], (ctx) => {
    console.log(`[local-cost-meter] 已加载,账本:${ledgerFile()}`)
    try {
      const dir = join(home(), 'cache', 'local-cost-meter')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'loaded.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), ledger: ledgerFile() }))
    } catch { /* 只作诊断用途 */ }

    // 首次运行：自动把 dsh-cost-meter 切到「官方人民币价」并同步官方价表（只做一次）。
    const cnyTimer = setTimeout(() => { void ensureOfficialCnyOnce(ctx) }, 4_000)
    cnyTimer.unref?.()

    // 每条回复下面的本轮费用（与网页端 dsh-cost-meter 的 turnTail 同口径）。
    ctx.dshGo.turnNote('turn-cost', (scope, emit) => {
      const s = settings()
      let stopped = false
      const tick = async () => {
        if (stopped) return
        try {
          const out = {}
          // 首选：按轮 seq 区间重放计价，与网页端完全一致。
          const values = await turnCostMap(ctx, scope.sessionId, s)
          if (values) {
            for (const [turn, row] of values) {
              if (!row) continue
              out[String(turn)] = { text: money(basisAmount(converted(row, s, 'cost'), converted(row, s, 'apiCost'), s.basis), s) }
            }
          } else {
            // 回退：读不到服务或会话快照时，用账单的按轮汇总（仅主会话）。
            const session = await sessionStats(ctx, scope.sessionId, s)
            const turns = (session?.turns ?? []).slice(-MAX_NOTE_TURNS)
            for (const row of turns) {
              if (row?.turn === null || row?.turn === undefined) continue
              out[String(row.turn)] = { text: money(moneyOfRow(row, s), s) }
            }
          }
          if (stopped) return
          emit(out)
        } catch { /* 读不到时保留上一条脚注 */ }
      }
      tick()
      const timer = setInterval(tick, TICK_MS)
      return () => { stopped = true; clearInterval(timer) }
    })

    // 费用面板：输入框上方「费用」胶囊 / 对话详情「插件」页签 / 全部功能。
    ctx.dshGo.panel('billing', {
      view: (scope, caps) => buildView(caps?.locale),
      data: (scope, emit) => {
        let stopped = false
        const push = async () => {
          if (stopped) return
          try {
            const data = await panelData(ctx, scope.sessionId)
            if (!stopped) emit(data)
          } catch { /* 失败时保留上一份数据 */ }
        }
        push()
        const timer = setInterval(push, TICK_MS)
        return () => { stopped = true; clearInterval(timer) }
      },
      actions: {
        refresh: () => ({ refresh: true }),
        'sync-cny': (scope) => ({
          pending: { label: '同步官方价', timeoutMs: 60_000 },
          result: async () => {
            const synced = await syncOfficialCnyPricing(ctx)
            try {
              ctx.dshGo.refresh('billing', scope)
              ctx.dshGo.refresh('turn-cost', scope)
            } catch { /* 面板没打开时忽略 */ }
            return { toast: (synced.ok ? '已同步官方人民币价' : '官方价格同步失败，稍后再试').slice(0, 40) }
          },
        }),
      },
    })

    // 每轮结束或每步结束时即时刷新，手机端不用等 45 秒轮询。
    let lastRefresh = 0
    ctx.on('session/event', (session, event) => {
      const type = typeof event?.type === 'string' ? event.type : ''
      if (type !== 'turn/end' && type !== 'step/end' && type !== 'assistant/message') return
      const sessionId = typeof session?.id === 'string' ? session.id : session?.sessionId
      if (typeof sessionId !== 'string') return
      sessionCache.delete(sessionId)
      if (type === 'turn/end') turnCostCache.delete(sessionId)
      const now = Date.now()
      if (now - lastRefresh < REFRESH_GAP_MS) return
      lastRefresh = now
      refreshFeeds(ctx, sessionId)
    }, { global: true })
  })
}
