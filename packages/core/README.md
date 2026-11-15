# @personal-agent-protocol/core

The rules of the [Personal Agent Protocol](https://personalagentprotocol.org) 1.0, with no
dependencies. It runs in any runtime with `fetch` and WebCrypto: Node.js 22.18+, Bun, Deno,
Cloudflare Workers.

Core is the layer the SDKs share, so each rule is written once. Most apps want
`@personal-agent-protocol/sdk` (Promises) or `@personal-agent-protocol/effect` (Effect) on top of it.

| Module                                                                  | What it does                                                                                                                   | Spec      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------- |
| `discover`                                                              | Fetches `poppy.json`, checks redirects, `organization.domain`, the issuer and its `protected_resources`, and chooses a version | 3         |
| `signDelegation`, `signSessionJwt`                                      | Delegations and per-request Session JWTs (`htm`, `htu`, `ath`)                                                                 | 5.2       |
| `createSessionVerifier`                                                 | The Company's Session header and `Poppy-Version` checks                                                                        | 3.4, 5.3  |
| `startDirectSignIn`, `startDeviceSignIn`, `refreshToken`, `revokeToken` | OAuth with client assertions, PKCE, PAR, `iss` checks, and device link checks                                                  | 4         |
| `PoppyError`, `errorFromResponse`, `errorResponse`                      | Every error code, read from and written to responses                                                                           | 5.3, 8.13 |
| `assertUsableUrl`, `blockedAddress`                                     | HTTPS only, no private addresses                                                                                               | 3         |
| `parseServerSentEvents`                                                 | Conversation streams                                                                                                           | 8.6       |
| `validate`, types                                                       | Wire documents, checked against the protocol's JSON Schemas                                                                    |           |

```ts
import {
    createSessionVerifier,
    discover,
    errorResponse,
    PoppyError,
} from "@personal-agent-protocol/core";

// Personal Agent: everything section 3 requires before using poppy.json.
const company = await discover("example.com");
company.identifier; // "https://auth.example.com", the audience of Session JWTs

// Company: verify the Session header on a request.
const verify = createSessionVerifier({ identifier: "https://auth.example.com", versions: ["1.0"] });
try {
    const session = await verify({
        session: req.headers.get("poppy-session") ?? undefined,
        version: req.headers.get("poppy-version") ?? undefined,
        method: req.method,
        url: req.url,
    });
} catch (error) {
    if (error instanceof PoppyError) return errorResponse(error); // 400 invalid_session, …
    throw error;
}
```

## Types

Discovery defaults to protocol 1.0. To also discover 0.4 Companies, pass
`{ versions: ["1.0", "0.4"] }` to `discover`. Their protocol descriptions may be absent;
`DiscoveryDocument` includes `Poppy04` to reflect that. Protocol 1.0 still requires descriptions.
This compatibility option covers discovery, not differences in authenticated sign-in behavior.

The types and the schemas used for validation are generated from `kit/company/schemas`, the
protocol's JSON Schemas. After changing a schema, run `pnpm sdk:generate`. The tests fail when the
generated files are out of date.

## Development

```sh
pnpm --filter @personal-agent-protocol/core test
pnpm --filter @personal-agent-protocol/core build
```
