package com.monika.dashboard.lsposed;

import android.content.Context;
import android.os.Handler;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

final class LspWebAllowlistTestHosts {
    private LspWebAllowlistTestHosts() {}

    /** A controller on a phone without the system browser: strict browsing never activates. */
    static LspWebAllowlistController inactive(Context context) {
        return new LspWebAllowlistController(new FakeHost(context, Collections.emptyList()));
    }

    static final class FakeHost implements LspWebAllowlistController.Host {
        final Context context;
        final List<String> installed;
        final List<String> declaredBrowsers = new ArrayList<>();
        final Set<String> suspended = new HashSet<>();
        final Set<String> supervisionFrozen = new HashSet<>();
        Handler handler;
        int directUploadRequests = 0;

        FakeHost(Context context, List<String> installed) {
            this.context = context;
            this.installed = new ArrayList<>(installed);
        }

        @Override
        public Context systemContext() {
            return context;
        }

        @Override
        public Handler handler() {
            return handler;
        }

        @Override
        public List<String> browserPackages() {
            return new ArrayList<>(declaredBrowsers);
        }

        @Override
        public boolean isInstalled(String packageName) {
            return installed.contains(packageName);
        }

        @Override
        public boolean setPackageSuspended(String packageName, boolean value) {
            if (value) suspended.add(packageName);
            else suspended.remove(packageName);
            return true;
        }

        @Override
        public boolean isSupervisionFrozen(String packageName) {
            return supervisionFrozen.contains(packageName);
        }

        @Override
        public void requestDirectUpload(boolean force) {
            directUploadRequests++;
        }

        @Override
        public String isoTime(long millis) {
            return java.time.Instant.ofEpochMilli(millis).toString();
        }

        @Override
        public void logDebug(String message) {}

        @Override
        public void logWarn(String message) {}
    }
}
