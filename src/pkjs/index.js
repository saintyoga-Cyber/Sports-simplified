var timeline = require('./timeline');

var COMPANION_URL = 'https://pebble-connect--saintyoga1.replit.app';
var POLL_INTERVAL_MS = 2 * 60 * 1000;

// localStorage keys for persisted settings (written by the
// webviewclosed handler after the user saves on the hosted
// settings page).
//
// LS_FOLLOWED holds the multi-sport map of the user's followed-team
// selections, keyed by sport id, e.g. { "nhl": ["10"], "fifa-wc":
// ["CAN"] }. LS_ACTIVE_SPORT holds the sport id the user most
// recently saved on the settings page; it drives buildSnapshotQuery
// and sportIcon so the watch keeps polling/displaying one sport at
// a time even though the followed map can carry several.
//
// LS_SPORT_LEGACY and LS_TEAMS_LEGACY are the previous single-sport
// keys, retained here only so getSavedFollowed() can perform a
// one-shot migration on first read after upgrade.
var LS_FOLLOWED = 'sports_followed';
var LS_ACTIVE_SPORT = 'sports_active_sport';
var LS_SPORT_LEGACY = 'sports_selected_sport';
var LS_TEAMS_LEGACY = 'sports_followed_teams';

// One-shot migration + read of the multi-sport followed map.
// On first read after upgrade, copies the old single-sport keys into
// the new shape, seeds LS_ACTIVE_SPORT from the old LS_SPORT_LEGACY,
// and removes both legacy keys so subsequent reads see only the new
// shape. Always returns a plain object (possibly empty).
function getSavedFollowed() {
  try {
    var raw = localStorage.getItem(LS_FOLLOWED);
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
      return {};
    }
    var oldSport = localStorage.getItem(LS_SPORT_LEGACY);
    var oldTeamsRaw = localStorage.getItem(LS_TEAMS_LEGACY);
    if (oldSport && oldTeamsRaw) {
      var oldTeams = JSON.parse(oldTeamsRaw);
      if (Array.isArray(oldTeams)) {
        var migrated = {};
        migrated[oldSport] = oldTeams;
        try { localStorage.setItem(LS_FOLLOWED, JSON.stringify(migrated)); } catch (e1) {}
        try { localStorage.setItem(LS_ACTIVE_SPORT, oldSport); } catch (e2) {}
        try { localStorage.removeItem(LS_SPORT_LEGACY); } catch (e3) {}
        try { localStorage.removeItem(LS_TEAMS_LEGACY); } catch (e4) {}
        console.log('sports: migrated legacy settings to multi-sport followed map');
        return migrated;
      }
    }
    return {};
  } catch (e) {
    return {};
  }
}

function getSavedSport() {
  try {
    // Reading getSavedFollowed() first guarantees the legacy migration
    // runs (and seeds LS_ACTIVE_SPORT) before we read LS_ACTIVE_SPORT.
    getSavedFollowed();
    return localStorage.getItem(LS_ACTIVE_SPORT) || '';
  } catch (e) {
    return '';
  }
}

function getSavedTeamIds() {
  var followed = getSavedFollowed();
  var sport = getSavedSport();
  if (!sport) return [];
  var teams = followed[sport];
  return Array.isArray(teams) ? teams : [];
}

var pollTimer = null;
// Master gate. Any in-flight fetch callback that resolves after
// stopPolling() must NOT be allowed to schedule another tick.
var isPollingActive = false;
// gameIds we've seen in 'in-game' state and not yet finalised.
var activeGameIds = {};
// gameIds we've already pushed a terminal-state pin for this session,
// so we don't spam final/postponed/canceled pins on every tick.
var pushedFinalIds = {};
// gameIds we've already pushed a scheduled-state pin for this session,
// so we don't spam upcoming-game pins on every tick. Cleared per-id
// when the game transitions to in-game, so the live pin overwrites
// the scheduled pin on the timeline.
var pushedScheduledIds = {};
// Window in which an upcoming scheduled game is eligible for a pin.
// Pebble's timeline already supports far-future pins, but capping at
// 48h keeps the watch's pin set focused on near-term games.
var SCHEDULED_WINDOW_MS = 48 * 60 * 60 * 1000;

// ---------- snapshot fetch ----------

function buildSnapshotQuery() {
  var sport = getSavedSport();
  var teams = getSavedTeamIds();
  var params = [];
  if (sport) params.push('sport=' + encodeURIComponent(sport));
  if (teams.length > 0) params.push('teams=' + encodeURIComponent(teams.join(',')));
  return params.length > 0 ? '?' + params.join('&') : '';
}

function fetchSnapshot(cb) {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', COMPANION_URL + '/api/sports/games' + buildSnapshotQuery(), true);
  // Hard cap so a stalled snapshot fetch can't kill the polling loop.
  // Without this, a TCP-level stall leaves tick()'s callback un-fired
  // and scheduleNext() is never called, so the loop dies silently.
  xhr.timeout = 10000;
  xhr.ontimeout = function() { cb(new Error('snapshot timeout'), []); };
  xhr.onload = function() {
    if (xhr.status >= 200 && xhr.status < 300) {
      try {
        var data = JSON.parse(xhr.responseText);
        cb(null, (data && data.games) || []);
      } catch (e) {
        cb(e, []);
      }
    } else {
      cb(new Error('snapshot status ' + xhr.status), []);
    }
  };
  xhr.onerror = function() { cb(new Error('snapshot network error'), []); };
  xhr.send();
}

// ---------- pin factory ----------

function teamLabel(team) {
  if (!team) return '';
  return team.abbreviation || team.shortDisplayName || team.displayName || '';
}

// Format an ISO 8601 start time as "MM/DD HH:MM" in the phone's local
// timezone. PebbleKit JS Date methods are reliable for getMonth/Date/
// Hours/Minutes; toLocaleString is not, so we hand-roll the format.
function formatStartTime(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
  return pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function buildBody(game) {
  var away = teamLabel(game.awayTeam);
  var home = teamLabel(game.homeTeam);
  var score = away + ' ' + game.awayScore + ' - ' + game.homeScore + ' ' + home;

  if (game.state === 'final') return 'Final: ' + score;
  if (game.state === 'postponed') return 'Postponed: ' + away + ' @ ' + home;
  if (game.state === 'canceled') return 'Canceled: ' + away + ' @ ' + home;
  // Server emits 'pre-game' for upcoming games (see
  // shared/schema.ts GameState). Accept 'scheduled' too as a
  // forward-compat alias.
  if (game.state === 'pre-game' || game.state === 'scheduled') {
    return 'Scheduled: ' + away + ' @ ' + home + ' — ' +
      formatStartTime(game.startTime);
  }
  if (game.state === 'in-game') {
    var clockBits = [];
    if (game.period) clockBits.push(game.period);
    if (game.clock) clockBits.push(game.clock);
    var suffix = clockBits.length ? ' (' + clockBits.join(' ') + ')' : '';
    return score + suffix;
  }
  return score;
}

function buildTitle(game) {
  var away = teamLabel(game.awayTeam);
  var home = teamLabel(game.homeTeam);
  return away + ' @ ' + home;
}

// Map the saved sport setting to the matching Pebble system tinyIcon.
// Falls back to the generic SCHEDULED_EVENT icon for unknown values
// (including the empty string a brand-new install has before the user
// opens settings for the first time).
function sportIcon() {
  var sport = getSavedSport();
  if (sport === 'nhl')      return 'system://images/HOCKEY_GAME';
  if (sport === 'fifa-wc')  return 'system://images/SOCCER_GAME';
  if (sport === 'nba')      return 'system://images/BASKETBALL_GAME';
  if (sport === 'nfl')      return 'system://images/AMERICAN_FOOTBALL_GAME';
  if (sport === 'mlb')      return 'system://images/BASEBALL_GAME';
  return 'system://images/SCHEDULED_EVENT';
}

function createSportsPin(game) {
  return {
    id: 'sports-' + game.gameId,
    time: game.startTime,
    layout: {
      type: 'genericPin',
      title: buildTitle(game),
      body: buildBody(game),
      tinyIcon: sportIcon()
    }
  };
}

// ---------- push handling ----------

function pushPin(game, label) {
  var pin = createSportsPin(game);
  console.log('sports: PUT pin ' + pin.id + ' [' + label + '] ' + pin.layout.body);
  timeline.insertUserPin(pin, function(responseText, status) {
    console.log('sports: pin ' + pin.id + ' status=' + status);
    if (status === 401 || status === 410) {
      // timeline.js calls Pebble.getTimelineToken() on every request, so
      // the next tick will automatically pick up a refreshed token. Log
      // explicitly so token expiry is visible in the JS console.
      console.log('sports: pin ' + pin.id + ' auth rejected (' + status +
        '), next tick will refetch timeline token');
      return;
    }
    if (status < 200 || status >= 300) {
      console.log('sports: pin ' + pin.id + ' failed: ' + responseText);
    }
  });
}

// ---------- polling controller ----------

function tick() {
  if (!isPollingActive) {
    console.log('sports: tick aborted (polling inactive)');
    return;
  }
  fetchSnapshot(function(err, games) {
    if (!isPollingActive) {
      // Watchapp exited while the fetch was in flight. Drop the result
      // and do NOT schedule another tick.
      console.log('sports: snapshot returned after stop — discarding');
      return;
    }
    if (err) {
      console.log('sports: fetch failed: ' + err.message);
      scheduleNext(true);
      return;
    }

    var stillLive = false;

    for (var i = 0; i < games.length; i++) {
      var game = games[i];
      if (!game || !game.gameId) continue;

      if (game.state === 'in-game') {
        activeGameIds[game.gameId] = true;
        delete pushedFinalIds[game.gameId];
        // Drop any prior scheduled-pin bookkeeping for this game so a
        // future scheduled state (rare but possible on data corrections)
        // would re-push, and so the live pushPin's same-id overwrite
        // semantically replaces the scheduled pin on the timeline.
        delete pushedScheduledIds[game.gameId];
        pushPin(game, 'live');
        stillLive = true;
      } else if (game.state === 'pre-game' || game.state === 'scheduled') {
        // Push a pre-game pin once per session for any upcoming game
        // whose start time is within the next 48 hours. Pin id is
        // 'sports-' + gameId, so when the game later transitions to
        // in-game the live pushPin overwrites this pre-game pin in
        // place on the timeline. The server's GameState enum (see
        // shared/schema.ts) uses 'pre-game'; 'scheduled' is accepted
        // as a forward-compat alias.
        if (!pushedScheduledIds[game.gameId]) {
          var startMs = game.startTime ? new Date(game.startTime).getTime() : NaN;
          if (!isNaN(startMs)) {
            var diffMs = startMs - Date.now();
            if (diffMs >= 0 && diffMs <= SCHEDULED_WINDOW_MS) {
              pushPin(game, 'scheduled');
              pushedScheduledIds[game.gameId] = true;
            }
          }
        }
      } else if (game.state === 'final' || game.state === 'postponed' ||
                 game.state === 'canceled') {
        // Push a terminal pin once per session per gameId. Covers both:
        // (a) games we tracked as in-game this session that just ended,
        // (b) recently-final games already in the snapshot when the
        //     watchapp opened (so the user still gets a pin update).
        if (!pushedFinalIds[game.gameId]) {
          pushPin(game, game.state);
          pushedFinalIds[game.gameId] = true;
          delete activeGameIds[game.gameId];
        }
      }
    }

    if (stillLive) {
      scheduleNext(false);
    } else {
      // No live games — hand off to C's wakeup scheduler instead of
      // staying in the local JS poll loop. C receives SPORTS_POLL_RESULT=0
      // and schedules the next wakeup at the upcoming 4am or 4pm; the
      // watchapp re-launches at that time and SPORTS_APP_OPEN flows back
      // through the appmessage handler to startPolling() again.
      //
      // CRITICAL: stopPolling() must run only after C acks the send.
      // If we stop unconditionally and the AppMessage drops, C never
      // schedules a wakeup and the autonomous loop is dead until the
      // user manually relaunches. On send failure we keep the JS poll
      // loop alive (scheduleNext) so the next tick re-attempts the
      // handoff using the existing 2-minute retry cadence.
      console.log('sports: no live games — notifying C, awaiting next wakeup');
      sendPollResult(0, function(err) {
        if (!isPollingActive) return;
        if (err) {
          console.log('sports: SPORTS_POLL_RESULT failed — retrying on next tick');
          scheduleNext(true);
        } else {
          stopPolling();
        }
      });
    }
  });
}

function scheduleNext(isRetry) {
  if (!isPollingActive) return;
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
  if (isRetry) console.log('sports: retrying in ' + (POLL_INTERVAL_MS / 1000) + 's');
}

function startPolling() {
  if (isPollingActive) return;
  console.log('sports: starting poll loop');
  // Reset session state so a re-opened watchapp session re-emits
  // terminal-state pins for any games that finished while we were
  // stopped. Without this, finals for already-tracked gameIds would
  // be silently skipped.
  activeGameIds = {};
  pushedFinalIds = {};
  pushedScheduledIds = {};
  isPollingActive = true;
  tick();
}

function stopPolling() {
  if (!isPollingActive && !pollTimer) return;
  console.log('sports: stopping poll loop');
  isPollingActive = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

// ---------- Pebble lifecycle ----------

// Helper: read an appmessage payload value by string key OR numeric index.
function readKey(payload, name) {
  if (!payload) return undefined;
  if (payload[name] !== undefined) return payload[name];
  // Fallback: messageKeys are exposed as 0-based numeric indices when the
  // C side uses MESSAGE_KEY_<NAME> integers directly.
  var idx = MESSAGE_KEYS_INDEX[name];
  if (idx !== undefined && payload[idx] !== undefined) return payload[idx];
  return undefined;
}

// Indices MUST match pebble.messageKeys in package.json.
// SPORTS_APP_OPEN (2) and SPORTS_APP_EXIT (3) are the C-side
// appmessage lifecycle keys. SPORTS_POLL_RESULT (4) carries the
// live-game count back to C so it can schedule the next wakeup.
// The SPORT (0) and TEAMS (1) entries in the manifest are legacy —
// settings now flow through the hosted /settings page and
// webviewclosed JSON, not appmessage.
var MESSAGE_KEYS_INDEX = {
  SPORTS_APP_OPEN: 2,
  SPORTS_APP_EXIT: 3,
  SPORTS_POLL_RESULT: 4
};

// Notify C of the live-game count so it can decide whether to
// schedule a wakeup. Currently we only send 0 (the "go idle, please
// wake me at the next 4am/4pm" signal); a future change could send
// the live count to let C reason about active polling sessions.
// Invokes onSent(null) on ack from C, or onSent(Error) on failure;
// callers MUST wait for the ack before stopPolling(), otherwise a
// dropped send leaves C without a wakeup scheduled and breaks the
// autonomous loop.
function sendPollResult(count, onSent) {
  Pebble.sendAppMessage(
    { 'SPORTS_POLL_RESULT': count },
    function() {
      console.log('sports: SPORTS_POLL_RESULT=' + count + ' sent');
      if (onSent) onSent(null);
    },
    function(e) {
      var msg = (e && e.error && e.error.message) || 'unknown';
      console.log('sports: SPORTS_POLL_RESULT send failed: ' + msg);
      if (onSent) onSent(new Error(msg));
    }
  );
}

Pebble.addEventListener('ready', function() {
  console.log('Sports Simplified pkjs ready');
  // 'ready' fires when pkjs spins up alongside the watchapp launch — in
  // PebbleKit JS this is the de-facto watchapp-open signal. The
  // SPORTS_APP_OPEN/EXIT appmessage handler below lets the C side
  // override this gating once the matching C wiring lands.
  // (timeline.js fetches a fresh timeline token on every insertUserPin,
  //  so no upfront token fetch is needed here.)
  startPolling();
});

// Explicit watchapp lifecycle from C: keeps the polling loop strictly
// gated on watchapp open/exit instead of relying on JS-process lifetime.
Pebble.addEventListener('appmessage', function(e) {
  var payload = e && e.payload;
  if (readKey(payload, 'SPORTS_APP_OPEN') !== undefined) {
    console.log('sports: appmessage SPORTS_APP_OPEN — starting poll loop');
    startPolling();
  }
  if (readKey(payload, 'SPORTS_APP_EXIT') !== undefined) {
    console.log('sports: appmessage SPORTS_APP_EXIT — stopping poll loop');
    stopPolling();
  }
});

// ---------- Settings (hosted on companion server) ----------

Pebble.addEventListener('showConfiguration', function() {
  var sport = getSavedSport() || 'nhl';
  var followed = getSavedFollowed();
  var base = COMPANION_URL + '/settings';
  // Send the active sport so the page opens on the right tab, plus
  // the full multi-sport followed map so the page can pre-select
  // each sport's saved teams as the user switches the dropdown.
  var params = 'sport=' + encodeURIComponent(sport) +
               '&followed=' + encodeURIComponent(JSON.stringify(followed));
  Pebble.openURL(base + '?' + params);
});

Pebble.addEventListener('webviewclosed', function(e) {
  if (!e || !e.response) return;
  var settings;
  try {
    settings = JSON.parse(decodeURIComponent(e.response));
  } catch (err) {
    console.log('sports: webviewclosed parse error: ' + err.message);
    return;
  }
  var sport = settings && settings.SPORT;
  var teams = settings && settings.TEAMS;
  if (!sport || typeof sport !== 'string' || sport.length === 0) {
    console.log('sports: webviewclosed missing SPORT — ignoring payload');
    return;
  }
  if (!Array.isArray(teams)) {
    console.log('sports: webviewclosed missing TEAMS array — ignoring payload');
    return;
  }
  // Merge the page's single-sport result into the persisted multi-sport
  // map so editing one sport's selection never wipes the others.
  var followed = getSavedFollowed();
  followed[sport] = teams;
  try { localStorage.setItem(LS_FOLLOWED, JSON.stringify(followed)); } catch (e2) {}
  try { localStorage.setItem(LS_ACTIVE_SPORT, sport); } catch (e3) {}
  console.log('sports: saved active sport=' + sport +
              ' teams=' + teams.join(',') +
              ' followed=' + JSON.stringify(followed));
});
