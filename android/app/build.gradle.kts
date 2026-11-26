import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

// Release signing. Android only installs an update when it is signed with the SAME key as the installed app, so the
// release key must never change and must not be a machine's debug key (those get regenerated: 2.0.0 and 2.1.0 were
// signed with different debug keys and 2.1.0 could not update 2.0.0). The key lives outside the repo, in
// ~/.glidr/glidrscreen-signing.properties (storeFile, storePassword, keyAlias, keyPassword) or the file named by
// -Pglidr.signing.properties=<path>. Without that file `assembleRelease` still builds, but unsigned.
val signingProps = Properties().also { props ->
    val path = (project.findProperty("glidr.signing.properties") as String?)
        ?: "${System.getProperty("user.home")}/.glidr/glidrscreen-signing.properties"
    val f = file(path)
    if (f.isFile) f.inputStream().use { props.load(it) }
}
val hasReleaseKey = signingProps.getProperty("storeFile")?.let { file(it).isFile } == true

android {
    namespace = "com.yashraj.glidr.screenapp"
    compileSdk {
        version = release(37)
    }

    defaultConfig {
        applicationId = "com.yashraj.glidr.screen"
        minSdk = 29
        targetSdk = 37
        versionCode = 7
        versionName = "2.1.3"
    }

    buildFeatures {
        compose = true
    }

    signingConfigs {
        if (hasReleaseKey) {
            create("release") {
                storeFile = file(signingProps.getProperty("storeFile"))
                storePassword = signingProps.getProperty("storePassword")
                keyAlias = signingProps.getProperty("keyAlias")
                keyPassword = signingProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            if (hasReleaseKey) signingConfig = signingConfigs.getByName("release")
            // Whole-app R8. A packageScope limited to androidx/kotlin/kotlinx moved part of the Kotlin
            // StringsKt facade out of kotlin.text, away from its package-private superclass, and the
            // release build crashed on launch with IllegalAccessError.
            optimization {
                enable = true
            }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}

dependencies {
    implementation(project(":screenview"))
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.runtime)
}
