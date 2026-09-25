import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { buildCollectionMsg, waLink, logWaSendParty, suggestNextFollowup } from '../lib/fms'
import MultiSelect from './MultiSelect'
import { inr, inrShort, dmy, isoDay, toLocalInput, normKey, userName, isUrgent, STAGES, STAGE_HINT, PAY_MODES, bucketOf, isBroken, EMPTY_AGG, buildAgg, priorityOf, fetchAll, FUP_COLS, RCPT_COLS, BUCKET_LABEL, useIsMobile } from '../lib/coll'
import { COLS, COL_PRESETS, COLL_DEFAULT_ON, useColVis, cellOf, sortVal, useExtraFilters, filterOptions, applyExtraFilters, extraFilterText, useTotals, printTable } from '../lib/collCols'
import { BucketPill, Timeline, Receipts, Avatar, PartyCell, StatStrip, Tabs, Chip, Toast, NextUp, Skeleton, PartyCard, ExtraFilters, ColPanel, TotalsRow } from './CollBits'

// Collection tab: poore ledger ka party-wise outstanding (fms_collection, har ghante ERP se sync)
// + follow-up system (fms_followups): stage, bills, commitment, transfer, permanent note
// + ERP receipts (fms_receipts, Payment.ashx voucher-wise) — paisa aaya ya nahi ERP batata hai, manual entry sirf "claim".
// Design goal: naya CRM executive bina training ke chala le — sabse zaroori party UPAR,
// har row par seedha Call/WhatsApp/Note, ek-click filter chips (counts ke saath), phone par cards.
const STATUS_PRESETS = [
  { key: 'all', label: 'All' }, { key: 'missed', label: '⏰ Missed', tone: 'red' }, { key: 'today', label: '📅 Today', tone: 'amber' },
  { key: 'tomorrow', label: 'Tomorrow' }, { key: 'week', label: 'This week' }, { key: 'nodate', label: 'No date' },
]
const SITUATION_PRESETS = [
  { key: 'broken', label: '💔 Broken promise', tone: 'red' }, { key: 'hot', label: '🔴 Urgent', tone: 'red' }, { key: 'warm', label: '🟠 90+ days', tone: 'amber' },
  { key: 'committed', label: '🤝 Committed / PDC' }, { key: 'pdc', label: '🧾 PDC' }, { key: 'flw5', label: '🔁 5+ follow-ups' },
  { key: 'received', label: '💵 Received' }, { key: 'transferred', label: '↪ Transferred' }, { key: 'closed', label: '✅ Closed' }, { key: 'excluded', label: '🚫 Excluded' },
]
// preset -> party match (counts + filter dono isi se)
function matchPreset(e, key, recvSet) {
  switch (key) {
    case 'all': return true
    case 'missed': case 'today': case 'tomorrow': case 'week': case 'nodate': case 'closed': return e.bucket === key
    case 'broken': return e.broken
    case 'hot': return isUrgent(e.p)
    case 'warm': return (e.p.oldest_od || 0) > 90
    case 'committed': return (e.ag.committed && !e.broken) || e.p.has_pdc || e.ag.lastStage === 'PDC received'
    case 'pdc': return e.p.has_pdc || e.ag.lastStage === 'PDC received'
    case 'flw5': return e.ag.count >= 5
    case 'received': return recvSet.has(normKey(e.p.party_name))
    case 'transferred': return !!e.ag.transferTo
    case 'excluded': return !!e.p.permanent_note
    default: return true
  }
}

// ---------- Follow-up form (chhota modal): bill-wise ya party-level ----------
// bills = [{ vno, pending }] jin par ye note hai (khali = poora account)
function FollowupForm({ p, bills, salesmen, demo, onClose, onSaved }) {
  const [stage, setStage] = useState('')
  const [remark, setRemark] = useState('')
  const [amount, setAmount] = useState('')
  const [payMode, setPayMode] = useState('')
  const [cAmt, setCAmt] = useState('')
  const [cDate, setCDate] = useState('')
  const [tTo, setTTo] = useState('')
  const [tReason, setTReason] = useState('')
  const [nextDate, setNextDate] = useState(() => toLocalInput(suggestNextFollowup()))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const billSum = bills.reduce((a, b) => a + Number(b.pending || 0), 0)
  const scope = bills.length === 0 ? 'whole account' : bills.length === 1 ? `bill ${bills[0].vno} · ${inr(bills[0].pending)} pending` : `${bills.length} bills · ${inr(billSum)} pending`

  useEffect(() => { const k = (e) => e.key === 'Escape' && onClose(); document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k) }, [onClose])

  // Committed: date default = next follow-up date; amount default = in bills ka pending
  const pickStage = (s) => {
    setStage(s)
    if (s === 'Committed') { if (!cDate && nextDate) setCDate(nextDate.slice(0, 10)); if (!cAmt && billSum) setCAmt(String(Math.round(billSum))) }
    if (s === 'Payment received' && !amount && billSum) setAmount(String(Math.round(billSum)))
  }
  const quickNext = (days) => { const d = suggestNextFollowup(days); setNextDate(toLocalInput(d)) }

  const save = async () => {
    if (!stage) { setErr('Pick a Stage first — what happened on this call?'); return }
    if (!remark.trim()) { setErr('Write what was discussed'); return }
    if (stage === 'Committed' && !(Number(cAmt) > 0 && cDate)) { setErr('Committed stage needs the promised amount and date'); return }
    if (stage === 'Payment received' && !(Number(amount) > 0)) { setErr('Payment received — enter the amount'); return }
    if (Number(amount) > 0 && !payMode) { setErr('Pick the payment mode for the amount received'); return }
    if (stage === 'Transfer' && !tTo.trim()) { setErr('Transfer — pick the salesman to hand over to'); return }
    if (stage !== 'Close' && !nextDate) { setErr('Set the next follow-up date'); return }
    if (demo) { setErr('Demo mode cannot save — use the real login'); return }
    setSaving(true); setErr('')
    const { data: { user } } = await supabase.auth.getUser()
    const { error: e1 } = await supabase.from('fms_followups').insert({
      party_name: p.party_name, remarks: remark.trim(), mode: 'call', stage,
      amount_received: Number(amount) > 0 ? Number(amount) : null,
      payment_mode: Number(amount) > 0 ? payMode : null,
      bill_nos: bills.map((b) => b.vno),
      committed_amount: stage === 'Committed' ? Number(cAmt) : null,
      committed_date: stage === 'Committed' ? cDate : null,
      transfer_to: stage === 'Transfer' ? tTo.trim() : null,
      transfer_reason: stage === 'Transfer' ? tReason.trim() || null : null,
      followup_date: isoDay(),
      next_followup_date: stage === 'Close' ? null : new Date(nextDate).toISOString(),   // PLAN (scoring)
      created_by: user?.email || '',
    })
    const { error: e2 } = await supabase.from('fms_collection')
      .update({ next_followup_date: stage === 'Close' ? null : new Date(nextDate).toISOString() }).eq('party_name', p.party_name)
    setSaving(false)
    if (e1 || e2) { setErr('Save failed: ' + (e1 || e2).message); return }
    onSaved?.(stage === 'Close' ? '✅ Saved — party closed, it leaves the Today/Tomorrow lists.'
      : stage === 'Transfer' ? `✅ Saved — this party now shows under ${tTo.trim()} as well.`
      : stage === 'Payment received' ? '✅ Saved as claimed — the hourly ERP sync will confirm it against the bills.'
      : `✅ Saved! Next follow-up ${dmy(nextDate)} — it will appear under "Today" that day.`)
    onClose()
  }

  return (
    <div className="modal-back fup-back" onClick={onClose}>
      <div className="modal fup-modal2" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="mh-left">
            <Avatar name={p.party_name} size={34} />
            <div>
              <h3>Follow-up — {p.party_name}</h3>
              <p className="muted small" style={{ margin: '2px 0 0' }}>For: <b>{scope}</b>{bills.length > 1 && <> · {bills.map((b) => b.vno).join(', ')}</>}</p>
            </div>
          </div>
          <button className="btn ghost" onClick={onClose}>✕</button>
        </div>
        <div className="fup2-grid">
          <div className="step-form">
            <b><span className="step-num">1</span> What happened?</b>
            <div className="stage-grid">
              {STAGES.map((s) => <button key={s} className={`stage-opt ${stage === s ? 'on' : ''}`} title={STAGE_HINT[s]} onClick={() => pickStage(s)}>{s}</button>)}
            </div>
            {stage && <span className="muted small stage-hint">{STAGE_HINT[stage]}</span>}
            <input placeholder='What did they say? e.g. "Will pay by RTGS on the 5th"' value={remark} onChange={(e) => setRemark(e.target.value)} autoFocus />
          </div>
          <div className="step-form">
            <b><span className="step-num">2</span> Details</b>
            {stage === 'Committed' && <div className="fld-row">
              <input type="number" placeholder="Promised amount ₹" value={cAmt} onChange={(e) => setCAmt(e.target.value)} />
              <input type="date" value={cDate} title="Promised date" onChange={(e) => setCDate(e.target.value)} />
            </div>}
            {stage === 'Transfer' && <div className="fld-row">
              <input list="coll-salesmen" placeholder="Transfer to (salesman)" value={tTo} onChange={(e) => setTTo(e.target.value)} />
              <datalist id="coll-salesmen">{salesmen.map((s) => <option key={s} value={s} />)}</datalist>
              <input placeholder="Reason" value={tReason} onChange={(e) => setTReason(e.target.value)} />
            </div>}
            <div className="fld-row">
              <input type="number" placeholder="Amount received now (blank if none)" value={amount} onChange={(e) => setAmount(e.target.value)} />
              {Number(amount) > 0 && <select value={payMode} onChange={(e) => setPayMode(e.target.value)}>
                <option value="">Mode…</option>{PAY_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>}
            </div>
            <span className="muted small">Amount is a claim — the ERP receipt confirms it and splits it across bills automatically.</span>
          </div>
          <div className="step-form">
            <b><span className="step-num">3</span> When to remind next?</b>
            <input type="datetime-local" value={nextDate} disabled={stage === 'Close'} onChange={(e) => setNextDate(e.target.value)} />
            {stage !== 'Close' && <div className="fld-row quick">
              {[['Tomorrow', 1], ['+3 days', 3], ['+7 days', 7], ['+15 days', 15]].map(([l, d]) => <button key={d} className="btn ghost sm" onClick={() => quickNext(d)}>{l}</button>)}
            </div>}
            {stage === 'Close' && <span className="muted small">Close = no next date; party leaves the worklist.</span>}
            <button className="btn primary" onClick={save} disabled={saving}>{saving ? '⏳ Saving…' : '💾 Save follow-up'}</button>
            {err && <span className="err small" style={{ marginTop: 0 }}>{err}</span>}
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------- Party modal body: stats, actions, tabs (bills / receipts / history), permanent note ----------
function PartyDetail({ p, ag, bucket, demo, salesmen, onSaved, onToast }) {
  const [selBills, setSelBills] = useState([])
  const [form, setForm] = useState(null)      // null | { bills: [{vno, pending}] }
  const [tab, setTab] = useState('bills')
  const [err, setErr] = useState('')
  const [noteOpen, setNoteOpen] = useState(false)
  const [note, setNote] = useState(p.permanent_note || '')

  const wa = waLink(p.mobile, buildCollectionMsg(p))
  const overdueBills = (p.bills || []).filter((b) => (b.od || 0) > 0)
  const toggleBill = (v) => setSelBills((s) => (s.includes(v) ? s.filter((x) => x !== v) : [...s, v]))
  const billObj = (vno) => { const b = overdueBills.find((x) => x.vno === vno); return { vno, pending: b ? (b.pending ?? b.amt) : 0 } }
  const openForm = (vnos) => setForm({ bills: vnos.map(billObj) })
  const saved = (msg) => { onToast?.(msg); setSelBills([]); onSaved?.() }

  const saveNote = async (clear) => {
    if (demo) { setErr('Demo mode cannot save — use the real login'); return }
    const { data: { user } } = await supabase.auth.getUser()
    const { error } = await supabase.from('fms_collection').update({
      permanent_note: clear ? null : note.trim() || null, note_updated_by: user?.email || '', note_updated_at: new Date().toISOString(),
    }).eq('party_name', p.party_name)
    if (error) { setErr('Note save failed: ' + error.message); return }
    if (clear) setNote('')
    setNoteOpen(false); onToast?.(clear ? '✅ Note removed — party is back in the worklist' : '✅ Party excluded from the worklist'); onSaved?.()
  }

  // bills table ke filters: firm-wise + aging-wise (multi-select) + PDC + paid toggle
  const [fFirms, setFFirms] = useState([])
  const [fAges, setFAges] = useState([])
  const [fPdc, setFPdc] = useState('')
  const [showPaid, setShowPaid] = useState(false)
  const AGE_OPTS = ['1-30', '31-60', '61-90', '91-120', '121-150', '151-180', '180+']
  const ageBucket = (od) => od <= 30 ? '1-30' : od <= 60 ? '31-60' : od <= 90 ? '61-90' : od <= 120 ? '91-120' : od <= 150 ? '121-150' : od <= 180 ? '151-180' : '180+'
  const firmOpts = [...new Set(overdueBills.map((b) => String(b.company || '').trim()).filter(Boolean))].sort()
  const today = isoDay()
  const hasPdc = (b) => !!(b.pdc_rcpt || b.pdc_date)
  // paid state: 'erp' = ERP Full (ERP list se agle sync me hatega) | 'claimed' = note me received likha, ERP me abhi nahi
  const paidState = (b) => b.pay_status === 'Full' ? 'erp' : ag.paid.has(b.vno) ? 'claimed' : ''
  const paidN = overdueBills.filter((b) => paidState(b)).length
  const shownBills = overdueBills.filter((b) =>
    (showPaid || !paidState(b)) &&
    (!fFirms.length || fFirms.includes(String(b.company || '').trim())) &&
    (!fAges.length || fAges.includes(ageBucket(b.od || 0))) &&
    (!fPdc || (fPdc === 'none' ? !hasPdc(b) : hasPdc(b) && b.pdc_date && (fPdc === 'today' ? b.pdc_date === today : fPdc === 'up' ? b.pdc_date > today : b.pdc_date < today))))
  const hotN = shownBills.filter((b) => (b.od || 0) >= 60).length
  const filtersOn = fFirms.length > 0 || fAges.length > 0 || fPdc
  const selSum = selBills.reduce((a, v) => a + Number(billObj(v).pending || 0), 0)
  const r0 = ag.receipts[0]
  const broken = isBroken(ag)

  const erpCell = (b) => {
    const claimed = ag.paid.get(b.vno)
    if (b.pay_status === 'Full') return <span className="green-t small">✅ Full{b.last_pay_date ? ' · ' + dmy(b.last_pay_date) : ''}</span>
    if (b.pay_status === 'Part') return <span className="small"><b className="green-t">Part {inr(b.received)}</b>{claimed ? <div className="amber-t">claimed {inr(claimed.amount)} {dmy(claimed.at)}</div> : b.last_pay_date ? <div className="muted">{dmy(b.last_pay_date)}</div> : null}</span>
    if (claimed) return <span className="amber-t small" title="Logged as received in a note; ERP has not shown a receipt yet — check after the next hourly sync">⚠ claimed {dmy(claimed.at)}<div>not in ERP yet</div></span>
    return <span className="muted small">—</span>
  }

  const stats = [
    { l: 'Total pending', v: inrShort(p.total_pending), s: `${p.bill_count} bills`, cls: 'vio' },
    { l: 'Overdue bills', v: overdueBills.length, s: `of ${(p.bills || []).length}`, cls: overdueBills.length ? 'amb' : '' },
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
        {wa && <a className="wa-btn" href={wa} target="_blank" rel="noreferrer"
          onClick={() => { logWaSendParty(p.party_name, 'Sent WhatsApp payment reminder'); setTimeout(() => onSaved?.(), 800) }}>📤 Send WhatsApp</a>}
        {!p.mobile && <span className="muted small">No mobile number — ask salesman {p.salesman || ''}</span>}
        <button className="btn ghost sm" onClick={() => openForm([])} title="Note about the whole account (no specific bill)">📝 Follow-up (whole account)</button>
        <button className="btn ghost sm" title="Permanent note: e.g. legal case, party closed — removes party from the worklist" onClick={() => setNoteOpen((v) => !v)}>
          {p.permanent_note ? '🚫 Edit note' : '🚫 Exclude'}
        </button>
        <span className="muted small ask" title={`Ask: "Total ${inrShort(p.total_pending)} is pending${p.oldest_od ? `, oldest bill ${p.oldest_od} days overdue` : ''} — when can we expect the payment?"`}>💬 "Total {inrShort(p.total_pending)} is pending{p.oldest_od ? `, oldest bill ${p.oldest_od} days overdue` : ''} — when can we expect the payment?"</span>
      </div>
      {(ag.transferTo || p.permanent_note || err) && (
        <div className="coll-flags">
          {ag.transferTo && <span className="stage-chip st-park">↪ Transferred to {ag.transferTo}{ag.transferReason ? ' — ' + ag.transferReason : ''}</span>}
          {p.permanent_note && <span className="stage-chip st-bad">🚫 Excluded: {p.permanent_note}</span>}
          {err && <span className="err small" style={{ margin: 0 }}>{err}</span>}
        </div>
      )}
      {noteOpen && (
        <div className="note-box">
          <textarea rows={2} placeholder="Why should this party stay out of the worklist? (legal case, disputed, account closed…)" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="fld-row">
            <button className="btn primary sm" onClick={() => saveNote(false)} disabled={!note.trim()}>Save note (exclude)</button>
            {p.permanent_note && <button className="btn ghost sm" onClick={() => saveNote(true)}>Remove note (bring back)</button>}
            <button className="btn ghost sm" onClick={() => setNoteOpen(false)}>Cancel</button>
          </div>
          {p.permanent_note && p.note_updated_by && <span className="muted small">Set by {userName(p.note_updated_by)} on {dmy(p.note_updated_at)}</span>}
        </div>
      )}

      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'bills', label: '🧾 Overdue bills', n: overdueBills.length },
        { key: 'rcpt', label: '💵 Receipts (ERP)', n: ag.receipts.length },
        { key: 'hist', label: '🗒️ History', n: ag.count },
      ]} />

      {tab === 'bills' && (
        <div className="coll-bills">
          <div className="coll-bill-filters">
            <span className="muted small">Click 📝 on a bill to note a call about it, or tick several bills.{hotN > 0 && <span className="hot-lgd">{hotN} bill{hotN > 1 ? 's' : ''} 60+ days overdue</span>}</span>
            <span style={{ flex: 1 }} />
            <MultiSelect label="Firm" options={firmOpts} value={fFirms} onChange={setFFirms} />
            <MultiSelect label="Aging" options={AGE_OPTS.map((a) => ({ key: a, label: a + ' days' }))} value={fAges} onChange={setFAges} />
            <select value={fPdc} onChange={(e) => setFPdc(e.target.value)} title="Filter by post-dated cheque date">
              <option value="">PDC: All</option><option value="today">PDC today</option><option value="up">PDC upcoming</option><option value="due">PDC date passed</option><option value="none">No PDC</option>
            </select>
            {paidN > 0 && <label className="small chk"><input type="checkbox" checked={showPaid} onChange={(e) => setShowPaid(e.target.checked)} /> Show {paidN} paid / claimed</label>}
            {filtersOn && <>
              <button className="btn ghost sm" onClick={() => { setFFirms([]); setFAges([]); setFPdc('') }}>✕ Clear</button>
              <span className="filter-count active">🔎 {shownBills.length} / {overdueBills.length}</span>
            </>}
          </div>
          {selBills.length > 0 && (
            <div className="sel-bar">
              <b>{selBills.length} bill{selBills.length > 1 ? 's' : ''} selected · {inr(selSum)}</b>
              <button className="btn primary sm" onClick={() => openForm(selBills)}>📝 Follow-up for these</button>
              <button className="btn ghost sm" onClick={() => setSelBills([])}>✕</button>
            </div>
          )}
          <div className="tbl-wrap-inner">
            <table className="cfg-tbl coll-bill-tbl">
              <thead><tr><th title="Tick to select several bills for one note">✓</th><th>Bill No</th><th>Firm</th><th>Bill Date</th><th>Age</th><th className="num">Pending</th><th title="From ERP Payment.ashx: Full / Part received, or your claimed amount awaiting ERP">ERP paid</th><th>PDC (cheque)</th><th>Bilty</th><th>Notes</th><th></th></tr></thead>
              <tbody>
                {shownBills.slice(0, 100).map((b, i) => {
                  const ps = paidState(b)
                  const cls = [ps ? 'coll-paid' : '', b.od > 180 ? 'coll-old' : b.od >= 60 ? 'coll-hot' : '', selBills.includes(b.vno) ? 'coll-sel' : ''].join(' ')
                  return (
                    <tr key={i} className={cls} onClick={() => b.vno && toggleBill(b.vno)}>
                      <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={selBills.includes(b.vno)} disabled={!b.vno} onChange={() => toggleBill(b.vno)} /></td>
                      <td><b>{b.vno || '—'}</b></td>
                      <td className="small">{b.company || '—'}</td>
                      <td>{dmy(b.date)}</td>
                      {/* summary-shape bill (vno nahi) me sirf bill ki umar pata hoti hai — "not due yet" mat likho */}
                      <td>{b.od > 0 ? <span className={b.od > 90 ? 'red-t' : 'amber-t'}><b>{b.od} days</b></span>
                        : <span className="muted small">{b.days != null ? (b.vno ? `${b.days} days (not due yet)` : `${b.days} days old`) : '—'}</span>}</td>
                      <td className="num"><b>{inr(b.pending ?? b.amt)}</b>{b.pay_status === 'Part' && b.still_pending != null && Math.round(b.still_pending) !== Math.round(b.pending ?? b.amt) && <div className="muted small">ERP: {inr(b.still_pending)}</div>}</td>
                      <td onClick={(e) => e.stopPropagation()}>{erpCell(b)}</td>
                      <td className="small">{hasPdc(b) ? <span className={b.pdc_date && b.pdc_date < today ? 'red-t' : b.pdc_date === today ? 'amber-t' : ''}>✅ {b.pdc_rcpt || ''} {dmy(b.pdc_date)}</span> : '—'}</td>
                      <td className="small">{b.bilty || '—'}</td>
                      <td className="small coll-notes" title={b.notes || ''}>{b.notes || '—'}</td>
                      <td onClick={(e) => e.stopPropagation()}>{b.vno && <button className="btn ghost sm" title={`Follow-up note for ${b.vno}`} onClick={() => openForm([b.vno])}>📝</button>}</td>
                    </tr>
                  )
                })}
                {!overdueBills.length && (
                  <tr><td colSpan={11} className="muted">No overdue bills — all pending bills are still within their credit period.</td></tr>
                )}
                {overdueBills.length > 0 && !shownBills.length && (
                  <tr><td colSpan={11} className="muted">{paidN && !filtersOn ? 'All overdue bills are paid / claimed — tick "Show paid / claimed" to see them.' : 'No bills match this filter.'}</td></tr>
                )}
                {shownBills.length > 100 && (
                  <tr><td colSpan={11} className="muted small">…and {shownBills.length - 100} more overdue bills (oldest 100 shown above)</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {tab === 'rcpt' && <div className="coll-rcpts"><Receipts list={ag.receipts} /></div>}
      {tab === 'hist' && <div className="fup-log tall"><Timeline entries={ag.entries} waCount={ag.waCount} /></div>}

      {form && <FollowupForm p={p} bills={form.bills} salesmen={salesmen} demo={demo} onClose={() => setForm(null)} onSaved={saved} />}
    </div>
  )
}

// ---------- table columns (⚙ Columns se show/hide, localStorage me yaad) ----------
export default function Collection() {
  const demo = new URLSearchParams(window.location.search).has('demo')
  const isMobile = useIsMobile()
  const [rows, setRows] = useState(null)
  const [fups, setFups] = useState([])
  const [rcpts, setRcpts] = useState([])
  const [q, setQ] = useState('')
  const [salesman, setSalesman] = useState('')
  const xf = useExtraFilters()                  // beat / aging bucket / company / difference
  const [preset, setPreset] = useState('all')
  const [sort, setSort] = useState(['priority', 'desc'])
  const [open, setOpen] = useState(null) // party_name jo modal me hai
  const [tick, setTick] = useState(0)
  const [showHelp, setShowHelp] = useState(() => !localStorage.getItem('fms_coll_help_seen'))
  const cols = useColVis('fms_coll_cols', COLL_DEFAULT_ON)
  const [colPanel, setColPanel] = useState(false)   // false | 'cols' | 'print'
  const [toast, setToast] = useState('')
  const [pulseOpen, setPulseOpen] = useState(() => localStorage.getItem('fms_coll_pulse') !== '0')
  // Pulse date range — default: is mahine
  const [from, setFrom] = useState(() => { const n = new Date(); return isoDay(new Date(n.getFullYear(), n.getMonth(), 1)) })
  const [to, setTo] = useState(() => isoDay())

  useEffect(() => {
    if (demo) {
      // demo mode me DB access nahi hai — sample data dikhao taaki tab samajh aaye
      fetch('/demo-collection.json').then((r) => r.json()).then(setRows).catch(() => setRows([]))
      return
    }
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

  const salesmen = useMemo(() => {
    const s = new Set((rows || []).map((r) => r.salesman).filter(Boolean))
    agg.forEach((a) => { if (a.transferTo) s.add(a.transferTo) })
    return [...s].sort()
  }, [rows, agg])

  const opts = useMemo(() => filterOptions(rows), [rows])

  // Pulse: chuni range me ERP receipts (asli paisa) + logged follow-ups, kisne kitne kiye
  const inRange = (iso) => { const d = String(iso || '').slice(0, 10); return (!from || d >= from) && (!to || d <= to) }
  const pulse = useMemo(() => {
    const r = { erp: 0, erpN: 0, logged: 0, done: 0, byUser: {}, recvParties: new Set() }
    for (const x of rcpts) {
      if (!x.pay_date || !inRange(x.pay_date)) continue
      r.erp += Number(x.amount || 0); r.erpN++; r.recvParties.add(normKey(x.party_name))
    }
    for (const f of fups) {
      if (f.mode === 'whatsapp' || !inRange(f.created_at)) continue
      r.done++
      const u = userName(f.created_by) || '?'; r.byUser[u] = (r.byUser[u] || 0) + 1
      if (Number(f.amount_received) > 0) { r.logged += Number(f.amount_received); r.recvParties.add(normKey(f.party_name)) }
    }
    return r
  }, [fups, rcpts, from, to]) // eslint-disable-line react-hooks/exhaustive-deps

  // har party ka derived data ek baar (filter/sort/KPI sab isi se)
  const enriched = useMemo(() => (rows || []).map((p) => {
    const ag = agOf(p); const bucket = bucketOf(p, ag)
    return { p, ag, bucket, pr: priorityOf(p, ag, bucket), broken: isBroken(ag) }
  }), [rows, agg]) // eslint-disable-line react-hooks/exhaustive-deps
  const openE = useMemo(() => enriched.find((e) => e.p.party_name === open) || null, [enriched, open])

  const kpi = useMemo(() => {
    const live = enriched.filter((e) => !e.p.permanent_note)
    const sum = (list) => list.reduce((a, e) => a + Number(e.p.total_pending || 0), 0)
    const missed = live.filter((e) => e.bucket === 'missed')
    return {
      total: sum(live), parties: live.length,
      missed: missed.length, missedAmt: sum(missed),
      due: live.filter((e) => e.bucket === 'today').length,
      broken: live.filter((e) => e.broken).length,
      hot: live.filter((e) => isUrgent(e.p)).length,
      old180: live.reduce((a, e) => a + Number(e.p.aging?.b180p || 0), 0),
      commit: live.filter((e) => matchPreset(e, 'committed', pulse.recvParties)).length,
      flw5: live.filter((e) => e.ag.count >= 5).length,
      excluded: enriched.length - live.length,
    }
  }, [enriched, pulse])

  // search + salesman ke baad ki base list (chip counts isi par)
  const base = useMemo(() => {
    let list = enriched
    const s = q.trim().toLowerCase()
    if (s) list = list.filter(({ p }) => `${p.party_name} ${p.mobile || ''} ${p.city || ''} ${p.salesman || ''}`.toLowerCase().includes(s))
    // salesman filter: apni parties + jo transfer hoke aayi
    if (salesman) list = list.filter((e) => e.p.salesman === salesman || e.ag.transferTo === salesman)
    return applyExtraFilters(list, xf.f)
  }, [enriched, q, salesman, xf.f])
  const counts = useMemo(() => {
    const live = base.filter((e) => !e.p.permanent_note)
    const c = {}
    for (const pr of [...STATUS_PRESETS, ...SITUATION_PRESETS]) c[pr.key] = (pr.key === 'excluded' ? base : live).filter((e) => matchPreset(e, pr.key, pulse.recvParties)).length
    return c
  }, [base, pulse])

  const filtered = useMemo(() => {
    let list = preset === 'excluded' ? base.filter((e) => e.p.permanent_note) : base.filter((e) => !e.p.permanent_note)   // permanent note wali parties worklist se bahar
    list = list.filter((e) => matchPreset(e, preset, pulse.recvParties))
    const [k, dir] = sort
    const mul = dir === 'desc' ? -1 : 1
    const val = (e) => sortVal(k, e, dir)
    return [...list].sort((a, b) => {
      if (k === 'priority') {
        // pehle priority, same priority me bada amount upar — "upar se kaam karo" hamesha sahi rahe
        const d = a.pr.rank - b.pr.rank
        if (d !== 0) return d * mul
        return (Number(a.p.total_pending || 0) - Number(b.p.total_pending || 0)) * mul
      }
      const av = val(a), bv = val(b)
      return (av < bv ? -1 : av > bv ? 1 : 0) * mul
    })
  }, [base, preset, sort, pulse])
  const nextUp = useMemo(() => (preset === 'all' && !q ? filtered.find((e) => e.pr.rank >= 3) : null), [filtered, preset, q])

  const sortBtn = (key, label, title) => (
    <button className="link th-sort" title={title || ''} onClick={() => setSort(([k, d]) => [key, k === key && d === 'desc' ? 'asc' : 'desc'])}>
      {label}{sort[0] === key ? (sort[1] === 'desc' ? ' ↓' : ' ↑') : ''}
    </button>
  )
  const { visCols } = cols
  const totals = useTotals(filtered)
  const printNow = () => { setColPanel(false); printTable(visCols.length) }

  const dismissHelp = () => { setShowHelp(false); try { localStorage.setItem('fms_coll_help_seen', '1') } catch { /* private mode */ } }
  const clearAll = () => { setQ(''); setSalesman(''); xf.clear(); setPreset('all') }
  const anyFilter = q || salesman || xf.any || preset !== 'all'
  const filterTxt = [preset !== 'all' ? preset : '', salesman, ...extraFilterText(xf.f), q ? `"${q}"` : ''].filter(Boolean).join(' · ')
  const chip = (pr) => <Chip key={pr.key} label={pr.label} n={counts[pr.key]} tone={pr.tone} active={preset === pr.key} onClick={() => setPreset(pr.key)} />
  const setRange = (f, t) => { setFrom(f); setTo(t) }
  const rangeTxt = from || to ? `${from ? dmy(from) : 'start'} – ${to ? dmy(to) : 'today'}` : 'all time'
  const togglePulse = () => { setPulseOpen((v) => { try { localStorage.setItem('fms_coll_pulse', v ? '0' : '1') } catch { /* ignore */ } return !v }) }
  const rowActions = (p) => {
    const wa = waLink(p.mobile, buildCollectionMsg(p))
    return (<>
      {p.mobile && <a className="btn ghost sm" href={`tel:${p.mobile}`} title={`Call: ${p.mobile}`}>📞{isMobile && ' Call'}</a>}
      {wa && <a className="wa-btn" href={wa} target="_blank" rel="noreferrer" title="Send WhatsApp reminder"
        onClick={() => { logWaSendParty(p.party_name, 'Sent WhatsApp payment reminder'); setTimeout(() => setTick((t) => t + 1), 800) }}>📤{isMobile && ' WhatsApp'}</a>}
      <button className="btn ghost sm" title="Open party — bills + follow-up" onClick={() => setOpen(p.party_name)}>📝{isMobile && ' Note'}</button>
    </>)
  }

  if (rows === null) return <div className="action-page coll-page"><div className="action-head"><h2>💰 Collection — Outstanding Payments</h2></div><Skeleton rows={8} /></div>

  return (
    <div className="action-page coll-page">
      <div className="action-head">
        <div className="coll-title">
          <div>
            <h2>💰 Collection — Outstanding Payments</h2>
            <p className="muted small">All pending payments, party-wise. The most important party is <b>at the top</b> — work top to bottom.</p>
          </div>
          <span className="coll-tools">
            <button className={`btn ghost sm ${pulseOpen ? 'on' : ''}`} onClick={togglePulse} title="Show / hide the date-range pulse">📊 Pulse</button>
            <button className={`btn ghost sm ${colPanel === 'cols' ? 'on' : ''}`} onClick={() => setColPanel((v) => (v === 'cols' ? false : 'cols'))} title="Show / hide table columns">⚙ Columns</button>
            <button className={`btn ghost sm ${colPanel === 'print' ? 'on' : ''}`} onClick={() => setColPanel((v) => (v === 'print' ? false : 'print'))} title="Choose columns, then print this list with the current filters">🖨 Print</button>
          </span>
        </div>

        {showHelp && (
          <div className="coll-help">
            <b>How to use (3 steps):</b>
            <span>1️⃣ Click the top party</span>
            <span>2️⃣ 📞 Call or 📤 WhatsApp them</span>
            <span>3️⃣ Click 📝 on the bill you talked about, pick the stage, note + next date → Save</span>
            <button className="btn ghost sm" onClick={dismissHelp}>✕ Got it</button>
          </div>
        )}

        <div className="coll-kpis">
          <button className={preset === 'all' ? 'kpi-card active' : 'kpi-card'} onClick={() => setPreset('all')}>
            <i>💰</i><b>{inrShort(kpi.total)}</b><span>Total pending · {kpi.parties} parties</span>
          </button>
          <button className={preset === 'missed' ? 'kpi-card red active' : 'kpi-card red'} onClick={() => setPreset('missed')} title="Follow-up date passed, nobody called">
            <i>⏰</i><b>{kpi.missed}</b><span>Missed · {inrShort(kpi.missedAmt)} stuck</span>
          </button>
          <button className={preset === 'today' ? 'kpi-card due active' : 'kpi-card due'} onClick={() => setPreset('today')}>
            <i>📅</i><b>{kpi.due}</b><span>Due today</span>
          </button>
          <button className={preset === 'broken' ? 'kpi-card red active' : 'kpi-card red'} onClick={() => setPreset('broken')} title="Promised date passed, nothing received">
            <i>💔</i><b>{kpi.broken}</b><span>Broken promises</span>
          </button>
          <button className={preset === 'hot' ? 'kpi-card red active' : 'kpi-card red'} onClick={() => setPreset('hot')}>
            <i>🔴</i><b>{kpi.hot}</b><span>Urgent · {inrShort(kpi.old180)} very old</span>
          </button>
          <button className={preset === 'committed' ? 'kpi-card active' : 'kpi-card'} onClick={() => setPreset('committed')}>
            <i>🤝</i><b>{kpi.commit}</b><span>Committed / PDC</span>
          </button>
          <button className={preset === 'flw5' ? 'kpi-card active' : 'kpi-card'} onClick={() => setPreset('flw5')} title="Chased 5 or more times — needs escalation">
            <i>🔁</i><b>{kpi.flw5}</b><span>5+ follow-ups</span>
          </button>
        </div>

        {/* Pulse: date range me ERP receipts + follow-ups done (team productivity) */}
        {pulseOpen && (
          <div className="coll-pulse">
            <div className="pulse-head">
              <div><b>Collection pulse</b> <span className="muted small">— what happened in this date range</span></div>
              <div className="pulse-range">
                <label className="small muted">From <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></label>
                <label className="small muted">To <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></label>
                <button className="btn ghost sm" onClick={() => setRange(isoDay(), isoDay())}>Today</button>
                <button className="btn ghost sm" onClick={() => { const n = new Date(); setRange(isoDay(new Date(n.getFullYear(), n.getMonth(), 1)), isoDay()) }}>This month</button>
                <button className="btn ghost sm" onClick={() => setRange('', '')}>All</button>
              </div>
            </div>
            <div className="pulse-grid">
              <button className={preset === 'received' ? 'pulse-stat green active' : 'pulse-stat green'} onClick={() => setPreset(preset === 'received' ? 'all' : 'received')} title="Receipts in ERP (Payment.ashx) — click to see those parties">
                <b>{inrShort(pulse.erp)}</b><span>💵 Received (ERP) · {pulse.erpN} voucher{pulse.erpN === 1 ? '' : 's'} · {rangeTxt}</span>
                {pulse.logged > 0 && <span>claimed in notes: {inrShort(pulse.logged)}</span>}
              </button>
              <div className="pulse-stat"><b>{pulse.done}</b><span>📞 Follow-ups done · {rangeTxt}</span></div>
              <div className="pulse-stat wide">
                <span>👤 By user</span>
                <div className="pulse-users">
                  {Object.entries(pulse.byUser).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([u, n]) => <span key={u} className="user-tag">{u} <b>{n}</b></span>)}
                  {!pulse.done && <span className="muted small">no follow-ups in this range</span>}
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="coll-toolbar">
          <input className="search" placeholder="🔍 Search party / mobile / city…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={salesman} onChange={(e) => setSalesman(e.target.value)} title="Own parties + parties transferred to this salesman">
            <option value="">Salesman: All</option>
            {salesmen.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <ExtraFilters opts={opts} f={xf.f} set={xf.set} onDiffYes={() => cols.showCol('diff')} />
          {anyFilter && <button className="btn ghost sm" onClick={clearAll}>✕ Clear</button>}
          <span className="filter-count active">🔎 {filtered.length} / {kpi.parties}</span>
        </div>
        <div className="chip-rows">
          <div className="chip-row"><span className="preset-lbl">Follow-up</span>{STATUS_PRESETS.map(chip)}</div>
          <div className="chip-row"><span className="preset-lbl">Situation</span>{SITUATION_PRESETS.map((pr) => pr.key === 'excluded' && !kpi.excluded ? null : chip(pr))}</div>
        </div>
        {colPanel && <ColPanel mode={colPanel} cols={cols} allCols={COLS} presets={COL_PRESETS} count={filtered.length} onPrint={printNow} />}
      </div>

      {demo && rows.length > 0 && (
        <div className="panel demo-note"><p className="muted small">⚠️ This is SAMPLE data (demo mode). Login without <code>?demo</code> to see the real data.</p></div>
      )}
      {rows.length === 0 && (
        <div className="panel empty-state"><div className="es-ico">🕐</div><b>No collection data yet</b><p className="muted small">Wait for the next ERP sync (hourly at :20).</p></div>
      )}
      {rows.length > 0 && filtered.length === 0 && (
        <div className="panel empty-state"><div className="es-ico">🎉</div><b>Nothing here</b><p className="muted small">No party matches this filter. <button className="link" onClick={clearAll}>Clear filters</button></p></div>
      )}

      <NextUp e={nextUp} onOpen={setOpen} />

      {isMobile ? (
        <div className="card-list">
          {filtered.slice(0, 100).map((e) => <PartyCard key={e.p.party_name} e={e} onOpen={setOpen} actions={rowActions(e.p)} />)}
          {filtered.length > 100 && <p className="muted small" style={{ textAlign: 'center' }}>…and {filtered.length - 100} more — use search</p>}
        </div>
      ) : (
        <div className="panel coll-list">
          <div className="print-only small muted">Collection list · {filtered.length} parties · {inrShort(totals.total_pending)} pending · filter: {filterTxt || 'all'} · printed {new Date().toLocaleString('en-IN')}</div>
          <table className="cfg-tbl coll-tbl">
            <thead>
              <tr>
                <th>{sortBtn('priority', 'Priority', 'Most important on top — work in this order')}</th>
                <th>{sortBtn('party_name', 'Party')}</th>
                {visCols.map((c) => <th key={c.key} className={c.num ? 'num' : ''} title={c.title || ''}>{c.sort ? sortBtn(c.sort, c.label, c.title) : c.label}</th>)}
                <th className="no-print">Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 200).map((e) => {
                const { p, ag, pr } = e
                return (
                  <tr key={p.party_name} className={`coll-row pr-row ${pr.cls} ${open === p.party_name ? 'is-open' : ''}`} onClick={() => setOpen(p.party_name)}>
                    <td><span className={`pr-badge ${pr.cls}`} title={pr.hint}>{pr.label}</span></td>
                    <td><PartyCell p={p} ag={ag} /></td>
                    {visCols.map((c) => <td key={c.key} className={c.num ? 'num' : ''}>{cellOf(c, e)}</td>)}
                    <td className="coll-actions no-print" onClick={(ev) => ev.stopPropagation()}>{rowActions(p)}</td>
                  </tr>
                )
              })}
              {filtered.length > 200 && <tr><td colSpan={3 + visCols.length} className="muted small">…and {filtered.length - 200} more parties — use the search box above</td></tr>}
            </tbody>
            <TotalsRow visCols={visCols} totals={totals} count={filtered.length} lead={2} />
          </table>
        </div>
      )}

      {openE && (
        <div className="modal-back" onClick={() => setOpen(null)}>
          <div className="modal coll-modal" onClick={(ev) => ev.stopPropagation()}>
            <div className="modal-head">
              <div className="mh-left">
                <Avatar name={openE.p.party_name} size={40} />
                <div>
                  <h3>{openE.p.party_name} <span className={`pr-badge ${openE.pr.cls}`} title={openE.pr.hint}>{openE.pr.label}</span> <BucketPill b={openE.bucket} date={openE.p.next_followup_date} /></h3>
                  <p className="muted small coll-modal-sub">{[openE.p.salesman, openE.p.beat, openE.p.city, openE.p.mobile].filter(Boolean).join(' · ')}{openE.p.credit_days ? ` · credit ${openE.p.credit_days} days` : ''}</p>
                </div>
              </div>
              <button className="btn ghost" onClick={() => setOpen(null)}>✕ Close</button>
            </div>
            <PartyDetail key={openE.p.party_name} p={openE.p} ag={openE.ag} bucket={openE.bucket} demo={demo} salesmen={salesmen} onSaved={() => setTick((t) => t + 1)} onToast={setToast} />
          </div>
        </div>
      )}
      <Toast msg={toast} />
    </div>
  )
}
