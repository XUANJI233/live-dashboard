package com.monika.dashboard.ui.components

fun friendlyErrorMessage(error: Throwable): String =
    friendlyErrorMessage(error.message ?: error.javaClass.simpleName)

fun friendlyErrorMessage(message: String?): String {
    val raw = message?.trim().orEmpty()
    if (raw.isBlank()) return "操作失败"

    return when {
        raw.contains("localhost/127.0.0.1", ignoreCase = true) ||
            raw.contains("Failed to connect to localhost", ignoreCase = true) ||
            raw.contains("Failed to connect to 127.0.0.1", ignoreCase = true) ->
            "无法连接到 localhost。Android 上的 localhost 指向设备本机；连接电脑本地服务请先用 adb reverse 转发端口，或改用 HTTPS 地址。"

        raw.contains("CLEARTEXT communication", ignoreCase = true) ->
            "当前地址使用 HTTP 且未被允许。请改用 HTTPS；本地调试只支持 localhost/127.0.0.1。"

        raw.contains("Only HTTPS or http://localhost allowed", ignoreCase = true) ||
            raw.contains("Invalid URL: must be HTTPS or http://localhost", ignoreCase = true) ->
            "地址无效：必须使用 HTTPS；HTTP 仅支持 localhost/127.0.0.1。"

        else -> raw
    }
}
