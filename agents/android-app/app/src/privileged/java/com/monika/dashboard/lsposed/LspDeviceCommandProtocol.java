package com.monika.dashboard.lsposed;

import org.json.JSONArray;
import org.json.JSONObject;

import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

final class LspDeviceCommandProtocol {
    static final String TYPE_COMMAND = "device_command";
    static final String TYPE_RECEIPT = "device_command_receipt";
    static final String TYPE_RESULT = "device_command_result";
    static final String TYPE_RECEIPT_ACK = "device_command_receipt_received";
    static final String TYPE_RESULT_ACK = "device_command_result_received";
    static final String KIND_SUPERVISION = "supervision";
    static final long VIBRATE_MS = 650L;

    private LspDeviceCommandProtocol() {}

    static String cleanId(String value) {
        String clean = safeString(value).replaceAll("[\\u0000-\\u001f\\u007f]", "").trim();
        if (clean.length() > 160) clean = clean.substring(0, 160);
        return clean.matches("[a-zA-Z0-9_.:-]{1,160}") ? clean : "";
    }

    static String stableResultId(String commandId) {
        String clean = cleanId(commandId);
        if (clean.length() == 0) return "res_invalid";
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(clean.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder("res_");
            for (int i = 0; i < 12 && i < hash.length; i++) {
                out.append(String.format(Locale.US, "%02x", hash[i] & 0xff));
            }
            return out.toString();
        } catch (Throwable ignored) {
            return "res_" + clean.replaceAll("[^a-zA-Z0-9_.:-]", "_");
        }
    }

    static boolean strictBoolean(JSONObject object, String key, boolean defaultWhenMissing) {
        if (object == null || !object.has(key) || object.isNull(key)) return defaultWhenMissing;
        Object value = object.opt(key);
        return value instanceof Boolean ? (Boolean) value : false;
    }

    static List<Pattern> compileSafePatterns(JSONArray arr) {
        ArrayList<Pattern> out = new ArrayList<>();
        if (arr == null) return out;
        for (int i = 0; i < arr.length(); i++) {
            String pattern = safeString(arr.optString(i));
            if (isAllCommand(pattern)) continue;
            if (!isSafePattern(pattern)) continue;
            try {
                out.add(Pattern.compile(pattern, Pattern.CASE_INSENSITIVE));
            } catch (Throwable ignored) {}
            if (out.size() >= 12) break;
        }
        return out;
    }

    static boolean containsAllCommand(JSONArray arr) {
        if (arr == null) return false;
        for (int i = 0; i < arr.length(); i++) {
            if (isAllCommand(arr.optString(i))) return true;
        }
        return false;
    }

    static boolean matchesAny(List<Pattern> patterns, String text) {
        if (patterns == null || patterns.isEmpty()) return false;
        String value = safeString(text);
        if (value.length() == 0) return false;
        for (Pattern pattern : patterns) {
            try {
                if (pattern.matcher(value).find()) return true;
            } catch (Throwable ignored) {}
        }
        return false;
    }

    static void put(JSONObject target, String key, Object value) {
        try {
            target.put(key, value);
        } catch (Throwable ignored) {}
    }

    static String safeString(String value) {
        if (value == null) return "";
        String trimmed = value.trim();
        if (trimmed.length() > 500) return trimmed.substring(0, 500);
        return trimmed;
    }

    static String reason(JSONObject payload, String fallback) {
        String reason = safeString(payload != null ? payload.optString("reason", "") : "");
        if (reason.length() == 0 && payload != null) reason = safeString(payload.optString("say", ""));
        if (reason.length() == 0) reason = safeString(fallback);
        return reason;
    }

    private static boolean isAllCommand(String value) {
        String clean = safeString(value).replaceAll("\\s+", "").toLowerCase(Locale.ROOT);
        return "全部".equals(clean)
                || "全量".equals(clean)
                || "所有".equals(clean)
                || "all".equals(clean)
                || "*".equals(clean)
                || ".*".equals(clean);
    }

    private static boolean isSafePattern(String pattern) {
        String value = safeString(pattern);
        if (value.length() == 0 || value.length() > 160) return false;
        int meta = 0;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if ("[](){}+*?|\\^$".indexOf(c) >= 0) meta++;
        }
        return meta <= 12;
    }
}
