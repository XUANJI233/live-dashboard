package com.monika.dashboard.lsposed;

import android.graphics.Bitmap;
import android.os.Binder;
import android.view.Display;

import java.lang.reflect.Method;

final class LspSystemScreenshotSource implements LspScreenshotController.Source {
    interface Host {
        void logDebug(String message);
    }

    private final Host host;

    LspSystemScreenshotSource(Host host) {
        this.host = host;
    }

    @Override
    public Bitmap captureBitmap() {
        long identity = Binder.clearCallingIdentity();
        Bitmap hardwareBitmap = null;
        try {
            Class<?> managerType = Class.forName("android.hardware.display.DisplayManagerInternal");
            Class<?> localServicesType = Class.forName("com.android.server.LocalServices");
            Method getService = localServicesType.getDeclaredMethod("getService", Class.class);
            getService.setAccessible(true);
            Object manager = getService.invoke(null, managerType);
            if (manager == null) {
                host.logDebug("system screenshot failed: display manager unavailable");
                return null;
            }

            Method screenshotMethod = managerType.getDeclaredMethod("userScreenshot", int.class);
            screenshotMethod.setAccessible(true);
            Object screenshotBuffer = screenshotMethod.invoke(manager, Display.DEFAULT_DISPLAY);
            if (screenshotBuffer == null) {
                host.logDebug("system screenshot failed: empty display buffer");
                return null;
            }

            Method asBitmap = screenshotBuffer.getClass().getDeclaredMethod("asBitmap");
            asBitmap.setAccessible(true);
            Object captured = asBitmap.invoke(screenshotBuffer);
            if (!(captured instanceof Bitmap)) {
                host.logDebug("system screenshot failed: bitmap unavailable");
                return null;
            }
            hardwareBitmap = (Bitmap) captured;
            Bitmap softwareBitmap = hardwareBitmap.copy(Bitmap.Config.ARGB_8888, false);
            if (softwareBitmap == null) {
                host.logDebug("system screenshot failed: bitmap copy failed");
            }
            return softwareBitmap;
        } catch (Throwable error) {
            Throwable cause = error.getCause() != null ? error.getCause() : error;
            host.logDebug("system screenshot failed: " + cause.getClass().getSimpleName());
            return null;
        } finally {
            if (hardwareBitmap != null) {
                try { hardwareBitmap.recycle(); } catch (Throwable ignored) {}
            }
            Binder.restoreCallingIdentity(identity);
        }
    }
}
