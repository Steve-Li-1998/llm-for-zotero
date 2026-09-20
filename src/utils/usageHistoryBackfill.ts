/**
 * One-time reconstruction of the usage ledger from stored chat history.
 *
 * The ledger (`./usageStore.ts`) only started recording when it shipped, so a
 * user who has been asking questions for a year would open the Usage tab and
 * see an empty panel. This rebuilds the part of that history the database can
 * still prove, and marks every row it writes as an estimate.
 *
 * WHAT IS RECONSTRUCTED, AND WHAT IS NOT
 *
 *   - One row per stored USER message, so the question count equals the
 *     questions actually asked. An agent turn that produced several assistant
 *     messages is still ONE question, exactly as the live path counts it.
 *   - `counts_as_question = 1` for every row. The old schema records no retry
 *     marker, so a historical retry is indistinguishable from a first ask and
 *     is counted once. Live rows keep their honest retry flag.
 *   - INPUT tokens come from the paired assistant message's `context_tokens`,
 *     which is the size of the prompt the plugin assembled -- an estimate, not
 *     a billed count. When no assistant message in the turn recorded one, the
 *     row stays at zero: nothing here invents a number.
 *   - OUTPUT tokens are always zero. They were never stored, and an estimate
 *     of them would be fiction.
 *
 * Everything it writes carries `token_source = 'history-estimate'` so the read
 * layer can say plainly that pre-cutover tokens are input-only estimates.
 *
 * WHAT IS EXCLUDED
 *
 *   - WebChat turns, by the `webchat_session` catalog flag AND by the
 *     per-message `webchat_run_state` witness (an adopted WebChat turn can sit
 *     inside an ordinary conversation). The live path records nothing for
 *     WebChat, so including them historically would make the two halves of the
 *     ledger disagree.
 *   - Messages whose conversation has no catalog row. Without a catalog there
 *     is no way to check the WebChat flag or attribute a library/paper scope.
 *
 * SAFETY
 *
 * Running this twice would double a year of history, so it is guarded three
 * ways: the conversation-schema-migration marker (once per profile), a
 * module-level in-flight promise, and a per-conversation cutoff that keeps it
 * strictly behind anything the live recorder already wrote. It is wired as a
 * deferred startup task, catches its own failures, and never throws into
 * startup.
 */

import { classifyConversationKey } from "../shared/conversationKeySpace";
import {
  hasConversationSchemaMigration,
  markConversationSchemaMigrationApplied,
} from "../shared/conversationSchemaMigrations";
import {
  USAGE_EVENTS_TABLE,
  initUsageStore,
  resolveUsageScope,
  toLocalDateKey,
  type UsageEventMode,
  type UsageEventRuntime,
} from "./usageStore";

export const USAGE_HISTORY_BACKFILL_MIGRATION_ID = "usage-history-backfill-v1";

const USAGE_HISTORY_BACKFILL_DESCRIPTION =
  "Reconstruct usage ledger rows from stored chat history: one estimated row " +
  "per historical user message, input tokens only, WebChat excluded.";

/**
 * Rows per INSERT. Kept well under the 999-parameter limit an older SQLite
 * build enforces (17 columns x 50 rows = 850), so the batch size never becomes
 * the reason a backfill fails on someone's machine.
 */
const INSERT_BATCH_ROWS = 50;

export type UsageHistoryBackfillResult = {
  /** True when this call is the one that wrote the rows and the marker. */
  applied: boolean;
  rows: number;
  conversations: number;
  /** Rows that carry a non-zero input-token estimate. */
  rowsWithTokenEstimate: number;
  batches: number;
};

const EMPTY_RESULT: UsageHistoryBackfillResult = {
  applied: false,
  rows: 0,
  conversations: 0,
  rowsWithTokenEstimate: 0,
  batches: 0,
};

type BackfillDb = {
  queryAsync: (sql: string, params?: unknown[]) => Promise<unknown>;
};

type HistoryConversation = {
  conversationKey: number;
  messagesTable: string;
  /** From the catalog; the registry still gets the final word below. */
  catalogMode: UsageEventMode;
  libraryID: number | null;
  paperItemID: number | null;
  conversationInstanceID: string | null;
};

type HistoryMessage = {
  role: "user" | "assistant";
  timestamp: number;
  runMode: string | null;
  modelName: string | null;
  providerLabel: string | null;
  contextTokens: number;
  webchatRunState: string | null;
};

type HistoryTurn = {
  timestamp: number;
  promptTokens: number;
  model: string | null;
  provider: string | null;
  runMode: string | null;
  isWebChat: boolean;
};

type PendingRow = {
  timestamp: number;
  localDate: string;
  mode: UsageEventMode;
  conversationKey: number;
  conversationInstanceID: string | null;
  libraryID: number | null;
  paperItemID: number | null;
  model: string | null;
  provider: string | null;
  runtime: UsageEventRuntime | null;
  promptTokens: number;
};

const CHAT_MESSAGES_TABLE = "llm_for_zotero_chat_messages";
const CLAUDE_MESSAGES_TABLE = "llm_for_zotero_claude_messages";
const CODEX_MESSAGES_TABLE = "llm_for_zotero_codex_messages";

let backfillTask: Promise<UsageHistoryBackfillResult> | null = null;

function getDb(): BackfillDb | null {
  const db = (globalThis as { Zotero?: { DB?: { queryAsync?: unknown } } })
    .Zotero?.DB;
  return typeof db?.queryAsync === "function" ? (db as BackfillDb) : null;
}

function log(message: string, error?: unknown): void {
  const write = (
    globalThis as { ztoolkit?: { log?: (...a: unknown[]) => void } }
  ).ztoolkit?.log;
  try {
    if (typeof write === "function") write(`LLM: ${message}`, error);
  } catch {
    // A logging failure must never be the thing that breaks startup.
  }
}

function normalizePositiveInt(value: unknown): number | null {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeTokenCount(value: unknown): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Column names a table actually has; empty means the table is not there. */
async function readTableColumns(
  db: BackfillDb,
  table: string,
): Promise<Set<string>> {
  try {
    const rows = (await db.queryAsync(`PRAGMA table_info(${table})`)) as
      | Array<{ name?: unknown }>
      | undefined;
    return new Set(
      (rows || [])
        .map((row) => (typeof row?.name === "string" ? row.name : ""))
        .filter(Boolean),
    );
  } catch (error) {
    if (/no such table|no table/i.test(String(error))) return new Set<string>();
    throw error;
  }
}

/**
 * A SELECT list that tolerates a column an older schema never created.
 *
 * A downgrade/upgrade cycle, or simply a profile that predates a column, would
 * otherwise turn the whole backfill into one "no such column" failure.
 */
function selectList(
  columns: Set<string>,
  wanted: Array<[string, string]>,
): string {
  return wanted
    .map(([column, alias]) =>
      columns.has(column) ? `${column} AS ${alias}` : `NULL AS ${alias}`,
    )
    .join(", ");
}

async function loadConversationsFromCatalog(
  db: BackfillDb,
  params: {
    catalogTable: string;
    messagesTable: string;
    /** Fixed mode for the upstream catalogs, which are split by table. */
    fixedMode?: UsageEventMode;
  },
): Promise<HistoryConversation[]> {
  const columns = await readTableColumns(db, params.catalogTable);
  if (!columns.size || !columns.has("conversation_key")) return [];
  const fields = selectList(columns, [
    ["conversation_key", "conversationKey"],
    ["library_id", "libraryID"],
    ["paper_item_id", "paperItemID"],
    ["conversation_instance_id", "conversationInstanceID"],
    ["kind", "kind"],
  ]);
  // A WebChat conversation is not part of the ledger at all: the live path
  // records nothing for it, so neither may history.
  const where = columns.has("webchat_session")
    ? "WHERE COALESCE(webchat_session, 0) = 0"
    : "";
  const rows = (await db.queryAsync(
    `SELECT ${fields} FROM ${params.catalogTable} ${where}`,
  )) as Array<Record<string, unknown>> | undefined;
  const conversations: HistoryConversation[] = [];
  for (const row of rows || []) {
    const conversationKey = normalizePositiveInt(row.conversationKey);
    if (!conversationKey) continue;
    const kind = normalizeText(row.kind);
    conversations.push({
      conversationKey,
      messagesTable: params.messagesTable,
      catalogMode: params.fixedMode ?? (kind === "paper" ? "paper" : "library"),
      libraryID: normalizePositiveInt(row.libraryID),
      paperItemID: normalizePositiveInt(row.paperItemID),
      conversationInstanceID: normalizeText(row.conversationInstanceID),
    });
  }
  return conversations;
}

async function loadHistoryConversations(
  db: BackfillDb,
): Promise<HistoryConversation[]> {
  const sources: Array<{
    catalogTable: string;
    messagesTable: string;
    fixedMode?: UsageEventMode;
  }> = [
    {
      catalogTable: "llm_for_zotero_paper_conversations",
      messagesTable: CHAT_MESSAGES_TABLE,
      fixedMode: "paper",
    },
    {
      catalogTable: "llm_for_zotero_global_conversations",
      messagesTable: CHAT_MESSAGES_TABLE,
      fixedMode: "library",
    },
    {
      catalogTable: "llm_for_zotero_claude_conversations",
      messagesTable: CLAUDE_MESSAGES_TABLE,
    },
    {
      catalogTable: "llm_for_zotero_codex_conversations",
      messagesTable: CODEX_MESSAGES_TABLE,
    },
  ];
  const conversations: HistoryConversation[] = [];
  for (const source of sources) {
    conversations.push(...(await loadConversationsFromCatalog(db, source)));
  }
  return conversations;
}

/** Earliest live row per conversation: the line history may not cross. */
async function loadLiveCutoffs(db: BackfillDb): Promise<Map<number, number>> {
  const cutoffs = new Map<number, number>();
  const rows = (await db.queryAsync(
    `SELECT conversation_key AS conversationKey,
            MIN(timestamp) AS earliest
     FROM ${USAGE_EVENTS_TABLE}
     GROUP BY conversation_key`,
  )) as Array<Record<string, unknown>> | undefined;
  for (const row of rows || []) {
    const key = normalizePositiveInt(row.conversationKey);
    const earliest = Math.floor(Number(row.earliest));
    if (!key || !Number.isFinite(earliest)) continue;
    cutoffs.set(key, earliest);
  }
  return cutoffs;
}

async function loadMessages(
  db: BackfillDb,
  messagesTable: string,
  columns: Set<string>,
  conversationKey: number,
): Promise<HistoryMessage[]> {
  const fields = selectList(columns, [
    ["role", "role"],
    ["timestamp", "timestamp"],
    ["run_mode", "runMode"],
    ["model_name", "modelName"],
    ["model_provider_label", "providerLabel"],
    ["context_tokens", "contextTokens"],
    ["webchat_run_state", "webchatRunState"],
  ]);
  const rows = (await db.queryAsync(
    `SELECT ${fields}
     FROM ${messagesTable}
     WHERE conversation_key = ?
     ORDER BY timestamp ASC, id ASC`,
    [conversationKey],
  )) as Array<Record<string, unknown>> | undefined;
  const messages: HistoryMessage[] = [];
  for (const row of rows || []) {
    const role = normalizeText(row.role);
    const timestamp = Math.floor(Number(row.timestamp));
    if (
      (role !== "user" && role !== "assistant") ||
      !Number.isFinite(timestamp)
    )
      continue;
    messages.push({
      role,
      timestamp,
      runMode: normalizeText(row.runMode),
      modelName: normalizeText(row.modelName),
      providerLabel: normalizeText(row.providerLabel),
      contextTokens: normalizeTokenCount(row.contextTokens),
      webchatRunState: normalizeText(row.webchatRunState),
    });
  }
  return messages;
}

/**
 * Group a conversation's messages into turns: one per user message, carrying
 * every assistant message that followed it before the next question.
 */
export function buildHistoryTurns(messages: HistoryMessage[]): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  let current: HistoryTurn | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      current = {
        timestamp: message.timestamp,
        promptTokens: 0,
        model: message.modelName,
        provider: message.providerLabel,
        runMode: message.runMode,
        isWebChat: Boolean(message.webchatRunState),
      };
      turns.push(current);
      continue;
    }
    // An assistant message before any question belongs to no turn.
    if (!current) continue;
    if (message.webchatRunState) current.isWebChat = true;
    // The first recorded context size is the prompt the question was sent
    // with. Later rounds of an agent turn grow it, and summing or maximizing
    // them would claim a number nobody measured.
    if (!current.promptTokens) current.promptTokens = message.contextTokens;
    if (!current.model) current.model = message.modelName;
    if (!current.provider) current.provider = message.providerLabel;
    if (!current.runMode) current.runMode = message.runMode;
  }
  return turns;
}

/**
 * Drop every turn the live ledger might already describe.
 *
 * A live row is written DURING its turn, so its timestamp sits AFTER that
 * turn's user message. Taking everything strictly before the cutoff would
 * therefore re-describe the very turn that produced the earliest live row, so
 * the newest surviving turn is dropped as well. Costing at most one turn is
 * the right trade against counting one twice.
 */
export function selectBackfillableTurns(
  turns: HistoryTurn[],
  liveCutoff: number | undefined,
): HistoryTurn[] {
  if (liveCutoff === undefined) return turns;
  const older = turns.filter((turn) => turn.timestamp < liveCutoff);
  return older.slice(0, Math.max(0, older.length - 1));
}

/** The runtime label the live path would have written for this turn. */
export function resolveHistoryRuntime(
  conversationKey: number,
  runMode: string | null,
): UsageEventRuntime | null {
  const system = classifyConversationKey(conversationKey)?.system;
  if (system === "claude_code") return "claude-code";
  if (system === "codex") return "codex";
  if (runMode === "agent") return "agent";
  if (runMode === "chat") return "chat";
  // A row written before `run_mode` existed says nothing about its runtime,
  // and guessing one would put questions under a label they never ran in.
  return null;
}

const INSERT_COLUMNS = [
  "timestamp",
  "local_date",
  "mode",
  "conversation_key",
  "conversation_instance_id",
  "library_id",
  "paper_item_id",
  "model",
  "provider",
  "runtime",
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "counts_as_question",
  "token_source",
] as const;

function rowParams(row: PendingRow): unknown[] {
  return [
    row.timestamp,
    row.localDate,
    row.mode,
    row.conversationKey,
    row.conversationInstanceID,
    row.libraryID,
    row.paperItemID,
    row.model,
    row.provider,
    row.runtime,
    row.promptTokens,
    // Output tokens were never recorded; the total is therefore the input
    // estimate alone, exactly as the live recorder totals a turn.
    0,
    row.promptTokens,
    0,
    0,
    1,
    "history-estimate",
  ];
}

async function insertRows(db: BackfillDb, rows: PendingRow[]): Promise<number> {
  let batches = 0;
  for (let start = 0; start < rows.length; start += INSERT_BATCH_ROWS) {
    const batch = rows.slice(start, start + INSERT_BATCH_ROWS);
    const placeholders = batch
      .map(() => `(${INSERT_COLUMNS.map(() => "?").join(", ")})`)
      .join(", ");
    const params: unknown[] = [];
    for (const row of batch) params.push(...rowParams(row));
    await db.queryAsync(
      `INSERT INTO ${USAGE_EVENTS_TABLE} (${INSERT_COLUMNS.join(", ")})
       VALUES ${placeholders}`,
      params,
    );
    batches += 1;
  }
  return batches;
}

async function collectRows(db: BackfillDb): Promise<PendingRow[]> {
  const conversations = await loadHistoryConversations(db);
  if (!conversations.length) return [];
  const cutoffs = await loadLiveCutoffs(db);
  const columnsByTable = new Map<string, Set<string>>();
  const rows: PendingRow[] = [];
  for (const conversation of conversations) {
    let columns = columnsByTable.get(conversation.messagesTable);
    if (!columns) {
      columns = await readTableColumns(db, conversation.messagesTable);
      columnsByTable.set(conversation.messagesTable, columns);
    }
    if (!columns.size || !columns.has("conversation_key")) continue;
    const messages = await loadMessages(
      db,
      conversation.messagesTable,
      columns,
      conversation.conversationKey,
    );
    if (!messages.length) continue;
    const turns = selectBackfillableTurns(
      buildHistoryTurns(messages),
      cutoffs.get(conversation.conversationKey),
    ).filter((turn) => !turn.isWebChat);
    if (!turns.length) continue;
    // Attribute exactly as the live path does, then let the catalog fill what
    // the registry does not know: the two must agree row for row or the panel
    // would split one paper across two identities.
    const scope = await resolveUsageScope(conversation.conversationKey);
    const mode: UsageEventMode =
      scope.mode === "paper" || conversation.catalogMode === "paper"
        ? "paper"
        : "library";
    const libraryID = scope.libraryID ?? conversation.libraryID;
    const paperItemID =
      mode === "paper" ? (scope.paperItemID ?? conversation.paperItemID) : null;
    const conversationInstanceID =
      scope.conversationInstanceID ?? conversation.conversationInstanceID;
    for (const turn of turns) {
      rows.push({
        timestamp: turn.timestamp,
        localDate: toLocalDateKey(turn.timestamp),
        mode,
        conversationKey: conversation.conversationKey,
        conversationInstanceID,
        libraryID,
        paperItemID,
        model: turn.model,
        provider: turn.provider,
        runtime: resolveHistoryRuntime(
          conversation.conversationKey,
          turn.runMode,
        ),
        promptTokens: turn.promptTokens,
      });
    }
  }
  return rows;
}

async function runBackfill(): Promise<UsageHistoryBackfillResult> {
  const db = getDb();
  if (!db) return EMPTY_RESULT;
  await initUsageStore();
  if (await hasConversationSchemaMigration(USAGE_HISTORY_BACKFILL_MIGRATION_ID))
    return EMPTY_RESULT;
  const rows = await collectRows(db);
  const conversations = new Set(rows.map((row) => row.conversationKey)).size;
  const rowsWithTokenEstimate = rows.filter(
    (row) => row.promptTokens > 0,
  ).length;
  let batches = 0;
  // Zotero.DB.executeTransaction reads `this._callbacks`, so it must be called
  // AS A METHOD of the connection.
  const connection = (
    globalThis as {
      Zotero?: {
        DB?: { executeTransaction?: (task: () => Promise<void>) => unknown };
      };
    }
  ).Zotero?.DB;
  let applied = false;
  const apply = async (): Promise<void> => {
    // Re-check inside the transaction: a concurrent pass must not be able to
    // write the same year of history twice.
    if (
      await hasConversationSchemaMigration(USAGE_HISTORY_BACKFILL_MIGRATION_ID)
    ) {
      return;
    }
    batches = await insertRows(db, rows);
    await markConversationSchemaMigrationApplied(
      USAGE_HISTORY_BACKFILL_MIGRATION_ID,
      USAGE_HISTORY_BACKFILL_DESCRIPTION,
    );
    applied = true;
  };
  if (typeof connection?.executeTransaction === "function") {
    await connection.executeTransaction(apply);
  } else {
    await apply();
  }
  if (!applied) return EMPTY_RESULT;
  return {
    applied: true,
    rows: rows.length,
    conversations,
    rowsWithTokenEstimate,
    batches,
  };
}

/**
 * Rebuild the ledger from history, once per profile.
 *
 * Never throws: a reporting surface may not be the reason a startup fails.
 */
export async function backfillUsageHistory(): Promise<UsageHistoryBackfillResult> {
  if (backfillTask) return backfillTask;
  backfillTask = (async () => {
    try {
      return await runBackfill();
    } catch (error) {
      log("Failed to backfill the usage ledger from chat history", error);
      return EMPTY_RESULT;
    }
  })();
  return backfillTask;
}

export function resetUsageHistoryBackfillForTests(): void {
  backfillTask = null;
}
