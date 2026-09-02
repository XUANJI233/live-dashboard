package com.monika.dashboard.lsposed;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;

import java.io.ByteArrayOutputStream;

final class LspScreenshotController {
    interface Source {
        byte[] capturePng();
    }

    interface Host {
        void logDebug(String message);
    }

    private static final int DEFAULT_MAX_WIDTH = 720;
    private static final int MIN_WIDTH = 320;
    private static final int MAX_WIDTH = 1080;
    private static final int MIN_QUALITY = 35;
    private static final int MAX_QUALITY = 85;
    private static final int MAX_JPEG_BYTES = 700 * 1024;

    private final Source source;
    private final Host host;

    LspScreenshotController(Source source, Host host) {
        this.source = source;
        this.host = host;
    }

    LspCapturedScreenshot capture(int requestedMaxWidth, int requestedQuality) {
        byte[] png = source.capturePng();
        if (png == null || png.length == 0) return null;
        Bitmap original = null;
        Bitmap scaled = null;
        Bitmap fallback = null;
        try {
            original = BitmapFactory.decodeByteArray(png, 0, png.length);
            if (original == null || original.getWidth() <= 0 || original.getHeight() <= 0) return null;
            int maxWidth = clamp(requestedMaxWidth, MIN_WIDTH, MAX_WIDTH, DEFAULT_MAX_WIDTH);
            int targetWidth = Math.min(maxWidth, original.getWidth());
            int targetHeight = Math.max(1, Math.round(original.getHeight() * (targetWidth / (float) original.getWidth())));
            scaled = targetWidth == original.getWidth()
                    ? original
                    : Bitmap.createScaledBitmap(original, targetWidth, targetHeight, true);
            int quality = clamp(requestedQuality, MIN_QUALITY, MAX_QUALITY, 65);
            byte[] jpeg = compressWithinLimit(scaled, quality);
            if (jpeg == null && scaled.getWidth() > 480) {
                int fallbackWidth = 480;
                int fallbackHeight = Math.max(1,
                        Math.round(scaled.getHeight() * (fallbackWidth / (float) scaled.getWidth())));
                fallback = Bitmap.createScaledBitmap(scaled, fallbackWidth, fallbackHeight, true);
                jpeg = compressWithinLimit(fallback, Math.min(quality, 55));
            }
            if (jpeg == null) return null;
            Bitmap encoded = fallback != null ? fallback : scaled;
            return new LspCapturedScreenshot(jpeg, encoded.getWidth(), encoded.getHeight(), "image/jpeg");
        } catch (Throwable t) {
            host.logDebug("screenshot capture failed: " + t.getClass().getSimpleName());
            return null;
        } finally {
            if (fallback != null && fallback != scaled && fallback != original) {
                try { fallback.recycle(); } catch (Throwable ignored) {}
            }
            if (scaled != null && scaled != original) {
                try { scaled.recycle(); } catch (Throwable ignored) {}
            }
            if (original != null) {
                try { original.recycle(); } catch (Throwable ignored) {}
            }
        }
    }

    private byte[] compressWithinLimit(Bitmap bitmap, int initialQuality) {
        for (int quality = initialQuality; quality >= MIN_QUALITY; quality -= 10) {
            ByteArrayOutputStream out = new ByteArrayOutputStream(256 * 1024);
            if (!bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)) return null;
            byte[] bytes = out.toByteArray();
            if (bytes.length <= MAX_JPEG_BYTES) return bytes;
        }
        host.logDebug("screenshot JPEG exceeds upload limit");
        return null;
    }

    private int clamp(int value, int min, int max, int fallback) {
        int selected = value > 0 ? value : fallback;
        return Math.min(max, Math.max(min, selected));
    }
}

final class LspCapturedScreenshot {
    final byte[] bytes;
    final int width;
    final int height;
    final String mimeType;

    LspCapturedScreenshot(byte[] bytes, int width, int height, String mimeType) {
        this.bytes = bytes;
        this.width = width;
        this.height = height;
        this.mimeType = mimeType;
    }
}
