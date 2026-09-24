package com.caloriesguard.gallerysaver;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.database.Cursor;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

@CapacitorPlugin(
    name = "GallerySaver",
    permissions = { @Permission(alias = "storage", strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }) }
)
public class GallerySaverPlugin extends Plugin {
    private static final String ALBUM_NAME = "餐盤小幫手";

    @PluginMethod
    public void saveImage(PluginCall call) {
        String data = call.getString("data");
        if (data == null || data.isBlank()) {
            call.reject("圖片資料不完整，無法存到相簿。");
            return;
        }

        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P && getPermissionState("storage") != PermissionState.GRANTED) {
            requestPermissionForAlias("storage", call, "storagePermissionCallback");
            return;
        }
        saveImageOnWorker(call);
    }

    @PermissionCallback
    private void storagePermissionCallback(PluginCall call) {
        if (getPermissionState("storage") != PermissionState.GRANTED) {
            call.reject("沒有相簿儲存權限，請到系統設定允許後再試。");
            return;
        }
        saveImageOnWorker(call);
    }

    private void saveImageOnWorker(PluginCall call) {
        getBridge().execute(() -> {
            try {
                byte[] imageBytes = Base64.decode(call.getString("data"), Base64.DEFAULT);
                if (imageBytes.length == 0) throw new IllegalArgumentException("Empty image");
                String mimeType = call.getString("mimeType", "image/png");
                String filename = sanitizeFilename(call.getString("filename", "營養紀錄.png"), mimeType);
                Uri uri = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                    ? saveWithMediaStore(imageBytes, filename, mimeType)
                    : saveLegacy(imageBytes, filename, mimeType);
                JSObject result = new JSObject();
                result.put("uri", uri.toString());
                call.resolve(result);
            } catch (Exception error) {
                call.reject("無法將圖片存到手機相簿，請確認相簿權限與儲存空間。", error);
            }
        });
    }

    private Uri saveWithMediaStore(byte[] imageBytes, String filename, String mimeType) throws Exception {
        ContentResolver resolver = getContext().getContentResolver();
        String relativePath = Environment.DIRECTORY_PICTURES + File.separator + ALBUM_NAME + File.separator;
        String legacyRelativePath = Environment.DIRECTORY_PICTURES + File.separator + ALBUM_NAME;
        String alternateFilename = filename.toLowerCase().endsWith(".jpg")
            ? filename.substring(0, filename.length() - 4) + ".png"
            : filename;
        List<Uri> matches = new ArrayList<>();
        String[] projection = { MediaStore.Images.Media._ID };
        String selection = "(" + MediaStore.Images.Media.DISPLAY_NAME + " = ? OR "
            + MediaStore.Images.Media.DISPLAY_NAME + " = ?) AND ("
            + MediaStore.Images.Media.RELATIVE_PATH + " = ? OR "
            + MediaStore.Images.Media.RELATIVE_PATH + " = ?)";
        try (Cursor cursor = resolver.query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            projection,
            selection,
            new String[] { filename, alternateFilename, relativePath, legacyRelativePath },
            MediaStore.Images.Media.DATE_MODIFIED + " DESC"
        )) {
            if (cursor != null) {
                int idColumn = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID);
                while (cursor.moveToNext()) {
                    matches.add(ContentUris.withAppendedId(
                        MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                        cursor.getLong(idColumn)
                    ));
                }
            }
        }

        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, filename);
        values.put(MediaStore.Images.Media.MIME_TYPE, mimeType);
        values.put(MediaStore.Images.Media.RELATIVE_PATH, relativePath);
        values.put(MediaStore.Images.Media.IS_PENDING, 1);

        Uri uri = matches.isEmpty() ? resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) : matches.get(0);
        if (uri == null) throw new IllegalStateException("MediaStore insert failed");
        try {
            if (!matches.isEmpty()) resolver.update(uri, values, null, null);
            try (OutputStream stream = resolver.openOutputStream(uri, "w")) {
                if (stream == null) throw new IllegalStateException("MediaStore stream unavailable");
                stream.write(imageBytes);
            }
            ContentValues completed = new ContentValues();
            completed.put(MediaStore.Images.Media.IS_PENDING, 0);
            resolver.update(uri, completed, null, null);
            for (int index = 1; index < matches.size(); index++) resolver.delete(matches.get(index), null, null);
            return uri;
        } catch (Exception error) {
            if (matches.isEmpty()) resolver.delete(uri, null, null);
            throw error;
        }
    }

    @SuppressWarnings("deprecation")
    private Uri saveLegacy(byte[] imageBytes, String filename, String mimeType) throws Exception {
        File album = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), ALBUM_NAME);
        if (!album.exists() && !album.mkdirs()) throw new IllegalStateException("Album directory unavailable");
        File output = new File(album, filename);
        try (OutputStream stream = new FileOutputStream(output)) {
            stream.write(imageBytes);
        }
        MediaScannerConnection.scanFile(getContext(), new String[] { output.getAbsolutePath() }, new String[] { mimeType }, null);
        return Uri.fromFile(output);
    }

    private String sanitizeFilename(String filename, String mimeType) {
        String safe = filename.replaceAll("[\\\\/:*?\"<>|\\r\\n]+", "-").trim();
        boolean jpeg = "image/jpeg".equalsIgnoreCase(mimeType);
        String extension = jpeg ? ".jpg" : ".png";
        if (safe.isEmpty()) safe = "營養紀錄" + extension;
        String lower = safe.toLowerCase();
        if (!lower.endsWith(".png") && !lower.endsWith(".jpg") && !lower.endsWith(".jpeg")) safe += extension;
        return safe;
    }
}
