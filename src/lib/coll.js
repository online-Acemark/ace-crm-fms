// Collection / My Parties shared helpers: formatting, follow-up buckets, aggregation, priority, paging.
import { useEffect, useState } from 'react'
import { supabase } from './supabase'

export const BUCKETS = [
  ['b0_30', '0-30'], ['b31_60', '31-60'], ['b61_90', '61-90'], ['b91_120', '91-120'],
  ['b121_150', '121-150'], ['b151_180', '151-180'], ['b180p', '180+'],
]
// saat buckets ka jod — ERP ki aging report me jitna paisa gina gaya
export const agingSum = (p) => BUCKETS.reduce((a, [k]) => a + Number(p?.aging?.[k] || 0), 0)
// Total Pending − aging sum: jo paisa aging report me nahi aaya (internal / non-trade accounts)
export const agingDiff = (p) => Math.round(Number(p?.total_pending || 0) - agingSum(p))
// party ke bills kin firms ke hain (Acemark Stationers / Publications / Ace Paper …) — distinct, sorted
export const firmsOf = (p) => [...new Set((p?.bills || []).map((b) => String(b.company || '').trim()).filter(Boolean))].sort()
// chip ke liye chhota naam: 'Acemark Publications' -> 'Publications', 'Ace Paper Products' -> 'Ace Paper'
export const firmShort = (name) => {
  const n = String(name || '').trim()
  if (/^acemark\s+/i.test(n)) return n.replace(/^acemark\s+/i, '')
  return n.split(/\s+/).slice(0, 2).join(' ')
}
export const inr = (v) => '₹' + Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })
// bade amounts chhote me: 12.5L, 1.2Cr — naye banda ko ek nazar me samajh aaye
export const inrShort = (v) => {
  const n = Number(v || 0)
  if (n >= 1e7) return '₹' + (n / 1e7).toFixed(2).replace(/\.?0+$/, '') + ' Cr'
  if (n >= 1e5) return '₹' + (n / 1e5).toFixed(1).replace(/\.0$/, '') + ' L'
  return inr(n)
}
export const dmy = (v) => v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'
export const dmyt = (v) => v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'
export const pad = (n) => String(n).padStart(2, '0')
export const isoDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const toLocalInput = (dt) => `${isoDay(dt)}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`
export const startOfDay = (v) => { const d = new Date(v); d.setHours(0, 0, 0, 0); return d }
// kitne din baad/pehle (date-only): -1 = kal beet gaya, 0 = aaj, 1 = kal
export const dayDiff = (v) => Math.round((startOfDay(v) - startOfDay(new Date())) / 864e5)
export const normKey = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')
export const userName = (e) => String(e || '').split('@')[0]

export const isCross = (p) => Number(p.credit_limit) > 0 && Number(p.total_pending) > Number(p.credit_limit)
export const isUrgent = (p) => (p.oldest_od || 0) > 180 || isCross(p)

// ---------- follow-up stages (form dropdown) ----------
export const STAGES = ['Committed', 'Payment received', 'PDC received', 'Dispute', 'No response', 'CRM Support', 'Transfer', 'Close']
export const STAGE_CLS = {
  'Committed': 'st-commit', 'Payment received': 'st-recv', 'PDC received': 'st-recv', 'Dispute': 'st-bad',
  'No response': 'st-bad', 'CRM Support': 'st-park', 'Transfer': 'st-park', 'Close': 'st-close',
}
export const STAGE_HINT = {
  'Committed': 'Party promised to pay — enter the amount and the date they promised',
  'Payment received': 'Party says money is sent — enter amount + mode. ERP sync (hourly) confirms it against the bills',
  'PDC received': 'Post-dated cheque received — enter amount, mode = Cheque/PDC',
  'Dispute': 'Party disputes the bill (rate / damage / short supply) — write details',
  'No response': 'Phone not picked / switched off — set the next date',
  'CRM Support': 'Needs office help (ledger, credit note) — party leaves the Missed list until resolved',
  'Transfer': 'Hand this party to another salesman — pick the name and give the reason',
  'Close': 'Nothing more to chase (fully paid / written off) — party leaves Today & Tomorrow lists',
}
export const PAY_MODES = ['RTGS/NEFT', 'UPI', 'Cash', 'Cheque', 'PDC', 'Other']

// ---------- follow-up status buckets (from next_followup_date + latest stage) ----------
export const BUCKET_LABEL = { missed: 'Missed', today: 'Today', tomorrow: 'Tomorrow', week: 'This week', later: 'Later', nodate: 'No date', closed: 'Closed' }
export const BUCKET_CLS = { missed: 'bk-missed', today: 'bk-today', tomorrow: 'bk-tom', week: 'bk-week', later: 'bk-later', nodate: 'bk-none', closed: 'bk-closed' }
export function bucketOf(p, ag) {
  if (ag.lastStage === 'Close') return 'closed'
  if (!p.next_followup_date) return 'nodate'
  const d = dayDiff(p.next_followup_date)
  if (d < 0) return (ag.doneToday || ag.lastStage === 'CRM Support') ? 'later' : 'missed'
  if (d === 0) return 'today'
  if (d === 1) return 'tomorrow'
  const t = new Date(); const dow = (t.getDay() + 6) % 7   // Mon=0 … Sun=6
  return d <= 6 - dow ? 'week' : 'later'
}

// Promise tuta? Committed date beet gayi, uske baad paisa nahi aaya (ERP receipt ya logged), aur party close nahi hui.
export function isBroken(ag) {
  const c = ag.committed
  if (!c || ag.lastStage === 'Close') return false
  if (dayDiff(c.date) >= 0) return false
  const cAt = new Date(c.at)
  if (ag.entries.some((f) => Number(f.amount_received) > 0 && new Date(f.created_at) > cAt)) return false
  const cDay = String(c.at).slice(0, 10)
  return !ag.receipts.some((r) => r.pay_date && r.pay_date >= cDay)
}

export const EMPTY_AGG = { entries: [], waCount: 0, count: 0, last: null, lastStage: '', doneToday: false, committed: null, transferTo: '', transferReason: '', paid: new Map(), recvTotal: 0, receipts: [] }
// fms_followups (party-level) + fms_receipts -> per party summary. Entries created_at DESC aate hain.
export function buildAgg(fups, receipts) {
  const m = new Map()
  const today = isoDay()
  const get = (k) => { let a = m.get(k); if (!a) { a = { ...EMPTY_AGG, entries: [], paid: new Map(), receipts: [] }; m.set(k, a) } return a }
  for (const f of fups) {
    const k = normKey(f.party_name); if (!k) continue
    const a = get(k)
    if (f.mode === 'whatsapp') { a.waCount++; continue }
    a.entries.push(f); a.count++
    if (!a.last) { a.last = f; a.lastStage = f.stage || '' }
    if (String(f.created_at || '').slice(0, 10) === today) a.doneToday = true
    if (!a.committed && f.committed_date) a.committed = { amount: Number(f.committed_amount) || 0, date: f.committed_date, at: f.created_at, by: f.created_by }
    if (!a.transferTo && f.transfer_to) { a.transferTo = f.transfer_to; a.transferReason = f.transfer_reason || '' }
    if (Number(f.amount_received) > 0) {
      a.recvTotal += Number(f.amount_received)
      for (const v of (Array.isArray(f.bill_nos) ? f.bill_nos : [])) if (v && !a.paid.has(v)) a.paid.set(v, { at: f.created_at, amount: Number(f.amount_received) })
    }
  }
  for (const r of receipts) { const k = normKey(r.party_name); if (k) get(k).receipts.push(r) }   // pay_date DESC
  return m
}

// Priority: jitna bada number, utna upar. Naya banda bas upar se neeche kaam kare.
export function priorityOf(p, ag, bucket) {
  if (p.permanent_note) return { rank: -1, label: 'Excluded', cls: 'pr-mild', hint: 'Permanent note set — party is out of the follow-up worklist' }
  if (bucket === 'closed') return { rank: 0, label: 'Closed', cls: 'pr-ok', hint: 'Last stage = Close. Will disappear after ERP shows it paid' }
  if (isBroken(ag)) return { rank: 6, label: 'Broken promise', cls: 'pr-hot', hint: `Promised ${inrShort(ag.committed.amount)} by ${dmy(ag.committed.date)} — nothing received since` }
  if (bucket === 'missed') return { rank: 5, label: 'Missed', cls: 'pr-hot', hint: 'Follow-up date has passed and nobody called' }
  if (bucket === 'today') return { rank: 4, label: 'Due today', cls: 'pr-due', hint: 'You set a follow-up date for today — call this party first' }
  if (isUrgent(p)) return { rank: 3, label: 'Urgent', cls: 'pr-hot', hint: isCross(p) ? 'Party has crossed the credit limit' : 'Oldest bill is more than 6 months overdue' }
  if ((p.oldest_od || 0) > 90) return { rank: 2, label: 'Act soon', cls: 'pr-warm', hint: 'Oldest bill is more than 3 months overdue' }
  if ((p.oldest_od || 0) > 30) return { rank: 1, label: 'Watch', cls: 'pr-mild', hint: 'Oldest bill is more than 1 month overdue' }
  return { rank: 0, label: 'OK', cls: 'pr-ok', hint: 'Nothing is very old yet' }
}


// Supabase ek call me max 1000 rows deta hai — page-wise lao
export async function fetchAll(table, cols, apply) {
  const out = []; const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(table).select(cols)
    q = apply(q).range(from, from + PAGE - 1)
    const { data, error } = await q
    if (error || !data?.length) break
    out.push(...data)
    if (data.length < PAGE) break
  }
  return out
}
export const FUP_COLS = 'id,party_name,stage,payment_mode,bill_nos,committed_amount,committed_date,transfer_to,transfer_reason,remarks,amount_received,mode,created_by,created_at,next_followup_date'
export const RCPT_COLS = 'company_id,pay_vno,party_name,pay_date,pay_type,amount,bills'


// ---------- follow-up scoring (weekly, Mon–Sat) ----------
// Har follow-up entry par PLAN save hota hai (next_followup_date). Usi party ki AGLI entry = ACTUAL.
// actual <= plan (same day ya pehle) = on time (full points); late = plan ke baad, har din penalty;
// plan beet gaya aur agli entry nahi = missed (0). Score us hafte me ginta hai jis hafte plan tha.
export const SCORE_DEFAULTS = { on_time_points: 100, penalty_per_day: 20, min_points: 0 }
// hafte ki key = us hafte ka Monday (yyyy-mm-dd). Sunday apne hi hafte (Mon–Sun) me.
export function weekKey(v) { const d = startOfDay(v); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return isoDay(d) }
export function weekLabel(k) { const m = new Date(k + 'T00:00:00'); const s = new Date(m); s.setDate(m.getDate() + 5); return `${dmy(m)} – ${dmy(s)}` }
export function scoreFollowups(fups, cfg = SCORE_DEFAULTS, today = isoDay()) {
  const c = { ...SCORE_DEFAULTS, ...(cfg || {}) }
  const byParty = new Map()
  for (const f of fups) {
    if (f.mode === 'whatsapp') continue
    const k = normKey(f.party_name); if (!k) continue
    if (!byParty.has(k)) byParty.set(k, [])
    byParty.get(k).push(f)
  }
  const items = []
  for (const [k, list] of byParty) {
    list.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    for (let i = 0; i < list.length; i++) {
      const f = list[i]
      if (!f.next_followup_date || f.stage === 'Close') continue
      const plan = isoDay(new Date(f.next_followup_date))
      const next = list[i + 1]
      const actual = next ? isoDay(new Date(next.created_at)) : null
      let status, days = 0, points = null
      if (actual) {
        days = Math.round((startOfDay(actual) - startOfDay(plan)) / 864e5)
        if (days <= 0) { status = days < 0 ? 'early' : 'ontime'; points = c.on_time_points }
        else { status = 'late'; points = Math.max(c.min_points, c.on_time_points - c.penalty_per_day * days) }
      } else if (plan < today) {
        status = 'missed'; days = Math.round((startOfDay(today) - startOfDay(plan)) / 864e5); points = c.min_points
      } else { status = 'upcoming' }
      items.push({
        id: f.id, key: k, party: f.party_name, plan, actual, status, days, points, week: weekKey(plan),
        planner: userName(f.created_by), doer: next ? userName(next.created_by) : '',
        // credit: jisne follow-up kiya; missed ho to jisne plan banaya tha
        who: next ? userName(next.created_by) : userName(f.created_by),
        stage: next ? next.stage || '' : '',
      })
    }
  }
  return items
}
// items ka summary (ek group ke liye)
export function summarize(items, cfg = SCORE_DEFAULTS) {
  const c = { ...SCORE_DEFAULTS, ...(cfg || {}) }
  const r = { planned: items.length, ontime: 0, early: 0, late: 0, missed: 0, upcoming: 0, lateDays: 0, points: 0, scored: 0 }
  for (const it of items) {
    r[it.status]++
    if (it.status === 'late') r.lateDays += it.days
    if (it.points != null) { r.points += it.points; r.scored++ }
  }
  r.done = r.ontime + r.early
  r.avgLate = r.late ? Math.round((r.lateDays / r.late) * 10) / 10 : 0
  r.score = r.scored ? Math.round((r.points / (r.scored * c.on_time_points)) * 100) : null
  return r
}

// ---------- UI helpers (avatar colour/initials, mobile hook) ----------
const AVA = ['#6a5fe8', '#0f8a64', '#d2683e', '#c2497e', '#2a7fc9', '#8a6ee0', '#b88414', '#3f9e8a']
export function avaColor(s) { let h = 0; s = String(s || ''); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return AVA[h % AVA.length] }
export function initials(s) { const w = String(s || '?').trim().split(/\s+/).filter(Boolean); return ((w[0] || '?')[0] || '?').toUpperCase() + (w.length > 1 ? (w[1][0] || '').toUpperCase() : '') }
export function useIsMobile(bp = 760) {
  const q = `(max-width: ${bp}px)`
  const [m, setM] = useState(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q).matches : false))
  useEffect(() => {
    if (!window.matchMedia) return
    const mq = window.matchMedia(q); const h = (e) => setM(e.matches)
    mq.addEventListener('change', h); return () => mq.removeEventListener('change', h)
  }, [q])
  return m
}
