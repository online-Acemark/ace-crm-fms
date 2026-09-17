import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { buildCollectionMsg, waLink, logWaSendParty, suggestNextFollowup } from '../lib/fms'

// Collection tab: poore ledger ka party-wise outstanding (fms_collection, har ghante ERP se sync)
const BUCKETS = [
  ['b0_30', '0-30'], ['b31_60', '31-60'], ['b61_90', '61-90'], ['b91_120', '91-120'],
  ['b121_150', '121-150'], ['b151_180', '151-180'], ['b180p', '180+'],
]
const inr = (v) => '₹' + Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })
const dmy = (v) => v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'
const toLocalInput = (dt) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}T${p(dt.getHours())}:${p(dt.getMinutes())}`
}

function AgingChips({ aging }) {
  const a = aging || {}
  const cls = ['bkt-ok', 'bkt-ok', 'bkt-8', 'bkt-8', 'bkt-30', 'bkt-30', 'bkt-30']
  return (
    <div className="aging-chips">
      {BUCKETS.map(([k, label], i) => {
        const v = Number(a[k] || 0)
        if (!v) return null
        return <span key={k} className={`age-chip ${cls[i]}`} title={`${label} din purana`}>{label}d: {inr(v)}</span>
      })}
    </div>
  )
}

function LimitBar({ pending, limit }) {
  if (!Number(limit)) return <span className="muted small">limit —</span>
  const pct = (Number(pending) / Number(limit)) * 100
  const over = pct > 100
  return (
    <div className="limit-bar-wrap" title={`Baaki ${inr(pending)} / Limit ${inr(limit)} (${Math.round(pct)}%)`}>
      <div className="limit-bar"><div className={over ? 'limit-fill over' : 'limit-fill'} style={{ width: Math.min(pct, 100) + '%' }} /></div>
      <span className={over ? 'small red-t' : 'small muted'}>{Math.round(pct)}%{over && ' ⚠️'}</span>
    </div>
  )
}

// Party row expand hone par: bills detail + follow-up log + naya follow-up form
function PartyDetail({ p, demo, onSaved }) {
  const [logs, setLogs] = useState(null)
  const [remark, setRemark] = useState('')
  const [amount, setAmount] = useState('')
  const [nextDate, setNextDate] = useState(() => toLocalInput(suggestNextFollowup()))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    supabase.from('fms_followups').select('*').eq('party_name', p.party_name)
      .order('created_at', { ascending: false }).limit(20)
      .then(({ data }) => setLogs(data || []))
  }, [p.party_name])

  const save = async () => {
    if (!remark.trim()) { setErr('Remark likhna zaroori hai'); return }
    if (!nextDate) { setErr('Next follow-up date zaroori hai'); return }
    if (demo) { setErr('Demo mode me save nahi hota — login karke use karo'); return }
    setSaving(true); setErr('')
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
    if (e1 || e2) { setErr((e1 || e2).message); return }
    setRemark(''); setAmount('')
    const { data } = await supabase.from('fms_followups').select('*').eq('party_name', p.party_name)
      .order('created_at', { ascending: false }).limit(20)
    setLogs(data || [])
    onSaved?.()
  }

  return (
    <div className="coll-detail">
      <div className="coll-bills">
        <h4>🧾 Pending Bills ({(p.bills || []).length})</h4>
        <div className="tbl-wrap-inner">
          <table className="cfg-tbl coll-bill-tbl">
            <thead><tr><th>Bill No</th><th>Firm</th><th>Date</th><th>Din</th><th>Overdue</th><th>Baaki</th><th>PDC</th><th>Bilty</th><th>Notes</th></tr></thead>
            <tbody>
              {(p.bills || []).slice(0, 100).map((b, i) => (
                <tr key={i} className={b.od > 180 ? 'coll-old' : ''}>
                  <td><b>{b.vno || '—'}</b></td>
                  <td className="small">{b.company || '—'}</td>
                  <td>{dmy(b.date)}</td>
                  <td>{b.days ?? '—'}</td>
                  <td>{b.od > 0 ? <span className={b.od > 90 ? 'red-t' : 'amber-t'}><b>{b.od}d</b></span> : '—'}</td>
                  <td><b>{inr(b.pending)}</b></td>
                  <td className="small">{b.pdc_rcpt || b.pdc_date ? `✅ ${b.pdc_rcpt || ''} ${dmy(b.pdc_date)}` : '—'}</td>
                  <td className="small">{b.bilty || '—'}</td>
                  <td className="small coll-notes" title={b.notes || ''}>{b.notes || '—'}</td>
                </tr>
              ))}
              {(p.bills || []).length > 100 && (
                <tr><td colSpan={9} className="muted small">…aur {(p.bills || []).length - 100} bills (sabse purane 100 upar dikh rahe hain)</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div className="coll-fup">
        <h4>📝 Follow-up</h4>
        <div className="coll-fup-form">
          <input placeholder="Remark — baat kya hui? *" value={remark} onChange={(e) => setRemark(e.target.value)} />
          <input type="number" placeholder="Amount mila (optional)" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <label className="small muted">Next follow-up *<input type="datetime-local" value={nextDate} onChange={(e) => setNextDate(e.target.value)} /></label>
          <button className="btn primary sm" onClick={save} disabled={saving}>{saving ? '⏳' : '💾 Save'}</button>
        </div>
        {err && <p className="err small">{err}</p>}
        <div className="fup-log">
          {logs === null ? <p className="muted small">Log load ho raha hai…</p>
            : logs.length === 0 ? <p className="muted small">Is party ka abhi koi follow-up log nahi hai.</p>
            : logs.map((l) => (
              <div key={l.id} className="fup-log-item">
                <span className="muted small">{new Date(l.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                {l.mode === 'whatsapp' ? ' 📤 ' : ' 📞 '}
                <span>{l.remarks}</span>
                {l.amount_received != null && <b className="green-t"> · {inr(l.amount_received)} mila</b>}
                {l.created_by && <span className="muted small"> — {l.created_by.split('@')[0]}</span>}
              </div>
            ))}
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
  const [bucket, setBucket] = useState('')
  const [onlyCross, setOnlyCross] = useState(false)
  const [onlyPdc, setOnlyPdc] = useState(false)
  const [sort, setSort] = useState(['total_pending', 'desc'])
  const [open, setOpen] = useState(null) // party_name jo expand hai
  const [tick, setTick] = useState(0)

  useEffect(() => {
    supabase.from('fms_collection').select('*').then(({ data }) => setRows(data || []))
  }, [tick])

  const salesmen = useMemo(() => [...new Set((rows || []).map((r) => r.salesman).filter(Boolean))].sort(), [rows])

  const filtered = useMemo(() => {
    let list = rows || []
    const s = q.trim().toLowerCase()
    if (s) list = list.filter((r) => `${r.party_name} ${r.mobile || ''} ${r.city || ''} ${r.salesman || ''}`.toLowerCase().includes(s))
    if (salesman) list = list.filter((r) => r.salesman === salesman)
    if (bucket) list = list.filter((r) => Number(r.aging?.[bucket] || 0) > 0)
    if (onlyCross) list = list.filter((r) => Number(r.credit_limit) > 0 && Number(r.total_pending) > Number(r.credit_limit))
    if (onlyPdc) list = list.filter((r) => r.has_pdc)
    const [k, dir] = sort
    const mul = dir === 'desc' ? -1 : 1
    return [...list].sort((a, b) => {
      const av = k === 'party_name' ? String(a[k] || '') : Number(a[k] || 0)
      const bv = k === 'party_name' ? String(b[k] || '') : Number(b[k] || 0)
      return (av < bv ? -1 : av > bv ? 1 : 0) * mul
    })
  }, [rows, q, salesman, bucket, onlyCross, onlyPdc, sort])

  const kpi = useMemo(() => {
    const list = rows || []
    return {
      total: list.reduce((a, r) => a + Number(r.total_pending || 0), 0),
      old180: list.reduce((a, r) => a + Number(r.aging?.b180p || 0), 0),
      cross: list.filter((r) => Number(r.credit_limit) > 0 && Number(r.total_pending) > Number(r.credit_limit)).length,
      pdc: list.filter((r) => r.has_pdc).length,
    }
  }, [rows])

  const sortBtn = (key, label) => (
    <button className="link th-sort" onClick={() => setSort(([k, d]) => [key, k === key && d === 'desc' ? 'asc' : 'desc'])}>
      {label}{sort[0] === key ? (sort[1] === 'desc' ? ' ↓' : ' ↑') : ''}
    </button>
  )

  if (rows === null) return <div className="action-page"><p className="muted">Collection data load ho raha hai…</p></div>

  return (
    <div className="action-page coll-page">
      <div className="action-head">
        <h2>💰 Collection — Pura Ledger Outstanding</h2>
        <p className="muted small">Saari firms ke pending bills party-wise (ERP se har ghante sync). FMS Grid sirf mobile-app orders dikhata hai — yahan PURA bakaya hai.</p>
        <div className="coll-kpis">
          <span className="kpi-chip"><b>{inr(kpi.total)}</b> total baaki · {rows.length} parties</span>
          <span className="kpi-chip red">180+ din: <b>{inr(kpi.old180)}</b></span>
          <span className="kpi-chip amber">Limit cross: <b>{kpi.cross}</b></span>
          <span className="kpi-chip">PDC mila: <b>{kpi.pdc}</b></span>
        </div>
        <div className="action-filter coll-filters">
          <input className="search" placeholder="🔍 Party / mobile / city / salesman…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={salesman} onChange={(e) => setSalesman(e.target.value)}>
            <option value="">Salesman: sab</option>
            {salesmen.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={bucket} onChange={(e) => setBucket(e.target.value)}>
            <option value="">Aging: sab</option>
            {BUCKETS.map(([k, l]) => <option key={k} value={k}>{l} din</option>)}
          </select>
          <label className="chk"><input type="checkbox" checked={onlyCross} onChange={(e) => setOnlyCross(e.target.checked)} /> Limit cross</label>
          <label className="chk"><input type="checkbox" checked={onlyPdc} onChange={(e) => setOnlyPdc(e.target.checked)} /> PDC wale</label>
          <span className="filter-count active">🔎 {filtered.length} / {rows.length}</span>
        </div>
      </div>

      {rows.length === 0 && (
        <div className="panel"><p className="muted">Koi collection data nahi mila.{demo ? ' (Demo mode me DB access nahi hai — real login se dekho.)' : ' Agla ERP sync (har ghante :20 par) hone do.'}</p></div>
      )}

      <div className="panel coll-list">
        <table className="cfg-tbl coll-tbl">
          <thead>
            <tr>
              <th>{sortBtn('party_name', 'Party')}</th>
              <th>Salesman</th>
              <th>{sortBtn('total_pending', 'Total Baaki')}</th>
              <th>{sortBtn('oldest_od', 'Oldest OD')}</th>
              <th>Aging</th>
              <th>Credit Limit</th>
              <th>Last Pay</th>
              <th>Next F/Up</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 200).map((p) => {
              const wa = waLink(p.mobile, buildCollectionMsg(p))
              const fupDue = p.next_followup_date && new Date(p.next_followup_date) <= new Date()
              return [
                <tr key={p.party_name} className={open === p.party_name ? 'coll-row open' : 'coll-row'}>
                  <td>
                    <button className="link" onClick={() => setOpen(open === p.party_name ? null : p.party_name)}>
                      {open === p.party_name ? '▼' : '▶'} <b>{p.party_name}</b>
                    </button>
                    <div className="muted small">{[p.city, p.mobile].filter(Boolean).join(' · ')}{p.has_pdc && ' · ✅ PDC'}</div>
                  </td>
                  <td className="small">{p.salesman || '—'}<div className="muted small">{p.beat || ''}</div></td>
                  <td><b>{inr(p.total_pending)}</b><div className="muted small">{p.bill_count} bills</div></td>
                  <td>{p.oldest_od ? <span className={p.oldest_od > 90 ? 'red-t' : p.oldest_od > 30 ? 'amber-t' : ''}><b>{p.oldest_od}d</b></span> : '—'}</td>
                  <td><AgingChips aging={p.aging} /></td>
                  <td><LimitBar pending={p.total_pending} limit={p.credit_limit} /></td>
                  <td className="small">{p.last_pay_amt ? <>{inr(p.last_pay_amt)}<div className="muted">{dmy(p.last_pay_date)}</div></> : '—'}</td>
                  <td className="small">{p.next_followup_date ? <span className={fupDue ? 'amber-t' : ''}>{fupDue && '📅 '}{dmy(p.next_followup_date)}</span> : '—'}</td>
                  <td>{wa && <a className="wa-btn" href={wa} target="_blank" rel="noreferrer"
                    onClick={() => logWaSendParty(p.party_name, 'WhatsApp payment reminder bheja')}>📤</a>}</td>
                </tr>,
                open === p.party_name && (
                  <tr key={p.party_name + '_d'} className="coll-detail-row">
                    <td colSpan={9}><PartyDetail p={p} demo={demo} onSaved={() => setTick((t) => t + 1)} /></td>
                  </tr>
                ),
              ]
            })}
            {filtered.length > 200 && <tr><td colSpan={9} className="muted small">…aur {filtered.length - 200} parties — filter/search use karo</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
