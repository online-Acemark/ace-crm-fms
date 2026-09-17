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
  if (isFupDue(p)) return { rank: 4, label: 'Aaj follow-up', cls: 'pr-due', hint: 'Aapne khud is party ke liye aaj ki date lagayi thi — pehle isko call karo' }
  if ((p.oldest_od || 0) > 180 || isCross(p)) return { rank: 3, label: 'Turant', cls: 'pr-hot', hint: isCross(p) ? 'Party ne credit limit paar kar di hai' : 'Bill 6 mahine se zyada purana hai' }
  if ((p.oldest_od || 0) > 90) return { rank: 2, label: 'Jaldi karo', cls: 'pr-warm', hint: 'Bill 3 mahine se zyada purana hai' }
  if ((p.oldest_od || 0) > 30) return { rank: 1, label: 'Dhyan do', cls: 'pr-mild', hint: 'Bill 1 mahine se purana hai' }
  return { rank: 0, label: 'Theek hai', cls: 'pr-ok', hint: 'Abhi zyada purana nahi hua' }
}

// Ek-click filter chips — dropdown se aasan
const PRESETS = [
  { key: 'all', label: 'Sab' },
  { key: 'due', label: '📅 Aaj ke follow-up' },
  { key: 'hot', label: '🔴 Turant (180+/limit)' },
  { key: 'warm', label: '🟠 90+ din' },
  { key: 'pdc', label: '🧾 Cheque (PDC) mila' },
]

function AgingChips({ aging }) {
  const a = aging || {}
  const cls = ['bkt-ok', 'bkt-ok', 'bkt-8', 'bkt-8', 'bkt-30', 'bkt-30', 'bkt-30']
  const chips = BUCKETS.map(([k, label], i) => ({ k, label, i, v: Number(a[k] || 0) })).filter((c) => c.v > 0)
  if (!chips.length) return <span className="muted small">—</span>
  return (
    <div className="aging-chips">
      {chips.map((c) => (
        <span key={c.k} className={`age-chip ${cls[c.i]}`} title={`${c.label} din purana paisa: ${inr(c.v)}`}>{c.label}d: {inrShort(c.v)}</span>
      ))}
    </div>
  )
}

function LimitBar({ pending, limit }) {
  if (!Number(limit)) return <span className="muted small">limit set nahi</span>
  const pct = (Number(pending) / Number(limit)) * 100
  const over = pct > 100
  return (
    <div className="limit-bar-wrap" title={`Baaki ${inr(pending)} / Limit ${inr(limit)} — limit ka ${Math.round(pct)}% use ho gaya`}>
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
    if (!remark.trim()) { setErr('Pehle likho ki baat kya hui (Step 2)'); return }
    if (!nextDate) { setErr('Agli baar kab yaad dilana hai — date dalo (Step 3)'); return }
    if (demo) { setErr('Demo mode me save nahi hota — real login karke use karo'); return }
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
    if (e1 || e2) { setErr('Save nahi hua: ' + (e1 || e2).message); return }
    setRemark(''); setAmount('')
    setOkMsg('✅ Save ho gaya! Agli date par ye party "Aaj ke follow-up" me apne aap aa jayegi.')
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
          <h4>Is party ke saath kya karna hai:</h4>
          <div className="coll-step-btns">
            <div className="coll-step">
              <span className="step-num">1</span>
              <div>
                <b>Baat karo</b>
                <div className="step-actions">
                  {p.mobile && <a className="btn primary sm" href={`tel:${p.mobile}`}>📞 Call {p.mobile}</a>}
                  {wa && <a className="wa-btn" href={wa} target="_blank" rel="noreferrer"
                    onClick={() => logWaSendParty(p.party_name, 'WhatsApp payment reminder bheja')}>📤 WhatsApp bhejo</a>}
                  {!p.mobile && <span className="muted small">Mobile number nahi hai — salesman {p.salesman || ''} se poochho</span>}
                </div>
                <p className="muted small">Poochhna hai: "Total {inrShort(p.total_pending)} baaki hai{p.oldest_od ? `, sabse purana bill ${p.oldest_od} din se pending` : ''} — payment kab tak hoga?"</p>
              </div>
            </div>
            <div className="coll-step">
              <span className="step-num">2</span>
              <div className="step-form">
                <b>Jo baat hui, yahan likho</b>
                <input placeholder='Jaise: "Bole 5 tarikh ko RTGS karenge"' value={remark} onChange={(e) => setRemark(e.target.value)} />
                <input type="number" placeholder="Paisa abhi mila ho to amount likho (warna khali chhodo)" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
            </div>
            <div className="coll-step">
              <span className="step-num">3</span>
              <div className="step-form">
                <b>Agli baar kab yaad dilaye?</b>
                <input type="datetime-local" value={nextDate} onChange={(e) => setNextDate(e.target.value)} />
                <button className="btn primary" onClick={save} disabled={saving}>{saving ? '⏳ Save ho raha…' : '💾 Save karo'}</button>
              </div>
            </div>
          </div>
          {err && <p className="err small">{err}</p>}
          {okMsg && <p className="green-t small"><b>{okMsg}</b></p>}
        </div>
        <div className="fup-log">
          <h4>🗒️ Pehle kya baat hui thi {logs?.length ? `(${logs.length})` : ''}</h4>
          {logs === null ? <p className="muted small">Load ho raha hai…</p>
            : logs.length === 0 ? <p className="muted small">Is party se abhi tak koi baat record nahi hui — aap pehli baar call kar rahe ho.</p>
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
      <div className="coll-bills">
        <h4>🧾 Kaunse bills baaki hain ({(p.bills || []).length}{overdueBills.length ? ` — ${overdueBills.length} overdue` : ''})</h4>
        <div className="tbl-wrap-inner">
          <table className="cfg-tbl coll-bill-tbl">
            <thead><tr><th>Bill No</th><th>Firm</th><th>Bill Date</th><th>Kitna Purana</th><th>Baaki</th><th>Cheque (PDC)</th><th>Bilty</th><th>Office Note</th></tr></thead>
            <tbody>
              {(p.bills || []).slice(0, 100).map((b, i) => (
                <tr key={i} className={b.od > 180 ? 'coll-old' : ''}>
                  <td><b>{b.vno || '—'}</b></td>
                  <td className="small">{b.company || '—'}</td>
                  <td>{dmy(b.date)}</td>
                  <td>{b.od > 0 ? <span className={b.od > 90 ? 'red-t' : 'amber-t'}><b>{b.od} din overdue</b></span> : <span className="muted small">{b.days != null ? `${b.days} din (time hai)` : '—'}</span>}</td>
                  <td><b>{inr(b.pending)}</b></td>
                  <td className="small">{b.pdc_rcpt || b.pdc_date ? `✅ ${b.pdc_rcpt || ''} ${dmy(b.pdc_date)}` : '—'}</td>
                  <td className="small">{b.bilty || '—'}</td>
                  <td className="small coll-notes" title={b.notes || ''}>{b.notes || '—'}</td>
                </tr>
              ))}
              {(p.bills || []).length > 100 && (
                <tr><td colSpan={8} className="muted small">…aur {(p.bills || []).length - 100} bills (sabse purane 100 upar dikh rahe hain)</td></tr>
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

  if (rows === null) return <div className="action-page"><p className="muted">Collection data load ho raha hai…</p></div>

  return (
    <div className="action-page coll-page">
      <div className="action-head">
        <h2>💰 Collection — Payment Vasooli</h2>
        <p className="muted small">Company ka poora bakaya paisa, party-wise. Sabse zaroori party <b>sabse upar</b> hai — bas upar se neeche kaam karte jao.</p>

        {showHelp && (
          <div className="coll-help">
            <b>Kaise use karo (3 steps):</b>
            <span>1️⃣ Upar wali party par click karo</span>
            <span>2️⃣ 📞 Call ya 📤 WhatsApp karo</span>
            <span>3️⃣ Jo baat hui wo likho + agli date dalo → Save</span>
            <button className="btn ghost sm" onClick={dismissHelp}>✕ Samajh gaya</button>
          </div>
        )}

        <div className="coll-kpis">
          <button className={preset === 'all' ? 'kpi-card active' : 'kpi-card'} onClick={() => setPreset('all')}>
            <b>{inrShort(kpi.total)}</b><span>Total baaki · {rows.length} parties</span>
          </button>
          <button className={preset === 'due' ? 'kpi-card due active' : 'kpi-card due'} onClick={() => setPreset('due')}>
            <b>{kpi.due}</b><span>📅 Aaj ke follow-up</span>
          </button>
          <button className={preset === 'hot' ? 'kpi-card red active' : 'kpi-card red'} onClick={() => setPreset('hot')}>
            <b>{kpi.hot}</b><span>🔴 Turant — {inrShort(kpi.old180)} bahut purana</span>
          </button>
          <button className={preset === 'pdc' ? 'kpi-card active' : 'kpi-card'} onClick={() => setPreset('pdc')}>
            <b>{kpi.pdc}</b><span>🧾 Cheque (PDC) mila hai</span>
          </button>
        </div>

        <div className="action-filter coll-filters">
          <div className="coll-presets">
            {PRESETS.map((p) => (
              <button key={p.key} className={preset === p.key ? 'preset-chip active' : 'preset-chip'} onClick={() => setPreset(p.key)}>{p.label}</button>
            ))}
          </div>
          <input className="search" placeholder="🔍 Party ka naam / mobile / city likho…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={salesman} onChange={(e) => setSalesman(e.target.value)}>
            <option value="">Salesman: sab</option>
            {salesmen.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          {(q || salesman || preset !== 'all') && (
            <button className="btn ghost sm" onClick={() => { setQ(''); setSalesman(''); setPreset('all') }}>✕ Filter hatao</button>
          )}
          <span className="filter-count active">🔎 {filtered.length} / {rows.length} parties</span>
        </div>
      </div>

      {demo && rows.length > 0 && (
        <div className="panel demo-note"><p className="muted small">⚠️ Ye SAMPLE data hai (demo mode). Real 682 parties ka data dekhne ke liye bina <code>?demo</code> ke login karo.</p></div>
      )}
      {rows.length === 0 && (
        <div className="panel"><p className="muted">Koi collection data nahi mila. Agla ERP sync (har ghante :20 par) hone do.</p></div>
      )}

      {rows.length > 0 && filtered.length === 0 && (
        <div className="panel"><p className="muted">Is filter me koi party nahi mili. <button className="link" onClick={() => { setQ(''); setSalesman(''); setPreset('all') }}>Filter hatao</button></p></div>
      )}

      <div className="panel coll-list">
        <table className="cfg-tbl coll-tbl">
          <thead>
            <tr>
              <th>{sortBtn('priority', 'Kitna Zaroori', 'Sabse zaroori upar — isi order me kaam karo')}</th>
              <th>{sortBtn('party_name', 'Party')}</th>
              <th>{sortBtn('total_pending', 'Total Baaki')}</th>
              <th>{sortBtn('oldest_od', 'Kitna Purana', 'Sabse purana bill kitne din se overdue hai')}</th>
              <th title="Kaunsa paisa kitna purana hai — hara naya, laal bahut purana">Kab ka Paisa</th>
              <th title="Party ko kitne tak udhaar dene ki limit hai, kitni use ho gayi">Credit Limit</th>
              <th>Last Payment</th>
              <th>Agla F/Up</th>
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
                  <td>{p.oldest_od ? <span className={p.oldest_od > 90 ? 'red-t' : p.oldest_od > 30 ? 'amber-t' : ''}><b>{p.oldest_od} din</b></span> : '—'}</td>
                  <td><AgingChips aging={p.aging} /></td>
                  <td><LimitBar pending={p.total_pending} limit={p.credit_limit} /></td>
                  <td className="small">{p.last_pay_amt ? <>{inrShort(p.last_pay_amt)}<div className="muted">{dmy(p.last_pay_date)}</div></> : <span className="muted">—</span>}</td>
                  <td className="small">{p.next_followup_date ? <span className={isFupDue(p) ? 'amber-t' : ''}>{isFupDue(p) && '📅 '}{dmy(p.next_followup_date)}</span> : '—'}</td>
                  <td className="coll-actions" onClick={(e) => e.stopPropagation()}>
                    {p.mobile && <a className="btn ghost sm" href={`tel:${p.mobile}`} title={`Call: ${p.mobile}`}>📞</a>}
                    {wa && <a className="wa-btn" href={wa} target="_blank" rel="noreferrer" title="WhatsApp reminder bhejo"
                      onClick={() => logWaSendParty(p.party_name, 'WhatsApp payment reminder bheja')}>📤</a>}
                    <button className="btn ghost sm" title="Baat ka note likho" onClick={() => setOpen(p.party_name)}>📝</button>
                  </td>
                </tr>
              )
            })}
            {filtered.length > 200 && <tr><td colSpan={9} className="muted small">…aur {filtered.length - 200} parties — upar search me naam likho</td></tr>}
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
                  {' · '}Total baaki <b>{inrShort(openParty.total_pending)}</b> ({openParty.bill_count} bills)
                  {openParty.oldest_od ? <> · sabse purana <b>{openParty.oldest_od} din</b></> : null}
                </p>
              </div>
              <button className="btn ghost" onClick={() => setOpen(null)}>✕ Band karo</button>
            </div>
            <PartyDetail p={openParty} demo={demo} onSaved={() => setTick((t) => t + 1)} />
          </div>
        </div>
      )}
    </div>
  )
}
