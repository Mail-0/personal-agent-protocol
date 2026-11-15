// The Company's side: verifying the Session header on requests and answering with the protocol's
// errors. Works with any server built on the Fetch API: Hono, Next.js route handlers, Bun.serve,
// Deno, Cloudflare Workers.

import {
    createSessionVerifier,
    errorResponse,
    PoppyError,
    SESSION_HEADER,
    validate,
    VERSION_HEADER,
    type Poppy,
    type SessionVerifierOptions,
    type VerifiedSession,
} from "@personal-agent-protocol/core";

export type CompanyOptions = SessionVerifierOptions & {
    // Whether a Session was ended, so its requests get session_ended (spec 5.5).
    isEnded?: (session: VerifiedSession) => boolean | Promise<boolean>;
};

export type VerifyOptions = {
    // The URL the Personal Agent sent the request to, when a proxy changed request.url.
    url?: string;
    // The client_id the access token was issued to, from the Company's token validation.
    tokenClientId?: string;
};

export type CompanyServer = {
    readonly identifier: string;
    // Verifies a request's Session header and Poppy-Version (spec 3.4, 5.3, 5.5).
    verify(request: Request, options?: VerifyOptions): Promise<VerifiedSession>;
    // Wraps a handler so it gets the verified Session and Poppy errors become their responses.
    handle(
        handler: (request: Request, session: VerifiedSession) => Response | Promise<Response>,
        options?: (request: Request) => VerifyOptions,
    ): (request: Request) => Promise<Response>;
    // The response for GET /.well-known/poppy.json, after checking the document against the schema.
    discoveryResponse(document: Poppy): Response;
};

export function createCompany(options: CompanyOptions): CompanyServer {
    const verifier = createSessionVerifier(options);
    async function verify(request: Request, opts: VerifyOptions = {}): Promise<VerifiedSession> {
        const token = accessToken(request);
        const session = await verifier({
            session: request.headers.get(SESSION_HEADER) ?? undefined,
            version: request.headers.get(VERSION_HEADER) ?? undefined,
            method: request.method,
            url: opts.url ?? request.url,
            ...(token !== undefined ? { accessToken: token } : {}),
            ...(opts.tokenClientId !== undefined ? { tokenClientId: opts.tokenClientId } : {}),
        });
        if (await options.isEnded?.(session)) throw new PoppyError("session_ended");
        return session;
    }
    return {
        identifier: options.identifier,
        verify,
        handle(handler, opts) {
            return async (request) => {
                try {
                    return await handler(request, await verify(request, opts?.(request)));
                } catch (error) {
                    if (error instanceof PoppyError) return errorResponse(error);
                    throw error;
                }
            };
        },
        discoveryResponse(document) {
            validate("poppy.schema.json", document);
            return new Response(JSON.stringify(document), {
                headers: { "content-type": "application/json" },
            });
        },
    };
}

// The access token from Authorization: Bearer or DPoP (spec 4.5).
export function accessToken(request: Request): string | undefined {
    const match = /^(?:Bearer|DPoP)\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
    return match?.[1];
}
