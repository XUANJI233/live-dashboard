package com.monika.dashboard.lsposed;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Environment;
import android.os.Process;

import java.io.File;
import java.lang.reflect.Method;

/**
 * Preferences that survive reboots inside system_server. The "android" system context
 * has no app data directory, so name-based getSharedPreferences fails there; files go
 * to /data/system/monika_lsp instead (device-encrypted, readable before unlock). Other
 * contexts keep using device-protected storage.
 */
final class LspSystemPreferences {
    private static final String SYSTEM_DIR = "system/monika_lsp";

    private LspSystemPreferences() {}

    static SharedPreferences open(Context context, String name) {
        if (inSystemServer(context)) {
            SharedPreferences prefs = openSystemFile(context, name);
            if (prefs != null) return prefs;
        }
        return context
                .createDeviceProtectedStorageContext()
                .getSharedPreferences(name, Context.MODE_PRIVATE);
    }

    private static boolean inSystemServer(Context context) {
        return Process.myUid() == Process.SYSTEM_UID && "android".equals(context.getPackageName());
    }

    private static SharedPreferences openSystemFile(Context context, String name) {
        try {
            File dir = new File(Environment.getDataDirectory(), SYSTEM_DIR);
            if (!dir.isDirectory() && !dir.mkdirs()) return null;
            // Context#getSharedPreferences(File, int) is hidden but stable since API 24.
            Method open = Context.class.getMethod("getSharedPreferences", File.class, int.class);
            return (SharedPreferences) open.invoke(context, new File(dir, name + ".xml"), Context.MODE_PRIVATE);
        } catch (Throwable ignored) {
            return null;
        }
    }
}
