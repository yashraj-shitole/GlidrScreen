package com.yashraj.glidr.screen

import com.yashraj.glidr.screen.signal.PairingParser
import com.yashraj.glidr.screen.signal.SignalCrypto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

/** Known-answer vectors produced by host/test/crypto.test.js: both ends must agree byte for byte. */
class SignalCryptoTest {
    private val key = ByteArray(16) { it.toByte() }

    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

    @Test fun derivesSameTopicAndKeyAsHost() {
        val slot = SignalCrypto.deriveSlot(key)
        assertEquals("gs-ech4ik3y3tbm5dic2ersa5oon3yywej3", slot.topic)
        assertEquals("6415664756e3dcc5866f33df6a22339567dc9f44921a05c3e909fa11e227db6a", hex(slot.encKey))
    }

    @Test fun opensFrameSealedByHost() {
        val frame = "oKGio6SlpqeoqaqrAiODrHkJPii8BW20uGq87P7-z0LQM1HGtwjL_38lF74IZOBFdt4VVj9aDpXbvJzmZw6-EAzJTI_2F4tCuP9SHIlhioWdNFc"
        val plain = SignalCrypto.open(SignalCrypto.deriveSlot(key).encKey, frame)
        assertEquals("""{"t":"req","sid":"abc","n":"Pixel"}""", plain)
    }

    @Test fun sealRoundTripAndTamperRejected() {
        val enc = SignalCrypto.deriveSlot(key).encKey
        val frame = SignalCrypto.seal(enc, """{"t":"answer","sdp":"v=0"}""")
        assertEquals("""{"t":"answer","sdp":"v=0"}""", SignalCrypto.open(enc, frame))
        val raw = Base64.getUrlDecoder().decode(frame)
        raw[20] = (raw[20].toInt() xor 1).toByte()
        assertNull(SignalCrypto.open(enc, Base64.getUrlEncoder().withoutPadding().encodeToString(raw)))
        assertNull(SignalCrypto.open(SignalCrypto.deriveSlot(SignalCrypto.newKey()).encKey, frame))
        assertNull(SignalCrypto.open(enc, "garbage"))
    }

    @Test fun manualCodeAndLinkParse() {
        val byCode = PairingParser.parse("AAAQ-EAYE-AUDA-OCAJ-BIFQ-YDIO-B4")
        assertNotNull(byCode); assertEquals(hex(key), hex(byCode!!.key))
        val link = "glidr://screen?v=1&k=${Base64.getUrlEncoder().withoutPadding().encodeToString(key)}&n=My+PC&s=https%3A%2F%2Fntfy.example.com"
        val byLink = PairingParser.parse(link)
        assertNotNull(byLink)
        assertEquals("My PC", byLink!!.hostName); assertEquals("https://ntfy.example.com", byLink.signalBase); assertEquals(hex(key), hex(byLink.key))
        assertNull(PairingParser.parse("hello")); assertNull(PairingParser.parse("glidr://screen?k=AAAA"))
        assertTrue(PairingParser.parse("aaaq eaye audad ocaj bifq ydio b4")?.key?.size == 16)
    }
}
