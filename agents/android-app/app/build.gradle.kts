import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
        id("io.gitlab.arturbosch.detekt")
}

android {
    namespace = "com.monika.dashboard"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.monika.dashboard"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
    }

    flavorDimensions += "capability"
    productFlavors {
        create("normal") {
            dimension = "capability"
            buildConfigField("boolean", "PRIVILEGED_FEATURES", "false")
        }
        create("privileged") {
            dimension = "capability"
            versionNameSuffix = "-privileged"
            buildConfigField("boolean", "PRIVILEGED_FEATURES", "true")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    // LSPosed module runs in system_server (always latest API) and uses new APIs
    // with runtime version guards. Disable lint checks that would block compilation.
    lint {
        disable += "BlockedPrivateApi"
        disable += "NewApi"
    }

        testOptions {
            unitTests.isIncludeAndroidResources = true
            unitTests.isReturnDefaultValues = true
        }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

    detekt {
        buildUponDefaultConfig = true
        allRules = false
        config.setFrom("$rootDir/detekt.yml")
        baseline = file("$rootDir/detekt-baseline.xml")
    }

dependencies {
    // Compose BOM
    val composeBom = platform("androidx.compose:compose-bom:2024.09.03")
    implementation(composeBom)
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.navigation:navigation-compose:2.8.4")
    debugImplementation("androidx.compose.ui:ui-tooling")

    // Lifecycle
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")

    // DataStore
    implementation("androidx.datastore:datastore-preferences:1.1.1")

    // Encrypted SharedPreferences
    implementation("androidx.security:security-crypto:1.0.0")

    // OkHttp
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // AI config encryption (X25519) and markdown rendering for summaries
    implementation("org.bouncycastle:bcprov-jdk18on:1.82")
    implementation("io.noties.markwon:core:4.6.2")
    implementation("io.noties.markwon:ext-tables:4.6.2")

    // Optional LSPosed module entry. Only the privileged flavor compiles the
    // module classes; normal APKs do not contain LSPosed metadata or hooks.
    add("privilegedCompileOnly", "io.github.libxposed:api:101.0.1")

    // Health Connect background-read APIs are available here while staying
    // compatible with the current compileSdk / Android Gradle Plugin versions.
    implementation("androidx.health.connect:connect-client:1.1.0")

    // WorkManager
    implementation("androidx.work:work-runtime-ktx:2.10.0")

    // Core
    implementation("androidx.core:core-ktx:1.15.0")

        // ── Testing ──
        testImplementation("junit:junit:4.13.2")
        testImplementation("org.robolectric:robolectric:4.14.1")
        testImplementation("androidx.test:core:1.6.1")
        testImplementation("androidx.test.ext:junit:1.2.1")
        testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
}
