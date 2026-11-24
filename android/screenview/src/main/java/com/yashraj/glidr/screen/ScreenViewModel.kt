package com.yashraj.glidr.screen

import android.app.Application
import android.os.SystemClock
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.yashraj.glidr.screen.lock.AppLockSession
import com.yashraj.glidr.screen.lock.AppLockStore
import com.yashraj.glidr.screen.net.ConnState
import com.yashraj.glidr.screen.net.ScreenClient
import com.yashraj.glidr.screen.signal.PairedPc
import com.yashraj.glidr.screen.signal.PairingParser
import com.yashraj.glidr.screen.signal.PairingStore
import com.yashraj.glidr.screen.signal.PcPresence
import com.yashraj.glidr.screen.signal.PresenceChecker
import com.yashraj.glidr.screen.signal.UNNAMED_PC
import com.yashraj.glidr.screen.signal.WakeOnLan
import com.yashraj.glidr.screen.update.GitHubReleases
import com.yashraj.glidr.screen.update.UpdateSource
import com.yashraj.glidr.screen.update.UpdateState
import com.yashraj.glidr.screen.update.installedFromPlay
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class ScreenViewModel(app: Application) : AndroidViewModel(app) {
    private val store = PairingStore(app)
    private val prefsStore = ViewerPrefsStore(app)

    /**
     * The app lock (PIN). Whether the app is unlocked is kept here in memory only, so a new process starts locked.
     * While it is locked nothing pairs or connects (see [pair] and [connect]).
     */
    val lock = AppLockSession(AppLockStore(app), System::currentTimeMillis, SystemClock::elapsedRealtime)

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
        if (lock.locked.value) return null // nothing pairs behind the lock screen
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

    private val _wakeNote = MutableStateFlow<String?>(null)
    /** Result line of the last Wake tap ("Wake signal sent..." or the error); null before any. */
    val wakeNote: StateFlow<String?> = _wakeNote.asStateFlow()

    /** Sends a Wake-on-LAN packet to [pc] (does nothing for a PC that shared no MAC address). */
    fun wake(pc: PairedPc) {
        val mac = pc.mac ?: return
        _wakeNote.value = "Sending wake signal..."
        viewModelScope.launch { _wakeNote.value = WakeOnLan.resultMessage(WakeOnLan.send(mac, pc.broadcast)) }
    }

    private val _presence = MutableStateFlow<Map<String, PcPresence?>>(emptyMap())
    /**
     * What each PC last said about itself, by PC id. A PC without an entry has not been checked yet (or its check is still
     * running); an entry with null was checked and nothing was found.
     */
    val presence: StateFlow<Map<String, PcPresence?>> = _presence.asStateFlow()
    private var presenceJob: Job? = null

    /** Looks every paired PC up once (at most [PRESENCE_PARALLEL] at a time, [PRESENCE_TIMEOUT_MS] each). No background polling. */
    fun refreshPresence() {
        presenceJob?.cancel()
        val list = _pcs.value
        presenceJob = viewModelScope.launch {
            val gate = Semaphore(PRESENCE_PARALLEL)
            for (pc in list) launch {
                val found = gate.withPermit {
                    withContext(Dispatchers.IO) { withTimeoutOrNull(PRESENCE_TIMEOUT_MS) { PresenceChecker.check(pc) } }
                }
                // a failed refresh (offline phone) must not wipe an earlier answer; its age keeps counting up
                _presence.update { old -> if (found == null && old[pc.id] != null) old else old + (pc.id to found) }
            }
        }
    }

    private var nameJob: Job? = null
    private var liveJob: Job? = null
    /** The PC whose input settings (speed, zones, handedness) are active; they are kept per PC. */
    private var activePcId: String? = null

    fun connect(pc: PairedPc) {
        if (lock.locked.value) return // nothing connects behind the lock screen
        nameJob?.cancel()
        liveJob?.cancel()
        _client.value?.close()
        store.touch(pc)
        _pcs.value = store.load()
        activePcId = pc.id
        _prefs.value = _prefs.value.withInputFrom(prefsStore.loadFor(pc.id))
        val c = ScreenClient(getApplication(), pc, viewModelScope)
        _client.value = c
        c.start()
        // "Last connected" means a session really went live, not that a connection was tried
        liveJob = viewModelScope.launch {
            c.state.first { it is ConnState.Live }
            store.markLive(pc)
            _pcs.value = store.load()
        }
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
        liveJob?.cancel()
        _client.value?.close()
        _client.value = null
    }

    fun forget(pc: PairedPc) {
        if (_client.value != null) disconnect()
        store.remove(pc)
        prefsStore.removeFor(pc.id)
        _pcs.value = store.load()
    }

    fun rename(pc: PairedPc, name: String) {
        store.rename(pc, name.trim().ifBlank { pc.name })
        _pcs.value = store.load()
    }

    fun updatePrefs(f: (ViewerPrefs) -> ViewerPrefs) {
        _prefs.value = f(_prefs.value).also { prefsStore.save(it); activePcId?.let { id -> prefsStore.saveFor(id, it) } }
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

/** Presence lookups: how many run at once, and how long one may take. */
private const val PRESENCE_PARALLEL = 4
private const val PRESENCE_TIMEOUT_MS = 8_000L
