package com.yashraj.glidr.screen

import com.yashraj.glidr.screen.update.Versions
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VersionsTest {
    @Test fun newerPatchMinorMajor() {
        assertTrue(Versions.compare("1.0.1", "1.0.0") > 0)
        assertTrue(Versions.compare("v1.10.0", "1.9.9") > 0)
        assertTrue(Versions.compare("2.0", "1.99.99") > 0)
    }

    @Test fun equalAndOlder() {
        assertEquals(0, Versions.compare("v1.0.0", "1.0.0"))
        assertEquals(0, Versions.compare("1.0.0", "1.0.0-beta"))
        assertTrue(Versions.compare("0.9", "1.0.0") < 0)
    }

    @Test fun picksTheApk() {
        val assets = listOf("GlidrScreen-win-x64.zip" to "https://z", "GlidrScreen-1.1.0.apk" to "https://a")
        assertEquals("https://a", Versions.pickAsset(assets, ".apk"))
        assertNull(Versions.pickAsset(listOf("x.zip" to "https://z"), ".apk"))
    }
}
