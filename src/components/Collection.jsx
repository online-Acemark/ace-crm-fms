import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { buildCollectionMsg, waLink, logWaSendParty, suggestNextFollowup } from '../lib/fms'

// Collection tab: poore ledger ka party-wise outstanding (fms_collection, har ghante ERP se sync)
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
const toLocalInput = (dt) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}T${p(dt.getHours())}:${p(dt.getMinutes())}`
}

const isCross = (p) => Number(p.credit_limit) > 0 && Number(p.total_pending) > Number(p.credit_limit)
const isFupDue = (p) => p.next_followup_date && new Date(p.next_followup_date) <= new Date()

// Priority: jitna bada number, utna upar. Naya banda bas upar se neeche kaam kare.
function priorityOf(p) {
  if (isFupDue(p)) return { rank: 4, label: 'Due today', cls: 'pr-due', hint: 'You set a follow-up date for today — call this party first' }
  if ((p.oldest_od || 0) > 180 || isCross(p)) return { rank: 3, label: 'Urgent', cls: 'pr-hot', hint: isCross(p) ? 'Party has crossed the credit limit' : 'Oldest bill is more than 6 months overdue' }
  if ((p.oldest_od || 0) > 90) return { rank: 2, label: 'Act soon', cls: 'pr-warm', hint: 'Oldest bill is more than 3 months overdue' }
  if ((p.oldest_od || 0) > 30) return { rank: 1, label: 'Watch', cls: 'pr-mild', hint: 'Oldest bill is more than 1 month overdue' }
  return { rank: 0, label: 'OK', cls: 'pr-ok', hint: 'Nothing is very old yet' }
}

// Ek-click filter chips — dropdown se aasan
const PRESETS = [
  { key: 'all', label: 'All' },
  { key: 'due', label: '📅 Due today' },
  { key: 'hot', label: '🔴 Urgent (180+/limit)' },
  { key: 'warm', label: '🟠 90+ days' },
  { key: 'pdc', label: '🧾 PDC received' },
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

// Party expand: bills detail + guided follow-up form + purani baat-cheet
function PartyDetail({ p, demo, onSaved }) {
  const [logs, setLogs] = useState(null)
  const [remark, setRemark] = useState('')
  const [amount, setAmount] = useState('')
  const [nextDate, setNextDate] = useState(() => toLocalInput(suggestNextFollowup()))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [okMsg, setOkMsg] = useState('')

  useEffect(() => {
    supabase.from('fms_followups').select('*').eq('party_name', p.party_name)
      .order('created_at', { ascending: false }).limit(20)
      .then(({ data }) => setLogs(data || []))
  }, [p.party_name])

  const save = async () => {
    if (!remark.trim()) { setErr('Write what was discussed first (Step 2)'); return }
    if (!nextDate) { setErr('Set the next follow-up date (Step 3)'); return }
    if (demo) { setErr('Demo mode cannot save — use the real login'); return }
    setSaving(true); setErr(''); setOkMsg('')
    const { data: { user } } = await supabase.auth.getUser()
    const { error: e1 } = await supabase.from('fms_followups').insert({
      party_name: p.party_name, remarks: remark.trim(), mode: 'call',
      amount_received: amount ? Number(amount) : null,
      followup_date: new Date().toISOString().slice(0, 10),
      created_by: user?.email || '',
    })
    const { error: e2 } = await supabase.from('fms_collection')
      .update({ next_followup_date: new Date(nextDate).toISOString() }).eq('party_name', p.party_name)
    setSaving(false)
    if (e1 || e2) { setErr('Save failed: ' + (e1 || e2).message); return }
    setRemark(''); setAmount('')
    setOkMsg('✅ Saved! On that date this party will automatically appear under "Due today".')
    setTimeout(() => setOkMsg(''), 5000)
    const { data } = await supabase.from('fms_followups').select('*').eq('party_name', p.party_name)
      .order('created_at', { ascending: false }).limit(20)
    setLogs(data || [])
    onSaved?.()
  }

  const wa = waLink(p.mobile, buildCollectionMsg(p))
  const overdueBills = (p.bills || []).filter((b) => (b.od || 0) > 0)

  return (
    <div className="coll-detail">
      <div className="coll-fup">
        <div className="coll-steps">
          <h4>What to do with this party:</h4>
          <div className="coll-step-btns">
            <div className="coll-step">
              <span className="step-num">1</span>
              <div>
                <b>Talk to them</b>
                <div className="step-actions">
                  {p.mobile && <a className="btn primary sm" href={`tel:${p.mobile}`}>📞 Call {p.mobile}</a>}
                  {wa && <a className="wa-btn" href={wa} target="_blank" rel="noreferrer"
                    onClick={() => logWaSendParty(p.party_name, 'Sent WhatsApp payment reminder')}>📤 Send WhatsApp</a>}
                  {!p.mobile && <span className="muted small">No mobile number — ask salesman {p.salesman || ''}</span>}
                </div>
                <p className="muted small">Ask: "Total {inrShort(p.total_pending)} is pending{p.oldest_od ? `, oldest bill ${p.oldest_od} days overdue` : ''} — when can we expect the payment?"</p>
              </div>
            </div>
            <div className="coll-step">
              <span className="step-num">2</span>
              <div className="step-form">
                <b>Note what they said</b>
                <input placeholder='e.g. "Will pay by RTGS on the 5th"' value={remark} onChange={(e) => setRemark(e.target.value)} />
                <input type="number" placeholder="Amount received now (leave blank if none)" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
            </div>
            <div className="coll-step">
              <span className="step-num">3</span>
              <div className="step-form">
                <b>When to remind next?</b>
                <input type="datetime-local" value={nextDate} onChange={(e) => setNextDate(e.target.value)} />
                <button className="btn primary" onClick={save} disabled={saving}>{saving ? '⏳ Saving…' : '💾 Save'}</button>
              </div>
            </div>
          </div>
          {err && <p className="err small">{err}</p>}
          {okMsg && <p className="green-t small"><b>{okMsg}</b></p>}
        </div>
        <div className="fup-log">
          <h4>🗒️ Past conversations {logs?.length ? `(${logs.length})` : ''}</h4>
          {logs === null ? <p className="muted small">Loading…</p>
            : logs.length === 0 ? <p className="muted small">No conversation recorded with this party yet — you are the first to call.</p>
            : logs.map((l) => (
              <div key={l.id} className="fup-log-item">
                <span className="muted small">{new Date(l.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                {l.mode === 'whatsapp' ? ' 📤 ' : ' 📞 '}
                <span>{l.remarks}</span>
                {l.amount_received != null && <b className="green-t"> · {inr(l.amount_received)} received</b>}
                {l.created_by && <span className="muted small"> — {l.created_by.split('@')[0]}</span>}
              </div>
            ))}
        </div>
      </div>
      <div className="coll-bills">
        <h4>🧾 Pending bills ({(p.bills || []).length}{overdueBills.length ? ` — ${overdueBills.length} overdue` : ''})</h4>
        <div className="tbl-wrap-inner">
          <table className="cfg-tbl coll-bill-tbl">
            <thead><tr><th>Bill No</th><th>Firm</th><th>Bill Date</th><th>Age</th><th>Pending</th><th>PDC (cheque)</th><th>Bilty</th><th>Notes</th></tr></thead>
            <tbody>
              {(p.bills || []).slice(0, 100).map((b, i) => (
                <tr key={i} className={b.od > 180 ? 'coll-old' : ''}>
                  <td><b>{b.vno || '—'}</b></td>
                  <td className="small">{b.company || '—'}</td>
                  <td>{dmy(b.date)}</td>
                  <td>{b.od > 0 ? <span className={b.od > 90 ? 'red-t' : 'amber-t'}><b>{b.od} days overdue</b></span> : <span className="muted small">{b.days != null ? `${b.days} days (not due yet)` : '—'}</span>}</td>
                  <td><b>{inr(b.pending)}</b></td>
                  <td className="small">{b.pdc_rcpt || b.pdc_date ? `✅ ${b.pdc_rcpt || ''} ${dmy(b.pdc_date)}` : '—'}</td>
                  <td className="small">{b.bilty || '—'}</td>
                  <td className="small coll-notes" title={b.notes || ''}>{b.notes || '—'}</td>
                </tr>
              ))}
              {(p.bills || []).length > 100 && (
                <tr><td colSpan={8} className="muted small">…and {(p.bills || []).length - 100} more bills (oldest 100 shown above)</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

export default function Collection() {
  const demo = new URLSearchParams(window.location.search).has('demo')
  const [rows, setRows] = useState(null)
  const [q, setQ] = useState('')
  const [salesman, setSalesman] = useState('')
  const [preset, setPreset] = useState('all')
  const [sort, setSort] = useState(['priority', 'desc'])
  const [open, setOpen] = useState(null) // party_name jo expand hai
  const [tick, setTick] = useState(0)
  const [showHelp, setShowHelp] = useState(() => !localStorage.getItem('fms_coll_help_seen'))

  useEffect(() => {
    if (demo) {
      // demo mode me DB access nahi hai — sample data dikhao taaki tab samajh aaye
      fetch('/demo-collection.json').then((r) => r.json()).then(setRows).catch(() => setRows([]))
      return
    }
    supabase.from('fms_collection').select('*').then(({ data }) => setRows(data || []))
  }, [tick, demo])

  const salesmen = useMemo(() => [...new Set((rows || []).map((r) => r.salesman).filter(Boolean))].sort(), [rows])
  // modal ke liye: save/re-sync ke baad bhi fresh row mile
  const openParty = useMemo(() => (rows || []).find((r) => r.party_name === open) || null, [rows, open])

  const kpi = useMemo(() => {
    const list = rows || []
    return {
      total: list.reduce((a, r) => a + Number(r.total_pending || 0), 0),
      due: list.filter(isFupDue).length,
      hot: list.filter((r) => (r.oldest_od || 0) > 180 || isCross(r)).length,
      old180: list.reduce((a, r) => a + Number(r.aging?.b180p || 0), 0),
      pdc: list.filter((r) => r.has_pdc).length,
    }
  }, [rows])

  const filtered = useMemo(() => {
    let list = rows || []
    const s = q.trim().toLowerCase()
    if (s) list = list.filter((r) => `${r.party_name} ${r.mobile || ''} ${r.city || ''} ${r.salesman || ''}`.toLowerCase().includes(s))
    if (salesman) list = list.filter((r) => r.salesman === salesman)
    if (preset === 'due') list = list.filter(isFupDue)
    if (preset === 'hot') list = list.filter((r) => (r.oldest_od || 0) > 180 || isCross(r))
    if (preset === 'warm') list = list.filter((r) => (r.oldest_od || 0) > 90)
    if (preset === 'pdc') list = list.filter((r) => r.has_pdc)
    const [k, dir] = sort
    const mul = dir === 'desc' ? -1 : 1
    return [...list].sort((a, b) => {
      if (k === 'priority') {
        // pehle priority, same priority me bada amount upar — "upar se kaam karo" hamesha sahi rahe
        const d = priorityOf(a).rank - priorityOf(b).rank
        if (d !== 0) return d * mul
        return (Number(a.total_pending || 0) - Number(b.total_pending || 0)) * mul
      }
      const av = k === 'party_name' ? String(a[k] || '') : Number(a[k] || 0)
      const bv = k === 'party_name' ? String(b[k] || '') : Number(b[k] || 0)
      return (av < bv ? -1 : av > bv ? 1 : 0) * mul
    })
  }, [rows, q, salesman, preset, sort])

  const sortBtn = (key, label, title) => (
    <button className="link th-sort" title={title || ''} onClick={() => setSort(([k, d]) => [key, k === key && d === 'desc' ? 'asc' : 'desc'])}>
      {label}{sort[0] === key ? (sort[1] === 'desc' ? ' ↓' : ' ↑') : ''}
    </button>
  )

  const dismissHelp = () => { setShowHelp(false); try { localStorage.setItem('fms_coll_help_seen', '1') } catch { /* private mode */ } }

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
            <span>3️⃣ Note what they said + set next date → Save</span>
            <button className="btn ghost sm" onClick={dismissHelp}>✕ Got it</button>
          </div>
        )}

        <div className="coll-kpis">
          <button className={preset === 'all' ? 'kpi-card active' : 'kpi-card'} onClick={() => setPreset('all')}>
            <b>{inrShort(kpi.total)}</b><span>Total pending · {rows.length} parties</span>
          </button>
          <button className={preset === 'due' ? 'kpi-card due active' : 'kpi-card due'} onClick={() => setPreset('due')}>
            <b>{kpi.due}</b><span>📅 Follow-ups due today</span>
          </button>
          <button className={preset === 'hot' ? 'kpi-card red active' : 'kpi-card red'} onClick={() => setPreset('hot')}>
            <b>{kpi.hot}</b><span>🔴 Urgent — {inrShort(kpi.old180)} very old</span>
          </button>
          <button className={preset === 'pdc' ? 'kpi-card active' : 'kpi-card'} onClick={() => setPreset('pdc')}>
            <b>{kpi.pdc}</b><span>🧾 PDC (cheque) received</span>
          </button>
        </div>

        <div className="action-filter coll-filters">
          <div className="coll-presets">
            {PRESETS.map((p) => (
              <button key={p.key} className={preset === p.key ? 'preset-chip active' : 'preset-chip'} onClick={() => setPreset(p.key)}>{p.label}</button>
            ))}
          </div>
          <input className="search" placeholder="🔍 Search party / mobile / city…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={salesman} onChange={(e) => setSalesman(e.target.value)}>
            <option value="">Salesman: All</option>
            {salesmen.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          {(q || salesman || preset !== 'all') && (
            <button className="btn ghost sm" onClick={() => { setQ(''); setSalesman(''); setPreset('all') }}>✕ Clear filters</button>
          )}
          <span className="filter-count active">🔎 {filtered.length} / {rows.length} parties</span>
        </div>
      </div>

      {demo && rows.length > 0 && (
        <div className="panel demo-note"><p className="muted small">⚠️ This is SAMPLE data (demo mode). Login without <code>?demo</code> to see the real data.</p></div>
      )}
      {rows.length === 0 && (
        <div className="panel"><p className="muted">No collection data yet. Wait for the next ERP sync (hourly at :20).</p></div>
      )}

      {rows.length > 0 && filtered.length === 0 && (
        <div className="panel"><p className="muted">No party matches this filter. <button className="link" onClick={() => { setQ(''); setSalesman(''); setPreset('all') }}>Clear filters</button></p></div>
      )}

      <div className="panel coll-list">
        <table className="cfg-tbl coll-tbl">
          <thead>
            <tr>
              <th>{sortBtn('priority', 'Priority', 'Most important on top — work in this order')}</th>
              <th>{sortBtn('party_name', 'Party')}</th>
              <th>{sortBtn('total_pending', 'Total Pending')}</th>
              <th>{sortBtn('oldest_od', 'Oldest Due', 'How many days the oldest bill is overdue')}</th>
              <th title="How old the money is — green is new, red is very old">Aging</th>
              <th title="Credit limit given to the party and how much is used">Credit Limit</th>
              <th>Last Payment</th>
              <th>Next F/Up</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 200).map((p) => {
              const pr = priorityOf(p)
              const wa = waLink(p.mobile, buildCollectionMsg(p))
              return (
                <tr key={p.party_name} className="coll-row" onClick={() => setOpen(p.party_name)}>
                  <td><span className={`pr-badge ${pr.cls}`} title={pr.hint}>{pr.label}</span></td>
                  <td>
                    <span className="coll-party"><b>{p.party_name}</b></span>
                    <div className="muted small">{[p.salesman, p.city].filter(Boolean).join(' · ')}{p.has_pdc && ' · 🧾 PDC'}</div>
                  </td>
                  <td><b>{inrShort(p.total_pending)}</b><div className="muted small">{p.bill_count} bills</div></td>
                  <td>{p.oldest_od ? <span className={p.oldest_od > 90 ? 'red-t' : p.oldest_od > 30 ? 'amber-t' : ''}><b>{p.oldest_od} days</b></span> : '—'}</td>
                  <td><AgingChips aging={p.aging} /></td>
                  <td><LimitBar pending={p.total_pending} limit={p.credit_limit} /></td>
                  <td className="small">{p.last_pay_amt ? <>{inrShort(p.last_pay_amt)}<div className="muted">{dmy(p.last_pay_date)}</div></> : <span className="muted">—</span>}</td>
                  <td className="small">{p.next_followup_date ? <span className={isFupDue(p) ? 'amber-t' : ''}>{isFupDue(p) && '📅 '}{dmy(p.next_followup_date)}</span> : '—'}</td>
                  <td className="coll-actions" onClick={(e) => e.stopPropagation()}>
                    {p.mobile && <a className="btn ghost sm" href={`tel:${p.mobile}`} title={`Call: ${p.mobile}`}>📞</a>}
                    {wa && <a className="wa-btn" href={wa} target="_blank" rel="noreferrer" title="Send WhatsApp reminder"
                      onClick={() => logWaSendParty(p.party_name, 'Sent WhatsApp payment reminder')}>📤</a>}
                    <button className="btn ghost sm" title="Add a follow-up note" onClick={() => setOpen(p.party_name)}>📝</button>
                  </td>
                </tr>
              )
            })}
            {filtered.length > 200 && <tr><td colSpan={9} className="muted small">…and {filtered.length - 200} more parties — use the search box above</td></tr>}
          </tbody>
        </table>
      </div>

      {openParty && (
        <div className="modal-back" onClick={() => setOpen(null)}>
          <div className="modal coll-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <h3>{openParty.party_name} <span className={`pr-badge ${priorityOf(openParty).cls}`} title={priorityOf(openParty).hint}>{priorityOf(openParty).label}</span></h3>
                <p className="muted small coll-modal-sub">
                  {[openParty.salesman, openParty.city, openParty.mobile].filter(Boolean).join(' · ')}
                  {' · '}Total pending <b>{inrShort(openParty.total_pending)}</b> ({openParty.bill_count} bills)
                  {openParty.oldest_od ? <> · oldest <b>{openParty.oldest_od} days</b></> : null}
                </p>
              </div>
              <button className="btn ghost" onClick={() => setOpen(null)}>✕ Close</button>
            </div>
            <PartyDetail p={openParty} demo={demo} onSaved={() => setTick((t) => t + 1)} />
          </div>
        </div>
      )}
    </div>
  )
}
