package com.yashraj.glidr.screen

import com.yashraj.glidr.screen.input.InputProfile
import com.yashraj.glidr.screen.input.PadZone
import com.yashraj.glidr.screen.input.PadZones
import com.yashraj.glidr.screen.input.ProfileKeys
import com.yashraj.glidr.screen.input.Shortcuts
import com.yashraj.glidr.screen.input.matchingProfile
import com.yashraj.glidr.screen.input.withProfile
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class InputFeaturesTest {
    @Test fun shortcutRoundTripsThroughJson() {
        val copy = Shortcuts.create("Copy", listOf("Ctrl", "C"), pinned = true)
        val snip = Shortcuts.create("Snip", listOf("Win", "Shift", "S"))
        assertNotNull(copy); assertNotNull(snip)
        val list = listOf(copy!!, snip!!)
        assertEquals(list, Shortcuts.fromJson(Shortcuts.toJson(list)))
    }

    @Test fun invalidShortcutsAreRejected() {
        assertNull(Shortcuts.create("", listOf("Ctrl", "C")))            // no label
        assertNull(Shortcuts.create("Nothing", emptyList()))              // no keys
        assertNull(Shortcuts.create("Bad", listOf("Ctrl", "NotAKey")))    // a key the PC does not know
    }

    @Test fun brokenJsonGivesAnEmptyDeck() {
        assertTrue(Shortcuts.fromJson(null).isEmpty())
        assertTrue(Shortcuts.fromJson("not json at all").isEmpty())
    }

    @Test fun onlyFourShortcutsAreShownPinned() {
        val many = (1..6).map { Shortcuts.create("S$it", listOf("Ctrl", "F$it"), pinned = true)!! }
        assertEquals(4, Shortcuts.pinned(many).size)
    }

    @Test fun profileKeysAreSafeAndPerPc() {
        assertEquals(ProfileKeys.key("abc12345", "sens"), ProfileKeys.key("abc12345", "sens"))
        assertTrue(ProfileKeys.key("abc12345", "sens") != ProfileKeys.key("zzz99999", "sens"))
        assertTrue(!ProfileKeys.key("a/b c\n", "sens").contains(' '))
    }

    @Test fun appliedProfileIsRecognisedAndEditingBreaksTheMatch() {
        for (profile in InputProfile.entries) {
            assertEquals(profile, ViewerPrefs().withProfile(profile).matchingProfile())
        }
        assertNull(ViewerPrefs().withProfile(InputProfile.Reading).copy(sensitivity = 2.77f).matchingProfile())
    }

    @Test fun padZonesAreOffUnlessEnabled() {
        // a tap in the bottom-right corner of a 400x300 pad is just a normal touch with both options off
        assertEquals(PadZone.Normal, PadZones.classify(390f, 290f, 400f, 300f, edge = false, corner = false, stripPx = 40f, cornerPx = 60f))
        // the middle of the pad is always normal
        assertEquals(PadZone.Normal, PadZones.classify(200f, 100f, 400f, 300f, edge = true, corner = true, stripPx = 40f, cornerPx = 60f))
        // with the options on, the bottom strip scrolls sideways and the far corner right-clicks
        assertEquals(PadZone.EdgeScroll, PadZones.classify(100f, 290f, 400f, 300f, edge = true, corner = false, stripPx = 40f, cornerPx = 60f))
        assertEquals(PadZone.Corner, PadZones.classify(390f, 290f, 400f, 300f, edge = true, corner = true, stripPx = 40f, cornerPx = 60f))
    }
}
