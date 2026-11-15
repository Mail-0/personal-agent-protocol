// Session JWTs and delegations (spec 5.2), signed by the Personal Agent and verified by the Company
// (spec 5.3).

import { nowSeconds, randomId } from "./encoding.ts";
import { PoppyError } from "./errors.ts";
import { getJson, type HttpOptions } from "./http.ts";
import {
    ath,
    decodeJwt,
    signJwt,
    signPs384,
    thumbprint,
    verifyJwt,
    verifyPs384,
    type DecodedJwt,
    type EcPublicJwk,
    type RsaKey,
    type RsaPublicJwk,
    type SigningKey,
} from "./jose.ts";

export const SESSION_JWT_TYP = "poppy-session+jwt";
export const DELEGATION_TYP = "poppy-delegation+jwt";
// The longest lifetime a delegation may have, in seconds (spec 5.2).
export const MAX_DELEGATION_LIFETIME = 24 * 60 * 60;

// A new Session ID: random, so it can't be guessed, and never reused (spec 5.2).
export function newSessionId(): string {
    return randomId(16);
}

// The URL without its query and fragment, as a Session JWT's `htu` (spec 5.2, RFC 9449 §4.2).
export function htuOf(url: string): string {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
}

// A delegation (spec 5.2): `root`, a key in the Personal Agent's jwks_uri, vouches for `delegated`
// until it expires. An RSA root signs with PS384. It names no User or Company.
export async function signDelegation(options: {
    root: SigningKey | RsaKey;
    delegated: EcPublicJwk;
    clientId: string;
    // Seconds, at most MAX_DELEGATION_LIFETIME. Defaults to 2 hours.
    lifetime?: number;
    iat?: number;
}): Promise<string> {
    const lifetime = options.lifetime ?? 2 * 60 * 60;
    if (lifetime > MAX_DELEGATION_LIFETIME)
        throw new RangeError("A delegation lasts at most 24 hours (spec 5.2).");
    const iat = options.iat ?? nowSeconds();
    const { kty, crv, x, y } = options.delegated;
    const rsa = options.root.publicJwk.kty === "RSA";
    const kid = options.root.publicJwk.kid;
    if (!kid) throw new TypeError("The root key needs the kid it has in jwks_uri (spec 5.2).");
    const header = { alg: rsa ? "PS384" : "ES256", typ: DELEGATION_TYP, kid };
    const payload = {
        iss: options.clientId,
        cnf: { jwk: { kty, crv, x, y } },
        iat,
        exp: iat + lifetime,
        jti: randomId(16),
    };
    return rsa
        ? signPs384(header, payload, options.root.privateKey)
        : signJwt(header, payload, options.root.privateKey);
}

export type SessionJwtOptions = {
    // The delegated key that signs the JWT, and the delegation that vouches for it.
    key: SigningKey;
    delegation: string;
    clientId: string;
    // The Company's identifier (spec 3.2).
    audience: string;
    sid: string;
    userId: string;
    agentId?: string;
    method: string;
    url: string;
    // The access token the request carries, which `ath` covers.
    accessToken?: string;
    iat?: number;
};

// A Session JWT for one request, for the Poppy-Session header (spec 5.2).
export async function signSessionJwt(options: SessionJwtOptions): Promise<string> {
    const header = {
        typ: SESSION_JWT_TYP,
        alg: "ES256",
        kid: await thumbprint(options.key.publicJwk),
        poppy_dlg: options.delegation,
    };
    const payload: Record<string, unknown> = {
        iss: options.clientId,
        aud: options.audience,
        sid: options.sid,
        sub: options.userId,
        ...(options.agentId !== undefined ? { agent_id: options.agentId } : {}),
        htm: options.method.toUpperCase(),
        htu: htuOf(options.url),
        iat: options.iat ?? nowSeconds(),
        jti: randomId(16),
    };
    if (options.accessToken !== undefined) payload.ath = await ath(options.accessToken);
    return signJwt(header, payload, options.key.privateKey);
}

// What a verified Session JWT says.
export type VerifiedSession = {
    clientId: string;
    userId: string;
    sid: string;
    agentId?: string;
    jti: string;
    iat: number;
    // Whether the request carried an access token, which `ath` matched.
    signedIn: boolean;
    // The delegated key's JWK thumbprint, for a Company that limits each key to one User ID.
    keyThumbprint: string;
};

export type ClientKeys = {
    jwks: (EcPublicJwk | RsaPublicJwk)[];
    metadata: Record<string, unknown>;
};

// Fetches a Personal Agent's client metadata without following redirects, then its JWKS (spec 4.1,
// 5.3).
export async function fetchClientKeys(clientId: string, http: HttpOptions): Promise<ClientKeys> {
    const meta = await getJson(clientId, http, 0);
    const metadata = meta.json as Record<string, unknown> | undefined;
    if (!meta.response.ok || !metadata || typeof metadata !== "object")
        throw invalid(`client metadata at ${clientId} returned HTTP ${meta.response.status}`);
    if (metadata.client_id !== clientId)
        throw invalid("the client metadata's client_id isn't the URL it was fetched from");
    const jwksUri = metadata.jwks_uri;
    if (typeof jwksUri !== "string" || !sameDomain(jwksUri, clientId))
        throw invalid("jwks_uri must be an HTTPS URL on the same domain as client_id");
    const keys = await getJson(jwksUri, http, 0);
    const jwks = (keys.json as { keys?: unknown } | undefined)?.keys;
    if (!keys.response.ok || !Array.isArray(jwks)) throw invalid(`no key set at ${jwksUri}`);
    return { metadata, jwks: jwks as ClientKeys["jwks"] };
}

export type SessionVerifierOptions = {
    // The Company's identifier (spec 3.2): its issuer, or https://{organization.domain}.
    identifier: string;
    // The protocol versions the Company serves, as "major.minor".
    versions: string[];
    // How far `iat` may be from now, in seconds. Defaults to 60.
    maxSkew?: number;
    // How long fetched client keys are reused, in seconds. Defaults to 300.
    clientKeysTtl?: number;
    // Resolves a client_id to its keys. Defaults to fetchClientKeys with `http`.
    resolveClient?: (clientId: string) => Promise<ClientKeys>;
    http?: HttpOptions;
    now?: () => number;
};

export type SessionRequest = {
    // The Poppy-Session header, or undefined when there was none.
    session: string | undefined;
    // The Poppy-Version header.
    version: string | undefined;
    method: string;
    url: string;
    // The access token the request carries, if any.
    accessToken?: string;
    // The client_id the access token was issued to, when the Company knows it (spec 5.3 step 3).
    tokenClientId?: string;
};

export type SessionVerifier = (request: SessionRequest) => Promise<VerifiedSession>;

// Verifies the Session header (spec 5.3 steps 1 to 3) and Poppy-Version (spec 3.4). Throws a
// PoppyError with invalid_session or version_unsupported. Looking up the Session record (step 4)
// and checking ended Sessions (spec 5.5) are the Company's.
export function createSessionVerifier(options: SessionVerifierOptions): SessionVerifier {
    const now = options.now ?? nowSeconds;
    const maxSkew = options.maxSkew ?? 60;
    const ttl = options.clientKeysTtl ?? 300;
    const resolve = options.resolveClient ?? ((id) => fetchClientKeys(id, options.http ?? {}));
    const clients = new Map<string, { keys: Promise<ClientKeys>; until: number }>();
    const delegations = new Map<string, { jwk: EcPublicJwk; exp: number; iss: string }>();

    function clientKeys(clientId: string): Promise<ClientKeys> {
        const cached = clients.get(clientId);
        if (cached && cached.until > now()) return cached.keys;
        const keys = resolve(clientId);
        evictExpired(clients, now());
        clients.set(clientId, { keys, until: now() + ttl });
        keys.catch(() => clients.delete(clientId));
        return keys;
    }

    async function delegatedKey(delegation: string, clientId: string): Promise<EcPublicJwk> {
        const cached = delegations.get(delegation);
        if (cached && cached.exp > now() && cached.iss === clientId) return cached.jwk;
        const decoded = safeDecode(delegation);
        if (!decoded) throw invalid("the delegation isn't a JWT");
        const { header, payload } = decoded;
        if (header.typ !== DELEGATION_TYP)
            throw invalid(`the delegation's typ isn't ${DELEGATION_TYP}`);
        if (payload.iss !== clientId) throw invalid("the delegation's iss isn't the token's iss");
        const { jwks } = await clientKeys(clientId);
        const root = jwks.find((k) => k.kid === header.kid);
        if (!root) throw invalid(`no key ${String(header.kid)} in the client's jwks_uri`);
        const verified =
            header.alg === "ES256" && root.kty === "EC"
                ? await safeVerify(() => verifyJwt(delegation, root))
                : header.alg === "PS384" && root.kty === "RSA"
                  ? await safeVerify(() => verifyPs384(delegation, root))
                  : null;
        if (!verified) throw invalid("the delegation's signature doesn't verify");
        const iat = Number(payload.iat);
        const exp = Number(payload.exp);
        if (!(exp > now())) throw invalid("the delegation has expired");
        if (!(exp - iat <= MAX_DELEGATION_LIFETIME))
            throw invalid("the delegation lasts more than 24 hours");
        const jwk = (payload.cnf as { jwk?: Record<string, unknown> } | undefined)?.jwk;
        if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || "d" in jwk)
            throw invalid("the delegation's cnf.jwk isn't a public P-256 key");
        const key = { kty: "EC", crv: "P-256", x: String(jwk.x), y: String(jwk.y) } as const;
        evictExpired(delegations, now());
        delegations.set(delegation, { jwk: key, exp, iss: clientId });
        return key;
    }

    return async (request) => {
        if (!request.version || !options.versions.some((v) => compatible(v, request.version!)))
            throw new PoppyError("version_unsupported");
        if (!request.session) throw invalid("the request has no Poppy-Session header");
        const decoded = safeDecode(request.session);
        if (!decoded) throw invalid("the Session header isn't a JWT");
        const { header, payload } = decoded;
        if (header.typ !== SESSION_JWT_TYP) throw invalid(`typ isn't ${SESSION_JWT_TYP}`);
        if (header.alg !== "ES256") throw invalid("alg isn't ES256");
        if (typeof header.poppy_dlg !== "string")
            throw invalid("the Session JWT has no delegation");
        if (typeof payload.iss !== "string") throw invalid("iss is missing");
        const jwk = await delegatedKey(header.poppy_dlg, payload.iss);
        if (!(await safeVerify(() => verifyJwt(request.session!, jwk))))
            throw invalid("the signature doesn't verify with the delegated key");
        const keyThumbprint = await thumbprint(jwk);
        if (header.kid !== keyThumbprint) throw invalid("kid isn't the delegated key's thumbprint");
        for (const claim of ["aud", "sid", "sub", "htm", "htu", "jti"]) {
            if (typeof payload[claim] !== "string" || !payload[claim])
                throw invalid(`${claim} is missing`);
        }
        if (payload.aud !== options.identifier)
            throw invalid("aud isn't this Company's identifier");
        if (payload.htm !== request.method.toUpperCase())
            throw invalid("htm doesn't match the request");
        if (!sameHtu(String(payload.htu), request.url))
            throw invalid("htu doesn't match the request");
        const iat = payload.iat;
        if (typeof iat !== "number" || Math.abs(now() - iat) > maxSkew)
            throw invalid("iat is outside the acceptance window");
        if (request.accessToken !== undefined) {
            if (payload.ath !== (await ath(request.accessToken)))
                throw invalid("ath doesn't match the access token");
            if (request.tokenClientId !== undefined && request.tokenClientId !== payload.iss)
                throw invalid("the access token was issued to another client_id");
        } else if (payload.ath !== undefined) {
            throw invalid("ath is present without an access token");
        }
        return {
            clientId: payload.iss,
            userId: String(payload.sub),
            sid: String(payload.sid),
            ...(typeof payload.agent_id === "string" ? { agentId: payload.agent_id } : {}),
            jti: String(payload.jti),
            iat,
            signedIn: request.accessToken !== undefined,
            keyThumbprint,
        };
    };
}

// Whether two protocol versions are compatible: the same major version and, before 1.0, the same
// minor version (spec 3.4).
export function compatible(a: string, b: string): boolean {
    if (!/^\d+\.\d+$/.test(a) || !/^\d+\.\d+$/.test(b)) return false;
    const [am, an] = a.split(".");
    const [bm, bn] = b.split(".");
    return am === bm && (am !== "0" || an === bn);
}

// Drops expired entries once a cache is large, so a long-running verifier doesn't keep every
// rotated delegation and client it has seen.
function evictExpired<T extends { exp?: number; until?: number }>(
    cache: Map<string, T>,
    now: number,
) {
    if (cache.size < 1000) return;
    for (const [key, entry] of cache) if ((entry.exp ?? entry.until ?? 0) <= now) cache.delete(key);
}

function invalid(description: string): PoppyError {
    return new PoppyError("invalid_session", description);
}

function safeDecode(jwt: string): DecodedJwt | undefined {
    try {
        if (jwt.split(".").length !== 3) return undefined;
        const decoded = decodeJwt(jwt);
        return isObject(decoded.header) && isObject(decoded.payload) ? decoded : undefined;
    } catch {
        return undefined;
    }
}

function isObject(value: unknown): boolean {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function safeVerify(verify: () => Promise<DecodedJwt | null>): Promise<DecodedJwt | null> {
    try {
        return await verify();
    } catch {
        return null;
    }
}

// RFC 9449 §4.3: compare without query and fragment, after normalizing.
function sameHtu(htu: string, url: string): boolean {
    try {
        return htuOf(htu) === htuOf(url);
    } catch {
        return false;
    }
}

function sameDomain(url: string, clientId: string): boolean {
    try {
        const a = new URL(url);
        const host = new URL(clientId).hostname;
        return a.protocol === "https:" && (a.hostname === host || a.hostname.endsWith(`.${host}`));
    } catch {
        return false;
    }
}
