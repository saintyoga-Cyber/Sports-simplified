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

static time_t next_4am_or_4pm(void) {
  time_t now  = time(NULL);
  time_t t4am = clock_to_timestamp(TODAY, 4,  0);
  time_t t4pm = clock_to_timestamp(TODAY, 16, 0);
  if (t4am <= now) t4am += SECONDS_PER_DAY;
  if (t4pm <= now) t4pm += SECONDS_PER_DAY;
  return (t4am < t4pm) ? t4am : t4pm;
}

static void schedule_next_wakeup(void) {
  wakeup_cancel_all();
  time_t when = next_4am_or_4pm();
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
  } else {
    APP_LOG(APP_LOG_LEVEL_INFO,
            "wakeup id=%ld scheduled for %ld (retries=%d)",
            (long)id, (long)when, retries);
  }
}

static void inbox_received_handler(DictionaryIterator *iter, void *context) {
  Tuple *poll_result = dict_find(iter, MSG_SPORTS_POLL_RESULT);
  if (poll_result) {
    int32_t live_count = poll_result->value->int32;
    APP_LOG(APP_LOG_LEVEL_INFO, "SPORTS_POLL_RESULT=%d", (int)live_count);
    if (live_count == 0) {
      schedule_next_wakeup();
    }
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

static void main_window_disappear(Window *window) {
  send_lifecycle_msg(MSG_SPORTS_APP_EXIT);
}

static void init(void) {
  s_main_window = window_create();

  window_set_window_handlers(s_main_window, (WindowHandlers) {
    .load      = main_window_load,
    .unload    = main_window_unload,
    .disappear = main_window_disappear
  });

  window_stack_push(s_main_window, true);

  app_message_register_inbox_received(inbox_received_handler);
  app_message_open(64, 64);

  wakeup_service_subscribe(wakeup_handler);

  if (launch_reason() == APP_LAUNCH_WAKEUP) {
    APP_LOG(APP_LOG_LEVEL_INFO, "launched via wakeup — kicking pkjs poll");
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
