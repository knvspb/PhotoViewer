package ru.letseetheworld.photoviewer;

import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

/**
 * Обёртка веб-приложения letseetheworld PhotoViewer.
 * - SafPlugin: выбор папок через системный диалог (в т.ч. флешки на Android TV);
 * - AppWebViewClient: отдаёт файлы этих папок странице по адресам https://localhost/_saf_/… (с поддержкой Range)
 *   и перехватывает возврат из входа в Яндекс.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SafPlugin.class);
        super.onCreate(savedInstanceState);
        bridge.setWebViewClient(new AppWebViewClient(bridge));
        // слайд-шоу с видео: воспроизведение без касания экрана; экран не гаснет, пока приложение открыто
        bridge.getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
}
