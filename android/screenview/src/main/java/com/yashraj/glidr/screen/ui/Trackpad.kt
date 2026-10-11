package com.yashraj.glidr.screen.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.unit.dp
import com.yashraj.glidr.screen.ViewerPrefs
import com.yashraj.glidr.screen.input.PointerMath
import com.yashraj.glidr.screen.net.MouseButton
import com.yashraj.glidr.screen.net.ScreenClient
import kotlin.math.max

private const val TAP_MS = 300L
private const val DRAG_TAP_GAP_MS = 280L
private const val PX_PER_NOTCH = 40f

/**
 * Laptop-style trackpad: one finger moves, tap clicks, two-finger tap right-clicks, three-finger tap middle-clicks,
 * two fingers scroll, tap-then-drag drags. The right edge is a scroll strip.
 */
@Composable
fun Trackpad(
    client: ScreenClient,
    prefs: ViewerPrefs,
    hostWidth: Int,
    haptic: (strong: Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = Gs.colors
    val p by rememberUpdatedState(prefs)
    val hw by rememberUpdatedState(hostWidth)
    val hp by rememberUpdatedState(haptic)
    var touching by remember { mutableStateOf(false) }

    Row(modifier.clip(RoundedCornerShape(24.dp)).background(c.s1).border(1.dp, c.line, RoundedCornerShape(24.dp))) {
        Box(
            Modifier.weight(1f).fillMaxHeight()
                .pointerInput(client) {
                    var lastTapEnd = 0L
                    awaitEachGesture {
                        val first = awaitFirstDown(requireUnconsumed = false)
                        touching = true
                        val dragMode = lastTapEnd > 0 && first.uptimeMillis - lastTapEnd < DRAG_TAP_GAP_MS
                        if (dragMode) client.buttonDown(MouseButton.Left)
                        var maxFingers = 1
                        var moved = false
                        var total = Offset.Zero
                        var lastUp = first.uptimeMillis
                        while (true) {
                            val event = awaitPointerEvent(PointerEventPass.Main)
                            val pressed = event.changes.filter { it.pressed }
                            if (pressed.isEmpty()) {
                                lastUp = event.changes.maxOf { it.uptimeMillis }
                                break
                            }
                            maxFingers = max(maxFingers, pressed.size)
                            if (pressed.size >= 2) {
                                var dx = 0f; var dy = 0f
                                pressed.forEach { dx += it.positionChange().x; dy += it.positionChange().y }
                                dx /= pressed.size; dy /= pressed.size
                                moved = moved || Offset(dx, dy).getDistance() > 0.5f
                                val k = p.scrollSpeed / PX_PER_NOTCH
                                val dir = if (p.naturalScroll) 1f else -1f
                                client.scrollBy(-dir * dx * k, dir * dy * k)
                            } else if (maxFingers == 1) {
                                val ch = pressed[0]
                                val d = ch.positionChange()
                                total += d
                                if (!moved && total.getDistance() > viewConfiguration.touchSlop) moved = true
                                if (moved) {
                                    val dt = (ch.uptimeMillis - ch.previousUptimeMillis).toFloat()
                                    val (mx, my) = PointerMath.toHost(d.x, d.y, dt, p.sensitivity, p.accel, hw)
                                    client.moveBy(mx, my)
                                }
                            }
                            event.changes.forEach { it.consume() }
                        }
                        touching = false
                        if (dragMode) {
                            client.buttonUp(MouseButton.Left)
                            lastTapEnd = 0
                        } else if (!moved && lastUp - first.uptimeMillis < TAP_MS) {
                            when (maxFingers) {
                                1 -> { client.click(MouseButton.Left); lastTapEnd = lastUp; hp(false) }
                                2 -> { client.click(MouseButton.Right); hp(true) }
                                else -> { client.click(MouseButton.Middle); hp(false) }
                            }
                        }
                    }
                },
        ) {
            val dot = c.dot
            Canvas(Modifier.fillMaxSize()) {
                val step = 22.dp.toPx()
                var y = step / 2
                while (y < size.height) {
                    var x = step / 2
                    while (x < size.width) { drawCircle(dot, 1.4.dp.toPx(), Offset(x, y)); x += step }
                    y += step
                }
            }
            if (!touching) Label("Trackpad", color = c.dim, modifier = Modifier.align(Alignment.Center))
        }
        ScrollStrip(client, prefs)
    }
}

@Composable
private fun ScrollStrip(client: ScreenClient, prefs: ViewerPrefs) {
    val c = Gs.colors
    val p by rememberUpdatedState(prefs)
    val line = c.line
    Box(
        Modifier.width(44.dp).fillMaxHeight().background(c.s2)
            .pointerInput(client) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    while (true) {
                        val event = awaitPointerEvent(PointerEventPass.Main)
                        val ch = event.changes.firstOrNull() ?: break
                        if (!ch.pressed) break
                        client.scrollBy(0f, -ch.positionChange().y * p.scrollSpeed / PX_PER_NOTCH * 1.6f)
                        ch.consume()
                    }
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.fillMaxSize()) {
            val step = 14.dp.toPx()
            var y = step
            while (y < size.height) {
                drawLine(line, Offset(size.width * 0.3f, y), Offset(size.width * 0.7f, y), 2.dp.toPx(), StrokeCap.Round)
                y += step
            }
        }
    }
}

/** Left / right mouse buttons. Holding a button keeps it pressed, so these also drag. */
@Composable
fun MouseButtons(client: ScreenClient, haptic: (Boolean) -> Unit, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().height(56.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        HoldButton("Left", MouseButton.Left, client, haptic, Modifier.weight(1f))
        HoldButton("Right", MouseButton.Right, client, haptic, Modifier.weight(1f))
    }
}

@Composable
private fun HoldButton(label: String, button: MouseButton, client: ScreenClient, haptic: (Boolean) -> Unit, modifier: Modifier) {
    val c = Gs.colors
    var down by remember { mutableStateOf(false) }
    val hp by rememberUpdatedState(haptic)
    Box(
        modifier.fillMaxHeight().clip(RoundedCornerShape(18.dp)).background(if (down) c.accent else c.s2)
            .border(1.dp, c.line, RoundedCornerShape(18.dp))
            .pointerInput(client, button) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    down = true
                    client.buttonDown(button)
                    hp(button == MouseButton.Right)
                    do {
                        val e = awaitPointerEvent()
                        e.changes.forEach { it.consume() }
                    } while (e.changes.any { it.pressed })
                    client.buttonUp(button)
                    down = false
                }
            },
        contentAlignment = Alignment.Center,
    ) { Label(label, color = if (down) c.ink else c.text) }
}
