package com.yashraj.glidr.screen.ui

import android.view.HapticFeedbackConstants
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDecay
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.FloatExponentialDecaySpec
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.systemGestureExclusion
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.yashraj.glidr.screen.ViewerPrefs
import com.yashraj.glidr.screen.net.ScreenClient
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.sin

private const val ZONE_DP = 48 // touch zone of the vertical wheel (same as the Glidr app)
private const val PILL_DP = 32 // the visible pill, centred in the zone
private const val SIDE_ZONE_DP = 40 // the sideways wheel is thinner
private const val SIDE_PILL_DP = 28
private const val TICK_DP = 12f // one tick = one haptic click = this much finger travel
private const val PX_PER_NOTCH = 40f
private const val FLING_MIN_PX_PER_S = 400f

/**
 * Ticks on a cylinder, ported from the Glidr app: evenly spaced marks are laid round a drum, so near the middle they are
 * long and bright, and towards the ends they bunch together, shorten and fade. Moving [offset] turns the drum.
 */
internal fun DrawScope.dialTicks(vertical: Boolean, offset: Float, color: Color, tickLen: Float, step: Float, stroke: Float) {
    val length = if (vertical) size.height else size.width
    val cross = if (vertical) size.width else size.height
    val half = length / 2f
    val thetaMax = 1.45f
    val radius = half / thetaMax
    val norm = sin(thetaMax)
    var u = ((offset % step) + step) % step - ceil(half / step) * step
    while (u <= half) {
        val theta = u / radius
        if (abs(theta) < thetaMax) {
            val c = cos(theta)
            val pos = half + half * (sin(theta) / norm)
            val a = (c * c).coerceIn(0f, 1f)
            val len = tickLen * (0.4f + 0.6f * c)
            val from = (cross - len) / 2f
            val tint = color.copy(alpha = color.alpha * a)
            if (vertical) drawLine(tint, Offset(from, pos), Offset(from + len, pos), strokeWidth = stroke)
            else drawLine(tint, Offset(pos, from), Offset(pos, from + len), strokeWidth = stroke)
        }
        u += step
    }
}

/**
 * The scroll wheel, same as the Glidr app's: a pill with ticks on a turning drum. The ticks follow the finger, each tick
 * clicks (when haptics are on), the pill widens and takes the accent border while held, and a flick keeps it spinning
 * after the finger lifts. [vertical] scrolls up and down (next to the pad); otherwise it scrolls sideways (under the pad).
 */
@Composable
fun ScrollWheel(client: ScreenClient, prefs: ViewerPrefs, vertical: Boolean, modifier: Modifier = Modifier) {
    val c = Gs.colors
    val p by rememberUpdatedState(prefs)
    val view = LocalView.current
    val scope = rememberCoroutineScope()
    var pressed by remember { mutableStateOf(false) }
    var offset by remember { mutableFloatStateOf(0f) }
    var fling by remember { mutableStateOf<Job?>(null) }
    val widen by animateFloatAsState(if (pressed) 1.18f else 1f, tween(120), label = "wheelWiden")
    val border by animateColorAsState(if (pressed) c.accent else c.line, tween(120), label = "wheelBorder")
    val pill = if (vertical) PILL_DP else SIDE_PILL_DP
    val shape = RoundedCornerShape(pill.dp / 2)

    /** Sends [travel] px of finger (or fling) movement to the PC, in wheel notches. */
    fun send(travel: Float) {
        val k = p.scrollSpeed / PX_PER_NOTCH * 1.6f
        if (vertical) client.scrollBy(0f, -travel * k)
        else client.scrollBy(-(if (p.naturalScroll) 1f else -1f) * travel * k, 0f)
    }

    val zone = if (vertical) {
        modifier.width(ZONE_DP.dp).fillMaxHeight()
            // The vertical wheel sits at the screen edge, where Android's back swipe starts: keep that gesture off it.
            .systemGestureExclusion()
    } else {
        modifier.fillMaxWidth().height(SIDE_ZONE_DP.dp)
    }
    Box(
        zone
            .semantics {
                contentDescription = if (vertical) "Scroll wheel. Drag up or down to scroll." else "Sideways scroll wheel. Drag left or right to scroll sideways."
                customActions = if (vertical) listOf(
                    CustomAccessibilityAction("Scroll up") { client.scrollBy(0f, 3f); true },
                    CustomAccessibilityAction("Scroll down") { client.scrollBy(0f, -3f); true },
                ) else listOf(
                    CustomAccessibilityAction("Scroll left") { client.scrollBy(-3f, 0f); true },
                    CustomAccessibilityAction("Scroll right") { client.scrollBy(3f, 0f); true },
                )
            }
            .pointerInput(vertical) {
                val tick = TICK_DP.dp.toPx()
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    if (down.type == PointerType.Mouse) {
                        do { val e = awaitPointerEvent() } while (e.changes.any { it.pressed })
                        return@awaitEachGesture
                    }
                    down.consume()
                    fling?.cancel()
                    pressed = true
                    var sinceTick = 0f
                    val velocity = VelocityTracker()
                    velocity.addPosition(down.uptimeMillis, down.position)
                    try {
                        while (true) {
                            val event = awaitPointerEvent(PointerEventPass.Main)
                            val ch = event.changes.firstOrNull { it.id == down.id }
                            if (ch == null || !ch.pressed) break
                            velocity.addPosition(ch.uptimeMillis, ch.position)
                            val d = ch.positionChange()
                            val travel = if (vertical) d.y else d.x
                            if (travel != 0f) {
                                offset = (offset + travel) % tick
                                send(travel)
                                sinceTick += abs(travel)
                                if (sinceTick >= tick) {
                                    sinceTick %= tick
                                    if (p.haptics) view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
                                }
                            }
                            ch.consume()
                        }
                    } finally {
                        pressed = false
                    }
                    val v = velocity.calculateVelocity()
                    val speed = if (vertical) v.y else v.x
                    if (abs(speed) > FLING_MIN_PX_PER_S) {
                        fling = scope.launch {
                            var last = 0f
                            var ticked = 0f
                            animateDecay(0f, speed, FloatExponentialDecaySpec(frictionMultiplier = 2f)) { value, _ ->
                                val step = value - last
                                last = value
                                offset = (offset + step) % tick
                                send(step)
                                ticked += abs(step)
                                if (ticked >= tick) {
                                    ticked %= tick
                                    if (p.haptics) view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
                                }
                            }
                        }
                    }
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        val dim = c.dim
        val inner = if (vertical) {
            Modifier.width(PILL_DP.dp).fillMaxHeight().padding(vertical = Space.sm).graphicsLayer { scaleX = widen }
        } else {
            Modifier.height(SIDE_PILL_DP.dp).fillMaxWidth().padding(horizontal = Space.sm).graphicsLayer { scaleY = widen }
        }
        Box(
            inner.clip(shape).background(c.s2).border(1.dp, border, shape)
                .drawBehind { dialTicks(vertical, offset, dim, 12.dp.toPx(), 12.dp.toPx(), 1.5.dp.toPx()) },
        )
    }
}
