package ru.letseetheworld.photoviewer;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Папки через Storage Access Framework: системный выбор папки (ACTION_OPEN_DOCUMENT_TREE) с постоянным
 * разрешением на чтение и список содержимого. Сами файлы страница читает по адресам
 * https://localhost/_saf_/file?u=<uri> (см. AppWebViewClient).
 */
@CapacitorPlugin(name = "Saf")
public class SafPlugin extends Plugin {

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        try {
            startActivityForResult(call, i, "pickResult");
        } catch (ActivityNotFoundException e) {
            call.reject("На этом устройстве нет системного окна выбора папок", "NO_PICKER");
        }
    }

    @ActivityCallback
    private void pickResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("Выбор папки отменён", "CANCELLED");
            return;
        }
        Uri tree = result.getData().getData();
        try {
            getContext().getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (SecurityException ignored) {
            // некоторые оболочки не дают постоянное разрешение — тогда доступ будет до перезапуска
        }
        JSObject r = new JSObject();
        r.put("uri", tree.toString());
        r.put("name", displayName(tree, DocumentsContract.getTreeDocumentId(tree)));
        call.resolve(r);
    }

    /** Содержимое папки: { items: [{ id, name, mime, size, mtime, dir, uri }] } */
    @PluginMethod
    public void list(PluginCall call) {
        String treeStr = call.getString("uri");
        if (treeStr == null) { call.reject("нет uri"); return; }
        Uri tree = Uri.parse(treeStr);
        String docId = call.getString("docId");
        if (docId == null) docId = DocumentsContract.getTreeDocumentId(tree);
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId);
        String[] cols = {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        };
        JSArray items = new JSArray();
        try (Cursor c = getContext().getContentResolver().query(children, cols, null, null, null)) {
            if (c != null) {
                while (c.moveToNext()) {
                    String id = c.getString(0), mime = c.getString(2);
                    JSObject o = new JSObject();
                    o.put("id", id);
                    o.put("name", c.getString(1));
                    o.put("mime", mime);
                    o.put("size", c.isNull(3) ? 0 : c.getLong(3));
                    o.put("mtime", c.isNull(4) ? 0 : c.getLong(4));
                    o.put("dir", DocumentsContract.Document.MIME_TYPE_DIR.equals(mime));
                    o.put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, id).toString());
                    items.put(o);
                }
            }
        } catch (SecurityException e) {
            call.reject("Нет доступа к папке — выберите её заново", "NO_ACCESS");
            return;
        } catch (Exception e) {
            call.reject("Не удалось прочитать папку: " + e.getMessage(), "LIST_FAILED");
            return;
        }
        JSObject r = new JSObject();
        r.put("items", items);
        call.resolve(r);
    }

    /** Есть ли ещё постоянное разрешение на папку: { ok } */
    @PluginMethod
    public void check(PluginCall call) {
        String uri = call.getString("uri");
        boolean ok = false;
        for (UriPermission p : getContext().getContentResolver().getPersistedUriPermissions()) {
            if (p.isReadPermission() && p.getUri().toString().equals(uri)) { ok = true; break; }
        }
        JSObject r = new JSObject();
        r.put("ok", ok);
        call.resolve(r);
    }

    private String displayName(Uri tree, String docId) {
        Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, docId);
        ContentResolver cr = getContext().getContentResolver();
        try (Cursor c = cr.query(doc, new String[] { DocumentsContract.Document.COLUMN_DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) {}
        int i = docId.lastIndexOf(':');
        return i >= 0 ? docId.substring(i + 1) : docId;
    }
}
