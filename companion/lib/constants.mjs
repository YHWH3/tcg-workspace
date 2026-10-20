// Fixed endpoints and policy constants for the TCG Workspace Companion.
//
// SECURITY: these values are deliberately NOT read from environment variables
// or config files. The issuer, token endpoint and inference endpoint decide
// where ChatGPT credentials are sent, so they are compile-time constants.
// Tests inject a stub `fetch`, never different endpoints.
//
// Source: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
//         https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
//         https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference

export const OPENAI_ISSUER = 'https://auth.openai.com';
export const OPENAI_AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';
export const OPENAI_TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
export const OPENAI_DISCOVERY_URL = 'https://auth.openai.com/.well-known/openid-configuration';
export const OPENAI_AUTH_HOST = 'auth.openai.com';
export const OPENAI_API_HOST = 'api.openai.com';
export const OPENAI_RESOURCE = 'https://api.openai.com/v1';
export const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';
export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

/** First-registration entrypoint. Never saved as an issued client id. */
export const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
/** Our app's actual name, used consistently as agent_name_hint on first registration only. */
export const AGENT_NAME = 'TCG Workspace Companion';

export const SIWC_SCOPES = Object.freeze([
  'openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct',
]);
/** Without this granted scope the sign-in is kept but plan usage stays disabled. */
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';

/** SIWC loopback: only the port may vary; host must be 127.0.0.1, path fixed. */
export const SIWC_CALLBACK_PATH = '/auth/callback';
export const SIWC_DEFAULT_PORT = 1455;
/** Workspace OAuth loopback path (registered with the Workspace server; different from SIWC). */
export const WORKSPACE_CALLBACK_PATH = '/callback';
export const LOOPBACK_HOST = '127.0.0.1';

/** Refresh errors that mean the stored refresh token is unusable. */
export const TERMINAL_REFRESH_ERRORS = Object.freeze(new Set([
  'invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired',
  'refresh_token_invalidated', 'refresh_token_reused',
]));

/**
 * Responses request fields the ChatGPT-plan route does not support.
 * https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
 */
export const UNSUPPORTED_RESPONSES_FIELDS = Object.freeze([
  'background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation',
  'multi_agent', 'prompt', 'prompt_cache_retention', 'safety_identifier', 'temperature',
  'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id',
]);
/** Hosted tool types that must never be sent on this route. */
export const UNSUPPORTED_TOOL_TYPES = Object.freeze(new Set([
  'mcp', 'file_search', 'code_interpreter', 'computer_use_preview', 'computer', 'tool_search',
  'image_generation', 'programmatic_tool_calling',
]));

/**
 * Workspace MCP tools the model must never be able to call. Approval,
 * execution of approved previews, undo and publishing stay human-only.
 */
export const EXCLUDED_TOOLS = Object.freeze(new Set([
  'execute_preview', 'decide_approval', 'request_approval', 'undo_change',
  'publish_page', 'publish_moodboard', 'share_moodboard',
]));

/** Namespace that groups Workspace MCP tools for the Responses API. */
export const TOOL_NAMESPACE = 'tcg_workspace';
export const MAX_TOOL_STEPS = 8;
export const MAX_TOOL_OUTPUT_CHARS = 20_000;

export const MANAGE_USAGE_HINT = 'Manage usage: ChatGPT Settings → Usage (https://chatgpt.com → Settings → Usage)';
export const COMPANION_VERSION = '0.1.0';
