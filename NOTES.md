# Operator notes

The direct line to Claude. Anything written here is read at the start of every
session, before any code is touched.

Two channels exist and they are not interchangeable:

| Where | Who reads it | Use it for |
|---|---|---|
| **This file** | Claude, every session | Changes you want made to the system |
| **Dashboard notes** (`/api/daily`) | Stored in D1, shown on the dashboard | Jotting during the session, tied to a specific trading day |

Claude cannot reach the production database, so notes typed into the dashboard
are **not** visible here. To act on one, paste it into **Requested changes**
below, or say "check the dashboard notes" and export them from `/api/daily`.

---

## Requested changes

> Add one bullet per change. Claude clears these into **Done** as they ship,
> with the commit that did it.

- _(nothing pending)_

## Standing instructions

> Rules that apply to every session until removed.

- **No trade quotas.** The number of trades per day is an output, never a
  target. If a day offers nothing, the correct number of trades is zero. Do not
  loosen a gate to raise the trade count; loosen a gate only when there is
  evidence the gate is measuring the wrong thing.
- **Never invent data.** A missing quote, a missing article body, or a missing
  filing stays missing. No estimates, no backfills, no defaults that read as
  real values.
- **Every gate change needs a before/after** on the daily funnel counts, so the
  effect on the record is visible rather than asserted.

## Observations

> What you noticed. Undated entries are fine; Claude will date them.

- **2026-08-21** — Multiple consecutive days with zero trades. Triggered the
  funnel instrumentation below.

## Done

- **2026-08-21** — Dated trade / no-trade record, per-day funnel analysis, and
  this notes channel. See `worker/funnel.ts` and the Daily Record section of the
  dashboard.
- **2026-08-21** — Separated *extension* from *confirmation* in scoring. The
  "already up 8%, no chasing" guard was measuring the move since Atlas first
  saw the story, not the move on the day, so a stock already up 12% read as
  unmoved if Atlas first looked at the top.

---

## How to read the daily record

Each session gets one row with a verdict. The verdicts are not
interchangeable and the difference is the point:

- **`TRADED`** — positions opened.
- **`NO_QUALIFYING_SETUP`** — plenty was scored, nothing cleared the gates.
  This is the system working. A run of these is information about the market,
  not a defect.
- **`BLOCKED_BY_RISK`** — most rejections came from deliberate safety rules
  (halts, wash-sale blackout, manipulation screen). Also working as designed.
- **`PIPELINE_STARVED`** — no stories, nothing scored, or a scan reported
  insufficient data. **This zero is Atlas's fault, not the market's**, and is
  the only kind that is always worth fixing.
- **`NOT_A_TRADING_DAY`** — market closed.

The `actionable` flag is the one to watch. It is set when the day's zero came
from missing evidence rather than from an absent setup — that is where changes
actually buy something.
