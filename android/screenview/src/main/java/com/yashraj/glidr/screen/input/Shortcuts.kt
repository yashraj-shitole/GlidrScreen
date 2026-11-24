package com.yashraj.glidr.screen.input

/** One user-defined shortcut: a label and the keys sent together (modifiers first, then one key). */
data class CustomShortcut(val label: String, val keys: List<String>, val pinned: Boolean = false) {
    /** "Ctrl+Shift+Esc". */
    val describe: String get() = keys.joinToString("+")
}

/** The key names the PC knows (the `VK` table in host/src/input.js plus single letters and digits). */
object HostKeys {
    val MODIFIERS = listOf("Ctrl", "Alt", "Shift", "Win")
    val LETTERS = ('A'..'Z').map { it.toString() }
    val DIGITS = ('0'..'9').map { it.toString() }
    val PUNCTUATION = listOf(";", "=", ",", "-", ".", "/", "`", "[", "\\", "]", "'")
    val FUNCTION = (1..24).map { "F$it" }
    val NAVIGATION = listOf("Enter", "Esc", "Tab", "Space", "Backspace", "Del", "Ins", "Home", "End", "PgUp", "PgDn", "Left", "Up", "Right", "Down")
    private val OTHER = listOf("PrtSc", "Pause", "CapsLock", "NumLock", "ScrollLock", "Menu", "Mute", "VolDown", "VolUp", "Next", "Prev", "Stop", "PlayPause")

    /** The keys the shortcut editor offers: the common ones, not all of them. */
    val PICKER = LETTERS + DIGITS + NAVIGATION + FUNCTION.take(12) + listOf("PrtSc") + PUNCTUATION

    private val canonical: Map<String, String> =
        (MODIFIERS + LETTERS + DIGITS + PUNCTUATION + FUNCTION + NAVIGATION + OTHER).associateBy { it.lowercase() }

    /** The host's spelling of [name] ("ctrl" -> "Ctrl", "c" -> "C"), or null when the PC would not know it. */
    fun normalise(name: String): String? = canonical[name.trim().lowercase()]
    fun isModifier(name: String) = name in MODIFIERS
}

enum class ShortcutError(val message: String) {
    EmptyLabel("Give it a name."),
    LabelTooLong("Names are at most 16 characters."),
    NoKey("Pick a key."),
    OneKeyOnly("Use modifiers plus one other key."),
    UnknownKey("The PC does not know that key."),
}

object Shortcuts {
    const val MAX = 12
    const val MAX_PINNED = 4
    const val MAX_LABEL = 16

    /** Cleans [keys] to the host's spelling, modifiers first (in Ctrl, Alt, Shift, Win order) and then the key; null if invalid. */
    fun normaliseKeys(keys: List<String>): List<String>? {
        val names = keys.map { HostKeys.normalise(it) ?: return null }.distinct()
        val mods = HostKeys.MODIFIERS.filter { it in names }
        val rest = names.filterNot { HostKeys.isModifier(it) }
        if (rest.size > 1 || names.isEmpty()) return null
        return mods + rest
    }

    fun validate(label: String, keys: List<String>): ShortcutError? {
        val name = label.trim()
        return when {
            name.isEmpty() -> ShortcutError.EmptyLabel
            name.length > MAX_LABEL -> ShortcutError.LabelTooLong
            keys.isEmpty() -> ShortcutError.NoKey
            keys.any { HostKeys.normalise(it) == null } -> ShortcutError.UnknownKey
            normaliseKeys(keys) == null -> ShortcutError.OneKeyOnly
            else -> null
        }
    }

    /** A cleaned-up shortcut, or null when [validate] would refuse it. */
    fun create(label: String, keys: List<String>, pinned: Boolean = false): CustomShortcut? =
        if (validate(label, keys) != null) null else CustomShortcut(label.trim(), normaliseKeys(keys)!!, pinned)

    /** Adds [s] to the end; null when the list is full. A new pinned shortcut is unpinned if four are already pinned. */
    fun add(list: List<CustomShortcut>, s: CustomShortcut): List<CustomShortcut>? {
        if (list.size >= MAX) return null
        val pin = s.pinned && list.count { it.pinned } < MAX_PINNED
        return list + s.copy(pinned = pin)
    }

    /** Flips the favourite flag; refuses (returns the list unchanged) when four are already pinned. */
    fun togglePin(list: List<CustomShortcut>, index: Int): List<CustomShortcut> {
        val s = list.getOrNull(index) ?: return list
        if (!s.pinned && list.count { it.pinned } >= MAX_PINNED) return list
        return list.mapIndexed { i, x -> if (i == index) x.copy(pinned = !x.pinned) else x }
    }

    fun remove(list: List<CustomShortcut>, index: Int): List<CustomShortcut> = list.filterIndexed { i, _ -> i != index }

    /** The favourites shown in the deck row, in list order. */
    fun pinned(list: List<CustomShortcut>): List<CustomShortcut> = list.filter { it.pinned }.take(MAX_PINNED)

    // ---------------------------------------------------------------- JSON (kept dependency-free so it is unit-testable)

    fun toJson(list: List<CustomShortcut>): String = list.joinToString(",", "[", "]") { s ->
        "{\"l\":${quote(s.label)},\"k\":[${s.keys.joinToString(",") { quote(it) }}],\"p\":${s.pinned}}"
    }

    /** Reads what [toJson] wrote. Entries that are broken or no longer valid are dropped, never a crash. */
    fun fromJson(text: String?): List<CustomShortcut> {
        if (text.isNullOrBlank()) return emptyList()
        val root = try { MiniJson(text).parseTop() } catch (_: Exception) { return emptyList() }
        val arr = root as? List<*> ?: return emptyList()
        val out = ArrayList<CustomShortcut>()
        var pins = 0
        for (item in arr) {
            val o = item as? Map<*, *> ?: continue
            val label = o["l"] as? String ?: continue
            val keys = (o["k"] as? List<*>)?.map { it as? String ?: "" } ?: continue
            val wantPin = o["p"] == true
            val s = create(label, keys, wantPin && pins < MAX_PINNED) ?: continue
            if (s.pinned) pins++
            out += s
            if (out.size == MAX) break
        }
        return out
    }

    private fun quote(s: String): String {
        val b = StringBuilder("\"")
        for (ch in s) when {
            ch == '"' -> b.append("\\\"")
            ch == '\\' -> b.append("\\\\")
            ch < ' ' -> b.append("\\u%04x".format(ch.code))
            else -> b.append(ch)
        }
        return b.append('"').toString()
    }
}

/** Just enough JSON to read the shortcut list: objects, arrays, strings, numbers, booleans, null. */
private class MiniJson(private val s: String) {
    private var i = 0

    fun parseTop(): Any? {
        val v = value()
        ws()
        if (i != s.length) error("trailing data")
        return v
    }

    private fun ws() { while (i < s.length && s[i].isWhitespace()) i++ }

    private fun value(): Any? {
        ws()
        return when (val c = s.getOrNull(i) ?: error("eof")) {
            '{' -> obj()
            '[' -> arr()
            '"' -> str()
            't' -> lit("true", true)
            'f' -> lit("false", false)
            'n' -> lit("null", null)
            else -> if (c == '-' || c.isDigit()) num() else error("unexpected $c")
        }
    }

    private fun lit(word: String, v: Any?): Any? {
        if (!s.startsWith(word, i)) error("bad literal")
        i += word.length
        return v
    }

    private fun num(): Any {
        val start = i
        while (i < s.length && (s[i].isDigit() || s[i] in "+-.eE")) i++
        return s.substring(start, i).toDouble()
    }

    private fun str(): String {
        i++ // opening quote
        val b = StringBuilder()
        while (true) {
            val c = s.getOrNull(i++) ?: error("unterminated string")
            when (c) {
                '"' -> return b.toString()
                '\\' -> when (val e = s.getOrNull(i++) ?: error("bad escape")) {
                    'n' -> b.append('\n')
                    't' -> b.append('\t')
                    'r' -> b.append('\r')
                    'b' -> b.append('\b')
                    'f' -> b.append('\u000c')
                    'u' -> { b.append(s.substring(i, i + 4).toInt(16).toChar()); i += 4 }
                    else -> b.append(e)
                }
                else -> b.append(c)
            }
        }
    }

    private fun arr(): List<Any?> {
        i++
        val out = ArrayList<Any?>()
        ws()
        if (s.getOrNull(i) == ']') { i++; return out }
        while (true) {
            out += value()
            ws()
            when (s.getOrNull(i++)) { ',' -> {}; ']' -> return out; else -> error("bad array") }
        }
    }

    private fun obj(): Map<String, Any?> {
        i++
        val out = LinkedHashMap<String, Any?>()
        ws()
        if (s.getOrNull(i) == '}') { i++; return out }
        while (true) {
            ws()
            if (s.getOrNull(i) != '"') error("key expected")
            val k = str()
            ws()
            if (s.getOrNull(i++) != ':') error("colon expected")
            out[k] = value()
            ws()
            when (s.getOrNull(i++)) { ',' -> {}; '}' -> return out; else -> error("bad object") }
        }
    }
}
