package com.yashraj.glidr.screen.input

import kotlin.math.hypot
import kotlin.math.min

/** Trackpad movement -> PC pixels. Pure functions so the feel is unit-testable. */
object PointerMath {
    /** [level]: 0 off, 1 low, 2 medium, 3 high. [speed] is touch speed in px per ms. */
    fun gain(speed: Float, level: Int): Float {
        if (level <= 0) return 1f
        val k = when (level) { 1 -> 0.12f; 2 -> 0.25f; else -> 0.45f }
        return 1f + k * min(speed, 4f)
    }

    /**
     * Converts a touch delta (px on the phone) to PC pixels. The PC monitor width scales it so the same finger travel
     * covers a similar share of a small laptop panel and of a 4K display.
     */
    fun toHost(dx: Float, dy: Float, dtMs: Float, sensitivity: Float, accel: Int, hostWidth: Int): Pair<Float, Float> {
        val speed = if (dtMs > 0f) hypot(dx, dy) / dtMs else 0f
        val g = gain(speed, accel) * sensitivity * (hostWidth.coerceIn(800, 7680) / 1920f)
        return dx * g to dy * g
    }
}

/** Where a touch point lands in the PC's frame when the video is letter-boxed and zoomed inside its container. */
object VideoMapping {
    /** Returns the normalised (0..1) position in the video, or null when the touch is outside the picture. */
    fun toNormalised(
        px: Float, py: Float, containerW: Float, containerH: Float, videoW: Int, videoH: Int,
        zoom: Float, panX: Float, panY: Float,
    ): Pair<Float, Float>? {
        if (videoW <= 0 || videoH <= 0 || containerW <= 0f || containerH <= 0f) return null
        val fit = min(containerW / videoW, containerH / videoH)
        val rw = videoW * fit
        val rh = videoH * fit
        val cx = containerW / 2f
        val cy = containerH / 2f
        // undo the zoom (about the container centre) and pan
        val x = cx + (px - cx - panX) / zoom
        val y = cy + (py - cy - panY) / zoom
        val nx = (x - (cx - rw / 2f)) / rw
        val ny = (y - (cy - rh / 2f)) / rh
        return if (nx in 0f..1f && ny in 0f..1f) nx to ny else null
    }
}
