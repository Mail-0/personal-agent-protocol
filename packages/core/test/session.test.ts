import assert from "node:assert/strict";
import { test } from "node:test";
import { ath, generateKey, generateRsaKey, thumbprint } from "../src/jose.ts";
import {
    createSessionVerifier,
    newSessionId,
    signDelegation,
    signSessionJwt,
    type SessionRequest,
} from "../src/session.ts";
import { PoppyError } from "../src/errors.ts";
import { fakeFetch } from "./fake.ts";

const CLIENT_ID = "https://agent.example/agent.json";
const AUDIENCE = "https://auth.example.com";
const URL_ = "https://api.example.com/orders/ord_7Hk2/exchanges";

async function agent(rsa = false) {
    const root = rsa ? await generateRsaKey() : await generateKey();
    root.publicJwk.kid = "root-1";
    const delegated = await generateKey();
    const delegation = await signDelegation({
        root,
        delegated: delegated.publicJwk,
        clientId: CLIENT_ID,
    });
    const fetch = fakeFetch({
        [CLIENT_ID]: { client_id: CLIENT_ID, jwks_uri: "https://agent.example/jwks.json" },
        "https://agent.example/jwks.json": { keys: [root.publicJwk] },
    });
    return { root, delegated, delegation, fetch };
}

async function request(
    a: Awaited<ReturnType<typeof agent>>,
    overrides: Partial<Parameters<typeof signSessionJwt>[0]> = {},
): Promise<SessionRequest> {
    const session = await signSessionJwt({
        key: a.delegated,
        delegation: a.delegation,
        clientId: CLIENT_ID,
        audience: AUDIENCE,
        sid: newSessionId(),
        userId: "usr_Q7c1vK",
        method: "post",
        url: `${URL_}?x=1`,
        ...overrides,
    });
    return {
        session,
        version: "1.0",
        method: "POST",
        url: URL_,
        accessToken: overrides.accessToken,
    };
}

function verifier(a: Awaited<ReturnType<typeof agent>>) {
    return createSessionVerifier({
        identifier: AUDIENCE,
        versions: ["1.0"],
        http: { fetch: a.fetch },
    });
}

async function rejects(promise: Promise<unknown>, code: string, match?: RegExp) {
    await assert.rejects(promise, (e: unknown) => {
        assert.ok(e instanceof PoppyError);
        assert.equal(e.code, code);
        if (match) assert.match(e.message, match);
        return true;
    });
}

test("a Session JWT signed with a delegated key verifies", async () => {
    const a = await agent();
    const verified = await verifier(a)(await request(a));
    assert.equal(verified.clientId, CLIENT_ID);
    assert.equal(verified.userId, "usr_Q7c1vK");
    assert.equal(verified.signedIn, false);
    assert.equal(verified.keyThumbprint, await thumbprint(a.delegated.publicJwk));
});

test("a PS384 delegation verifies, as blind signing produces (spec 10.7)", async () => {
    const a = await agent(true);
    assert.equal((await verifier(a)(await request(a))).clientId, CLIENT_ID);
});

test("ath ties the JWT to the access token", async () => {
    const a = await agent();
    const verify = verifier(a);
    const signed = await request(a, { accessToken: "token-1" });
    assert.equal((await verify(signed)).signedIn, true);
    await rejects(verify({ ...signed, accessToken: "token-2" }), "invalid_session", /ath/);
    await rejects(verify({ ...signed, accessToken: undefined }), "invalid_session", /ath/);
    await rejects(
        verify({ ...signed, tokenClientId: "https://other.example/agent.json" }),
        "invalid_session",
    );
    assert.equal(
        JSON.parse(atob(signed.session!.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).ath,
        await ath("token-1"),
    );
});

test("the claims must match the request and the Company", async () => {
    const a = await agent();
    const verify = verifier(a);
    const signed = await request(a);
    await rejects(verify({ ...signed, method: "GET" }), "invalid_session", /htm/);
    await rejects(
        verify({ ...signed, url: "https://api.example.com/other" }),
        "invalid_session",
        /htu/,
    );
    await rejects(
        verify(await request(a, { audience: "https://other.example" })),
        "invalid_session",
        /aud/,
    );
    await rejects(
        verify(await request(a, { iat: Math.floor(Date.now() / 1000) - 600 })),
        "invalid_session",
        /iat/,
    );
});

test("Poppy-Version is required and must be compatible (spec 3.4)", async () => {
    const a = await agent();
    const verify = verifier(a);
    const signed = await request(a);
    await rejects(verify({ ...signed, version: undefined }), "version_unsupported");
    await rejects(verify({ ...signed, version: "2.0" }), "version_unsupported");
    assert.ok(await verify({ ...signed, version: "1.3" }));
});

test("a delegation from a key outside jwks_uri, or an expired one, is rejected", async () => {
    const a = await agent();
    const stranger = await generateKey();
    stranger.publicJwk.kid = "root-1";
    const forged = await signDelegation({
        root: stranger,
        delegated: a.delegated.publicJwk,
        clientId: CLIENT_ID,
    });
    await rejects(
        verifier(a)(await request(a, { delegation: forged })),
        "invalid_session",
        /signature/,
    );
    const old = await signDelegation({
        root: a.root,
        delegated: a.delegated.publicJwk,
        clientId: CLIENT_ID,
        iat: Math.floor(Date.now() / 1000) - 7200,
        lifetime: 3600,
    });
    await rejects(verifier(a)(await request(a, { delegation: old })), "invalid_session", /expired/);
    await assert.rejects(
        signDelegation({
            root: a.root,
            delegated: a.delegated.publicJwk,
            clientId: CLIENT_ID,
            lifetime: 90000,
        }),
        RangeError,
    );
});

test("a Session JWT signed directly with a jwks_uri key is rejected", async () => {
    const a = await agent();
    const signed = await request(a, { key: a.root as never });
    await rejects(verifier(a)(signed), "invalid_session");
});

test("client metadata is fetched without following redirects, and keys are cached", async () => {
    const a = await agent();
    const verify = verifier(a);
    await verify(await request(a));
    await verify(await request(a));
    assert.equal(a.fetch.calls.length, 2);
    const moved = fakeFetch({
        [CLIENT_ID]: () =>
            new Response(null, {
                status: 302,
                headers: { location: "https://agent.example/other.json" },
            }),
    });
    const v = createSessionVerifier({
        identifier: AUDIENCE,
        versions: ["1.0"],
        http: { fetch: moved },
    });
    await rejects(v(await request(a)), "invalid_response", /redirected/);
});
