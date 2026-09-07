import { supabase, SUPABASE_URL, SUPABASE_ANON } from './supabase'

// ---------- fetch ERP data via edge-function proxy ----------
export async function fetchERP(src) {
  const { data: { session } } = await supabase.auth.getSession()
  const res = await fetch(`${SUPABASE_URL}/functions/v1/fms-proxy?src=${src}`, {
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
  const dt = (v) => v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : ''
  const lines = [`Namaste ${name} 🙏`, `Aapke order (SO #${o.mobile_so_no}, ${dt(o.mobile_so_created)}) ka status:`, '']
  if (o.desp_date) {
    lines.push(`✅ Order dispatch ho chuka hai (${dt(o.desp_date)}).`)
  } else if (o.gpout_created) {
    lines.push(`🚚 Maal gate pass ho gaya hai — dispatch aaj/kal me ho jayega.`)
  } else if (o.billing_date) {
    lines.push(`🧾 Billing ho gayi hai (${dt(o.billing_date)}), dispatch ki taiyari chal rahi hai.`)
  } else if (o.so_convert_date) {
    lines.push(`✅ Order confirm ho gaya hai, billing process me hai.`)
  } else {
    lines.push(`📝 Order receive ho gaya hai, confirm karke jaldi update denge.`)
  }
  if (Number(o.pending_qty) > 0) lines.push(`ℹ️ ${o.pending_qty} qty abhi pending hai, baki dispatch ho chuki/ho rahi hai.`)
  if (o.bill_net_amount) lines.push(`💰 Bill amount: ₹${Number(o.bill_net_amount).toLocaleString('en-IN')}${o.credit_days ? ` (credit ${o.credit_days} din)` : ''}`)
  if ((o.inv_urls || []).length) lines.push(`📄 Invoice: ${o.inv_urls[0]}`)
  lines.push('', 'Koi bhi jankari ke liye humein batayein. Dhanyavaad!', '— Acemark Stationers')
  return lines.join('\n')
}

// Family 'N' = No follow-up: is account ka payment follow-up nahi karna hai
export function noFollowup(o) {
  return String(o.acc_family || '').trim().toUpperCase() === 'N'
}

export function waLink(mobile, text) {
  const m = String(mobile || '').replace(/\D/g, '')
  if (!m) return null
  return `https://wa.me/91${m.slice(-10)}${text ? '?text=' + encodeURIComponent(text) : ''}`
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
    const allHave = (f) => lines.every((l) => l[f] != null && l[f] !== '')
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
      pending_qty: sum('PendingQty'),
      bill_qty: sum('BillQty') || null,
      line_count: lines.length,
      bill_nos: [...billMap.keys()],
      inv_urls: [...billMap.values()].map((b) => b.url),
      bills: [...billMap.values()].map(({ bill_no, billing_date, amt, qty, url, products }) => ({ bill_no, billing_date, amount: amt, qty, url, products })),
      products: lines.map((l) => ({ name: l.ProductName, code: l.ProductCode, qty: l.SO_Qty, pending: l.PendingQty, unit: l.ProdUnit })),
    })
  }
  return out
}

// ---------- pipeline: planned / actual / delay per stage ----------
const H = 3600 * 1000
const d = (v) => (v ? new Date(v) : null)

export function computePipeline(o, stages, scoring) {
  const res = {}
  let prevRef = d(o.mobile_so_created) // chain reference
  const actualOf = {
    so_convert: d(o.so_convert_date),
    billing: d(o.billing_date),
    gpout: d(o.gpout_created),
    dispatch: d(o.desp_date),
    payment: o.payment_complete ? d(o.payment_date) || new Date() : null,
  }
  const now = new Date()
  for (const st of stages.filter((s) => s.active)) {
    let planned = null
    if (st.stage_key === 'payment') {
      const bill = d(o.billing_date)
      if (bill && o.credit_days != null) planned = new Date(bill.getTime() + o.credit_days * 24 * H)
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
