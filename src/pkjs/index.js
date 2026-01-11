var COMPANION_URL = 'https://pebble-connect--saintyoga1.replit.app';

Pebble.addEventListener('ready', function() {
  console.log('Sports Simplified ready!');
  
  // Ping companion to wake it up (for live score updates)
  wakeCompanion();
  
  Pebble.getTimelineToken(
    function(token) {
      console.log('Timeline token: ' + token);
      registerToken(token);
    },
    function(error) {
      console.log('Error getting timeline token: ' + error);
    }
  );
});

function wakeCompanion() {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', COMPANION_URL + '/api/sports/games', true);
  xhr.onload = function() {
    if (xhr.status === 200) {
      console.log('Companion server awake');
    }
  };
  xhr.onerror = function() {
    console.log('Could not reach companion');
  };
  xhr.send();
}

function registerToken(token) {
  var xhr = new XMLHttpRequest();
  xhr.open('POST', COMPANION_URL + '/api/sports/timeline/register', true);
  xhr.setRequestHeader('Content-Type', 'application/json');
  
  xhr.onload = function() {
    if (xhr.status === 200 || xhr.status === 201) {
      console.log('Token registered successfully');
    } else {
      console.log('Failed to register token: ' + xhr.status);
    }
  };
  
  xhr.onerror = function() {
    console.log('Error registering token');
  };
  
  xhr.send(JSON.stringify({ token: token }));
}

Pebble.addEventListener('showConfiguration', function() {
  Pebble.openURL(COMPANION_URL + '/sports');
});

Pebble.addEventListener('webviewclosed', function(e) {
  console.log('Configuration closed');
});