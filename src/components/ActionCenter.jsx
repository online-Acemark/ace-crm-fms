import { useMemo, useState } from 'react'
import { computePipeline, fmtDelay, fmtDT, resolveContact, contactMissing, buildStatusMsg, waLink, noFollowup, logWaSend, isPaid } from '../lib/fms'
import OrderDrawer from './OrderDrawer'
import FollowupModal from './FollowupModal'

const SECTIONS = [
  {
    key: 'confirm', icon: '🆕', title: 'Naye Orders — Confirm Karo',
    how: 'ERP me SO convert karo. Phir client ko call/WhatsApp karke bolo: "Aapka order mil gaya hai, confirm ho gaya" — 30 minute ke andar.',
  },
  {
    key: 'billing', icon: '🧾', title: 'Billing Pending — Billwise Me Bill Banao',
    how: 'Billwise me invoice banwao (invoice number Billwise se aayega). Delay ho raha hai to dispatch team ko turant bolo.',
  },
  {
    key: 'dispatch', icon: '🚚', title: 'Dispatch Due — Aaj Nikalna Hai',
    how: '4 PM se pehle ke orders AAJ hi dispatch hone chahiye. Gate pass + transporter confirm karo, phir client ko 📤 Status bhejo.',
  },
  {
    key: 'payment', icon: '💰', title: 'Payment Follow-up — Aaj Call Karo',
    how: 'Client ko call karo, payment ki due date yaad dilao. Baat ho jaye to order kholke follow-up note + next date likho. Paisa aaye to amount entry karo.',
  },
  {
    key: 'contact', icon: '📇', title: 'Contact Data Adhura — Bharo',
    how: 'Client se baat ho tab puch lo: dusre contact person ka naam & email. FMS Grid me dotted box me hi type kar do — apne aap save ho jayega.',
  },
]

export default function ActionCenter({ orders, stages, scoring, onChanged }) {
  const [open, setOpen] = useState(null)
  const [fupOrder, setFupOrder] = useState(null)
  const today = new Date(); today.setHours(0, 0, 0, 0)

  const tasks = useMemo(() => {
    const t = { confirm: [], billing: [], dispatch: [], payment: [], contact: [] }
    for (const o of orders) {
      const pipe = computePipeline(o, stages, scoring)
      if (!o.so_convert_date) t.confirm.push({ o, pipe, d: pipe.so_convert?.delayH })
      else if (!o.billing_date && (pipe.billing?.status === 'running')) t.billing.push({ o, pipe, d: pipe.billing?.delayH })
      if (o.billing_date && !o.desp_date && ['running', 'pending'].includes(pipe.dispatch?.status)) t.dispatch.push({ o, pipe, d: pipe.dispatch?.delayH })
      const fupDue = o.next_followup_date && new Date(o.next_followup_date) <= new Date()
      // Family N = No follow-up — payment list me mat dikhao; ERP Full-paid bhi bahar
      if (!isPaid(o) && !noFollowup(o) && (pipe.payment?.status === 'running' || fupDue)) t.payment.push({ o, pipe, d: pipe.payment?.delayH, fupDue })
      if (contactMissing(o) && !isPaid(o)) t.contact.push({ o, pipe })
    }
    for (const k of Object.keys(t)) t[k].sort((a, b) => (b.d || 0) - (a.d || 0))
    return t
  }, [orders, stages, scoring, today])

  const totalTasks = SECTIONS.reduce((n, s) => n + tasks[s.key].length, 0)

  return (
    <div className="action-page">
      <div className="action-head">
        <h2>📌 Aaj Ke Kaam — {totalTasks} pending</h2>
        <p className="muted">Upar se neeche order me karo. Har section me likha hai KYA karna hai aur KAISE. Order number par click karo to pura detail khulega.</p>
      </div>
      {SECTIONS.map((sec) => {
        const list = tasks[sec.key]
        return (
          <div key={sec.key} className="panel action-sec">
            <div className="sec-title">
              <h3>{sec.icon} {sec.title} <span className={list.length ? 'count-badge' : 'count-badge zero'}>{list.length}</span></h3>
              <p className="muted small how">Kaise: {sec.how}</p>
            </div>
            {list.length === 0 ? <div className="all-done">✅ Sab ho gaya!</div> : (
              <table className="cfg-tbl">
                <tbody>
                  {list.slice(0, 25).map(({ o, pipe, d, fupDue }) => {
                    const c = resolveContact(o)
                    const wa = waLink(o.mobile_no, buildStatusMsg(o, pipe))
                    const due = o.billing_date && o.credit_days != null ? new Date(new Date(o.billing_date).getTime() + o.credit_days * 864e5) : null
                    return (
                      <tr key={o.mobile_so_no}>
                        <td><button className="link" onClick={() => setOpen(o)}><b>#{o.mobile_so_no}</b></button></td>
                        <td><b>{o.account_name}</b>{c.contact_person && <span className="muted"> · {c.contact_person}</span>}</td>
                        <td>{o.mobile_no && <a className="link" href={waLink(o.mobile_no)} target="_blank" rel="noreferrer">📞 {o.mobile_no}</a>}</td>
                        <td className="small">
                          {sec.key === 'confirm' && <>SO aaya: {fmtDT(o.mobile_so_created)}</>}
                          {sec.key === 'billing' && <>Confirm hua: {fmtDT(o.so_convert_date)}</>}
                          {sec.key === 'dispatch' && <>Bill bana: {fmtDT(o.billing_date)}</>}
                          {sec.key === 'payment' && (() => {
                            const overdueDays = pipe.payment?.planned ? Math.floor((Date.now() - new Date(pipe.payment.planned).getTime()) / 864e5) : 0
                            const bucket = overdueDays > 30 ? 'bkt-30' : overdueDays > 7 ? 'bkt-8' : ''
                            const baaki = o.payment_pending_erp != null ? Number(o.payment_pending_erp) : Number(o.bill_net_amount || o.sorder_amount || 0)
                            return <>{fupDue && <b className="amber-t">📅 Follow-up aaj due · </b>}Due: {due ? due.toLocaleDateString('en-IN') : '—'} · <b>Baaki ₹{baaki.toLocaleString('en-IN')}</b>{o.pay_status === 'Part' && <span className="amber-t"> (Part paid)</span>}
                              {overdueDays > 0 && <span className={`age-chip ${bucket}`}>{overdueDays > 30 ? '🔴' : overdueDays > 7 ? '🟠' : '🟡'} {overdueDays}d overdue</span>}</>
                          })()}
                          {sec.key === 'contact' && <span className="muted">Missing: {[!c.contact_person && 'Person 1', !c.contact_person2 && 'Person 2', !c.email_id && 'Email 1', !c.email_id2 && 'Email 2'].filter(Boolean).join(', ')}</span>}
                        </td>
                        <td>{d != null && d > 0 && <span className="red-t"><b>⏰ {fmtDelay(d)} late</b></span>}</td>
                        <td>
                          {sec.key === 'payment' && <button className="btn primary sm" onClick={() => setFupOrder(o)}>📝 Follow-up</button>}
                          {wa && sec.key !== 'contact' && <a className="wa-btn" href={wa} target="_blank" rel="noreferrer"
                            onClick={() => logWaSend(o, 'WhatsApp status bheja').then(() => onChanged?.())}>📤 Status</a>}
                        </td>
                      </tr>
                    )
                  })}
                  {list.length > 25 && <tr><td colSpan={6} className="muted small">…aur {list.length - 25} — filter use karo FMS Grid me</td></tr>}
                </tbody>
              </table>
            )}
          </div>
        )
      })}
      {open && <OrderDrawer order={open} stages={stages} scoring={scoring} onClose={() => setOpen(null)} onChanged={onChanged} />}
      {fupOrder && <FollowupModal order={fupOrder} onClose={() => setFupOrder(null)} onChanged={onChanged} />}
    </div>
  )
}
