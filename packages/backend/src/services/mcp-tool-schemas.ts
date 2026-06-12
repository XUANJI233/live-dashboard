import { z } from "zod";

export const DateRangeSchema = z.object({
  start: z.string().describe("Inclusive ISO timestamp."),
  end: z.string().describe("Exclusive ISO timestamp."),
  limit: z.number().int().min(1).max(240).optional(),
  timezone_offset_minutes: z.number().int().min(-14 * 60).max(14 * 60).optional(),
});

export const DeviceTimelineSchema = DateRangeSchema.extend({
  device_id: z.string().min(1).max(160),
});

export const FrozenListSchema = z.object({
  device_id: z.string().min(1).max(160),
});

export const InstalledAppsSchema = z.object({
  device_id: z.string().min(1).max(160),
});

export const SendCommandsSchema = z.object({
  request_id: z.string().min(1).max(160).optional(),
  created_by: z.enum(["mcp", "supervision"]).optional(),
  commands: z.array(z.object({
    device_id: z.string().min(1).max(160),
    freeze_commands: z.array(z.string().max(120)).max(12).optional(),
    unfreeze_commands: z.array(z.string().max(120)).max(12).optional(),
    vibrate: z.boolean().optional(),
    screen_off: z.boolean().optional(),
    say: z.string().max(500).optional(),
    expires_in_seconds: z.number().int().min(10).max(3600).optional(),
  })).min(1).max(20),
});

export const SupervisionPolicySchema = z.object({
  risk_app_regex: z.array(z.string().max(120)).max(12).optional(),
  risk_trigger_minutes: z.number().int().min(1).max(55).optional(),
  app_time_limits: z.array(z.object({
    app_regex: z.string().min(1).max(120),
    limit_minutes: z.number().int().min(1).max(55),
    reason: z.string().max(120).optional(),
  })).max(12).optional(),
  device_ids: z.array(z.string().min(1).max(160)).max(20).optional(),
  expires_in_seconds: z.number().int().min(10).max(3600).optional(),
});

export const CommandStatusSchema = z.object({
  command_id: z.string().min(1).max(160).optional(),
  request_id: z.string().min(1).max(160).optional(),
});

export type SendCommandsArgs = z.infer<typeof SendCommandsSchema>;
export type SupervisionPolicyArgs = z.infer<typeof SupervisionPolicySchema>;
