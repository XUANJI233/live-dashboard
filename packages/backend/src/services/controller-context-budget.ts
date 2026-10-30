import { minimalLedger } from "./ledger-context-trim";

const MAX_STRUCTURED_BYTES = 24_000;
const ALLOWED_TRUNCATED_SECTIONS = new Set([
  "settings",
  "persona",
  "devices",
  "devices.frozen_packages",
  "usage_digest",
  "usage_today",
  "installed_changes",
  "timeline",
  "recent_events",
  "commitments",
  "ledger",
]);

interface ControllerContextBounds {
  max_structured_bytes: typeof MAX_STRUCTURED_BYTES;
  truncated: boolean;
  truncated_sections: string[];
  decision_complete: boolean;
  followup_required: false;
  truncation_policy: string;
}

interface ControllerContextCandidate extends Record<string, unknown> {
  schema: "live_dashboard.controller_context.v1";
  generated_at: string;
  mode: string;
  controller_active: boolean;
}

interface BoundedControllerContext extends ControllerContextCandidate {
  bounds: ControllerContextBounds;
}

export function fitControllerContextToMcpBudget(
  candidate: ControllerContextCandidate,
  initiallyTruncated: Iterable<string>,
): BoundedControllerContext {
  const truncatedSections = new Set(
    Array.from(initiallyTruncated).filter((section) => ALLOWED_TRUNCATED_SECTIONS.has(section)),
  );
  const context: BoundedControllerContext = {
    ...candidate,
    bounds: {
      max_structured_bytes: MAX_STRUCTURED_BYTES,
      truncated: false,
      truncated_sections: [],
      decision_complete: true,
      followup_required: false,
      truncation_policy: "Only older or lower-priority detail is omitted. Do not re-read solely because truncated is true.",
    },
  };
  syncBounds(context, truncatedSections);

  const minimumEvents = context.mode === "memory" ? 8 : 4;
  const minimumSessions = context.mode === "daily" || context.mode === "weekly" ? 12 : 6;
  trimWhileOversized(context, () => trimOldestRecentEvent(context, minimumEvents), truncatedSections, "recent_events");
  if (serializedBytes(context) > MAX_STRUCTURED_BYTES && compactTimelineItems(context, 3)) {
    truncatedSections.add("timeline");
    syncBounds(context, truncatedSections);
  }
  trimWhileOversized(context, () => trimOldestTimelineSession(context, minimumSessions), truncatedSections, "timeline");
  trimWhileOversized(context, () => trimFrozenPackage(context), truncatedSections, "devices.frozen_packages");

  if (serializedBytes(context) > MAX_STRUCTURED_BYTES) {
    for (const section of compactLargeTextSections(context)) truncatedSections.add(section);
    syncBounds(context, truncatedSections);
  }
  trimWhileOversized(context, () => trimUsageDigestApp(context, 2), truncatedSections, "usage_digest");
  trimWhileOversized(context, () => trimUsageDigestDevice(context, 2), truncatedSections, "usage_digest");
  trimWhileOversized(context, () => trimUsageTodayApp(context, 2), truncatedSections, "usage_today");
  trimWhileOversized(context, () => trimUsageTodayDevice(context, 2), truncatedSections, "usage_today");
  trimWhileOversized(context, () => trimOldestInstalledChange(context, 5), truncatedSections, "installed_changes");
  trimWhileOversized(context, () => trimOldestDevice(context, 4), truncatedSections, "devices");
  trimWhileOversized(context, () => trimOldestRecentEvent(context, 0), truncatedSections, "recent_events");
  trimWhileOversized(context, () => trimOldestTimelineSession(context, 1), truncatedSections, "timeline");
  trimWhileOversized(context, () => trimOldestInstalledChange(context, 0), truncatedSections, "installed_changes");
  trimWhileOversized(context, () => trimOldestDevice(context, 1), truncatedSections, "devices");
  if (serializedBytes(context) > MAX_STRUCTURED_BYTES) {
    replaceWithMinimalContext(context);
    truncatedSections.add("recent_events");
    truncatedSections.add("timeline");
    truncatedSections.add("devices");
    if (isRecord(context.usage_digest)) truncatedSections.add("usage_digest");
    if (isRecord(context.usage_today)) truncatedSections.add("usage_today");
    if (isRecord(context.installed_changes)) truncatedSections.add("installed_changes");
    syncBounds(context, truncatedSections);
  }
  return serializedBytes(context) <= MAX_STRUCTURED_BYTES
    ? context
    : absoluteMinimalContext(context, truncatedSections);
}

export function controllerContextText(context: Record<string, unknown>): string {
  return JSON.stringify(context);
}

function trimWhileOversized(
  context: BoundedControllerContext,
  trim: () => boolean,
  truncatedSections: Set<string>,
  section: string,
): void {
  while (serializedBytes(context) > MAX_STRUCTURED_BYTES && trim()) {
    truncatedSections.add(section);
    syncBounds(context, truncatedSections);
  }
}

function trimOldestRecentEvent(context: BoundedControllerContext, minimum: number): boolean {
  const recentEvents = recordField(context.recent_events);
  if (!Array.isArray(recentEvents.events) || recentEvents.events.length <= minimum) return false;
  recentEvents.events.shift();
  recentEvents.has_more = true;
  recentEvents.returned_event_count = recentEvents.events.length;
  return true;
}

function trimOldestTimelineSession(context: BoundedControllerContext, minimum: number): boolean {
  const refs = timelineSessionRefs(context);
  if (refs.length <= minimum) return false;
  const oldest = refs.sort(compareSessionRefs)[0];
  if (!oldest) return false;
  oldest.sessions.splice(oldest.sessionIndex, 1);
  if (oldest.sessions.length === 0) oldest.devices.splice(oldest.deviceIndex, 1);
  markTimelineTruncated(context);
  return true;
}

function compactTimelineItems(context: BoundedControllerContext, maximumPerSession: number): boolean {
  let changed = false;
  for (const { session } of timelineSessionRefs(context)) {
    if (!Array.isArray(session.items) || session.items.length <= maximumPerSession) continue;
    session.available_item_count = session.items.length;
    const compactItems = session.items.slice(-maximumPerSession);
    session.items = compactItems;
    session.returned_item_count = compactItems.length;
    session.items_truncated = true;
    changed = true;
  }
  if (changed) markTimelineTruncated(context);
  return changed;
}

interface TimelineSessionRef {
  devices: unknown[];
  deviceIndex: number;
  sessions: unknown[];
  sessionIndex: number;
  session: Record<string, unknown>;
}

function timelineSessionRefs(context: BoundedControllerContext): TimelineSessionRef[] {
  const timeline = recordField(context.timeline);
  const document = recordField(timeline.timeline);
  if (!Array.isArray(document.devices)) return [];
  const devices = document.devices;
  const refs: TimelineSessionRef[] = [];
  devices.forEach((deviceValue, deviceIndex) => {
    if (!isRecord(deviceValue) || !Array.isArray(deviceValue.sessions)) return;
    const sessions = deviceValue.sessions;
    sessions.forEach((sessionValue, sessionIndex) => {
      if (!isRecord(sessionValue)) return;
      refs.push({ devices, deviceIndex, sessions, sessionIndex, session: sessionValue });
    });
  });
  return refs;
}

function compareSessionRefs(left: TimelineSessionRef, right: TimelineSessionRef): number {
  return String(left.session.start || "").localeCompare(String(right.session.start || ""));
}

function markTimelineTruncated(context: BoundedControllerContext): void {
  const timeline = recordField(context.timeline);
  timeline.truncated = true;
  timeline.segment_count = timelineSessionRefs(context)
    .reduce((total, { session }) => total + numericField(session.segment_count), 0);
  timeline.returned_segment_count = timeline.segment_count;
}

function trimFrozenPackage(context: BoundedControllerContext): boolean {
  if (!Array.isArray(context.devices)) return false;
  const device = context.devices
    .filter(isRecord)
    .filter((candidate) => Array.isArray(candidate.frozen_packages) && candidate.frozen_packages.length > 0)
    .sort((left, right) => arrayLength(right.frozen_packages) - arrayLength(left.frozen_packages))[0];
  if (!device || !Array.isArray(device.frozen_packages)) return false;
  device.frozen_packages.pop();
  device.frozen_packages_truncated = true;
  device.frozen_packages_returned_count = device.frozen_packages.length;
  return true;
}

function trimOldestDevice(context: BoundedControllerContext, minimum: number): boolean {
  if (!Array.isArray(context.devices) || context.devices.length <= minimum) return false;
  context.devices.pop();
  context.returned_device_count = context.devices.length;
  return true;
}

function trimUsageDigestApp(context: BoundedControllerContext, minimumApps: number): boolean {
  const devices = recordField(context.usage_digest).devices;
  if (!Array.isArray(devices)) return false;
  const device = devices
    .filter(isRecord)
    .filter((candidate) => arrayLength(candidate.top_apps) > minimumApps)
    .sort((left, right) => arrayLength(right.top_apps) - arrayLength(left.top_apps))[0];
  if (!device || !Array.isArray(device.top_apps)) return false;
  device.top_apps.pop();
  return true;
}

function trimUsageDigestDevice(context: BoundedControllerContext, minimumDevices: number): boolean {
  const devices = recordField(context.usage_digest).devices;
  if (!Array.isArray(devices) || devices.length <= minimumDevices) return false;
  devices.pop();
  return true;
}

function trimUsageTodayApp(context: BoundedControllerContext, minimumApps: number): boolean {
  const usageToday = recordField(context.usage_today);
  if (!Array.isArray(usageToday.devices)) return false;
  const device = usageToday.devices
    .filter(isRecord)
    .filter((candidate) => arrayLength(candidate.top_apps) > minimumApps)
    .sort((left, right) => arrayLength(right.top_apps) - arrayLength(left.top_apps))[0];
  if (!device || !Array.isArray(device.top_apps)) return false;
  device.top_apps.pop();
  usageToday.truncated = true;
  return true;
}

function trimUsageTodayDevice(context: BoundedControllerContext, minimumDevices: number): boolean {
  const usageToday = recordField(context.usage_today);
  if (!Array.isArray(usageToday.devices) || usageToday.devices.length <= minimumDevices) return false;
  usageToday.devices.pop();
  usageToday.truncated = true;
  return true;
}

// Changes are newest first; the oldest go first and the counts say how many remain.
function trimOldestInstalledChange(context: BoundedControllerContext, minimum: number): boolean {
  const installedChanges = recordField(context.installed_changes);
  if (!Array.isArray(installedChanges.changes) || installedChanges.changes.length <= minimum) return false;
  installedChanges.changes.pop();
  installedChanges.returned_count = installedChanges.changes.length;
  installedChanges.has_more = true;
  return true;
}

function compactLargeTextSections(context: BoundedControllerContext): string[] {
  const changed = new Set<string>();
  const settings = recordField(context.settings);
  if (assignClippedText(settings, "target", 500)) changed.add("settings");
  if (assignClippedText(settings, "supervision_policy_reason", 240)) changed.add("settings");
  if (Array.isArray(settings.weekly_plan)) {
    const weeklyPlan = settings.weekly_plan.filter(isRecord).map((day) => {
      const target = clippedText(day.target, 240);
      if (target !== day.target) changed.add("settings");
      return { ...day, target };
    });
    settings.weekly_plan = weeklyPlan;
  }
  const persona = recordField(context.persona);
  if (assignClippedText(persona, "persona", 1_200)) changed.add("persona");
  if (assignClippedText(persona, "relationship", 400)) changed.add("persona");
  if (assignClippedText(persona, "style_notes", 600)) changed.add("persona");
  if (Array.isArray(context.commitments)) {
    const before = serializedBytes(context.commitments);
    context.commitments = compactCommitments(context.commitments, 120);
    if (serializedBytes(context.commitments) < before) changed.add("commitments");
  }
  return Array.from(changed);
}

// The user's own rules outrank everything else in the envelope: they are clipped, never dropped.
function compactCommitments(value: unknown[], quoteLength: number): Record<string, unknown>[] {
  return value.filter(isRecord).map((item) => ({
    commitment_id: item.commitment_id,
    kind: item.kind,
    title: clippedText(item.title, 80),
    user_quote: clippedText(item.user_quote, quoteLength),
    device_id: item.device_id,
    packages_count: arrayLength(item.packages),
    window: item.window ?? null,
    in_window_now: item.in_window_now === true,
    exceptions_left_today: numericField(item.exceptions_left_today),
    open_exceptions: Array.isArray(item.open_exceptions) ? item.open_exceptions.slice(0, 3) : [],
    ends_at: item.ends_at ?? null,
  }));
}

function replaceWithMinimalContext(context: BoundedControllerContext): void {
  const persona = recordField(context.persona);
  context.persona = {
    enabled: persona.enabled === true,
    controller: persona.controller,
    controller_name: persona.controller_name,
    persona: clippedText(persona.persona, 600),
    relationship: clippedText(persona.relationship, 240),
    style_notes: clippedText(persona.style_notes, 240),
    updated_at: persona.updated_at,
  };
  if (Array.isArray(context.devices)) {
    const minimalDevices = context.devices.slice(0, 4).filter(isRecord).map((device) => ({
      device_id: device.device_id,
      device_name: device.device_name,
      platform: device.platform,
      is_online: device.is_online,
      last_seen_at: device.last_seen_at,
      current_app: device.current_app,
      capability: device.capability,
      frozen_packages_count: device.frozen_packages_count,
      frozen_packages_returned_count: 0,
      frozen_packages_truncated: numericField(device.frozen_packages_count) > 0,
      frozen_packages: [],
      sleeping: device.sleeping,
      device_kind: device.device_kind,
    }));
    context.devices = minimalDevices;
    context.returned_device_count = minimalDevices.length;
  }
  const usageDigest = recordField(context.usage_digest);
  if (Array.isArray(usageDigest.devices)) {
    usageDigest.devices = usageDigest.devices.slice(0, 2).filter(isRecord).map((device) => ({
      ...device,
      top_apps: Array.isArray(device.top_apps) ? device.top_apps.slice(0, 2) : [],
    }));
  }
  const usageToday = recordField(context.usage_today);
  if (Array.isArray(usageToday.devices)) {
    usageToday.devices = usageToday.devices.slice(0, 2).filter(isRecord).map((device) => ({
      ...device,
      top_apps: Array.isArray(device.top_apps) ? device.top_apps.slice(0, 2) : [],
    }));
    usageToday.truncated = true;
  }
  const installedChanges = recordField(context.installed_changes);
  const changes = installedChanges.changes;
  if (Array.isArray(changes) && changes.length > 3) {
    installedChanges.changes = changes.slice(0, 3);
    installedChanges.returned_count = 3;
    installedChanges.has_more = true;
  }
  const timeline = recordField(context.timeline);
  timeline.truncated = true;
  timeline.segment_count = 0;
  timeline.returned_segment_count = 0;
  recordField(timeline.timeline).devices = [];
  const recentEvents = recordField(context.recent_events);
  recentEvents.has_more = true;
  recentEvents.events = [];
  recentEvents.returned_event_count = 0;
}

function absoluteMinimalContext(
  context: BoundedControllerContext,
  truncatedSections: Set<string>,
): BoundedControllerContext {
  const settings = recordField(context.settings);
  const persona = recordField(context.persona);
  for (const section of ["settings", "persona", "devices", "timeline", "recent_events"]) {
    truncatedSections.add(section);
  }
  if (isRecord(context.ledger)) truncatedSections.add("ledger");
  return {
    schema: context.schema,
    generated_at: clippedText(context.generated_at, 40),
    mode: clippedText(context.mode, 40),
    controller_active: context.controller_active,
    bounds: {
      ...context.bounds,
      truncated: true,
      truncated_sections: Array.from(truncatedSections).slice(0, 12),
      decision_complete: false,
      followup_required: false,
      truncation_policy: "Required context exceeded the transport envelope. Return the safe silent result; do not repeat the aggregate read.",
    },
    settings: {
      supervision_enabled: settings.supervision_enabled === true,
      supervision_vibrate: settings.supervision_vibrate === true,
      supervision_lsp_freeze: settings.supervision_lsp_freeze === true,
      supervision_skip_watch_sleep: settings.supervision_skip_watch_sleep === true,
    },
    persona: {
      enabled: persona.enabled === true,
      controller: clippedText(persona.controller, 40),
      controller_name: clippedText(persona.controller_name, 80),
    },
    rest_state: clippedText(context.rest_state, 20),
    commitments: Array.isArray(context.commitments) ? compactCommitments(context.commitments, 60) : [],
    // What is due now survives with the commitments: by id and title only.
    ...(isRecord(context.ledger) ? { ledger: minimalLedger(context.ledger) } : {}),
    available_device_count: numericField(context.available_device_count),
    returned_device_count: 0,
    devices: [],
    timeline: {
      truncated: true,
      prebudget_segment_count: numericField(recordField(context.timeline).prebudget_segment_count),
      returned_segment_count: 0,
      segment_count: 0,
      timeline: { devices: [] },
    },
    recent_events: {
      has_more: true,
      prebudget_event_count: numericField(recordField(context.recent_events).prebudget_event_count),
      returned_event_count: 0,
      events: [],
    },
  };
}

function syncBounds(context: BoundedControllerContext, truncatedSections: Set<string>): void {
  context.bounds.truncated = truncatedSections.size > 0;
  context.bounds.truncated_sections = Array.from(truncatedSections);
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function clippedText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  let codePoints = 0;
  let bodyEnd = 0;
  for (const character of value) {
    if (codePoints === maxLength) return `${value.slice(0, bodyEnd)}…`;
    codePoints += 1;
    if (codePoints < maxLength) bodyEnd += character.length;
  }
  return value;
}

function assignClippedText(target: Record<string, unknown>, key: string, maxLength: number): boolean {
  const current = target[key];
  const clipped = clippedText(current, maxLength);
  target[key] = clipped;
  return typeof current === "string" && clipped !== current;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function numericField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function recordField(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
