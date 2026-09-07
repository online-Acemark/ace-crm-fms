import { useState } from 'react'
import { supabase } from '../lib/supabase'

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
    </div>
  )
}
