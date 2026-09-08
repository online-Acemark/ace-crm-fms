import { useEffect, useState, useCallback } from 'react'
import { supabase } from './lib/supabase'
import { syncOrders, loadWorkingDays, loadStock } from './lib/fms'
import Grid from './components/Grid'
import ActionCenter from './components/ActionCenter'
import Scoreboard from './components/Scoreboard'
import StageConfig from './components/StageConfig'
import { getColumns } from './lib/columns'

function Login() {
  const [err, setErr] = useState('')
  const signIn = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    })
    if (error) setErr(error.message)
  }
  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-logo">📋</div>
        <h1>CRM FMS</h1>
        <p className="muted">Order → Delivery → Payment · Plan vs Actual · Scoring</p>
        <button className="btn-google" onClick={signIn}>
          <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C41 35.2 44 30 44 24c0-1.3-.1-2.6-.4-3.9z"/></svg>
          Sign in with Google
        </button>
        {err && <p className="err">{err}</p>}
      </div>
    </div>
  )
}

export default function App() {
  const [session, setSession] = useState(undefined)
  const [tab, setTab] = useState('action')
  const columns = getColumns()
  const [orders, setOrders] = useState([])
  const [stages, setStages] = useState([])
  const [scoring, setScoring] = useState(null)
  const [fupCounts, setFupCounts] = useState({})
  const [partyInfo, setPartyInfo] = useState({}) // account_name -> { salesman, beat }
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [theme, setTheme] = useState(() => localStorage.getItem('fms_theme') || 'light')

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('fms_theme', theme)
  }, [theme])

  const demo = new URLSearchParams(window.location.search).has('demo')

  useEffect(() => {
    if (demo) { setSession({ user: { email: 'demo@local', user_metadata: {} } }); return }
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  const loadAll = useCallback(async () => {
    await Promise.all([loadWorkingDays(), loadStock()]) // planned rules: working day calendar + stock availability
    if (demo) {
      const { aggregateSO } = await import('./lib/fms')
      const raw = await fetch('/demo-so.json').then((r) => r.json())
      setOrders(aggregateSO(raw).sort((a, b) => (b.mobile_so_created || '').localeCompare(a.mobile_so_created || '')))
      setStages([
        { id: 1, stage_key: 'so_convert', stage_name: 'Confirm Order (SO Convert)', sort_order: 1, planned_hours: 0.5, use_cutoff: false, weight: 2, active: true },
        { id: 2, stage_key: 'billing', stage_name: 'Billing / Invoice', sort_order: 2, planned_hours: 3, use_cutoff: false, weight: 2, active: true },
        { id: 3, stage_key: 'gpout', stage_name: 'Gate Pass Out', sort_order: 3, planned_hours: 2, use_cutoff: false, weight: 1, active: true },
        { id: 4, stage_key: 'dispatch', stage_name: 'Dispatch / Delivery', sort_order: 4, planned_hours: null, use_cutoff: true, cutoff_time: '16:00', weight: 2, active: true },
        { id: 5, stage_key: 'payment', stage_name: 'Payment Collection', sort_order: 5, planned_hours: null, use_cutoff: false, weight: 3, active: true },
      ])
      setScoring({ on_time_points: 100, grace_hours: 1, penalty_per_hour: 2, min_points: 0 })
      return
    }
    const [o, s, set, f, pi] = await Promise.all([
      supabase.from('fms_orders').select('*').order('mobile_so_created', { ascending: false }),
      supabase.from('fms_stage_config').select('*').order('sort_order'),
      supabase.from('fms_settings').select('*').eq('key', 'scoring').maybeSingle(),
      supabase.from('fms_followups').select('mobile_so_no,remarks,created_at').order('created_at', { ascending: true }),
      supabase.from('fms_party_info').select('*'),
    ])
    setOrders(o.data || [])
    setStages(s.data || [])
    setScoring(set.data?.value || {})
    const fc = {}
    for (const r of (f.data || [])) {
      const e = fc[r.mobile_so_no] || { count: 0, lastRemark: '' }
      e.count += 1
      if (r.remarks) e.lastRemark = r.remarks
      fc[r.mobile_so_no] = e
    }
    setFupCounts(fc)
    setPartyInfo(Object.fromEntries((pi.data || []).map((r) => [r.account_name, { salesman: r.salesman || '', beat: r.beat || '' }])))
  }, [])


  useEffect(() => { if (session) loadAll() }, [session, loadAll])

  const doSync = async () => {
    setBusy(true)
    try {
      const n = await syncOrders(stages, scoring, setMsg)
      setMsg(`✅ ${n} orders sync ho gaye`)
      await loadAll()
    } catch (e) { setMsg('❌ ' + e.message) }
    setBusy(false)
    setTimeout(() => setMsg(''), 6000)
  }

  if (session === undefined) return <div className="login-wrap"><div className="muted">Loading…</div></div>
  if (!session) return <Login />

  const user = session.user
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">📋 <b>CRM FMS</b> <span className="muted small">Acemark</span></div>
        <nav>
          {[['action', 'Aaj Ke Kaam'], ['fms', 'FMS Grid'], ['score', 'Scoreboard'], ['stages', 'Stage Plan']].map(([k, l]) => (
            <button key={k} className={tab === k ? 'tab active' : 'tab'} onClick={() => setTab(k)}>{l}</button>
          ))}
        </nav>
        <div className="top-right">
          <button className="btn ghost theme-btn" title={theme === 'light' ? 'Dark mode' : 'Light mode'}
            onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? '🌙' : '☀️'}</button>
          <button className="btn primary" onClick={doSync} disabled={busy}>{busy ? '⏳ Syncing…' : '🔄 Sync ERP'}</button>
          <span className="user" title={user.email}>{user.user_metadata?.avatar_url ? <img src={user.user_metadata.avatar_url} alt="" /> : user.email?.[0]?.toUpperCase()}</span>
          <button className="btn ghost" onClick={() => supabase.auth.signOut()}>Logout</button>
        </div>
      </header>
      {msg && <div className="toast">{msg}</div>}
      <main>
        {tab === 'action' && <ActionCenter orders={orders} stages={stages} scoring={scoring} onChanged={loadAll} />}
        {tab === 'fms' && <Grid orders={orders} stages={stages} columns={columns} scoring={scoring} fupCounts={fupCounts} partyInfo={partyInfo} onChanged={loadAll} />}
        {tab === 'score' && <Scoreboard orders={orders} stages={stages} scoring={scoring} />}
        {tab === 'stages' && <StageConfig stages={stages} scoring={scoring} onChanged={loadAll} />}
      </main>
    </div>
  )
}
