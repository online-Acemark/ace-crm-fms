import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { suggestNextFollowup } from '../lib/fms'
import { toLocalInput } from './Grid'

const inr = (v) => v == null ? '—' : '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })

// Payment follow-up ka quick modal: date + remark bharo, save karo, neeche log dikhta hai.
// Remark/amount → Supabase table `fms_followups` me insert hota hai;
// next date → `fms_orders.next_followup_date` me update hota hai.
export default function FollowupModal({ order, onClose, onChanged }) {
  const [fups, setFups] = useState([])
  const [note, setNote] = useState('')
  const [amt, setAmt] = useState('')
  // default: +3 din (working day, 11 AM) — follow-up chain kabhi na toote
  const [nextDate, setNextDate] = useState(toLocalInput(order.next_followup_date) || toLocalInput(suggestNextFollowup()))
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState('')
  const [err, setErr] = useState('')
  const isDemo = new URLSearchParams(window.location.search).has('demo')

  const loadFups = () => {
    if (isDemo) return Promise.resolve()
    return supabase.from('fms_followups').select('*').eq('mobile_so_no', order.mobile_so_no)
      .order('created_at', { ascending: false }).then(({ data }) => setFups(data || []))
  }

  useEffect(() => { loadFups() }, [order.mobile_so_no])

  const save = async () => {
    if (!note.trim() && !Number(amt)) { setErr('Remark ya amount dalo'); return }
    if (!nextDate) { setErr('Next follow-up date zaroori hai — bina date ke party list se gayab ho jayegi'); return }
    setSaving(true); setErr('')
    if (isDemo) {
      // demo mode: database me save nahi hota, sirf screen par log dikhta hai
      setFups([{ id: Date.now(), created_at: new Date().toISOString(), remarks: note.trim(), amount_received: Number(amt) || 0, created_by: 'demo@local' }, ...fups])
      setNote(''); setAmt(''); setSaving(false)
      setSavedMsg('✔ Demo me add hua (database me save NAHI hota — Google sign-in karo)')
      setTimeout(() => setSavedMsg(''), 4000)
      return
    }
    const { data: { user } } = await supabase.auth.getUser()
    const { error } = await supabase.from('fms_followups').insert({
      mobile_so_no: order.mobile_so_no, remarks: note.trim(), amount_received: Number(amt) || 0,
      created_by: user?.email || '',
    })
    if (error) { setErr('❌ Save nahi hua: ' + error.message); setSaving(false); return }
    const updates = {}
    if (Number(amt) > 0) updates.payment_received = (Number(order.payment_received) || 0) + Number(amt)
    if (nextDate) updates.next_followup_date = new Date(nextDate).toISOString()
    if (Object.keys(updates).length) await supabase.from('fms_orders').update(updates).eq('mobile_so_no', order.mobile_so_no)
    setNote(''); setAmt(''); setSaving(false)
    setSavedMsg('✔ Save ho gaya')
    setTimeout(() => setSavedMsg(''), 2500)
    await loadFups(); onChanged?.()
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal fup-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>💰 Follow-up — SO #{order.mobile_so_no} · {order.account_name}</h3>
          <button className="btn ghost" onClick={onClose}>✕</button>
        </div>
        <div className="fup-form">
          <label className="small muted">Remark (call/WhatsApp me kya baat hui):
            <input placeholder="e.g. Payment kal karenge bola" value={note} autoFocus
              onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} /></label>
          <label className="small muted">Next follow-up date + time:
            <input type="datetime-local" value={nextDate} onChange={(e) => setNextDate(e.target.value)} /></label>
          <label className="small muted">Amount received ₹ (agar paisa aaya ho):
            <input type="number" placeholder="0" value={amt} onChange={(e) => setAmt(e.target.value)} /></label>
          <div className="fup-btns">
            <button className="btn primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : '💾 Save Follow-up'}</button>
            {savedMsg && <span className="green-t small"><b>{savedMsg}</b></span>}
            {err && <span className="red-t small"><b>{err}</b></span>}
          </div>
          {isDemo && <p className="amber-t small">⚠ Demo mode chal raha hai — yahan save database me NAHI jata. Asli save ke liye Google sign-in karke use karo.</p>}
        </div>
        <h3 className="fup-log-title">📜 Follow-up Log</h3>
        <ul className="fup-list">
          {fups.map((f) => (
            <li key={f.id}><b>{new Date(f.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</b> — {f.remarks || '—'}
              {Number(f.amount_received) > 0 && <span className="green-t"> +{inr(f.amount_received)}</span>}
              <span className="muted small"> {f.created_by}</span></li>
          ))}
          {!fups.length && <li className="muted">Abhi koi follow-up nahi</li>}
        </ul>
        <p className="muted small save-hint">Data Supabase me save hota hai: remark/amount → <b>fms_followups</b> table, next date → <b>fms_orders.next_followup_date</b></p>
      </div>
    </div>
  )
}
