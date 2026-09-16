import { safePostJson, SafeFetchError, SsrfBlockedError } from "@cma/security";
import { buildSystemPrompt, buildUserPrompt } from "../prompt.js";
import { buildDigestSystemPrompt, buildDigestUserPrompt } from "../digestPrompt.js";
import { AiProviderRequestError, AiProviderTimeoutError } from "../errors.js";
import { REQUEST_TIMEOUT_MS } from "../limits.js";
import { DIGEST_REQUEST_TIMEOUT_MS } from "../digestLimits.js";
import type { AiProvider, ChangeAnalysisInput, EvidenceBundleInput, NormalizedAiResponse } from "../types.js";

/**
 * Minimal Chat-Completions-shaped response - the de facto compatibility
 * surface most "OpenAI-compatible" third-party endpoints implement
 * (unlike the Responses API, which is OpenAI-proprietary). Kept private
 * to this file (Section 8/10: no vendor response object escapes the
 * provider layer).
 */
interface ChatCompletionsBody {
  id?: string;
  model?: string;
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string };
}

export interface OpenAiCompatibleProviderOptions {
  apiKey: string;
  model: string;
  /**
   * Customer/organization-supplied - Section 9/20: this is an
   * UNTRUSTED outbound destination, exactly like a monitored
   * competitor URL. Never fetched directly; always through
   * `safePostJson` (@cma/security), which re-validates the resolved
   * address against the same SSRF allowlist the monitoring pipeline
   * uses (localhost/private/link-local/cloud-metadata all blocked).
   */
  baseUrl: string;
  timeoutMs?: number;
}

/**
 * Section 9: a single adapter for the whole class of providers that
 * expose an OpenAI-compatible Chat Completions endpoint, rather than a
 * bespoke code path per vendor - onboarding a new one is a
 * configuration row (provider="openai-compatible", baseUrl, model,
 * apiKey), never a new class.
 */
export class OpenAiCompatibleProvider implements AiProvider {
  readonly name = "openai-compatible";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: OpenAiCompatibleProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async analyzeChange(input: ChangeAnalysisInput): Promise<NormalizedAiResponse> {
    return this.request(buildSystemPrompt(), buildUserPrompt(input), this.timeoutMs);
  }

  /** Phase 11: same request/parse/error-classification machinery as analyzeChange, only the system/user prompt differs. */
  async interpretDigest(input: EvidenceBundleInput): Promise<NormalizedAiResponse> {
    return this.request(buildDigestSystemPrompt(), buildDigestUserPrompt(input), DIGEST_REQUEST_TIMEOUT_MS);
  }

  private async request(systemPrompt: string, userPrompt: string, timeoutMs: number): Promise<NormalizedAiResponse> {
    const url = `${this.baseUrl}/chat/completions`;

    let result: Awaited<ReturnType<typeof safePostJson>>;
    try {
      result = await safePostJson(
        url,
        {
          model: this.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          // Not every OpenAI-compatible endpoint supports strict
          // json_schema mode (that is largely OpenAI-specific) - the
          // widely-supported `json_object` mode is used instead, with
          // the prompt itself (shared with every other provider)
          // carrying the exact shape requirement. The real enforcement
          // point is analyzeAndValidateChange.ts's / validateDigestInterpretation.ts's
          // zod validation downstream, regardless of what hint was sent here.
          response_format: { type: "json_object" },
        },
        {
          headers: { Authorization: `Bearer ${this.apiKey}` },
          timeoutMs,
        },
      );
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        // A configuration problem (an unsafe baseUrl), not a transient
        // network blip - never retry it.
        throw new AiProviderRequestError(this.name, `Refusing unsafe endpoint: ${err.message}`, false);
      }
      if (err instanceof SafeFetchError && /timed out/i.test(err.message)) {
        throw new AiProviderTimeoutError(this.name, timeoutMs);
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new AiProviderRequestError(this.name, message, true);
    }

    let body: ChatCompletionsBody;
    try {
      body = JSON.parse(result.body) as ChatCompletionsBody;
    } catch {
      throw new AiProviderRequestError(this.name, "response was not valid JSON", false);
    }

    if (result.status < 200 || result.status >= 300) {
      const retryable = result.status === 429 || result.status >= 500;
      throw new AiProviderRequestError(this.name, body.error?.message ?? `HTTP ${result.status}`, retryable);
    }

    const content = body.choices?.[0]?.message?.content;
    if (content === undefined) {
      throw new AiProviderRequestError(this.name, "response contained no choices[0].message.content", false);
    }

    return {
      content,
      inputTokens: body.usage?.prompt_tokens,
      outputTokens: body.usage?.completion_tokens,
      totalTokens: body.usage?.total_tokens,
      finishReason: body.choices?.[0]?.finish_reason,
      providerMetadata: { responseId: body.id, responseModel: body.model, baseUrl: this.baseUrl },
    };
  }
}
