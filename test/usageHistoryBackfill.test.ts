import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import {
  CLAUDE_PAPER_CONVERSATION_KEY_BASE,
  UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE,
  UPSTREAM_PAPER_CONVERSATION_KEY_BASE,
} from "../src/shared/conversationKeySpace";
import {
  appendClaudeMessage,
  initClaudeCodeStore,
  upsertClaudeConversationSummary,
} from "../src/claudeCode/store";
import { resetConversationWriteFenceForTests } from "../src/shared/conversationWriteFence";
import {
  USAGE_EVENTS_TABLE,
  initUsageStore,
  loadUsageEventsForConversation,
  recordUsageEvent,
  resetUsageStoreForTests,
} from "../src/utils/usageStore";
import {
  USAGE_HISTORY_BACKFILL_MIGRATION_ID,
  backfillUsageHistory,
  resetUsageHistoryBackfillForTests,
} from "../src/utils/usageHistoryBackfill";
import { CONVERSATION_SCHEMA_MIGRATIONS_TABLE } from "../src/shared/conversationSchemaMigrations";
import { resetConversationForkLinksStoreInitForTests } from "../src/shared/conversationForkLinks";
import { resetRecentlyDeletedConversationsForTests } from "../src/core/conversations/recentlyDeletedConversations";
import { resetConversationRegistryStoreInitForTests } from "../src/shared/conversationRegistry";
import {
  appendMessage,
  createGlobalConversation,
  createPaperConversation,
  deleteUpstreamConversationLocalRows,
  initChatStore,
  type StoredChatMessage,
} from "../src/utils/chatStore";

const globalScope = globalThis as typeof globalThis & {
  Zotero?: Record<string, unknown>;
};
const originalZotero = globalScope.Zotero;

type SqliteHarness = {
  db: DatabaseSync;
  all: (sql: string, params?: unknown[]) => Record<string, unknown>[];
  statements: string[];
};

/**
 * Zotero's `queryAsync` hands back rows that THROW when code reads a column the
 * SELECT did not include. node:sqlite would quietly return undefined, so the
 * fake proxies every row to reproduce the real failure.
 */
function installSqliteZotero(): SqliteHarness {
  const db = new DatabaseSync(":memory:");
  const prefs = new Map<string, unknown>();
  const statements: string[] = [];
  let transactionDepth = 0;
  const bindable = (params: unknown[] | undefined) =>
    (Array.isArray(params) ? params : params === undefined ? [] : [params]).map(
      (value) => (value === undefined ? null : value),
    ) as never[];
  const toZoteroRow = (row: Record<string, unknown>) =>
    new Proxy(row, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && !(prop in target)) {
          throw new Error(`Column '${prop}' not present in this row`);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  const queryAsync = async (sql: string, params?: unknown[]) => {
    const head = sql.trimStart().slice(0, 8).toUpperCase();
    const isRead =
      head.startsWith("SELECT") ||
      head.startsWith("PRAGMA") ||
      head.startsWith("WITH");
    if (!isRead) {
      statements.push(
        `${transactionDepth > 0 ? "tx:" : "auto:"}${sql.trimStart().slice(0, 64)}`,
      );
    }
    const stmt = db.prepare(sql);
    if (isRead) {
      return (stmt.all(...bindable(params)) as Record<string, unknown>[]).map(
        toZoteroRow,
      );
    }
    stmt.run(...bindable(params));
    return [];
  };
  globalScope.Zotero = {
    ...(originalZotero || {}),
    Libraries: { userLibraryID: 1 },
    Items: { get: () => null },
    Prefs: {
      get: (key: string) => prefs.get(key),
      set: (key: string, value: unknown) => prefs.set(key, value),
      clear: (key: string) => prefs.delete(key),
    },
    Profile: { dir: "/tmp/llm-for-zotero-usage-backfill" },
    debug: () => undefined,
    DB: {
      queryAsync,
      executeTransaction: async (task: () => Promise<unknown>) => {
        transactionDepth += 1;
        try {
          return await task();
        } finally {
          transactionDepth -= 1;
        }
      },
    },
  };
  return {
    db,
    all: (sql, params) =>
      db.prepare(sql).all(...((params || []) as never[])) as Record<
        string,
        unknown
      >[],
    statements,
  };
}

const LIBRARY_ID = 1;
const DAY = 24 * 60 * 60 * 1000;
const BASE_TIME = new Date(2026, 0, 5, 10, 0, 0).getTime();

function userMessage(
  timestamp: number,
  overrides: Partial<StoredChatMessage> = {},
): StoredChatMessage {
  return {
    role: "user",
    text: "question",
    timestamp,
    ...overrides,
  } as StoredChatMessage;
}

function assistantMessage(
  timestamp: number,
  overrides: Partial<StoredChatMessage> = {},
): StoredChatMessage {
  return {
    role: "assistant",
    text: "answer",
    timestamp,
    ...overrides,
  } as StoredChatMessage;
}

async function allUsageRows(harness: SqliteHarness) {
  return harness.all(
    `SELECT conversation_key AS conversationKey,
            mode,
            timestamp,
            local_date AS localDate,
            paper_item_id AS paperItemID,
            library_id AS libraryID,
            model,
            provider,
            runtime,
            prompt_tokens AS promptTokens,
            completion_tokens AS completionTokens,
            total_tokens AS totalTokens,
            counts_as_question AS countsAsQuestion,
            token_source AS tokenSource
     FROM ${USAGE_EVENTS_TABLE}
     ORDER BY timestamp ASC, id ASC`,
  );
}

describe("usage history backfill", function () {
  let harness: SqliteHarness;

  beforeEach(async function () {
    resetUsageStoreForTests();
    resetUsageHistoryBackfillForTests();
    resetConversationWriteFenceForTests();
    resetConversationForkLinksStoreInitForTests();
    resetConversationRegistryStoreInitForTests();
    resetRecentlyDeletedConversationsForTests();
    harness = installSqliteZotero();
    await initChatStore();
    await initUsageStore();
  });

  afterEach(function () {
    harness.db.close();
    resetUsageStoreForTests();
    resetUsageHistoryBackfillForTests();
    resetConversationWriteFenceForTests();
    resetConversationForkLinksStoreInitForTests();
    resetConversationRegistryStoreInitForTests();
    resetRecentlyDeletedConversationsForTests();
    globalScope.Zotero = originalZotero;
  });

  it("writes one estimated row per historical user message, with the input-only tokens", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    await appendMessage(
      conversationKey,
      userMessage(BASE_TIME, { modelName: "deepseek-chat" }),
    );
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + 1000, {
        modelName: "deepseek-chat",
        modelProviderLabel: "DeepSeek",
        contextTokens: 4200,
      }),
    );
    await appendMessage(conversationKey, userMessage(BASE_TIME + DAY));
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + DAY + 1000, { contextTokens: 5100 }),
    );

    const result = await backfillUsageHistory();
    assert.strictEqual(result.applied, true);
    assert.strictEqual(result.rows, 2);

    const rows = await allUsageRows(harness);
    assert.lengthOf(rows, 2);
    assert.deepStrictEqual(
      rows.map((row) => Number(row.promptTokens)),
      [4200, 5100],
    );
    for (const row of rows) {
      assert.strictEqual(row.tokenSource, "history-estimate");
      assert.strictEqual(Number(row.completionTokens), 0);
      assert.strictEqual(Number(row.countsAsQuestion), 1);
      assert.strictEqual(row.mode, "library");
      assert.strictEqual(Number(row.conversationKey), conversationKey);
    }
    assert.strictEqual(Number(rows[0]!.totalTokens), 4200);
    assert.strictEqual(rows[0]!.model, "deepseek-chat");
    assert.strictEqual(rows[0]!.provider, "DeepSeek");
    assert.strictEqual(Number(rows[0]!.timestamp), BASE_TIME);
  });

  it("counts an agent turn with several assistant messages as one question", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    await appendMessage(
      conversationKey,
      userMessage(BASE_TIME, {
        runMode: "agent",
      } as Partial<StoredChatMessage>),
    );
    for (const offset of [1000, 2000, 3000]) {
      await appendMessage(
        conversationKey,
        assistantMessage(BASE_TIME + offset, {
          contextTokens: 1000 + offset,
          runMode: "agent",
        } as Partial<StoredChatMessage>),
      );
    }

    await backfillUsageHistory();
    const rows = await allUsageRows(harness);
    assert.lengthOf(rows, 1);
    assert.strictEqual(Number(rows[0]!.promptTokens), 2000);
    assert.strictEqual(rows[0]!.runtime, "agent");
  });

  it("leaves tokens at zero when no assistant message recorded a context size", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    await appendMessage(conversationKey, userMessage(BASE_TIME));
    await appendMessage(conversationKey, assistantMessage(BASE_TIME + 1000));

    await backfillUsageHistory();
    const rows = await allUsageRows(harness);
    assert.lengthOf(rows, 1);
    assert.strictEqual(Number(rows[0]!.promptTokens), 0);
    assert.strictEqual(Number(rows[0]!.totalTokens), 0);
    assert.strictEqual(rows[0]!.tokenSource, "history-estimate");
  });

  it("attributes a paper conversation exactly as the live path does", async function () {
    const paper = await createPaperConversation(LIBRARY_ID, 4242);
    assert.isOk(paper);
    const conversationKey = paper!.conversationKey;
    await appendMessage(conversationKey, userMessage(BASE_TIME));
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + 1000, { contextTokens: 300 }),
    );

    await backfillUsageHistory();
    const rows = await loadUsageEventsForConversation(conversationKey);
    assert.lengthOf(rows, 1);
    assert.strictEqual(rows[0]!.mode, "paper");
    assert.strictEqual(rows[0]!.paperItemID, 4242);
    assert.strictEqual(rows[0]!.libraryID, LIBRARY_ID);
    assert.isTrue(
      conversationKey < UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE &&
        conversationKey >= UPSTREAM_PAPER_CONVERSATION_KEY_BASE,
    );
  });

  it("never runs twice: a second pass adds no rows", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    await appendMessage(conversationKey, userMessage(BASE_TIME));
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + 1000, { contextTokens: 900 }),
    );

    const first = await backfillUsageHistory();
    const firstRows = await allUsageRows(harness);
    resetUsageHistoryBackfillForTests();
    const second = await backfillUsageHistory();
    const secondRows = await allUsageRows(harness);

    assert.strictEqual(first.applied, true);
    assert.strictEqual(second.applied, false);
    assert.strictEqual(second.rows, 0);
    assert.deepStrictEqual(secondRows, firstRows);
    const markers = harness.all(
      `SELECT id FROM ${CONVERSATION_SCHEMA_MIGRATIONS_TABLE} WHERE id = ?`,
      [USAGE_HISTORY_BACKFILL_MIGRATION_ID],
    );
    assert.lengthOf(markers, 1);
  });

  it("re-running initUsageStore does not re-add backfilled rows", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    await appendMessage(conversationKey, userMessage(BASE_TIME));
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + 1000, { contextTokens: 900 }),
    );
    await backfillUsageHistory();

    resetUsageStoreForTests();
    await initUsageStore();
    const rows = await allUsageRows(harness);
    assert.lengthOf(rows, 1);
    assert.strictEqual(rows[0]!.tokenSource, "history-estimate");
  });

  it("keeps the healing pass from re-labelling an estimate with zero tokens", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    await appendMessage(conversationKey, userMessage(BASE_TIME));
    await appendMessage(conversationKey, assistantMessage(BASE_TIME + 1000));
    await backfillUsageHistory();

    resetUsageStoreForTests();
    await initUsageStore();
    const rows = await allUsageRows(harness);
    assert.lengthOf(rows, 1);
    assert.strictEqual(Number(rows[0]!.totalTokens), 0);
    assert.strictEqual(rows[0]!.tokenSource, "history-estimate");
  });

  it("never describes a turn the live ledger already recorded", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    // Three historical turns; the live ledger already owns the last one.
    for (const index of [0, 1, 2]) {
      await appendMessage(
        conversationKey,
        userMessage(BASE_TIME + index * DAY),
      );
      await appendMessage(
        conversationKey,
        assistantMessage(BASE_TIME + index * DAY + 1000, {
          contextTokens: 100 + index,
        }),
      );
    }
    // A live row is written DURING its turn, so its timestamp sits after that
    // turn's user message: the boundary turn must still be left alone.
    await recordUsageEvent({
      mode: "library",
      conversationKey,
      timestamp: BASE_TIME + 2 * DAY + 500,
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
    });

    await backfillUsageHistory();
    const rows = await allUsageRows(harness);
    assert.lengthOf(rows, 3);
    const estimates = rows.filter(
      (row) => row.tokenSource === "history-estimate",
    );
    assert.lengthOf(estimates, 2);
    assert.deepStrictEqual(
      estimates.map((row) => Number(row.timestamp)),
      [BASE_TIME, BASE_TIME + DAY],
    );
  });

  it("backfills a conversation that has no live rows at all", async function () {
    const untouched = await createGlobalConversation(LIBRARY_ID);
    const live = await createGlobalConversation(LIBRARY_ID);
    await appendMessage(untouched, userMessage(BASE_TIME + 10 * DAY));
    await appendMessage(
      untouched,
      assistantMessage(BASE_TIME + 10 * DAY + 1000, { contextTokens: 77 }),
    );
    await appendMessage(live, userMessage(BASE_TIME));
    await appendMessage(
      live,
      assistantMessage(BASE_TIME + 1000, { contextTokens: 88 }),
    );
    await recordUsageEvent({
      mode: "library",
      conversationKey: live,
      timestamp: BASE_TIME + 500,
      totalTokens: 5,
    });

    await backfillUsageHistory();
    const estimates = (await allUsageRows(harness)).filter(
      (row) => row.tokenSource === "history-estimate",
    );
    assert.lengthOf(estimates, 1);
    assert.strictEqual(Number(estimates[0]!.conversationKey), untouched);
    assert.strictEqual(Number(estimates[0]!.promptTokens), 77);
  });

  it("excludes WebChat conversations, which the live path never records", async function () {
    const webchat = await createGlobalConversation(LIBRARY_ID, {
      webchatSession: true,
    });
    const webchatPaper = await createPaperConversation(LIBRARY_ID, 99, {
      webchatSession: true,
    });
    // Written straight to the table: appendMessage ADOPTS a webchat-flagged
    // row (it clears the flag), which would quietly turn this into a test of
    // an ordinary conversation.
    for (const key of [webchat, webchatPaper!.conversationKey]) {
      harness.db
        .prepare(
          `INSERT INTO llm_for_zotero_chat_messages
             (conversation_key, role, text, timestamp, context_tokens)
           VALUES (?, 'user', 'question', ?, NULL),
                  (?, 'assistant', 'answer', ?, 1200)`,
        )
        .run(key, BASE_TIME, key, BASE_TIME + 1000);
    }

    await backfillUsageHistory();
    assert.lengthOf(await allUsageRows(harness), 0);
  });

  it("excludes a WebChat turn adopted into an ordinary conversation", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    await appendMessage(conversationKey, userMessage(BASE_TIME));
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + 1000, {
        contextTokens: 1200,
        webchatRunState: "done",
      }),
    );
    await appendMessage(conversationKey, userMessage(BASE_TIME + DAY));
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + DAY + 1000, { contextTokens: 50 }),
    );

    await backfillUsageHistory();
    const rows = await allUsageRows(harness);
    assert.lengthOf(rows, 1);
    assert.strictEqual(Number(rows[0]!.promptTokens), 50);
  });

  it("attributes Claude Code history to its own runtime", async function () {
    await initClaudeCodeStore();
    const conversationKey = CLAUDE_PAPER_CONVERSATION_KEY_BASE + 17;
    await upsertClaudeConversationSummary({
      conversationKey,
      libraryID: LIBRARY_ID,
      kind: "paper",
      paperItemID: 808,
    });
    await appendClaudeMessage(conversationKey, userMessage(BASE_TIME));
    await appendClaudeMessage(
      conversationKey,
      assistantMessage(BASE_TIME + 1000, { contextTokens: 1500 }),
    );

    await backfillUsageHistory();
    const rows = await loadUsageEventsForConversation(conversationKey);
    assert.lengthOf(rows, 1);
    assert.strictEqual(rows[0]!.runtime, "claude-code");
    assert.strictEqual(rows[0]!.mode, "paper");
    assert.strictEqual(rows[0]!.paperItemID, 808);
    assert.strictEqual(rows[0]!.promptTokens, 1500);
    assert.strictEqual(rows[0]!.tokenSource, "history-estimate");
  });

  it("lets the deletion cascade remove backfilled rows", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    await appendMessage(conversationKey, userMessage(BASE_TIME));
    await appendMessage(
      conversationKey,
      assistantMessage(BASE_TIME + 1000, { contextTokens: 640 }),
    );
    await backfillUsageHistory();
    assert.lengthOf(await loadUsageEventsForConversation(conversationKey), 1);

    await deleteUpstreamConversationLocalRows(conversationKey, "global");
    assert.lengthOf(await loadUsageEventsForConversation(conversationKey), 0);
  });

  it("inserts a large history in batches inside one transaction", async function () {
    const conversationKey = await createGlobalConversation(LIBRARY_ID);
    for (let index = 0; index < 120; index += 1) {
      await appendMessage(
        conversationKey,
        userMessage(BASE_TIME + index * 60_000),
      );
      await appendMessage(
        conversationKey,
        assistantMessage(BASE_TIME + index * 60_000 + 1000, {
          contextTokens: 100 + index,
        }),
      );
    }
    harness.statements.length = 0;

    const result = await backfillUsageHistory();
    assert.strictEqual(result.rows, 120);
    const inserts = harness.statements.filter((statement) =>
      statement.includes(`INSERT INTO ${USAGE_EVENTS_TABLE}`),
    );
    // Batched: far fewer statements than rows, and every one inside the
    // transaction so a failure cannot leave half a year of history behind.
    assert.isAtMost(inserts.length, 12);
    assert.isAtLeast(inserts.length, 1);
    for (const statement of inserts) {
      assert.isTrue(
        statement.startsWith("tx:"),
        `insert ran outside a transaction: ${statement}`,
      );
    }
    assert.lengthOf(await allUsageRows(harness), 120);
  });
});
