// Timeline API - Rebble Services
// Uses Rebble timeline API for pin delivery

var TIMELINE_API_URL = 'https://timeline-api.rebble.io/';

/**
 * Send a request to the Rebble timeline API.
 * @param pin The JSON pin to insert. Must contain 'id' field.
 * @param type The type of request, either PUT or DELETE.
 * @param callback The callback to receive the responseText after the request has completed.
 */
function timelineRequest(pin, type, callback) {
  var url = TIMELINE_API_URL + 'v1/user/pins/' + pin.id;

  console.log('timeline: sending ' + type + ' request to Rebble API');
  console.log('timeline: URL: ' + url);

  var xhr = new XMLHttpRequest();
  xhr.onload = function () {
    console.log('timeline: response status: ' + this.status);
    console.log('timeline: response: ' + this.responseText);
    callback(this.responseText, this.status);
  };
  xhr.onerror = function() {
    console.log('timeline: request error');
    callback('{"error": "Request failed"}', 0);
  };
  xhr.open(type, url);
  xhr.setRequestHeader('Content-Type', 'application/json');

  console.log('timeline: getting timeline token...');
  Pebble.getTimelineToken(function(token) {
    console.log('timeline: token acquired: ' + token.substring(0, 10) + '...');
    xhr.setRequestHeader('X-User-Token', '' + token);
    xhr.send(JSON.stringify(pin));
    console.log('timeline: request sent');
  }, function(error) { 
    console.log('timeline: ERROR getting token: ' + error); 
    callback('{"error": "Failed to get timeline token: ' + error + '"}', 0);
  });
}

/**
 * Insert a pin into the timeline for this user.
 * @param pin The JSON pin to insert.
 * @param callback The callback to receive the responseText after the request has completed.
 */
function insertUserPin(pin, callback) {
  timelineRequest(pin, 'PUT', callback);
}

/**
 * Delete a pin from the timeline for this user.
 * @param pin The JSON pin to delete.
 * @param callback The callback to receive the responseText after the request has completed.
 */
function deleteUserPin(pin, callback) {
  timelineRequest(pin, 'DELETE', callback);
}

module.exports.insertUserPin = insertUserPin;
module.exports.deleteUserPin = deleteUserPin;
