package com.yashraj.glidr.screen.net

/** The two places a connection attempt can exchange its sealed messages with the PC. */
enum class SignalRoute { LAN, PUBLIC }

/**
 * Decides when the public signaling server (ntfy.sh by default) is needed. A PC that shared a LAN address is tried on
 * the local network FIRST; the public server, whose anonymous message quota is small, joins in only when
 *
 *  - the LAN route failed (could not connect, or the request could not be posted), or
 *  - [graceMs] have passed since the attempt began without an offer.
 *
 * Whichever route delivers the offer first is the one used for the rest of the attempt. A PC without a LAN address
 * uses the public server from the start, exactly as before LAN signaling existed.
 *
 * Pure logic with an injected [clock] (milliseconds, monotonic), so the timing is unit tested without waiting.
 */
class RoutePlanner(
    private val hasLan: Boolean,
    private val clock: () -> Long,
    val graceMs: Long = LAN_GRACE_MS,
) {
    private var startedAt = 0L
    private var failed = false

    /** The route that delivered the offer, once there is one. Later offers never change it. */
    var winner: SignalRoute? = null
        private set

    /** Marks the start of an attempt. */
    fun begin() {
        startedAt = clock()
        failed = false
        winner = null
    }

    /** The LAN route is dead for this attempt: the public server is needed right now. */
    fun onLanFailed() {
        failed = true
    }

    /** True while the LAN route may still deliver (it exists and has not failed). */
    val lanViable: Boolean get() = hasLan && !failed

    /** Is the public server needed now? */
    fun publicDue(): Boolean = !lanViable || clock() - startedAt >= graceMs

    /** How long to keep waiting on the LAN alone before [publicDue] turns true (0 when it already is). */
    fun publicDelayMs(): Long = if (publicDue()) 0L else (graceMs - (clock() - startedAt)).coerceAtLeast(0L)

    /** An offer arrived on [route]. Returns the route the attempt uses: the first one that delivered. */
    fun onOffer(route: SignalRoute): SignalRoute = winner ?: route.also { winner = it }

    companion object {
        /** How long the LAN gets on its own before the public server also receives the request. */
        const val LAN_GRACE_MS = 4_000L
    }
}
