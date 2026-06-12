package com.monika.dashboard.lsposed;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;

final class LspPackageController {
    interface Host {
        Context systemContext();
        String resolveAppLabel(String packageName);
        boolean isIgnoredPackage(String packageName);
        boolean isSystemServerProcess();
        String isoTime(long millis);
        void postFreezeNotification(String packageName, String appName, String reason, long until);
        void cancelFreezeNotification(String packageName);
        void logDebug(String message);
        void logWarn(String message);
    }

    private final Host host;
    private final LspFrozenPackageStore store = new LspFrozenPackageStore();
    private final LspPackageOperations operations;
    private final LspProtectedPackagePolicy protectedPolicy;

    LspPackageController(LspHookSupport hookSupport, Host host, String targetPackage) {
        this.host = host;
        operations = new LspPackageOperations(hookSupport, newPackageOperationsHost(host));
        protectedPolicy = new LspProtectedPackagePolicy(targetPackage, operations, host::isIgnoredPackage);
    }

    JSONObject frozenState(long now) {
        return store.frozenState(now, host::isoTime, this::releaseExpiredRecord);
    }

    List<LspFrozenPackage> frozenPackages(long now) {
        try {
            return store.frozenPackages(now, this::releaseExpiredRecord);
        } catch (Throwable t) {
            host.logDebug("device command frozen snapshot failed: " + t.getClass().getSimpleName());
            return java.util.Collections.emptyList();
        }
    }

    boolean unfreezePackage(String packageName) {
        String pkg = safeString(packageName);
        if (pkg.length() == 0) return false;
        try {
            LspFrozenPackageStore.Record record = store.record(pkg);
            if (record == null) return false;
            if ("suspended".equals(record.mode) && !operations.setPackageSuspended(record.packageName, false)) {
                return false;
            }
            store.remove(pkg);
            host.cancelFreezeNotification(record.packageName);
            return true;
        } catch (Throwable t) {
            host.logDebug("device command unfreeze failed: " + t.getClass().getSimpleName());
            return false;
        }
    }

    LspFreezeResult freezePackage(String packageName, String reason, long now, long until) {
        String pkg = safeString(packageName);
        String appName = safeString(host.resolveAppLabel(pkg));
        if (pkg.length() == 0 || isProtectedPackage(pkg)) {
            return new LspFreezeResult(pkg, appName, "", "ignored", "protected_or_empty_package", 0L);
        }
        LspFrozenPackageStore.Record existing = store.activeRecord(pkg, now);
        if (existing != null) {
            return new LspFreezeResult(
                    existing.packageName,
                    existing.appName,
                    existing.mode,
                    "applied",
                    "already_frozen",
                    existing.until);
        }
        boolean suspended = operations.setPackageSuspended(pkg, true);
        boolean stopped = operations.forceStopPackage(pkg);
        if (!suspended && !stopped) {
            return new LspFreezeResult(pkg, appName, "", "failed", "freeze_api_failed", 0L);
        }
        String mode = suspended ? "suspended" : "force_stopped";
        store.put(pkg, appName, now, until, reason, mode);
        host.postFreezeNotification(pkg, appName, reason, until);
        return new LspFreezeResult(pkg, appName, mode, "applied", reason, until);
    }

    boolean isInstalledPackage(String packageName) {
        return operations.isInstalledPackage(packageName);
    }

    List<LspInstalledApp> installedApps() {
        return operations.installedApps(protectedPolicy);
    }

    JSONArray frozenPackagesJson(long now) {
        return store.frozenPackagesJson(now, host::isoTime, this::releaseExpiredRecord);
    }

    boolean clear(String reason) {
        try {
            for (LspFrozenPackageStore.Record record : store.snapshot()) {
                releaseRecord(record);
            }
            store.clear();
            host.logWarn("supervision freeze cleared: " + safeString(reason));
            return true;
        } catch (Throwable t) {
            host.logDebug("clear supervision freeze failed: " + t.getClass().getSimpleName());
            return false;
        }
    }

    boolean isProtectedPackage(String packageName) {
        return protectedPolicy.isProtectedPackage(packageName);
    }

    private void releaseExpiredRecord(LspFrozenPackageStore.Record record) {
        try {
            releaseRecord(record);
        } catch (Throwable ignored) {}
    }

    private void releaseRecord(LspFrozenPackageStore.Record record) {
        if (record == null) return;
        if ("suspended".equals(record.mode)) operations.setPackageSuspended(record.packageName, false);
        host.cancelFreezeNotification(record.packageName);
    }

    private LspPackageOperations.Host newPackageOperationsHost(Host controllerHost) {
        return new LspPackageOperations.Host() {
            @Override
            public Context systemContext() {
                return controllerHost.systemContext();
            }

            @Override
            public boolean isSystemServerProcess() {
                return controllerHost.isSystemServerProcess();
            }

            @Override
            public void logDebug(String message) {
                controllerHost.logDebug(message);
            }

            @Override
            public void logWarn(String message) {
                controllerHost.logWarn(message);
            }
        };
    }

    private static String safeString(String value) {
        return value != null ? value.trim() : "";
    }
}
