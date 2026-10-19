import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

// User Control (sirf admin): kaun user kaunse tab dekh sakta hai.
// Employee list master se aati hai (public.users — Checklist & Delegation admin, via fms_employee_list());
// access fms_users me save hota hai (login email + tabs), employee_id se employee se juda.
export const APP_TABS = [
  ['action', 'Today Work'],
  // ['fms', 'FMS Grid'],   // HIDDEN 19 Oct 2026 (owner ke kehne par) — delete ka tareeka: supabase/README.md "FMS Grid (hidden)"
  ['pendqty', 'Pending Order'],
  ['coll', 'Collection'],
  ['sales', 'My Parties'],
  ['score', 'Scoreboard'],
  ['stages', 'Stage Plan'],
]
const ALL_KEYS = APP_TABS.map(([k]) => k)
const ACTIVE = ['active', 'on_leave']

export default function UserControl({ myEmail, onChanged }) {
  const demo = new URLSearchParams(window.location.search).has('demo')
  const me = (myEmail || '').toLowerCase()
  const [rows, setRows] = useState(null)        // fms_users (access list)
  const [emps, setEmps] = useState([])          // employees from the master
  const [empErr, setEmpErr] = useState('')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [msg, setMsg] = useState('')
  const [q, setQ] = useState('')
  const [dept, setDept] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const [salesmen, setSalesmen] = useState([])   // ERP salesman names (fms_collection se) — My Parties mapping ke liye

  const load = () => supabase.from('fms_users').select('*').order('created_at').then(({ data }) => setRows(data || []))
  useEffect(() => {
    if (demo) {
      // demo mode me DB access nahi hai — sample employees + logins taaki screen samajh aaye
      fetch('/demo-users.json').then((r) => r.json()).then((d) => { setEmps(d.employees || []); setRows(d.logins || []) }).catch(() => setRows([]))
      return
    }
    load()
    supabase.rpc('fms_employee_list').then(({ data, error }) => {
      if (error) setEmpErr(error.message)
      else setEmps(data || [])
    })
    supabase.from('fms_collection').select('salesman').then(({ data }) => setSalesmen([...new Set((data || []).map((r) => r.salesman).filter(Boolean))].sort()))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(''), 5000) }
  const demoBlock = () => { if (demo) flash('❌ Demo mode cannot save — use the real login'); return demo }

  // employee ↔ access row: pehle employee_id se, warna same email se
  const { empRows, others, depts } = useMemo(() => {
    const list = rows || []
    const used = new Set()
    const empRows = emps.map((e) => {
      const acc = list.find((u) => u.employee_id === e.id) || (e.email && list.find((u) => !u.employee_id && u.email === e.email)) || null
      if (acc) used.add(acc.email)
      return { e, acc }
    })
    const others = list.filter((u) => !used.has(u.email))
    const depts = [...new Set(emps.map((e) => e.department).filter(Boolean))].sort()
    return { empRows, others, depts }
  }, [rows, emps])

  const shownEmps = useMemo(() => {
    const s = q.trim().toLowerCase()
    return empRows
      .filter(({ e }) => showInactive || ACTIVE.includes(e.status))
      .filter(({ e }) => !dept || e.department === dept)
      .filter(({ e, acc }) => !s || `${e.name || ''} ${e.email || ''} ${acc?.email || ''} ${e.designation || ''}`.toLowerCase().includes(s))
      .sort((a, b) => (!!b.acc - !!a.acc) || String(a.e.name || '').localeCompare(String(b.e.name || '')))
  }, [empRows, q, dept, showInactive])

  const setSalesman = async (u, sm) => {
    if (demoBlock()) return
    const { error } = await supabase.from('fms_users').update({ salesman: sm || null }).eq('email', u.email)
    if (error) { flash('❌ ' + error.message); return }
    flash(sm ? `✅ ${u.email} → My Parties shows ${sm === '*' ? 'all salesmen' : sm + "'s parties"}` : '✅ Mapping removed — auto-match by name will be used')
    load(); onChanged?.()
  }

  const addUser = async () => {
    const em = email.trim().toLowerCase()
    if (!/^\S+@\S+\.\S+$/.test(em)) { flash('❌ Enter a valid email address'); return }
    if (demo) { flash('❌ Demo mode cannot save — use the real login'); return }
    const { error } = await supabase.from('fms_users').insert({ email: em, full_name: name.trim() || null, tabs: ALL_KEYS, added_by: myEmail || '' })
    if (error) { flash('❌ ' + (error.code === '23505' ? 'This login is already in the list' : error.message)); return }
    setEmail(''); setName('')
    flash('✅ Login added — untick the tabs they should not see')
    load(); onChanged?.()
  }

  // employee ko access do: uske master email se login row banti hai
  const giveAccess = async (e) => {
    if (demo) { flash('❌ Demo mode cannot save — use the real login'); return }
    if (!e.email) { flash('❌ This employee has no email in the Checklist admin — add it there first'); return }
    const { error } = await supabase.from('fms_users').insert({ email: e.email, full_name: e.name, tabs: ALL_KEYS, employee_id: e.id, added_by: myEmail || '' })
    if (error) { flash('❌ ' + (error.code === '23505' ? 'This email already has access' : error.message)); return }
    flash(`✅ ${e.name} can now log in with ${e.email} — untick the tabs they should not see`)
    load(); onChanged?.()
  }

  // shared / alag email wala login kisi employee se jodo (ek banda do jagah na dikhe)
  const linkEmployee = async (u, empId) => {
    if (demoBlock()) return
    const { error } = await supabase.from('fms_users').update({ employee_id: empId ? Number(empId) : null }).eq('email', u.email)
    if (error) { flash('❌ ' + error.message); return }
    flash(empId ? `✅ ${u.email} linked to ${emps.find((x) => x.id === Number(empId))?.name}` : `✅ ${u.email} unlinked`)
    load()
  }

  const setTabs = async (u, key, on) => {
    if (demoBlock()) return
    const tabs = on ? [...new Set([...(u.tabs || []), key])] : (u.tabs || []).filter((t) => t !== key)
    if (!tabs.length) { flash('❌ At least one tab must stay ticked'); return }
    const { error } = await supabase.from('fms_users').update({ tabs }).eq('email', u.email)
    if (error) { flash('❌ ' + error.message); return }
    load(); onChanged?.()
  }

  const setAdmin = async (u, on) => {
    if (demoBlock()) return
    if (!on && u.email === me) { flash('❌ You cannot remove your own admin access'); return }
    const { error } = await supabase.from('fms_users').update({ is_admin: on }).eq('email', u.email)
    if (error) { flash('❌ ' + error.message); return }
    load(); onChanged?.()
  }

  const setHoldApprover = async (u, on) => {
    if (demoBlock()) return
    const { error } = await supabase.from('fms_users').update({ can_approve_hold: on }).eq('email', u.email)
    if (error) { flash('❌ ' + error.message); return }
    flash(on ? `✅ ${u.email} can now Approve / Reject hold orders` : `✅ ${u.email} is no longer a hold approver`)
    load(); onChanged?.()
  }

  const removeUser = async (u) => {
    if (demoBlock()) return
    if (u.email === me) { flash('❌ You cannot remove yourself'); return }
    if (!window.confirm(`Remove ${u.email} from the access list?\nThey will get default access (all tabs) again.`)) return
    const { error } = await supabase.from('fms_users').delete().eq('email', u.email)
    if (error) { flash('❌ ' + error.message); return }
    load(); onChanged?.()
  }

  if (rows === null) return <div className="action-page"><p className="muted">Loading users…</p></div>

  // access cells (tabs + salesman + admin + remove) — employee aur other login dono ke liye same
  const accessCells = (u) => (<>
    {APP_TABS.map(([k]) => (
      <td key={k} className="uc-chk">
        <input type="checkbox" checked={(u.tabs || []).includes(k)} onChange={(ev) => setTabs(u, k, ev.target.checked)} />
      </td>
    ))}
    <td>
      <select value={u.salesman || ''} onChange={(ev) => setSalesman(u, ev.target.value)} title="Blank = auto-match by name">
        <option value="">auto (by name)</option>
        <option value="*">★ All salesmen (CRM / office)</option>
        {salesmen.map((s) => <option key={s} value={s}>{s}</option>)}
        {u.salesman && u.salesman !== '*' && !salesmen.includes(u.salesman) && <option value={u.salesman}>{u.salesman}</option>}
      </select>
    </td>
    <td className="uc-chk"><input type="checkbox" checked={!!u.can_approve_hold} onChange={(ev) => setHoldApprover(u, ev.target.checked)} /></td>
    <td className="uc-chk"><input type="checkbox" checked={!!u.is_admin} onChange={(ev) => setAdmin(u, ev.target.checked)} /></td>
    <td><button className="btn ghost sm" title="Remove from list (back to default access)" onClick={() => removeUser(u)}>🗑</button></td>
  </>)
  const head = (first) => (
    <thead>
      <tr>
        <th>{first}</th>
        {APP_TABS.map(([k, l]) => <th key={k}>{l}</th>)}
        <th title="ERP salesman whose parties this login sees in My Parties. Blank = auto-match by Google name / email">Salesman (My Parties)</th>
        <th title="Can Approve / Reject hold orders in Today Work → Hold Approval">Hold approver</th>
        <th title="Admin sees this User Control tab and can change access">Admin</th>
        <th></th>
      </tr>
    </thead>
  )
  const withAccess = empRows.filter((r) => r.acc).length
  const activeCount = empRows.filter((r) => ACTIVE.includes(r.e.status)).length

  return (
    <div className="action-page">
      <div className="action-head">
        <h2>👥 User Control — Tab Access</h2>
        <p className="muted small">Employees come from the Checklist &amp; Delegation admin (one user list for all apps) — add or rename people there. Here you only choose who can open this app and which tabs they see. Logins not in this list see all tabs (but never this one). Changes apply when the user refreshes or logs in again.</p>
        {demo && <p className="err small">⚠️ Demo mode — SAMPLE employees and logins; changes will not save. Use the real login.</p>}
        {msg && <p className="small"><b>{msg}</b></p>}
      </div>

      <div className="panel">
        <div className="uc-head">
          <h3 className="uc-title">👤 Employees <span className="muted small">· {activeCount} active · {withAccess} with access set</span></h3>
          <div className="uc-filters">
            <input placeholder="🔍 Name / email / designation" value={q} onChange={(ev) => setQ(ev.target.value)} />
            <select value={dept} onChange={(ev) => setDept(ev.target.value)}>
              <option value="">All departments</option>
              {depts.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <label className="small muted"><input type="checkbox" checked={showInactive} onChange={(ev) => setShowInactive(ev.target.checked)} /> Show inactive</label>
          </div>
        </div>
        {empErr && <p className="err small">Employee list could not load: {empErr}</p>}
        <div className="tbl-wrap-inner">
          <table className="cfg-tbl uc-tbl">
            {head('Employee')}
            <tbody>
              {shownEmps.map(({ e, acc }) => (
                <tr key={e.id} className={ACTIVE.includes(e.status) ? '' : 'uc-inactive'}>
                  <td>
                    <b>{e.name || '—'}</b>{!ACTIVE.includes(e.status) && <span className="tag tag-stop">{e.status}</span>}
                    <div className="muted small">{[e.department, e.designation].filter(Boolean).join(' · ') || '—'}</div>
                    <div className="muted small">
                      {acc ? <>login: {acc.email}{acc.email === me && ' · you'}{e.email && acc.email !== e.email && <span title={`Email in Checklist admin: ${e.email}`}> ⚠ differs from master</span>}</>
                        : (e.email || <span className="amber-t">no email in master</span>)}
                    </div>
                  </td>
                  {acc ? accessCells(acc) : (
                    <td colSpan={APP_TABS.length + 4} className="muted small">
                      Default (all tabs if they log in) ·{' '}
                      <button className="btn ghost sm" disabled={!e.email} title={e.email ? `Create an access row for ${e.email}` : 'Add an email in the Checklist admin first'} onClick={() => giveAccess(e)}>➕ Give access</button>
                    </td>
                  )}
                </tr>
              ))}
              {!shownEmps.length && <tr><td colSpan={APP_TABS.length + 5} className="muted">{emps.length ? 'No employee matches this filter.' : 'No employees loaded.'}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h3 className="uc-title">🔑 Other logins <span className="muted small">· shared / location logins, or a login whose email differs from the employee master</span></h3>
        <div className="tbl-wrap-inner">
          <table className="cfg-tbl uc-tbl">
            {head('Login')}
            <tbody>
              {others.map((u) => (
                <tr key={u.email}>
                  <td>
                    <b>{u.full_name || u.email.split('@')[0]}</b>
                    <div className="muted small">{u.email}{u.email === me && ' · you'}</div>
                    <select className="uc-link" value={u.employee_id || ''} onChange={(ev) => linkEmployee(u, ev.target.value)} title="If this login belongs to an employee, link it so they show once">
                      <option value="">— not an employee —</option>
                      {emps.filter((x) => ACTIVE.includes(x.status)).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                    </select>
                  </td>
                  {accessCells(u)}
                </tr>
              ))}
              {!others.length && <tr><td colSpan={APP_TABS.length + 5} className="muted">No other logins.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="uc-add">
          <input placeholder="Other Google login (e.g. dispatch.branch@gmail.com)" value={email} onChange={(ev) => setEmail(ev.target.value)} onKeyDown={(ev) => ev.key === 'Enter' && addUser()} />
          <input placeholder="Name (optional)" value={name} onChange={(ev) => setName(ev.target.value)} onKeyDown={(ev) => ev.key === 'Enter' && addUser()} />
          <button className="btn primary" onClick={addUser}>Add login</button>
        </div>
        <p className="muted small uc-note">Note: this controls which tabs are visible in the app. All logged-in users still share the same database access level — role-based data security can be added later if needed.</p>
      </div>
    </div>
  )
}
