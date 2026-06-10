#include <pebble.h>

#define MSG_SPORTS_APP_OPEN 2
#define MSG_SPORTS_APP_EXIT 3
#define MSG_SPORTS_POLL_RESULT 4
#define MSG_SPORTS_GAME_TIMES 5

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

static Window *s_main_window;
static TextLayer *s_title_layer;
static TextLayer *s_status_layer;
static TextLayer *s_info_layer;

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

static void cancel_auto_exit(ClickRecognizerRef recognizer, void *context) {
  if (!s_user_interacted) {
    APP_LOG(APP_LOG_LEVEL_INFO, "user interaction — auto-exit canceled");
  }
  s_user_interacted = true;
  if (s_exit_timer) {
    app_timer_cancel(s_exit_timer);
    s_exit_timer = NULL;
  }
}

static void click_config_provider(void *context) {
  window_single_click_subscribe(BUTTON_ID_SELECT, cancel_auto_exit);
  window_single_click_subscribe(BUTTON_ID_UP, cancel_auto_exit);
  window_single_click_subscribe(BUTTON_ID_DOWN, cancel_auto_exit);
}

static void inbox_received_handler(DictionaryIterator *iter, void *context) {
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
  Layer *window_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(window_layer);

  s_title_layer = text_layer_create(GRect(0, 20, bounds.size.w, 30));
  text_layer_set_text(s_title_layer, "Sports Timeline");
  text_layer_set_font(s_title_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_text_alignment(s_title_layer, GTextAlignmentCenter);
  text_layer_set_background_color(s_title_layer, GColorClear);
  layer_add_child(window_layer, text_layer_get_layer(s_title_layer));

  s_status_layer = text_layer_create(GRect(10, 60, bounds.size.w - 20, 50));
  text_layer_set_text(s_status_layer,
    s_wakeup_launch ? "Updating pins..."
                    : "Timeline pins will appear automatically for your teams!");
  text_layer_set_font(s_status_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18));
  text_layer_set_text_alignment(s_status_layer, GTextAlignmentCenter);
  text_layer_set_background_color(s_status_layer, GColorClear);
  layer_add_child(window_layer, text_layer_get_layer(s_status_layer));

  s_info_layer = text_layer_create(GRect(10, 120, bounds.size.w - 20, 40));
  text_layer_set_text(s_info_layer,
    s_wakeup_launch ? "Press any button to keep open"
                    : "Open settings to pick your teams");
  text_layer_set_font(s_info_layer, fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
  text_layer_set_text_alignment(s_info_layer, GTextAlignmentCenter);
  text_layer_set_background_color(s_info_layer, GColorClear);
  layer_add_child(window_layer, text_layer_get_layer(s_info_layer));
}

static void main_window_unload(Window *window) {
  text_layer_destroy(s_title_layer);
  text_layer_destroy(s_status_layer);
  text_layer_destroy(s_info_layer);
}

static void main_window_disappear(Window *window) {
  send_lifecycle_msg(MSG_SPORTS_APP_EXIT);
}

static void init(void) {
  s_wakeup_launch = (launch_reason() == APP_LAUNCH_WAKEUP);

  s_main_window = window_create();

  window_set_window_handlers(s_main_window, (WindowHandlers) {
    .load      = main_window_load,
    .unload    = main_window_unload,
    .disappear = main_window_disappear
  });
  window_set_click_config_provider(s_main_window, click_config_provider);

  window_stack_push(s_main_window, true);

  app_message_register_inbox_received(inbox_received_handler);
  // Inbox must fit the GAME_TIMES CSV (8 epochs + separators + dict
  // overhead); outbox only carries single-byte lifecycle keys.
  app_message_open(256, 64);

  wakeup_service_subscribe(wakeup_handler);

  if (s_wakeup_launch) {
    APP_LOG(APP_LOG_LEVEL_INFO, "launched via wakeup — kicking pkjs poll");
    arm_exit_timer(EXIT_FAILSAFE_MS);
  }
  send_lifecycle_msg(MSG_SPORTS_APP_OPEN);
}

static void deinit(void) {
  window_destroy(s_main_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
