package ru.letseetheworld.photoviewer;

import android.graphics.Bitmap;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

public class AppWebViewClient extends BridgeWebViewClient {
    /** Адрес возврата, зарегистрированный в приложении Яндекс OAuth (сравниваем без учёта регистра) */
    private static final String YA_HOME = "https://knvspb.github.io/photoviewer/";
    private final Bridge bridge;

    public AppWebViewClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
    }

    // ---------- вход в Яндекс: страница входа открывается внутри приложения, а возврат с токеном
    // (https://knvspb.github.io/PhotoViewer/#access_token=…) перехватываем и отдаём самому приложению
    private boolean yandexReturn(WebView view, Uri url) {
        if (url == null || !url.toString().toLowerCase(Locale.ROOT).startsWith(YA_HOME)) return false;
        String frag = url.getEncodedFragment();
        view.loadUrl(bridge.getAppUrl() + (frag != null ? "#" + frag : ""));
        return true;
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        if (yandexReturn(view, request.getUrl())) return true;
        return super.shouldOverrideUrlLoading(view, request);
    }

    @Override
    public void onPageStarted(WebView view, String url, Bitmap favicon) {
        if (url != null && yandexReturn(view, Uri.parse(url))) { view.stopLoading(); return; }
        super.onPageStarted(view, url, favicon);
    }

    // ---------- файлы из папок SAF: https://localhost/_saf_/file?u=<content-uri>, с поддержкой Range
    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri u = request.getUrl();
        if (u != null && "localhost".equals(u.getHost()) && u.getPath() != null && u.getPath().startsWith("/_saf_/")) {
            return serveSaf(request);
        }
        return super.shouldInterceptRequest(view, request);
    }

    private WebResourceResponse serveSaf(WebResourceRequest request) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Accept-Ranges", "bytes");
        headers.put("Cache-Control", "no-store");
        try {
            Uri doc = Uri.parse(request.getUrl().getQueryParameter("u"));
            String mime = bridge.getContext().getContentResolver().getType(doc);
            if (mime == null) mime = "application/octet-stream";
            ParcelFileDescriptor pfd = bridge.getContext().getContentResolver().openFileDescriptor(doc, "r");
            if (pfd == null) throw new IOException("нет файла");
            long size = pfd.getStatSize();
            InputStream in = new ParcelFileDescriptor.AutoCloseInputStream(pfd);
            String range = null;
            for (Map.Entry<String, String> h : request.getRequestHeaders().entrySet()) {
                if ("range".equalsIgnoreCase(h.getKey())) range = h.getValue();
            }
            if (range != null && range.startsWith("bytes=") && size > 0) {
                String[] p = range.substring(6).split("-", -1);
                long from = p[0].isEmpty() ? Math.max(0, size - Long.parseLong(p[1])) : Long.parseLong(p[0]);
                long to = (p.length > 1 && !p[1].isEmpty() && !p[0].isEmpty()) ? Math.min(Long.parseLong(p[1]), size - 1) : size - 1;
                if (from >= size) {
                    in.close();
                    headers.put("Content-Range", "bytes */" + size);
                    return new WebResourceResponse(mime, null, 416, "Range Not Satisfiable", headers, null);
                }
                long skipped = 0;
                while (skipped < from) { long s = in.skip(from - skipped); if (s <= 0) break; skipped += s; }
                long len = to - from + 1;
                headers.put("Content-Range", "bytes " + from + "-" + to + "/" + size);
                headers.put("Content-Length", String.valueOf(len));
                return new WebResourceResponse(mime, null, 206, "Partial Content", headers, new LimitedInputStream(in, len));
            }
            if (size >= 0) headers.put("Content-Length", String.valueOf(size));
            return new WebResourceResponse(mime, null, 200, "OK", headers, in);
        } catch (SecurityException e) {
            return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", headers, null);
        } catch (Exception e) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, null);
        }
    }

    /** Поток, который отдаёт не больше limit байт */
    private static final class LimitedInputStream extends InputStream {
        private final InputStream in;
        private long left;

        LimitedInputStream(InputStream in, long limit) { this.in = in; this.left = limit; }

        @Override public int read() throws IOException {
            if (left <= 0) return -1;
            int b = in.read();
            if (b >= 0) left--;
            return b;
        }

        @Override public int read(byte[] buf, int off, int len) throws IOException {
            if (left <= 0) return -1;
            int n = in.read(buf, off, (int) Math.min(len, left));
            if (n > 0) left -= n;
            return n;
        }

        @Override public int available() throws IOException { return (int) Math.min(in.available(), left); }

        @Override public void close() throws IOException { in.close(); }
    }
}
