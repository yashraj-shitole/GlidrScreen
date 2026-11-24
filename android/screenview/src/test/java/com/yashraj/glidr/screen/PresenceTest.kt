package com.yashraj.glidr.screen

import com.yashraj.glidr.screen.signal.PcPresence
import com.yashraj.glidr.screen.signal.PresenceChecker
import com.yashraj.glidr.screen.signal.PresenceState
import com.yashraj.glidr.screen.signal.PresenceText
import com.yashraj.glidr.screen.signal.RecentMessage
import com.yashraj.glidr.screen.signal.SignalCrypto
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PresenceTest {
    private val now = 1_800_000_000_000L
    private val min = 60_000L
    private val hour = 60 * min

    private fun p(state: PresenceState, ageMs: Long) = PcPresence(state, ageMs)
    private fun text(state: PresenceState, ageMs: Long) = PresenceText.describe(p(state, ageMs), now)

    // ---- PresenceText

    @Test fun onlineAndFreshSaysOnline() {
        assertEquals("PC online", text(PresenceState.Online, 0))
        assertEquals("PC online", text(PresenceState.Online, 5 * min))
        assertEquals("PC online", text(PresenceState.Online, 7 * min - 1))
    }

    @Test fun onlineBecomesLastSeenAtSevenMinutes() {
        assertEquals("Last seen 7 min ago", text(PresenceState.Online, 7 * min))
        assertEquals("Last seen 12 min ago", text(PresenceState.Online, 12 * min))
        assertEquals("Last seen 59 min ago", text(PresenceState.Online, 59 * min))
        assertEquals("Last seen 1 h ago", text(PresenceState.Online, hour))
        assertEquals("Last seen 2 h ago", text(PresenceState.Online, 2 * hour))
    }

    @Test fun staleOnlineKeepsCountingPastTwoHours() {
        assertEquals("Last seen 2 h ago", text(PresenceState.Online, 2 * hour + 1))
        assertEquals("Last seen 3 h ago", text(PresenceState.Online, 3 * hour + 5 * min))
        assertEquals("Last seen 1 d ago", text(PresenceState.Online, 25 * hour))
    }

    @Test fun sleepSaysWhen() {
        assertEquals("PC went to sleep just now", text(PresenceState.Sleep, 20_000))
        assertEquals("PC went to sleep 12 min ago", text(PresenceState.Sleep, 12 * min))
        assertEquals("PC went to sleep 3 h ago", text(PresenceState.Sleep, 3 * hour))
    }

    @Test fun pausedHasNoAge() {
        assertEquals("Sharing paused on the PC", text(PresenceState.Paused, 0))
        assertEquals("Sharing paused on the PC", text(PresenceState.Paused, 5 * hour))
    }

    @Test fun quitSaysWhen() {
        assertEquals("Glidr Screen was closed just now", text(PresenceState.Quit, 1_000))
        assertEquals("Glidr Screen was closed 3 h ago", text(PresenceState.Quit, 3 * hour))
    }

    @Test fun nothingFound() {
        assertEquals("No sign of the PC in the last 12 hours", PresenceText.describe(null, now))
    }

    @Test fun ageKeepsGrowingWhileTheListStaysOpen() {
        val checked = PcPresence(PresenceState.Online, ageMs = 3 * min, checkedAt = now)
        assertEquals("PC online", PresenceText.describe(checked, now + 3 * min)) // 6 min
        assertEquals("Last seen 8 min ago", PresenceText.describe(checked, now + 5 * min))
        // a clock that moved backwards never makes the marker younger
        assertEquals("PC online", PresenceText.describe(checked, now - 10 * min))
    }

    // ---- PresenceChecker.newest

    private fun msg(t: String = "presence", from: String = "h", state: String = "online", ts: Long? = now, server: Long = now) =
        RecentMessage(JSONObject().put("t", t).put("from", from).put("state", state).also { if (ts != null) it.put("ts", ts) }, server)

    @Test fun noMessagesIsNull() {
        assertNull(PresenceChecker.newest(emptyList(), now))
    }

    @Test fun newestMarkerWins() {
        val got = PresenceChecker.newest(
            listOf(msg(state = "online", ts = now - 30 * min), msg(state = "sleep", ts = now - 10 * min), msg(state = "online", ts = now - 20 * min)),
            now,
        )
        assertEquals(PresenceState.Sleep, got?.state)
        assertEquals(10 * min, got?.ageMs)
        assertEquals(now, got?.checkedAt)
    }

    @Test fun onlyPresenceFromTheHostCounts() {
        val got = PresenceChecker.newest(
            listOf(
                msg(state = "quit", ts = now - 60 * min),
                msg(t = "req", ts = now - 1 * min), // an ordinary rendezvous message
                msg(from = "p", state = "online", ts = now - 2 * min), // a phone cannot speak for the PC
                msg(state = "exploded", ts = now - 3 * min), // unknown state
            ),
            now,
        )
        assertEquals(PresenceState.Quit, got?.state)
        assertEquals(60 * min, got?.ageMs)
    }

    @Test fun nothingUsableIsNull() {
        assertNull(PresenceChecker.newest(listOf(msg(t = "offer"), msg(from = "p"), msg(state = "?")), now))
    }

    @Test fun missingOrFutureTimestampFallsBackToServerTime() {
        val noTs = PresenceChecker.newest(listOf(msg(ts = null, server = now - 4 * min)), now)
        assertEquals(4 * min, noTs?.ageMs)
        val future = PresenceChecker.newest(listOf(msg(ts = now + 2 * hour, server = now - 9 * min)), now)
        assertEquals(9 * min, future?.ageMs)
        // a little clock difference is trusted
        val slack = PresenceChecker.newest(listOf(msg(ts = now + 30_000, server = now - 9 * min)), now)
        assertEquals(0L, slack?.ageMs)
        assertNull(PresenceChecker.newest(listOf(msg(ts = null, server = 0)), now)) // no time at all
    }

    @Test fun authenticSealedMarkersRoundTrip() {
        // what the host sends, sealed and opened the way NtfySignaling.recentMessages does
        val key = ByteArray(16) { it.toByte() }
        val slot = SignalCrypto.deriveSlot(key)
        val frame = SignalCrypto.seal(slot.encKey, """{"t":"presence","from":"h","ts":${now - 8 * min},"state":"online"}""")
        assertTrue(frame.length < 200)
        val opened = JSONObject(SignalCrypto.open(slot.encKey, frame)!!)
        val got = PresenceChecker.newest(listOf(RecentMessage(opened, now)), now)
        assertNotNull(got)
        assertEquals("Last seen 8 min ago", PresenceText.describe(got, now))
        // another PC's key cannot read it
        assertNull(SignalCrypto.open(SignalCrypto.deriveSlot(ByteArray(16) { 9 }).encKey, frame))
    }

    @Test fun wireNamesMatchTheProtocol() {
        assertEquals(PresenceState.Online, PresenceState.fromWire("online"))
        assertEquals(PresenceState.Sleep, PresenceState.fromWire("sleep"))
        assertEquals(PresenceState.Paused, PresenceState.fromWire("paused"))
        assertEquals(PresenceState.Quit, PresenceState.fromWire("quit"))
        assertNull(PresenceState.fromWire("Online"))
    }
}
