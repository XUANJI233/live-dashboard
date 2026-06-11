package com.monika.dashboard.network

data class SupervisionRules(
    val whitelistAppRegex: List<String>,
    val blacklistAppRegex: List<String>,
    val riskAppRegex: List<String>,
    val targetAppRegex: List<String>,
    val reason: String,
) {
    fun hasContent(): Boolean =
        reason.isNotBlank() ||
            whitelistAppRegex.isNotEmpty() ||
            blacklistAppRegex.isNotEmpty() ||
            riskAppRegex.isNotEmpty() ||
            targetAppRegex.isNotEmpty()

    companion object {
        fun empty(): SupervisionRules = SupervisionRules(
            whitelistAppRegex = emptyList(),
            blacklistAppRegex = emptyList(),
            riskAppRegex = emptyList(),
            targetAppRegex = emptyList(),
            reason = "",
        )
    }
}
