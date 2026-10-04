package dev.maestromobile.app

import android.content.Intent
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class MaestroBackgroundRuntimeModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  override fun getName() = "MaestroBackgroundRuntime"

  @ReactMethod
  fun startBackgroundService(url: String, token: String?, promise: Promise) {
    try {
      val intent = Intent(reactApplicationContext, MaestroBackgroundService::class.java)
        .setAction(MaestroBackgroundService.ACTION_START)
        .putExtra(MaestroBackgroundService.EXTRA_URL, url)
        .putExtra(MaestroBackgroundService.EXTRA_TOKEN, token)
      ContextCompat.startForegroundService(reactApplicationContext, intent)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("background_service_start_failed", error)
    }
  }

  @ReactMethod
  fun stopBackgroundService(promise: Promise) {
    try {
      reactApplicationContext.stopService(Intent(reactApplicationContext, MaestroBackgroundService::class.java))
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("background_service_stop_failed", error)
    }
  }
}
