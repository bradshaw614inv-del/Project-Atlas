import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db/index.ts";
import { accountState, accountTransactions, marketWeatherLog, scanRuns } from "../../../db/schema.ts";
import { DEFAULT_MAX_OPEN_POSITIONS } from "../../../worker/positions.ts";
import { isAccountRequestError, parseAccountRequest } from "../../../worker/account-requests.ts";

export async function GET() {
  const db = getDb();
  const [account] = await db.select().from(accountState).where(eq(accountState.id, 1)).limit(1);
  const [weather] = await db.select().from(marketWeatherLog).orderBy(desc(marketWeatherLog.id)).limit(1);
  const [lastScan] = await db.select().from(scanRuns).orderBy(desc(scanRuns.id)).limit(1);
  const recentScans = await db.select().from(scanRuns).orderBy(desc(scanRuns.id)).limit(12);
  const recentTransactions = await db.select().from(accountTransactions).orderBy(desc(accountTransactions.id)).limit(10);

  return Response.json({
    account: account ?? null,
    weather: weather ? { ...weather, flags: JSON.parse(weather.reasonFlags || "[]") } : null,
    lastScan: lastScan ?? null,
    recentTransactions,
    collectionHealth: {
      recentScans,
      totalRecentStories: recentScans.reduce((sum, scan) => sum + scan.storiesFetched, 0),
      totalRecentCandidates: recentScans.reduce((sum, scan) => sum + scan.candidatesEvaluated, 0),
      healthy: !!lastScan?.finishedAt && !lastScan.error && Date.now() - new Date(lastScan.startedAt).getTime() < 15 * 60 * 1000,
    },
  });
}

export async function POST(request: Request) {
  const body = (await request.json()) as { action?: string; amount?: number; maxOpenPositions?: number; riskPerTradePct?: number };

  // Validate before acquiring the database: a malformed request should never
  // reach D1, and this keeps the bounds testable on their own.
  const parsed = parseAccountRequest(body);
  if (isAccountRequestError(parsed)) {
    return Response.json({ error: parsed.error }, { status: parsed.status });
  }

  const db = getDb();

  if (parsed.kind === "ADD_FUNDS") {
    const [existingAccount] = await db.select().from(accountState).where(eq(accountState.id, 1)).limit(1);
    const currentCapital = existingAccount?.startingCapital ?? 10000;
    const balanceAfter = currentCapital + parsed.amount;
    if (!existingAccount) await db.insert(accountState).values({ id: 1, startingCapital: balanceAfter });
    else await db.update(accountState).set({ startingCapital: balanceAfter, updatedAt: new Date().toISOString() }).where(eq(accountState.id, 1));
    await db.insert(accountTransactions).values({ type: "CONTRIBUTION", amount: parsed.amount, balanceAfter });
    return Response.json({ ok: true, balanceAfter });
  }

  const { riskPerTradePct } = parsed;
  const existing = await db.select({ id: accountState.id }).from(accountState).where(eq(accountState.id, 1)).limit(1);
  if (existing.length === 0) {
    await db.insert(accountState).values({ id: 1, maxOpenPositions: DEFAULT_MAX_OPEN_POSITIONS, riskPerTradePct });
  } else {
    await db.update(accountState).set({ maxOpenPositions: DEFAULT_MAX_OPEN_POSITIONS, riskPerTradePct, updatedAt: new Date().toISOString() }).where(eq(accountState.id, 1));
  }
  return Response.json({ ok: true });
}
