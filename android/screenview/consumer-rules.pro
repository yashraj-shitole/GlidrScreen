-keep class org.webrtc.** { *; }
-dontwarn org.webrtc.**

# Google's code scanner (ML Kit) finds its components by class name: the manifest lists registrars as strings and the
# library calls into its own internal classes through those. R8 renamed or stripped them, the scanner got no
# components and "Scan QR" crashed in the release build with a NullPointerException (the debug build was fine).
-keep class com.google.mlkit.** { *; }
-keep class com.google.android.gms.internal.mlkit_code_scanner.** { *; }
-keep class * implements com.google.firebase.components.ComponentRegistrar { *; }
-keep class com.google.firebase.components.** { *; }
-dontwarn com.google.mlkit.**
