import assert from "node:assert/strict";
import test from "node:test";
import {
  getMarketClock, isForceCloseTime, isMarketOpen, isWeekday,
  isWithinCollectionWindow, isWithinEntryWindow,
} from "../worker/market-hours.ts";
import { washSaleBlockedUntil } from "../worker/wash-sale.ts";

// Six predicates over four windows, every one of them a timezone conversion,
// and none of them had a test. These decide when Atlas may open a position and
// when it must be flat. Every instant below is written in UTC and annotated
// with what it is in New York, because that difference is the whole risk.

test("the clock reads the wall time in New York, not UTC", () => {
  // 14:30 UTC in January is 09:30 ET — the opening bell during standard time.
  const winter = getMarketClock(new Date("2026-01-14T14:30:00Z"));
  assert.equal(winter.weekday, "Wed");
  assert.equal(winter.minutesSinceMidnight, 9 * 60 + 30);
  assert.equal(winter.tradingDay, "2026-01-14");

  // The same wall-clock moment in July is an hour earlier in UTC.
  const summer = getMarketClock(new Date("2026-07-15T13:30:00Z"));
  assert.equal(summer.minutesSinceMidnight, 9 * 60 + 30, "daylight time must shift the offset, not the bell");
  assert.equal(summer.tradingDay, "2026-07-15");

  // Late evening in New York is already tomorrow in UTC. Reading the UTC date
  // here would advance the trading day eight hours early.
  const evening = getMarketClock(new Date("2026-03-11T01:30:00Z"));
  assert.equal(evening.tradingDay, "2026-03-10", "still the 10th in New York");
  assert.equal(evening.weekday, "Tue");
});

test("the session windows open and close at the right wall-clock minutes", () => {
  // [UTC instant, ET wall clock, open?, collection?, entry?, forceClose?]
  const cases = [
    ["2026-03-11T11:59:00Z", "07:59 ET Wed", false, false, false, false],
    ["2026-03-11T12:00:00Z", "08:00 ET Wed — collection opens", false, true, false, false],
    ["2026-03-11T13:29:00Z", "09:29 ET Wed", false, true, false, false],
    ["2026-03-11T13:30:00Z", "09:30 ET Wed — the bell", true, true, false, false],
    ["2026-03-11T13:59:00Z", "09:59 ET Wed — still the volatile open", true, true, false, false],
    ["2026-03-11T14:00:00Z", "10:00 ET Wed — entries begin", true, true, true, false],
    ["2026-03-11T19:44:00Z", "15:44 ET Wed — last entry minute", true, true, true, false],
    ["2026-03-11T19:45:00Z", "15:45 ET Wed — flatten", true, true, false, true],
    ["2026-03-11T19:59:00Z", "15:59 ET Wed", true, true, false, true],
    ["2026-03-11T20:00:00Z", "16:00 ET Wed — the close", false, true, false, true],
    ["2026-03-11T20:59:00Z", "16:59 ET Wed", false, true, false, true],
    ["2026-03-11T21:00:00Z", "17:00 ET Wed — collection ends", false, false, false, true],
  ];

  for (const [iso, label, open, collection, entry, force] of cases) {
    const clock = getMarketClock(new Date(iso));
    assert.equal(isMarketOpen(clock), open, `isMarketOpen at ${label}`);
    assert.equal(isWithinCollectionWindow(clock), collection, `isWithinCollectionWindow at ${label}`);
    assert.equal(isWithinEntryWindow(clock), entry, `isWithinEntryWindow at ${label}`);
    assert.equal(isForceCloseTime(clock), force, `isForceCloseTime at ${label}`);
  }
});

test("the windows hold across both daylight-saving transitions", () => {
  // US clocks moved forward on 2026-03-08 and back on 2026-11-01. A window
  // pinned to a UTC offset rather than a timezone silently slips an hour on
  // each side of these dates, which would open entries at 09:00 or 11:00 ET.
  const openingBells = [
    ["2026-03-06T14:30:00Z", "Fri before the spring change (EST, UTC-5)"],
    ["2026-03-09T13:30:00Z", "Mon after the spring change (EDT, UTC-4)"],
    ["2026-10-30T13:30:00Z", "Fri before the autumn change (EDT, UTC-4)"],
    ["2026-11-02T14:30:00Z", "Mon after the autumn change (EST, UTC-5)"],
  ];

  for (const [iso, label] of openingBells) {
    const clock = getMarketClock(new Date(iso));
    assert.equal(clock.minutesSinceMidnight, 9 * 60 + 30, `${label} must be 09:30 ET`);
    assert.equal(isMarketOpen(clock), true, `market must be open at ${label}`);
    assert.equal(isWithinEntryWindow(clock), false, `${label} is still inside the first 30 minutes`);
  }
});

test("the entry window and the force-close window are exact complements in-session", () => {
  // These two decide opposite actions and are checked independently, so an
  // overlap would let Atlas open a position in the same scan that flattens it.
  // Walk the whole session minute by minute and assert they never agree.
  const sessionStart = Date.parse("2026-06-10T13:30:00Z"); // 09:30 ET Wed
  for (let minute = 0; minute <= 390; minute++) {
    const clock = getMarketClock(new Date(sessionStart + minute * 60000));
    const entry = isWithinEntryWindow(clock);
    const force = isForceCloseTime(clock);
    assert.ok(!(entry && force), `entry and force-close both true at ${clock.minutesSinceMidnight} minutes`);
  }

  // And they meet exactly: the minute entries stop is the minute flattening starts.
  const lastEntry = getMarketClock(new Date("2026-06-10T19:44:00Z"));
  const firstFlatten = getMarketClock(new Date("2026-06-10T19:45:00Z"));
  assert.equal(isWithinEntryWindow(lastEntry), true);
  assert.equal(isForceCloseTime(firstFlatten), true);
});

test("nothing trades at the weekend", () => {
  const saturday = getMarketClock(new Date("2026-06-13T15:00:00Z")); // 11:00 ET Sat
  const sunday = getMarketClock(new Date("2026-06-14T15:00:00Z"));

  for (const clock of [saturday, sunday]) {
    assert.equal(isWeekday(clock), false);
    assert.equal(isMarketOpen(clock), false);
    assert.equal(isWithinCollectionWindow(clock), false, "no point burning quota on a frozen tape");
    assert.equal(isWithinEntryWindow(clock), false);
    assert.equal(isForceCloseTime(clock), false, "and nothing to force-close either");
  }

  assert.equal(isWeekday(getMarketClock(new Date("2026-06-12T15:00:00Z"))), true, "Friday is a weekday");
  assert.equal(isWeekday(getMarketClock(new Date("2026-06-15T15:00:00Z"))), true, "Monday is a weekday");
});

test("a wash-sale block runs to the end of the trading day before the safe date", () => {
  // The safe dates are calendar dates in the market's timezone. Comparing a UTC
  // date against them released every block at 20:00 ET the evening before —
  // still the prior trading day in New York, and still inside the window.
  const blockedUntil = (iso) => washSaleBlockedUntil("GME", new Date(iso));

  assert.equal(blockedUntil("2026-09-11T14:00:00Z"), "2026-09-14", "10:00 ET on the 11th — blocked");
  assert.equal(blockedUntil("2026-09-13T23:00:00Z"), "2026-09-14", "19:00 ET on the 13th — still blocked");
  assert.equal(blockedUntil("2026-09-14T00:30:00Z"), "2026-09-14", "20:30 ET on the 13th — the case that used to leak");
  assert.equal(blockedUntil("2026-09-14T03:59:00Z"), "2026-09-14", "23:59 ET on the 13th — the last blocked minute");

  // And it does expire: on the safe date itself the ticker is tradeable again.
  assert.equal(blockedUntil("2026-09-14T13:30:00Z"), null, "09:30 ET on the 14th — clear");
  assert.equal(blockedUntil("2026-10-01T14:00:00Z"), null, "well past the window — clear");

  // A ticker that was never blocked is never blocked.
  assert.equal(washSaleBlockedUntil("AAPL", new Date("2026-09-11T14:00:00Z")), null);
});
