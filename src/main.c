#include <pebble.h>

#define MSG_SPORTS_APP_OPEN 2
#define MSG_SPORTS_APP_EXIT 3
#define MSG_SPORTS_POLL_RESULT 4

static Window *s_main_window;
static TextLayer *s_title_layer;
static TextLayer *s_status_layer;
static TextLayer *s_info_layer;

static void send_lifecycle_msg(uint32_t key) {
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) == APP_MSG_OK) {
    dict_write_uint8(iter, key, 1);
    app_message_outbox_send();
  }
}

// Compute the next absolute timestamp at which the wall-clock crosses
// 04:00 or 16:00 local time, whichever comes first from "now".
// clock_to_timestamp(TODAY, ...) already rolls forward to the next
// instance of the requested hour/minute, so the smaller of the two
// returned values is the next 4am-or-4pm boundary.
static time_t next_4am_or_4pm(void) {
  time_t t4am = clock_to_timestamp(TODAY, 4, 0);
  time_t t4pm = clock_to_timestamp(TODAY, 16, 0);
  return (t4am < t4pm) ? t4am : t4pm;
}

static void schedule_next_wakeup(void) {
  // Drop any prior pending wakeup so we never accumulate duplicates;
  // the latest poll result is always the source of truth for "when
  // should we run next".
  wakeup_cancel_all();
  time_t when = next_4am_or_4pm();
  // notify_if_missed=true so a wakeup that fires while the watch is
  // powered off still triggers when the watch boots back up.
  WakeupId id = wakeup_schedule(when, 0, true);
  // wakeup_schedule can return E_RANGE if the requested slot is too
  // close to a wakeup belonging to another app. wakeup_cancel_all()
  // only clears OUR app's slots, so cross-app collisions are still
  // possible. Bump the timestamp by 60s up to a few times to find a
  // free slot rather than dropping the wakeup entirely.
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
  } else {
    APP_LOG(APP_LOG_LEVEL_INFO,
            "wakeup id=%ld scheduled for %ld (retries=%d)",
            (long)id, (long)when, retries);
  }
}

static void inbox_received_handler(DictionaryIterator *iter, void *context) {
  Tuple *poll_result = dict_find(iter, MSG_SPORTS_POLL_RESULT);
  if (poll_result) {
    // pkjs sends this as an integer; read as int32 to cover signed
    // and small unsigned values uniformly.
    int32_t live_count = poll_result->value->int32;
    APP_LOG(APP_LOG_LEVEL_INFO, "SPORTS_POLL_RESULT=%d", (int)live_count);
    if (live_count == 0) {
      // pkjs is going idle — schedule the next background poll so we
      // re-launch the app at the upcoming 4am/4pm and start the cycle
      // over.
      schedule_next_wakeup();
    }
  }
}

static void wakeup_handler(WakeupId wakeup_id, int32_t reason) {
  // Wakeup fired while the app was already running. We don't need to
  // do anything special here — init() already detected the launch
  // reason on background-launch starts and dispatched SPORTS_APP_OPEN
  // to pkjs, which will tick once and then send SPORTS_POLL_RESULT
  // back so we can chain the next wakeup.
  APP_LOG(APP_LOG_LEVEL_INFO,
          "wakeup fired id=%ld reason=%d",
          (long)wakeup_id, (int)reason);
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
  text_layer_set_text(s_status_layer, "Timeline pins will appear automatically for your teams!");
  text_layer_set_font(s_status_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18));
  text_layer_set_text_alignment(s_status_layer, GTextAlignmentCenter);
  text_layer_set_background_color(s_status_layer, GColorClear);
  layer_add_child(window_layer, text_layer_get_layer(s_status_layer));
  
  s_info_layer = text_layer_create(GRect(10, 120, bounds.size.w - 20, 40));
  text_layer_set_text(s_info_layer, "Open settings to pick your teams");
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

static void init(void) {
  s_main_window = window_create();
  
  window_set_window_handlers(s_main_window, (WindowHandlers) {
    .load = main_window_load,
    .unload = main_window_unload
  });
  
  window_stack_push(s_main_window, true);

  // Register inbox handler BEFORE opening AppMessage so we don't miss
  // a SPORTS_POLL_RESULT that arrives in the very first window.
  app_message_register_inbox_received(inbox_received_handler);
  app_message_open(64, 64);

  // Subscribe so wakeup events that fire while we're running can be
  // observed. The launch-reason check below covers the separate case
  // where *this* run was triggered by a wakeup.
  wakeup_service_subscribe(wakeup_handler);

  if (launch_reason() == APP_LAUNCH_WAKEUP) {
    APP_LOG(APP_LOG_LEVEL_INFO, "launched via wakeup — kicking pkjs poll");
  }
  // SPORTS_APP_OPEN goes to pkjs on every launch (foreground user-tap
  // and background wakeup alike). startPolling() in pkjs is idempotent,
  // so this is safe alongside the 'ready' event already handled there.
  send_lifecycle_msg(MSG_SPORTS_APP_OPEN);
}

static void deinit(void) {
  send_lifecycle_msg(MSG_SPORTS_APP_EXIT);
  window_destroy(s_main_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
