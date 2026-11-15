import assert from "node:assert/strict";
import { test } from "node:test";
import { assertUsableUrl, blockedAddress } from "../src/address.ts";
import { b64url, b64urlDecode, fromUtf8, randomId } from "../src/encoding.ts";
import { errorFromResponse, errorResponse, PoppyError } from "../src/errors.ts";
import { formatExtensions, parseExtensions } from "../src/headers.ts";
import { parseServerSentEvents } from "../src/sse.ts";
import { schemaErrors } from "../src/validate.ts";
import { POPPY } from "./fake.ts";

test("base64url round-trips, and IDs are 22 characters", () => {
    assert.equal(fromUtf8(b64urlDecode(b64url("héllo?>"))), "héllo?>");
    assert.match(randomId(), /^[A-Za-z0-9_-]{22}$/);
});

test("non-public addresses are blocked", () => {
    for (const a of [
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.1",
        "192.168.1.1",
        "169.254.169.254",
        "::1",
        "fe80::1",
        "fd00::1",
        "::ffff:10.0.0.1",
    ])
        assert.ok(blockedAddress(a), a);
    for (const a of ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946", "example.com"])
        assert.equal(blockedAddress(a), undefined, a);
});

test("errors are read from JSON bodies, challenges, and 429s", async () => {
    const e1 = await errorFromResponse(new Response('{"error":"session_ended"}', { status: 400 }));
    assert.equal(e1?.code, "session_ended");
    const e2 = await errorFromResponse(
        new Response("", {
            status: 403,
            headers: {
                "www-authenticate": 'Bearer error="insufficient_scope", scope="orders:write"',
            },
        }),
    );
    assert.equal(e2?.code, "insufficient_scope");
    assert.equal(e2?.challenges[0].params.scope, "orders:write");
    const e3 = await errorFromResponse(
        new Response("", { status: 429, headers: { "retry-after": "7" } }),
    );
    assert.equal(e3?.retryAfter, 7);
    assert.equal(await errorFromResponse(new Response("{}")), undefined);
});

test("error responses carry the status and code", async () => {
    const response = errorResponse(
        new PoppyError("version_mismatch", undefined, { body: { protocol_version: "1.0" } }),
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "version_mismatch", protocol_version: "1.0" });
});

test("Poppy-Extensions round-trips as an RFC 9651 list", () => {
    const header = formatExtensions({ operations: "3", links: "1" });
    assert.equal(header, '"operations";v="3", "links";v="1"');
    assert.deepEqual(parseExtensions(header), { operations: "3", links: "1" });
    assert.deepEqual(parseExtensions("operations;v=3"), {});
});

test("server-sent events parse, including unnamed and multi-line data", async () => {
    const text =
        'id: evt_c2\ndata: {"a":1}\n\nevent: working\ndata: {"working":false}\n\n: comment\nevent: text-delta\ndata: one\ndata: two\n\n';
    const body = new Response(text).body!;
    const events = [];
    for await (const e of parseServerSentEvents(body)) events.push(e);
    assert.deepEqual(events, [
        { id: "evt_c2", event: "message", data: '{"a":1}' },
        { event: "working", data: '{"working":false}' },
        { event: "text-delta", data: "one\ntwo" },
    ]);
});

test("documents validate against the protocol's schemas", () => {
    assert.deepEqual(schemaErrors("poppy.schema.json", POPPY), []);
    assert.ok(schemaErrors("poppy.schema.json", { protocol_version: "1" }).length);
});

test("IPv4-mapped IPv6 in hex form is blocked", async () => {
    assert.ok(blockedAddress("::ffff:7f00:1"));
    assert.ok(blockedAddress("::ffff:a00:1"));
    assert.equal(blockedAddress("::ffff:5db8:d822"), undefined);
    await assert.rejects(assertUsableUrl("https://[::ffff:127.0.0.1]/"), /loopback/);
});

test("a CRLF split across chunks doesn't end an event early", async () => {
    const chunks = ["data: a\r", "\ndata: b\r\n\r\n"].map((c) => new TextEncoder().encode(c));
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const c of chunks) controller.enqueue(c);
            controller.close();
        },
    });
    const events = [];
    for await (const e of parseServerSentEvents(body)) events.push(e);
    assert.deepEqual(events, [{ event: "message", data: "a\nb" }]);
});

test("a PoppyError's description reaches its response", async () => {
    const response = errorResponse(
        new PoppyError("invalid_session", "aud isn't this Company's identifier"),
    );
    assert.deepEqual(await response.json(), {
        error: "invalid_session",
        error_description: "aud isn't this Company's identifier",
    });
});

test("Poppy-Extensions: the last v wins, and a trailing comma declares none", () => {
    assert.deepEqual(parseExtensions('"operations";v="2";v="3"'), { operations: "3" });
    assert.deepEqual(parseExtensions('"operations";v="3",'), {});
});
