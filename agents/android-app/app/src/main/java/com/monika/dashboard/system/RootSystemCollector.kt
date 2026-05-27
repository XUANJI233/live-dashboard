package com.monika.dashboard.system

import android.content.Context
import android.content.pm.PackageManager
import com.monika.dashboard.data.DebugLog
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

class RootSystemCollector(private val context: Context) {

    suspend fun collect(): SystemSnapshot? = withContext(Dispatchers.IO) {
        val activity = runRoot("dumpsys activity activities")
        val window = runRoot("dumpsys window")
        val input = runRoot("dumpsys input_method")
        val media = runRoot("dumpsys media_session")

        if (activity == null && window == null && input == null && media == null) {
            DebugLog.log("root", "root采集不可用，降级为normal")
            return@withContext null
        }

        val foreground = parseForeground(activity.orEmpty(), window.orEmpty())
        val inputInfo = parseInput(input.orEmpty())
        val mediaInfo = parseMedia(media.orEmpty())
        SystemSnapshot(
            capabilityMode = "root",
            foreground = foreground,
            input = inputInfo,
            media = mediaInfo,
        )
    }

    private fun runRoot(command: String): String? {
        return try {
            val process = ProcessBuilder("su", "-c", command)
                .redirectErrorStream(true)
                .start()
            if (!process.waitFor(1500, TimeUnit.MILLISECONDS)) {
                process.destroyForcibly()
                return null
            }
            if (process.exitValue() != 0) return null
            process.inputStream.bufferedReader().use { it.readText().take(120_000) }
        } catch (_: Exception) {
            null
        }
    }

    private fun parseForeground(activityDump: String, windowDump: String): ForegroundInfo? {
        val combined = activityDump + "\n" + windowDump
        val patterns = listOf(
            Regex("""mResumedActivity:.*?\s([a-zA-Z0-9_.]+)/([a-zA-Z0-9_.$]+)"""),
            Regex("""topResumedActivity=.*?\s([a-zA-Z0-9_.]+)/([a-zA-Z0-9_.$]+)"""),
            Regex("""mCurrentFocus=.*?\s([a-zA-Z0-9_.]+)/([a-zA-Z0-9_.$]+)"""),
            Regex("""mFocusedApp=.*?\s([a-zA-Z0-9_.]+)/([a-zA-Z0-9_.$]+)"""),
        )
        for (pattern in patterns) {
            val match = pattern.find(combined) ?: continue
            val pkg = match.groupValues.getOrNull(1)?.takeIf { it.isNotBlank() } ?: continue
            val activity = match.groupValues.getOrNull(2)?.takeIf { it.isNotBlank() }
            return ForegroundInfo(
                packageName = pkg,
                appName = resolveAppName(pkg),
                activity = activity,
                source = "root",
                confidence = 0.8,
            )
        }
        return null
    }

    private fun parseInput(inputDump: String): InputInfo? {
        if (inputDump.isBlank()) return null
        val active = inputDump.contains("mInputShown=true", ignoreCase = true) ||
            inputDump.contains("inputShown=true", ignoreCase = true) ||
            inputDump.contains("mServedView", ignoreCase = true)
        return InputInfo(inputActive = active, isTyping = active, source = "root")
    }

    private fun parseMedia(mediaDump: String): MediaInfo? {
        if (mediaDump.isBlank()) return null
        val blocks = mediaDump
            .split(Regex("""(?m)^\s*Sessions Stack|\n\s*Session\s+"""))
            .map { it.trim() }
            .filter { it.isNotBlank() }

        val candidate = blocks.firstOrNull { block ->
            isPlayingMediaBlock(block) && !isIgnoredMediaPackage(extractPackage(block).orEmpty())
        } ?: blocks.firstOrNull { isPlayingMediaBlock(it) }

        if (candidate == null) return MediaInfo(playing = false, source = "root")

        val packageName = extractPackage(candidate)
        val title = extractMetadata(candidate, "title")
            ?: extractMetadata(candidate, "android.media.metadata.TITLE")
        val artist = extractMetadata(candidate, "artist")
            ?: extractMetadata(candidate, "android.media.metadata.ARTIST")
            ?: extractMetadata(candidate, "android.media.metadata.AUTHOR")
        return MediaInfo(
            playing = true,
            title = title,
            artist = artist,
            app = packageName?.let(::resolveAppName) ?: packageName,
            packageName = packageName,
            state = "playing",
            source = "root",
        )
    }

    private fun isPlayingMediaBlock(block: String): Boolean {
        return block.contains("state=PlaybackState {state=3", ignoreCase = true) ||
            block.contains("state=3,", ignoreCase = true) ||
            block.contains("STATE_PLAYING", ignoreCase = true) ||
            block.contains("PlaybackState {state=3", ignoreCase = true)
    }

    private fun extractPackage(block: String): String? {
        val patterns = listOf(
            Regex("""package=([a-zA-Z0-9_.]+)"""),
            Regex("""packageName=([a-zA-Z0-9_.]+)"""),
            Regex("""ownerPackageName=([a-zA-Z0-9_.]+)"""),
        )
        return patterns.firstNotNullOfOrNull { pattern ->
            pattern.find(block)?.groupValues?.getOrNull(1)
        }
    }

    private fun extractMetadata(block: String, key: String): String? {
        val escaped = Regex.escape(key)
        val patterns = listOf(
            Regex("""$escaped=([^,\n}]+)""", RegexOption.IGNORE_CASE),
            Regex("""$escaped:\s*([^,\n}]+)""", RegexOption.IGNORE_CASE),
        )
        return patterns.firstNotNullOfOrNull { pattern ->
            pattern.find(block)?.groupValues?.getOrNull(1)?.trim()?.takeIf { it.isNotBlank() && it != "null" }
        }
    }

    private fun isIgnoredMediaPackage(packageName: String): Boolean {
        return packageName == "android" ||
            packageName == "com.android.systemui" ||
            packageName == "com.milink.service" ||
            packageName == "com.miui.misound"
    }

    private fun resolveAppName(packageName: String): String? {
        return try {
            val pm = context.packageManager
            val info = pm.getApplicationInfo(packageName, 0)
            pm.getApplicationLabel(info).toString()
        } catch (_: PackageManager.NameNotFoundException) {
            null
        } catch (_: Exception) {
            null
        }
    }
}
