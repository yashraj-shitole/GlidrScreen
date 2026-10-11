package com.yashraj.glidr.screen

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.yashraj.glidr.screen.net.ScreenClient
import com.yashraj.glidr.screen.signal.PairedPc
import com.yashraj.glidr.screen.signal.PairingParser
import com.yashraj.glidr.screen.signal.PairingStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

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

    fun connect(pc: PairedPc) {
        _client.value?.close()
        store.touch(pc)
        _pcs.value = store.load()
        val c = ScreenClient(getApplication(), pc, viewModelScope)
        _client.value = c
        c.start()
    }

    fun disconnect() {
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

    override fun onCleared() {
        _client.value?.close()
    }
}
