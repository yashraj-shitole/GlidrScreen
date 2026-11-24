package com.yashraj.glidr.screen.lock

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** What the lock keeps on disk. Writes must be durable at once: a killed app must not forget a wrong try. */
interface LockStorage {
    /** The stored PIN hash, or null when the lock is off. A damaged value still counts as "on" (and never verifies). */
    fun loadPin(): PinLock.Stored?
    fun savePin(stored: PinLock.Stored?)
    fun loadDelay(): LockDelay
    fun saveDelay(delay: LockDelay)
    fun loadAttempts(): Attempts
    fun saveAttempts(attempts: Attempts)
}

/**
 * [LockStorage] in its own SharedPreferences file, in app-private storage. The app's backup rules
 * (`allowBackup=false`, and `data_extraction_rules.xml` excluding every shared preference) keep it off cloud backup and
 * device transfer, like the pairing secrets.
 */
class AppLockStore(context: Context) : LockStorage {
    private val p = context.applicationContext.getSharedPreferences("glidr_screen_lock", Context.MODE_PRIVATE)

    override fun loadPin(): PinLock.Stored? {
        if (!p.contains(SALT) && !p.contains(HASH)) return null
        return try {
            PinLock.Stored(p.getString(SALT, "") ?: "", p.getString(HASH, "") ?: "", p.getInt(ITER, 0))
        } catch (_: Exception) {
            PinLock.Stored("", "", 0) // on, but can never be unlocked: fail closed
        }
    }

    override fun savePin(stored: PinLock.Stored?) {
        val e = p.edit()
        if (stored == null) e.remove(SALT).remove(HASH).remove(ITER)
        else e.putString(SALT, stored.salt).putString(HASH, stored.hash).putInt(ITER, stored.iterations)
        e.commit()
    }

    override fun loadDelay(): LockDelay = try {
        LockDelay.fromId(p.getString(DELAY, null))
    } catch (_: Exception) {
        LockDelay.DEFAULT
    }

    override fun saveDelay(delay: LockDelay) { p.edit().putString(DELAY, delay.id).commit() }

    override fun loadAttempts(): Attempts = try {
        Attempts(p.getInt(FAILS, 0).coerceAtLeast(0), p.getLong(UNTIL, 0L))
    } catch (_: Exception) {
        Attempts()
    }

    override fun saveAttempts(attempts: Attempts) {
        p.edit().putInt(FAILS, attempts.failures).putLong(UNTIL, attempts.blockedUntil).commit()
    }

    private companion object {
        const val SALT = "salt"
        const val HASH = "hash"
        const val ITER = "iter"
        const val DELAY = "delay"
        const val FAILS = "fails"
        const val UNTIL = "until"
    }
}

/** Outcome of checking a PIN against the stored one. */
sealed interface PinCheck {
    data object Success : PinCheck
    /** Wrong; [triesLeft] more before a wait starts. */
    data class Wrong(val triesLeft: Int) : PinCheck
    /** Not even checked: the wait after too many wrong tries is still running. */
    data class Blocked(val remainingMs: Long) : PinCheck
}

/** Outcome of turning the lock on, changing the PIN or turning it off. */
sealed interface LockResult {
    data object Done : LockResult
    /** The new PIN is not acceptable (see [LockText.error]). */
    data class BadNew(val error: PinLock.Error) : LockResult
    /** The current PIN was not accepted ([check] is [PinCheck.Wrong] or [PinCheck.Blocked]); nothing changed. */
    data class Rejected(val check: PinCheck) : LockResult
}

data class LockSettings(val enabled: Boolean, val delay: LockDelay)

/**
 * The app lock for one run of the app. Whether the app is unlocked lives only here, in memory: a new process always
 * starts locked (when the lock is on). The counter of wrong tries is persisted through [storage].
 *
 * Every method that checks a PIN runs PBKDF2 (about 0.1 s): call them off the main thread. They are serialised, so
 * guesses cannot run in parallel.
 *
 * @param wallClock epoch millis, for the persisted wait after wrong tries.
 * @param monotonic a clock that keeps counting in deep sleep and never goes back (SystemClock.elapsedRealtime), for the
 *   time spent in the background.
 */
class AppLockSession(
    private val storage: LockStorage,
    private val wallClock: () -> Long,
    private val monotonic: () -> Long,
) {
    private var pin: PinLock.Stored? = storage.loadPin()
    private var delay: LockDelay = storage.loadDelay()
    @Volatile private var attempts: Attempts = storage.loadAttempts()
    private var stoppedAt: Long? = null
    private var externalSince: Long? = null
    private var externalStop = false

    private val _locked = MutableStateFlow(pin != null)
    /** True while the lock screen must cover everything. */
    val locked: StateFlow<Boolean> = _locked.asStateFlow()
    private val _settings = MutableStateFlow(LockSettings(pin != null, delay))
    val settings: StateFlow<LockSettings> = _settings.asStateFlow()

    /** Millis until the next PIN try is allowed (0 = now). Cheap and lock-free: safe to poll from the UI. */
    fun waitRemainingMs(): Long = LockPolicy.remaining(attempts, wallClock())

    /** The app left the foreground (Activity stopped). */
    @Synchronized fun onStop() {
        if (pin == null) return
        val now = monotonic()
        val since = externalSince
        externalStop = since != null && now - since in 0..EXTERNAL_START_WINDOW_MS
        externalSince = null
        stoppedAt = now
    }

    /** The app is back in the foreground (also called once when it first appears: then there is nothing to do). */
    @Synchronized fun onStart() {
        val stopped = stoppedAt ?: return
        stoppedAt = null
        val byUs = externalStop
        externalStop = false
        if (pin == null) return
        val now = monotonic()
        // a screen this app opened itself (the QR scanner) is not "leaving the app": give it a few minutes of grace
        if (byUs && now - stopped in 0..EXTERNAL_GRACE_MS) return
        if (LockPolicy.shouldLock(delay, stopped, now)) _locked.value = true
    }

    /**
     * Call right before this app opens another screen of its own that is not ours to lock (the QR scanner), so coming
     * back from it with [LockDelay.Immediately] does not lock and drop the scan.
     */
    @Synchronized fun beginExternalUi() {
        if (pin != null) externalSince = monotonic()
    }

    /** Checks [candidate] for the lock screen; Success unlocks. */
    @Synchronized fun tryUnlock(candidate: String): PinCheck {
        if (pin == null) { _locked.value = false; return PinCheck.Success }
        val r = checkPin(candidate)
        if (r == PinCheck.Success) _locked.value = false
        return r
    }

    /** Checks the current PIN without changing anything (the first step of "Change PIN"). Counts as a try. */
    @Synchronized fun verifyCurrent(candidate: String): PinCheck = if (pin == null) PinCheck.Success else checkPin(candidate)

    /** Turns the lock on with a new PIN. Stays unlocked: the person is in the app right now. */
    @Synchronized fun enable(newPin: String): LockResult {
        check(pin == null) { "the lock is already on" }
        PinLock.validate(newPin)?.let { return LockResult.BadNew(it) }
        store(PinLock.create(newPin))
        _locked.value = false
        return LockResult.Done
    }

    /** Replaces the PIN, after [current] is accepted. */
    @Synchronized fun change(current: String, newPin: String): LockResult {
        if (pin == null) return LockResult.Done
        PinLock.validate(newPin)?.let { return LockResult.BadNew(it) }
        val c = checkPin(current)
        if (c != PinCheck.Success) return LockResult.Rejected(c)
        store(PinLock.create(newPin))
        return LockResult.Done
    }

    /** Turns the lock off, after [current] is accepted. */
    @Synchronized fun disable(current: String): LockResult {
        if (pin == null) return LockResult.Done
        val c = checkPin(current)
        if (c != PinCheck.Success) return LockResult.Rejected(c)
        storage.savePin(null)
        pin = null
        resetAttempts()
        stoppedAt = null
        _locked.value = false
        _settings.value = LockSettings(false, delay)
        return LockResult.Done
    }

    @Synchronized fun setDelay(d: LockDelay) {
        delay = d
        storage.saveDelay(d)
        _settings.value = LockSettings(pin != null, d)
    }

    private fun store(s: PinLock.Stored) {
        storage.savePin(s)
        pin = s
        resetAttempts()
        _settings.value = LockSettings(true, delay)
    }

    private fun resetAttempts() {
        if (attempts != Attempts()) {
            attempts = Attempts()
            storage.saveAttempts(attempts)
        }
    }

    private fun checkPin(candidate: String): PinCheck {
        val stored = pin ?: return PinCheck.Success
        val now = wallClock()
        val wait = LockPolicy.remaining(attempts, now)
        if (wait > 0) return PinCheck.Blocked(wait) // no guess is even looked at during a wait
        if (PinLock.verify(candidate, stored)) {
            resetAttempts()
            return PinCheck.Success
        }
        attempts = LockPolicy.afterWrong(attempts, now).also(storage::saveAttempts)
        val after = LockPolicy.remaining(attempts, now)
        return if (after > 0) PinCheck.Blocked(after) else PinCheck.Wrong(LockPolicy.triesLeft(attempts))
    }

    companion object {
        /** A stop counts as caused by our own scanner only when it follows [beginExternalUi] this closely. */
        const val EXTERNAL_START_WINDOW_MS = 15_000L
        /** And only when we are back within this long. */
        const val EXTERNAL_GRACE_MS = 3 * 60_000L
    }
}
