import java.net.URI

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "pl.jakubokruszek.flipcollector"
    compileSdk = 35

    defaultConfig {
        applicationId = "pl.jakubokruszek.flipcollector"
        minSdk = 26
        targetSdk = 35
        versionCode = providers.gradleProperty("FLIP_COLLECTOR_VERSION_CODE").orElse("16").get().toInt()
        versionName = "0.7.1-offline"

        val testOrigin = providers.gradleProperty("FLIP_OFFLINE_TEST_ORIGIN").orElse("").get()
        require(testOrigin.isEmpty() || Regex("https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?").matches(testOrigin))
        if (testOrigin.isNotEmpty()) {
            val testHost = URI(testOrigin).host.lowercase()
            require(testHost != "flip-manager-ai.vercel.app" && !testHost.endsWith(".supabase.co"))
        }
        buildConfigField("String", "OFFLINE_TEST_API_ORIGIN", "\"$testOrigin\"")

        buildConfigField(
            "String",
            "DEFAULT_FLIP_MANAGER_URL",
            "\"${providers.gradleProperty("FLIP_MANAGER_BASE_URL").orElse("https://flip-manager-ai.vercel.app").get()}\"",
        )
        // Live collection (job queue + Facebook WebView) stays compiled out
        // until the user separately approves it; see LiveCollectionGate.
        buildConfigField("boolean", "LIVE_COLLECTION_ENABLED", "false")
        buildConfigField("boolean", "ANDROID_BACKEND_INTEGRATION_ENABLED", "false")
        val pilotEnabled = providers.gradleProperty("FLIP_LIVE_PILOT_ENABLED").orElse("false").get()
        require(pilotEnabled in setOf("true", "false"))
        require(pilotEnabled != "true" || providers.gradleProperty("FLIP_PILOT_APK").orElse("false").get() == "true") { "LIVE pilot requires its separate APK identity" }
        buildConfigField("boolean", "LIVE_PILOT_ENABLED", pilotEnabled)
        val pilotOrigin = providers.gradleProperty("FLIP_LIVE_PILOT_ORIGIN").orElse("").get()
        require(pilotOrigin.isEmpty() || Regex("https://[A-Za-z0-9.-]+").matches(pilotOrigin))
        require(pilotOrigin != "https://flip-manager-ai.vercel.app" && !pilotOrigin.endsWith(".supabase.co"))
        require(pilotEnabled != "true" || pilotOrigin.isNotEmpty())
        buildConfigField("String", "LIVE_PILOT_ORIGIN", "\"$pilotOrigin\"")
        resValue("string", "app_name", "Flip Collector")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        debug {
            // A remote OFFLINE_TEST build must also install beside any previous
            // .integration APK: GitHub-hosted runners have fresh debug signing keys.
            val remoteOfflineBuild = providers.gradleProperty("FLIP_OFFLINE_TEST_ORIGIN").orElse("").get().isNotEmpty()
            val pilotApk = providers.gradleProperty("FLIP_PILOT_APK").orElse("false").get() == "true"
            applicationIdSuffix = if (pilotApk) (if (providers.gradleProperty("FLIP_LIVE_PILOT_ENABLED").orElse("false").get() == "true") ".integration.pilot43approved" else ".integration.pilot43") else if (remoteOfflineBuild) ".remote2" else ".integration"
            versionNameSuffix = "-debug"
            resValue("string", "app_name", if (pilotApk) "Flip Watcher · pilot 43" else if (remoteOfflineBuild) "Flip Collector (remote test 0.7.1)" else "Flip Collector (offline integration)")
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
        buildConfig = true
        compose = true
    }

    testOptions {
        unitTests.isReturnDefaultValues = false
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.activity:activity-compose:1.10.0")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material:material-icons-core")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("com.squareup.okhttp3:okhttp-tls:4.12.0")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
    // Android's org.json is a stub on the JVM; tests use the real library.
    testImplementation("org.json:json:20240303")

    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation(platform("androidx.compose:compose-bom:2024.12.01"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("com.squareup.okhttp3:okhttp-tls:4.12.0")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:core-ktx:1.6.1")
    androidTestImplementation("androidx.work:work-testing:2.10.0")
}

// Reuse the exact extension core; do not maintain a fork or package Chrome MV3.
val offlineCoreAssets = tasks.register<Copy>("offlineCoreAssets") {
    from(rootProject.file("../../extensions/facebook-collector/collector-core.js"))
    into(layout.buildDirectory.dir("generated/offlineAssets"))
}
android.sourceSets.getByName("main").assets.srcDir(layout.buildDirectory.dir("generated/offlineAssets"))
tasks.named("preBuild").configure { dependsOn(offlineCoreAssets) }

