package com.yashraj.glidr.screen.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.yashraj.glidr.screen.net.QuickAction
import com.yashraj.glidr.screen.net.ScreenClient
import kotlinx.coroutines.delay

/** Wording of the quick actions sheet. Pure so it is testable. The results' own texts live in `ActionResult.message`. */
object QuickActionText {
    /** What a restart or shutdown does and how to take it back. The host starts both after a 15 s delay. */
    fun confirmQuestion(a: QuickAction): String = when (a.id) {
        "restart" -> "Restart the PC? It restarts in 15 seconds. You can cancel from here."
        "shutdown" -> "Shut down the PC? It shuts down in 15 seconds. You can cancel from here."
        else -> "${a.label}? You can cancel from here."
    }

    fun confirmButton(a: QuickAction): String = when (a.id) {
        "restart" -> "Restart"
        "shutdown" -> "Shut down"
        else -> a.label
    }

    /** The rows of the main list: everything except "Cancel shutdown", which has its own row while a countdown runs. */
    fun listed(all: List<QuickAction>): List<QuickAction> = all.filter { it.id != QuickAction.CANCEL_SHUTDOWN }

    /** The "Cancel shutdown" action when the PC offers it and a restart or shutdown was just sent, else null. */
    fun cancelRow(all: List<QuickAction>, pending: Boolean): QuickAction? =
        if (pending) all.firstOrNull { it.id == QuickAction.CANCEL_SHUTDOWN } else null

    /** An action only a confirmed tap may run: danger ones go through the confirm step, never straight to the PC. */
    fun needsConfirm(a: QuickAction): Boolean = a.danger
}

/** 48 dp round-cornered button that sits on the picture, with a power symbol. Shown only while the PC offers actions. */
@Composable
fun QuickActionsChip(client: ScreenClient, onClick: () -> Unit) {
    val actions by client.quickActions.collectAsState()
    if (actions.isEmpty()) return
    val shape = RoundedCornerShape(Radius.control)
    PressBox(onClick, Modifier.height(48.dp), "Quick actions", shape, background = Color(0xCC000000)) {
        Row(Modifier.padding(horizontal = Space.md), verticalAlignment = Alignment.CenterVertically) { PowerIcon(Color.White) }
    }
}

@Composable
private fun PowerIcon(tint: Color, size: Dp = 24.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val sw = w * 0.085f
        fun p(x: Float, y: Float) = Offset(x * w / 24f, y * w / 24f)
        drawArc(tint, -55f, 290f, false, p(5f, 5f), Size(14f * w / 24f, 14f * w / 24f), style = Stroke(sw, cap = StrokeCap.Round))
        drawLine(tint, p(12f, 3f), p(12f, 12f), sw, StrokeCap.Round)
    }
}

/** One 48 dp row of the sheet: the label on the left, red for a dangerous action. */
@Composable
private fun ActionRow(label: String, danger: Boolean, highlighted: Boolean = false, onClick: () -> Unit) {
    val c = Gs.colors
    PressBox(
        onClick, Modifier.fillMaxWidth().height(48.dp), label, RoundedCornerShape(Radius.chip),
        background = if (highlighted) c.accent else c.s2, border = !highlighted,
    ) {
        Row(Modifier.fillMaxWidth().padding(horizontal = Space.lg), verticalAlignment = Alignment.CenterVertically) {
            Label(label, color = if (highlighted) c.ink else if (danger) c.bad else c.text, maxLines = 1)
        }
    }
}

/**
 * Lock, sleep, restart and the launchers the PC owner allowed, run on the PC. The phone only picks from the PC's list.
 * Dangerous actions (restart, shut down) open a second step first; only its button sends `confirm:true`.
 */
@Composable
fun QuickActionsSheet(client: ScreenClient, onDismiss: () -> Unit) {
    val c = Gs.colors
    val actions by client.quickActions.collectAsState()
    val pending by client.shutdownPending.collectAsState()
    var confirming by remember { mutableStateOf<QuickAction?>(null) }
    var feedback by remember { mutableStateOf<String?>(null) }
    var tick by remember { mutableStateOf(0) } // one tick per answer so the same text twice still restarts its timeout

    LaunchedEffect(client) { client.lastActionResult.collect { feedback = it.message; tick++ } }
    LaunchedEffect(tick) { if (feedback != null) { delay(3_000); feedback = null } }
    // the PC owner removed or switched off the action while its confirm step was open
    LaunchedEffect(actions) { confirming?.let { a -> if (actions.none { it.id == a.id }) confirming = null } }

    Sheet(onDismiss) {
        val ask = confirming
        if (ask != null) {
            Label(ask.label, style = Gs.type.body)
            Label(QuickActionText.confirmQuestion(ask), color = c.dim, style = Gs.type.small)
            Pill(QuickActionText.confirmButton(ask), { client.runAction(ask.id, confirm = true); confirming = null }, Modifier.fillMaxWidth(), danger = true)
            Pill("Cancel", { confirming = null }, Modifier.fillMaxWidth())
        } else {
            Label("Quick actions", style = Gs.type.body)
            Label("These run on your PC. Your PC decides what is listed here.", color = c.dim, style = Gs.type.small)
            QuickActionText.cancelRow(actions, pending)?.let { cancel ->
                ActionRow("Cancel shutdown", danger = false, highlighted = true) { client.runAction(cancel.id) }
            }
            Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                for (a in QuickActionText.listed(actions)) {
                    ActionRow(a.label, a.danger) { if (QuickActionText.needsConfirm(a)) confirming = a else client.runAction(a.id) }
                }
            }
            feedback?.let { Label(it, color = c.accentText, style = Gs.type.small) }
            Pill("Done", onDismiss, Modifier.fillMaxWidth())
        }
    }
}
