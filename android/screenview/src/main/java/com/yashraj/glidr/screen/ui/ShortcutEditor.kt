package com.yashraj.glidr.screen.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.yashraj.glidr.screen.ViewerPrefs
import com.yashraj.glidr.screen.input.CustomShortcut
import com.yashraj.glidr.screen.input.HostKeys
import com.yashraj.glidr.screen.input.ShortcutError
import com.yashraj.glidr.screen.input.Shortcuts
import com.yashraj.glidr.screen.net.ScreenClient

/** Up to four pinned favourites, shown as a row of chips under the mouse buttons. Draws nothing when none are pinned. */
@Composable
fun ShortcutDeck(shortcuts: List<CustomShortcut>, client: ScreenClient, haptic: (Boolean) -> Unit, modifier: Modifier = Modifier) {
    val pinned = Shortcuts.pinned(shortcuts)
    if (pinned.isEmpty()) return
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
        pinned.forEach { s ->
            PressBox(
                { client.combo(s.keys); haptic(false) }, Modifier.weight(1f).height(44.dp), "${s.label}, ${s.describe}", RoundedCornerShape(Radius.key),
            ) { Label(s.label, maxLines = 1, style = Gs.type.small.copy(fontWeight = FontWeight.SemiBold), modifier = Modifier.padding(horizontal = Space.sm)) }
        }
    }
}

/** The "Your shortcuts" part of the keyboard sheet's Shortcuts section: tap to send, pin, delete, add. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun CustomShortcutsSection(
    prefs: ViewerPrefs,
    onPrefs: ((ViewerPrefs) -> ViewerPrefs) -> Unit,
    client: ScreenClient,
    haptic: (Boolean) -> Unit,
) {
    val c = Gs.colors
    val list = prefs.shortcuts
    var editing by remember { mutableStateOf(false) }
    var label by remember { mutableStateOf("") }
    val mods = remember { mutableStateListOf<String>() }
    var key by remember { mutableStateOf<String?>(null) }
    var pin by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
        Label("Your shortcuts", color = c.dim, style = Gs.type.small)
        if (list.isEmpty() && !editing) {
            Label("Add up to ${Shortcuts.MAX}. Pin up to ${Shortcuts.MAX_PINNED} to keep them under the mouse buttons.", color = c.dim, style = Gs.type.small)
        }
        list.forEachIndexed { i, s ->
            Row(horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalAlignment = Alignment.CenterVertically) {
                PressBox(
                    { client.combo(s.keys); haptic(false) }, Modifier.weight(1f).height(44.dp), "${s.label}, ${s.describe}", RoundedCornerShape(Radius.key),
                ) {
                    Row(Modifier.padding(horizontal = Space.md), horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalAlignment = Alignment.CenterVertically) {
                        Label(s.label, maxLines = 1, style = Gs.type.small.copy(fontWeight = FontWeight.SemiBold), modifier = Modifier.weight(1f, fill = false))
                        Label(s.describe, color = c.dim, maxLines = 1, style = Gs.type.mono)
                    }
                }
                val canPin = s.pinned || list.count { it.pinned } < Shortcuts.MAX_PINNED
                PressBox(
                    { if (canPin) onPrefs { it.copy(shortcuts = Shortcuts.togglePin(it.shortcuts, i)) } },
                    Modifier.size(width = 64.dp, height = 44.dp), if (s.pinned) "Unpin ${s.label}" else "Pin ${s.label}", RoundedCornerShape(Radius.key),
                    background = if (s.pinned) c.accent else c.s2, border = !s.pinned,
                ) { Label(if (s.pinned) "Pinned" else "Pin", color = if (s.pinned) c.ink else if (canPin) c.text else c.dim, maxLines = 1, style = Gs.type.small) }
                PressBox(
                    { onPrefs { it.copy(shortcuts = Shortcuts.remove(it.shortcuts, i)) } },
                    Modifier.size(44.dp), "Delete ${s.label}", RoundedCornerShape(Radius.key),
                ) { Icon(Ico.Trash, c.text, 20.dp) }
            }
        }
        if (!editing) {
            if (list.size < Shortcuts.MAX) {
                PressBox({ editing = true }, Modifier.height(44.dp).widthIn(min = 96.dp), "Add shortcut", RoundedCornerShape(Radius.key)) {
                    Label("Add shortcut", maxLines = 1, style = Gs.type.small.copy(fontWeight = FontWeight.SemiBold), modifier = Modifier.padding(horizontal = Space.md))
                }
            }
        } else {
            BasicTextField(
                value = label, onValueChange = { label = it.take(Shortcuts.MAX_LABEL); error = null },
                textStyle = Gs.type.body.copy(color = c.text), cursorBrush = SolidColor(c.accent), singleLine = true,
                decorationBox = { inner ->
                    Box(Modifier.fillMaxWidth().height(48.dp).clip(RoundedCornerShape(Radius.chip)).background(c.s2).padding(horizontal = Space.lg), contentAlignment = Alignment.CenterStart) {
                        if (label.isEmpty()) Label("Name, for example Lock PC", color = c.dim)
                        inner()
                    }
                },
            )
            Label("Modifiers", color = c.dim, style = Gs.type.small)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                HostKeys.MODIFIERS.forEach { m ->
                    val on = m in mods
                    EditorChip(m, on) { if (on) mods.remove(m) else mods.add(m); error = null }
                }
            }
            Label("Key  ${key ?: "none"}", color = c.dim, style = Gs.type.small)
            Box(Modifier.fillMaxWidth().heightIn(max = 132.dp).verticalScroll(rememberScrollState())) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                    HostKeys.PICKER.forEach { k -> EditorChip(k, key == k) { key = if (key == k) null else k; error = null } }
                }
            }
            error?.let { Label(it, color = c.bad, style = Gs.type.small) }
            Row(horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalAlignment = Alignment.CenterVertically) {
                EditorChip("Pin", pin, wide = true) { pin = !pin }
                Pill("Cancel", { editing = false; label = ""; mods.clear(); key = null; pin = false; error = null }, Modifier.weight(1f))
                Pill("Save", {
                    val keys = mods.toList() + listOfNotNull(key)
                    val err: ShortcutError? = Shortcuts.validate(label, keys)
                    val made = if (err == null) Shortcuts.create(label, keys, pin) else null
                    val next = made?.let { Shortcuts.add(list, it) }
                    if (next != null) {
                        onPrefs { it.copy(shortcuts = next) }
                        editing = false; label = ""; mods.clear(); key = null; pin = false; error = null
                    } else {
                        error = err?.message ?: "You can keep up to ${Shortcuts.MAX} shortcuts."
                    }
                }, Modifier.weight(1f), primary = true)
            }
        }
    }
}

@Composable
private fun EditorChip(label: String, active: Boolean, wide: Boolean = false, onClick: () -> Unit) {
    val c = Gs.colors
    PressBox(
        onClick, Modifier.height(44.dp).widthIn(min = if (wide || label.length > 3) 64.dp else 44.dp), label, RoundedCornerShape(Radius.key),
        background = if (active) c.accent else c.s2, border = !active,
    ) { Label(label, color = if (active) c.ink else c.text, maxLines = 1, style = Gs.type.small.copy(fontWeight = FontWeight.SemiBold), modifier = Modifier.padding(horizontal = Space.sm)) }
}
