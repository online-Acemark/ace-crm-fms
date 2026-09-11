import { useMemo, useState } from 'react'
import { computePipeline, computeScore, fmtDelay } from '../lib/fms'

export default function Scoreboard({ orders, stages, scoring }) {
  const [q, setQ] = useState('') // account scoreboard me party/family se search
  const { accounts, stageStats } = useMemo(() => {
    const accMap = new Map()
    const stStats = {}
    for (const s of stages.filter((x) => x.active)) stStats[s.stage_key] = { name: s.stage_name, ontime: 0, late: 0, open: 0, totDelay: 0 }
    for (const o of orders) {
      const pipe = computePipeline(o, stages, scoring)
      const score = computeScore(pipe, scoring)
      for (const k of Object.keys(pipe)) {
        const p = pipe[k]; const st = stStats[k]; if (!st) continue
        if (p.status === 'ontime' || p.status === 'done') st.ontime++
        else if (p.status === 'late') { st.late++; st.totDelay += p.delayH || 0 }
        else if (p.status === 'running') { st.open++; st.totDelay += p.delayH || 0 }
      }
      const a = accMap.get(o.account_name) || { name: o.account_name, family: o.acc_family, orders: 0, amount: 0, scores: [], delayed: 0, payDue: 0 }
      a.orders++
      a.amount += Number(o.sorder_amount) || 0
      if (score != null) a.scores.push(score)
      if (Object.values(pipe).some((p) => p.status === 'late' || p.status === 'running')) a.delayed++
      if (pipe.payment?.status === 'running' && !o.payment_complete) a.payDue++
      accMap.set(o.account_name, a)
    }
    const accounts = [...accMap.values()].map((a) => ({
      ...a, avg: a.scores.length ? Math.round(a.scores.reduce((x, y) => x + y, 0) / a.scores.length) : null,
    })).sort((x, y) => (y.avg ?? -1) - (x.avg ?? -1))
    return { accounts, stageStats: stStats }
  }, [orders, stages, scoring])

  const inr = (v) => '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })

  return (
    <div className="cols-page">
      <div className="panel">
        <h2>🔷 Stage-wise Performance (CRM Score)</h2>
        <table className="cfg-tbl">
          <thead><tr><th>Stage</th><th>✔ On Time</th><th>⚠ Late</th><th>⏳ Open/Overdue</th><th>On-time %</th><th>Avg Delay</th></tr></thead>
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
                  <td>{avgD ? fmtDelay(avgD) : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="panel">
        <h2>🏆 Account Scoreboard</h2>
        <div className="score-search">
          <input className="search" placeholder="🔍 Party name / family se dhundo…" value={q} onChange={(e) => setQ(e.target.value)} />
          {q && <>
            <button className="btn ghost sm" onClick={() => setQ('')}>✕ Clear</button>
            <span className="filter-count active">🔎 {accounts.filter((a) => `${a.name} ${a.family || ''}`.toLowerCase().includes(q.trim().toLowerCase())).length} / {accounts.length}</span>
          </>}
        </div>
        <table className="cfg-tbl">
          <thead><tr><th>#</th><th>Account</th><th>Family</th><th>Orders</th><th>Business</th><th>Delayed</th><th>Pay Due</th><th>Score</th></tr></thead>
          <tbody>
            {accounts.map((a, i) => ({ ...a, rank: i + 1 }))
              .filter((a) => !q.trim() || `${a.name} ${a.family || ''}`.toLowerCase().includes(q.trim().toLowerCase()))
              .map((a) => (
              <tr key={a.name}>
                <td>{a.rank}</td>
                <td><b>{a.name}</b></td>
                <td>{a.family || '—'}</td>
                <td>{a.orders}</td>
                <td>{inr(a.amount)}</td>
                <td className={a.delayed ? 'red-t' : ''}>{a.delayed}</td>
                <td className={a.payDue ? 'amber-t' : ''}>{a.payDue}</td>
                <td>{a.avg == null ? '—' : <span className={`score ${a.avg >= 90 ? 'sc-g' : a.avg >= 70 ? 'sc-y' : 'sc-r'}`}>{a.avg}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
