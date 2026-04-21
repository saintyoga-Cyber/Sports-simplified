var timeline = require('./timeline');

var COMPANION_URL = 'https://pebble-connect--saintyoga1.replit.app';
var POLL_INTERVAL_MS = 2 * 60 * 1000;

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

function fetchSnapshot(cb) {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', COMPANION_URL + '/api/sports/games', true);
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

// Order MUST match pebble.messageKeys in package.json.
var MESSAGE_KEYS_INDEX = {
  SPORTS_APP_OPEN: 0,
  SPORTS_APP_EXIT: 1
};

Pebble.addEventListener('ready', function() {
  console.log('Sports Simplified pkjs ready');
  Pebble.getTimelineToken(function(token) {
    console.log('sports: timeline token ' + (token ? token.substring(0, 10) + '...' : '(none)'));
  }, function(err) {
    console.log('sports: timeline token error: ' + err);
  });
  // 'ready' fires when pkjs spins up alongside the watchapp launch — in
  // PebbleKit JS this is the de-facto watchapp-open signal. The
  // SPORTS_APP_OPEN/EXIT appmessage handler below gives the C side a
  // way to override this gating once the matching C wiring lands
  // (flagged follow-up); until then, ready==open / pkjs-teardown==exit.
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

Pebble.addEventListener('showConfiguration', function() {
  Pebble.openURL(COMPANION_URL + '/sports');
});

Pebble.addEventListener('webviewclosed', function() {
  // Per Task #18 acceptance criteria: clear the timer on
  // webviewclosed / app exit. Settings round-trip (Phase D) will
  // re-start polling explicitly when it lands.
  console.log('sports: webviewclosed — stopping poll loop');
  stopPolling();
});
