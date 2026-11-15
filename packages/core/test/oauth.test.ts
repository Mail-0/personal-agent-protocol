import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeJwt, generateKey, verifyJwt } from "../src/jose.ts";
import {
    completeDirectSignIn,
    pollDeviceSignIn,
    signClientAssertion,
    startDeviceSignIn,
    startDirectSignIn,
    type OAuthClient,
} from "../src/oauth.ts";
import { PoppyError } from "../src/errors.ts";
import { fakeFetch, ISSUER_METADATA, json } from "./fake.ts";

const CLIENT_ID = "https://agent.example/agent.json";

async function client(
    routes: Parameters<typeof fakeFetch>[0],
    metadata = {},
): Promise<OAuthClient & { fetch: ReturnType<typeof fakeFetch> }> {
    const fetch = fakeFetch(routes);
    return {
        clientId: CLIENT_ID,
        key: await generateKey(),
        issuer: ISSUER_METADATA.issuer,
        metadata: { ...ISSUER_METADATA, ...metadata },
        http: { fetch },
        fetch,
    };
}

test("client assertions name the issuer as aud and last at most 5 minutes", async () => {
    const key = await generateKey();
    const jwt = await signClientAssertion({
        clientId: CLIENT_ID,
        issuer: "https://auth.example.com",
        key,
        lifetime: 3600,
    });
    const { payload } = (await verifyJwt(jwt, key.publicJwk))!;
    assert.equal(payload.aud, "https://auth.example.com");
    assert.equal(payload.iss, CLIENT_ID);
    assert.ok(Number(payload.exp) - Number(payload.iat) <= 300);
});

test("Direct Sign-In asks for consent, then checks iss and state before exchanging the code", async () => {
    const c = await client({
        [ISSUER_METADATA.token_endpoint]: async (req) => {
            const form = new URLSearchParams(await req.text());
            assert.equal(
                form.get("client_assertion_type"),
                "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            );
            assert.equal(
                decodeJwt(form.get("client_assertion")!).payload.aud,
                ISSUER_METADATA.issuer,
            );
            return json({
                access_token: "at",
                token_type: "Bearer",
                expires_in: 300,
                refresh_token: "rt",
                scope: "orders:read",
            });
        },
    });
    const signIn = await startDirectSignIn(c, {
        redirectUri: "https://agent.example/oauth/callback",
        scope: "orders:read",
    });
    const url = new URL(signIn.url);
    assert.equal(url.searchParams.get("prompt"), "consent");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    const swapped = new URLSearchParams({
        code: "c",
        state: signIn.state,
        iss: "https://evil.example",
    });
    await assert.rejects(completeDirectSignIn(c, signIn, swapped), /iss/);
    const ok = new URLSearchParams({ code: "c", state: signIn.state, iss: ISSUER_METADATA.issuer });
    assert.equal((await completeDirectSignIn(c, signIn, ok)).refresh_token, "rt");
});

test("Direct Sign-In pushes the request when the issuer offers PAR", async () => {
    const c = await client(
        {
            "https://auth.example.com/oauth/par": json(
                { request_uri: "urn:example:abc", expires_in: 60 },
                201,
            ),
        },
        { pushed_authorization_request_endpoint: "https://auth.example.com/oauth/par" },
    );
    const url = new URL(
        (
            await startDirectSignIn(c, {
                redirectUri: "https://agent.example/cb",
                scope: "orders:read",
            })
        ).url,
    );
    assert.deepEqual([...url.searchParams.keys()].sort(), ["client_id", "request_uri"]);
});

test("Device Sign-In refuses a link on another Company's host, and polls", async () => {
    const device = {
        device_code: "d",
        user_code: "WDJB-MJHT",
        verification_uri: "https://evil.example/device",
        expires_in: 600,
        interval: 5,
    };
    const bad = await client({ [ISSUER_METADATA.device_authorization_endpoint]: device });
    await assert.rejects(
        startDeviceSignIn(bad, { scope: "orders:read", domain: "example.com" }),
        /isn't on the Company's hosts/,
    );
    let polls = 0;
    const good = await client({
        [ISSUER_METADATA.device_authorization_endpoint]: {
            ...device,
            verification_uri: "https://auth.example.com/device",
        },
        [ISSUER_METADATA.token_endpoint]: () =>
            ++polls === 1
                ? json({ error: "authorization_pending" }, 400)
                : polls === 2
                  ? json({ error: "slow_down" }, 400)
                  : json({ access_token: "at", token_type: "Bearer", expires_in: 300 }),
    });
    const started = await startDeviceSignIn(good, { scope: "orders:read", domain: "example.com" });
    assert.deepEqual(await pollDeviceSignIn(good, started, 5), { status: "pending" });
    assert.deepEqual(await pollDeviceSignIn(good, started, 5), {
        status: "slow_down",
        interval: 10,
    });
    assert.equal((await pollDeviceSignIn(good, started, 10)).status, "done");
});

test("OAuth errors surface as PoppyError codes", async () => {
    const c = await client({
        [ISSUER_METADATA.token_endpoint]: json({ error: "access_denied" }, 400),
    });
    const started = {
        device_code: "d",
        user_code: "u",
        verification_uri: "https://auth.example.com/device",
        expires_in: 1,
    };
    await assert.rejects(
        pollDeviceSignIn(c, started, 5),
        (e: unknown) => e instanceof PoppyError && e.code === "access_denied",
    );
});
