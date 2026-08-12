import { env } from "cloudflare:workers";
import { getDb } from "../../../db";
import { runScan } from "../../../worker/engine";

// Manual trigger for local testing only. In production the Cron Trigger in
// wrangler.jsonc calls the same runScan() every 5 minutes via worker/index.ts.
export async function POST() {
  const apiKey = (env as unknown as { FINNHUB_API_KEY?: string }).FINNHUB_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "FINNHUB_API_KEY is not set. Add it to .dev.vars locally." }, { status: 501 });
  }
  try {
    await runScan(getDb(), apiKey, new Date());
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Scan failed." }, { status: 500 });
  }
}
