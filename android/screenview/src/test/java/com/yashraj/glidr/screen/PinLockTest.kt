package com.yashraj.glidr.screen

import com.yashraj.glidr.screen.lock.PinEntry
import com.yashraj.glidr.screen.lock.PinLock
import com.yashraj.glidr.screen.lock.PinLock.Error
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PinLockTest {
    // ---- validate

    @Test fun acceptsFourToEightOrdinaryDigits() {
        for (p in listOf("1357", "2580", "908172", "13572468", "0852", "1233", "4321 ".trim() + "9")) {
            assertNull("$p should be fine", PinLock.validate(p))
        }
    }

    @Test fun rejectsTooShortAndTooLong() {
        assertEquals(Error.TooShort, PinLock.validate(""))
        assertEquals(Error.TooShort, PinLock.validate("135"))
        assertEquals(Error.TooLong, PinLock.validate("135724681"))
    }

    @Test fun rejectsNonDigitsIncludingUnicodeDigits() {
        assertEquals(Error.NotDigits, PinLock.validate("12a4"))
        assertEquals(Error.NotDigits, PinLock.validate("1 357"))
        assertEquals(Error.NotDigits, PinLock.validate("-1357"))
        assertEquals(Error.NotDigits, PinLock.validate("١٣٥٧")) // Arabic-Indic digits are not ASCII 0-9
    }

    @Test fun rejectsRepeatedDigits() {
        for (p in listOf("0000", "1111", "99999999")) assertEquals(p, Error.Weak, PinLock.validate(p))
    }

    @Test fun rejectsStraightRunsUpAndDown() {
        for (p in listOf("1234", "4321", "0123", "3210", "56789", "98765", "12345678", "87654321")) {
            assertEquals(p, Error.Weak, PinLock.validate(p))
        }
        // not a run: one step breaks it
        assertNull(PinLock.validate("1235"))
        assertNull(PinLock.validate("1324"))
        assertNull(PinLock.validate("1212"))
    }

    // ---- create / verify

    @Test fun correctPinVerifies() {
        val s = PinLock.create("483920")
        assertTrue(PinLock.verify("483920", s))
    }

    @Test fun wrongPinDoesNotVerify() {
        val s = PinLock.create("483920")
        assertFalse(PinLock.verify("483921", s))
        assertFalse(PinLock.verify("48392", s))
        assertFalse(PinLock.verify("4839200", s))
        assertFalse(PinLock.verify("", s))
    }

    @Test fun storedValueHoldsNoPinAndUsesTheSpecifiedParameters() {
        val s = PinLock.create("483920")
        assertEquals(120_000, s.iterations)
        assertEquals(16, java.util.Base64.getDecoder().decode(s.salt).size)
        assertEquals(32, java.util.Base64.getDecoder().decode(s.hash).size)
        assertFalse(s.salt.contains("483920"))
        assertFalse(s.hash.contains("483920"))
    }

    @Test fun eachPinGetsItsOwnRandomSalt() {
        val a = PinLock.create("483920")
        val b = PinLock.create("483920")
        assertNotEquals(a.salt, b.salt)
        assertNotEquals(a.hash, b.hash)
        assertTrue(PinLock.verify("483920", a))
        assertTrue(PinLock.verify("483920", b))
    }

    @Test fun createRefusesAnUnacceptablePin() {
        for (p in listOf("1234", "12", "abcd", "1111")) {
            val threw = try { PinLock.create(p); false } catch (_: IllegalArgumentException) { true }
            assertTrue("$p must be refused", threw)
        }
    }

    // ---- corrupted stored values fail closed and never throw

    @Test fun corruptedStoredValuesNeverVerifyAndNeverThrow() {
        val good = PinLock.create("483920")
        val broken = listOf(
            PinLock.Stored("", "", 0),
            PinLock.Stored("", "", 120_000),
            PinLock.Stored(good.salt, "", good.iterations),
            PinLock.Stored("", good.hash, good.iterations),
            PinLock.Stored("%%% not base64 %%%", good.hash, good.iterations),
            PinLock.Stored(good.salt, "%%% not base64 %%%", good.iterations),
            PinLock.Stored(good.salt, good.hash.dropLast(4), good.iterations), // truncated hash
            PinLock.Stored(good.salt.dropLast(4), good.hash, good.iterations), // truncated salt
            PinLock.Stored(good.hash, good.salt, good.iterations), // swapped
            PinLock.Stored(good.salt, good.hash, 0),
            PinLock.Stored(good.salt, good.hash, -5),
            PinLock.Stored(good.salt, good.hash, 1),
            PinLock.Stored(good.salt, good.hash, Int.MAX_VALUE), // must not spin for hours
            PinLock.Stored(good.salt, good.hash, good.iterations + 1), // wrong rounds: different hash
        )
        for (b in broken) assertFalse("$b", PinLock.verify("483920", b))
    }

    @Test fun absurdInputNeverReachesTheHash() {
        val s = PinLock.create("483920")
        assertFalse(PinLock.verify("1".repeat(1_000_000), s))
        assertFalse(PinLock.verify("48392\u0000", s))
    }

    // ---- PinEntry

    @Test fun pinEntryAppendsBacksAndStopsAtMax() {
        var p = ""
        for (d in 1..9) p = PinEntry.append(p, d)
        assertEquals("12345678", p)
        assertEquals("1234567", PinEntry.backspace(p))
        assertEquals("", PinEntry.backspace(""))
        assertEquals("5", PinEntry.append("", 5))
        assertEquals("", PinEntry.append("", 10))
        assertEquals("", PinEntry.append("", -1))
    }

    @Test fun pinEntrySanitizesTextFieldInput() {
        assertEquals("1357", PinEntry.sanitize("1a3-5 7"))
        assertEquals("12345678", PinEntry.sanitize("123456789012"))
        assertEquals("", PinEntry.sanitize("١٢"))
    }

    @Test fun hardwareKeysMapToDigits() {
        // android.view.KeyEvent: KEYCODE_0 = 7 .. KEYCODE_9 = 16, KEYCODE_NUMPAD_0 = 144 .. KEYCODE_NUMPAD_9 = 153
        assertEquals(0, PinEntry.digitForKeyCode(7))
        assertEquals(9, PinEntry.digitForKeyCode(16))
        assertEquals(0, PinEntry.digitForKeyCode(144))
        assertEquals(9, PinEntry.digitForKeyCode(153))
        assertNull(PinEntry.digitForKeyCode(6))
        assertNull(PinEntry.digitForKeyCode(17))
        assertNull(PinEntry.digitForKeyCode(66)) // Enter
    }
}
