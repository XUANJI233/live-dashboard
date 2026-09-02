package com.monika.dashboard.integration

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class AutoAccountingParserTest {
    @Test
    fun `keeps only completed parent bills`() {
        val json = """
            {
              "code": 200,
              "msg": "OK",
              "data": [
                {"id":1,"type":"Expend","currency":"CNY","money":12.5,"time":1788230400000,"state":"Edited","groupId":-1,"shopName":"Coffee"},
                {"id":2,"type":"Income","currency":"{\"code\":\"USD\",\"rate\":7.1}","money":5,"time":1788230500000,"state":"Synced","groupId":-1},
                {"id":3,"type":"Expend","currency":"CNY","money":9,"time":1788230600000,"state":"Wait2Edit","groupId":-1},
                {"id":4,"type":"Expend","currency":"CNY","money":2,"time":1788230700000,"state":"Edited","groupId":1}
              ]
            }
        """.trimIndent()

        val bills = AutoAccountingParser.parseCompletedBills(json)

        assertEquals(listOf("1", "2"), bills.map { it.sourceBillId })
        assertEquals("CNY", bills[0].currencyCode)
        assertEquals("USD", bills[1].currencyCode)
        assertTrue(bills.all { it.groupId == -1L })
    }
}
