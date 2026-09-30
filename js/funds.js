const MFAPI = 'https://api.mfapi.in/mf'
const KUVERA = 'https://api.kuvera.in'
const DAY = 86400000
const STAMP_DUTY_FROM = '2020-07-01'
const STAMP_DUTY = 0.00005

async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`Fund data service returned ${res.status}`)
  return res.json()
}

const isoOf = text => {
  const [d, m, y] = text.split('-')
  return `${y}-${m}-${d}`
}
const isoFromNow = days => new Date(Date.now() + days * DAY).toISOString().slice(0, 10)

const rowsOf = body =>
  (Array.isArray(body?.data) ? body.data : [])
    .map(r => ({ date: isoOf(r.date), nav: parseFloat(r.nav) }))
    .filter(r => r.nav > 0)
    .sort((a, b) => a.date.localeCompare(b.date))

export async function searchFunds(query) {
  const list = await getJSON(`${MFAPI}/search?q=${encodeURIComponent(query)}`)
  const payout = name => /idcw|dividend|bonus/i.test(name)
  return (Array.isArray(list) ? list : [])
    .filter(f => /direct/i.test(f.schemeName))
    .sort((a, b) => Number(payout(a.schemeName)) - Number(payout(b.schemeName)))
    .map(f => ({ schemeCode: f.schemeCode, name: f.schemeName.replace(/\s+/g, ' ').trim() }))
}

export async function getFundInfo(schemeCode) {
  const body = await getJSON(`${MFAPI}/${schemeCode}/latest`)
  const meta = body?.meta ?? {}
  return {
    name: (meta.scheme_name ?? '').trim(),
    house: meta.fund_house ?? '',
    category: (meta.scheme_category ?? '').replace(/^.*Scheme - /, ''),
    isins: [meta.isin_growth, meta.isin_div_reinvestment].filter(Boolean),
  }
}

const histories = new Map()

export function navHistory(schemeCode) {
  if (!histories.has(schemeCode)) {
    const load = getJSON(`${MFAPI}/${schemeCode}`)
      .then(rowsOf)
      .catch(err => {
        histories.delete(schemeCode)
        throw err
      })
    histories.set(schemeCode, load)
  }
  return histories.get(schemeCode)
}

export function navOn(history, date) {
  let lo = 0
  let hi = history.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (history[mid].date < date) lo = mid + 1
    else hi = mid
  }
  return history[lo] ?? history[history.length - 1] ?? null
}

export function unitsFor(amount, nav, date) {
  const net = date >= STAMP_DUTY_FROM ? amount * (1 - STAMP_DUTY) : amount
  return Math.round((net / nav) * 1000) / 1000
}

export async function getNav(schemeCode) {
  let rows = rowsOf(await getJSON(`${MFAPI}/${schemeCode}?startDate=${isoFromNow(-21)}&endDate=${isoFromNow(1)}`))
  if (rows.length < 2) rows = (await navHistory(schemeCode)).slice(-2)
  if (!rows.length) throw new Error('No NAV data')
  const latest = rows[rows.length - 1]
  const prev = rows[rows.length - 2] ?? null
  const change = prev ? latest.nav - prev.nav : null
  return {
    nav: latest.nav,
    date: latest.date,
    prevNav: prev?.nav ?? null,
    change,
    changePct: prev ? (change / prev.nav) * 100 : null,
    stale: Date.now() - Date.parse(latest.date) > 10 * DAY,
  }
}

export async function getNavs(codes, onResult, concurrency = 4) {
  const queue = [...codes]
  const worker = async () => {
    while (queue.length) {
      const code = queue.shift()
      try {
        onResult(code, await getNav(code), null)
      } catch (err) {
        onResult(code, null, err)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
}

const PLAN_WORDS = /\b(direct|regular|growth|idcw|dividend|payout|reinvest(ment)?|bonus|option)\b/i

function searchTerms(name) {
  const parts = name.split(/\s+-\s+/)
  const kept = parts.filter((p, i) => i === 0 || !PLAN_WORDS.test(p))
  const tidy = text => text.replace(/\b(fund|plan)\b/gi, ' ').replace(/\s+/g, ' ').trim()
  return [...new Set([tidy(kept.join(' ')), tidy(parts[0])])].filter(Boolean)
}

const joinCodes = codes => codes.map(encodeURIComponent).join('%7C')

export async function findHoldingsCode(name, isins) {
  for (const term of searchTerms(name)) {
    const found = await getJSON(`${KUVERA}/insight/api/v1/mutual_fund_search.json?query=${encodeURIComponent(term)}`)
    const codes = (found?.data?.funds ?? []).map(f => f.unique_fund_code).filter(Boolean).slice(0, 20)
    if (!codes.length) continue
    const schemes = await getJSON(`${KUVERA}/mf/api/v5/fund_schemes/${joinCodes(codes)}.json`)
    const match = (Array.isArray(schemes) ? schemes : []).find(s => isins.includes(s.ISIN))
    if (match) return match.code
  }
  return null
}

export async function getHoldings(codes) {
  if (!codes.length) return {}
  const body = await getJSON(`${KUVERA}/mf/api/v5/fund_portfolio_holdings/${joinCodes(codes)}.json`)
  const out = {}
  for (const code of codes) {
    const rows = Array.isArray(body?.[code]) ? body[code] : []
    out[code] = {
      date: rows.reduce((d, r) => (r.portfolio_date > d ? r.portfolio_date : d), ''),
      items: rows.map(r => ({
        name: (r.company_name || r.security_name || '').trim(),
        isin: r.holding_isin || '',
        ticker: r.ticker || '',
        sector: r.sector_name || '',
        equity: /equity/i.test(r.security_asset_class || ''),
        pct: Number(r.percentage_to_aum) || 0,
      })),
    }
  }
  return out
}
