import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

// User Control (sirf admin): kaun user kaunse tab dekh sakta hai
export const APP_TABS = [
  ['action', 'Today Work'],
  ['fms', 'FMS Grid'],
  ['coll', 'Collection'],
  ['score', 'Scoreboard'],
  ['stages', 'Stage Plan'],
]
const ALL_KEYS = APP_TABS.map(([k]) => k)

export default function UserControl({ myEmail, onChanged }) {
  const demo = new URLSearchParams(window.location.search).has('demo')
  const [rows, setRows] = useState(null)
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [msg, setMsg] = useState('')

  const load = () => supabase.from('fms_users').select('*').order('created_at').then(({ data }) => setRows(data || []))
  useEffect(() => { load() }, [])

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 5000) }

  const addUser = async () => {
    const em = email.trim().toLowerCase()
    if (!/^\S+@\S+\.\S+$/.test(em)) { flash('❌ Enter a valid email address'); return }
    if (demo) { flash('❌ Demo mode cannot save — use the real login'); return }
    const { error } = await supabase.from('fms_users').insert({ email: em, full_name: name.trim() || null, tabs: ALL_KEYS, added_by: myEmail || '' })
    if (error) { flash('❌ ' + (error.code === '23505' ? 'This user is already in the list' : error.message)); return }
    setEmail(''); setName('')
    flash('✅ User added — untick the tabs they should not see')
    load(); onChanged?.()
  }

  const setTabs = async (u, key, on) => {
    const tabs = on ? [...new Set([...(u.tabs || []), key])] : (u.tabs || []).filter((t) => t !== key)
    if (!tabs.length) { flash('❌ At least one tab must stay ticked'); return }
    const { error } = await supabase.from('fms_users').update({ tabs }).eq('email', u.email)
    if (error) { flash('❌ ' + error.message); return }
    load(); onChanged?.()
  }

  const setAdmin = async (u, on) => {
    if (!on && u.email === (myEmail || '').toLowerCase()) { flash('❌ You cannot remove your own admin access'); return }
    const { error } = await supabase.from('fms_users').update({ is_admin: on }).eq('email', u.email)
    if (error) { flash('❌ ' + error.message); return }
    load(); onChanged?.()
  }

  const removeUser = async (u) => {
    if (u.email === (myEmail || '').toLowerCase()) { flash('❌ You cannot remove yourself'); return }
    if (!window.confirm(`Remove ${u.email} from the access list?\nThey will get default access (all tabs) again.`)) return
    const { error } = await supabase.from('fms_users').delete().eq('email', u.email)
    if (error) { flash('❌ ' + error.message); return }
    load(); onChanged?.()
  }

  if (rows === null) return <div className="action-page"><p className="muted">Loading users…</p></div>

  return (
    <div className="action-page">
      <div className="action-head">
        <h2>👥 User Control — Tab Access</h2>
        <p className="muted small">Tick the tabs each user can see. Users not in this list see all tabs (but never this one). Changes apply when the user refreshes or logs in again.</p>
        {demo && <p className="err small">⚠️ Demo mode — changes will not save. Use the real login.</p>}
      </div>

      <div className="panel">
        <h3 className="uc-title">➕ Add user</h3>
        <div className="uc-add">
          <input placeholder="Google email (e.g. name@acemark.in)" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addUser()} />
          <input placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addUser()} />
          <button className="btn primary" onClick={addUser}>Add</button>
        </div>
        {msg && <p className="small"><b>{msg}</b></p>}
      </div>

      <div className="panel">
        <table className="cfg-tbl uc-tbl">
          <thead>
            <tr>
              <th>User</th>
              {APP_TABS.map(([k, l]) => <th key={k}>{l}</th>)}
              <th title="Admin sees this User Control tab and can change access">Admin</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.email}>
                <td><b>{u.full_name || u.email.split('@')[0]}</b><div className="muted small">{u.email}{u.email === (myEmail || '').toLowerCase() && ' · you'}</div></td>
                {APP_TABS.map(([k]) => (
                  <td key={k} className="uc-chk">
                    <input type="checkbox" checked={(u.tabs || []).includes(k)} onChange={(e) => setTabs(u, k, e.target.checked)} />
                  </td>
                ))}
                <td className="uc-chk"><input type="checkbox" checked={!!u.is_admin} onChange={(e) => setAdmin(u, e.target.checked)} /></td>
                <td><button className="btn ghost sm" title="Remove from list (back to default access)" onClick={() => removeUser(u)}>🗑</button></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={APP_TABS.length + 3} className="muted">No users yet — add one above.</td></tr>}
          </tbody>
        </table>
        <p className="muted small uc-note">Note: this controls which tabs are visible in the app. All logged-in users still share the same database access level — role-based data security can be added later if needed.</p>
      </div>
    </div>
  )
}
