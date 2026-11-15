// The Personal Agent as an Effect service. It wraps @personal-agent-protocol/sdk, so discovery,
// Session JWTs, delegated keys, and the retry rules behave exactly as they do there.

import {
    createAgent,
    type AgentOptions,
    type Company as SdkCompany,
    type Conversation as SdkConversation,
    type ConversationState,
    type DeviceAuthorizationResponse,
    type DirectSignIn,
    type Discovered,
    type Event,
    type EventsOptions,
    type EventsResponse,
    type FeedbackReport,
    type OutgoingMessage,
    type Session as SdkSession,
    type Tasks,
} from "@personal-agent-protocol/sdk";
import { Context, Effect, Layer, Stream } from "effect";
import { toPoppyErrors, type PoppyErrors } from "./errors.ts";

export type Company = {
    readonly identifier: string;
    readonly info: Discovered;
    session(options: {
        userId: string;
        agentId?: string;
        extensions?: Record<string, string>;
    }): Session;
};

export type Session = {
    readonly sid: Effect.Effect<string>;
    request<T = unknown>(
        method: string,
        url: string,
        body?: unknown,
    ): Effect.Effect<T, PoppyErrors>;
    tasks: Effect.Effect<Tasks, PoppyErrors>;
    feedback(report: FeedbackReport): Effect.Effect<unknown, PoppyErrors>;
    authorizeBrowser(code: string): Effect.Effect<void, PoppyErrors>;
    conversations(endpoint?: string): Effect.Effect<Conversations, PoppyErrors>;
    startSignIn(options: {
        redirectUri: string;
        scope: string;
        sameDevice?: boolean;
    }): Effect.Effect<DirectSignIn, PoppyErrors>;
    completeSignIn(
        signIn: DirectSignIn,
        callback: URLSearchParams,
    ): Effect.Effect<void, PoppyErrors>;
    startDeviceSignIn(options: {
        scope: string;
    }): Effect.Effect<
        { device: DeviceAuthorizationResponse; done: Effect.Effect<void, PoppyErrors> },
        PoppyErrors
    >;
    signOut: Effect.Effect<void, PoppyErrors>;
};

export type Conversations = {
    start(message: OutgoingMessage | string): Effect.Effect<Conversation, PoppyErrors>;
    get(id: string): Conversation;
};

export type Conversation = {
    readonly id: string;
    readonly state: Effect.Effect<ConversationState>;
    send(message: OutgoingMessage | string): Effect.Effect<void, PoppyErrors>;
    read(options?: { cursor?: string; wait?: number }): Effect.Effect<EventsResponse, PoppyErrors>;
    // New events until the conversation closes: streamed or long-polled, deduplicated (spec 8.5).
    events(options?: Omit<EventsOptions, "signal">): Stream.Stream<Event, PoppyErrors>;
    handoff: Effect.Effect<void, PoppyErrors>;
    cancelHandoff: Effect.Effect<void, PoppyErrors>;
    close: Effect.Effect<void, PoppyErrors>;
};

export class PoppyAgent extends Context.Service<
    PoppyAgent,
    {
        readonly clientId: string;
        // Discovers a Company from its domain (spec 3).
        discover(domain: string): Effect.Effect<Company, PoppyErrors>;
    }
>()("@personal-agent-protocol/effect/PoppyAgent") {
    static layer(options: AgentOptions): Layer.Layer<PoppyAgent> {
        return Layer.sync(PoppyAgent, () => {
            const agent = createAgent(options);
            return PoppyAgent.of({
                clientId: agent.clientId,
                discover: (domain) =>
                    promise(() => agent.discover(domain)).pipe(Effect.map(wrapCompany)),
            });
        });
    }
}

function promise<A>(run: () => Promise<A>): Effect.Effect<A, PoppyErrors> {
    return Effect.tryPromise({ try: run, catch: toPoppyErrors });
}

function wrapCompany(company: SdkCompany): Company {
    return {
        identifier: company.identifier,
        info: company.info,
        session: (options) => wrapSession(company.session(options)),
    };
}

function wrapSession(session: SdkSession): Session {
    return {
        sid: Effect.sync(() => session.sid),
        request: <T>(method: string, url: string, body?: unknown) =>
            promise(() => session.request<T>(method, url, body)).pipe(Effect.map((r) => r.json)),
        tasks: promise(() => session.tasks()),
        feedback: (report) => promise(() => session.feedback(report)),
        authorizeBrowser: (code) => promise(() => session.authorizeBrowser(code)),
        conversations: (endpoint) =>
            Effect.try({ try: () => session.conversations(endpoint), catch: toPoppyErrors }).pipe(
                Effect.map((c) => ({
                    start: (message) =>
                        promise(() => c.start(message)).pipe(Effect.map(wrapConversation)),
                    get: (id) => wrapConversation(c.get(id)),
                })),
            ),
        startSignIn: (options) => promise(() => session.startSignIn(options)),
        completeSignIn: (signIn, callback) =>
            promise(() => session.completeSignIn(signIn, callback)),
        startDeviceSignIn: (options) =>
            promise(() => session.startDeviceSignIn(options)).pipe(
                Effect.map(({ device, done }) => ({ device, done: promise(() => done) })),
            ),
        signOut: promise(() => session.signOut()),
    };
}

function wrapConversation(conversation: SdkConversation): Conversation {
    return {
        id: conversation.id,
        state: Effect.sync(() => conversation.state),
        send: (message) => promise(() => conversation.send(message)),
        read: (options) => promise(() => conversation.read(options)),
        events: (options = {}) =>
            Stream.unwrap(
                Effect.sync(() => {
                    const controller = new AbortController();
                    return Stream.fromAsyncIterable(
                        conversation.events({ ...options, signal: controller.signal }),
                        toPoppyErrors,
                    ).pipe(Stream.ensuring(Effect.sync(() => controller.abort())));
                }),
            ),
        handoff: promise(() => conversation.handoff()),
        cancelHandoff: promise(() => conversation.cancelHandoff()),
        close: promise(() => conversation.close()),
    };
}
