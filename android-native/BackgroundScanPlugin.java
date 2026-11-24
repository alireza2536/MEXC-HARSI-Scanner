package com.personal.harsi;

import android.Manifest;
import android.content.Intent;
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
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), HarsiScanService.class);
        intent.setAction(HarsiScanService.ACTION_STOP);
        getContext().startService(intent);
        call.resolve();
    }
}
