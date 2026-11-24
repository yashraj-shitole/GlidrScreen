package com.yashraj.glidr.screen

import com.yashraj.glidr.screen.lock.AppLockSession
import com.yashraj.glidr.screen.lock.Attempts
import com.yashraj.glidr.screen.lock.LockDelay
import com.yashraj.glidr.screen.lock.LockResult
import com.yashraj.glidr.screen.lock.LockStorage
import com.yashraj.glidr.screen.lock.PinCheck
import com.yashraj.glidr.screen.lock.PinLock
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** In-memory [LockStorage] standing in for the SharedPreferences file; reused across "restarts". */
private class FakeStorage : LockStorage {
    var pin: PinLock.Stored? = null
    var delay = LockDelay.DEFAULT
    var attempts = Attempts()
    override fun loadPin() = pin
    override fun savePin(stored: PinLock.Stored?) { pin = stored }
    override fun loadDelay() = delay
    override fun saveDelay(delay: LockDelay) { this.delay = delay }
    override fun loadAttempts() = attempts
    override fun saveAttempts(attempts: Attempts) { this.attempts = attempts }
}

class AppLockSessionTest {
    private val sec = 1_000L
    private val min = 60 * sec
    private var wall = 1_800_000_000_000L
    private var mono = 5_000_000L
    private val storage = FakeStorage()

    private fun session() = AppLockSession(storage, { wall }, { mono })

    /** A session with the lock on, PIN 483920, unlocked (the person just turned it on). */
    private fun lockedApp(delay: LockDelay = LockDelay.DEFAULT): AppLockSession {
        val s = session()
        assertEquals(LockResult.Done, s.enable("483920"))
        s.setDelay(delay)
        return s
    }

    /** A new process: starts locked when the lock is on. */
    private fun restart() = session()

    // ---- start

    @Test fun lockOffMeansNeverLocked() {
        val s = session()
        assertFalse(s.locked.value)
        assertFalse(s.settings.value.enabled)
        s.onStop(); mono += 10 * min; s.onStart()
        assertFalse(s.locked.value)
    }

    @Test fun anAppStartWithTheLockOnIsLocked() {
        lockedApp()
        assertTrue(restart().locked.value)
    }

    @Test fun enablingDoesNotLockTheAppTheUserIsInside() {
        val s = lockedApp()
        assertFalse(s.locked.value)
        assertTrue(s.settings.value.enabled)
    }

    // ---- unlock

    @Test fun rightPinUnlocksWrongDoesNot() {
        lockedApp()
        val s = restart()
        assertEquals(PinCheck.Wrong(4), s.tryUnlock("111222"))
        assertTrue(s.locked.value)
        assertEquals(PinCheck.Success, s.tryUnlock("483920"))
        assertFalse(s.locked.value)
    }

    @Test fun unlockedStateIsNotPersisted() {
        lockedApp()
        val s = restart()
        s.tryUnlock("483920")
        assertTrue(restart().locked.value) // nothing stored says "unlocked"
    }

    @Test fun aWrongTryThenTheRightOneResetsTheCounter() {
        lockedApp()
        val s = restart()
        s.tryUnlock("000001"); s.tryUnlock("000002")
        assertEquals(2, storage.attempts.failures)
        assertEquals(PinCheck.Success, s.tryUnlock("483920"))
        assertEquals(Attempts(), storage.attempts)
    }

    // ---- brute force protection

    @Test fun fifthWrongTryStartsAThirtySecondWait() {
        lockedApp()
        val s = restart()
        for (n in 1..4) assertTrue(s.tryUnlock("00000$n") is PinCheck.Wrong)
        assertEquals(PinCheck.Blocked(30 * sec), s.tryUnlock("000005"))
        assertEquals(30 * sec, s.waitRemainingMs())
    }

    @Test fun duringTheWaitEvenTheRightPinIsRefused() {
        lockedApp()
        val s = restart()
        repeat(5) { s.tryUnlock("00000$it") }
        wall += 10 * sec
        assertEquals(PinCheck.Blocked(20 * sec), s.tryUnlock("483920"))
        assertTrue(s.locked.value)
        assertEquals(5, storage.attempts.failures) // a refused try is not counted
    }

    @Test fun afterTheWaitTheRightPinWorks() {
        lockedApp()
        val s = restart()
        repeat(5) { s.tryUnlock("00000$it") }
        wall += 30 * sec
        assertEquals(0L, s.waitRemainingMs())
        assertEquals(PinCheck.Success, s.tryUnlock("483920"))
    }

    @Test fun waitsGrowWithEachFurtherWrongTry() {
        lockedApp()
        val s = restart()
        repeat(5) { s.tryUnlock("00000$it") }
        wall += 30 * sec
        assertEquals(PinCheck.Blocked(1 * min), s.tryUnlock("000009"))
        wall += 1 * min
        assertEquals(PinCheck.Blocked(5 * min), s.tryUnlock("000009"))
        wall += 5 * min
        assertEquals(PinCheck.Blocked(15 * min), s.tryUnlock("000009"))
        wall += 15 * min
        assertEquals(PinCheck.Blocked(15 * min), s.tryUnlock("000009"))
    }

    @Test fun killingTheAppDoesNotResetTheCounterOrTheWait() {
        lockedApp()
        var s = restart()
        repeat(3) { s.tryUnlock("00000$it") }
        s = restart() // killed and reopened
        assertEquals(PinCheck.Wrong(1), s.tryUnlock("000008")) // 4th wrong overall
        s = restart()
        assertTrue(s.tryUnlock("000009") is PinCheck.Blocked) // 5th wrong overall
        s = restart()
        assertEquals(30 * sec, s.waitRemainingMs())
        wall += 10 * sec
        s = restart()
        assertEquals(PinCheck.Blocked(20 * sec), s.tryUnlock("483920")) // still waiting after yet another restart
    }

    // ---- background and foreground

    @Test fun immediatelyLocksOnReturn() {
        val s = lockedApp(LockDelay.Immediately)
        s.onStop(); s.onStart()
        assertTrue(s.locked.value)
    }

    @Test fun oneMinuteDelayKeepsShortTripsUnlocked() {
        val s = lockedApp(LockDelay.OneMinute)
        s.onStop(); mono += 59 * sec; s.onStart()
        assertFalse(s.locked.value)
        s.onStop(); mono += 60 * sec; s.onStart()
        assertTrue(s.locked.value)
    }

    @Test fun fiveMinuteDelay() {
        val s = lockedApp(LockDelay.FiveMinutes)
        s.onStop(); mono += 4 * min; s.onStart()
        assertFalse(s.locked.value)
        s.onStop(); mono += 5 * min; s.onStart()
        assertTrue(s.locked.value)
    }

    @Test fun staysInTheForegroundNeverLocks() {
        val s = lockedApp(LockDelay.Immediately)
        s.onStart() // the first ON_START the observer replays on registration
        mono += 3_600_000
        assertFalse(s.locked.value)
    }

    @Test fun aLockedAppStaysLockedWhateverHappens() {
        lockedApp()
        val s = restart()
        s.onStart(); s.onStop(); s.onStart()
        assertTrue(s.locked.value)
    }

    @Test fun theChosenDelayIsRemembered() {
        val s = lockedApp(LockDelay.FiveMinutes)
        assertEquals(LockDelay.FiveMinutes, s.settings.value.delay)
        assertEquals(LockDelay.FiveMinutes, restart().settings.value.delay)
    }

    // ---- the QR scanner is not "leaving the app"

    @Test fun comingBackFromTheScannerDoesNotLockEvenWithImmediately() {
        val s = lockedApp(LockDelay.Immediately)
        s.beginExternalUi()
        mono += 500; s.onStop()
        mono += 20 * sec; s.onStart()
        assertFalse(s.locked.value)
    }

    @Test fun anAbandonedScannerDoesNotExemptALaterBackgroundTrip() {
        val s = lockedApp(LockDelay.Immediately)
        s.beginExternalUi() // the scanner never opened
        mono += 60 * sec
        s.onStop(); mono += 5 * sec; s.onStart()
        assertTrue(s.locked.value)
    }

    @Test fun theScannerGraceEndsAfterAFewMinutes() {
        val s = lockedApp(LockDelay.Immediately)
        s.beginExternalUi()
        s.onStop(); mono += AppLockSession.EXTERNAL_GRACE_MS + 1; s.onStart()
        assertTrue(s.locked.value)
    }

    @Test fun theScannerGraceIsUsedOnce() {
        val s = lockedApp(LockDelay.Immediately)
        s.beginExternalUi()
        s.onStop(); mono += sec; s.onStart()
        assertFalse(s.locked.value)
        s.onStop(); mono += sec; s.onStart()
        assertTrue(s.locked.value)
    }

    // ---- turning on, changing, turning off

    @Test fun enablingRejectsWeakPinsAndStoresNothing() {
        val s = session()
        assertEquals(LockResult.BadNew(PinLock.Error.Weak), s.enable("1234"))
        assertEquals(LockResult.BadNew(PinLock.Error.TooShort), s.enable("12"))
        assertNull(storage.pin)
        assertFalse(s.settings.value.enabled)
    }

    @Test fun storedPinIsAHashNotThePin() {
        lockedApp()
        val p = storage.pin
        assertNotNull(p)
        assertFalse(p!!.hash.contains("483920"))
        assertTrue(PinLock.verify("483920", p))
    }

    @Test fun changingNeedsTheCurrentPin() {
        val s = lockedApp()
        assertEquals(LockResult.Rejected(PinCheck.Wrong(4)), s.change("999000", "7391"))
        assertTrue(PinLock.verify("483920", storage.pin!!)) // unchanged
        assertEquals(LockResult.Done, s.change("483920", "739150"))
        assertTrue(PinLock.verify("739150", storage.pin!!))
        assertFalse(PinLock.verify("483920", storage.pin!!))
        assertTrue(restart().tryUnlock("483920") is PinCheck.Wrong)
        assertEquals(PinCheck.Success, restart().tryUnlock("739150"))
    }

    @Test fun changingRejectsAWeakNewPin() {
        val s = lockedApp()
        assertEquals(LockResult.BadNew(PinLock.Error.Weak), s.change("483920", "2222"))
        assertTrue(PinLock.verify("483920", storage.pin!!))
    }

    @Test fun verifyCurrentChecksWithoutChangingAnything() {
        val s = lockedApp()
        assertEquals(PinCheck.Success, s.verifyCurrent("483920"))
        assertTrue(s.verifyCurrent("000001") is PinCheck.Wrong)
        assertTrue(PinLock.verify("483920", storage.pin!!))
    }

    @Test fun wrongTriesInTheSettingsCountTowardsTheSameWait() {
        val s = lockedApp()
        repeat(4) { s.verifyCurrent("00000$it") }
        assertEquals(LockResult.Rejected(PinCheck.Blocked(30 * sec)), s.disable("000009"))
        assertEquals(LockResult.Rejected(PinCheck.Blocked(30 * sec)), s.disable("483920")) // right PIN, still waiting
        assertTrue(s.settings.value.enabled)
    }

    @Test fun turningOffNeedsTheCurrentPinThenClearsEverything() {
        val s = lockedApp()
        assertEquals(LockResult.Rejected(PinCheck.Wrong(4)), s.disable("999000"))
        assertTrue(s.settings.value.enabled)
        assertEquals(LockResult.Done, s.disable("483920"))
        assertFalse(s.settings.value.enabled)
        assertNull(storage.pin)
        assertEquals(Attempts(), storage.attempts)
        assertFalse(restart().locked.value) // lock off: a new start is not locked
    }

    @Test fun turningOffWhileLockedOutOfTimeIsNotPossibleToBypass() {
        lockedApp()
        val s = restart()
        assertTrue(s.locked.value)
        assertEquals(LockResult.Rejected(PinCheck.Wrong(4)), s.disable("999000"))
        assertTrue(s.locked.value)
    }

    // ---- corrupted storage fails closed

    @Test fun aDamagedStoredPinLocksAndNeverUnlocks() {
        storage.pin = PinLock.Stored("garbage", "garbage", 120_000)
        val s = session()
        assertTrue(s.locked.value)
        assertTrue(s.settings.value.enabled)
        for (guess in listOf("483920", "0000", "1234", "", "99999999")) assertFalse(s.tryUnlock(guess) == PinCheck.Success)
        assertTrue(s.locked.value)
    }

    @Test fun aDamagedAttemptCounterCannotLockForeverNorUnlock() {
        lockedApp()
        storage.attempts = Attempts(7, Long.MAX_VALUE)
        val s = restart()
        assertTrue(s.waitRemainingMs() <= 5 * min)
        assertTrue(s.locked.value)
    }
}
