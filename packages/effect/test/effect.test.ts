import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestNetwork } from "@personal-agent-protocol/sdk/testing";
import { Effect, Stream } from "effect";
import { CurrentSession, PoppyAgent, PoppyCompany, withSession } from "../src/index.ts";

test("a conversation through the Effect API", async () => {
    const net = await createTestNetwork();
    const program = Effect.gen(function* () {
        const agent = yield* PoppyAgent;
        const company = yield* agent.discover(net.domain);
        const session = company.session({ userId: "usr_1" });
        const conversations = yield* session.conversations();
        const convo = yield* conversations.start("Return my jacket");
        yield* convo.close;
        const events = yield* Stream.runCollect(convo.events());
        return Array.from(events).flatMap((e) => (e.type === "message" ? [e.message.text] : []));
    });
    const texts = await Effect.runPromise(
        program.pipe(
            Effect.provide(
                PoppyAgent.layer({
                    clientId: net.clientId,
                    key: net.key,
                    http: { fetch: net.fetch },
                }),
            ),
        ),
    );
    assert.deepEqual(texts, ["Return my jacket", "echo: Return my jacket"]);
});

test("wire errors are tagged errors", async () => {
    const net = await createTestNetwork();
    const program = Effect.gen(function* () {
        const company = yield* (yield* PoppyAgent).discover(net.domain);
        const conversations = yield* company.session({ userId: "usr_1" }).conversations();
        return yield* conversations.get("cnv_missing").read();
    }).pipe(
        Effect.as("read"),
        Effect.catchTag("ConversationNotFound", (e) => Effect.succeed(e.code)),
    );
    const result = await Effect.runPromise(
        program.pipe(
            Effect.provide(
                PoppyAgent.layer({
                    clientId: net.clientId,
                    key: net.key,
                    http: { fetch: net.fetch },
                }),
            ),
        ),
    );
    assert.equal(result, "conversation_not_found");
});

test("withSession verifies the request and answers Poppy errors with their responses", async () => {
    const net = await createTestNetwork();
    const company = PoppyCompany.layer({
        identifier: `https://${net.domain}`,
        versions: ["1.0"],
        http: { fetch: net.fetch },
    });
    const handler = (request: Request) =>
        withSession(
            request,
            Effect.gen(function* () {
                const session = yield* CurrentSession;
                return Response.json({ user: session.userId });
            }),
        );
    const missing = await Effect.runPromise(
        handler(
            new Request(`https://${net.domain}/api`, { headers: { "poppy-version": "1.0" } }),
        ).pipe(Effect.provide(company)),
    );
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), { error: "invalid_session" });

    let ok: Response | undefined;
    const throughHandler = async (url: string, init?: RequestInit) => {
        ok = await Effect.runPromise(handler(new Request(url, init)).pipe(Effect.provide(company)));
        return ok.clone();
    };
    const agent = net.agent({
        http: {
            fetch: (url, init) =>
                url.endsWith("/api") ? throughHandler(url, init) : net.fetch(url, init),
        },
    });
    await (await agent.discover(net.domain))
        .session({ userId: "usr_9" })
        .fetch(`https://${net.domain}/api`);
    assert.equal(ok?.status, 200);
    assert.deepEqual(await ok?.json(), { user: "usr_9" });
});
