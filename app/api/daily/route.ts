import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../db/index.ts";
import { missedOpportunities, operatorNotes, tradingDays } from "../../../db/schema.ts";
import { STAGE_LABELS, parseStageCounts, type FunnelStage } from "../../../worker/funnel.ts";
import { isNoteRequestError, parseNoteRequest } from "../../../worker/note-requests.ts";
import { summariseGateCost } from "../../../worker/missed.ts";

const DEFAULT_DAYS = 30;
const MAX_DAYS = 180;

/**
 * The dated trade / no-trade record, newest first, each day carrying the funnel
 * counts behind its verdict and any notes written against it.
 */
export async function GET(request: Request) {
  const requested = Number(new URL(request.url).searchParams.get("days"));
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_DAYS) : DEFAULT_DAYS;

  const db = getDb();
  const days = await db.select().from(tradingDays).orderBy(desc(tradingDays.tradingDay)).limit(limit);
  const notes = await db.select().from(operatorNotes).orderBy(desc(operatorNotes.id)).limit(200);
  // Every rejection Atlas followed forward, so each gate can be judged on what
  // it actually turned down rather than on how reasonable it sounds.
  const misses = await db.select().from(missedOpportunities).orderBy(desc(missedOpportunities.id)).limit(2000);

  const shaped = days.map((day) => {
    const stages = parseStageCounts(day.stageCounts);
    return {
      ...day,
      stageCounts: undefined,
      isTradingDay: Boolean(day.isTradingDay),
      actionable: Boolean(day.actionable),
      blockers: Object.entries(stages)
        .filter(([stage]) => stage !== "OPENED")
        .map(([stage, count]) => ({
          stage,
          count,
          label: STAGE_LABELS[stage as FunnelStage]?.label ?? stage,
          kind: STAGE_LABELS[stage as FunnelStage]?.kind ?? "market",
        }))
        .sort((a, b) => (b.count ?? 0) - (a.count ?? 0)),
      notes: notes.filter((note) => note.tradingDay === day.tradingDay)
        .map((note) => ({ ...note, resolved: Boolean(note.resolved) })),
    };
  });

  // Sessions only — weekends and holidays would flatter the rate either way.
  const sessions = shaped.filter((day) => day.isTradingDay);
  const traded = sessions.filter((day) => day.positionsOpened > 0).length;

  const gateCost = summariseGateCost(misses.map((miss) => ({
    blockedStage: miss.blockedStage,
    resolved: Boolean(miss.resolved),
    wouldHaveWon: miss.wouldHaveWon === null ? null : Boolean(miss.wouldHaveWon),
  })));

  return Response.json({
    days: shaped,
    gateCost,
    summary: {
      sessions: sessions.length,
      tradedSessions: traded,
      tradeRate: sessions.length ? traded / sessions.length : null,
      // Days whose zero was Atlas's fault rather than the market's. This is the
      // number worth acting on; the raw count of empty days is not.
      actionableSessions: sessions.filter((day) => day.actionable).length,
      openNotes: notes.filter((note) => !note.resolved).length,
      missesTracked: misses.length,
      missesResolved: misses.filter((miss) => miss.resolved).length,
    },
  });
}

/** Records a note against a trading day, or resolves one. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

  const parsed = parseNoteRequest(body);
  if (isNoteRequestError(parsed)) {
    return Response.json({ error: parsed.error }, { status: parsed.status });
  }

  const db = getDb();

  if (parsed.kind === "RESOLVE") {
    await db.update(operatorNotes).set({ resolved: 1 }).where(eq(operatorNotes.id, parsed.id));
    return Response.json({ ok: true });
  }

  const [created] = await db.insert(operatorNotes).values({
    tradingDay: parsed.tradingDay,
    kind: parsed.noteKind,
    body: parsed.body,
  }).returning();

  return Response.json({ ok: true, note: created });
}

/** Deletes a note the operator no longer wants on the record. */
export async function DELETE(request: Request) {
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "id must be a positive integer." }, { status: 400 });
  }
  const db = getDb();
  await db.delete(operatorNotes).where(and(eq(operatorNotes.id, id)));
  return Response.json({ ok: true });
}
