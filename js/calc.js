const DAY = 86400000
const YEAR = 365 * DAY

export const XIRR_MIN_DAYS = 365

export function todayISO(now = new Date()) {
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

export function daysSince(iso, now = Date.now()) {
  return Math.floor((now - Date.parse(iso)) / DAY)
}

export function xirr(flows) {
  if (flows.length < 2) return null
  const t0 = Math.min(...flows.map(f => f.t))
  const npv = r => flows.reduce((sum, f) => sum + f.v / Math.pow(1 + r, (f.t - t0) / YEAR), 0)
  let lo = -0.9999
  let hi = 1
  while (npv(hi) > 0 && hi < 1e6) hi *= 2
  if (npv(lo) < 0 || npv(hi) > 0) return null
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    if (npv(mid) > 0) lo = mid
    else hi = mid
    if (hi - lo < 1e-9) break
  }
  return (lo + hi) / 2
}

export function summarizeFund(fund, quote, now = Date.now()) {
  const lots = fund.lots
  const units = lots.reduce((sum, l) => sum + l.units, 0)
  const invested = lots.reduce((sum, l) => sum + l.amount, 0)
  const firstDate = lots.map(l => l.date).sort()[0] ?? null
  const days = firstDate ? daysSince(firstDate, now) : 0
  const nav = quote?.nav ?? null
  const current = nav == null ? null : units * nav
  const pnl = current == null ? null : current - invested
  const flows = lots.map(l => ({ t: Date.parse(l.date), v: -l.amount }))
  return {
    units,
    invested,
    avg: units ? invested / units : 0,
    firstDate,
    days,
    nav,
    current,
    value: current ?? invested,
    pnl,
    pnlPct: pnl == null || !invested ? null : (pnl / invested) * 100,
    dayPnl: quote?.change == null ? null : units * quote.change,
    dayPct: quote?.changePct ?? null,
    xirr: current != null && days >= XIRR_MIN_DAYS ? xirr([...flows, { t: now, v: current }]) : null,
    flows,
  }
}

export function summarizeFunds(funds, quotes, now = Date.now()) {
  const rows = funds.map(f => ({ f, s: summarizeFund(f, quotes.get(f.schemeCode), now) }))
  const priced = rows.filter(r => r.s.current != null)
  const invested = rows.reduce((sum, r) => sum + r.s.invested, 0)
  const current = rows.reduce((sum, r) => sum + r.s.value, 0)
  const withDay = rows.filter(r => r.s.dayPnl != null)
  const dayPnl = withDay.length ? withDay.reduce((sum, r) => sum + r.s.dayPnl, 0) : null
  const prevValue = withDay.reduce((sum, r) => sum + r.s.current - r.s.dayPnl, 0)
  const firstDate = rows.map(r => r.s.firstDate).filter(Boolean).sort()[0] ?? null
  const days = firstDate ? daysSince(firstDate, now) : 0
  const missing = rows.length - priced.length
  const pricedValue = priced.reduce((sum, r) => sum + r.s.current, 0)
  const annual =
    priced.length && !missing && days >= XIRR_MIN_DAYS
      ? xirr([...priced.flatMap(r => r.s.flows), { t: now, v: pricedValue }])
      : null
  for (const r of rows) r.s.weight = current ? (r.s.value / current) * 100 : null
  return {
    rows,
    invested,
    current,
    missing,
    pnl: current - invested,
    pnlPct: invested ? ((current - invested) / invested) * 100 : null,
    dayPnl,
    dayPct: dayPnl != null && prevValue ? (dayPnl / prevValue) * 100 : null,
    firstDate,
    days,
    xirr: annual,
  }
}

export function lookThrough(rows, holdings, top = 10) {
  const total = rows.reduce((sum, r) => sum + r.s.value, 0)
  const companies = new Map()
  const dates = []
  const uncovered = []
  for (const { f, s } of rows) {
    const h = f.kuvera ? holdings[f.kuvera] : null
    if (!h?.items.length) {
      uncovered.push({ fund: f, value: s.value })
      continue
    }
    if (h.date) dates.push(h.date)
    for (const item of h.items) {
      if (!item.equity || !(item.pct > 0)) continue
      const key = item.isin || item.name.toLowerCase()
      const amount = (s.value * item.pct) / 100
      const c = companies.get(key) ?? { key, name: item.name, ticker: item.ticker, sector: item.sector, amount: 0, via: [] }
      c.amount += amount
      c.via.push({ fund: f, amount, pct: item.pct })
      companies.set(key, c)
    }
  }
  const ranked = [...companies.values()].sort((a, b) => b.amount - a.amount)
  const leaders = ranked.slice(0, top).map(c => ({ ...c, share: total ? (c.amount / total) * 100 : 0, via: c.via.sort((a, b) => b.amount - a.amount) }))
  const othersAmount = Math.max(0, total - leaders.reduce((sum, c) => sum + c.amount, 0))
  dates.sort()
  return {
    total,
    leaders,
    others: {
      amount: othersAmount,
      share: total ? (othersAmount / total) * 100 : 0,
      companies: Math.max(0, ranked.length - leaders.length),
      uncoveredValue: uncovered.reduce((sum, u) => sum + u.value, 0),
    },
    uncovered,
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
  }
}
