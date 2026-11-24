package com.yashraj.glidr.screen.input

import com.yashraj.glidr.screen.ViewerPrefs
import kotlin.math.abs

/** One-tap pointer feel presets in the settings sheet. They only set speed, acceleration and scroll speed. */
enum class InputProfile(val label: String, val sensitivity: Float, val accel: Int, val scrollSpeed: Float) {
    Reading("Reading", 1.0f, 1, 0.8f),
    Precision("Precision", 0.7f, 0, 0.6f),
    Presentation("Presentation", 2.2f, 3, 1.5f),
}

fun ViewerPrefs.withProfile(p: InputProfile): ViewerPrefs = copy(sensitivity = p.sensitivity, accel = p.accel, scrollSpeed = p.scrollSpeed)

/** The preset these settings equal, or null once the user tuned a slider by hand. */
fun ViewerPrefs.matchingProfile(): InputProfile? = InputProfile.entries.firstOrNull {
    abs(sensitivity - it.sensitivity) < 0.05f && accel == it.accel && abs(scrollSpeed - it.scrollSpeed) < 0.05f
}

/** SharedPreferences keys for the per-PC input settings: one set per pairing id. */
object ProfileKeys {
    fun key(pcId: String, field: String) = "pc_${pcId.filter { it.isLetterOrDigit() || it == '-' || it == '_' }}_$field"
}
