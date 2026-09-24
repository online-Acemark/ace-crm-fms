# CRM FMS — Acemark

Order → Delivery → Payment FMS with Plan vs Actual, Delay tracking, Scoring, and dynamic columns.

## Stack
- React + Vite (this folder)
- Supabase project `checklist_delegation` (dgsuenfqujouikjefymm)
  - Tables: `fms_orders`, `fms_stage_config`, `fms_followups`, `fms_settings`
  - Edge function `fms-proxy` — server-side fetch of ERP APIs (CORS-safe):
    - `?src=so`    → MobileSO.ashx (order pipeline)
    - `?src=stock` → ProductStock.ashx

## Run
    npm install
    npm run dev

Demo without login: open http://localhost:5173/?demo (static sample data from public/demo-so.json)

## Google Login setup (one-time, Supabase dashboard)
1. https://supabase.com/dashboard/project/dgsuenfqujouikjefymm/auth/providers → Google → Enable
2. Google Cloud Console → APIs & Services → Credentials → Create OAuth Client (Web):
   - Authorized redirect URI: https://dgsuenfqujouikjefymm.supabase.co/auth/v1/callback
3. Paste Client ID + Secret into the Supabase Google provider form.
4. Supabase → Authentication → URL Configuration → add your app URL (http://localhost:5173 and the deployed URL) to Redirect URLs.

## CRM Executive ke liye
- **Aaj Ke Kaam** (default tab) — 5 prioritized queues: Naye orders confirm, Billing pending,
  Dispatch due, Payment follow-up, Contact data adhura. Har section me "Kaise" instruction likha hai.
- **📤 Status button** — client ko ready-made WhatsApp message (order ka current stage, pending qty,
  bill amount, invoice PDF link) — ek click me.
- **Contact split** — ERP ka "Name1 / Name2" apne aap Person 1 / Person 2 me split hota hai (email bhi).
  Jo blank hai wo grid me dotted box hai — wahin type karo, `contact_manual` (JSONB) me save hota hai
  aur agla sync usse kabhi overwrite nahi karta. Filter: "📇 Contact info missing".

## Collection tab — follow-up system (Supabase)
- Party list `fms_collection` (hourly ERP sync) + follow-up log `fms_followups` (party-level rows).
- **Follow-up entry** (party modal): Stage (Committed / Payment received / PDC received / Dispute /
  No response / CRM Support / Transfer / Close), remark, amount received + payment mode, bills ticked
  in the table (`bill_nos`), promised amount + date (`committed_*`), transfer to salesman + reason
  (`transfer_*`), next follow-up date -> `fms_collection.next_followup_date` (Close = null).
- **Status buckets** from next date: Missed / Today / Tomorrow / This week / Later / No date / Closed.
  Rules: call logged today or last stage "CRM Support" -> not Missed; last stage "Close" -> Closed.
- **Broken promise** = committed date passed, nothing received after it, not closed -> top priority.
- **Bill-wise entry**: 📝 on a bill row (or tick several bills → "Follow-up for these") opens the
  form in a small modal with the bill(s) locked in; "Follow-up (whole account)" for no specific bill.
- **ERP receipts** (`fms_receipts`, from Payment.ashx): party modal shows voucher-wise receipts
  (date, voucher no, type, amount, bills adjusted); bills carry `pay_status/received/still_pending`.
  Pulse "Received (ERP)" is the real number; amounts typed in notes are only "claimed" and show as
  ⚠ until ERP confirms (Full → bill hidden as paid).
- **Permanent note** (`fms_collection.permanent_note`) = party excluded from worklist ("Excluded" chip).
- **Pulse**: date range -> received amount, follow-ups done, by user. Columns picker (localStorage
  `fms_coll_cols`) + Print (current filter).
- **Imported history** (`mode = 'sheet'`): the old Google-Form sheet (Payment_FollowUp_Res, 27 Jun –
  22 Sep 2026, 2,115 rows / 265 parties, +74 rows for 22–23 Sep added on 24 Sep) was loaded into `fms_followups` — remark, bill
  no, stage (Payment received / No response / Close / CRM Support), amount + mode, next date (plan) and
  the original timestamp + salesman as `created_by`. It shows in party History, Pulse and Scoreboard
  like any call entry; `fms_collection.next_followup_date` was back-filled from each party's latest
  open sheet entry (159 parties). Parties that no longer have pending bills keep their history only.

## My Parties tab (salesman)
- Shows only the logged-in salesman's parties (+ those transferred to them). Login -> ERP salesman
  name: admin sets it in User Control ("Salesman (My Parties)"), else auto-match by Google name /
  email first name (only when exactly one salesman matches). Admins get a "view as salesman" picker.
- Row click expands: overdue bills (tick to link), ERP receipts, history, and the **commitment form**
  (promised amount + date + remark) -> `fms_followups` stage Committed; CRM's next follow-up date is
  pulled to the promised day if it was blank or later.
- Shared helpers live in `src/lib/coll.js`, shared UI bits in `src/components/CollBits.jsx`
  (avatar/party cell, stat strip, tabs, chips with counts, toast, next-up banner, mobile cards).
- UI: filter chips show live counts, "Start here" banner picks the top-priority party, table has a
  sticky header + priority accent, party modal = stat strip + action bar + tabs (Bills / Receipts /
  History), follow-up form uses a stage picker + quick next-date buttons. Under 760px both tabs
  switch from table to cards with big Call / WhatsApp buttons.

## Collection follow-up scoring (Scoreboard tab)
- Every follow-up entry stores its plan (`fms_followups.next_followup_date`). The next non-WhatsApp
  entry on the same party is the actual. Same day or earlier = on time (100), each day late −20
  (settings key `coll_scoring`, editable in Stage Plan → Collection Follow-up Points), plan date passed with
  no call = missed (0), stage Close = no plan. Week = Monday–Saturday, scored in the week of the plan.
- Credit goes to whoever logged the actual follow-up; a missed plan counts against its planner.
- Scoreboard shows week picker, KPIs, by-user table, 8-week trend and the plan list.
  Logic: `scoreFollowups()` / `summarize()` in `src/lib/coll.js`.

## How it works
- **Sync ERP** button pulls MobileSO.ashx via the proxy, aggregates line-rows per Mobile SO,
  and upserts into `fms_orders` (custom column values & payment status are preserved).
- **Planned** times chain from Mobile SO created time using `fms_stage_config.planned_hours`;
  Dispatch uses the 4 PM cutoff rule (before 4 PM → same day, else next day);
  Payment due = Billing date + CreditDays.
- **Delay** = Actual − Planned (running delay shown live for open stages).
- **Score** = weighted stage points (on-time = 100, penalty per hour of delay; rules editable in Stage Plan tab).
- **Columns**: code me manage hote hain — `src/lib/columns.js` kholo, COLUMNS array me
  sahi jagah entry add karo (instructions file ke top par comment me hain).
  Custom column values `fms_orders.custom_data` (JSONB) me save hoti hain.
- **Order drawer** (click SO number): full pipeline, products, invoice PDFs, payment follow-ups,
  mark payment complete.
