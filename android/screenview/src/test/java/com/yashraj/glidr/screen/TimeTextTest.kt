package com.yashraj.glidr.screen

import com.yashraj.glidr.screen.ui.TimeText
import org.junit.Assert.assertEquals
import org.junit.Test

class TimeTextTest {
    private val now = 1_000_000_000_000L

    @Test fun agoBuckets() {
        assertEquals("just now", TimeText.ago(now, now - 5_000))
        assertEquals("1 min ago", TimeText.ago(now, now - 60_000))
        assertEquals("59 min ago", TimeText.ago(now, now - 59 * 60_000L))
        assertEquals("3 h ago", TimeText.ago(now, now - 3 * 3_600_000L - 5))
        assertEquals("2 d ago", TimeText.ago(now, now - 2 * 86_400_000L))
    }

    @Test fun futureTimestampIsJustNow() {
        assertEquals("just now", TimeText.ago(now, now + 60_000))
    }

    @Test fun splitReasonHeadlineAndDetail() {
        val (head, detail) = TimeText.splitReason("The PC did not answer. Check that Glidr Screen is running on it.")
        assertEquals("The PC did not answer.", head)
        assertEquals("Check that Glidr Screen is running on it.", detail)
        assertEquals("Another phone is using this PC right now" to "", TimeText.splitReason("Another phone is using this PC right now"))
        assertEquals("Timed out" to "", TimeText.splitReason("Timed out"))
    }

    @Test fun lastConnectedSubtitle() {
        assertEquals("Not connected yet", TimeText.lastConnected(now, 0))
        assertEquals("Last connected 5 min ago", TimeText.lastConnected(now, now - 5 * 60_000L))
    }
}
