// FMS proxy: fetches ERP APIs server-side and returns JSON with CORS headers.
// ERP URLs fms_settings (key='erp') se aate hain: { "so_url": "...", "stock_url": "..." }
// — URL badalna ho to sirf wahi row update karo, redeploy ki zaroorat nahi.
const DEFAULTS: Record<string, string> = {
  so: "http://eksai12.ddns.net:8786/ek_api/telegramApi/MobileSO.ashx",
  stock: "http://eksai12.ddns.net:8786/ek_api/telegramApi/ProductStock.ashx",
};

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function getSources(): Promise<Record<string, string>> {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/fms_settings?key=eq.erp&select=value`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
    });
    const j = await r.json();
    const v = j?.[0]?.value || {};
    return { so: v.so_url || DEFAULTS.so, stock: v.stock_url || DEFAULTS.stock };
  } catch {
    return DEFAULTS;
  }
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = new URL(req.url);
    const src = url.searchParams.get("src") ?? "so";
    const sources = await getSources();
    const target = sources[src];
    if (!target) {
      return new Response(JSON.stringify({ error: "unknown src" }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    const upstream = await fetch(target, { signal: AbortSignal.timeout(120000) });
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 502,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
