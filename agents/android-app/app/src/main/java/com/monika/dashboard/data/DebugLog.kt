package com.monika.dashboard.data

import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.concurrent.ConcurrentLinkedDeque
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * In-memory debug log buffer, visible in Status screen.
 * Thread-safe, capped at MAX_ENTRIES.
 */
object DebugLog {
    private const val MAX_ENTRIES = 300
    private val entries = ConcurrentLinkedDeque<String>()
    private val timeFmt = DateTimeFormatter.ofPattern("HH:mm:ss")
    private val _version = MutableStateFlow(0)

    val lines: List<String> get() = entries.toList()
    val version: StateFlow<Int> = _version.asStateFlow()

    fun log(tag: String, message: String) {
        val time = LocalTime.now().format(timeFmt)
        val line = "$time [$tag] $message"
        entries.addFirst(line)
        // Trim excess entries
        while (entries.size > MAX_ENTRIES) {
            entries.pollLast()
        }
        _version.value += 1
    }

    fun clear() {
        entries.clear()
        _version.value += 1
    }
}
