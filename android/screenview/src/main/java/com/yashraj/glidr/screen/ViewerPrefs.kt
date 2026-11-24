package com.yashraj.glidr.screen

import android.content.Context
import com.yashraj.glidr.screen.input.CustomShortcut
import com.yashraj.glidr.screen.input.ProfileKeys
import com.yashraj.glidr.screen.input.Shortcuts

/**
 * Viewer preferences. Plain data so the UI can copy-and-update it.
 *
 * The input fields (speed, scrolling, trackpad zones, handedness) are kept per paired PC, see [ViewerPrefsStore.loadFor];
 * the look and the shortcut deck are shared by every PC.
 */
data class ViewerPrefs(
    val sensitivity: Float = 1.4f,
    val accel: Int = 2, // 0 off, 1 low, 2 medium, 3 high
    val scrollSpeed: Float = 1.0f,
    val naturalScroll: Boolean = true,
    val directTouch: Boolean = false, // tap the picture to click there instead of using the trackpad
    val haptics: Boolean = true,
    val showStats: Boolean = true,
    val light: Boolean = false,
    val accent: Int = 0,
    val edgeScroll: Boolean = false, // bottom strip of the pad scrolls sideways
    val cornerClick: Boolean = false, // bottom-right corner tap = right-click
    val precision: Boolean = false, // a second finger resting on the pad slows the pointer
    val leftHanded: Boolean = false, // scroll strip and (one-handed) monitor chips on the left
    val oneHanded: Boolean = false, // monitor chips move into the tool row, within thumb reach
    val simpleGestures: Boolean = false, // on-screen Middle / Scroll buttons for people who cannot use multi-finger gestures
    val panelCollapsed: Boolean = false, // landscape controls panel folded to an edge handle
    val shortcuts: List<CustomShortcut> = emptyList(),
) {
    /** This with the per-PC input fields of [o]. */
    fun withInputFrom(o: ViewerPrefs) = copy(
        sensitivity = o.sensitivity, accel = o.accel, scrollSpeed = o.scrollSpeed, naturalScroll = o.naturalScroll,
        directTouch = o.directTouch, edgeScroll = o.edgeScroll, cornerClick = o.cornerClick, precision = o.precision,
        leftHanded = o.leftHanded, oneHanded = o.oneHanded, simpleGestures = o.simpleGestures,
    )

    /** This with the shared fields (look, haptics, deck, panel) of [o]. */
    fun withSharedFrom(o: ViewerPrefs) = copy(
        haptics = o.haptics, showStats = o.showStats, light = o.light, accent = o.accent,
        panelCollapsed = o.panelCollapsed, shortcuts = o.shortcuts,
    )
}

class ViewerPrefsStore(context: Context) {
    private val p = context.applicationContext.getSharedPreferences("glidr_screen_prefs", Context.MODE_PRIVATE)

    /** Everything, as the global default: also what a PC that has no settings of its own yet starts from. */
    fun load(): ViewerPrefs {
        val d = ViewerPrefs()
        return readInput(null, d).copy(
            haptics = p.getBoolean("haptics", d.haptics), showStats = p.getBoolean("stats", d.showStats),
            light = p.getBoolean("light", d.light), accent = p.getInt("accent", d.accent),
            panelCollapsed = p.getBoolean("panel_collapsed", d.panelCollapsed),
            shortcuts = Shortcuts.fromJson(p.getString("shortcuts", null)),
        )
    }

    fun save(v: ViewerPrefs) {
        val e = p.edit()
        writeInput(e, null, v)
        e.putBoolean("haptics", v.haptics).putBoolean("stats", v.showStats).putBoolean("light", v.light).putInt("accent", v.accent)
            .putBoolean("panel_collapsed", v.panelCollapsed).putString("shortcuts", Shortcuts.toJson(v.shortcuts))
            .apply()
    }

    /**
     * The input settings of one paired PC (looked up by [pcId]). The first time a PC is seen it inherits the global
     * settings from before per-PC profiles existed, and keeps its own copy from then on.
     */
    fun loadFor(pcId: String): ViewerPrefs {
        val global = load()
        if (!p.contains(ProfileKeys.key(pcId, "sens"))) {
            saveFor(pcId, global)
            return global
        }
        return readInput(pcId, global)
    }

    fun saveFor(pcId: String, v: ViewerPrefs) {
        val e = p.edit()
        writeInput(e, pcId, v)
        e.apply()
    }

    /** Forgets a PC's own settings (called when the PC is unpaired). */
    fun removeFor(pcId: String) {
        val e = p.edit()
        p.all.keys.filter { it.startsWith(ProfileKeys.key(pcId, "")) }.forEach { e.remove(it) }
        e.apply()
    }

    private fun k(pcId: String?, name: String) = if (pcId == null) name else ProfileKeys.key(pcId, name)

    private fun readInput(pcId: String?, d: ViewerPrefs) = d.copy(
        sensitivity = p.getFloat(k(pcId, "sens"), d.sensitivity), accel = p.getInt(k(pcId, "accel"), d.accel),
        scrollSpeed = p.getFloat(k(pcId, "scroll"), d.scrollSpeed), naturalScroll = p.getBoolean(k(pcId, "natural"), d.naturalScroll),
        directTouch = p.getBoolean(k(pcId, "direct"), d.directTouch), edgeScroll = p.getBoolean(k(pcId, "edge"), d.edgeScroll),
        cornerClick = p.getBoolean(k(pcId, "corner"), d.cornerClick), precision = p.getBoolean(k(pcId, "precision"), d.precision),
        leftHanded = p.getBoolean(k(pcId, "left"), d.leftHanded), oneHanded = p.getBoolean(k(pcId, "onehand"), d.oneHanded),
        simpleGestures = p.getBoolean(k(pcId, "simple"), d.simpleGestures),
    )

    private fun writeInput(e: android.content.SharedPreferences.Editor, pcId: String?, v: ViewerPrefs) {
        e.putFloat(k(pcId, "sens"), v.sensitivity).putInt(k(pcId, "accel"), v.accel).putFloat(k(pcId, "scroll"), v.scrollSpeed)
            .putBoolean(k(pcId, "natural"), v.naturalScroll).putBoolean(k(pcId, "direct"), v.directTouch)
            .putBoolean(k(pcId, "edge"), v.edgeScroll).putBoolean(k(pcId, "corner"), v.cornerClick)
            .putBoolean(k(pcId, "precision"), v.precision).putBoolean(k(pcId, "left"), v.leftHanded)
            .putBoolean(k(pcId, "onehand"), v.oneHanded).putBoolean(k(pcId, "simple"), v.simpleGestures)
    }
}
