import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { buildCollectionMsg, waLink, logWaSendParty, suggestNextFollowup } from '../lib/fms'
import MultiSelect from './MultiSelect'

// Collection tab: poore ledger ka party-wise outstanding (fms_collection, har ghante ERP se sync)
// + follow-up system (fms_followups): stage, bills, commitment, transfer, permanent note
// + ERP receipts (fms_receipts, Payment.ashx voucher-wise) — paisa aaya ya nahi ERP batata hai, manual entry sirf "claim".
// Design goal: naya CRM executive bina training ke chala le — sabse zaroori party UPAR,
// har row par seedha Call/WhatsApp/Note, aur ek-click filter chips.
const BUCKETS = [
  ['b0_30', '0-30'], ['b31_60', '31-60'], ['b61_90', '61-90'], ['b91_120', '91-120'],
  ['b121_150', '121-150'], ['b151_180', '151-180'], ['b180p', '180+'],
]
const inr = (v) => '₹' + Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })
// bade amounts chhote me: 12.5L, 1.2Cr — naye banda ko ek nazar me samajh aaye
const inrShort = (v) => {
  const n = Number(v || 0)
  if (n >= 1e7) return '₹' + (n / 1e7).toFixed(2).replace(/\.?0+$/, '') + ' Cr'
  if (n >= 1e5) return '₹' + (n / 1e5).toFixed(1).replace(/\.0$/, '') + ' L'
  return inr(n)
}
const dmy = (v) => v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'
const dmyt = (v) => v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'
const pad = (n) => String(n).padStart(2, '0')
const isoDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const toLocalInput = (dt) => `${isoDay(dt)}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`
const startOfDay = (v) => { const d = new Date(v); d.setHours(0, 0, 0, 0); return d }
// kitne din baad/pehle (date-only): -1 = kal beet gaya, 0 = aaj, 1 = kal
const dayDiff = (v) => Math.round((startOfDay(v) - startOfDay(new Date())) / 864e5)
const normKey = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')
const userName = (e) => String(e || '').split('@')[0]

const isCross = (p) => Number(p.credit_limit) > 0 && Number(p.total_pending) > Number(p.credit_limit)
const isUrgent = (p) => (p.oldest_od || 0) > 180 || isCross(p)

// ---------- follow-up stages (form dropdown) ----------
const STAGES = ['Committed', 'Payment received', 'PDC received', 'Dispute', 'No response', 'CRM Support', 'Transfer', 'Close']
const STAGE_CLS = {
  'Committed': 'st-commit', 'Payment received': 'st-recv', 'PDC received': 'st-recv', 'Dispute': 'st-bad',
  'No response': 'st-bad', 'CRM Support': 'st-park', 'Transfer': 'st-park', 'Close': 'st-close',
}
const STAGE_HINT = {
  'Committed': 'Party promised to pay — enter the amount and the date they promised',
  'Payment received': 'Party says money is sent — enter amount + mode. ERP sync (hourly) confirms it against the bills',
  'PDC received': 'Post-dated cheque received — enter amount, mode = Cheque/PDC',
  'Dispute': 'Party disputes the bill (rate / damage / short supply) — write details',
  'No response': 'Phone not picked / switched off — set the next date',
  'CRM Support': 'Needs office help (ledger, credit note) — party leaves the Missed list until resolved',
  'Transfer': 'Hand this party to another salesman — pick the name and give the reason',
  'Close': 'Nothing more to chase (fully paid / written off) — party leaves Today & Tomorrow lists',
}
const PAY_MODES = ['RTGS/NEFT', 'UPI', 'Cash', 'Cheque', 'PDC', 'Other']

// ---------- follow-up status buckets (from next_followup_date + latest stage) ----------
const BUCKET_LABEL = { missed: 'Missed', today: 'Today', tomorrow: 'Tomorrow', week: 'This week', later: 'Later', nodate: 'No date', closed: 'Closed' }
const BUCKET_CLS = { missed: 'bk-missed', today: 'bk-today', tomorrow: 'bk-tom', week: 'bk-week', later: 'bk-later', nodate: 'bk-none', closed: 'bk-closed' }
function bucketOf(p, ag) {
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
function isBroken(ag) {
  const c = ag.committed
  if (!c || ag.lastStage === 'Close') return false
  if (dayDiff(c.date) >= 0) return false
  const cAt = new Date(c.at)
  if (ag.entries.some((f) => Number(f.amount_received) > 0 && new Date(f.created_at) > cAt)) return false
  const cDay = String(c.at).slice(0, 10)
  return !ag.receipts.some((r) => r.pay_date && r.pay_date >= cDay)
}

const EMPTY_AGG = { entries: [], waCount: 0, count: 0, last: null, lastStage: '', doneToday: false, committed: null, transferTo: '', transferReason: '', paid: new Map(), recvTotal: 0, receipts: [] }
// fms_followups (party-level) + fms_receipts -> per party summary. Entries created_at DESC aate hain.
function buildAgg(fups, receipts) {
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
function priorityOf(p, ag, bucket) {
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

// Ek-click filter chips — do groups: follow-up status + situation
const STATUS_PRESETS = [
  { key: 'all', label: 'All' }, { key: 'missed', label: '⏰ Missed' }, { key: 'today', label: '📅 Today' },
  { key: 'tomorrow', label: 'Tomorrow' }, { key: 'week', label: 'This week' }, { key: 'nodate', label: 'No date' },
]
const SITUATION_PRESETS = [
  { key: 'broken', label: '💔 Broken promise' }, { key: 'hot', label: '🔴 Urgent (180+/limit)' }, { key: 'warm', label: '🟠 90+ days' },
  { key: 'committed', label: '🤝 Committed / PDC' }, { key: 'pdc', label: '🧾 PDC received' }, { key: 'flw5', label: '🔁 5+ follow-ups' },
  { key: 'received', label: '💵 Received (range)' }, { key: 'transferred', label: '↪ Transferred' }, { key: 'closed', label: '✅ Closed' }, { key: 'excluded', label: '🚫 Excluded' },
]

function AgingChips({ aging }) {
  const a = aging || {}
  const cls = ['bkt-ok', 'bkt-ok', 'bkt-8', 'bkt-8', 'bkt-30', 'bkt-30', 'bkt-30']
  const chips = BUCKETS.map(([k, label], i) => ({ k, label, i, v: Number(a[k] || 0) })).filter((c) => c.v > 0)
  if (!chips.length) return <span className="muted small">—</span>
  return (
    <div className="aging-chips">
      {chips.map((c) => (
        <span key={c.k} className={`age-chip ${cls[c.i]}`} title={`${c.label} days old: ${inr(c.v)}`}>{c.label}d: {inrShort(c.v)}</span>
      ))}
    </div>
  )
}

function LimitBar({ pending, limit }) {
  if (!Number(limit)) return <span className="muted small">no limit set</span>
  const pct = (Number(pending) / Number(limit)) * 100
  const over = pct > 100
  return (
    <div className="limit-bar-wrap" title={`Pending ${inr(pending)} / Limit ${inr(limit)} (${Math.round(pct)}% used)`}>
      <div className="limit-bar"><div className={over ? 'limit-fill over' : 'limit-fill'} style={{ width: Math.min(pct, 100) + '%' }} /></div>
      <span className={over ? 'small red-t' : 'small muted'}>{Math.round(pct)}%{over && ' ⚠️'}</span>
    </div>
  )
}

const StageChip = ({ s }) => s ? <span className={`stage-chip ${STAGE_CLS[s] || ''}`}>{s}</span> : null
const BucketPill = ({ b, date }) => <span className={`bk-pill ${BUCKET_CLS[b]}`}>{BUCKET_LABEL[b]}{date && b !== 'nodate' && b !== 'closed' ? ' · ' + dmy(date) : ''}</span>

// ---------- follow-up timeline (party ki poori baat-cheet) ----------
function Timeline({ entries, waCount }) {
  if (!entries.length && !waCount) return <p className="muted small">No conversation recorded with this party yet — you are the first to call.</p>
  return (
    <div className="tl">
      {waCount > 0 && <div className="muted small" style={{ marginBottom: 4 }}>📤 {waCount} WhatsApp reminder{waCount > 1 ? 's' : ''} sent (auto-logged)</div>}
      {entries.map((f) => (
        <div key={f.id} className="tl-item">
          <div className="tl-dot" />
          <div className="tl-body">
            <div className="tl-top">
              <b>{dmyt(f.created_at)}</b>
              <StageChip s={f.stage} />
              {Number(f.amount_received) > 0 && <span className="stage-chip st-recv">{inr(f.amount_received)} received{f.payment_mode ? ' · ' + f.payment_mode : ''}</span>}
              {f.committed_date && <span className="stage-chip st-commit">Promised {inr(f.committed_amount)} by {dmy(f.committed_date)}</span>}
              {f.transfer_to && <span className="stage-chip st-park">↪ to {f.transfer_to}{f.transfer_reason ? ' — ' + f.transfer_reason : ''}</span>}
              {f.created_by && <span className="muted small">— {userName(f.created_by)}</span>}
            </div>
            <div className="tl-says">{f.remarks || <span className="muted">(nothing written)</span>}</div>
            {Array.isArray(f.bill_nos) && f.bill_nos.length > 0 && <div className="tl-bills">Bills: {f.bill_nos.join(', ')}</div>}
          </div>
        </div>
      ))}
    </div>
  )
}

// ---------- ERP receipts (Payment.ashx) — kab, kaunse voucher se, kitna, kin bills par ----------
function Receipts({ list }) {
  const [all, setAll] = useState(false)
  if (!list.length) return <p className="muted small">No receipt found in ERP for this party (Payment.ashx covers bills from Jan 2026).</p>
  const shown = all ? list : list.slice(0, 8)
  return (
    <div className="tbl-wrap-inner">
      <table className="cfg-tbl rcpt-tbl">
        <thead><tr><th>Date</th><th>Voucher</th><th>Type</th><th>Amount</th><th>Adjusted against</th></tr></thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.company_id + '|' + r.pay_vno}>
              <td>{dmy(r.pay_date)}</td>
              <td className="small"><b>{r.pay_vno}</b></td>
              <td className="small">{r.pay_type || '—'}</td>
              <td><b className="green-t">{inr(r.amount)}</b></td>
              <td className="small">{(r.bills || []).map((b, i) => <span key={i} className="bill-tag static" title={inr(b.amt)}>{b.vno}</span>)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.length > 8 && <button className="link small" onClick={() => setAll((v) => !v)}>{all ? 'Show less' : `Show all ${list.length} receipts`}</button>}
    </div>
  )
}

// ---------- Follow-up form (chhota modal): bill-wise ya party-level ----------
// bills = [{ vno, pending }] jin par ye note hai (khali = poora account)
function FollowupForm({ p, bills, salesmen, demo, onClose, onSaved }) {
  const [stage, setStage] = useState('')
  const [remark, setRemark] = useState('')
  const [amount, setAmount] = useState('')
  const [payMode, setPayMode] = useState('')
  const [cAmt, setCAmt] = useState('')
  const [cDate, setCDate] = useState('')
  const [tTo, setTTo] = useState('')
  const [tReason, setTReason] = useState('')
  const [nextDate, setNextDate] = useState(() => toLocalInput(suggestNextFollowup()))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const billSum = bills.reduce((a, b) => a + Number(b.pending || 0), 0)
  const scope = bills.length === 0 ? 'whole account' : bills.length === 1 ? `bill ${bills[0].vno} · ${inr(bills[0].pending)} pending` : `${bills.length} bills · ${inr(billSum)} pending`

  // Committed: date default = next follow-up date; amount default = in bills ka pending
  const pickStage = (s) => {
    setStage(s)
    if (s === 'Committed') { if (!cDate && nextDate) setCDate(nextDate.slice(0, 10)); if (!cAmt && billSum) setCAmt(String(Math.round(billSum))) }
    if (s === 'Payment received' && !amount && billSum) setAmount(String(Math.round(billSum)))
  }

  const save = async () => {
    if (!stage) { setErr('Pick a Stage first — what happened on this call?'); return }
    if (!remark.trim()) { setErr('Write what was discussed'); return }
    if (stage === 'Committed' && !(Number(cAmt) > 0 && cDate)) { setErr('Committed stage needs the promised amount and date'); return }
    if (stage === 'Payment received' && !(Number(amount) > 0)) { setErr('Payment received — enter the amount'); return }
    if (Number(amount) > 0 && !payMode) { setErr('Pick the payment mode for the amount received'); return }
    if (stage === 'Transfer' && !tTo.trim()) { setErr('Transfer — pick the salesman to hand over to'); return }
    if (stage !== 'Close' && !nextDate) { setErr('Set the next follow-up date'); return }
    if (demo) { setErr('Demo mode cannot save — use the real login'); return }
    setSaving(true); setErr('')
    const { data: { user } } = await supabase.auth.getUser()
    const { error: e1 } = await supabase.from('fms_followups').insert({
      party_name: p.party_name, remarks: remark.trim(), mode: 'call', stage,
      amount_received: Number(amount) > 0 ? Number(amount) : null,
      payment_mode: Number(amount) > 0 ? payMode : null,
      bill_nos: bills.map((b) => b.vno),
      committed_amount: stage === 'Committed' ? Number(cAmt) : null,
      committed_date: stage === 'Committed' ? cDate : null,
      transfer_to: stage === 'Transfer' ? tTo.trim() : null,
      transfer_reason: stage === 'Transfer' ? tReason.trim() || null : null,
      followup_date: isoDay(),
      created_by: user?.email || '',
    })
    const { error: e2 } = await supabase.from('fms_collection')
      .update({ next_followup_date: stage === 'Close' ? null : new Date(nextDate).toISOString() }).eq('party_name', p.party_name)
    setSaving(false)
    if (e1 || e2) { setErr('Save failed: ' + (e1 || e2).message); return }
    onSaved?.(stage === 'Close' ? '✅ Saved — party closed, it leaves the Today/Tomorrow lists.'
      : stage === 'Transfer' ? `✅ Saved — this party now shows under ${tTo.trim()} as well.`
      : stage === 'Payment received' ? '✅ Saved as claimed — the hourly ERP sync will confirm it against the bills.'
      : '✅ Saved! On that date this party will appear under "Today".')
    onClose()
  }

  return (
    <div className="modal-back fup-back" onClick={onClose}>
      <div className="modal fup-modal2" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h3>📝 Follow-up — {p.party_name}</h3>
            <p className="muted small" style={{ margin: '2px 0 0' }}>For: <b>{scope}</b>{bills.length > 1 && <> · {bills.map((b) => b.vno).join(', ')}</>}</p>
          </div>
          <button className="btn ghost" onClick={onClose}>✕</button>
        </div>
        <div className="fup2-grid">
          <div className="step-form">
            <b>What happened?</b>
            <select value={stage} onChange={(e) => pickStage(e.target.value)} autoFocus>
              <option value="">Stage — pick one…</option>
              {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            {stage && <span className="muted small stage-hint">{STAGE_HINT[stage]}</span>}
            <input placeholder='What did they say? e.g. "Will pay by RTGS on the 5th"' value={remark} onChange={(e) => setRemark(e.target.value)} />
          </div>
          <div className="step-form">
            <b>Details</b>
            {stage === 'Committed' && <div className="fld-row">
              <input type="number" placeholder="Promised amount ₹" value={cAmt} onChange={(e) => setCAmt(e.target.value)} />
              <input type="date" value={cDate} title="Promised date" onChange={(e) => setCDate(e.target.value)} />
            </div>}
            {stage === 'Transfer' && <div className="fld-row">
              <input list="coll-salesmen" placeholder="Transfer to (salesman)" value={tTo} onChange={(e) => setTTo(e.target.value)} />
              <datalist id="coll-salesmen">{salesmen.map((s) => <option key={s} value={s} />)}</datalist>
              <input placeholder="Reason" value={tReason} onChange={(e) => setTReason(e.target.value)} />
            </div>}
            <div className="fld-row">
              <input type="number" placeholder="Amount received now (blank if none)" value={amount} onChange={(e) => setAmount(e.target.value)} />
              {Number(amount) > 0 && <select value={payMode} onChange={(e) => setPayMode(e.target.value)}>
                <option value="">Mode…</option>{PAY_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>}
            </div>
            <span className="muted small">Amount is a claim — ERP receipt confirms it and splits it across bills automatically.</span>
          </div>
          <div className="step-form">
            <b>When to remind next?</b>
            <input type="datetime-local" value={nextDate} disabled={stage === 'Close'} onChange={(e) => setNextDate(e.target.value)} />
            {stage === 'Close' && <span className="muted small">Close = no next date; party leaves the worklist.</span>}
            <button className="btn primary" onClick={save} disabled={saving}>{saving ? '⏳ Saving…' : '💾 Save'}</button>
            {err && <span className="err small" style={{ marginTop: 0 }}>{err}</span>}
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------- Party modal body: actions, bills (bill-wise 📝), ERP receipts, history + permanent note ----------
function PartyDetail({ p, ag, demo, salesmen, onSaved }) {
  const [selBills, setSelBills] = useState([])
  const [form, setForm] = useState(null)      // null | { bills: [{vno, pending}] }
  const [okMsg, setOkMsg] = useState('')
  const [err, setErr] = useState('')
  const [noteOpen, setNoteOpen] = useState(false)
  const [note, setNote] = useState(p.permanent_note || '')

  const wa = waLink(p.mobile, buildCollectionMsg(p))
  const overdueBills = (p.bills || []).filter((b) => (b.od || 0) > 0)
  const toggleBill = (v) => setSelBills((s) => (s.includes(v) ? s.filter((x) => x !== v) : [...s, v]))
  const billObj = (vno) => { const b = overdueBills.find((x) => x.vno === vno); return { vno, pending: b ? (b.pending ?? b.amt) : 0 } }
  const openForm = (vnos) => setForm({ bills: vnos.map(billObj) })
  const saved = (msg) => { setOkMsg(msg); setSelBills([]); setTimeout(() => setOkMsg(''), 6000); onSaved?.() }

  const saveNote = async (clear) => {
    if (demo) { setErr('Demo mode cannot save — use the real login'); return }
    const { data: { user } } = await supabase.auth.getUser()
    const { error } = await supabase.from('fms_collection').update({
      permanent_note: clear ? null : note.trim() || null, note_updated_by: user?.email || '', note_updated_at: new Date().toISOString(),
    }).eq('party_name', p.party_name)
    if (error) { setErr('Note save failed: ' + error.message); return }
    if (clear) setNote('')
    setNoteOpen(false); onSaved?.()
  }

  // bills table ke filters: firm-wise + aging-wise (multi-select) + PDC + paid toggle
  const [fFirms, setFFirms] = useState([])
  const [fAges, setFAges] = useState([])
  const [fPdc, setFPdc] = useState('')
  const [showPaid, setShowPaid] = useState(false)
  const AGE_OPTS = ['1-30', '31-60', '61-90', '91-120', '121-150', '151-180', '180+']
  const ageBucket = (od) => od <= 30 ? '1-30' : od <= 60 ? '31-60' : od <= 90 ? '61-90' : od <= 120 ? '91-120' : od <= 150 ? '121-150' : od <= 180 ? '151-180' : '180+'
  const firmOpts = [...new Set(overdueBills.map((b) => String(b.company || '').trim()).filter(Boolean))].sort()
  const today = isoDay()
  const hasPdc = (b) => !!(b.pdc_rcpt || b.pdc_date)
  // paid state: 'erp' = ERP Full (ERP list se agle sync me hatega) | 'claimed' = note me received likha, ERP me abhi nahi
  const paidState = (b) => b.pay_status === 'Full' ? 'erp' : ag.paid.has(b.vno) ? 'claimed' : ''
  const paidN = overdueBills.filter((b) => paidState(b)).length
  const shownBills = overdueBills.filter((b) =>
    (showPaid || !paidState(b)) &&
    (!fFirms.length || fFirms.includes(String(b.company || '').trim())) &&
    (!fAges.length || fAges.includes(ageBucket(b.od || 0))) &&
    (!fPdc || (fPdc === 'none' ? !hasPdc(b) : hasPdc(b) && b.pdc_date && (fPdc === 'today' ? b.pdc_date === today : fPdc === 'up' ? b.pdc_date > today : b.pdc_date < today))))
  const hotN = shownBills.filter((b) => (b.od || 0) >= 60).length
  const filtersOn = fFirms.length > 0 || fAges.length > 0 || fPdc
  const selSum = selBills.reduce((a, v) => a + Number(billObj(v).pending || 0), 0)

  const erpCell = (b) => {
    const claimed = ag.paid.get(b.vno)
    if (b.pay_status === 'Full') return <span className="green-t small">✅ Full{b.last_pay_date ? ' · ' + dmy(b.last_pay_date) : ''}</span>
    if (b.pay_status === 'Part') return <span className="small"><b className="green-t">Part {inr(b.received)}</b>{claimed ? <div className="amber-t">claimed {inr(claimed.amount)} {dmy(claimed.at)}</div> : b.last_pay_date ? <div className="muted">{dmy(b.last_pay_date)}</div> : null}</span>
    if (claimed) return <span className="amber-t small" title="Logged as received in a note; ERP has not shown a receipt yet — check after the next hourly sync">⚠ claimed {dmy(claimed.at)}<div>not in ERP yet</div></span>
    return <span className="muted small">—</span>
  }

  return (
    <div className="coll-detail">
      <div className="coll-actbar">
        {p.mobile && <a className="btn primary sm" href={`tel:${p.mobile}`}>📞 Call {p.mobile}</a>}
        {wa && <a className="wa-btn" href={wa} target="_blank" rel="noreferrer"
          onClick={() => { logWaSendParty(p.party_name, 'Sent WhatsApp payment reminder'); setTimeout(() => onSaved?.(), 800) }}>📤 Send WhatsApp</a>}
        {!p.mobile && <span className="muted small">No mobile number — ask salesman {p.salesman || ''}</span>}
        <button className="btn ghost sm" onClick={() => openForm([])} title="Note about the whole account (no specific bill)">📝 Follow-up (whole account)</button>
        <button className="btn ghost sm" title="Permanent note: e.g. legal case, party closed — removes party from the worklist" onClick={() => setNoteOpen((v) => !v)}>
          {p.permanent_note ? '🚫 Edit note' : '🚫 Exclude / note'}
        </button>
        <span className="muted small ask" title={`Ask: "Total ${inrShort(p.total_pending)} is pending${p.oldest_od ? `, oldest bill ${p.oldest_od} days overdue` : ''} — when can we expect the payment?"`}>Ask: "Total {inrShort(p.total_pending)} is pending{p.oldest_od ? `, oldest bill ${p.oldest_od} days overdue` : ''} — when can we expect the payment?"</span>
      </div>
      {(ag.committed || ag.transferTo || p.permanent_note || okMsg || err) && (
        <div className="coll-flags">
          {ag.committed && <span className={`stage-chip ${isBroken(ag) ? 'st-bad' : 'st-commit'}`}>{isBroken(ag) ? '💔 Broken promise: ' : '🤝 Promised: '}{inr(ag.committed.amount)} by {dmy(ag.committed.date)} <span className="muted">({userName(ag.committed.by)})</span></span>}
          {ag.transferTo && <span className="stage-chip st-park">↪ Transferred to {ag.transferTo}{ag.transferReason ? ' — ' + ag.transferReason : ''}</span>}
          {p.permanent_note && <span className="stage-chip st-bad">🚫 Excluded: {p.permanent_note}</span>}
          {okMsg && <span className="green-t small"><b>{okMsg}</b></span>}
          {err && <span className="err small" style={{ margin: 0 }}>{err}</span>}
        </div>
      )}
      {noteOpen && (
        <div className="note-box">
          <textarea rows={2} placeholder="Why should this party stay out of the worklist? (legal case, disputed, account closed…)" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="fld-row">
            <button className="btn primary sm" onClick={() => saveNote(false)} disabled={!note.trim()}>Save note (exclude)</button>
            {p.permanent_note && <button className="btn ghost sm" onClick={() => saveNote(true)}>Remove note (bring back)</button>}
            <button className="btn ghost sm" onClick={() => setNoteOpen(false)}>Cancel</button>
          </div>
          {p.permanent_note && p.note_updated_by && <span className="muted small">Set by {userName(p.note_updated_by)} on {dmy(p.note_updated_at)}</span>}
        </div>
      )}

      <div className="coll-bills">
        {/* sirf DUE/OVERDUE bills dikhate hain — jo abhi credit period ke andar hain wo exclude */}
        <h4>🧾 Overdue bills ({overdueBills.length} of {(p.bills || []).length} pending){hotN > 0 && <span className="hot-lgd">{hotN} bill{hotN > 1 ? 's' : ''} 60+ days overdue</span>}
          <span className="muted small" style={{ fontWeight: 400, marginLeft: 8 }}>— click 📝 on a bill to note a call about it, or tick several bills</span></h4>
        <div className="coll-bill-filters">
          <MultiSelect label="Firm" options={firmOpts} value={fFirms} onChange={setFFirms} />
          <MultiSelect label="Aging" options={AGE_OPTS.map((a) => ({ key: a, label: a + ' days' }))} value={fAges} onChange={setFAges} />
          <select value={fPdc} onChange={(e) => setFPdc(e.target.value)} title="Filter by post-dated cheque date">
            <option value="">PDC: All</option><option value="today">PDC today</option><option value="up">PDC upcoming</option><option value="due">PDC date passed</option><option value="none">No PDC</option>
          </select>
          {paidN > 0 && <label className="small chk"><input type="checkbox" checked={showPaid} onChange={(e) => setShowPaid(e.target.checked)} /> Show {paidN} paid / claimed</label>}
          {filtersOn && <>
            <button className="btn ghost sm" onClick={() => { setFFirms([]); setFAges([]); setFPdc('') }}>✕ Clear</button>
            <span className="filter-count active">🔎 {shownBills.length} / {overdueBills.length} bills</span>
          </>}
          {selBills.length > 0 && (
            <span className="sel-bar">
              <b>{selBills.length} bill{selBills.length > 1 ? 's' : ''} selected · {inr(selSum)}</b>
              <button className="btn primary sm" onClick={() => openForm(selBills)}>📝 Follow-up for these</button>
              <button className="btn ghost sm" onClick={() => setSelBills([])}>✕</button>
            </span>
          )}
        </div>
        <div className="tbl-wrap-inner">
          <table className="cfg-tbl coll-bill-tbl">
            <thead><tr><th title="Tick to select several bills for one note">✓</th><th>Bill No</th><th>Firm</th><th>Bill Date</th><th>Age</th><th>Pending</th><th title="From ERP Payment.ashx: Full / Part received, or your claimed amount awaiting ERP">ERP paid</th><th>PDC (cheque)</th><th>Bilty</th><th>Notes</th><th></th></tr></thead>
            <tbody>
              {shownBills.slice(0, 100).map((b, i) => {
                const ps = paidState(b)
                const cls = [ps ? 'coll-paid' : '', b.od > 180 ? 'coll-old' : b.od >= 60 ? 'coll-hot' : '', selBills.includes(b.vno) ? 'coll-sel' : ''].join(' ')
                return (
                  <tr key={i} className={cls} onClick={() => b.vno && toggleBill(b.vno)}>
                    <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={selBills.includes(b.vno)} disabled={!b.vno} onChange={() => toggleBill(b.vno)} /></td>
                    <td><b>{b.vno || '—'}</b></td>
                    <td className="small">{b.company || '—'}</td>
                    <td>{dmy(b.date)}</td>
                    {/* summary-shape bill (vno nahi) me sirf bill ki umar pata hoti hai — "not due yet" mat likho */}
                    <td>{b.od > 0 ? <span className={b.od > 90 ? 'red-t' : 'amber-t'}><b>{b.od} days overdue</b></span>
                      : <span className="muted small">{b.days != null ? (b.vno ? `${b.days} days (not due yet)` : `${b.days} days old`) : '—'}</span>}</td>
                    <td><b>{inr(b.pending ?? b.amt)}</b>{b.pay_status === 'Part' && b.still_pending != null && Math.round(b.still_pending) !== Math.round(b.pending ?? b.amt) && <div className="muted small">ERP: {inr(b.still_pending)}</div>}</td>
                    <td onClick={(e) => e.stopPropagation()}>{erpCell(b)}</td>
                    <td className="small">{hasPdc(b) ? <span className={b.pdc_date && b.pdc_date < today ? 'red-t' : b.pdc_date === today ? 'amber-t' : ''}>✅ {b.pdc_rcpt || ''} {dmy(b.pdc_date)}</span> : '—'}</td>
                    <td className="small">{b.bilty || '—'}</td>
                    <td className="small coll-notes" title={b.notes || ''}>{b.notes || '—'}</td>
                    <td onClick={(e) => e.stopPropagation()}>{b.vno && <button className="btn ghost sm" title={`Follow-up note for ${b.vno}`} onClick={() => openForm([b.vno])}>📝</button>}</td>
                  </tr>
                )
              })}
              {!overdueBills.length && (
                <tr><td colSpan={11} className="muted">No overdue bills — all pending bills are still within their credit period.</td></tr>
              )}
              {overdueBills.length > 0 && !shownBills.length && (
                <tr><td colSpan={11} className="muted">{paidN && !filtersOn ? 'All overdue bills are paid / claimed — tick "Show paid / claimed" to see them.' : 'No bills match this filter.'}</td></tr>
              )}
              {shownBills.length > 100 && (
                <tr><td colSpan={11} className="muted small">…and {shownBills.length - 100} more overdue bills (oldest 100 shown above)</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="coll-fup">
        <div className="coll-rcpts">
          <h4>💵 Receipts from ERP {ag.receipts.length ? `(${ag.receipts.length})` : ''} <span className="muted small" style={{ fontWeight: 400 }}>— voucher-wise, synced hourly</span></h4>
          <Receipts list={ag.receipts} />
        </div>
        <div className="fup-log">
          <div className="fup-log-head"><h4>🗒️ Conversation history {ag.count ? `(${ag.count})` : ''}</h4></div>
          <Timeline entries={ag.entries} waCount={ag.waCount} />
        </div>
      </div>

      {form && <FollowupForm p={p} bills={form.bills} salesmen={salesmen} demo={demo} onClose={() => setForm(null)} onSaved={saved} />}
    </div>
  )
}

// ---------- table columns (⚙ Columns se show/hide, localStorage me yaad) ----------
const COLS = [
  { key: 'total_pending', label: 'Total Pending', on: true, sort: 'total_pending' },
  { key: 'oldest_od', label: 'Oldest Due', on: true, sort: 'oldest_od', title: 'How many days the oldest bill is overdue' },
  { key: 'aging', label: 'Aging', on: true, title: 'How old the money is — green is new, red is very old' },
  { key: 'credit_limit', label: 'Credit Limit', on: true, title: 'Credit limit given to the party and how much is used' },
  { key: 'last_pay', label: 'Last Payment', on: true, title: 'Last receipt in ERP' },
  { key: 'next', label: 'Next F/Up', on: true, sort: 'next' },
  { key: 'flw', label: 'Follow-ups', on: true, sort: 'flw', title: 'How many times this party has been chased' },
  { key: 'stage', label: 'Last Stage', on: true },
  { key: 'committed', label: 'Committed', on: true, sort: 'committed' },
  { key: 'remark', label: 'Last Remark', on: false },
  { key: 'transfer', label: 'Transferred to', on: false },
  { key: 'city', label: 'City', on: false }, { key: 'beat', label: 'Beat', on: false },
]
const COLS_LS = 'fms_coll_cols'
const loadCols = () => { try { const v = JSON.parse(localStorage.getItem(COLS_LS) || 'null'); if (v && typeof v === 'object') return v } catch { /* ignore */ } return {} }

// Supabase ek call me max 1000 rows deta hai — page-wise lao
async function fetchAll(table, cols, apply) {
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
const FUP_COLS = 'id,party_name,stage,payment_mode,bill_nos,committed_amount,committed_date,transfer_to,transfer_reason,remarks,amount_received,mode,created_by,created_at'
const RCPT_COLS = 'company_id,pay_vno,party_name,pay_date,pay_type,amount,bills'

export default function Collection() {
  const demo = new URLSearchParams(window.location.search).has('demo')
  const [rows, setRows] = useState(null)
  const [fups, setFups] = useState([])
  const [rcpts, setRcpts] = useState([])
  const [q, setQ] = useState('')
  const [salesman, setSalesman] = useState('')
  const [preset, setPreset] = useState('all')
  const [sort, setSort] = useState(['priority', 'desc'])
  const [open, setOpen] = useState(null) // party_name jo expand hai
  const [tick, setTick] = useState(0)
  const [showHelp, setShowHelp] = useState(() => !localStorage.getItem('fms_coll_help_seen'))
  const [colVis, setColVis] = useState(loadCols)
  const [colPanel, setColPanel] = useState(false)
  // Pulse date range — default: is mahine
  const [from, setFrom] = useState(() => { const n = new Date(); return isoDay(new Date(n.getFullYear(), n.getMonth(), 1)) })
  const [to, setTo] = useState(() => isoDay())

  useEffect(() => {
    if (demo) {
      // demo mode me DB access nahi hai — sample data dikhao taaki tab samajh aaye
      fetch('/demo-collection.json').then((r) => r.json()).then(setRows).catch(() => setRows([]))
      return
    }
    Promise.all([
      supabase.from('fms_collection').select('*'),
      fetchAll('fms_followups', FUP_COLS, (x) => x.not('party_name', 'is', null).order('created_at', { ascending: false })),
      fetchAll('fms_receipts', RCPT_COLS, (x) => x.order('pay_date', { ascending: false, nullsFirst: false })),
    ]).then(([{ data }, f, r]) => { setRows(data || []); setFups(f); setRcpts(r) })
  }, [tick, demo])

  const agg = useMemo(() => buildAgg(fups, rcpts), [fups, rcpts])
  const agOf = (p) => agg.get(normKey(p.party_name)) || EMPTY_AGG

  const salesmen = useMemo(() => {
    const s = new Set((rows || []).map((r) => r.salesman).filter(Boolean))
    agg.forEach((a) => { if (a.transferTo) s.add(a.transferTo) })
    return [...s].sort()
  }, [rows, agg])
  // modal ke liye: save/re-sync ke baad bhi fresh row mile
  const openParty = useMemo(() => (rows || []).find((r) => r.party_name === open) || null, [rows, open])

  // Pulse: chuni range me ERP receipts (asli paisa) + logged follow-ups, kisne kitne kiye
  const inRange = (iso) => { const d = String(iso || '').slice(0, 10); return (!from || d >= from) && (!to || d <= to) }
  const pulse = useMemo(() => {
    const r = { erp: 0, erpN: 0, logged: 0, done: 0, byUser: {}, recvParties: new Set() }
    for (const x of rcpts) {
      if (!x.pay_date || !inRange(x.pay_date)) continue
      r.erp += Number(x.amount || 0); r.erpN++; r.recvParties.add(normKey(x.party_name))
    }
    for (const f of fups) {
      if (f.mode === 'whatsapp' || !inRange(f.created_at)) continue
      r.done++
      const u = userName(f.created_by) || '?'; r.byUser[u] = (r.byUser[u] || 0) + 1
      if (Number(f.amount_received) > 0) { r.logged += Number(f.amount_received); r.recvParties.add(normKey(f.party_name)) }
    }
    return r
  }, [fups, rcpts, from, to]) // eslint-disable-line react-hooks/exhaustive-deps

  // har party ka derived data ek baar (filter/sort/KPI sab isi se)
  const enriched = useMemo(() => (rows || []).map((p) => {
    const ag = agOf(p); const bucket = bucketOf(p, ag)
    return { p, ag, bucket, pr: priorityOf(p, ag, bucket), broken: isBroken(ag) }
  }), [rows, agg]) // eslint-disable-line react-hooks/exhaustive-deps

  const kpi = useMemo(() => {
    const live = enriched.filter((e) => !e.p.permanent_note)
    const sum = (list) => list.reduce((a, e) => a + Number(e.p.total_pending || 0), 0)
    const missed = live.filter((e) => e.bucket === 'missed')
    return {
      total: sum(live), parties: live.length,
      missed: missed.length, missedAmt: sum(missed),
      due: live.filter((e) => e.bucket === 'today').length,
      broken: live.filter((e) => e.broken).length,
      hot: live.filter((e) => isUrgent(e.p)).length,
      old180: live.reduce((a, e) => a + Number(e.p.aging?.b180p || 0), 0),
      commit: live.filter((e) => (e.ag.committed && !e.broken) || e.p.has_pdc || e.ag.lastStage === 'PDC received').length,
      flw5: live.filter((e) => e.ag.count >= 5).length,
      excluded: enriched.length - live.length,
    }
  }, [enriched])

  const filtered = useMemo(() => {
    let list = enriched
    if (preset === 'excluded') list = list.filter((e) => e.p.permanent_note)
    else list = list.filter((e) => !e.p.permanent_note)   // permanent note wali parties worklist se bahar
    const s = q.trim().toLowerCase()
    if (s) list = list.filter(({ p }) => `${p.party_name} ${p.mobile || ''} ${p.city || ''} ${p.salesman || ''}`.toLowerCase().includes(s))
    // salesman filter: apni parties + jo transfer hoke aayi
    if (salesman) list = list.filter((e) => e.p.salesman === salesman || e.ag.transferTo === salesman)
    switch (preset) {
      case 'missed': case 'today': case 'tomorrow': case 'week': case 'nodate': case 'closed': list = list.filter((e) => e.bucket === preset); break
      case 'broken': list = list.filter((e) => e.broken); break
      case 'hot': list = list.filter((e) => isUrgent(e.p)); break
      case 'warm': list = list.filter((e) => (e.p.oldest_od || 0) > 90); break
      case 'committed': list = list.filter((e) => (e.ag.committed && !e.broken) || e.p.has_pdc || e.ag.lastStage === 'PDC received'); break
      case 'pdc': list = list.filter((e) => e.p.has_pdc || e.ag.lastStage === 'PDC received'); break
      case 'flw5': list = list.filter((e) => e.ag.count >= 5); break
      case 'received': list = list.filter((e) => pulse.recvParties.has(normKey(e.p.party_name))); break
      case 'transferred': list = list.filter((e) => e.ag.transferTo); break
      default: break
    }
    const [k, dir] = sort
    const mul = dir === 'desc' ? -1 : 1
    const val = (e) => k === 'party_name' ? String(e.p.party_name || '')
      : k === 'flw' ? e.ag.count
      : k === 'next' ? (e.p.next_followup_date ? new Date(e.p.next_followup_date).getTime() : (dir === 'desc' ? -1 : 9e15))
      : k === 'committed' ? (e.ag.committed?.amount || 0)
      : Number(e.p[k] || 0)
    return [...list].sort((a, b) => {
      if (k === 'priority') {
        // pehle priority, same priority me bada amount upar — "upar se kaam karo" hamesha sahi rahe
        const d = a.pr.rank - b.pr.rank
        if (d !== 0) return d * mul
        return (Number(a.p.total_pending || 0) - Number(b.p.total_pending || 0)) * mul
      }
      const av = val(a), bv = val(b)
      return (av < bv ? -1 : av > bv ? 1 : 0) * mul
    })
  }, [enriched, q, salesman, preset, sort, pulse])

  const sortBtn = (key, label, title) => (
    <button className="link th-sort" title={title || ''} onClick={() => setSort(([k, d]) => [key, k === key && d === 'desc' ? 'asc' : 'desc'])}>
      {label}{sort[0] === key ? (sort[1] === 'desc' ? ' ↓' : ' ↑') : ''}
    </button>
  )
  const vis = (c) => (c.key in colVis ? !!colVis[c.key] : c.on)
  const visCols = COLS.filter(vis)
  const toggleCol = (k) => setColVis((v) => { const n = { ...v, [k]: !vis(COLS.find((c) => c.key === k)) }; try { localStorage.setItem(COLS_LS, JSON.stringify(n)) } catch { /* ignore */ } return n })
  const resetCols = () => { setColVis({}); try { localStorage.removeItem(COLS_LS) } catch { /* ignore */ } }

  const cell = (c, { p, ag, bucket, broken }) => {
    switch (c.key) {
      case 'total_pending': return <><b>{inrShort(p.total_pending)}</b><div className="muted small">{p.bill_count} bills</div></>
      case 'oldest_od': return p.oldest_od ? <span className={p.oldest_od > 90 ? 'red-t' : p.oldest_od > 30 ? 'amber-t' : ''}><b>{p.oldest_od} days</b></span> : '—'
      case 'aging': return <AgingChips aging={p.aging} />
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
      default: return null
    }
  }

  const dismissHelp = () => { setShowHelp(false); try { localStorage.setItem('fms_coll_help_seen', '1') } catch { /* private mode */ } }
  const clearAll = () => { setQ(''); setSalesman(''); setPreset('all') }
  const chip = (pr) => <button key={pr.key} className={preset === pr.key ? 'preset-chip active' : 'preset-chip'} onClick={() => setPreset(pr.key)}>{pr.label}</button>
  const setRange = (f, t) => { setFrom(f); setTo(t) }
  const rangeTxt = from || to ? `${from ? dmy(from) : 'start'} – ${to ? dmy(to) : 'today'}` : 'all time'

  if (rows === null) return <div className="action-page"><p className="muted">Loading collection data…</p></div>

  return (
    <div className="action-page coll-page">
      <div className="action-head">
        <h2>💰 Collection — Outstanding Payments</h2>
        <p className="muted small">All pending payments of the company, party-wise. The most important party is <b>at the top</b> — just work from top to bottom.</p>

        {showHelp && (
          <div className="coll-help">
            <b>How to use (3 steps):</b>
            <span>1️⃣ Click the top party</span>
            <span>2️⃣ 📞 Call or 📤 WhatsApp them</span>
            <span>3️⃣ Click 📝 on the bill you talked about, pick the stage, note + next date → Save</span>
            <button className="btn ghost sm" onClick={dismissHelp}>✕ Got it</button>
          </div>
        )}

        <div className="coll-kpis">
          <button className={preset === 'all' ? 'kpi-card active' : 'kpi-card'} onClick={() => setPreset('all')}>
            <b>{inrShort(kpi.total)}</b><span>Total pending · {kpi.parties} parties</span>
          </button>
          <button className={preset === 'missed' ? 'kpi-card red active' : 'kpi-card red'} onClick={() => setPreset('missed')} title="Follow-up date passed, nobody called">
            <b>{kpi.missed}</b><span>⏰ Missed · {inrShort(kpi.missedAmt)} stuck</span>
          </button>
          <button className={preset === 'today' ? 'kpi-card due active' : 'kpi-card due'} onClick={() => setPreset('today')}>
            <b>{kpi.due}</b><span>📅 Follow-ups due today</span>
          </button>
          <button className={preset === 'broken' ? 'kpi-card red active' : 'kpi-card red'} onClick={() => setPreset('broken')} title="Promised date passed, nothing received">
            <b>{kpi.broken}</b><span>💔 Broken promises</span>
          </button>
          <button className={preset === 'hot' ? 'kpi-card red active' : 'kpi-card red'} onClick={() => setPreset('hot')}>
            <b>{kpi.hot}</b><span>🔴 Urgent — {inrShort(kpi.old180)} very old</span>
          </button>
          <button className={preset === 'committed' ? 'kpi-card active' : 'kpi-card'} onClick={() => setPreset('committed')}>
            <b>{kpi.commit}</b><span>🤝 Committed / PDC</span>
          </button>
          <button className={preset === 'flw5' ? 'kpi-card active' : 'kpi-card'} onClick={() => setPreset('flw5')} title="Chased 5 or more times — needs escalation">
            <b>{kpi.flw5}</b><span>🔁 5+ follow-ups</span>
          </button>
        </div>

        {/* Pulse: date range me ERP receipts + follow-ups done (team productivity) */}
        <div className="coll-pulse">
          <div className="pulse-head">
            <div><b>Collection pulse</b> <span className="muted small">— what happened in this date range</span></div>
            <div className="pulse-range">
              <label className="small muted">From <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></label>
              <label className="small muted">To <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></label>
              <button className="btn ghost sm" onClick={() => setRange(isoDay(), isoDay())}>Today</button>
              <button className="btn ghost sm" onClick={() => { const n = new Date(); setRange(isoDay(new Date(n.getFullYear(), n.getMonth(), 1)), isoDay()) }}>This month</button>
              <button className="btn ghost sm" onClick={() => setRange('', '')}>All</button>
            </div>
          </div>
          <div className="pulse-grid">
            <button className={preset === 'received' ? 'pulse-stat green active' : 'pulse-stat green'} onClick={() => setPreset(preset === 'received' ? 'all' : 'received')} title="Receipts in ERP (Payment.ashx) — click to see those parties">
              <b>{inrShort(pulse.erp)}</b><span>💵 Received (ERP) · {pulse.erpN} voucher{pulse.erpN === 1 ? '' : 's'} · {rangeTxt}</span>
              {pulse.logged > 0 && <span>claimed in notes: {inrShort(pulse.logged)}</span>}
            </button>
            <div className="pulse-stat"><b>{pulse.done}</b><span>📞 Follow-ups done · {rangeTxt}</span></div>
            <div className="pulse-stat wide">
              <span>👤 By user</span>
              <div className="pulse-users">
                {Object.entries(pulse.byUser).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([u, n]) => <span key={u} className="user-tag">{u} <b>{n}</b></span>)}
                {!pulse.done && <span className="muted small">no follow-ups in this range</span>}
              </div>
            </div>
          </div>
        </div>

        <div className="action-filter coll-filters">
          <div className="coll-presets"><span className="preset-lbl">Follow-up:</span>{STATUS_PRESETS.map(chip)}</div>
          <div className="coll-presets"><span className="preset-lbl">Situation:</span>{SITUATION_PRESETS.map((pr) => pr.key === 'excluded' && !kpi.excluded ? null : chip(pr))}</div>
          <input className="search" placeholder="🔍 Search party / mobile / city…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={salesman} onChange={(e) => setSalesman(e.target.value)} title="Own parties + parties transferred to this salesman">
            <option value="">Salesman: All</option>
            {salesmen.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          {(q || salesman || preset !== 'all') && (
            <button className="btn ghost sm" onClick={clearAll}>✕ Clear filters</button>
          )}
          <span className="filter-count active">🔎 {filtered.length} / {kpi.parties} parties</span>
          <span className="coll-tools">
            <button className="btn ghost sm" onClick={() => setColPanel((v) => !v)} title="Show / hide table columns">⚙ Columns</button>
            <button className="btn ghost sm" onClick={() => window.print()} title="Print this list with the current filters">🖨 Print</button>
          </span>
        </div>
        {colPanel && (
          <div className="coll-colpanel">
            {COLS.map((c) => <label key={c.key} className="small chk"><input type="checkbox" checked={vis(c)} onChange={() => toggleCol(c.key)} /> {c.label}</label>)}
            <button className="btn ghost sm" onClick={resetCols}>Reset</button>
          </div>
        )}
      </div>

      {demo && rows.length > 0 && (
        <div className="panel demo-note"><p className="muted small">⚠️ This is SAMPLE data (demo mode). Login without <code>?demo</code> to see the real data.</p></div>
      )}
      {rows.length === 0 && (
        <div className="panel"><p className="muted">No collection data yet. Wait for the next ERP sync (hourly at :20).</p></div>
      )}

      {rows.length > 0 && filtered.length === 0 && (
        <div className="panel"><p className="muted">No party matches this filter. <button className="link" onClick={clearAll}>Clear filters</button></p></div>
      )}

      <div className="panel coll-list">
        <div className="print-only small muted">Collection list · {filtered.length} parties · filter: {preset}{salesman ? ' · ' + salesman : ''}{q ? ' · "' + q + '"' : ''} · printed {new Date().toLocaleString('en-IN')}</div>
        <table className="cfg-tbl coll-tbl">
          <thead>
            <tr>
              <th>{sortBtn('priority', 'Priority', 'Most important on top — work in this order')}</th>
              <th>{sortBtn('party_name', 'Party')}</th>
              {visCols.map((c) => <th key={c.key} title={c.title || ''}>{c.sort ? sortBtn(c.sort, c.label, c.title) : c.label}</th>)}
              <th className="no-print">Action</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 200).map((e) => {
              const { p, ag, pr } = e
              const wa = waLink(p.mobile, buildCollectionMsg(p))
              return (
                <tr key={p.party_name} className="coll-row" onClick={() => setOpen(p.party_name)}>
                  <td><span className={`pr-badge ${pr.cls}`} title={pr.hint}>{pr.label}</span></td>
                  <td>
                    <span className="coll-party"><b>{p.party_name}</b></span>
                    <div className="muted small">{[p.salesman, p.city].filter(Boolean).join(' · ')}{p.has_pdc && ' · 🧾 PDC'}{ag.transferTo && <span className="xfer-tag" title={'Transferred: ' + ag.transferReason}>↪ {ag.transferTo}</span>}</div>
                  </td>
                  {visCols.map((c) => <td key={c.key}>{cell(c, e)}</td>)}
                  <td className="coll-actions no-print" onClick={(ev) => ev.stopPropagation()}>
                    {p.mobile && <a className="btn ghost sm" href={`tel:${p.mobile}`} title={`Call: ${p.mobile}`}>📞</a>}
                    {wa && <a className="wa-btn" href={wa} target="_blank" rel="noreferrer" title="Send WhatsApp reminder"
                      onClick={() => { logWaSendParty(p.party_name, 'Sent WhatsApp payment reminder'); setTimeout(() => setTick((t) => t + 1), 800) }}>📤</a>}
                    <button className="btn ghost sm" title="Open party — bills + follow-up" onClick={() => setOpen(p.party_name)}>📝</button>
                  </td>
                </tr>
              )
            })}
            {filtered.length > 200 && <tr><td colSpan={3 + visCols.length} className="muted small">…and {filtered.length - 200} more parties — use the search box above</td></tr>}
          </tbody>
        </table>
      </div>

      {openParty && (() => {
        const e = enriched.find((x) => x.p === openParty)
        const pr = e ? e.pr : priorityOf(openParty, EMPTY_AGG, 'nodate')
        return (
          <div className="modal-back" onClick={() => setOpen(null)}>
            <div className="modal coll-modal" onClick={(ev) => ev.stopPropagation()}>
              <div className="modal-head">
                <div>
                  <h3>{openParty.party_name} <span className={`pr-badge ${pr.cls}`} title={pr.hint}>{pr.label}</span> {e && <BucketPill b={e.bucket} date={openParty.next_followup_date} />}</h3>
                  <p className="muted small coll-modal-sub">
                    {[openParty.salesman, openParty.city, openParty.mobile].filter(Boolean).join(' · ')}
                    {' · '}Total pending <b>{inrShort(openParty.total_pending)}</b> ({openParty.bill_count} bills)
                    {openParty.oldest_od ? <> · oldest <b>{openParty.oldest_od} days</b></> : null}
                    {openParty.last_pay_amt ? <> · last paid <b>{inrShort(openParty.last_pay_amt)}</b> on {dmy(openParty.last_pay_date)}</> : null}
                  </p>
                </div>
                <button className="btn ghost" onClick={() => setOpen(null)}>✕ Close</button>
              </div>
              <PartyDetail key={openParty.party_name} p={openParty} ag={agOf(openParty)} demo={demo} salesmen={salesmen} onSaved={() => setTick((t) => t + 1)} />
            </div>
          </div>
        )
      })()}
    </div>
  )
}
