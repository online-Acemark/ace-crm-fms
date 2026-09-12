import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { computePipeline, computeScore, fmtDelay, isPaid } from '../lib/fms'

export default function Scoreboard({ orders, stages, scoring }) {
  const [q, setQ] = useState('') // account scoreboard me party/family se search
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

  const { accounts, stageStats, salesmen } = useMemo(() => {
    const accMap = new Map()
    const smMap = new Map()
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
      const a = accMap.get(o.account_name) || { name: o.account_name, family: o.acc_family, orders: 0, amount: 0, scores: [], delayed: 0, payDue: 0 }
      a.orders++
      a.amount += Number(o.sorder_amount) || 0
      if (score != null) a.scores.push(score)
      if (isDelayed) a.delayed++
      if (payRunning) a.payDue++
      accMap.set(o.account_name, a)
      // salesman-wise
      const smKey = o.salesman || '—'
      const sm = smMap.get(smKey) || { name: smKey, orders: 0, business: 0, scores: [], delayed: 0, overdueAmt: 0 }
      sm.orders++
      sm.business += Number(o.sorder_amount) || 0
      if (score != null) sm.scores.push(score)
      if (isDelayed) sm.delayed++
      if (payRunning) sm.overdueAmt += o.payment_pending_erp != null ? Number(o.payment_pending_erp) : (Number(o.bill_net_amount) || 0)
      smMap.set(smKey, sm)
    }
    const avgOf = (arr) => arr.length ? Math.round(arr.reduce((x, y) => x + y, 0) / arr.length) : null
    const accounts = [...accMap.values()].map((a) => ({ ...a, avg: avgOf(a.scores) })).sort((x, y) => (y.avg ?? -1) - (x.avg ?? -1))
    const salesmen = [...smMap.values()].map((s) => ({ ...s, avg: avgOf(s.scores) })).sort((x, y) => (y.avg ?? -1) - (x.avg ?? -1))
    return { accounts, stageStats: stStats, salesmen }
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
        <h2>👤 Salesman Scoreboard</h2>
        <table className="cfg-tbl">
          <thead><tr><th>#</th><th>Salesman</th><th>Orders</th><th>Business</th><th>Delayed</th><th>Overdue ₹</th><th>Score</th><th>7-din Trend</th></tr></thead>
          <tbody>
            {salesmen.map((s, i) => (
              <tr key={s.name}>
                <td>{i + 1}</td>
                <td><b>{s.name}</b></td>
                <td>{s.orders}</td>
                <td>{inr(s.business)}</td>
                <td className={s.delayed ? 'red-t' : ''}>{s.delayed}</td>
                <td className={s.overdueAmt ? 'amber-t' : ''}>{s.overdueAmt ? inr(s.overdueAmt) : '—'}</td>
                <td>{s.avg == null ? '—' : <span className={`score ${s.avg >= 90 ? 'sc-g' : s.avg >= 70 ? 'sc-y' : 'sc-r'}`}>{s.avg}</span>}</td>
                <td><TrendArrow now={s.avg} prev={trendRef?.salesmen?.[s.name]?.avg ?? null} /></td>
              </tr>
            ))}
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
