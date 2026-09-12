// FMS auto-sync: ERP MobileSO -> fms_orders (server-side). Cron har 30 min isko call karta hai.
// Logic client ke src/lib/fms.js ka mirror hai — wahan rule badle to yahan bhi badalna.
// ERP URLs fms_settings (key='erp') se aate hain: { "so_url": "...", "stock_url": "..." }
const ERP_DEFAULTS = {
  so: "http://eksai12.ddns.net:8786/ek_api/telegramApi/MobileSO.ashx",
  stock: "http://eksai12.ddns.net:8786/ek_api/telegramApi/ProductStock.ashx",
  payment: "http://eksai12.ddns.net:8786/ek_api/telegramApi/Payment.ashx",
};
const IST = 5.5 * 3600 * 1000; // function UTC me chalta hai; ERP dates IST wall-clock naked strings hain
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

// DB ke timestamptz (Z/+00 wale) IST frame me shift; ERP ke naked strings waise hi (env UTC me wall-clock ban jate hain)
const d = (v: unknown) => {
  if (!v) return null;
  const dt = new Date(v as string);
  if (isNaN(dt.getTime())) return null;
  return /z$|[+-]\d\d:?\d\d$/i.test(String(v)) ? new Date(dt.getTime() + IST) : dt;
};
const nowIST = () => new Date(Date.now() + IST);

const splitTwo = (v: string) => {
  const s = (v || "").trim();
  if (!s) return ["", ""];
  const parts = s.split(/\s*[/;,]\s*/).map((x) => x.trim()).filter(Boolean);
  return [parts[0] || "", parts.slice(1).join(" / ") || ""];
};

const ymd = (dt: Date) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;

let workingDaySet: Set<string> | null = null;
let stockMap: Record<string, number> | null = null;

const isWorkingDay = (dt: Date) => (workingDaySet ? workingDaySet.has(ymd(dt)) : dt.getDay() !== 0);
const nextWorkingDay = (from: Date) => {
  let day = new Date(from); day.setHours(0, 0, 0, 0);
  for (let i = 0; i < 60; i++) { day = new Date(day.getTime() + 864e5); if (isWorkingDay(day)) break; }
  return day;
};

const SO_CUTOFF = [19, 30], NEXT_DAY_START = [10, 30], BILL_CUTOFF = [16, 0];

function soConvertPlanned(t: Date | null, plannedHours: number | null) {
  if (!t) return null;
  const addMs = (plannedHours != null ? Number(plannedHours) : 0.5) * H;
  const cutoff = new Date(t); cutoff.setHours(SO_CUTOFF[0], SO_CUTOFF[1], 0, 0);
  if (isWorkingDay(t) && t <= cutoff) return new Date(t.getTime() + addMs);
  const day = nextWorkingDay(t);
  day.setHours(NEXT_DAY_START[0], NEXT_DAY_START[1], 0, 0);
  return new Date(day.getTime() + addMs);
}

function stockAvailableFor(o: any) {
  if (!stockMap) return null;
  const ps = o.products || [];
  if (!ps.length) return null;
  for (const p of ps) {
    const s = stockMap[String(p.code || "").trim().toLowerCase()];
    if (s == null || s < (Number(p.qty) || 0)) return false;
  }
  return true;
}

function billingPlanned(base: Date | null, o: any) {
  if (!base) return null;
  const avail = stockAvailableFor(o);
  if (avail == null) return null;
  const cut = new Date(base); cut.setHours(BILL_CUTOFF[0], BILL_CUTOFF[1], 0, 0);
  let day: Date;
  if (avail && isWorkingDay(base) && base <= cut) day = new Date(base);
  else day = nextWorkingDay(base);
  day.setHours(BILL_CUTOFF[0], BILL_CUTOFF[1], 0, 0);
  return day;
}

// ---------- ERP Payment.ashx: bill-wise payment reconciliation ----------
const nums = (v: unknown) => (v == null || v === "" ? 0 : Number(v) || 0);
const MONTHS: Record<string, number> = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
// '20-Feb-26' -> '2026-02-20'
function parsePayDate(s: unknown) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  const mo = MONTHS[m[2]];
  if (!mo) return null;
  return `20${m[3]}-${String(mo).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}
const tailOf = (bn: unknown) => {
  const m = /(\d+)\s*$/.exec(String(bn || ""));
  return m ? String(Number(m[1])) : null;
};
const norm = (s: unknown) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

// index: tail -> Map(full BillNo -> payment rows)
let payIdx: Map<string, Map<string, any[]>> | null = null;
function buildPayIdx(rows: any[]) {
  payIdx = new Map();
  for (const r of rows) {
    const t = tailOf(r.BillNo);
    if (!t) continue;
    let m = payIdx.get(t);
    if (!m) { m = new Map(); payIdx.set(t, m); }
    const k = String(r.BillNo);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
}

// ek bill ka payment summary; AS/AM series collision party name se resolve hoti hai
function billPayment(billNo: unknown, accountName: string) {
  if (!payIdx) return null;
  const m = payIdx.get(String(Number(billNo)) || String(billNo));
  if (!m) return null;
  // party name match HAMESHA zaroori — same number alag series/saal me alag party ka hota hai
  const groups = [...m.values()].filter((rows) => rows.some((r) => norm(r.PartyName) === norm(accountName)));
  if (groups.length !== 1) return null; // no match ya ambiguous — galat data se behtar hai skip
  const rows = groups[0];
  // NOTE: PaidAmt/TotalAdjusted VOUCHER-level hote hain (ek voucher kai bills cover karta hai) —
  // isliye per-bill hisaab BillAmt - StillPending se hota hai (dono bill-level hain)
  let anyFull = false, lastPay: string | null = null;
  const pendingVals: number[] = [];
  for (const r of rows) {
    if (r.PayStatus === "Full") anyFull = true;
    if (r.StillPending !== "" && r.StillPending != null) pendingVals.push(nums(r.StillPending));
    const pd = parsePayDate(r.PayDate);
    if (pd && (!lastPay || pd > lastPay)) lastPay = pd;
  }
  const billAmt = nums(rows[0].BillAmt);
  const pending = anyFull ? 0 : (pendingVals.length ? Math.min(...pendingVals) : billAmt);
  const received = Math.max(0, billAmt - pending);
  return { received, pending, status: anyFull ? "Full" : received > 0 ? "Part" : "Pending", lastPay };
}

function paymentDue(billDate: unknown, creditDays: number | null) {
  if (!billDate || creditDays == null) return null;
  let due = new Date((d(billDate) as Date).getTime() + creditDays * 24 * H);
  if (!isWorkingDay(due)) { const day = nextWorkingDay(due); day.setHours(due.getHours(), due.getMinutes(), 0, 0); due = day; }
  return due;
}

function aggregateSO(rows: any[]) {
  const map = new Map<string, any[]>();
  for (const r of rows) {
    const key = r.MobileAppSoNo;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(r);
  }
  const out: any[] = [];
  for (const [soNo, lines] of map) {
    const first = (f: string) => lines.map((l) => l[f]).find((v) => v != null && v !== "");
    // SO_Qty null/0 wali lines SO convert me drop ho chuki hain (item cancel) —
    // billing/GP out/dispatch ke completion check me unhe mat gino
    const activeLines = lines.filter((l) => Number(l.SO_Qty) > 0);
    const chk = activeLines.length ? activeLines : lines;
    const allHave = (f: string) => chk.every((l) => l[f] != null && l[f] !== "");
    const maxDate = (f: string) => { const vs = lines.map((l) => l[f]).filter(Boolean); return vs.length ? vs.sort().at(-1) : null; };
    const sum = (f: string) => lines.reduce((a, l) => a + (Number(l[f]) || 0), 0);
    const billMap = new Map<string, any>();
    for (const l of lines) {
      if (!l.BillNo) continue;
      const b = billMap.get(l.BillNo) || { bill_no: l.BillNo, billing_date: null, amt: 0, qty: 0, url: null, products: [] };
      b.amt = Number(l.BillNetAmount) || b.amt;
      b.billing_date = [b.billing_date, l.BillingDate].filter(Boolean).sort().at(-1) || null;
      b.url = b.url || l.InvUrl || null;
      b.qty += Number(l.BillQty) || 0;
      b.products.push({ name: l.ProductName, code: l.ProductCode, qty: l.BillQty ?? l.SO_Qty, unit: l.ProdUnit });
      billMap.set(l.BillNo, b);
    }
    const [cp1, cp2] = splitTwo(first("ContactPerson"));
    const [em1, em2] = splitTwo(first("EmailID"));
    out.push({
      mobile_so_no: soNo,
      sorder_no: first("SOrderNo") ?? null,
      account_name: first("AccountName") ?? "",
      mobile_no: first("MobileNo") ?? "",
      contact_person: cp1, contact_person2: cp2, email_id: em1, email_id2: em2,
      acc_family: (first("AccFamily") || "").trim(),
      salesman: (first("SalesMan_Cloud") || "").trim(),
      beat: (first("Beat") || "").trim(),
      mobile_so_created: first("MobileAppSoCreated") ?? null,
      so_convert_date: first("SoConvertDate") ?? null,
      billing_date: allHave("BillNo") ? maxDate("BillingDate") : null,
      gpout_created: allHave("GPOutNo") ? maxDate("GPOUTCreated") : null,
      desp_date: allHave("GPOutNo") && allHave("DespDate") ? maxDate("DespDate") : null,
      credit_days: first("CreditDays") ?? null,
      mobile_so_amount: first("MobileSoAmount") ?? null,
      sorder_amount: first("SorderAmount") ?? null,
      bill_net_amount: [...billMap.values()].reduce((a, b) => a + b.amt, 0) || null,
      so_qty: sum("SO_Qty") || null,
      mobile_qty: sum("MobileApp_Qty") || null,
      pending_qty: sum("PendingQty"),
      bill_qty: sum("BillQty") || null,
      line_count: lines.length,
      bill_nos: [...billMap.keys()],
      inv_urls: [...billMap.values()].map((b) => b.url),
      bills: [...billMap.values()].map(({ bill_no, billing_date, amt, qty, url, products }) => ({ bill_no, billing_date, amount: amt, qty, url, products })),
      products: lines.map((l) => ({ name: l.ProductName, code: l.ProductCode, qty: l.SO_Qty, pending: l.PendingQty, unit: l.ProdUnit, mqty: l.MobileApp_Qty, munit: l.MasterUnit, bqty: l.BillQty, bno: l.BillNo ?? null, gpno: l.GPOutNo ?? null, gpdt: l.GPOUTCreated ?? null, ddt: l.DespDate ?? null })),
    });
  }
  return out;
}

function computePipeline(o: any, stages: any[], scoring: any) {
  const res: Record<string, any> = {};
  let prevRef = d(o.mobile_so_created);
  const actualOf: Record<string, Date | null> = {
    so_convert: d(o.so_convert_date),
    billing: d(o.billing_date),
    gpout: d(o.gpout_created),
    dispatch: d(o.desp_date),
    payment: o.payment_complete ? d(o.payment_date) || nowIST() : null,
  };
  const now = nowIST();
  for (const st of stages.filter((s) => s.active)) {
    let planned: Date | null = null;
    if (st.stage_key === "so_convert") {
      planned = soConvertPlanned(d(o.mobile_so_created), st.planned_hours);
    } else if (st.stage_key === "billing") {
      planned = billingPlanned(prevRef, o);
      if (!planned && st.planned_hours != null && prevRef) planned = new Date(prevRef.getTime() + Number(st.planned_hours) * H);
    } else if (st.stage_key === "payment") {
      planned = paymentDue(o.billing_date, o.credit_days);
    } else if (st.use_cutoff) {
      const base = d(o.mobile_so_created);
      if (base) {
        const [ch, cm] = String(st.cutoff_time || "16:00").split(":").map(Number);
        const cut = new Date(base); cut.setHours(ch, cm, 0, 0);
        planned = new Date(base); planned.setHours(23, 59, 0, 0);
        if (base > cut) planned = new Date(planned.getTime() + 24 * H);
      }
    } else if (st.planned_hours != null && prevRef) {
      planned = new Date(prevRef.getTime() + Number(st.planned_hours) * H);
    }
    const actual = actualOf[st.stage_key] ?? null;
    let delayH: number | null = null, status = "na";
    if (planned) {
      if (actual) {
        delayH = Math.max(0, (actual.getTime() - planned.getTime()) / H);
        status = delayH <= (scoring?.grace_hours ?? 1) ? "ontime" : "late";
      } else if (now > planned) {
        delayH = (now.getTime() - planned.getTime()) / H;
        status = "running";
      } else {
        status = "pending";
      }
    } else if (actual) {
      status = "done";
    }
    res[st.stage_key] = { planned, actual, delayH, status, weight: Number(st.weight) || 1 };
    if (actual) prevRef = actual;
    else if (planned) prevRef = planned;
  }
  return res;
}

function computeScore(pipe: Record<string, any>, scoring: any) {
  const s = { on_time_points: 100, grace_hours: 1, penalty_per_hour: 2, min_points: 0, ...(scoring || {}) };
  let wsum = 0, total = 0, counted = 0;
  for (const k of Object.keys(pipe)) {
    const p = pipe[k];
    if (p.status === "na" || p.status === "pending") continue;
    let pts;
    if (p.status === "ontime" || (p.status === "done" && !p.delayH)) pts = s.on_time_points;
    else pts = Math.min(s.on_time_points, Math.max(s.min_points, s.on_time_points - (p.delayH - s.grace_hours) * s.penalty_per_hour));
    total += pts * p.weight;
    wsum += p.weight;
    counted++;
  }
  return counted ? Math.round(total / wsum) : null;
}

Deno.serve(async () => {
  try {
    const [stages, scoringRow, erpRow, wd, hd, existing] = await Promise.all([
      sb("fms_stage_config?select=*&order=sort_order"),
      sb("fms_settings?key=eq.scoring&select=value"),
      sb("fms_settings?key=eq.erp&select=value"),
      sb("working_day_calender?select=working_date"),
      sb("holidays?select=holiday_date"),
      sb("fms_orders?select=mobile_so_no,payment_complete,payment_date"),
    ]);
    const scoring = scoringRow?.[0]?.value || {};
    const erpCfg = erpRow?.[0]?.value || {};
    const ERP_SO = erpCfg.so_url || ERP_DEFAULTS.so;
    const ERP_STOCK = erpCfg.stock_url || ERP_DEFAULTS.stock;
    const ERP_PAYMENT = erpCfg.payment_url || ERP_DEFAULTS.payment;
    const hset = new Set((hd || []).map((r: any) => r.holiday_date));
    workingDaySet = new Set((wd || []).map((r: any) => r.working_date).filter((x: string) => !hset.has(x)));

    try {
      const sres = await fetch(ERP_STOCK, { signal: AbortSignal.timeout(120000) });
      const sjson = await sres.json();
      const srows = Array.isArray(sjson) ? sjson : sjson?.DataRec || [];
      stockMap = {};
      for (const r of srows) if (r.ProductCode) stockMap[String(r.ProductCode).trim().toLowerCase()] = Number(r.Total) || 0;
    } catch { stockMap = null; }

    // ERP payment reconciliation — fail ho to pay fields null rehte hain, sync nahi rukta
    try {
      const pres = await fetch(ERP_PAYMENT, { signal: AbortSignal.timeout(120000) });
      const pjson = await pres.json();
      const prows = Array.isArray(pjson) ? pjson : pjson?.DataRec || [];
      if (prows.length) buildPayIdx(prows);
    } catch { payIdx = null; }

    const res = await fetch(ERP_SO, { signal: AbortSignal.timeout(120000) });
    const json = await res.json();
    const raw = Array.isArray(json) ? json : json?.DataRec || [];
    if (!raw.length) throw new Error("ERP se 0 rows aaye — sync skip");

    const aggregated = aggregateSO(raw);
    const exMap = new Map((existing || []).map((e: any) => [e.mobile_so_no, e]));
    const payload = aggregated.map((o) => {
      // ERP payment data: order ke har bill ka summary jodkar
      let rec = 0, pen = 0, matched = 0, lastPay: string | null = null;
      const statuses: string[] = [];
      const billsPay: any[] = [];
      for (const bn of o.bill_nos || []) {
        const s = billPayment(bn, o.account_name);
        if (!s) continue;
        matched++;
        rec += s.received; pen += s.pending; statuses.push(s.status);
        billsPay.push({ bill_no: bn, status: s.status, received: s.received, pending: s.pending, last_pay: s.lastPay });
        if (s.lastPay && (!lastPay || s.lastPay > lastPay)) lastPay = s.lastPay;
      }
      o.payment_received_erp = matched ? rec : null;
      o.payment_pending_erp = matched ? pen : null;
      o.bills_payment = matched ? billsPay : null;
      o.pay_status = matched
        ? (matched === (o.bill_nos || []).length && statuses.every((x) => x === "Full") ? "Full" : rec > 0 ? "Part" : "Pending")
        : null;
      o.pay_last_date = lastPay;

      const ex = exMap.get(o.mobile_so_no);
      // ERP Full = payment complete (manual ✔ bhi respect hota hai)
      const merged = {
        ...o,
        payment_complete: ex?.payment_complete || o.pay_status === "Full",
        payment_date: ex?.payment_date || o.pay_last_date || null,
      };
      const pipe = computePipeline(merged, stages, scoring);
      const delays: Record<string, number> = {};
      for (const k of Object.keys(pipe)) if (pipe[k].delayH != null) delays[k] = Math.round(pipe[k].delayH * 100) / 100;
      return { ...o, delays, score: computeScore(pipe, scoring), synced_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    });

    await sb("fms_orders?on_conflict=mobile_so_no", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(payload),
    });

    return new Response(JSON.stringify({ ok: true, synced: payload.length, at: new Date().toISOString() }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
