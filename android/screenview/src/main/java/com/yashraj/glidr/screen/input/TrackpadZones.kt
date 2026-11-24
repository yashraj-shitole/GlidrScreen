package com.yashraj.glidr.screen.input

/** Where on the pad a touch started. */
enum class PadZone { Normal, EdgeScroll, Corner }

/** Pure hit-testing and maths for the trackpad's opt-in edge zones and precision mode. */
object PadZones {
    /** Pointer speed while a second finger rests on the pad. */
    const val PRECISION_SCALE = 0.3f

    /**
     * Zone of a touch at ([x], [y]) on a pad [w] x [h] px. The bottom [stripPx] is the horizontal scroll strip when [edge]
     * is on; the bottom-right [cornerPx] square is the right-click corner when [corner] is on and wins over the strip.
     */
    fun classify(x: Float, y: Float, w: Float, h: Float, edge: Boolean, corner: Boolean, stripPx: Float, cornerPx: Float): PadZone = when {
        corner && x >= w - cornerPx && y >= h - cornerPx && x <= w && y <= h -> PadZone.Corner
        edge && y >= h - stripPx && y <= h -> PadZone.EdgeScroll
        else -> PadZone.Normal
    }

    /** A touch that started in the corner and then slid is no longer a corner tap: it scrolls (strip on) or moves the pointer. */
    fun afterMove(zone: PadZone, edge: Boolean): PadZone = if (zone == PadZone.Corner) (if (edge) PadZone.EdgeScroll else PadZone.Normal) else zone

    /** True while the resting finger has not travelled more than the touch slop, so the pair is not a two-finger scroll. */
    fun secondFingerStill(travel: Float, slop: Float) = travel <= slop

    /** The factor applied to pointer movement. */
    fun precisionScale(precisionOn: Boolean, secondFingerTravel: Float, slop: Float): Float =
        if (precisionOn && secondFingerStill(secondFingerTravel, slop)) PRECISION_SCALE else 1f
}
