const ET_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export type MarketClock = {
  weekday: string;
  minutesSinceMidnight: number;
  tradingDay: string; // YYYY-MM-DD in Eastern time
};

export function getMarketClock(date: Date): MarketClock {
  const parts = Object.fromEntries(ET_FORMAT.formatToParts(date).map((p) => [p.type, p.value]));
  const minutesSinceMidnight = Number(parts.hour) * 60 + Number(parts.minute);
  return {
    weekday: parts.weekday,
    minutesSinceMidnight,
    tradingDay: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

const WEEKDAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);
const MARKET_OPEN = 9 * 60 + 30;
const MARKET_CLOSE = 16 * 60;
const ENTRY_WINDOW_START = 10 * 60; // skip the first 30 minutes — most volatile, least reliable
const ENTRY_WINDOW_END = 15 * 60 + 45; // stop opening new positions 15 minutes before the close

// Wider than regular hours on purpose: real catalysts land premarket (earnings
// before the bell) and after the close, and Atlas should collect that news when
// it appears. Outside this window quotes are frozen, so re-reading them every
// five minutes only burns free-tier quota and writes duplicate history.
const COLLECTION_WINDOW_START = 8 * 60;
const COLLECTION_WINDOW_END = 17 * 60;

export function isWeekday(clock: MarketClock) {
  return WEEKDAYS.has(clock.weekday);
}

export function isMarketOpen(clock: MarketClock) {
  return isWeekday(clock) && clock.minutesSinceMidnight >= MARKET_OPEN && clock.minutesSinceMidnight < MARKET_CLOSE;
}

export function isWithinCollectionWindow(clock: MarketClock) {
  return isWeekday(clock)
    && clock.minutesSinceMidnight >= COLLECTION_WINDOW_START
    && clock.minutesSinceMidnight < COLLECTION_WINDOW_END;
}

export function isWithinEntryWindow(clock: MarketClock) {
  return isWeekday(clock) && clock.minutesSinceMidnight >= ENTRY_WINDOW_START && clock.minutesSinceMidnight < ENTRY_WINDOW_END;
}

// Robinhood stop and trailing-stop orders don't execute after regular hours, so every
// simulated position must be flat before the close — never held overnight.
export function isForceCloseTime(clock: MarketClock) {
  return isWeekday(clock) && clock.minutesSinceMidnight >= ENTRY_WINDOW_END;
}
