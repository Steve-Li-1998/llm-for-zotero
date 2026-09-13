import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import {
  CLAUDE_GLOBAL_CONVERSATION_KEY_BASE,
  CODEX_GLOBAL_CONVERSATION_KEY_BASE,
} from "../src/shared/conversationKeySpace";
import {
  appendMessage,
  createGlobalConversation,
  initChatStore,
  loadConversation,
  type StoredChatMessage,
} from "../src/utils/chatStore";
import {
  appendCodexMessage,
  clearCodexConversation,
  getCodexConversationSummary,
  initCodexAppServerStore,
  loadCodexConversation,
  repairCodexConversationIdentityRegistry,
  upsertCodexConversationSummary,
} from "../src/codexAppServer/store";
import {
  appendClaudeMessage,
  clearClaudeConversation,
  getClaudeConversationSummary,
  initClaudeCodeStore,
  loadClaudeConversation,
  repairClaudeConversationIdentityRegistry,
  upsertClaudeConversationSummary,
} from "../src/claudeCode/store";

/**
 * Characterization for the mechanics the three conversation stores duplicate:
 * schema-column access, row -> message mapping, the JSON column codec, the
 * transaction wrapper, the registry-repair sweep, and the catalog summary
 * cache.  Every assertion here describes behavior that must survive the
 * extraction of those mechanics into one owner, so the file is written against
 * each store's public surface rather than against any helper.
 */

const CODEX_CATALOG_TABLE = "llm_for_zotero_codex_conversations";
const CLAUDE_CATALOG_TABLE = "llm_for_zotero_claude_conversations";
const CODEX_MESSAGES_TABLE = "llm_for_zotero_codex_messages";
const CLAUDE_MESSAGES_TABLE = "llm_for_zotero_claude_messages";
const CHAT_MESSAGES_TABLE = "llm_for_zotero_chat_messages";

const globalScope = globalThis as typeof globalThis & {
  Zotero?: Record<string, unknown>;
};
const originalZotero = globalScope.Zotero;

type SqliteHarness = {
  db: DatabaseSync;
  all: (sql: string, params?: unknown[]) => Record<string, unknown>[];
  run: (sql: string, params?: unknown[]) => void;
  transactions: () => number;
};

function installSqliteZotero(): SqliteHarness {
  const db = new DatabaseSync(":memory:");
  const bindable = (params: unknown[] | undefined) =>
    (Array.isArray(params) ? params : params === undefined ? [] : [params]).map(
      (value) => (value === undefined ? null : value),
    ) as never[];
  // Zotero 7's queryAsync wraps rows in a proxy that THROWS when code reads a
  // column the SELECT did not include (node:sqlite returns undefined). Mimic
  // that here or the suite silently passes on exactly the row-access bugs
  // that break the real plugin.
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
    const stmt = db.prepare(sql);
    if (
      head.startsWith("SELECT") ||
      head.startsWith("PRAGMA") ||
      head.startsWith("WITH")
    ) {
      return (stmt.all(...bindable(params)) as Record<string, unknown>[]).map(
        toZoteroRow,
      );
    }
    stmt.run(...bindable(params));
    return [];
  };
  const prefs = new Map<string, unknown>();
  let transactions = 0;
  globalScope.Zotero = {
    ...(originalZotero || {}),
    Libraries: { userLibraryID: 1 },
    Items: { get: () => null },
    Prefs: {
      get: (key: string) => prefs.get(key),
      set: (key: string, value: unknown) => prefs.set(key, value),
      clear: (key: string) => prefs.delete(key),
    },
    Profile: { dir: "/tmp/llm-for-zotero-store-mechanics" },
    debug: () => undefined,
    DB: {
      queryAsync,
      executeTransaction: async (task: () => Promise<unknown>) => {
        transactions += 1;
        return await task();
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
    run: (sql, params) => {
      db.prepare(sql).run(...((params || []) as never[]));
    },
    transactions: () => transactions,
  };
}

function tableColumns(harness: SqliteHarness, table: string): Set<string> {
  return new Set(
    harness
      .all(`PRAGMA table_info(${table})`)
      .map((row) => String(row.name as string)),
  );
}

/**
 * A message that populates every JSON-encoded column the stores own, so the
 * encode side and the decode side are both pinned by one round trip.
 */
function paperContext(itemId: number, title: string) {
  return { libraryID: 1, itemId, contextItemId: itemId, title };
}

function richMessage(overrides: Partial<StoredChatMessage> = {}) {
  return {
    role: "user" as const,
    text: "how does this paper define salience?",
    timestamp: 1700000000000,
    runMode: "agent" as const,
    agentRunId: "run-7",
    documentId: "doc-3",
    selectedText: "salience map",
    selectedTexts: ["salience map", "attention gate"],
    selectedTextPaperContexts: [
      paperContext(41, "Paper A"),
      paperContext(42, "Paper B"),
    ],
    forcedSkillIds: ["write-note"],
    paperContexts: [paperContext(41, "Paper A")],
    pdfPaperContexts: [paperContext(42, "Paper B")],
    fullTextPaperContexts: [paperContext(43, "Paper C")],
    citationPaperContexts: [paperContext(44, "Paper D")],
    quoteCitations: [
      {
        quoteText: "salience is defined as the weighted priority of a stimulus",
        citationLabel: "Smith 2020",
        itemId: 41,
        contextItemId: 41,
        allowShortQuoteText: true,
      },
    ],
    selectedCollectionContexts: [
      { collectionId: 9, name: "Reviews", libraryID: 1 },
    ],
    selectedTagContexts: [
      { name: "salience", normalizedName: "salience", libraryID: 1 },
    ],
    screenshotImages: ["data:image/png;base64,AAA"],
    attachments: [
      {
        id: "att-1",
        name: "figure.png",
        mimeType: "image/png",
        sizeBytes: 12,
        category: "image" as const,
      },
    ],
    modelName: "gpt-5",
    modelEntryId: "entry-1",
    modelProviderLabel: "OpenAI",
    contextTokens: 1200,
    contextWindow: 128000,
    ...overrides,
  } as unknown as StoredChatMessage;
}

describe("conversation store mechanics", function () {
  let harness: SqliteHarness;

  beforeEach(function () {
    harness = installSqliteZotero();
  });

  afterEach(function () {
    harness.db.close();
    globalScope.Zotero = originalZotero;
  });

  describe("schema column access", function () {
    it("adds each backend catalog's own column set and stays idempotent", async function () {
      await initCodexAppServerStore();
      await initClaudeCodeStore();

      const codexColumns = tableColumns(harness, CODEX_CATALOG_TABLE);
      const claudeColumns = tableColumns(harness, CLAUDE_CATALOG_TABLE);

      // Shared vocabulary: every catalog carries the same identity columns.
      for (const column of [
        "conversation_key",
        "conversation_id",
        "conversation_instance_id",
        "scoped_conversation_key",
        "user_turn_count",
        "last_activity_at",
      ]) {
        assert.isTrue(
          codexColumns.has(column),
          `codex catalog is missing ${column}`,
        );
        assert.isTrue(
          claudeColumns.has(column),
          `claude catalog is missing ${column}`,
        );
      }

      // Provider-specific: only Codex carries the permission-state columns.
      assert.isTrue(codexColumns.has("provider_permission_state"));
      assert.isTrue(codexColumns.has("provider_session_path_state"));
      assert.isFalse(claudeColumns.has("provider_permission_state"));
      assert.isFalse(claudeColumns.has("provider_session_path_state"));

      // Re-running initialization must not fail on already-present columns.
      await initCodexAppServerStore();
      await initClaudeCodeStore();
      assert.deepEqual(
        [...tableColumns(harness, CODEX_CATALOG_TABLE)].sort(),
        [...codexColumns].sort(),
      );
    });
  });

  describe("row to message mapping and the JSON column codec", function () {
    it("round-trips every JSON-encoded column through the Codex store", async function () {
      await initCodexAppServerStore();
      const conversationKey = CODEX_GLOBAL_CONVERSATION_KEY_BASE + 11;
      await upsertCodexConversationSummary({
        conversationKey,
        libraryID: 1,
        kind: "global",
      });
      await appendCodexMessage(conversationKey, richMessage());

      const [loaded] = await loadCodexConversation(conversationKey, 10);

      assert.strictEqual(loaded.role, "user");
      assert.strictEqual(loaded.text, "how does this paper define salience?");
      assert.strictEqual(loaded.timestamp, 1700000000000);
      assert.strictEqual(loaded.runMode, "agent");
      assert.strictEqual(loaded.agentRunId, "run-7");
      assert.strictEqual(loaded.documentId, "doc-3");
      assert.deepEqual(loaded.selectedTexts, [
        "salience map",
        "attention gate",
      ]);
      assert.strictEqual(
        loaded.selectedTextContexts?.[0]?.text,
        "salience map",
      );
      assert.strictEqual(loaded.selectedTextContexts?.[0]?.source, "pdf");
      assert.strictEqual(
        loaded.selectedTextContexts?.[0]?.paperContext?.itemId,
        41,
      );
      assert.deepEqual(loaded.forcedSkillIds, ["write-note"]);
      assert.strictEqual(loaded.paperContexts?.[0]?.itemId, 41);
      assert.strictEqual(loaded.pdfPaperContexts?.[0]?.itemId, 42);
      assert.strictEqual(
        loaded.pdfPaperContexts?.[0]?.contentSourceMode,
        "pdf",
      );
      assert.strictEqual(loaded.fullTextPaperContexts?.[0]?.itemId, 43);
      assert.strictEqual(loaded.citationPaperContexts?.[0]?.itemId, 44);
      assert.strictEqual(loaded.quoteCitations?.[0]?.itemId, 41);
      assert.strictEqual(
        loaded.quoteCitations?.[0]?.citationLabel,
        "(Smith 2020)",
      );
      assert.strictEqual(
        loaded.selectedCollectionContexts?.[0]?.collectionId,
        9,
      );
      assert.strictEqual(loaded.selectedTagContexts?.[0]?.name, "salience");
      assert.deepEqual(loaded.screenshotImages, ["data:image/png;base64,AAA"]);
      assert.strictEqual(loaded.attachments?.[0]?.id, "att-1");
      assert.strictEqual(loaded.modelName, "gpt-5");
      assert.strictEqual(loaded.modelEntryId, "entry-1");
      assert.strictEqual(loaded.modelProviderLabel, "OpenAI");
      assert.strictEqual(loaded.contextTokens, 1200);
      assert.strictEqual(loaded.contextWindow, 128000);
    });

    it("maps the same row shape in the Claude store", async function () {
      await initClaudeCodeStore();
      const conversationKey = CLAUDE_GLOBAL_CONVERSATION_KEY_BASE + 11;
      await upsertClaudeConversationSummary({
        conversationKey,
        libraryID: 1,
        kind: "global",
      });
      await appendClaudeMessage(conversationKey, richMessage());

      const [loaded] = await loadClaudeConversation(conversationKey, 10);

      assert.deepEqual(loaded.selectedTexts, [
        "salience map",
        "attention gate",
      ]);
      assert.deepEqual(loaded.forcedSkillIds, ["write-note"]);
      assert.strictEqual(loaded.paperContexts?.[0]?.itemId, 41);
      assert.strictEqual(loaded.pdfPaperContexts?.[0]?.itemId, 42);
      assert.strictEqual(loaded.quoteCitations?.[0]?.itemId, 41);
      assert.strictEqual(loaded.attachments?.[0]?.id, "att-1");
      assert.strictEqual(loaded.contextWindow, 128000);
    });

    it("keeps the upstream chat store's own mapping of the same message", async function () {
      await initChatStore();
      const conversationKey = await createGlobalConversation(1);
      await appendMessage(conversationKey, richMessage());

      const [loaded] = await loadConversation(conversationKey, 10);

      assert.deepEqual(loaded.selectedTexts, [
        "salience map",
        "attention gate",
      ]);
      assert.deepEqual(loaded.forcedSkillIds, ["write-note"]);
      assert.strictEqual(loaded.paperContexts?.[0]?.itemId, 41);
      assert.strictEqual(loaded.attachments?.[0]?.id, "att-1");
      assert.strictEqual(loaded.contextTokens, 1200);
    });

    it("tolerates malformed JSON in a context column instead of failing the load", async function () {
      await initCodexAppServerStore();
      const conversationKey = CODEX_GLOBAL_CONVERSATION_KEY_BASE + 12;
      await upsertCodexConversationSummary({
        conversationKey,
        libraryID: 1,
        kind: "global",
      });
      await appendCodexMessage(conversationKey, richMessage());
      harness.run(
        `UPDATE ${CODEX_MESSAGES_TABLE}
         SET paper_contexts_json = '{not json',
             attachments_json = '{not json'
         WHERE conversation_key = ?`,
        [conversationKey],
      );

      const [loaded] = await loadCodexConversation(conversationKey, 10);

      assert.isUndefined(loaded.paperContexts);
      assert.isUndefined(loaded.attachments);
      // Columns that still hold valid JSON are unaffected.
      assert.strictEqual(loaded.pdfPaperContexts?.[0]?.itemId, 42);
    });

    it("writes NULL rather than an empty JSON array for absent context columns", async function () {
      await initClaudeCodeStore();
      const conversationKey = CLAUDE_GLOBAL_CONVERSATION_KEY_BASE + 12;
      await upsertClaudeConversationSummary({
        conversationKey,
        libraryID: 1,
        kind: "global",
      });
      await appendClaudeMessage(conversationKey, {
        role: "user",
        text: "plain",
        timestamp: 5,
      });

      const [row] = harness.all(
        `SELECT paper_contexts_json AS paperContextsJson,
                attachments_json AS attachmentsJson,
                quote_citations_json AS quoteCitationsJson
         FROM ${CLAUDE_MESSAGES_TABLE}
         WHERE conversation_key = ?`,
        [conversationKey],
      );
      assert.isNull(row.paperContextsJson);
      assert.isNull(row.attachmentsJson);
      assert.isNull(row.quoteCitationsJson);
    });
  });

  describe("message conversation selector", function () {
    it("returns no messages for a key with no registered conversation id", async function () {
      await initCodexAppServerStore();
      const conversationKey = CODEX_GLOBAL_CONVERSATION_KEY_BASE + 13;
      // Rows exist under the key, but nothing registered the scope, so the
      // selector must resolve to the "match nothing" branch.
      harness.run(
        `INSERT INTO ${CODEX_MESSAGES_TABLE}
           (conversation_key, role, text, timestamp)
         VALUES (?, 'user', 'orphan', 1)`,
        [conversationKey],
      );

      assert.deepEqual(await loadCodexConversation(conversationKey, 10), []);
    });

    it("matches legacy rows that carry no conversation id once the scope is registered", async function () {
      await initClaudeCodeStore();
      const conversationKey = CLAUDE_GLOBAL_CONVERSATION_KEY_BASE + 13;
      await upsertClaudeConversationSummary({
        conversationKey,
        libraryID: 1,
        kind: "global",
      });
      harness.run(
        `INSERT INTO ${CLAUDE_MESSAGES_TABLE}
           (conversation_key, role, text, timestamp)
         VALUES (?, 'user', 'legacy row', 1)`,
        [conversationKey],
      );

      const loaded = await loadClaudeConversation(conversationKey, 10);
      assert.deepEqual(
        loaded.map((message) => message.text),
        ["legacy row"],
      );
    });
  });

  describe("transaction wrapper", function () {
    it("wraps every backend write path in a database transaction", async function () {
      await initCodexAppServerStore();
      const conversationKey = CODEX_GLOBAL_CONVERSATION_KEY_BASE + 14;
      await upsertCodexConversationSummary({
        conversationKey,
        libraryID: 1,
        kind: "global",
      });

      const beforeAppend = harness.transactions();
      await appendCodexMessage(conversationKey, richMessage());
      assert.isAbove(
        harness.transactions(),
        beforeAppend,
        "appending a message must open a transaction",
      );

      const beforeClear = harness.transactions();
      await clearCodexConversation(conversationKey);
      assert.isAbove(
        harness.transactions(),
        beforeClear,
        "clearing a conversation must open a transaction",
      );
    });

    it("wraps the upstream chat store's append in a transaction too", async function () {
      await initChatStore();
      const conversationKey = await createGlobalConversation(1);

      const before = harness.transactions();
      await appendMessage(conversationKey, richMessage());
      assert.isAbove(harness.transactions(), before);
      const [row] = harness.all(
        `SELECT COUNT(*) AS count FROM ${CHAT_MESSAGES_TABLE} WHERE conversation_key = ?`,
        [conversationKey],
      );
      assert.strictEqual(Number(row.count), 1);
    });
  });

  describe("registry repair sweep", function () {
    it("re-registers a Codex catalog row whose registry entry is missing", async function () {
      await initCodexAppServerStore();
      const conversationKey = CODEX_GLOBAL_CONVERSATION_KEY_BASE + 15;
      await upsertCodexConversationSummary({
        conversationKey,
        libraryID: 1,
        kind: "global",
      });
      harness.run(
        "DELETE FROM llm_for_zotero_conversation_registry WHERE legacy_conversation_key = ?",
        [conversationKey],
      );

      await repairCodexConversationIdentityRegistry();

      const [registered] = harness.all(
        `SELECT legacy_conversation_key AS conversationKey, system
         FROM llm_for_zotero_conversation_registry
         WHERE legacy_conversation_key = ?`,
        [conversationKey],
      );
      assert.ok(registered, "sweep must restore the registry row");
      assert.strictEqual(registered.system, "codex");
    });

    it("re-registers a Claude catalog row whose registry entry is missing", async function () {
      await initClaudeCodeStore();
      const conversationKey = CLAUDE_GLOBAL_CONVERSATION_KEY_BASE + 15;
      await upsertClaudeConversationSummary({
        conversationKey,
        libraryID: 1,
        kind: "global",
      });
      harness.run(
        "DELETE FROM llm_for_zotero_conversation_registry WHERE legacy_conversation_key = ?",
        [conversationKey],
      );

      await repairClaudeConversationIdentityRegistry();

      const [registered] = harness.all(
        `SELECT legacy_conversation_key AS conversationKey, system
         FROM llm_for_zotero_conversation_registry
         WHERE legacy_conversation_key = ?`,
        [conversationKey],
      );
      assert.ok(registered, "sweep must restore the registry row");
      assert.strictEqual(registered.system, "claude_code");
    });
  });

  describe("catalog summary cache", function () {
    it("refreshes the Codex catalog summary from the message rows on append", async function () {
      await initCodexAppServerStore();
      const conversationKey = CODEX_GLOBAL_CONVERSATION_KEY_BASE + 16;
      await upsertCodexConversationSummary({
        conversationKey,
        libraryID: 1,
        kind: "global",
      });

      await appendCodexMessage(conversationKey, {
        role: "user",
        text: "first question",
        timestamp: 10,
      });
      await appendCodexMessage(conversationKey, {
        role: "assistant",
        text: "answer",
        timestamp: 20,
      });
      await appendCodexMessage(conversationKey, {
        role: "user",
        text: "second question",
        timestamp: 30,
      });

      const summary = await getCodexConversationSummary(conversationKey);
      assert.strictEqual(summary?.userTurnCount, 2);
      assert.strictEqual(summary?.title, "first question");

      const [row] = harness.all(
        `SELECT first_user_title AS firstUserTitle,
                last_activity_at AS lastActivityAt
         FROM ${CODEX_CATALOG_TABLE}
         WHERE conversation_key = ?`,
        [conversationKey],
      );
      assert.strictEqual(row.firstUserTitle, "first question");
      assert.strictEqual(Number(row.lastActivityAt), 30);
    });

    it("refreshes the Claude catalog summary from the message rows on append", async function () {
      await initClaudeCodeStore();
      const conversationKey = CLAUDE_GLOBAL_CONVERSATION_KEY_BASE + 16;
      await upsertClaudeConversationSummary({
        conversationKey,
        libraryID: 1,
        kind: "global",
      });

      await appendClaudeMessage(conversationKey, {
        role: "user",
        text: "first question",
        timestamp: 10,
      });
      await appendClaudeMessage(conversationKey, {
        role: "user",
        text: "second question",
        timestamp: 30,
      });

      const summary = await getClaudeConversationSummary(conversationKey);
      assert.strictEqual(summary?.userTurnCount, 2);
      assert.strictEqual(summary?.title, "first question");

      const [row] = harness.all(
        `SELECT user_turn_count AS userTurnCount,
                last_activity_at AS lastActivityAt
         FROM ${CLAUDE_CATALOG_TABLE}
         WHERE conversation_key = ?`,
        [conversationKey],
      );
      assert.strictEqual(Number(row.userTurnCount), 2);
      assert.strictEqual(Number(row.lastActivityAt), 30);
    });

    it("drops the summary back to zero turns after the conversation is cleared", async function () {
      await initClaudeCodeStore();
      const conversationKey = CLAUDE_GLOBAL_CONVERSATION_KEY_BASE + 17;
      await upsertClaudeConversationSummary({
        conversationKey,
        libraryID: 1,
        kind: "global",
      });
      await appendClaudeMessage(conversationKey, {
        role: "user",
        text: "only question",
        timestamp: 10,
      });

      await clearClaudeConversation(conversationKey);

      const summary = await getClaudeConversationSummary(conversationKey);
      assert.strictEqual(summary?.userTurnCount, 0);
    });
  });
});
