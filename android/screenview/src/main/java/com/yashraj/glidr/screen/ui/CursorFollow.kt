package com.yashraj.glidr.screen.ui

import kotlin.math.abs
import kotlin.math.min

/**
 * Pure maths for "follow pointer": while the picture is zoomed in, pan it so the PC cursor stays in the middle third of
 * the view. Pan values use the same convention as [VideoViewState] and `VideoMapping`: the picture is scaled about the
 * centre of its container, then translated by (panX, panY) pixels.
 */
object CursorFollow {
    /** A manual pan or pinch pauses following for this long, so the user can look around without a tug-of-war. */
    const val PAUSE_MS = 1_500L

    /** The cursor may sit this far (share of the view size) outside the middle third before the view moves. */
    const val DEAD_ZONE = 0.04f

    /** Share of the remaining distance covered per animation step. */
    const val EASE = 0.25f

    private const val BAND_LO = 1f / 3f
    private const val BAND_HI = 2f / 3f

    /** Where the video position ([nx], [ny], each 0..1) is drawn inside the container, in container pixels. */
    fun screenPos(
        nx: Float, ny: Float, containerW: Float, containerH: Float, videoW: Int, videoH: Int,
        zoom: Float, panX: Float, panY: Float,
    ): Pair<Float, Float> {
        val fit = min(containerW / videoW, containerH / videoH)
        val rw = videoW * fit
        val rh = videoH * fit
        return (containerW / 2f + (nx - 0.5f) * rw * zoom + panX) to (containerH / 2f + (ny - 0.5f) * rh * zoom + panY)
    }

    /** True while a manual gesture should keep the view still. */
    fun paused(now: Long, pausedUntil: Long) = now < pausedUntil

    /** The largest pan that keeps the zoomed picture covering the container, as `VideoViewState` clamps it. */
    fun maxPan(size: Float, zoom: Float) = size * (zoom - 1f) / 2f

    /**
     * One easing step of the new (panX, panY) for a cursor at ([nx], [ny]). Returns the pan unchanged when the view is
     * not zoomed, the sizes are unknown, or the cursor is inside the middle third (plus the [deadZone]). Otherwise the
     * view moves [ease] of the way that brings the cursor back to the edge of the middle third, never past the picture
     * edge. Call it again on the next frame to finish the move.
     */
    fun followPan(
        nx: Float, ny: Float, containerW: Float, containerH: Float, videoW: Int, videoH: Int,
        zoom: Float, panX: Float, panY: Float,
        deadZone: Float = DEAD_ZONE, ease: Float = EASE,
    ): Pair<Float, Float> {
        if (videoW <= 0 || videoH <= 0 || containerW <= 0f || containerH <= 0f || zoom <= 1.01f) return panX to panY
        val (sx, sy) = screenPos(nx.coerceIn(0f, 1f), ny.coerceIn(0f, 1f), containerW, containerH, videoW, videoH, zoom, panX, panY)
        val dx = correction(sx, containerW, deadZone)
        val dy = correction(sy, containerH, deadZone)
        val maxX = maxPan(containerW, zoom)
        val maxY = maxPan(containerH, zoom)
        return (panX - dx * ease).coerceIn(-maxX, maxX) to (panY - dy * ease).coerceIn(-maxY, maxY)
    }

    /** How far [pos] is outside the middle third of [size], 0 while inside it or within the dead zone. */
    private fun correction(pos: Float, size: Float, deadZone: Float): Float {
        val lo = size * BAND_LO
        val hi = size * BAND_HI
        val over = when {
            pos < lo -> pos - lo
            pos > hi -> pos - hi
            else -> 0f
        }
        return if (abs(over) <= size * deadZone) 0f else over
    }
}
