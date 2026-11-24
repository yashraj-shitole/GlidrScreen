package com.yashraj.glidr.screen.input

import kotlin.math.abs
import kotlin.math.hypot

/** A three-finger swipe on the trackpad. [None] means the fingers did not travel far enough in one direction: it stays a tap. */
enum class Swipe(val keys: List<String>?) {
    Up(listOf("Win", "Tab")), // task view
    Down(listOf("Win", "D")), // show desktop
    Left(listOf("Ctrl", "Win", "Left")), // previous virtual desktop
    Right(listOf("Ctrl", "Win", "Right")), // next virtual desktop
    None(null),
}

object SwipeGestures {
    /** Average travel of the three fingers must exceed this many touch slops to count as a swipe. */
    const val SLOP_FACTOR = 3f

    /** The major axis must be at least this many times the minor one ("mostly in one axis"). */
    const val AXIS_RATIO = 2f

    /** [dx], [dy]: average travel of the fingers in pixels (y grows downward). */
    fun classify(dx: Float, dy: Float, slop: Float): Swipe {
        if (hypot(dx, dy) <= SLOP_FACTOR * slop) return Swipe.None
        val ax = abs(dx)
        val ay = abs(dy)
        return when {
            ay >= AXIS_RATIO * ax -> if (dy < 0) Swipe.Up else Swipe.Down
            ax >= AXIS_RATIO * ay -> if (dx < 0) Swipe.Left else Swipe.Right
            else -> Swipe.None
        }
    }
}
