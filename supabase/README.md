# Supabase server-side setup (backup copy)

Ye folder Supabase par deploy hue edge functions ka backup hai. Asli deployment
Supabase project `dgsuenfqujouikjefymm` par live hai. Yahan edit karne se live
function NAHI badalta — deploy karna padta hai (`supabase functions deploy <name>`).

## Edge functions

| Function | Kaam | Kaun call karta hai |
|---|---|---|
| `fms-proxy` | ERP APIs (MobileSO, ProductStock) ka CORS proxy | App (Sync ERP button, stock column) |
| `fms-sync` | Pura ERP sync server-side — orders + delays + scores `fms_orders` me | Cron: har 30 min (`fms-auto-sync`, `*/30 * * * *`) |
| `fms-digest` | Roz subah ka Telegram digest (counts, follow-ups, payment overdue) | Cron: 9:00 AM IST (`fms-daily-digest`, `30 3 * * *` UTC) |
| `fms-alerts` | `?mode=instant`: naya order + confirm late; `?mode=dispatch`: 2 PM dispatch reminder | Cron: `5,35 * * * *` (instant) aur 2:00 PM IST (`30 8 * * *` UTC) |

## Zaroori baat — logic 2 jagah hai

Planned/delay ke business rules (SO convert 7:30 PM cutoff, stock-based billing,
payment due + working-day skip) **do jagah** likhe hain:

1. App: `src/lib/fms.js`
2. Server: `supabase/functions/fms-sync/index.ts` (+ partial `fms-alerts`)

Koi rule badle to **dono jagah** badalna hai.

## Settings (database me)

- `fms_settings` key `telegram`: `{ "token": "<bot token>", "chat_id": "<chat id>" }`
  — digest/alerts kahan jayenge. Group me bhejne ke liye bas chat_id badal do.
- `fms_settings` key `scoring`: scoring rules (app ke Stage Plan tab se bhi).
- `working_day_calender` + `holidays`: working-day rules ka calendar
  (23 Feb 2027 tak bhara hai — uske baad naya saal add karna hoga).
- `fms_alert_log`: kis SO ka kaun sa alert ja chuka (duplicate rokne ke liye).

## Cron jobs dekhne/badalne ke liye

```sql
select jobname, schedule, active from cron.job;
-- band karna ho: select cron.unschedule('fms-daily-digest');
```
