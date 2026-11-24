package com.personal.harsi;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "HarsiBackupPicker")
public class HarsiBackupPickerPlugin extends Plugin {
    @PluginMethod
    public void chooseDestination(PluginCall call) {
        String fileName = call.getString("fileName", "harsi-backup.json");
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/json");
        intent.putExtra(Intent.EXTRA_TITLE, fileName);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        startActivityForResult(call, intent, "backupDestinationSelected");
    }

    @ActivityCallback
    private void backupDestinationSelected(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null
            || result.getData().getData() == null) {
            JSObject cancelled = new JSObject();
            cancelled.put("cancelled", true);
            call.resolve(cancelled);
            return;
        }
        Uri uri = result.getData().getData();
        JSObject response = new JSObject();
        response.put("cancelled", false);
        response.put("uri", uri.toString());
        response.put("fileName", call.getString("fileName", "harsi-backup.json"));
        call.resolve(response);
    }

    @PluginMethod
    public void chooseBackupFile(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/json");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
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
        JSObject response = new JSObject();
        response.put("cancelled", false);
        response.put("uri", uri.toString());
        call.resolve(response);
    }

    @PluginMethod
    public void readJson(PluginCall call) {
        String uriString = call.getString("uri");
        if (uriString == null || uriString.isEmpty()) {
            call.reject("فایل پشتیبان انتخاب نشده است.");
            return;
        }
        try (java.io.InputStream input = getContext().getContentResolver().openInputStream(Uri.parse(uriString))) {
            if (input == null) throw new IllegalStateException("امکان خواندن فایل انتخاب‌شده وجود ندارد.");
            java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int count;
            while ((count = input.read(chunk)) != -1) buffer.write(chunk, 0, count);
            JSObject response = new JSObject();
            response.put("data", buffer.toString("UTF-8"));
            call.resolve(response);
        } catch (Exception error) {
            call.reject("خواندن فایل پشتیبان ناموفق بود: " + error.getMessage(), error);
        }
    }

    @PluginMethod
    public void writeJson(PluginCall call) {
        String uriString = call.getString("uri");
        String data = call.getString("data");
        if (uriString == null || uriString.isEmpty() || data == null) {
            call.reject("مسیر ذخیره یا محتوای فایل پشتیبان مشخص نیست.");
            return;
        }
        try (OutputStream output = getContext().getContentResolver().openOutputStream(Uri.parse(uriString), "w")) {
            if (output == null) throw new IllegalStateException("امکان نوشتن در محل انتخاب‌شده وجود ندارد.");
            output.write(data.getBytes(StandardCharsets.UTF_8));
            output.flush();
            JSObject response = new JSObject();
            response.put("saved", true);
            response.put("uri", uriString);
            call.resolve(response);
        } catch (Exception error) {
            call.reject("ذخیره فایل پشتیبان ناموفق بود: " + error.getMessage(), error);
        }
    }
}
