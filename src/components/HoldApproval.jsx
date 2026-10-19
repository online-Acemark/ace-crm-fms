import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { inr, dmy } from '../lib/coll'

// Hold Approval (Google Sheet "Hold SO System" ki jagah): ERP me order hold -> case (fms_hold_cases, fms-sync banata hai)
// -> Step 1 salesman commitment (Google Form jaise fields) -> Step 2 approver (Deepak) Approve / Reject.
// Planned time DB me lock hota hai (office time + 1 ghanta); score Score System me jaata hai.
export const PAY_THROUGH = ['RTGS', 'NEFT', 'CHEQUE', 'UPI', 'CASH']
const DEMO_CASES = [
  { id: -1, mobile_so_no: 42066, so_no: 'AS/SO/26-27/24518', party: 'Demo Traders (sample)', salesman: 'Demo Salesman', amount: 64713, hold_seen_at: new Date(Date.now() - 3 * 3600e3).toISOString(), commit_planned_at: new Date(Date.now() - 2 * 3600e3).toISOString() },
  { id: -2, mobile_so_no: 42735, so_no: 'AS/SO/26-27/24976', party: 'Sample Book Depot', salesman: 'Demo Salesman', amount: 15925, hold_seen_at: new Date(Date.now() - 6 * 3600e3).toISOString(), commit_planned_at: new Date(Date.now() - 5 * 3600e3).toISOString(), commit_at: new Date(Date.now() - 4 * 3600e3).toISOString(), commit_by: 'salesman@example.com', commit_amount: 20000, commit_date: new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10), pay_through: 'RTGS', reminder: true, remarks: 'Mall bhejdo', hold_clear: true, approve_planned_at: new Date(Date.now() - 3 * 3600e3).toISOString() },
]

const fmtT = (v) => (v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }) : '')
const late = (planned, actual) => planned && new Date(actual || Date.now()) > new Date(planned)

export function holdStatus(c) {
  if (!c.commit_at) return { label: 'Commitment pending', cls: 'amber-t', step: 1 }
  if (!c.decision) return { label: 'Approval pending', cls: 'amber-t', step: 2 }
  if (c.decision === 'Approved') return { label: 'Approved — remove hold in ERP', cls: 'green-t', step: 3 }
  return { label: 'Rejected', cls: 'red-t', step: 3 }
}

// open hold cases (ERP me abhi hold) — Today Work + My Parties dono
export function useHoldCases() {
  const demo = new URLSearchParams(window.location.search).has('demo')
  const [cases, setCases] = useState(demo ? DEMO_CASES : [])
  const load = useCallback(() => {
    if (demo) return
    supabase.from('fms_hold_cases').select('*').is('released_at', null).order('hold_seen_at', { ascending: false })
      .then(({ data }) => setCases(data || []))
  }, [demo])
  useEffect(() => { load() }, [load])
  return [cases, load]
}

// Step 1: salesman ki commitment — fields bilkul purane Google Form jaise
export function HoldCommitForm({ hc, onDone, onCancel }) {
  const demo = new URLSearchParams(window.location.search).has('demo')
  const [amount, setAmount] = useState(hc.commit_amount ? String(hc.commit_amount) : '')
  const [date, setDate] = useState(hc.commit_date || '')
  const [pay, setPay] = useState(hc.pay_through || '')
  const [reminder, setReminder] = useState(hc.reminder == null ? 'Yes' : hc.reminder ? 'Yes' : 'No')
  const [remarks, setRemarks] = useState(hc.remarks || '')
  const [holdClear, setHoldClear] = useState(hc.hold_clear == null ? 'Yes' : hc.hold_clear ? 'Yes' : 'No')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const save = async () => {
    if (amount && !(Number(amount) > 0)) { setErr('Committed amount must be more than 0'); return }
    if (!date) { setErr('Pick the committed date'); return }
    if (!pay) { setErr('Pick how the party will pay'); return }
    if (demo) { setErr('Demo mode cannot save — use the real login'); return }
    setSaving(true); setErr('')
    const { error } = await supabase.rpc('fms_hold_commit', {
      p_case: hc.id, p_amount: amount ? Number(amount) : null, p_date: date, p_pay: pay,
      p_reminder: reminder === 'Yes', p_remarks: remarks, p_hold_clear: holdClear === 'Yes',
    })
    setSaving(false)
    if (error) { setErr(error.message); return }
    supabase.functions.invoke('fms-alerts', { body: { mode: 'hold' } }).catch(() => {})   // approver ko turant Telegram
    onDone?.(`✅ Commitment saved for ${hc.so_no || '#' + hc.mobile_so_no} — sent to the approver`)
  }

  return (
    <div className="hold-form">
      <div className="hold-form-head">
        <b>🤝 Hold commitment — {hc.party}</b>
        <span className="muted small">SO {hc.so_no || '—'} · #{hc.mobile_so_no} · {inr(hc.amount)}</span>
      </div>
      <div className="hold-form-grid">
        <label className="small muted">Committed amount ₹
          <input type="number" placeholder="e.g. 50000" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
        </label>
        <label className="small muted">Committed date *
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="small muted">Payment through *
          <select value={pay} onChange={(e) => setPay(e.target.value)}>
            <option value="">Select…</option>
            {PAY_THROUGH.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="small muted">Reminder
          <select value={reminder} onChange={(e) => setReminder(e.target.value)}><option>Yes</option><option>No</option></select>
        </label>
        <label className="small muted">Is there any order on hold to be cleared?
          <select value={holdClear} onChange={(e) => setHoldClear(e.target.value)}><option>Yes</option><option>No</option></select>
        </label>
        <label className="small muted hold-wide">Remarks
          <input placeholder='e.g. "Mall bhejdo"' value={remarks} onChange={(e) => setRemarks(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
        </label>
      </div>
      <div className="fld-row">
        <button className="btn primary" onClick={save} disabled={saving}>{saving ? '⏳ Saving…' : '💾 Save commitment'}</button>
        {onCancel && <button className="btn ghost" onClick={onCancel}>Cancel</button>}
        {hc.commit_planned_at && !hc.commit_at && <span className={`small ${late(hc.commit_planned_at) ? 'red-t' : 'muted'}`}>Target: {fmtT(hc.commit_planned_at)}</span>}
      </div>
      {err && <span className="err small" style={{ margin: 0 }}>{err}</span>}
    </div>
  )
}

// Telegram link (?hold=<case id>): login ke baad kisi bhi tab par seedha us order ka commitment form
export function HoldLinkModal({ caseId, onClose }) {
  const demo = new URLSearchParams(window.location.search).has('demo')
  const [hc, setHc] = useState(undefined)   // undefined = loading, null = nahi mila
  const [done, setDone] = useState('')
  useEffect(() => {
    if (demo) { setHc(DEMO_CASES.find((c) => String(c.id) === String(caseId)) || DEMO_CASES[0]); return }
    supabase.from('fms_hold_cases').select('*').eq('id', Number(caseId) || 0).maybeSingle().then(({ data }) => setHc(data || null))
  }, [caseId, demo])
  const note = hc === null ? 'This hold order link is not valid.'
    : hc?.released_at ? `${hc.so_no || '#' + hc.mobile_so_no} is no longer on hold in ERP — nothing to fill.`
    : hc?.decision ? `${hc.so_no || '#' + hc.mobile_so_no} is already ${hc.decision.toLowerCase()}${hc.decision_reason ? ` (${hc.decision_reason})` : ''}.`
    : done
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal hold-modal" onClick={(ev) => ev.stopPropagation()}>
        {hc === undefined ? <p className="muted">⏳ Loading…</p>
          : note ? (
            <div className="hold-form">
              <b>{note}</b>
              <div className="fld-row"><button className="btn primary" onClick={onClose}>OK</button></div>
            </div>
          )
          : <HoldCommitForm hc={hc} onCancel={onClose} onDone={setDone} />}
      </div>
    </div>
  )
}

// Today Work -> Hold Approval table (Step 1 + Step 2)
export default function HoldApproval({ cases, orders, access, q = '', fSalesman = '', onChanged, onOpenOrder }) {
  const demo = new URLSearchParams(window.location.search).has('demo')
  const canApprove = !!access?.can_approve_hold || demo
  const [commitFor, setCommitFor] = useState(null)   // case jiska commitment form khula hai
  const [rejectFor, setRejectFor] = useState(null)   // case id jiska reject reason likha ja raha hai
  const [reason, setReason] = useState('')
  const [msg, setMsg] = useState('')
  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 6000) }
  const orderBy = useMemo(() => new Map((orders || []).map((o) => [Number(o.mobile_so_no), o])), [orders])

  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return (cases || [])
      .filter((c) => !fSalesman || (c.salesman || '').trim() === fSalesman)
      .filter((c) => !s || `${c.party} ${c.mobile_so_no} ${c.so_no || ''} ${c.salesman || ''}`.toLowerCase().includes(s))
      .sort((a, b) => holdStatus(a).step - holdStatus(b).step || new Date(a.hold_seen_at) - new Date(b.hold_seen_at))
  }, [cases, q, fSalesman])

  const decide = async (c, decision) => {
    if (demo) { flash('❌ Demo mode cannot save — use the real login'); return }
    if (decision === 'Rejected' && !reason.trim()) { flash('❌ Write the reject reason'); return }
    if (decision === 'Approved' && !window.confirm(`Approve hold release for ${c.party} (${c.so_no || '#' + c.mobile_so_no})?\nAfter approving, remove the hold in ERP.`)) return
    const { error } = await supabase.rpc('fms_hold_decide', { p_case: c.id, p_decision: decision, p_reason: decision === 'Rejected' ? reason : null })
    if (error) { flash('❌ ' + error.message); return }
    setRejectFor(null); setReason('')
    flash(decision === 'Approved' ? '✅ Approved — now remove the hold in ERP; the order moves to Billing Pending on the next sync' : '✅ Rejected — the order stays on hold')
    onChanged?.()
  }

  return (
    <div>
      {msg && <p className="small"><b>{msg}</b></p>}
      {!canApprove && <p className="muted small">Only the hold approver can Approve / Reject. Salesmen fill the commitment from My Parties (or here).</p>}
      {!list.length ? <div className="all-done">✅ No order on hold</div> : (
        <div className="sec-tbl-wrap">
          <table className="cfg-tbl act-tbl hold-tbl">
            <thead>
              <tr>
                <th>MO SO No.</th><th>SO No</th><th>Party</th><th>Salesman</th><th className="num">Amount</th>
                <th title="From ERP HoldSo: party closing balance, credit limit, PDC received">Balance / Limit / PDC</th>
                <th>On hold since</th><th>Commitment (salesman)</th><th>Status</th><th>Action</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => {
                const o = orderBy.get(Number(c.mobile_so_no))
                const hi = o?.hold_info || {}
                const st = holdStatus(c)
                return (
                  <tr key={c.id}>
                    <td>{o ? <button className="link" onClick={() => onOpenOrder?.(o)}><b>#{c.mobile_so_no}</b></button> : <b>#{c.mobile_so_no}</b>}</td>
                    <td className="small">{c.so_no || '—'}</td>
                    <td><b>{c.party}</b>{hi.remarks && <div className="muted small" title={hi.remarks}>💬 {hi.remarks.slice(0, 60)}{hi.remarks.length > 60 ? '…' : ''}</div>}</td>
                    <td className="small">{c.salesman || '—'}</td>
                    <td className="num"><b>{inr(c.amount)}</b></td>
                    <td className="small">
                      <div>Bal: <b className={Number(hi.closing_balance) > Number(hi.credit_limit || Infinity) ? 'red-t' : ''}>{hi.closing_balance != null ? inr(hi.closing_balance) : '—'}</b></div>
                      <div className="muted">Limit {hi.credit_limit ? inr(hi.credit_limit) : '—'}{hi.credit_days ? ` · ${hi.credit_days}d` : ''}</div>
                      {Number(hi.pdc_amount) > 0 && <div>🧾 PDC {inr(hi.pdc_amount)}</div>}
                    </td>
                    <td className="small">{fmtT(c.hold_seen_at)}{hi.hold_by && <div className="muted">by {hi.hold_by}</div>}</td>
                    <td className="small">
                      {c.commit_at ? (<>
                        <div><b>{c.commit_amount ? inr(c.commit_amount) : '—'}</b> by <b>{dmy(c.commit_date)}</b> · {c.pay_through}</div>
                        <div className="muted">Reminder {c.reminder ? 'Yes' : 'No'} · Hold to clear {c.hold_clear ? 'Yes' : 'No'}</div>
                        {c.remarks && <div className="muted">“{c.remarks}”</div>}
                        <div className={late(c.commit_planned_at, c.commit_at) ? 'red-t' : 'green-t'}>{fmtT(c.commit_at)}{late(c.commit_planned_at, c.commit_at) ? ' · late' : ' · on time'}</div>
                      </>) : <span className={late(c.commit_planned_at) ? 'red-t' : 'amber-t'}>Not filled · target {fmtT(c.commit_planned_at)}</span>}
                    </td>
                    <td className="small">
                      <b className={st.cls}>{st.label}</b>
                      {st.step === 2 && <div className={late(c.approve_planned_at) ? 'red-t' : 'muted'}>target {fmtT(c.approve_planned_at)}</div>}
                      {c.decision && <div className="muted">{fmtT(c.decision_at)}{c.decision_reason ? ` · ${c.decision_reason}` : ''}</div>}
                    </td>
                    <td className="hold-act">
                      {st.step <= 2 && <button className="btn ghost sm" onClick={() => setCommitFor(c)}>{c.commit_at ? '✏️ Edit commitment' : '🤝 Commitment'}</button>}
                      {st.step === 2 && canApprove && (rejectFor === c.id ? (
                        <div className="fld-row">
                          <input placeholder="Reject reason" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
                          <button className="btn sm" onClick={() => decide(c, 'Rejected')}>❌ Reject</button>
                          <button className="btn ghost sm" onClick={() => { setRejectFor(null); setReason('') }}>✕</button>
                        </div>
                      ) : (
                        <div className="fld-row">
                          <button className="btn primary sm" onClick={() => decide(c, 'Approved')}>✅ Approve</button>
                          <button className="btn ghost sm" onClick={() => { setRejectFor(c.id); setReason('') }}>❌ Reject</button>
                        </div>
                      ))}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {commitFor && (
        <div className="modal-back" onClick={() => setCommitFor(null)}>
          <div className="modal hold-modal" onClick={(e) => e.stopPropagation()}>
            <HoldCommitForm hc={commitFor} onCancel={() => setCommitFor(null)} onDone={(m) => { setCommitFor(null); flash(m); onChanged?.() }} />
          </div>
        </div>
      )}
    </div>
  )
}
