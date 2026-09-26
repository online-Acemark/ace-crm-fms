import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { buildCollectionMsg, waLink, logWaSendParty, suggestNextFollowup } from '../lib/fms'
import { inr, inrShort, dmy, isoDay, normKey, useFormOpts, bucketOf, isBroken, EMPTY_AGG, buildAgg, priorityOf, fetchAll, FUP_COLS, RCPT_COLS, BUCKET_LABEL, useIsMobile } from '../lib/coll'
import { COLS, COL_PRESETS, SALES_DEFAULT_ON, useColVis, cellOf, useExtraFilters, filterOptions, applyExtraFilters, extraFilterText, useTotals, printTable } from '../lib/collCols'
import { BucketPill, Timeline, Receipts, Avatar, PartyCell, StatStrip, Tabs, Chip, Toast, NextUp, Skeleton, PartyCard, ExtraFilters, ColPanel, TotalsRow } from './CollBits'

// My Parties (salesman tab): login wale salesman ki apni parties (+ jo usko transfer hui),
// har party par commitment form (amount + date + remark). Data wahi (fms_collection / fms_followups / fms_receipts).
// Super admin (is_admin) ko sab salesmen; phone par cards.

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
  { key: 'all', label: 'All' }, { key: 'today', label: '📅 Due today', tone: 'amber' }, { key: 'missed', label: '⏰ Missed', tone: 'red' },
  { key: 'broken', label: '💔 Broken promise', tone: 'red' }, { key: 'committed', label: '🤝 Committed' }, { key: 'nocommit', label: 'No commitment' },
  { key: 'warm', label: '🟠 90+ days', tone: 'amber' },
]
const matchChip = (e, key) => {
  switch (key) {
    case 'today': case 'missed': return e.bucket === key
    case 'broken': return e.broken
    case 'committed': return e.ag.committed && !e.broken
    case 'nocommit': return !e.ag.committed
    case 'warm': return (e.p.oldest_od || 0) > 90
    default: return true
  }
}

// ---------- commitment form (salesman ka wada: kitna, kab, remark) ----------
function CommitForm({ p, ag, selBills, demo, onSaved }) {
  const formOpts = useFormOpts()
  const [says, setSays] = useState('')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(() => isoDay(suggestNextFollowup()))
  const [remark, setRemark] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const selSum = selBills.reduce((a, b) => a + Number(b.pending || 0), 0)
  const quick = (days) => setDate(isoDay(suggestNextFollowup(days)))

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
      customer_says: says || null,
      committed_amount: Number(amount), committed_date: date,
      bill_nos: selBills.map((b) => b.vno),
      followup_date: isoDay(), created_by: user?.email || '',
      next_followup_date: new Date(date + 'T11:00:00').toISOString(),   // PLAN = wade ka din (scoring)
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
      <div className="commit-head">
        <h4>🤝 New commitment</h4>
        {ag.committed && <span className={`stage-chip ${isBroken(ag) ? 'st-bad' : 'st-commit'}`}>last: {inr(ag.committed.amount)} by {dmy(ag.committed.date)}{isBroken(ag) ? ' — broken' : ''}</span>}
      </div>
      <div className="commit-grid">
        <label className="small muted">Promised amount ₹
          <input type="number" placeholder={selSum ? `selected bills ${inr(selSum)}` : 'e.g. 50000'} value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
        </label>
        <label className="small muted">Promised date
          <input type="date" value={date} min={isoDay()} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="small muted">Customer says
          <select value={says} onChange={(e) => setSays(e.target.value)}>
            <option value="">— optional —</option>
            {(formOpts.customer_says || []).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
        <label className="small muted">Remark
          <input placeholder="e.g. RTGS after their collection on the 5th" value={remark} onChange={(e) => setRemark(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
        </label>
      </div>
      <div className="fld-row">
        <span className="fld-row quick">{[['Tomorrow', 1], ['+3 days', 3], ['+7 days', 7], ['+15 days', 15]].map(([l, d]) => <button key={d} className="btn ghost sm" onClick={() => quick(d)}>{l}</button>)}</span>
        {selSum > 0 && !amount && <button className="btn ghost sm" onClick={() => setAmount(String(Math.round(selSum)))}>Use {inr(selSum)}</button>}
        {selBills.length > 0 && <span className="small">For: {selBills.map((b) => <span key={b.vno} className="bill-tag static">{b.vno}</span>)}</span>}
        <span style={{ flex: 1 }} />
        <button className="btn primary" onClick={save} disabled={saving}>{saving ? '⏳ Saving…' : '💾 Save commitment'}</button>
      </div>
      {err && <span className="err small" style={{ margin: 0 }}>{err}</span>}
      <span className="muted small">Tick bills in the Bills tab to link the promise to specific bills (optional).</span>
    </div>
  )
}

// ---------- party modal body: stats, actions, commitment form, tabs (bills / receipts / history) ----------
function PartyPanel({ p, ag, bucket, demo, onSaved, onToast }) {
  const [sel, setSel] = useState([])
  const [tab, setTab] = useState('bills')
  const overdue = (p.bills || []).filter((b) => (b.od || 0) > 0 && b.pay_status !== 'Full' && !ag.paid.has(b.vno))
  const toggle = (b) => setSel((s) => (s.some((x) => x.vno === b.vno) ? s.filter((x) => x.vno !== b.vno) : [...s, { vno: b.vno, pending: b.pending ?? b.amt }]))
  const saved = (m) => { onToast?.(m); setSel([]); onSaved?.() }
  const wa = waLink(p.mobile, buildCollectionMsg(p))
  const r0 = ag.receipts[0]
  const broken = isBroken(ag)
  const stats = [
    { l: 'Total pending', v: inrShort(p.total_pending), s: `${p.bill_count} bills`, cls: 'vio' },
    { l: 'Overdue bills', v: overdue.length, cls: overdue.length ? 'amb' : '' },
    { l: 'Oldest', v: p.oldest_od ? `${p.oldest_od} d` : '—', cls: p.oldest_od > 90 ? 'red' : '' },
    { l: 'Last payment', v: r0 ? inrShort(r0.amount) : p.last_pay_amt ? inrShort(p.last_pay_amt) : '—', s: r0 ? `${dmy(r0.pay_date)} · ${r0.pay_type}` : p.last_pay_date ? dmy(p.last_pay_date) : '', cls: 'grn' },
    { l: 'Next follow-up', v: BUCKET_LABEL[bucket], s: p.next_followup_date && bucket !== 'closed' ? dmy(p.next_followup_date) : '', cls: bucket === 'missed' ? 'red' : bucket === 'today' ? 'amb' : '' },
    { l: 'Promise', v: ag.committed ? inrShort(ag.committed.amount) : '—', s: ag.committed ? `${broken ? '💔 broken' : 'by'} ${dmy(ag.committed.date)}` : 'none', cls: ag.committed ? (broken ? 'red' : 'blu') : '' },
  ]
  return (
    <div className="coll-detail">
      <StatStrip items={stats} />
      <div className="coll-actbar">
        {p.mobile && <a className="btn primary sm" href={`tel:${p.mobile}`}>📞 Call {p.mobile}</a>}
        {wa && <a className="wa-btn" href={wa} target="_blank" rel="noreferrer" onClick={() => { logWaSendParty(p.party_name, 'Sent WhatsApp payment reminder'); setTimeout(() => onSaved?.(), 800) }}>📤 Send WhatsApp</a>}
        {!p.mobile && <span className="muted small">No mobile number in ERP</span>}
        {ag.transferTo && <span className="stage-chip st-park">↪ Transferred to {ag.transferTo}{ag.transferReason ? ' — ' + ag.transferReason : ''}</span>}
      </div>
      <CommitForm p={p} ag={ag} selBills={sel} demo={demo} onSaved={saved} />
      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'bills', label: '🧾 Overdue bills', n: overdue.length },
        { key: 'rcpt', label: '💵 Receipts (ERP)', n: ag.receipts.length },
        { key: 'hist', label: '🗒️ History', n: ag.count },
      ]} />
      {tab === 'bills' && (
        <div className="tbl-wrap-inner">
          <table className="cfg-tbl coll-bill-tbl sm-bill-tbl">
            <thead><tr><th>✓</th><th>Bill No</th><th>Firm</th><th>Date</th><th>Age</th><th className="num">Pending</th><th>ERP paid</th></tr></thead>
            <tbody>
              {overdue.slice(0, 40).map((b, i) => (
                <tr key={i} className={[b.od > 180 ? 'coll-old' : b.od >= 60 ? 'coll-hot' : '', sel.some((x) => x.vno === b.vno) ? 'coll-sel' : ''].join(' ')} onClick={() => b.vno && toggle(b)}>
                  <td onClick={(e) => e.stopPropagation()}><input type="checkbox" disabled={!b.vno} checked={sel.some((x) => x.vno === b.vno)} onChange={() => toggle(b)} /></td>
                  <td><b>{b.vno || '—'}</b></td>
                  <td className="small">{b.company || '—'}</td>
                  <td>{dmy(b.date)}</td>
                  <td><span className={b.od > 90 ? 'red-t' : 'amber-t'}><b>{b.od}d</b></span></td>
                  <td className="num"><b>{inr(b.pending ?? b.amt)}</b></td>
                  <td className="small">{b.pay_status === 'Part' ? <b className="green-t">Part {inr(b.received)}</b> : <span className="muted">—</span>}</td>
                </tr>
              ))}
              {!overdue.length && <tr><td colSpan={7} className="muted">No overdue bills.</td></tr>}
              {overdue.length > 40 && <tr><td colSpan={7} className="muted small">…and {overdue.length - 40} more</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {tab === 'rcpt' && <Receipts list={ag.receipts} />}
      {tab === 'hist' && <div className="fup-log tall"><Timeline entries={ag.entries} waCount={ag.waCount} /></div>}
    </div>
  )
}

export default function Salesman({ user, access }) {
  const demo = new URLSearchParams(window.location.search).has('demo')
  const isMobile = useIsMobile()
  const [rows, setRows] = useState(null)
  const [fups, setFups] = useState([])
  const [rcpts, setRcpts] = useState([])
  const [tick, setTick] = useState(0)
  const [q, setQ] = useState('')
  const [chip, setChip] = useState('all')
  const [open, setOpen] = useState(null)
  const [viewAs, setViewAs] = useState('')   // admin: kisi bhi salesman ki nazar se dekho
  const xf = useExtraFilters()               // beat / aging bucket / company / difference
  const cols = useColVis('fms_sales_cols', SALES_DEFAULT_ON)
  const [colPanel, setColPanel] = useState(false)   // false | 'cols' | 'print'
  const [toast, setToast] = useState('')

  useEffect(() => {
    if (demo) { fetch('/demo-collection.json').then((r) => r.json()).then(setRows).catch(() => setRows([])); return }
    Promise.all([
      supabase.from('fms_collection').select('*'),
      fetchAll('fms_followups', FUP_COLS, (x) => x.not('party_name', 'is', null).order('created_at', { ascending: false })),
      fetchAll('fms_receipts', RCPT_COLS, (x) => x.order('pay_date', { ascending: false, nullsFirst: false })),
    ]).then(([{ data }, f, r]) => { setRows(data || []); setFups(f); setRcpts(r) })
  }, [tick, demo])
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 6000); return () => clearTimeout(t) }, [toast])
  useEffect(() => { if (!open) return; const k = (e) => e.key === 'Escape' && setOpen(null); document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k) }, [open])

  const agg = useMemo(() => buildAgg(fups, rcpts), [fups, rcpts])
  const agOf = (p) => agg.get(normKey(p.party_name)) || EMPTY_AGG
  const salesmen = useMemo(() => [...new Set((rows || []).map((r) => r.salesman).filter(Boolean))].sort(), [rows])
  const resolved = useMemo(() => resolveSalesman(user, access, salesmen), [user, access, salesmen])
  // Super admin (fms_users.is_admin) ko default me SAB salesmen ki parties; dropdown se ek salesman chun sakta hai.
  const isAdmin = !!access?.is_admin
  const ALL = '*'
  const me = viewAs || (isAdmin ? ALL : resolved?.name || '')
  const allView = me === ALL

  const enriched = useMemo(() => (rows || [])
    .filter((p) => me && !p.permanent_note && (allView || p.salesman === me || agOf(p).transferTo === me))
    .map((p) => { const ag = agOf(p); const bucket = bucketOf(p, ag); return { p, ag, bucket, pr: priorityOf(p, ag, bucket), broken: isBroken(ag) } })
    .sort((a, b) => (b.pr.rank - a.pr.rank) || (Number(b.p.total_pending) - Number(a.p.total_pending))),
  [rows, agg, me]) // eslint-disable-line react-hooks/exhaustive-deps
  const openE = useMemo(() => enriched.find((e) => e.p.party_name === open) || null, [enriched, open])

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

  const opts = useMemo(() => filterOptions(rows), [rows])
  const base = useMemo(() => {
    const s = q.trim().toLowerCase()
    const list = s ? enriched.filter(({ p }) => `${p.party_name} ${p.mobile || ''} ${p.city || ''} ${p.salesman || ''}`.toLowerCase().includes(s)) : enriched
    return applyExtraFilters(list, xf.f)
  }, [enriched, q, xf.f])
  const counts = useMemo(() => Object.fromEntries(CHIPS.map((c) => [c.key, base.filter((e) => matchChip(e, c.key)).length])), [base])
  const filtered = useMemo(() => base.filter((e) => matchChip(e, chip)), [base, chip])
  const nextUp = useMemo(() => (chip === 'all' && !q ? filtered.find((e) => e.pr.rank >= 3) : null), [filtered, chip, q])
  const { visCols } = cols
  const totals = useTotals(filtered)
  const printNow = () => { setColPanel(false); printTable(visCols.length) }
  const clearAll = () => { setQ(''); xf.clear(); setChip('all') }
  const anyFilter = q || xf.any || chip !== 'all'
  const filterTxt = [allView ? 'all salesmen' : me, chip !== 'all' ? chip : '', ...extraFilterText(xf.f), q ? `"${q}"` : ''].filter(Boolean).join(' · ')

  const rowActions = (p) => {
    const wa = waLink(p.mobile, buildCollectionMsg(p))
    return (<>
      {p.mobile && <a className="btn ghost sm" href={`tel:${p.mobile}`} title={`Call ${p.mobile}`}>📞{isMobile && ' Call'}</a>}
      {wa && <a className="wa-btn" href={wa} target="_blank" rel="noreferrer" title="WhatsApp reminder" onClick={() => { logWaSendParty(p.party_name, 'Sent WhatsApp payment reminder'); setTimeout(() => setTick((t) => t + 1), 800) }}>📤{isMobile && ' WhatsApp'}</a>}
      <button className="btn primary sm" title="Open party — bills, history, commitment" onClick={() => setOpen(p.party_name)}>🤝 Commit</button>
    </>)
  }

  if (rows === null) return <div className="action-page coll-page"><div className="action-head"><h2>🧑‍💼 My Parties</h2></div><Skeleton rows={8} /></div>

  return (
    <div className="action-page coll-page">
      <div className="action-head">
        <div className="coll-title">
          <div>
            <h2>🧑‍💼 My Parties {me && <span className="muted" style={{ fontWeight: 400, fontSize: 15 }}>— {allView ? 'all salesmen' : me}</span>}</h2>
            {allView
              ? <p className="muted small">Super admin view — every salesman's parties. Pick a salesman to see only theirs.</p>
              : me
                ? <p className="muted small">Parties under <b>{me}</b>{resolved && !viewAs ? ` (${resolved.how})` : ''}, plus any transferred to you. Most important on top — call, then save the party's commitment.</p>
                : <p className="muted small">Your login is not linked to a salesman name.</p>}
          </div>
          <span className="coll-tools">
          {(isAdmin || !resolved) && salesmen.length > 0 && (
            <label className="small muted" style={{ whiteSpace: 'nowrap' }}>{isAdmin ? 'Salesman' : 'Preview as'}
              <select value={viewAs} onChange={(e) => { setViewAs(e.target.value); setOpen(null) }} style={{ marginLeft: 6 }}>
                <option value="">{isAdmin ? 'All salesmen' : resolved ? `me (${resolved.name})` : '— pick —'}</option>
                {salesmen.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
          )}
            <button className={`btn ghost sm ${colPanel === 'cols' ? 'on' : ''}`} onClick={() => setColPanel((v) => (v === 'cols' ? false : 'cols'))} title="Show / hide table columns">⚙ Columns</button>
            <button className={`btn ghost sm ${colPanel === 'print' ? 'on' : ''}`} onClick={() => setColPanel((v) => (v === 'print' ? false : 'print'))} title="Choose columns, then print this list with the current filters">🖨 Print</button>
          </span>
        </div>

        {!isAdmin && !resolved && !viewAs && (
          <div className="panel empty-state">
            <div className="es-ico">🔗</div>
            <b>Login {user?.email} is not linked to an ERP salesman</b>
            <p className="muted small">Ask the admin to open <b>User Control</b> and set your "Salesman (My Parties)" mapping. ERP salesmen: {salesmen.join(' · ') || '—'}</p>
          </div>
        )}

        {me && (<>
          <div className="coll-kpis">
            <button className={chip === 'all' ? 'kpi-card active' : 'kpi-card'} onClick={() => setChip('all')}><i>💰</i><b>{inrShort(kpi.total)}</b><span>Total pending · {kpi.parties} parties</span></button>
            <button className={chip === 'today' ? 'kpi-card due active' : 'kpi-card due'} onClick={() => setChip('today')}><i>📅</i><b>{kpi.due}</b><span>Due / missed follow-up</span></button>
            <button className={chip === 'committed' ? 'kpi-card active' : 'kpi-card'} onClick={() => setChip('committed')}><i>🤝</i><b>{kpi.committed}</b><span>Committed · {inrShort(kpi.committedAmt)}</span></button>
            <button className={chip === 'broken' ? 'kpi-card red active' : 'kpi-card red'} onClick={() => setChip('broken')}><i>💔</i><b>{kpi.broken}</b><span>Broken promises</span></button>
            <button className={chip === 'warm' ? 'kpi-card red active' : 'kpi-card red'} onClick={() => setChip('warm')}><i>🟠</i><b>{kpi.warm}</b><span>90+ days overdue</span></button>
            <div className="kpi-card static"><i>💵</i><b className="green-t">{inrShort(kpi.recvMonth)}</b><span>Received this month (ERP)</span></div>
          </div>
          <div className="coll-toolbar">
            <input className="search" placeholder="🔍 Search party / mobile / city…" value={q} onChange={(e) => setQ(e.target.value)} />
            <ExtraFilters opts={opts} f={xf.f} set={xf.set} onDiffYes={() => cols.showCol('diff')} />
            {anyFilter && <button className="btn ghost sm" onClick={clearAll}>✕ Clear</button>}
            <span className="filter-count active">🔎 {filtered.length} / {enriched.length}</span>
          </div>
          <div className="chip-rows"><div className="chip-row">{CHIPS.map((c) => <Chip key={c.key} label={c.label} n={counts[c.key]} tone={c.tone} active={chip === c.key} onClick={() => setChip(c.key)} />)}</div></div>
          {colPanel && <ColPanel mode={colPanel} cols={cols} allCols={COLS} presets={COL_PRESETS} count={filtered.length} onPrint={printNow} />}
        </>)}
      </div>

      {demo && <div className="panel demo-note"><p className="muted small">⚠️ SAMPLE data (demo mode).</p></div>}

      {me && !filtered.length && (
        <div className="panel empty-state"><div className="es-ico">🎉</div><b>{enriched.length ? 'Nothing here' : `No pending parties under ${me}`}</b>{enriched.length > 0 && <p className="muted small">No party matches this filter.</p>}</div>
      )}
      {me && <NextUp e={nextUp} onOpen={setOpen} />}

      {me && filtered.length > 0 && (isMobile ? (
        <div className="card-list">
          {filtered.slice(0, 100).map((e) => <PartyCard key={e.p.party_name} e={e} me={me} showSalesman={allView} onOpen={setOpen} actions={rowActions(e.p)} />)}
          {filtered.length > 100 && <p className="muted small" style={{ textAlign: 'center' }}>…and {filtered.length - 100} more — use search</p>}
        </div>
      ) : (
        <div className="panel coll-list">
          <div className="print-only small muted">My Parties · {filtered.length} parties · {inrShort(totals.total_pending)} pending · {filterTxt} · printed {new Date().toLocaleString('en-IN')}</div>
          <table className="cfg-tbl coll-tbl sm-tbl">
            <thead>
              <tr>
                <th className="no-print">Action</th><th>Priority</th><th>Party</th>{allView && <th>Salesman</th>}
                {visCols.map((c) => <th key={c.key} className={c.num ? 'num' : ''} title={c.title || ''}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 200).map((e) => {
                const { p, ag, pr } = e
                return (
                  <tr key={p.party_name} className={`coll-row pr-row ${pr.cls} ${open === p.party_name ? 'is-open' : ''}`} onClick={() => setOpen(p.party_name)}>
                    <td className="coll-actions no-print" onClick={(ev) => ev.stopPropagation()}>{rowActions(p)}</td>
                    <td><span className={`pr-badge ${pr.cls}`} title={pr.hint}>{pr.label}</span></td>
                    <td><PartyCell p={p} ag={ag} showSalesman={false} me={allView ? '' : me} /></td>
                    {allView && <td className="small">{p.salesman || '—'}</td>}
                    {visCols.map((c) => <td key={c.key} className={c.num ? 'num' : ''}>{cellOf(c, e)}</td>)}
                  </tr>
                )
              })}
              {filtered.length > 200 && <tr><td colSpan={(allView ? 4 : 3) + visCols.length} className="muted small">…and {filtered.length - 200} more — use search</td></tr>}
            </tbody>
            <TotalsRow visCols={visCols} totals={totals} count={filtered.length} lead={allView ? 3 : 2} />
          </table>
        </div>
      ))}

      {openE && (
        <div className="modal-back" onClick={() => setOpen(null)}>
          <div className="modal coll-modal" onClick={(ev) => ev.stopPropagation()}>
            <div className="modal-head">
              <div className="mh-left">
                <Avatar name={openE.p.party_name} size={40} />
                <div>
                  <h3>{openE.p.party_name} <span className={`pr-badge ${openE.pr.cls}`} title={openE.pr.hint}>{openE.pr.label}</span> <BucketPill b={openE.bucket} date={openE.p.next_followup_date} /></h3>
                  <p className="muted small coll-modal-sub">{[allView ? openE.p.salesman : null, openE.p.beat, openE.p.city, openE.p.mobile].filter(Boolean).join(' · ')}{openE.p.credit_days ? ` · credit ${openE.p.credit_days} days` : ''}</p>
                </div>
              </div>
              <button className="btn ghost" onClick={() => setOpen(null)}>✕ Close</button>
            </div>
            <PartyPanel key={openE.p.party_name} p={openE.p} ag={openE.ag} bucket={openE.bucket} demo={demo} onSaved={() => setTick((t) => t + 1)} onToast={setToast} />
          </div>
        </div>
      )}
      <Toast msg={toast} />
    </div>
  )
}
