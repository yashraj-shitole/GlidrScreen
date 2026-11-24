package com.yashraj.glidr.screen.net

import android.content.ContentResolver
import android.net.Uri
import android.provider.OpenableColumns
import java.io.InputStream

/**
 * A file picked with the system picker or shared to the app, read through the [ContentResolver]. Creating one only
 * asks for the name and size (metadata); the content is not opened until [open], which the sender calls after the PC
 * accepted the offer.
 */
class UriFileSource(private val resolver: ContentResolver, private val uri: Uri) : FileSource {
    override val name: String
    override val size: Long

    init {
        var n: String? = null
        var s = -1L
        try {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    val si = c.getColumnIndex(OpenableColumns.SIZE)
                    if (ni >= 0 && !c.isNull(ni)) n = c.getString(ni)
                    if (si >= 0 && !c.isNull(si)) s = c.getLong(si)
                }
            }
            if (s < 0) s = resolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: -1L // some providers omit SIZE
        } catch (_: Exception) {
            // SecurityException (permission gone), missing provider, ...: reported as "Could not read this file"
        }
        name = FileNames.display(n ?: uri.lastPathSegment)
        size = if (s < 0) -1L else s
    }

    override fun open(): InputStream = resolver.openInputStream(uri) ?: throw java.io.IOException("cannot open")

    companion object {
        /** Only `content://` URIs are read: a `file://` link from another app could point into this app's private files. */
        fun isReadable(uri: Uri): Boolean = uri.scheme == ContentResolver.SCHEME_CONTENT
    }
}

/** Names shown and offered. The PC sanitises again; this only keeps the offered name short and free of paths. */
object FileNames {
    fun display(raw: String?): String {
        val last = raw.orEmpty().substringAfterLast('/').substringAfterLast('\\').trim()
        return last.ifEmpty { "file" }.take(200)
    }
}
