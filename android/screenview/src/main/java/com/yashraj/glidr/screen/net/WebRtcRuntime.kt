package com.yashraj.glidr.screen.net

import android.content.Context
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import android.media.AudioAttributes
import org.webrtc.PeerConnectionFactory
import org.webrtc.audio.JavaAudioDeviceModule

/** Process-wide WebRTC factory and EGL context. Initialised lazily, once. */
object WebRtcRuntime {
    @Volatile private var egl: EglBase? = null
    @Volatile private var factory: PeerConnectionFactory? = null

    fun eglBase(context: Context): EglBase = ensure(context).first
    fun factory(context: Context): PeerConnectionFactory = ensure(context).second

    @Volatile private var decoders: List<String>? = null

    /** Protocol names of the video codecs this phone can really decode (hardware or software); cached. */
    fun decoderNames(context: Context): List<String> {
        decoders?.let { return it }
        val egl = eglBase(context)
        val names = runCatching {
            VideoDecoders.names(DefaultVideoDecoderFactory(egl.eglBaseContext).supportedCodecs.map { it.name })
        }.getOrDefault(emptyList())
        decoders = names
        return names
    }

    @Synchronized
    private fun ensure(context: Context): Pair<EglBase, PeerConnectionFactory> {
        val e = egl
        val f = factory
        if (e != null && f != null) return e to f
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context.applicationContext).createInitializationOptions(),
        )
        val newEgl = EglBase.create()
        // The PC's audio is media (music, video, system sound), not a phone call. The default audio device module plays
        // through the voice-call stream, which Android routes to the earpiece; media usage uses the loudspeaker (or
        // headphones) and the normal media volume keys.
        val audioDevice = JavaAudioDeviceModule.builder(context.applicationContext)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE)
                    .build(),
            )
            .createAudioDeviceModule()
        val newFactory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(audioDevice)
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(newEgl.eglBaseContext))
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(newEgl.eglBaseContext, true, true))
            .createPeerConnectionFactory()
        egl = newEgl
        factory = newFactory
        return newEgl to newFactory
    }
}
