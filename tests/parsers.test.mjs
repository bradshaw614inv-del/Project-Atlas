import assert from "node:assert/strict";
import test from "node:test";
import { parseHaltRecords } from "../worker/manipulation.ts";
import {
  macroRiskTitles, parseYahooNewsRss, pressReleasesFromRss, snapshotFromChart, xmlValues,
} from "../worker/free-sources.ts";

// Every parser here was pure already, but each sat behind a fetch call with no
// seam to test through. They matter more than ordinary parsing code because of
// how they fail: each loop skips malformed rows rather than throwing, so a feed
// changing a field name yields zero results and a clean success. That is the
// exact silent blindness data-sufficiency.ts exists to detect after the fact.

// --- Nasdaq trade halts -----------------------------------------------------

const haltFeed = (items) => `<?xml version="1.0"?><rss><channel>${items}</channel></rss>`;
const haltItem = (fields) => `<item>${Object.entries(fields)
  .map(([tag, value]) => `<ndaq:${tag}>${value}</ndaq:${tag}>`).join("")}</item>`;

test("halt records keep the reason code, not just the symbol", () => {
  // The reason is what separates a routine news pause from the exchange
  // stepping in on disorderly trading, and it drives an unconditional block.
  const [record] = parseHaltRecords(haltFeed(haltItem({
    IssueSymbol: "xyz", ReasonCode: "LUDP", HaltDate: "2026-08-18", HaltTime: "14:05:00",
  })));

  assert.equal(record.symbol, "XYZ", "symbols are normalised to upper case");
  assert.equal(record.reasonCode, "LUDP");
  assert.equal(record.haltedAt, "2026-08-18T14:05:00Z");
  assert.equal(record.resumedAt, null, "still halted");
});

test("a resumption after midnight is dated to the following day", () => {
  // The feed gives a resumption time with no date, so it borrows the halt's. A
  // resumption clock-time earlier than the halt's means the session rolled over
  // — dating it from the halt day put the resumption before the halt.
  const [overnight] = parseHaltRecords(haltFeed(haltItem({
    IssueSymbol: "XYZ", ReasonCode: "T1", HaltDate: "2026-08-18", HaltTime: "23:40:00",
    ResumptionTradeTime: "00:15:00",
  })));

  assert.equal(overnight.haltedAt, "2026-08-18T23:40:00Z");
  assert.equal(overnight.resumedAt, "2026-08-19T00:15:00Z");
  assert.ok(Date.parse(overnight.resumedAt) > Date.parse(overnight.haltedAt),
    "a pause can never end before it began");

  // The ordinary same-day case is unaffected.
  const [sameDay] = parseHaltRecords(haltFeed(haltItem({
    IssueSymbol: "XYZ", ReasonCode: "T1", HaltDate: "2026-08-18", HaltTime: "10:00:00",
    ResumptionTradeTime: "10:20:00",
  })));
  assert.equal(sameDay.resumedAt, "2026-08-18T10:20:00Z");

  // And a month-end rollover carries into the next month.
  const [monthEnd] = parseHaltRecords(haltFeed(haltItem({
    IssueSymbol: "XYZ", ReasonCode: "T1", HaltDate: "2026-08-31", HaltTime: "23:50:00",
    ResumptionTradeTime: "00:05:00",
  })));
  assert.equal(monthEnd.resumedAt, "2026-09-01T00:05:00Z");
});

test("halt items without a symbol are dropped, not guessed at", () => {
  const records = parseHaltRecords(haltFeed(
    haltItem({ ReasonCode: "LUDP", HaltDate: "2026-08-18", HaltTime: "10:00:00" }) +
    haltItem({ IssueSymbol: "AAA", ReasonCode: "LUDP", HaltDate: "2026-08-18", HaltTime: "10:01:00" }),
  ));
  assert.equal(records.length, 1);
  assert.equal(records[0].symbol, "AAA");

  // A missing reason is recorded as unknown rather than silently omitted: the
  // security is still halted either way.
  const [noReason] = parseHaltRecords(haltFeed(haltItem({ IssueSymbol: "BBB", HaltDate: "2026-08-18", HaltTime: "10:00:00" })));
  assert.equal(noReason.reasonCode, "UNKNOWN");

  assert.deepEqual(parseHaltRecords(haltFeed("")), [], "an empty feed is empty, not an error");
  assert.deepEqual(parseHaltRecords("not xml at all"), []);
});

// --- Yahoo news RSS ---------------------------------------------------------

const newsFeed = (items) => `<?xml version="1.0"?><rss version="2.0"><channel>${items}</channel></rss>`;
const newsItem = ({ title = "", link = "", pubDate = "", guid = "", description = "" }) =>
  `<item><title>${title}</title><link>${link}</link><guid>${guid}</guid>` +
  `<pubDate>${pubDate}</pubDate><description>${description}</description></item>`;

test("a news item is read whole, including the article summary", () => {
  // The summary is the reason this feed is used at all: the JSON search endpoint
  // returns titles only, which had Atlas judging stories on one line of text.
  const [story] = parseYahooNewsRss(newsFeed(newsItem({
    title: "Salesforce beats estimates and raises guidance",
    link: "https://finance.yahoo.com/news/crm-beats",
    guid: "crm-2026-08-18",
    pubDate: "Tue, 18 Aug 2026 14:05:00 +0000",
    description: "The firm reported record revenue and lifted its full-year outlook.",
  })));

  assert.equal(story.id, "yahoo:crm-2026-08-18");
  assert.equal(story.headline, "Salesforce beats estimates and raises guidance");
  assert.match(story.summary, /record revenue/);
  assert.equal(story.source, "Yahoo Finance");
  assert.equal(story.publishedAt, "2026-08-18T14:05:00.000Z");
});

test("CDATA wrapping and embedded markup are stripped from news fields", () => {
  const [story] = parseYahooNewsRss(newsFeed(newsItem({
    title: "<![CDATA[Apple <b>climbs</b> on product news]]>",
    link: "https://example.com/a",
    guid: "a1",
    pubDate: "Tue, 18 Aug 2026 14:05:00 +0000",
    description: "<![CDATA[<p>Shares rose <em>4%</em>.</p>]]>",
  })));

  assert.equal(story.headline, "Apple climbs on product news");
  assert.equal(story.summary, "Shares rose 4%.");
});

test("news items missing any required field are dropped", () => {
  const complete = { title: "Real story", link: "https://example.com/x", guid: "g1", pubDate: "Tue, 18 Aug 2026 14:05:00 +0000" };
  const dropped = [
    ["no title", { ...complete, title: "" }],
    ["no link and so no id", { ...complete, link: "", guid: "" }],
    ["an unparseable date", { ...complete, pubDate: "sometime last week" }],
    ["no date at all", { ...complete, pubDate: "" }],
  ];

  for (const [description, fields] of dropped) {
    assert.deepEqual(parseYahooNewsRss(newsFeed(newsItem(fields))), [], `${description} must be dropped`);
  }

  // A missing guid falls back to the link rather than dropping a real story.
  const [fallback] = parseYahooNewsRss(newsFeed(newsItem({ ...complete, guid: "" })));
  assert.equal(fallback.id, "yahoo:https://example.com/x");

  // Good and bad items in one feed: keep the good, drop the bad.
  const mixed = parseYahooNewsRss(newsFeed(newsItem(complete) + newsItem({ ...complete, title: "" })));
  assert.equal(mixed.length, 1);

  assert.deepEqual(parseYahooNewsRss(newsFeed("")), []);
});

// --- Press release wires ----------------------------------------------------

test("a press release counts only when it names a universe ticker by exchange tag", () => {
  const feed = `<rss><channel>
    <item><title>Apple Inc. (NASDAQ: AAPL) announces record quarter</title>
      <link>https://example.com/1</link><pubDate>Tue, 18 Aug 2026 12:00:00 +0000</pubDate>
      <description>Full year guidance raised.</description></item>
    <item><title>Privateco announces a funding round</title>
      <link>https://example.com/2</link><pubDate>Tue, 18 Aug 2026 12:00:00 +0000</pubDate>
      <description>No exchange tag anywhere in this release.</description></item>
    <item><title>Someone mentions apple and microsoft in passing</title>
      <link>https://example.com/3</link><pubDate>Tue, 18 Aug 2026 12:00:00 +0000</pubDate>
      <description>Fuzzy company-name matching must never create a ticker.</description></item>
  </channel></rss>`;

  const releases = pressReleasesFromRss(feed, "Business Wire");
  assert.equal(releases.length, 1, "only the tagged release counts");
  assert.equal(releases[0].source, "Business Wire");
  assert.deepEqual(releases[0].tickers, ["AAPL"]);
  assert.equal(releases[0].publishedAt, "2026-08-18T12:00:00.000Z");
});

test("a release naming several tagged tickers reports each one once", () => {
  const feed = `<rss><channel><item>
    <title>Apple Inc. (NASDAQ: AAPL) and Microsoft Corp (NASDAQ: MSFT) announce a partnership</title>
    <link>https://example.com/1</link><pubDate>Tue, 18 Aug 2026 12:00:00 +0000</pubDate>
    <description>Apple Inc. (NASDAQ: AAPL) will supply the hardware.</description>
  </item></channel></rss>`;

  const [release] = pressReleasesFromRss(feed, "PR Newswire");
  assert.deepEqual([...release.tickers].sort(), ["AAPL", "MSFT"], "AAPL appears twice but counts once");
});

test("a release with an unparseable date is dropped", () => {
  const feed = `<rss><channel><item>
    <title>Apple Inc. (NASDAQ: AAPL) announces something</title>
    <link>https://example.com/1</link><pubDate>whenever</pubDate><description></description>
  </item></channel></rss>`;
  assert.deepEqual(pressReleasesFromRss(feed, "Business Wire"), []);
});

// --- Yahoo chart snapshots --------------------------------------------------

// Two sessions of hourly bars in Eastern time. 14:00Z is 10:00 ET in August.
const barsAt = (day, closes, volume = 1000) => closes.map((close, index) => ({
  stamp: Math.floor(Date.parse(`${day}T${String(14 + index).padStart(2, "0")}:00:00Z`) / 1000),
  high: close + 0.5, low: close - 0.5, close, volume,
}));

const chartOf = (rows, meta) => ({
  chart: {
    result: [{
      meta,
      timestamp: rows.map((row) => row.stamp),
      indicators: {
        quote: [{
          high: rows.map((row) => row.high),
          low: rows.map((row) => row.low),
          close: rows.map((row) => row.close),
          volume: rows.map((row) => row.volume),
        }],
      },
    }],
  },
});

test("a chart snapshot reports price, change and a volume-weighted average", () => {
  const rows = barsAt("2026-08-18", [100, 102, 104]);
  const snapshot = snapshotFromChart(chartOf(rows, { regularMarketPrice: 104, chartPreviousClose: 100 }), "AAPL");

  assert.equal(snapshot.price, 104);
  assert.equal(snapshot.prevClose, 100);
  assert.ok(Math.abs(snapshot.changePct - 4) < 1e-9);

  // VWAP over equal-volume bars is the mean of each bar's typical price, and
  // the typical price of a symmetric bar is its close.
  assert.ok(Math.abs(snapshot.vwap - 102) < 1e-9);
});

test("relative volume compares today against the same point in prior sessions", () => {
  // Yesterday traded 1,000 per bar; today is running at 3,000 on the same bars.
  const yesterday = barsAt("2026-08-17", [100, 100, 100], 1000);
  const today = barsAt("2026-08-18", [100, 100, 100], 3000);
  const snapshot = snapshotFromChart(
    chartOf([...yesterday, ...today], { regularMarketPrice: 100, chartPreviousClose: 100 }), "AAPL");

  assert.ok(Math.abs(snapshot.relativeVolume - 3) < 1e-9, "three times the usual crowd");
});

test("a single session gives no baseline, so relative volume stays unknown", () => {
  // Guessing 1.0 here would tell the scorer the day is normal when it has no
  // idea, and relative volume feeds an attention penalty that blocks trades.
  const snapshot = snapshotFromChart(
    chartOf(barsAt("2026-08-18", [100, 101, 102]), { regularMarketPrice: 102, chartPreviousClose: 100 }), "AAPL");
  assert.equal(snapshot.relativeVolume, null);
});

test("bars with missing or zero-volume fields are skipped rather than counted", () => {
  const rows = barsAt("2026-08-18", [100, 102, 104]);
  const chart = chartOf(rows, { regularMarketPrice: 104, chartPreviousClose: 100 });
  chart.chart.result[0].indicators.quote[0].close[1] = null;
  chart.chart.result[0].indicators.quote[0].volume[2] = 0;

  const snapshot = snapshotFromChart(chart, "AAPL");
  // Only the first bar is fully usable, so VWAP is that bar's typical price.
  assert.ok(Math.abs(snapshot.vwap - 100) < 1e-9);
  assert.equal(snapshot.price, 104, "the quoted price comes from meta, not the bars");
});

test("a chart with no usable price is refused rather than defaulted", () => {
  const rows = barsAt("2026-08-18", [100]);
  assert.throws(() => snapshotFromChart(chartOf(rows, { regularMarketPrice: 0 }), "AAPL"), /no price/);
  assert.throws(() => snapshotFromChart(chartOf(rows, {}), "AAPL"), /no price/);
  assert.throws(() => snapshotFromChart({ chart: { result: [] } }, "AAPL"), /no price/);
  assert.throws(() => snapshotFromChart({}, "AAPL"), /no price/);
});

test("a missing previous close leaves the change unknown, never zero", () => {
  const rows = barsAt("2026-08-18", [100, 101]);
  const snapshot = snapshotFromChart(chartOf(rows, { regularMarketPrice: 101 }), "AAPL");
  assert.equal(snapshot.prevClose, null);
  assert.equal(snapshot.changePct, null, "an unknown change must not read as flat");
});

test("ATR needs a real sample before it will size a stop", () => {
  // Below twenty bars there is not enough range history to place a stop from,
  // and positions.ts falls back to its fixed distance when this is null.
  const thin = snapshotFromChart(
    chartOf(barsAt("2026-08-18", [100, 101, 102]), { regularMarketPrice: 102, chartPreviousClose: 100 }), "AAPL");
  assert.equal(thin.atrPct, null);

  const long = snapshotFromChart(
    chartOf(barsAt("2026-08-18", Array.from({ length: 24 }, () => 100)), { regularMarketPrice: 100, chartPreviousClose: 100 }), "AAPL");
  assert.ok(long.atrPct > 0, "a full session reports a real range");
  assert.ok(Math.abs(long.atrPct - 1) < 1e-9, "a 1.0-wide bar on a 100 close is a 1% range");
});

// --- Shared XML helper and the macro feed -----------------------------------

test("xmlValues pulls every occurrence of a tag and strips its markup", () => {
  const xml = "<feed><title>One</title><title><![CDATA[Two]]></title><title>Th<b>ree</b></title></feed>";
  assert.deepEqual(xmlValues(xml, "title"), ["One", "Two", "Three"]);
  assert.deepEqual(xmlValues(xml, "missing"), []);
});

test("only recent policy headlines count as macro risk", () => {
  const now = new Date("2026-08-18T15:00:00Z");
  const entry = (title, updated) => `<entry><title>${title}</title><updated>${updated}</updated></entry>`;
  const feed = `<feed>${
    entry("FOMC statement on monetary policy", "2026-08-18T14:30:00Z") +      // recent and relevant
    entry("Federal Reserve Board announces personnel change", "2026-08-18T14:30:00Z") + // recent, irrelevant
    entry("FOMC statement on monetary policy", "2026-08-17T09:00:00Z") +      // relevant but stale
    entry("Emergency lending facility established", "2026-08-18T20:00:00Z")   // dated in the future
  }</feed>`;

  assert.deepEqual(macroRiskTitles(feed, now), ["FOMC statement on monetary policy"]);
  assert.deepEqual(macroRiskTitles("<feed></feed>", now), []);
});

// --- SEC EDGAR submissions --------------------------------------------------

test("the filing walk reads item codes, filters forms and honours the cutoff", async () => {
  const { filingsFromSubmissions } = await import("../worker/sec-edgar.ts");

  // EDGAR's parallel-array format: index N of every array describes filing N.
  const submission = {
    cik: "320193",
    filings: {
      recent: {
        form: ["8-K", "4", "10-Q", "8-K"],
        accessionNumber: ["0000320193-26-000101", "0000320193-26-000102", "0000320193-26-000103", "0000320193-26-000010"],
        filingDate: ["2026-08-18", "2026-08-18", "2026-08-18", "2026-01-05"],
        acceptanceDateTime: ["2026-08-18T16:31:00.000Z", "2026-08-18T16:32:00.000Z", "2026-08-18T16:33:00.000Z", "2026-01-05T16:30:00.000Z"],
        primaryDocument: ["a8k.htm", "form4.xml", "a10q.htm", "old8k.htm"],
        primaryDocDescription: ["8-K Report", "Form 4", "", "8-K Report"],
        items: ["2.02,9.01", "", "", "1.01"],
      },
    },
  };

  const filings = filingsFromSubmissions(submission, "AAPL", 320193, new Date("2026-08-01T00:00:00Z"));

  assert.equal(filings.length, 2, "Form 4 is not material and the January 8-K is before the cutoff");
  assert.deepEqual(filings.map((filing) => filing.form), ["8-K", "10-Q"]);

  // The item codes are the whole point of reading these filings, and the line
  // that read them referenced an undeclared variable — so this path threw a
  // ReferenceError on every real payload and the SEC feed delivered nothing.
  const [eightK, tenQ] = filings;
  assert.equal(eightK.items, "2.02,9.01");
  assert.equal(eightK.eventLabel, "Results of operations (earnings)");
  assert.equal(eightK.eventTone, "NEUTRAL");
  assert.equal(eightK.url, "https://www.sec.gov/Archives/edgar/data/320193/000032019326000101/a8k.htm");
  assert.equal(eightK.filedAt, "2026-08-18T16:31:00.000Z");

  // A filing with no item codes still reports, with an empty label.
  assert.equal(tenQ.eventLabel, "");
  assert.equal(tenQ.description, "SEC Form 10-Q", "a blank description falls back to the form name");
});

test("an empty or malformed submission yields nothing rather than throwing", async () => {
  const { filingsFromSubmissions } = await import("../worker/sec-edgar.ts");
  const since = new Date("2026-08-01T00:00:00Z");

  assert.deepEqual(filingsFromSubmissions({ cik: "1" }, "AAPL", 1, since), []);
  assert.deepEqual(filingsFromSubmissions({ cik: "1", filings: {} }, "AAPL", 1, since), []);
  assert.deepEqual(filingsFromSubmissions({ cik: "1", filings: { recent: {} } }, "AAPL", 1, since), []);

  // A material form with an unparseable date or no accession number is skipped
  // rather than producing a filing with a broken URL.
  const broken = {
    cik: "1",
    filings: { recent: {
      form: ["8-K", "8-K"],
      accessionNumber: ["", "0000000001-26-000001"],
      filingDate: ["2026-08-18", "not-a-date"],
      acceptanceDateTime: ["", ""],
      primaryDocument: ["a.htm", "b.htm"],
      primaryDocDescription: ["", ""],
      items: ["1.01", "1.01"],
    } },
  };
  assert.deepEqual(filingsFromSubmissions(broken, "AAPL", 1, since), []);
});
