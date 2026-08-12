import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { newsStories, positions } from "../../../db/schema";

export async function GET() {
  const db = getDb();
  const rows = await db.select({ position: positions, story: newsStories })
    .from(positions)
    .leftJoin(newsStories, eq(positions.storyId, newsStories.id))
    .orderBy(desc(positions.id))
    .limit(200);

  const shaped = rows.map((row) => ({ ...row.position, headline: row.story?.headline ?? null, sourceUrl: row.story?.url ?? null }));
  return Response.json({
    open: shaped.filter((p) => p.status === "OPEN"),
    closed: shaped.filter((p) => p.status === "CLOSED").slice(0, 50),
  });
}
