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
