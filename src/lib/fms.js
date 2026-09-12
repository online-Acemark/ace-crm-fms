import { supabase, SUPABASE_URL, SUPABASE_ANON } from './supabase'

// ---------- config (.env se; sensible defaults) ----------
// ERP proxy ka URL — default: Supabase edge function fms-proxy
const FMS_PROXY_URL = import.meta.env.VITE_FMS_PROXY_URL || `${SUPABASE_URL}/functions/v1/fms-proxy`
// WhatsApp country code (wa.me links ke liye)
const WA_COUNTRY = import.meta.env.VITE_WA_COUNTRY_CODE || '91'

// ---------- fetch ERP data via edge-function proxy ----------
export async function fetchERP(src) {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(`${FMS_PROXY_URL}?src=${src}`, {
    headers: {
      apikey: SUPABASE_ANON,
      Authorization: `Bearer ${session?.access_token || SUPABASE_ANON}`,
    },
  })
  if (!res.ok) throw new Error(`Proxy ${src} failed: ${res.status}`)
  return res.json()
}

// ---------- helpers: split "A / B" style double values ----------
export function splitTwo(v) {
  const s = (v || '').trim()
  if (!s) return ['', '']
  const parts = s.split(/\s*[/;,]\s*/).map((x) => x.trim()).filter(Boolean)
  return [parts[0] || '', parts.slice(1).join(' / ') || '']
}

// merged contact view: manual override (exec ne bhara) > ERP value
export function resolveContact(o) {
  const m = o.contact_manual || {}
  return {
    contact_person: m.contact_person || o.contact_person || '',
    contact_person2: m.contact_person2 || o.contact_person2 || '',
    email_id: m.email_id || o.email_id || '',
    email_id2: m.email_id2 || o.email_id2 || '',
    mobile_no2: m.mobile_no2 || '',
  }
}

export function contactMissing(o) {
  const c = resolveContact(o)
  return !c.contact_person || !c.contact_person2 || !c.email_id || !c.email_id2
}

// ---------- client status message (WhatsApp) ----------
export function buildStatusMsg(o, pipe) {
  const c = resolveContact(o)
  const name = c.contact_person ? `${c.contact_person} ji` : `${o.account_name}`
  const dt = (v) => v ? erpDate(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : ''
  const lines = [`Namaste ${name}`, `Aapke order (SO #${o.mobile_so_no}, ${dt(o.mobile_so_created)}) ka status:`, '']
  if (o.desp_date) {
    lines.push(`Order dispatch ho chuka hai (${dt(o.desp_date)}).`)
  } else if (o.gpout_created) {
    lines.push(`Maal gate pass ho gaya hai — dispatch aaj/kal me ho jayega.`)
  } else if (o.billing_date) {
    lines.push(`Billing ho gayi hai (${dt(o.billing_date)}), dispatch ki taiyari chal rahi hai.`)
  } else if (o.so_convert_date) {
    lines.push(`Order confirm ho gaya hai, billing process me hai.`)
  } else {
    lines.push(`Order receive ho gaya hai, confirm karke jaldi update denge.`)
  }
  if (Number(o.pending_qty) > 0) lines.push(`${o.pending_qty} qty abhi pending hai, baki dispatch ho chuki/ho rahi hai.`)
  if (o.bill_net_amount) lines.push(`Bill amount: ₹${Number(o.bill_net_amount).toLocaleString('en-IN')}${o.credit_days ? ` (credit ${o.credit_days} din)` : ''}`)
  if ((o.inv_urls || []).length) lines.push(`Invoice: ${o.inv_urls[0]}`)
  lines.push('', 'Koi bhi jankari ke liye humein batayein. Dhanyavaad!', '— Acemark Stationers')
  return lines.join('\n')
}

// Family 'N' = No follow-up: is account ka payment follow-up nahi karna hai
export function noFollowup(o) {
  return String(o.acc_family || '').trim().toUpperCase() === 'N'
}

// paid = manual ✔ YA ERP payment reconciliation kehta hai saare bills Full paid hain
export function isPaid(o) {
  return !!o.payment_complete || o.pay_status === 'Full'
}

// bill-wise WhatsApp message: person naam (na ho to party naam), bill no, amount, qty, due date, invoice PDF
export function buildBillMsg(o, b) {
  const c = resolveContact(o)
  const name = c.contact_person ? `${c.contact_person} ji` : `${o.account_name}`
  const lines = [`Namaste ${name}`, '', 'Aapka bill ban gaya hai:']
  lines.push(`Bill No: ${b.bill_no}${b.billing_date ? ` (${erpDate(b.billing_date).toLocaleDateString('en-IN')})` : ''}`)
  if (b.amount != null) lines.push(`Amount: ₹${Number(b.amount).toLocaleString('en-IN')}`)
  if (b.qty) lines.push(`Qty: ${Number(b.qty).toLocaleString('en-IN')}`)
  if (o.credit_days != null && b.billing_date) {
    const due = paymentDue(b.billing_date, o.credit_days)
    lines.push(`Payment due: ${due.toLocaleDateString('en-IN')} (credit ${o.credit_days} din)`)
  }
  if (b.url) lines.push(`Invoice: ${b.url}`)
  lines.push('', 'Koi bhi jankari ke liye humein batayein. Dhanyavaad!', '— Acemark Stationers')
  return lines.join('\n')
}

// WhatsApp bhejne ka log: 📤 click par fms_followups me entry (communication trail)
export async function logWaSend(o, note) {
  if (new URLSearchParams(window.location.search).has('demo')) return
  try {
    const { data: { user } } = await supabase.auth.getUser()
    await supabase.from('fms_followups').insert({
      mobile_so_no: o.mobile_so_no, remarks: note, mode: 'whatsapp', created_by: user?.email || '',
    })
  } catch { /* log fail hone par bhi WhatsApp khulna nahi rukna chahiye */ }
}

// follow-up ka default next date: +N din, Sunday/holiday skip, 11:00 AM
export function suggestNextFollowup(days = 3) {
  let dt = new Date(Date.now() + days * 864e5)
  if (!isWorkingDay(dt)) dt = nextWorkingDay(dt)
  dt.setHours(11, 0, 0, 0)
  return dt
}

export function waLink(mobile, text) {
  const m = String(mobile || '').replace(/\D/g, '')
  if (!m) return null
  return `https://wa.me/${WA_COUNTRY}${m.slice(-10)}${text ? '?text=' + encodeURIComponent(text) : ''}`
}

// ---------- aggregate MobileSO line rows -> one row per SO ----------
export function aggregateSO(rows) {
  const map = new Map()
  for (const r of rows) {
    const key = r.MobileAppSoNo
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(r)
  }
  const out = []
  for (const [soNo, lines] of map) {
    const first = (f) => lines.map((l) => l[f]).find((v) => v != null && v !== '')
    // SO_Qty null/0 wali lines SO convert me drop ho chuki hain (item cancel) —
    // billing/GP out/dispatch ke completion check me unhe mat gino
    const activeLines = lines.filter((l) => Number(l.SO_Qty) > 0)
    const chk = activeLines.length ? activeLines : lines
    const allHave = (f) => chk.every((l) => l[f] != null && l[f] !== '')
    const maxDate = (f) => {
      const vs = lines.map((l) => l[f]).filter(Boolean)
      return vs.length ? vs.sort().at(-1) : null
    }
    const sum = (f) => lines.reduce((a, l) => a + (Number(l[f]) || 0), 0)
    // distinct bills: amount + apna invoice PDF + per-bill detail (bill-wise view ke liye)
    const billMap = new Map()
    for (const l of lines) {
      if (!l.BillNo) continue
      const b = billMap.get(l.BillNo) || { bill_no: l.BillNo, billing_date: null, amt: 0, qty: 0, url: null, products: [] }
      b.amt = Number(l.BillNetAmount) || b.amt // BillNetAmount bill-level hota hai (har line pe repeat)
      b.billing_date = [b.billing_date, l.BillingDate].filter(Boolean).sort().at(-1) || null
      b.url = b.url || l.InvUrl || null
      b.qty += Number(l.BillQty) || 0
      b.products.push({ name: l.ProductName, code: l.ProductCode, qty: l.BillQty ?? l.SO_Qty, unit: l.ProdUnit })
      billMap.set(l.BillNo, b)
    }
    const [cp1, cp2] = splitTwo(first('ContactPerson'))
    const [em1, em2] = splitTwo(first('EmailID'))
    out.push({
      mobile_so_no: soNo,
      sorder_no: first('SOrderNo') ?? null,
      account_name: first('AccountName') ?? '',
      mobile_no: first('MobileNo') ?? '',
      contact_person: cp1,
      contact_person2: cp2,
      email_id: em1,
      email_id2: em2,
      acc_family: (first('AccFamily') || '').trim(),
      salesman: (first('SalesMan_Cloud') || '').trim(),
      beat: (first('Beat') || '').trim(),
      mobile_so_created: first('MobileAppSoCreated') ?? null,
      so_convert_date: first('SoConvertDate') ?? null,
      billing_date: allHave('BillNo') ? maxDate('BillingDate') : null,
      gpout_created: allHave('GPOutNo') ? maxDate('GPOUTCreated') : null,
      // ERP DespDate bina billing ke bhi bhar deta hai — dispatch tabhi actual jab GP Out complete ho
      desp_date: allHave('GPOutNo') && allHave('DespDate') ? maxDate('DespDate') : null,
      credit_days: first('CreditDays') ?? null,
      mobile_so_amount: first('MobileSoAmount') ?? null,
      sorder_amount: first('SorderAmount') ?? null,
      bill_net_amount: [...billMap.values()].reduce((a, b) => a + b.amt, 0) || null,
      so_qty: sum('SO_Qty') || null,
      mobile_qty: sum('MobileApp_Qty') || null,
      pending_qty: sum('PendingQty'),
      bill_qty: sum('BillQty') || null,
      line_count: lines.length,
      bill_nos: [...billMap.keys()],
      inv_urls: [...billMap.values()].map((b) => b.url),
      bills: [...billMap.values()].map(({ bill_no, billing_date, amt, qty, url, products }) => ({ bill_no, billing_date, amount: amt, qty, url, products })),
      products: lines.map((l) => ({ name: l.ProductName, code: l.ProductCode, qty: l.SO_Qty, pending: l.PendingQty, unit: l.ProdUnit, mqty: l.MobileApp_Qty, munit: l.MasterUnit, bqty: l.BillQty, bno: l.BillNo ?? null, gpno: l.GPOutNo ?? null, gpdt: l.GPOUTCreated ?? null, ddt: l.DespDate ?? null })),
    })
  }
  return out
}

// ---------- working day calendar (Supabase: working_day_calender + holidays) ----------
let workingDaySet = null // Set of 'YYYY-MM-DD' — Sunday/holiday pehle se excluded hain
export async function loadWorkingDays() {
  if (workingDaySet) return
  try {
    const [wd, hd] = await Promise.all([
      supabase.from('working_day_calender').select('working_date'),
      supabase.from('holidays').select('holiday_date'),
    ])
    if (wd.data?.length) {
      const hset = new Set((hd.data || []).map((r) => r.holiday_date))
      workingDaySet = new Set(wd.data.map((r) => r.working_date).filter((dt) => !hset.has(dt)))
    }
  } catch { /* fallback niche: sirf Sunday skip */ }
}

const ymd = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
const isWorkingDay = (dt) => workingDaySet ? workingDaySet.has(ymd(dt)) : dt.getDay() !== 0

const nextWorkingDay = (from) => {
  let day = new Date(from); day.setHours(0, 0, 0, 0)
  for (let i = 0; i < 60; i++) {
    day = new Date(day.getTime() + 864e5)
    if (isWorkingDay(day)) break
  }
  return day
}

// ---------- ERP stock (ProductStock API) — billing rule + Stock column dono ke liye ----------
let stockMap = null // code -> { total, unit, status }
export async function loadStock() {
  if (stockMap) return
  try {
    const raw = await fetchERP('stock')
    const rows = Array.isArray(raw) ? raw : raw?.DataRec || []
    const m = {}
    for (const r of rows) if (r.ProductCode) m[String(r.ProductCode).trim().toLowerCase()] = { total: Number(r.Total) || 0, unit: r.ProdUnit || '', status: r.StockStatus || '' }
    stockMap = m
  } catch { /* stock na mile to billing purane chain rule par chalta hai */ }
}
export const getStockMap = () => stockMap

// order ke SAARE items ki qty stock me hai? true/false; stock data hi nahi to null
function stockAvailableFor(o) {
  if (!stockMap) return null
  const ps = o.products || []
  if (!ps.length) return null
  for (const p of ps) {
    const s = stockMap[String(p.code || '').trim().toLowerCase()]
    if (s == null || s.total < (Number(p.qty) || 0)) return false
  }
  return true
}

// Billing rule: stock available + confirm 4 PM se pehle → usi din 4 PM; warna agle working day 4 PM
const BILL_CUTOFF = [16, 0]
function billingPlanned(base, o) {
  if (!base) return null
  const avail = stockAvailableFor(o)
  if (avail == null) return null // stock data nahi — caller purana rule lagayega
  const cut = new Date(base); cut.setHours(BILL_CUTOFF[0], BILL_CUTOFF[1], 0, 0)
  let day
  if (avail && isWorkingDay(base) && base <= cut) day = new Date(base)
  else day = nextWorkingDay(base)
  day.setHours(BILL_CUTOFF[0], BILL_CUTOFF[1], 0, 0)
  return day
}

// SO Convert rule: working day par 7:30 PM se pehle aaya → +30 min;
// warna (late/Sunday/holiday) → agle working day 10:30 AM + 30 min = 11:00 AM
const SO_CUTOFF = [19, 30]
const NEXT_DAY_START = [10, 30]
function soConvertPlanned(t, plannedHours) {
  if (!t) return null
  const addMs = (plannedHours != null ? Number(plannedHours) : 0.5) * 3600 * 1000
  const cutoff = new Date(t); cutoff.setHours(SO_CUTOFF[0], SO_CUTOFF[1], 0, 0)
  if (isWorkingDay(t) && t <= cutoff) return new Date(t.getTime() + addMs)
  const day = nextWorkingDay(t)
  day.setHours(NEXT_DAY_START[0], NEXT_DAY_START[1], 0, 0)
  return new Date(day.getTime() + addMs)
}

// Payment due: bill date + credit days; due din Sunday/holiday ho to agla working day
export function paymentDue(billDate, creditDays) {
  if (!billDate || creditDays == null) return null
  let due = new Date(erpDate(billDate).getTime() + creditDays * 24 * 3600 * 1000)
  if (!isWorkingDay(due)) {
    const day = nextWorkingDay(due)
    day.setHours(due.getHours(), due.getMinutes(), 0, 0)
    due = day
  }
  return due
}

// ---------- ERP timestamp parse ----------
// ERP ke times IST wall-clock hote hain par DB me galat '+00' label ke saath store hain.
// Isliye parse karte waqt timezone suffix hata do — browser local (IST) = wahi wall clock.
// Demo ke naked strings par koi asar nahi. App ke apne timestamps (follow-up dates etc.)
// asli UTC hain — unke liye normal d() hi use hota hai.
export const erpDate = (v) => {
  if (!v) return null
  const dt = new Date(String(v).replace(/(\.\d+)?(\+00(:00)?|Z)$/i, ''))
  return isNaN(dt) ? null : dt
}
export const fmtERP = (v) => fmtDT(erpDate(v))

// ---------- pipeline: planned / actual / delay per stage ----------
const H = 3600 * 1000
const d = (v) => (v ? new Date(v) : null)

export function computePipeline(o, stages, scoring) {
  const res = {}
  let prevRef = erpDate(o.mobile_so_created) // chain reference
  const actualOf = {
    so_convert: erpDate(o.so_convert_date),
    billing: erpDate(o.billing_date),
    gpout: erpDate(o.gpout_created),
    dispatch: erpDate(o.desp_date),
    payment: (o.payment_complete || o.pay_status === 'Full') ? d(o.payment_date) || d(o.pay_last_date) || new Date() : null,
  }
  const now = new Date()
  for (const st of stages.filter((s) => s.active)) {
    let planned = null
    if (st.stage_key === 'so_convert') {
      planned = soConvertPlanned(d(o.mobile_so_created), st.planned_hours)
    } else if (st.stage_key === 'billing') {
      planned = billingPlanned(prevRef, o)
      // stock data na ho to purana chain rule: confirm + planned_hours
      if (!planned && st.planned_hours != null && prevRef) planned = new Date(prevRef.getTime() + Number(st.planned_hours) * H)
    } else if (st.stage_key === 'payment') {
      planned = paymentDue(o.billing_date, o.credit_days)
    } else if (st.use_cutoff) {
      const base = d(o.mobile_so_created)
      if (base) {
        const [ch, cm] = String(st.cutoff_time || '16:00').split(':').map(Number)
        const cut = new Date(base); cut.setHours(ch, cm, 0, 0)
        planned = new Date(base); planned.setHours(23, 59, 0, 0)
        if (base > cut) planned = new Date(planned.getTime() + 24 * H) // next day EOD
      }
    } else if (st.planned_hours != null && prevRef) {
      planned = new Date(prevRef.getTime() + Number(st.planned_hours) * H)
    }
    const actual = actualOf[st.stage_key] ?? null
    let delayH = null, status = 'na'
    if (planned) {
      if (actual) {
        delayH = Math.max(0, (actual - planned) / H)
        status = delayH <= (scoring?.grace_hours ?? 1) ? 'ontime' : 'late'
      } else if (now > planned) {
        delayH = (now - planned) / H
        status = 'running' // still open & already late
      } else {
        status = 'pending'
      }
    } else if (actual) {
      status = 'done'
    }
    res[st.stage_key] = { planned, actual, delayH, status, weight: Number(st.weight) || 1 }
    if (actual) prevRef = actual
    else if (planned) prevRef = planned
  }
  return res
}

export function computeScore(pipe, scoring) {
  const s = { on_time_points: 100, grace_hours: 1, penalty_per_hour: 2, min_points: 0, ...(scoring || {}) }
  let wsum = 0, total = 0, counted = 0
  for (const k of Object.keys(pipe)) {
    const p = pipe[k]
    if (p.status === 'na' || p.status === 'pending') continue
    let pts
    if (p.status === 'ontime' || (p.status === 'done' && !p.delayH)) pts = s.on_time_points
    else pts = Math.min(s.on_time_points, Math.max(s.min_points, s.on_time_points - (p.delayH - s.grace_hours) * s.penalty_per_hour))
    total += pts * p.weight
    wsum += p.weight
    counted++
  }
  if (!counted || !wsum) return null
  return Math.round((total / wsum) * 10) / 10
}

export function fmtDelay(h) {
  if (h == null) return ''
  if (h < 1) return `${Math.round(h * 60)}m`
  if (h < 48) return `${Math.round(h * 10) / 10}h`
  return `${Math.round(h / 24)}d`
}

export function fmtDT(v) {
  if (!v) return '—'
  const dt = new Date(v)
  if (isNaN(dt)) return '—'
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) + ' ' +
    dt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
}

// ---------- sync into supabase ----------
export async function syncOrders(stages, scoring, onMsg) {
  await Promise.all([loadWorkingDays(), loadStock()])
  onMsg?.('ERP se orders fetch ho rahe hain…')
  const raw = await fetchERP('so')
  onMsg?.(`${raw.length} lines mile — aggregate ho raha hai…`)
  const aggregated = aggregateSO(raw)
  // preserve app-side fields: fetch existing payment/custom info
  const { data: existing } = await supabase.from('fms_orders')
    .select('mobile_so_no,payment_complete,payment_date')
  const exMap = new Map((existing || []).map((e) => [e.mobile_so_no, e]))
  const payload = aggregated.map((o) => {
    const ex = exMap.get(o.mobile_so_no)
    const merged = { ...o, payment_complete: ex?.payment_complete || false, payment_date: ex?.payment_date || null }
    const pipe = computePipeline(merged, stages, scoring)
    const delays = {}
    for (const k of Object.keys(pipe)) if (pipe[k].delayH != null) delays[k] = Math.round(pipe[k].delayH * 100) / 100
    const { payment_complete, payment_date, ...syncFields } = merged
    return { ...syncFields, delays, score: computeScore(pipe, scoring), synced_at: new Date().toISOString(), updated_at: new Date().toISOString() }
  })
  onMsg?.(`${payload.length} orders Supabase me save ho rahe hain…`)
  const { error } = await supabase.from('fms_orders').upsert(payload, { onConflict: 'mobile_so_no' })
  if (error) throw error
  return payload.length
}
