package com.yashraj.glidr.screen.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.yashraj.glidr.screen.net.FPS_OPTIONS
import com.yashraj.glidr.screen.net.ScreenClient

/** Caption under the stream quality control; says what the PC is really doing. */
fun streamCaption(fps: Int, saver: Boolean): String =
    "Quality caps the resolution and bitrate sent from the PC. Now streaming at $fps fps" +
        (if (saver) " with data saver on." else ". Higher frame rates use more data and battery.")

/**
 * Settings: caption for the quality control, frame rate and data saver. Replaces the old fixed "Always 24 fps" line,
 * so call it right below the quality [Segmented] inside the settings column.
 */
@Composable
fun StreamTuning(client: ScreenClient) {
    val c = Gs.colors
    val quality by client.quality.collectAsState()
    val fps by client.fps.collectAsState()
    val saver by client.dataSaver.collectAsState()
    Label(streamCaption(fps, saver), color = c.dim, style = Gs.type.small)
    Label("Frame rate", color = c.dim, style = Gs.type.small)
    Segmented(FPS_OPTIONS.map { it.toString() }, FPS_OPTIONS.indexOf(fps), { client.setStreamQuality(quality, FPS_OPTIONS[it], saver) })
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Label("Data saver")
            Label("Lower bitrate to use less mobile data", color = c.dim, style = Gs.type.small)
        }
        Toggle(saver, { client.setStreamQuality(quality, fps, it) }, "Data saver")
    }
}
