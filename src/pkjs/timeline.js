// Timeline API — Rebble timeline service.
//
// Core Devices users still go through the Rebble timeline service
// (confirmed by a working sibling companion app on the same device).
// Every push attempt logs URL/status/response so any future failure
// mode is visible in the JS console.

var TIMELINE_API_URL = 'https://timeline-api.rebble.io/';

/**
 * Send a request to the timeline API.
 * @param pin The JSON pin to insert. Must contain 'id' field.
 * @param type The type of request, either PUT or DELETE.
 * @param callback The callback to receive the responseText after the request has completed.
 */
function timelineRequest(pin, type, callback) {
  var url = TIMELINE_API_URL + 'v1/user/pins/' + pin.id;

  console.log('timeline: sending ' + type + ' request');
  console.log('timeline: URL: ' + url);

  var xhr = new XMLHttpRequest();
  // Hard cap so a stalled timeline push doesn't silently drop the
  // request. Mirrors the snapshot fetch in index.js.
  xhr.timeout = 10000;
  xhr.ontimeout = function () {
    console.log('timeline: request timeout for ' + url);
    callback('{"error": "timeout"}', 0);
  };
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
