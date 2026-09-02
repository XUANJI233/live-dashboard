package com.monika.dashboard.lsposed;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

final class LspShellScreenshotSource implements LspScreenshotController.Source {
    interface Host {
        void logDebug(String message);
    }

    private static final int MAX_PNG_BYTES = 16 * 1024 * 1024;
    private static final long CAPTURE_TIMEOUT_SECONDS = 8L;
    private final Host host;

    LspShellScreenshotSource(Host host) {
        this.host = host;
    }

    @Override
    public byte[] capturePng() {
        Process process = null;
        ExecutorService reader = null;
        try {
            process = new ProcessBuilder("/system/bin/screencap", "-p").start();
            Process running = process;
            reader = Executors.newSingleThreadExecutor(task -> {
                Thread thread = new Thread(task, "monika-screenshot-reader");
                thread.setDaemon(true);
                return thread;
            });
            Future<byte[]> pendingPng = reader.submit(() -> readBounded(running.getInputStream()));
            boolean exited = process.waitFor(CAPTURE_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (!exited) process.destroyForcibly();
            byte[] png = pendingPng.get(2, TimeUnit.SECONDS);
            if (!exited || process.exitValue() != 0 || png.length == 0) {
                if (!exited) process.destroyForcibly();
                host.logDebug("system screencap did not complete");
                return null;
            }
            return png;
        } catch (Throwable t) {
            host.logDebug("system screencap failed: " + t.getClass().getSimpleName());
            return null;
        } finally {
            if (reader != null) reader.shutdownNow();
            if (process != null) {
                try { process.getInputStream().close(); } catch (Throwable ignored) {}
                try { process.getErrorStream().close(); } catch (Throwable ignored) {}
                try { process.getOutputStream().close(); } catch (Throwable ignored) {}
                try { process.destroy(); } catch (Throwable ignored) {}
            }
        }
    }

    private byte[] readBounded(InputStream input) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream(1024 * 1024);
        byte[] buffer = new byte[16 * 1024];
        int read;
        while ((read = input.read(buffer)) >= 0) {
            out.write(buffer, 0, read);
            if (out.size() > MAX_PNG_BYTES) throw new IllegalStateException("screenshot_png_too_large");
        }
        return out.toByteArray();
    }
}
