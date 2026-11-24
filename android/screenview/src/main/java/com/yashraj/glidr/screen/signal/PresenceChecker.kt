package com.yashraj.glidr.screen.signal

import com.yashraj.glidr.screen.ui.TimeText
import kotlinx.coroutines.CancellationException

/** What the PC last said about itself (see "Presence" in docs/PROTOCOL.md). */
enum class PresenceState(val wire: String) {
    Online("online"), Sleep("sleep"), Paused("paused"), Quit("quit");

    companion object {
        fun fromWire(s: String): PresenceState? = values().firstOrNull { it.wire == s }
    }
}

/**
 * The newest authentic marker of a PC. [ageMs] is how old it was when it was read at [checkedAt] (epoch ms), so the text
 * can keep counting up while the list stays on screen. [checkedAt] 0 means "read just now".
 */
data class PcPresence(val state: PresenceState, val ageMs: Long, val checkedAt: Long = 0L)

/** Short plain text for a [PcPresence], unit-tested. */
object PresenceText {
    /** The host sends 'online' every 5 minutes; a marker older than this probably means the app stopped. */
    const val FRESH_MS = 7 * 60_000L
    const val NONE = "No sign of the PC in the last 12 hours"

    fun describe(presence: PcPresence?, nowMs: Long): String {
        if (presence == null) return NONE
        val age = presence.ageMs + if (presence.checkedAt > 0) (nowMs - presence.checkedAt).coerceAtLeast(0) else 0L
        return when (presence.state) {
            PresenceState.Online -> if (age < FRESH_MS) "PC online" else "Last seen ${TimeText.ago(age, 0)}"
            PresenceState.Sleep -> "PC went to sleep ${TimeText.ago(age, 0)}"
            PresenceState.Paused -> "Sharing paused on the PC"
            PresenceState.Quit -> "Glidr Screen was closed ${TimeText.ago(age, 0)}"
        }
    }
}

/** One-shot "last seen" lookup. Reads the topic's cached messages once; never polls in the background. */
object PresenceChecker {
    /** The newest authentic presence from the PC among [recent], or null. Pure, so it is unit-tested. */
    fun newest(recent: List<RecentMessage>, nowMs: Long): PcPresence? {
        var bestAt = Long.MIN_VALUE
        var best: PresenceState? = null
        for (m in recent) {
            val j = m.json
            if (j.optString("t") != "presence" || j.optString("from") != "h") continue
            val state = PresenceState.fromWire(j.optString("state")) ?: continue
            // the sealed ts is the PC's own clock; a missing or future one falls back to the server's receive time
            val ts = j.optLong("ts", 0L)
            val at = if (ts > 0 && ts <= nowMs + CLOCK_SLACK_MS) ts else m.serverTimeMs
            if (at <= 0) continue
            if (at >= bestAt) { bestAt = at; best = state }
        }
        return best?.let { PcPresence(it, (nowMs - bestAt).coerceAtLeast(0), nowMs) }
    }

    /** Looks [pc] up on its rendezvous server. Network errors and an empty topic both give null; never throws. */
    suspend fun check(pc: PairedPc, nowMs: () -> Long = System::currentTimeMillis): PcPresence? = try {
        newest(NtfySignaling(pc.signalBase, pc.keyBytes).recentMessages(), nowMs())
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    }

    private const val CLOCK_SLACK_MS = 60_000L
}
