// Builds the Clay config dynamically based on the current saved sport
// and the team list fetched live from the companion server. The team
// section's options[] is populated at runtime — we never hardcode the
// team list in this config module.
//
// The "searchable" team picker is implemented as an input field that
// filters the underlying checkboxgroup options client-side via the
// customFn that index.js registers on Clay. See clayCustomFn() below.

function buildClayConfig(opts) {
  var sport = opts.sport || 'nhl';
  var teams = opts.teams || [];
  var followedTeamIds = opts.followedTeamIds || [];

  var teamOptions = teams.map(function(t) {
    return {
      label: t.name + ' (' + t.abbreviation + ')',
      value: t.id
    };
  });

  return [
    {
      type: 'heading',
      defaultValue: 'Sports Simplified'
    },
    {
      type: 'text',
      defaultValue: 'Pick a sport and the teams you want to follow. The watch will only push pin updates for these teams.'
    },
    {
      type: 'section',
      items: [
        {
          type: 'heading',
          defaultValue: 'Sport'
        },
        {
          type: 'select',
          messageKey: 'SPORT',
          label: 'Active sport',
          defaultValue: sport,
          options: [
            { label: 'NHL Hockey', value: 'nhl' },
            { label: 'FIFA World Cup', value: 'fifa-wc' }
          ]
        }
      ]
    },
    {
      type: 'section',
      items: [
        {
          type: 'heading',
          defaultValue: sport === 'fifa-wc' ? 'Followed Countries' : 'Followed Teams'
        },
        {
          type: 'input',
          id: 'teamSearch',
          label: 'Search',
          attributes: {
            placeholder: sport === 'fifa-wc' ? 'Filter countries…' : 'Filter teams…'
          }
        },
        {
          type: 'checkboxgroup',
          messageKey: 'TEAMS',
          id: 'teamPicker',
          label: sport === 'fifa-wc' ? 'Countries' : 'Teams',
          defaultValue: followedTeamIds,
          options: teamOptions
        }
      ]
    },
    {
      type: 'submit',
      defaultValue: 'Save Settings'
    }
  ];
}

// Clay customFn — runs inside the Clay webview on the phone. Wires up
// two interactive behaviors that vanilla checkboxgroup can't do alone:
//  1) The "Search" input filters the team checkbox list in place.
//  2) Changing the sport re-fetches /api/sports/teams?sport=<new> and
//     rebuilds the checkbox options so the picker always matches the
//     currently selected sport without needing to close & re-open.
//
// COMPANION_URL is interpolated by buildCustomFnSource() in index.js
// so this file stays portable.
function clayCustomFn(companionUrl) {
  return function() {
    var clay = this;
    var sportItem = clay.getItemByMessageKey('SPORT');
    var searchItem = clay.getItemById('teamSearch');
    var teamPicker = clay.getItemByMessageKey('TEAMS');
    console.log('clay-customFn: init sportItem=' + !!sportItem +
      ' searchItem=' + !!searchItem + ' teamPicker=' + !!teamPicker);
    if (!sportItem || !teamPicker) return;

    var allOptions = teamPicker.config.options.slice();

    function applyFilter() {
      var q = searchItem ? String(searchItem.get() || '').toLowerCase().trim() : '';
      var filtered = q
        ? allOptions.filter(function(o) {
            return String(o.label).toLowerCase().indexOf(q) !== -1;
          })
        : allOptions.slice();
      teamPicker.set(teamPicker.get() || []);
      teamPicker.config.options = filtered;
      // Re-render by re-setting value (Clay redraws checkboxes from
      // config.options on each set()).
      teamPicker.set(teamPicker.get() || []);
    }

    if (searchItem) {
      searchItem.on('change', applyFilter);
    }

    sportItem.on('change', function() {
      var newSport = String(sportItem.get() || 'nhl');
      console.log('clay-customFn: sport changed -> ' + newSport +
        ', refetching team list');
      var xhr = new XMLHttpRequest();
      xhr.open('GET', companionUrl + '/api/sports/teams?sport=' + encodeURIComponent(newSport), true);
      // Hard cap so a stalled fetch can't leave the picker silently
      // un-refreshed. 5s matches the showConfiguration-side fetch and
      // is well under any plausible user attention span.
      xhr.timeout = 5000;
      xhr.ontimeout = function() {
        console.log('clay-customFn: teams fetch timeout for sport=' + newSport);
      };
      xhr.onerror = function() {
        console.log('clay-customFn: teams fetch network error for sport=' + newSport);
      };
      xhr.onload = function() {
        if (xhr.status < 200 || xhr.status >= 300) {
          console.log('clay-customFn: teams fetch status=' + xhr.status +
            ' for sport=' + newSport);
          return;
        }
        var data;
        try {
          data = JSON.parse(xhr.responseText);
        } catch (e) {
          console.log('clay-customFn: teams JSON parse failed for sport=' +
            newSport + ': ' + (e && e.message));
          return;
        }
        if (!Array.isArray(data)) {
          console.log('clay-customFn: teams payload not an array for sport=' +
            newSport);
          return;
        }
        allOptions = data.map(function(t) {
          return { label: t.name + ' (' + t.abbreviation + ')', value: t.id };
        });
        console.log('clay-customFn: rebuilt picker with ' + allOptions.length +
          ' options for sport=' + newSport);
        // Sport changed — clear previous selections (different sport
        // means different team IDs) and reset the search filter so the
        // user immediately sees the full new list.
        teamPicker.set([]);
        if (searchItem) { searchItem.set(''); }
        teamPicker.config.options = allOptions;
        applyFilter();
      };
      xhr.send();
    });
  };
}

module.exports = buildClayConfig;
module.exports.clayCustomFn = clayCustomFn;
