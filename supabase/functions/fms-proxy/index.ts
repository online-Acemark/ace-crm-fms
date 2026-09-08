// FMS proxy: fetches ERP APIs server-side and returns JSON with CORS headers
const SOURCES: Record<string, string> = {
  so: "http://eksai12.ddns.net:8786/ek_api/telegramApi/MobileSO.ashx",
  stock: "http://eksai12.ddns.net:8786/ek_api/telegramApi/ProductStock.ashx",
};

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
    const target = SOURCES[src];
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
