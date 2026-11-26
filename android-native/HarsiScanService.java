package com.personal.harsi;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

public class HarsiScanService extends Service {
    static final String ACTION_START = "com.personal.harsi.SCAN_START";
    static final String ACTION_UPDATE = "com.personal.harsi.SCAN_UPDATE";
    static final String ACTION_STOP = "com.personal.harsi.SCAN_STOP";
    private static final String CHANNEL_ID = "harsi_scan_progress";
    private static final int NOTIFICATION_ID = 4201;
    private PowerManager.WakeLock wakeLock;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_START.equals(action)) {
            startForeground(NOTIFICATION_ID, buildNotification("اسکن در حال اجراست", 0, 0, false));
            acquireWakeLock();
        } else if (ACTION_UPDATE.equals(action)) {
            String message = intent.getStringExtra("message");
            int processed = intent.getIntExtra("processed", 0);
            int total = intent.getIntExtra("total", 0);
            NotificationManager manager = getSystemService(NotificationManager.class);
            manager.notify(NOTIFICATION_ID, buildNotification(
                message == null ? "در حال پردازش" : message, processed, total, total > 0
            ));
        }
        return START_NOT_STICKY;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "وضعیت اسکن Harsi", NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("نمایش پیشرفت اسکن دستی ارزها");
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
    }

    private Notification buildNotification(String message, int progress, int total, boolean showProgress) {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);
        builder.setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("Harsi — بروزرسانی دستی")
            .setContentText(message)
            .setOnlyAlertOnce(true)
            .setOngoing(true);
        if (showProgress) builder.setProgress(total, Math.min(progress, total), false);
        return builder.build();
    }

    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) return;
        PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Harsi::ManualScan");
        wakeLock.acquire(6 * 60 * 60 * 1000L);
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.cancel(NOTIFICATION_ID);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
