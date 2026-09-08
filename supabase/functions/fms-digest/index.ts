// FMS daily digest: roz subah team ke Telegram par due-list bhejta hai.
// Bot token/chat_id fms_settings (key='telegram') me: { "token": "...", "chat_id": "..." }
const IST = 5.5 * 3600 * 1000;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const sb = async (path: string) => {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
};

const d = (v: unknown) => {
  if (!v) return null;
  const dt = new Date(v as string);
  if (isNaN(dt.getTime())) return null;
  return /z$|[+-]\d\d:?\d\d$/i.test(String(v)) ? new Date(dt.getTime() + IST) : dt;
};
const nowIST = () => new Date(Date.now() + IST);
const inr = (v: unknown) => "Rs." + Number(v || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });
const dmy = (dt: Date) => `${String(dt.getDate()).padStart(2, "0")}/${String(dt.getMonth() + 1).padStart(2, "0")}`;

Deno.serve(async () => {
  try {
    const settings = await sb("fms_settings?key=eq.telegram&select=value");
    const tg = settings?.[0]?.value;
    if (!tg?.token || !tg?.chat_id) {
      return new Response(JSON.stringify({ ok: false, error: "fms_settings me key='telegram' set karo: { token, chat_id }" }), { status: 400, headers: { "Content-Type": "application/json" } });
    }

    const orders = await sb("fms_orders?select=mobile_so_no,account_name,mobile_no,acc_family,salesman,so_convert_date,billing_date,desp_date,credit_days,bill_net_amount,sorder_amount,payment_complete,next_followup_date,mobile_so_created");
    const now = nowIST();
    const noFup = (o: any) => String(o.acc_family || "").trim().toUpperCase() === "N";

    const confirmPending = orders.filter((o: any) => !o.so_convert_date);
    const billingPending = orders.filter((o: any) => o.so_convert_date && !o.billing_date);
    const dispatchDue = orders.filter((o: any) => o.billing_date && !o.desp_date);

    const overdue = orders
      .filter((o: any) => !o.payment_complete && !noFup(o) && o.billing_date && o.credit_days != null)
      .map((o: any) => {
        const due = new Date((d(o.billing_date) as Date).getTime() + o.credit_days * 864e5);
        const days = Math.floor((now.getTime() - due.getTime()) / 864e5);
        return { ...o, due, days };
      })
      .filter((o: any) => o.days > 0)
      .sort((a: any, b: any) => b.days - a.days);

    const fupToday = orders.filter((o: any) => !o.payment_complete && !noFup(o) && o.next_followup_date && (d(o.next_followup_date) as Date) <= now);

    const L: string[] = [];
    L.push(`FMS Digest — ${dmy(now)} subah`);
    L.push("");
    L.push(`Aaj ke kaam:`);
    L.push(`- Naye orders confirm karne hain: ${confirmPending.length}`);
    L.push(`- Billing pending: ${billingPending.length}`);
    L.push(`- Dispatch due: ${dispatchDue.length}`);
    L.push(`- Payment overdue parties: ${overdue.length}`);
    L.push(`- Follow-up aaj due: ${fupToday.length}`);

    if (fupToday.length) {
      L.push("");
      L.push(`AAJ KE FOLLOW-UP (${fupToday.length}):`);
      for (const o of fupToday.slice(0, 10)) {
        L.push(`- ${o.account_name} | #${o.mobile_so_no} | ${o.mobile_no || ""} | ${o.salesman || ""}`);
      }
      if (fupToday.length > 10) L.push(`  ...aur ${fupToday.length - 10}`);
    }

    if (overdue.length) {
      L.push("");
      const totalOut = overdue.reduce((a: number, o: any) => a + Number(o.bill_net_amount || o.sorder_amount || 0), 0);
      L.push(`PAYMENT OVERDUE (${overdue.length} | ${inr(totalOut)}):`);
      for (const o of overdue.slice(0, 10)) {
        L.push(`- ${o.days}d late | ${o.account_name} | ${inr(o.bill_net_amount || o.sorder_amount)} | #${o.mobile_so_no} | ${o.mobile_no || ""} | ${o.salesman || ""}`);
      }
      if (overdue.length > 10) L.push(`  ...aur ${overdue.length - 10} parties`);
    }

    if (confirmPending.length) {
      L.push("");
      L.push(`CONFIRM PENDING (${confirmPending.length}):`);
      for (const o of confirmPending.slice(0, 5)) {
        const t = d(o.mobile_so_created);
        L.push(`- ${o.account_name} | #${o.mobile_so_no}${t ? " | aaya " + dmy(t) : ""}`);
      }
    }

    L.push("");
    L.push("Pura detail: CRM FMS app kholo.");
    const text = L.join("\n").slice(0, 4000);

    const tgRes = await fetch(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: tg.chat_id, text }),
    });
    const tgJson = await tgRes.json();
    if (!tgJson.ok) throw new Error("Telegram: " + JSON.stringify(tgJson));

    return new Response(JSON.stringify({ ok: true, sent: true, counts: { confirm: confirmPending.length, billing: billingPending.length, dispatch: dispatchDue.length, overdue: overdue.length, fupToday: fupToday.length } }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
