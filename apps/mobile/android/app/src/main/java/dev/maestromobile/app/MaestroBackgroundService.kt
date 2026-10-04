package dev.maestromobile.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

class MaestroBackgroundService : Service() {
  private var socket: WebSocket? = null
  private val client = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()

  companion object {
    const val CHANNEL_ID = "maestro_background_connection"
    const val NOTIFICATION_ID = 4739
    const val ACTION_START = "dev.maestromobile.app.action.START_BACKGROUND_CONNECTION"
    const val ACTION_STOP = "dev.maestromobile.app.action.STOP_BACKGROUND_CONNECTION"
    const val EXTRA_URL = "host_url"
    const val EXTRA_TOKEN = "host_token"
  }

  override fun onCreate() {
    super.onCreate()
    createChannel()
    startForeground(NOTIFICATION_ID, buildNotification("正在保持主机连接"))
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
      return START_NOT_STICKY
    }
    val url = intent?.getStringExtra(EXTRA_URL)
    if (url != null && socket == null) {
      val builder = Request.Builder().url(url).addHeader("User-Agent", "MaestroMobile-Background")
      intent.getStringExtra(EXTRA_TOKEN)?.takeIf { it.isNotBlank() }?.let { builder.addHeader("Authorization", "Bearer $it") }
      socket = client.newWebSocket(builder.build(), object : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, text: String) {
          handleFrame(text)
        }
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: okhttp3.Response?) {
          socket = null
        }
      })
    }
    // Transport ownership remains native while this service is alive. The JS bridge
    // must stop its socket before starting this service and reconnect after stop.
    return START_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    socket?.close(1000, "foreground service stopped")
    socket = null
    client.dispatcher.executorService.shutdown()
    stopForeground(STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }

  private fun handleFrame(text: String) {
    try {
      val frame = JSONObject(text)
      val type = frame.optString("type")
      if (type != "notification_event") return
      val title = frame.optString("title", "Maestro Mobile")
      val body = frame.optString("body", "桌面会话有新状态")
      val eventId = frame.optString("eventId", "").ifBlank { return }
      val preferences = getSharedPreferences("maestro_background_notifications", MODE_PRIVATE)
      if (preferences.getBoolean(eventId, false)) return
      preferences.edit().putBoolean(eventId, true).apply()
      val manager = getSystemService(NotificationManager::class.java)
      manager.notify(eventId.hashCode(), buildNotification("$title：$body"))
    } catch (_: Exception) {
      // Malformed frames are ignored; foreground recovery remains authoritative.
    }
  }

  private fun createChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(CHANNEL_ID, "后台连接", NotificationManager.IMPORTANCE_LOW).apply {
      description = "Maestro Mobile 后台保持 Host 连接"
      setShowBadge(false)
    }
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  private fun buildNotification(text: String): Notification {
    val stop = PendingIntent.getService(
      this,
      1,
      Intent(this, MaestroBackgroundService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_notify_sync)
      .setContentTitle("Maestro Mobile")
      .setContentText(text)
      .setOngoing(true)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .addAction(android.R.drawable.ic_menu_close_clear_cancel, "停止", stop)
      .build()
  }
}
