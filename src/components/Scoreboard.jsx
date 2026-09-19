import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { computePipeline, computeScore, fmtDelay, isPaid } from '../lib/fms'

export default function Scoreboard({ orders, stages, scoring }) {
  const [hist, setHist] = useState([]) // fms_score_daily: pichhle 30 din ke snapshots (trend ke liye)

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('demo')) return
    const from = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10)
    supabase.from('fms_score_daily').select('day,stages,salesmen,totals').gte('day', from).order('day')
      .then(({ data }) => setHist(data || []))
  }, [])

  // trend: aaj ki value vs ~7 din pehle ke snapshot ki value
  const trendRef = useMemo(() => {
    if (hist.length < 2) return null
    const today = new Date().toISOString().slice(0, 10)
    const past = hist.filter((h) => h.day < today)
    if (!past.length) return null
    const target = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)
    return past.reduce((best, h) => (Math.abs(new Date(h.day) - new Date(target)) < Math.abs(new Date(best.day) - new Date(target)) ? h : best))
  }, [hist])

  const TrendArrow = ({ now, prev }) => {
    if (now == null || prev == null) return <span className="muted small">—</span>
    const diff = now - prev
    if (diff >= 2) return <span className="green-t small" title={`Pichhle snapshot (${trendRef?.day}) me ${prev} tha`}>▲ +{diff}</span>
    if (diff <= -2) return <span className="red-t small" title={`Pichhle snapshot (${trendRef?.day}) me ${prev} tha`}>▼ {diff}</span>
    return <span className="muted small" title={`Pichhle snapshot me ${prev}`}>▬</span>
  }

  const { stageStats, families } = useMemo(() => {
    const famMap = new Map()
    const stStats = {}
    for (const s of stages.filter((x) => x.active)) stStats[s.stage_key] = { name: s.stage_name, ontime: 0, late: 0, open: 0, totDelay: 0 }
    for (const o of orders) {
      const pipe = computePipeline(o, stages, scoring)
      const score = computeScore(pipe, scoring)
      const isDelayed = Object.values(pipe).some((p) => p.status === 'late' || p.status === 'running')
      const payRunning = pipe.payment?.status === 'running' && !isPaid(o)
      for (const k of Object.keys(pipe)) {
        const p = pipe[k]; const st = stStats[k]; if (!st) continue
        if (p.status === 'ontime' || p.status === 'done') st.ontime++
        else if (p.status === 'late') { st.late++; st.totDelay += p.delayH || 0 }
        else if (p.status === 'running') { st.open++; st.totDelay += p.delayH || 0 }
      }
      // family-wise scoring (G = Golden, N = No follow-up, ...)
      const famKey = String(o.acc_family || '').trim().toUpperCase() || '—'
      const fm = famMap.get(famKey) || { family: famKey, accounts: new Set(), orders: 0, business: 0, scores: [], delayed: 0, payDue: 0 }
      fm.accounts.add(o.account_name)
      fm.orders++
      fm.business += Number(o.sorder_amount) || 0
      if (score != null) fm.scores.push(score)
      if (isDelayed) fm.delayed++
      if (payRunning) fm.payDue++
      famMap.set(famKey, fm)
    }
    const avgOf = (arr) => arr.length ? Math.round(arr.reduce((x, y) => x + y, 0) / arr.length) : null
    const families = [...famMap.values()].map((f) => ({ ...f, accCount: f.accounts.size, avg: avgOf(f.scores) })).sort((x, y) => (y.avg ?? -1) - (x.avg ?? -1))
    return { stageStats: stStats, families }
  }, [orders, stages, scoring])

  const inr = (v) => '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })

  return (
    <div className="cols-page">
      <div className="panel">
        <h2>🔷 Stage-wise Performance (CRM Score)</h2>
        <table className="cfg-tbl">
          <thead><tr><th>Stage</th><th>✔ On Time</th><th>⚠ Late</th><th>⏳ Open/Overdue</th><th>On-time %</th><th>7-din Trend</th><th>Avg Delay</th></tr></thead>
          <tbody>
            {Object.entries(stageStats).map(([k, s]) => {
              const done = s.ontime + s.late
              const pct = done + s.open ? Math.round((s.ontime / (done + s.open)) * 100) : null
              const avgD = (s.late + s.open) ? s.totDelay / (s.late + s.open) : 0
              return (
                <tr key={k}>
                  <td><b>{s.name}</b></td>
                  <td className="green-t">{s.ontime}</td>
                  <td className="red-t">{s.late}</td>
                  <td className="amber-t">{s.open}</td>
                  <td>{pct == null ? '—' : <span className={pct >= 80 ? 'green-t' : pct >= 50 ? 'amber-t' : 'red-t'}><b>{pct}%</b></span>}</td>
                  <td><TrendArrow now={pct} prev={trendRef?.stages?.[k]?.pct ?? null} /></td>
                  <td>{avgD ? fmtDelay(avgD) : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {trendRef && <p className="muted small" style={{ marginTop: 8 }}>Trend {trendRef.day} ke snapshot se compare — roz raat ka score history apne aap save hota hai.</p>}
      </div>
      <div className="panel">
        <h2>⭐ Family-wise Scoring</h2>
        <p className="muted small">Account family ke hisaab se performance — G (Golden) sabse important hai.</p>
        <table className="cfg-tbl">
          <thead><tr><th>Family</th><th>Accounts</th><th>Orders</th><th>Business</th><th>Delayed</th><th>Pay Due</th><th>Avg Score</th></tr></thead>
          <tbody>
            {families.map((f) => (
              <tr key={f.family}>
                <td>{f.family === 'G'
                  ? <span className="fam-badge fam-g" title="Golden customer — first priority">⭐ G</span>
                  : <span className="fam-badge">{f.family}</span>}</td>
                <td>{f.accCount}</td>
                <td>{f.orders}</td>
                <td>{inr(f.business)}</td>
                <td className={f.delayed ? 'red-t' : ''}>{f.delayed}</td>
                <td className={f.payDue ? 'amber-t' : ''}>{f.payDue}</td>
                <td>{f.avg == null ? '—' : <span className={`score ${f.avg >= 90 ? 'sc-g' : f.avg >= 70 ? 'sc-y' : 'sc-r'}`}>{f.avg}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
