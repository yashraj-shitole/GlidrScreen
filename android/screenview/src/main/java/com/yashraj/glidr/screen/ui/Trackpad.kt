package com.yashraj.glidr.screen.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.systemGestureExclusion
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import androidx.compose.ui.input.pointer.PointerType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.yashraj.glidr.screen.ViewerPrefs
import com.yashraj.glidr.screen.input.PadZone
import com.yashraj.glidr.screen.input.PadZones
import com.yashraj.glidr.screen.input.PointerMath
import com.yashraj.glidr.screen.input.Swipe
import com.yashraj.glidr.screen.input.SwipeGestures
import com.yashraj.glidr.screen.net.MouseButton
import com.yashraj.glidr.screen.net.ScreenClient
import kotlinx.coroutines.delay
import kotlin.math.max

private const val TAP_MS = 300L
private const val DRAG_TAP_GAP_MS = 280L
private const val PX_PER_NOTCH = 40f
private const val EDGE_STRIP_DP = 48
private const val CORNER_DP = 64

/**
 * Laptop-style trackpad: one finger moves, tap clicks, two-finger tap right-clicks, three-finger tap middle-clicks,
 * two fingers scroll, tap-then-drag drags. With "Three-finger swipes" on, three fingers that travel far enough in one
 * direction send a Windows shortcut instead (see [SwipeGestures]). A scroll wheel (the right by default, the left when left-handed) sits beside the pad.
 * Opt-in: a thin sideways wheel under the pad, and precision mode (a second finger resting on the pad slows the pointer).
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

    Row(modifier.clip(RoundedCornerShape(Radius.pad)).background(c.s1).border(1.dp, c.line, RoundedCornerShape(Radius.pad))) {
        if (prefs.leftHanded) ScrollWheel(client, prefs, vertical = true)
        Column(Modifier.weight(1f).fillMaxHeight()) {
        Box(
            Modifier.weight(1f).fillMaxWidth()
                .semantics {
                    contentDescription = "Trackpad. Drag one finger to move the pointer. Tap to left-click, tap with two fingers to right-click, " +
                        "drag with two fingers to scroll."
                    customActions = listOf(
                        CustomAccessibilityAction("Left click") { client.click(MouseButton.Left); true },
                        CustomAccessibilityAction("Right click") { client.click(MouseButton.Right); true },
                        CustomAccessibilityAction("Middle click") { client.click(MouseButton.Middle); true },
                    )
                }
                .pointerInput(client) {
                    var lastTapEnd = 0L
                    awaitEachGesture {
                        val first = awaitFirstDown(requireUnconsumed = false)
                        if (first.type == PointerType.Mouse) {
                            // an attached mouse is handled at the viewer root, not as a finger
                            do { val e = awaitPointerEvent() } while (e.changes.any { it.pressed })
                            return@awaitEachGesture
                        }
                        touching = true
                        val slop = viewConfiguration.touchSlop
                        var zone = PadZones.classify(
                            first.position.x, first.position.y, size.width.toFloat(), size.height.toFloat(),
                            false, false, EDGE_STRIP_DP.dp.toPx(), CORNER_DP.dp.toPx(),
                        )
                        val dragMode = zone == PadZone.Normal && lastTapEnd > 0 && first.uptimeMillis - lastTapEnd < DRAG_TAP_GAP_MS
                        if (dragMode) client.buttonDown(MouseButton.Left)
                        var maxFingers = 1
                        var moved = false
                        var scrolling = false
                        var secondTravel = 0f
                        var swipeTotal = Offset.Zero // average travel of three fingers (three-finger swipes)
                        var total = Offset.Zero
                        var lastUp = first.uptimeMillis
                        try {
                            while (true) {
                                val event = awaitPointerEvent(PointerEventPass.Main)
                                val pressed = event.changes.filter { it.pressed }
                                if (pressed.isEmpty()) {
                                    lastUp = event.changes.maxOf { it.uptimeMillis }
                                    break
                                }
                                maxFingers = max(maxFingers, pressed.size)
                                val primary = pressed.firstOrNull { it.id == first.id }
                                val dir = if (p.naturalScroll) 1f else -1f
                                if (zone != PadZone.Normal && pressed.size == 1 && maxFingers == 1) {
                                    // started in the bottom strip or the corner: a tap stays a tap, a slide scrolls sideways
                                    val d = pressed[0].positionChange()
                                    total += d
                                    if (!moved && total.getDistance() > slop) {
                                        moved = true
                                        zone = PadZones.afterMove(zone, p.edgeScroll)
                                    } else if (moved && zone == PadZone.EdgeScroll) {
                                        client.scrollBy(-dir * d.x * p.scrollSpeed / PX_PER_NOTCH * 1.6f, 0f)
                                    }
                                } else if (p.swipeGestures && pressed.size >= 3) {
                                    // three fingers with swipes on: collect the travel, decide when they lift (small travel stays a tap)
                                    var dx = 0f; var dy = 0f
                                    pressed.forEach { dx += it.positionChange().x; dy += it.positionChange().y }
                                    swipeTotal += Offset(dx / pressed.size, dy / pressed.size)
                                } else if (pressed.size >= 2) {
                                    pressed.filter { it.id != first.id }.forEach { secondTravel += it.positionChange().getDistance() }
                                    if (p.precision && !scrolling && primary != null && PadZones.secondFingerStill(secondTravel, slop)) {
                                        // a second finger resting on the pad: the first one moves the pointer slowly
                                        val d = primary.positionChange()
                                        total += d
                                        if (!moved && total.getDistance() > slop) moved = true
                                        if (moved) {
                                            val dt = (primary.uptimeMillis - primary.previousUptimeMillis).toFloat()
                                            val (mx, my) = PointerMath.toHost(d.x, d.y, dt, p.sensitivity, p.accel, hw)
                                            val k = PadZones.precisionScale(true, secondTravel, slop)
                                            client.moveBy(mx * k, my * k)
                                        }
                                    } else {
                                        scrolling = true
                                        var dx = 0f; var dy = 0f
                                        pressed.forEach { dx += it.positionChange().x; dy += it.positionChange().y }
                                        dx /= pressed.size; dy /= pressed.size
                                        moved = moved || Offset(dx, dy).getDistance() > 0.5f
                                        val k = p.scrollSpeed / PX_PER_NOTCH
                                        client.scrollBy(-dir * dx * k, dir * dy * k)
                                    }
                                } else if (maxFingers == 1 || (p.precision && !scrolling && pressed[0].id == first.id)) {
                                    val ch = pressed[0]
                                    val d = ch.positionChange()
                                    total += d
                                    if (!moved && total.getDistance() > slop) moved = true
                                    if (moved) {
                                        val dt = (ch.uptimeMillis - ch.previousUptimeMillis).toFloat()
                                        val (mx, my) = PointerMath.toHost(d.x, d.y, dt, p.sensitivity, p.accel, hw)
                                        client.moveBy(mx, my)
                                    }
                                }
                                event.changes.forEach { it.consume() }
                            }
                        } finally {
                            // also when the gesture is cancelled (pad leaves the screen mid-drag): never leave the PC button held
                            touching = false
                            if (dragMode) client.buttonUp(MouseButton.Left)
                        }
                        val swipe = if (p.swipeGestures && maxFingers >= 3 && !dragMode) SwipeGestures.classify(swipeTotal.x, swipeTotal.y, slop) else Swipe.None
                        val swipeTravel = swipeTotal.getDistance()
                        if (dragMode) {
                            lastTapEnd = 0
                        } else if (swipe.keys != null) {
                            client.combo(swipe.keys); hp(false)
                        } else if (p.swipeGestures && maxFingers >= 3 && swipeTravel > SwipeGestures.SLOP_FACTOR * slop) {
                            // a long diagonal three-finger drag is neither a swipe nor a tap
                        } else if (!moved && lastUp - first.uptimeMillis < TAP_MS) {
                            when (maxFingers) {
                                1 -> if (zone == PadZone.Corner) {
                                    client.click(MouseButton.Right); hp(true)
                                } else {
                                    client.click(MouseButton.Left); lastTapEnd = lastUp; hp(false)
                                }
                                2 -> { client.click(MouseButton.Right); hp(true) }
                                else -> { client.click(MouseButton.Middle); hp(false) }
                            }
                        }
                    }
                },
        ) {
            val dot = c.dot
            val line = c.line
            Canvas(Modifier.fillMaxSize()) {
                val step = 24.dp.toPx()
                var y = step / 2
                while (y < size.height) {
                    var x = step / 2
                    while (x < size.width) { drawCircle(dot, 1.4.dp.toPx(), Offset(x, y)); x += step }
                    y += step
                }
            }
            if (!touching) {
                // The how-to text is centred in the pad and shrinks to one line on a short pad.
                androidx.compose.foundation.layout.BoxWithConstraints(Modifier.fillMaxSize()) {
                    val roomy = maxHeight >= 120.dp
                    Column(
                        Modifier.align(Alignment.Center).padding(horizontal = Space.lg),
                        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.xs),
                    ) {
                        Label("Trackpad", color = c.dim)
                        if (roomy) {
                            val hint = Gs.type.small.copy(textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                            Label("Drag: move   Tap: click", color = c.dim, style = hint)
                            Label("Two-finger tap: right-click", color = c.dim, style = hint)
                            Label("Two fingers: scroll", color = c.dim, style = hint)
                            Label("Tap, then drag: drag", color = c.dim, style = hint)
                        } else {
                            Label("Drag to move, tap to click", color = c.dim, style = Gs.type.small, maxLines = 1)
                        }
                    }
                }
            }
        }
        if (prefs.edgeScroll) ScrollWheel(client, prefs, vertical = false)
        }
        if (!prefs.leftHanded) ScrollWheel(client, prefs, vertical = true)
    }
}

/**
 * The three mouse buttons in one 56 dp row, laid out like the Glidr app: a wide Left, a narrow Middle drawn as a scroll
 * wheel, and Right. Left-handed mirrors the order. Holding a button keeps it pressed, so all three also drag.
 */
@Composable
fun MouseButtons(client: ScreenClient, haptic: (Boolean) -> Unit, modifier: Modifier = Modifier, leftHanded: Boolean = false) {
    val order = if (leftHanded) listOf(MouseButton.Right, MouseButton.Middle, MouseButton.Left) else listOf(MouseButton.Left, MouseButton.Middle, MouseButton.Right)
    Row(modifier.fillMaxWidth().height(56.dp), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
        for (b in order) {
            when (b) {
                MouseButton.Left -> HoldButton("Left", MouseButton.Left, client, haptic, Modifier.weight(3f))
                MouseButton.Middle -> HoldButton("Middle", MouseButton.Middle, client, haptic, Modifier.weight(1.1f), wheel = true)
                else -> HoldButton("Right", MouseButton.Right, client, haptic, Modifier.weight(2f))
            }
        }
    }
}

@Composable
private fun HoldButton(label: String, button: MouseButton, client: ScreenClient, haptic: (Boolean) -> Unit, modifier: Modifier, wheel: Boolean = false) {
    val c = Gs.colors
    var down by remember { mutableStateOf(false) }
    val hp by rememberUpdatedState(haptic)
    Box(
        modifier.fillMaxHeight().clip(RoundedCornerShape(Radius.control)).background(if (down) c.s3 else c.s2)
            .border(1.dp, c.line, RoundedCornerShape(Radius.control))
            .semantics {
                contentDescription = "$label mouse button. Touch and hold to keep it pressed, for dragging."
                role = Role.Button
                onClick(label = "Click") { client.click(button); true }
            }
            .pointerInput(client, button) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    down = true
                    client.buttonDown(button)
                    hp(button == MouseButton.Right)
                    try {
                        do {
                            val e = awaitPointerEvent()
                            e.changes.forEach { it.consume() }
                        } while (e.changes.any { it.pressed })
                    } finally {
                        client.buttonUp(button)
                        down = false
                    }
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        if (wheel) {
            // a scroll wheel: an upright rounded outline, the same symbol the Glidr app uses for the middle button
            Box(Modifier.width(12.dp).height(24.dp).border(1.5.dp, c.text, RoundedCornerShape(6.dp)))
        } else {
            Label(label, color = c.text)
        }
    }
}
