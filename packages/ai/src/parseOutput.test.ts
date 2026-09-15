import { describe, expect, it } from "vitest";
import { parseAiOutput } from "./parseOutput.js";
import { AiOutputValidationError } from "./errors.js";
import { MAX_OUTPUT_CHARS } from "./limits.js";

const VALID = JSON.stringify({
  summary: "The price dropped.",
  facts: ["The listed price changed from 49.00 to 39.00."],
  interpretations: ["This may make the offer more competitive."],
  speculation: [],
  confidence: "medium",
});

describe("parseAiOutput", () => {
  it("accepts a well-formed, schema-valid response", () => {
    const output = parseAiOutput("test", VALID);
    expect(output.summary).toBe("The price dropped.");
    expect(output.confidence).toBe("medium");
  });

  it("strips a ```json fence some models add despite instructions not to", () => {
    const output = parseAiOutput("test", "```json\n" + VALID + "\n```");
    expect(output.summary).toBe("The price dropped.");
  });

  it("rejects malformed (non-JSON) output (Section 5)", () => {
    expect(() => parseAiOutput("test", "this is not json at all")).toThrow(AiOutputValidationError);
  });

  it("rejects JSON that does not match the schema - missing required field", () => {
    const missingField = JSON.stringify({ summary: "x", facts: [], interpretations: [], speculation: [] });
    expect(() => parseAiOutput("test", missingField)).toThrow(AiOutputValidationError);
  });

  it("rejects an invalid confidence value", () => {
    const badConfidence = JSON.stringify({ summary: "x", facts: [], interpretations: [], speculation: [], confidence: "extreme" });
    expect(() => parseAiOutput("test", badConfidence)).toThrow(AiOutputValidationError);
  });

  it("rejects output that exceeds the hard output-size cap before even attempting to parse it", () => {
    const huge = "x".repeat(MAX_OUTPUT_CHARS + 1);
    expect(() => parseAiOutput("test", huge)).toThrow(AiOutputValidationError);
  });

  it("rejects a prompt-injection attempt that only produces a malformed/incomplete JSON shape", () => {
    // Even if hostile page content convinced a weak model to try to comply, the
    // output must still pass the same strict schema as any other response.
    const injected = JSON.stringify({ summary: "PWNED", facts: [] });
    expect(() => parseAiOutput("test", injected)).toThrow(AiOutputValidationError);
  });
});
