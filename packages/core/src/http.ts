// The one place core sends requests: every URL passes the address rules (spec 3) and redirects are
// never followed automatically, so no token, Session JWT, or assertion goes to a URL it wasn't
// signed for.

import { assertUsableUrl, type AddressPolicy } from "./address.ts";
import { PoppyError } from "./errors.ts";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type HttpOptions = AddressPolicy & {
    // The fetch to use. Defaults to the global fetch.
    fetch?: FetchLike;
};

// Sends one request, without following redirects.
export async function send(
    url: string,
    init: RequestInit,
    options: HttpOptions,
): Promise<Response> {
    await assertUsableUrl(url, options);
    return (options.fetch ?? fetch)(url, { ...init, redirect: "manual" });
}

export type JsonResult = { url: string; response: Response; json?: unknown };

// GETs a JSON document, following at most `redirects` redirects by hand, each to an HTTPS URL that
// passes the address rules. Returns the final URL with the response.
export async function getJson(
    url: string,
    options: HttpOptions,
    redirects = 0,
    headers: Record<string, string> = {},
): Promise<JsonResult> {
    let current = url;
    for (let hop = 0; ; hop++) {
        const response = await send(
            current,
            { headers: { accept: "application/json", ...headers } },
            options,
        );
        if (response.status >= 300 && response.status < 400 && response.status !== 304) {
            const location = response.headers.get("location");
            if (hop >= redirects || !location) {
                throw new PoppyError(
                    "invalid_response",
                    `${current} redirected${location ? ` to ${location}` : ""}, which isn't allowed here.`,
                    { status: response.status },
                );
            }
            current = new URL(location, current).toString();
            continue;
        }
        if (!response.ok) return { url: current, response };
        try {
            return { url: current, response, json: await response.json() };
        } catch {
            throw new PoppyError("invalid_response", `${current} didn't return JSON.`);
        }
    }
}

// A form-encoded POST, as OAuth endpoints take.
export function postForm(
    url: string,
    params: Record<string, string | undefined>,
    options: HttpOptions,
): Promise<Response> {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params))
        if (value !== undefined) body.set(key, value);
    return send(
        url,
        {
            method: "POST",
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                accept: "application/json",
            },
            body: body.toString(),
        },
        options,
    );
}
