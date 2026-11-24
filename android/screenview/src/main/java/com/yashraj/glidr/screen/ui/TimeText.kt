package com.yashraj.glidr.screen.ui

/** Pure text helpers for the screens, unit-tested. */
object TimeText {
    /** "just now", "5 min ago", "3 h ago", "2 d ago" for [then] seen from [now] (both epoch milliseconds). */
    fun ago(now: Long, then: Long): String {
        val s = ((now - then) / 1000).coerceAtLeast(0)
        return when {
            s < 60 -> "just now"
            s < 3600 -> "${s / 60} min ago"
            s < 86_400 -> "${s / 3600} h ago"
            else -> "${s / 86_400} d ago"
        }
    }

    /** Splits a failure message into a short headline (first sentence) and the explanation that follows it. */
    fun splitReason(reason: String): Pair<String, String> {
        val i = reason.indexOf(". ")
        return if (i in 8..90) reason.substring(0, i + 1) to reason.substring(i + 2).trim() else reason to ""
    }

    /** Subtitle of a paired PC in the list. */
    fun lastConnected(now: Long, lastLive: Long): String =
        if (lastLive <= 0) "Not connected yet" else "Last connected ${ago(now, lastLive)}"
}
