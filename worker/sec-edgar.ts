import { canAfford, countSubrequest } from "./subrequests.ts";

export type SecFiling = {
  ticker: string;
  accessionNumber: string;
  form: string;
  filedAt: string;
  description: string;
  url: string;
  items: string;          // raw 8-K item codes as filed, e.g. "2.02,9.01"
  eventLabel: string;     // what those codes mean in plain language
  eventTone: "POSITIVE" | "NEGATIVE" | "NEUTRAL";
};

// An 8-K item code is the company telling the SEC, under legal obligation,
// exactly what kind of material event occurred. It is the most reliable
// catalyst signal available anywhere for free: no headline to interpret, no
// publisher spin, no question of whether the story is really about this
// company. Tone is assigned only where the code itself is unambiguous.
const EIGHT_K_ITEMS: Record<string, { label: string; tone: "POSITIVE" | "NEGATIVE" | "NEUTRAL" }> = {
  "1.01": { label: "Entry into a material definitive agreement", tone: "POSITIVE" },
  "1.02": { label: "Termination of a material agreement", tone: "NEGATIVE" },
  "1.03": { label: "Bankruptcy or receivership", tone: "NEGATIVE" },
  "2.01": { label: "Completion of acquisition or disposition", tone: "POSITIVE" },
  "2.02": { label: "Results of operations (earnings)", tone: "NEUTRAL" },
  "2.03": { label: "Material direct financial obligation", tone: "NEUTRAL" },
  "2.04": { label: "Triggering of a financial obligation", tone: "NEGATIVE" },
  "2.05": { label: "Costs from exit or disposal activities", tone: "NEGATIVE" },
  "2.06": { label: "Material impairment", tone: "NEGATIVE" },
  "3.01": { label: "Delisting notice or listing rule failure", tone: "NEGATIVE" },
  "3.03": { label: "Modification of security holder rights", tone: "NEUTRAL" },
  "4.01": { label: "Change in certifying accountant", tone: "NEGATIVE" },
  "4.02": { label: "Previously issued financials cannot be relied upon", tone: "NEGATIVE" },
  "5.01": { label: "Change in control", tone: "POSITIVE" },
  "5.02": { label: "Director or principal officer departure or appointment", tone: "NEUTRAL" },
  "5.03": { label: "Amendment to charter or bylaws", tone: "NEUTRAL" },
  "7.01": { label: "Regulation FD disclosure", tone: "NEUTRAL" },
  "8.01": { label: "Other material event", tone: "NEUTRAL" },
  "9.01": { label: "Financial statements and exhibits", tone: "NEUTRAL" },
};

// A filing carrying any negative code is negative regardless of what else it
// contains: a company reporting earnings alongside an impairment is not a
// clean earnings event.
export function describeFiling(items: string): { label: string; tone: "POSITIVE" | "NEGATIVE" | "NEUTRAL" } {
  const codes = items.split(/[,\s]+/).map((code) => code.trim()).filter(Boolean);
  const known = codes.map((code) => EIGHT_K_ITEMS[code]).filter(Boolean);
  if (known.length === 0) return { label: "", tone: "NEUTRAL" };
  const negative = known.find((entry) => entry.tone === "NEGATIVE");
  if (negative) return { label: negative.label, tone: "NEGATIVE" };
  const positive = known.find((entry) => entry.tone === "POSITIVE");
  if (positive) return { label: positive.label, tone: "POSITIVE" };
  // 9.01 is boilerplate attached to almost everything; prefer a real event.
  const substantive = known.find((entry) => entry.label !== "Financial statements and exhibits");
  return substantive ?? known[0];
}

type TickerMap = Record<string, { cik_str: number; ticker: string; title: string }>;
export type Submissions = {
  cik: string;
  filings?: { recent?: Record<string, unknown[]> };
};

const MATERIAL_FORMS = new Set(["8-K", "8-K/A", "10-Q", "10-Q/A", "10-K", "10-K/A", "6-K", "6-K/A", "20-F", "20-F/A"]);
const SEC_REQUEST_INTERVAL_MS = 125;

function secHeaders(userAgent: string) {
  return { "User-Agent": userAgent, "Accept-Encoding": "gzip, deflate", Accept: "application/json" };
}

async function secJson<T>(url: string, userAgent: string): Promise<T> {
  countSubrequest("sec.gov");
  const response = await fetch(url, { headers: secHeaders(userAgent) });
  if (!response.ok) throw new Error(`SEC EDGAR request failed (${response.status})`);
  return response.json() as Promise<T>;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Filings for the given tickers, newest first.
 *
 * One request per ticker plus one for the CIK map, so the caller decides which
 * tickers are worth spending on. A filing never creates a candidate by itself —
 * it corroborates a story or vetoes one — so asking about a ticker with no
 * story this scan buys nothing and costs a subrequest out of a budget of fifty.
 *
 * The walk stops early rather than being cut off mid-sequence when the budget
 * runs out, so whatever it did fetch is complete and usable.
 */
export async function getRecentSecFilings(userAgent: string, tickers: string[], since: Date): Promise<SecFiling[]> {
  if (!userAgent.trim() || tickers.length === 0) return [];
  // The CIK map plus at least one submission, or there is no point starting.
  if (!canAfford(2)) return [];

  const tickerMap = await secJson<TickerMap>("https://www.sec.gov/files/company_tickers.json", userAgent);
  const cikByTicker = new Map(Object.values(tickerMap).map((entry) => [entry.ticker.toUpperCase(), entry.cik_str]));
  const filings: SecFiling[] = [];

  for (const ticker of tickers) {
    const cik = cikByTicker.get(ticker.toUpperCase());
    if (!cik) continue;
    if (!canAfford(1)) break;
    await wait(SEC_REQUEST_INTERVAL_MS);
    const paddedCik = String(cik).padStart(10, "0");
    const submission = await secJson<Submissions>(`https://data.sec.gov/submissions/CIK${paddedCik}.json`, userAgent);
    filings.push(...filingsFromSubmissions(submission, ticker, cik, since));
  }
  return filings;
}

/**
 * Walks EDGAR's parallel-array submission format into filings. Kept separate
 * from the fetch above so it can be run against a saved payload: this is the
 * only place the 8-K item codes are read, and they are the most reliable
 * catalyst signal Atlas has.
 */
export function filingsFromSubmissions(submission: Submissions, ticker: string, cik: string | number, since: Date): SecFiling[] {
  const filings: SecFiling[] = [];
  const recent = submission.filings?.recent ?? {};
  const forms = (recent.form ?? []) as string[];
  const accessionNumbers = (recent.accessionNumber ?? []) as string[];
  const filingDates = (recent.filingDate ?? []) as string[];
  const acceptanceTimes = (recent.acceptanceDateTime ?? []) as string[];
  const primaryDocuments = (recent.primaryDocument ?? []) as string[];
  const descriptions = (recent.primaryDocDescription ?? []) as string[];
  // EDGAR publishes the 8-K item codes in a parallel `items` array. This
  // declaration was missing, so every call reaching a material form threw a
  // ReferenceError and the whole SEC pathway silently returned nothing.
  const itemCodes = (recent.items ?? []) as string[];

  for (let index = 0; index < forms.length; index++) {
    if (!MATERIAL_FORMS.has(forms[index])) continue;
    const filedAt = acceptanceTimes[index] || `${filingDates[index]}T00:00:00.000Z`;
    const filedDate = new Date(filedAt);
    if (!Number.isFinite(filedDate.getTime()) || filedDate < since) continue;
    const accessionNumber = accessionNumbers[index];
    if (!accessionNumber) continue;
    const accessionPath = accessionNumber.replaceAll("-", "");
    const primaryDocument = primaryDocuments[index];
    const described = describeFiling(itemCodes[index] ?? "");
    filings.push({
      ticker,
      accessionNumber,
      form: forms[index],
      items: itemCodes[index] ?? "",
      eventLabel: described.label,
      eventTone: described.tone,
      filedAt: filedDate.toISOString(),
      description: descriptions[index] || `SEC Form ${forms[index]}`,
      url: `https://www.sec.gov/Archives/edgar/data/${cik}/${accessionPath}/${primaryDocument}`,
    });
  }
  return filings;
}
