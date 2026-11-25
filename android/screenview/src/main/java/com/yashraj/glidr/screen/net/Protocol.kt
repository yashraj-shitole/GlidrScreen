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

/** What the phone is looking at: a whole monitor or one application window. [wire] is the `kind` of `source` / `active`. */
enum class SourceKind(val wire: String) { Monitor("monitor"), Window("window") }

/**
 * One application window of the PC that can be shared (`windows` list). [id] is an opaque token from the host and
 * [title] is untrusted text from another program: show it as plain text only, never use it for anything else.
 */
data class PcWindow(val id: String, val title: String, val w: Int, val h: Int) {
    companion object {
        const val MAX_WINDOWS = 30
        const val MAX_TITLE = 80
        private const val MAX_ID = 200

        /** Tolerant: entries without a text `id` are dropped, titles lose control characters and are cut to [MAX_TITLE] characters. */
        fun parseAll(arr: JSONArray?): List<PcWindow> {
            if (arr == null) return emptyList()
            val out = ArrayList<PcWindow>()
            for (i in 0 until arr.length()) {
                if (out.size >= MAX_WINDOWS) break
                val o = arr.optJSONObject(i) ?: continue
                val id = o.opt("id") as? String ?: continue
                if (id.isEmpty() || id.length > MAX_ID) continue
                out += PcWindow(id, cleanTitle(o.opt("title") as? String), o.optInt("w"), o.optInt("h"))
            }
            return out
        }

        /** Control characters become spaces, the text is trimmed and cut to [MAX_TITLE] code points (never inside an emoji). */
        fun cleanTitle(raw: String?): String {
            if (raw == null) return ""
            val t = raw.replace(Regex("[\\p{Cc}\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]+"), " ").trim()
            return if (t.codePointCount(0, t.length) <= MAX_TITLE) t else t.substring(0, t.offsetByCodePoints(0, MAX_TITLE)).trimEnd()
        }
    }
}

/** A `wthumb` preview of one window: [jpg] is base64. Oversized or malformed ones give null. */
data class WindowThumb(val id: String, val jpg: String) {
    companion object {
        private const val MAX_JPG_CHARS = 300_000

        fun parse(m: JSONObject): WindowThumb? {
            val id = m.opt("id") as? String ?: return null
            val jpg = m.opt("jpg") as? String ?: return null
            return if (id.isEmpty() || jpg.isEmpty() || jpg.length > MAX_JPG_CHARS) null else WindowThumb(id, jpg)
        }
    }
}

/** The host's `active` message: the shared source is now a monitor (older hosts, no `kind`) or a window. */
sealed interface ActiveSource {
    data class Display(val id: Long, val w: Int, val h: Int) : ActiveSource
    data class Window(val id: String, val title: String, val w: Int, val h: Int) : ActiveSource

    companion object {
        fun parse(m: JSONObject): ActiveSource? = when (m.optString("kind", "monitor")) {
            "window" -> {
                val id = m.opt("id") as? String
                if (id.isNullOrEmpty()) null else Window(id, PcWindow.cleanTitle(m.opt("title") as? String), m.optInt("w"), m.optInt("h"))
            }
            else -> Display(m.optLong("id"), m.optInt("w"), m.optInt("h"))
        }
    }
}

/** The host could not share the requested window (`source-error`). */
data class SourceError(val id: String, val reason: String) {
    /** Text for the person looking at the phone. */
    val message: String get() = if (reason == "gone") "That window is gone" else "Could not share that window"

    companion object {
        fun parse(m: JSONObject): SourceError? =
            if (m.optString("t") == "source-error") SourceError(m.optString("id"), m.optString("reason", "gone")) else null
    }
}

enum class Quality(val wire: String, val label: String) {
    Auto("auto", "Auto"), Low("low", "540p"), Balanced("balanced", "720p"), High("high", "1440p");

    companion object { fun of(wire: String?) = entries.firstOrNull { it.wire == wire } ?: Auto }
}

/** What the PC encoder favours: the optional `mode` of the `quality` message. */
enum class StreamMode(val wire: String, val label: String) {
    Auto("auto", "Auto"), Fast("latency", "Fast"), Sharp("clarity", "Sharp");

    companion object { fun of(wire: String?) = entries.firstOrNull { it.wire == wire } ?: Auto }
}

enum class MouseButton(val wire: String) { Left("l"), Right("r"), Middle("m") }

/** Video codecs this phone reports it can decode (`req.dec`); the PC only offers codecs from the list. */
object VideoDecoders {
    /** The only names the PC understands, lower case, in the order they are reported. */
    val KNOWN = listOf("h264", "vp8", "vp9", "av1")

    /**
     * Maps WebRTC `VideoCodecInfo.name` values ("H264", "VP8", "VP9", "AV1", maybe others) to the protocol names:
     * lower-cased, de-duplicated, only the four known ones, in the fixed [KNOWN] order.
     */
    fun names(codecNames: Iterable<String>): List<String> {
        val have = codecNames.map { it.trim().lowercase() }.toSet()
        return KNOWN.filter { it in have }
    }
}

/** The `req` signaling message (see docs/PROTOCOL.md). [decoders] are protocol names, see [VideoDecoders]. */
object SignalMsg {
    fun request(sid: String, ts: Long, name: String, decoders: List<String>): JSONObject {
        val m = JSONObject().put("t", "req").put("from", "p").put("sid", sid).put("ts", ts).put("n", name)
        val dec = decoders.filter { it in VideoDecoders.KNOWN }.distinct()
        if (dec.isNotEmpty()) m.put("dec", JSONArray(dec))
        return m
    }
}

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

    /** Start or stop the list (and previews) of the PC's application windows. */
    fun windows(on: Boolean) = JSONObject().put("t", "windows").put("on", on)

    /**
     * Share [id]: a window id from the `windows` list for [SourceKind.Window], or a monitor id (as text) for
     * [SourceKind.Monitor], which the host treats exactly like `monitor`.
     */
    fun source(kind: SourceKind, id: String) = JSONObject().put("t", "source").put("kind", kind.wire).put("id", id)

    /**
     * [fps], [saver] and [mode] are optional on the wire: omitted when null so an older host sees exactly the old
     * message. [mode] is "auto", "latency" or "clarity" (see [StreamMode]); the phone's own default is Auto.
     */
    fun quality(q: Quality, fps: Int? = null, saver: Boolean? = null, mode: StreamMode? = null): JSONObject {
        val o = JSONObject().put("t", "quality").put("p", q.wire)
        if (fps != null) o.put("fps", fps)
        if (saver != null) o.put("saver", saver)
        if (mode != null) o.put("mode", mode.wire)
        return o
    }

    /** Sets the PC clipboard. [s] must already be within [ClipLimits]. */
    fun clip(s: String) = JSONObject().put("t", "clip").put("s", s)

    /** Ask the PC to push its clipboard text changes ([HostEvent.Clip]) while [on]. */
    fun clipsync(on: Boolean) = JSONObject().put("t", "clipsync").put("on", on)

    /** Start or stop the PC cursor position stream ([HostEvent.Cursor], about 30 Hz). */
    fun curs(on: Boolean) = JSONObject().put("t", "curs").put("on", on)

    /**
     * Run the PC's quick action [id]. Only an id is ever sent, never a command (see [QuickAction]). [confirm] is true only
     * after the person confirmed a dangerous action (restart, shut down) on the phone.
     */
    fun action(id: String, confirm: Boolean = false) = JSONObject().put("t", "action").put("id", id).put("confirm", confirm)

    /**
     * Phone camera / microphone: our new offer for the running connection (see [PhoneMediaSession]). The PC answers with
     * `renegotiate-answer` or `renegotiate-error`. The SDP stays under [PHONE_MEDIA_MAX_SDP]; the session checks that first.
     */
    fun renegotiate(sdp: String) = JSONObject().put("t", "renegotiate").put("sdp", sdp)
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

/**
 * One quick action the PC offers (`hello.actions`, `actions`): only an [id] the PC knows, its [label] and whether it is
 * [danger]ous (restart, shut down: the phone asks for confirmation and sends `confirm:true`). The phone never learns
 * what an action runs, and never sends anything but the [id].
 */
data class QuickAction(val id: String, val label: String, val danger: Boolean) {
    companion object {
        const val MAX_ACTIONS = 32
        const val MAX_LABEL = 60
        /** Built-in id of "Cancel shutdown" (`shutdown /a`): the sheet shows it while a restart or shutdown is counting down. */
        const val CANCEL_SHUTDOWN = "cancel-shutdown"
        private val ID = Regex("[a-z0-9-]{1,24}")

        fun validId(id: String?): Boolean = id != null && ID.matches(id)

        /** Tolerant: entries without a valid text `id` are dropped, labels lose control characters and are cut; missing list = none. */
        fun parseAll(arr: JSONArray?): List<QuickAction> {
            if (arr == null) return emptyList()
            val out = ArrayList<QuickAction>()
            val seen = HashSet<String>()
            for (i in 0 until arr.length()) {
                if (out.size >= MAX_ACTIONS) break
                val o = arr.optJSONObject(i) ?: continue
                val id = o.opt("id") as? String ?: continue
                if (!validId(id) || !seen.add(id)) continue
                val label = PcWindow.cleanTitle(o.opt("label") as? String).take(MAX_LABEL).ifBlank { id }
                out += QuickAction(id, label, o.opt("danger") == true)
            }
            return out
        }
    }
}

/** The PC's answer to an `action`. [reason] is one of the host's reasons when [ok] is false, or "offline" (made up by the phone). */
data class ActionResult(val id: String, val ok: Boolean, val reason: String?) {
    /** Text for the person holding the phone. */
    val message: String
        get() = if (ok) (if (id == QuickAction.CANCEL_SHUTDOWN) "Shutdown cancelled" else "Done") else when (reason) {
            "disabled" -> "Switched off on the PC"
            "unknown" -> "No longer available on the PC"
            "view-only" -> "This phone is view only"
            "rate" -> "Too many actions, wait a moment"
            "confirm" -> "Please confirm first"
            "failed" -> "The PC could not run that"
            "offline" -> "Not connected to the PC"
            else -> "The PC did not do that"
        }

    companion object {
        private val REASON = Regex("[a-z-]{1,20}")

        fun parse(m: JSONObject): ActionResult? {
            if (m.optString("t") != "action-result") return null
            val id = m.opt("id") as? String
            if (id == null || !QuickAction.validId(id)) return null
            val ok = m.opt("ok") == true
            val reason = (m.opt("reason") as? String)?.takeIf { REASON.matches(it) }
            return ActionResult(id, ok, if (ok) null else reason)
        }
    }
}
