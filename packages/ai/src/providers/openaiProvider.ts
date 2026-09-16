import { buildSystemPrompt, buildUserPrompt } from "../prompt.js";
import { buildDigestSystemPrompt, buildDigestUserPrompt } from "../digestPrompt.js";
import { aiAnalysisOutputJsonSchema } from "../schema.js";
import { aiInterpretationOutputJsonSchema } from "../digestSchema.js";
import { AiProviderRequestError, AiProviderTimeoutError } from "../errors.js";
import { REQUEST_TIMEOUT_MS } from "../limits.js";
import { DIGEST_REQUEST_TIMEOUT_MS } from "../digestLimits.js";
import type { AiProvider, ChangeAnalysisInput, EvidenceBundleInput, NormalizedAiResponse } from "../types.js";

const OPENAI_API_URL = "https://api.openai.com/v1/responses";

export interface OpenAiProviderOptions {
  apiKey: string;
  /** Section 15: model comes from configuration, never hard-coded in call sites. */
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Minimal shape of the Responses API's success body this provider
 * actually reads (Section 8/10: "do not assume the response structure",
 * "no OpenAI-specific response objects should escape the provider
 * layer" - this type is intentionally private to this file). The
 * Responses API's `output` array can contain non-message items (e.g. a
 * "reasoning" item for reasoning-capable models) before the actual
 * "message" item - every field below is read defensively rather than
 * assumed to be at a fixed index.
 */
interface OpenAiResponseBody {
  id?: string;
  model?: string;
  output?: {
    type: string;
    status?: string;
    content?: { type: string; text?: string }[];
  }[];
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  error?: { message?: string; type?: string; code?: string };
}

function extractOutputText(body: OpenAiResponseBody): { text: string | undefined; finishReason: string | undefined } {
  for (const item of body.output ?? []) {
    if (item.type !== "message") continue;
    const textBlock = item.content?.find((block) => block.type === "output_text");
    if (textBlock?.text !== undefined) return { text: textBlock.text, finishReason: item.status };
  }
  return { text: undefined, finishReason: undefined };
}

/**
 * The first production `AiProvider` (Section 8). Plain `fetch` against
 * the Responses API - no SDK dependency added, same rationale as the
 * rest of @cma/ai: timeout/retry-classification stays explicit and
 * unit-testable rather than hidden inside a client library. Uses the
 * Responses API's native structured-output support
 * (`text.format: { type: "json_schema" }`) to bias the model toward
 * schema-shaped JSON, but that is only a request-time hint - this
 * provider does NOT itself validate the output against that schema
 * (see analyzeAndValidateChange.ts): it only normalizes whatever text
 * came back into `NormalizedAiResponse.content` and lets the shared
 * validation step decide whether to trust it (Section 4).
 *
 * Makes exactly one HTTP attempt per call; the one retry Section 6/12
 * allows is the caller's responsibility (see analyzeChangeWithRetry.ts),
 * applied uniformly across every provider rather than duplicated here.
 */
export class OpenAiProvider implements AiProvider {
  readonly name = "openai";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async analyzeChange(input: ChangeAnalysisInput): Promise<NormalizedAiResponse> {
    return this.request(buildSystemPrompt(), buildUserPrompt(input), "ai_analysis_output", aiAnalysisOutputJsonSchema, this.timeoutMs);
  }

  /** Phase 11: same request/parse/error-classification machinery as analyzeChange, only the system/user prompt and structured-output schema differ. */
  async interpretDigest(input: EvidenceBundleInput): Promise<NormalizedAiResponse> {
    return this.request(
      buildDigestSystemPrompt(),
      buildDigestUserPrompt(input),
      "ai_interpretation_output",
      aiInterpretationOutputJsonSchema,
      DIGEST_REQUEST_TIMEOUT_MS,
    );
  }

  private async request(
    systemPrompt: string,
    userPrompt: string,
    schemaName: string,
    jsonSchema: object,
    timeoutMs: number,
  ): Promise<NormalizedAiResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(OPENAI_API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Never logged, never persisted, never returned to a caller -
          // this header is the only place the key is used (Section 25).
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          text: {
            format: {
              type: "json_schema",
              name: schemaName,
              schema: jsonSchema,
              strict: true,
            },
          },
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new AiProviderTimeoutError(this.name, timeoutMs);
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new AiProviderRequestError(this.name, message, true);
    } finally {
      clearTimeout(timer);
    }

    const body = (await response.json().catch(() => ({}))) as OpenAiResponseBody;

    if (!response.ok) {
      // 429 (rate limit) and 5xx are transient. 401/403 (invalid or
      // missing API key) and 400 (bad request - e.g. an unknown model
      // configured via CMA_AI_MODEL/AiConnection.model) are permanent
      // configuration problems - Section 12: "Do NOT retry permanent
      // authentication/configuration failures."
      const retryable = response.status === 429 || response.status >= 500;
      const message = body.error?.message ?? `HTTP ${response.status}`;
      throw new AiProviderRequestError(this.name, message, retryable);
    }

    const { text, finishReason } = extractOutputText(body);
    if (text === undefined) {
      throw new AiProviderRequestError(this.name, "response contained no output_text content block", false);
    }

    return {
      content: text,
      inputTokens: body.usage?.input_tokens,
      outputTokens: body.usage?.output_tokens,
      totalTokens: body.usage?.total_tokens,
      finishReason,
      // Small, non-secret diagnostic fields only (Section 12/25) -
      // never the prompt, never page content, never a credential.
      providerMetadata: { responseId: body.id, responseModel: body.model },
    };
  }
}
