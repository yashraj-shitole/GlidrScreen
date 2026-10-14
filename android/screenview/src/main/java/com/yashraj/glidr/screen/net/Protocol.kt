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
    fun quality(q: Quality) = JSONObject().put("t", "quality").put("p", q.wire)
}
