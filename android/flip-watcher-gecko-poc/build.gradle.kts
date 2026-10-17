plugins {
    // AGP 9 compiles Kotlin itself (built-in Kotlin); no separate kotlin-android plugin.
    // 9.1.1 is the first AGP that supports compileSdk 37, which GeckoView 158 requires.
    id("com.android.application") version "9.1.1" apply false
}
