// Collection / My Parties shared UI bits: aging chips, limit bar, stage/bucket pills, timeline, ERP receipts.
import { useState } from 'react'
import { BUCKETS, STAGE_CLS, BUCKET_LABEL, BUCKET_CLS, inr, inrShort, dmy, dmyt, userName, avaColor, initials } from '../lib/coll'

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


// ---------- next-level UI bits: avatar, party cell, stat strip, tabs, chips, toast, mobile cards ----------
export const Avatar = ({ name, size = 30 }) => <span className="ava" style={{ background: avaColor(name), width: size, height: size, fontSize: Math.round(size * 0.38) }}>{initials(name)}</span>

// Party cell: avatar + naam + meta (salesman · city · mobile) + tags (PDC, transfer)
export function PartyCell({ p, ag, showSalesman = true, me = '' }) {
  const meta = [showSalesman ? p.salesman : null, p.city].filter(Boolean).join(' · ')
  return (
    <div className="pcell">
      <Avatar name={p.party_name} />
      <div className="pcell-b">
        <div className="pcell-n">{p.party_name}</div>
        <div className="pcell-m">
          {meta}{meta && p.mobile ? ' · ' : ''}{p.mobile && <a href={`tel:${p.mobile}`} onClick={(e) => e.stopPropagation()}>{p.mobile}</a>}
          {p.has_pdc && <span className="tag tag-pdc">🧾 PDC</span>}
          {ag?.transferTo && <span className="tag tag-xfer" title={'Transferred: ' + (ag.transferReason || '')}>↪ {me && ag.transferTo === me ? 'to you' : ag.transferTo}</span>}
        </div>
      </div>
    </div>
  )
}

// Compact stat strip (modal header ke neeche): [{ l, v, s, cls, hint }]
export const StatStrip = ({ items }) => (
  <div className="stat-strip">
    {items.map((i, k) => (
      <div key={k} className={`stat ${i.cls || ''}`} title={i.hint || ''}>
        <span className="stat-l">{i.l}</span>
        <b className="stat-v">{i.v}</b>
        {i.s ? <span className="stat-s">{i.s}</span> : null}
      </div>
    ))}
  </div>
)

export const Tabs = ({ tabs, active, onChange }) => (
  <div className="tabs" role="tablist">
    {tabs.map((t) => (
      <button key={t.key} role="tab" className={active === t.key ? 'tabbtn on' : 'tabbtn'} onClick={() => onChange(t.key)}>
        {t.label}{t.n != null && <span className="tab-n">{t.n}</span>}
      </button>
    ))}
  </div>
)

// Filter chip with count badge; 0 count = dim
export const Chip = ({ label, n, active, onClick, tone = '' }) => (
  <button className={`chip ${tone} ${active ? 'on' : ''} ${n === 0 ? 'dim' : ''}`} onClick={onClick}>
    {label}{n != null && <b className="chip-n">{n}</b>}
  </button>
)

export const Toast = ({ msg }) => msg ? <div className="coll-toast" role="status">{msg}</div> : null


// "Start here" banner: sabse zaroori party
export function NextUp({ e, onOpen }) {
  if (!e) return null
  const { p, pr } = e
  return (
    <div className={`nextup ${pr.cls}`}>
      <Avatar name={p.party_name} size={36} />
      <div className="nextup-b">
        <div className="nextup-t">Start here: <b>{p.party_name}</b> <span className={`pr-badge ${pr.cls}`}>{pr.label}</span></div>
        <div className="muted small">{pr.hint} · pending <b>{inrShort(p.total_pending)}</b>{p.oldest_od ? ` · oldest ${p.oldest_od} days` : ''}{p.mobile ? ` · ${p.mobile}` : ''}</div>
      </div>
      <button className="btn primary sm" onClick={() => onOpen(p.party_name)}>Open →</button>
    </div>
  )
}

export const Skeleton = ({ rows = 6 }) => (
  <div className="skel-wrap">{Array.from({ length: rows }).map((_, i) => <div key={i} className="skel" style={{ width: `${70 + ((i * 13) % 30)}%` }} />)}</div>
)

// Mobile card (phone par table ki jagah)
export function PartyCard({ e, me, showSalesman, onOpen, actions }) {
  const { p, ag, pr, bucket, broken } = e
  return (
    <div className={`pcard ${pr.cls}`} onClick={() => onOpen(p.party_name)}>
      <div className="pcard-top">
        <span className={`pr-badge ${pr.cls}`} title={pr.hint}>{pr.label}</span>
        <BucketPill b={bucket} date={p.next_followup_date} />
      </div>
      <PartyCell p={p} ag={ag} showSalesman={showSalesman} me={me} />
      <div className="pcard-nums">
        <div><span className="muted small">Pending</span><b>{inrShort(p.total_pending)}</b><span className="muted small">{p.bill_count} bills</span></div>
        <div><span className="muted small">Oldest</span><b className={p.oldest_od > 90 ? 'red-t' : p.oldest_od > 30 ? 'amber-t' : ''}>{p.oldest_od ? p.oldest_od + 'd' : '—'}</b></div>
        <div><span className="muted small">Promise</span>{ag.committed ? <b className={broken ? 'red-t' : ''}>{inrShort(ag.committed.amount)}<span className="muted small"> {broken ? '💔' : 'by'} {dmy(ag.committed.date)}</span></b> : <b className="muted">—</b>}</div>
      </div>
      <AgingChips aging={p.aging} />
      {(ag.lastStage || ag.last) && <div className="pcard-last">{ag.lastStage && <StageChip s={ag.lastStage} />}{ag.last && <span className="muted small">{dmy(ag.last.created_at)} · {userName(ag.last.created_by)}{ag.last.remarks ? ' — ' + ag.last.remarks : ''}</span>}</div>}
      <div className="pcard-act" onClick={(ev) => ev.stopPropagation()}>{actions}</div>
    </div>
  )
}
