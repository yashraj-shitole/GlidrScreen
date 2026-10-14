package com.yashraj.glidr.screen

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.yashraj.glidr.screen.net.ScreenClient
import com.yashraj.glidr.screen.signal.PairedPc
import com.yashraj.glidr.screen.signal.PairingParser
import com.yashraj.glidr.screen.signal.PairingStore
import com.yashraj.glidr.screen.signal.UNNAMED_PC
import com.yashraj.glidr.screen.update.GitHubReleases
import com.yashraj.glidr.screen.update.UpdateSource
import com.yashraj.glidr.screen.update.UpdateState
import com.yashraj.glidr.screen.update.installedFromPlay
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class ScreenViewModel(app: Application) : AndroidViewModel(app) {
    private val store = PairingStore(app)
    private val prefsStore = ViewerPrefsStore(app)

    private val _pcs = MutableStateFlow(store.load())
    val pcs: StateFlow<List<PairedPc>> = _pcs.asStateFlow()
    private val _prefs = MutableStateFlow(prefsStore.load())
    val prefs: StateFlow<ViewerPrefs> = _prefs.asStateFlow()
    private val _client = MutableStateFlow<ScreenClient?>(null)
    /** The active session, or null while browsing the list of PCs. */
    val client: StateFlow<ScreenClient?> = _client.asStateFlow()
    private val _pairError = MutableStateFlow<String?>(null)
    val pairError: StateFlow<String?> = _pairError.asStateFlow()

    /** Pairs from a scanned QR, a pasted link or a typed code. Returns the new PC, or null (see [pairError]). */
    fun pair(text: String): PairedPc? {
        val info = PairingParser.parse(text)
        if (info == null) {
            _pairError.value = "That does not look like a Glidr Screen pairing code."
            return null
        }
        _pairError.value = null
        val pc = store.add(info)
        _pcs.value = store.load()
        return pc
    }

    fun clearPairError() { _pairError.value = null }

    private var nameJob: Job? = null

    fun connect(pc: PairedPc) {
        nameJob?.cancel()
        _client.value?.close()
        store.touch(pc)
        _pcs.value = store.load()
        val c = ScreenClient(getApplication(), pc, viewModelScope)
        _client.value = c
        c.start()
        if (pc.name == UNNAMED_PC) {
            // paired with a typed code: keep the name the PC reports, so the list does not say "PC" forever
            nameJob = viewModelScope.launch {
                val real = c.hostName.first { it != UNNAMED_PC && it.isNotBlank() }
                store.rename(pc, real)
                _pcs.value = store.load()
            }
        }
    }

    fun disconnect() {
        nameJob?.cancel()
        _client.value?.close()
        _client.value = null
    }

    fun forget(pc: PairedPc) {
        if (_client.value != null) disconnect()
        store.remove(pc)
        _pcs.value = store.load()
    }

    fun rename(pc: PairedPc, name: String) {
        store.rename(pc, name.trim().ifBlank { pc.name })
        _pcs.value = store.load()
    }

    fun updatePrefs(f: (ViewerPrefs) -> ViewerPrefs) {
        _prefs.value = f(_prefs.value).also { prefsStore.save(it) }
    }

    // ------------------------------------------------------------------ updates (only when the host app opts in)

    private var updateSource: UpdateSource? = null
    private val _update = MutableStateFlow<UpdateState>(UpdateState.Idle)
    val update: StateFlow<UpdateState> = _update.asStateFlow()
    val updatesEnabled: Boolean get() = updateSource != null
    val currentVersion: String? get() = updateSource?.currentVersion

    /** Turns update checks on and checks once per app start. Embedded hosts leave this off and ship their own. */
    fun configureUpdates(source: UpdateSource) {
        if (updateSource == source) return
        updateSource = source
        checkForUpdates()
    }

    fun checkForUpdates() {
        val src = updateSource ?: return
        if (_update.value == UpdateState.Checking) return
        if (installedFromPlay(getApplication())) { _update.value = UpdateState.ViaStore; return }
        _update.value = UpdateState.Checking
        viewModelScope.launch { _update.value = GitHubReleases.check(src, "GlidrScreen-Android/${src.currentVersion}") }
    }

    override fun onCleared() {
        _client.value?.close()
    }
}
