# @personal-agent-protocol/sdk

The [Personal Agent Protocol](https://personalagentprotocol.org) 1.0 for TypeScript, with Promises
and async iterators. It works for both parties: a Personal Agent client, and Session verification for
a Company. Built on `@personal-agent-protocol/core` and re-exporting it, so this is the only package
you need.

## Personal Agent

Set `versions: ["1.0", "0.4"]` in `createAgent` to opt into discovery of 0.4 Companies,
including stores whose conversation protocols have no description. The default remains 1.0 only.
This does not adapt authenticated sign-in behavior to older issuers.

```ts
import { createAgent, importPrivateJwk, PoppyError } from "@personal-agent-protocol/sdk";

const agent = createAgent({
    clientId: "https://agent.example/agent.json",
    key: await importPrivateJwk(JSON.parse(process.env.AGENT_PRIVATE_JWK!)), // a key in your jwks_uri
});

const company = await agent.discover("example.com"); // every check in spec section 3
const session = company.session({ userId: "usr_Q7c1vK" }); // the User ID for this Company

const convo = await session.conversations().start("Exchange my jacket for a size M");
for await (const event of convo.events()) {
    // streams when the Company offers it, long-polls otherwise
    if (event.type === "message") console.log(event.message.text);
    if (event.type === "authorization") {
        const signIn = await session.startSignIn({ redirectUri, scope: event.scope });
        // open signIn.url, then: await session.completeSignIn(signIn, callbackQuery)
    }
}
```

Every request gets a fresh Session JWT signed by a delegated key for that User only, plus the
version headers and the access token when signed in. The client also applies the retry rules the
spec sets:

| Response                          | What the SDK does                                                                                     | Spec     |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- | -------- |
| 429 with `Retry-After` up to 60 s | waits it out, then sends again (twice at most)                                                        | 5.6      |
| `session_ended`                   | starts a Session with a new `sid` and sends again, once                                               | 5.5      |
| `version_unsupported`             | fetches `poppy.json` again; if the chosen version changed, starts a new Session and sends again, once | 3.4      |
| `invalid_token`                   | refreshes the token once; on `invalid_grant` it drops the tokens and continues signed out             | 4.4, 5.5 |
| `cursor_expired`                  | reads again from the start, skipping events already handled                                           | 8.5      |

Tokens are kept per Company and User in a `TokenStore`. The default, `memoryTokenStore()`, keeps
them in memory, so pass your own durable store in production.

## Company

```ts
import { createCompany } from "@personal-agent-protocol/sdk";

const poppy = createCompany({
    identifier: "https://auth.example.com",
    versions: ["1.0"],
    isEnded: (s) => endedSessions.has(s.sid),
});

// Any Fetch-API server: Hono, Next.js route handlers, Bun.serve, Workers.
export const POST = poppy.handle(async (request, session) => {
    // session.clientId, session.userId, session.sid, session.signedIn
    return Response.json({ ok: true });
});
```

Failed checks come back as `400 {"error": "invalid_session"}`, `session_ended`, or
`version_unsupported`, with the status and body the spec defines.

## Testing

`@personal-agent-protocol/sdk/testing` provides an in-memory network with a hosted agent identity
and a Company. The Company serves `poppy.json`, conversations (request-ID idempotency, ownership,
SSE or long-poll), tasks, feedback, and browser join, and checks every Session header with
`createCompany`:

```ts
import { createTestNetwork } from "@personal-agent-protocol/sdk/testing";

const net = await createTestNetwork();
const session = (await net.agent().discover(net.domain)).session({ userId: "usr_1" });
const convo = await session.conversations().start("hi"); // the Company replies "echo: hi"
```
