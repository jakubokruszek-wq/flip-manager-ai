plugins {
    // AGP 9 compiles Kotlin itself (built-in Kotlin); no separate kotlin-android plugin is applied.
    // 9.1.1 is the first AGP that supports compileSdk 37, which GeckoView 158 requires.
    id("com.android.application") version "9.1.1" apply false
    // Only selects the Kotlin compiler version built-in Kotlin uses: GeckoView's
    // dependencies bring a newer kotlin-stdlib than AGP's default compiler can read.
    id("org.jetbrains.kotlin.android") version "2.4.20" apply false
}
