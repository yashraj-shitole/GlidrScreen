package com.yashraj.glidr.screen.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import com.yashraj.glidr.screen.ViewerPrefs
import com.yashraj.glidr.screen.net.Monitor
import com.yashraj.glidr.screen.net.Quality
import com.yashraj.glidr.screen.net.ScreenClient
import kotlin.math.min

// ------------------------------------------------------------------------------------------------ displays

/** Layout map of every PC monitor with live previews; tap one to view it. */
@Composable
fun MonitorSheet(client: ScreenClient, onDismiss: () -> Unit) {
    val c = Gs.colors
    val monitors by client.monitors.collectAsState()
    val active by client.activeMonitor.collectAsState()
    val thumbs by client.thumbs.collectAsState()

    DisposableEffect(client) {
        client.setThumbnails(true)
        onDispose { client.setThumbnails(false) }
    }

    Sheet(onDismiss) {
        Label("Displays", style = Gs.type.body)
        Label("Tap a display to see and control it.", color = c.dim, style = Gs.type.small)
        if (monitors.isEmpty()) {
            Label("Waiting for the PC...", color = c.dim)
        } else {
            val minX = monitors.minOf { it.x }
            val minY = monitors.minOf { it.y }
            val totalW = (monitors.maxOf { it.x + it.w } - minX).toFloat()
            val totalH = (monitors.maxOf { it.y + it.h } - minY).toFloat()
            BoxWithConstraints(Modifier.fillMaxWidth()) {
                val scale = min(maxWidth.value / totalW, 230f / totalH)
                Box(Modifier.align(Alignment.Center).size((totalW * scale).dp, (totalH * scale).dp)) {
                    monitors.forEachIndexed { i, m ->
                        val on = m.id == active
                        val shape = RoundedCornerShape(8.dp)
                        Box(
                            Modifier.offset(((m.x - minX) * scale).dp, ((m.y - minY) * scale).dp).size((m.w * scale).dp - 4.dp, (m.h * scale).dp - 4.dp)
                                .clip(shape).background(c.s2).border(if (on) 3.dp else 1.dp, if (on) c.accent else c.line, shape)
                                .clickable { client.switchMonitor(m.id); onDismiss() },
                        ) {
                            thumbs[m.id]?.let { Image(it.asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop) }
                            Label(
                                "${i + 1}  ${m.w}x${m.h}", color = if (on) c.ink else c.text, style = Gs.type.mono,
                                modifier = Modifier.align(Alignment.BottomStart).padding(6.dp).clip(RoundedCornerShape(6.dp))
                                    .background(if (on) c.accent else Color0).padding(horizontal = 6.dp, vertical = 2.dp),
                            )
                        }
                    }
                }
            }
        }
        Pill("Close", onDismiss, Modifier.fillMaxWidth())
    }
}

private val Color0 = androidx.compose.ui.graphics.Color(0xB3000000)

// ------------------------------------------------------------------------------------------------ keyboard

private val MODIFIERS = listOf("Ctrl", "Alt", "Shift", "Win")

private data class Shortcut(val label: String, val keys: List<String>)

private val SHORTCUTS = listOf(
    Shortcut("Copy", listOf("Ctrl", "C")), Shortcut("Paste", listOf("Ctrl", "V")), Shortcut("Cut", listOf("Ctrl", "X")),
    Shortcut("Undo", listOf("Ctrl", "Z")), Shortcut("Select all", listOf("Ctrl", "A")), Shortcut("Save", listOf("Ctrl", "S")),
    Shortcut("Find", listOf("Ctrl", "F")), Shortcut("Alt+Tab", listOf("Alt", "Tab")), Shortcut("Desktop", listOf("Win", "D")),
    Shortcut("Task view", listOf("Win", "Tab")), Shortcut("Task Manager", listOf("Ctrl", "Shift", "Esc")),
    Shortcut("Snip", listOf("Win", "Shift", "S")), Shortcut("Lock", listOf("Win", "L")), Shortcut("Close window", listOf("Alt", "F4")),
    Shortcut("Refresh", listOf("F5")), Shortcut("Full screen", listOf("F11")),
)

private val MEDIA = listOf("Vol -" to "VolDown", "Vol +" to "VolUp", "Mute" to "Mute", "Prev" to "Prev", "Play/Pause" to "PlayPause", "Next" to "Next")

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun KeyboardSheet(client: ScreenClient, haptic: (Boolean) -> Unit, onDismiss: () -> Unit) {
    val c = Gs.colors
    val latched: SnapshotStateList<String> = remember { mutableStateListOf() }
    var field by remember { mutableStateOf(TextFieldValue("")) }
    var phrase by remember { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current

    LaunchedEffect(Unit) { focus.requestFocus(); keyboard?.show() }

    fun press(name: String) {
        if (latched.isEmpty()) client.key(name) else { client.combo(latched.toList() + name); latched.clear() }
        haptic(false)
    }

    fun onTyped(new: TextFieldValue) {
        val old = field.text
        val prefix = old.commonPrefixWith(new.text).length
        repeat(old.length - prefix) { press("Backspace") }
        val added = new.text.substring(prefix)
        if (added.isNotEmpty()) {
            if (latched.isNotEmpty() && added.length == 1) { client.combo(latched.toList() + added); latched.clear() } else client.typeText(added)
        }
        // keep the buffer short; the PC already has the characters
        field = if (new.text.length > 48) TextFieldValue("") else new
    }

    Sheet(onDismiss) {
        Column(Modifier.imePadding().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            BasicTextField(
                value = field,
                onValueChange = ::onTyped,
                textStyle = Gs.type.body.copy(color = c.text),
                cursorBrush = SolidColor(c.accent),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Send, autoCorrectEnabled = false),
                keyboardActions = KeyboardActions(onSend = { press("Enter") }),
                singleLine = true,
                decorationBox = { inner ->
                    Box(Modifier.fillMaxWidth().height(52.dp).clip(RoundedCornerShape(14.dp)).background(c.s2).padding(horizontal = 14.dp), contentAlignment = Alignment.CenterStart) {
                        if (field.text.isEmpty()) Label("Type here, it goes to the PC", color = c.dim)
                        inner()
                    }
                },
                modifier = Modifier.focusRequester(focus),
            )
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                MODIFIERS.forEach { m ->
                    KeyChip(m, active = m in latched) { if (m in latched) latched.remove(m) else latched.add(m); haptic(false) }
                }
                KeyChip("Esc") { press("Esc") }; KeyChip("Tab") { press("Tab") }; KeyChip("Enter") { press("Enter") }
                KeyChip("Bksp") { press("Backspace") }; KeyChip("Del") { press("Del") }; KeyChip("Space") { press("Space") }
                KeyChip("Left") { press("Left") }; KeyChip("Up") { press("Up") }; KeyChip("Down") { press("Down") }; KeyChip("Right") { press("Right") }
                KeyChip("Home") { press("Home") }; KeyChip("End") { press("End") }; KeyChip("PgUp") { press("PgUp") }; KeyChip("PgDn") { press("PgDn") }
                for (i in 1..12) KeyChip("F$i") { press("F$i") }
            }
            Label("Shortcuts", color = c.dim, style = Gs.type.small)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                SHORTCUTS.forEach { s -> KeyChip(s.label) { client.combo(s.keys); haptic(false) } }
            }
            Label("Media", color = c.dim, style = Gs.type.small)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                MEDIA.forEach { (label, key) -> KeyChip(label) { client.key(key); haptic(false) } }
            }
            Label("Type a phrase in any language", color = c.dim, style = Gs.type.small)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                BasicTextField(
                    value = phrase, onValueChange = { phrase = it },
                    textStyle = Gs.type.body.copy(color = c.text), cursorBrush = SolidColor(c.accent),
                    modifier = Modifier.weight(1f).heightIn52().clip(RoundedCornerShape(14.dp)).background(c.s2).padding(14.dp),
                )
                Pill("Send", { client.typeText(phrase); phrase = "" }, enabled = phrase.isNotEmpty(), primary = true)
            }
            Pill("Done", onDismiss, Modifier.fillMaxWidth())
        }
    }
}

private fun Modifier.heightIn52() = this.then(Modifier.height(52.dp))

@Composable
private fun KeyChip(label: String, active: Boolean = false, onClick: () -> Unit) {
    val c = Gs.colors
    PressBox(
        onClick, Modifier.height(44.dp).width(if (label.length > 5) 96.dp else 62.dp), label, RoundedCornerShape(12.dp),
        background = if (active) c.accent else c.s2, border = !active,
    ) { Label(label, color = if (active) c.ink else c.text, maxLines = 1, style = Gs.type.small.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold)) }
}

// ------------------------------------------------------------------------------------------------ settings

@Composable
fun SettingsSheet(
    client: ScreenClient,
    prefs: ViewerPrefs,
    onPrefs: ((ViewerPrefs) -> ViewerPrefs) -> Unit,
    onDisconnect: () -> Unit,
    onDismiss: () -> Unit,
) {
    val c = Gs.colors
    val quality by client.quality.collectAsState()
    Sheet(onDismiss) {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Label("Stream quality", color = c.dim, style = Gs.type.small)
            Segmented(Quality.entries.map { it.label }, quality.ordinal, { client.setQuality(Quality.entries[it]) })
            Label("Always 24 fps. This caps the resolution and bitrate sent from the PC.", color = c.dim, style = Gs.type.small)

            Label("Pointer speed  %.1fx".format(prefs.sensitivity), color = c.dim, style = Gs.type.small)
            Slider(prefs.sensitivity, 0.5f..3.5f, { v -> onPrefs { it.copy(sensitivity = v) } }, "Pointer speed")
            Label("Pointer acceleration", color = c.dim, style = Gs.type.small)
            Segmented(listOf("Off", "Low", "Med", "High"), prefs.accel, { v -> onPrefs { it.copy(accel = v) } })
            Label("Scroll speed  %.1fx".format(prefs.scrollSpeed), color = c.dim, style = Gs.type.small)
            Slider(prefs.scrollSpeed, 0.4f..3f, { v -> onPrefs { it.copy(scrollSpeed = v) } }, "Scroll speed")

            SettingRow("Natural scrolling", "Content follows your fingers", prefs.naturalScroll) { v -> onPrefs { it.copy(naturalScroll = v) } }
            SettingRow("Direct touch", "Tap the picture to click that spot", prefs.directTouch) { v -> onPrefs { it.copy(directTouch = v) } }
            SettingRow("Haptics", "Vibrate on clicks", prefs.haptics) { v -> onPrefs { it.copy(haptics = v) } }
            SettingRow("Show stats", "fps, resolution, bitrate and ping", prefs.showStats) { v -> onPrefs { it.copy(showStats = v) } }
            SettingRow("Light theme", "Paper instead of Midnight", prefs.light) { v -> onPrefs { it.copy(light = v) } }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Pill("Disconnect", onDisconnect, Modifier.weight(1f))
                Pill("Done", onDismiss, Modifier.weight(1f), primary = true)
            }
        }
    }
}

@Composable
private fun SettingRow(title: String, sub: String, on: Boolean, onChange: (Boolean) -> Unit) {
    val c = Gs.colors
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Label(title)
            Label(sub, color = c.dim, style = Gs.type.small)
        }
        Toggle(on, onChange, title)
    }
}
