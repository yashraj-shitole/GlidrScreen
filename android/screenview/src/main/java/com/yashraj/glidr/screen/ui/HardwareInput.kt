package com.yashraj.glidr.screen.ui

import androidx.compose.foundation.focusable
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.nativeKeyCode
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.PointerType
import androidx.compose.ui.input.pointer.changedToDown
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import com.yashraj.glidr.screen.ViewerPrefs
import com.yashraj.glidr.screen.input.HardwareKeys
import com.yashraj.glidr.screen.input.HardwareMouse
import com.yashraj.glidr.screen.input.HwOp
import com.yashraj.glidr.screen.input.PointerMath
import com.yashraj.glidr.screen.net.Msg
import com.yashraj.glidr.screen.net.ScreenClient

/**
 * Forwards an attached keyboard and mouse to the PC. Put it on the viewer root. While [enabled] is false (a sheet is
 * open, or the session is not live) events are left alone so text fields keep working.
 *
 * Keyboard: Ctrl, Alt, Shift and Win are held down on the PC while held on the phone; keys go by name with those held,
 * and printable keys type their character. Mouse: movement is relative (the phone's pointer deltas), buttons and the
 * wheel go as clicks. A USB or Bluetooth mouse on Android reports its pointer within the screen, so moving stops at the
 * screen edge.
 */
@Composable
fun Modifier.hardwareInput(client: ScreenClient, enabled: Boolean, prefs: ViewerPrefs, hostWidth: Int): Modifier {
    val on by rememberUpdatedState(enabled)
    val p by rememberUpdatedState(prefs)
    val hw by rememberUpdatedState(hostWidth)
    val focus = remember { FocusRequester() }
    val heldKeys = remember { mutableSetOf<String>() }

    LaunchedEffect(enabled) { if (enabled) runCatching { focus.requestFocus() } }
    // never leave a modifier stuck down on the PC if the viewer goes away mid-press
    DisposableEffect(client) {
        onDispose { heldKeys.toList().forEach { client.send(Msg.key(it, "u")) }; heldKeys.clear() }
    }

    return this
        .focusRequester(focus)
        .focusable()
        .onPreviewKeyEvent { ev ->
            if (!on) return@onPreviewKeyEvent false
            val down = ev.type == KeyEventType.KeyDown
            if (!down && ev.type != KeyEventType.KeyUp) return@onPreviewKeyEvent false
            val ne = ev.nativeKeyEvent
            val ops = HardwareKeys.plan(ev.key.nativeKeyCode, ne.unicodeChar, down, ne.isCtrlPressed, ne.isAltPressed, ne.isMetaPressed)
            if (ops.isEmpty()) return@onPreviewKeyEvent false
            for (op in ops) when (op) {
                is HwOp.Text -> client.typeText(op.s)
                is HwOp.Key -> when (op.action) {
                    "d" -> if (heldKeys.add(op.name)) client.send(Msg.key(op.name, "d")) // ignore auto-repeat of a held modifier
                    "u" -> { heldKeys.remove(op.name); client.send(Msg.key(op.name, "u")) }
                    else -> client.send(Msg.key(op.name, "p"))
                }
            }
            true
        }
        .pointerInput(client) {
            var mask = 0
            try {
                awaitPointerEventScope {
                    while (true) {
                        val ev = awaitPointerEvent(PointerEventPass.Initial)
                        val ch = ev.changes.firstOrNull { it.type == PointerType.Mouse } ?: continue
                        if (!on) { mask = 0; continue }
                        val now = HardwareMouse.mask(ev.buttons.isPrimaryPressed, ev.buttons.isSecondaryPressed, ev.buttons.isTertiaryPressed)
                        for ((button, isDown) in HardwareMouse.transitions(mask, now)) {
                            if (isDown) client.buttonDown(button) else client.buttonUp(button)
                        }
                        mask = now
                        when (ev.type) {
                            PointerEventType.Move -> {
                                val d = ch.positionChange()
                                if (d.x != 0f || d.y != 0f) {
                                    val dt = (ch.uptimeMillis - ch.previousUptimeMillis).toFloat()
                                    val (mx, my) = PointerMath.toHost(d.x, d.y, dt, p.sensitivity, p.accel, hw)
                                    client.moveBy(mx, my)
                                }
                            }
                            PointerEventType.Scroll -> {
                                val (wx, wy) = HardwareMouse.wheel(ch.scrollDelta.x, ch.scrollDelta.y)
                                client.scrollBy(wx, wy)
                            }
                            else -> {}
                        }
                        if (ch.changedToDown()) ch.consume() // keeps Android from turning a right-click into Back
                    }
                }
            } finally {
                // the mouse left or the viewer closed with a button held: release it on the PC
                for ((button, _) in HardwareMouse.transitions(mask, 0)) client.buttonUp(button)
            }
        }
}
