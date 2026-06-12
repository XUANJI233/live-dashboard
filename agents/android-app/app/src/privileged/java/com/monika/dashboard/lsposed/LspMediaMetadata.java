package com.monika.dashboard.lsposed;

import android.media.MediaMetadata;
import android.media.session.PlaybackState;

final class LspMediaMetadata {
    private LspMediaMetadata() {
    }

    static String title(MediaMetadata metadata) {
        return safeString(firstNonBlank(
                text(metadata, MediaMetadata.METADATA_KEY_DISPLAY_TITLE),
                text(metadata, MediaMetadata.METADATA_KEY_TITLE)));
    }

    static String artist(MediaMetadata metadata) {
        return safeString(firstNonBlank(
                text(metadata, MediaMetadata.METADATA_KEY_ARTIST),
                text(metadata, MediaMetadata.METADATA_KEY_AUTHOR),
                text(metadata, MediaMetadata.METADATA_KEY_ALBUM_ARTIST)));
    }

    static String playbackStateName(Object playback) {
        if (playback instanceof PlaybackState) {
            int state = ((PlaybackState) playback).getState();
            if (state == PlaybackState.STATE_PLAYING) return "playing";
            if (state == PlaybackState.STATE_PAUSED) return "paused";
            if (state == PlaybackState.STATE_STOPPED) return "stopped";
            return "state_" + state;
        }
        return playback == null ? null : playback.toString();
    }

    static String safeString(String value) {
        return value == null ? "" : value.trim();
    }

    private static String text(MediaMetadata metadata, String key) {
        try {
            CharSequence value = metadata != null ? metadata.getText(key) : null;
            return value != null ? value.toString() : null;
        } catch (Throwable ignored) {
            return null;
        }
    }

    private static String firstNonBlank(String... values) {
        for (String value : values) {
            if (value != null && value.trim().length() > 0) return value;
        }
        return null;
    }
}
