package com.monika.dashboard.lsposed;

import android.content.Context;
import android.content.Intent;
import android.os.Handler;

import org.json.JSONObject;

final class LspMediaTracker {
    interface Host extends
            LspMediaSessionRecordHooks.Host,
            LspMediaControllerTracker.Host {
    }

    static final class Snapshot {
        private static final String EXTRA_MEDIA_PLAYING = "media_playing";
        private static final String EXTRA_MEDIA_PACKAGE = "media_package";
        private static final String EXTRA_MEDIA_TITLE = "media_title";
        private static final String EXTRA_MEDIA_ARTIST = "media_artist";
        private static final String EXTRA_MEDIA_APP = "media_app";
        private static final String EXTRA_MEDIA_STATE = "media_state";

        final boolean playing;
        final String packageName;
        final String appName;
        final String title;
        final String artist;
        final String state;

        Snapshot(boolean playing, String packageName, String appName, String title, String artist, String state) {
            this.playing = playing;
            this.packageName = LspMediaMetadata.safeString(packageName);
            this.appName = LspMediaMetadata.safeString(appName);
            this.title = LspMediaMetadata.safeString(title);
            this.artist = LspMediaMetadata.safeString(artist);
            this.state = LspMediaMetadata.safeString(state);
        }

        void putIntentExtras(Intent intent) {
            intent.putExtra(EXTRA_MEDIA_PLAYING, playing);
            if (packageName.length() > 0) intent.putExtra(EXTRA_MEDIA_PACKAGE, packageName);
            if (title.length() > 0) intent.putExtra(EXTRA_MEDIA_TITLE, title);
            if (artist.length() > 0) intent.putExtra(EXTRA_MEDIA_ARTIST, artist);
            if (appName.length() > 0) intent.putExtra(EXTRA_MEDIA_APP, appName);
            if (state.length() > 0) intent.putExtra(EXTRA_MEDIA_STATE, state);
        }

        void putReportMedia(JSONObject extra) throws Exception {
            if (!playing && packageName.length() == 0 && state.length() == 0) return;
            JSONObject media = new JSONObject();
            media.put("playing", playing);
            if (playing && title.length() > 0) media.put("title", title);
            if (playing && artist.length() > 0) media.put("artist", artist);
            if (appName.length() > 0) media.put("app", appName);
            if (packageName.length() > 0) media.put("package_name", packageName);
            if (state.length() > 0) media.put("state", state);
            media.put("source", "lsposed");
            extra.put("media", media);
        }

        String signaturePart() {
            return packageName + "|" + title + "|" + playing + "|" + state;
        }
    }

    private final LspMediaState state = new LspMediaState();
    private final LspMediaSessionRecordHooks sessionRecordHooks;
    private final LspMediaControllerTracker controllerTracker;

    LspMediaTracker(LspHookSupport hookSupport, Host host) {
        sessionRecordHooks = new LspMediaSessionRecordHooks(hookSupport, state, host);
        controllerTracker = new LspMediaControllerTracker(state, host);
    }

    Snapshot snapshot() {
        return state.snapshot();
    }

    void installInternalHooks(ClassLoader cl) {
        sessionRecordHooks.install(cl);
    }

    void initSessionListener() {
        controllerTracker.initSessionListener();
    }

    void validateIfNeeded(long now, boolean directUploadMedia) {
        controllerTracker.validateIfNeeded(now, directUploadMedia);
    }
}
