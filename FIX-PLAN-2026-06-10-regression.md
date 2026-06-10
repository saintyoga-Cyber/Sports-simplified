# Fix Plan: June 2026 Regression — "Nothing Works Anymore"

**Status:** APPLIED (2026-06-10, branch `claude/modest-carson-tfd13p`)
- Fix 1 (restore `largeIcon`) — applied, commit `f0b0ba5`
- Fix 2 (`isAppOpen=true` on `ready`) — applied, commit `994134f`
- Fix 3 (records out of subtitle, into body) — applied, commit `6fc1dca`
- Background-pin verification (Root Cause 3) — PENDING: requires the
  Cloudflare dashboard (KV contents + cron logs), not reachable from
  the development sandbox. See checklist below.
- On-watch verification of Fixes 1–3 — PENDING: rebuild `.pbw`,
  sideload, confirm `status=200` on pin pushes.
**Repos affected:** `Sports-simplified` (pkjs), `-pebble-sports-worker` (verification only)
**Baseline:** Last known-good = June 3 (`c5bfb7e` watchapp / `344e869` worker):
pins updated on app open, no background updates.
**Current symptom:** No pins at all, even when opening the watchapp.

---

## Root Cause 1 — CRITICAL: PR #1 removed `largeIcon` from the sportsPin layout

**Commit:** `8f3ace0` (merge of PR #1 `improve-pregame-pin-layout`, June 9)
**File:** `src/pkjs/index.js`, `createSportsPin()`

The merged PR deleted this line from the pin layout:

```js
largeIcon: sportIcon(),
```

Per the official Pebble pin schema, **`largeIcon` is REQUIRED for the
`sportsPin` layout** (it is optional for `genericPin`, but required for
`sportsPin` and `weatherPin`). The Rebble timeline API validates pins
against this schema and rejects non-conforming pins with **HTTP 400**.

Because the watchapp's in-app pin path goes straight to
`timeline-api.rebble.io` (`timeline.js` → `insertUserPin`), **every single
pin PUT now fails with 400** — live, pre-game, and final. This is why
nothing updates anymore, even with the app open.

Corroborating evidence:

- The Worker's own pin builder (`-pebble-sports-worker/src/pin.ts:266`)
  still includes `largeIcon: sportIcon(game.sport)` — the two sides are
  now inconsistent, and the side that dropped it is the side that broke.
- Timing matches exactly: stable on June 3, broken after the June 9 merge.
- The PR branch was authored **May 19** and merged into the June codebase
  three weeks later — a stale-branch merge that bypassed everything
  learned in between.

### Fix 1 (CRITICAL — must ship alone, no bundling)

One line in `createSportsPin()` in `src/pkjs/index.js`. Restore:

```js
tinyIcon: sportIcon(),
largeIcon: sportIcon(),   // ← restore; REQUIRED by sportsPin schema
```

**Verification:**
1. Rebuild `.pbw`, sideload.
2. Watch the pkjs console (or temporarily set `DEBUG_PIN_PUSH = true` in
   `timeline.js`): every `PUT pin sports-…` must log `status=200`, not 400.
3. Confirm pins reappear on the timeline when opening the app.

This restores the June 3 baseline. Everything else below is secondary.

---

## Root Cause 2 — HIGH: cold-start race leaves `isAppOpen=false` while the app is open

**Commit:** `1821a7b` (June 10)

`ready` now starts with `isAppOpen = false` and relies on `main.c`
sending `SPORTS_APP_OPEN` at launch. The problem:

- `init()` in `main.c` sends `SPORTS_APP_OPEN` **once**, immediately at
  launch, with no ACK handling and no retry
  (`send_lifecycle_msg` ignores failure).
- At cold start, pkjs is not yet running when that message is sent — the
  message is dropped. `ready` fires *afterwards*.
- Result: `isAppOpen` stays `false` for the whole cold-start session.
  After the first tick with no live games, the poll loop halts while the
  user is still looking at the app — no near-real-time refresh of
  pre-game/final pins (the behavior that previously worked).

The reopen path (warm JS, app relaunched) is the one case the June 10
commit fixes, and that part is sound — when pkjs is already alive,
`SPORTS_APP_OPEN` *is* received.

### Fix 2 (ship alone, after Fix 1 is verified)

In the `ready` handler in `src/pkjs/index.js`, restore:

```js
isAppOpen = true;
```

Rationale: pkjs only cold-starts when the watchapp launches, so at
`ready` the app is *by definition* open. The warm-reopen case stays
covered by the `SPORTS_APP_OPEN` handler (unchanged). The stale-`true`
risk the June 10 commit was guarding against is bounded: the next
no-live-games tick after `SPORTS_APP_EXIT` stops the loop.

**Optional hardening (separate, later):** make `send_lifecycle_msg` in
`main.c` retry on NACK via `app_message_register_outbox_failed`, so
lifecycle messages stop being fire-and-forget.

---

## Root Cause 3 — Background pins (the original, pre-June-3 issue)

A correction to `FIX-PLAN-timeline-token.md` (worker repo): its
architecture table claims the local push path uses an "internal opaque
session token". **That is wrong.** `timeline.js` calls
`Pebble.getTimelineToken()` and sends it as `X-User-Token` — the local
path and the Worker use the **same token**.

Implication: since local pushes worked on June 3, the phone is returning
a **real** token. `emulated-dummy-token` is the hardcoded token of the
**SDK emulator** (pypkjs). The most likely way KV got poisoned is a
registration made from an emulator session — not a token-exchange race
on the real phone. The June 5–9 retry logic is harmless but will never
turn a dummy token real inside the emulator; on the real phone the real
token passes on the first attempt.

### What to verify (no code changes; cannot be probed from this sandbox)

1. **KV contents:** in the Cloudflare dashboard, inspect the registered
   user entry. Is `timelineToken` a real UUID-like value, and does its
   prefix match the `sports: timelineToken=[…]` line logged by the watch?
2. **Stale poison:** the Worker now *rejects* dummy tokens at ingestion
   (`74f389f`), but a previously poisoned KV entry is **not** cleaned up
   by that change. If a dummy entry is still there, delete it manually,
   then open the watchapp once (after Fix 1) to re-register.
3. **Cron logs:** check `[timeline] PUT sports-… → <status>` lines.
   - `401/410` → token in KV is bad (see 1–2).
   - `400` → pin payload problem on the Worker side.
   - `200` with no pin on watch → pin `time` outside the timeline window.
4. Only after 1–3 are answered does it make sense to plan further
   background-pin work.

---

## Minor — PR #1 put a newline inside `subtitle`

For pre-game pins, `subtitle` now becomes
`"Starts in 2h 5m\nBOS 45-20 · NYK 40-25"`. Subtitle is a single-line
field on the watch; embedded newlines render unpredictably. Recommend
moving the records line back into `body` (where it lived before).
Cosmetic — do **not** bundle with Fix 1 or Fix 2.

---

## Deployment order

| Step | Change | Repo | Criticality |
|---|---|---|---|
| 1 | Fix 1: restore `largeIcon` | Sports-simplified | CRITICAL — alone |
| 2 | Verify pins return 200 / appear on watch | — | — |
| 3 | Fix 2: `isAppOpen = true` on `ready` | Sports-simplified | HIGH — alone |
| 4 | Background-pin verification checklist (KV, logs) | worker (no code) | — |
| 5 | Subtitle newline cleanup | Sports-simplified | cosmetic |

## Process recommendation

The June 9 merge of a three-week-old branch is what reverted a required
field without anyone noticing. Before merging any PR, rebase it onto the
current main (or at minimum diff the merge result against main) and
re-check the pin payload against the sportsPin schema. Stale branches in
this repo are dangerous because pin-layout knowledge changes weekly.
