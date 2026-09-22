# Supabase server-side setup (backup copy)

Ye folder Supabase par deploy hue edge functions ka backup hai. Asli deployment
Supabase project `dgsuenfqujouikjefymm` par live hai. Yahan edit karne se live
function NAHI badalta — deploy karna padta hai (`supabase functions deploy <name>`).

## Edge functions

| Function | Kaam | Kaun call karta hai |
|---|---|---|
| `fms-proxy` | ERP APIs (MobileSO, ProductStock) ka CORS proxy | App (Sync ERP button, stock column) |
| `fms-sync` | Pura ERP sync server-side — orders + delays + scores `fms_orders` me | Cron: har 30 min (`fms-auto-sync`, `*/30 * * * *`) |
| `fms-digest` | Roz subah ka Telegram digest (counts, follow-ups, payment overdue, Collection: Missed / Aaj due / Broken promise / kal ka kaam) | Cron: 9:00 AM IST (`fms-daily-digest`, `30 3 * * *` UTC) |
| `fms-alerts` | `?mode=instant`: naya order + confirm late; `?mode=dispatch`: 2 PM dispatch reminder | Cron: `5,35 * * * *` (instant) aur 2:00 PM IST (`30 8 * * *` UTC) |
| `fms-collection-sync` | Poore ledger ka party-wise outstanding (PaymentFollowup + UrgentPaymentFollow) -> `fms_collection` (aging, bills, PDC, credit limit). Fully-paid parties auto-delete. Payment.ashx se receipts voucher-wise -> `fms_receipts`, aur har bill me `pay_status/received/still_pending/pay_vnos`. | Cron: har ghante :20 par (`fms-collection-sync`, `20 * * * *`) |

## Zaroori baat — logic 2 jagah hai

Planned/delay ke business rules (SO convert 7:30 PM cutoff, stock-based billing,
payment due + working-day skip) **do jagah** likhe hain:

1. App: `src/lib/fms.js`
2. Server: `supabase/functions/fms-sync/index.ts` (+ partial `fms-alerts`)

Koi rule badle to **dono jagah** badalna hai.

## Settings (database me)

- `fms_settings` key `erp`: `{ "so_url": "<MobileSO.ashx>", "stock_url": "<ProductStock.ashx>", "payment_url": "<Payment.ashx>", "payfup_url": "<PaymentFollowup.ashx>", "urgent_url": "<UrgentPaymentFollow.ashx>" }`
  — ERP API addresses. **ERP ka address badle to sirf ye row update karo** (SQL ya
  Supabase Table Editor se) — kisi function ka redeploy nahi chahiye.
- `fms_settings` key `telegram`: `{ "token": "<bot token>", "chat_id": "<chat id>" }`
  — digest/alerts kahan jayenge. Group me bhejne ke liye bas chat_id badal do.
- `fms_settings` key `scoring`: scoring rules (app ke Stage Plan tab se bhi).
- `working_day_calender` + `holidays`: working-day rules ka calendar
  (23 Feb 2027 tak bhara hai — uske baad naya saal add karna hoga).
- `fms_alert_log`: kis SO ka kaun sa alert ja chuka (duplicate rokne ke liye).
- `fms_users`: tab-wise access (User Control tab). List me nahi = saare tabs.
  `is_admin=true` wale hi doosron ka access badal sakte hain (RLS policy
  `fms_is_admin()` security-definer function se — warna infinite recursion).
  Naya admin banana ho aur koi admin login na ho to SQL se:
  `update fms_users set is_admin=true where email='...';`

## Payment reconciliation (Payment.ashx)

`fms-sync` har run me ERP ke Payment.ashx se bill-wise payment data milata hai:
`fms_orders` me `pay_status` (Full/Part/Pending), `payment_received_erp`,
`payment_pending_erp` (asli baaki), `pay_last_date` bharta hai. Matching
bill number + party name dono se hoti hai (AS/AM series me same number alag
party ka hota hai) — naam na mile to skip (galat data se behtar). `pay_status
= 'Full'` app me payment complete gina jata hai (manual ✔ ke barabar).
NOTE: Payment API ke PaidAmt/TotalAdjusted VOUCHER-level hain; per-bill
hisaab BillAmt - StillPending se hota hai.

## Cron jobs dekhne/badalne ke liye

```sql
select jobname, schedule, active from cron.job;
-- band karna ho: select cron.unschedule('fms-daily-digest');
```

## Collection follow-ups (migration `collection_followup_stage_commit_transfer`)

`fms_followups` extra columns: `stage, payment_mode, bill_nos (jsonb array), committed_amount,
committed_date, transfer_to, transfer_reason`. `fms_collection` extra: `permanent_note,
note_updated_by, note_updated_at`. `fms-collection-sync` ka upsert sirf apne columns bhejta hai,
isliye `next_followup_date` / `permanent_note` sync me preserve rehte hain (fully-paid party delete
hone par note bhi jaata hai). Sab derived values (follow-up count, last stage, broken promise,
claimed-paid bills) app me `fms_followups` se compute hote hain — koi trigger nahi.

## ERP receipts (`fms_receipts`, migration `fms_receipts_from_payment_api`)

Payment.ashx ki har row = ek bill x ek payment voucher. `PaidAmt` us voucher ka us bill par laga
hissa hai (bill-level; har bill ke liye sum(PaidAmt) = TotalAdjusted), `StillPending` bill ka balance,
`PayStatus` Full/Part/Pending. `fms-collection-sync` inhe voucher-wise group karke `fms_receipts`
(PK company_id + pay_vno) me upsert karta hai — purane vouchers delete nahi hote. API sirf Jan-2026 se
aage ke bills cover karta hai, isliye ek voucher ka amount usi window ke bills ka jod hai.
