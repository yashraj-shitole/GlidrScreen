package com.yashraj.glidr.screen.lock

/** How long the app may stay in the background before it asks for the PIN again. */
enum class LockDelay(val id: String, val millis: Long, val label: String) {
    Immediately("now", 0L, "Immediately"),
    OneMinute("1m", 60_000L, "1 minute"),
    FiveMinutes("5m", 300_000L, "5 minutes");

    companion object {
        val DEFAULT = OneMinute
        fun fromId(id: String?): LockDelay = entries.firstOrNull { it.id == id } ?: DEFAULT
    }
}

/** Wrong tries in a row, and when the next try is allowed (wall-clock millis; 0 = no wait). Survives restarts. */
data class Attempts(val failures: Int = 0, val blockedUntil: Long = 0L)

/**
 * The rules of the app lock, as pure functions of the numbers passed in (the caller supplies the clock), so they are
 * unit tested without a phone.
 */
object LockPolicy {
    /** Wrong tries allowed in a row before the first wait. */
    const val FREE_TRIES = 5

    /** The wait after the 5th, 6th, 7th, 8th and every later wrong try. */
    private val WAITS_MS = longArrayOf(30_000L, 60_000L, 300_000L, 900_000L)

    /** How long to wait after [failures] wrong tries in a row (0 below [FREE_TRIES]; capped at 15 minutes). */
    fun waitFor(failures: Int): Long =
        if (failures < FREE_TRIES) 0L else WAITS_MS[(failures - FREE_TRIES).coerceAtMost(WAITS_MS.lastIndex)]

    /** The counter after one more wrong try at time [now]. */
    fun afterWrong(a: Attempts, now: Long): Attempts {
        val failures = (a.failures + 1).coerceAtMost(10_000)
        val wait = waitFor(failures)
        return Attempts(failures, if (wait > 0) now + wait else 0L)
    }

    /**
     * Millis still to wait at [now]. Never more than the wait that belongs to the counter, so setting the phone's clock
     * back cannot stretch it (and a damaged value cannot lock the phone for years).
     */
    fun remaining(a: Attempts, now: Long): Long {
        if (a.failures < FREE_TRIES || a.blockedUntil <= now) return 0L
        val max = waitFor(a.failures)
        return if (now < 0) max else minOf(a.blockedUntil - now, max) // now >= 0 and blockedUntil > now: no overflow
    }

    /** Wrong tries left before a wait starts (1 once the counter is past the free tries: the next wrong try waits longer). */
    fun triesLeft(a: Attempts): Int = if (a.failures >= FREE_TRIES) 1 else FREE_TRIES - a.failures

    /**
     * Whether coming back to the app should show the lock: it was in the background for [delay] or longer
     * ([stoppedAt] and [now] are on the same monotonic clock). A clock that went backwards locks.
     */
    fun shouldLock(delay: LockDelay, stoppedAt: Long, now: Long): Boolean {
        val away = now - stoppedAt
        return away < 0 || away >= delay.millis
    }

    /** "0:27", "4:59", "15:00": [ms] rounded up to whole seconds. */
    fun formatWait(ms: Long): String {
        val s = (ms.coerceAtLeast(0L) + 999) / 1000
        return "%d:%02d".format(s / 60, s % 60)
    }
}
