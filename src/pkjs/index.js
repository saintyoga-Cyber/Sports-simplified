var COMPANION_URL = 'https://pebble-connect--saintyoga1.replit.app';

var LS_FOLLOWED = 'sports_followed';
var LS_ACTIVE_SPORT = 'sports_active_sport';
var LS_SPORT_LEGACY = 'sports_selected_sport';
var LS_TEAMS_LEGACY = 'sports_followed_teams';

function clearLegacyKeys() {
  try { localStorage.removeItem(LS_SPORT_LEGACY); } catch (e1) {}
  try { localStorage.removeItem(LS_TEAMS_LEGACY); } catch (e2) {}
}

function getSavedFollowed() {
  try {
    var raw = localStorage.getItem(LS_FOLLOWED);
    if (raw) {
      var parsed;
      try { parsed = JSON.parse(raw); } catch (eParse) { parsed = null; }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
      try { localStorage.removeItem(LS_FOLLOWED); } catch (eClear) {}
      console.log('sports: LS_FOLLOWED corrupted — discarded');
    }
    var oldSport = localStorage.getItem(LS_SPORT_LEGACY);
    var oldTeamsRaw = localStorage.getItem(LS_TEAMS_LEGACY);
    if (oldSport || oldTeamsRaw) {
      var migrated = {};
      var migratedOk = false;
      if (oldSport && oldTeamsRaw) {
        try {
          var oldTeams = JSON.parse(oldTeamsRaw);
          if (Array.isArray(oldTeams)) {
            migrated[oldSport] = oldTeams;
            migratedOk = true;
          }
        } catch (eOld) {}
      }
      try { localStorage.setItem(LS_FOLLOWED, JSON.stringify(migrated)); } catch (e1) {}
      if (migratedOk) {
        try { localStorage.setItem(LS_ACTIVE_SPORT, oldSport); } catch (e2) {}
        console.log('sports: migrated legacy settings to multi-sport followed map');
      } else {
        console.log('sports: legacy settings malformed — discarded');
      }
      clearLegacyKeys();
      return migrated;
    }
    return {};
  } catch (e) {
    return {};
  }
}

function getSavedSport() {
  try {
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

// ---------- pin factory (kept for tests + reference) ----------

function teamLabel(team) {
  if (!team) return '';
  var label = team.abbreviation || team.shortDisplayName || team.displayName || '';
  return label.substring(0, 4);
}

function formatStartTime(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
  return pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function buildSubtitle(game) {
  if (game.state === 'final')     return 'Final';
  if (game.state === 'postponed') return 'Postponed';
  if (game.state === 'canceled')  return 'Canceled';
  if (game.state === 'pre-game' || game.state === 'scheduled') {
    return formatStartTime(game.startTime);
  }
  if (game.state === 'in-game') {
    var bits = [];
    if (game.period) bits.push(game.period);
    if (game.clock)  bits.push(game.clock);
    return bits.length ? bits.join(' ') : 'In Progress';
  }
  return '';
}

function buildName(game) {
  var away = teamLabel(game.awayTeam);
  var home = teamLabel(game.homeTeam);
  return away + ' @ ' + home;
}

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
  var awayAbbr = teamLabel(game.awayTeam);
  var homeAbbr = teamLabel(game.homeTeam);
  var isScoreState = game.state === 'in-game' ||
                     game.state === 'final';
  var rankAway = game.awayTeam && game.awayTeam.rank
                   ? String(game.awayTeam.rank).substring(0, 2) : '';
  var rankHome = game.homeTeam && game.homeTeam.rank
                   ? String(game.homeTeam.rank).substring(0, 2) : '';
  var recordAway = game.awayTeam && game.awayTeam.record
                     ? game.awayTeam.record : '';
  var recordHome = game.homeTeam && game.homeTeam.record
                     ? game.homeTeam.record : '';
  var layout = {
    type: 'sportsPin',
    title: buildName(game),
    subtitle: buildSubtitle(game),
    tinyIcon: sportIcon(),
    largeIcon: sportIcon(),
    lastUpdated: game.lastUpdated || new Date().toISOString(),
    nameAway: awayAbbr,
    nameHome: homeAbbr,
    rankAway: rankAway,
    rankHome: rankHome,
    recordAway: recordAway,
    recordHome: recordHome,
    scoreAway: isScoreState ? String(game.awayScore) : '',
    scoreHome: isScoreState ? String(game.homeScore) : '',
    sportsGameState: isScoreState ? 'in-game' : 'pre-game'
  };
  return {
    id: 'sports-' + game.gameId,
    time: game.startTime,
    layout: layout
  };
}

// ---------- server registration ----------

function registerWithServer() {
  var followed = getSavedFollowed();
  var accountToken;
  try {
    accountToken = Pebble.getAccountToken();
  } catch (e) {
    console.log('sports: getAccountToken error: ' + e);
  }
  if (!accountToken) {
    try { accountToken = Pebble.getWatchToken(); } catch (e2) {}
  }
  if (!accountToken) {
    console.log('sports: no account/watch token — cannot register');
    return;
  }

  Pebble.getTimelineToken(function(timelineToken) {
    var payload = JSON.stringify({
      accountToken: accountToken,
      timelineToken: timelineToken,
      followed: followed
    });
    var xhr = new XMLHttpRequest();
    xhr.open('POST', COMPANION_URL + '/api/sports/timeline/register', true);
    xhr.timeout = 10000;
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = function() {
      console.log('sports: registered with server status=' + xhr.status);
    };
    xhr.onerror = function() {
      console.log('sports: server registration failed (network error)');
    };
    xhr.ontimeout = function() {
      console.log('sports: server registration timed out');
    };
    xhr.send(payload);
  }, function(err) {
    console.log('sports: getTimelineToken failed: ' + err);
  });
}

// ---------- Pebble lifecycle ----------

Pebble.addEventListener('ready', function() {
  console.log('Sports Simplified pkjs ready');
  registerWithServer();
});

Pebble.addEventListener('showConfiguration', function() {
  var sport = getSavedSport() || 'nhl';
  var followed = getSavedFollowed();
  var base = COMPANION_URL + '/settings';
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
  var followed = getSavedFollowed();
  followed[sport] = teams;
  try { localStorage.setItem(LS_FOLLOWED, JSON.stringify(followed)); } catch (e2) {}
  try { localStorage.setItem(LS_ACTIVE_SPORT, sport); } catch (e3) {}
  console.log('sports: saved active sport=' + sport +
              ' teams=' + teams.join(',') +
              ' followed=' + JSON.stringify(followed));
  registerWithServer();
});
