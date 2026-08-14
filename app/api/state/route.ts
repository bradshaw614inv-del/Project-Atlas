import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { accountState, marketWeatherLog, scanRuns } from "../../../db/schema";
import { DEFAULT_MAX_OPEN_POSITIONS } from "../../../worker/positions";

export async function GET() {
  const db = getDb();
  const [account] = await db.select().from(accountState).where(eq(accountState.id, 1)).limit(1);
  const [weather] = await db.select().from(marketWeatherLog).orderBy(desc(marketWeatherLog.id)).limit(1);
  const [lastScan] = await db.select().from(scanRuns).orderBy(desc(scanRuns.id)).limit(1);
  const recentScans = await db.select().from(scanRuns).orderBy(desc(scanRuns.id)).limit(12);

  return Response.json({
    account: account ?? null,
    weather: weather ? { ...weather, flags: JSON.parse(weather.reasonFlags || "[]") } : null,
    lastScan: lastScan ?? null,
    collectionHealth: {
      recentScans,
      totalRecentStories: recentScans.reduce((sum, scan) => sum + scan.storiesFetched, 0),
      totalRecentCandidates: recentScans.reduce((sum, scan) => sum + scan.candidatesEvaluated, 0),
      healthy: !!lastScan?.finishedAt && !lastScan.error && Date.now() - new Date(lastScan.startedAt).getTime() < 15 * 60 * 1000,
    },
  });
}

export async function POST(request: Request) {
  const body = (await request.json()) as { startingCapital?: number; maxOpenPositions?: number; riskPerTradePct?: number };
  const startingCapital = Number(body.startingCapital);
  const riskPerTradePct = Number(body.riskPerTradePct);
  if (!Number.isFinite(startingCapital) || startingCapital <= 0) {
    return Response.json({ error: "startingCapital must be a positive number." }, { status: 400 });
  }
  if (!Number.isFinite(riskPerTradePct) || riskPerTradePct <= 0 || riskPerTradePct > 5) {
    return Response.json({ error: "riskPerTradePct must be between 0 and 5." }, { status: 400 });
  }

  const db = getDb();
  const existing = await db.select({ id: accountState.id }).from(accountState).where(eq(accountState.id, 1)).limit(1);
  if (existing.length === 0) {
    await db.insert(accountState).values({ id: 1, startingCapital, maxOpenPositions: DEFAULT_MAX_OPEN_POSITIONS, riskPerTradePct });
  } else {
    await db.update(accountState).set({ startingCapital, maxOpenPositions: DEFAULT_MAX_OPEN_POSITIONS, riskPerTradePct, updatedAt: new Date().toISOString() }).where(eq(accountState.id, 1));
  }
  return Response.json({ ok: true });
}
