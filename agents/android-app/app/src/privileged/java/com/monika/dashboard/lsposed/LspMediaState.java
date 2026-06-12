package com.monika.dashboard.lsposed;

final class LspMediaState {
    private volatile boolean playing = false;
    private volatile String packageName = "";
    private volatile String appName = "";
    private volatile String title = "";
    private volatile String artist = "";
    private volatile String state = "";
    private volatile long lastValidationAt = 0L;

    synchronized LspMediaTracker.Snapshot snapshot() {
        return new LspMediaTracker.Snapshot(playing, packageName, appName, title, artist, state);
    }

    synchronized boolean playing() {
        return playing;
    }

    synchronized String packageName() {
        return packageName;
    }

    synchronized boolean hasAnyState() {
        return playing || packageName.length() > 0 || state.length() > 0;
    }

    synchronized long lastValidationAt() {
        return lastValidationAt;
    }

    synchronized void markValidated(long now) {
        lastValidationAt = now;
    }

    synchronized void clear() {
        playing = false;
        packageName = "";
        appName = "";
        title = "";
        artist = "";
        state = "";
    }

    synchronized void setStopped(String nextPackageName, String nextAppName, String nextState) {
        clear();
        packageName = LspMediaMetadata.safeString(nextPackageName);
        appName = LspMediaMetadata.safeString(nextAppName);
        state = LspMediaMetadata.safeString(nextState);
    }

    synchronized void setPlaying(
            String nextPackageName,
            String nextAppName,
            String nextState,
            String nextTitle,
            String nextArtist) {
        playing = true;
        packageName = LspMediaMetadata.safeString(nextPackageName);
        appName = LspMediaMetadata.safeString(nextAppName);
        state = LspMediaMetadata.safeString(nextState);
        title = LspMediaMetadata.safeString(nextTitle);
        artist = LspMediaMetadata.safeString(nextArtist);
    }

    synchronized String signature() {
        return playing
                + "|" + packageName
                + "|" + appName
                + "|" + title
                + "|" + artist
                + "|" + state;
    }
}
