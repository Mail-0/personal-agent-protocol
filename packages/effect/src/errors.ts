// Poppy errors as tagged Effect errors, so callers use Effect.catchTag instead of reading codes.

import { PoppyError } from "@personal-agent-protocol/core";
import { Schema } from "effect";

const fields = {
    code: Schema.String,
    message: Schema.String,
    status: Schema.optional(Schema.Number),
    body: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
};

export class InvalidSession extends Schema.TaggedError<InvalidSession>()(
    "InvalidSession",
    fields,
) {}
export class SessionEnded extends Schema.TaggedError<SessionEnded>()("SessionEnded", fields) {}
export class VersionUnsupported extends Schema.TaggedError<VersionUnsupported>()(
    "VersionUnsupported",
    fields,
) {}
export class VersionMismatch extends Schema.TaggedError<VersionMismatch>()(
    "VersionMismatch",
    fields,
) {}
export class ConversationNotFound extends Schema.TaggedError<ConversationNotFound>()(
    "ConversationNotFound",
    fields,
) {}
export class ConversationClosed extends Schema.TaggedError<ConversationClosed>()(
    "ConversationClosed",
    fields,
) {}
export class RequestIdConflict extends Schema.TaggedError<RequestIdConflict>()(
    "RequestIdConflict",
    fields,
) {}
export class CursorExpired extends Schema.TaggedError<CursorExpired>()("CursorExpired", fields) {}
export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {
    ...fields,
    retryAfter: Schema.optional(Schema.Number),
}) {}
// The Company needs sign-in or more scopes: invalid_token, insufficient_scope (spec 7, 8.11).
export class SignInRequired extends Schema.TaggedError<SignInRequired>()("SignInRequired", {
    ...fields,
    scope: Schema.optional(Schema.String),
}) {}
export class DiscoveryFailed extends Schema.TaggedError<DiscoveryFailed>()(
    "DiscoveryFailed",
    fields,
) {}
// Any other protocol, OAuth, or address error, with its wire code.
export class PoppyRequestError extends Schema.TaggedError<PoppyRequestError>()(
    "PoppyRequestError",
    fields,
) {}
// The request never got a response, such as a network failure.
export class TransportError extends Schema.TaggedError<TransportError>()("TransportError", {
    message: Schema.String,
}) {}

export type PoppyErrors =
    | InvalidSession
    | SessionEnded
    | VersionUnsupported
    | VersionMismatch
    | ConversationNotFound
    | ConversationClosed
    | RequestIdConflict
    | CursorExpired
    | RateLimited
    | SignInRequired
    | DiscoveryFailed
    | PoppyRequestError
    | TransportError;

const BY_CODE = {
    invalid_session: InvalidSession,
    session_ended: SessionEnded,
    version_unsupported: VersionUnsupported,
    version_mismatch: VersionMismatch,
    conversation_not_found: ConversationNotFound,
    conversation_closed: ConversationClosed,
    request_id_conflict: RequestIdConflict,
    cursor_expired: CursorExpired,
    discovery_failed: DiscoveryFailed,
} as const;

// The tagged error for anything an SDK call rejects with.
export function toPoppyErrors(error: unknown): PoppyErrors {
    if (!(error instanceof PoppyError))
        return new TransportError({
            message: error instanceof Error ? error.message : String(error),
        });
    const base = {
        code: error.code,
        message: error.message,
        ...(error.status !== undefined ? { status: error.status } : {}),
        ...(error.body !== undefined ? { body: error.body } : {}),
    };
    if (error.code === "rate_limited")
        return new RateLimited({
            ...base,
            ...(error.retryAfter !== undefined ? { retryAfter: error.retryAfter } : {}),
        });
    if (error.code === "invalid_token" || error.code === "insufficient_scope") {
        const scope = error.challenges.find((c) => c.params.scope)?.params.scope;
        return new SignInRequired({ ...base, ...(scope ? { scope } : {}) });
    }
    const Tagged = Object.hasOwn(BY_CODE, error.code)
        ? BY_CODE[error.code as keyof typeof BY_CODE]
        : PoppyRequestError;
    return new Tagged(base);
}

// Back to a PoppyError, for writing a Company's error response.
export function toPoppyError(error: Exclude<PoppyErrors, TransportError>): PoppyError {
    return new PoppyError(error.code, undefined, {
        ...(error._tag === "RateLimited" && error.retryAfter !== undefined
            ? { retryAfter: error.retryAfter }
            : {}),
        ...(error.status !== undefined ? { status: error.status } : {}),
        ...(error.body !== undefined ? { body: error.body } : {}),
    });
}
