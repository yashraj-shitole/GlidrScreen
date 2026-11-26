package com.yashraj.glidr.screen.ui

import android.app.Activity
import android.content.res.Configuration
import android.view.HapticFeedbackConstants
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.yashraj.glidr.screen.ViewerPrefs
import com.yashraj.glidr.screen.net.ConnState
import com.yashraj.glidr.screen.net.ConnectStages
import com.yashraj.glidr.screen.net.MouseButton
import com.yashraj.glidr.screen.net.ScreenClient

private enum class Overlay { None, Keyboard, Displays, More, Settings, ConfirmExit }

@Composable
fun ViewerScreen(
    client: ScreenClient,
    prefs: ViewerPrefs,
    onPrefs: ((ViewerPrefs) -> ViewerPrefs) -> Unit,
    onExit: () -> Unit,
) {
    val c = Gs.colors
    val state by client.state.collectAsState()
    val track by client.videoTrack.collectAsState()
    val monitors by client.monitors.collectAsState()
    val active by client.activeMonitor.collectAsState()
    val switching by client.switching.collectAsState()
    val stats by client.stats.collectAsState()
    val rtt by client.rttMs.collectAsState()
    val control by client.controlAllowed.collectAsState()
    val hostName by client.hostName.collectAsState()
    val videoSize by client.videoSize.collectAsState()
    val diag by client.diag.collectAsState()
    val stage by client.stage.collectAsState()
    val media by client.phoneMedia.collectAsState()
    val audio by client.audioActive.collectAsState()
    val muted by client.audioMuted.collectAsState()
    val quickActions by client.quickActions.collectAsState()
    val recording by client.recording.collectAsState()
    val recordControl by client.recordControl.collectAsState()
    var overlay by remember { mutableStateOf(Overlay.None) }
    val zoom = remember { VideoViewState() }
    val extras = rememberViewerExtras() // HOOK 1/3: locked banner, clipboard, follow pointer, mute (see Banners.kt)
    val landscape = LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
    val view = LocalView.current

    val haptic: (Boolean) -> Unit = { strong ->
        if (prefs.haptics) view.performHapticFeedback(if (strong) HapticFeedbackConstants.LONG_PRESS else HapticFeedbackConstants.VIRTUAL_KEY)
    }

    val live = state is ConnState.Live
    // A back swipe is easy to trigger by accident while using the pad: ask before ending a live session.
    BackHandler {
        when {
            overlay != Overlay.None -> overlay = Overlay.None
            live -> overlay = Overlay.ConfirmExit
            else -> onExit()
        }
    }
    ViewerWindowEffect(hideBars = landscape)

    val sortedMonitors = remember(monitors) { monitors.sortedWith(compareBy({ it.x }, { it.y })) }
    val hostWidth = monitors.firstOrNull { it.id == active }?.w ?: 1920

    val video: @Composable (Modifier) -> Unit = { mod ->
        Box(mod.background(c.bg)) {
            RemoteVideo(track, client, zoom, prefs.directTouch, videoSize, haptic, Modifier.fillMaxSize())
            if (live) {
                // Top left: ONE stack, so two things can never land on the same spot. First the display numbers, then the
                // status tags (shared window, PC recording, phone camera or microphone live). Tags only inform; no button
                // of this stack covers the picture except the display numbers.
                Column(Modifier.align(Alignment.TopStart).padding(Space.md), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                    if (sortedMonitors.size > 1 && !prefs.oneHanded) {
                        Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                            sortedMonitors.forEachIndexed { i, m ->
                                val on = m.id == active
                                Box(
                                    Modifier.size(44.dp).clip(CircleShape).background(if (on) c.accent else Color80).clickable { client.switchMonitor(m.id); haptic(false) }
                                        .semantics { contentDescription = "Display ${i + 1}" },
                                    contentAlignment = Alignment.Center,
                                ) { Label("${i + 1}", color = if (on) c.ink else c.text) }
                            }
                        }
                    }
                    WindowTag(client)
                    RecordingStatus(client)
                    MediaLiveTag(client)
                }
                // Top right: the view-only notice and, while zoomed in, the two zoom controls (labelled).
                Column(Modifier.align(Alignment.TopEnd).padding(Space.md), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                    if (!control) Tag("View only")
                    if (zoom.zoomed) {
                        OverlayChip(ExtraIco.Pointer, if (zoom.followCursor) "Follow pointer, on" else "Follow pointer, off", zoom.followCursor, "Follow pointer") {
                            zoom.followCursor = !zoom.followCursor
                        }
                        Box(
                            Modifier.height(48.dp).clip(RoundedCornerShape(Radius.control)).background(Color80).border(1.dp, c.line, RoundedCornerShape(Radius.control))
                                .clickable { zoom.reset() }.padding(horizontal = Space.lg).semantics { contentDescription = "Reset zoom" },
                            contentAlignment = Alignment.Center,
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                                Icon(Ico.Reset, c.text)
                                Label("Reset zoom", color = c.text, style = Gs.type.small)
                            }
                        }
                    }
                }
                ViewerVideoOverlays(client, zoom, extras) // HOOK 2/3
                if (switching) Box(Modifier.fillMaxSize().background(Color(0x66000000)), contentAlignment = Alignment.Center) { Label("Switching display...") }
            }
            StateOverlay(state, diag, stage, onRetry = client::retry, onExit = onExit)
        }
    }

    val controls: @Composable (Modifier) -> Unit = { mod ->
        // The pad takes everything the rows below it leave: the mouse buttons, the pinned shortcuts, and one row with the
        // two tools that stay in reach (Keyboard, More). Every other tool is in the More popup.
        Column(mod, verticalArrangement = Arrangement.spacedBy(Space.md)) {
            Trackpad(client, prefs, hostWidth, haptic, Modifier.weight(1f).fillMaxWidth())
            MouseButtons(client, haptic, leftHanded = prefs.leftHanded)
            ShortcutDeck(prefs.shortcuts, client, haptic)
            if (prefs.oneHanded && sortedMonitors.size > 1) {
                // within thumb reach: the display switches live next to the tools instead of in the top corner
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    sortedMonitors.forEachIndexed { i, m ->
                        val on = m.id == active
                        PressBox(
                            { client.switchMonitor(m.id); haptic(false) }, Modifier.weight(1f).height(44.dp), "Display ${i + 1}", RoundedCornerShape(Radius.key),
                            background = if (on) c.accent else c.s2, border = !on,
                        ) { Label("${i + 1}", color = if (on) c.ink else c.text) }
                    }
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                ToolBarButton("Keyboard", active = false, modifier = Modifier.weight(1f), onClick = { overlay = Overlay.Keyboard }) { Icon(Ico.Keyboard, it) }
                // lit while something inside it is on (direct touch, camera or microphone, muted PC audio)
                ToolBarButton("More", active = prefs.directTouch || media.on || muted || recording, modifier = Modifier.weight(1f), onClick = { overlay = Overlay.More }) { MoreIcon(it) }
            }
        }
    }

    // an attached keyboard and mouse drive the PC while the session is live and no sheet is open
    Box(Modifier.fillMaxSize().background(c.bg).hardwareInput(client, live && overlay == Overlay.None, prefs, hostWidth)) {
        if (landscape) {
            // Full-width picture; the controls float on the thumb side and fold away to a handle, so the PC gets the whole screen.
            Box(Modifier.fillMaxSize()) {
                video(Modifier.fillMaxSize())
                val side = if (prefs.leftHanded) Alignment.CenterStart else Alignment.CenterEnd
                if (live && prefs.panelCollapsed) {
                    Box(Modifier.align(side).navigationBarsPadding().padding(Space.md)) {
                        RoundIconButton(Ico.Pad, "Show controls", { onPrefs { it.copy(panelCollapsed = false) } })
                    }
                } else {
                    Column(
                        Modifier.align(side).width(304.dp).fillMaxHeight().statusBarsPadding().navigationBarsPadding().padding(Space.sm)
                            .clip(RoundedCornerShape(Radius.card)).background(c.s1.copy(alpha = 0.94f)).padding(Space.md),
                        verticalArrangement = Arrangement.spacedBy(Space.md),
                    ) {
                        TopBar(hostName, state, stats, rtt, prefs.showStats, onExit) { overlay = Overlay.Settings }
                        if (live) {
                            controls(Modifier.weight(1f))
                        }
                    }
                }
            }
        } else {
            Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
                TopBar(hostName, state, stats, rtt, prefs.showStats, onExit, Modifier.padding(horizontal = Space.md, vertical = Space.sm)) { overlay = Overlay.Settings }
                // While live the picture is exactly as tall as the PC's screen shape needs, so the pad and tools below get
                // all the rest instead of a band of black bars. Before that (connecting, failed) it fills the space.
                val ratio = if (videoSize.first > 0 && videoSize.second > 0) (videoSize.first.toFloat() / videoSize.second).coerceIn(1.2f, 2.4f) else 16f / 9f
                video(if (live) Modifier.fillMaxWidth().aspectRatio(ratio) else Modifier.fillMaxWidth().weight(1.15f))
                if (live) controls(Modifier.fillMaxWidth().weight(1f).padding(Space.md)) else Box(Modifier.weight(1f))
            }
        }
        when (overlay) {
            Overlay.Keyboard -> KeyboardSheet(client, haptic, prefs, onPrefs) { overlay = Overlay.None }
            Overlay.Displays -> MonitorSheet(client) { overlay = Overlay.None }
            Overlay.More -> Sheet({ overlay = Overlay.None }) {
                Label("More tools", style = Gs.type.body)
                // A tile that opens something closes this popup first; the two switches stay so the person sees them change.
                fun go(f: () -> Unit): () -> Unit = { overlay = Overlay.None; f() }
                val tiles = buildList {
                    add(ToolTileSpec("Direct touch", active = prefs.directTouch, onClick = { onPrefs { p -> p.copy(directTouch = !p.directTouch) } }) { Icon(Ico.Touch, it) })
                    if (monitors.isNotEmpty()) add(ToolTileSpec("Displays", onClick = go { overlay = Overlay.Displays }) { Icon(Ico.Display, it) })
                    if (sortedMonitors.size > 1) add(ToolTileSpec("Next display", onClick = go {
                        val i = sortedMonitors.indexOfFirst { it.id == active }
                        sortedMonitors.getOrNull((i + 1) % sortedMonitors.size)?.let { m -> client.switchMonitor(m.id) }
                    }) { Icon(Ico.Swap, it) })
                    add(ToolTileSpec("Clipboard", onClick = go { extras.clipboardOpen = true }) { ExtraIcon(ExtraIco.Clipboard, it) })
                    add(ToolTileSpec("Send file", onClick = go { extras.sendOpen = true }) { ExtraIcon(ExtraIco.Send, it) })
                    add(ToolTileSpec("Camera and mic", active = media.on, onClick = go { extras.mediaOpen = true }) { MediaIcon(false, it) })
                    if (audio) add(ToolTileSpec(if (muted) "Unmute PC" else "Mute PC", active = muted, onClick = { client.setAudioMuted(!muted) }) {
                        ExtraIcon(if (muted) ExtraIco.SpeakerOff else ExtraIco.Speaker, it)
                    })
                    if (quickActions.isNotEmpty()) add(ToolTileSpec("PC actions", onClick = go { extras.actionsOpen = true }) { PowerIcon(it) })
                    // Only while the PC owner allows it. A switch like Mute: stays open, lights up while the PC records.
                    if (recordControl) add(ToolTileSpec(if (recording) "Stop recording" else "Record PC", active = recording, onClick = { client.setRecording(!recording) }) { RecordIcon(it) })
                    if (landscape) add(ToolTileSpec("Hide controls", onClick = go { onPrefs { p -> p.copy(panelCollapsed = true) } }) { Icon(Ico.Pad, it) })
                }
                ToolGrid(tiles, ToolGridLayout.PORTRAIT_PER_ROW)
                Pill("Done", { overlay = Overlay.None }, Modifier.fillMaxWidth())
            }
            Overlay.Settings -> SettingsSheet(client, prefs, onPrefs, onDisconnect = onExit) { overlay = Overlay.None }
            Overlay.ConfirmExit -> Sheet({ overlay = Overlay.None }) {
                Label("Disconnect from $hostName?", maxLines = 2, style = Gs.type.body)
                Label("The session ends and you will need to connect again.", color = c.dim, style = Gs.type.small)
                Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    Pill("Stay", { overlay = Overlay.None }, Modifier.weight(1f), primary = true)
                    Pill("Disconnect", onExit, Modifier.weight(1f))
                }
            }
            Overlay.None -> {}
        }
        ViewerExtraSheets(client, extras) // HOOK 3/3
    }
}

private val Color80 = androidx.compose.ui.graphics.Color(0xCC000000)
private fun Color(v: Long) = androidx.compose.ui.graphics.Color(v)

@Composable
private fun TopBar(
    name: String, state: ConnState, stats: com.yashraj.glidr.screen.net.LinkStats?, rtt: Int?, showStats: Boolean,
    onExit: () -> Unit, modifier: Modifier = Modifier, onSettings: () -> Unit,
) {
    val c = Gs.colors
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md)) {
        RoundIconButton(Ico.Back, "Disconnect", onExit)
        Column(Modifier.weight(1f)) {
            Label(name, maxLines = 1)
            val line = when (state) {
                is ConnState.Live -> if (showStats && stats != null) {
                    "${stats.fps} fps  ${stats.w}x${stats.h}  %.1f Mbit/s".format(stats.mbps) + (rtt?.let { "  $it ms" } ?: "") + "  ${stats.path}"
                } else "Connected"
                is ConnState.Connecting -> state.step
                is ConnState.Reconnecting -> "Reconnecting..."
                is ConnState.Failed -> "Disconnected"
                ConnState.Idle -> ""
            }
            Label(line, color = if (state is ConnState.Live) c.accentText else c.dim, style = Gs.type.mono, maxLines = 1)
        }
        RoundIconButton(Ico.Settings, "Settings", onSettings)
    }
}

/** How far a first connection has come: 1 contacting, 2 waiting for the PC's answer, 3 opening the direct link. */
private fun stepsDone(step: String) = when {
    step.startsWith("Opening") -> 3
    step.contains("aiting") -> 2
    else -> 1
}

@Composable
private fun StateOverlay(state: ConnState, diag: String, stage: String, onRetry: () -> Unit, onExit: () -> Unit) {
    val c = Gs.colors
    // The ICE / candidate line is for troubleshooting: shown on failure, or when asked for, never by default.
    var details by remember { mutableStateOf(false) }
    val text = when (state) {
        is ConnState.Connecting -> state.step + "..."
        is ConnState.Reconnecting -> "Connection lost. Reconnecting (${state.attempt})..."
        is ConnState.Failed -> state.reason
        else -> null
    } ?: return
    val busy = state is ConnState.Connecting || state is ConnState.Reconnecting
    val center = androidx.compose.ui.text.style.TextAlign.Center
    Box(Modifier.fillMaxSize().background(if (state is ConnState.Failed) c.bg else Color(0xB3000000)), contentAlignment = Alignment.Center) {
        Column(Modifier.padding(Space.xl), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.md)) {
            if (busy) Spinner(c.accent)
            if (state is ConnState.Failed) {
                // a short red headline, then the explanation in a calmer colour
                val (head, detail) = TimeText.splitReason(text)
                Label(head, color = c.bad, style = Gs.type.body.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold, textAlign = center))
                if (detail.isNotEmpty()) Label(detail, color = c.dim, style = Gs.type.body.copy(textAlign = center))
            } else {
                Label(text, color = c.text, style = Gs.type.body.copy(textAlign = center))
            }
            if (state is ConnState.Connecting) StepDots(listOf("Contact", "Wait", "Connect"), stepsDone(state.step))
            if (diag.isNotEmpty() && (state is ConnState.Failed || details)) Label(diag, color = c.dim, style = Gs.type.mono)
            if (busy && diag.isNotEmpty()) {
                Label(
                    if (details) "Hide details" else "Details", color = c.dim, style = Gs.type.small,
                    modifier = Modifier.clickable { details = !details }.padding(horizontal = Space.md, vertical = Space.md),
                )
            }
            if (busy) Pill("Cancel", onExit)
            if (state is ConnState.Failed) {
                ConnectStages.failureLine(stage)?.let { Label(it, color = c.dim, style = Gs.type.small.copy(textAlign = center)) }
                Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    Pill("Back", onExit)
                    Pill("Try again", onRetry, primary = true)
                }
            }
        }
    }
}

@Composable
private fun Tag(text: String) {
    val c = Gs.colors
    Box(Modifier.height(40.dp).clip(RoundedCornerShape(Radius.control)).background(Color80).border(1.dp, c.line, RoundedCornerShape(Radius.control)).padding(horizontal = Space.lg), contentAlignment = Alignment.Center) {
        Label(text, style = Gs.type.small)
    }
}

/** Keeps the screen on, and hides the system bars in landscape for a bigger picture. */
@Composable
private fun ViewerWindowEffect(hideBars: Boolean) {
    val view = LocalView.current
    DisposableEffect(hideBars) {
        view.keepScreenOn = true
        val window = (view.context as? Activity)?.window
        val ctl = window?.let { WindowCompat.getInsetsController(it, view) }
        ctl?.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        if (hideBars) ctl?.hide(WindowInsetsCompat.Type.systemBars()) else ctl?.show(WindowInsetsCompat.Type.systemBars())
        onDispose {
            view.keepScreenOn = false
            ctl?.show(WindowInsetsCompat.Type.systemBars())
        }
    }
}
