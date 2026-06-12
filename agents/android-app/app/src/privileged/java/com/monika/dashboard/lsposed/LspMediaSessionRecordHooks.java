package com.monika.dashboard.lsposed;

import android.media.MediaMetadata;
import android.media.session.PlaybackState;

import java.lang.reflect.Method;

final class LspMediaSessionRecordHooks {
    interface Host {
        String resolveAppLabel(String packageName);
        void requestDirectUpload(boolean force);
        void logInfo(String message);
        void logWarn(String message);
        void logDebug(String message);
    }

    private final LspHookSupport hookSupport;
    private final LspMediaState state;
    private final Host host;
    private volatile boolean installed = false;

    LspMediaSessionRecordHooks(LspHookSupport hookSupport, LspMediaState state, Host host) {
        this.hookSupport = hookSupport;
        this.state = state;
        this.host = host;
    }

    void install(ClassLoader cl) {
        if (installed) return;
        try {
            Class<?> record = hookSupport.findClass("com.android.server.media.MediaSessionRecord", cl);
            Class<?> sessionStub = hookSupport.findClass("com.android.server.media.MediaSessionRecord$SessionStub", cl);
            if (record == null && sessionStub == null) throw new ClassNotFoundException("MediaSessionRecord");
            int hooked = 0;
            if (record != null) {
                hooked += hookMediaSessionRecordMethod(record, "setPlaybackState");
                hooked += hookMediaSessionRecordMethod(record, "setMetadata");
            }
            if (sessionStub != null) {
                hooked += hookMediaSessionRecordMethod(sessionStub, "setPlaybackState");
                hooked += hookMediaSessionRecordMethod(sessionStub, "setMetadata");
            }
            if (hooked > 0) {
                installed = true;
                host.logInfo("hooked MediaSessionRecord media methods: " + hooked);
            }
        } catch (Throwable t) {
            host.logWarn("internal media hooks skipped: " + t.getClass().getSimpleName());
        }
    }

    private int hookMediaSessionRecordMethod(Class<?> record, String methodName) {
        int hooked = 0;
        for (Method method : hookSupport.declaredMethodsByName(record, methodName)) {
            boolean ok = hookSupport.hookAfter(method, chain -> {
                try {
                    MediaMetadata metadata = null;
                    PlaybackState playbackState = null;
                    for (Object arg : chain.getArgs()) {
                        if (arg instanceof MediaMetadata) metadata = (MediaMetadata) arg;
                        if (arg instanceof PlaybackState) playbackState = (PlaybackState) arg;
                    }
                    updateMediaFromSessionRecord(chain.getThisObject(), playbackState, metadata);
                } catch (Throwable t) {
                    host.logDebug("media record hook ignored: " + t.getClass().getSimpleName());
                }
            });
            if (ok) hooked++;
        }
        return hooked;
    }

    private void updateMediaFromSessionRecord(Object record, PlaybackState playbackState, MediaMetadata metadata) {
        if (record == null) return;
        record = mediaRecordFromHookThis(record);
        if (playbackState == null) playbackState = playbackStateFromRecord(record);
        if (metadata == null) metadata = metadataFromRecord(record);
        String pkg = sessionRecordPackage(record);
        if (pkg.length() == 0 && state.packageName().length() == 0) return;

        String beforeMedia = state.signature();
        boolean knownPlaying = playbackState == null && metadata != null && state.playing()
                && (pkg.length() == 0 || pkg.equals(state.packageName()));
        boolean nextPlaying = knownPlaying
                || (playbackState != null && playbackState.getState() == PlaybackState.STATE_PLAYING);
        if (playbackState == null && !nextPlaying) return;
        if (!nextPlaying) {
            if (pkg.length() == 0 || pkg.equals(state.packageName())) {
                state.clear();
                if (pkg.length() > 0) {
                    state.setStopped(pkg, host.resolveAppLabel(pkg), LspMediaMetadata.playbackStateName(playbackState));
                }
            }
            host.requestDirectUpload(!beforeMedia.equals(state.signature()));
            return;
        }

        state.setPlaying(
                pkg,
                host.resolveAppLabel(pkg),
                LspMediaMetadata.playbackStateName(playbackState),
                LspMediaMetadata.title(metadata),
                LspMediaMetadata.artist(metadata));
        state.markValidated(System.currentTimeMillis());
        host.requestDirectUpload(!beforeMedia.equals(state.signature()));
    }

    private Object mediaRecordFromHookThis(Object value) {
        Object outer = hookSupport.readFirstField(
                value,
                "this$0",
                "mSessionRecord",
                "mRecord",
                "mSession");
        return outer != null ? outer : value;
    }

    private PlaybackState playbackStateFromRecord(Object record) {
        Object value = hookSupport.invokeNoArg(record, "getPlaybackState");
        if (!(value instanceof PlaybackState)) {
            value = hookSupport.readFirstField(record, "mPlaybackState", "mPlaybackStateCache");
        }
        return value instanceof PlaybackState ? (PlaybackState) value : null;
    }

    private MediaMetadata metadataFromRecord(Object record) {
        Object value = hookSupport.invokeNoArg(record, "getMetadata");
        if (!(value instanceof MediaMetadata)) {
            value = hookSupport.readFirstField(record, "mMetadata", "mMetadataCache");
        }
        return value instanceof MediaMetadata ? (MediaMetadata) value : null;
    }

    private String sessionRecordPackage(Object record) {
        Object value = hookSupport.invokeNoArg(record, "getPackageName");
        if (!(value instanceof String)) {
            value = hookSupport.readFirstField(
                    record,
                    "mPackageName",
                    "mOwnerPackageName",
                    "mCallingPackage");
        }
        return value instanceof String ? LspMediaMetadata.safeString((String) value) : "";
    }
}
