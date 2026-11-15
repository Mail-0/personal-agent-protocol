// Poppy's error codes as one error class, read from responses and written into them.

// The HTTP status of each error code this version defines (spec 3.4, 5.3, 5.5, 8.2, 8.13).
export const ERROR_STATUS: Readonly<Record<string, number>> = {
    invalid_session: 400,
    session_ended: 400,
    version_unsupported: 400,
    invalid_request: 400,
    invalid_cursor: 400,
    extension_required: 403,
    conversation_not_found: 404,
    conversation_closed: 409,
    direct_conversation_open: 409,
    request_id_conflict: 409,
    version_mismatch: 409,
    cursor_expired: 410,
};

export type PoppyErrorOptions = {
    status?: number;
    // The JSON body the error came with, or should be sent with.
    body?: Record<string, unknown>;
    // Seconds to wait before sending the request again, from a 429's Retry-After (spec 5.6).
    retryAfter?: number;
    // Every WWW-Authenticate challenge of a 401 or 403, such as insufficient_scope (spec 7).
    challenges?: Challenge[];
};

// A Poppy, OAuth, or transport error. `code` is the wire `error` code, such as invalid_session, or
// one of core's own: rate_limited, http_error, invalid_url, blocked_address, invalid_response.
export class PoppyError extends Error {
    readonly code: string;
    readonly status?: number;
    readonly body?: Record<string, unknown>;
    readonly retryAfter?: number;
    readonly challenges: Challenge[];

    constructor(code: string, description?: string, options: PoppyErrorOptions = {}) {
        super(description ? `${code}: ${description}` : code);
        this.name = "PoppyError";
        this.code = code;
        this.status = options.status ?? ERROR_STATUS[code];
        this.body = options.body;
        this.retryAfter = options.retryAfter;
        this.challenges = options.challenges ?? [];
    }

    get description(): string | undefined {
        const value = this.body?.error_description;
        return typeof value === "string" ? value : undefined;
    }
}

// The error a response carries, or undefined when it succeeded. Reads the JSON `error` code first,
// then a WWW-Authenticate challenge, then falls back to the status (spec 8.13).
export async function errorFromResponse(response: Response): Promise<PoppyError | undefined> {
    if (response.ok) return undefined;
    const body = await readJsonBody(response);
    const challenges = parseChallenges(response.headers.get("www-authenticate") ?? undefined);
    const options: PoppyErrorOptions = { status: response.status, challenges };
    if (body) options.body = body;
    if (response.status === 429) {
        options.retryAfter = retryAfterSeconds(response.headers.get("retry-after") ?? undefined);
        return new PoppyError("rate_limited", undefined, options);
    }
    const code =
        (typeof body?.error === "string" ? body.error : undefined) ??
        challenges.find((c) => c.params.error)?.params.error;
    const description =
        typeof body?.error_description === "string" ? body.error_description : undefined;
    return new PoppyError(code ?? "http_error", description ?? `HTTP ${response.status}`, options);
}

// A JSON error response for a Poppy error, for a Company's endpoints: `{"error": code}` with its
// status, and error_description when given.
export function errorResponse(error: PoppyError | string, description?: string): Response {
    const e = typeof error === "string" ? new PoppyError(error, description) : error;
    const body: Record<string, unknown> = { ...e.body, error: e.code };
    const text = description ?? (typeof error === "string" ? undefined : e.description);
    if (text) body.error_description = text;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (e.retryAfter !== undefined) headers["retry-after"] = String(e.retryAfter);
    return new Response(JSON.stringify(body), { status: e.status ?? 400, headers });
}

// Retry-After in seconds, from a number of seconds or an HTTP date.
export function retryAfterSeconds(value: string | undefined, now = Date.now()): number | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
    const date = Date.parse(trimmed);
    if (Number.isNaN(date)) return undefined;
    return Math.max(0, Math.ceil((date - now) / 1000));
}

export type Challenge = { scheme: string; params: Record<string, string> };

// Parses every challenge of a WWW-Authenticate header, such as
// `Bearer error="insufficient_scope", scope="orders:write", resource_metadata="…"`.
export function parseChallenges(value: string | undefined): Challenge[] {
    const challenges: Challenge[] = [];
    if (!value) return challenges;
    const token = /[A-Za-z0-9!#$%&'*+.^_`|~-]+/y;
    let i = 0;
    let current: Challenge | undefined;
    while (i < value.length) {
        while (i < value.length && /[\s,]/.test(value[i])) i++;
        token.lastIndex = i;
        const m = token.exec(value);
        if (!m) {
            i++;
            continue;
        }
        const name = m[0];
        i = token.lastIndex;
        let j = i;
        while (j < value.length && value[j] === " ") j++;
        if (value[j] === "=" && current) {
            j++;
            while (j < value.length && value[j] === " ") j++;
            let v = "";
            if (value[j] === '"') {
                j++;
                while (j < value.length && value[j] !== '"') {
                    if (value[j] === "\\" && j + 1 < value.length) j++;
                    v += value[j++];
                }
                j++;
            } else {
                while (j < value.length && !/[\s,]/.test(value[j])) v += value[j++];
            }
            const key = name.toLowerCase();
            if (!(key in current.params)) current.params[key] = v;
            i = j;
        } else if (value[j] === "=") {
            i = j + 1;
        } else {
            current = { scheme: name, params: {} };
            challenges.push(current);
            const t68 = /^ +[A-Za-z0-9._~+/-]+=*(?=\s*(,|$))/.exec(value.slice(i));
            if (t68 && !/=\s*"/.test(t68[0]) && !value.slice(i + t68[0].length).startsWith("="))
                i += t68[0].length;
        }
    }
    return challenges;
}

async function readJsonBody(response: Response): Promise<Record<string, unknown> | undefined> {
    try {
        const json: unknown = JSON.parse(await response.text());
        return json && typeof json === "object" && !Array.isArray(json)
            ? (json as Record<string, unknown>)
            : undefined;
    } catch {
        return undefined;
    }
}
