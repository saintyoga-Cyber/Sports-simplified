var timeline = require('./timeline');
var Clay = require('./clay');
var buildClayConfig = require('./clay-config');

var COMPANION_URL = 'https://pebble-connect--saintyoga1.replit.app';
var POLL_INTERVAL_MS = 2 * 60 * 1000;

// localStorage keys for Clay-driven settings.
var LS_SPORT = 'sports_selected_sport';
var LS_TEAMS = 'sports_followed_teams';

function getSavedSport() {
  try {
    return localStorage.getItem(LS_SPORT) || '';
  } catch (e) {
    return '';
  }
}

function getSavedTeamIds() {
  try {
    var raw = localStorage.getItem(LS_TEAMS);
    if (!raw) return [];
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

// Clay needs a config object at construction time. Start with an empty
// teams list — we rebuild and overwrite clay.config on every settings
// open so the team picker is always populated from the live server.
//
// The customFn runs INSIDE the Clay webview on the phone (not in pkjs).
// Clay serialises it via .toString() before injecting into the webview,
// so closures/free variables from this scope do NOT survive. We build
// a self-contained Function whose body has COMPANION_URL inlined as a
// string literal.
// clay-config.clayCustomFn is a FACTORY: clayCustomFn(companionUrl)
// returns the actual handler that Clay should invoke with `this` set
// to the Clay instance. We must (a) call the factory with the URL,
// then (b) call the returned handler with the Clay context.
var clayCustomFnBody =
  '((' + buildClayConfig.clayCustomFn.toString() + ')(' +
  JSON.stringify(COMPANION_URL) + ')).call(this);';
// eslint-disable-next-line no-new-func
var clayCustomFn = new Function(clayCustomFnBody);

var clay = new Clay(
  buildClayConfig({ sport: 'nhl', teams: [], followedTeamIds: [] }),
  clayCustomFn,
  { autoHandleEvents: false }
);

var pollTimer = null;
// Master gate. Any in-flight fetch callback that resolves after
// stopPolling() must NOT be allowed to schedule another tick.
var isPollingActive = false;
// gameIds we've seen in 'in-game' state and not yet finalised on Rebble.
var activeGameIds = {};
// gameIds we've already pushed a terminal-state pin for this session,
// so we don't spam final/postponed/canceled pins on every tick.
var pushedFinalIds = {};

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

function buildBody(game) {
  var away = teamLabel(game.awayTeam);
  var home = teamLabel(game.homeTeam);
  var score = away + ' ' + game.awayScore + ' - ' + game.homeScore + ' ' + home;

  if (game.state === 'final') return 'Final: ' + score;
  if (game.state === 'postponed') return 'Postponed: ' + away + ' @ ' + home;
  if (game.state === 'canceled') return 'Canceled: ' + away + ' @ ' + home;
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

function createSportsPin(game) {
  return {
    id: 'sports-' + game.gameId,
    time: game.startTime,
    layout: {
      type: 'genericPin',
      title: buildTitle(game),
      body: buildBody(game),
      tinyIcon: 'system://images/HOCKEY_GAME'
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
        pushPin(game, 'live');
        stillLive = true;
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
      console.log('sports: no live games — stopping poll loop');
      stopPolling();
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

// Indices MUST match pebble.messageKeys in package.json. SPORT (0) and
// TEAMS (1) are owned by Clay; SPORTS_APP_OPEN (2) and SPORTS_APP_EXIT
// (3) are the C-side appmessage lifecycle keys.
var MESSAGE_KEYS_INDEX = {
  SPORTS_APP_OPEN: 2,
  SPORTS_APP_EXIT: 3
};

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

// ---------- Clay-driven settings ----------

function fetchTeamsForSport(sport, cb) {
  var xhr = new XMLHttpRequest();
  xhr.open(
    'GET',
    COMPANION_URL + '/api/sports/teams?sport=' + encodeURIComponent(sport),
    true
  );
  xhr.onload = function() {
    if (xhr.status >= 200 && xhr.status < 300) {
      try {
        var data = JSON.parse(xhr.responseText);
        cb(null, Array.isArray(data) ? data : []);
      } catch (e) {
        cb(e, []);
      }
    } else {
      cb(new Error('teams status ' + xhr.status), []);
    }
  };
  xhr.onerror = function() { cb(new Error('teams network error'), []); };
  xhr.send();
}

Pebble.addEventListener('showConfiguration', function() {
  // Clay is constructed with autoHandleEvents:false so we can fetch the
  // live team list from the companion server first, rebuild the config
  // dynamically, and then hand the URL to Pebble.openURL ourselves.
  var sport = getSavedSport() || 'nhl';
  var followed = getSavedTeamIds();

  fetchTeamsForSport(sport, function(err, teams) {
    if (err) {
      console.log('sports: settings teams fetch failed: ' + err.message +
        ' — falling back to empty team list');
      teams = [];
    }
    clay.config = buildClayConfig({
      sport: sport,
      teams: teams,
      followedTeamIds: followed
    });
    Pebble.openURL(clay.generateUrl());
  });
});

Pebble.addEventListener('webviewclosed', function(e) {
  // Settings webview closed. Do NOT stop polling here — settings can be
  // opened mid-session while a live game is being tracked. The poll
  // loop is gated by SPORTS_APP_EXIT (from C) or natural drain when no
  // live games remain.
  if (!e || !e.response) {
    console.log('sports: webviewclosed (cancelled, no payload)');
    return;
  }

  var settings;
  try {
    settings = clay.getSettings(e.response);
  } catch (err) {
    console.log('sports: clay.getSettings failed: ' + err.message);
    return;
  }

  if (!settings) {
    console.log('sports: webviewclosed (no settings parsed)');
    return;
  }

  // Clay wraps each value as { value: ... } for messageKey-mapped items.
  function unwrap(v) { return v && typeof v === 'object' && 'value' in v ? v.value : v; }
  var sport = unwrap(settings.SPORT);
  var teams = unwrap(settings.TEAMS);

  if (sport === 'nhl' || sport === 'fifa-wc') {
    try { localStorage.setItem(LS_SPORT, sport); } catch (err) {}
    console.log('sports: saved sport=' + sport);
  }
  if (Array.isArray(teams)) {
    try { localStorage.setItem(LS_TEAMS, JSON.stringify(teams)); } catch (err) {}
    console.log('sports: saved followed teams=' + teams.join(','));
  }
});
