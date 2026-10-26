// Reports clicks on remote (APNs) notifications to JS.
//
// Electron routes UNUserNotificationCenter responses only to its own local
// Notification objects; a response to a remote notification is dropped after
// the completion handler runs (shell/browser/notifications/mac/
// notification_center_delegate.mm). This addon wraps that delegate method on
// Electron's delegate class: for a default-action click (not a dismiss or a
// custom action) on a UNPushNotificationTrigger it hands
// { identifier, userInfo } to JS (userInfo null when it is not JSON-safe), then
// always calls Electron's original implementation with
// the same arguments, which still handles local notifications and calls the
// completion handler exactly once.

#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#import <objc/runtime.h>

#include <node_api.h>

namespace {

typedef void (*DidReceiveFn)(id, SEL, UNUserNotificationCenter*,
                             UNNotificationResponse*, void (^)(void));

SEL DidReceiveSelector() {
  return @selector(userNotificationCenter:
                   didReceiveNotificationResponse:withCompletionHandler:);
}

napi_threadsafe_function g_tsfn = nullptr;
DidReceiveFn g_original = nullptr;

// Runs on the JS thread: parse the JSON click and call the callback.
void CallJs(napi_env env, napi_value callback, void*, void* data) {
  char* json = static_cast<char*>(data);
  if (env != nullptr && callback != nullptr) {
    napi_value global, json_obj, parse, str, parsed;
    if (napi_get_global(env, &global) == napi_ok &&
        napi_get_named_property(env, global, "JSON", &json_obj) == napi_ok &&
        napi_get_named_property(env, json_obj, "parse", &parse) == napi_ok &&
        napi_create_string_utf8(env, json, NAPI_AUTO_LENGTH, &str) == napi_ok &&
        napi_call_function(env, json_obj, parse, 1, &str, &parsed) == napi_ok) {
      napi_value undefined;
      napi_get_undefined(env, &undefined);
      napi_call_function(env, undefined, callback, 1, &parsed, nullptr);
    }
    bool pending = false;
    if (napi_is_exception_pending(env, &pending) == napi_ok && pending) {
      napi_value ignored;
      napi_get_and_clear_last_exception(env, &ignored);
    }
  }
  free(json);
}

// The JS thread released the function (env teardown); clicks stop reporting.
void TsfnFinalized(napi_env, void*, void*) { g_tsfn = nullptr; }

void Emit(UNNotificationResponse* response) {
  @try {
    UNNotificationRequest* request = response.notification.request;
    if (g_tsfn == nullptr ||
        ![response.actionIdentifier
            isEqualToString:UNNotificationDefaultActionIdentifier] ||
        ![request.trigger isKindOfClass:[UNPushNotificationTrigger class]])
      return;
    NSDictionary* info = request.content.userInfo;
    // Still report an unserialisable userInfo, so main brings the app forward.
    id user_info = info != nil && [NSJSONSerialization isValidJSONObject:info]
                       ? info
                       : [NSNull null];
    NSDictionary* click =
        @{@"identifier" : request.identifier ?: @"", @"userInfo" : user_info};
    NSData* data = [NSJSONSerialization dataWithJSONObject:click
                                                   options:0
                                                     error:nil];
    if (data == nil) return;
    char* json = static_cast<char*>(malloc(data.length + 1));
    if (json == nullptr) return;
    memcpy(json, data.bytes, data.length);
    json[data.length] = '\0';
    if (napi_call_threadsafe_function(g_tsfn, json, napi_tsfn_nonblocking) !=
        napi_ok)
      free(json);
  } @catch (NSException*) {
    // Never let reporting get in the way of Electron's own handling.
  }
}

napi_value Start(napi_env env, napi_callback_info info) {
  napi_value result_false, result_true;
  napi_get_boolean(env, false, &result_false);
  napi_get_boolean(env, true, &result_true);

  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok ||
      argc < 1)
    return result_false;
  napi_valuetype type;
  if (napi_typeof(env, argv[0], &type) != napi_ok || type != napi_function)
    return result_false;
  if (g_tsfn != nullptr) return result_false;  // already started

  // Only hook Electron's own delegate. It is installed when Electron creates
  // its notification presenter (Notification.isSupported() does that), and
  // nothing else in Electron assigns the delegate afterwards.
  Class electron_delegate = NSClassFromString(@"NotificationCenterDelegate");
  id<UNUserNotificationCenterDelegate> current =
      [UNUserNotificationCenter currentNotificationCenter].delegate;
  if (electron_delegate == nil || current == nil ||
      [current class] != electron_delegate)
    return result_false;

  Method method = class_getInstanceMethod(electron_delegate, DidReceiveSelector());
  if (method == nullptr) return result_false;

  napi_value name;
  napi_create_string_utf8(env, "push-click", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(env, argv[0], nullptr, name, 0, 1,
                                      nullptr, TsfnFinalized, nullptr, CallJs,
                                      &g_tsfn) != napi_ok) {
    g_tsfn = nullptr;
    return result_false;
  }
  // Clicks must not keep the event loop alive on their own.
  napi_unref_threadsafe_function(env, g_tsfn);

  SEL sel = DidReceiveSelector();
  IMP replacement = imp_implementationWithBlock(
      ^(id obj, UNUserNotificationCenter* center,
        UNNotificationResponse* response, void (^completion)(void)) {
        Emit(response);
        g_original(obj, sel, center, response, completion);
      });
  g_original =
      reinterpret_cast<DidReceiveFn>(method_setImplementation(method, replacement));
  return result_true;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "start", NAPI_AUTO_LENGTH, Start, nullptr, &fn);
  napi_set_named_property(env, exports, "start", fn);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
