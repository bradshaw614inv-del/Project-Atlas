import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db/index.ts";
import { candidates, newsStories } from "../../../db/schema.ts";

export async function GET() {
  const db = getDb();
  const rows = await db.select({ candidate: candidates, story: newsStories })
    .from(candidates)
    .leftJoin(newsStories, eq(candidates.storyId, newsStories.id))
    .orderBy(desc(candidates.id))
    .limit(60);

  const shaped = rows.map((row) => ({
    ...row.candidate,
    signals: JSON.parse(row.candidate.signalBreakdown || "[]"),
    headline: row.story?.headline ?? null,
    sourceUrl: row.story?.url ?? null,
    source: row.story?.source ?? null,
  }));
  return Response.json({ candidates: shaped });
}
