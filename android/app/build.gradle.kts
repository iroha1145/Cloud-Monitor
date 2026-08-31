plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

val versionFile = rootProject.file("../VERSION")
val fallbackName = if (versionFile.exists()) versionFile.readText().trim() else "0.1.4"
fun propText(name: String): String? = findProperty(name)?.toString()?.ifBlank { null }
val appVersionName = propText("versionName") ?: fallbackName
val appVersionCode = propText("versionCode")?.toIntOrNull() ?: 1

android {
    namespace = "io.github.iroha1145.cloudmonitor"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.iroha1145.cloudmonitor"
        minSdk = 28
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersionName
        ndk {
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
        vectorDrawables.useSupportLibrary = true
    }

    signingConfigs {
        val storePath = System.getenv("ANDROID_KEYSTORE_PATH")
        if (!storePath.isNullOrBlank()) {
            create("release") {
                storeFile = file(storePath)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD") ?: ""
                keyAlias = System.getenv("ANDROID_KEY_ALIAS") ?: "cloudmonitor"
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
                    ?: System.getenv("ANDROID_KEYSTORE_PASSWORD")
                    ?: ""
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            val rel = signingConfigs.findByName("release")
            if (rel != null && rel.storeFile != null) {
                signingConfig = rel
            }
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
            excludes += "**/kotlin/DebugProbesKt.bin"
            excludes += "DebugProbesKt.bin"
            excludes += "kotlin-tooling-metadata.json"
        }
        jniLibs {
            excludes += listOf("**/armeabi-v7a/**", "**/x86/**", "**/armeabi/**")
        }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.splashscreen)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.security.crypto)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.coil.compose)
    implementation(libs.coil.svg)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.haze)
    debugImplementation(libs.androidx.compose.ui.tooling)
}
