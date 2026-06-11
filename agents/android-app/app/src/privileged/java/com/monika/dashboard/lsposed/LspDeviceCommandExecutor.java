package com.monika.dashboard.lsposed;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.Instant;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.regex.Pattern;

final class LspDeviceCommandExecutor {
    private final LspDeviceCommandHost host;

    LspDeviceCommandExecutor(LspDeviceCommandHost host) {
        this.host = host;
    }

    JSONObject execute(JSONObject command, String resultId, String source) {
        String commandId = LspDeviceCommandProtocol.cleanId(command.optString("command_id", ""));
        String requestId = LspDeviceCommandProtocol.cleanId(command.optString("request_id", ""));
        JSONArray actions = new JSONArray();

        if (isExpired(command.optString("expires_at", ""))) {
            return result(commandId, requestId, resultId, "expired", actions, host.frozenState(System.currentTimeMillis()), "command_expired");
        }

        JSONObject payload = command.optJSONObject("payload");
        if (payload == null) {
            return result(commandId, requestId, resultId, "unsupported", actions, host.frozenState(System.currentTimeMillis()), "unsupported_command_kind");
        }
        String kind = payload.optString("kind", "");
        if (LspDeviceCommandProtocol.KIND_SUPERVISION_POLICY.equals(kind)) {
            return executePolicy(commandId, requestId, resultId, payload, actions);
        }
        if (!LspDeviceCommandProtocol.KIND_SUPERVISION.equals(kind)) {
            return result(commandId, requestId, resultId, "unsupported", actions, host.frozenState(System.currentTimeMillis()), "unsupported_command_kind");
        }

        Counts counts = new Counts();
        String reason = LspDeviceCommandProtocol.reason(payload, payload.optString("say", ""));
        if (LspDeviceCommandProtocol.strictBoolean(payload, "screen_off", false)) {
            actions.put(action("screen_off", "unsupported", "screen_off_not_supported"));
            counts.unsupported++;
        }

        String say = LspDeviceCommandProtocol.safeString(payload.optString("say", ""));
        if (say.length() > 0) {
            if (host.postSayNotification(commandId, say)) {
                actions.put(action("say", "applied", source));
                counts.applied++;
            } else {
                actions.put(action("say", "failed", "notification_unavailable"));
                counts.failed++;
            }
        }

        if (LspDeviceCommandProtocol.strictBoolean(payload, "vibrate", false)) {
            if (host.vibrate(LspDeviceCommandProtocol.VIBRATE_MS)) {
                actions.put(action("vibrate", "applied", source));
                counts.applied++;
            } else {
                actions.put(action("vibrate", "failed", "vibrator_unavailable"));
                counts.failed++;
            }
        }

        Counts unfreezeCounts = applyUnfreeze(payload.optJSONArray("unfreeze_commands"), reason, actions);
        counts.add(unfreezeCounts);
        if (unfreezeCounts.applied > 0 && commandsContainPendingReview(payload.optJSONArray("unfreeze_commands"))) {
            host.finishPendingSupervisionReview();
        }
        counts.add(applyFreeze(payload.optJSONArray("freeze_commands"), reason, actions));

        if (counts.isEmpty()) {
            actions.put(action("noop", "ignored", "empty_or_no_matching_command"));
            counts.ignored++;
        }
        if (counts.applied > 0) host.requestDirectUpload();
        return result(commandId, requestId, resultId, counts.status(), actions, host.frozenState(System.currentTimeMillis()), "");
    }

    private JSONObject executePolicy(String commandId, String requestId, String resultId, JSONObject payload, JSONArray actions) {
        if (host.applySupervisionPolicy(payload)) {
            actions.put(action("supervision_policy", "applied", "policy_updated"));
            host.requestDirectUpload();
            return result(commandId, requestId, resultId, "applied", actions, host.frozenState(System.currentTimeMillis()), "");
        }
        actions.put(action("supervision_policy", "failed", "policy_apply_failed"));
        return result(commandId, requestId, resultId, "failed", actions, host.frozenState(System.currentTimeMillis()), "policy_apply_failed");
    }

    private Counts applyUnfreeze(JSONArray commands, String reason, JSONArray actions) {
        Counts counts = new Counts();
        if (commands == null || commands.length() == 0) return counts;
        boolean unfreezeAll = LspDeviceCommandProtocol.containsAllCommand(commands);
        List<Pattern> patterns = LspDeviceCommandProtocol.compileSafePatterns(commands);
        if (!unfreezeAll && patterns.isEmpty()) {
            actions.put(action("unfreeze", "ignored", "no_safe_unfreeze_patterns"));
            counts.ignored++;
            return counts;
        }

        int matched = 0;
        for (LspFrozenPackage frozen : host.frozenPackages()) {
            if (frozen == null) continue;
            if (!unfreezeAll && !matchesFrozen(frozen, patterns)) continue;
            matched++;
            if (host.unfreezePackage(frozen.packageName)) {
                JSONObject action = action("unfreeze", "applied", reason);
                LspDeviceCommandProtocol.put(action, "package_name", frozen.packageName);
                LspDeviceCommandProtocol.put(action, "app_name", frozen.appName);
                LspDeviceCommandProtocol.put(action, "mode", frozen.mode);
                actions.put(action);
                counts.applied++;
            } else {
                JSONObject action = action("unfreeze", "failed", "unfreeze_api_failed");
                LspDeviceCommandProtocol.put(action, "package_name", frozen.packageName);
                LspDeviceCommandProtocol.put(action, "app_name", frozen.appName);
                LspDeviceCommandProtocol.put(action, "mode", frozen.mode);
                actions.put(action);
                counts.failed++;
            }
        }
        if (matched == 0) {
            actions.put(action("unfreeze", "ignored", "no_frozen_app_matched"));
            counts.ignored++;
        }
        return counts;
    }

    private Counts applyFreeze(JSONArray commands, String reason, JSONArray actions) {
        Counts counts = new Counts();
        if (commands == null || commands.length() == 0) return counts;
        List<Pattern> patterns = LspDeviceCommandProtocol.compileSafePatterns(commands);
        if (patterns.isEmpty()) {
            actions.put(action("freeze", "ignored", "no_safe_freeze_patterns"));
            counts.ignored++;
            return counts;
        }

        LinkedHashSet<String> targets = resolveFreezeTargets(commands, patterns);
        if (targets.isEmpty()) {
            actions.put(action("freeze", "ignored", "no_installed_or_foreground_app_matched"));
            counts.ignored++;
            return counts;
        }

        long now = System.currentTimeMillis();
        long until = host.nextDailyUnfreezeAt(now);
        for (String target : targets) {
            LspFreezeResult frozen = host.freezePackage(target, reason, now, until);
            JSONObject action = action("freeze", frozen.status, frozen.reason);
            LspDeviceCommandProtocol.put(action, "package_name", frozen.packageName);
            LspDeviceCommandProtocol.put(action, "app_name", frozen.appName);
            if (frozen.mode.length() > 0) LspDeviceCommandProtocol.put(action, "mode", frozen.mode);
            if (frozen.until > 0L) LspDeviceCommandProtocol.put(action, "until", host.isoTime(frozen.until));
            actions.put(action);
            if ("applied".equals(frozen.status)) counts.applied++;
            else if ("failed".equals(frozen.status)) counts.failed++;
            else counts.ignored++;
        }
        return counts;
    }

    private LinkedHashSet<String> resolveFreezeTargets(JSONArray commands, List<Pattern> patterns) {
        LinkedHashSet<String> targets = new LinkedHashSet<>();
        String foregroundPackage = LspDeviceCommandProtocol.safeString(host.foregroundPackage());
        String currentText = foregroundPackage + " "
                + LspDeviceCommandProtocol.safeString(host.foregroundApp()) + " "
                + LspDeviceCommandProtocol.safeString(host.foregroundTitle());
        if (foregroundPackage.length() > 0 && LspDeviceCommandProtocol.matchesAny(patterns, currentText)) {
            targets.add(foregroundPackage);
        }
        for (int i = 0; i < commands.length(); i++) {
            String raw = LspDeviceCommandProtocol.safeString(commands.optString(i, ""));
            if (host.isInstalledPackage(raw)) targets.add(raw);
            if (targets.size() >= 12) return targets;
        }
        for (LspInstalledApp app : host.installedApps()) {
            if (app == null || app.packageName == null || app.packageName.length() == 0) continue;
            String text = app.packageName + " " + LspDeviceCommandProtocol.safeString(app.label);
            if (LspDeviceCommandProtocol.matchesAny(patterns, text)) {
                targets.add(app.packageName);
                if (targets.size() >= 12) break;
            }
        }
        return targets;
    }

    private boolean matchesFrozen(LspFrozenPackage frozen, List<Pattern> patterns) {
        String text = LspDeviceCommandProtocol.safeString(frozen.packageName) + " "
                + LspDeviceCommandProtocol.safeString(frozen.appName) + " "
                + LspDeviceCommandProtocol.safeString(frozen.reason);
        return LspDeviceCommandProtocol.matchesAny(patterns, text);
    }

    private boolean commandsContainPendingReview(JSONArray commands) {
        if (commands == null) return false;
        for (int i = 0; i < commands.length(); i++) {
            if (LspSupervisionPolicy.PENDING_RISK_FREEZE_REASON.equals(commands.optString(i))) return true;
        }
        return false;
    }

    private JSONObject result(
            String commandId,
            String requestId,
            String resultId,
            String status,
            JSONArray actions,
            JSONObject stateAfter,
            String reason) {
        JSONObject result = new JSONObject();
        LspDeviceCommandProtocol.put(result, "type", LspDeviceCommandProtocol.TYPE_RESULT);
        LspDeviceCommandProtocol.put(result, "v", 1);
        LspDeviceCommandProtocol.put(result, "request_id", requestId);
        LspDeviceCommandProtocol.put(result, "command_id", commandId);
        LspDeviceCommandProtocol.put(result, "result_id", resultId);
        LspDeviceCommandProtocol.put(result, "status", status);
        LspDeviceCommandProtocol.put(result, "executed_at", host.isoTime(System.currentTimeMillis()));
        LspDeviceCommandProtocol.put(result, "actions", actions != null ? actions : new JSONArray());
        LspDeviceCommandProtocol.put(result, "state_after", stateAfter != null ? stateAfter : new JSONObject());
        if (reason != null && reason.length() > 0) LspDeviceCommandProtocol.put(result, "reason", reason);
        return result;
    }

    private JSONObject action(String name, String status, String reason) {
        JSONObject out = new JSONObject();
        LspDeviceCommandProtocol.put(out, "action", name);
        LspDeviceCommandProtocol.put(out, "status", status);
        if (reason != null && reason.length() > 0) LspDeviceCommandProtocol.put(out, "reason", LspDeviceCommandProtocol.safeString(reason));
        return out;
    }

    private boolean isExpired(String expiresAt) {
        try {
            String value = LspDeviceCommandProtocol.safeString(expiresAt);
            return value.length() > 0 && Instant.parse(value).toEpochMilli() < System.currentTimeMillis();
        } catch (Throwable ignored) {
            return false;
        }
    }

    private static final class Counts {
        int applied;
        int unsupported;
        int failed;
        int ignored;

        void add(Counts other) {
            if (other == null) return;
            applied += other.applied;
            unsupported += other.unsupported;
            failed += other.failed;
            ignored += other.ignored;
        }

        boolean isEmpty() {
            return applied == 0 && unsupported == 0 && failed == 0 && ignored == 0;
        }

        String status() {
            if (applied > 0 && (unsupported > 0 || failed > 0 || ignored > 0)) return "partial";
            if (applied > 0) return "applied";
            if (failed > 0) return "failed";
            if (unsupported > 0) return "unsupported";
            return "ignored";
        }
    }
}
