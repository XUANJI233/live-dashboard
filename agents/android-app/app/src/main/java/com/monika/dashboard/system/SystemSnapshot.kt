package com.monika.dashboard.system

data class ForegroundInfo(
    val packageName: String? = null,
    val appName: String? = null,
    val activity: String? = null,
    val title: String? = null,
    val source: String = "normal",
    val confidence: Double = 0.0,
)

data class InputInfo(
    val inputActive: Boolean? = null,
    val isTyping: Boolean? = null,
    val source: String = "normal",
)

data class MediaInfo(
    val playing: Boolean? = null,
    val title: String? = null,
    val artist: String? = null,
    val app: String? = null,
    val packageName: String? = null,
    val state: String? = null,
    val source: String = "normal",
)

data class SystemSnapshot(
    val capabilityMode: String = "normal",
    val foreground: ForegroundInfo? = null,
    val input: InputInfo? = null,
    val media: MediaInfo? = null,
    val sampledAt: Long = System.currentTimeMillis(),
)

data class LocationSnapshot(
    val latitude: Double,
    val longitude: Double,
    val accuracyMeters: Float? = null,
    val provider: String? = null,
    val recordedAt: Long = System.currentTimeMillis(),
)

object SystemSnapshotStore {
    @Volatile
    private var latestLsposed: SystemSnapshot? = null
    @Volatile
    private var latestAccessibility: SystemSnapshot? = null
    @Volatile
    private var latestNotification: SystemSnapshot? = null

    fun updateFromLsposed(snapshot: SystemSnapshot) {
        val previous = latestLsposedFresh(maxAgeMs = 10 * 60_000L)
        latestLsposed = SystemSnapshot(
            capabilityMode = "lsposed",
            foreground = mergeForeground(previous?.foreground, snapshot.foreground),
            input = snapshot.input ?: previous?.input,
            media = mergeMedia(previous?.media, snapshot.media),
            sampledAt = System.currentTimeMillis(),
        )
    }

    private fun mergeForeground(previous: ForegroundInfo?, next: ForegroundInfo?): ForegroundInfo? {
        if (previous == null) return next
        if (next == null) return previous
        return ForegroundInfo(
            packageName = next.packageName ?: previous.packageName,
            appName = next.appName ?: previous.appName,
            activity = next.activity ?: previous.activity,
            title = next.title ?: previous.title,
            source = next.source,
            confidence = maxOf(next.confidence, previous.confidence),
        )
    }

    private fun mergeMedia(previous: MediaInfo?, next: MediaInfo?): MediaInfo? {
        if (previous == null) return next
        if (next == null) return previous
        return MediaInfo(
            playing = next.playing ?: previous.playing,
            title = next.title ?: previous.title,
            artist = next.artist ?: previous.artist,
            app = next.app ?: previous.app,
            packageName = next.packageName ?: previous.packageName,
            state = next.state ?: previous.state,
            source = next.source,
        )
    }

    fun latestLsposedFresh(maxAgeMs: Long = 2 * 60_000L): SystemSnapshot? {
        val current = latestLsposed ?: return null
        return if (System.currentTimeMillis() - current.sampledAt <= maxAgeMs) current else null
    }

    fun updateFromAccessibility(foreground: ForegroundInfo) {
        latestAccessibility = SystemSnapshot(
            capabilityMode = "normal",
            foreground = foreground,
            sampledAt = System.currentTimeMillis(),
        )
    }

    fun latestAccessibilityFresh(maxAgeMs: Long = 2 * 60_000L): SystemSnapshot? {
        val current = latestAccessibility ?: return null
        return if (System.currentTimeMillis() - current.sampledAt <= maxAgeMs) current else null
    }

    fun updateFromNotification(media: MediaInfo) {
        latestNotification = SystemSnapshot(
            capabilityMode = "normal",
            media = media,
            sampledAt = System.currentTimeMillis(),
        )
    }

    fun latestNotificationFresh(maxAgeMs: Long = 10 * 60_000L): SystemSnapshot? {
        val current = latestNotification ?: return null
        return if (System.currentTimeMillis() - current.sampledAt <= maxAgeMs) current else null
    }

    fun mergedNormalSnapshot(includeForeground: Boolean, includeMedia: Boolean): SystemSnapshot {
        val foreground = if (includeForeground) latestAccessibilityFresh()?.foreground else null
        val media = if (includeMedia) latestNotificationFresh()?.media else null
        return SystemSnapshot(
            capabilityMode = "normal",
            foreground = foreground,
            media = media,
        )
    }
}
