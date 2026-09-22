import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { SCORE_DEFAULTS } from '../lib/coll'

export default function StageConfig({ stages, scoring, onChanged }) {
  const [edit, setEdit] = useState({})
  const [sc, setSc] = useState(scoring || {})

  const saveStage = async (s) => {
    const e = edit[s.id] || {}
    await supabase.from('fms_stage_config').update({
      planned_hours: e.planned_hours ?? s.planned_hours,
      cutoff_time: e.cutoff_time ?? s.cutoff_time,
      weight: e.weight ?? s.weight,
      active: e.active ?? s.active,
    }).eq('id', s.id)
    setEdit((p) => ({ ...p, [s.id]: undefined }))
    onChanged?.()
  }

  const saveScoring = async () => {
    await supabase.from('fms_settings').upsert({ key: 'scoring', value: sc, updated_at: new Date().toISOString() })
    onChanged?.()
  }

  // Collection follow-up scoring (Scoreboard ka "Collection Follow-up Score") — fms_settings key 'coll_scoring'
  const [cs, setCs] = useState(SCORE_DEFAULTS)
  const [csMsg, setCsMsg] = useState('')
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('demo')) return
    supabase.from('fms_settings').select('value').eq('key', 'coll_scoring').maybeSingle()
      .then(({ data }) => { if (data?.value) setCs({ ...SCORE_DEFAULTS, ...data.value }) })
  }, [])
  const saveCollScoring = async () => {
    const v = { on_time_points: Number(cs.on_time_points) || 0, penalty_per_day: Number(cs.penalty_per_day) || 0, min_points: Number(cs.min_points) || 0 }
    if (v.on_time_points <= 0) { setCsMsg('❌ On-time points must be more than 0'); return }
    if (v.min_points > v.on_time_points) { setCsMsg('❌ Minimum points cannot exceed on-time points'); return }
    const { error } = await supabase.from('fms_settings').upsert({ key: 'coll_scoring', value: v, updated_at: new Date().toISOString() })
    setCsMsg(error ? '❌ ' + error.message : '✅ Saved — Scoreboard uses the new points from its next load')
    setTimeout(() => setCsMsg(''), 5000)
  }
  const daysToZero = cs.penalty_per_day > 0 ? Math.ceil((cs.on_time_points - cs.min_points) / cs.penalty_per_day) : null

  const val = (s, f) => edit[s.id]?.[f] ?? s[f] ?? ''
  const set = (s, f, v) => setEdit((p) => ({ ...p, [s.id]: { ...(p[s.id] || {}), [f]: v } }))

  return (
    <div className="cols-page">
      <div className="panel">
        <h2>⏱ Stage Plan (TAT)</h2>
        <p className="muted">Har stage ka planned time — isi se Pln date, Delay aur Score nikalta hai.</p>
        <table className="cfg-tbl">
          <thead><tr><th>Stage</th><th>Planned (hours)</th><th>4PM Cutoff</th><th>Score Weight</th><th>Active</th><th></th></tr></thead>
          <tbody>
            {stages.map((s) => (
              <tr key={s.id}>
                <td><b>{s.stage_name}</b></td>
                <td>{s.stage_key === 'payment'
                  ? <span className="muted small">Billing + Credit Days</span>
                  : s.use_cutoff
                    ? <span className="muted small">cutoff rule</span>
                    : <input type="number" step="0.5" value={val(s, 'planned_hours')} onChange={(e) => set(s, 'planned_hours', e.target.value === '' ? null : Number(e.target.value))} />}</td>
                <td>{s.use_cutoff ? <input type="time" value={val(s, 'cutoff_time')?.slice(0, 5) || '16:00'} onChange={(e) => set(s, 'cutoff_time', e.target.value)} /> : '—'}</td>
                <td><input type="number" step="0.5" value={val(s, 'weight')} onChange={(e) => set(s, 'weight', Number(e.target.value))} /></td>
                <td><input type="checkbox" checked={!!val(s, 'active')} onChange={(e) => set(s, 'active', e.target.checked)} /></td>
                <td><button className="btn primary sm" onClick={() => saveStage(s)} disabled={!edit[s.id]}>Save</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="panel">
        <h2>🏆 Scoring Rules</h2>
        <div className="score-form">
          <label>On-time points <input type="number" value={sc.on_time_points ?? 100} onChange={(e) => setSc({ ...sc, on_time_points: Number(e.target.value) })} /></label>
          <label>Grace (hours) <input type="number" step="0.5" value={sc.grace_hours ?? 1} onChange={(e) => setSc({ ...sc, grace_hours: Number(e.target.value) })} /></label>
          <label>Penalty / hour delay <input type="number" step="0.5" value={sc.penalty_per_hour ?? 2} onChange={(e) => setSc({ ...sc, penalty_per_hour: Number(e.target.value) })} /></label>
          <label>Minimum points <input type="number" value={sc.min_points ?? 0} onChange={(e) => setSc({ ...sc, min_points: Number(e.target.value) })} /></label>
          <button className="btn primary" onClick={saveScoring}>Save Scoring</button>
        </div>
        <p className="muted small">Score = weighted average of stage points. Stage on time → full points; har delay hour par penalty. Payment weight sabse zyada (default 3) — kyunki collection sabse important.</p>
      </div>
      <div className="panel">
        <h2>💰 Collection Follow-up Points</h2>
        <div className="score-form">
          <label>On-time points <input type="number" value={cs.on_time_points} onChange={(e) => setCs({ ...cs, on_time_points: Number(e.target.value) })} /></label>
          <label>Penalty / day late <input type="number" value={cs.penalty_per_day} onChange={(e) => setCs({ ...cs, penalty_per_day: Number(e.target.value) })} /></label>
          <label>Minimum points <input type="number" value={cs.min_points} onChange={(e) => setCs({ ...cs, min_points: Number(e.target.value) })} /></label>
          <button className="btn primary" onClick={saveCollScoring}>Save Follow-up Points</button>
          {csMsg && <span className="small"><b>{csMsg}</b></span>}
        </div>
        <p className="muted small">Follow-up on the planned day or earlier = {cs.on_time_points} points. Each day late −{cs.penalty_per_day}{daysToZero ? ` (reaches the minimum after ${daysToZero} days)` : ''}. Plan date passed with no call = missed = {cs.min_points}. Week = Monday–Saturday. Shown in Scoreboard → Collection Follow-up Score.</p>
      </div>
    </div>
  )
}
