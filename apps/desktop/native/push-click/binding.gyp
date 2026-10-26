{
  "targets": [
    {
      "target_name": "push_click",
      "sources": ["src/push_click.mm"],
      "defines": ["NAPI_VERSION=8"],
      "link_settings": {
        "libraries": [
          "$(SDKROOT)/System/Library/Frameworks/Foundation.framework",
          "$(SDKROOT)/System/Library/Frameworks/UserNotifications.framework"
        ]
      },
      "xcode_settings": {
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "MACOSX_DEPLOYMENT_TARGET": "13.0",
        "OTHER_CFLAGS": ["-fobjc-arc"]
      }
    }
  ]
}
