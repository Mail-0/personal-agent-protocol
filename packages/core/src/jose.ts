// ES256 and PS384 keys, JWT signing and verification, JWK thumbprints, and ath, with WebCrypto.
// PS384 lets a Personal Agent have its client assertions and delegations signed blindly (spec 10.7).

import { b64url, b64urlDecode, fromUtf8, sha256, utf8 } from "./encoding.ts";

export type EcPublicJwk = {
    kty: "EC";
    crv: "P-256";
    x: string;
    y: string;
    kid?: string;
    alg?: string;
    use?: string;
};

export type EcPrivateJwk = EcPublicJwk & { d: string };

// A signing key: the private key for signing, and its public JWK (with kid, if it has one).
export type SigningKey = { privateKey: CryptoKey; publicJwk: EcPublicJwk };

export type RsaPublicJwk = {
    kty: "RSA";
    n: string;
    e: string;
    kid?: string;
    alg?: string;
    use?: string;
};

export type RsaPrivateJwk = RsaPublicJwk & {
    d: string;
    p: string;
    q: string;
    dp: string;
    dq: string;
    qi: string;
};

// A PS384 key, which a Personal Agent can use to sign blindly (spec 10.7).
export type RsaKey = { privateKey: CryptoKey; publicJwk: RsaPublicJwk };

const RSA_ALGORITHM = { name: "RSA-PSS", hash: "SHA-384" } as const;
// PS384 uses a salt as long as the hash (RFC 7518 §3.5).
const RSA_SIGN = { name: "RSA-PSS", saltLength: 48 } as const;

const ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

// The `ath` claim of a Session JWT, as in DPoP: the base64url SHA-256 hash of the access token.
export function ath(accessToken: string): Promise<string> {
    return sha256(accessToken);
}

function publicPart(jwk: JsonWebKey): EcPublicJwk {
    return { kty: "EC", crv: "P-256", x: jwk.x as string, y: jwk.y as string };
}

// RFC 7638 JWK thumbprint of an EC public key.
export function thumbprint(jwk: EcPublicJwk): Promise<string> {
    return sha256(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }));
}

// RFC 7638 JWK thumbprint of an RSA public key.
export function rsaThumbprint(jwk: RsaPublicJwk): Promise<string> {
    return sha256(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n }));
}

// Generates an ES256 key pair. With `extractable`, the private JWK is returned too, for keygen.
export async function generateKey(
    extractable = false,
): Promise<SigningKey & { privateJwk?: EcPrivateJwk }> {
    const pair = (await crypto.subtle.generateKey(ALGORITHM, extractable, [
        "sign",
        "verify",
    ])) as CryptoKeyPair;
    const publicJwk = publicPart(await crypto.subtle.exportKey("jwk", pair.publicKey));
    publicJwk.kid = await thumbprint(publicJwk);
    if (!extractable) return { privateKey: pair.privateKey, publicJwk };
    const exported = await crypto.subtle.exportKey("jwk", pair.privateKey);
    return {
        privateKey: pair.privateKey,
        publicJwk,
        privateJwk: { ...publicJwk, d: exported.d as string },
    };
}

export async function importPrivateJwk(jwk: EcPrivateJwk): Promise<SigningKey> {
    if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.d !== "string") {
        throw new Error("The private key must be an EC P-256 JWK with a d value.");
    }
    const privateKey = await crypto.subtle.importKey(
        "jwk",
        { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d },
        ALGORITHM,
        false,
        ["sign"],
    );
    const bare = publicPart(jwk);
    const publicJwk: EcPublicJwk = { ...bare, kid: jwk.kid ?? (await thumbprint(bare)) };
    return { privateKey, publicJwk };
}

export async function signJwt(
    header: Record<string, unknown>,
    payload: Record<string, unknown>,
    key: CryptoKey,
): Promise<string> {
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    // WebCrypto ECDSA signatures are r || s, which is the JWS form for ES256.
    const signature = await crypto.subtle.sign(SIGN, key, utf8(input));
    return `${input}.${b64url(signature)}`;
}

export type DecodedJwt = {
    header: Record<string, unknown>;
    payload: Record<string, unknown>;
};

export function decodeJwt(jwt: string): DecodedJwt {
    const [h, p] = jwt.split(".");
    return {
        header: JSON.parse(fromUtf8(b64urlDecode(h))) as Record<string, unknown>,
        payload: JSON.parse(fromUtf8(b64urlDecode(p))) as Record<string, unknown>,
    };
}

// Verifies an ES256 JWT's signature with a public JWK. Returns the decoded JWT, or null.
export async function verifyJwt(jwt: string, jwk: EcPublicJwk): Promise<DecodedJwt | null> {
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
        ALGORITHM,
        false,
        ["verify"],
    );
    const ok = await crypto.subtle.verify(
        SIGN,
        key,
        b64urlDecode(parts[2]),
        utf8(`${parts[0]}.${parts[1]}`),
    );
    return ok ? decodeJwt(jwt) : null;
}

export async function generateRsaKey(): Promise<RsaKey & { privateJwk: RsaPrivateJwk }> {
    const pair = (await crypto.subtle.generateKey(
        { ...RSA_ALGORITHM, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
        true,
        ["sign", "verify"],
    )) as CryptoKeyPair;
    const exported = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const { d, p, q, dp, dq, qi } = exported as Record<string, string>;
    const publicJwk: RsaPublicJwk = { kty: "RSA", n: exported.n!, e: exported.e! };
    publicJwk.kid = await rsaThumbprint(publicJwk);
    return {
        privateKey: pair.privateKey,
        publicJwk,
        privateJwk: { ...publicJwk, d, p, q, dp, dq, qi },
    };
}

export async function importRsaPrivateJwk(jwk: RsaPrivateJwk): Promise<RsaKey> {
    if (jwk.kty !== "RSA" || typeof jwk.d !== "string") {
        throw new Error("The RSA private key must be an RSA JWK with a d value.");
    }
    const { kty, n, e, d, p, q, dp, dq, qi } = jwk;
    const privateKey = await crypto.subtle.importKey(
        "jwk",
        { kty, n, e, d, p, q, dp, dq, qi },
        RSA_ALGORITHM,
        false,
        ["sign"],
    );
    const publicJwk: RsaPublicJwk = {
        kty,
        n,
        e,
        kid: jwk.kid ?? (await rsaThumbprint({ kty, n, e })),
    };
    return { privateKey, publicJwk };
}

// Verifies a PS384 JWT's signature with an RSA public JWK. Returns the decoded JWT, or null.
export async function verifyPs384(jwt: string, jwk: RsaPublicJwk): Promise<DecodedJwt | null> {
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: jwk.n, e: jwk.e },
        RSA_ALGORITHM,
        false,
        ["verify"],
    );
    const ok = await crypto.subtle.verify(
        RSA_SIGN,
        key,
        b64urlDecode(parts[2]),
        utf8(`${parts[0]}.${parts[1]}`),
    );
    return ok ? decodeJwt(jwt) : null;
}

// Signs a JWT with PS384 and an RSA private key.
export async function signPs384(
    header: Record<string, unknown>,
    payload: Record<string, unknown>,
    privateKey: CryptoKey,
): Promise<string> {
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const signature = await crypto.subtle.sign(RSA_SIGN, privateKey, utf8(input));
    return `${input}.${b64url(signature)}`;
}
