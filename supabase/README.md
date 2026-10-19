# Supabase server-side setup (backup copy)

Ye folder Supabase par deploy hue edge functions ka backup hai. Asli deployment
Supabase project `dgsuenfqujouikjefymm` par live hai. Yahan edit karne se live
function NAHI badalta — deploy karna padta hai (`supabase functions deploy <name>`).

## Edge functions

| Function | Kaam | Kaun call karta hai |
|---|---|---|
| `fms-proxy` | ERP APIs (MobileSO, ProductStock) ka CORS proxy | App (Sync ERP button, stock column) |
| `fms-sync` | Pura ERP sync server-side — orders + delays + scores `fms_orders` me | Cron: har 30 min (`fms-auto-sync`, `*/30 * * * *`) |
| `fms-digest` | Roz subah ka Telegram digest (counts, follow-ups, payment overdue + dispatch due BILL-WISE, Collection: Missed / Aaj due / Broken promise / kal ka kaam) | Cron: 9:00 AM IST (`fms-daily-digest`, `30 3 * * *` UTC) |
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
Migration `followup_form_conditional_fields`: `fms_followups.customer_says, received_by, received_salesman,
support_type` + `fms_settings.coll_form` (form dropdown options); sheet rows ka `customer_says` /
`received_by` remark se backfill kiya.

Purani Google-Sheet history (`Payment_FollowUp_Res`) `fms_followups` me `mode='sheet'` ke saath one-time
import hai (22 Sep 2026, 2,115 rows; 24 Sep ko 22–23 Sep ki 74 rows aur judi — duplicate check timestamp + party par) — `created_at` = sheet ka original timestamp (IST), `created_by` =
sheet ka salesman, `next_followup_date` = sheet ka next date 11:00 IST. Dubara import karna ho to pehle
`delete from fms_followups where mode='sheet'` chalao.

## ERP receipts (`fms_receipts`, migration `fms_receipts_from_payment_api`)

Payment.ashx ki har row = ek bill x ek payment voucher. `PaidAmt` us voucher ka us bill par laga
hissa hai (bill-level; har bill ke liye sum(PaidAmt) = TotalAdjusted), `StillPending` bill ka balance,
`PayStatus` Full/Part/Pending. `fms-collection-sync` inhe voucher-wise group karke `fms_receipts`
(PK company_id + pay_vno) me upsert karta hai — purane vouchers delete nahi hote. API sirf Jan-2026 se
aage ke bills cover karta hai, isliye ek voucher ka amount usi window ke bills ka jod hai.

## MIS Score: Collection follow-ups (view `score.v_crm_collection_followup_mis`)

Maahi (`acemarkcrm@gmail.com`) ke collection follow-ups Acemark **Score System** (`score` schema, same
project) me MIS rules se gine jaate hain. Score System har 5 min `score.sync_webapp_facts()` se view
padh ke `score.task_facts` me daalta hai (registry id 25 "Collection Follow-up", source id 125).
Purana Google Sheet source "Payment Collection" (registry 17) `is_official = false` hai (16 Oct 2026).

- 1 task = Maahi ki ek planned follow-up: party ki us din ki **aakhri** entry ka `next_followup_date`
  (ek call me kai bill-notes = ek hi task). WhatsApp auto-log, `Close` stage aur sheet import nahi gine jaate.
- Planned: `fms_followups.plan_time_set = true` (form me time chuna, 16 Oct 2026 se zaroori) → exact
  time; purane plans (default 11:00) → us din 23:59:59 IST. `original_planned_at` = planned (entry kabhi edit nahi hoti).
- Actual = usi party par **agle din ya baad** ki pehli call entry ka `created_at` (koi bhi user).
- Pending task tab hat-ta hai jab party `fms_collection` me nahi (paid) / permanent note / ledger difference.
- Score sirf 28 Sep 2026 ke baad ki plan dates ka. Formula Score System ka (`score.mis_score_core`, datetime mode).

## MIS Score: Today Work (Ahmad Khan) — table `fms_today_tasks`, view `score.v_o2d_today_work_mis`

Today Work ke 3 kaam Score System me Ahmad Khan ke naam gine jaate hain (registry 26 "Order To Delivery (Today Work)",
source 126). Payment follow-up yahan nahi (wo Maahi ke Collection Follow-up me hai); Hold / Contact gine nahi jaate.
Purana "Order To Delivery" Google Sheet source (registry 10, sources 95–97) 16 Oct 2026 se band hai.

- `fms-sync` har 30 min `todayTasksOf()` se task banata hai aur `rpc/fms_capture_today_tasks` ko bhejta hai. Naya task
  insert hota hai aur uska `planned_at` **lock** ho jaata hai (MIS: original planned kabhi nahi badalta); baad ke syncs sirf
  `actual_at` bharte hain.
  - **Confirm order** (har order): planned = SO Convert rule (aaya + 30 min; 7:30 PM ke baad / chhutti → agle working
    din 11:00). Actual = ERP `SoConvertDate`.
  - **Billing** (har confirmed order jo bill ho gaya ya Billing Pending me dikhne layak hai — stock ho, sab lines
    pre-closed na hon, hold nahi): planned = confirm (ya stock baad me aaya to pehli baar list me aane ka waqt) 4 PM se
    pehle → usi din 4 PM, warna agle working din 4 PM. Actual = ERP billing date.
  - **Dispatch** (har bill): planned = Today Work ka dispatch planned (order 4 PM se pehle → usi din 23:59, warna agle
    din 23:59). Actual = bill ki saari lines par GP + DespDate (ERP sirf date deta hai → din ke hisaab se on-time).
- View sirf 19 Oct 2026 ke baad ke planned ginta hai (shuru ki date `fms_settings.today_work_score.from` se, default
  19 Oct); cancelled / hold orders ke pending task bahar.
- Score System me har Today Work section ka **alag source** hai (merge nahi): source 126 "Naya Order (Confirm)" →
  `score.v_o2d_confirm_mis`, 127 "Billing" → `v_o2d_billing_mis`, 128 "Dispatch" → `v_o2d_dispatch_mis`
  (teeno common view `v_o2d_today_work_mis` ko `step_no` se filter karte hain).

## Hold Approval (table `fms_hold_cases`, migration `fms_hold_approval`) — "Hold SO System" sheet ki jagah

ERP me hold pe rakhe SO ka case app me khulta hai; salesman commitment bharta hai, Deepak Kumar Sahu approve/reject
karte hain. 19 Oct 2026 se (`fms_settings.hold_score.from`). Purana Google Sheet source (registry 8 "Hold Order System")
cron `hold_sheet_off` se 19 Oct 00:00 IST ko band hota hai.

- `fms-sync` har 30 min `PreclosedHoldorder.ashx` (hold SO list) + `HoldSo.ashx` (closing balance, PDC, credit limit,
  remark → `fms_orders.hold_info`) padhta hai aur `rpc/fms_sync_hold_cases` bhejta hai: naya hold → case khulta hai
  (`hold_seen_at`), list se hata → `released_at`. Hold list fail ho to cases ko chheda nahi jaata.
- Ek SO ka ek hi open case. `commit_planned_at` = hold_seen + 1 office-ghanta (`fms_office_plus`: 10:30–19:30, working day).
- Salesman (My Parties ka hold panel / Today Work → Hold Approval) `fms_hold_commit` se form bharta hai: committed
  amount, date, payment through, reminder, "order on hold to be cleared?", remarks. Pehla commit `commit_at` lock karta
  hai, `approve_planned_at` = commit + 1 office-ghanta, aur `fms_followups` me "Committed" entry banti hai (collection
  follow-up commit date 11:00 IST).
- Approve/Reject `fms_hold_decide` — sirf `fms_users.can_approve_hold = true` (User Control → "Hold approver").
  Reject me reason zaroori.
- Alerts (`fms-alerts`, `mode=hold` + instant mode): naye case par salesman ko Telegram DM (`public.users.telegram_chat_id`,
  naam se match), commitment aane par approvers ko. FMS bot (@Acemark_alerts_bot), phir Score System bot, phir Checklist
  bot (project secret `TELEGRAM_BOT_TOKEN`) — user ne jis bot ko Start kiya ho. `?mode=holddiag` bina message bheje batata
  hai kaunsa bot kis user tak pahunchta hai.
- MIS Score (registry 27 "Hold Approval"): source 129 → `score.v_hold_commit_mis` (salesman, planned = commit_planned_at,
  actual = commit_at), source 130 → `score.v_hold_approval_mis` (approver, planned = approve_planned_at, actual = decision_at).
  SO-wise; release ho chuke case ke pending task bahar.
