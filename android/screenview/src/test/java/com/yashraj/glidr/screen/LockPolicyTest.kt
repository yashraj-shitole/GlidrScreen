package com.yashraj.glidr.screen

import com.yashraj.glidr.screen.lock.Attempts
import com.yashraj.glidr.screen.lock.LockDelay
import com.yashraj.glidr.screen.lock.LockPolicy
import com.yashraj.glidr.screen.lock.LockText
import com.yashraj.glidr.screen.lock.PinCheck
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LockPolicyTest {
    private val sec = 1_000L
    private val min = 60 * sec
    private val t0 = 1_800_000_000_000L

    // ---- the wait after wrong tries

    @Test fun noWaitForTheFirstFourWrongTries() {
        for (n in 0..4) assertEquals(0L, LockPolicy.waitFor(n))
    }

    @Test fun waitGrowsThenStopsAtFifteenMinutes() {
        assertEquals(30 * sec, LockPolicy.waitFor(5))
        assertEquals(1 * min, LockPolicy.waitFor(6))
        assertEquals(5 * min, LockPolicy.waitFor(7))
        assertEquals(15 * min, LockPolicy.waitFor(8))
        assertEquals(15 * min, LockPolicy.waitFor(9))
        assertEquals(15 * min, LockPolicy.waitFor(10_000))
    }

    @Test fun counterAdvancesAndSetsTheDeadlineOnlyFromTheFifth() {
        var a = Attempts()
        for (n in 1..4) {
            a = LockPolicy.afterWrong(a, t0)
            assertEquals(n, a.failures)
            assertEquals(0L, a.blockedUntil)
            assertEquals(0L, LockPolicy.remaining(a, t0))
        }
        a = LockPolicy.afterWrong(a, t0)
        assertEquals(5, a.failures)
        assertEquals(t0 + 30 * sec, a.blockedUntil)
        assertEquals(30 * sec, LockPolicy.remaining(a, t0))
        assertEquals(10 * sec, LockPolicy.remaining(a, t0 + 20 * sec))
        assertEquals(0L, LockPolicy.remaining(a, t0 + 30 * sec))
        assertEquals(0L, LockPolicy.remaining(a, t0 + 5 * min))
    }

    @Test fun aWrongTryAfterTheWaitStartsALongerWait() {
        var a = Attempts()
        repeat(5) { a = LockPolicy.afterWrong(a, t0) }
        val later = t0 + 31 * sec
        a = LockPolicy.afterWrong(a, later)
        assertEquals(6, a.failures)
        assertEquals(1 * min, LockPolicy.remaining(a, later))
        a = LockPolicy.afterWrong(a, later + 2 * min)
        assertEquals(5 * min, LockPolicy.remaining(a, later + 2 * min))
    }

    @Test fun settingTheClockBackCannotStretchTheWait() {
        var a = Attempts()
        repeat(5) { a = LockPolicy.afterWrong(a, t0) }
        // the clock was moved a day back: still at most the 30 s that belong to 5 failures
        assertEquals(30 * sec, LockPolicy.remaining(a, t0 - 24 * 60 * min))
        // a damaged deadline far in the future cannot lock the phone for years either
        assertEquals(30 * sec, LockPolicy.remaining(Attempts(5, Long.MAX_VALUE), t0))
        assertEquals(0L, LockPolicy.remaining(Attempts(2, Long.MAX_VALUE), t0)) // no wait below the free tries
        assertEquals(0L, LockPolicy.remaining(Attempts(7, Long.MIN_VALUE), t0))
    }

    @Test fun triesLeftCountsDownThenStaysAtOne() {
        assertEquals(5, LockPolicy.triesLeft(Attempts(0)))
        assertEquals(2, LockPolicy.triesLeft(Attempts(3)))
        assertEquals(1, LockPolicy.triesLeft(Attempts(4)))
        assertEquals(1, LockPolicy.triesLeft(Attempts(5)))
        assertEquals(1, LockPolicy.triesLeft(Attempts(12)))
    }

    // ---- locking after the background time

    @Test fun immediatelyAlwaysLocks() {
        assertTrue(LockPolicy.shouldLock(LockDelay.Immediately, 1000, 1000))
        assertTrue(LockPolicy.shouldLock(LockDelay.Immediately, 1000, 1001))
    }

    @Test fun oneMinuteLocksOnlyAfterAMinute() {
        val d = LockDelay.OneMinute
        assertFalse(LockPolicy.shouldLock(d, 0, 0))
        assertFalse(LockPolicy.shouldLock(d, 0, 59_999))
        assertTrue(LockPolicy.shouldLock(d, 0, 60_000))
        assertTrue(LockPolicy.shouldLock(d, 0, 10 * min))
    }

    @Test fun fiveMinutesLocksOnlyAfterFive() {
        val d = LockDelay.FiveMinutes
        assertFalse(LockPolicy.shouldLock(d, 100, 100 + 5 * min - 1))
        assertTrue(LockPolicy.shouldLock(d, 100, 100 + 5 * min))
    }

    @Test fun aClockThatWentBackwardsLocksWhateverTheDelay() {
        assertTrue(LockPolicy.shouldLock(LockDelay.FiveMinutes, 10_000, 5_000))
    }

    @Test fun delayIdsRoundTripAndDefaultIsOneMinute() {
        for (d in LockDelay.entries) assertEquals(d, LockDelay.fromId(d.id))
        assertEquals(LockDelay.OneMinute, LockDelay.DEFAULT)
        assertEquals(LockDelay.OneMinute, LockDelay.fromId(null))
        assertEquals(LockDelay.OneMinute, LockDelay.fromId("garbage"))
        assertEquals(listOf("Immediately", "1 minute", "5 minutes"), LockDelay.entries.map { it.label })
    }

    // ---- text

    @Test fun waitIsShownAsMinutesAndSecondsRoundedUp() {
        assertEquals("0:30", LockPolicy.formatWait(30 * sec))
        assertEquals("0:27", LockPolicy.formatWait(26_001))
        assertEquals("0:01", LockPolicy.formatWait(1))
        assertEquals("1:00", LockPolicy.formatWait(60 * sec))
        assertEquals("4:59", LockPolicy.formatWait(5 * min - 1000))
        assertEquals("15:00", LockPolicy.formatWait(15 * min))
        assertEquals("0:00", LockPolicy.formatWait(0))
        assertEquals("0:00", LockPolicy.formatWait(-5))
    }

    @Test fun messagesAreShortAndPlain() {
        assertNull(LockText.check(PinCheck.Success))
        assertEquals("Wrong PIN. 4 tries left before a wait.", LockText.check(PinCheck.Wrong(4)))
        assertEquals("Wrong PIN. 1 try left before a wait.", LockText.check(PinCheck.Wrong(1)))
        assertEquals("Too many wrong tries. Try again in 0:30.", LockText.check(PinCheck.Blocked(30 * sec)))
        assertTrue(LockText.FORGOTTEN.contains("no recovery"))
        assertTrue(LockText.FORGOTTEN.contains("all pairings"))
    }
}
