import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { dmy, isoDay, fetchAll, FUP_COLS, SCORE_DEFAULTS, weekKey, weekLabel, scoreFollowups, summarize } from '../lib/coll'

// Collection follow-up scoring (Scoreboard me): har PLAN (next follow-up date) vs ACTUAL (agli entry ka din).
// Hafta = Monday–Saturday; score us hafte me jis hafte plan tha.
const STATUS = {
  ontime: ['On time', 'green-t'], early: ['Early', 'green-t'], late: ['Late', 'amber-t'], missed: ['Missed', 'red-t'], upcoming: ['Upcoming', 'muted'],
}
const ScorePill = ({ v }) => v == null ? <span className="muted">—</span>
  : <span className={`score ${v >= 80 ? 'sc-g' : v >= 50 ? 'sc-y' : 'sc-r'}`}>{v}%</span>

export default function CollectionScore() {
  const demo = new URLSearchParams(window.location.search).has('demo')
  const [fups, setFups] = useState([])
  const [cfg, setCfg] = useState(SCORE_DEFAULTS)
  const [week, setWeek] = useState(() => weekKey(new Date()))   // '' = all weeks
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    if (demo) return
    fetchAll('fms_followups', FUP_COLS, (x) => x.not('party_name', 'is', null).order('created_at', { ascending: false })).then(setFups)
    supabase.from('fms_settings').select('value').eq('key', 'coll_scoring').maybeSingle().then(({ data }) => { if (data?.value) setCfg({ ...SCORE_DEFAULTS, ...data.value }) })
  }, [demo])

  const items = useMemo(() => scoreFollowups(fups, cfg), [fups, cfg])
  // pichhle 8 hafte + jo bhi weeks data me hain
  const weeks = useMemo(() => {
    const s = new Set(items.map((i) => i.week))
    for (let n = 0; n < 8; n++) { const d = new Date(); d.setDate(d.getDate() - 7 * n); s.add(weekKey(d)) }
    return [...s].sort().reverse()
  }, [items])
  const inWeek = useMemo(() => (week ? items.filter((i) => i.week === week) : items), [items, week])
  const scored = useMemo(() => inWeek.filter((i) => i.status !== 'upcoming'), [inWeek])
  const total = useMemo(() => summarize(scored, cfg), [scored, cfg])
  const byUser = useMemo(() => {
    const m = new Map()
    for (const it of scored) { if (!m.has(it.who)) m.set(it.who, []); m.get(it.who).push(it) }
    return [...m.entries()].map(([who, list]) => ({ who, ...summarize(list, cfg) })).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.planned - a.planned)
  }, [scored, cfg])
  const trend = useMemo(() => weeks.slice(0, 8).map((w) => ({ w, ...summarize(items.filter((i) => i.week === w && i.status !== 'upcoming'), cfg) })), [weeks, items, cfg])
  const order = { missed: 0, late: 1, ontime: 2, early: 3, upcoming: 4 }
  const detail = useMemo(() => [...inWeek].sort((a, b) => (order[a.status] - order[b.status]) || b.days - a.days || a.plan.localeCompare(b.plan)), [inWeek]) // eslint-disable-line react-hooks/exhaustive-deps
  const thisWeek = weekKey(new Date())

  return (
    <div className="panel cs-panel">
      <div className="cs-head">
        <div>
          <h2>💰 Collection Follow-up Score</h2>
          <p className="muted small">Every follow-up sets a plan (next date). The next call on that party is the actual. Same day or earlier = <b>{cfg.on_time_points}</b> points; each day late −{cfg.penalty_per_day}; plan passed with no call = missed (0). Week = Monday–Saturday.</p>
        </div>
        <label className="small muted">Week
          <select value={week} onChange={(e) => setWeek(e.target.value)}>
            {weeks.map((w) => <option key={w} value={w}>{weekLabel(w)}{w === thisWeek ? ' (this week)' : ''}</option>)}
            <option value="">All weeks</option>
          </select>
        </label>
      </div>
      {demo && <p className="muted small">⚠️ Demo mode — no follow-up data.</p>}

      <div className="kpis">
        <div className="kpi"><b>{total.planned}</b><span>Planned follow-ups</span></div>
        <div className="kpi green"><b>{total.done}</b><span>On time{total.early ? ` (${total.early} early)` : ''}</span></div>
        <div className="kpi amber"><b>{total.late}</b><span>Late{total.late ? ` · avg ${total.avgLate} days` : ''}</span></div>
        <div className="kpi red"><b>{total.missed}</b><span>Missed (no call yet)</span></div>
        <div className="kpi"><b><ScorePill v={total.score} /></b><span>Week score</span></div>
        {week && <div className="kpi"><b>{inWeek.length - scored.length}</b><span>Upcoming (not scored)</span></div>}
      </div>

      <div className="cs-grid">
        <div>
          <h3 className="cs-sub">👤 By user {week ? `· ${weekLabel(week)}` : '· all weeks'}</h3>
          <table className="cfg-tbl cs-tbl">
            <thead><tr><th>User</th><th>Planned</th><th>On time</th><th>Late</th><th>Missed</th><th>Score</th></tr></thead>
            <tbody>
              {byUser.map((u) => (
                <tr key={u.who}>
                  <td><b>{u.who || '?'}</b></td><td>{u.planned}</td>
                  <td className="green-t">{u.done}</td>
                  <td className="amber-t">{u.late}{u.late ? <span className="muted small"> · {u.avgLate}d</span> : ''}</td>
                  <td className="red-t">{u.missed}</td>
                  <td><ScorePill v={u.score} /></td>
                </tr>
              ))}
              {!byUser.length && <tr><td colSpan={6} className="muted">No scored follow-ups in this week yet. Plans are scored once their date passes or the next call is logged.</td></tr>}
            </tbody>
          </table>
        </div>
        <div>
          <h3 className="cs-sub">📈 Weekly trend</h3>
          <table className="cfg-tbl cs-tbl">
            <thead><tr><th>Week (Mon–Sat)</th><th>Planned</th><th>On time</th><th>Late</th><th>Missed</th><th>Score</th></tr></thead>
            <tbody>
              {trend.map((t) => (
                <tr key={t.w} className={t.w === week ? 'cs-cur' : ''} onClick={() => setWeek(t.w)} style={{ cursor: 'pointer' }}>
                  <td>{weekLabel(t.w)}{t.w === thisWeek && <span className="muted small"> · this week</span>}</td>
                  <td>{t.planned}</td><td className="green-t">{t.done}</td><td className="amber-t">{t.late}</td><td className="red-t">{t.missed}</td><td><ScorePill v={t.score} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <h3 className="cs-sub">📋 Follow-up plans {week ? `· ${weekLabel(week)}` : ''} <span className="muted small" style={{ fontWeight: 400 }}>— missed and late first</span></h3>
      <table className="cfg-tbl cs-tbl">
        <thead><tr><th>Party</th><th>Planned</th><th>Actual</th><th>Status</th><th>Days</th><th>Points</th><th>Planned by</th><th>Done by</th><th>Outcome</th></tr></thead>
        <tbody>
          {(showAll ? detail : detail.slice(0, 40)).map((it) => {
            const [lbl, cls] = STATUS[it.status]
            return (
              <tr key={it.id}>
                <td><b>{it.party}</b></td>
                <td>{dmy(it.plan)}</td>
                <td>{it.actual ? dmy(it.actual) : <span className="muted">—</span>}</td>
                <td className={cls}><b>{lbl}</b></td>
                <td>{it.status === 'late' ? `+${it.days}` : it.status === 'early' ? it.days : it.status === 'missed' ? `${it.days} overdue` : it.status === 'ontime' ? '0' : `in ${Math.round((new Date(it.plan) - new Date(isoDay())) / 864e5)}`}</td>
                <td>{it.points == null ? <span className="muted">—</span> : it.points}</td>
                <td className="small">{it.planner}</td>
                <td className="small">{it.doer || <span className="muted">—</span>}</td>
                <td className="small">{it.stage || <span className="muted">—</span>}</td>
              </tr>
            )
          })}
          {!detail.length && <tr><td colSpan={9} className="muted">No follow-up plans in this week.</td></tr>}
        </tbody>
      </table>
      {detail.length > 40 && <button className="link small" onClick={() => setShowAll((v) => !v)}>{showAll ? 'Show less' : `Show all ${detail.length}`}</button>}
    </div>
  )
}
