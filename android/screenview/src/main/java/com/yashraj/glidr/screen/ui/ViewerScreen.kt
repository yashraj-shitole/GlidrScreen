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
import com.yashraj.glidr.screen.net.ScreenClient

private enum class Overlay { None, Keyboard, Displays, Settings }

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
    val landscape = LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
    val view = LocalView.current

    val haptic: (Boolean) -> Unit = { strong ->
        if (prefs.haptics) view.performHapticFeedback(if (strong) HapticFeedbackConstants.LONG_PRESS else HapticFeedbackConstants.VIRTUAL_KEY)
    }

    BackHandler { if (overlay != Overlay.None) overlay = Overlay.None else onExit() }
    ViewerWindowEffect(hideBars = landscape)

    val sortedMonitors = remember(monitors) { monitors.sortedWith(compareBy({ it.x }, { it.y })) }
    val live = state is ConnState.Live
    val hostWidth = monitors.firstOrNull { it.id == active }?.w ?: 1920

    val video: @Composable (Modifier) -> Unit = { mod ->
        Box(mod.background(c.bg)) {
            RemoteVideo(track, client, zoom, prefs.directTouch, videoSize, haptic, Modifier.fillMaxSize())
            if (live) {
                Row(Modifier.align(Alignment.TopStart).padding(10.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (sortedMonitors.size > 1) {
                        sortedMonitors.forEachIndexed { i, m ->
                            val on = m.id == active
                            Box(
                                Modifier.size(38.dp).clip(CircleShape).background(if (on) c.accent else Color80).clickable { client.switchMonitor(m.id); haptic(false) },
                                contentAlignment = Alignment.Center,
                            ) { Label("${i + 1}", color = if (on) c.ink else c.text) }
                        }
                    }
                }
                Row(Modifier.align(Alignment.TopEnd).padding(10.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (!control) Tag("View only")
                    if (zoom.zoomed) Box(Modifier.size(38.dp).clip(CircleShape).background(Color80).clickable { zoom.reset() }, contentAlignment = Alignment.Center) { Icon(Ico.Reset, c.text, 18.dp) }
                }
                if (switching) Box(Modifier.fillMaxSize().background(Color(0x66000000)), contentAlignment = Alignment.Center) { Label("Switching display...") }
            }
            StateOverlay(state, diag, onRetry = client::retry, onExit = onExit)
        }
    }

    val controls: @Composable (Modifier) -> Unit = { mod ->
        Column(mod, verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Trackpad(client, prefs, hostWidth, haptic, Modifier.weight(1f).fillMaxWidth())
            MouseButtons(client, haptic)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
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

    Box(Modifier.fillMaxSize().background(c.bg)) {
        if (landscape) {
            Row(Modifier.fillMaxSize().navigationBarsPadding()) {
                video(Modifier.weight(1f).fillMaxHeight())
                Column(Modifier.width(300.dp).fillMaxHeight().statusBarsPadding().padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    TopBar(hostName, state, stats, rtt, prefs.showStats, onExit) { overlay = Overlay.Settings }
                    if (live) controls(Modifier.weight(1f))
                }
            }
        } else {
            Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
                TopBar(hostName, state, stats, rtt, prefs.showStats, onExit, Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) { overlay = Overlay.Settings }
                video(Modifier.fillMaxWidth().weight(1.15f))
                if (live) controls(Modifier.fillMaxWidth().weight(1f).padding(12.dp)) else Box(Modifier.weight(1f))
            }
        }
        when (overlay) {
            Overlay.Keyboard -> KeyboardSheet(client, haptic) { overlay = Overlay.None }
            Overlay.Displays -> MonitorSheet(client) { overlay = Overlay.None }
            Overlay.Settings -> SettingsSheet(client, prefs, onPrefs, onDisconnect = onExit) { overlay = Overlay.None }
            Overlay.None -> {}
        }
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
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        RoundIconButton(Ico.Back, "Disconnect", onExit, size = 44.dp)
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
        RoundIconButton(Ico.Settings, "Settings", onSettings, size = 44.dp)
    }
}

@Composable
private fun StateOverlay(state: ConnState, diag: String, onRetry: () -> Unit, onExit: () -> Unit) {
    val c = Gs.colors
    val text = when (state) {
        is ConnState.Connecting -> state.step + "..."
        is ConnState.Reconnecting -> "Connection lost. Reconnecting (${state.attempt})..."
        is ConnState.Failed -> state.reason
        else -> null
    } ?: return
    Box(Modifier.fillMaxSize().background(if (state is ConnState.Failed) c.bg else Color(0xB3000000)), contentAlignment = Alignment.Center) {
        Column(Modifier.padding(28.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Label(text, color = if (state is ConnState.Failed) c.bad else c.text, style = Gs.type.body)
            if (diag.isNotEmpty() && state !is ConnState.Live) Label(diag, color = c.dim, style = Gs.type.mono)
            if (state is ConnState.Failed) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
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
    Box(Modifier.height(38.dp).clip(RoundedCornerShape(19.dp)).background(Color80).border(1.dp, c.line, RoundedCornerShape(19.dp)).padding(horizontal = 14.dp), contentAlignment = Alignment.Center) {
        Label(text, style = Gs.type.small)
    }
}

@Composable
private fun ToolButton(kind: Ico, description: String, modifier: Modifier, active: Boolean = false, enabled: Boolean = true, onClick: () -> Unit) {
    val c = Gs.colors
    PressBox(
        { if (enabled) onClick() }, modifier.height(52.dp), description, RoundedCornerShape(16.dp),
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
