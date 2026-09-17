// FMS collection sync: poore ledger ka party-wise outstanding (PaymentFollowup + UrgentPaymentFollow)
// -> fms_collection table. Cron har ghante isko call karta hai. Collection tab isi se chalta hai.
const DEFAULTS = {
  payfup: "http://eksai12.ddns.net:8786/ek_api/googleAutomation/PaymentFollowup.ashx",
  urgent: "http://eksai12.ddns.net:8786/ek_api/googleAutomation/UrgentPaymentFollow.ashx",
};

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

const norm = (s: unknown) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
const num = (v: unknown) => { const n = Number(String(v ?? "").replace(/,/g, "")); return isNaN(n) ? 0 : n; };
const MONTHS: Record<string, number> = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
// '13-Aug-26' -> '2026-08-13'
function dmy(s: unknown) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/.exec(String(s || "").trim());
  if (!m || !MONTHS[m[2]]) return null;
  return `20${m[3]}-${String(MONTHS[m[2]]).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

const BUCKETS: [string, string][] = [
  ["0 - 30 Days", "b0_30"], ["31 - 60 Days", "b31_60"], ["61 - 90 Days", "b61_90"],
  ["91 - 120 Days", "b91_120"], ["121 - 150 Days", "b121_150"], ["151 - 180 Days", "b151_180"], ["Above 180 Days", "b180p"],
];

Deno.serve(async () => {
  try {
    const erpRow = await sb("fms_settings?key=eq.erp&select=value");
    const cfg = erpRow?.[0]?.value || {};
    const URL_PAYFUP = cfg.payfup_url || DEFAULTS.payfup;
    const URL_URGENT = cfg.urgent_url || DEFAULTS.urgent;

    const [pf, ug] = await Promise.all([
      fetch(URL_PAYFUP, { signal: AbortSignal.timeout(180000) }).then((r) => r.json()),
      fetch(URL_URGENT, { signal: AbortSignal.timeout(180000) }).then((r) => r.json()),
    ]);
    const pfRows = Array.isArray(pf) ? pf : pf?.DataRec || [];
    const ugRows = Array.isArray(ug) ? ug : ug?.DataRec || [];
    if (!pfRows.length && !ugRows.length) throw new Error("dono APIs se 0 rows — sync skip");

    const runAt = new Date().toISOString();
    const map = new Map<string, any>();

    // 1) PaymentFollowup: party-level summary
    for (const r of pfRows) {
      const key = norm(r.PartyName);
      if (!key) continue;
      const amts = String(r.PendingAmt || "").split(",").map((x) => num(x)).filter((x) => x);
      const dates = String(r.VouDate || "").split(",").map((x) => dmy(x));
      const days = String(r.BillDays || "").split(",").map((x) => num(x));
      map.set(key, {
        party_name: String(r.PartyName || "").trim(),
        mobile: String(r.MobileNo || "").trim() || null,
        salesman: String(r.EmployeeName || "").trim() || null,
        beat: null,
        city: String(r.City || "").trim() || null,
        total_pending: amts.reduce((a, b) => a + b, 0),
        oldest_od: num(r.Overdue) || null,
        bill_count: amts.length,
        credit_days: r.CreditDays ?? null,
        credit_limit: num(r.CreditLimit) || null,
        last_pay_amt: num(r.LastPayAmt) || null,
        last_pay_date: dmy(r.LastPayDate),
        aging: {},
        bills: amts.map((a, i) => ({ amt: a, date: dates[i] || null, days: days[i] || null })),
        has_pdc: false,
        synced_at: runAt,
      });
    }

    // 2) UrgentPaymentFollow: bill-wise detail + aging + PDC + notes (multi-company)
    const ugByParty = new Map<string, any[]>();
    for (const r of ugRows) {
      const key = norm(r.PartyName);
      if (!key) continue;
      if (!ugByParty.has(key)) ugByParty.set(key, []);
      ugByParty.get(key)!.push(r);
    }
    for (const [key, lines] of ugByParty) {
      let e = map.get(key);
      if (!e) {
        // party sirf Urgent me hai (dusri firm ya PayFup filter se bahar)
        e = {
          party_name: String(lines[0].PartyName || "").trim(),
          mobile: String(lines[0].Mobile || "").trim() || null,
          salesman: String(lines[0].EmployeeName || "").trim() || null,
          beat: null, city: null,
          total_pending: 0, oldest_od: null, bill_count: 0,
          credit_days: lines[0].AccountCreditDays ?? null,
          credit_limit: num(lines[0].CreditLimit) || null,
          last_pay_amt: num(lines[0].LastPayAmt) || null,
          last_pay_date: dmy(lines[0].LastPayDate),
          aging: {}, bills: [], has_pdc: false, synced_at: runAt,
        };
        e.total_pending = lines.reduce((a: number, l: any) => a + num(l.PendingAmt), 0);
        e.oldest_od = Math.max(...lines.map((l: any) => num(l.OD) || 0)) || null;
        e.bill_count = lines.length;
        map.set(key, e);
      }
      e.beat = e.beat || String(lines[0].Beat || "").trim() || null;
      const aging: Record<string, number> = {};
      for (const [, dst] of BUCKETS) aging[dst] = 0;
      const bills: any[] = [];
      for (const l of lines) {
        for (const [src, dst] of BUCKETS) aging[dst] += num(l[src]);
        const pdc = String(l.PdcRcpt || "").trim() || String(l.PdcDate || "").trim();
        if (pdc) e.has_pdc = true;
        bills.push({
          vno: String(l.VNo || "").trim(),
          company: String(l.CompanyName || "").trim(),
          date: dmy(l.VouDate),
          days: num(l.BillDays) || null,
          od: num(l.OD) || null,
          amt: num(l.VouAmt) || null,
          pending: num(l.PendingAmt) || 0,
          bilty: String(l.BiltyNo || "").trim() || null,
          pdc_rcpt: String(l.PdcRcpt || "").trim() || null,
          pdc_date: dmy(l.PdcDate),
          notes: String(l.Notes || "").trim() || null,
        });
      }
      e.aging = aging;
      // Urgent zyada complete hai (saari firms) — bills/detail wahi use karo
      e.bills = bills.sort((a, b) => (b.od || 0) - (a.od || 0));
      e.bill_count = bills.length;
      const ugTotal = bills.reduce((a, b) => a + (b.pending || 0), 0);
      if (ugTotal > (e.total_pending || 0)) e.total_pending = ugTotal;
    }

    const payload = [...map.values()];
    // 500 ke batches me upsert (row size ki wajah se)
    for (let i = 0; i < payload.length; i += 500) {
      await sb("fms_collection?on_conflict=party_name", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(payload.slice(i, i + 500)),
      });
    }
    // jo parties ab list me nahi (poora paid) — hata do
    await sb(`fms_collection?synced_at=lt.${encodeURIComponent(runAt)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });

    const total = payload.reduce((a, p) => a + (p.total_pending || 0), 0);
    return new Response(JSON.stringify({ ok: true, parties: payload.length, total_pending: Math.round(total), at: runAt }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
