import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { buildCollectionMsg, waLink, logWaSendParty, suggestNextFollowup } from '../lib/fms'
import { inr, inrShort, dmy, isoDay, normKey, userName, bucketOf, isBroken, EMPTY_AGG, buildAgg, priorityOf, fetchAll, FUP_COLS, RCPT_COLS } from '../lib/coll'
import { AgingChips, StageChip, BucketPill, Timeline, Receipts } from './CollBits'

// My Parties (salesman tab): login wale salesman ki apni parties (+ jo usko transfer hui),
// har party par commitment form (amount + date + remark). Data wahi (fms_collection / fms_followups / fms_receipts).

// Google login -> ERP salesman name. Pehle admin mapping (fms_users.salesman), warna naam / email se auto-match.
const tok = (s) => normKey(s).replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(Boolean)
function resolveSalesman(user, access, salesmen) {
  if (access?.salesman) return { name: access.salesman, how: 'set by admin' }
  const cands = [access?.full_name, user?.user_metadata?.full_name, user?.user_metadata?.name].filter(Boolean)
  // 1) poora naam same (case / dots ignore)
  for (const c of cands) {
    const hit = salesmen.filter((s) => tok(s).join(' ') === tok(c).join(' '))
    if (hit.length === 1) return { name: hit[0], how: 'matched by name' }
  }
  // 2) pehla naam same ("Dilip Kodwani" <-> "Dilip.", email dilip@ <-> "Dilip.") — sirf jab ek hi salesman mile
  const local = String(user?.email || '').split('@')[0].replace(/[._-]+/g, ' ')
  for (const c of [...cands, local]) {
    const f = tok(c)[0]; if (!f) continue
    const hit = salesmen.filter((s) => tok(s)[0] === f)
    if (hit.length === 1) return { name: hit[0], how: 'matched by first name' }
  }
  return null
}

const CHIPS = [
  { key: 'all', label: 'All' }, { key: 'today', label: '📅 Due today' }, { key: 'missed', label: '⏰ Missed' },
  { key: 'broken', label: '💔 Broken promise' }, { key: 'committed', label: '🤝 Committed' }, { key: 'nocommit', label: 'No commitment' },
  { key: 'warm', label: '🟠 90+ days' },
]

// ---------- commitment form (salesman ka wada: kitna, kab, remark) ----------
function CommitForm({ p, ag, selBills, demo, onSaved }) {
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(() => isoDay(suggestNextFollowup()))
  const [remark, setRemark] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const selSum = selBills.reduce((a, b) => a + Number(b.pending || 0), 0)

  const save = async () => {
    if (!(Number(amount) > 0)) { setErr('Enter the amount the party promised'); return }
    if (!date) { setErr('Pick the promised date'); return }
    if (date < isoDay()) { setErr('Promised date cannot be in the past'); return }
    if (demo) { setErr('Demo mode cannot save — use the real login'); return }
    setSaving(true); setErr('')
    const { data: { user } } = await supabase.auth.getUser()
    const { error } = await supabase.from('fms_followups').insert({
      party_name: p.party_name, mode: 'call', stage: 'Committed',
      remarks: remark.trim() || `Committed ${inr(amount)} by ${dmy(date)}`,
      committed_amount: Number(amount), committed_date: date,
      bill_nos: selBills.map((b) => b.vno),
      followup_date: isoDay(), created_by: user?.email || '',
    })
    if (error) { setSaving(false); setErr('Save failed: ' + error.message); return }
    // CRM ka next follow-up: agar blank hai ya commitment date ke BAAD hai to commitment ke din 11 AM par le aao
    const cd = new Date(date + 'T11:00:00')
    const cur = p.next_followup_date ? new Date(p.next_followup_date) : null
    if (!cur || cur > cd) await supabase.from('fms_collection').update({ next_followup_date: cd.toISOString() }).eq('party_name', p.party_name)
    setSaving(false); setAmount(''); setRemark('')
    onSaved?.(`✅ Commitment saved — ${inr(amount)} by ${dmy(date)}. CRM will follow up on that day.`)
  }

  return (
    <div className="commit-form">
      <h4>🤝 New commitment {ag.committed && <span className="muted small" style={{ fontWeight: 400 }}>(last: {inr(ag.committed.amount)} by {dmy(ag.committed.date)}{isBroken(ag) ? ' — broken' : ''})</span>}</h4>
      <div className="fld-row">
        <input type="number" placeholder={`Promised amount ₹${selSum ? ' (selected bills ' + inr(selSum) + ')' : ''}`} value={amount} onChange={(e) => setAmount(e.target.value)} />
        <input type="date" value={date} min={isoDay()} onChange={(e) => setDate(e.target.value)} title="Promised date" />
      </div>
      <input placeholder="Remark — e.g. RTGS after their collection on the 5th" value={remark} onChange={(e) => setRemark(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
      <div className="fld-row">
        {selBills.length > 0 && <span className="small">For: {selBills.map((b) => <span key={b.vno} className="bill-tag static">{b.vno}</span>)}</span>}
        {selSum > 0 && !amount && <button className="btn ghost sm" onClick={() => setAmount(String(Math.round(selSum)))}>Use {inr(selSum)}</button>}
        <button className="btn primary sm" onClick={save} disabled={saving}>{saving ? '⏳ Saving…' : '💾 Save commitment'}</button>
      </div>
      {err && <span className="err small" style={{ margin: 0 }}>{err}</span>}
      <span className="muted small">Tick bills above to link the promise to specific bills (optional).</span>
    </div>
  )
}

// ---------- expanded party row: bills + receipts + history + commitment form ----------
function PartyPanel({ p, ag, demo, onSaved }) {
  const [sel, setSel] = useState([])
  const [msg, setMsg] = useState('')
  const overdue = (p.bills || []).filter((b) => (b.od || 0) > 0 && b.pay_status !== 'Full' && !ag.paid.has(b.vno))
  const toggle = (b) => setSel((s) => (s.some((x) => x.vno === b.vno) ? s.filter((x) => x.vno !== b.vno) : [...s, { vno: b.vno, pending: b.pending ?? b.amt }]))
  const saved = (m) => { setMsg(m); setSel([]); setTimeout(() => setMsg(''), 6000); onSaved?.() }
  return (
    <div className="sm-panel">
      <div className="sm-bills">
        <h4>🧾 Overdue bills ({overdue.length})</h4>
        <div className="tbl-wrap-inner">
          <table className="cfg-tbl coll-bill-tbl sm-bill-tbl">
            <thead><tr><th>✓</th><th>Bill No</th><th>Firm</th><th>Date</th><th>Age</th><th>Pending</th><th>ERP paid</th></tr></thead>
            <tbody>
              {overdue.slice(0, 40).map((b, i) => (
                <tr key={i} className={[b.od > 180 ? 'coll-old' : b.od >= 60 ? 'coll-hot' : '', sel.some((x) => x.vno === b.vno) ? 'coll-sel' : ''].join(' ')} onClick={() => b.vno && toggle(b)}>
                  <td onClick={(e) => e.stopPropagation()}><input type="checkbox" disabled={!b.vno} checked={sel.some((x) => x.vno === b.vno)} onChange={() => toggle(b)} /></td>
                  <td><b>{b.vno || '—'}</b></td>
                  <td className="small">{b.company || '—'}</td>
                  <td>{dmy(b.date)}</td>
                  <td><span className={b.od > 90 ? 'red-t' : 'amber-t'}><b>{b.od}d</b></span></td>
                  <td><b>{inr(b.pending ?? b.amt)}</b></td>
                  <td className="small">{b.pay_status === 'Part' ? <b className="green-t">Part {inr(b.received)}</b> : <span className="muted">—</span>}</td>
                </tr>
              ))}
              {!overdue.length && <tr><td colSpan={7} className="muted">No overdue bills.</td></tr>}
              {overdue.length > 40 && <tr><td colSpan={7} className="muted small">…and {overdue.length - 40} more</td></tr>}
            </tbody>
          </table>
        </div>
        <CommitForm p={p} ag={ag} selBills={sel} demo={demo} onSaved={saved} />
        {msg && <p className="green-t small"><b>{msg}</b></p>}
      </div>
      <div className="sm-side">
        <h4>💵 Receipts (ERP)</h4>
        <Receipts list={ag.receipts.slice(0, 5)} />
        <h4 style={{ marginTop: 10 }}>🗒️ History {ag.count ? `(${ag.count})` : ''}</h4>
        <div className="fup-log"><Timeline entries={ag.entries.slice(0, 15)} waCount={ag.waCount} /></div>
      </div>
    </div>
  )
}

export default function Salesman({ user, access }) {
  const demo = new URLSearchParams(window.location.search).has('demo')
  const [rows, setRows] = useState(null)
  const [fups, setFups] = useState([])
  const [rcpts, setRcpts] = useState([])
  const [tick, setTick] = useState(0)
  const [q, setQ] = useState('')
  const [chip, setChip] = useState('all')
  const [open, setOpen] = useState(null)
  const [viewAs, setViewAs] = useState('')   // admin: kisi bhi salesman ki nazar se dekho

  useEffect(() => {
    if (demo) { fetch('/demo-collection.json').then((r) => r.json()).then(setRows).catch(() => setRows([])); return }
    Promise.all([
      supabase.from('fms_collection').select('*'),
      fetchAll('fms_followups', FUP_COLS, (x) => x.not('party_name', 'is', null).order('created_at', { ascending: false })),
      fetchAll('fms_receipts', RCPT_COLS, (x) => x.order('pay_date', { ascending: false, nullsFirst: false })),
    ]).then(([{ data }, f, r]) => { setRows(data || []); setFups(f); setRcpts(r) })
  }, [tick, demo])

  const agg = useMemo(() => buildAgg(fups, rcpts), [fups, rcpts])
  const agOf = (p) => agg.get(normKey(p.party_name)) || EMPTY_AGG
  const salesmen = useMemo(() => [...new Set((rows || []).map((r) => r.salesman).filter(Boolean))].sort(), [rows])
  const resolved = useMemo(() => resolveSalesman(user, access, salesmen), [user, access, salesmen])
  const me = viewAs || resolved?.name || ''

  const enriched = useMemo(() => (rows || [])
    .filter((p) => me && !p.permanent_note && (p.salesman === me || agOf(p).transferTo === me))
    .map((p) => { const ag = agOf(p); const bucket = bucketOf(p, ag); return { p, ag, bucket, pr: priorityOf(p, ag, bucket), broken: isBroken(ag) } })
    .sort((a, b) => (b.pr.rank - a.pr.rank) || (Number(b.p.total_pending) - Number(a.p.total_pending))),
  [rows, agg, me]) // eslint-disable-line react-hooks/exhaustive-deps

  const kpi = useMemo(() => {
    const m0 = isoDay().slice(0, 7)
    const mine = new Set(enriched.map((e) => normKey(e.p.party_name)))
    const recvMonth = rcpts.filter((r) => r.pay_date && r.pay_date.startsWith(m0) && mine.has(normKey(r.party_name))).reduce((a, r) => a + Number(r.amount || 0), 0)
    const committed = enriched.filter((e) => e.ag.committed && !e.broken)
    return {
      total: enriched.reduce((a, e) => a + Number(e.p.total_pending || 0), 0), parties: enriched.length,
      due: enriched.filter((e) => e.bucket === 'today' || e.bucket === 'missed').length,
      committed: committed.length, committedAmt: committed.reduce((a, e) => a + e.ag.committed.amount, 0),
      broken: enriched.filter((e) => e.broken).length,
      warm: enriched.filter((e) => (e.p.oldest_od || 0) > 90).length,
      recvMonth,
    }
  }, [enriched, rcpts])

  const filtered = useMemo(() => {
    let list = enriched
    const s = q.trim().toLowerCase()
    if (s) list = list.filter(({ p }) => `${p.party_name} ${p.mobile || ''} ${p.city || ''}`.toLowerCase().includes(s))
    switch (chip) {
      case 'today': case 'missed': list = list.filter((e) => e.bucket === chip); break
      case 'broken': list = list.filter((e) => e.broken); break
      case 'committed': list = list.filter((e) => e.ag.committed && !e.broken); break
      case 'nocommit': list = list.filter((e) => !e.ag.committed); break
      case 'warm': list = list.filter((e) => (e.p.oldest_od || 0) > 90); break
      default: break
    }
    return list
  }, [enriched, q, chip])

  if (rows === null) return <div className="action-page"><p className="muted">Loading your parties…</p></div>

  return (
    <div className="action-page coll-page">
      <div className="action-head">
        <h2>🧑‍💼 My Parties {me && <span className="muted" style={{ fontWeight: 400, fontSize: 15 }}>— {me}</span>}</h2>
        {me
          ? <p className="muted small">Parties under <b>{me}</b>{resolved && !viewAs ? ` (${resolved.how})` : ''}, plus any transferred to you. Most important on top — call, then save the party's commitment.</p>
          : <p className="muted small">Your login is not linked to a salesman name.</p>}

        {!resolved && !viewAs && (
          <div className="panel" style={{ marginTop: 10 }}>
            <p className="small"><b>Login {user?.email} does not match any ERP salesman name.</b></p>
            <p className="muted small">Ask the admin to open <b>User Control</b> and set your "Salesman (My Parties)" mapping. ERP salesmen: {salesmen.join(' · ') || '—'}</p>
          </div>
        )}
        {(access?.is_admin || !resolved) && salesmen.length > 0 && (
          <div className="fld-row" style={{ marginTop: 8 }}>
            <label className="small muted" style={{ flex: 'none' }}>{access?.is_admin ? 'Admin — view as salesman:' : 'Preview as:'}</label>
            <select value={viewAs} onChange={(e) => { setViewAs(e.target.value); setOpen(null) }} style={{ flex: 'none' }}>
              <option value="">{resolved ? `me (${resolved.name})` : '— pick —'}</option>
              {salesmen.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}

        {me && (<>
          <div className="coll-kpis">
            <button className={chip === 'all' ? 'kpi-card active' : 'kpi-card'} onClick={() => setChip('all')}><b>{inrShort(kpi.total)}</b><span>Total pending · {kpi.parties} parties</span></button>
            <button className={chip === 'today' ? 'kpi-card due active' : 'kpi-card due'} onClick={() => setChip('today')}><b>{kpi.due}</b><span>📅 Due / missed follow-up</span></button>
            <button className={chip === 'committed' ? 'kpi-card active' : 'kpi-card'} onClick={() => setChip('committed')}><b>{kpi.committed}</b><span>🤝 Committed · {inrShort(kpi.committedAmt)}</span></button>
            <button className={chip === 'broken' ? 'kpi-card red active' : 'kpi-card red'} onClick={() => setChip('broken')}><b>{kpi.broken}</b><span>💔 Broken promises</span></button>
            <button className={chip === 'warm' ? 'kpi-card red active' : 'kpi-card red'} onClick={() => setChip('warm')}><b>{kpi.warm}</b><span>🟠 90+ days overdue</span></button>
            <div className="kpi-card" style={{ cursor: 'default' }}><b className="green-t">{inrShort(kpi.recvMonth)}</b><span>💵 Received this month (ERP)</span></div>
          </div>
          <div className="action-filter coll-filters">
            <div className="coll-presets">{CHIPS.map((c) => <button key={c.key} className={chip === c.key ? 'preset-chip active' : 'preset-chip'} onClick={() => setChip(c.key)}>{c.label}</button>)}</div>
            <input className="search" placeholder="🔍 Search party / mobile / city…" value={q} onChange={(e) => setQ(e.target.value)} />
            <span className="filter-count active">🔎 {filtered.length} / {enriched.length} parties</span>
          </div>
        </>)}
      </div>

      {demo && <div className="panel demo-note"><p className="muted small">⚠️ SAMPLE data (demo mode).</p></div>}

      {me && (
        <div className="panel coll-list">
          <table className="cfg-tbl coll-tbl sm-tbl">
            <thead>
              <tr>
                <th>Priority</th><th>Party</th><th>Total Pending</th><th>Oldest Due</th><th>Aging</th><th title="Last receipt in ERP">Last Payment</th>
                <th>Next F/Up</th><th>Last Stage</th><th title="Promised amount and date">Committed</th><th className="no-print">Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 200).map((e) => {
                const { p, ag, pr, bucket, broken } = e
                const wa = waLink(p.mobile, buildCollectionMsg(p))
                const isOpen = open === p.party_name
                const r0 = ag.receipts[0]
                return [
                  <tr key={p.party_name} className={isOpen ? 'coll-row sm-open' : 'coll-row'} onClick={() => setOpen(isOpen ? null : p.party_name)}>
                    <td><span className={`pr-badge ${pr.cls}`} title={pr.hint}>{pr.label}</span></td>
                    <td><span className="coll-party"><b>{p.party_name}</b></span><div className="muted small">{[p.city, p.mobile].filter(Boolean).join(' · ')}{p.salesman !== me && ag.transferTo === me && <span className="xfer-tag">↪ transferred to you</span>}</div></td>
                    <td><b>{inrShort(p.total_pending)}</b><div className="muted small">{p.bill_count} bills</div></td>
                    <td>{p.oldest_od ? <span className={p.oldest_od > 90 ? 'red-t' : p.oldest_od > 30 ? 'amber-t' : ''}><b>{p.oldest_od} days</b></span> : '—'}</td>
                    <td><AgingChips aging={p.aging} /></td>
                    <td className="small">{r0 ? <>{inrShort(r0.amount)}<div className="muted">{dmy(r0.pay_date)}</div></> : p.last_pay_amt ? <>{inrShort(p.last_pay_amt)}<div className="muted">{dmy(p.last_pay_date)}</div></> : <span className="muted">—</span>}</td>
                    <td><BucketPill b={bucket} date={p.next_followup_date} /></td>
                    <td>{ag.lastStage ? <StageChip s={ag.lastStage} /> : <span className="muted">—</span>}{ag.last && <div className="muted small">{dmy(ag.last.created_at)} · {userName(ag.last.created_by)}</div>}</td>
                    <td>{ag.committed ? <span className={`small ${broken ? 'red-t' : ''}`}><b>{inrShort(ag.committed.amount)}</b><div className={broken ? 'red-t' : 'muted'}>{broken ? '💔 ' : 'by '}{dmy(ag.committed.date)}</div></span> : <span className="muted">—</span>}</td>
                    <td className="coll-actions no-print" onClick={(ev) => ev.stopPropagation()}>
                      {p.mobile && <a className="btn ghost sm" href={`tel:${p.mobile}`} title={`Call ${p.mobile}`}>📞</a>}
                      {wa && <a className="wa-btn" href={wa} target="_blank" rel="noreferrer" title="WhatsApp reminder" onClick={() => { logWaSendParty(p.party_name, 'Sent WhatsApp payment reminder'); setTimeout(() => setTick((t) => t + 1), 800) }}>📤</a>}
                      <button className="btn primary sm" title="Save the party's commitment" onClick={() => setOpen(isOpen ? null : p.party_name)}>🤝 Commit</button>
                    </td>
                  </tr>,
                  isOpen && (
                    <tr key={p.party_name + '#x'} className="sm-expand"><td colSpan={10}>
                      <PartyPanel p={p} ag={ag} demo={demo} onSaved={() => setTick((t) => t + 1)} />
                    </td></tr>
                  ),
                ]
              })}
              {!filtered.length && <tr><td colSpan={10} className="muted">{enriched.length ? 'No party matches this filter.' : `No pending parties under ${me}.`}</td></tr>}
              {filtered.length > 200 && <tr><td colSpan={10} className="muted small">…and {filtered.length - 200} more — use search</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
