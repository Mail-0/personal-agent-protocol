# @personal-agent-protocol/effect

The [Personal Agent Protocol](https://personalagentprotocol.org) 1.0 for
[Effect](https://effect.website): services, Layers, tagged errors, and Streams. It wraps
`@personal-agent-protocol/sdk`, so discovery, Session JWTs, delegated keys, and the spec's retry
rules behave exactly as they do there. Requires `effect` 4.

## Personal Agent

```ts
import { PoppyAgent } from "@personal-agent-protocol/effect";
import { importPrivateJwk } from "@personal-agent-protocol/sdk";
import { Console, Effect, Stream } from "effect";

const program = Effect.gen(function* () {
    const company = yield* (yield* PoppyAgent).discover("example.com");
    const session = company.session({ userId: "usr_Q7c1vK" });
    const convo = yield* (yield* session.conversations()).start("Exchange my jacket for a size M");
    yield* convo.events().pipe(Stream.runForEach((event) => Console.log(event.type)));
}).pipe(
    Effect.catchTag("SignInRequired", (e) => Console.log(`sign in for ${e.scope}`)),
    Effect.provide(
        PoppyAgent.layer({
            clientId: "https://agent.example/agent.json",
            key: await importPrivateJwk(JSON.parse(process.env.AGENT_PRIVATE_JWK!)),
        }),
    ),
);
```

Wire errors are tagged errors: `InvalidSession`, `SessionEnded`, `VersionUnsupported`,
`VersionMismatch`, `ConversationNotFound`, `ConversationClosed`, `RequestIdConflict`,
`CursorExpired`, `RateLimited`, `SignInRequired`, `DiscoveryFailed`, `PoppyRequestError` (any other
code), and `TransportError`. `convo.events()` is a `Stream` that streams over SSE or long-polls, and
it aborts the underlying request when the stream is interrupted.

## Company

```ts
import { CurrentSession, PoppyCompany, withSession } from "@personal-agent-protocol/effect";

const handler = (request: Request) =>
    withSession(
        request,
        Effect.gen(function* () {
            const session = yield* CurrentSession; // verified clientId, userId, sid, signedIn
            return Response.json({ ok: true });
        }),
    ).pipe(
        Effect.provide(
            PoppyCompany.layer({ identifier: "https://auth.example.com", versions: ["1.0"] }),
        ),
    );
```

A failed check returns the spec's response, such as `400 {"error": "invalid_session"}`, and so does
any Poppy error the handler fails with.
