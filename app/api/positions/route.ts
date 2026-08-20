import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db/index.ts";
import { newsStories, positions } from "../../../db/schema.ts";

export async function GET() {
  const db = getDb();
  const rows = await db.select({ position: positions, story: newsStories })
    .from(positions)
    .leftJoin(newsStories, eq(positions.storyId, newsStories.id))
    .orderBy(desc(positions.id))
    .limit(200);

  // Both entry and exit are already execution prices (the simulated
  // spread/slippage is baked into each), so this percentage is consistent with
  // realizedPnl rather than a separate, rosier "gross" number.
  const shaped = rows.map((row) => ({
    ...row.position,
    returnPct: row.position.exitPrice !== null && row.position.entryPrice > 0
      ? ((row.position.exitPrice - row.position.entryPrice) / row.position.entryPrice) * 100
      : null,
    headline: row.story?.headline ?? null,
    sourceUrl: row.story?.url ?? null,
  }));
  return Response.json({
    open: shaped.filter((p) => p.status === "OPEN"),
    closed: shaped.filter((p) => p.status === "CLOSED").slice(0, 50),
  });
}
