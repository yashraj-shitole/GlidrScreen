package com.yashraj.glidr.screen.net

/** How far a connection attempt got, in plain words, so a failure can say where it stopped. */
object ConnectStages {
    const val SIGNALING = "Reached the signaling server"
    const val LAN = "Reached the PC on the local network"
    const val REQUEST_SENT = "Request sent to the PC"
    const val OFFER = "PC answered with an offer"
    const val DIRECT = "Opened the direct connection"

    private fun rank(stage: String): Int = when (stage) {
        SIGNALING, LAN -> 1
        REQUEST_SENT -> 2
        OFFER -> 3
        DIRECT -> 4
        else -> 0
    }

    /** The stage to show when [next] was reached while [current] was already known: it never moves backwards, and the first of two equal stages (LAN or public server) stays. */
    fun furthest(current: String, next: String): String = if (rank(next) > rank(current)) next else current

    /** The extra line on the failure screen, or null when the attempt did not get anywhere (the reason already says so). */
    fun failureLine(stage: String): String? = stage.trim().takeIf { it.isNotEmpty() }?.let { "Got as far as: $it" }
}
