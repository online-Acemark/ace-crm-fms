// Collection + My Parties ka shared table setup: columns, column picker state, filters, totals, print.
// (Sirf non-component exports — components CollBits.jsx me hain, fast-refresh ke liye.)
import { useMemo, useState } from 'react'
import { inr, inrShort, dmy, userName, BUCKETS, agingSum, agingDiff, firmsOf } from './coll'
import { AgingChips, LimitBar, StageChip, BucketPill, FirmChips } from '../components/CollBits'

// aging column ka rang: pehle 2 buckets green, agle 2 amber, baaki red (AgingChips jaisa)
const AGE_CLS = ['green-t', 'green-t', 'amber-t', 'amber-t', 'red-t', 'red-t', 'red-t']
export const AGING_COLS = BUCKETS.map(([k, label], i) => ({
  key: 'ag_' + k, bkt: k, label: label + 'd', sort: 'ag_' + k, num: true, cls: AGE_CLS[i],
  title: `Pending amount ${label} days old (ERP aging report)`, total: (p) => Number(p.aging?.[k] || 0),
}))
export const COLS = [
  { key: 'total_pending', label: 'Total Pending', sort: 'total_pending', num: true, total: (p) => Number(p.total_pending || 0) },
  { key: 'oldest_od', label: 'Oldest Due', sort: 'oldest_od', title: 'How many days the oldest bill is overdue' },
  { key: 'company', label: 'Company', title: 'Which firms the pending bills belong to' },
  { key: 'aging', label: 'Aging (chips)', title: 'How old the money is — green is new, red is very old' },
  ...AGING_COLS,
  { key: 'aging_sum', label: 'Aging Total', sort: 'aging_sum', num: true, total: agingSum, title: 'Sum of all aging buckets' },
  { key: 'diff', label: 'Difference', sort: 'diff', num: true, total: agingDiff, title: 'Total Pending − Aging Total: money that is not in the ERP aging report' },
  { key: 'credit_limit', label: 'Credit Limit', title: 'Credit limit given to the party and how much is used' },
  { key: 'last_pay', label: 'Last Payment', title: 'Last receipt in ERP' },
  { key: 'next', label: 'Next F/Up', sort: 'next' },
  { key: 'flw', label: 'Follow-ups', sort: 'flw', title: 'How many times this party has been chased' },
  { key: 'stage', label: 'Last Stage' },
  { key: 'committed', label: 'Committed', sort: 'committed' },
  { key: 'remark', label: 'Last Remark' },
  { key: 'transfer', label: 'Transferred to' },
  { key: 'city', label: 'City' }, { key: 'beat', label: 'Beat' },
]
// Print panel ke quick presets: kaunse columns on rakhne hain
export const COL_PRESETS = {
  'Follow-up list': ['total_pending', 'oldest_od', 'company', 'next', 'flw', 'stage', 'committed', 'remark'],
  'Aging report': ['total_pending', 'company', ...AGING_COLS.map((c) => c.key), 'aging_sum', 'diff'],
  'Party master': ['total_pending', 'oldest_od', 'company', 'credit_limit', 'last_pay', 'city', 'beat'],
}
export const COLL_DEFAULT_ON = ['total_pending', 'oldest_od', 'company', 'credit_limit', 'last_pay', 'next', 'flw', 'stage', 'committed']
export const SALES_DEFAULT_ON = ['total_pending', 'oldest_od', 'aging', 'last_pay', 'next', 'stage', 'committed']

const loadCols = (key) => { try { const v = JSON.parse(localStorage.getItem(key) || 'null'); if (v && typeof v === 'object') return v } catch { /* ignore */ } return {} }
// column on/off state (localStorage me yaad rehta hai) — Collection aur My Parties apni-apni key se
export function useColVis(lsKey, defaultOn) {
  const [colVis, setColVis] = useState(() => loadCols(lsKey))
  const def = new Set(defaultOn)
  const vis = (c) => (c.key in colVis ? !!colVis[c.key] : def.has(c.key))
  const visCols = COLS.filter(vis)
  const save = (n) => { setColVis(n); try { localStorage.setItem(lsKey, JSON.stringify(n)) } catch { /* ignore */ } }
  const toggleCol = (k) => save({ ...colVis, [k]: !vis(COLS.find((c) => c.key === k)) })
  const resetCols = () => { setColVis({}); try { localStorage.removeItem(lsKey) } catch { /* ignore */ } }
  const applyPreset = (name) => { const on = new Set(COL_PRESETS[name]); const n = {}; COLS.forEach((c) => { n[c.key] = on.has(c.key) }); save(n) }
  const showCol = (k) => { if (!vis(COLS.find((c) => c.key === k))) toggleCol(k) }
  return { vis, visCols, toggleCol, resetCols, applyPreset, showCol }
}

// ek cell ka content — e = { p, ag, bucket, broken }
export function cellOf(c, { p, ag, bucket, broken }) {
  switch (c.key) {
    case 'total_pending': return <><b>{inrShort(p.total_pending)}</b><div className="muted small">{p.bill_count} bills</div></>
    case 'oldest_od': return p.oldest_od ? <span className={p.oldest_od > 90 ? 'red-t' : p.oldest_od > 30 ? 'amber-t' : ''}><b>{p.oldest_od} days</b></span> : '—'
    case 'aging': return <AgingChips aging={p.aging} />
    case 'company': return <FirmChips p={p} />
    case 'aging_sum': { const v = agingSum(p); return v ? <b>{inrShort(v)}</b> : <span className="muted">—</span> }
    case 'diff': { const v = agingDiff(p); return Math.abs(v) > 1 ? <b className="amber-t" title={`${inr(p.total_pending)} pending − ${inr(agingSum(p))} in aging`}>{inrShort(v)}</b> : <span className="muted">—</span> }
    case 'credit_limit': return <LimitBar pending={p.total_pending} limit={p.credit_limit} />
    case 'last_pay': {
      const r = ag.receipts[0]
      if (r) return <span className="small">{inrShort(r.amount)}<div className="muted">{dmy(r.pay_date)} · {r.pay_type}</div></span>
      return p.last_pay_amt ? <span className="small">{inrShort(p.last_pay_amt)}<div className="muted">{dmy(p.last_pay_date)}</div></span> : <span className="muted">—</span>
    }
    case 'next': return <BucketPill b={bucket} date={p.next_followup_date} />
    case 'flw': return ag.count || ag.waCount
      ? <span className="small"><span className={`flw-pill ${ag.count >= 5 ? 'hi' : ''}`} title={`${ag.count} calls logged · ${ag.waCount} WhatsApp sent`}>{ag.count}x</span>{ag.last && <div className="muted">{dmy(ag.last.created_at)} · {userName(ag.last.created_by)}</div>}</span>
      : <span className="muted">—</span>
    case 'stage': return ag.lastStage ? <StageChip s={ag.lastStage} /> : <span className="muted">—</span>
    case 'committed': return ag.committed
      ? <span className={`small ${broken ? 'red-t' : ''}`}><b>{inrShort(ag.committed.amount)}</b><div className={broken ? 'red-t' : 'muted'}>{broken ? '💔 ' : 'by '}{dmy(ag.committed.date)}</div></span>
      : <span className="muted">—</span>
    case 'remark': return ag.last?.remarks ? <span className="small coll-remark" title={ag.last.remarks}>{ag.last.remarks}</span> : <span className="muted">—</span>
    case 'transfer': return ag.transferTo ? <span className="small" title={ag.transferReason}>↪ {ag.transferTo}</span> : <span className="muted">—</span>
    case 'city': return p.city || <span className="muted">—</span>
    case 'beat': return p.beat || <span className="muted">—</span>
    default: {
      if (c.bkt) { const v = Number(p.aging?.[c.bkt] || 0); return v ? <span className={c.cls} title={inr(v)}>{inrShort(v)}</span> : <span className="muted">—</span> }
      return null
    }
  }
}

// sort ke liye column value
export function sortVal(k, e, dir) {
  return k === 'party_name' ? String(e.p.party_name || '')
    : k === 'flw' ? e.ag.count
    : k === 'next' ? (e.p.next_followup_date ? new Date(e.p.next_followup_date).getTime() : (dir === 'desc' ? -1 : 9e15))
    : k === 'committed' ? (e.ag.committed?.amount || 0)
    : k === 'aging_sum' ? agingSum(e.p)
    : k === 'diff' ? agingDiff(e.p)
    : k.startsWith('ag_') ? Number(e.p.aging?.[k.slice(3)] || 0)
    : Number(e.p[k] || 0)
}

// ---------- extra filters (beat / aging bucket / company / difference) ----------
export const EMPTY_FILTERS = { beat: '', agingF: '', company: '', diffF: '' }
export function useExtraFilters() {
  const [f, setF] = useState(EMPTY_FILTERS)
  const set = (k, v) => setF((o) => ({ ...o, [k]: v }))
  const clear = () => setF(EMPTY_FILTERS)
  const any = !!(f.beat || f.agingF || f.company || f.diffF)
  return { f, set, clear, any }
}
export function filterOptions(rows) {
  return {
    beats: [...new Set((rows || []).map((p) => String(p.beat || '').trim()).filter(Boolean))].sort(),
    companies: [...new Set((rows || []).flatMap((p) => firmsOf(p)))].sort(),
  }
}
export function applyExtraFilters(list, { beat, agingF, company, diffF }) {
  if (beat) list = list.filter((e) => String(e.p.beat || '').trim() === beat)
  if (agingF) list = list.filter((e) => Number(e.p.aging?.[agingF] || 0) > 0)
  if (company) list = list.filter((e) => firmsOf(e.p).includes(company))
  if (diffF) list = list.filter((e) => (Math.abs(agingDiff(e.p)) > 1) === (diffF === 'yes'))
  return list
}
// print header ke liye: lage hue filters ek line me
export function extraFilterText({ beat, agingF, company, diffF }) {
  return [beat, agingF ? 'aging ' + (BUCKETS.find(([k]) => k === agingF) || [])[1] + 'd' : '', company, diffF ? (diffF === 'yes' ? 'has difference' : 'no difference') : ''].filter(Boolean)
}

// footer totals: jo parties filter me dikh rahi hain, unka column-wise jod (sirf number columns)
export function useTotals(filtered) {
  return useMemo(() => { const t = {}; for (const c of COLS) if (c.total) t[c.key] = filtered.reduce((a, e) => a + c.total(e.p), 0); return t }, [filtered])
}

// Print: saare chune columns page par aa jaayein — column count se font chhota + fixed layout,
// 7+ columns par landscape. Rule sirf is print ke liye lagta hai, afterprint par hat jaata hai.
export function printTable(nCols) {
  const landscape = nCols > 7
  const availPx = landscape ? 1060 : 730                    // A4 @96dpi minus 8mm margins
  const perCol = availPx / (nCols + 2)                       // + Priority + Party
  const font = Math.max(6.5, Math.min(10.5, perCol / 6.2))   // ~6 chars per column width
  const st = document.createElement('style')
  st.textContent = `@media print {
    @page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: 8mm; }
    .coll-tbl { font-size: ${font.toFixed(1)}px !important; table-layout: fixed; width: 100% !important; min-width: 0 !important; }
    .coll-tbl th, .coll-tbl td { white-space: normal !important; word-break: break-word; overflow-wrap: anywhere; padding: 2px 3px !important; }
    .coll-tbl th:nth-child(3), .coll-tbl td:nth-child(3) { width: ${Math.round(perCol * 2.2)}px; }   /* Party (Action column print me hidden hai) */
    .coll-tbl .small, .coll-tbl .muted, .coll-tbl .pcell-m, .coll-tbl .pcell-m .tag { font-size: 0.9em !important; }
    .coll-tbl .pcell-n { font-size: 1em; white-space: normal; }
    .coll-tbl .pcell-m { white-space: normal; }
    .coll-tbl .age-chip, .coll-tbl .firm-chip, .coll-tbl .pr-badge, .coll-tbl .flw-pill, .coll-tbl .stage-chip, .coll-tbl .bk-pill, .coll-tbl .tag { font-size: 0.9em !important; padding: 0 3px !important; white-space: normal !important; border-radius: 4px; }
    .coll-tbl .aging-chips { gap: 2px; }
    .coll-tbl .coll-remark { max-width: none; white-space: normal; }
    .coll-tbl .pcell { gap: 0; }
    .coll-tbl .pcell .ava { display: none; }
  }`
  document.head.appendChild(st)
  const done = () => { st.remove(); window.removeEventListener('afterprint', done) }
  window.addEventListener('afterprint', done); setTimeout(done, 60000)
  setTimeout(() => window.print(), 50)
}
