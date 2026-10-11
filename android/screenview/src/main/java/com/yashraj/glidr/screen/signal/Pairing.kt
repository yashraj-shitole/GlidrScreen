package com.yashraj.glidr.screen.signal

import android.content.Context
import java.net.URLDecoder
import org.json.JSONArray
import org.json.JSONObject
import java.util.Base64

const val DEFAULT_SIGNAL_BASE = "https://ntfy.sh"

/** A PC this phone can connect to. [key] is the 128-bit pairing secret (base64url). */
data class PairedPc(
    val id: String,
    val name: String,
    val key: String,
    val signalBase: String = DEFAULT_SIGNAL_BASE,
    val lastUsed: Long = 0L,
) {
    val keyBytes: ByteArray get() = Base64.getUrlDecoder().decode(key)
}

/** What a pairing QR / link / typed code carries. */
data class PairingInfo(val key: ByteArray, val hostName: String, val signalBase: String)

object PairingParser {
    /** Accepts `glidr://screen?v=1&k=...&n=...&s=...` links or the 26-character manual code. */
    fun parse(text: String): PairingInfo? {
        val t = text.trim()
        if (t.startsWith("glidr://", ignoreCase = true)) return fromLink(t)
        return fromCode(t)
    }

    private fun fromLink(link: String): PairingInfo? = try {
        val q = link.substringAfter('?', "").substringBefore('#').split('&').filter { it.contains('=') }
            .associate { it.substringBefore('=') to URLDecoder.decode(it.substringAfter('='), "UTF-8") }
        val key = Base64.getUrlDecoder().decode(q["k"] ?: return null)
        if (key.size != 16) null else PairingInfo(
            key,
            q["n"]?.take(40)?.ifBlank { null } ?: "PC",
            q["s"]?.takeIf { it.startsWith("https://") || it.startsWith("http://") } ?: DEFAULT_SIGNAL_BASE,
        )
    } catch (_: Exception) {
        null
    }

    private fun fromCode(code: String): PairingInfo? {
        val clean = code.filter { it.isLetterOrDigit() }
        if (clean.length < 26 || clean.any { it.lowercaseChar() !in "abcdefghijklmnopqrstuvwxyz234567" }) return null
        val key = SignalCrypto.unbase32(clean.take(26))
        return if (key.size >= 16) PairingInfo(key.copyOf(16), "PC", DEFAULT_SIGNAL_BASE) else null
    }
}

/** Paired PCs, kept in app-private storage (no backup, see the manifest). */
class PairingStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("glidr_screen_pairs", Context.MODE_PRIVATE)

    fun load(): List<PairedPc> = try {
        val arr = JSONArray(prefs.getString("pcs", "[]"))
        (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            PairedPc(o.getString("id"), o.getString("name"), o.getString("key"), o.optString("base", DEFAULT_SIGNAL_BASE), o.optLong("used"))
        }.sortedByDescending { it.lastUsed }
    } catch (_: Exception) {
        emptyList()
    }

    private fun save(list: List<PairedPc>) {
        val arr = JSONArray()
        list.forEach {
            arr.put(JSONObject().put("id", it.id).put("name", it.name).put("key", it.key).put("base", it.signalBase).put("used", it.lastUsed))
        }
        prefs.edit().putString("pcs", arr.toString()).apply()
    }

    /** Adds (or replaces, when the same key is paired again) and returns the stored PC. */
    fun add(info: PairingInfo): PairedPc {
        val key = Base64.getUrlEncoder().withoutPadding().encodeToString(info.key)
        val existing = load()
        val pc = PairedPc(key.take(8), info.hostName, key, info.signalBase, System.currentTimeMillis())
        save(existing.filterNot { it.key == key } + pc)
        return pc
    }

    fun touch(pc: PairedPc) = save(load().map { if (it.id == pc.id) it.copy(lastUsed = System.currentTimeMillis()) else it })
    fun rename(pc: PairedPc, name: String) = save(load().map { if (it.id == pc.id) it.copy(name = name) else it })
    fun remove(pc: PairedPc) = save(load().filterNot { it.id == pc.id })
}
