export type SecFiling = {
  ticker: string;
  accessionNumber: string;
  form: string;
  filedAt: string;
  description: string;
  url: string;
};

type TickerMap = Record<string, { cik_str: number; ticker: string; title: string }>;
type Submissions = {
  cik: string;
  filings?: { recent?: Record<string, unknown[]> };
};

const MATERIAL_FORMS = new Set(["8-K", "8-K/A", "10-Q", "10-Q/A", "10-K", "10-K/A", "6-K", "6-K/A", "20-F", "20-F/A"]);
const SEC_REQUEST_INTERVAL_MS = 125;

function secHeaders(userAgent: string) {
  return { "User-Agent": userAgent, "Accept-Encoding": "gzip, deflate", Accept: "application/json" };
}

async function secJson<T>(url: string, userAgent: string): Promise<T> {
  const response = await fetch(url, { headers: secHeaders(userAgent) });
  if (!response.ok) throw new Error(`SEC EDGAR request failed (${response.status})`);
  return response.json() as Promise<T>;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getRecentSecFilings(userAgent: string, tickers: string[], since: Date): Promise<SecFiling[]> {
  if (!userAgent.trim()) return [];
  const tickerMap = await secJson<TickerMap>("https://www.sec.gov/files/company_tickers.json", userAgent);
  const cikByTicker = new Map(Object.values(tickerMap).map((entry) => [entry.ticker.toUpperCase(), entry.cik_str]));
  const filings: SecFiling[] = [];

  for (const ticker of tickers) {
    const cik = cikByTicker.get(ticker.toUpperCase());
    if (!cik) continue;
    await wait(SEC_REQUEST_INTERVAL_MS);
    const paddedCik = String(cik).padStart(10, "0");
    const submission = await secJson<Submissions>(`https://data.sec.gov/submissions/CIK${paddedCik}.json`, userAgent);
    const recent = submission.filings?.recent ?? {};
    const forms = (recent.form ?? []) as string[];
    const accessionNumbers = (recent.accessionNumber ?? []) as string[];
    const filingDates = (recent.filingDate ?? []) as string[];
    const acceptanceTimes = (recent.acceptanceDateTime ?? []) as string[];
    const primaryDocuments = (recent.primaryDocument ?? []) as string[];
    const descriptions = (recent.primaryDocDescription ?? []) as string[];

    for (let index = 0; index < forms.length; index++) {
      if (!MATERIAL_FORMS.has(forms[index])) continue;
      const filedAt = acceptanceTimes[index] || `${filingDates[index]}T00:00:00.000Z`;
      const filedDate = new Date(filedAt);
      if (!Number.isFinite(filedDate.getTime()) || filedDate < since) continue;
      const accessionNumber = accessionNumbers[index];
      const accessionPath = accessionNumber.replaceAll("-", "");
      const primaryDocument = primaryDocuments[index];
      filings.push({
        ticker,
        accessionNumber,
        form: forms[index],
        filedAt: filedDate.toISOString(),
        description: descriptions[index] || `SEC Form ${forms[index]}`,
        url: `https://www.sec.gov/Archives/edgar/data/${cik}/${accessionPath}/${primaryDocument}`,
      });
    }
  }
  return filings;
}
