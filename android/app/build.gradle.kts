plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.yashraj.glidr.screenapp"
    compileSdk {
        version = release(37)
    }

    defaultConfig {
        applicationId = "com.yashraj.glidr.screen"
        minSdk = 29
        targetSdk = 37
        versionCode = 2
        versionName = "1.0.1"
    }

    buildFeatures {
        compose = true
    }

    buildTypes {
        release {
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
