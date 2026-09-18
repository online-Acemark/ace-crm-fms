import { useEffect, useMemo, useState } from 'react'
import { fetchERP } from '../lib/fms'

// Pending Qty tab: ERP PendingQuantity.ashx — order-wise kaunsa item kitna pending hai
const inr = (v) => '₹' + Number(v || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })
const num = (v) => Number(v) || 0

export default function PendingQty() {
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [godowns, setGodowns] = useState([]) // multi-select: khali = sab
  const [division, setDivision] = useState('')
  const [cat, setCat] = useState('')
  const [brand, setBrand] = useState('')
  const [onlyLate, setOnlyLate] = useState(false)
  const [onlyStock, setOnlyStock] = useState(false)
  const [sort, setSort] = useState(['Late', 'desc'])

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
    if (cat) list = list.filter((r) => String(r.BaseCat || '').trim() === cat)
    if (brand) list = list.filter((r) => String(r.ProdBrand || '').trim() === brand)
    if (onlyLate) list = list.filter((r) => num(r.Late) > 0)
    if (onlyStock) list = list.filter((r) => num(r.NetStock) >= num(r.Balance) && num(r.Balance) > 0)
    const [k, dir] = sort
    const mul = dir === 'desc' ? -1 : 1
    return [...list].sort((a, b) => {
      const av = ['PartyName', 'ProductName', 'Number'].includes(k) ? String(a[k] || '') : num(a[k])
      const bv = ['PartyName', 'ProductName', 'Number'].includes(k) ? String(b[k] || '') : num(b[k])
      return (av < bv ? -1 : av > bv ? 1 : 0) * mul
    })
  }, [rows, q, godowns, division, cat, brand, onlyLate, onlyStock, sort])

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

  const anyFilter = q || godowns.length || division || cat || brand || onlyLate || onlyStock

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
          <div className="coll-presets pq-godowns">
            <span className="muted small">Godown:</span>
            <button className={!godowns.length ? 'preset-chip active' : 'preset-chip'} onClick={() => setGodowns([])}>All</button>
            {opts.godown.map((g) => (
              <button key={g} className={godowns.includes(g) ? 'preset-chip active' : 'preset-chip'}
                title="Click to select — multiple godowns can be selected together"
                onClick={() => setGodowns((cur) => cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g])}>
                {godowns.includes(g) ? '✓ ' : ''}{g}
              </button>
            ))}
          </div>
          <input className="search" placeholder="🔍 Search party / product / code / order no…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={division} onChange={(e) => setDivision(e.target.value)}>
            <option value="">Division: All</option>
            {opts.division.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <select value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="">Category: All</option>
            {opts.cat.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={brand} onChange={(e) => setBrand(e.target.value)}>
            <option value="">Brand: All</option>
            {opts.brand.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
          <label className="chk"><input type="checkbox" checked={onlyLate} onChange={(e) => setOnlyLate(e.target.checked)} /> Late only</label>
          <label className="chk" title="Lines where current stock covers the pending qty"><input type="checkbox" checked={onlyStock} onChange={(e) => setOnlyStock(e.target.checked)} /> Stock available</label>
          {anyFilter && <button className="btn ghost sm" onClick={() => { setQ(''); setGodowns([]); setDivision(''); setCat(''); setBrand(''); setOnlyLate(false); setOnlyStock(false) }}>✕ Clear filters</button>}
          <span className="filter-count active">🔎 {filtered.length} / {(rows || []).length} lines</span>
        </div>
      </div>

      <div className="panel coll-list">
        <table className="cfg-tbl pq-tbl">
          <thead>
            <tr>
              <th>{sortBtn('Number', 'Order No')}</th>
              <th>Date</th>
              <th>{sortBtn('PartyName', 'Party')}</th>
              <th>{sortBtn('ProductName', 'Product')}</th>
              <th>Brand</th>
              <th>Category</th>
              <th>Godown</th>
              <th>{sortBtn('QTY', 'Order Qty')}</th>
              <th>{sortBtn('Balance', 'Pending')}</th>
              <th title="Current stock of this product">{sortBtn('NetStock', 'Stock')}</th>
              <th>{sortBtn('Late', 'Late', 'Days late')}</th>
              <th>{sortBtn('SumOfAmt', 'Value')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 500).map((r, i) => {
              const late = num(r.Late)
              const stockOk = num(r.NetStock) >= num(r.Balance) && num(r.Balance) > 0
              return (
                <tr key={i}>
                  <td><b>{r.Number}</b></td>
                  <td className="small">{r.Date || '—'}</td>
                  <td className="pq-party"><b>{r.PartyName}</b></td>
                  <td className="pq-prod" title={`${r.ProductName} (${r.ProductCode || ''})`}>{r.ProductName}<div className="muted small">{r.ProductCode}</div></td>
                  <td className="small">{r.ProdBrand || '—'}</td>
                  <td className="small pq-cat" title={`${r.BaseCat || ''} › ${r.ProdCat || ''} › ${r.ProdSubGroup || ''}`}>{r.BaseCat || '—'}</td>
                  <td className="small">{r.Godown || '—'}</td>
                  <td className="num">{num(r.QTY).toLocaleString('en-IN')}</td>
                  <td className="num"><b>{num(r.Balance).toLocaleString('en-IN')}</b></td>
                  <td className={`num ${stockOk ? 'green-t' : num(r.NetStock) <= 0 ? 'red-t' : ''}`} title={stockOk ? 'Stock covers pending qty — can dispatch' : ''}>{num(r.NetStock).toLocaleString('en-IN')}</td>
                  <td>{late > 0 ? <span className={late > 30 ? 'red-t' : 'amber-t'}><b>{late}d</b></span> : <span className="muted">—</span>}</td>
                  <td className="num">{inr(r.SumOfAmt)}</td>
                </tr>
              )
            })}
            {!filtered.length && <tr><td colSpan={12} className="muted">No pending lines match this filter.</td></tr>}
            {filtered.length > 500 && <tr><td colSpan={12} className="muted small">…and {filtered.length - 500} more lines — use the filters above</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
