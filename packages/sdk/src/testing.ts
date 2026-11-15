// An in-memory network for testing a Personal Agent without sending anything: a hosted agent
// identity, and a Company that serves poppy.json, conversations, tasks, feedback, and browser join,
// verifying every Session header with createCompany.

import {
    errorResponse,
    generateKey,
    PoppyError,
    randomId,
    validate,
    type Event,
    type FetchLike,
    type Message,
    type Poppy,
    type SigningKey,
    type VerifiedSession,
} from "@personal-agent-protocol/core";
import { createAgent, type Agent, type AgentOptions } from "./agent.ts";
import { createCompany } from "./company.ts";

export type TestConversation = {
    id: string;
    owner: string;
    events: Event[];
    handoff: "none" | "pending";
    responder: "agent" | "human";
    closed: boolean;
};

export type TestNetworkOptions = {
    // Replies to each message the Personal Agent sends. Defaults to echoing its text.
    reply?: (message: Message, conversation: TestConversation) => string | undefined;
    // Whether the Company streams events (spec 8.6). Defaults to true.
    stream?: boolean;
};

export type TestNetwork = {
    fetch: FetchLike;
    clientId: string;
    key: SigningKey;
    domain: string;
    poppy: Poppy;
    conversations: Map<string, TestConversation>;
    sessions: VerifiedSession[];
    feedback: unknown[];
    authorizedCodes: string[];
    // Ends a Session, so its next request gets session_ended (spec 5.5).
    endSession(sid: string): void;
    // Adds a Company message to a conversation.
    say(conversationId: string, text: string): void;
    // An Agent wired to this network.
    agent(options?: Partial<AgentOptions>): Agent;
};

const DOMAIN = "company.test";
const API = "https://api.company.test";
const CLIENT_ID = "https://agent.test/agent.json";

export async function createTestNetwork(options: TestNetworkOptions = {}): Promise<TestNetwork> {
    const key = await generateKey();
    key.publicJwk.kid = "test-root";
    const ended = new Set<string>();
    const conversations = new Map<string, TestConversation>();
    const requests = new Map<string, { signature: string; response: Response }>();
    const sessions: VerifiedSession[] = [];
    const feedback: unknown[] = [];
    const authorizedCodes: string[] = [];
    const reply = options.reply ?? ((m) => (m.text ? `echo: ${m.text}` : undefined));
    const poppy: Poppy = {
        protocol_version: "1.0",
        organization: { name: "Test Company", domain: DOMAIN },
        agent: {
            protocols: [
                { type: "poppy", endpoint: `${API}/poppy/conversations`, description: "Anything" },
            ],
        },
        web: { browser_session_endpoint: `https://${DOMAIN}/poppy/browser-session` },
        tasks: { endpoint: `${API}/poppy/tasks` },
    };

    const network: TestNetwork = {
        fetch: undefined as unknown as FetchLike,
        clientId: CLIENT_ID,
        key,
        domain: DOMAIN,
        poppy,
        conversations,
        sessions,
        feedback,
        authorizedCodes,
        endSession: (sid) => ended.add(sid),
        say: (id, text) => record(conversations.get(id)!, companyMessage(text)),
        agent: (overrides = {}) =>
            createAgent({
                clientId: CLIENT_ID,
                key,
                http: { fetch: network.fetch },
                sleep: async () => undefined,
                ...overrides,
            }),
    };

    let fetchImpl: FetchLike;
    const company = createCompany({
        identifier: `https://${DOMAIN}`,
        versions: ["1.0"],
        isEnded: (s) => ended.has(s.sid),
        http: { fetch: (url, init) => fetchImpl(url, init) },
    });

    const handle = company.handle(async (request, session) => {
        sessions.push(session);
        const url = new URL(request.url);
        const owner = `${session.clientId}\n${session.userId}`;
        const base = "/poppy/conversations";
        if (url.pathname === "/poppy/tasks" && request.method === "GET") {
            return json({
                excluded_tasks: [{ task: "Close an account" }],
                feedback: { endpoint: `${API}/poppy/feedback` },
            });
        }
        if (url.pathname === "/poppy/feedback" && request.method === "POST") {
            feedback.push(validate("feedback-report.schema.json", await request.json()));
            return new Response(null, { status: 204 });
        }
        if (url.pathname === "/poppy/browser-session/authorize" && request.method === "POST") {
            authorizedCodes.push(
                validate<{ code: string }>(
                    "browser-session-authorize.schema.json",
                    await request.json(),
                ).code,
            );
            return new Response(null, { status: 204 });
        }
        if (!url.pathname.startsWith(base)) return new Response("not found", { status: 404 });
        const [id, action, sub] = url.pathname
            .slice(base.length)
            .split("/")
            .filter(Boolean)
            .map(decodeURIComponent);

        if (request.method === "GET" && action === "events") {
            const conversation = owned(id, owner);
            const cursor =
                request.headers.get("last-event-id") ?? url.searchParams.get("cursor") ?? undefined;
            const start =
                cursor === undefined
                    ? 0
                    : conversation.events.findIndex((e) => e.id === cursor) + 1;
            if (cursor !== undefined && start === 0) throw new PoppyError("invalid_cursor");
            const events = conversation.events.slice(start);
            if (
                /text\/event-stream/.test(request.headers.get("accept") ?? "") &&
                options.stream !== false
            ) {
                const text = [
                    `event: working\ndata: {"working":false}\n\n`,
                    ...events.map((e) => `id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`),
                ].join("");
                return new Response(text, { headers: { "content-type": "text/event-stream" } });
            }
            return json(read(conversation, events, cursor ?? null));
        }
        if (request.method !== "POST") return new Response("not found", { status: 404 });

        const body = (await request.json()) as Record<string, unknown>;
        const path = url.pathname;
        const requestKey = `${owner}\n${String(body.id)}`;
        const signature = JSON.stringify([path, body]);
        const earlier = requests.get(requestKey);
        if (earlier) {
            if (earlier.signature !== signature) throw new PoppyError("request_id_conflict");
            return earlier.response.clone();
        }
        let response: Response;
        if (id === undefined) {
            validate("conversation-request.schema.json", body);
            const conversation: TestConversation = {
                id: `cnv_${randomId(9)}`,
                owner,
                events: [],
                handoff: "none",
                responder: "agent",
                closed: false,
            };
            conversations.set(conversation.id, conversation);
            accept(conversation, String(body.id), body.message as Message);
            response = json({ conversation_id: conversation.id }, 201);
        } else {
            const conversation = owned(id, owner);
            if (conversation.closed && action !== "close")
                throw new PoppyError("conversation_closed");
            if (action === "messages") {
                validate("conversation-message-request.schema.json", body);
                accept(conversation, String(body.id), body.message as Message);
            } else if (action === "handoff" && sub === "cancel") {
                setState(conversation, { handoff: "none" });
            } else if (action === "handoff") {
                setState(conversation, { handoff: "pending" });
            } else if (action === "close") {
                if (!conversation.closed) setState(conversation, { closed: true });
            } else {
                return new Response("not found", { status: 404 });
            }
            response = json({ conversation_id: conversation.id }, 202);
        }
        requests.set(requestKey, { signature, response: response.clone() });
        return response;
    });

    function owned(id: string, owner: string): TestConversation {
        const conversation = conversations.get(id);
        if (!conversation || conversation.owner !== owner)
            throw new PoppyError("conversation_not_found");
        return conversation;
    }

    function accept(conversation: TestConversation, requestId: string, message: Message) {
        record(conversation, { ...message, id: requestId, role: "user" });
        const text = reply(message, conversation);
        if (text) record(conversation, companyMessage(text, requestId));
    }

    function setState(conversation: TestConversation, change: Partial<TestConversation>) {
        Object.assign(conversation, change);
        conversation.events.push({
            id: `evt_${randomId(9)}`,
            type: "state",
            created_at: new Date().toISOString(),
            handoff: conversation.handoff,
            responder: conversation.responder,
            closed: conversation.closed,
        } as Event);
    }

    fetchImpl = async (url, init) => {
        const request = new Request(url, init);
        const { origin, pathname } = new URL(url);
        if (url === CLIENT_ID)
            return json({
                client_id: CLIENT_ID,
                client_name: "Test Agent",
                jwks_uri: "https://agent.test/jwks.json",
                redirect_uris: ["https://agent.test/callback"],
                token_endpoint_auth_method: "private_key_jwt",
            });
        if (url === "https://agent.test/jwks.json") return json({ keys: [key.publicJwk] });
        if (origin === `https://${DOMAIN}` && pathname === "/.well-known/poppy.json")
            return company.discoveryResponse(poppy);
        if (origin === API || (origin === `https://${DOMAIN}` && pathname.startsWith("/poppy/")))
            return handle(request);
        return errorResponse(new PoppyError("http_error", undefined, { status: 404 }));
    };
    network.fetch = fetchImpl;
    return network;
}

function record(conversation: TestConversation, message: Message) {
    conversation.events.push({
        id: `evt_${randomId(9)}`,
        type: "message",
        created_at: new Date().toISOString(),
        message,
    } as Event);
}

function companyMessage(text: string, asOf?: string): Message {
    return {
        id: `msg_${randomId(9)}`,
        role: "company",
        author: { type: "agent" },
        text,
        ...(asOf ? { as_of_request: asOf } : {}),
    };
}

function read(conversation: TestConversation, events: Event[], cursor: string | null) {
    return {
        conversation_id: conversation.id,
        events,
        cursor: events.at(-1)?.id ?? cursor,
        has_more: false,
        working: false,
        handoff: conversation.handoff,
        responder: conversation.responder,
        closed: conversation.closed,
    };
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}
