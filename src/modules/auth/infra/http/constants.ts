/** Groups the module's endpoints in the generated OpenAPI document. */
export const AUTH_TAG = 'Auth'

export const OK_STATUS = 200
/**
 * The register endpoint's only success status. It says "accepted, and what
 * happens next happens by email" — which is exactly true, and reveals nothing
 * about whether the address already had an account.
 */
export const ACCEPTED_STATUS = 202
export const NO_CONTENT_STATUS = 204
export const BAD_REQUEST_STATUS = 400
export const UNAUTHORIZED_STATUS = 401
/** The login gate: the password was right, the account is not verified. */
export const FORBIDDEN_STATUS = 403
export const NOT_FOUND_STATUS = 404
/**
 * A rule failed on a request that was well-formed and properly authenticated.
 * The password change endpoint is the first to produce it from a domain error.
 */
export const UNPROCESSABLE_ENTITY_STATUS = 422
export const TOO_MANY_REQUESTS_STATUS = 429
/**
 * Produced by every endpoint that opens a transaction: a deadlock that survives
 * the runner's retries surfaces as `TransactionConflictError`, which the error
 * handler answers with 503 plus `Retry-After`. These are the first endpoints in
 * the project that can produce it.
 */
export const SERVICE_UNAVAILABLE_STATUS = 503

/**
 * Sample values published in the OpenAPI document.
 *
 * Without them Swagger UI invents its own, and for an OpenAPI 3.1 document it
 * feeds the schema's `pattern` to a regex generator BEFORE it ever looks at
 * `format` — expanding every `*` and `+` up to 100 repetitions. Zod emits both
 * keywords for `z.email()` and `z.uuid()`, so the e-mail sample came out as a
 * multi-kilobyte address with a hundred domain labels. An explicit example
 * short-circuits that branch entirely.
 *
 * They must satisfy the schemas they annotate: the UI's "Try it out" sends them
 * verbatim, so an example that fails validation documents a request nobody can
 * make.
 */
export const EXAMPLE_USER_ID = '0d3d5d8a-6f2e-4d2e-9f1a-6d0f9a3b5c21'
export const EXAMPLE_EMAIL = 'user@example.com'
/** Satisfies the registration policy: letter, digit and non-alphanumeric. */
export const EXAMPLE_PASSWORD = 'sup3rS3cret!'
