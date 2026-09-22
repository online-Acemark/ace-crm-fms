// Collection / My Parties shared UI bits: aging chips, limit bar, stage/bucket pills, timeline, ERP receipts.
import { useState } from 'react'
import { BUCKETS, STAGE_CLS, BUCKET_LABEL, BUCKET_CLS, inr, inrShort, dmy, dmyt, userName } from '../lib/coll'

export function AgingChips({ aging }) {
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

export function LimitBar({ pending, limit }) {
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

export const StageChip = ({ s }) => s ? <span className={`stage-chip ${STAGE_CLS[s] || ''}`}>{s}</span> : null
export const BucketPill = ({ b, date }) => <span className={`bk-pill ${BUCKET_CLS[b]}`}>{BUCKET_LABEL[b]}{date && b !== 'nodate' && b !== 'closed' ? ' · ' + dmy(date) : ''}</span>

// ---------- follow-up timeline (party ki poori baat-cheet) ----------
export function Timeline({ entries, waCount }) {
  if (!entries.length && !waCount) return <p className="muted small">No conversation recorded with this party yet — you are the first to call.</p>
  return (
    <div className="tl">
      {waCount > 0 && <div className="muted small" style={{ marginBottom: 4 }}>📤 {waCount} WhatsApp reminder{waCount > 1 ? 's' : ''} sent (auto-logged)</div>}
      {entries.map((f) => (
        <div key={f.id} className="tl-item">
          <div className="tl-dot" />
          <div className="tl-body">
            <div className="tl-top">
              <b>{dmyt(f.created_at)}</b>
              <StageChip s={f.stage} />
              {Number(f.amount_received) > 0 && <span className="stage-chip st-recv">{inr(f.amount_received)} received{f.payment_mode ? ' · ' + f.payment_mode : ''}</span>}
              {f.committed_date && <span className="stage-chip st-commit">Promised {inr(f.committed_amount)} by {dmy(f.committed_date)}</span>}
              {f.transfer_to && <span className="stage-chip st-park">↪ to {f.transfer_to}{f.transfer_reason ? ' — ' + f.transfer_reason : ''}</span>}
              {f.created_by && <span className="muted small">— {userName(f.created_by)}</span>}
            </div>
            <div className="tl-says">{f.remarks || <span className="muted">(nothing written)</span>}</div>
            {Array.isArray(f.bill_nos) && f.bill_nos.length > 0 && <div className="tl-bills">Bills: {f.bill_nos.join(', ')}</div>}
          </div>
        </div>
      ))}
    </div>
  )
}

// ---------- ERP receipts (Payment.ashx) — kab, kaunse voucher se, kitna, kin bills par ----------
export function Receipts({ list }) {
  const [all, setAll] = useState(false)
  if (!list.length) return <p className="muted small">No receipt found in ERP for this party (Payment.ashx covers bills from Jan 2026).</p>
  const shown = all ? list : list.slice(0, 8)
  return (
    <div className="tbl-wrap-inner">
      <table className="cfg-tbl rcpt-tbl">
        <thead><tr><th>Date</th><th>Voucher</th><th>Type</th><th>Amount</th><th>Adjusted against</th></tr></thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.company_id + '|' + r.pay_vno}>
              <td>{dmy(r.pay_date)}</td>
              <td className="small"><b>{r.pay_vno}</b></td>
              <td className="small">{r.pay_type || '—'}</td>
              <td><b className="green-t">{inr(r.amount)}</b></td>
              <td className="small">{(r.bills || []).map((b, i) => <span key={i} className="bill-tag static" title={inr(b.amt)}>{b.vno}</span>)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.length > 8 && <button className="link small" onClick={() => setAll((v) => !v)}>{all ? 'Show less' : `Show all ${list.length} receipts`}</button>}
    </div>
  )
}

