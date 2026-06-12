package com.monika.dashboard.lsposed;

import android.content.Context;
import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.os.Handler;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

final class LspMediaControllerTracker {
    private static final long MEDIA_VALIDATE_MS = 60_000L;

    interface Host {
        Context systemContext();
        Handler uploadHandler();
        String resolveAppLabel(String packageName);
        void requestDirectUpload(boolean force);
        void logInfo(String message);
        void logWarn(String message);
        void logDebug(String message);
    }

    private static final class MediaControllerRegistration {
        final MediaController controller;
        final MediaController.Callback callback;

        MediaControllerRegistration(MediaController controller, MediaController.Callback callback) {
            this.controller = controller;
            this.callback = callback;
        }

        void unregister() {
            try { controller.unregisterCallback(callback); } catch (Throwable ignored) {}
        }
    }

    private final LspMediaState state;
    private final Host host;
    private final Map<Object, MediaControllerRegistration> registeredMediaControllers =
            java.util.Collections.synchronizedMap(new HashMap<>());
    private volatile boolean listenerRegistered = false;
    private volatile MediaSessionManager mediaSessionManager;

    LspMediaControllerTracker(LspMediaState state, Host host) {
        this.state = state;
        this.host = host;
    }

    void initSessionListener() {
        if (listenerRegistered) return;
        Context context = host.systemContext();
        if (context == null) return;
        try {
            mediaSessionManager = (MediaSessionManager) context.getSystemService(Context.MEDIA_SESSION_SERVICE);
            if (mediaSessionManager == null) {
                host.logWarn("MediaSessionManager not available");
                return;
            }
            mediaSessionManager.addOnActiveSessionsChangedListener(
                    controllers -> handleActiveSessionsChanged(controllers),
                    null);
            List<MediaController> active = mediaSessionManager.getActiveSessions(null);
            String beforeMedia = state.signature();
            if (active != null) {
                host.logInfo("initial active media sessions: " + active.size());
                for (MediaController controller : active) {
                    registerMediaControllerCallback(controller);
                }
                refreshMediaFromControllers(active);
            }
            listenerRegistered = true;
            host.requestDirectUpload(!beforeMedia.equals(state.signature()));
            host.logInfo("MediaSessionManager listener registered");
        } catch (Throwable t) {
            host.logWarn("initMediaSessionListener failed: " + t.getClass().getSimpleName());
        }
    }

    void validateIfNeeded(long now, boolean directUploadMedia) {
        if (!directUploadMedia) return;
        if (!state.hasAnyState()) return;
        if (now - state.lastValidationAt() < MEDIA_VALIDATE_MS) return;
        refreshActiveMediaState();
    }

    private void handleActiveSessionsChanged(List<MediaController> controllers) {
        try {
            if (controllers == null) return;
            host.logDebug("active sessions changed: " + controllers.size());
            String beforeMedia = state.signature();
            String trackedPkg = state.packageName();
            if (trackedPkg.length() > 0 && !containsPackage(controllers, trackedPkg)) {
                host.logDebug("media session removed: " + trackedPkg + ", clearing media info");
                state.clear();
            }
            for (MediaController controller : controllers) {
                registerMediaControllerCallback(controller);
            }
            refreshMediaFromControllers(controllers);
            cleanupStaleMediaControllerCallbacks(activeControllerKeys(controllers));
            host.requestDirectUpload(!beforeMedia.equals(state.signature()));
        } catch (Throwable t) {
            host.logWarn("onActiveSessionsChanged failed: " + t.getClass().getSimpleName());
        }
    }

    private boolean containsPackage(List<MediaController> controllers, String packageName) {
        for (MediaController controller : controllers) {
            if (packageName.equals(controller.getPackageName())) return true;
        }
        return false;
    }

    private HashSet<Object> activeControllerKeys(List<MediaController> controllers) {
        HashSet<Object> activeKeys = new HashSet<>();
        for (MediaController controller : controllers) {
            activeKeys.add(mediaControllerKey(controller));
        }
        return activeKeys;
    }

    private void registerMediaControllerCallback(MediaController controller) {
        if (controller == null) return;
        Object key = mediaControllerKey(controller);
        synchronized (registeredMediaControllers) {
            if (registeredMediaControllers.containsKey(key)) return;
        }
        try {
            MediaController.Callback callback = new MediaController.Callback() {
                @Override
                public void onPlaybackStateChanged(PlaybackState playbackState) {
                    handlePlaybackStateChanged(controller, playbackState);
                }

                @Override
                public void onMetadataChanged(MediaMetadata metadata) {
                    handleMetadataChanged(controller, metadata);
                }

                @Override
                public void onSessionDestroyed() {
                    try {
                        unregisterMediaControllerCallback(key);
                        refreshActiveMediaState();
                        host.requestDirectUpload(true);
                    } catch (Throwable ignored) {}
                }
            };
            Handler handler = host.uploadHandler();
            if (handler != null) {
                controller.registerCallback(callback, handler);
            } else {
                controller.registerCallback(callback);
            }
            boolean duplicate = false;
            synchronized (registeredMediaControllers) {
                if (registeredMediaControllers.containsKey(key)) {
                    duplicate = true;
                } else {
                    registeredMediaControllers.put(key, new MediaControllerRegistration(controller, callback));
                }
            }
            if (duplicate) {
                try { controller.unregisterCallback(callback); } catch (Throwable ignored) {}
            }
        } catch (Throwable ignored) {
            synchronized (registeredMediaControllers) {
                registeredMediaControllers.remove(key);
            }
        }
    }

    private void handlePlaybackStateChanged(MediaController controller, PlaybackState playbackState) {
        try {
            if (playbackState == null) return;
            String beforeMedia = state.signature();
            String pkg = controller.getPackageName();
            boolean nextPlaying = playbackState.getState() == PlaybackState.STATE_PLAYING;
            if (!nextPlaying) {
                refreshActiveMediaState();
                host.logDebug("media playback stopped/paused: pkg=" + pkg);
                host.requestDirectUpload(!beforeMedia.equals(state.signature()));
                return;
            }
            MediaMetadata metadata = controller.getMetadata();
            state.setPlaying(
                    pkg,
                    host.resolveAppLabel(pkg),
                    LspMediaMetadata.playbackStateName(playbackState),
                    LspMediaMetadata.title(metadata),
                    LspMediaMetadata.artist(metadata));
            host.logDebug("media playback: pkg=" + pkg
                    + " playing=true title=" + state.snapshot().title);
            host.requestDirectUpload(!beforeMedia.equals(state.signature()));
        } catch (Throwable t) {
            host.logWarn("onPlaybackStateChanged failed: " + t.getClass().getSimpleName());
        }
    }

    private void handleMetadataChanged(MediaController controller, MediaMetadata metadata) {
        try {
            String beforeMedia = state.signature();
            String pkg = controller.getPackageName();
            PlaybackState playbackState = controller.getPlaybackState();
            boolean playing = playbackState != null && playbackState.getState() == PlaybackState.STATE_PLAYING;
            if (!playing) {
                refreshActiveMediaState();
                host.requestDirectUpload(!beforeMedia.equals(state.signature()));
                return;
            }
            state.setPlaying(
                    pkg,
                    host.resolveAppLabel(pkg),
                    LspMediaMetadata.playbackStateName(playbackState),
                    LspMediaMetadata.title(metadata),
                    LspMediaMetadata.artist(metadata));
            host.logDebug("media metadata: pkg=" + pkg
                    + " playing=true title=" + state.snapshot().title);
            host.requestDirectUpload(!beforeMedia.equals(state.signature()));
        } catch (Throwable t) {
            host.logWarn("onMetadataChanged failed: " + t.getClass().getSimpleName());
        }
    }

    private Object mediaControllerKey(MediaController controller) {
        if (controller == null) return "";
        try {
            Object token = controller.getSessionToken();
            if (token != null) return token;
        } catch (Throwable ignored) {}
        return LspMediaMetadata.safeString(controller.getPackageName()) + "@" + System.identityHashCode(controller);
    }

    private void cleanupStaleMediaControllerCallbacks(HashSet<Object> activeKeys) {
        ArrayList<MediaControllerRegistration> stale = new ArrayList<>();
        synchronized (registeredMediaControllers) {
            Iterator<Map.Entry<Object, MediaControllerRegistration>> iterator =
                    registeredMediaControllers.entrySet().iterator();
            while (iterator.hasNext()) {
                Map.Entry<Object, MediaControllerRegistration> entry = iterator.next();
                if (!activeKeys.contains(entry.getKey())) {
                    stale.add(entry.getValue());
                    iterator.remove();
                }
            }
        }
        for (MediaControllerRegistration registration : stale) {
            registration.unregister();
        }
    }

    private void unregisterMediaControllerCallback(Object key) {
        MediaControllerRegistration registration;
        synchronized (registeredMediaControllers) {
            registration = registeredMediaControllers.remove(key);
        }
        if (registration != null) registration.unregister();
    }

    private void refreshMediaFromControllers(List<MediaController> controllers) {
        try {
            state.markValidated(System.currentTimeMillis());
            MediaController playing = null;
            if (controllers != null) {
                for (MediaController controller : controllers) {
                    PlaybackState playbackState = controller.getPlaybackState();
                    if (playbackState != null && playbackState.getState() == PlaybackState.STATE_PLAYING) {
                        playing = controller;
                        break;
                    }
                }
            }
            if (playing == null) {
                state.clear();
                return;
            }
            String pkg = playing.getPackageName();
            PlaybackState playbackState = playing.getPlaybackState();
            MediaMetadata metadata = playing.getMetadata();
            state.setPlaying(
                    pkg,
                    host.resolveAppLabel(pkg),
                    LspMediaMetadata.playbackStateName(playbackState),
                    LspMediaMetadata.title(metadata),
                    LspMediaMetadata.artist(metadata));
        } catch (Throwable t) {
            state.clear();
            host.logDebug("refresh media failed: " + t.getClass().getSimpleName());
        }
    }

    private void refreshActiveMediaState() {
        try {
            if (mediaSessionManager == null) {
                state.clear();
                return;
            }
            refreshMediaFromControllers(mediaSessionManager.getActiveSessions(null));
        } catch (Throwable ignored) {
            state.clear();
        }
    }
}
