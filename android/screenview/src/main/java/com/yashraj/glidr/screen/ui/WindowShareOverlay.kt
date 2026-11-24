package com.yashraj.glidr.screen.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.yashraj.glidr.screen.net.ScreenClient
import com.yashraj.glidr.screen.net.SourceKind
import kotlinx.coroutines.delay

private val Scrim = Color(0xB3000000)

/**
 * Window sharing on top of the picture (call inside the video Box, while live): a "Window: <title>" tag while one
 * application window is shared, and a short notice when the PC could not share a window or fell back to a monitor.
 * The title is untrusted text from another program and is only ever drawn as plain, single-line text.
 */
@Composable
fun BoxScope.WindowShareOverlay(client: ScreenClient) {
    val c = Gs.colors
    val kind by client.activeKind.collectAsState()
    val window by client.activeWindow.collectAsState()
    var notice by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(client) { client.sourceMessage.collect { notice = it } }
    LaunchedEffect(notice) { if (notice != null) { delay(3_500); notice = null } }

    val shape = RoundedCornerShape(Radius.control)
    val w = window
    if (kind == SourceKind.Window && w != null) {
        // under the display buttons (44 dp) of the base top-left row
        Box(
            Modifier.align(Alignment.TopStart).padding(start = Space.md, top = Space.md + 44.dp + Space.sm).widthIn(max = 240.dp)
                .height(40.dp).clip(shape).background(Scrim, shape).border(1.dp, c.line, shape).padding(horizontal = Space.lg),
            contentAlignment = Alignment.Center,
        ) { Label("Window: ${w.title.ifBlank { "Untitled" }}", color = Color.White, style = Gs.type.small, maxLines = 1) }
    }
    notice?.let { text ->
        Box(
            Modifier.align(Alignment.BottomCenter).padding(Space.lg).clip(shape).background(Scrim, shape).border(1.dp, c.line, shape)
                .padding(horizontal = Space.lg, vertical = Space.md),
            contentAlignment = Alignment.Center,
        ) { Label(text, color = Color.White, style = Gs.type.small) }
    }
}
