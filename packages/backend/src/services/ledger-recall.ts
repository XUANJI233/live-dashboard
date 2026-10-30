import { cleanText } from "./mcp-contracts";
import { normalizeSearchText } from "./ledger-guards";
import { RECALL_TEXT_LIMIT } from "./ledger-rules";
import {
  getLedgerRecord,
  ledgerRecallCandidates,
  type LedgerFilter,
  type LedgerRecallCandidate,
  type LedgerRow,
} from "./ledger-store";

// Recall for ledger_search's `about`: the few records that share the most distinctive words with a
// free text such as his latest message, so Hermes can bring them back on every Weixin turn without
// picking a keyword. Words are CJK character bigrams (a two-character word inside a sentence still
// lines up) and ASCII words; a word many records carry counts for little (IDF), and filler bigrams
// count for nothing. Bounded: at most MAX_RECALL_TERMS words against at most MAX_RECALL_ROWS
// records, one substring scan each.

export const DEFAULT_RECALL_LIMIT = 5;
const MAX_RECALL_ROWS = 2_000;
const MAX_RECALL_TERMS = 64;
// A small ledger is judged as if it had this many records, so one rare word can still recall.
const IDF_FLOOR_ROWS = 8;
// One word found in under about a quarter of the records clears this; common words need company.
const MIN_RECALL_SCORE = 1.5;
const FILLER_BIGRAMS = new Set([
  "我们", "你们", "他们", "自己", "今天", "现在", "什么", "怎么", "这个", "那个", "这么", "那么", "这样",
  "一下", "一个", "一直", "没有", "不是", "就是", "还是", "可以", "知道", "觉得", "因为", "所以", "但是",
  "然后", "已经", "时候", "有点", "真的", "好的", "的话", "我的", "你的",
]);
const WORD_RUN = /\p{Script=Han}+|[a-z]+/gu;
const HAN_START = /^\p{Script=Han}/u;

/** The records most related to `about`, open first, then by score; none below the minimum. */
export function recallLedgerRows(filter: LedgerFilter, about: string, limit: number): LedgerRow[] {
  const ids = rankLedgerRecall(ledgerRecallCandidates(filter, MAX_RECALL_ROWS), about, limit);
  return ids.map((id) => getLedgerRecord(id)).filter((row): row is LedgerRow => row !== null);
}

function rankLedgerRecall(candidates: LedgerRecallCandidate[], about: string, limit: number): string[] {
  const terms = recallTerms(about);
  if (terms.length === 0 || candidates.length === 0) return [];
  const found = candidates.map((row) => terms.filter((term) => containsTerm(row.search_text, term)));
  const carriers = new Map<string, number>();
  for (const list of found) for (const term of list) carriers.set(term, (carriers.get(term) ?? 0) + 1);
  const rows = Math.max(candidates.length, IDF_FLOOR_ROWS);
  const weight = (term: string) => Math.log(1 + rows / carriers.get(term)!);
  return candidates
    .map((row, index) => ({ row, score: found[index]!.reduce((sum, term) => sum + weight(term), 0) }))
    .filter((entry) => entry.row.selected && entry.score >= MIN_RECALL_SCORE)
    .sort((left, right) => Number(left.row.status !== "open") - Number(right.row.status !== "open")
      || right.score - left.score
      || right.row.created_at.localeCompare(left.row.created_at)
      || right.row.record_id.localeCompare(left.row.record_id))
    .slice(0, limit)
    .map((entry) => entry.row.record_id);
}

/** Distinct CJK bigrams and ASCII words (two letters or more), in text order, capped. */
function recallTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const [run] of normalizeSearchText(cleanText(text, RECALL_TEXT_LIMIT)).matchAll(WORD_RUN)) {
    if (HAN_START.test(run)) {
      const characters = Array.from(run);
      for (let index = 0; index + 1 < characters.length; index += 1) {
        const bigram = characters[index]! + characters[index + 1]!;
        if (!FILLER_BIGRAMS.has(bigram)) terms.add(bigram);
      }
    } else if (run.length >= 2) {
      terms.add(run);
    }
    if (terms.size >= MAX_RECALL_TERMS) break;
  }
  return [...terms].slice(0, MAX_RECALL_TERMS);
}

/** Bigrams match anywhere; an ASCII word only between non-letters, so "on" misses "consequence". */
function containsTerm(text: string, term: string): boolean {
  if (HAN_START.test(term)) return text.includes(term);
  for (let at = text.indexOf(term); at !== -1; at = text.indexOf(term, at + 1)) {
    if (!isLetter(text.charCodeAt(at - 1)) && !isLetter(text.charCodeAt(at + term.length))) return true;
  }
  return false;
}

function isLetter(code: number): boolean {
  return code >= 97 && code <= 122;
}
