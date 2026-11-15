// The Company's side as an Effect service: verifying the Session header, and turning Poppy errors
// into the responses the spec defines. Fetch-API based, so it fits any server.

import {
    createCompany,
    errorResponse,
    type CompanyOptions,
    type VerifiedSession,
    type VerifyOptions,
} from "@personal-agent-protocol/sdk";
import { Context, Effect, Layer } from "effect";
import {
    toPoppyError,
    toPoppyErrors,
    type InvalidSession,
    type PoppyErrors,
    type SessionEnded,
    type TransportError,
    type VersionUnsupported,
} from "./errors.ts";

export type SessionErrors = InvalidSession | SessionEnded | VersionUnsupported;

// The verified Session of the request being handled.
export class CurrentSession extends Context.Service<CurrentSession, VerifiedSession>()(
    "@personal-agent-protocol/effect/CurrentSession",
) {}

export class PoppyCompany extends Context.Service<
    PoppyCompany,
    {
        readonly identifier: string;
        // Verifies a request's Session header and Poppy-Version (spec 3.4, 5.3, 5.5).
        verify(
            request: Request,
            options?: VerifyOptions,
        ): Effect.Effect<VerifiedSession, SessionErrors>;
    }
>()("@personal-agent-protocol/effect/PoppyCompany") {
    static layer(options: CompanyOptions): Layer.Layer<PoppyCompany> {
        return Layer.sync(PoppyCompany, () => {
            const company = createCompany(options);
            return PoppyCompany.of({
                identifier: company.identifier,
                verify: (request, opts) =>
                    Effect.tryPromise({
                        try: () => company.verify(request, opts),
                        catch: (e) => toPoppyErrors(e) as SessionErrors,
                    }),
            });
        });
    }
}

// Runs `handler` with the request's verified Session as CurrentSession. Poppy errors from
// verification or the handler become their JSON responses (spec 5.3, 8.13).
export function withSession<E, R>(
    request: Request,
    handler: Effect.Effect<Response, E, R>,
    options?: VerifyOptions,
): Effect.Effect<Response, Exclude<E, PoppyErrors>, Exclude<R, CurrentSession> | PoppyCompany> {
    return Effect.gen(function* () {
        const company = yield* PoppyCompany;
        const session = yield* company.verify(request, options);
        return yield* handler.pipe(Effect.provideService(CurrentSession, session));
    }).pipe(
        Effect.catchIf(isPoppyErrors, (error) =>
            Effect.succeed(
                errorResponse(toPoppyError(error as Exclude<PoppyErrors, TransportError>)),
            ),
        ),
    ) as Effect.Effect<
        Response,
        Exclude<E, PoppyErrors>,
        Exclude<R, CurrentSession> | PoppyCompany
    >;
}

const TAGS = new Set([
    "InvalidSession",
    "SessionEnded",
    "VersionUnsupported",
    "VersionMismatch",
    "ConversationNotFound",
    "ConversationClosed",
    "RequestIdConflict",
    "CursorExpired",
    "RateLimited",
    "SignInRequired",
    "DiscoveryFailed",
    "PoppyRequestError",
]);

function isPoppyErrors(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        TAGS.has((error as { _tag?: string })._tag ?? "")
    );
}
