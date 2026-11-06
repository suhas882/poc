package com.knackhook.prsphone

import com.knackhook.prsphone.data.PairLink
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PairLinkTest {
    @Test
    fun parsesTheWebsiteQrCode() {
        val link = PairLink.parse("prsphone://pair?s=https%3A%2F%2Frecords.example.org&c=ABCD2345")
        assertEquals(PairLink("https://records.example.org", "ABCD-2345"), link)
    }

    @Test
    fun rejectsOtherText() {
        assertNull(PairLink.parse("https://records.example.org"))
        assertNull(PairLink.parse("prsphone://pair?s=https%3A%2F%2Fx.org"))
        assertNull(PairLink.parse("prsphone://pair?c=ABCD2345"))
        assertNull(PairLink.parse(null))
    }

    @Test
    fun formatsTypedCodes() {
        assertEquals("ABCD-2345", PairLink.formatCode("abcd 2345"))
        assertEquals("ABCD-2345", PairLink.formatCode("ABCD-2345-extra"))
        assertEquals("AB", PairLink.formatCode("ab"))
    }
}
