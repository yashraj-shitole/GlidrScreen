package com.yashraj.glidr.screen.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.yashraj.glidr.screen.net.ScreenClient

private val Scrim = Color(0xCC000000)
private val RecordingRed = Color(0xFFFF3B30)

/**
 * A small red dot and "PC is recording" while the PC saves this session to a video file (the PC owner switched
 * "Record sessions" on; see docs/PROTOCOL.md, "Recording"). Not dismissible: the person holding the phone always knows.
 */
@Composable
fun RecordingTag(modifier: Modifier = Modifier) {
    val c = Gs.colors
    val shape = RoundedCornerShape(Radius.control)
    Row(
        modifier.height(40.dp).clip(shape).background(Scrim, shape).border(1.dp, c.line, shape).padding(horizontal = Space.lg)
            .semantics { contentDescription = "The PC is recording this session" },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.sm),
    ) {
        Box(Modifier.size(Space.sm).clip(CircleShape).background(RecordingRed))
        Label("PC is recording", color = Color.White, style = Gs.type.small)
    }
}

/** One item of the viewer's status stack (top left of the picture): the tag, only while the PC records. */
@Composable
fun RecordingStatus(client: ScreenClient) {
    val recording by client.recording.collectAsState()
    if (recording) RecordingTag()
}
