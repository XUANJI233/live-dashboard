package com.monika.dashboard.lsposed;

import android.content.Context;
import android.os.Environment;
import android.os.Process;
import android.util.AtomicFile;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * Small state files that survive reboots inside system_server. The "android" system
 * context has no app data directory, so name-based SharedPreferences throw there;
 * system_server keeps these files in /data/system/monika_lsp (device-encrypted, readable
 * before unlock). Other contexts use device-protected app storage.
 */
final class LspSystemStateFile {
    private static final String SYSTEM_DIR = "system/monika_lsp";
    private static final String APP_DIR = "monika_lsp";
    private static final int MAX_BYTES = 64 * 1024;

    private LspSystemStateFile() {}

    /** Returns "" when the file does not exist yet. */
    static String read(Context context, String name) throws IOException {
        AtomicFile atomic = new AtomicFile(file(context, name));
        File base = atomic.getBaseFile();
        if (!base.exists()) return "";
        if (base.length() > MAX_BYTES) throw new IOException("state file too large: " + name);
        return new String(atomic.readFully(), StandardCharsets.UTF_8);
    }

    static void write(Context context, String name, String content) throws IOException {
        File target = file(context, name);
        File dir = target.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) {
            throw new IOException("cannot create " + dir);
        }
        AtomicFile atomic = new AtomicFile(target);
        FileOutputStream out = atomic.startWrite();
        try {
            out.write(content.getBytes(StandardCharsets.UTF_8));
            atomic.finishWrite(out);
        } catch (IOException e) {
            atomic.failWrite(out);
            throw e;
        }
    }

    static File file(Context context, String name) {
        File dir = inSystemServer(context)
                ? new File(Environment.getDataDirectory(), SYSTEM_DIR)
                : new File(context.createDeviceProtectedStorageContext().getFilesDir(), APP_DIR);
        return new File(dir, name);
    }

    private static boolean inSystemServer(Context context) {
        return Process.myUid() == Process.SYSTEM_UID && "android".equals(context.getPackageName());
    }
}
