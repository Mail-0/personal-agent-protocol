// The Personal Agent's side of OAuth (spec 4): client assertions, Direct Sign-In with PKCE and PAR,
// Device Sign-In, refresh, and revocation.

import { b64url, nowSeconds, randomId, sha256 } from "./encoding.ts";
import { errorFromResponse, PoppyError } from "./errors.ts";
import type {
    AuthorizationServerMetadata,
    DeviceAuthorizationResponse,
    TokenResponse,
} from "./generated/types.ts";
import { postForm, type HttpOptions } from "./http.ts";
import { signJwt, signPs384, type RsaKey, type SigningKey } from "./jose.ts";
import { validate } from "./validate.ts";

const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export type OAuthClient = {
    clientId: string;
    // A key from the Personal Agent's jwks_uri. ES256, or PS384 for an RSA key (spec 4.1).
    key: SigningKey | RsaKey;
    // The Company's issuer and its verified metadata, from discovery.
    issuer: string;
    metadata: AuthorizationServerMetadata;
    http?: HttpOptions;
};

// A client assertion for the token endpoint (spec 4.1, RFC 7523): `aud` is the issuer, and it lasts
// at most 5 minutes.
export function signClientAssertion(options: {
    clientId: string;
    issuer: string;
    key: SigningKey | RsaKey;
    lifetime?: number;
}): Promise<string> {
    const iat = nowSeconds();
    const lifetime = Math.min(options.lifetime ?? 60, 300);
    const rsa = options.key.publicJwk.kty === "RSA";
    const header: Record<string, unknown> = { alg: rsa ? "PS384" : "ES256", typ: "JWT" };
    if (options.key.publicJwk.kid) header.kid = options.key.publicJwk.kid;
    const payload = {
        iss: options.clientId,
        sub: options.clientId,
        aud: options.issuer,
        iat,
        exp: iat + lifetime,
        jti: randomId(16),
    };
    return rsa
        ? signPs384(header, payload, options.key.privateKey)
        : signJwt(header, payload, options.key.privateKey);
}

// RFC 9126 metadata, which Poppy allows (spec 4.2).
type ParMetadata = {
    pushed_authorization_request_endpoint?: string;
    require_pushed_authorization_requests?: boolean;
};

export type Pkce = { verifier: string; challenge: string; method: "S256" };

export async function createPkce(): Promise<Pkce> {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    return { verifier, challenge: await sha256(verifier), method: "S256" };
}

export type DirectSignIn = {
    // Open this in the User's browser.
    url: string;
    state: string;
    pkce: Pkce;
    redirectUri: string;
};

// Starts Direct Sign-In (spec 4.2). Uses PAR when the issuer lists its endpoint, and asks for
// prompt=consent unless the redirect only comes back to the device that opened the URL.
export async function startDirectSignIn(
    client: OAuthClient,
    options: { redirectUri: string; scope: string; sameDevice?: boolean; resource?: string },
): Promise<DirectSignIn> {
    const endpoint = client.metadata.authorization_endpoint;
    if (!endpoint) throw new PoppyError("unsupported_grant_type", "no authorization_endpoint");
    const pkce = await createPkce();
    const state = randomId(16);
    const params: Record<string, string | undefined> = {
        response_type: "code",
        client_id: client.clientId,
        redirect_uri: options.redirectUri,
        scope: options.scope,
        state,
        code_challenge: pkce.challenge,
        code_challenge_method: pkce.method,
        prompt: options.sameDevice ? undefined : "consent",
        resource: options.resource,
    };
    const metadata = client.metadata as AuthorizationServerMetadata & ParMetadata;
    const par = metadata.pushed_authorization_request_endpoint;
    const url = new URL(endpoint);
    if (par) {
        const pushed = await tokenEndpointCall(client, par, params);
        const requestUri = (pushed as { request_uri?: unknown }).request_uri;
        if (typeof requestUri !== "string")
            throw new PoppyError("invalid_response", "no request_uri");
        url.searchParams.set("client_id", client.clientId);
        url.searchParams.set("request_uri", requestUri);
    } else if (metadata.require_pushed_authorization_requests) {
        throw new PoppyError("invalid_response", "PAR is required but has no endpoint");
    } else {
        for (const [k, v] of Object.entries(params))
            if (v !== undefined) url.searchParams.set(k, v);
    }
    return { url: url.toString(), state, pkce, redirectUri: options.redirectUri };
}

// Finishes Direct Sign-In with the redirect's query: checks `state` and `iss` (RFC 9207), then
// exchanges the code.
export async function completeDirectSignIn(
    client: OAuthClient,
    signIn: DirectSignIn,
    callback: URLSearchParams,
): Promise<TokenResponse> {
    if (callback.get("iss") !== client.issuer)
        throw new PoppyError("invalid_response", "the redirect's iss isn't the Company's issuer");
    if (callback.get("state") !== signIn.state)
        throw new PoppyError("invalid_response", "the redirect's state doesn't match");
    const error = callback.get("error");
    if (error) throw new PoppyError(error, callback.get("error_description") ?? undefined);
    const code = callback.get("code");
    if (!code) throw new PoppyError("invalid_response", "the redirect has no code");
    return requestToken(client, {
        grant_type: "authorization_code",
        code,
        redirect_uri: signIn.redirectUri,
        code_verifier: signIn.pkce.verifier,
    });
}

export type DeviceSignIn = DeviceAuthorizationResponse & { organizationName?: string };

// Starts Device Sign-In (spec 4.3). Checks that the link the User will see is on the issuer's host,
// organization.domain, or a subdomain of either, before returning it.
export async function startDeviceSignIn(
    client: OAuthClient,
    options: { scope: string; domain: string },
): Promise<DeviceAuthorizationResponse> {
    const endpoint = client.metadata.device_authorization_endpoint;
    if (!endpoint)
        throw new PoppyError("unsupported_grant_type", "no device_authorization_endpoint");
    const json = await tokenEndpointCall(client, endpoint, { scope: options.scope });
    const response = validate<DeviceAuthorizationResponse>(
        "device-authorization-response.schema.json",
        json,
    );
    const hosts = [new URL(client.issuer).hostname, options.domain.split(":")[0]];
    for (const link of [response.verification_uri, response.verification_uri_complete]) {
        if (!link) continue;
        const host = new URL(link).hostname;
        if (!hosts.some((h) => host === h || host.endsWith(`.${h}`)))
            throw new PoppyError(
                "invalid_response",
                `the sign-in link ${link} isn't on the Company's hosts`,
            );
    }
    return response;
}

export type DevicePoll =
    | { status: "pending" }
    | { status: "slow_down"; interval: number }
    | { status: "done"; tokens: TokenResponse };

// Polls the token endpoint once for a Device Sign-In (RFC 8628 §3.4–3.5). Call it every `interval`
// seconds until it's done; it throws on access_denied, expired_token, and other errors.
export async function pollDeviceSignIn(
    client: OAuthClient,
    device: DeviceAuthorizationResponse,
    interval: number,
): Promise<DevicePoll> {
    try {
        const tokens = await requestToken(client, {
            grant_type: DEVICE_GRANT,
            device_code: device.device_code,
        });
        return { status: "done", tokens };
    } catch (error) {
        if (error instanceof PoppyError && error.code === "authorization_pending")
            return { status: "pending" };
        if (error instanceof PoppyError && error.code === "slow_down")
            return { status: "slow_down", interval: interval + 5 };
        throw error;
    }
}

// Refreshes an access token (spec 4.4). Keep the old refresh token when the response has no new one.
export function refreshToken(
    client: OAuthClient,
    refresh: string,
    options: { scope?: string; resource?: string } = {},
): Promise<TokenResponse> {
    return requestToken(client, {
        grant_type: "refresh_token",
        refresh_token: refresh,
        scope: options.scope,
        resource: options.resource,
    });
}

// Revokes a refresh token (spec 4.6, RFC 7009). Revoking every refresh token for an account signs
// out of it (spec 5.5).
export async function revokeToken(client: OAuthClient, token: string): Promise<void> {
    const endpoint = client.metadata.revocation_endpoint;
    if (!endpoint) throw new PoppyError("unsupported_token_type", "no revocation_endpoint");
    await tokenEndpointCall(client, endpoint, { token, token_type_hint: "refresh_token" }, true);
}

async function requestToken(
    client: OAuthClient,
    params: Record<string, string | undefined>,
): Promise<TokenResponse> {
    const json = await tokenEndpointCall(client, client.metadata.token_endpoint, params);
    return validate<TokenResponse>("token-response.schema.json", json);
}

async function tokenEndpointCall(
    client: OAuthClient,
    endpoint: string,
    params: Record<string, string | undefined>,
    emptyOk = false,
): Promise<unknown> {
    const assertion = await signClientAssertion(client);
    const response = await postForm(
        endpoint,
        {
            ...params,
            client_id: client.clientId,
            client_assertion_type: ASSERTION_TYPE,
            client_assertion: assertion,
        },
        client.http ?? {},
    );
    const error = await errorFromResponse(response);
    if (error) throw error;
    if (emptyOk) return undefined;
    try {
        return await response.json();
    } catch {
        throw new PoppyError("invalid_response", `${endpoint} didn't return JSON`);
    }
}
