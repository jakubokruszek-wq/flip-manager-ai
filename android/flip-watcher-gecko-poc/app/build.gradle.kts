import java.security.MessageDigest

plugins {
    id("com.android.application")
}

// GeckoView follows Firefox: a new stable major every 4 weeks. Pinned to the
// stable release resolved on 2026-10-17; override with -PGECKOVIEW_VERSION.
val geckoviewVersion = providers.gradleProperty("GECKOVIEW_VERSION").orElse("158.0.20261007201254").get()

/**
 * Builds the built-in WebExtension into generated assets: the POC's own
 * manifest/adapter/content script plus the UNCHANGED collector-core.js of the
 * Chrome extension. The build fails if collector-core.js no longer matches the
 * reviewed hash, so a parser change is never shipped to the phone unnoticed.
 */
abstract class BundleCollectorExtension : DefaultTask() {
    @get:InputDirectory abstract val extensionSources: DirectoryProperty
    @get:InputFile abstract val collectorCore: RegularFileProperty
    @get:Input abstract val expectedCoreSha256: Property<String>
    @get:Input abstract val extensionPath: Property<String>
    @get:OutputDirectory abstract val outputDir: DirectoryProperty

    @TaskAction
    fun bundle() {
        val core = collectorCore.get().asFile
        val actual = MessageDigest.getInstance("SHA-256").digest(core.readBytes()).joinToString("") { "%02x".format(it) }
        check(actual == expectedCoreSha256.get()) {
            "collector-core.js changed (sha256 $actual); review it and update COLLECTOR_CORE_SHA256"
        }
        val target = outputDir.get().asFile.resolve(extensionPath.get())
        target.deleteRecursively()
        target.mkdirs()
        extensionSources.get().asFile.listFiles()!!.filter { it.isFile }.forEach { it.copyTo(target.resolve(it.name)) }
        core.copyTo(target.resolve("collector-core.js"))
    }
}

val collectorCoreSha256 = "32c98525cfac6b580b93b4847140d4872ee4119b26981786322235df42e5b88b"

android {
    namespace = "pl.jakubokruszek.flipwatcher.geckopoc"
    compileSdk = 37

    defaultConfig {
        // Separate package: installs beside Flip Collector / Watcher, shares nothing with them.
        applicationId = "pl.jakubokruszek.flipwatcher.geckopoc"
        minSdk = 26
        targetSdk = 36
        versionCode = providers.gradleProperty("GECKO_POC_VERSION_CODE").orElse("2700").get().toInt()
        versionName = "0.5.17-gecko-poc"
        buildConfigField("String", "COLLECTOR_CORE_SHA256", "\"$collectorCoreSha256\"")
        // No backend in this POC: there is no API URL, token or upload code at all.
        buildConfigField("boolean", "LIVE_UPLOAD_ENABLED", "false")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        // A fixed, PUBLIC debug key committed with the POC (not a secret, never used for
        // a store release): every CI build is signed alike, so a new APK installs as an
        // UPDATE over the previous one and keeps the Facebook session. Without it each
        // CI runner generated its own debug key and updates were refused.
        getByName("debug") {
            storeFile = file("gecko-poc-debug.keystore")
            storePassword = "android"
            keyAlias = "geckopocdebug"
            keyPassword = "android"
        }
    }

    splits {
        abi {
            // arm64 for the Samsung, x86_64 for the CI emulator; one universal APK would be ~3x larger.
            isEnable = true
            reset()
            include("arm64-v8a", "x86_64")
            isUniversalApk = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }

    testOptions {
        unitTests.isReturnDefaultValues = false
    }
}

androidComponents {
    onVariants { variant ->
        val bundle = tasks.register<BundleCollectorExtension>("bundle${variant.name.replaceFirstChar { it.uppercase() }}CollectorExtension") {
            extensionPath.set("ext/flip_poc")
            extensionSources.set(layout.projectDirectory.dir("src/main/extension"))
            collectorCore.set(rootProject.layout.projectDirectory.file("../../extensions/facebook-collector/collector-core.js"))
            expectedCoreSha256.set(collectorCoreSha256)
            outputDir.set(layout.buildDirectory.dir("generated/collectorExtension/${variant.name}"))
        }
        variant.sources.assets?.addGeneratedSourceDirectory(bundle, BundleCollectorExtension::outputDir)
        if (variant.name == "debug") {
            val lab = tasks.register<BundleCollectorExtension>("bundleMainLabExtension") {
                extensionPath.set("ext/main_lab")
                extensionSources.set(layout.projectDirectory.dir("src/debug/main-lab"))
                collectorCore.set(rootProject.layout.projectDirectory.file("../../extensions/facebook-collector/collector-core.js"))
                expectedCoreSha256.set(collectorCoreSha256)
                outputDir.set(layout.buildDirectory.dir("generated/mainLabExtension"))
            }
            variant.sources.assets?.addGeneratedSourceDirectory(lab, BundleCollectorExtension::outputDir)
        }
    }
}

dependencies {
    implementation("org.mozilla.geckoview:geckoview:$geckoviewVersion")
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")

    testImplementation("junit:junit:4.13.2")
    // Android's org.json is a stub on the JVM; tests use the real library.
    testImplementation("org.json:json:20240303")

    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:core-ktx:1.6.1")
    androidTestImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
}

// Synthetic contract fixture only: this task is JVM tests, never the foreground application.
tasks.withType<Test>().configureEach {
    systemProperty("pilot.fixture.output", layout.buildDirectory.file("pilot-fixture.json").get().asFile.absolutePath)
}
