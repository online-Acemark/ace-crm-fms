// ============================================================
//  CRM FMS — GRID COLUMNS (code me hi manage hota hai)
// ============================================================
//  COLUMN ADD KARNA HO TO: bas is list me sahi jagah par ek
//  entry likh do — array ka order hi grid ka order hai.
//
//  Types:
//   'builtin' — app ka data field (mobile_so_no, account_name...)
//   'stage'   — pipeline stage (Pln | Act | Delay 3 sub-columns)
//   'text' | 'number' | 'date' | 'select' | 'checkbox'
//             — CUSTOM editable column; value Supabase me
//               fms_orders.custom_data me save hoti hai.
//               col_key hamesha 'c_' se shuru karo (unique).
//
//  Example — Dispatch ke baad "Transporter" text column:
//   { col_key: 'c_transporter', label: 'Transporter', col_type: 'text', is_custom: true },
//
//  Example — dropdown:
//   { col_key: 'c_priority', label: 'Priority', col_type: 'select',
//     options: ['High', 'Normal', 'Low'], is_custom: true },
//
//  Column chhupana ho to: visible: false laga do (delete mat karo).
// ============================================================

export const COLUMNS = [
  { col_key: 'mobile_so_no',    label: 'Mobile SO No',  col_type: 'builtin' },
  { col_key: 'so_date',         label: 'Date',          col_type: 'builtin' },
  { col_key: 'account_name',    label: 'Client Name',   col_type: 'builtin' },
  { col_key: 'salesman',        label: 'Salesman',      col_type: 'builtin' },
  { col_key: 'beat',            label: 'Beat',          col_type: 'builtin' },
  { col_key: 'mobile_no',       label: 'Contact',       col_type: 'builtin' },
  { col_key: 'contact_person',  label: 'Person 1',      col_type: 'builtin' },
  { col_key: 'email_id',        label: 'Email 1',       col_type: 'builtin' },
  { col_key: 'contact_person2', label: 'Person 2',      col_type: 'builtin' },
  { col_key: 'email_id2',       label: 'Email 2',       col_type: 'builtin' },
  { col_key: 'acc_family',      label: 'Family',        col_type: 'builtin' },
  { col_key: 'so_number',       label: 'SO Number',     col_type: 'builtin' },
  { col_key: 'so_amount',       label: 'SO Amount',     col_type: 'builtin' },
  { col_key: 'mobile_qty',      label: 'Mobile SO Qty', col_type: 'builtin' },
  { col_key: 'item',            label: 'Item',          col_type: 'builtin' },
  { col_key: 'so_qty',          label: 'SO Qty',        col_type: 'builtin' },
  { col_key: 'unit',            label: 'Unit',          col_type: 'builtin' },
  { col_key: 'stock',           label: 'Stock',         col_type: 'builtin' },
  { col_key: 'client_update',   label: 'Client Update', col_type: 'builtin' },
  { col_key: 'stage_so_convert', label: 'Confirm Order', col_type: 'stage' },
  { col_key: 'stage_billing',   label: 'Billing',       col_type: 'stage' },
  { col_key: 'stage_gpout',     label: 'Gate Pass Out', col_type: 'stage' },
  { col_key: 'stage_dispatch',  label: 'Dispatch',      col_type: 'stage' },
  { col_key: 'stage_payment',   label: 'Payment',       col_type: 'stage' },
  { col_key: 'pending_qty',     label: 'Pending Qty',   col_type: 'builtin' },
  { col_key: 'score',           label: 'Score',         col_type: 'builtin' },
]

// Grid ke liye normalize: array order = position, default visible = true
export function getColumns() {
  return COLUMNS.map((c, i) => ({
    id: i + 1,
    position: (i + 1) * 10,
    visible: c.visible !== false,
    is_custom: !!c.is_custom,
    options: c.options || [],
    ...c,
  }))
}
