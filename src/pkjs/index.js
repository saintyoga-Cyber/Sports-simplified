var COMPANION_URL = 'https://pebble-dev-companion.replit.app';

Pebble.addEventListener('ready', function() {
  console.log('Sports Simplified ready!');
  
  var token = Pebble.getTimelineToken();
  if (token) {
    console.log('Timeline token: ' + token);
    registerToken(token);
  } else {
    console.log('No timeline token available');
  }
});

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
