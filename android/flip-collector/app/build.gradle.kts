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
        versionCode = providers.gradleProperty("FLIP_COLLECTOR_VERSION_CODE").orElse("2").get().toInt()
        versionName = "0.2.0"

        buildConfigField(
            "String",
            "DEFAULT_FLIP_MANAGER_URL",
            "\"${providers.gradleProperty("FLIP_MANAGER_BASE_URL").orElse("https://flip-manager-ai.vercel.app").get()}\"",
        )
        // Live collection (job queue + Facebook WebView) stays compiled out
        // until the user separately approves it; see LiveCollectionGate.
        buildConfigField("boolean", "LIVE_COLLECTION_ENABLED", "false")
        resValue("string", "app_name", "Flip Collector")
    }

    buildTypes {
        debug {
            // Installs beside a production build instead of replacing it.
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            resValue("string", "app_name", "Flip Collector (test)")
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
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.activity:activity-compose:1.10.0")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
    // Android's org.json is a stub on the JVM; tests use the real library.
    testImplementation("org.json:json:20240303")
}
