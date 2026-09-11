import { assert } from "chai";
import {
  buildAdapterToolCallResult,
  filterFollowupMessageForCapabilities,
} from "../src/agent/model/toolArtifactDelivery";

describe("Agent tool artifact delivery", function () {
  it("keeps supported content and explains omitted content without changing the role", function () {
    const result = filterFollowupMessageForCapabilities(
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect the prepared inputs." },
          { type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
          {
            type: "file_ref",
            file_ref: {
              name: "paper.pdf",
              mimeType: "application/pdf",
              storedPath: "/tmp/paper.pdf",
              contentHash: "hash",
            },
          },
        ],
      },
      {
        tools: true,
        contentInputs: {
          images: false,
          pdfDocuments: true,
          nativeFiles: false,
        },
      } as never,
      "Test model",
    );

    assert.equal(result?.role, "user");
    assert.isArray(result?.content);
    const parts = Array.isArray(result?.content) ? result.content : [];
    assert.deepEqual(
      parts.map((part) => part.type),
      ["text", "file_ref", "text"],
    );
    assert.match(
      parts[2]?.type === "text" ? parts[2].text : "",
      /1 image input.*Test model does not support image input/,
    );
  });

  it("converts one workflow outcome into the adapter tool-result contract", function () {
    const result = buildAdapterToolCallResult({
      toolResult: {
        callId: "call-1",
        name: "pdf_read",
        ok: true,
        content: { ignored: true },
      },
      delivery: {
        callId: "call-1",
        name: "pdf_read",
        content: { page: 3 },
        followupMessages: [
          { role: "user", content: "Use this page." },
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,AA" },
              },
            ],
          },
        ],
      },
    });

    assert.isTrue(result.success);
    assert.deepEqual(result.contentItems, [
      { type: "inputText", text: '{\n  "page": 3\n}' },
      { type: "inputText", text: "Use this page." },
      { type: "inputImage", imageUrl: "data:image/png;base64,AA" },
    ]);
  });
});
