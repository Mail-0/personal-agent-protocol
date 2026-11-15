// Conversations with the Company Agent (spec 8): starting them, sending messages, and reading
// events by long-polling or streaming, with dedupe, cursors, and reconnects handled.

import {
    errorFromResponse,
    parseServerSentEvents,
    PoppyError,
    randomId,
    validate,
    type Event,
    type EventsResponse,
    type Message,
} from "@personal-agent-protocol/core";
import type { Session } from "./agent.ts";

// A message as the Personal Agent sends it: the Company sets id and role (spec 8.4).
export type OutgoingMessage = Omit<Message, "id" | "role" | "author"> & {
    author?: Message["author"];
};

export type ConversationState = Pick<
    EventsResponse,
    "working" | "handoff" | "responder" | "closed"
>;

// The event types this version defines. Others are skipped (spec 8.5).
const KNOWN_EVENTS = new Set([
    "message",
    "state",
    "authorization",
    "user_requested",
    "direct_opened",
    "direct_closed",
]);

export class Conversations {
    readonly session: Session;
    readonly endpoint: string;

    constructor(session: Session, endpoint: string) {
        this.session = session;
        this.endpoint = endpoint.replace(/\/+$/, "");
    }

    // Starts a conversation with its first message (spec 8.3).
    async start(message: OutgoingMessage | string): Promise<Conversation> {
        const { conversation_id } = await post(this.session, this.endpoint, {
            message: outgoing(message),
        });
        return new Conversation(this, conversation_id);
    }

    // A conversation already started, such as one from an earlier Session (spec 8.2).
    get(id: string): Conversation {
        return new Conversation(this, id);
    }
}

export type EventsOptions = {
    // Seconds the Company may hold each read (spec 8.5). Defaults to 30.
    wait?: number;
    // Ask for server-sent events (spec 8.6). Defaults to true; falls back to reads when the Company
    // doesn't stream.
    stream?: boolean;
    // Pieces of a Company message as it's written, replaced by its complete message event.
    onTextDelta?: (delta: { message_id: string; text: string }) => void;
    signal?: AbortSignal;
};

export class Conversation {
    readonly id: string;
    readonly #conversations: Conversations;
    #seen = new Set<string>();
    // The last event handled, for the next read (spec 8.5).
    cursor?: string;
    state: ConversationState = {
        working: false,
        handoff: "none",
        responder: "agent",
        closed: false,
    };

    constructor(conversations: Conversations, id: string) {
        this.#conversations = conversations;
        this.id = id;
    }

    get #url(): string {
        return `${this.#conversations.endpoint}/${encodeURIComponent(this.id)}`;
    }

    get #session(): Session {
        return this.#conversations.session;
    }

    // Sends another message (spec 8.3).
    async send(message: OutgoingMessage | string): Promise<void> {
        await post(this.#session, `${this.#url}/messages`, { message: outgoing(message) });
    }

    // Asks for a person at the Company (spec 8.9).
    async handoff(): Promise<void> {
        await post(this.#session, `${this.#url}/handoff`, {});
    }

    async cancelHandoff(): Promise<void> {
        await post(this.#session, `${this.#url}/handoff/cancel`, {});
    }

    // Closes the conversation (spec 8.12).
    async close(): Promise<void> {
        await post(this.#session, `${this.#url}/close`, {});
    }

    // One read of the events after `cursor` (spec 8.5).
    async read(options: { cursor?: string; wait?: number } = {}): Promise<EventsResponse> {
        const url = new URL(`${this.#url}/events`);
        if (options.cursor) url.searchParams.set("cursor", options.cursor);
        if (options.wait !== undefined) url.searchParams.set("wait", String(options.wait));
        const { json } = await this.#session.request("GET", url.toString());
        return validate<EventsResponse>("events-response.schema.json", json);
    }

    // Every new event, in order, until the conversation closes or the loop is broken. Events seen
    // before are skipped, unknown types are skipped, and state is kept in `state`.
    async *events(options: EventsOptions = {}): AsyncGenerator<Event> {
        let stream = options.stream ?? true;
        let transportFailures = 0;
        while (!options.signal?.aborted) {
            try {
                if (stream) {
                    const result = yield* this.#streamOnce(options);
                    if (result === "events") transportFailures = 0;
                    if (result === "unsupported") stream = false;
                    else if (this.state.closed) return;
                    if (result !== "empty") continue;
                }
                const response = await this.read({ cursor: this.cursor, wait: options.wait ?? 30 });
                for (const event of response.events) {
                    const handled = this.#handle(event);
                    if (handled) yield handled;
                }
                transportFailures = 0;
                if (response.cursor) this.cursor = response.cursor;
                if (response.has_more) continue;
                this.state = pickState(response);
                if (this.state.closed) return;
            } catch (error) {
                if (error instanceof PoppyError && error.code === "cursor_expired") {
                    this.cursor = undefined;
                    continue;
                }
                // A dropped connection reconnects from the saved cursor, up to 3 times in a row.
                if (
                    !(error instanceof PoppyError) &&
                    !options.signal?.aborted &&
                    ++transportFailures <= 3
                )
                    continue;
                throw error;
            }
        }
    }

    async *#streamOnce(
        options: EventsOptions,
    ): AsyncGenerator<Event, "unsupported" | "empty" | "events"> {
        const headers: Record<string, string> = { accept: "text/event-stream" };
        if (this.cursor) headers["last-event-id"] = this.cursor;
        const response = await this.#session.fetch(`${this.#url}/events`, {
            headers,
            ...(options.signal ? { signal: options.signal } : {}),
        });
        if (!response.ok) throw await errorFromResponse(response);
        if (!/^text\/event-stream/i.test(response.headers.get("content-type") ?? "")) {
            await response.body?.cancel();
            return "unsupported";
        }
        let any = false;
        for await (const sse of parseServerSentEvents(response.body!)) {
            if (sse.event === "working") {
                this.state = { ...this.state, working: Boolean(JSON.parse(sse.data).working) };
            } else if (sse.event === "text-delta") {
                options.onTextDelta?.(JSON.parse(sse.data));
            } else if (sse.event === "message") {
                const handled = this.#handle(
                    validate<Event>("event.schema.json", JSON.parse(sse.data)),
                );
                any = true;
                if (handled) yield handled;
            }
        }
        return any ? "events" : "empty";
    }

    #handle(event: Event): Event | undefined {
        this.cursor = event.id;
        if (this.#seen.has(event.id)) return undefined;
        this.#seen.add(event.id);
        if (event.type === "state") {
            const { handoff, responder, closed } = event;
            this.state = { ...this.state, handoff, responder, closed };
        }
        return KNOWN_EVENTS.has(event.type) ? event : undefined;
    }
}

function pickState(
    source: Omit<ConversationState, "working"> & { working?: boolean },
): ConversationState {
    const { working, handoff, responder, closed } = source;
    return { working: working ?? false, handoff, responder, closed };
}

function outgoing(message: OutgoingMessage | string): Message {
    const value = typeof message === "string" ? { text: message } : message;
    return { author: { type: "agent" }, ...value };
}

// A POST with a fresh request ID, sent again with the same ID once after a network error, so a
// retry is safe (spec 8.3).
async function post(
    session: Session,
    url: string,
    body: Record<string, unknown>,
): Promise<{ conversation_id: string }> {
    const payload = { id: randomId(16), ...body };
    try {
        return (await session.request<{ conversation_id: string }>("POST", url, payload)).json;
    } catch (error) {
        if (error instanceof PoppyError) throw error;
        return (await session.request<{ conversation_id: string }>("POST", url, payload)).json;
    }
}
