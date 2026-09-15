import { buildSystemPrompt, buildUserPrompt } from "../prompt.js";
import { parseAiOutput } from "../parseOutput.js";
import { AiProviderRequestError, AiProviderTimeoutError } from "../errors.js";
import { REQUEST_TIMEOUT_MS } from "../limits.js";
import type { AiProvider, AiProviderResult, ChangeAnalysisInput } from "../types.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface AnthropicMessageResponse {
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Real provider (Section 6). Plain `fetch` against the Messages API
 * rather than the SDK - one fewer dependency, and it makes the
 * timeout logic explicit and testable rather than hidden inside a
 * client library. Makes exactly one HTTP attempt per call; retrying a
 * transient failure is the caller's responsibility (see
 * analyzeChangeWithRetry.ts), applied uniformly across every provider
 * rather than duplicated inside each one.
 */
export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AnthropicProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async analyzeChange(input: ChangeAnalysisInput): Promise<AiProviderResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 1024,
          system: buildSystemPrompt(),
          messages: [{ role: "user", content: buildUserPrompt(input) }],
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new AiProviderTimeoutError(this.name, this.timeoutMs);
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new AiProviderRequestError(this.name, message, true);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // 429 (rate limit) and 5xx are transient - everything else (bad
      // request, auth failure) is not worth retrying.
      const retryable = response.status === 429 || response.status >= 500;
      const body = await response.text().catch(() => "");
      throw new AiProviderRequestError(this.name, `HTTP ${response.status}: ${body.slice(0, 300)}`, retryable);
    }

    const body = (await response.json()) as AnthropicMessageResponse;
    const text = body.content?.find((block) => block.type === "text")?.text;
    if (text === undefined) {
      throw new AiProviderRequestError(this.name, "response contained no text content block", false);
    }

    const output = parseAiOutput(this.name, text);
    return {
      output,
      provider: this.name,
      model: this.model,
      usage: {
        inputTokens: body.usage?.input_tokens,
        outputTokens: body.usage?.output_tokens,
      },
    };
  }
}
