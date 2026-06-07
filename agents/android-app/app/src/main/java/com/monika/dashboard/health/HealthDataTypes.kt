package com.monika.dashboard.health

import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.*

/**
 * 18 health data types supported by the app.
 * Each type maps to a Health Connect record class and permission.
 */
enum class HealthDataType(
    val key: String,
    val displayName: String,
    val unit: String,
    val icon: String,
    val permission: String,
    val recordClass: Class<out Record>
) {
    HEART_RATE(
        "heart_rate", "心率", "bpm", "HR",
        HealthPermission.getReadPermission(HeartRateRecord::class),
        HeartRateRecord::class.java
    ),
    RESTING_HEART_RATE(
        "resting_heart_rate", "静息心率", "bpm", "RHR",
        HealthPermission.getReadPermission(RestingHeartRateRecord::class),
        RestingHeartRateRecord::class.java
    ),
    HEART_RATE_VARIABILITY(
        "heart_rate_variability", "心率变异性", "ms", "HRV",
        HealthPermission.getReadPermission(HeartRateVariabilityRmssdRecord::class),
        HeartRateVariabilityRmssdRecord::class.java
    ),
    STEPS(
        "steps", "步数", "count", "STP",
        HealthPermission.getReadPermission(StepsRecord::class),
        StepsRecord::class.java
    ),
    DISTANCE(
        "distance", "距离", "m", "DST",
        HealthPermission.getReadPermission(DistanceRecord::class),
        DistanceRecord::class.java
    ),
    EXERCISE(
        "exercise", "运动", "min", "EX",
        HealthPermission.getReadPermission(ExerciseSessionRecord::class),
        ExerciseSessionRecord::class.java
    ),
    SLEEP(
        "sleep", "睡眠", "min", "SLP",
        HealthPermission.getReadPermission(SleepSessionRecord::class),
        SleepSessionRecord::class.java
    ),
    OXYGEN_SATURATION(
        "oxygen_saturation", "血氧", "%", "SPO",
        HealthPermission.getReadPermission(OxygenSaturationRecord::class),
        OxygenSaturationRecord::class.java
    ),
    BODY_TEMPERATURE(
        "body_temperature", "体温", "°C", "TMP",
        HealthPermission.getReadPermission(BodyTemperatureRecord::class),
        BodyTemperatureRecord::class.java
    ),
    RESPIRATORY_RATE(
        "respiratory_rate", "呼吸频率", "breaths/min", "RR",
        HealthPermission.getReadPermission(RespiratoryRateRecord::class),
        RespiratoryRateRecord::class.java
    ),
    BLOOD_PRESSURE(
        "blood_pressure", "血压", "mmHg", "BP",
        HealthPermission.getReadPermission(BloodPressureRecord::class),
        BloodPressureRecord::class.java
    ),
    BLOOD_GLUCOSE(
        "blood_glucose", "血糖", "mmol/L", "GLU",
        HealthPermission.getReadPermission(BloodGlucoseRecord::class),
        BloodGlucoseRecord::class.java
    ),
    WEIGHT(
        "weight", "体重", "kg", "WT",
        HealthPermission.getReadPermission(WeightRecord::class),
        WeightRecord::class.java
    ),
    HEIGHT(
        "height", "身高", "m", "HT",
        HealthPermission.getReadPermission(HeightRecord::class),
        HeightRecord::class.java
    ),
    ACTIVE_CALORIES(
        "active_calories", "活动卡路里", "kcal", "CAL",
        HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class),
        ActiveCaloriesBurnedRecord::class.java
    ),
    TOTAL_CALORIES(
        "total_calories", "总卡路里", "kcal", "TCA",
        HealthPermission.getReadPermission(TotalCaloriesBurnedRecord::class),
        TotalCaloriesBurnedRecord::class.java
    ),
    HYDRATION(
        "hydration", "饮水", "mL", "H2O",
        HealthPermission.getReadPermission(HydrationRecord::class),
        HydrationRecord::class.java
    ),
    NUTRITION(
        "nutrition", "营养", "g", "NUT",
        HealthPermission.getReadPermission(NutritionRecord::class),
        NutritionRecord::class.java
    );

    companion object {
        fun fromKey(key: String): HealthDataType? = entries.find { it.key == key }

        fun permissionsForTypes(types: Set<String>): Set<String> =
            types.mapNotNull { key -> fromKey(key)?.permission }.toSet()
    }
}
