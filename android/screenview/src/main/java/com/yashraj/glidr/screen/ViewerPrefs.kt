package com.yashraj.glidr.screen

import android.content.Context

/** Viewer preferences. Plain data so the UI can copy-and-update it. */
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
)

class ViewerPrefsStore(context: Context) {
    private val p = context.applicationContext.getSharedPreferences("glidr_screen_prefs", Context.MODE_PRIVATE)

    fun load(): ViewerPrefs {
        val d = ViewerPrefs()
        return ViewerPrefs(
            p.getFloat("sens", d.sensitivity), p.getInt("accel", d.accel), p.getFloat("scroll", d.scrollSpeed),
            p.getBoolean("natural", d.naturalScroll), p.getBoolean("direct", d.directTouch), p.getBoolean("haptics", d.haptics),
            p.getBoolean("stats", d.showStats), p.getBoolean("light", d.light), p.getInt("accent", d.accent),
        )
    }

    fun save(v: ViewerPrefs) {
        p.edit()
            .putFloat("sens", v.sensitivity).putInt("accel", v.accel).putFloat("scroll", v.scrollSpeed)
            .putBoolean("natural", v.naturalScroll).putBoolean("direct", v.directTouch).putBoolean("haptics", v.haptics)
            .putBoolean("stats", v.showStats).putBoolean("light", v.light).putInt("accent", v.accent)
            .apply()
    }
}
