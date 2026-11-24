package com.personal.harsi;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import com.getcapacitor.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "HarsiBackupPicker")
public class HarsiBackupPickerPlugin extends Plugin {
    @PluginMethod
    public void saveJson(PluginCall call) {
        String data = call.getString("data");
        String fileName = call.getString("fileName", "harsi-backup.json");
        if (data == null || data.isEmpty()) {
            call.reject("محتوای فایل پشتیبان خالی است.");
            return;
        }

        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/json");
        intent.putExtra(Intent.EXTRA_TITLE, fileName);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        startActivityForResult(call, intent, "backupFileSelected");
    }

    @ActivityCallback
    private void backupFileSelected(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null
            || result.getData().getData() == null) {
            JSObject cancelled = new JSObject();
            cancelled.put("cancelled", true);
            call.resolve(cancelled);
            return;
        }

        Uri uri = result.getData().getData();
        String data = call.getString("data");
        String fileName = call.getString("fileName", "harsi-backup.json");
        try (OutputStream output = getContext().getContentResolver().openOutputStream(uri, "w")) {
            if (output == null) throw new IllegalStateException("امکان نوشتن در محل انتخاب‌شده وجود ندارد.");
            output.write(data.getBytes(StandardCharsets.UTF_8));
            output.flush();

            JSObject response = new JSObject();
            response.put("cancelled", false);
            response.put("uri", uri.toString());
            response.put("fileName", fileName);
            call.resolve(response);
        } catch (Exception error) {
            call.reject("ذخیره فایل پشتیبان ناموفق بود: " + error.getMessage(), error);
        }
    }
}
