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

> **REVISED 2026-06-10** after reading the Core Devices mobile app
> source (`coredevices/mobileapp`, open source). The earlier theory
> below ("KV poisoned from an emulator session") was wrong. The real
> mechanism is worse: with the Core Devices phone app, **server-pushed
> pins cannot reach the watch at all**, regardless of token.

### How the Core Devices app actually handles the timeline

Verified in `coredevices/mobileapp` source:

1. **`LibPebbleConfig.kt`** — `emulateRemoteTimeline: Boolean = true`.
   The Core app *emulates* the remote timeline by default. There is a
   user-facing toggle in the app's watch settings
   (`WatchSettingsScreen.kt`).
2. **`RemoteTimelineEmulator.kt`** — when emulation is on, pkjs
   `XMLHttpRequest` calls to `timeline-api.rebble.io/v1/user/pins/…`
   are **intercepted on the phone** and the pin is written to a local
   database. Nothing is ever sent to Rebble's web service. This is why
   in-app pushes "work": they never leave the phone.
3. **`JsTokenUtil.kt`** — `getTimelineToken()` returns the app's real
   Rebble-appstore `userToken` if present in the locker, otherwise the
   literal fallback string **`"emulated-dummy-token"`** (when emulation
   is on). A sideloaded app has no appstore data → our real phone
   returns the dummy token. *That* is where the KV poison came from —
   not the SDK emulator.
4. There is **no remote-timeline sync client anywhere in the Core app**
   — the only reference to `timeline-api.rebble.io` in the entire
   codebase is the interceptor. Even with a valid token, pins PUT by
   the Cloudflare Worker to Rebble's web timeline are never fetched by
   the phone and never reach the watch.

### Consequences

- The Worker's background push architecture is **incompatible with the
  Core Devices app today**. No token fix, retry loop, or KV cleanup can
  make it work. The June 5–9 dummy-token work treated a symptom.
- The token retry loop in `registerWithServer()` will simply retry 5×
  and give up on every cold start (the dummy token never becomes real).
  Harmless, but pointless on this phone app.
- The **only working background refresh** path on the current Core app
  is the one already built into `main.c`: the 4am/4pm `wakeup` API
  launches the watchapp, pkjs polls, and pins are pushed locally. This
  works end-to-end without the Worker.

### Options going forward (decide before any code change)

| Option | Effort | Outcome |
|---|---|---|
| A. Rely on wakeup-based refresh (already implemented); optionally add more wakeup slots (e.g. every 3–4 h — `wakeup_schedule` is per-app limited to 8 pending) | Low | Pins refresh a few times a day without opening the app |
| B. Upstream contribution / feature request to `coredevices/mobileapp` for real remote-timeline sync | External | True server push for everyone, eventually |
| C. Keep Worker for the snapshot API only; stop pushing pins from cron (dead code path on Core app) | Low | Simpler system, no false hope |

### Superseded theory (kept for the record)

A correction to `FIX-PLAN-timeline-token.md` (worker repo): its
architecture table claims the local push path uses an "internal opaque
session token". That is wrong — `timeline.js` calls
`Pebble.getTimelineToken()` and sends it as `X-User-Token`; both paths
use the same token. The "poisoned from an emulator session" theory is
also wrong; see `JsTokenUtil.kt` above.

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

## Improvement requests (2026-06-10) — pin appearance & "Open App" action

### Request 1 — Native big-score scoreboard (docs screenshot)

The screenshot is the **native `sportsPin` scoreboard** rendered by the
firmware from the sports attributes (`nameAway/nameHome`,
`scoreAway/scoreHome`, `sportsGameState`, …). Our pins already declare
`type: 'sportsPin'` and populate every one of those fields.

**Why it doesn't render:** `RemoteTimelineEmulator.applyAttributesFrom()`
in the Core Devices phone app forwards only the generic attributes
(title, subtitle, body, icons, colors, headings, paragraphs,
lastUpdated) to the watch. **All sports attributes are silently
dropped.** The firmware itself supports the layout (`sportsPin = 7` in
`coredevices/PebbleOS` `layouts.json.in`), but the phone never delivers
the data it needs. This also retroactively validates the May 4 commit
(`88f1ece`) that crammed everything into generic fields — that is still
the correct workaround.

**Conclusion: not achievable from this repo today.** Any change here
(e.g. removing `body` again per the May 3 finding) would make pins
*emptier*, not scoreboard-shaped, because the score data never reaches
the watch. The fix belongs upstream in `coredevices/mobileapp`
(`applyAttributesFrom` needs to map the sports attribute IDs that
`Timeline.kt` already defines). Recommended action: file an upstream
issue / PR; keep our sports-* fields populated so pins light up the
moment Core ships the mapping.

### Request 2 — "Open Sports Simplified" entry in the pin action menu

Already implemented on our side: every pin (pkjs **and** Worker)
carries

```js
actions: [{ type: 'openWatchApp', title: 'Open Sports App', launchCode: 1 }]
```

since May 24 (`d90c51d`, `ee02405`; worker `ba65785`).

**Why it doesn't appear:** in `RemoteTimelineEmulator.kt` the Core app
*parses* the action type (`"openWatchApp" → Action.Type.OpenWatchapp`)
but the code that attaches actions to the stored pin is **commented out
with a `// TODO developer actions` note**. The action is recognized and
then discarded, so the watch menu only shows the system "Remove" entry.

**Conclusion: not achievable from this repo today.** No pin JSON we
emit can survive that TODO. Our pins already carry the correct action
and will show "Open Sports App" automatically once Core Devices
implements it. Recommended action: same upstream issue. (Side note: the
`allowJs` capability added by `d90c51d` is not a real Pebble capability
and never affected this — it can be removed in a future cleanup.)

---

## Process recommendation

The June 9 merge of a three-week-old branch is what reverted a required
field without anyone noticing. Before merging any PR, rebase it onto the
current main (or at minimum diff the merge result against main) and
re-check the pin payload against the sportsPin schema. Stale branches in
this repo are dangerous because pin-layout knowledge changes weekly.
