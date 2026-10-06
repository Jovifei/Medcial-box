import java.net.URI
import java.util.Base64

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// Only an explicitly enabled loopback trial may keep the installed certificate.
val localTrialSigning = providers.gradleProperty("medboxLocalTrialSigning").orNull == "true"
val trialDefines = (findProperty("dart-defines") as? String).orEmpty().split(",")
    .mapNotNull { runCatching { String(Base64.getDecoder().decode(it)) }.getOrNull() }
if (localTrialSigning) {
    val endpoint = trialDefines.firstOrNull { it.startsWith("API_BASE_URL=") }?.substringAfter("=")
    val origin = runCatching { URI(endpoint.orEmpty()) }.getOrNull()
    check(trialDefines.contains("LOCAL_APP_TRIAL=true") && origin?.scheme == "http" &&
        origin.host in setOf("127.0.0.1", "localhost")) {
        "Trial signing requires LOCAL_APP_TRIAL=true and an HTTP loopback API."
    }
}

android {
    namespace = "com.joviluma.home_medicine_flutter"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.joviluma.home_medicine_flutter"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    buildTypes {
        release {
            // Deliberately do not fall back to the debug keystore.
            // CI may compile an unsigned optimized APK; distribution signing must be
            // supplied by the release environment after the final applicationId is fixed.
            if (localTrialSigning) {
                signingConfig = signingConfigs.getByName("debug")
            }
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")
    implementation("com.google.mlkit:text-recognition-chinese:16.0.1")
}
