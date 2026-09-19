import { useState } from 'react'

// Dropdown with checkboxes — multiple options tick karke filter karo.
// options: [{ key, label }] ya simple strings; value: selected keys ka array; khali = All
export default function MultiSelect({ label, options, value, onChange }) {
  const [open, setOpen] = useState(false)
  const opts = options.map((o) => (typeof o === 'string' ? { key: o, label: o } : o))

  const toggle = (k) => onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k])
  const btnText = value.length === 0 ? `${label}: All`
    : value.length === 1 ? `${label}: ${opts.find((o) => o.key === value[0])?.label ?? value[0]}`
    : `${label}: ${value.length} selected`

  return (
    <div className="ms-wrap">
      <button className={value.length ? 'ms-btn active' : 'ms-btn'} onClick={() => setOpen((v) => !v)}>
        {btnText} <span className="ms-caret">▾</span>
      </button>
      {open && <>
        <div className="ms-back" onClick={() => setOpen(false)} />
        <div className="ms-panel">
          <label className="ms-item">
            <input type="checkbox" checked={value.length === 0} onChange={() => onChange([])} />
            <span><b>All</b></span>
          </label>
          {opts.map((o) => (
            <label key={o.key} className="ms-item">
              <input type="checkbox" checked={value.includes(o.key)} onChange={() => toggle(o.key)} />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      </>}
    </div>
  )
}
