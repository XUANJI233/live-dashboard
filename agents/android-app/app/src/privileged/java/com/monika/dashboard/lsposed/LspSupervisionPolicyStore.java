package com.monika.dashboard.lsposed;

import android.content.Context;

import org.json.JSONObject;

final class LspSupervisionPolicyStore {
    static final String FILE_NAME = "supervision_policy.json";

    private static final int SCHEMA_VERSION = 1;
    private static final int MAX_STORED_JSON_CHARS = 16 * 1024;

    boolean save(Context context, JSONObject policy) {
        if (context == null || policy == null) return false;
        try {
            JSONObject envelope = new JSONObject();
            LspDeviceCommandProtocol.put(envelope, "v", SCHEMA_VERSION);
            LspDeviceCommandProtocol.put(envelope, "policy", policy);
            String encoded = envelope.toString();
            if (encoded.length() == 0 || encoded.length() > MAX_STORED_JSON_CHARS) return false;
            LspSystemStateFile.write(context, FILE_NAME, encoded);
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    JSONObject load(Context context) {
        if (context == null) return null;
        try {
            String encoded = LspSystemStateFile.read(context, FILE_NAME);
            if (encoded.length() == 0 || encoded.length() > MAX_STORED_JSON_CHARS) {
                return null;
            }
            JSONObject envelope = new JSONObject(encoded);
            if (envelope.optInt("v", -1) != SCHEMA_VERSION) return null;
            return envelope.optJSONObject("policy");
        } catch (Throwable ignored) {
            return null;
        }
    }
}
