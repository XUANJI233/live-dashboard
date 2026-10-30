import { z } from "zod";
import {
  ACCOUNTING_GROUP_BY,
  ACCOUNTING_TRANSACTION_TYPES,
  MAX_ACCOUNTING_GROUP_LIMIT,
} from "./accounting-contracts";

// The bill list and the bill summary take the same filters and the same Android refresh switch.
const accountingFilterShape = {
  device_id: z.string().min(1).max(160).optional(),
  transaction_types: z.array(z.enum(ACCOUNTING_TRANSACTION_TYPES)).max(10).optional(),
  category: z.string().max(100).optional().describe("Exact category name."),
  keyword: z.string().max(200).optional()
    .describe("Space-separated words; a bill matches when any word appears inside its shop, item, category, remark, app, channel, or tags (Chinese too)."),
};

const refreshShape = {
  refresh_from_android: z.boolean().optional()
    .describe("True by default. Ask the online Android integration to read AutoAccounting's completed bills before querying the server cache."),
};

export const AccountingBillsSchema = z.object({
  start: z.string().describe("Inclusive ISO timestamp for processed AutoAccounting bills."),
  end: z.string().describe("Exclusive ISO timestamp for processed AutoAccounting bills."),
  ...accountingFilterShape,
  limit: z.number().int().min(1).max(200).optional().describe("Defaults to 50."),
  cursor: z.string().max(500).optional(),
  ...refreshShape,
});

export const AccountingSummarySchema = z.object({
  start: z.string().max(40).describe("Inclusive ISO timestamp with an explicit offset (Z or +08:00); day groups use this offset."),
  end: z.string().max(40).describe("Exclusive ISO timestamp with an explicit offset."),
  ...accountingFilterShape,
  currency_code: z.string().regex(/^[A-Za-z0-9]{2,8}$/).optional()
    .describe("Only this currency; use it when currency_codes lists several."),
  group_by: z.enum(ACCOUNTING_GROUP_BY).optional().describe("Defaults to category; day is the local calendar day."),
  group_limit: z.number().int().min(1).max(MAX_ACCOUNTING_GROUP_LIMIT).optional().describe("Defaults to 20."),
  ...refreshShape,
});
