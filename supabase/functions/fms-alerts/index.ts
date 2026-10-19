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
// API ek request me max 1000 rows deti hai — badi tables page-by-page (path me order= zaroor ho)
const sbAll = async (path: string) => {
  const out: any[] = [];
  for (let off = 0; ; off += 1000) {
    const page = await sb(`${path}${path.includes("?") ? "&" : "?"}limit=1000&offset=${off}`);
    if (!page?.length) break;
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
};

const d = (v: unknown) => {
  if (!v) return null;
  const dt = new Date(v as string);
  if (isNaN(dt.getTime())) return null;
  return /z$|[+-]\d\d:?\d\d$/i.test(String(v)) ? new Date(dt.getTime() + IST) : dt;
};
const nowIST = () => new Date(Date.now() + IST);
const inr = (v: unknown) => "Rs." + Number(v || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });

// ---- bill-wise (app ke billStatuses jaisa): ek SO ke kai bills; har bill ka apna GP Out / dispatch / payment status ----
type Bill = { bill_no: string; billing_date: string | null; amount: number; qty: number; lines: number; status: string; gp_nos: string[]; pay_status: string | null; pending: number };
const billsOf = (o: any): Bill[] => {
  const ps: any[] = Array.isArray(o.products) ? o.products : [];
  const pay = new Map<string, any>((Array.isArray(o.bills_payment) ? o.bills_payment : []).map((b: any) => [String(b.bill_no), b]));
  return (Array.isArray(o.bills) ? o.bills : []).map((b: any) => {
    const key = String(b.bill_no);
    const lines = ps.filter((x) => String(x.bno ?? "") === key);
    const gp = lines.filter((x) => x.gpno != null);
    const out = lines.filter((x) => x.gpno != null && x.ddt);
    const status = lines.length && out.length === lines.length ? "dispatched" : lines.length && gp.length === lines.length ? "gpout" : gp.length ? "partial" : "pending";
    const pm: any = pay.get(key);
    return { bill_no: key, billing_date: b.billing_date || null, amount: Number(b.amount) || 0, qty: Number(b.qty) || 0, lines: lines.length, status,
      gp_nos: [...new Set(gp.map((x) => String(x.gpno)))], pay_status: pm?.status || null, pending: pm ? Number(pm.pending) || 0 : Number(b.amount) || 0 };
  });
};
const BILL_TXT: Record<string, string> = { gpout: "GP done, dispatch baaki", partial: "GP partly done", pending: "GP Out baaki" };
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
  if (isWorkingDay(t) && t <= cutoff) {
    const open = new Date(t); open.setHours(10, 30, 0, 0); // office 10:30 se pehle aaya → 11:00 AM
    return new Date(Math.max(t.getTime(), open.getTime()) + addMs);
  }
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

// ---------- Hold Approval alerts (Telegram DM) ----------
// Naya hold -> us party ke SALESMAN ko (commitment bharo); commitment aate hi APPROVER (Deepak) ko.
// Chat id master user list (public.users.telegram_chat_id) se. Pehle FMS bot, na chale to Score System bot
// (chat id kisi bhi bot ka ho sakta hai — jis bot ko user ne /start kiya hai wahi DM bhej sakta hai).
const APP_URL = Deno.env.get("FMS_APP_URL") || "https://ace-crm-fms.vercel.app"; // ?hold=<case id> = seedha commitment form
const normPerson = (s: unknown) => String(s || "").toLowerCase().replace(/\s*\(.*\)\s*$/, "").replace(/[.]+$/, "").replace(/\s+/g, " ").trim();
const dmyIST = (v: unknown) => { const t = d(v); return t ? `${String(t.getDate()).padStart(2, "0")}/${String(t.getMonth() + 1).padStart(2, "0")} ${hm(t)}` : ""; };
async function holdAlerts() {
  // shuruaat fms_settings.hold_score.from se (19 Oct 2026) — usse pehle koi alert nahi
  const cfg = await sb("fms_settings?key=eq.hold_score&select=value");
  const from = new Date(cfg?.[0]?.value?.from || "2026-10-19T00:00:00+05:30").getTime();
  if (Date.now() < from) return { hold_new: 0, hold_approve: 0, note: "hold alerts start " + new Date(from).toISOString() };
  const cases = await sbAll("fms_hold_cases?select=*&released_at=is.null&order=id");
  const fresh = cases.filter((c: any) => !c.salesman_alerted_at && Date.now() - Math.max(new Date(c.hold_seen_at).getTime(), from) < 48 * H);
  const toApprove = cases.filter((c: any) => c.commit_at && !c.decision && !c.approver_alerted_at);
  if (!fresh.length && !toApprove.length) return { hold_new: 0, hold_approve: 0 };

  const [users, approvers, tgRow, ss] = await Promise.all([
    sbAll("users?select=id,user_name,telegram_chat_id&order=id"),
    sb("fms_users?select=email,employee_id&can_approve_hold=eq.true"),
    sb("fms_settings?key=eq.telegram&select=value"),
    sb("rpc/ss_secrets", { method: "POST", headers: { "Content-Profile": "score" }, body: "{}" }).catch(() => ({})),
  ]);
  // FMS bot, Score System bot, Checklist & Delegation bot (project secret) — jise user ne /start kiya ho
  const bots = [tgRow?.[0]?.value?.token, (ss as any)?.TELEGRAM_BOT_TOKEN, Deno.env.get("TELEGRAM_BOT_TOKEN")].filter(Boolean);
  const chatOfName = (name: unknown) => users.find((u: any) => normPerson(u.user_name) === normPerson(name) && String(u.telegram_chat_id || "").trim())?.telegram_chat_id;
  const chatOfEmp = (id: unknown) => users.find((u: any) => u.id === id && String(u.telegram_chat_id || "").trim())?.telegram_chat_id;
  const dm = async (chat: unknown, text: string) => {
    for (const tok of bots) {
      try {
        const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: String(chat).trim(), text: text.slice(0, 4000) }),
        });
        if ((await r.json()).ok) return true;
      } catch (_e) { /* agla bot try karo */ }
    }
    return false;
  };
  const sos = [...new Set(cases.map((c: any) => c.mobile_so_no))];
  const infoRows = sos.length ? await sbAll(`fms_orders?select=mobile_so_no,hold_info&mobile_so_no=in.(${sos.join(",")})&order=mobile_so_no`) : [];
  const info = new Map(infoRows.map((r: any) => [r.mobile_so_no, r.hold_info || {}]));
  const patch = (id: number, body: any) => sb(`fms_hold_cases?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(body) });

  // TEST mode (hold_score.test_user = public.users id): har alert sirf us user ko, upar likha "asli me kise jaata".
  // Asli salesman_alerted_at / approver_alerted_at nahi chhedte — live karne par salesman ko phir bhi jayega.
  // Ek case ka test alert ek hi baar (fms_alert_log: so_no = 'hold:<case id>').
  const testUser = cfg?.[0]?.value?.test_user;
  if (testUser) {
    const chat = chatOfEmp(Number(testUser));
    if (!chat) return { hold_new: 0, hold_approve: 0, note: "test_user ki chat id nahi" };
    const logRows = await sbAll(`fms_alert_log?select=so_no,alert_type&so_no=like.hold:*&order=so_no`);
    const done = new Set(logRows.map((r: any) => r.so_no + "|" + r.alert_type));
    const log = (c: any, type: string) => sb("fms_alert_log?on_conflict=so_no,alert_type", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify([{ so_no: `hold:${c.id}`, alert_type: type }]) });
    let tNew = 0, tApprove = 0;
    for (const c of fresh) {
      if (done.has(`hold:${c.id}|hold_test_new`)) continue;
      const hi: any = info.get(c.mobile_so_no) || {};
      const text = [
        `[TEST] Asli me jayega: ${c.salesman || "-"} (chat id ${chatOfName(c.salesman) ? "hai" : "NAHI"})`,
        `HOLD ORDER — party se baat karke commitment bharo`,
        `Party: ${c.party || ""}`,
        `SO: ${c.so_no || ""} (#${c.mobile_so_no}) | ${inr(c.amount)}`,
        `Closing balance: ${inr(hi.closing_balance)} | PDC: ${inr(hi.pdc_amount)} | Credit limit: ${inr(hi.credit_limit)}`,
        hi.remarks ? `Remark: ${hi.remarks}` : "",
        `Target: ${dmyIST(c.commit_planned_at)} tak`,
        `Commitment bharo: ${APP_URL}/?hold=${c.id}`,
      ].filter(Boolean).join("\n");
      if (await dm(chat, text)) { await log(c, "hold_test_new"); tNew++; }
    }
    for (const c of toApprove) {
      if (done.has(`hold:${c.id}|hold_test_approve`)) continue;
      const names = (approvers || []).map((a: any) => users.find((u: any) => u.id === a.employee_id)?.user_name || a.email).join(", ");
      const text = [
        `[TEST] Asli me jayega: ${names || "-"} (approver)`,
        `HOLD APPROVAL PENDING`,
        `Party: ${c.party || ""} | SO: ${c.so_no || ""} (#${c.mobile_so_no}) | ${inr(c.amount)}`,
        `Commitment: ${inr(c.commit_amount)} by ${c.commit_date || ""} | ${c.pay_through || ""} | Reminder: ${c.reminder ? "Yes" : "No"}`,
        c.remarks ? `Remark: ${c.remarks}` : "",
        `Salesman: ${c.salesman || ""} | Target: ${dmyIST(c.approve_planned_at)} tak`,
        `Approve / Reject: ${APP_URL} (Today Work -> Hold Approval)`,
      ].filter(Boolean).join("\n");
      if (await dm(chat, text)) { await log(c, "hold_test_approve"); tApprove++; }
    }
    return { test_user: testUser, hold_new: tNew, hold_approve: tApprove };
  }

  let sentNew = 0, sentApprove = 0;
  for (const c of fresh) {
    const chat = chatOfName(c.salesman);
    if (!chat) continue; // chat id nahi — add hote hi agle run me (48 ghante tak) chala jayega
    const hi: any = info.get(c.mobile_so_no) || {};
    const text = [
      `HOLD ORDER — party se baat karke commitment bharo`,
      `Party: ${c.party || ""}`,
      `SO: ${c.so_no || ""} (#${c.mobile_so_no}) | ${inr(c.amount)}`,
      `Closing balance: ${inr(hi.closing_balance)} | PDC: ${inr(hi.pdc_amount)} | Credit limit: ${inr(hi.credit_limit)}`,
      hi.remarks ? `Remark: ${hi.remarks}` : "",
      `Target: ${dmyIST(c.commit_planned_at)} tak`,
      `Commitment bharo: ${APP_URL}/?hold=${c.id}`,
    ].filter(Boolean).join("\n");
    if (await dm(chat, text)) { await patch(c.id, { salesman_alerted_at: new Date().toISOString() }); sentNew++; }
  }
  for (const c of toApprove) {
    const text = [
      `HOLD APPROVAL PENDING`,
      `Party: ${c.party || ""} | SO: ${c.so_no || ""} (#${c.mobile_so_no}) | ${inr(c.amount)}`,
      `Commitment: ${inr(c.commit_amount)} by ${c.commit_date || ""} | ${c.pay_through || ""} | Reminder: ${c.reminder ? "Yes" : "No"}`,
      c.remarks ? `Remark: ${c.remarks}` : "",
      `Salesman: ${c.salesman || ""} | Target: ${dmyIST(c.approve_planned_at)} tak`,
      `Approve / Reject: ${APP_URL} (Today Work -> Hold Approval)`,
    ].filter(Boolean).join("\n");
    let any = false;
    for (const a of approvers || []) { const chat = chatOfEmp(a.employee_id); if (chat && await dm(chat, text)) any = true; }
    if (any) { await patch(c.id, { approver_alerted_at: new Date().toISOString() }); sentApprove++; }
  }
  return { hold_new: sentNew, hold_approve: sentApprove };
}

Deno.serve(async (req) => {
  try {
    let mode = new URL(req.url).searchParams.get("mode") || "";
    if (!mode && req.method === "POST") { try { mode = (await req.json())?.mode || ""; } catch (_e) { /* body nahi */ } }
    mode = mode || "instant";
    const now = nowIST();

    if (mode === "holddiag") {
      // koi message nahi bhejta — sirf getChat: kaunsa bot kis user (salesman / approver) tak pahunch sakta hai
      const [users, tgRow, ss] = await Promise.all([
        sbAll("users?select=id,user_name,telegram_chat_id&telegram_chat_id=not.is.null&order=id"),
        sb("fms_settings?key=eq.telegram&select=value"),
        sb("rpc/ss_secrets", { method: "POST", headers: { "Content-Profile": "score" }, body: "{}" }).catch(() => ({})),
      ]);
      const bots: [string, string | undefined][] = [["fms", tgRow?.[0]?.value?.token], ["score", (ss as any)?.TELEGRAM_BOT_TOKEN], ["checklist", Deno.env.get("TELEGRAM_BOT_TOKEN")]];
      const out: any[] = [];
      for (const u of users) {
        const chat = String(u.telegram_chat_id || "").trim();
        if (!chat) continue;
        const ok: string[] = [];
        for (const [name, tok] of bots) {
          if (!tok) continue;
          try { if ((await (await fetch(`https://api.telegram.org/bot${tok}/getChat?chat_id=${encodeURIComponent(chat)}`)).json()).ok) ok.push(name); } catch (_e) { /* skip */ }
        }
        out.push({ id: u.id, user: u.user_name, reachable_by: ok });
      }
      return new Response(JSON.stringify({ ok: true, bots: bots.filter((b) => b[1]).map((b) => b[0]), users: out }), { headers: { "Content-Type": "application/json" } });
    }

    if (mode === "hold") {
      const r = await holdAlerts();
      return new Response(JSON.stringify({ ok: true, ...r }), { headers: { "Content-Type": "application/json" } });
    }

    if (mode === "dispatch") {
      // BILL-WISE (app ke Today Work jaisa): bill bana par nikla nahi — har bill apni line; hold wale bahar
      const orders = await sbAll("fms_orders?select=mobile_so_no,account_name,salesman,billing_date,desp_date,bill_net_amount,sorder_amount,on_hold,bills,products,bills_payment&desp_date=is.null&cancelled=eq.false&on_hold=not.is.true&order=mobile_so_no");
      const due: any[] = [];
      for (const o of orders) {
        const bs = billsOf(o).filter((b) => b.status !== "dispatched");
        if (bs.length) due.push(...bs.map((b) => ({ o, b })));
        else if (o.billing_date && !(Array.isArray(o.bills) && o.bills.length)) due.push({ o, b: null });
      }
      if (!due.length) return new Response(JSON.stringify({ ok: true, sent: false, note: "koi dispatch pending nahi" }), { headers: { "Content-Type": "application/json" } });
      const nOrders = new Set(due.map((x) => x.o.mobile_so_no)).size;
      const L = [`DISPATCH REMINDER (2 PM) — 4 baje se pehle nikalna hai (bill-wise):`, ""];
      for (const x of due.slice(0, 15)) {
        const o = x.o, b = x.b;
        L.push(b ? `- Bill ${b.bill_no} | ${o.account_name} | ${inr(b.amount)} | ${BILL_TXT[b.status] || b.status}${b.gp_nos.length ? " (GP " + b.gp_nos.join(",") + ")" : ""} | #${o.mobile_so_no} | ${o.salesman || ""}`
          : `- #${o.mobile_so_no} | ${o.account_name} | ${inr(o.bill_net_amount || o.sorder_amount)} | ${o.salesman || ""}`);
      }
      if (due.length > 15) L.push(`...aur ${due.length - 15} bills`);
      L.push("", `Total pending dispatch: ${due.length} bills | ${nOrders} orders`);
      await sendTG(L.join("\n"));
      return new Response(JSON.stringify({ ok: true, sent: true, dispatchPending: due.length, dispatchOrders: nOrders }), { headers: { "Content-Type": "application/json" } });
    }

    // mode=instant
    const [orders, wd, hd, log] = await Promise.all([
      sbAll("fms_orders?select=mobile_so_no,account_name,mobile_no,salesman,mobile_so_created,so_convert_date,sorder_amount,mobile_so_amount&cancelled=eq.false&order=mobile_so_no"),
      sbAll("working_day_calender?select=working_date&order=working_date"),
      sb("holidays?select=holiday_date"),
      sbAll("fms_alert_log?select=so_no,alert_type&order=so_no,alert_type"),
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

    let hold: any = null;
    try { hold = await holdAlerts(); } catch (e) { hold = { error: String(e) }; }

    return new Response(JSON.stringify({ ok: true, sent: parts.length > 0, newOrders: newLines.length, confirmLate: lateLines.length, loggedRows: newLog.length, hold }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
