package com.monika.dashboard.integration

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

data class ProcessedAccountingBill(
    val sourceBillId: String,
    val type: String,
    val currencyCode: String,
    val money: Double,
    val fee: Double,
    val occurredAt: String,
    val shopName: String,
    val shopItem: String,
    val categoryName: String,
    val bookName: String,
    val accountNameFrom: String,
    val accountNameTo: String,
    val app: String,
    val channel: String,
    val state: String,
    val remark: String,
    val auto: Boolean,
    val ruleName: String,
    val tags: List<String>,
    val flag: Int,
    val groupId: Long,
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("source_bill_id", sourceBillId)
        put("type", type)
        put("currency_code", currencyCode)
        put("money", money)
        put("fee", fee)
        put("occurred_at", occurredAt)
        put("shop_name", shopName)
        put("shop_item", shopItem)
        put("category_name", categoryName)
        put("book_name", bookName)
        put("account_name_from", accountNameFrom)
        put("account_name_to", accountNameTo)
        put("app", app)
        put("channel", channel)
        put("state", state)
        put("remark", remark)
        put("auto", auto)
        put("rule_name", ruleName)
        put("tags", JSONArray(tags))
        put("flag", flag)
        put("group_id", groupId)
    }
}

object AutoAccountingParser {
    private val completedStates = setOf("Edited", "Synced")
    private val transactionTypes = setOf(
        "Expend",
        "ExpendReimbursement",
        "ExpendLending",
        "ExpendRepayment",
        "Income",
        "IncomeLending",
        "IncomeRepayment",
        "IncomeReimbursement",
        "IncomeRefund",
        "Transfer",
    )

    fun parseCompletedBills(responseText: String): List<ProcessedAccountingBill> {
        val response = JSONObject(responseText)
        require(response.optInt("code") == 200) {
            response.optString("msg").ifBlank { "AutoAccounting request failed" }
        }
        val data = response.optJSONArray("data") ?: JSONArray()
        return buildList {
            for (index in 0 until data.length()) {
                parseBill(data.optJSONObject(index))?.let(::add)
            }
        }
    }

    private fun parseBill(source: JSONObject?): ProcessedAccountingBill? {
        if (source == null) return null
        val id = source.optLong("id", -1L)
        val groupId = source.optLong("groupId", -1L)
        val state = source.optString("state")
        val type = source.optString("type")
        val time = source.optLong("time", -1L)
        val money = source.optDouble("money", Double.NaN)
        if (id < 0L || !source.has("groupId") || groupId != -1L) return null
        if (state !in completedStates || type !in transactionTypes) return null
        if (time <= 0L || !money.isFinite() || money < 0.0) return null

        return ProcessedAccountingBill(
            sourceBillId = id.toString(),
            type = type,
            currencyCode = currencyCode(source.optString("currency")),
            money = money.roundMoney(),
            fee = source.optDouble("fee", 0.0).takeIf(Double::isFinite)?.roundMoney() ?: 0.0,
            occurredAt = Instant.ofEpochMilli(time).toString(),
            shopName = source.cleanText("shopName", 160),
            shopItem = source.cleanText("shopItem", 160),
            categoryName = source.cleanText("cateName", 100),
            bookName = source.cleanText("bookName", 100),
            accountNameFrom = source.cleanText("accountNameFrom", 100),
            accountNameTo = source.cleanText("accountNameTo", 100),
            app = source.cleanText("app", 100),
            channel = source.cleanText("channel", 120),
            state = state,
            remark = source.cleanText("remark", 500),
            auto = source.opt("auto") as? Boolean ?: false,
            ruleName = source.cleanText("ruleName", 160),
            tags = source.optString("tags")
                .split(',')
                .map(String::trim)
                .filter(String::isNotBlank)
                .distinct()
                .take(20),
            flag = source.optInt("flag", 0),
            groupId = groupId,
        )
    }

    private fun currencyCode(value: String): String {
        val trimmed = value.trim()
        val fromJson = runCatching { JSONObject(trimmed).optString("code") }.getOrNull().orEmpty()
        return (fromJson.ifBlank { trimmed })
            .uppercase()
            .takeIf { it.matches(Regex("[A-Z0-9]{2,8}")) }
            ?: "CNY"
    }

    private fun JSONObject.cleanText(key: String, maxLength: Int): String =
        optString(key)
            .replace(Regex("[\\u0000-\\u001f\\u007f]"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()
            .take(maxLength)

    private fun Double.roundMoney(): Double = kotlin.math.round(this * 100.0) / 100.0
}
