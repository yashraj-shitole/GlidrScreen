package com.yashraj.glidr.screen

import com.yashraj.glidr.screen.net.ActiveSource
import com.yashraj.glidr.screen.net.Msg
import com.yashraj.glidr.screen.net.PcWindow
import com.yashraj.glidr.screen.net.SourceError
import com.yashraj.glidr.screen.net.SourceKind
import com.yashraj.glidr.screen.net.WindowThumb
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Wire format of the window sharing messages (docs/PROTOCOL.md, "Window sharing"). */
class WindowSharingTest {
    private fun flat(o: JSONObject) = o.keys().asSequence().associateWith { o.get(it) }

    private fun assertJson(expected: String, actual: JSONObject) =
        assertEquals(flat(JSONObject(expected)), flat(JSONObject(actual.toString())))

    @Test fun windowsMessage() {
        assertJson("""{"t":"windows","on":true}""", Msg.windows(true))
        assertJson("""{"t":"windows","on":false}""", Msg.windows(false))
    }

    @Test fun sourceMessage() {
        assertJson("""{"t":"source","kind":"window","id":"window:1234:0"}""", Msg.source(SourceKind.Window, "window:1234:0"))
        assertJson("""{"t":"source","kind":"monitor","id":"2528732444"}""", Msg.source(SourceKind.Monitor, 2528732444L.toString()))
    }

    @Test fun parsesTheWindowList() {
        val arr = JSONArray(
            """[{"id":"window:1:0","title":"Docs - Browser","w":1280,"h":720},
                {"id":"window:2:0","title":"Notes","w":800,"h":600}]""",
        )
        assertEquals(
            listOf(PcWindow("window:1:0", "Docs - Browser", 1280, 720), PcWindow("window:2:0", "Notes", 800, 600)),
            PcWindow.parseAll(arr),
        )
        assertEquals(emptyList<PcWindow>(), PcWindow.parseAll(null))
        assertEquals(emptyList<PcWindow>(), PcWindow.parseAll(JSONArray("[]")))
    }

    @Test fun listParsingIsTolerant() {
        val arr = JSONArray(
            """[{"title":"no id"},{"id":"","title":"empty id"},{"id":5,"title":"numeric id"},{"id":null,"title":"null id"},
                "junk",7,{"id":"window:9:0"},{"id":"window:10:0","title":"ok","w":"x"}]""",
        )
        val list = PcWindow.parseAll(arr)
        assertEquals(listOf("window:9:0", "window:10:0"), list.map { it.id })
        assertEquals("", list[0].title)
        assertEquals(0, list[1].w)
    }

    @Test fun listIsCappedAt30() {
        val arr = JSONArray((1..50).map { JSONObject().put("id", "window:$it:0").put("title", "W$it").put("w", 300).put("h", 200) })
        val list = PcWindow.parseAll(arr)
        assertEquals(30, list.size)
        assertEquals("window:1:0", list.first().id)
    }

    @Test fun titlesAreCleanedAndCut() {
        assertEquals("a b", PcWindow.cleanTitle("a\u0000\n\tb"))
        assertEquals("a b", PcWindow.cleanTitle("a‮b"))
        assertEquals("", PcWindow.cleanTitle(null))
        assertEquals(80, PcWindow.cleanTitle("x".repeat(300)).length)
        val emoji = PcWindow.cleanTitle("😀".repeat(100)) // 100 code points
        assertEquals(80, emoji.codePointCount(0, emoji.length))
        assertTrue("no half emoji at the end", !Character.isHighSurrogate(emoji.last()))
    }

    @Test fun activeMonitorKeepsTheOldMessage() {
        val a = ActiveSource.parse(JSONObject("""{"t":"active","id":2528732444,"w":1920,"h":1080}"""))
        assertEquals(ActiveSource.Display(2528732444L, 1920, 1080), a)
        assertEquals(ActiveSource.Display(7, 10, 20), ActiveSource.parse(JSONObject("""{"t":"active","kind":"monitor","id":7,"w":10,"h":20}""")))
    }

    @Test fun activeWindow() {
        val a = ActiveSource.parse(JSONObject("""{"t":"active","kind":"window","id":"window:77:0","title":"Notes","w":640,"h":480}"""))
        assertEquals(ActiveSource.Window("window:77:0", "Notes", 640, 480), a)
        assertNull(ActiveSource.parse(JSONObject("""{"t":"active","kind":"window","id":12,"title":"x"}""")))
        assertNull(ActiveSource.parse(JSONObject("""{"t":"active","kind":"window","title":"x"}""")))
        val long = ActiveSource.parse(JSONObject().put("kind", "window").put("id", "window:1:0").put("title", "T".repeat(500))) as ActiveSource.Window
        assertEquals(80, long.title.length)
    }

    @Test fun sourceErrorMessages() {
        val e = SourceError.parse(JSONObject("""{"t":"source-error","id":"window:5:0","reason":"gone"}"""))
        assertEquals(SourceError("window:5:0", "gone"), e)
        assertEquals("That window is gone", e!!.message)
        assertEquals("Could not share that window", SourceError("window:5:0", "weird").message)
        assertEquals("gone", SourceError.parse(JSONObject("""{"t":"source-error","id":"x"}"""))!!.reason)
        assertNull(SourceError.parse(JSONObject("""{"t":"active"}""")))
    }

    @Test fun thumbParsing() {
        assertEquals(WindowThumb("window:1:0", "AAAA"), WindowThumb.parse(JSONObject("""{"t":"wthumb","id":"window:1:0","w":384,"h":216,"jpg":"AAAA"}""")))
        assertNull(WindowThumb.parse(JSONObject("""{"t":"wthumb","id":"window:1:0"}""")))
        assertNull(WindowThumb.parse(JSONObject("""{"t":"wthumb","jpg":"AAAA"}""")))
        assertNull(WindowThumb.parse(JSONObject("""{"t":"wthumb","id":"window:1:0","jpg":""}""")))
        assertNull(WindowThumb.parse(JSONObject().put("id", "w").put("jpg", "A".repeat(300_001))))
    }
}
