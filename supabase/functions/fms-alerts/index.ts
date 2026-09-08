// FMS instant alerts (Telegram):
//  mode=instant (default, har 30 min sync ke baad): naya order aaya + confirm late
//  mode=dispatch (roz 2 PM): aaj ke pending dispatch ka reminder
// Har SO ka alert ek hi baar jata hai — fms_alert_log me record hota hai.
const IST = 5.5 * 3600 * 1000;
const H = 3600 * 1000;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const sb = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
};

const d = (v: unknown) => {
  if (!v) return null;
  const dt = new Date(v as string);
  if (isNaN(dt.getTime())) return null;
  return /z$|[+-]\d\d:?\d\d$/i.test(String(v)) ? new Date(dt.getTime() + IST) : dt;
};
const nowIST = () => new Date(Date.now() + IST);
const inr = (v: unknown) => "Rs." + Number(v || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });
const hm = (dt: Date) => dt.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
const ymd = (dt: Date) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;

let workingDaySet: Set<string> | null = null;
const isWorkingDay = (dt: Date) => (workingDaySet ? workingDaySet.has(ymd(dt)) : dt.getDay() !== 0);
const nextWorkingDay = (from: Date) => {
  let day = new Date(from); day.setHours(0, 0, 0, 0);
  for (let i = 0; i < 60; i++) { day = new Date(day.getTime() + 864e5); if (isWorkingDay(day)) break; }
  return day;
};
// SO Convert planned — same rule as app/fms-sync
function soConvertPlanned(t: Date | null, plannedHours = 0.5) {
  if (!t) return null;
  const addMs = plannedHours * H;
  const cutoff = new Date(t); cutoff.setHours(19, 30, 0, 0);
  if (isWorkingDay(t) && t <= cutoff) return new Date(t.getTime() + addMs);
  const day = nextWorkingDay(t);
  day.setHours(10, 30, 0, 0);
  return new Date(day.getTime() + addMs);
}

const sendTG = async (text: string) => {
  const settings = await sb("fms_settings?key=eq.telegram&select=value");
  const tg = settings?.[0]?.value;
  if (!tg?.token || !tg?.chat_id) throw new Error("fms_settings me key='telegram' set nahi hai");
  const res = await fetch(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: tg.chat_id, text: text.slice(0, 4000) }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error("Telegram: " + JSON.stringify(j));
};

Deno.serve(async (req) => {
  try {
    const mode = new URL(req.url).searchParams.get("mode") || "instant";
    const now = nowIST();

    if (mode === "dispatch") {
      const orders = await sb("fms_orders?select=mobile_so_no,account_name,salesman,billing_date,desp_date,bill_net_amount,sorder_amount&billing_date=not.is.null&desp_date=is.null");
      if (!orders.length) return new Response(JSON.stringify({ ok: true, sent: false, note: "koi dispatch pending nahi" }), { headers: { "Content-Type": "application/json" } });
      const L = [`DISPATCH REMINDER (2 PM) — 4 baje se pehle nikalna hai:`, ""];
      for (const o of orders.slice(0, 15)) L.push(`- #${o.mobile_so_no} | ${o.account_name} | ${inr(o.bill_net_amount || o.sorder_amount)} | ${o.salesman || ""}`);
      if (orders.length > 15) L.push(`...aur ${orders.length - 15} orders`);
      L.push("", `Total pending dispatch: ${orders.length}`);
      await sendTG(L.join("\n"));
      return new Response(JSON.stringify({ ok: true, sent: true, dispatchPending: orders.length }), { headers: { "Content-Type": "application/json" } });
    }

    // mode=instant
    const [orders, wd, hd, log] = await Promise.all([
      sb("fms_orders?select=mobile_so_no,account_name,mobile_no,salesman,mobile_so_created,so_convert_date,sorder_amount,mobile_so_amount"),
      sb("working_day_calender?select=working_date"),
      sb("holidays?select=holiday_date"),
      sb("fms_alert_log?select=so_no,alert_type"),
    ]);
    const hset = new Set((hd || []).map((r: any) => r.holiday_date));
    workingDaySet = new Set((wd || []).map((r: any) => r.working_date).filter((x: string) => !hset.has(x)));
    const logged = new Set((log || []).map((r: any) => r.so_no + "|" + r.alert_type));

    const newLog: any[] = [];
    const newLines: string[] = [];
    const lateLines: string[] = [];

    for (const o of orders) {
      const so = String(o.mobile_so_no);
      const created = d(o.mobile_so_created);
      const planned = soConvertPlanned(created);

      // naya order: pehli baar dikha — log sabka hota hai, message sirf 24h ke andar wale ka
      if (!logged.has(so + "|new_order")) {
        newLog.push({ so_no: so, alert_type: "new_order" });
        if (created && now.getTime() - created.getTime() < 24 * H) {
          newLines.push(`- #${so} | ${o.account_name} | ${inr(o.sorder_amount || o.mobile_so_amount)} | ${o.salesman || ""} | aaya ${hm(created)}${planned ? " | target " + hm(planned) : ""}`);
        }
      }

      // confirm late: abhi tak convert nahi hua aur planned time nikal gaya — ek hi baar
      if (!o.so_convert_date && planned && now > planned && !logged.has(so + "|confirm_late")) {
        newLog.push({ so_no: so, alert_type: "confirm_late" });
        const lateMin = Math.round((now.getTime() - planned.getTime()) / 60000);
        const lateTxt = lateMin >= 60 ? `${Math.floor(lateMin / 60)}h ${lateMin % 60}m` : `${lateMin}m`;
        lateLines.push(`- #${so} | ${o.account_name} | target tha ${hm(planned)} | ${lateTxt} late | ${o.salesman || ""}`);
      }
    }

    if (newLog.length) {
      await sb("fms_alert_log?on_conflict=so_no,alert_type", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify(newLog),
      });
    }

    const parts: string[] = [];
    if (newLines.length) parts.push(`NAYA ORDER AAYA (${newLines.length}) — 30 min me confirm karna hai:\n` + newLines.join("\n"));
    if (lateLines.length) parts.push(`CONFIRM LATE (${lateLines.length}) — abhi tak SO convert nahi hua:\n` + lateLines.join("\n"));

    if (parts.length) await sendTG(parts.join("\n\n"));

    return new Response(JSON.stringify({ ok: true, sent: parts.length > 0, newOrders: newLines.length, confirmLate: lateLines.length, loggedRows: newLog.length }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
