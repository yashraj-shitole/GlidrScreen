package com.yashraj.glidr.screen.input

import android.view.KeyEvent
import com.yashraj.glidr.screen.net.MouseButton

/** What to send to the PC for one Android key event. */
sealed interface HwOp {
    /** [action]: "d" down, "u" up, "p" press (see Msg.key). */
    data class Key(val name: String, val action: String) : HwOp
    data class Text(val s: String) : HwOp
}

/** Maps a phone's attached keyboard to the PC's key names (host/src/input.js `VK`). Pure, so it is unit-tested. */
object HardwareKeys {
    private val fixed: Map<Int, String> = buildMap {
        put(KeyEvent.KEYCODE_ENTER, "Enter"); put(KeyEvent.KEYCODE_NUMPAD_ENTER, "Enter")
        put(KeyEvent.KEYCODE_ESCAPE, "Esc"); put(KeyEvent.KEYCODE_TAB, "Tab"); put(KeyEvent.KEYCODE_SPACE, "Space")
        put(KeyEvent.KEYCODE_DEL, "Backspace"); put(KeyEvent.KEYCODE_FORWARD_DEL, "Del"); put(KeyEvent.KEYCODE_INSERT, "Ins")
        put(KeyEvent.KEYCODE_DPAD_LEFT, "Left"); put(KeyEvent.KEYCODE_DPAD_RIGHT, "Right")
        put(KeyEvent.KEYCODE_DPAD_UP, "Up"); put(KeyEvent.KEYCODE_DPAD_DOWN, "Down")
        put(KeyEvent.KEYCODE_MOVE_HOME, "Home"); put(KeyEvent.KEYCODE_MOVE_END, "End")
        put(KeyEvent.KEYCODE_PAGE_UP, "PgUp"); put(KeyEvent.KEYCODE_PAGE_DOWN, "PgDn")
        put(KeyEvent.KEYCODE_CTRL_LEFT, "Ctrl"); put(KeyEvent.KEYCODE_CTRL_RIGHT, "Ctrl")
        put(KeyEvent.KEYCODE_ALT_LEFT, "Alt"); put(KeyEvent.KEYCODE_ALT_RIGHT, "Alt")
        put(KeyEvent.KEYCODE_SHIFT_LEFT, "Shift"); put(KeyEvent.KEYCODE_SHIFT_RIGHT, "Shift")
        put(KeyEvent.KEYCODE_META_LEFT, "Win"); put(KeyEvent.KEYCODE_META_RIGHT, "Win")
        put(KeyEvent.KEYCODE_CAPS_LOCK, "CapsLock"); put(KeyEvent.KEYCODE_NUM_LOCK, "NumLock"); put(KeyEvent.KEYCODE_SCROLL_LOCK, "ScrollLock")
        put(KeyEvent.KEYCODE_BREAK, "Pause"); put(KeyEvent.KEYCODE_SYSRQ, "PrtSc")
        put(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, "PlayPause"); put(KeyEvent.KEYCODE_MEDIA_NEXT, "Next")
        put(KeyEvent.KEYCODE_MEDIA_PREVIOUS, "Prev"); put(KeyEvent.KEYCODE_MEDIA_STOP, "Stop"); put(KeyEvent.KEYCODE_MUTE, "Mute")
        put(KeyEvent.KEYCODE_COMMA, ","); put(KeyEvent.KEYCODE_PERIOD, "."); put(KeyEvent.KEYCODE_MINUS, "-"); put(KeyEvent.KEYCODE_EQUALS, "=")
        put(KeyEvent.KEYCODE_LEFT_BRACKET, "["); put(KeyEvent.KEYCODE_RIGHT_BRACKET, "]"); put(KeyEvent.KEYCODE_BACKSLASH, "\\")
        put(KeyEvent.KEYCODE_SEMICOLON, ";"); put(KeyEvent.KEYCODE_APOSTROPHE, "'"); put(KeyEvent.KEYCODE_SLASH, "/"); put(KeyEvent.KEYCODE_GRAVE, "`")
        for (i in 0..9) { put(KeyEvent.KEYCODE_0 + i, "$i"); put(KeyEvent.KEYCODE_NUMPAD_0 + i, "$i") }
        for (i in 0 until 26) put(KeyEvent.KEYCODE_A + i, ('A' + i).toString())
        for (i in 1..12) put(KeyEvent.KEYCODE_F1 + i - 1, "F$i")
    }

    /** The PC's name for an Android key code, or null for keys the phone should keep (Back, Home, volume, ...). */
    fun hostName(keyCode: Int): String? = fixed[keyCode]

    fun isModifier(name: String) = HostKeys.isModifier(name)

    /** The text a key types on its own, or null for control characters and dead keys. */
    fun printable(unicodeChar: Int): String? {
        if (unicodeChar and COMBINING_ACCENT != 0) return null // dead key
        if (unicodeChar <= 0x1f || unicodeChar == 0x7f || unicodeChar > 0x10ffff) return null
        return String(Character.toChars(unicodeChar))
    }

    private const val COMBINING_ACCENT = 0x80000000.toInt()

    /**
     * What one key event does. Modifiers are held on the PC while they are held on the phone, so shortcuts like Alt+Tab
     * work; with Ctrl, Alt or Win down a key is pressed by name, otherwise a printable key types its character
     * (so the phone's layout and Shift decide what appears).
     */
    fun plan(keyCode: Int, unicodeChar: Int, down: Boolean, ctrl: Boolean, alt: Boolean, meta: Boolean): List<HwOp> {
        val name = hostName(keyCode) ?: return emptyList()
        if (isModifier(name)) return listOf(HwOp.Key(name, if (down) "d" else "u"))
        if (!down) return emptyList()
        val chord = ctrl || alt || meta
        val typed = if (chord) null else printable(unicodeChar)
        return listOf(if (typed != null) HwOp.Text(typed) else HwOp.Key(name, "p"))
    }
}

/** An attached mouse. Pure helpers for button state and wheel direction. */
object HardwareMouse {
    const val LEFT = 1
    const val RIGHT = 2
    const val MIDDLE = 4

    fun mask(primary: Boolean, secondary: Boolean, tertiary: Boolean) =
        (if (primary) LEFT else 0) or (if (secondary) RIGHT else 0) or (if (tertiary) MIDDLE else 0)

    /** The buttons that went down (true) or up (false) between two states. */
    fun transitions(before: Int, after: Int): List<Pair<MouseButton, Boolean>> = buildList {
        for ((bit, button) in listOf(LEFT to MouseButton.Left, RIGHT to MouseButton.Right, MIDDLE to MouseButton.Middle)) {
            val was = before and bit != 0
            val now = after and bit != 0
            if (was != now) add(button to now)
        }
    }

    /** Android's scroll delta (positive = down / right) as the host's wheel notches (+y = content moves down, +x = scroll right). */
    fun wheel(scrollX: Float, scrollY: Float): Pair<Float, Float> = scrollX to -scrollY
}
