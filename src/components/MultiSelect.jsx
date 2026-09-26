import { useState } from 'react'

// Dropdown with checkboxes — multiple options tick karke filter karo.
// options: [{ key, label }] ya simple strings; value: selected keys ka array; khali = All (koi filter nahi)
// Panel me search + "Select all shown" (jo items dikh rahe hain sab tick) + "Clear" (wapas All).
export default function MultiSelect({ label, options, value, onChange }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const opts = options.map((o) => (typeof o === 'string' ? { key: o, label: o } : o))
  const s = q.trim().toLowerCase()
  const shown = s ? opts.filter((o) => String(o.label).toLowerCase().includes(s)) : opts
  const allShownOn = shown.length > 0 && shown.every((o) => value.includes(o.key))

  const toggle = (k) => onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k])
  // Select all (shown): search lagi ho to sirf dikh rahe items add hote hain, baaki selection waise hi rehti hai
  const selectShown = () => onChange(allShownOn ? value.filter((k) => !shown.some((o) => o.key === k)) : [...new Set([...value, ...shown.map((o) => o.key)])])
  const btnText = value.length === 0 ? `${label}: All`
    : value.length === 1 ? `${label}: ${opts.find((o) => o.key === value[0])?.label ?? value[0]}`
    : value.length === opts.length ? `${label}: All ${opts.length} ticked`
    : `${label}: ${value.length} selected`

  return (
    <div className="ms-wrap">
      <button className={value.length ? 'ms-btn active' : 'ms-btn'} onClick={() => setOpen((v) => !v)}>
        {btnText} <span className="ms-caret">▾</span>
      </button>
      {open && <>
        <div className="ms-back" onClick={() => { setOpen(false); setQ('') }} />
        <div className="ms-panel">
          {opts.length > 6 && <input className="ms-search" placeholder={`Search ${label.toLowerCase()}…`} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />}
          <div className="ms-tools">
            <button className="link small" onClick={selectShown} disabled={!shown.length} title={s ? 'Tick every item matching the search' : 'Tick every item in the list'}>
              {allShownOn ? '☐ Untick all' : '☑ Select all'}{s ? ` shown (${shown.length})` : ` (${shown.length})`}
            </button>
            <button className="link small" onClick={() => onChange([])} disabled={!value.length} title="No filter — show everything">✕ Clear (All)</button>
          </div>
          <label className="ms-item">
            <input type="checkbox" checked={value.length === 0} onChange={() => onChange([])} />
            <span><b>All</b> <span className="muted">(no filter)</span></span>
          </label>
          {shown.map((o) => (
            <label key={o.key} className="ms-item">
              <input type="checkbox" checked={value.includes(o.key)} onChange={() => toggle(o.key)} />
              <span>{o.label}</span>
            </label>
          ))}
          {!shown.length && <div className="muted small" style={{ padding: '6px 9px' }}>Nothing matches "{q}"</div>}
        </div>
      </>}
    </div>
  )
}
