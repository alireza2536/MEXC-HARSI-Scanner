package com.personal.harsi;

import android.Manifest;
import android.content.Intent;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import android.os.Build;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "BackgroundScan",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class BackgroundScanPlugin extends Plugin {
    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            call.resolve();
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationPermissionCallback");
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        if (getPermissionState("notifications") != PermissionState.GRANTED) {
            call.reject("برای نمایش اعلان پیشرفت اسکن، اجازه اعلان‌های Harsi را فعال کنید.");
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void start(PluginCall call) {
        Intent intent = new Intent(getContext(), HarsiScanService.class);
        intent.setAction(HarsiScanService.ACTION_START);
        try {
            getContext().startForegroundService(intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("شروع سرویس پس‌زمینه ناموفق بود: " + error.getMessage(), error);
        }
    }

    @PluginMethod
    public void update(PluginCall call) {
        Intent intent = new Intent(getContext(), HarsiScanService.class);
        intent.setAction(HarsiScanService.ACTION_UPDATE);
        intent.putExtra("message", call.getString("message", "در حال پردازش"));
        intent.putExtra("processed", call.getInt("processed", 0));
        intent.putExtra("total", call.getInt("total", 0));
        getContext().startService(intent);
        call.resolve();
    }


    @PluginMethod
    public void saveTextToDownloads(PluginCall call) {
        String content = call.getString("content");
        String fileName = call.getString("fileName");
        if (content == null || fileName == null || fileName.trim().isEmpty()) {
            call.reject("محتوا یا نام فایل معتبر نیست.");
            return;
        }
        try {
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
            values.put(MediaStore.MediaColumns.MIME_TYPE, "text/plain");
            Uri uri;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Harsi");
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                uri = getContext().getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            } else {
                java.io.File dir = new java.io.File(getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "Harsi");
                if (!dir.exists() && !dir.mkdirs()) throw new java.io.IOException("ساخت پوشه دانلود ناموفق بود.");
                java.io.File file = new java.io.File(dir, fileName);
                try (OutputStream out = new java.io.FileOutputStream(file)) {
                    out.write(content.getBytes(StandardCharsets.UTF_8));
                }
                call.resolve(new com.getcapacitor.JSObject().put("fileName", fileName).put("location", file.getAbsolutePath()));
                return;
            }
            if (uri == null) throw new java.io.IOException("ساخت فایل در پوشه دانلود ناموفق بود.");
            try (OutputStream out = getContext().getContentResolver().openOutputStream(uri)) {
                if (out == null) throw new java.io.IOException("دسترسی نوشتن فایل ممکن نیست.");
                out.write(content.getBytes(StandardCharsets.UTF_8));
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues done = new ContentValues();
                done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                getContext().getContentResolver().update(uri, done, null, null);
            }
            call.resolve(new com.getcapacitor.JSObject().put("fileName", fileName).put("location", "Downloads/Harsi/" + fileName));
        } catch (Exception error) {
            call.reject("ذخیره فایل در پوشه دانلود ناموفق بود: " + error.getMessage(), error);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        final android.content.BroadcastReceiver stoppedReceiver = new android.content.BroadcastReceiver() {
            @Override
            public void onReceive(android.content.Context context, Intent intent) {
                try { getContext().unregisterReceiver(this); } catch (Exception ignored) {}
                call.resolve();
            }
        };
        IntentFilter filter = new IntentFilter(HarsiScanService.ACTION_STOPPED);
        if (Build.VERSION.SDK_INT >= 33) {
            getContext().registerReceiver(stoppedReceiver, filter, android.content.Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(stoppedReceiver, filter);
        }
        Intent serviceIntent = new Intent(getContext(), HarsiScanService.class);
        boolean wasRunning = getContext().stopService(serviceIntent);
        if (!wasRunning) {
            try { getContext().unregisterReceiver(stoppedReceiver); } catch (Exception ignored) {}
            call.resolve();
        }
    }
}
