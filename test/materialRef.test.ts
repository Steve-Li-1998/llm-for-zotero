import { assert } from "chai";
import {
  assertMaterialRefMatches,
  materialDocumentId,
  materialDocumentIdForWorkflow,
  materialRefFromDocument,
} from "../src/agent/documents/workflowMaterial";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

const document = {
  documentId: "document:summary",
  documentVersion: 3,
  contentHash: `sha256:${"b".repeat(64)}`,
};

describe("workflow MaterialRef", function () {
  it("binds identity to an exact document version and content hash", function () {
    const ref = materialRefFromDocument(document);
    assert.deepEqual(ref, document);
    assert.doesNotThrow(() => assertMaterialRefMatches(document, ref));
    assert.throws(
      () =>
        assertMaterialRefMatches(
          { ...document, documentVersion: document.documentVersion + 1 },
          ref,
        ),
      /version or content has changed/i,
    );
  });

  it("derives stable material IDs from a host workflow identity without semantic intent", function () {
    assert.equal(
      materialDocumentIdForWorkflow("execution:42", "summary"),
      "material:execution%3A42:summary",
    );
    const request = resolvedAgentRequest({
      conversationKey: 42,
      mode: "agent",
      userText: "Write a summary",
      libraryID: 1,
      executionContext: {
        version: 1,
        executionId: "execution:42",
      },
    });
    assert.equal(
      materialDocumentId(request, "summary"),
      "material:execution%3A42:summary",
    );
  });

  it("rejects workflow and output identifiers that are not durable", function () {
    assert.throws(
      () => materialDocumentIdForWorkflow(" ", "summary"),
      /workflow identity/i,
    );
    assert.throws(
      () => materialDocumentIdForWorkflow("execution:42", " "),
      /output identity/i,
    );
  });
});
