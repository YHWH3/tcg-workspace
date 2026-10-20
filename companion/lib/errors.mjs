// Typed errors. Messages never include token values.

export class CompanionError extends Error {
  /** @param {string} code @param {string} message @param {Record<string, unknown>} [extra] */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'CompanionError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** Authorization/sign-in failures (state mismatch, denied, client mismatch, identity mismatch, ...). */
export class AuthError extends CompanionError { constructor(code, message, extra) { super(code, message, extra); this.name = 'AuthError'; } }

/** Stored credentials are unusable; the user must sign in again. */
export class ReauthRequired extends CompanionError { constructor(message, extra) { super('reauth_required', message, extra); this.name = 'ReauthRequired'; } }

/** Signed in, but `chatgpt.tokens.use.direct` was not granted: never run inference. */
export class PlanUsageDisabled extends CompanionError {
  constructor(label) {
    super('plan_usage_disabled', `ChatGPT plan usage is disabled for "${label}": the chatgpt.tokens.use.direct permission was not granted. ` +
      'Run `tcg-companion login --account <label> --enable-plan` to request it again. No other billing path is used.');
    this.name = 'PlanUsageDisabled';
  }
}

/**
 * A Responses/route failure. Preserves HTTP status, error code/param and
 * request id exactly as returned.
 */
export class ResponsesError extends CompanionError {
  /** @param {{status?:number|null, code?:string|null, param?:string|null, requestId?:string|null, detail?:string|null, kind:string, message:string, retryable?:boolean}} f */
  constructor(f) {
    super(f.code ?? f.kind, f.message, {});
    this.name = 'ResponsesError';
    this.status = f.status ?? null;
    this.errorCode = f.code ?? null;
    this.param = f.param ?? null;
    this.requestId = f.requestId ?? null;
    this.detail = f.detail ?? null;
    this.kind = f.kind;
    this.retryable = Boolean(f.retryable);
  }
}
