package com.yashraj.glidr.screen.lock

import android.view.KeyEvent

/** Small pure helpers for typing a PIN on the pad or a hardware keyboard. */
object PinEntry {
    /** [pin] with [digit] (0-9) added, unchanged once it is [PinLock.MAX_LENGTH] long. */
    fun append(pin: String, digit: Int): String =
        if (digit !in 0..9 || pin.length >= PinLock.MAX_LENGTH) pin else pin + ('0' + digit)

    fun backspace(pin: String): String = pin.dropLast(1)

    /** Keeps only ASCII digits, at most [PinLock.MAX_LENGTH] (for a text field). */
    fun sanitize(text: String): String = text.filter { it in '0'..'9' }.take(PinLock.MAX_LENGTH)

    /** The digit a hardware key stands for (top row or number pad), or null. */
    fun digitForKeyCode(code: Int): Int? = when (code) {
        in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> code - KeyEvent.KEYCODE_0
        in KeyEvent.KEYCODE_NUMPAD_0..KeyEvent.KEYCODE_NUMPAD_9 -> code - KeyEvent.KEYCODE_NUMPAD_0
        else -> null
    }
}
