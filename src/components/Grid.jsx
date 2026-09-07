import { useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { computePipeline, computeScore, fmtDelay, fmtDT, resolveContact, contactMissing, buildStatusMsg, waLink } from '../lib/fms'
import OrderDrawer from './OrderDrawer'

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

// Payment group ka Remark cell: last remark dikhta hai + naya remark yahin se add hota hai
function RemarkCell({ order, lastRemark, onChanged }) {
  const [v, setV] = useState('')
  const save = async () => {
    if (!v.trim()) return
    const { data: { user } } = await supabase.auth.getUser()
    await supabase.from('fms_followups').insert({
      mobile_so_no: order.mobile_so_no, remarks: v.trim(), mode: 'call', created_by: user?.email || '',
    })
    setV('')
    onChanged?.()
  }
  return <td className="sub fup-remark-cell stage_payment">
    {lastRemark && <div className="last-remark" title={lastRemark}>{lastRemark}</div>}
    <input className="fill-inp remark-inp" placeholder="+ naya remark, Enter dabao" value={v}
      onChange={(e) => setV(e.target.value)} onBlur={save}
      onKeyDown={(e) => e.key === 'Enter' && e.target.blur()} />
  </td>
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

export default function Grid({ orders, stages, columns, scoring, fupCounts, onChanged }) {
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('all')
  const [open, setOpen] = useState(null)

  const rows = useMemo(() => orders.map((o) => {
    const pipe = computePipeline(o, stages, scoring)
    return { o, pipe, score: computeScore(pipe, scoring) }
  }), [orders, stages, scoring])

  const filtered = rows.filter(({ o, pipe }) => {
    if (q && !(`${o.account_name} ${o.mobile_so_no} ${o.mobile_no}`.toLowerCase().includes(q.toLowerCase()))) return false
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
        <input className="search" placeholder="🔍 Client / SO No…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">All orders</option>
          <option value="delayed">⚠ Delayed</option>
          <option value="payment">💰 Payment due</option>
          <option value="pending">📦 Pending qty</option>
          <option value="contact">📇 Contact info missing</option>
        </select>
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
                ? <th key={c.col_key} colSpan={c.col_key === 'stage_billing' ? 4 : c.col_key === 'stage_payment' ? 6 : 3} className={`stage-h ${c.col_key}`}>{c.label}</th>
                : <th key={c.col_key} rowSpan={2} className={c.is_custom ? 'cust-h' : ''}>{c.label}{c.is_custom ? ' ✏️' : ''}</th>)}
            </tr>
            <tr>
              {visCols.filter((c) => c.col_type === 'stage').flatMap((c) => [
                <th key={c.col_key + 'p'} className={`sub-h ${c.col_key} stg-first`}>Pln</th>,
                <th key={c.col_key + 'a'} className={`sub-h ${c.col_key}`}>Act</th>,
                <th key={c.col_key + 'd'} className={`sub-h ${c.col_key}`}>Delay</th>,
                ...(c.col_key === 'stage_billing' ? [<th key={c.col_key + 'i'} className={`sub-h ${c.col_key}`}>Inv No</th>] : []),
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
              <tr key={o.mobile_so_no}>
                {visCols.map((c) => {
                  if (c.col_type === 'stage') {
                    const cell = <StageCell key={c.col_key} p={pipe[stageMap[c.col_key]?.stage_key]} sk={c.col_key} />
                    if (c.col_key === 'stage_billing') return [cell,
                      <td key={c.col_key + '_inv'} className={`sub inv-col ${c.col_key}`}>
                        {(o.bill_nos || []).length ? (o.bill_nos || []).map((b, i) => {
                          const u = (o.inv_urls || [])[i]
                          return u
                            ? <a key={b} className="link" href={u} target="_blank" rel="noreferrer" title="Invoice PDF kholo">#{b}</a>
                            : <span key={b}>#{b}</span>
                        }) : <span className="muted">—</span>}
                      </td>]
                    if (c.col_key === 'stage_payment') {
                      const f = fupCounts?.[o.mobile_so_no]
                      return [cell,
                        <td key={c.col_key + '_n'} className={`sub ${c.col_key}`}><span className={f?.count ? 'fup-badge' : 'muted'}>{f?.count || '—'}</span></td>,
                        <td key={c.col_key + '_x'} className={`sub cust ${c.col_key}`}>
                          <input type="datetime-local" value={toLocalInput(o.next_followup_date)}
                            onChange={async (e) => {
                              const v = e.target.value ? new Date(e.target.value).toISOString() : null
                              await supabase.from('fms_orders').update({ next_followup_date: v }).eq('mobile_so_no', o.mobile_so_no)
                              onChanged?.()
                            }} />
                        </td>,
                        <RemarkCell key={c.col_key + '_r'} order={o} lastRemark={f?.lastRemark} onChanged={onChanged} />]
                    }
                    return cell
                  }
                  if (c.is_custom) return <CustomCell key={c.col_key} order={o} col={c} onChanged={onChanged} />
                  switch (c.col_key) {
                    case 'mobile_so_no': return <td key={c.col_key}><button className="link" onClick={() => setOpen(o)}>{o.mobile_so_no}</button></td>
                    case 'so_date': return <td key={c.col_key} className="so-date">{fmtDT(o.mobile_so_created)}</td>
                    case 'account_name': return <td key={c.col_key} className="acct">{o.account_name}</td>
                    case 'mobile_no': return <td key={c.col_key}>{o.mobile_no ? <a className="link" href={waLink(o.mobile_no)} target="_blank" rel="noreferrer">{o.mobile_no}</a> : '—'}</td>
                    case 'contact_person': return <ContactCell key={c.col_key} order={o} field="contact_person" placeholder="+ naam bharo" onChanged={onChanged} />
                    case 'contact_person2': return <ContactCell key={c.col_key} order={o} field="contact_person2" placeholder="+ person 2" onChanged={onChanged} />
                    case 'email_id': return <ContactCell key={c.col_key} order={o} field="email_id" placeholder="+ email bharo" isEmail onChanged={onChanged} />
                    case 'email_id2': return <ContactCell key={c.col_key} order={o} field="email_id2" placeholder="+ email 2" isEmail onChanged={onChanged} />
                    case 'client_update': {
                      const link = waLink(o.mobile_no, buildStatusMsg(o, pipe))
                      return <td key={c.col_key}>{link ? <a className="wa-btn" href={link} target="_blank" rel="noreferrer" title="Client ko order status WhatsApp karo">📤 Status</a> : '—'}</td>
                    }
                    case 'acc_family': return <td key={c.col_key}>{o.acc_family || '—'}</td>
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
    </div>
  )
}
