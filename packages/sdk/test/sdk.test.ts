import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryTokenStore, PoppyError, type Event } from "../src/index.ts";
import { createTestNetwork } from "../src/testing.ts";

async function collect(events: AsyncGenerator<Event>, limit = 50): Promise<Event[]> {
    const out: Event[] = [];
    for await (const e of events) {
        out.push(e);
        if (out.length >= limit) break;
    }
    return out;
}

function texts(events: Event[]): string[] {
    return events.flatMap((e) =>
        e.type === "message" ? [`${e.message.role}:${e.message.text}`] : [],
    );
}

for (const stream of [true, false]) {
    test(`a conversation from start to close (${stream ? "streamed" : "long-polled"})`, async () => {
        const net = await createTestNetwork({ stream });
        const company = await net.agent().discover("company.test");
        assert.equal(company.identifier, "https://company.test");
        const session = company.session({ userId: "usr_1" });
        const convo = await session.conversations().start("Return my jacket");
        await convo.send("Size M please");
        await convo.close();
        const events = await collect(convo.events());
        assert.deepEqual(texts(events), [
            "user:Return my jacket",
            "company:echo: Return my jacket",
            "user:Size M please",
            "company:echo: Size M please",
        ]);
        assert.equal(convo.state.closed, true);
        assert.ok(net.sessions.every((s) => s.sid === session.sid && s.userId === "usr_1"));
    });
}

test("events resume from the cursor without repeats", async () => {
    const net = await createTestNetwork({ stream: false });
    const session = (await net.agent().discover("company.test")).session({ userId: "usr_1" });
    const convo = await session.conversations().start("hi");
    const first = await convo.read();
    assert.equal(first.events.length, 2);
    net.say(convo.id, "anything else?");
    await convo.close();
    const rest = await collect(convo.events());
    assert.deepEqual(texts(rest), ["user:hi", "company:echo: hi", "company:anything else?"]);
    const resumed = await collect(session.conversations().get(convo.id).events());
    assert.equal(texts(resumed).length, 3);
});

test("session_ended starts a new Session and sends the request again once (spec 5.5)", async () => {
    const net = await createTestNetwork();
    const session = (await net.agent().discover("company.test")).session({ userId: "usr_1" });
    await session.tasks();
    const first = session.sid;
    net.endSession(first);
    await session.tasks();
    assert.notEqual(session.sid, first);
    assert.equal(net.sessions.at(-1)?.sid, session.sid);
});

test("a 429 is waited out (spec 5.6)", async () => {
    const net = await createTestNetwork();
    let limited = 0;
    const waits: number[] = [];
    const agent = net.agent({
        http: {
            fetch: async (url, init) => {
                if (url.endsWith("/poppy/tasks") && limited++ === 0)
                    return new Response("", { status: 429, headers: { "retry-after": "2" } });
                return net.fetch(url, init);
            },
        },
        sleep: async (ms) => void waits.push(ms),
    });
    const tasks = await (await agent.discover("company.test")).session({ userId: "u" }).tasks();
    assert.equal(tasks.excluded_tasks?.[0].task, "Close an account");
    assert.deepEqual(waits, [2000]);
});

test("conversations belong to the User who started them (spec 8.2)", async () => {
    const net = await createTestNetwork();
    const company = await net.agent().discover("company.test");
    const convo = await company.session({ userId: "usr_1" }).conversations().start("mine");
    const other = company.session({ userId: "usr_2" }).conversations().get(convo.id);
    await assert.rejects(
        other.read(),
        (e: unknown) => e instanceof PoppyError && e.code === "conversation_not_found",
    );
});

test("a retried request ID returns the original response (spec 8.3)", async () => {
    const net = await createTestNetwork();
    const session = (await net.agent().discover("company.test")).session({ userId: "usr_1" });
    const endpoint = net.poppy.agent!.protocols[0].endpoint;
    const body = { id: "req_1", message: { author: { type: "agent" }, text: "hello" } };
    const a = await session.request<{ conversation_id: string }>("POST", endpoint, body);
    const b = await session.request<{ conversation_id: string }>("POST", endpoint, body);
    assert.equal(a.json.conversation_id, b.json.conversation_id);
    assert.equal(net.conversations.size, 1);
    await assert.rejects(
        session.request("POST", endpoint, {
            ...body,
            message: { author: { type: "agent" }, text: "changed" },
        }),
        (e: unknown) => e instanceof PoppyError && e.code === "request_id_conflict",
    );
});

test("each User ID gets its own delegated key (spec 5.2)", async () => {
    const net = await createTestNetwork();
    const company = await net.agent().discover("company.test");
    await company.session({ userId: "a" }).tasks();
    await company.session({ userId: "a" }).tasks();
    await company.session({ userId: "b" }).tasks();
    const [a1, a2, b] = net.sessions.map((s) => s.keyThumbprint);
    assert.equal(a1, a2);
    assert.notEqual(a1, b);
});

test("signed-in requests carry the access token, bound by ath (spec 5.2)", async () => {
    const net = await createTestNetwork();
    const tokens = memoryTokenStore();
    await tokens.set("https://company.test", "usr_1", { accessToken: "at_1" });
    const session = (await net.agent({ tokens }).discover("company.test")).session({
        userId: "usr_1",
    });
    await session.conversations().start("hi");
    assert.equal(net.sessions.at(-1)?.signedIn, true);
    await session.tasks();
    assert.equal(
        net.sessions.at(-1)?.signedIn,
        false,
        "tasks are fetched with no access token (spec 9)",
    );
});

test("tasks, feedback, and browser join", async () => {
    const net = await createTestNetwork();
    const session = (await net.agent().discover("company.test")).session({ userId: "usr_1" });
    await session.feedback({
        task: "Pay with a gift card",
        description: "No interface applies gift cards.",
    });
    assert.deepEqual(net.feedback, [
        { task: "Pay with a gift card", description: "No interface applies gift cards." },
    ]);
    await session.authorizeBrowser("code_123");
    assert.deepEqual(net.authorizedCodes, ["code_123"]);
});

test("the Company rejects a request without a Session header", async () => {
    const net = await createTestNetwork();
    const response = await net.fetch("https://api.company.test/poppy/tasks", {
        headers: { "poppy-version": "1.0" },
    });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: string }).error, "invalid_session");
});
