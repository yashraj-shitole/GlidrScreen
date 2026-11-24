package com.yashraj.glidr.screen.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.yashraj.glidr.screen.lock.AppLockSession
import com.yashraj.glidr.screen.lock.LockDelay
import com.yashraj.glidr.screen.lock.LockResult
import com.yashraj.glidr.screen.lock.LockText
import com.yashraj.glidr.screen.lock.PinCheck
import com.yashraj.glidr.screen.lock.PinEntry
import com.yashraj.glidr.screen.lock.PinLock
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Where the settings sheet is. A PIN typed in an earlier step is kept in memory only until the sheet closes. */
private sealed interface LockStep {
    data object Overview : LockStep
    /** Turning on: [first] is null while the PIN is chosen, and the PIN to repeat afterwards. */
    data class Create(val first: String?) : LockStep
    /** Asking for the current PIN before [then]. */
    data class Current(val then: After) : LockStep
    /** Changing: [current] was accepted; [first] as in [Create]. */
    data class Replace(val current: String, val first: String?) : LockStep
}

private enum class After { Change, TurnOff }

/**
 * The "App lock" sheet. Off: explains and turns on (new PIN twice). On: the delay, Change PIN and Turn off; the last two
 * ask for the current PIN first.
 */
@Composable
fun LockSettingsSheet(lock: AppLockSession, onDismiss: () -> Unit) {
    val c = Gs.colors
    val settings by lock.settings.collectAsState()
    val scope = rememberCoroutineScope()
    var step by remember { mutableStateOf<LockStep>(LockStep.Overview) }
    var entry by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    fun go(next: LockStep, message: String? = null) {
        step = next
        entry = ""
        error = message
    }

    /** Runs a PIN check off the main thread (PBKDF2 takes about 0.1 s) and hands the outcome back. */
    fun <T> work(block: () -> T, done: (T) -> Unit) {
        busy = true
        scope.launch {
            val r = withContext(Dispatchers.Default) { block() }
            busy = false
            done(r)
        }
    }

    fun rejected(check: PinCheck) { go(step, LockText.check(check)) }

    Sheet(onDismiss) {
        when (val s = step) {
            LockStep.Overview -> {
                Label("App lock", style = Gs.type.body)
                Label(LockText.INTRO, color = c.dim, style = Gs.type.small)
                if (!settings.enabled) {
                    Label(LockText.STORED, color = c.dim, style = Gs.type.small)
                    Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                        Pill("Close", onDismiss, Modifier.weight(1f))
                        Pill("Turn on", { go(LockStep.Create(null)) }, Modifier.weight(1f), primary = true)
                    }
                } else {
                    Label("Lock again after leaving the app for", color = c.dim, style = Gs.type.small)
                    val options = LockDelay.entries
                    Segmented(options.map { it.label }, options.indexOf(settings.delay), { lock.setDelay(options[it]) })
                    Label(LockText.BACKGROUND, color = c.dim, style = Gs.type.small)
                    Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                        Pill("Change PIN", { go(LockStep.Current(After.Change)) }, Modifier.weight(1f))
                        Pill("Turn off", { go(LockStep.Current(After.TurnOff)) }, Modifier.weight(1f))
                    }
                    Pill("Close", onDismiss, Modifier.fillMaxWidth(), primary = true)
                }
            }

            is LockStep.Create -> PinStep(
                title = if (s.first == null) "Choose a PIN" else "Enter the PIN again",
                hint = if (s.first == null) "${PinLock.MIN_LENGTH} to ${PinLock.MAX_LENGTH} digits." else "To make sure you typed it right.",
                entry = entry, onEntry = { entry = it; error = null }, error = error, busy = busy,
                action = if (s.first == null) "Next" else "Turn on",
                onBack = { go(LockStep.Overview) },
                onSubmit = {
                    val first = s.first
                    if (first == null) {
                        val bad = PinLock.validate(entry)
                        if (bad != null) error = LockText.error(bad) else go(LockStep.Create(entry))
                    } else if (entry != first) {
                        go(LockStep.Create(null), "The two PINs did not match. Start again.")
                    } else {
                        work({ lock.enable(first) }) { r ->
                            when (r) {
                                LockResult.Done -> go(LockStep.Overview)
                                is LockResult.BadNew -> go(LockStep.Create(null), LockText.error(r.error))
                                is LockResult.Rejected -> go(LockStep.Overview)
                            }
                        }
                    }
                },
            )

            is LockStep.Current -> PinStep(
                title = "Enter your current PIN",
                hint = if (s.then == After.TurnOff) "The lock is turned off once the PIN is right." else "Then you choose a new one.",
                entry = entry, onEntry = { entry = it; error = null }, error = error, busy = busy,
                action = if (s.then == After.TurnOff) "Turn off" else "Next",
                onBack = { go(LockStep.Overview) },
                onSubmit = {
                    val pin = entry
                    if (s.then == After.TurnOff) {
                        work({ lock.disable(pin) }) { r ->
                            when (r) {
                                is LockResult.Rejected -> rejected(r.check)
                                else -> go(LockStep.Overview)
                            }
                        }
                    } else {
                        work({ lock.verifyCurrent(pin) }) { r ->
                            if (r == PinCheck.Success) go(LockStep.Replace(pin, null)) else rejected(r)
                        }
                    }
                },
            )

            is LockStep.Replace -> PinStep(
                title = if (s.first == null) "Choose a new PIN" else "Enter the new PIN again",
                hint = if (s.first == null) "${PinLock.MIN_LENGTH} to ${PinLock.MAX_LENGTH} digits." else "To make sure you typed it right.",
                entry = entry, onEntry = { entry = it; error = null }, error = error, busy = busy,
                action = if (s.first == null) "Next" else "Save PIN",
                onBack = { go(LockStep.Overview) },
                onSubmit = {
                    val first = s.first
                    if (first == null) {
                        val bad = PinLock.validate(entry)
                        if (bad != null) error = LockText.error(bad) else go(LockStep.Replace(s.current, entry))
                    } else if (entry != first) {
                        go(LockStep.Replace(s.current, null), "The two PINs did not match. Start again.")
                    } else {
                        work({ lock.change(s.current, first) }) { r ->
                            when (r) {
                                LockResult.Done -> go(LockStep.Overview)
                                is LockResult.BadNew -> go(LockStep.Replace(s.current, null), LockText.error(r.error))
                                is LockResult.Rejected -> go(LockStep.Current(After.Change), LockText.check(r.check))
                            }
                        }
                    }
                },
            )
        }
    }
}

/** One PIN question: a title, a masked digits-only field, an error line, and Back / [action]. */
@Composable
private fun PinStep(
    title: String, hint: String, entry: String, onEntry: (String) -> Unit, error: String?, busy: Boolean,
    action: String, onBack: () -> Unit, onSubmit: () -> Unit,
) {
    val c = Gs.colors
    val focus = remember { FocusRequester() }
    LaunchedEffect(title) { runCatching { focus.requestFocus() } }
    Label(title, style = Gs.type.body)
    Label(hint, color = c.dim, style = Gs.type.small)
    BasicTextField(
        value = entry,
        onValueChange = { onEntry(PinEntry.sanitize(it)) },
        textStyle = Gs.type.body.copy(color = c.text),
        cursorBrush = SolidColor(c.accent),
        singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { if (!busy && entry.length >= PinLock.MIN_LENGTH) onSubmit() }),
        modifier = Modifier.fillMaxWidth().height(48.dp).clip(RoundedCornerShape(Radius.chip)).background(c.s2)
            .padding(Space.md).focusRequester(focus),
    )
    if (error != null) Label(error, color = c.bad, style = Gs.type.small, maxLines = 3)
    Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
        Pill("Back", onBack, Modifier.weight(1f))
        Pill(action, onSubmit, Modifier.weight(1f), primary = true, enabled = !busy && entry.length >= PinLock.MIN_LENGTH)
    }
}
