package com.yashraj.glidr.screen.ui

import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.yashraj.glidr.screen.net.FileLimits
import com.yashraj.glidr.screen.net.FileTexts
import com.yashraj.glidr.screen.net.UriFileSource

/**
 * Files other apps shared to Glidr Screen ("Share" > Glidr Screen), waiting for a connection. Only the URIs are kept:
 * nothing is read from them until the user is connected and confirms the send in the send sheet.
 */
class ShareQueue {
    var uris by mutableStateOf<List<Uri>>(emptyList())
        private set

    /** Adds shared files. Only `content://` URIs are kept (a `file://` link could point at this app's private files). */
    fun add(list: List<Uri>) {
        uris = (uris + list.filter { UriFileSource.isReadable(it) }).distinct().take(FileLimits.MAX_QUEUED)
    }

    /** Hands the waiting files over (to be sent) and empties the queue. */
    fun take(): List<Uri> = uris.also { uris = emptyList() }

    fun discard() { uris = emptyList() }
}

val LocalShareQueue = staticCompositionLocalOf { ShareQueue() }

/** Shown over the PC list while shared files wait for a connection. */
@Composable
fun ShareWaitingCard(shares: ShareQueue, modifier: Modifier = Modifier) {
    val c = Gs.colors
    val shape = RoundedCornerShape(Radius.card)
    Box(modifier.fillMaxWidth().navigationBarsPadding().padding(Space.lg), contentAlignment = androidx.compose.ui.Alignment.BottomCenter) {
        Column(
            Modifier.widthIn(max = MAX_SHEET_WIDTH).fillMaxWidth().background(c.s1, shape).border(1.dp, c.line, shape).padding(Space.inset),
            verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(Space.md),
        ) {
            Label("Connect to a PC first", style = Gs.type.body)
            Label(
                "${FileTexts.files(shares.uris.size)} from another app ${if (shares.uris.size == 1) "is" else "are"} waiting. " +
                    "Connect to a PC and you can send ${if (shares.uris.size == 1) "it" else "them"} from there.",
                color = c.dim, style = Gs.type.small,
            )
            Pill("Discard", { shares.discard() }, Modifier.fillMaxWidth())
        }
    }
}
