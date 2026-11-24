package com.yashraj.glidr.screen

import com.yashraj.glidr.screen.input.VideoMapping
import com.yashraj.glidr.screen.ui.CursorFollow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

class CursorFollowTest {
    // a 1000 x 500 container showing a 1920 x 1080 picture (letterboxed: fit = 0.5208, drawn 1000 x 562.5)
    private val cw = 1000f
    private val ch = 500f
    private val vw = 1920
    private val vh = 1080
    private val zoom = 3f

    private fun follow(nx: Float, ny: Float, panX: Float = 0f, panY: Float = 0f, z: Float = zoom) =
        CursorFollow.followPan(nx, ny, cw, ch, vw, vh, z, panX, panY)

    @Test fun cursorInTheMiddleThirdDoesNotMoveTheView() {
        assertEquals(0f to 0f, follow(0.5f, 0.5f))
        // 0.5 +/- a little is still inside the middle third of the zoomed view
        assertEquals(0f to 0f, follow(0.52f, 0.5f))
    }

    @Test fun cursorToTheRightPansTheViewLeft() {
        val (px, py) = follow(0.62f, 0.5f)
        assertTrue("panX $px should go negative", px < 0f)
        assertEquals(0f, py, 0f)
    }

    @Test fun cursorToTheLeftPansTheViewRight() {
        val (px, _) = follow(0.38f, 0.5f)
        assertTrue(px > 0f)
    }

    @Test fun verticalFollowWorksIndependently() {
        val (px, py) = follow(0.5f, 0.6f)
        assertEquals(0f, px, 0f)
        assertTrue(py < 0f)
    }

    @Test fun deadZoneIgnoresSmallOvershoot() {
        // find a cursor just outside the middle third (screen x slightly above 2/3) but inside the dead zone
        val z = 3f
        val sxHi = cw * 2f / 3f
        val target = sxHi + cw * CursorFollow.DEAD_ZONE * 0.5f
        val nx = 0.5f + (target - cw / 2f) / (vw * minOf(cw / vw, ch / vh) * z)
        assertEquals(0f to 0f, follow(nx, 0.5f))
    }

    @Test fun notZoomedNeverMoves() {
        assertEquals(10f to 20f, follow(0.95f, 0.95f, 10f, 20f, z = 1f))
        assertEquals(10f to 20f, follow(0.95f, 0.95f, 10f, 20f, z = 1.005f))
    }

    @Test fun unknownSizesAreIgnored() {
        assertEquals(1f to 2f, CursorFollow.followPan(0.9f, 0.9f, 0f, 0f, vw, vh, zoom, 1f, 2f))
        assertEquals(1f to 2f, CursorFollow.followPan(0.9f, 0.9f, cw, ch, 0, 0, zoom, 1f, 2f))
    }

    @Test fun panIsClampedToThePicture() {
        // already panned fully left; the cursor is far right, so the view wants to move further left but cannot
        val max = CursorFollow.maxPan(cw, zoom)
        val (px, _) = follow(0.99f, 0.5f, panX = -max)
        assertEquals(-max, px, 0.001f)
    }

    @Test fun easesRatherThanJumping() {
        val (px, _) = follow(0.8f, 0.5f)
        val (full, _) = CursorFollow.followPan(0.8f, 0.5f, cw, ch, vw, vh, zoom, 0f, 0f, ease = 1f)
        assertTrue(abs(px) < abs(full))
        assertEquals(full * CursorFollow.EASE, px, 0.001f)
    }

    @Test fun repeatedStepsBringTheCursorIntoTheMiddleThird() {
        var pan = 0f to 0f
        repeat(80) { pan = follow(0.7f, 0.4f, pan.first, pan.second) }
        val (sx, sy) = CursorFollow.screenPos(0.7f, 0.4f, cw, ch, vw, vh, zoom, pan.first, pan.second)
        val slackX = cw * CursorFollow.DEAD_ZONE
        val slackY = ch * CursorFollow.DEAD_ZONE
        assertTrue("sx $sx", sx >= cw / 3f - slackX && sx <= cw * 2f / 3f + slackX)
        assertTrue("sy $sy", sy >= ch / 3f - slackY && sy <= ch * 2f / 3f + slackY)
        // and a further step does nothing: it has settled
        assertEquals(pan, follow(0.7f, 0.4f, pan.first, pan.second))
    }

    @Test fun screenPosAgreesWithTheTouchMapping() {
        val nx = 0.31f
        val ny = 0.77f
        val (sx, sy) = CursorFollow.screenPos(nx, ny, cw, ch, vw, vh, 2.5f, -120f, 45f)
        val back = VideoMapping.toNormalised(sx, sy, cw, ch, vw, vh, 2.5f, -120f, 45f)
        assertNotNull(back)
        assertEquals(nx, back!!.first, 0.0005f)
        assertEquals(ny, back.second, 0.0005f)
    }

    @Test fun manualGesturesPauseFollowingFor1500Ms() {
        assertEquals(1_500L, CursorFollow.PAUSE_MS)
        val until = 10_000L + CursorFollow.PAUSE_MS
        assertTrue(CursorFollow.paused(10_000L, until))
        assertTrue(CursorFollow.paused(11_499L, until))
        assertFalse(CursorFollow.paused(11_500L, until))
        assertFalse(CursorFollow.paused(5L, 0L))
    }
}
