package com.yashraj.glidr.screen.lock

/** Plain-language messages for the lock screen and its settings sheet. */
object LockText {
    const val INTRO = "Lock Glidr Screen with a PIN so nobody else can use your paired PCs."
    const val STORED = "The PIN is kept on this phone only as a salted hash, never as the number itself."
    const val BACKGROUND = "A live session keeps running after you leave the app only as long as Android allows."
    const val FORGOTTEN =
        "Forgot your PIN? There is no recovery. Clearing the app's data (Android Settings, Apps, Glidr Screen, Storage) " +
            "removes the lock and all pairings."

    fun error(e: PinLock.Error): String = when (e) {
        PinLock.Error.TooShort -> "Use at least ${PinLock.MIN_LENGTH} digits."
        PinLock.Error.TooLong -> "Use at most ${PinLock.MAX_LENGTH} digits."
        PinLock.Error.NotDigits -> "Use digits only."
        PinLock.Error.Weak -> "Too easy to guess. Avoid repeated digits and runs like 1234."
    }

    /** What to tell the person after a PIN that was not accepted; null for [PinCheck.Success]. */
    fun check(c: PinCheck): String? = when (c) {
        PinCheck.Success -> null
        is PinCheck.Blocked -> "Too many wrong tries. Try again in ${LockPolicy.formatWait(c.remainingMs)}."
        is PinCheck.Wrong ->
            if (c.triesLeft == 1) "Wrong PIN. 1 try left before a wait." else "Wrong PIN. ${c.triesLeft} tries left before a wait."
    }
}
