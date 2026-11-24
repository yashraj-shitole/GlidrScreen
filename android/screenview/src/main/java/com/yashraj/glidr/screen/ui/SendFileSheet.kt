package com.yashraj.glidr.screen.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.yashraj.glidr.screen.net.FileItem
import com.yashraj.glidr.screen.net.FileProgress
import com.yashraj.glidr.screen.net.FileStatus
import com.yashraj.glidr.screen.net.FileTexts
import com.yashraj.glidr.screen.net.ScreenClient
import com.yashraj.glidr.screen.net.UriFileSource
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Send files from this phone to the PC (saved in its Downloads\Glidr folder). Files come from the system picker or,
 * waiting in [shares], from another app's Share menu. Nothing shared is read or sent until the user taps Send here.
 */
@Composable
fun SendFileSheet(client: ScreenClient, shares: ShareQueue, onDismiss: () -> Unit) {
    val c = Gs.colors
    val context = LocalContext.current
    val queue by client.fileTransfers.collectAsState()
    val waiting = shares.uris

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { picked: List<Uri> ->
        if (picked.isNotEmpty()) client.sendFiles(context.contentResolver, picked)
    }
    // Name and size only (metadata), and only now that the user is connected and looking at the sheet.
    val waitingNames by produceState(emptyList<Pair<String, Long>>(), waiting) {
        value = withContext(Dispatchers.IO) { waiting.map { UriFileSource(context.contentResolver, it) }.map { it.name to it.size } }
    }

    Sheet(onDismiss) {
        Label("Send file", style = Gs.type.body)
        Label("Files go straight to your PC and are saved in its Downloads\\Glidr folder, never through a server.", color = c.dim, style = Gs.type.small)

        if (waiting.isNotEmpty() && !queue.busy) {
            Label("Ready to send from another app:", style = Gs.type.small)
            Column(Modifier.heightIn(max = 140.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(Space.xs)) {
                waitingNames.forEach { (name, size) ->
                    Label("$name${if (size >= 0) "  ${FileProgress.humanSize(size)}" else ""}", color = c.dim, style = Gs.type.small, maxLines = 1)
                }
            }
            Pill("Send ${FileTexts.files(waiting.size)}", { client.sendFiles(context.contentResolver, shares.take()) }, Modifier.fillMaxWidth(), primary = true)
            Pill("Discard", { shares.discard() }, Modifier.fillMaxWidth())
        }

        if (queue.items.isNotEmpty()) {
            Column(Modifier.heightIn(max = 260.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(Space.md)) {
                queue.items.forEach { FileRow(it) }
            }
        }

        if (queue.busy) {
            Pill("Cancel", { client.cancelFiles() }, Modifier.fillMaxWidth(), danger = true)
        } else {
            if (waiting.isEmpty()) {
                Pill("Choose files", { picker.launch(arrayOf("*/*")) }, Modifier.fillMaxWidth(), primary = queue.items.isEmpty())
            }
            Pill("Done", { client.clearFiles(); onDismiss() }, Modifier.fillMaxWidth())
        }
    }
}

@Composable
private fun FileRow(item: FileItem) {
    val c = Gs.colors
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Space.xs)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
            Label(item.name, Modifier.weight(1f), maxLines = 1)
            if (item.size >= 0) Label(FileProgress.humanSize(item.size), color = c.dim, style = Gs.type.small)
        }
        if (item.status == FileStatus.Sending || item.status == FileStatus.Finishing) {
            Box(Modifier.fillMaxWidth().height(8.dp).clip(CircleShape).background(c.s3)) {
                Box(Modifier.fillMaxWidth(FileProgress.fraction(item.sent, item.size)).height(8.dp).clip(CircleShape).background(c.accent))
            }
        }
        val text = FileTexts.status(item)
        if (text.isNotEmpty()) {
            Label(
                text, maxLines = 3, style = Gs.type.small,
                color = when (item.status) { FileStatus.Failed -> c.bad; FileStatus.Done -> c.accentText; else -> c.dim },
            )
        }
    }
}
