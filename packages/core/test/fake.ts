// An in-memory network for tests: routes by URL to handlers, with nothing sent anywhere.

import type { FetchLike } from "../src/http.ts";

export type Handler = (request: Request) => Response | Promise<Response>;

export function fakeFetch(
    routes: Record<string, Handler | Response | object>,
): FetchLike & { calls: Request[] } {
    const calls: Request[] = [];
    const fn = async (url: string, init?: RequestInit) => {
        const request = new Request(url, init);
        calls.push(request);
        const route = routes[url.split("?")[0]];
        if (!route) return new Response("not found", { status: 404 });
        if (route instanceof Response) return route.clone();
        return typeof route === "function" ? (route as Handler)(request) : json(route);
    };
    return Object.assign(fn, { calls });
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
    });
}

export function redirect(location: string, status = 302): Response {
    return new Response(null, { status, headers: { location } });
}

export const POPPY = {
    protocol_version: "1.0",
    organization: { name: "Example Company", domain: "example.com" },
    agent: {
        protocols: [
            {
                type: "poppy",
                endpoint: "https://api.example.com/poppy/conversations",
                description: "Orders",
            },
        ],
    },
};

export const PROTECTED_RESOURCE = {
    resource: "https://example.com",
    authorization_servers: ["https://auth.example.com"],
};

export const ISSUER_METADATA = {
    issuer: "https://auth.example.com",
    token_endpoint: "https://auth.example.com/oauth/token",
    revocation_endpoint: "https://auth.example.com/oauth/revoke",
    authorization_endpoint: "https://auth.example.com/oauth/authorize",
    device_authorization_endpoint: "https://auth.example.com/oauth/device",
    grant_types_supported: [
        "refresh_token",
        "authorization_code",
        "urn:ietf:params:oauth:grant-type:device_code",
    ],
    protected_resources: ["https://example.com"],
};

export const COMPANY_ROUTES = {
    "https://example.com/.well-known/poppy.json": POPPY,
    "https://example.com/.well-known/oauth-protected-resource": PROTECTED_RESOURCE,
    "https://auth.example.com/.well-known/oauth-authorization-server": ISSUER_METADATA,
};
