package com.monika.dashboard.system

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SystemPackageGuardTest {
    @Test
    fun protectsCoreAndroidPackages() {
        assertTrue(SystemPackageGuard.isProtectedForSupervision(null, "android"))
        assertTrue(SystemPackageGuard.isProtectedForSupervision(null, "com.android.systemui"))
        assertTrue(SystemPackageGuard.isProtectedForSupervision(null, "com.android.chrome"))
    }

    @Test
    fun doesNotProtectOrdinaryPackagesByName() {
        assertFalse(SystemPackageGuard.isProtectedForSupervision(null, "com.example.video"))
        assertFalse(SystemPackageGuard.isProtectedForSupervision(null, null))
    }
}
