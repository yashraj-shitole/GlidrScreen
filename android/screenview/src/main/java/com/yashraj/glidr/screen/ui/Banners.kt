package com.yashraj.glidr.screen.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.yashraj.glidr.screen.net.ConnState
import com.yashraj.glidr.screen.net.ScreenClient

/**
 * Everything the viewer adds on top of the picture besides the base controls: the locked banner, and a column of
 * small buttons (clipboard, follow pointer, mute). ViewerScreen only hosts them with two calls
 * ([ViewerVideoOverlays] over the video, [ViewerExtraSheets] at the root) and one [rememberViewerExtras].
 */
class ViewerExtras {
    var clipboardOpen by mutableStateOf(false)
    var sendOpen by mutableStateOf(false)
    var actionsOpen by mutableStateOf(false)
}

@Composable
fun rememberViewerExtras() = remember { ViewerExtras() }

private val Scrim = Color(0xCC000000)

/** Centered notice for a locked PC: Windows does not let the app capture or control the lock screen. */
@Composable
fun LockedBanner(modifier: Modifier = Modifier) {
    val c = Gs.colors
    val shape = RoundedCornerShape(Radius.card)
    Box(modifier.widthIn(max = 320.dp).background(Scrim, shape).border(1.dp, c.line, shape).padding(Space.lg), contentAlignment = Alignment.Center) {
        Label("PC is locked. Unlock it at the PC to continue.", color = Color.White, style = Gs.type.body.copy(textAlign = TextAlign.Center))
    }
}

/** A 48 dp round-cornered button that sits on the picture: an icon, optionally with a short text. */
@Composable
private fun OverlayChip(kind: ExtraIco, description: String, active: Boolean = false, text: String? = null, onClick: () -> Unit) {
    val c = Gs.colors
    val fg = if (active) c.ink else Color.White
    PressBox(
        onClick, Modifier.height(48.dp), description, RoundedCornerShape(Radius.control),
        background = if (active) c.accent else Scrim, border = !active,
    ) {
        Row(
            Modifier.padding(horizontal = if (text == null) Space.md else Space.lg), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Space.sm),
        ) {
            ExtraIcon(kind, fg)
            if (text != null) Label(text, color = fg, style = Gs.type.small)
        }
    }
}

/** Hook for the video area (call inside its Box, while live): locked banner and the extra buttons. */
@Composable
fun BoxScope.ViewerVideoOverlays(client: ScreenClient, zoom: VideoViewState, extras: ViewerExtras) {
    val locked by client.hostLocked.collectAsState()
    val audio by client.audioActive.collectAsState()
    val muted by client.audioMuted.collectAsState()
    if (locked) LockedBanner(Modifier.align(Alignment.Center).padding(Space.lg))
    WindowShareOverlay(client)
    // sits under the base top-right row (View only tag, zoom reset), which is 44 dp tall
    Column(
        Modifier.align(Alignment.TopEnd).padding(top = Space.md + 44.dp + Space.sm, end = Space.md),
        horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(Space.sm),
    ) {
        OverlayChip(ExtraIco.Clipboard, "Clipboard") { extras.clipboardOpen = true }
        OverlayChip(ExtraIco.Send, "Send file to PC") { extras.sendOpen = true }
        QuickActionsChip(client) { extras.actionsOpen = true } // only when the PC offers quick actions
        if (zoom.zoomed) {
            OverlayChip(ExtraIco.Pointer, if (zoom.followCursor) "Follow pointer, on" else "Follow pointer, off", zoom.followCursor, "Follow pointer") {
                zoom.followCursor = !zoom.followCursor
            }
        }
        if (audio) {
            OverlayChip(if (muted) ExtraIco.SpeakerOff else ExtraIco.Speaker, if (muted) "Unmute PC audio" else "Mute PC audio", muted) {
                client.setAudioMuted(!muted)
            }
        }
    }
}

/** Hook for the root of the viewer, next to the other sheets: the clipboard sheet and PC-to-phone clipboard copy. */
@Composable
fun ViewerExtraSheets(client: ScreenClient, extras: ViewerExtras) {
    ClipboardAutoCopy(client)
    if (extras.clipboardOpen) {
        // registered after the viewer's own BackHandler, so Back closes this sheet first
        BackHandler { extras.clipboardOpen = false }
        ClipboardSheet(client) { extras.clipboardOpen = false }
    }
    // Files shared from another app open the send sheet once the connection is live (never before: nothing is read earlier).
    val shares = LocalShareQueue.current
    val state by client.state.collectAsState()
    val live = state is ConnState.Live
    LaunchedEffect(live, shares.uris.isNotEmpty()) { if (live && shares.uris.isNotEmpty()) extras.sendOpen = true }
    if (extras.sendOpen) {
        BackHandler { extras.sendOpen = false }
        SendFileSheet(client, shares) { extras.sendOpen = false }
    }
    if (extras.actionsOpen) {
        BackHandler { extras.actionsOpen = false }
        QuickActionsSheet(client) { extras.actionsOpen = false }
    }
}
