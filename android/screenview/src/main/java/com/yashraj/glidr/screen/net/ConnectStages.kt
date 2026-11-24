package com.yashraj.glidr.screen.net

/** How far a connection attempt got, in plain words, so a failure can say where it stopped. */
object ConnectStages {
    const val SIGNALING = "Reached the signaling server"
    const val REQUEST_SENT = "Request sent to the PC"
    const val OFFER = "PC answered with an offer"
    const val DIRECT = "Opened the direct connection"

    /** The extra line on the failure screen, or null when the attempt did not get anywhere (the reason already says so). */
    fun failureLine(stage: String): String? = stage.trim().takeIf { it.isNotEmpty() }?.let { "Got as far as: $it" }
}
