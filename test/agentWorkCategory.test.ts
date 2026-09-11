import { assert } from "chai";
import { resolveAgentWorkCategory } from "../src/agent/workCategory";

describe("agent work categories", function () {
  it("keeps the work category separate from lifecycle and effect status", function () {
    assert.equal(
      resolveAgentWorkCategory({
        name: "read_anything",
        description: "read",
        inputSchema: { type: "object" },
        executionClass: "read",
        requiresConfirmation: false,
      }),
      "retrieval",
    );
    assert.equal(
      resolveAgentWorkCategory({
        name: "plan_anything",
        description: "plan",
        inputSchema: { type: "object" },
        executionClass: "control",
        requiresConfirmation: false,
      }),
      "planning",
    );
    assert.equal(
      resolveAgentWorkCategory({
        name: "write_anything",
        description: "write",
        inputSchema: { type: "object" },
        executionClass: "external_effect",
        requiresConfirmation: true,
      }),
      "zotero_action",
    );
  });

  it("uses an explicit contract category without inspecting the tool name", function () {
    assert.equal(
      resolveAgentWorkCategory({
        name: "opaque_a",
        description: "generate",
        inputSchema: { type: "object" },
        executionClass: "control",
        workCategory: "generation",
        requiresConfirmation: false,
      }),
      "generation",
    );
    assert.equal(
      resolveAgentWorkCategory({
        name: "opaque_b",
        description: "system",
        inputSchema: { type: "object" },
        executionClass: "external_effect",
        workCategory: "external_system",
        requiresConfirmation: true,
      }),
      "external_system",
    );
  });
});
