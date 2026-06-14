#include <pebble.h>

#define MSG_SPORTS_APP_OPEN 2
#define MSG_SPORTS_APP_EXIT 3
#define MSG_SPORTS_POLL_RESULT 4
#define MSG_SPORTS_GAME_TIMES 5
#define MSG_SPORTS_GAME_LIST 6

// Smart game-day wakeups: pkjs sends followed games' start times as a
// CSV of epoch seconds (SPORTS_GAME_TIMES). We schedule a wakeup at
// each start plus re-wakes every 30 min through the game window. The
// OS allows 8 pending wakeups per app: 7 game slots + 1 daily fallback.
#define MAX_GAME_WAKEUPS 7
#define MAX_GAMES 8
#define REWAKE_INTERVAL_SEC (30 * 60)
#define GAME_WINDOW_SEC (3 * 3600 + 30 * 60)
#define MIN_WAKEUP_GAP_SEC 120
#define MAX_CANDIDATES 64

// Auto-exit after a wakeup launch: failsafe if the phone never
// responds, short grace after the poll result so in-flight pin PUTs
// on the phone can finish before pkjs is killed by app exit.
#define EXIT_FAILSAFE_MS 60000
#define EXIT_GRACE_MS 5000

// Interactive game list (SPORTS_GAME_LIST). pkjs sends a delimited
// string: games separated by RS (0x1e), fields within a game by US
// (0x1f). 7 fields per game: sport, away, awayScore, home, homeScore,
// status, scoreMarker. Mirrors the parse_epochs fixed-array style — no
// dynamic allocation.
#define MAX_LIST_GAMES 12
#define LIST_RS 0x1e
#define LIST_FS 0x1f
#define LIST_CELL_H 56

// Persisted copy of the most recent game list so a cold launch can
// render instantly instead of waiting for pkjs to boot and fetch.
#define PERSIST_KEY_GAME_LIST 1

typedef struct {
  char sport[4];
  char away[6];
  char away_score[5];
  char home[6];
  char home_score[5];
  char status[24];
  bool has_scores;
} ListGame;

static Window *s_main_window;
static MenuLayer *s_menu_layer;
static Window *s_detail_window = NULL;
static Layer *s_detail_layer = NULL;

static ListGame s_games[MAX_LIST_GAMES];
static int  s_game_count = 0;
static bool s_list_loaded = false;   // false -> "Loading"; true && 0 -> "No games"
static int  s_detail_index = -1;

static bool s_wakeup_launch = false;
static bool s_user_interacted = false;
static bool s_got_game_times = false;
static AppTimer *s_exit_timer = NULL;

static void send_lifecycle_msg(uint32_t key) {
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) == APP_MSG_OK) {
    dict_write_uint8(iter, key, 1);
    app_message_outbox_send();
  }
}

static time_t next_4am_or_4pm(void) {
  time_t now  = time(NULL);
  time_t t4am = clock_to_timestamp(TODAY, 4,  0);
  time_t t4pm = clock_to_timestamp(TODAY, 16, 0);
  if (t4am <= now) t4am += SECONDS_PER_DAY;
  if (t4pm <= now) t4pm += SECONDS_PER_DAY;
  return (t4am < t4pm) ? t4am : t4pm;
}

static bool schedule_wakeup_at(time_t when) {
  WakeupId id = wakeup_schedule(when, 0, true);
  int retries = 0;
  while (id < 0 && retries < 5) {
    when += 60;
    id = wakeup_schedule(when, 0, true);
    retries++;
  }
  if (id < 0) {
    APP_LOG(APP_LOG_LEVEL_ERROR,
            "wakeup_schedule failed after %d retries: %ld",
            retries, (long)id);
    return false;
  }
  return true;
}

static void schedule_next_wakeup(void) {
  wakeup_cancel_all();
  time_t when = next_4am_or_4pm();
  if (schedule_wakeup_at(when)) {
    APP_LOG(APP_LOG_LEVEL_INFO, "fallback wakeup scheduled for %ld",
            (long)when);
  }
}

// Parse a CSV of positive epoch seconds. Returns the number parsed.
static int parse_epochs(const char *s, time_t *out, int max) {
  int n = 0;
  long cur = 0;
  bool have = false;
  for (;; s++) {
    char c = *s;
    if (c >= '0' && c <= '9') {
      cur = cur * 10 + (c - '0');
      have = true;
    } else {
      if (have && n < max && cur > 0) out[n++] = (time_t)cur;
      cur = 0;
      have = false;
      if (c != ',') break;
    }
  }
  return n;
}

static void schedule_game_wakeups(const char *csv) {
  time_t now = time(NULL);
  time_t games[MAX_GAMES];
  int ngames = parse_epochs(csv, games, MAX_GAMES);

  if (ngames == 0) {
    APP_LOG(APP_LOG_LEVEL_INFO, "no upcoming games — fallback schedule");
    schedule_next_wakeup();
    return;
  }

  // Expand each game into start + 30-min re-wakes across its window,
  // keeping only future times.
  time_t cand[MAX_CANDIDATES];
  int n = 0;
  for (int i = 0; i < ngames; i++) {
    for (time_t w = games[i];
         w <= games[i] + GAME_WINDOW_SEC && n < MAX_CANDIDATES;
         w += REWAKE_INTERVAL_SEC) {
      if (w > now + 60) cand[n++] = w;
    }
  }

  // Insertion sort (n <= 64).
  for (int i = 1; i < n; i++) {
    time_t v = cand[i];
    int j = i - 1;
    while (j >= 0 && cand[j] > v) { cand[j + 1] = cand[j]; j--; }
    cand[j + 1] = v;
  }

  wakeup_cancel_all();
  int scheduled = 0;
  time_t last = 0;
  for (int i = 0; i < n && scheduled < MAX_GAME_WAKEUPS; i++) {
    if (last != 0 && cand[i] - last < MIN_WAKEUP_GAP_SEC) continue;
    if (schedule_wakeup_at(cand[i])) {
      scheduled++;
      last = cand[i];
    }
  }
  // Always keep one daily fallback slot so the schedule self-heals
  // even if every game wakeup is consumed while the phone is away.
  schedule_wakeup_at(next_4am_or_4pm());
  APP_LOG(APP_LOG_LEVEL_INFO,
          "scheduled %d game wakeups (+1 fallback) from %d games",
          scheduled, ngames);
}

// ---------- Game list parsing ----------

static void copy_field(char *dst, int cap, const char *src, int len) {
  if (len > cap - 1) len = cap - 1;
  for (int i = 0; i < len; i++) dst[i] = src[i];
  dst[len] = '\0';
}

// Parse the RS/US-delimited game list into the static s_games array.
// Modeled on parse_epochs: single forward scan, fixed capacity, no
// allocation. An empty string yields zero games (the "No games" state).
static void parse_game_list(const char *s) {
  s_game_count = 0;
  s_list_loaded = true;
  if (!s || !*s) return;

  int g = 0;
  const char *p = s;
  while (*p && g < MAX_LIST_GAMES) {
    ListGame *cur = &s_games[g];
    cur->sport[0] = cur->away[0] = cur->away_score[0] = '\0';
    cur->home[0] = cur->home_score[0] = cur->status[0] = '\0';
    cur->has_scores = false;

    const char *field_start = p;
    int field_idx = 0;
    for (;;) {
      char c = *p;
      if (c == LIST_FS || c == LIST_RS || c == '\0') {
        int len = (int)(p - field_start);
        switch (field_idx) {
          case 0: copy_field(cur->sport, sizeof(cur->sport), field_start, len); break;
          case 1: copy_field(cur->away, sizeof(cur->away), field_start, len); break;
          case 2: copy_field(cur->away_score, sizeof(cur->away_score), field_start, len); break;
          case 3: copy_field(cur->home, sizeof(cur->home), field_start, len); break;
          case 4: copy_field(cur->home_score, sizeof(cur->home_score), field_start, len); break;
          case 5: copy_field(cur->status, sizeof(cur->status), field_start, len); break;
          case 6: cur->has_scores = (len > 0 && field_start[0] == '1'); break;
          default: break;
        }
        field_idx++;
        field_start = p + 1;
        if (c == LIST_RS || c == '\0') break;
      }
      p++;
    }
    g++;
    if (*p == '\0') break;
    p++;  // skip the RS separator
  }
  s_game_count = g;
}

// ---------- Persistent cache (instant cold-launch render) ----------

// Persist values cap at PERSIST_STRING_MAX_LENGTH (256) including the
// null terminator, so for a long list we store a prefix truncated at a
// record boundary — never a half-encoded game.
static void persist_save_list(const char *s) {
  if (!s) return;
  if ((int)strlen(s) < PERSIST_STRING_MAX_LENGTH) {
    persist_write_string(PERSIST_KEY_GAME_LIST, s);
    return;
  }
  int cut = PERSIST_STRING_MAX_LENGTH - 1;
  while (cut > 0 && s[cut] != LIST_RS) cut--;
  if (cut <= 0) return;  // a single record exceeds the budget — skip
  char buf[PERSIST_STRING_MAX_LENGTH];
  for (int i = 0; i < cut; i++) buf[i] = s[i];
  buf[cut] = '\0';
  persist_write_string(PERSIST_KEY_GAME_LIST, buf);
}

static void persist_load_list(void) {
  if (!persist_exists(PERSIST_KEY_GAME_LIST)) return;
  char buf[PERSIST_STRING_MAX_LENGTH];
  int n = persist_read_string(PERSIST_KEY_GAME_LIST, buf, sizeof(buf));
  if (n > 0) parse_game_list(buf);
}

// ---------- Auto-exit (wakeup launch only) ----------

static void mark_interacted(void) {
  if (!s_user_interacted) {
    APP_LOG(APP_LOG_LEVEL_INFO, "user interaction — auto-exit canceled");
  }
  s_user_interacted = true;
  if (s_exit_timer) {
    app_timer_cancel(s_exit_timer);
    s_exit_timer = NULL;
  }
}

static void exit_timer_cb(void *data) {
  s_exit_timer = NULL;
  if (s_user_interacted) return;
  // Never leave the watch without a future wakeup.
  if (!s_got_game_times) schedule_next_wakeup();
  APP_LOG(APP_LOG_LEVEL_INFO, "wakeup launch — auto-exit");
  window_stack_pop_all(true);
}

static void arm_exit_timer(uint32_t ms) {
  if (!s_wakeup_launch || s_user_interacted) return;
  if (s_exit_timer) {
    if (!app_timer_reschedule(s_exit_timer, ms)) {
      s_exit_timer = app_timer_register(ms, exit_timer_cb, NULL);
    }
  } else {
    s_exit_timer = app_timer_register(ms, exit_timer_cb, NULL);
  }
}

// ---------- Detail card (full-screen single game) ----------

static void detail_update_proc(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  graphics_context_set_text_color(ctx, GColorBlack);
  if (s_detail_index < 0 || s_detail_index >= s_game_count) return;
  ListGame *g = &s_games[s_detail_index];

  int16_t top = PBL_IF_ROUND_ELSE(24, 8);

  graphics_draw_text(ctx, g->sport,
    fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD),
    GRect(0, top, b.size.w, 24),
    GTextOverflowModeFill, GTextAlignmentCenter, NULL);

  if (g->has_scores) {
    int16_t sy = top + 26;
    GFont big = fonts_get_system_font(FONT_KEY_BITHAM_42_BOLD);
    graphics_draw_text(ctx, g->away_score, big,
      GRect(0, sy, b.size.w / 2, 48),
      GTextOverflowModeFill, GTextAlignmentCenter, NULL);
    graphics_draw_text(ctx, g->home_score, big,
      GRect(b.size.w / 2, sy, b.size.w / 2, 48),
      GTextOverflowModeFill, GTextAlignmentCenter, NULL);

    int16_t ty = sy + 50;
    GFont tf = fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD);
    graphics_draw_text(ctx, g->away, tf,
      GRect(0, ty, b.size.w / 2, 28),
      GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
    graphics_draw_text(ctx, g->home, tf,
      GRect(b.size.w / 2, ty, b.size.w / 2, 28),
      GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  } else {
    char matchup[16];
    snprintf(matchup, sizeof(matchup), "%s @ %s", g->away, g->home);
    graphics_draw_text(ctx, matchup,
      fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD),
      GRect(0, top + 40, b.size.w, 32),
      GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  }

  int16_t fy = b.size.h - PBL_IF_ROUND_ELSE(44, 34);
  graphics_draw_text(ctx, g->status,
    fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
    GRect(0, fy, b.size.w, 28),
    GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

static void detail_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  s_detail_layer = layer_create(layer_get_bounds(root));
  layer_set_update_proc(s_detail_layer, detail_update_proc);
  layer_add_child(root, s_detail_layer);
}

static void detail_window_unload(Window *window) {
  if (s_detail_layer) {
    layer_destroy(s_detail_layer);
    s_detail_layer = NULL;
  }
}

static void ensure_detail_window(void) {
  if (s_detail_window) return;
  s_detail_window = window_create();
  window_set_background_color(s_detail_window, GColorWhite);
  window_set_window_handlers(s_detail_window, (WindowHandlers) {
    .load   = detail_window_load,
    .unload = detail_window_unload
  });
}

// ---------- Game list MenuLayer ----------

static bool list_is_placeholder(void) {
  return (!s_list_loaded || s_game_count == 0);
}

static uint16_t menu_get_num_sections(MenuLayer *ml, void *ctx) {
  return 1;
}

static uint16_t menu_get_num_rows(MenuLayer *ml, uint16_t section, void *ctx) {
  return list_is_placeholder() ? 1 : (uint16_t)s_game_count;
}

static int16_t menu_get_cell_height(MenuLayer *ml, MenuIndex *idx, void *ctx) {
  if (list_is_placeholder()) {
    return layer_get_bounds(menu_layer_get_layer(ml)).size.h;
  }
  // Taller centered-focus cell on round reads better with the curved
  // scroll; rectangular keeps the compact height.
  return PBL_IF_ROUND_ELSE(64, LIST_CELL_H);
}

static void menu_draw_row(GContext *ctx, const Layer *cell_layer,
                          MenuIndex *cell_index, void *ctx2) {
  GRect b = layer_get_bounds(cell_layer);
  bool hl = menu_cell_layer_is_highlighted(cell_layer);
  graphics_context_set_text_color(ctx, hl ? GColorWhite : GColorBlack);

  if (list_is_placeholder()) {
    const char *msg = s_list_loaded ? "No games" : "Loading...";
    graphics_draw_text(ctx, msg,
      fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
      GRect(4, b.size.h / 2 - 20, b.size.w - 8, 40),
      GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
    return;
  }

  ListGame *g = &s_games[cell_index->row];
  GFont team_font = fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD);
  GFont foot_font = fonts_get_system_font(FONT_KEY_GOTHIC_14);

  // Round screens clip text at the curved edges, so inset the content
  // further and (below) center the footer; rectangular keeps the tight
  // left/right layout.
  int16_t inset = PBL_IF_ROUND_ELSE(22, 4);
  int16_t w = b.size.w - inset * 2;
  int16_t y0 = PBL_IF_ROUND_ELSE(6, 0);

  // Line 1: away abbrev (left) + away score (right).
  graphics_draw_text(ctx, g->away, team_font,
    GRect(inset, y0, w, 20),
    GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  if (g->has_scores) {
    graphics_draw_text(ctx, g->away_score, team_font,
      GRect(inset, y0, w, 20),
      GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
  }

  // Line 2: home abbrev (left) + home score (right).
  graphics_draw_text(ctx, g->home, team_font,
    GRect(inset, y0 + 18, w, 20),
    GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  if (g->has_scores) {
    graphics_draw_text(ctx, g->home_score, team_font,
      GRect(inset, y0 + 18, w, 20),
      GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
  }

  // Line 3 footer.
#if defined(PBL_ROUND)
  // One centered "SPORT  STATUS" line so nothing clips on the curve.
  char footer[40];
  snprintf(footer, sizeof(footer), "%s  %s", g->sport, g->status);
  graphics_draw_text(ctx, footer, foot_font,
    GRect(inset, y0 + 38, w, 16),
    GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
#else
  graphics_draw_text(ctx, g->sport, foot_font,
    GRect(inset, y0 + 38, w, 16),
    GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
  graphics_draw_text(ctx, g->status, foot_font,
    GRect(inset, y0 + 38, w, 16),
    GTextOverflowModeTrailingEllipsis, GTextAlignmentRight, NULL);
#endif
}

static void menu_selection_changed(MenuLayer *ml, MenuIndex new_index,
                                   MenuIndex old_index, void *ctx) {
  // Any scroll counts as interaction — cancels the wakeup-launch auto-exit.
  mark_interacted();
}

static void menu_select_click(MenuLayer *ml, MenuIndex *cell_index, void *ctx) {
  mark_interacted();
  if (list_is_placeholder()) return;
  s_detail_index = cell_index->row;
  ensure_detail_window();
  if (s_detail_layer) layer_mark_dirty(s_detail_layer);
  window_stack_push(s_detail_window, true);
}

static void inbox_received_handler(DictionaryIterator *iter, void *context) {
  Tuple *game_list = dict_find(iter, MSG_SPORTS_GAME_LIST);
  if (game_list && game_list->type == TUPLE_CSTRING) {
    parse_game_list(game_list->value->cstring);
    persist_save_list(game_list->value->cstring);
    if (s_menu_layer) menu_layer_reload_data(s_menu_layer);
  }

  Tuple *game_times = dict_find(iter, MSG_SPORTS_GAME_TIMES);
  if (game_times && game_times->type == TUPLE_CSTRING) {
    s_got_game_times = true;
    schedule_game_wakeups(game_times->value->cstring);
  }

  Tuple *poll_result = dict_find(iter, MSG_SPORTS_POLL_RESULT);
  if (poll_result) {
    int32_t live_count = poll_result->value->int32;
    APP_LOG(APP_LOG_LEVEL_INFO, "SPORTS_POLL_RESULT=%d", (int)live_count);
    if (!s_got_game_times && live_count == 0) {
      schedule_next_wakeup();
    }
    // Poll finished: pins for this tick are pushed (or in flight on the
    // phone) — exit shortly unless the user is interacting.
    arm_exit_timer(EXIT_GRACE_MS);
  }
}

static void wakeup_handler(WakeupId wakeup_id, int32_t reason) {
  APP_LOG(APP_LOG_LEVEL_INFO,
          "wakeup fired while app open id=%ld — triggering poll",
          (long)wakeup_id);
  send_lifecycle_msg(MSG_SPORTS_APP_OPEN);
}

static void main_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  s_menu_layer = menu_layer_create(bounds);
  menu_layer_set_callbacks(s_menu_layer, NULL, (MenuLayerCallbacks) {
    .get_num_sections  = menu_get_num_sections,
    .get_num_rows      = menu_get_num_rows,
    .get_cell_height   = menu_get_cell_height,
    .draw_row          = menu_draw_row,
    .selection_changed = menu_selection_changed,
    .select_click      = menu_select_click
  });
  menu_layer_set_highlight_colors(s_menu_layer, GColorBlue, GColorWhite);
  // Centered-focus gives round watches the curved up/down scroll; it is
  // already the default on round, but set it explicitly for clarity.
  menu_layer_set_center_focused(s_menu_layer, PBL_IF_ROUND_ELSE(true, false));
  menu_layer_set_click_config_onto_window(s_menu_layer, window);
  layer_add_child(root, menu_layer_get_layer(s_menu_layer));
}

static void main_window_unload(Window *window) {
  menu_layer_destroy(s_menu_layer);
  s_menu_layer = NULL;
}

static void main_window_disappear(Window *window) {
  send_lifecycle_msg(MSG_SPORTS_APP_EXIT);
}

static void init(void) {
  s_wakeup_launch = (launch_reason() == APP_LAUNCH_WAKEUP);

  // Render the last-known games immediately on launch; the fresh list
  // from pkjs overwrites this once it arrives.
  persist_load_list();

  s_main_window = window_create();
  window_set_background_color(s_main_window, GColorWhite);

  window_set_window_handlers(s_main_window, (WindowHandlers) {
    .load      = main_window_load,
    .unload    = main_window_unload,
    .disappear = main_window_disappear
  });

  window_stack_push(s_main_window, true);

  app_message_register_inbox_received(inbox_received_handler);
  // Inbox must fit the SPORTS_GAME_LIST payload (up to 12 games of
  // delimited text, ~550 bytes worst case) plus dict overhead; outbox
  // only carries single-byte lifecycle keys.
  app_message_open(640, 64);

  wakeup_service_subscribe(wakeup_handler);

  if (s_wakeup_launch) {
    APP_LOG(APP_LOG_LEVEL_INFO, "launched via wakeup — kicking pkjs poll");
    arm_exit_timer(EXIT_FAILSAFE_MS);
  }
  send_lifecycle_msg(MSG_SPORTS_APP_OPEN);
}

static void deinit(void) {
  if (s_detail_window) {
    window_destroy(s_detail_window);
    s_detail_window = NULL;
  }
  window_destroy(s_main_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
