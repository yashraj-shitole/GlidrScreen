package com.yashraj.glidr.screen.update

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log
import androidx.core.content.IntentCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.net.HttpURLConnection
import java.net.URL

enum class InstallError { Download, Damaged, Storage, Refused }

sealed interface InstallStep {
    data class Downloading(val percent: Int) : InstallStep
    data object Installing : InstallStep
    /** Android is waiting for the user to agree; [intent] opens its prompt. */
    data class Confirm(val intent: Intent) : InstallStep
    data class Failed(val error: InstallError) : InstallStep
}

data class Install(val release: Release, val step: InstallStep)

private const val NO_SESSION = -1

/** What an unsuccessful install status means; null when the user simply said no. */
fun installError(status: Int, message: String?): InstallError? = when {
    // Android calls it "aborted" when Play Protect or another verifier turns the APK away, too.
    status == PackageInstaller.STATUS_FAILURE_ABORTED && message?.contains("VERIFICATION") != true -> null
    status == PackageInstaller.STATUS_FAILURE_STORAGE -> InstallError.Storage
    else -> InstallError.Refused
}

/**
 * Downloads a release's APK straight into an Android install session and commits it, the same way the Glidr app updates
 * itself. Android itself checks that the APK is signed with the same key as this app and asks the user before
 * installing; nothing happens silently. One instance per process, see [ScreenUpdater].
 */
class Updater(private val context: Context, private val scope: CoroutineScope) {
    private val _state = MutableStateFlow<Install?>(null)
    /** Null when no update is under way. */
    val state: StateFlow<Install?> = _state.asStateFlow()

    private val installer get() = context.packageManager.packageInstaller
    private var job: Job? = null
    @Volatile private var sessionId = NO_SESSION
    private var confirmation: Intent? = null

    @Synchronized
    fun install(release: Release, userAgent: String) {
        val step = _state.value?.step
        if (step is InstallStep.Downloading || step == InstallStep.Installing) return
        if (!release.hasApk || !Versions.isTrustedLink(release.downloadUrl)) {
            _state.value = Install(release, InstallStep.Failed(InstallError.Refused))
            return
        }
        _state.value = Install(release, InstallStep.Downloading(0))
        val previous = job
        job = scope.launch(Dispatchers.IO) {
            previous?.join()
            try {
                download(release, userAgent) { ensureActive() }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.d("GlidrScreen", "update failed: $e")
                val error = if (e is DamagedDownload) InstallError.Damaged else InstallError.Download
                synchronized(this@Updater) {
                    ensureActive() // a cancelled download reports nothing
                    abandon()
                    _state.value = Install(release, InstallStep.Failed(error))
                }
            }
        }
    }

    /** Stops a download or an install that is waiting for the user, and clears any error. */
    @Synchronized
    fun cancel() {
        job?.cancel()
        confirmation = null
        abandon()
        _state.value = null
    }

    @Synchronized
    fun takeConfirmation(): Intent? = confirmation.also { confirmation = null }

    /** Progress from the download. Checked under the same lock as [cancel], so a cancelled one cannot come back. */
    @Synchronized
    private fun publish(release: Release, step: InstallStep, checkActive: () -> Unit) {
        checkActive()
        _state.value = Install(release, step)
    }

    private fun abandon() {
        sessionId = NO_SESSION
        // Includes any session an earlier, interrupted attempt left behind.
        runCatching { installer.mySessions.forEach { runCatching { installer.abandonSession(it.sessionId) } } }
    }

    private fun download(release: Release, userAgent: String, checkActive: () -> Unit) {
        abandon()
        val conn = URL(release.downloadUrl).openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 15_000
            conn.readTimeout = 30_000
            conn.setRequestProperty("User-Agent", userAgent)
            val code = conn.responseCode
            check(code == 200) { "HTTP $code" }
            // GitHub redirects to its file host; that must still be HTTPS.
            check(conn.url.protocol == "https") { "not HTTPS" }
            val length = conn.contentLengthLong

            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
            params.setAppPackageName(context.packageName) // Android rejects any other package.
            if (length > 0) params.setSize(length)
            val id = installer.createSession(params)
            sessionId = id
            installer.openSession(id).use { session ->
                session.openWrite("glidrscreen.apk", 0, length).use { out ->
                    conn.inputStream.use { input ->
                        copyVerified(input, out, length, release.sha256, checkActive) { percent ->
                            publish(release, InstallStep.Downloading(percent), checkActive)
                        }
                    }
                    session.fsync(out)
                }
                publish(release, InstallStep.Installing, checkActive)
                session.commit(statusSender(id))
            }
        } finally {
            conn.disconnect()
        }
    }

    private fun statusSender(id: Int) = PendingIntent.getBroadcast(
        context, id, Intent(context, InstallReceiver::class.java),
        // The system adds the result to this intent, so it has to be mutable.
        PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0),
    ).intentSender

    /** How Android says the install went, delivered through [InstallReceiver]. */
    @Synchronized
    fun onStatus(intent: Intent) {
        // Late word from a session that was given up on is ignored.
        if (intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, NO_SESSION) != sessionId) return
        val release = _state.value?.release ?: return
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        Log.d("GlidrScreen", "update status $status $message")
        _state.value = when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val prompt = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent::class.java)
                    ?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                confirmation = prompt
                Install(release, prompt?.let { InstallStep.Confirm(it) } ?: InstallStep.Failed(InstallError.Refused))
            }
            // Success replaces this process.
            PackageInstaller.STATUS_SUCCESS -> null
            else -> installError(status, message)?.let { Install(release, InstallStep.Failed(it)) }
        }
    }
}

/** The one [Updater] of this process, built on first use (the library has no Application class of its own). */
object ScreenUpdater {
    @Volatile private var instance: Updater? = null

    fun get(context: Context): Updater = instance ?: synchronized(this) {
        instance ?: Updater(context.applicationContext, CoroutineScope(SupervisorJob() + Dispatchers.Default)).also { instance = it }
    }
}

/** Receives Android's word on the install session. Not exported: only the system's PendingIntent reaches it. */
class InstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        ScreenUpdater.get(context).onStatus(intent)
    }
}
