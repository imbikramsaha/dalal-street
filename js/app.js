import { idleLockMinutes, refreshMinutes, topCompanies, maxSipInstalments } from './config.js'
import * as vault from './vault.js'
import * as gh from './github.js'
import { searchFunds, getFundInfo, findHoldingsCode, getHoldings, getNavs, getNav, navHistory, navOn, unitsFor } from './funds.js'
import { summarizeFund, summarizeFunds, lookThrough, todayISO, XIRR_MIN_DAYS } from './calc.js'
import { esc, money, signedMoney, pct, quantity, tone, dateLabel, heldFor } from './format.js'
import { icon } from './icons.js'

const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]
const uid = () => crypto.randomUUID()

const SESSION_KEY = '23th-street:session'

const session = {
  get(k) {
    try {
      return JSON.parse(sessionStorage.getItem(k))
    } catch {
      return null
    }
  },
  set(k, v) {
    try {
      sessionStorage.setItem(k, JSON.stringify(v))
    } catch {}
  },
  del(k) {
    try {
      sessionStorage.removeItem(k)
    } catch {}
  },
}

const state = {
  remote: null,
  keyInfo: null,
  data: null,
  baseRev: 0,
  baseFunds: '[]',
  token: null,
  unsynced: false,
  sync: 'idle',
  syncError: '',
  quotes: new Map(),
  quoteErrors: new Map(),
  holdings: {},
  holdingsError: false,
  refreshedAt: 0,
  loading: false,
  sort: { key: 'value', dir: -1 },
  expanded: null,
  gen: 0,
}

class ConflictError extends Error {}

function normalize(data) {
  return {
    ...data,
    rev: Number(data?.rev) || 0,
    funds: (Array.isArray(data?.funds) ? data.funds : []).map(f => ({ ...f, lots: Array.isArray(f.lots) ? f.lots : [] })),
  }
}

const snapshotFunds = () => JSON.stringify(state.data?.funds ?? [])

const PLAN_PART = /\b(direct|regular|growth|idcw|dividend|payout|reinvest(ment)?|bonus|option)\b/i

function shortName(name) {
  const parts = name.split(/\s+-\s+/)
  return parts.filter((p, i) => i === 0 || !PLAN_PART.test(p)).join(' - ').trim() || name
}

function planLabel(name) {
  const payout = /idcw|dividend/i.test(name)
  return `Direct · ${payout ? 'IDCW' : 'Growth'}`
}

function show(name) {
  for (const el of $$('.screen')) el.hidden = el.id !== `screen-${name}`
}

function busy(button, label) {
  button.dataset.label ??= button.textContent
  button.disabled = true
  button.textContent = label
  return () => {
    button.disabled = false
    button.textContent = button.dataset.label
  }
}

async function boot() {
  show('loading')
  $('#loading-text').textContent = 'Loading…'
  $('#loading-retry').hidden = true
  try {
    state.remote = await gh.readVault(null)
  } catch (err) {
    $('#loading-text').textContent = err.message
    $('#loading-retry').hidden = false
    return
  }
  if (!state.remote) return show('empty')
  const saved = session.get(SESSION_KEY)
  const kdf = state.remote.vault.kdf
  if (saved?.salt === kdf.salt) {
    try {
      const key = await vault.importKey(saved.key)
      const data = await vault.decrypt(key, state.remote.vault)
      return unlockWith({ key, kdf }, data)
    } catch {
      session.del(SESSION_KEY)
    }
  }
  showLock()
}

function showLock(note = '') {
  show('lock')
  $('#lock-note').textContent = note
  $('#lock-note').hidden = !note
  $('#lock-error').textContent = ''
  $('#lock-password').value = ''
  $('#lock-password').focus()
}

async function onLockSubmit(e) {
  e.preventDefault()
  const passphrase = $('#lock-password').value
  if (!passphrase) return
  const done = busy($('#lock-submit'), 'Unlocking…')
  $('#lock-error').textContent = ''
  try {
    try {
      state.remote = (await gh.readVault(null)) ?? state.remote
    } catch {}
    const kdf = state.remote.vault.kdf
    const key = await vault.deriveKey(passphrase, kdf)
    let data
    try {
      data = await vault.decrypt(key, state.remote.vault)
    } catch {
      throw new Error("That passphrase isn't right.")
    }
    await unlockWith({ key, kdf }, data)
  } catch (err) {
    $('#lock-error').textContent = err.message
    $('#lock-password').select()
  } finally {
    done()
  }
}

async function unlockWith(keyInfo, data) {
  state.keyInfo = keyInfo
  state.data = normalize(data)
  state.baseRev = state.data.rev
  state.baseFunds = snapshotFunds()
  state.token = state.data.github?.token ?? null
  state.unsynced = false
  state.sync = 'idle'
  session.set(SESSION_KEY, { salt: keyInfo.kdf.salt, key: await vault.exportKey(keyInfo.key) })
  show('main')
  lastActivity = Date.now()
  render()
  armTimers()
  refreshAll()
}

function lock(note) {
  state.gen++
  Object.assign(state, { keyInfo: null, data: null, token: null, unsynced: false, sync: 'idle', refreshedAt: 0, loading: false, holdings: {}, expanded: null })
  state.quotes.clear()
  state.quoteErrors.clear()
  session.del(SESSION_KEY)
  disarmTimers()
  hideTip()
  for (const d of $$('dialog')) {
    if (d.open) d.close()
    d.innerHTML = ''
  }
  for (const id of ['#summary', '#breakdown', '#funds']) $(id).innerHTML = ''
  $('#breakdown-panel').hidden = true
  showLock(note)
}

let saveChain = Promise.resolve()
let saveQueued = false

function persist() {
  state.data.updatedAt = new Date().toISOString()
  state.unsynced = true
  render()
  if (!state.token) {
    toast('Connect GitHub on 23th Street first, so changes can be saved.', 'warn', 7000)
    return
  }
  queueSave()
}

function queueSave() {
  if (saveQueued) return saveChain
  saveQueued = true
  saveChain = saveChain.then(() => {
    saveQueued = false
    return runSave()
  })
  return saveChain
}

async function runSave() {
  if (!state.token || !state.keyInfo) return
  const gen = state.gen
  state.sync = 'saving'
  renderSync()
  try {
    await saveOnce()
    if (gen !== state.gen) return
    state.sync = 'saved'
    state.unsynced = saveQueued
  } catch (err) {
    if (gen !== state.gen) return
    if (err instanceof ConflictError) {
      state.sync = 'saved'
      state.unsynced = false
      toast(err.message, 'warn', 8000)
    } else {
      state.sync = 'error'
      state.syncError = err.message
      toast(err.message, 'bad', 8000)
    }
  } finally {
    if (gen === state.gen) renderSync()
  }
}

async function saveOnce() {
  const remote = await gh.readVault(state.token, { fallback: false })
  if (remote) {
    let remoteData
    try {
      remoteData = normalize(await vault.decrypt(state.keyInfo.key, remote.vault))
    } catch {
      throw new Error('The vault on GitHub now uses a different passphrase. Lock, then unlock with the new one.')
    }
    if (remoteData.rev !== state.baseRev) {
      if (JSON.stringify(remoteData.funds) !== state.baseFunds) {
        adoptRemote(remote, remoteData)
        throw new ConflictError('Your funds were changed on another device. The latest version is loaded, so please redo your last change.')
      }
      state.data = { ...remoteData, funds: state.data.funds, updatedAt: state.data.updatedAt }
      state.baseRev = remoteData.rev
      state.token = remoteData.github?.token ?? state.token
    }
  }
  const next = { ...state.data, rev: state.baseRev + 1 }
  const sealed = await vault.seal(state.keyInfo, next)
  const sha = await gh.writeVault(state.token, sealed)
  state.remote = { vault: sealed, sha }
  state.baseRev = next.rev
  state.data.rev = next.rev
  state.baseFunds = JSON.stringify(next.funds)
}

function adoptRemote(remote, data) {
  state.remote = remote
  state.data = data
  state.token = data.github?.token ?? state.token
  state.baseRev = data.rev
  state.baseFunds = snapshotFunds()
  for (const d of ['#dlg-add', '#dlg-fund']) if ($(d).open) $(d).close()
  render()
  refreshAll()
}

async function refreshAll() {
  if (!state.data || state.loading) return
  const funds = state.data.funds
  if (!funds.length) return renderStatus()
  const gen = state.gen
  state.loading = true
  renderStatus()
  const codes = [...new Set(funds.map(f => f.kuvera).filter(Boolean))]
  const holdings = getHoldings(codes).then(
    h => ({ h, ok: true }),
    () => ({ h: {}, ok: false }),
  )
  await getNavs([...new Set(funds.map(f => f.schemeCode))], (code, quote, err) => {
    if (gen !== state.gen) return
    if (quote) {
      state.quotes.set(code, quote)
      state.quoteErrors.delete(code)
    } else state.quoteErrors.set(code, err)
  })
  const { h, ok } = await holdings
  if (gen !== state.gen) return
  if (ok) state.holdings = { ...state.holdings, ...h }
  state.holdingsError = !ok
  state.loading = false
  state.refreshedAt = Date.now()
  render()
  if ($('#dlg-fund').open && !$('#dlg-fund [data-editing]')) renderFund()
}

async function refreshOne(fund) {
  const gen = state.gen
  try {
    const [quote, h] = await Promise.all([getNav(fund.schemeCode), fund.kuvera ? getHoldings([fund.kuvera]) : {}])
    if (gen !== state.gen) return
    state.quotes.set(fund.schemeCode, quote)
    state.quoteErrors.delete(fund.schemeCode)
    state.holdings = { ...state.holdings, ...h }
  } catch (err) {
    if (gen === state.gen) state.quoteErrors.set(fund.schemeCode, err)
  }
  if (gen === state.gen) render()
}

function render() {
  if (!state.data) return
  const p = summarizeFunds(state.data.funds, state.quotes)
  renderSummary(p)
  renderBreakdown(p)
  renderFunds(p)
  renderStatus()
  renderSync()
}

function stat(label, value, sub, { valueTone = '', subTone = '', cls = '' } = {}) {
  return `<div class="stat ${cls}">
    <div class="stat-label">${esc(label)}</div>
    <div class="stat-value ${valueTone}">${esc(value)}</div>
    <div class="stat-sub ${subTone}">${esc(sub)}</div>
  </div>`
}

function renderSummary(p) {
  const el = $('#summary')
  el.hidden = !p.rows.length
  if (!p.rows.length) return (el.innerHTML = '')
  const waiting = p.missing === p.rows.length
  const note = p.missing && !waiting ? ` · ${p.missing} at cost, no NAV` : ''
  let xirrSub
  if (p.xirr != null) xirrSub = `Annualised since ${dateLabel(p.firstDate)}`
  else if (p.days < XIRR_MIN_DAYS) xirrSub = 'Shows once your first investment is a year old'
  else xirrSub = 'Needs a NAV for every fund'
  el.innerHTML = [
    stat('Current value', waiting ? '—' : money(p.current), `Invested ${money(p.invested)}${note}`, { cls: 'stat-hero' }),
    stat('Total returns', waiting ? '—' : signedMoney(p.pnl), waiting ? 'Waiting for NAVs' : pct(p.pnlPct), {
      valueTone: waiting ? '' : tone(p.pnl),
      subTone: waiting ? '' : tone(p.pnl),
    }),
    stat('1-day change', signedMoney(p.dayPnl), p.dayPct == null ? 'Waiting for NAVs' : pct(p.dayPct), { valueTone: tone(p.dayPnl), subTone: tone(p.dayPnl) }),
    stat('XIRR', p.xirr == null ? '—' : pct(p.xirr * 100), xirrSub, { valueTone: tone(p.xirr) }),
  ].join('')
}

function viaText(c, limit = 2) {
  const names = c.via.slice(0, limit).map(v => shortName(v.fund.name))
  const more = c.via.length - limit
  return `via ${names.join(', ')}${more > 0 ? ` +${more} more` : ''}`
}

function viaList(c) {
  return `<ul class="via-list">${c.via
    .map(v => `<li><span>${esc(shortName(v.fund.name))}</span><span>${money(v.amount)} · ${v.pct.toFixed(2)}% of fund</span></li>`)
    .join('')}</ul>`
}

function renderBreakdown(p) {
  const panel = $('#breakdown-panel')
  const el = $('#breakdown')
  const ready = p.rows.length && p.missing < p.rows.length
  const bd = ready ? lookThrough(p.rows, state.holdings, topCompanies) : null
  panel.hidden = !p.rows.length
  if (!p.rows.length) return
  if (!bd?.leaders.length) {
    breakdownCache = null
    $('#breakdown-date').textContent = ''
    el.innerHTML = `<p class="bd-empty muted">${
      state.loading || !ready ? 'Loading fund holdings…' : state.holdingsError ? "Couldn't load fund holdings. Refresh to try again." : 'None of your funds has holdings data yet.'
    }</p>`
    return
  }
  $('#breakdown-date').textContent = bd.from ? `Holdings as of ${dateLabel(bd.from)}${bd.to && bd.to !== bd.from ? ` to ${dateLabel(bd.to)}` : ''}` : ''
  const max = Math.max(...bd.leaders.map(c => c.amount))
  const width = amount => `${max ? Math.max(0.6, (amount / max) * 100) : 0}%`
  const rows = bd.leaders
    .map(
      (c, i) => `<li class="bd-row${state.expanded === c.key ? ' open' : ''}">
      <button type="button" class="bd-main" data-company="${esc(c.key)}" aria-expanded="${state.expanded === c.key}">
        <span class="bd-rank">${i + 1}</span>
        <span class="bd-name"><span class="co-name">${esc(c.name)}</span><span class="co-meta">${esc([/^\d+$/.test(c.ticker) ? '' : c.ticker, c.sector].filter(Boolean).join(' · '))}</span></span>
        <span class="bd-bar" aria-hidden="true"><span class="bd-fill" data-width="${width(c.amount)}"></span></span>
        <span class="bd-amount">${money(c.amount)}</span>
        <span class="bd-share">${c.share.toFixed(1)}%</span>
      </button>
      <div class="bd-detail" ${state.expanded === c.key ? '' : 'hidden'}>${viaList(c)}</div>
    </li>`,
    )
    .join('')
  const o = bd.others
  const otherNote = [
    `${o.companies ? `${o.companies} more ${o.companies === 1 ? 'company' : 'companies'} plus` : 'Plus'} cash, debt and other assets`,
    o.uncoveredValue ? `${money(o.uncoveredValue)} from funds without holdings data` : '',
  ].filter(Boolean)
  el.innerHTML = `<ol class="bd-list">${rows}
    <li class="bd-row bd-others">
      <div class="bd-main">
        <span class="bd-rank">11</span>
        <span class="bd-name"><span class="co-name">Others</span><span class="co-meta">${esc(otherNote.join(' · '))}</span></span>
        <span class="bd-bar" aria-hidden="true"></span>
        <span class="bd-amount">${money(o.amount)}</span>
        <span class="bd-share">${o.share.toFixed(1)}%</span>
      </div>
    </li>
  </ol>
  <p class="bd-total muted small"><span>Total across ${p.rows.length} fund${p.rows.length > 1 ? 's' : ''}</span><span>${money(bd.total)} · 100%</span></p>`
  for (const fill of $$('.bd-fill', el)) fill.style.width = fill.dataset.width
  breakdownCache = bd
}

let breakdownCache = null

const COLUMNS = [
  { key: 'name', label: 'Fund' },
  { key: 'units', label: 'Units' },
  { key: 'avg', label: 'Avg NAV' },
  { key: 'dayPct', label: 'NAV' },
  { key: 'invested', label: 'Invested' },
  { key: 'value', label: 'Current' },
  { key: 'pnlPct', label: 'Returns' },
  { key: 'xirr', label: 'XIRR' },
  { key: 'weight', label: 'Weight' },
]

function sortRows(rows) {
  const { key, dir } = state.sort
  const value = r => (key === 'name' ? shortName(r.f.name).toLowerCase() : r.s[key])
  return [...rows].sort((a, b) => {
    const x = value(a)
    const y = value(b)
    if (x == null && y == null) return 0
    if (x == null) return 1
    if (y == null) return -1
    return (x < y ? -1 : x > y ? 1 : 0) * dir
  })
}

function navCell(f, s) {
  const q = state.quotes.get(f.schemeCode)
  if (!q) return state.quoteErrors.has(f.schemeCode) ? '<span class="muted">No NAV</span>' : '<span class="muted">…</span>'
  const sub = q.stale ? `<div class="cell-sub muted">Last ${dateLabel(q.date)}</div>` : `<div class="cell-sub ${tone(s.dayPct)}">${pct(s.dayPct)}</div>`
  return `${money(s.nav)}${sub}`
}

function xirrCell(s) {
  if (s.xirr != null) return pct(s.xirr * 100)
  const title = s.days < XIRR_MIN_DAYS ? 'Shows once this fund is a year old' : 'Needs a NAV'
  return `<span class="muted" title="${title}">—</span>`
}

function renderFunds(p) {
  $('#fund-count').textContent = p.rows.length || ''
  const el = $('#funds')
  if (!p.rows.length) {
    el.innerHTML = `<div class="empty">
      <div class="empty-icon">${icon('empty', 28)}</div>
      <h3>No funds yet</h3>
      <p class="muted">Add your mutual funds and index funds with the dates and amounts you invested. SIPs can be added in one go.</p>
      <button class="btn btn-primary" type="button" data-action="add">${icon('plus')}Add fund</button>
    </div>`
    return
  }
  const rows = sortRows(p.rows)
  const { key, dir } = state.sort
  const head = COLUMNS.map(c => {
    const active = c.key === key
    const aria = active ? (dir > 0 ? 'ascending' : 'descending') : 'none'
    return `<th aria-sort="${aria}"><button type="button" data-sort="${c.key}" class="${active ? 'sorted' : ''}">${c.label}<span class="arrow">${active ? (dir > 0 ? '↑' : '↓') : ''}</span></button></th>`
  }).join('')
  const noHoldings = f => (f.kuvera ? '' : ' · <span title="Not included in the company breakdown">no holdings data</span>')
  const body = rows
    .map(
      ({ f, s }) => `<tr data-id="${esc(f.id)}" tabindex="0">
      <td><div class="co-name">${esc(shortName(f.name))}</div><div class="co-meta">${esc(planLabel(f.name))}${noHoldings(f)}</div></td>
      <td>${quantity(s.units)}</td>
      <td>${money(s.avg)}</td>
      <td>${navCell(f, s)}</td>
      <td>${money(s.invested)}</td>
      <td>${money(s.current)}</td>
      <td class="${tone(s.pnl)}">${signedMoney(s.pnl)}<div class="cell-sub">${pct(s.pnlPct)}</div></td>
      <td class="${tone(s.xirr)}">${xirrCell(s)}</td>
      <td>${s.weight == null ? '—' : `${s.weight.toFixed(1)}%`}</td>
    </tr>`,
    )
    .join('')
  const cards = rows
    .map(
      ({ f, s }) => `<li><button type="button" class="hcard" data-id="${esc(f.id)}">
      <span class="hcard-row"><span class="co-name">${esc(shortName(f.name))}</span><span class="hcard-value">${money(s.value)}</span></span>
      <span class="hcard-row co-meta"><span>${quantity(s.units)} units · avg ${money(s.avg)}</span><span class="${tone(s.pnl)}">${signedMoney(s.pnl)} (${pct(s.pnlPct)})</span></span>
      <span class="hcard-row co-meta"><span>NAV ${money(s.nav)} <span class="${tone(s.dayPct)}">${pct(s.dayPct)}</span></span><span>${s.xirr == null ? '' : `XIRR <span class="${tone(s.xirr)}">${pct(s.xirr * 100)}</span>`}</span></span>
    </button></li>`,
    )
    .join('')
  el.innerHTML = `<div class="table-wrap holdings-wrap"><table class="holdings-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div><ul class="hcards">${cards}</ul>`
}

function renderStatus() {
  const el = $('#price-status')
  $('#btn-refresh').classList.toggle('spinning', state.loading)
  if (!state.data?.funds.length) return (el.textContent = '')
  if (state.loading && !state.refreshedAt) return (el.textContent = 'Fetching NAVs…')
  const dates = [...state.quotes.values()].filter(q => !q.stale).map(q => q.date).sort()
  const parts = []
  if (dates.length) parts.push(`NAV as of ${dateLabel(dates[dates.length - 1])}`)
  const failed = state.data.funds.filter(f => state.quoteErrors.has(f.schemeCode)).length
  if (failed) parts.push(`${failed} NAV${failed > 1 ? 's' : ''} unavailable`)
  el.textContent = parts.join(' · ')
}

function renderSync() {
  const pill = $('#sync-pill')
  let label = 'Saved'
  let cls = 'ok'
  let title = 'Encrypted and saved to GitHub'
  if (state.sync === 'saving') [label, cls, title] = ['Saving…', 'busy', 'Saving to GitHub']
  else if (!state.token) [label, cls, title] = [state.unsynced ? 'Not saved' : 'Read-only', state.unsynced ? 'bad' : 'idle', 'Connect GitHub on 23th Street to save changes']
  else if (state.sync === 'error') [label, cls, title] = ['Not saved · retry', 'bad', state.syncError]
  else if (state.unsynced) [label, cls] = ['Not saved', 'bad']
  pill.className = `sync-pill ${cls}`
  pill.title = title
  pill.innerHTML = `<span class="dot"></span>${esc(label)}`
}

function showTip(target, c) {
  const tip = $('#viz-tip')
  tip.innerHTML = `<div class="viz-tip-title">${esc(c.name)}</div><div class="viz-tip-sub">${money(c.amount)} · ${c.share.toFixed(1)}% of your fund money</div>${viaList(c)}`
  tip.hidden = false
  const r = target.getBoundingClientRect()
  const w = tip.offsetWidth
  const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8)
  const below = r.bottom + 8 + tip.offsetHeight < window.innerHeight
  tip.style.left = `${left}px`
  tip.style.top = `${below ? r.bottom + 8 : r.top - tip.offsetHeight - 8}px`
}

function hideTip() {
  $('#viz-tip').hidden = true
}

const picker = { selected: null, results: [], active: -1, seq: 0, timer: 0, history: null, info: null }

function lotRowHTML(lot = {}) {
  return `<div class="lot-row lot-row-fund" data-lot>
    <label class="field lot-date"><span>Date</span><input type="date" name="date" max="${todayISO()}" value="${esc(lot.date ?? '')}"></label>
    <label class="field"><span>Amount (₹)</span><input type="number" name="amount" min="0" step="any" inputmode="decimal" placeholder="0" value="${esc(lot.amount ?? '')}"></label>
    <label class="field"><span>Units</span><input type="number" name="units" min="0" step="any" inputmode="decimal" placeholder="auto" value="${esc(lot.units ?? '')}" data-auto="${lot.units ? '0' : '1'}"></label>
    <button type="button" class="icon-btn lot-remove" data-action="remove-lot" aria-label="Remove this investment" title="Remove">${icon('close', 16)}</button>
    <span class="lot-nav muted" data-nav></span>
  </div>`
}

function openAdd() {
  Object.assign(picker, { selected: null, results: [], active: -1, history: null, info: null })
  const dlg = $('#dlg-add')
  dlg.innerHTML = `<form class="dlg" id="add-form" novalidate>
    <div class="dlg-head">
      <div><h3>Add fund</h3><p class="muted small">Find the fund (Direct plans), then enter each investment.</p></div>
      <button type="button" class="icon-btn" data-action="close" aria-label="Close">${icon('close')}</button>
    </div>
    <div class="dlg-body">
      <div class="field"><span>Fund</span><div id="add-company"></div></div>
      <div class="field">
        <span>Investments</span>
        <div class="lots" id="add-lots">${lotRowHTML()}</div>
        <div class="lots-actions">
          <button type="button" class="btn btn-sm" data-action="add-lot">${icon('plus', 16)}Another investment</button>
          <button type="button" class="btn btn-sm" data-action="sip">${icon('plus', 16)}Monthly SIP</button>
        </div>
        <div class="sip-form" id="sip-form" hidden>
          <label class="field"><span>Monthly amount (₹)</span><input type="number" name="sip-amount" min="0" step="any" inputmode="decimal"></label>
          <label class="field"><span>First instalment</span><input type="date" name="sip-start" max="${todayISO()}"></label>
          <label class="field"><span>Last instalment</span><input type="date" name="sip-end" max="${todayISO()}" value="${todayISO()}"></label>
          <button type="button" class="btn btn-sm btn-primary" data-action="sip-generate">Add instalments</button>
        </div>
        <p class="hint">Leave Units blank and they're worked out from that day's NAV. Replace them with your statement's figures if they differ. Only know your totals? Enter one row with your first investment date, total amount and total units.</p>
      </div>
      <div class="add-total" id="add-total"></div>
      <p class="form-error" id="add-error" role="alert"></p>
    </div>
    <div class="dlg-foot">
      <button type="button" class="btn" data-action="close">Cancel</button>
      <button type="submit" class="btn btn-primary">Add fund</button>
    </div>
  </form>`
  renderPicker()
  updateAddTotal()
  dlg.showModal()
  $('#add-search')?.focus()
}

function renderPicker() {
  const el = $('#add-company')
  const sel = picker.selected
  if (sel) {
    const held = state.data.funds.find(f => f.schemeCode === sel.schemeCode)
    const status = sel.resolving
      ? 'Looking up this fund…'
      : sel.kuvera
        ? 'Holdings found: it will be included in the company breakdown.'
        : "Holdings data isn't available for this fund, so it will count under Others in the breakdown."
    el.innerHTML = `<div class="picked">
        <div><div class="co-name">${esc(shortName(sel.name))}</div><div class="co-meta">${esc(planLabel(sel.name))}${sel.category ? ` · ${esc(sel.category)}` : ''}</div></div>
        <button type="button" class="btn btn-sm" data-action="change-company">Change</button>
      </div>
      <p class="hint">${esc(status)}</p>
      ${held ? '<p class="hint">You already hold this. These investments will be added to it.</p>' : ''}`
    return
  }
  el.innerHTML = `<div class="search">
      ${icon('search', 16)}
      <input id="add-search" type="search" placeholder="Search e.g. Parag Parikh Flexi Cap, Nifty 50 Index" autocomplete="off" spellcheck="false"
        role="combobox" aria-expanded="false" aria-controls="add-results" aria-autocomplete="list">
    </div>
    <div id="add-results" class="suggest" role="listbox" hidden></div>`
}

function renderResults(status) {
  const box = $('#add-results')
  const input = $('#add-search')
  if (!box) return
  let html = ''
  if (status === 'loading') html = '<div class="suggest-note">Searching…</div>'
  else if (status === 'error') html = '<div class="suggest-note">Search is unavailable right now. Try again in a moment.</div>'
  else if (status === 'none') html = '<div class="suggest-note">No Direct plan matches that. Try fewer words, like the fund house and fund name.</div>'
  else
    html = picker.results
      .map(
        (r, i) => `<button type="button" role="option" class="suggest-item" data-index="${i}" aria-selected="${i === picker.active}">
        <span><span class="co-name">${esc(shortName(r.name))}</span><span class="co-meta">${esc(r.name)}</span></span>
        <span class="badge">${/idcw|dividend/i.test(r.name) ? 'IDCW' : 'GROWTH'}</span>
      </button>`,
      )
      .join('')
  box.innerHTML = html
  box.hidden = !html
  input?.setAttribute('aria-expanded', String(!box.hidden))
}

function onSearchInput(value) {
  clearTimeout(picker.timer)
  const q = value.trim()
  if (q.length < 3) {
    picker.results = []
    renderResults()
    return
  }
  picker.timer = setTimeout(async () => {
    const seq = ++picker.seq
    renderResults('loading')
    try {
      const results = (await searchFunds(q)).slice(0, 15)
      if (seq !== picker.seq) return
      picker.results = results
      picker.active = results.length ? 0 : -1
      renderResults(results.length ? undefined : 'none')
    } catch {
      if (seq === picker.seq) renderResults('error')
    }
  }, 300)
}

async function pickResult(index) {
  const r = picker.results[index]
  if (!r) return
  const seq = ++picker.seq
  picker.selected = { ...r, resolving: true, kuvera: null, isins: [], category: '' }
  picker.history = navHistory(r.schemeCode)
  picker.history.catch(() => {})
  renderPicker()
  $('#add-lots [name=date]')?.focus()
  try {
    const info = await getFundInfo(r.schemeCode)
    const kuvera = await findHoldingsCode(info.name || r.name, info.isins).catch(() => null)
    if (seq !== picker.seq) return
    picker.selected = { ...r, name: info.name || r.name, isin: info.isins[0] ?? '', category: info.category, kuvera, resolving: false }
  } catch {
    if (seq !== picker.seq) return
    picker.selected = { ...picker.selected, resolving: false }
  }
  renderPicker()
  fillUnits()
}

function readLot(row) {
  return {
    date: $('[name=date]', row).value,
    amount: parseFloat($('[name=amount]', row).value),
    units: parseFloat($('[name=units]', row).value),
  }
}

async function fillUnits(onlyRow) {
  if (!picker.history) return
  let history
  try {
    history = await picker.history
  } catch {
    return
  }
  for (const row of onlyRow ? [onlyRow] : $$('#add-lots [data-lot]')) {
    const units = $('[name=units]', row)
    const lot = readLot(row)
    const hint = $('[data-nav]', row)
    if (!lot.date || !(lot.amount > 0) || !history.length) {
      if (hint) hint.textContent = ''
      continue
    }
    const point = navOn(history, lot.date)
    if (!point) continue
    if (hint) hint.textContent = lot.date < history[0].date ? 'This date is before the fund started.' : `NAV ${money(point.nav)} on ${dateLabel(point.date)}`
    if (units.dataset.auto !== '0') units.value = unitsFor(lot.amount, point.nav, point.date)
  }
  updateAddTotal()
}

function lotError(lot) {
  if (!lot.date || Number.isNaN(Date.parse(lot.date))) return 'Enter the date you invested.'
  if (lot.date > todayISO()) return "The date can't be in the future."
  if (!(lot.amount > 0)) return 'Amount must be more than zero.'
  if (!(lot.units > 0)) return 'Units are missing. Enter them, or wait a moment for them to be worked out.'
  return ''
}

function updateAddTotal() {
  const el = $('#add-total')
  if (!el) return
  const lots = $$('#add-lots [data-lot]').map(readLot).filter(l => l.amount > 0)
  const invested = lots.reduce((s, l) => s + l.amount, 0)
  const units = lots.filter(l => l.units > 0).reduce((s, l) => s + l.units, 0)
  el.innerHTML = invested
    ? `<span>${lots.length} investment${lots.length > 1 ? 's' : ''}</span><span>Invested ${money(invested)}</span>${units ? `<span>${quantity(units)} units</span><span>Avg NAV ${money(invested / units)}</span>` : ''}`
    : ''
}

function sipDates(start, end, limit) {
  const [y, m, d] = start.split('-').map(Number)
  const out = []
  for (let i = 0; out.length < limit; i++) {
    const last = new Date(Date.UTC(y, m - 1 + i + 1, 0)).getUTCDate()
    const date = new Date(Date.UTC(y, m - 1 + i, Math.min(d, last))).toISOString().slice(0, 10)
    if (date > end) break
    out.push(date)
  }
  return out
}

async function onSipGenerate() {
  const form = $('#sip-form')
  const error = $('#add-error')
  const amount = parseFloat($('[name=sip-amount]', form).value)
  const start = $('[name=sip-start]', form).value
  const end = $('[name=sip-end]', form).value || todayISO()
  if (!picker.selected) return (error.textContent = 'Pick the fund first.')
  if (!(amount > 0)) return (error.textContent = 'Enter the monthly SIP amount.')
  if (!start) return (error.textContent = 'Enter the date of the first instalment.')
  if (end < start) return (error.textContent = "The last instalment can't be before the first.")
  error.textContent = ''
  const dates = sipDates(start, end > todayISO() ? todayISO() : end, maxSipInstalments)
  const list = $('#add-lots')
  for (const row of $$('[data-lot]', list)) if (!readLot(row).amount && !$('[name=date]', row).value) row.remove()
  list.insertAdjacentHTML('beforeend', dates.map(date => lotRowHTML({ date, amount })).join(''))
  form.hidden = true
  await fillUnits()
  toast(`Added ${dates.length} monthly instalment${dates.length > 1 ? 's' : ''}. Check them before saving.`, 'ok')
}

function onAddSubmit(e) {
  e.preventDefault()
  const error = $('#add-error')
  const sel = picker.selected
  if (!sel) return (error.textContent = 'Pick a fund from the search results.')
  if (sel.resolving) return (error.textContent = 'Still looking up this fund. Try again in a second.')
  const lots = $$('#add-lots [data-lot]').map(readLot)
  const problem = lots.map(lotError).find(Boolean)
  if (problem) return (error.textContent = problem)
  const newLots = lots.map(l => ({ id: uid(), date: l.date, amount: l.amount, units: l.units }))
  const existing = state.data.funds.find(f => f.schemeCode === sel.schemeCode)
  if (existing) existing.lots.push(...newLots)
  else
    state.data.funds.push({
      id: uid(),
      name: sel.name,
      schemeCode: sel.schemeCode,
      isin: sel.isin ?? '',
      kuvera: sel.kuvera ?? null,
      lots: newLots,
      addedAt: new Date().toISOString(),
    })
  $('#dlg-add').close()
  toast(existing ? `Added ${newLots.length} investment${newLots.length > 1 ? 's' : ''} to ${shortName(sel.name)}` : `Added ${shortName(sel.name)}`, 'ok')
  persist()
  refreshOne(existing ?? state.data.funds[state.data.funds.length - 1])
}

let openFundId = null
let editingLot = null

function openFund(id) {
  openFundId = id
  editingLot = null
  renderFund()
  $('#dlg-fund').showModal()
  $('#dlg-fund .dlg-body').scrollTop = 0
}

function kv(label, value, cls = '') {
  return `<div class="kv"><div class="kv-label">${esc(label)}</div><div class="kv-value ${cls}">${value}</div></div>`
}

function lotEditRow(lot) {
  return `<tr data-editing data-lot>
    <td><input type="date" name="date" max="${todayISO()}" value="${esc(lot.date ?? '')}" aria-label="Date"></td>
    <td><input type="number" name="amount" min="0" step="any" inputmode="decimal" value="${esc(lot.amount ?? '')}" aria-label="Amount"></td>
    <td><input type="number" name="units" min="0" step="any" inputmode="decimal" value="${esc(lot.units ?? '')}" placeholder="auto" aria-label="Units"></td>
    <td colspan="3" class="lot-edit-error form-error"></td>
    <td class="row-actions">
      <button type="button" class="icon-btn" data-action="save-lot" aria-label="Save investment" title="Save">${icon('check', 16)}</button>
      <button type="button" class="icon-btn" data-action="cancel-lot" aria-label="Cancel" title="Cancel">${icon('close', 16)}</button>
    </td>
  </tr>`
}

function renderFund() {
  const dlg = $('#dlg-fund')
  const f = state.data?.funds.find(x => x.id === openFundId)
  if (!f) {
    if (dlg.open) dlg.close()
    return
  }
  const q = state.quotes.get(f.schemeCode)
  const s = summarizeFund(f, q)
  const lots = [...f.lots].sort((a, b) => b.date.localeCompare(a.date))
  const rows = lots
    .map(l => {
      if (l.id === editingLot) return lotEditRow(l)
      const value = q ? l.units * q.nav : null
      const ret = value == null ? null : ((value - l.amount) / l.amount) * 100
      return `<tr>
        <td>${dateLabel(l.date)}</td>
        <td>${money(l.amount)}</td>
        <td>${quantity(l.units)}</td>
        <td>${money(l.amount / l.units)}</td>
        <td>${money(value)}</td>
        <td class="${tone(ret)}">${pct(ret)}</td>
        <td class="row-actions">
          <button type="button" class="icon-btn" data-action="edit-lot" data-lot-id="${esc(l.id)}" aria-label="Edit investment" title="Edit">${icon('edit', 16)}</button>
          <button type="button" class="icon-btn" data-action="delete-lot" data-lot-id="${esc(l.id)}" aria-label="Delete investment" title="Delete">${icon('trash', 16)}</button>
        </td>
      </tr>`
    })
    .join('')
  const h = f.kuvera ? state.holdings[f.kuvera] : null
  const top = h ? h.items.filter(i => i.equity && i.pct > 0).sort((a, b) => b.pct - a.pct).slice(0, 10) : []
  const holdingsHTML = top.length
    ? `<div>
        <div class="section-head"><h4>Top holdings of this fund</h4><span class="muted small">As of ${dateLabel(h.date)}</span></div>
        <ol class="fund-holdings">${top
          .map(i => `<li><span>${esc(i.name)}</span><span>${i.pct.toFixed(2)}% · ${money((s.value * i.pct) / 100)}</span></li>`)
          .join('')}</ol>
      </div>`
    : `<p class="hint">${f.kuvera ? 'Holdings are loading or unavailable right now.' : "Holdings data isn't available for this fund, so it counts under Others in the breakdown."}</p>`
  const nav = q ? ` · NAV ${money(q.nav)} <span class="${tone(q.changePct)}">${pct(q.changePct)}</span> on ${dateLabel(q.date)}` : ''
  dlg.innerHTML = `<div class="dlg">
    <div class="dlg-head">
      <div><h3>${esc(shortName(f.name))}</h3><p class="co-meta">${esc(planLabel(f.name))}${nav}</p></div>
      <button type="button" class="icon-btn" data-action="close" aria-label="Close">${icon('close')}</button>
    </div>
    <div class="dlg-body">
      <div class="kv-grid">
        ${kv('Units', quantity(s.units))}
        ${kv('Avg NAV', money(s.avg))}
        ${kv('Invested', money(s.invested))}
        ${kv('Current value', money(s.current))}
        ${kv('Returns', `${signedMoney(s.pnl)} <span class="kv-sub">${pct(s.pnlPct)}</span>`, tone(s.pnl))}
        ${kv('XIRR', xirrCell(s), tone(s.xirr))}
        ${kv('First invested', dateLabel(s.firstDate))}
        ${kv('Held for', heldFor(s.firstDate))}
      </div>
      ${holdingsHTML}
      <div>
        <div class="section-head"><h4>Investments <span class="count">${f.lots.length}</span></h4>
          <button type="button" class="btn btn-sm" data-action="new-lot" ${editingLot ? 'disabled' : ''}>${icon('plus', 16)}Add investment</button>
        </div>
        <div class="table-wrap lots-scroll">
          <table class="lots-table">
            <thead><tr><th>Date</th><th>Amount</th><th>Units</th><th>NAV</th><th>Value now</th><th>Return</th><th></th></tr></thead>
            <tbody>${editingLot === 'new' ? lotEditRow({}) : ''}${rows}</tbody>
          </table>
        </div>
      </div>
    </div>
    <div class="dlg-foot dlg-foot-split">
      <button type="button" class="btn btn-danger" data-action="delete-fund">${icon('trash', 16)}Delete fund</button>
      <button type="button" class="btn" data-action="close">Done</button>
    </div>
  </div>`
  $('[data-editing] [name=date]', dlg)?.focus()
}

async function saveLotEdit(row) {
  const f = state.data.funds.find(x => x.id === openFundId)
  const lot = readLot(row)
  const errorCell = $('.lot-edit-error', row)
  if (lot.date && lot.amount > 0 && !(lot.units > 0)) {
    errorCell.textContent = 'Working out units…'
    try {
      const point = navOn(await navHistory(f.schemeCode), lot.date)
      if (point) lot.units = unitsFor(lot.amount, point.nav, point.date)
    } catch {}
  }
  const problem = lotError(lot)
  if (problem) return (errorCell.textContent = problem)
  if (editingLot === 'new') f.lots.push({ id: uid(), ...lot })
  else Object.assign(f.lots.find(l => l.id === editingLot), lot)
  editingLot = null
  persist()
  renderFund()
}

async function deleteLot(lotId) {
  const f = state.data.funds.find(x => x.id === openFundId)
  if (f.lots.length === 1) return deleteFund()
  const lot = f.lots.find(l => l.id === lotId)
  const ok = await confirmDialog({
    title: 'Delete this investment?',
    body: `${money(lot.amount)} invested on ${dateLabel(lot.date)} (${quantity(lot.units)} units).`,
    action: 'Delete investment',
  })
  if (!ok) return
  f.lots = f.lots.filter(l => l.id !== lotId)
  persist()
  renderFund()
}

async function deleteFund() {
  const f = state.data.funds.find(x => x.id === openFundId)
  const ok = await confirmDialog({
    title: `Delete ${shortName(f.name)}?`,
    body: `This removes the fund and all ${f.lots.length} of its investment${f.lots.length > 1 ? 's' : ''}.`,
    action: 'Delete fund',
  })
  if (!ok) return
  state.data.funds = state.data.funds.filter(x => x.id !== f.id)
  $('#dlg-fund').close()
  toast(`Deleted ${shortName(f.name)}`)
  persist()
}

function confirmDialog({ title, body, action }) {
  const dlg = $('#dlg-confirm')
  dlg.innerHTML = `<form class="dlg" method="dialog">
    <div class="dlg-head"><h3>${esc(title)}</h3></div>
    <div class="dlg-body"><p class="muted">${esc(body)}</p></div>
    <div class="dlg-foot">
      <button class="btn" value="cancel">Cancel</button>
      <button class="btn btn-danger-solid" value="ok">${esc(action)}</button>
    </div>
  </form>`
  dlg.returnValue = ''
  dlg.showModal()
  $('[value=cancel]', dlg).focus()
  return new Promise(resolve => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }))
}

function toast(message, kind = '', ms = 4000) {
  const el = document.createElement('div')
  el.className = `toast ${kind}`
  el.textContent = message
  const box = $('#toasts')
  box.append(el)
  while (box.children.length > 2) box.firstElementChild.remove()
  setTimeout(() => {
    el.classList.add('leaving')
    setTimeout(() => el.remove(), 250)
  }, ms)
}

let timers = []
let lastActivity = Date.now()

function armTimers() {
  disarmTimers()
  timers.push(setInterval(checkIdle, 30000))
}

function disarmTimers() {
  timers.forEach(clearInterval)
  timers = []
}

function checkIdle() {
  if (!state.data || state.unsynced || state.sync === 'saving') return
  if (Date.now() - lastActivity > idleLockMinutes * 60000) lock(`Locked after ${idleLockMinutes} minutes without activity.`)
}

function bindEvents() {
  for (const el of $$('[data-icon]')) el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon))

  $('#loading-retry').addEventListener('click', boot)
  $('#lock-form').addEventListener('submit', onLockSubmit)
  $('#btn-add').addEventListener('click', openAdd)
  $('#btn-refresh').addEventListener('click', refreshAll)
  $('#btn-lock').addEventListener('click', () => {
    if (state.unsynced && !window.confirm('You have changes that are not saved to GitHub. Lock anyway and lose them?')) return
    lock()
  })
  $('#sync-pill').addEventListener('click', () => {
    if (!state.token) toast('Connect GitHub on 23th Street first, so changes can be saved.', 'warn', 7000)
    else if (state.sync === 'error' || state.unsynced) queueSave()
  })

  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-action=toggle-pw]')
    if (!btn) return
    e.preventDefault()
    const input = $('input', btn.parentElement)
    const hidden = input.type === 'password'
    input.type = hidden ? 'text' : 'password'
    btn.setAttribute('aria-label', hidden ? 'Hide' : 'Show')
    btn.innerHTML = icon(hidden ? 'eyeOff' : 'eye', 18)
    input.focus()
  })

  const main = $('#screen-main')
  main.addEventListener('click', e => {
    const sort = e.target.closest('[data-sort]')
    if (sort) {
      const key = sort.dataset.sort
      state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : key === 'name' ? 1 : -1 }
      return render()
    }
    const company = e.target.closest('[data-company]')
    if (company) {
      state.expanded = state.expanded === company.dataset.company ? null : company.dataset.company
      hideTip()
      return render()
    }
    if (e.target.closest('[data-action=add]')) return openAdd()
    const row = e.target.closest('[data-id]')
    if (row) openFund(row.dataset.id)
  })
  main.addEventListener('keydown', e => {
    const row = e.target.closest('tr[data-id]')
    if (row && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      openFund(row.dataset.id)
    }
  })
  const tipFor = el => breakdownCache?.leaders.find(c => c.key === el.dataset.company)
  main.addEventListener('pointerover', e => {
    const el = e.target.closest('[data-company]')
    if (el && e.pointerType === 'mouse' && tipFor(el)) showTip(el, tipFor(el))
  })
  main.addEventListener('pointerout', e => {
    if (e.target.closest('[data-company]') && !e.relatedTarget?.closest?.('[data-company]')) hideTip()
  })
  main.addEventListener('focusin', e => {
    const el = e.target.closest('[data-company]')
    if (el && tipFor(el)) showTip(el, tipFor(el))
  })
  main.addEventListener('focusout', hideTip)
  window.addEventListener('scroll', hideTip, { passive: true })

  for (const dlg of $$('dialog')) {
    dlg.addEventListener('click', e => {
      if (e.target === dlg) return dlg.close()
      if (e.target.closest('[data-action=close]')) dlg.close()
    })
  }

  const add = $('#dlg-add')
  add.addEventListener('submit', onAddSubmit)
  add.addEventListener('input', e => {
    if (e.target.id === 'add-search') return onSearchInput(e.target.value)
    const row = e.target.closest('[data-lot]')
    if (row && e.target.name === 'units') e.target.dataset.auto = e.target.value ? '0' : '1'
    if (row && (e.target.name === 'date' || e.target.name === 'amount')) fillUnits(row)
    updateAddTotal()
  })
  add.addEventListener('keydown', e => {
    if (e.target.id !== 'add-search') return
    const n = picker.results.length
    if (e.key === 'ArrowDown' && n) picker.active = (picker.active + 1) % n
    else if (e.key === 'ArrowUp' && n) picker.active = (picker.active - 1 + n) % n
    else if (e.key === 'Enter') {
      e.preventDefault()
      return pickResult(picker.active)
    } else return
    e.preventDefault()
    renderResults()
    $(`#add-results [data-index="${picker.active}"]`)?.scrollIntoView({ block: 'nearest' })
  })
  add.addEventListener('click', e => {
    const item = e.target.closest('.suggest-item')
    if (item) return pickResult(Number(item.dataset.index))
    const action = e.target.closest('[data-action]')?.dataset.action
    if (action === 'change-company') {
      picker.selected = null
      picker.history = null
      picker.seq++
      renderPicker()
      $('#add-search').focus()
    } else if (action === 'add-lot') {
      $('#add-lots').insertAdjacentHTML('beforeend', lotRowHTML())
      $('#add-lots [data-lot]:last-child [name=date]').focus()
    } else if (action === 'remove-lot') {
      const rows = $$('#add-lots [data-lot]')
      if (rows.length > 1) e.target.closest('[data-lot]').remove()
      else for (const input of $$('input', rows[0])) input.value = ''
      updateAddTotal()
    } else if (action === 'sip') {
      const form = $('#sip-form')
      form.hidden = !form.hidden
      if (!form.hidden) $('[name=sip-amount]', form).focus()
    } else if (action === 'sip-generate') onSipGenerate()
  })

  const detail = $('#dlg-fund')
  detail.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]')
    if (!btn) return
    const action = btn.dataset.action
    if (action === 'edit-lot') {
      editingLot = btn.dataset.lotId
      renderFund()
    } else if (action === 'new-lot') {
      editingLot = 'new'
      renderFund()
    } else if (action === 'cancel-lot') {
      editingLot = null
      renderFund()
    } else if (action === 'save-lot') saveLotEdit(btn.closest('tr'))
    else if (action === 'delete-lot') deleteLot(btn.dataset.lotId)
    else if (action === 'delete-fund') deleteFund()
  })
  detail.addEventListener('keydown', e => {
    const row = e.target.closest('[data-editing]')
    if (!row) return
    if (e.key === 'Enter') {
      e.preventDefault()
      saveLotEdit(row)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      editingLot = null
      renderFund()
    }
  })

  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(type, () => (lastActivity = Date.now()), { passive: true, capture: true })
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.data) return
    checkIdle()
    if (state.data && Date.now() - state.refreshedAt > refreshMinutes * 60000) refreshAll()
  })
  window.addEventListener('beforeunload', e => {
    if (state.unsynced || state.sync === 'saving') {
      e.preventDefault()
      e.returnValue = ''
    }
  })
}

bindEvents()
boot()
