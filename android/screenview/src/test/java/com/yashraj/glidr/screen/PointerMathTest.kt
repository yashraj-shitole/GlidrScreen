package com.yashraj.glidr.screen

import com.yashraj.glidr.screen.input.PointerMath
import com.yashraj.glidr.screen.input.VideoMapping
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PointerMathTest {
    @Test fun accelerationOffIsLinear() {
        val (x, y) = PointerMath.toHost(10f, -4f, 8f, 1.0f, 0, 1920)
        assertEquals(10f, x, 0.001f); assertEquals(-4f, y, 0.001f)
    }

    @Test fun fastSwipesGoFartherThanSlowOnes() {
        val slow = PointerMath.toHost(10f, 0f, 100f, 1.4f, 2, 1920).first
        val fast = PointerMath.toHost(10f, 0f, 2f, 1.4f, 2, 1920).first
        assertTrue(fast > slow)
    }

    @Test fun biggerMonitorsMoveFarther() {
        val hd = PointerMath.toHost(10f, 0f, 10f, 1f, 0, 1920).first
        val uhd = PointerMath.toHost(10f, 0f, 10f, 1f, 0, 3840).first
        assertEquals(2f, uhd / hd, 0.001f)
    }

    @Test fun tapMapsToVideoCoordinates() {
        // 1920x1080 picture letter-boxed in a 1000x1000 box: picture is 1000 x 562.5, centred
        val centre = VideoMapping.toNormalised(500f, 500f, 1000f, 1000f, 1920, 1080, 1f, 0f, 0f)!!
        assertEquals(0.5f, centre.first, 0.001f); assertEquals(0.5f, centre.second, 0.001f)
        assertNull(VideoMapping.toNormalised(500f, 100f, 1000f, 1000f, 1920, 1080, 1f, 0f, 0f)) // in the black bar
        val topLeft = VideoMapping.toNormalised(0.5f, 219.5f, 1000f, 1000f, 1920, 1080, 1f, 0f, 0f)!!
        assertEquals(0f, topLeft.first, 0.002f); assertEquals(0f, topLeft.second, 0.002f)
    }

    @Test fun zoomAndPanAreUndone() {
        // zoom 2x about the centre, panned 100px left: the centre of the picture is now at x=400
        val p = VideoMapping.toNormalised(400f, 500f, 1000f, 1000f, 1920, 1080, 2f, -100f, 0f)
        assertNotNull(p); assertEquals(0.5f, p!!.first, 0.001f)
    }
}
