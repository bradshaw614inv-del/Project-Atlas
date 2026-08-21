// Validation for operator notes. Kept out of the route so the bounds are
// testable without a D1 binding, and so a malformed request never reaches it.

export const NOTE_KINDS = ["OBSERVATION", "CHANGE_REQUEST"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export const MAX_NOTE_LENGTH = 4000;
const TRADING_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type NoteRequest =
  | { kind: "CREATE"; tradingDay: string; noteKind: NoteKind; body: string }
  | { kind: "RESOLVE"; id: number };

export type NoteRequestError = { error: string; status: number };

export function isNoteRequestError(result: NoteRequest | NoteRequestError): result is NoteRequestError {
  return "error" in result;
}

export function parseNoteRequest(body: Record<string, unknown> | null | undefined): NoteRequest | NoteRequestError {
  if (body?.action === "RESOLVE") {
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) {
      return { error: "id must be a positive integer.", status: 400 };
    }
    return { kind: "RESOLVE", id };
  }

  const tradingDay = String(body?.tradingDay ?? "").trim();
  if (!TRADING_DAY_PATTERN.test(tradingDay)) {
    return { error: "tradingDay must be a YYYY-MM-DD date.", status: 400 };
  }

  // Trailing whitespace is trimmed, but the note has to say something.
  const text = String(body?.body ?? "").trim();
  if (!text) {
    return { error: "body must not be empty.", status: 400 };
  }
  if (text.length > MAX_NOTE_LENGTH) {
    return { error: `body must be ${MAX_NOTE_LENGTH} characters or fewer.`, status: 400 };
  }

  const requestedKind = String(body?.kind ?? "OBSERVATION");
  if (!NOTE_KINDS.includes(requestedKind as NoteKind)) {
    return { error: `kind must be one of ${NOTE_KINDS.join(", ")}.`, status: 400 };
  }

  return { kind: "CREATE", tradingDay, noteKind: requestedKind as NoteKind, body: text };
}
