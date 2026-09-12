import { assert } from "chai";
import { OPERATION_CATALOG } from "../src/agent/contracts/operationCatalog";
import type {
  AgentActionOperation,
  AgentActionProofDomain,
  AgentActionReceipt,
  AgentToolContext,
  AgentToolDefinition,
} from "../src/agent/types";
import { createBuiltInToolRegistry } from "../src/agent/tools";
import { createLibraryBatchTool } from "../src/agent/tools/write/libraryBatch";
import {
  initAgentChangeJournal,
  prepareJournalAction,
  prepareJournalStep,
} from "../src/agent/store/changeJournal";
import { ChangeJournalTestDb } from "./helpers/changeJournalTestDb";

/**
 * The executable audit of the effect path.
 *
 * Phase 3 asks six properties of every effect the Agent performs: a typed
 * proposal, a frozen operation and target digest, central authorization,
 * journalled execution, native post-state verification, and a scoped receipt
 * whose `verification` reflects that post-state. Five of them already run
 * through one shared pipeline; this file is what stops a new tool from
 * quietly joining the registry outside it.
 *
 * The table below is the audit, written as data: a tool that is registered as
 * an external effect but absent here fails, and a row here that no longer
 * matches the registry fails. Adding a tool therefore means deciding its
 * operations, its proof domain and its receipt verification on purpose.
 */

type Verification = AgentActionReceipt["verification"];

type AuditRow = {
  /** Every operation the tool's own adapter can describe. */
  operations: AgentActionOperation[];
  /**
   * The receipt verification a successful application of this tool produces
   * today. `verified` means a native re-read matched; `execution_only` means
   * the effect ran and no state can be re-read.
   */
  verification: Verification;
  /**
   * Set when `verification` is not yet proven from native state. These are the
   * rows Phase 3 tasks 3 to 5 move, and the note says what is missing.
   */
  verificationGap?: string;
  /** A representative input that actually performs the effect. */
  fixture: Record<string, unknown>;
  /**
   * The invocation-plan impact the fixture above produces. It must never be
   * `read_only`: the central policy treats a read-only plan with a known
   * assurance as a trusted read and executes it with no user authorization at
   * all, so a mutating call that planned read_only would be a tool granting
   * itself permission.
   */
  impact: "state_change" | "ambiguous" | "prohibited";
  /**
   * The read-mode input, for the tools that have one. A read-only plan is
   * executed by the central policy as a trusted read, with no user
   * authorization and without the assessor's typed-effect check. `proposes`
   * records what the tool still describes on that input, so a tool that starts
   * proposing an effect behind a read-only plan has to change this row.
   */
  readMode?: {
    fixture: Record<string, unknown>;
    reason: string;
    proposes: AgentActionOperation[];
  };
};

/** One reversible pending action the undo and revert fixtures target. */
const SEEDED_JOURNAL_ACTION = "audit-journal-action";
const AUDIT_CONVERSATION_KEY = 1;

const NOTE_BATCH_FIXTURE = {
  notes: [{ targetItemId: 1, content: "Audit body" }],
};

const AUDIT: Readonly<Record<string, AuditRow>> = {
  // ── Model-visible tools ───────────────────────────────────────────────────
  library_update: {
    operations: [
      "apply_tags",
      "remove_tags",
      "move_to_collection",
      "remove_from_collection",
      "update_metadata",
      "reparent_items",
      "relate_items",
      "update_library_tag",
      "set_item_tags",
    ],
    verification: "verified",
    fixture: { kind: "tags", action: "add", itemIds: [1], tags: ["audit"] },
    // A validated operation carrying no changes plans read_only, but it also
    // describes no proposal, so nothing is authorized either way.
    impact: "state_change",
  },
  collection_update: {
    operations: ["create_collection", "delete_collection", "update_collection"],
    verification: "verified",
    fixture: { action: "create", name: "Audit" },
    impact: "state_change",
  },
  note_write: {
    operations: ["note_create", "note_edit", "note_append"],
    verification: "verified",
    fixture: { mode: "create", targetItemId: 1, content: "Audit body" },
    impact: "state_change",
  },
  note_write_batch: {
    operations: ["save_notes_batch"],
    verification: "verified",
    fixture: NOTE_BATCH_FIXTURE,
    impact: "state_change",
  },
  saved_search_update: {
    operations: ["save_saved_search", "delete_saved_search"],
    verification: "verified",
    fixture: {
      action: "save",
      name: "Audit",
      conditions: [{ condition: "title", operator: "contains", value: "x" }],
    },
    impact: "state_change",
  },
  library_settings: {
    operations: ["settings_update"],
    verification: "verified",
    fixture: { action: "set", key: "recursiveCollections", value: true },
    // Setting a preference to the value it already holds plans read_only.
    impact: "state_change",
  },
  library_import: {
    operations: ["import_identifiers", "import_local_files", "create_items"],
    verification: "verified",
    fixture: { kind: "identifiers", identifiers: ["10.1000/audit"] },
    impact: "state_change",
  },
  library_delete: {
    operations: ["trash_items", "merge_items", "restore_from_trash"],
    verification: "verified",
    fixture: { mode: "trash", itemIds: [1] },
    impact: "state_change",
  },
  attachment_update: {
    operations: ["delete_attachment", "rename_attachment", "relink_attachment"],
    verification: "verified",
    fixture: { action: "rename", attachmentId: 1, newName: "Audit.pdf" },
    impact: "state_change",
  },
  undo_last_action: {
    operations: ["undo"],
    verification: "verified",
    verificationGap:
      "Read from the tool's own result.status, not from the per-step native re-read changeReverter already performs (Phase 3 task 3).",
    fixture: { actionId: SEEDED_JOURNAL_ACTION },
    // With an empty journal there is nothing to undo: the plan is read_only
    // and the execution is a no-op.
    impact: "state_change",
  },
  revert_changes: {
    operations: ["revert"],
    verification: "verified",
    verificationGap:
      "Read from result.reverted counters, not from the per-step native re-read (Phase 3 task 3).",
    fixture: { count: 1 },
    // A dry run, or an empty journal, plans read_only and applies no inverse.
    impact: "state_change",
  },
  annotate_pdf: {
    operations: ["annotation_write"],
    verification: "verified",
    fixture: {
      attachmentId: 1,
      pageIndex: 0,
      pageHeightPoints: 792,
      rects: [[10, 20, 120, 34]],
      text: "Audit",
    },
    impact: "state_change",
  },
  file_io: {
    operations: ["file_write"],
    verification: "verified",
    fixture: { action: "write", path: "/tmp/audit.txt", content: "audit" },
    impact: "state_change",
    readMode: {
      fixture: { action: "read", path: "/tmp/audit.txt" },
      reason: "Reading a file proposes no write.",
      proposes: [],
    },
  },
  run_command: {
    operations: ["command_execute"],
    verification: "execution_only",
    verificationGap:
      "A shell command has no re-readable state. Phase 3 task 3 keeps it execution_only by ruling and makes it visible instead.",
    fixture: { command: "rm -rf /tmp/audit-target" },
    impact: "state_change",
    readMode: {
      fixture: { command: "ls /tmp" },
      reason: "A statically recognized read-only command.",
      // By design the shell call still runs, and still mints an
      // execution_only receipt, so it keeps describing its command.
      proposes: ["command_execute"],
    },
  },
  zotero_script: {
    operations: ["zotero_script_execute"],
    verification: "execution_only",
    verificationGap:
      "The journal step already stores an expectedPostcondition the receipt ignores (Phase 3 task 3).",
    fixture: {
      access: "library",
      effect: "write",
      script:
        "for (const item of items) { env.snapshot(item); item.setField('extra', 'audited'); }",
      description: "Stamp an audit marker on the selected items.",
    },
    impact: "state_change",
    readMode: {
      fixture: {
        access: "library",
        effect: "read",
        script: "return items.length;",
        description: "Count the selected items.",
      },
      reason: "A library-scope script declared as a read.",
      proposes: [],
    },
  },

  // ── Internal legacy primitives ────────────────────────────────────────────
  // Registered so prepared slash actions and migration delegates can still
  // invoke them directly. They are the same definitions the facades above
  // delegate to, so they carry the same six properties.
  apply_tags: {
    operations: ["apply_tags", "remove_tags"],
    verification: "verified",
    fixture: { action: "add", itemIds: [1], tags: ["audit"] },
    impact: "state_change",
  },
  move_to_collection: {
    operations: ["move_to_collection", "remove_from_collection"],
    verification: "verified",
    fixture: { itemIds: [1], targetCollectionId: 2 },
    impact: "state_change",
  },
  update_metadata: {
    operations: ["update_metadata"],
    verification: "verified",
    fixture: { itemId: 1, metadata: { title: "Audit" } },
    impact: "state_change",
  },
  reparent_items: {
    operations: ["reparent_items"],
    verification: "verified",
    fixture: { assignments: [{ itemId: 1, parentItemId: 2 }] },
    impact: "state_change",
  },
  relate_items: {
    operations: ["relate_items"],
    verification: "verified",
    fixture: { itemId: 1, relatedItemIds: [2] },
    impact: "state_change",
  },
  create_items: {
    operations: ["create_items"],
    verification: "verified",
    fixture: {
      items: [{ itemType: "journalArticle", title: "Audit" }],
    },
    impact: "state_change",
  },
  tag_update: {
    operations: ["update_library_tag"],
    verification: "verified",
    fixture: { action: "rename", tag: "audit", newTag: "audited" },
    impact: "state_change",
  },
  set_item_tags: {
    operations: ["set_item_tags"],
    verification: "verified",
    fixture: { assignments: [{ itemId: 1, tags: ["audit"] }] },
    impact: "state_change",
  },
  manage_collections: {
    operations: ["create_collection", "delete_collection", "update_collection"],
    verification: "verified",
    fixture: { action: "create", name: "Audit" },
    impact: "state_change",
  },
  edit_current_note: {
    operations: ["note_create", "note_edit", "note_append"],
    verification: "verified",
    fixture: { mode: "create", targetItemId: 1, content: "Audit body" },
    impact: "state_change",
  },
  write_notes_batch: {
    operations: ["save_notes_batch"],
    verification: "verified",
    fixture: NOTE_BATCH_FIXTURE,
    impact: "state_change",
  },
  trash_items: {
    operations: ["trash_items"],
    verification: "verified",
    fixture: { itemIds: [1] },
    impact: "state_change",
  },
  restore_from_trash: {
    operations: ["restore_from_trash"],
    verification: "verified",
    fixture: { itemIds: [1] },
    impact: "state_change",
  },
  merge_items: {
    operations: ["merge_items"],
    verification: "verified",
    fixture: { masterItemId: 1, otherItemIds: [2] },
    impact: "state_change",
  },
  manage_attachments: {
    operations: ["delete_attachment", "rename_attachment", "relink_attachment"],
    verification: "verified",
    fixture: { action: "rename", attachmentId: 1, newName: "Audit.pdf" },
    impact: "state_change",
  },
  import_identifiers: {
    operations: ["import_identifiers"],
    verification: "verified",
    fixture: { identifiers: ["10.1000/audit"] },
    impact: "state_change",
  },
  import_local_files: {
    operations: ["import_local_files"],
    verification: "verified",
    fixture: { filePaths: ["/tmp/audit.pdf"] },
    impact: "state_change",
  },
};

/**
 * Class-level exemptions. A control tool owns no effect of its own: every call
 * it makes re-enters the registry as its own authorized invocation, so its
 * receipts are the children's. Listed by class, never by name.
 */
const CONTROL_TOOLS_WITHOUT_EFFECTS = ["library_batch", "workflow_script"];

/**
 * The inert host seams the audit's plan and adapter calls reach. Nothing here
 * returns live state: the audit asks what a tool *declares* about an effect,
 * never what the effect would do.
 */
function auditGateway() {
  return {
    getItem: () => null,
    getCollectionSummary: () => null,
    listCollectionSummaries: () => [],
    listSettings: () => [],
    getSettingNativeState: () => null,
    resolveMetadataItem: () => null,
    getEditableArticleMetadata: () => null,
    resolveRegularItem: () => null,
    resolveLibraryID: () => 1,
    listCollectionItemTargets: async () => ({ items: [] }),
    listCollectionPaperTargets: async () => ({ papers: [] }),
    getCollectionNativeState: () => null,
    listLibraryTags: () => [],
    getSavedSearch: () => null,
    listSavedSearches: () => [],
  } as never;
}

function auditRegistry() {
  const registry = createBuiltInToolRegistry({
    zoteroGateway: auditGateway(),
    pdfService: {} as never,
    pdfPageService: {} as never,
    retrievalService: {} as never,
  });
  // library_batch is registered by the composition root rather than the
  // factory, because it needs both registries. The audit must still see it.
  registry.register(
    createLibraryBatchTool({
      actionRegistry: {} as never,
      toolRegistry: registry,
      zoteroGateway: auditGateway(),
    }),
  );
  return registry;
}

function auditContext(): AgentToolContext {
  return {
    request: {
      conversationKey: 1,
      mode: "agent",
      userText: "audit",
    },
    item: null,
    currentAnswerText: "",
    modelName: "audit-model",
    runId: "audit-run",
  } as never;
}

function validatedFixture(
  tool: AgentToolDefinition<any, any>,
  row: AuditRow,
): unknown {
  const validated = tool.validate(row.fixture);
  assert.isTrue(
    validated.ok,
    `${tool.spec.name} fixture is not a valid input: ${
      validated.ok ? "" : validated.error
    }`,
  );
  if (!validated.ok) throw new Error(validated.error);
  return validated.value;
}

describe("effect path audit", function () {
  const originalZotero = globalThis.Zotero;
  const registry = auditRegistry();

  before(async function () {
    // undo_last_action and revert_changes plan from the durable journal, so
    // the audit seeds one reversible action: without it they correctly report
    // a read-only no-op and the mutating path would never be exercised.
    globalThis.Zotero = {
      DB: new ChangeJournalTestDb(),
      Prefs: { get: () => "auto" },
      debug: () => undefined,
    } as never;
    await initAgentChangeJournal();
    await prepareJournalAction({
      actionId: SEEDED_JOURNAL_ACTION,
      runId: "audit-run",
      conversationKey: AUDIT_CONVERSATION_KEY,
      toolName: "library_settings",
      description: "Audit fixture mutation",
      effect: "write",
      reversibility: "full",
    });
    await prepareJournalStep({
      actionId: SEEDED_JOURNAL_ACTION,
      sequence: 1,
      operation: "update_preference",
      forward: { key: "audit.setting", value: "after" },
      inverse: {
        version: 1,
        kind: "preference",
        key: "audit.setting",
        existed: true,
        value: "before",
      },
    });
  });

  after(function () {
    globalThis.Zotero = originalZotero;
  });

  const effects = registry
    .listToolDefinitions()
    .filter((tool) => tool.spec.executionClass === "external_effect");

  it("audits exactly the external effects the registry holds", function () {
    assert.deepEqual(
      effects.map((tool) => tool.spec.name).sort(),
      Object.keys(AUDIT).sort(),
      "every external-effect tool needs an audited row, and every row a tool",
    );
  });

  it("exempts control tools by class, not by name", function () {
    const controls = registry
      .listToolDefinitions()
      .filter((tool) => tool.spec.executionClass === "control")
      .map((tool) => tool.spec.name);
    for (const name of CONTROL_TOOLS_WITHOUT_EFFECTS) {
      assert.include(controls, name, `${name} must stay control class`);
      const tool = registry.getTool(name)!;
      assert.isUndefined(
        tool.effectOperations,
        `${name} performs no effect of its own`,
      );
    }
  });

  it("gives every external effect a typed action adapter", function () {
    const missing = effects
      .filter((tool) => !tool.describeAction)
      .map((tool) => tool.spec.name);
    assert.deepEqual(missing, []);
  });

  it("declares exactly the audited operations, each with a proof domain", function () {
    const declared: Record<string, AgentActionOperation[]> = {};
    const expected: Record<string, AgentActionOperation[]> = {};
    for (const tool of effects) {
      declared[tool.spec.name] = [...(tool.effectOperations || [])].sort();
      expected[tool.spec.name] = [...AUDIT[tool.spec.name].operations].sort();
      for (const operation of tool.effectOperations || []) {
        assert.property(
          OPERATION_CATALOG,
          operation,
          `${tool.spec.name} declares an uncatalogued operation`,
        );
      }
    }
    assert.deepEqual(declared, expected);
  });

  it("keeps one proof domain per operation, owned by the catalog", function () {
    const domains: Record<string, AgentActionProofDomain[]> = {};
    for (const [name, row] of Object.entries(AUDIT)) {
      domains[name] = [
        ...new Set(
          row.operations.map(
            (operation) => OPERATION_CATALOG[operation].proofDomain,
          ),
        ),
      ].sort();
    }
    assert.deepEqual(domains, {
      ...Object.fromEntries(
        Object.keys(AUDIT).map((name) => [name, ["zotero_state"]]),
      ),
      file_io: ["file_state"],
      run_command: ["execution"],
      zotero_script: ["execution"],
    });
  });

  it("records the receipt verification each proof domain produces today", function () {
    const byDomain: Record<string, Set<Verification>> = {};
    for (const row of Object.values(AUDIT)) {
      for (const operation of row.operations) {
        const domain = OPERATION_CATALOG[operation].proofDomain;
        (byDomain[domain] ||= new Set()).add(row.verification);
      }
    }
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(byDomain).map(([domain, values]) => [
          domain,
          [...values].sort(),
        ]),
      ),
      {
        zotero_state: ["verified"],
        file_state: ["verified"],
        execution: ["execution_only"],
      },
      "a domain that starts producing a second verification value is a decision, not an accident",
    );
  });

  it("describes only audited operations from a representative input", async function () {
    for (const tool of effects) {
      const row = AUDIT[tool.spec.name];
      const described =
        (await tool.describeAction!(
          validatedFixture(tool, row) as never,
          auditContext(),
        )) || [];
      assert.isNotEmpty(
        described,
        `${tool.spec.name} described no proposal for a mutating input`,
      );
      for (const proposal of described) {
        assert.include(
          row.operations,
          proposal.operation,
          `${tool.spec.name} described an operation it never declared`,
        );
        const entry = OPERATION_CATALOG[proposal.operation];
        assert.equal(
          proposal.capability,
          entry.capability,
          `${tool.spec.name} disagrees with the catalog's capability`,
        );
        assert.equal(
          proposal.proofDomain,
          entry.proofDomain,
          `${tool.spec.name} disagrees with the catalog's proof domain`,
        );
      }
    }
  });

  it("pins what each tool proposes on the inputs it plans as read-only", async function () {
    const covered: string[] = [];
    for (const tool of effects) {
      const row = AUDIT[tool.spec.name];
      if (!row.readMode) continue;
      covered.push(tool.spec.name);
      const validated = tool.validate(row.readMode.fixture);
      assert.isTrue(
        validated.ok,
        `${tool.spec.name} read-mode fixture is invalid: ${
          validated.ok ? "" : validated.error
        }`,
      );
      if (!validated.ok) continue;
      const plan = await tool.planInvocation!(
        validated.value as never,
        auditContext(),
      );
      assert.equal(
        plan.impact,
        "read_only",
        `${tool.spec.name}: ${row.readMode.reason}`,
      );
      const described =
        (await tool.describeAction!(
          validated.value as never,
          auditContext(),
        )) || [];
      assert.deepEqual(
        described.map((proposal) => proposal.operation),
        row.readMode.proposes,
        `${tool.spec.name} changed what it proposes behind a read-only plan`,
      );
    }
    assert.deepEqual(covered.sort(), [
      "file_io",
      "run_command",
      "zotero_script",
    ]);
  });

  it("never plans a mutating call as a trusted read", async function () {
    const impacts: Record<string, string> = {};
    for (const tool of effects) {
      const row = AUDIT[tool.spec.name];
      const plan = await tool.planInvocation!(
        validatedFixture(tool, row) as never,
        auditContext(),
      );
      assert.notEqual(
        plan.impact,
        "read_only",
        `${tool.spec.name} planned a mutating input as read_only, which the central policy executes as a trusted read`,
      );
      impacts[tool.spec.name] = plan.impact;
    }
    assert.deepEqual(
      impacts,
      Object.fromEntries(
        Object.entries(AUDIT).map(([name, row]) => [name, row.impact]),
      ),
    );
  });
});
