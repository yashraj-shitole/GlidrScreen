package com.yashraj.glidr.screen

import com.yashraj.glidr.screen.input.Swipe
import com.yashraj.glidr.screen.input.SwipeGestures
import com.yashraj.glidr.screen.net.ConnectStages
import com.yashraj.glidr.screen.net.Msg
import com.yashraj.glidr.screen.net.Quality
import com.yashraj.glidr.screen.net.StreamMode
import com.yashraj.glidr.screen.signal.PairingParser
import com.yashraj.glidr.screen.signal.WakeOnLan
import com.yashraj.glidr.screen.ui.modeCaption
import java.util.Base64
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Wake-on-LAN, three-finger swipes, the failure stage line and the quality mode message. */
class RoadmapPhoneTest {
    private val keyText = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(16) { it.toByte() })
    private fun link(extra: String = "") = "glidr://screen?v=1&k=$keyText&n=My+PC$extra"

    // ---------------------------------------------------------------- Wake-on-LAN

    @Test fun magicPacketIs102BytesOfFfThenMacSixteenTimes() {
        val mac = byteArrayOf(0x00, 0x1A, 0x2B, 0x3C, 0x4D, 0x5E)
        val p = WakeOnLan.magicPacket(mac)
        assertEquals(102, p.size)
        for (i in 0 until 6) assertEquals(0xFF.toByte(), p[i])
        for (r in 0 until 16) assertArrayEquals(mac, p.copyOfRange(6 + r * 6, 12 + r * 6))
    }

    @Test fun magicPacketFromText() {
        val p = WakeOnLan.magicPacket("001a2b3c4d5e")
        assertEquals(102, p.size)
        assertEquals(0x5E.toByte(), p[101])
    }

    @Test fun macParsingIsStrict() {
        assertArrayEquals(byteArrayOf(0, 0x1A, 0x2B, 0x3C, 0x4D, 0x5E), WakeOnLan.parseMac("001A2b3C4d5E"))
        assertEquals("001A2B3C4D5E", WakeOnLan.cleanMac("001a2b3c4d5e"))
        assertNull(WakeOnLan.parseMac(null))
        assertNull(WakeOnLan.parseMac(""))
        assertNull(WakeOnLan.parseMac("001A2B3C4D5")) // 11
        assertNull(WakeOnLan.parseMac("001A2B3C4D5E0")) // 13
        assertNull(WakeOnLan.parseMac("001A2B3C4D5G"))
        assertNull(WakeOnLan.parseMac("00:1A:2B:3C:4D:5E"))
    }

    @Test fun ipv4Validation() {
        assertEquals("192.168.1.255", WakeOnLan.cleanBroadcast("192.168.1.255"))
        assertEquals("10.0.0.255", WakeOnLan.cleanBroadcast("010.000.000.255"))
        assertNull(WakeOnLan.cleanBroadcast("256.1.1.1"))
        assertNull(WakeOnLan.cleanBroadcast("1.2.3"))
        assertNull(WakeOnLan.cleanBroadcast("1.2.3.4.5"))
        assertNull(WakeOnLan.cleanBroadcast("a.b.c.d"))
        assertNull(WakeOnLan.cleanBroadcast(null))
        assertNull(WakeOnLan.cleanBroadcast("192.168.1.255/24"))
    }

    @Test fun targetsListTheSubnetBroadcastFirstThenTheLimitedOne() {
        assertEquals(listOf("192.168.1.255", "255.255.255.255"), WakeOnLan.targets("192.168.1.255"))
        assertEquals(listOf("255.255.255.255"), WakeOnLan.targets(null))
        assertEquals(listOf("255.255.255.255"), WakeOnLan.targets("255.255.255.255"))
        assertEquals(listOf("255.255.255.255"), WakeOnLan.targets("garbage"))
    }

    @Test fun wakeMessages() {
        assertEquals("Wake signal sent. Give the PC a minute, then connect", WakeOnLan.resultMessage(Result.success(Unit)))
        assertTrue(WakeOnLan.resultMessage(Result.failure(java.io.IOException("Network is unreachable"))).contains("Network is unreachable"))
        assertEquals("Works on the same Wi-Fi when Wake-on-LAN is enabled on the PC", WakeOnLan.CAVEAT)
    }

    @Test fun pairingLinkCarriesOptionalMacAndBroadcast() {
        val info = PairingParser.parse(link("&m=001a2b3c4d5e&b=192.168.1.255"))
        assertNotNull(info)
        assertEquals("001A2B3C4D5E", info!!.mac)
        assertEquals("192.168.1.255", info.broadcast)
        assertEquals("My PC", info.hostName)
    }

    @Test fun oldLinksStillParseWithoutWakeFields() {
        val info = PairingParser.parse(link())
        assertNotNull(info)
        assertNull(info!!.mac); assertNull(info.broadcast)
        assertEquals(16, info.key.size)
        assertNull(PairingParser.parse("AAAQ-EAYE-AUDA-OCAJ-BIFQ-YDIO-B4")!!.mac)
    }

    @Test fun badWakeFieldsAreIgnoredNotFatal() {
        val info = PairingParser.parse(link("&m=nothex&b=300.1.1.1"))
        assertNotNull(info)
        assertNull(info!!.mac); assertNull(info.broadcast)
        val partial = PairingParser.parse(link("&m=001A2B3C4D5E&b=oops"))
        assertEquals("001A2B3C4D5E", partial!!.mac); assertNull(partial.broadcast)
    }

    // ---------------------------------------------------------------- three-finger swipes

    private val slop = 8f

    @Test fun swipeDirections() {
        assertEquals(Swipe.Up, SwipeGestures.classify(2f, -60f, slop))
        assertEquals(Swipe.Down, SwipeGestures.classify(-3f, 60f, slop))
        assertEquals(Swipe.Left, SwipeGestures.classify(-60f, 5f, slop))
        assertEquals(Swipe.Right, SwipeGestures.classify(60f, -5f, slop))
    }

    @Test fun smallTravelStaysATap() {
        assertEquals(Swipe.None, SwipeGestures.classify(0f, 0f, slop))
        assertEquals(Swipe.None, SwipeGestures.classify(0f, -3 * slop, slop)) // exactly 3x slop is not beyond it
        assertEquals(Swipe.None, SwipeGestures.classify(10f, -10f, slop))
        assertEquals(Swipe.Up, SwipeGestures.classify(0f, -3 * slop - 1f, slop))
    }

    @Test fun diagonalTravelIsNotASwipe() {
        assertEquals(Swipe.None, SwipeGestures.classify(50f, -50f, slop))
        assertEquals(Swipe.None, SwipeGestures.classify(-40f, 60f, slop))
    }

    @Test fun swipesMapToWindowsShortcuts() {
        assertEquals(listOf("Win", "Tab"), Swipe.Up.keys)
        assertEquals(listOf("Win", "D"), Swipe.Down.keys)
        assertEquals(listOf("Ctrl", "Win", "Left"), Swipe.Left.keys)
        assertEquals(listOf("Ctrl", "Win", "Right"), Swipe.Right.keys)
        assertNull(Swipe.None.keys)
    }

    @Test fun swipeGesturesDefaultOff() = assertFalse(ViewerPrefs().swipeGestures)

    @Test fun swipePrefTravelsWithThePerPcInputFields() {
        val a = ViewerPrefs(swipeGestures = true)
        assertTrue(ViewerPrefs().withInputFrom(a).swipeGestures)
        assertTrue(a.withSharedFrom(ViewerPrefs()).swipeGestures) // shared fields do not touch it
    }

    // ---------------------------------------------------------------- failure stage

    @Test fun failureLineNamesTheStage() {
        assertEquals("Got as far as: Request sent to the PC", ConnectStages.failureLine(ConnectStages.REQUEST_SENT))
        assertEquals("Got as far as: Reached the signaling server", ConnectStages.failureLine(ConnectStages.SIGNALING))
        assertEquals("Got as far as: PC answered with an offer", ConnectStages.failureLine(ConnectStages.OFFER))
        assertEquals("Got as far as: Opened the direct connection", ConnectStages.failureLine(ConnectStages.DIRECT))
    }

    @Test fun noStageNoLine() {
        assertNull(ConnectStages.failureLine(""))
        assertNull(ConnectStages.failureLine("   "))
    }

    // ---------------------------------------------------------------- quality mode

    private fun flat(o: org.json.JSONObject) = o.keys().asSequence().associateWith { o.get(it) }

    @Test fun qualityModeOnTheWire() {
        assertEquals(mapOf("t" to "quality", "p" to "auto", "mode" to "auto"), flat(Msg.quality(Quality.Auto, mode = StreamMode.Auto)))
        assertEquals("latency", Msg.quality(Quality.High, 30, false, StreamMode.Fast).getString("mode"))
        assertEquals("clarity", Msg.quality(Quality.High, mode = StreamMode.Sharp).getString("mode"))
        val full = Msg.quality(Quality.Balanced, 60, true, StreamMode.Sharp)
        assertEquals(mapOf("t" to "quality", "p" to "balanced", "fps" to 60, "saver" to true, "mode" to "clarity"), flat(full))
    }

    @Test fun qualityWithoutModeKeepsTheOldShape() {
        assertFalse(Msg.quality(Quality.Low).has("mode"))
        assertFalse(Msg.quality(Quality.Low, 24, false).has("mode"))
    }

    @Test fun streamModeLabelsAndWire() {
        assertEquals(listOf("Auto", "Fast", "Sharp"), StreamMode.entries.map { it.label })
        assertEquals(listOf("auto", "latency", "clarity"), StreamMode.entries.map { it.wire })
        assertEquals(StreamMode.Fast, StreamMode.of("latency"))
        assertEquals(StreamMode.Auto, StreamMode.of("nonsense"))
        assertEquals(StreamMode.Auto, StreamMode.of(null))
    }

    @Test fun everyModeHasACaption() {
        StreamMode.entries.forEach { assertTrue(modeCaption(it).isNotBlank()) }
        assertEquals(3, StreamMode.entries.map { modeCaption(it) }.toSet().size)
    }
}
