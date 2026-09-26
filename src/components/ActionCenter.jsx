import { useMemo, useState } from 'react'
import { computePipeline, fmtDelay, fmtERP, resolveContact, contactMissing, buildStatusMsg, waLink, noFollowup, logWaSend, isPaid, paymentDue, changedLines, getStockMap, billStatuses, billDispatchDelay, BILL_STATUS } from '../lib/fms'
import OrderDrawer from './OrderDrawer'
import FollowupModal from './FollowupModal'
import MultiSelect from './MultiSelect'

const SECTIONS = [
  {
    key: 'confirm', icon: '🆕', title: 'Naye Orders — Confirm Karo',
    how: 'ERP me SO convert karo. Phir client ko call/WhatsApp karke bolo: "Aapka order mil gaya hai, confirm ho gaya" — 30 minute ke andar.',
  },
  {
    key: 'billing', icon: '🧾', title: 'Billing Pending — Billwise Me Bill Banao',
    how: 'Billwise me invoice banwao (invoice number Billwise se aayega). Yahan sirf wo orders hain jinka STOCK available hai — bina stock wale is list me nahi aate. Delay ho raha hai to dispatch team ko turant bolo.',
  },
  {
    key: 'dispatch', icon: '🚚', title: 'Dispatch Due — Aaj Nikalna Hai',
    how: 'Ek row = ek BILL (ek order ke kai bills ho sakte hain). Jo bill nikal chuka wo yahan nahi dikhta. 4 PM se pehle ke orders AAJ hi dispatch hone chahiye. Gate pass + transporter confirm karo, phir client ko 📤 Status bhejo.',
  },
  {
    key: 'hold', icon: '⏸', title: 'On Hold — Roke Gaye Orders',
    how: 'Ye orders ERP me jaan-boojh kar HOLD/pre-close kiye gaye hain — inko chase MAT karo. Order chalu karna ho to ERP me hold hatao; agle sync me apne aap Billing Pending me aa jayega.',
  },
  {
    key: 'payment', icon: '💰', title: 'Payment Follow-up — Aaj Call Karo',
    how: 'Ek row = ek BILL (due date aur baaki bill-wise). Client ko call karo, payment ki due date yaad dilao. Baat ho jaye to order kholke follow-up note + next date likho. Paisa aaye to amount entry karo.',
  },
  {
    key: 'contact', icon: '📇', title: 'Contact Data Adhura — Bharo',
    how: 'Client se baat ho tab puch lo: dusre contact person ka naam & email. FMS Grid me dotted box me hi type kar do — apne aap save ho jayega.',
  },
]

export default function ActionCenter({ orders, stages, scoring, stockTick, onChanged }) {
  const [open, setOpen] = useState(null)
  const [fupOrder, setFupOrder] = useState(null)
  const [q, setQ] = useState('') // SO number ya party name se filter
  const [secKey, setSecKey] = useState(null) // kaunsa section tab khula hai (null = pehla non-empty)
  const [fGodowns, setFGodowns] = useState([]) // multi-select (canonical names) — khali = sab
  const [fSalesman, setFSalesman] = useState('')
  const today = new Date(); today.setHours(0, 0, 0, 0)

  // ERP me ek hi godown ke kai naam hain: 'Main (AS)', 'Main', 'Main(AP)' = Main;
  // 'zBhatagaon(AS)', 'zbhatagaon' = Bhatagaon — merge karke ek option banate hain
  const canonGodown = (g) => String(g || '').replace(/\(.*?\)/g, '').trim().replace(/^z/i, '').trim().toLowerCase()
  const godownParts = (o) => String(o.godown || '').split(',').map((g) => g.trim()).filter(Boolean)

  // filter options: canonical -> display label (pehla saaf naam)
  const godownOpts = useMemo(() => {
    const m = new Map()
    for (const o of orders) for (const part of godownParts(o)) {
      const c = canonGodown(part)
      if (!c) continue
      if (!m.has(c)) m.set(c, part.replace(/\(.*?\)/g, '').trim().replace(/^z/i, '').trim())
    }
    return [...m.entries()].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label))
  }, [orders]) // eslint-disable-line react-hooks/exhaustive-deps
  const salesmanOpts = useMemo(() => [...new Set(orders.map((o) => (o.salesman || '').trim()).filter(Boolean))].sort(), [orders])

  // Unconverted order ERP feed me ab bhi hai ya nahi? Last sync me update nahi hua
  // (synced_at sabse naye sync se 2h+ purana) = feed se hat gaya — cancel/reject ho sakta hai.
  const maxSync = useMemo(() => orders.reduce((m, o) => (o.synced_at && o.synced_at > m ? o.synced_at : m), ''), [orders])
  const notInFeed = (o) => !!(o.synced_at && maxSync && (new Date(maxSync) - new Date(o.synced_at)) > 2 * 3600 * 1000)

  const matches = (o) => {
    if (fGodowns.length && !godownParts(o).some((p) => fGodowns.includes(canonGodown(p)))) return false
    if (fSalesman && (o.salesman || '').trim() !== fSalesman) return false
    const s = q.trim().toLowerCase()
    if (!s) return true
    return `${o.account_name} ${o.mobile_so_no} ${o.mobile_no || ''}`.toLowerCase().includes(s)
  }

  // Billing pending me wo order mat dikhao jiski SAARI unbilled lines PRE-CLOSED ho chuki hain
  // (reset qty >= line qty) — unka bill kabhi banega hi nahi. Partial reset ho to dikhna chahiye.
  const hasBillableLeft = (o) => {
    const unbilled = (o.products || []).filter((p) => Number(p.qty) > 0 && p.bno == null)
    if (!unbilled.length) return true // data adhura — safe side par list me rehne do
    const pre = {}
    for (const pc of (o.preclosed || [])) {
      const k = String(pc.name || '').trim().toLowerCase()
      pre[k] = (pre[k] || 0) + (Number(pc.reset) || 0)
    }
    return unbilled.some((p) => (pre[String(p.name || '').trim().toLowerCase()] || 0) < Number(p.qty))
  }

  // Billing pending me sirf wo orders jinke unbilled items ka STOCK available hai —
  // bina stock ke bill ban hi nahi sakta. Stock data abhi load na hua ho to sabko dikhao.
  const stockOk = (o) => {
    const sm = getStockMap()
    if (!sm) return true
    const unbilled = (o.products || []).filter((p) => Number(p.qty) > 0 && p.bno == null)
    if (!unbilled.length) return true
    return unbilled.every((p) => {
      const s = sm[String(p.code || '').trim().toLowerCase()]
      return s != null && s.total >= Number(p.qty)
    })
  }

  const tasks = useMemo(() => {
    const t = { confirm: [], billing: [], dispatch: [], hold: [], payment: [], contact: [] }
    for (const o of orders) {
      const pipe = computePipeline(o, stages, scoring)
      if (!o.so_convert_date) t.confirm.push({ o, pipe, d: pipe.so_convert?.delayH })
      else if (o.on_hold && !o.billing_date) t.hold.push({ o, pipe, d: null }) // HOLD — billing pending me nahi
      else if (!o.billing_date && ['running', 'partial'].includes(pipe.billing?.status) && hasBillableLeft(o) && stockOk(o)) t.billing.push({ o, pipe, d: pipe.billing?.delayH })
      // Dispatch due — BILL-WISE: jo bill ban gaya par nikla nahi (GP Out + DespDate dono chahiye), har bill apni row
      if (!o.on_hold && !o.desp_date && (o.bills || []).length) {
        for (const b of billStatuses(o)) if (b.status !== 'dispatched') t.dispatch.push({ o, pipe, b, d: billDispatchDelay(b, pipe, stages).delayH })
      }
      const fupDue = o.next_followup_date && new Date(o.next_followup_date) <= new Date()
      // Family N = No follow-up — payment list me mat dikhao; ERP Full-paid bhi bahar
      if (!isPaid(o) && !noFollowup(o) && (pipe.payment?.status === 'running' || fupDue)) {
        // BILL-WISE: har unpaid bill apni row (due date + baaki bill ke hisaab se); bills na ho to order-level row
        const unpaid = billStatuses(o).filter((b) => b.pay_status !== 'Full')
        if (unpaid.length) for (const b of unpaid) {
          const due = paymentDue(b.billing_date, o.credit_days)
          const nowT = new Date().getTime()
          t.payment.push({ o, pipe, b, d: due && nowT > due.getTime() ? (nowT - due.getTime()) / 36e5 : null, fupDue })
        } else t.payment.push({ o, pipe, d: pipe.payment?.delayH, fupDue })
      }
      if (contactMissing(o) && !isPaid(o)) t.contact.push({ o, pipe })
    }
    // G = Golden customer, pehli priority — har section me sabse upar; uske baad zyada delay wale
    const isG = (o) => String(o.acc_family || '').trim().toUpperCase() === 'G'
    for (const k of Object.keys(t)) t[k].sort((a, b) => (isG(b.o) - isG(a.o)) || ((b.d || 0) - (a.d || 0)))
    return t
  }, [orders, stages, scoring, today, stockTick]) // eslint-disable-line react-hooks/exhaustive-deps

  const filteredTasks = useMemo(() => {
    const t = {}
    for (const k of Object.keys(tasks)) t[k] = tasks[k].filter(({ o }) => matches(o))
    return t
  }, [tasks, q, fGodowns, fSalesman]) // eslint-disable-line react-hooks/exhaustive-deps

  // Contact Data Adhura asli "kaam" nahi hai — header ke total me nahi ginta
  const countable = SECTIONS.filter((s) => s.key !== 'contact')
  const totalTasks = countable.reduce((n, s) => n + tasks[s.key].length, 0)
  const shownTasks = countable.reduce((n, s) => n + filteredTasks[s.key].length, 0)
  // click nahi kiya to pehla section jisme kaam pada hai
  const activeKey = secKey || SECTIONS.find((s) => filteredTasks[s.key].length)?.key || SECTIONS[0].key

  return (
    <div className="action-page act-page">
      <div className="action-head">
        <h2>📌 Today Work — {totalTasks} pending</h2>
        <p className="muted">Upar se neeche order me karo. Har section me likha hai KYA karna hai aur KAISE. Order number par click karo to pura detail khulega.</p>
        <div className="action-filter">
          <input className="search" placeholder="🔍 SO No / Party name se dhundo…" value={q} onChange={(e) => setQ(e.target.value)} />
          <MultiSelect label="Godown" options={godownOpts} value={fGodowns} onChange={setFGodowns} />
          <select value={fSalesman} onChange={(e) => setFSalesman(e.target.value)} title="Salesman-wise filter">
            <option value="">Salesman: All</option>
            {salesmanOpts.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          {(q || fGodowns.length > 0 || fSalesman) && <>
            <button className="btn ghost sm" onClick={() => { setQ(''); setFGodowns([]); setFSalesman('') }}>✕ Clear</button>
            <span className="filter-count active">🔎 {shownTasks} / {totalTasks} tasks</span>
          </>}
          <button className="btn ghost sm" title="Print the open section's table" onClick={() => window.print()}>🖨 Print</button>
        </div>
      </div>
      <div className="act-sec-tabs">
        {SECTIONS.map((s) => (
          <button key={s.key} className={activeKey === s.key ? 'sec-tab active' : 'sec-tab'} onClick={() => setSecKey(s.key)}>
            {s.icon} {s.title.split('—')[0].trim()}
            <span className={filteredTasks[s.key].length ? 'count-badge' : 'count-badge zero'}>{filteredTasks[s.key].length}</span>
          </button>
        ))}
      </div>
      {SECTIONS.filter((s) => s.key === activeKey).map((sec) => {
        const list = filteredTasks[sec.key]
        return (
          <div key={sec.key} className="panel action-sec">
            <div className="sec-title">
              <h3>{sec.icon} {sec.title} <span className={list.length ? 'count-badge' : 'count-badge zero'}>{list.length}</span></h3>
              <p className="muted small how">Kaise: {sec.how}</p>
            </div>
            {list.length === 0 ? <div className="all-done">{q && tasks[sec.key].length > 0 ? <span className="muted">🔍 filter me kuch nahi mila ({tasks[sec.key].length} hidden)</span> : '✅ Sab ho gaya!'}</div> : (
              <div className="sec-tbl-wrap">
              <table className="cfg-tbl act-tbl">
                <thead>
                  <tr>
                    <th title="Mobile app order number">MO SO No.</th>
                    {sec.key !== 'confirm' && (
                      <th title={sec.key === 'dispatch' ? 'Bill number' : sec.key === 'payment' ? 'Invoice number' : 'ERP SO number after conversion'}>
                        {sec.key === 'dispatch' ? 'Bill No' : sec.key === 'payment' ? 'Invoice No' : 'SO No'}
                      </th>
                    )}
                    <th>Party</th>
                    <th title="Account family — G (red) = Golden customer, first priority">Family</th>
                    <th>Godown</th>
                    <th>Contact</th>
                    <th>Details</th>
                    <th>Delay</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map(({ o, pipe, b, d, fupDue }) => {
                    const c = resolveContact(o)
                    const wa = waLink(o.mobile_no, buildStatusMsg(o, pipe))
                    const due = paymentDue(b ? b.billing_date : o.billing_date, o.credit_days)
                    const items = b ? b.lines.map((x) => `${x.name} (${Number(x.bqty ?? x.qty) || 0})`) : []
                    // ERP OrderStatus: SO convert ke time jo items badle/hate gaye + replacement hint
                    const { changed, repl } = changedLines(o)
                    return (
                      <tr key={`${o.mobile_so_no}-${b ? b.bill_no : ''}`}>
                        <td><button className="link" onClick={() => setOpen(o)}><b>#{o.mobile_so_no}</b></button>{b && (o.bills || []).length > 1 && <div className="muted small" title="This order has more than one bill — each bill is its own row">{(o.bills || []).length} bills</div>}</td>
                        {sec.key !== 'confirm' && (
                          <td>{['dispatch', 'payment'].includes(sec.key)
                            ? (b ? <><b>#{b.bill_no}</b><div className="muted small">{fmtERP(b.billing_date)}</div>{b.url && <a className="link small" href={b.url} target="_blank" rel="noreferrer">PDF</a>}</>
                              : (o.bill_nos || []).length ? <b>{(o.bill_nos || []).join(', ')}</b> : <span className="muted">—</span>)
                            : <b>{o.sorder_no ?? <span className="muted">—</span>}</b>}</td>
                        )}
                        <td className="act-party"><b>{o.account_name}</b>
                          {o.micro_order && <span className="fam-badge" title="Micro order — RetailerUnderMicroOrder list me hai">Micro</span>}
                          {c.contact_person && <span className="muted"> · {c.contact_person}</span>}
                          {o.so_remark && <div className="so-remark small" title={o.so_remark}>💬 {o.so_remark}</div>}
                          {b && items.length > 0 && <div className="bill-items small muted" title={items.join('\n')}>📦 {items.slice(0, 3).join(', ')}{items.length > 3 ? ` +${items.length - 3} more` : ''}</div>}
                          {changed.length > 0 && (
                            <div className="ost-note small">
                              🔁 <b>Product changed at SO:</b> {changed.map((p) => `${p.name} (${Number(p.mqty) || 0}${p.munit ? ' ' + p.munit : ''})`).join(', ')}
                              {repl.length > 0 && <span className="muted"> · likely replaced by: {repl.map((r) => `${r.name} (${Number(r.mqty) || 0}→${Number(r.qty)})`).join(', ')}</span>}
                            </div>
                          )}</td>
                        <td className="fam-cell">
                          {String(o.acc_family || '').trim()
                            ? <span className={String(o.acc_family).trim().toUpperCase() === 'G' ? 'fam-badge fam-g' : 'fam-badge'}
                                title={String(o.acc_family).trim().toUpperCase() === 'G' ? 'Golden customer — first priority' : 'Account family'}>
                                {String(o.acc_family).trim().toUpperCase() === 'G' ? '⭐ G' : String(o.acc_family).trim()}
                              </span>
                            : <span className="muted">—</span>}
                        </td>
                        <td className="small godown-cell" title={o.godown || ''}>{o.godown || <span className="muted">—</span>}</td>
                        <td>{o.mobile_no && <a className="link" href={waLink(o.mobile_no)} target="_blank" rel="noreferrer">📞 {o.mobile_no}</a>}</td>
                        <td className="small">
                          {sec.key === 'confirm' && <>SO aaya: {fmtERP(o.mobile_so_created)}
                            {notInFeed(o)
                              ? <span className="conv-chip conv-gone" title="This order is missing from today's ERP data — it may have been cancelled or rejected. Verify in ERP.">⚠️ Not in ERP feed — cancelled/rejected? Verify in ERP</span>
                              : <span className="conv-chip" title="Order is in ERP but not yet converted to SO.">🟡 Not converted yet — convert in ERP</span>}</>}
                          {sec.key === 'billing' && <>Confirm hua: {fmtERP(o.so_convert_date)}</>}
                          {sec.key === 'dispatch' && (b
                            ? <>Bill bana: {fmtERP(b.billing_date)} · <b>₹{Number(b.amount || 0).toLocaleString('en-IN')}</b> · {Number(b.qty || 0).toLocaleString('en-IN')} qty
                              <div><span className={BILL_STATUS[b.status].cls}><b>{b.status === 'gpout' ? '🟠' : b.status === 'partial' ? '🟠' : '🔴'} {BILL_STATUS[b.status].label}</b></span>{b.gp_nos.length > 0 && <span className="muted"> · GP {b.gp_nos.join(', ')}{b.gp_at ? ' · ' + fmtERP(b.gp_at) : ''}</span>}</div></>
                            : <>Bill bana: {fmtERP(o.billing_date)}</>)}
                          {sec.key === 'hold' && <>SO bana: {fmtERP(o.so_convert_date)} · <b>₹{Number(o.sorder_amount || o.mobile_so_amount || 0).toLocaleString('en-IN')}</b>
                            <span className="conv-chip conv-gone" title="ERP me ye SO hold/pre-close status me hai — delay aur score me nahi ginta">⏸ On hold in ERP</span></>}
                          {sec.key === 'payment' && (() => {
                            const overdueDays = due ? Math.floor((Date.now() - due.getTime()) / 864e5) : 0
                            const bucket = overdueDays > 30 ? 'bkt-30' : overdueDays > 7 ? 'bkt-8' : ''
                            const baaki = b ? b.pending : o.payment_pending_erp != null ? Number(o.payment_pending_erp) : Number(o.bill_net_amount || o.sorder_amount || 0)
                            const part = b ? b.pay_status === 'Part' : o.pay_status === 'Part'
                            return <>{fupDue && <b className="amber-t">📅 Follow-up aaj due · </b>}Due: {due ? due.toLocaleDateString('en-IN') : '—'} · <b>Baaki ₹{baaki.toLocaleString('en-IN')}</b>{part && <span className="amber-t"> (Part paid{b && b.received > 0 ? ` · ₹${b.received.toLocaleString('en-IN')} aaya` : ''})</span>}
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
                </tbody>
              </table>
              </div>
            )}
          </div>
        )
      })}
      {open && <OrderDrawer order={open} stages={stages} scoring={scoring} onClose={() => setOpen(null)} onChanged={onChanged} />}
      {fupOrder && <FollowupModal order={fupOrder} onClose={() => setFupOrder(null)} onChanged={onChanged} />}
    </div>
  )
}
