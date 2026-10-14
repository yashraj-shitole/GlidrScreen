package com.yashraj.glidr.screen.update

import android.content.Context
import android.os.Build
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** Where to look for new versions: a GitHub repo whose releases carry the APK, and the running version. */
data class UpdateSource(val repo: String, val currentVersion: String)

data class Release(val version: String, val downloadUrl: String, val pageUrl: String)

sealed interface UpdateState {
    data object Idle : UpdateState
    data object Checking : UpdateState
    data object UpToDate : UpdateState
    /** The repo has no published release yet. */
    data object NoReleases : UpdateState
    /** Installed from Google Play, which delivers updates itself. */
    data object ViaStore : UpdateState
    data class Available(val release: Release) : UpdateState
    data class Failed(val reason: String) : UpdateState
}

/** Pure helpers, unit-tested. */
object Versions {
    /** Numeric parts of "v1.2.3" / "1.2.3-beta". */
    fun parse(v: String): List<Int> =
        v.trim().removePrefix("v").removePrefix("V").split('.', '-', '+').take(3).map { it.toIntOrNull() ?: 0 }

    /** > 0 when [a] is newer than [b]. */
    fun compare(a: String, b: String): Int {
        val x = parse(a)
        val y = parse(b)
        for (i in 0 until 3) {
            val d = x.getOrElse(i) { 0 } - y.getOrElse(i) { 0 }
            if (d != 0) return d
        }
        return 0
    }

    /** The first asset whose name ends with [suffix] (e.g. ".apk"), as (name, url) pairs. */
    fun pickAsset(assets: List<Pair<String, String>>, suffix: String): String? =
        assets.firstOrNull { it.first.endsWith(suffix, ignoreCase = true) }?.second
}

object GitHubReleases {
    /** Latest published release of [repo], or null when it has none. Throws on network or HTTP errors. */
    suspend fun latest(repo: String, userAgent: String, assetSuffix: String = ".apk"): Release? = withContext(Dispatchers.IO) {
        val conn = URL("https://api.github.com/repos/$repo/releases/latest").openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 10_000
            conn.readTimeout = 10_000
            conn.setRequestProperty("Accept", "application/vnd.github+json")
            conn.setRequestProperty("User-Agent", userAgent)
            when (val code = conn.responseCode) {
                404 -> return@withContext null
                !in 200..299 -> throw IllegalStateException("GitHub HTTP $code")
            }
            val json = JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
            val version = json.optString("tag_name").removePrefix("v").removePrefix("V")
            require(version.isNotBlank()) { "release has no tag" }
            val page = json.optString("html_url").takeIf { it.startsWith("https://") }
                ?: "https://github.com/$repo/releases/latest"
            val arr = json.optJSONArray("assets")
            val assets = (0 until (arr?.length() ?: 0)).map {
                val a = arr!!.getJSONObject(it)
                a.optString("name") to a.optString("browser_download_url")
            }.filter { it.second.startsWith("https://") }
            Release(version, Versions.pickAsset(assets, assetSuffix) ?: page, page)
        } finally {
            conn.disconnect()
        }
    }

    /** One check: [UpdateState.Available], [UpdateState.UpToDate], [UpdateState.NoReleases] or [UpdateState.Failed]. */
    suspend fun check(source: UpdateSource, userAgent: String): UpdateState = try {
        val r = latest(source.repo, userAgent)
        when {
            r == null -> UpdateState.NoReleases
            Versions.compare(r.version, source.currentVersion) > 0 -> UpdateState.Available(r)
            else -> UpdateState.UpToDate
        }
    } catch (e: Exception) {
        UpdateState.Failed(e.message ?: "Could not check for updates")
    }
}

/** True when Google Play installed this app; Play then owns updates and the app must not point elsewhere. */
fun installedFromPlay(context: Context): Boolean = try {
    val installer = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        context.packageManager.getInstallSourceInfo(context.packageName).installingPackageName
    } else {
        @Suppress("DEPRECATION")
        context.packageManager.getInstallerPackageName(context.packageName)
    }
    installer == "com.android.vending"
} catch (_: Exception) {
    false
}
