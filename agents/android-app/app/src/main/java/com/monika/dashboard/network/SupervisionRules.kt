package com.monika.dashboard.network

data class SupervisionRules(
    val whitelistAppRegex: List<String>,
    val blacklistAppRegex: List<String>,
    val targetAppRegex: List<String>,
    val reason: String,
) {
    fun hasContent(): Boolean =
        reason.isNotBlank() ||
            whitelistAppRegex.isNotEmpty() ||
            blacklistAppRegex.isNotEmpty() ||
            targetAppRegex.isNotEmpty()

    companion object {
        fun empty(): SupervisionRules = SupervisionRules(
            whitelistAppRegex = emptyList(),
            blacklistAppRegex = emptyList(),
            targetAppRegex = emptyList(),
            reason = "",
        )
    }
}
