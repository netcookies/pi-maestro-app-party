# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# react-native-reanimated
-keep class com.swmansion.reanimated.** { *; }
-keep class com.facebook.react.turbomodule.** { *; }

# Add any project specific keep options here:

# ── Maestro Mobile（RN 0.79 New Architecture + Expo）────────────────────────
# Hermes 字节码与 JS runtime 由 RN 自带规则保留；这里补 Expo/网络库/JSC 容错

#expo：ReactNativeHost / expoview 相关
-keep class expo.** { *; }
-keep class versioned.host.exp.exponent.** { *; }

#okhttp3 / okhttp 事件流（WS 连接手机 host）
-dontwarn okhttp3.**
-dontwarn okio.**
-keep class okhttp3.** { *; }

# React Native Websocket（expo 常用 native ws）
-keep class com.facebook.react.modules.websocket.** { *; }

# 反射访问的 RN 内部类
-keep class com.facebook.react.** { *; }
-keep class com.facebook.hermes.** { *; }
-keep class com.facebook.jni.** { *; }

# 保留下列注解相关（RN codegen 生成代码）
-keep @javax.annotation.** class * { *; }
-keep class * extends androidx.** { *; }
-dontwarn androidx.**

# 用到 JSONObject / WebView 的桥接（expo-image-picker 等）
-keep class org.json.** { *; }
