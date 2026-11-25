package com.yashraj.glidr.screen

import com.yashraj.glidr.screen.net.ConnectStages
import com.yashraj.glidr.screen.net.RoutePlanner
import com.yashraj.glidr.screen.net.SignalRoute
import com.yashraj.glidr.screen.signal.LanAddress
import com.yashraj.glidr.screen.signal.PairingParser
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** LAN signaling: the `l=` pairing parameter and the LAN-first / public-fallback timing. */
class LanSignalingTest {
    private val keyText = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(16) { it.toByte() })
    private fun link(extra: String = "") = "glidr://screen?v=1&k=$keyText&n=My+PC&s=https%3A%2F%2Fntfy.sh$extra"

    // ---------------------------------------------------------------- LanAddress

    @Test fun acceptsPrivateIpv4WithPort() {
        assertEquals("192.168.1.20:50123", LanAddress.clean("192.168.1.20:50123"))
        assertEquals("10.0.0.5:49152", LanAddress.clean("10.0.0.5:49152"))
        assertEquals("172.16.0.1:65535", LanAddress.clean("172.16.0.1:65535"))
        assertEquals("172.31.255.254:1", LanAddress.clean("172.31.255.254:1"))
        assertEquals("169.254.10.20:50000", LanAddress.clean("169.254.10.20:50000"))
    }

    @Test fun refusesAnythingThatIsNotStrictlyThatShape() {
        for (bad in listOf(
            null, "", " ", "192.168.1.20", "192.168.1.20:", ":50123", "192.168.1.20:0", "192.168.1.20:65536", "192.168.1.20:123456",
            "192.168.1.20:-1", "192.168.1.20:5e3", "192.168.1.20:050123", "192.168.01.20:5000", "192.168.1:5000", "192.168.1.20.1:5000",
            "256.1.1.1:5000", "192.168.1.300:5000", "pc.local:5000", "http://192.168.1.20:5000", "192.168.1.20:5000/x",
            "192.168.1.20:5000 ", " 192.168.1.20:5000", "[fe80::1]:5000", "fe80::1", "192.168.1.20:5000,10.0.0.1:5000", "192.168.1.20:5000\n",
            "192.168.1.20,5000", "192,168,1,20:5000",
        )) assertNull("should be refused: $bad", LanAddress.clean(bad))
    }

    @Test fun refusesAddressesThatAreNotOnALocalNetwork() {
        for (bad in listOf(
            "8.8.8.8:5000", "1.1.1.1:443", "127.0.0.1:5000", "0.0.0.0:5000", "172.15.0.1:5000", "172.32.0.1:5000",
            "192.169.1.1:5000", "100.64.0.1:5000", "11.0.0.1:5000", "255.255.255.255:5000", "169.253.0.1:5000", "224.0.0.1:5000",
        )) assertNull("should be refused: $bad", LanAddress.clean(bad))
    }

    @Test fun baseUrlIsPlainHttpOnThatAddress() {
        assertEquals("http://192.168.1.20:50123", LanAddress.baseUrl("192.168.1.20:50123"))
    }

    // ---------------------------------------------------------------- pairing link

    @Test fun pairingLinkCarriesTheLanAddress() {
        val info = PairingParser.parse(link("&l=192.168.1.20%3A50123"))
        assertNotNull(info)
        assertEquals("192.168.1.20:50123", info!!.lan)
        assertEquals("My PC", info.hostName)
        assertEquals(16, info.key.size)
        assertEquals("192.168.1.20:50123", PairingParser.parse(link("&l=192.168.1.20:50123"))!!.lan) // unescaped colon too
    }

    @Test fun lanComesAfterTheWakeFieldsWithoutDisturbingThem() {
        val info = PairingParser.parse(link("&m=001a2b3c4d5e&b=192.168.1.255&l=192.168.1.20%3A50123"))!!
        assertEquals("001A2B3C4D5E", info.mac)
        assertEquals("192.168.1.255", info.broadcast)
        assertEquals("192.168.1.20:50123", info.lan)
    }

    @Test fun linksWithoutItStillWorkAsBefore() {
        val info = PairingParser.parse(link())
        assertNotNull(info)
        assertNull(info!!.lan)
        assertEquals("https://ntfy.sh", info.signalBase)
        assertNull(PairingParser.parse("AAAQ-EAYE-AUDA-OCAJ-BIFQ-YDIO-B4")!!.lan) // a typed code has none
    }

    @Test fun aBadAddressIsIgnoredAndTheLinkStillPairs() {
        for (bad in listOf("8.8.8.8%3A5000", "pc.local%3A5000", "192.168.1.20", "192.168.1.20%3A99999", "%00", "")) {
            val info = PairingParser.parse(link("&l=$bad"))
            assertNotNull("link must still parse with l=$bad", info)
            assertNull("l=$bad", info!!.lan)
            assertEquals(16, info.key.size)
        }
        assertNull(PairingParser.parse(link("&l"))!!.lan)
    }

    // ---------------------------------------------------------------- RoutePlanner (LAN first, public after 4 s or a LAN failure)

    private class Clock(var now: Long = 1_000_000L) { fun read() = now }

    @Test fun withoutALanAddressThePublicServerIsUsedFromTheStart() {
        val clock = Clock()
        val p = RoutePlanner(false, clock::read)
        p.begin()
        assertTrue(p.publicDue())
        assertEquals(0L, p.publicDelayMs())
        assertFalse(p.lanViable)
    }

    @Test fun withALanAddressTheLanGetsFourSecondsOnItsOwn() {
        val clock = Clock()
        val p = RoutePlanner(true, clock::read)
        p.begin()
        assertTrue(p.lanViable)
        assertFalse(p.publicDue())
        assertEquals(4_000L, p.publicDelayMs())
        clock.now += 1_500
        assertFalse(p.publicDue())
        assertEquals(2_500L, p.publicDelayMs())
        clock.now += 2_499
        assertFalse(p.publicDue())
        assertEquals(1L, p.publicDelayMs())
        clock.now += 1
        assertTrue(p.publicDue())
        assertEquals(0L, p.publicDelayMs())
        clock.now += 60_000
        assertEquals(0L, p.publicDelayMs()) // never negative
        assertTrue(p.lanViable) // the LAN keeps listening alongside the public server
    }

    @Test fun aLanFailureBringsThePublicServerInImmediately() {
        val clock = Clock()
        val p = RoutePlanner(true, clock::read)
        p.begin()
        clock.now += 300
        assertFalse(p.publicDue())
        p.onLanFailed()
        assertTrue(p.publicDue())
        assertEquals(0L, p.publicDelayMs())
        assertFalse(p.lanViable)
    }

    @Test fun theFirstRouteToDeliverTheOfferWinsAndStaysTheWinner() {
        val clock = Clock()
        val lanWins = RoutePlanner(true, clock::read)
        lanWins.begin()
        assertNull(lanWins.winner)
        assertEquals(SignalRoute.LAN, lanWins.onOffer(SignalRoute.LAN))
        assertEquals(SignalRoute.LAN, lanWins.onOffer(SignalRoute.PUBLIC)) // the duplicate from ntfy changes nothing
        assertEquals(SignalRoute.LAN, lanWins.winner)

        val publicWins = RoutePlanner(true, clock::read)
        publicWins.begin()
        clock.now += 5_000
        assertTrue(publicWins.publicDue())
        assertEquals(SignalRoute.PUBLIC, publicWins.onOffer(SignalRoute.PUBLIC))
        assertEquals(SignalRoute.PUBLIC, publicWins.onOffer(SignalRoute.LAN))
    }

    @Test fun beginStartsAFreshAttempt() {
        val clock = Clock()
        val p = RoutePlanner(true, clock::read)
        p.begin()
        p.onLanFailed()
        p.onOffer(SignalRoute.PUBLIC)
        clock.now += 10_000
        p.begin()
        assertTrue(p.lanViable)
        assertNull(p.winner)
        assertEquals(4_000L, p.publicDelayMs())
    }

    @Test fun graceCanBeChosen() {
        val clock = Clock()
        val p = RoutePlanner(true, clock::read, graceMs = 1_000)
        p.begin()
        assertEquals(1_000L, p.publicDelayMs())
        clock.now += 1_000
        assertTrue(p.publicDue())
        assertEquals(4_000L, RoutePlanner.LAN_GRACE_MS)
    }

    // ---------------------------------------------------------------- failure stage line

    @Test fun lanStageHasItsOwnWordsAndNeverMovesTheStageBackwards() {
        assertEquals("Reached the PC on the local network", ConnectStages.LAN)
        assertEquals("Got as far as: Reached the PC on the local network", ConnectStages.failureLine(ConnectStages.LAN))
        assertEquals(ConnectStages.LAN, ConnectStages.furthest("", ConnectStages.LAN))
        assertEquals(ConnectStages.LAN, ConnectStages.furthest(ConnectStages.LAN, ConnectStages.SIGNALING)) // the first of two equal stages stays
        assertEquals(ConnectStages.SIGNALING, ConnectStages.furthest(ConnectStages.SIGNALING, ConnectStages.LAN))
        assertEquals(ConnectStages.REQUEST_SENT, ConnectStages.furthest(ConnectStages.LAN, ConnectStages.REQUEST_SENT))
        assertEquals(ConnectStages.REQUEST_SENT, ConnectStages.furthest(ConnectStages.REQUEST_SENT, ConnectStages.SIGNALING)) // public opened after the LAN request went out
        assertEquals(ConnectStages.DIRECT, ConnectStages.furthest(ConnectStages.OFFER, ConnectStages.DIRECT))
        assertEquals(ConnectStages.OFFER, ConnectStages.furthest(ConnectStages.OFFER, ConnectStages.REQUEST_SENT))
    }
}
