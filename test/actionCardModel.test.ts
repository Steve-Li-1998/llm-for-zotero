import { assert } from "chai";
import type { AgentRunEventRecord } from "../src/agent/types";
import type { AgentActionReceipt } from "../src/agent/contracts/types";
import {
  buildAgentActionSummaryCard,
  noteEffectNoteId,
  type ActionCardResolvers,
} from "../src/modules/contextPanel/agentTrace/actionCardModel";

function receipt(
  overrides: Partial<AgentActionReceipt> & {
    id: string;
    operation: AgentActionReceipt["operation"];
  },
): AgentActionReceipt {
  return {
    version: 2,
    proposalId: overrides.id,
    proofDomain: "zotero_state",
    capability: "zotero.collections",
    verification: "verified",
    status: "applied",
    requestedTargets: ["item:11"],
    appliedTargets: ["item:11"],
    alreadySatisfiedTargets: [],
    rejectedTargets: [],
    reasons: [],
    verifiedFacts: [],
    ...overrides,
  } as AgentActionReceipt;
}

function toolResult(
  seq: number,
  receipts: AgentActionReceipt[],
): AgentRunEventRecord {
  return {
    id: `e${seq}`,
    sequence: seq,
    timestamp: seq,
    payload: {
      type: "tool_result",
      callId: `c${seq}`,
      name: "library_update",
      ok: true,
      actionReceipts: receipts,
      content: {},
    },
  } as unknown as AgentRunEventRecord;
}

const resolvers: ActionCardResolvers = {
  itemLabel: (id) => ({
    label: id === 11 ? "Smith, 2021" : id === 12 ? "Lee, 2020" : `Item ${id}`,
    libraryID: 1,
    itemKey: `K${id}`,
  }),
  collectionLabel: (id) =>
    id === 7 ? { label: "Reviews", libraryID: 1 } : undefined,
  noteLabel: (id) =>
    id === 99 ? { label: "Summary", libraryID: 1, itemKey: "N99" } : undefined,
  materialTitle: () => undefined,
};

describe("action card model", function () {
  it("projects a move into target, verb, collection object and verdict", function () {
    const card = buildAgentActionSummaryCard(
      [
        toolResult(1, [
          receipt({
            id: "r1",
            operation: "move_to_collection",
            normalizedParameters: { destinationCollectionId: 7 },
          }),
        ]),
      ],
      resolvers,
    );
    assert.equal(card?.actionCount, 1);
    assert.lengthOf(card!.entries, 1);
    const entry = card!.entries[0];
    assert.deepEqual(entry.targets, [
      {
        kind: "item",
        itemId: 11,
        label: "Smith, 2021",
        libraryID: 1,
        itemKey: "K11",
      },
    ]);
    assert.equal(entry.effects[0].verb.glyph, "→");
    assert.equal(entry.effects[0].label, "Moved to collection");
    assert.deepEqual(entry.effects[0].objects, [
      { kind: "collection", label: "Reviews", collectionId: 7, libraryID: 1 },
    ]);
    assert.equal(entry.verification, "verified");
    assert.deepEqual(entry.badges, ["Verified"]);
  });

  it("groups receipts that share a target set into one row, in receipt order", function () {
    const card = buildAgentActionSummaryCard(
      [
        toolResult(1, [
          receipt({
            id: "n",
            operation: "note_create",
            capability: "zotero.notes",
            verifiedFacts: ["native_note:99:text_match"],
          }),
        ]),
        toolResult(2, [
          receipt({
            id: "m",
            operation: "move_to_collection",
            normalizedParameters: { collectionName: "Reviews" },
          }),
        ]),
      ],
      resolvers,
    );
    assert.equal(card?.actionCount, 2);
    assert.lengthOf(card!.entries, 1);
    assert.deepEqual(
      card!.entries[0].effects.map((e) => e.operation),
      ["note_create", "move_to_collection"],
    );
    assert.deepEqual(card!.entries[0].effects[0].objects, [
      {
        kind: "note",
        label: "Summary",
        noteId: 99,
        libraryID: 1,
        itemKey: "N99",
      },
    ]);
    assert.deepEqual(card!.entries[0].effects[1].objects, [
      { kind: "collection", label: "Reviews" },
    ]);
  });

  it("keeps one receipt with many targets as one row", function () {
    const card = buildAgentActionSummaryCard(
      [
        toolResult(1, [
          receipt({
            id: "m",
            operation: "move_to_collection",
            requestedTargets: ["item:11", "item:12", "item:13"],
            appliedTargets: ["item:11", "item:12", "item:13"],
            normalizedParameters: { collectionName: "Reviews" },
          }),
        ]),
      ],
      resolvers,
    );
    assert.deepEqual(
      card!.entries[0].targets.map((t) => t.label),
      ["Smith, 2021", "Lee, 2020", "Item 13"],
    );
  });

  it("lists rejected targets with the receipt's first reason", function () {
    const card = buildAgentActionSummaryCard(
      [
        toolResult(1, [
          receipt({
            id: "m",
            operation: "move_to_collection",
            status: "partial",
            requestedTargets: ["item:11", "item:12"],
            appliedTargets: ["item:11"],
            rejectedTargets: ["item:12"],
            reasons: ["already in Reviews"],
            normalizedParameters: { collectionName: "Reviews" },
          }),
        ]),
      ],
      resolvers,
    );
    assert.deepEqual(
      card!.entries[0].targets.map((t) => t.label),
      ["Smith, 2021"],
    );
    assert.deepEqual(
      card!.entries[0].rejected.map((t) => t.label),
      ["Lee, 2020"],
    );
    assert.equal(card!.entries[0].rejectedReason, "already in Reviews");
  });

  it("projects tags, removed tags, files, commands, fields and trash", function () {
    const card = buildAgentActionSummaryCard(
      [
        toolResult(1, [
          receipt({
            id: "t",
            operation: "apply_tags",
            capability: "zotero.tags",
            normalizedParameters: { tags: ["to-read", "osc"] },
          }),
        ]),
        toolResult(2, [
          receipt({
            id: "u",
            operation: "remove_tags",
            capability: "zotero.tags",
            requestedTargets: ["item:12"],
            appliedTargets: ["item:12"],
            normalizedParameters: { tags: ["triage"] },
          }),
        ]),
        toolResult(3, [
          receipt({
            id: "f",
            operation: "file_write",
            capability: "file.write",
            proofDomain: "file_state",
            requestedTargets: [],
            appliedTargets: [],
            normalizedParameters: { newPath: "notes/smith-2021.md" },
          }),
        ]),
        toolResult(4, [
          receipt({
            id: "c",
            operation: "command_execute",
            capability: "command.execute",
            proofDomain: "execution",
            verification: "execution_only",
            requestedTargets: [],
            appliedTargets: [],
            normalizedParameters: { expectedText: "pandoc a.md -o a.docx" },
          }),
        ]),
        // `status: "unverified"` is not a reported effect (`receiptReportsEffect`),
        // so it would never reach the card; the unverified *proof* is the point here.
        toolResult(5, [
          receipt({
            id: "d",
            operation: "update_metadata",
            capability: "zotero.metadata",
            verification: "unverified",
            normalizedParameters: { metadataFields: ["DOI"] },
          }),
        ]),
        toolResult(6, [
          receipt({
            id: "x",
            operation: "trash_items",
            capability: "zotero.trash",
            requestedTargets: ["item:13"],
            appliedTargets: ["item:13"],
            executionAuthority: "external_runtime",
          }),
        ]),
      ],
      resolvers,
    );
    const byOp = Object.fromEntries(
      card!.entries.flatMap((e) =>
        e.effects.map((f) => [f.operation, { e, f }]),
      ),
    );
    assert.deepEqual(byOp.apply_tags.f.objects, [
      { kind: "tag", label: "to-read" },
      { kind: "tag", label: "osc" },
    ]);
    assert.deepEqual(byOp.remove_tags.f.objects, [
      { kind: "tag", label: "triage", removed: true },
    ]);
    assert.deepEqual(byOp.file_write.f.objects, [
      {
        kind: "file",
        label: "notes/smith-2021.md",
        path: "notes/smith-2021.md",
      },
    ]);
    assert.deepEqual(byOp.command_execute.f.objects, [
      { kind: "command", label: "pandoc a.md -o a.docx" },
    ]);
    assert.deepEqual(byOp.command_execute.e.badges, ["Ran (no state proof)"]);
    assert.deepEqual(byOp.update_metadata.f.objects, [
      { kind: "field", label: "DOI" },
    ]);
    assert.deepEqual(byOp.trash_items.f.objects, [{ kind: "trash" }]);
    assert.equal(byOp.trash_items.e.authority, "external_runtime");
    assert.deepEqual(byOp.trash_items.e.badges, [
      "Verified",
      "Authorized by connected client",
    ]);
  });

  it("shows nothing for a read-only or failed-only run and dedupes receipts by id", function () {
    assert.isNull(
      buildAgentActionSummaryCard(
        [
          toolResult(1, [
            receipt({
              id: "r",
              operation: "read_full",
              capability: "zotero.read",
            }),
          ]),
        ],
        resolvers,
      ),
    );
    const dup = receipt({
      id: "same",
      operation: "apply_tags",
      capability: "zotero.tags",
      normalizedParameters: { tags: ["a"] },
    });
    assert.equal(
      buildAgentActionSummaryCard(
        [toolResult(1, [dup]), toolResult(2, [dup])],
        resolvers,
      )?.actionCount,
      1,
    );
  });

  it("reads the note id from verified facts, then from parameters", function () {
    assert.equal(
      noteEffectNoteId(
        receipt({
          id: "a",
          operation: "note_edit",
          verifiedFacts: ["native_note:42:html_sha256:abc"],
        }),
      ),
      42,
    );
    assert.equal(
      noteEffectNoteId(
        receipt({
          id: "b",
          operation: "note_edit",
          normalizedParameters: { targetNoteId: 43 },
        }),
      ),
      43,
    );
    assert.isUndefined(
      noteEffectNoteId(receipt({ id: "c", operation: "apply_tags" })),
    );
  });
});
