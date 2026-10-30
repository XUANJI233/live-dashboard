export const ACCOUNTING_TRANSACTION_TYPES = [
  "Expend",
  "ExpendReimbursement",
  "ExpendLending",
  "ExpendRepayment",
  "Income",
  "IncomeLending",
  "IncomeRepayment",
  "IncomeReimbursement",
  "IncomeRefund",
  "Transfer",
] as const;

export const ACCOUNTING_GROUP_BY = ["category", "shop", "app", "day"] as const;
export const MAX_ACCOUNTING_GROUP_LIMIT = 50;
