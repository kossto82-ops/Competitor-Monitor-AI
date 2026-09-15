/** The provider did not respond within the configured timeout. */
export class AiProviderTimeoutError extends Error {
  constructor(provider: string, timeoutMs: number) {
    super(`${provider} did not respond within ${timeoutMs}ms`);
    this.name = "AiProviderTimeoutError";
  }
}

/** Network failure, non-2xx response, or rate limiting from the provider. */
export class AiProviderRequestError extends Error {
  constructor(
    provider: string,
    message: string,
    public readonly retryable: boolean = false,
  ) {
    super(`${provider} request failed: ${message}`);
    this.name = "AiProviderRequestError";
  }
}

/**
 * The provider responded, but its content was not valid JSON matching
 * AiAnalysisOutput - either malformed JSON (Section 5's "reject
 * malformed output") or JSON that fails schema validation. Both are
 * treated the same way by callers: the analysis is FAILED, nothing is
 * persisted as trusted structured data.
 */
export class AiOutputValidationError extends Error {
  constructor(
    provider: string,
    message: string,
    public readonly rawOutput: string,
  ) {
    super(`${provider} returned invalid output: ${message}`);
    this.name = "AiOutputValidationError";
  }
}
