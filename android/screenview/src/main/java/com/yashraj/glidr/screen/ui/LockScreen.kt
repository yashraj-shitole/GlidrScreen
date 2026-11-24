package com.yashraj.glidr.screen.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.nativeKeyCode
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.yashraj.glidr.screen.lock.AppLockSession
import com.yashraj.glidr.screen.lock.LockPolicy
import com.yashraj.glidr.screen.lock.LockText
import com.yashraj.glidr.screen.lock.PinCheck
import com.yashraj.glidr.screen.lock.PinEntry
import com.yashraj.glidr.screen.lock.PinLock
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Widest the pad gets, so a tablet or landscape phone keeps a phone-sized pad. */
private val PAD_MAX_WIDTH = 320.dp
private val KEY_HEIGHT = 56.dp

/**
 * Full-screen PIN prompt. It is the only thing composed while the app is locked (see `GlidrScreenApp`): nothing of the
 * list of PCs or a live session is drawn, read by an accessibility service or fed keystrokes while it shows.
 * A hardware keyboard works too (digits, Backspace, Enter).
 */
@Composable
fun LockScreen(session: AppLockSession, haptics: Boolean, modifier: Modifier = Modifier) {
    val c = Gs.colors
    val haptic = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    var pin by remember { mutableStateOf("") }
    var message by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var waitMs by remember { mutableLongStateOf(session.waitRemainingMs()) }
    val focus = remember { FocusRequester() }

    // count the wait down; the loop ends (and the pad comes back) when it reaches zero
    LaunchedEffect(waitMs > 0) {
        while (true) {
            val r = session.waitRemainingMs()
            waitMs = r
            if (r <= 0) break
            delay(250)
        }
    }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }

    val blocked = waitMs > 0
    val canType = !busy && !blocked

    fun tick() { if (haptics) haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove) }

    fun submit() {
        if (!canType || pin.length < PinLock.MIN_LENGTH) return
        val entered = pin
        busy = true
        scope.launch {
            // PBKDF2 takes about 0.1 s: keep it off the main thread
            val r = withContext(Dispatchers.Default) { session.tryUnlock(entered) }
            busy = false
            pin = ""
            when (r) {
                PinCheck.Success -> message = null // the lock screen leaves the composition
                is PinCheck.Blocked -> { message = null; waitMs = r.remainingMs }
                is PinCheck.Wrong -> message = LockText.check(r)
            }
        }
    }

    fun digit(d: Int) {
        if (!canType) return
        tick()
        pin = PinEntry.append(pin, d)
        message = null
        if (pin.length == PinLock.MAX_LENGTH) submit()
    }

    fun delete() {
        if (!canType) return
        tick()
        pin = PinEntry.backspace(pin)
    }

    Box(
        modifier
            .fillMaxSize()
            .background(c.bg)
            // nothing behind this screen may receive a touch
            .pointerInput(Unit) { awaitPointerEventScope { while (true) awaitPointerEvent().changes.forEach { it.consume() } } }
            .focusRequester(focus)
            .focusable()
            .onPreviewKeyEvent { ev ->
                if (ev.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                val code = ev.key.nativeKeyCode
                val d = PinEntry.digitForKeyCode(code)
                when {
                    d != null -> { digit(d); true }
                    code == android.view.KeyEvent.KEYCODE_DEL -> { delete(); true }
                    code == android.view.KeyEvent.KEYCODE_ENTER || code == android.view.KeyEvent.KEYCODE_NUMPAD_ENTER -> { submit(); true }
                    else -> false
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Column(
            Modifier.statusBarsPadding().navigationBarsPadding().verticalScroll(rememberScrollState())
                .widthIn(max = PAD_MAX_WIDTH).fillMaxWidth().padding(horizontal = Space.lg, vertical = Space.lg),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            Label("Glidr Screen is locked", style = Gs.type.title.copy(textAlign = TextAlign.Center), modifier = Modifier.fillMaxWidth())
            Label("Enter your PIN to continue.", color = c.dim, style = Gs.type.small.copy(textAlign = TextAlign.Center), modifier = Modifier.fillMaxWidth())

            Spacer(Modifier.height(Space.sm))
            PinDots(pin.length)

            // one line reserved for the message, so the pad does not jump
            val line = when {
                blocked -> "Too many wrong tries. Try again in ${LockPolicy.formatWait(waitMs)}."
                else -> message
            }
            Box(Modifier.fillMaxWidth().height(32.dp), contentAlignment = Alignment.Center) {
                if (line != null) Label(line, color = c.bad, style = Gs.type.small.copy(textAlign = TextAlign.Center), maxLines = 2, modifier = Modifier.fillMaxWidth())
            }

            Column(Modifier.alpha(if (canType) 1f else 0.4f), verticalArrangement = Arrangement.spacedBy(Space.md)) {
                for (row in listOf(listOf(1, 2, 3), listOf(4, 5, 6), listOf(7, 8, 9))) {
                    Row(horizontalArrangement = Arrangement.spacedBy(Space.md)) {
                        for (d in row) DigitKey(d.toString(), Modifier.weight(1f)) { digit(d) }
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(Space.md)) {
                    PressBox({ delete() }, Modifier.weight(1f).height(KEY_HEIGHT), "Delete", background = androidx.compose.ui.graphics.Color.Transparent, border = false) {
                        Label("Delete", color = c.dim, style = Gs.type.body)
                    }
                    DigitKey("0", Modifier.weight(1f)) { digit(0) }
                    val ready = canType && pin.length >= PinLock.MIN_LENGTH
                    PressBox(
                        { submit() }, Modifier.weight(1f).height(KEY_HEIGHT).alpha(if (ready) 1f else 0.5f), "Unlock",
                        background = c.accent, border = false,
                    ) { Icon(Ico.Check, c.ink) }
                }
            }

            Spacer(Modifier.height(Space.sm))
            Label(LockText.FORGOTTEN, color = c.dim, style = Gs.type.small.copy(textAlign = TextAlign.Center), modifier = Modifier.fillMaxWidth())
        }
    }
}

@Composable
private fun DigitKey(text: String, modifier: Modifier, onClick: () -> Unit) {
    PressBox(onClick, modifier.height(KEY_HEIGHT), text) { Label(text, style = Gs.type.title) }
}

/** One dot per entered digit, at least [PinLock.MIN_LENGTH] places. */
@Composable
private fun PinDots(count: Int) {
    val c = Gs.colors
    Row(
        Modifier.height(24.dp), horizontalArrangement = Arrangement.spacedBy(Space.md), verticalAlignment = Alignment.CenterVertically,
    ) {
        repeat(maxOf(PinLock.MIN_LENGTH, count)) { i ->
            Box(Modifier.size(12.dp).clip(CircleShape).background(if (i < count) c.accent else c.s3))
        }
    }
}
