import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { computePipeline, fmtDelay, fmtDT, resolveContact, buildStatusMsg, waLink } from '../lib/fms'
import { toLocalInput } from './Grid'

const inr = (v) => v == null ? '—' : '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })

export default function OrderDrawer({ order, stages, scoring, onClose, onChanged }) {
  const [fups, setFups] = useState([])
  const [note, setNote] = useState('')
  const [amt, setAmt] = useState('')
  const [nextDate, setNextDate] = useState(toLocalInput(order.next_followup_date))
  const [fupMsg, setFupMsg] = useState('')
  const [fupErr, setFupErr] = useState('')
  const isDemo = new URLSearchParams(window.location.search).has('demo')
  const pipe = computePipeline(order, stages, scoring)
  const contact = resolveContact(order)
  const [cEdit, setCEdit] = useState({ ...contact })
  const statusWa = waLink(order.mobile_no, buildStatusMsg(order, pipe))

  const saveContact = async () => {
    const cm = { ...(order.contact_manual || {}) }
    for (const f of ['contact_person', 'contact_person2', 'email_id', 'email_id2', 'mobile_no2']) {
      if ((cEdit[f] || '') !== (contact[f] || '')) cm[f] = (cEdit[f] || '').trim()
    }
    await supabase.from('fms_orders').update({ contact_manual: cm }).eq('mobile_so_no', order.mobile_so_no)
    onChanged?.()
  }

  useEffect(() => {
    supabase.from('fms_followups').select('*').eq('mobile_so_no', order.mobile_so_no)
      .order('created_at', { ascending: false }).then(({ data }) => setFups(data || []))
  }, [order.mobile_so_no])

  const addFup = async () => {
    if (!note.trim() && !nextDate && !Number(amt)) return
    setFupErr('')
    if (isDemo) {
      // demo mode: database me save nahi hota, sirf screen par log dikhta hai
      setFups([{ id: Date.now(), created_at: new Date().toISOString(), remarks: note.trim(), amount_received: Number(amt) || 0, created_by: 'demo@local' }, ...fups])
      setNote(''); setAmt('')
      setFupMsg('✔ Demo me add hua (database me save NAHI hota — Google sign-in karo)')
      setTimeout(() => setFupMsg(''), 4000)
      return
    }
    const { data: { user } } = await supabase.auth.getUser()
    const { error } = await supabase.from('fms_followups').insert({
      mobile_so_no: order.mobile_so_no, remarks: note, amount_received: Number(amt) || 0,
      created_by: user?.email || '',
    })
    if (error) { setFupErr('❌ Save nahi hua: ' + error.message); return }
    const updates = {}
    if (Number(amt) > 0) updates.payment_received = (Number(order.payment_received) || 0) + Number(amt)
    if (nextDate) updates.next_followup_date = new Date(nextDate).toISOString()
    if (Object.keys(updates).length) await supabase.from('fms_orders').update(updates).eq('mobile_so_no', order.mobile_so_no)
    setNote(''); setAmt('')
    setFupMsg('✔ Save ho gaya')
    setTimeout(() => setFupMsg(''), 2500)
    const { data } = await supabase.from('fms_followups').select('*').eq('mobile_so_no', order.mobile_so_no).order('created_at', { ascending: false })
    setFups(data || []); onChanged?.()
  }

  const markPaid = async (complete) => {
    await supabase.from('fms_orders').update({
      payment_complete: complete, payment_date: complete ? new Date().toISOString() : null,
    }).eq('mobile_so_no', order.mobile_so_no)
    onChanged?.(); onClose()
  }

  return (
    <div className="drawer-back" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <h2>SO #{order.mobile_so_no} · {order.account_name}</h2>
            <div className="muted small">{order.mobile_no} {contact.contact_person && '· ' + contact.contact_person} · Family {order.acc_family || '—'} · Credit {order.credit_days ?? '—'} days</div>
          </div>
          <div className="head-btns">
            {statusWa && <a className="wa-btn big" href={statusWa} target="_blank" rel="noreferrer">📤 Client Ko Status Bhejo</a>}
            <button className="btn ghost" onClick={onClose}>✕</button>
          </div>
        </div>

        <div className="contact-box">
          <h3>📇 Contact Details <span className="muted small">(jo blank hai wo client se puch ke bharo — Save dabao)</span></h3>
          <div className="contact-grid">
            <label>Person 1 <input value={cEdit.contact_person} onChange={(e) => setCEdit({ ...cEdit, contact_person: e.target.value })} placeholder="naam" /></label>
            <label>Person 2 <input value={cEdit.contact_person2} onChange={(e) => setCEdit({ ...cEdit, contact_person2: e.target.value })} placeholder="dusra naam" /></label>
            <label>Email 1 <input value={cEdit.email_id} onChange={(e) => setCEdit({ ...cEdit, email_id: e.target.value })} placeholder="email" /></label>
            <label>Email 2 <input value={cEdit.email_id2} onChange={(e) => setCEdit({ ...cEdit, email_id2: e.target.value })} placeholder="dusra email" /></label>
            <label>Mobile 2 <input value={cEdit.mobile_no2} onChange={(e) => setCEdit({ ...cEdit, mobile_no2: e.target.value })} placeholder="dusra number" /></label>
            <button className="btn primary sm" onClick={saveContact}>💾 Save Contact</button>
          </div>
        </div>

        <div className="pipe-list">
          {stages.filter((s) => s.active).map((s) => {
            const p = pipe[s.stage_key]; if (!p) return null
            const cls = { ontime: 'ok', late: 'late', running: 'run', pending: 'pend', done: 'ok', na: 'na' }[p.status]
            return (
              <div key={s.stage_key} className={`pipe-row ${cls}`}>
                <b>{s.stage_name}</b>
                <span>Pln: {fmtDT(p.planned)}</span>
                <span>Act: {p.actual ? fmtDT(p.actual) : '—'}</span>
                <span className="dl">{p.delayH != null ? `Delay ${fmtDelay(p.delayH)}` : p.status === 'ontime' || p.status === 'done' ? '✔ On time' : p.status}</span>
              </div>
            )
          })}
        </div>

        <div className="drawer-cols">
          <div>
            <h3>📦 Products ({order.line_count})</h3>
            <ul className="prod-list">
              {(order.products || []).map((p, i) => (
                <li key={i}>{p.name} <span className="muted">({p.code}) — {p.qty} {p.unit}{Number(p.pending) > 0 ? `, pending ${p.pending}` : ''}</span></li>
              ))}
            </ul>
            {(order.inv_urls || []).length > 0 && <>
              <h3>🧾 Invoices</h3>
              {(order.inv_urls || []).map((u, i) => <a key={i} className="link" href={u} target="_blank" rel="noreferrer">Invoice PDF {i + 1}</a>)}
            </>}
            <div className="amounts">
              <div>SO: <b>{inr(order.sorder_amount)}</b></div>
              <div>Billed: <b>{inr(order.bill_net_amount)}</b></div>
              <div>Received: <b>{inr(order.payment_received)}</b></div>
            </div>
          </div>
          <div>
            <h3>💰 Payment Follow-up</h3>
            <div className="fup-form">
              <input placeholder="Remarks (call/WhatsApp note)" value={note} onChange={(e) => setNote(e.target.value)} />
              <input type="number" placeholder="Amount received ₹" value={amt} onChange={(e) => setAmt(e.target.value)} />
              <label className="small muted">Next follow-up (date + time): <input type="datetime-local" value={nextDate} onChange={(e) => setNextDate(e.target.value)} /></label>
              <div className="fup-btns">
                <button className="btn primary" onClick={addFup}>＋ Add Follow-up</button>
                {order.payment_complete
                  ? <button className="btn ghost" onClick={() => markPaid(false)}>↩ Reopen payment</button>
                  : <button className="btn green" onClick={() => markPaid(true)}>✔ Payment Complete</button>}
              </div>
              {fupMsg && <span className="green-t small"><b>{fupMsg}</b></span>}
              {fupErr && <span className="red-t small"><b>{fupErr}</b></span>}
              {isDemo && <p className="amber-t small">⚠ Demo mode chal raha hai — yahan save database me NAHI jata. Asli save ke liye Google sign-in karke use karo.</p>}
            </div>
            <ul className="fup-list">
              {fups.map((f) => (
                <li key={f.id}><b>{new Date(f.created_at).toLocaleDateString('en-IN')}</b> — {f.remarks || '—'}
                  {Number(f.amount_received) > 0 && <span className="green-t"> +{inr(f.amount_received)}</span>}
                  <span className="muted small"> {f.created_by}</span></li>
              ))}
              {!fups.length && <li className="muted">Abhi koi follow-up nahi</li>}
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}
