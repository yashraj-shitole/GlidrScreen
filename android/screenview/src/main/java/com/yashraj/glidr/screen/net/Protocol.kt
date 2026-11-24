package com.yashraj.glidr.screen.net

import org.json.JSONArray
import org.json.JSONObject

/**
 * One PC monitor in physical pixels on the PC's virtual desktop. [id] is Chromium's display id, an unsigned 32-bit
 * hash on Windows (often above Int.MAX_VALUE), so it is a Long.
 */
data class Monitor(val id: Long, val name: String, val x: Int, val y: Int, val w: Int, val h: Int, val primary: Boolean) {
    companion object {
        fun parseAll(arr: JSONArray?): List<Monitor> = if (arr == null) emptyList() else (0 until arr.length()).map {
            val o = arr.getJSONObject(it)
            Monitor(o.getLong("id"), o.optString("name", "Display ${it + 1}"), o.optInt("x"), o.optInt("y"), o.optInt("w"), o.optInt("h"), o.optBoolean("primary"))
        }
    }
}

enum class Quality(val wire: String, val label: String) {
    Auto("auto", "Auto"), Low("low", "540p"), Balanced("balanced", "720p"), High("high", "1440p");

    companion object { fun of(wire: String?) = entries.firstOrNull { it.wire == wire } ?: Auto }
}

enum class MouseButton(val wire: String) { Left("l"), Right("r"), Middle("m") }

/** Builders for the JSON messages sent over the `ctl` data channel (see docs/PROTOCOL.md). */
object Msg {
    fun ping(n: Int, ts: Long) = JSONObject().put("t", "ping").put("n", n).put("ts", ts)
    fun move(dx: Int, dy: Int) = JSONObject().put("t", "mv").put("dx", dx).put("dy", dy)
    fun absolute(x: Float, y: Float) = JSONObject().put("t", "abs").put("x", x.toDouble()).put("y", y.toDouble())

    /** [action]: "d" down, "u" up, "c" click. */
    fun button(b: MouseButton, action: String) = JSONObject().put("t", "btn").put("b", b.wire).put("a", action)
    fun wheel(x: Float, y: Float) = JSONObject().put("t", "wheel").put("x", x.toDouble()).put("y", y.toDouble())
    fun key(name: String, action: String = "p") = JSONObject().put("t", "key").put("k", name).put("a", action)
    fun combo(keys: List<String>) = JSONObject().put("t", "combo").put("keys", JSONArray(keys))
    fun text(s: String) = JSONObject().put("t", "text").put("s", s)
    fun monitor(id: Long) = JSONObject().put("t", "monitor").put("id", id)
    fun thumbs(on: Boolean) = JSONObject().put("t", "thumbs").put("on", on)

    /** [fps] and [saver] are optional on the wire: omitted when null so an older host sees exactly the old message. */
    fun quality(q: Quality, fps: Int? = null, saver: Boolean? = null): JSONObject {
        val o = JSONObject().put("t", "quality").put("p", q.wire)
        if (fps != null) o.put("fps", fps)
        if (saver != null) o.put("saver", saver)
        return o
    }

    /** Sets the PC clipboard. [s] must already be within [ClipLimits]. */
    fun clip(s: String) = JSONObject().put("t", "clip").put("s", s)

    /** Ask the PC to push its clipboard text changes ([HostEvent.Clip]) while [on]. */
    fun clipsync(on: Boolean) = JSONObject().put("t", "clipsync").put("on", on)

    /** Start or stop the PC cursor position stream ([HostEvent.Cursor], about 30 Hz). */
    fun curs(on: Boolean) = JSONObject().put("t", "curs").put("on", on)
}

/** Frame rates the PC offers; the host clamps anything else. */
val FPS_OPTIONS = listOf(15, 24, 30, 60)
const val DEFAULT_FPS = 24

/** Size caps for clipboard text sent between the devices. */
object ClipLimits {
    /** Contract limit: characters in one `clip` message. */
    const val MAX_CHARS = 262_144

    /**
     * Practical limit on UTF-8 bytes of the text. A data channel message is capped near 256 KiB by libwebrtc and JSON
     * escaping adds a little, so text made of multi-byte characters is cut earlier than [MAX_CHARS].
     */
    const val MAX_BYTES = 200_000

    data class Capped(val text: String, val truncated: Boolean)

    /** Cuts [text] to the limits without splitting a surrogate pair (an emoji) in half. */
    fun cap(text: String): Capped {
        var end = minOf(text.length, MAX_CHARS)
        var bytes = 0
        var i = 0
        while (i < end) {
            val c = text[i]
            val cp = if (Character.isHighSurrogate(c) && i + 1 < text.length && Character.isLowSurrogate(text[i + 1])) Character.toCodePoint(c, text[i + 1]) else c.code
            val units = Character.charCount(cp)
            val size = when { cp < 0x80 -> 1; cp < 0x800 -> 2; cp < 0x10000 -> 3; else -> 4 }
            if (bytes + size > MAX_BYTES || i + units > end) { end = i; break }
            bytes += size
            i += units
        }
        if (end < text.length && end > 0 && Character.isHighSurrogate(text[end - 1])) end--
        return Capped(text.substring(0, end), end < text.length)
    }
}

/** Fields the host adds to `hello`; each is null when an older host did not send it. */
data class HelloExtras(val locked: Boolean?, val audio: Boolean?, val fps: Int?)

/** Host-to-phone messages added in protocol v1.1 (clipboard, cursor, lock state). Unknown or malformed ones give null. */
sealed interface HostEvent {
    data class Clip(val text: String) : HostEvent
    data class Cursor(val x: Float, val y: Float) : HostEvent
    data class Locked(val on: Boolean) : HostEvent
}

object HostEvents {
    fun parse(m: JSONObject): HostEvent? = when (m.optString("t")) {
        "clip" -> if (m.has("s") && !m.isNull("s")) m.optString("s").let { s ->
            if (s.isEmpty()) null else HostEvent.Clip(ClipLimits.cap(s).text)
        } else null
        "cur" -> {
            val x = m.optDouble("x", Double.NaN)
            val y = m.optDouble("y", Double.NaN)
            if (x.isNaN() || y.isNaN() || x.isInfinite() || y.isInfinite()) null
            else HostEvent.Cursor(x.toFloat().coerceIn(0f, 1f), y.toFloat().coerceIn(0f, 1f))
        }
        "locked" -> HostEvent.Locked(m.optBoolean("on", false))
        else -> null
    }

    fun helloExtras(m: JSONObject) = HelloExtras(
        locked = if (m.has("locked")) m.optBoolean("locked") else null,
        audio = if (m.has("audio")) m.optBoolean("audio") else null,
        fps = m.optInt("fps", 0).takeIf { it > 0 },
    )
}
