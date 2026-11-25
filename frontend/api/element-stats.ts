// Vercel serverless function: live Element market stats for the AXR collection.
//
// Why a function and not a direct browser call: Element's open API needs an
// X-api-key header, and a key baked into the client bundle would be public
// (anyone could burn the 120 req/min quota). The key lives in the Vercel
// project as ELEMENT_API_KEY (Settings -> Environment Variables) and never
// reaches the browser. Without a key this returns 503 and the site shows
// dashes + the Element link instead of failing.
//
// Element open API: https://api.element.market/openapi/ — key by request at
// https://forms.gle/78wpggURGADCjshr7 (see docs.element.market/developer/public-api).
// Endpoint confirmed to exist (400 "Missing Header: X-api-key" without one);
// exact param/response shape is parsed tolerantly below because it is only
// observable with a key.

const CHAIN_ID = 56; // BNB Chain
const COLLECTION = "0xBdd7Db43BdDB4CbE288c31A367a187B2Cae1138A";

function pick(obj: any, names: string[]): number | null {
  if (!obj || typeof obj !== "object") return null;
  for (const n of names) {
    const v = obj[n];
    if (v === undefined || v === null || v === "") continue;
    const num = Number(v);
    if (!Number.isFinite(num)) continue;
    // Values may come back in wei (huge) or BNB (small float).
    return num > 1e6 ? num / 1e18 : num;
  }
  return null;
}

function pickInt(obj: any, names: string[]): number | null {
  const v = pick(obj, names);
  return v === null ? null : Math.round(v);
}

export default async function handler(req: any, res: any) {
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
  const key = process.env.ELEMENT_API_KEY;
  if (!key) {
    return res.status(503).json({ ok: false, reason: "no-key" });
  }
  try {
    const url =
      `https://api.element.market/openapi/v1/collection/stats` +
      `?chainId=${CHAIN_ID}&collectionAddress=${COLLECTION}`;
    const r = await fetch(url, { headers: { "X-api-key": key } });
    if (!r.ok) {
      return res.status(502).json({ ok: false, reason: "element-error", status: r.status });
    }
    const j: any = await r.json();
    const d = j?.data ?? j ?? {};
    return res.status(200).json({
      ok: true,
      floorBnb: pick(d, ["floorPrice", "floor_price", "floor", "minPrice", "min_price"]),
      vol24hBnb: pick(d, ["volume24h", "volume_24h", "dayVolume", "volume24H", "vol24h"]),
      totalVolBnb: pick(d, ["totalVolume", "total_volume", "volume", "allVolume", "totalVol"]),
      listed: pickInt(d, ["listedCount", "listed_count", "listed", "onSaleCount", "on_sale_count"]),
      owners: pickInt(d, ["ownerCount", "owner_count", "owners", "holderCount", "holders"]),
    });
  } catch (e: any) {
    return res.status(502).json({ ok: false, reason: "fetch-failed", detail: String(e?.message ?? e) });
  }
}
