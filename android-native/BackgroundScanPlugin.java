package com.personal.harsi;

import android.content.Intent;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.JSObject;

@CapacitorPlugin(name = "BackgroundScan")
public class BackgroundScanPlugin extends Plugin {
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
