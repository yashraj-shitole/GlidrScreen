package com.yashraj.glidr.screen

import com.yashraj.glidr.screen.net.SignalMsg
import com.yashraj.glidr.screen.net.VideoDecoders
import com.yashraj.glidr.screen.signal.SignalCrypto
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VideoDecodersTest {
    // ---- decoder name mapping (VideoCodecInfo.name -> protocol names)

    @Test fun mapsWebRtcNamesToLowerCase() {
        assertEquals(listOf("h264", "vp8", "vp9", "av1"), VideoDecoders.names(listOf("VP8", "VP9", "H264", "AV1")))
    }

    @Test fun keepsAFixedOrderAndDropsDuplicates() {
        assertEquals(listOf("h264", "vp8"), VideoDecoders.names(listOf("VP8", "H264", "VP8", "H264", "vp8")))
    }

    @Test fun dropsUnknownCodecsAndRedundancyEntries() {
        // H.265 and the fec / rtx style entries are not offered by the PC, so they are never reported
        assertEquals(listOf("vp8"), VideoDecoders.names(listOf("H265", "red", "ulpfec", "VP8", "AV1X", "")))
        assertEquals(emptyList<String>(), VideoDecoders.names(emptyList()))
        assertEquals(emptyList<String>(), VideoDecoders.names(listOf("H265")))
    }

    @Test fun trimsAndIgnoresCase() {
        assertEquals(listOf("vp9", "av1"), VideoDecoders.names(listOf(" vp9 ", "Av1")))
    }

    // ---- the req message

    private fun req(decoders: List<String>, name: String = "Google Pixel 8") = SignalMsg.request("sid123", 1_800_000_000_000L, name, decoders)

    @Test fun requestKeepsTheExistingFields() {
        val m = req(listOf("h264"))
        assertEquals("req", m.getString("t"))
        assertEquals("p", m.getString("from"))
        assertEquals("sid123", m.getString("sid"))
        assertEquals(1_800_000_000_000L, m.getLong("ts"))
        assertEquals("Google Pixel 8", m.getString("n"))
    }

    @Test fun requestCarriesTheDecoders() {
        val dec = req(listOf("h264", "vp8", "vp9", "av1")).getJSONArray("dec")
        assertEquals(listOf("h264", "vp8", "vp9", "av1"), (0 until dec.length()).map { dec.getString(it) })
    }

    @Test fun requestOmitsDecWhenNothingIsKnown() {
        // an empty list means "unknown", which the PC treats like an older phone; better than claiming nothing decodes
        assertFalse(req(emptyList()).has("dec"))
        assertFalse(req(listOf("h265")).has("dec"))
    }

    @Test fun requestFiltersAndDeduplicatesDecoders() {
        val dec = req(listOf("vp9", "vp9", "hevc", "av1")).getJSONArray("dec")
        assertEquals(listOf("vp9", "av1"), (0 until dec.length()).map { dec.getString(it) })
    }

    @Test fun sealedRequestStaysFarBelowTheFrameLimit() {
        val slot = SignalCrypto.deriveSlot(ByteArray(32) { it.toByte() })
        val m = req(listOf("h264", "vp8", "vp9", "av1"), "x".repeat(48))
        val frame = SignalCrypto.seal(slot.encKey, m.toString()) // throws above 3900 characters
        assertTrue("frame ${frame.length}", frame.length < 400)
        assertEquals(m.toString(), JSONObject(SignalCrypto.open(slot.encKey, frame)!!).toString())
    }
}
