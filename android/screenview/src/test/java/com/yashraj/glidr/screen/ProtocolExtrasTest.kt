package com.yashraj.glidr.screen

import com.yashraj.glidr.screen.net.ClipLimits
import com.yashraj.glidr.screen.net.HostEvent
import com.yashraj.glidr.screen.net.HostEvents
import com.yashraj.glidr.screen.net.Msg
import com.yashraj.glidr.screen.net.Quality
import com.yashraj.glidr.screen.ui.streamCaption
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Wire format of the clipboard / cursor / quality messages (docs/PROTOCOL.md) and their size caps. */
class ProtocolExtrasTest {
    /** Key order of a JSONObject is unspecified, so compare as JSON values. */
    private fun assertJson(expected: String, actual: JSONObject) {
        fun flat(o: JSONObject) = o.keys().asSequence().associateWith { o.get(it) }
        // the actual message must survive a round trip through its own text, as it does on the data channel
        val sent = JSONObject(actual.toString())
        assertEquals("expected $expected but was $actual", flat(JSONObject(expected)), flat(sent))
    }

    @Test fun clipMessage() = assertJson("""{"t":"clip","s":"héllo \"x\"\n"}""", Msg.clip("héllo \"x\"\n"))

    @Test fun clipsyncMessage() {
        assertJson("""{"t":"clipsync","on":true}""", Msg.clipsync(true))
        assertJson("""{"t":"clipsync","on":false}""", Msg.clipsync(false))
    }

    @Test fun cursMessage() {
        assertJson("""{"t":"curs","on":true}""", Msg.curs(true))
        assertJson("""{"t":"curs","on":false}""", Msg.curs(false))
    }

    @Test fun qualityKeepsTheOldShapeWithoutExtras() = assertJson("""{"t":"quality","p":"balanced"}""", Msg.quality(Quality.Balanced))

    @Test fun qualityWithFpsAndSaver() {
        assertJson("""{"t":"quality","p":"auto","fps":60,"saver":false}""", Msg.quality(Quality.Auto, 60, false))
        assertJson("""{"t":"quality","p":"low","fps":15,"saver":true}""", Msg.quality(Quality.Low, 15, true))
        assertJson("""{"t":"quality","p":"high","fps":30}""", Msg.quality(Quality.High, 30))
        assertJson("""{"t":"quality","p":"high","saver":true}""", Msg.quality(Quality.High, saver = true))
    }

    // ---------------------------------------------------------------- clipboard size caps

    @Test fun shortTextIsUntouched() {
        val r = ClipLimits.cap("hello")
        assertEquals("hello", r.text); assertFalse(r.truncated)
    }

    @Test fun textAtTheCharLimitIsKept() {
        val s = "a".repeat(ClipLimits.MAX_CHARS)
        // ASCII is 1 byte per char, so the byte cap (200 000) bites first
        val r = ClipLimits.cap(s)
        assertEquals(ClipLimits.MAX_BYTES, r.text.length); assertTrue(r.truncated)
    }

    @Test fun longTextIsCutAndFlagged() {
        val r = ClipLimits.cap("x".repeat(ClipLimits.MAX_CHARS + 500))
        assertTrue(r.truncated)
        assertTrue(r.text.length <= ClipLimits.MAX_CHARS)
    }

    @Test fun multiByteTextIsCutByBytes() {
        val r = ClipLimits.cap("é".repeat(150_000)) // 2 bytes each
        assertTrue(r.truncated)
        assertEquals(ClipLimits.MAX_BYTES / 2, r.text.length)
        assertTrue(r.text.toByteArray().size <= ClipLimits.MAX_BYTES)
    }

    @Test fun neverSplitsASurrogatePair() {
        val smile = "😀" // 4 bytes in UTF-8, 2 chars
        val r = ClipLimits.cap(smile.repeat(60_000))
        assertTrue(r.truncated)
        assertTrue(r.text.length % 2 == 0)
        assertFalse(Character.isHighSurrogate(r.text.last()))
        assertTrue(r.text.toByteArray().size <= ClipLimits.MAX_BYTES)
    }

    @Test fun emptyStaysEmpty() {
        val r = ClipLimits.cap("")
        assertEquals("", r.text); assertFalse(r.truncated)
    }

    // ---------------------------------------------------------------- host messages

    @Test fun parsesClip() {
        assertEquals(HostEvent.Clip("copied text"), HostEvents.parse(JSONObject("""{"t":"clip","s":"copied text"}""")))
    }

    @Test fun ignoresEmptyOrMissingClip() {
        assertNull(HostEvents.parse(JSONObject("""{"t":"clip","s":""}""")))
        assertNull(HostEvents.parse(JSONObject("""{"t":"clip"}""")))
        assertNull(HostEvents.parse(JSONObject("""{"t":"clip","s":null}""")))
    }

    @Test fun capsAnOversizedIncomingClip() {
        val big = "z".repeat(ClipLimits.MAX_CHARS * 2)
        val ev = HostEvents.parse(JSONObject().put("t", "clip").put("s", big)) as HostEvent.Clip
        assertTrue(ev.text.length <= ClipLimits.MAX_CHARS)
    }

    @Test fun parsesCursorAndClampsIt() {
        assertEquals(HostEvent.Cursor(0.25f, 0.75f), HostEvents.parse(JSONObject("""{"t":"cur","x":0.25,"y":0.75}""")))
        assertEquals(HostEvent.Cursor(1f, 0f), HostEvents.parse(JSONObject("""{"t":"cur","x":1.4,"y":-0.2}""")))
    }

    @Test fun rejectsBrokenCursor() {
        assertNull(HostEvents.parse(JSONObject("""{"t":"cur","x":0.5}""")))
        assertNull(HostEvents.parse(JSONObject("""{"t":"cur"}""")))
        assertNull(HostEvents.parse(JSONObject("""{"t":"cur","x":"a","y":"b"}""")))
    }

    @Test fun parsesLocked() {
        assertEquals(HostEvent.Locked(true), HostEvents.parse(JSONObject("""{"t":"locked","on":true}""")))
        assertEquals(HostEvent.Locked(false), HostEvents.parse(JSONObject("""{"t":"locked","on":false}""")))
    }

    @Test fun parsesRecording() {
        assertEquals(HostEvent.Recording(true), HostEvents.parse(JSONObject("""{"t":"recording","on":true}""")))
        assertEquals(HostEvent.Recording(false), HostEvents.parse(JSONObject("""{"t":"recording","on":false}""")))
        // a message without a usable "on" never claims a recording
        assertEquals(HostEvent.Recording(false), HostEvents.parse(JSONObject("""{"t":"recording"}""")))
        assertEquals(HostEvent.Recording(false), HostEvents.parse(JSONObject("""{"t":"recording","on":null}""")))
        assertEquals(HostEvent.Recording(false), HostEvents.parse(JSONObject("""{"t":"recording","on":"maybe"}""")))
    }

    @Test fun helloRecordingFlag() {
        assertEquals(true, HostEvents.helloExtras(JSONObject("""{"t":"hello","recording":true}""")).recording)
        assertEquals(false, HostEvents.helloExtras(JSONObject("""{"t":"hello","recording":false}""")).recording)
        assertNull(HostEvents.helloExtras(JSONObject("""{"t":"hello","v":1}""")).recording) // older host
    }

    @Test fun unknownTypesAreIgnored() = assertNull(HostEvents.parse(JSONObject("""{"t":"whatever"}""")))

    @Test fun helloExtrasPresent() {
        val x = HostEvents.helloExtras(JSONObject("""{"t":"hello","locked":true,"audio":true,"fps":60}"""))
        assertEquals(true, x.locked); assertEquals(true, x.audio); assertEquals(60, x.fps)
    }

    @Test fun helloExtrasAbsentFromOlderHost() {
        val x = HostEvents.helloExtras(JSONObject("""{"t":"hello","v":1,"control":true}"""))
        assertNull(x.locked); assertNull(x.audio); assertNull(x.fps)
    }

    // ---------------------------------------------------------------- settings caption

    @Test fun captionNamesTheRealFrameRate() {
        assertTrue(streamCaption(60, false).contains("60 fps"))
        assertTrue(streamCaption(15, true).contains("15 fps"))
        assertTrue(streamCaption(15, true).contains("data saver"))
        assertFalse(streamCaption(24, false).contains("Always"))
    }
}
