package com.yashraj.glidr.screen.ui

import android.app.Activity
import android.content.res.Configuration
import android.view.HapticFeedbackConstants
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
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
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.yashraj.glidr.screen.ViewerPrefs
import com.yashraj.glidr.screen.net.ConnState
import com.yashraj.glidr.screen.net.MouseButton
import com.yashraj.glidr.screen.net.ScreenClient

private enum class Overlay { None, Keyboard, Displays, Settings, ConfirmExit }

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
                Row(Modifier.align(Alignment.TopStart).padding(Space.md), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    if (sortedMonitors.size > 1 && !prefs.oneHanded) {
                        sortedMonitors.forEachIndexed { i, m ->
                            val on = m.id == active
                            Box(
                                Modifier.size(44.dp).clip(CircleShape).background(if (on) c.accent else Color80).clickable { client.switchMonitor(m.id); haptic(false) },
                                contentAlignment = Alignment.Center,
                            ) { Label("${i + 1}", color = if (on) c.ink else c.text) }
                        }
                    }
                }
                Row(Modifier.align(Alignment.TopEnd).padding(Space.md), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    if (!control) Tag("View only")
                    if (zoom.zoomed) Box(Modifier.size(44.dp).clip(CircleShape).background(Color80).clickable { zoom.reset() }, contentAlignment = Alignment.Center) { Icon(Ico.Reset, c.text) }
                }
                ViewerVideoOverlays(client, zoom, extras) // HOOK 2/3
                if (switching) Box(Modifier.fillMaxSize().background(Color(0x66000000)), contentAlignment = Alignment.Center) { Label("Switching display...") }
            }
            StateOverlay(state, diag, onRetry = client::retry, onExit = onExit)
        }
    }

    val controls: @Composable (Modifier) -> Unit = { mod ->
        Column(mod, verticalArrangement = Arrangement.spacedBy(Space.md)) {
            Trackpad(client, prefs, hostWidth, haptic, Modifier.weight(1f).fillMaxWidth())
            MouseButtons(client, haptic)
            ShortcutDeck(prefs.shortcuts, client, haptic)
            if (prefs.simpleGestures) SimpleGestureButtons(client, haptic)
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
                ToolButton(Ico.Display, "Displays", Modifier.weight(1f), enabled = monitors.isNotEmpty()) { overlay = Overlay.Displays }
                ToolButton(Ico.Swap, "Next display", Modifier.weight(1f), enabled = sortedMonitors.size > 1) {
                    val i = sortedMonitors.indexOfFirst { it.id == active }
                    sortedMonitors.getOrNull((i + 1) % sortedMonitors.size)?.let { client.switchMonitor(it.id) }
                }
                ToolButton(Ico.Keyboard, "Keyboard", Modifier.weight(1f)) { overlay = Overlay.Keyboard }
                ToolButton(Ico.Touch, "Direct touch", Modifier.weight(1f), active = prefs.directTouch) { onPrefs { it.copy(directTouch = !it.directTouch) } }
            }
        }
    }

    // an attached keyboard and mouse drive the PC while the session is live and no sheet is open
    Box(Modifier.fillMaxSize().background(c.bg).hardwareInput(client, live && overlay == Overlay.None, prefs, hostWidth)) {
        if (landscape) {
            Row(Modifier.fillMaxSize().navigationBarsPadding()) {
                video(Modifier.weight(1f).fillMaxHeight())
                Column(Modifier.width(304.dp).fillMaxHeight().statusBarsPadding().padding(Space.md), verticalArrangement = Arrangement.spacedBy(Space.md)) {
                    TopBar(hostName, state, stats, rtt, prefs.showStats, onExit) { overlay = Overlay.Settings }
                    if (live) controls(Modifier.weight(1f))
                }
            }
        } else {
            Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
                TopBar(hostName, state, stats, rtt, prefs.showStats, onExit, Modifier.padding(horizontal = Space.md, vertical = Space.sm)) { overlay = Overlay.Settings }
                video(Modifier.fillMaxWidth().weight(1.15f))
                if (live) controls(Modifier.fillMaxWidth().weight(1f).padding(Space.md)) else Box(Modifier.weight(1f))
            }
        }
        when (overlay) {
            Overlay.Keyboard -> KeyboardSheet(client, haptic, prefs, onPrefs) { overlay = Overlay.None }
            Overlay.Displays -> MonitorSheet(client) { overlay = Overlay.None }
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
private fun StateOverlay(state: ConnState, diag: String, onRetry: () -> Unit, onExit: () -> Unit) {
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
                Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    Pill("Back", onExit)
                    Pill("Try again", onRetry, primary = true)
                }
            }
        }
    }
}

/** On-screen Middle click and scrolling for people who cannot do the multi-finger gestures. */
@Composable
private fun SimpleGestureButtons(client: ScreenClient, haptic: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
        Pill("Middle", { client.click(MouseButton.Middle); haptic(false) }, Modifier.weight(1f))
        Pill("Up", { client.scrollBy(0f, 3f); haptic(false) }, Modifier.weight(1f))
        Pill("Down", { client.scrollBy(0f, -3f); haptic(false) }, Modifier.weight(1f))
    }
}

@Composable
private fun Tag(text: String) {
    val c = Gs.colors
    Box(Modifier.height(40.dp).clip(RoundedCornerShape(Radius.control)).background(Color80).border(1.dp, c.line, RoundedCornerShape(Radius.control)).padding(horizontal = Space.lg), contentAlignment = Alignment.Center) {
        Label(text, style = Gs.type.small)
    }
}

@Composable
private fun ToolButton(kind: Ico, description: String, modifier: Modifier, active: Boolean = false, enabled: Boolean = true, onClick: () -> Unit) {
    val c = Gs.colors
    PressBox(
        { if (enabled) onClick() }, modifier.height(48.dp), description, RoundedCornerShape(Radius.chip),
        background = if (active) c.accent else c.s2, border = !active,
    ) { Icon(kind, if (!enabled) c.dim else if (active) c.ink else c.text) }
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
