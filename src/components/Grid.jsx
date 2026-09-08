import { useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { computePipeline, computeScore, fmtDelay, fmtDT, resolveContact, contactMissing, buildStatusMsg, buildBillMsg, waLink, noFollowup, getStockMap, paymentDue } from '../lib/fms'
import OrderDrawer from './OrderDrawer'
import FollowupModal from './FollowupModal'

const inr = (v) => v == null ? '—' : '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })

function StageCell({ p, sk }) {
  if (!p) return <td className={`stage-cell na ${sk} stg-first`} colSpan={3}>—</td>
  const cls = { ontime: 'ok', late: 'late', running: 'run', pending: 'pend', done: 'ok', na: 'na' }[p.status]
  return (<>
    <td className={`sub pln ${cls} ${sk} stg-first`}>{fmtDT(p.planned)}</td>
    <td className={`sub act ${cls} ${sk}`}>{p.actual ? fmtDT(p.actual) : (p.status === 'running' ? '⏳ pending' : '—')}</td>
    <td className={`sub dly ${cls} ${sk}`}>{p.delayH != null ? (p.status === 'ontime' || p.status === 'done' ? '✔ ' : '') + fmtDelay(p.delayH) : (p.status === 'ontime' ? '✔' : p.status === 'pending' ? '·' : '—')}</td>
  </>)
}

function ScoreBadge({ v }) {
  if (v == null) return <span className="muted">—</span>
  const c = v >= 90 ? 'sc-g' : v >= 70 ? 'sc-y' : 'sc-r'
  return <span className={`score ${c}`}>{v}</span>
}

function CustomCell({ order, col, onChanged }) {
  const val = order.custom_data?.[col.col_key] ?? ''
  const [v, setV] = useState(val)
  const save = async (nv) => {
    const cd = { ...(order.custom_data || {}), [col.col_key]: nv }
    await supabase.from('fms_orders').update({ custom_data: cd }).eq('mobile_so_no', order.mobile_so_no)
    onChanged?.()
  }
  if (col.col_type === 'checkbox')
    return <td className="cust"><input type="checkbox" checked={!!val} onChange={(e) => save(e.target.checked)} /></td>
  if (col.col_type === 'select')
    return <td className="cust"><select value={val} onChange={(e) => save(e.target.value)}>
      <option value=""></option>
      {(col.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
    </select></td>
  return <td className="cust"><input type={col.col_type === 'number' ? 'number' : col.col_type === 'date' ? 'date' : 'text'}
    value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== val && save(v)}
    onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} /></td>
}

// timestamptz <-> <input type="datetime-local"> conversion
export function toLocalInput(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d)) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

// blank ho to inline input dikhao (exec bhar sake), value ho to text — sab contact_manual me save hota hai
function ContactCell({ order, field, placeholder, isEmail, onChanged }) {
  const c = resolveContact(order)
  const val = c[field]
  const [v, setV] = useState('')
  const save = async () => {
    if (!v.trim()) return
    const cm = { ...(order.contact_manual || {}), [field]: v.trim() }
    await supabase.from('fms_orders').update({ contact_manual: cm }).eq('mobile_so_no', order.mobile_so_no)
    setV('')
    onChanged?.()
  }
  if (val) {
    if (isEmail) return <td><a className="link" href={`mailto:${val}`}>{val}</a></td>
    return <td>{val}</td>
  }
  return <td className="fill-cell">
    <input className="fill-inp" placeholder={placeholder} value={v}
      onChange={(e) => setV(e.target.value)} onBlur={save}
      onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} />
  </td>
}

export default function Grid({ orders, stages, columns, scoring, fupCounts, partyInfo, onChanged }) {
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('all')
  const [open, setOpen] = useState(null)
  const [fupOrder, setFupOrder] = useState(null)
  const [fBeat, setFBeat] = useState('')
  const [fSalesman, setFSalesman] = useState('')
  const [fParty, setFParty] = useState('')
  const [view, setView] = useState('so') // 'so' = ek row per SO, 'bill' = ek row per bill, 'item' = ek row per product line
  const stockMap = getStockMap() // App.loadAll pehle hi load kar chuka hota hai

  const rows = useMemo(() => orders.map((o) => {
    const pipe = computePipeline(o, stages, scoring)
    return { o, pipe, score: computeScore(pipe, scoring) }
  }), [orders, stages, scoring])

  // bill-wise: har bill ki alag row; item-wise: har product line ki alag row; bina bill wale SO waise hi dikhte hain
  const viewRows = useMemo(() => {
    if (view === 'so') return rows
    if (view === 'item') {
      const out = []
      for (const { o, pipe, score } of rows) {
        const ps = o.products?.length ? o.products : [null]
        ps.forEach((p, i) => out.push({
          o: {
            ...o, _billKey: o.mobile_so_no + '_item' + i,
            products: p ? [p] : [], line_count: 1,
            so_qty: p?.qty ?? null, pending_qty: p?.pending ?? null,
          },
          pipe, score,
        }))
      }
      return out
    }
    const out = []
    for (const { o } of orders.map((o) => ({ o }))) {
      // purane synced rows me bills nahi hota — bill_nos se bana lo
      const bills = (o.bills?.length ? o.bills : (o.bill_nos || []).map((bn, i) => ({
        bill_no: bn, billing_date: o.billing_date, amount: (o.bill_nos || []).length === 1 ? o.bill_net_amount : null,
        qty: null, url: (o.inv_urls || [])[i] || null, products: null,
      })))
      if (!bills.length) {
        const pipe = computePipeline(o, stages, scoring)
        out.push({ o: { ...o, _billKey: o.mobile_so_no + '_nobill' }, pipe, score: computeScore(pipe, scoring) })
        continue
      }
      for (const b of bills) {
        const bo = {
          ...o, _billKey: o.mobile_so_no + '_' + b.bill_no,
          billing_date: b.billing_date || o.billing_date, bill_net_amount: b.amount,
          bill_nos: [b.bill_no], inv_urls: [b.url], bill_qty: b.qty,
          products: b.products || o.products, line_count: (b.products || o.products || []).length,
        }
        const pipe = computePipeline(bo, stages, scoring)
        out.push({ o: bo, pipe, score: computeScore(pipe, scoring) })
      }
    }
    return out
  }, [rows, orders, view, stages, scoring])

  // salesman/beat: ERP (MobileSO API) primary source, fms_party_info manual fallback
  const smOf = (o) => o.salesman || partyInfo?.[o.account_name]?.salesman || ''
  const beatOf = (o) => o.beat || partyInfo?.[o.account_name]?.beat || ''

  // filter dropdowns ke options — jo values bhari gayi hain unse
  const beatOpts = useMemo(() => [...new Set(orders.map(beatOf).filter(Boolean))].sort(), [orders, partyInfo])
  const salesmanOpts = useMemo(() => [...new Set(orders.map(smOf).filter(Boolean))].sort(), [orders, partyInfo])
  const partyOpts = useMemo(() => [...new Set(orders.map((o) => o.account_name).filter(Boolean))].sort(), [orders])

  const filtered = viewRows.filter(({ o, pipe }) => {
    if (q && !(`${o.account_name} ${o.mobile_so_no} ${o.mobile_no} ${(o.products || []).map((p) => p.name + ' ' + p.code).join(' ')}`.toLowerCase().includes(q.toLowerCase()))) return false
    if (fBeat && beatOf(o) !== fBeat) return false
    if (fSalesman && smOf(o) !== fSalesman) return false
    if (fParty && o.account_name !== fParty) return false
    if (filter === 'delayed') return Object.values(pipe).some((p) => p.status === 'late' || p.status === 'running')
    if (filter === 'payment') return pipe.payment && ['running', 'pending', 'late'].includes(pipe.payment.status) && !o.payment_complete
    if (filter === 'pending') return Number(o.pending_qty) > 0
    if (filter === 'contact') return contactMissing(o)
    return true
  })

  const kpi = useMemo(() => {
    const delayed = rows.filter(({ pipe }) => Object.values(pipe).some((p) => p.status === 'running' || p.status === 'late')).length
    const payDue = rows.filter(({ o, pipe }) => pipe.payment?.status === 'running' && !o.payment_complete).length
    const scores = rows.map((r) => r.score).filter((v) => v != null)
    return {
      total: rows.length,
      delayed,
      payDue,
      avg: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : '—',
    }
  }, [rows])

  const visCols = [...columns].filter((c) => c.visible).sort((a, b) => a.position - b.position)
  const stageMap = Object.fromEntries(stages.map((s) => [`stage_${s.stage_key}`, s]))

  return (
    <div className="grid-page">
      <div className="kpis">
        <div className="kpi"><b>{kpi.total}</b><span>Total SO</span></div>
        <div className="kpi red"><b>{kpi.delayed}</b><span>Delayed</span></div>
        <div className="kpi amber"><b>{kpi.payDue}</b><span>Payment Overdue</span></div>
        <div className="kpi green"><b>{kpi.avg}</b><span>Avg Score</span></div>
        <select value={view} onChange={(e) => setView(e.target.value)} title="Row kis hisaab se dikhe">
          <option value="so">📄 SO-wise</option>
          <option value="bill">🧾 Bill-wise</option>
          <option value="item">📦 Item-wise</option>
        </select>
        <input className="search" placeholder="🔍 Client / SO No / Item…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">All orders</option>
          <option value="delayed">⚠ Delayed</option>
          <option value="payment">💰 Payment due</option>
          <option value="pending">📦 Pending qty</option>
          <option value="contact">📇 Contact info missing</option>
        </select>
        <select value={fSalesman} onChange={(e) => setFSalesman(e.target.value)} title="Salesman-wise filter">
          <option value="">👤 All salesmen</option>
          {salesmanOpts.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={fBeat} onChange={(e) => setFBeat(e.target.value)} title="Beat-wise filter">
          <option value="">🗺 All beats</option>
          {beatOpts.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <select value={fParty} onChange={(e) => setFParty(e.target.value)} title="Party-wise filter">
          <option value="">🏪 All parties</option>
          {partyOpts.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        {(fBeat || fSalesman || fParty) && <button className="btn ghost sm" onClick={() => { setFBeat(''); setFSalesman(''); setFParty('') }}>✕ Clear</button>}
      </div>
      <div className="legend">
        <span><i className="dot g"></i> On-time ✔</span>
        <span><i className="dot r"></i> Late / Delay</span>
        <span><i className="dot a"></i> ⏳ Abhi karna hai (overdue)</span>
        <span className="muted">· SO number par click karo → pura detail + follow-up</span>
        <span className="muted">· 📤 = client ko WhatsApp par ready-made status bhejo</span>
        <span className="muted">· Dotted box = data missing, yahin type karke bharo</span>
      </div>
      <div className="tbl-wrap">
        <table className="fms-tbl">
          <thead>
            <tr>
              {visCols.map((c) => c.col_type === 'stage'
                ? <th key={c.col_key} colSpan={c.col_key === 'stage_billing' ? 5 : c.col_key === 'stage_payment' ? 6 : 3} className={`stage-h ${c.col_key}`}>{c.label}</th>
                : <th key={c.col_key} rowSpan={2} className={c.is_custom ? 'cust-h' : ''}>{c.label}{c.is_custom ? ' ✏️' : ''}</th>)}
            </tr>
            <tr>
              {visCols.filter((c) => c.col_type === 'stage').flatMap((c) => [
                <th key={c.col_key + 'p'} className={`sub-h ${c.col_key} stg-first`}>Pln</th>,
                <th key={c.col_key + 'a'} className={`sub-h ${c.col_key}`}>Act</th>,
                <th key={c.col_key + 'd'} className={`sub-h ${c.col_key}`}>Delay</th>,
                ...(c.col_key === 'stage_billing' ? [
                  <th key={c.col_key + 'q'} className={`sub-h ${c.col_key}`}>Billed Qty</th>,
                  <th key={c.col_key + 'i'} className={`sub-h ${c.col_key}`}>Inv No</th>,
                ] : []),
                ...(c.col_key === 'stage_payment' ? [
                  <th key={c.col_key + 'n'} className={`sub-h ${c.col_key}`}>F/Ups</th>,
                  <th key={c.col_key + 'x'} className={`sub-h ${c.col_key}`}>Next F/Up</th>,
                  <th key={c.col_key + 'r'} className={`sub-h ${c.col_key}`}>Remark</th>,
                ] : []),
              ])}
            </tr>
          </thead>
          <tbody>
            {filtered.map(({ o, pipe, score }) => (
              <tr key={o._billKey || o.mobile_so_no}>
                {visCols.map((c) => {
                  if (c.col_type === 'stage') {
                    const cell = <StageCell key={c.col_key} p={pipe[stageMap[c.col_key]?.stage_key]} sk={c.col_key} />
                    if (c.col_key === 'stage_billing') return [cell,
                      <td key={c.col_key + '_bq'} className={`sub num ${c.col_key}`}>
                        {(() => { const ps = o.products || []; const v = ps.length === 1 && ps[0].bqty != null ? ps[0].bqty : o.bill_qty; return v != null ? Number(v).toLocaleString('en-IN') : '—' })()}
                      </td>,
                      <td key={c.col_key + '_inv'} className={`sub inv-col ${c.col_key}`}>
                        {(() => {
                          const bills = o.bills?.length ? o.bills : (o.bill_nos || []).map((bn, i) => ({
                            bill_no: bn, url: (o.inv_urls || [])[i] || null, billing_date: o.billing_date,
                            amount: (o.bill_nos || []).length === 1 ? o.bill_net_amount : null, qty: null,
                          }))
                          if (!bills.length) return <span className="muted">—</span>
                          return bills.map((b) => (
                            <span key={b.bill_no} className="inv-item">
                              {b.url
                                ? <a className="link" href={b.url} target="_blank" rel="noreferrer" title="Invoice PDF kholo">#{b.bill_no}</a>
                                : <span>#{b.bill_no}</span>}
                              {o.mobile_no && <a className="wa-mini" href={waLink(o.mobile_no, buildBillMsg(o, b))} target="_blank" rel="noreferrer" title="Is bill ka WhatsApp message bhejo">📤</a>}
                            </span>
                          ))
                        })()}
                      </td>]
                    if (c.col_key === 'stage_payment') {
                      const f = fupCounts?.[o.mobile_so_no]
                      if (noFollowup(o)) {
                        return [cell,
                          <td key={c.col_key + '_nf'} className={`sub ${c.col_key} no-fup`} colSpan={3} title="Family N = No follow-up — is account ka payment follow-up nahi karna hai">🚫 No F/Up (Family N)</td>]
                      }
                      return [cell,
                        <td key={c.col_key + '_n'} className={`sub ${c.col_key}`}>
                          <button className="fup-cell-btn" title="Follow-up modal kholo — date + remark dalo, log dekho" onClick={() => setFupOrder(o)}>
                            📝 <span className={f?.count ? 'fup-badge' : 'muted'}>{f?.count || 0}</span>
                          </button>
                        </td>,
                        <td key={c.col_key + '_x'} className={`sub ${c.col_key}`}>{o.next_followup_date ? fmtDT(o.next_followup_date) : <span className="muted">—</span>}</td>,
                        <td key={c.col_key + '_r'} className={`sub fup-remark-cell ${c.col_key}`}>
                          {f?.lastRemark ? <div className="last-remark" title={f.lastRemark}>{f.lastRemark}</div> : <span className="muted">—</span>}
                        </td>]
                    }
                    return cell
                  }
                  if (c.is_custom) return <CustomCell key={c.col_key} order={o} col={c} onChanged={onChanged} />
                  switch (c.col_key) {
                    case 'mobile_so_no': return <td key={c.col_key}><button className="link" onClick={() => setOpen(o)}>{o.mobile_so_no}</button></td>
                    case 'so_date': return <td key={c.col_key} className="so-date">{fmtDT(o.mobile_so_created)}</td>
                    case 'account_name': return <td key={c.col_key} className="acct">{o.account_name}</td>
                    case 'salesman': return <td key={c.col_key}>{smOf(o) || <span className="muted">—</span>}</td>
                    case 'beat': return <td key={c.col_key}>{beatOf(o) || <span className="muted">—</span>}</td>
                    case 'mobile_no': return <td key={c.col_key}>{o.mobile_no ? <a className="link" href={waLink(o.mobile_no)} target="_blank" rel="noreferrer">{o.mobile_no}</a> : '—'}</td>
                    case 'contact_person': return <ContactCell key={c.col_key} order={o} field="contact_person" placeholder="+ naam bharo" onChanged={onChanged} />
                    case 'email_id': return <ContactCell key={c.col_key} order={o} field="email_id" placeholder="+ email bharo" isEmail onChanged={onChanged} />
                    case 'contact_person2': return <ContactCell key={c.col_key} order={o} field="contact_person2" placeholder="+ person 2" onChanged={onChanged} />
                    case 'email_id2': return <ContactCell key={c.col_key} order={o} field="email_id2" placeholder="+ email 2" isEmail onChanged={onChanged} />
                    case 'client_update': {
                      const link = waLink(o.mobile_no, buildStatusMsg(o, pipe))
                      return <td key={c.col_key}>{link ? <a className="wa-btn" href={link} target="_blank" rel="noreferrer" title="Client ko order status WhatsApp karo">📤 Status</a> : '—'}</td>
                    }
                    case 'acc_family': return <td key={c.col_key}>{o.acc_family || '—'}</td>
                    case 'item': {
                      const ps = o.products || []
                      if (ps.length === 1) return <td key={c.col_key} className="item-cell" title={`${ps[0].name} (${ps[0].code || ''})`}>{ps[0].name}</td>
                      return <td key={c.col_key} className="item-cell muted">{ps.length ? ps.length + ' items' : '—'}</td>
                    }
                    case 'so_qty': {
                      const ps = o.products || []
                      const v = ps.length === 1 ? ps[0].qty : o.so_qty
                      return <td key={c.col_key} className="num">{v != null ? Number(v).toLocaleString('en-IN') : '—'}</td>
                    }
                    case 'unit': {
                      const ps = o.products || []
                      return <td key={c.col_key}>{ps.length === 1 ? (ps[0].unit || '—') : <span className="muted">—</span>}</td>
                    }
                    case 'mobile_qty': {
                      const ps = o.products || []
                      // item view: us line ki mobile qty; SO/bill view: pure order ka total
                      if (ps.length === 1 && ps[0].mqty != null) return <td key={c.col_key} className="num">{Number(ps[0].mqty).toLocaleString('en-IN')} {ps[0].munit || ''}</td>
                      return <td key={c.col_key} className="num">{o.mobile_qty != null ? Number(o.mobile_qty).toLocaleString('en-IN') : '—'}</td>
                    }
                    case 'bill_date': return <td key={c.col_key} className="small">{o.billing_date ? fmtDT(o.billing_date) : <span className="muted">—</span>}</td>
                    case 'credit_date': {
                      const due = paymentDue(o.billing_date, o.credit_days)
                      return <td key={c.col_key} className="small">{due ? <>{fmtDT(due)}{o.credit_days != null && <span className="muted"> ({o.credit_days}d)</span>}</> : <span className="muted">—</span>}</td>
                    }
                    case 'stock': {
                      const ps = o.products || []
                      if (ps.length !== 1) return <td key={c.col_key} className="muted">—</td>
                      if (stockMap == null) return <td key={c.col_key} className="muted">…</td>
                      const s = stockMap[String(ps[0].code || '').trim().toLowerCase()]
                      if (!s) return <td key={c.col_key} className="muted">—</td>
                      return <td key={c.col_key} className={`num stock-cell ${s.total <= 0 ? 'stock-neg' : ''}`} title={s.status}>{s.total.toLocaleString('en-IN')} {s.unit}</td>
                    }
                    case 'so_number': return <td key={c.col_key}>{o.sorder_no ?? '—'}</td>
                    case 'so_amount': return <td key={c.col_key} className="num">{inr(o.sorder_amount ?? o.mobile_so_amount)}</td>
                    case 'pending_qty': return <td key={c.col_key} className={`num ${Number(o.pending_qty) > 0 ? 'warn' : ''}`}>{o.pending_qty ?? '—'}</td>
                    case 'score': return <td key={c.col_key}><ScoreBadge v={score} /></td>
                    default: return <td key={c.col_key}>{String(o[c.col_key] ?? o.custom_data?.[c.col_key] ?? '—')}</td>
                  }
                })}
              </tr>
            ))}
            {!filtered.length && <tr><td colSpan={30} className="empty">Koi order nahi — upar 🔄 Sync ERP dabayen</td></tr>}
          </tbody>
        </table>
      </div>
      {open && <OrderDrawer order={open} stages={stages} scoring={scoring} onClose={() => setOpen(null)} onChanged={onChanged} />}
      {fupOrder && <FollowupModal order={fupOrder} onClose={() => setFupOrder(null)} onChanged={onChanged} />}
    </div>
  )
}
