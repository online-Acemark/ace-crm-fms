import { useEffect, useMemo, useState } from 'react'
import { fetchERP } from '../lib/fms'
import MultiSelect from './MultiSelect'

// Pending Qty tab: ERP PendingQuantity.ashx — order-wise kaunsa item kitna pending hai
const num = (v) => Number(v) || 0
const inr = (v) => '₹' + Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })
// ERP Date '17-09' (dd-mm, saal nahi deta) -> '17 Sep 26'; future nikle to pichhla saal
const fmtDate = (v) => {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(String(v || '').trim())
  if (!m) return String(v || '—')
  const dd = +m[1], mm = +m[2]
  const now = new Date()
  let y = now.getFullYear()
  if (new Date(y, mm - 1, dd).getTime() > now.getTime() + 864e5) y -= 1
  return new Date(y, mm - 1, dd).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })
}

// table columns — picker se hide/show; "Save as default" localStorage me yaad rakhta hai
const PQ_COLS = [
  { key: 'Number', label: 'Order No', sort: 'Number' },
  { key: 'Date', label: 'Date' },
  { key: 'PartyName', label: 'Party', sort: 'PartyName' },
  { key: 'ProductName', label: 'Product', sort: 'ProductName' },
  { key: 'ProdBrand', label: 'Brand' },
  { key: 'BaseCat', label: 'Category' },
  { key: 'Godown', label: 'Godown' },
  { key: 'QTY', label: 'Order Qty', sort: 'QTY', num: true },
  { key: 'Balance', label: 'Pending', sort: 'Balance', num: true },
  { key: 'NetStock', label: 'Stock', sort: 'NetStock', num: true, title: 'Current stock of this product' },
  { key: 'Late', label: 'Late', sort: 'Late', title: 'Days late' },
  { key: 'SumOfAmt', label: 'Value', sort: 'SumOfAmt', num: true },
]
const PQ_COLS_LS = 'fms_pq_cols'
const loadPqCols = () => { try { const v = JSON.parse(localStorage.getItem(PQ_COLS_LS) || 'null'); if (Array.isArray(v) && v.length) return v } catch { /* ignore */ } return PQ_COLS.map((c) => c.key) }
// Sort presets: party-wise = party A-Z, phir product A-Z; item-wise = product A-Z, phir party A-Z
const SORT_PRESETS = [
  { key: 'late', label: 'Most late first', sort: ['Late', 'desc'] },
  { key: 'party', label: 'Party-wise (A–Z, then product)', sort: ['PartyName', 'asc'] },
  { key: 'item', label: 'Item-wise (A–Z, then party)', sort: ['ProductName', 'asc'] },
  { key: 'value', label: 'Highest value first', sort: ['SumOfAmt', 'desc'] },
  { key: 'pending', label: 'Most pending qty first', sort: ['Balance', 'desc'] },
]
const TEXT_KEYS = ['PartyName', 'ProductName', 'Number', 'ProdBrand', 'BaseCat', 'Godown']

export default function PendingQty() {
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [godowns, setGodowns] = useState([]) // multi-select: khali = sab
  const [division, setDivision] = useState('')
  const [cats, setCats] = useState([]) // category multi-select — khali = sab
  const [brand, setBrand] = useState('')
  const [onlyLate, setOnlyLate] = useState(false)
  const [onlyStock, setOnlyStock] = useState(false)
  const [sort, setSort] = useState(['Late', 'desc'])
  const [visKeys, setVisKeys] = useState(loadPqCols)     // dikhne wale columns (saved default se shuru)
  const [colPanel, setColPanel] = useState(false)
  const [colMsg, setColMsg] = useState('')

  const load = () => {
    setErr('')
    fetchERP('pendqty')
      .then((j) => setRows(Array.isArray(j) ? j : j?.DataRec || []))
      .catch((e) => { setErr(String(e.message || e)); setRows([]) })
  }
  useEffect(() => { load() }, [])

  const opts = useMemo(() => {
    const list = rows || []
    const uniq = (f) => [...new Set(list.map((r) => String(r[f] || '').trim()).filter(Boolean))].sort()
    return { godown: uniq('Godown'), division: uniq('ProdDivision'), cat: uniq('BaseCat'), brand: uniq('ProdBrand') }
  }, [rows])

  const filtered = useMemo(() => {
    let list = rows || []
    const s = q.trim().toLowerCase()
    if (s) list = list.filter((r) => `${r.PartyName} ${r.ProductName} ${r.ProductCode} ${r.Number}`.toLowerCase().includes(s))
    if (godowns.length) list = list.filter((r) => godowns.includes(String(r.Godown || '').trim()))
    if (division) list = list.filter((r) => String(r.ProdDivision || '').trim() === division)
    if (cats.length) list = list.filter((r) => cats.includes(String(r.BaseCat || '').trim()))
    if (brand) list = list.filter((r) => String(r.ProdBrand || '').trim() === brand)
    if (onlyLate) list = list.filter((r) => num(r.Late) > 0)
    if (onlyStock) list = list.filter((r) => num(r.NetStock) >= num(r.Balance) && num(r.Balance) > 0)
    const [k, dir] = sort
    const mul = dir === 'desc' ? -1 : 1
    const val = (r, key) => TEXT_KEYS.includes(key) ? String(r[key] || '').trim().toLowerCase() : num(r[key])
    const cmp = (a, b, key) => { const av = val(a, key), bv = val(b, key); return av < bv ? -1 : av > bv ? 1 : 0 }
    // tie-breaker: party-wise me same party ke andar product A-Z; item-wise me same product ke andar party A-Z; baaki me party A-Z
    const tie = k === 'PartyName' ? 'ProductName' : 'PartyName'
    return [...list].sort((a, b) => cmp(a, b, k) * mul || cmp(a, b, tie) || cmp(a, b, 'Number'))
  }, [rows, q, godowns, division, cats, brand, onlyLate, onlyStock, sort])

  const visCols = PQ_COLS.filter((c) => visKeys.includes(c.key))
  const toggleCol = (k) => setVisKeys((v) => (v.includes(k) ? (v.length > 1 ? v.filter((x) => x !== k) : v) : PQ_COLS.map((c) => c.key).filter((x) => x === k || v.includes(x))))
  const saveCols = () => { try { localStorage.setItem(PQ_COLS_LS, JSON.stringify(visKeys)) } catch { /* ignore */ } setColMsg('✅ Saved — these columns will show by default from now on'); setTimeout(() => setColMsg(''), 4000) }
  const resetCols = () => { try { localStorage.removeItem(PQ_COLS_LS) } catch { /* ignore */ } setVisKeys(PQ_COLS.map((c) => c.key)); setColMsg('Reset — all columns, default cleared'); setTimeout(() => setColMsg(''), 4000) }
  const savedKeys = (() => { try { return JSON.parse(localStorage.getItem(PQ_COLS_LS) || 'null') } catch { return null } })()
  const isSaved = Array.isArray(savedKeys) && savedKeys.length === visKeys.length && savedKeys.every((k) => visKeys.includes(k))
  const presetKey = SORT_PRESETS.find((p) => p.sort[0] === sort[0] && p.sort[1] === sort[1])?.key || ''

  const kpi = useMemo(() => {
    const list = filtered
    return {
      lines: list.length,
      qty: list.reduce((a, r) => a + num(r.Balance), 0),
      amt: list.reduce((a, r) => a + num(r.SumOfAmt), 0),
      late: list.filter((r) => num(r.Late) > 0).length,
      ready: list.filter((r) => num(r.NetStock) >= num(r.Balance) && num(r.Balance) > 0).length,
    }
  }, [filtered])

  const sortBtn = (key, label, title) => (
    <button className="link th-sort" title={title || ''} onClick={() => setSort(([k, d]) => [key, k === key && d === 'desc' ? 'asc' : 'desc'])}>
      {label}{sort[0] === key ? (sort[1] === 'desc' ? ' ↓' : ' ↑') : ''}
    </button>
  )

  const anyFilter = q || godowns.length || division || cats.length || brand || onlyLate || onlyStock

  if (rows === null) return <div className="action-page"><p className="muted">Loading pending quantity from ERP…</p></div>

  return (
    <div className="action-page act-page">
      <div className="action-head">
        <h2>📦 Pending Order — Order-wise Pending Items</h2>
        <p className="muted small">Live from ERP: every order line that is still pending, with stock position and how late it is.</p>
        {err && <p className="err small">❌ Could not load: {err} <button className="link" onClick={() => { setRows(null); load() }}>Retry</button></p>}

        <div className="coll-kpis">
          <span className="kpi-chip"><b>{kpi.lines}</b> lines · <b>{kpi.qty.toLocaleString('en-IN')}</b> qty pending</span>
          <span className="kpi-chip"><b>{inr(kpi.amt)}</b> value</span>
          <span className="kpi-chip red"><b>{kpi.late}</b> late lines</span>
          <span className="kpi-chip green-k"><b>{kpi.ready}</b> stock available — dispatch possible</span>
        </div>

        <div className="action-filter coll-filters">
          <input className="search" placeholder="🔍 Search party / product / code / order no…" value={q} onChange={(e) => setQ(e.target.value)} />
          <MultiSelect label="Godown" options={opts.godown} value={godowns} onChange={setGodowns} />
          <select value={division} onChange={(e) => setDivision(e.target.value)}>
            <option value="">Division: All</option>
            {opts.division.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <MultiSelect label="Category" options={opts.cat} value={cats} onChange={setCats} />
          <select value={brand} onChange={(e) => setBrand(e.target.value)}>
            <option value="">Brand: All</option>
            {opts.brand.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
          <label className="chk"><input type="checkbox" checked={onlyLate} onChange={(e) => setOnlyLate(e.target.checked)} /> Late only</label>
          <label className="chk" title="Lines where current stock covers the pending qty"><input type="checkbox" checked={onlyStock} onChange={(e) => setOnlyStock(e.target.checked)} /> Stock available</label>
          <select value={presetKey} onChange={(e) => { const p = SORT_PRESETS.find((x) => x.key === e.target.value); if (p) setSort(p.sort) }} title="Sort order (column headers also sort)">
            {!presetKey && <option value="">Sort: {PQ_COLS.find((c) => c.sort === sort[0])?.label || sort[0]} {sort[1] === 'desc' ? '↓' : '↑'}</option>}
            {SORT_PRESETS.map((p) => <option key={p.key} value={p.key}>Sort: {p.label}</option>)}
          </select>
          {anyFilter && <button className="btn ghost sm" onClick={() => { setQ(''); setGodowns([]); setDivision(''); setCats([]); setBrand(''); setOnlyLate(false); setOnlyStock(false) }}>✕ Clear filters</button>}
          <span className="filter-count active">🔎 {filtered.length} / {(rows || []).length} lines</span>
          <button className={`btn ghost sm ${colPanel ? 'on' : ''}`} title="Show / hide table columns" onClick={() => setColPanel((v) => !v)}>⚙ Columns{visCols.length < PQ_COLS.length ? ` (${visCols.length}/${PQ_COLS.length})` : ''}</button>
          <button className="btn ghost sm" title="Print this table with the columns shown" onClick={() => window.print()}>🖨 Print</button>
        </div>
        {colPanel && (
          <div className="coll-colpanel">
            <div className="colpanel-head"><b>⚙ Columns</b><span className="muted small">Tick what you want to see. "Save as default" remembers it on this device — the table opens like this every time.</span></div>
            <div className="colpanel-cols">
              {PQ_COLS.map((c) => <label key={c.key} className="small chk"><input type="checkbox" checked={visKeys.includes(c.key)} onChange={() => toggleCol(c.key)} /> {c.label}</label>)}
            </div>
            <div className="colpanel-foot">
              <button className="btn ghost sm" onClick={resetCols}>Reset (all columns)</button>
              <button className={`btn sm ${isSaved ? 'ghost' : 'primary'}`} onClick={saveCols} disabled={isSaved}>{isSaved ? '✓ Saved as default' : '💾 Save as default'}</button>
              {colMsg && <span className="small"><b>{colMsg}</b></span>}
            </div>
          </div>
        )}
      </div>

      <div className="panel coll-list">
        <table className="cfg-tbl pq-tbl">
          <thead>
            <tr>
              {visCols.map((c) => <th key={c.key} className={c.num ? 'num' : ''} title={c.title || ''}>{c.sort ? sortBtn(c.sort, c.label, c.title) : c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 500).map((r, i) => {
              const late = num(r.Late)
              const stockOk = num(r.NetStock) >= num(r.Balance) && num(r.Balance) > 0
              const cell = (k) => {
                switch (k) {
                  case 'Number': return <td key={k}><b>{r.Number}</b></td>
                  case 'Date': return <td key={k} className="small">{fmtDate(r.Date)}</td>
                  case 'PartyName': return <td key={k} className="pq-party"><b>{r.PartyName}</b></td>
                  case 'ProductName': return <td key={k} className="pq-prod" title={`${r.ProductName} (${r.ProductCode || ''})`}>{r.ProductName}<div className="muted small">{r.ProductCode}</div></td>
                  case 'ProdBrand': return <td key={k} className="small">{r.ProdBrand || '—'}</td>
                  case 'BaseCat': return <td key={k} className="small pq-cat" title={`${r.BaseCat || ''} › ${r.ProdCat || ''} › ${r.ProdSubGroup || ''}`}>{r.BaseCat || '—'}</td>
                  case 'Godown': return <td key={k} className="small">{r.Godown || '—'}</td>
                  case 'QTY': return <td key={k} className="num">{num(r.QTY).toLocaleString('en-IN')}</td>
                  case 'Balance': return <td key={k} className="num"><b>{num(r.Balance).toLocaleString('en-IN')}</b></td>
                  case 'NetStock': return <td key={k} className={`num ${stockOk ? 'green-t' : num(r.NetStock) <= 0 ? 'red-t' : ''}`} title={stockOk ? 'Stock covers pending qty — can dispatch' : ''}>{num(r.NetStock).toLocaleString('en-IN')}</td>
                  case 'Late': return <td key={k}>{late > 0 ? <span className={late > 30 ? 'red-t' : 'amber-t'}><b>{late}d</b></span> : <span className="muted">—</span>}</td>
                  case 'SumOfAmt': return <td key={k} className="num">{inr(r.SumOfAmt)}</td>
                  default: return null
                }
              }
              return <tr key={i}>{visCols.map((c) => cell(c.key))}</tr>
            })}
            {!filtered.length && <tr><td colSpan={visCols.length} className="muted">No pending lines match this filter.</td></tr>}
            {filtered.length > 500 && <tr><td colSpan={visCols.length} className="muted small">…and {filtered.length - 500} more lines — use the filters above</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
