// The Personal Agent: discovers Companies, signs every request's Session header, keeps tokens, and
// applies the retry rules the spec requires.

import {
    compatible,
    completeDirectSignIn,
    discover,
    errorFromResponse,
    EXTENSIONS_HEADER,
    formatExtensions,
    generateKey,
    newSessionId,
    nowSeconds,
    pollDeviceSignIn,
    PoppyError,
    refreshToken,
    revokeToken,
    send,
    SESSION_HEADER,
    signDelegation,
    signSessionJwt,
    startDeviceSignIn,
    startDirectSignIn,
    validate,
    VERSION_HEADER,
    type DeviceAuthorizationResponse,
    type DirectSignIn,
    type Discovered,
    type ExtensionVersions,
    type FeedbackReport,
    type HttpOptions,
    type OAuthClient,
    type RsaKey,
    type SigningKey,
    type Tasks,
    type TokenResponse,
} from "@personal-agent-protocol/core";
import { Conversations } from "./conversations.ts";
import { memoryTokenStore, type StoredTokens, type TokenStore } from "./stores.ts";

export type AgentOptions = {
    // The Personal Agent's client_id: the URL of its client metadata document (spec 4.1).
    clientId: string;
    // A key from its jwks_uri. It signs delegations and client assertions, never Session JWTs.
    key: SigningKey | RsaKey;
    // Protocol versions implemented. Defaults to ["1.0"].
    versions?: string[];
    tokens?: TokenStore;
    http?: HttpOptions;
    // How long each delegation lasts, in seconds, at most 24 hours. Defaults to 2 hours.
    delegationLifetime?: number;
    // The longest Retry-After waited out, in seconds. Defaults to 60.
    maxRetryAfter?: number;
    sleep?: (ms: number) => Promise<void>;
};

export type Agent = {
    readonly clientId: string;
    // Discovers a Company from its domain (spec 3).
    discover(domain: string): Promise<Company>;
};

export function createAgent(options: AgentOptions): Agent {
    const context: AgentContext = {
        ...options,
        versions: options.versions ?? ["1.0"],
        tokens: options.tokens ?? memoryTokenStore(),
        http: options.http ?? {},
        maxRetryAfter: options.maxRetryAfter ?? 60,
        sleep: options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
        delegations: new Map(),
        refreshing: new Map(),
    };
    return {
        clientId: options.clientId,
        async discover(domain) {
            return new Company(context, domain, await discoverWith(context, domain));
        },
    };
}

type AgentContext = Required<Omit<AgentOptions, "delegationLifetime">> & {
    delegationLifetime?: number;
    delegations: Map<string, Promise<Delegated>>;
    refreshing: Map<string, Promise<StoredTokens | undefined>>;
};

type Delegated = { key: SigningKey; delegation: string; exp: number };

export class Company {
    #context: AgentContext;
    readonly domain: string;
    info: Discovered;

    constructor(context: AgentContext, domain: string, info: Discovered) {
        this.#context = context;
        this.domain = domain;
        this.info = info;
    }

    get identifier(): string {
        return this.info.identifier;
    }

    // Starts a Session for a User (spec 5). `userId` is the User ID for this Company (spec 5.1).
    session(options: {
        userId: string;
        agentId?: string;
        extensions?: ExtensionVersions;
    }): Session {
        return new Session(this.#context, this, options);
    }

    // Fetches poppy.json again, without a cache, after version_unsupported (spec 3.4).
    async rediscover(): Promise<boolean> {
        const before = this.info.version;
        this.info = await discoverWith(this.#context, this.domain);
        return this.info.version !== before;
    }
}

export class Session {
    #context: AgentContext;
    #options: { userId: string; agentId?: string; extensions?: ExtensionVersions };
    readonly company: Company;
    sid = newSessionId();

    constructor(
        context: AgentContext,
        company: Company,
        options: { userId: string; agentId?: string; extensions?: ExtensionVersions },
    ) {
        this.#context = context;
        this.company = company;
        this.#options = options;
    }

    get userId(): string {
        return this.#options.userId;
    }

    // Sends a request with the Session header, an access token when signed in, and the version
    // headers. Waits out 429s, and after session_ended or version_unsupported starts a new Session
    // and sends the request again once (spec 3.4, 5.5, 5.6). The body must be a string, so it can be
    // sent again. Error responses are returned, not thrown.
    async fetch(
        url: string,
        init: RequestInit = {},
        opts: { signedOut?: boolean } = {},
    ): Promise<Response> {
        let renewed = false;
        let rediscovered = false;
        let refreshed = false;
        for (let attempt = 0; ; attempt++) {
            const tokens = opts.signedOut ? undefined : await this.#tokens();
            const response = await send(
                url,
                { ...init, headers: await this.#headers(init, url, tokens?.accessToken) },
                this.#context.http,
            );
            if (response.status === 429 && attempt < 2) {
                const error = await errorFromResponse(response.clone());
                const wait = error?.retryAfter;
                if (wait !== undefined && wait <= this.#context.maxRetryAfter) {
                    await this.#context.sleep(wait * 1000);
                    continue;
                }
                return response;
            }
            if (response.status !== 400 && response.status !== 401) return response;
            const code = (await errorFromResponse(response.clone()))?.code;
            if (code === "session_ended" && !renewed) {
                renewed = true;
                this.sid = newSessionId();
                continue;
            }
            if (code === "version_unsupported" && !rediscovered) {
                rediscovered = true;
                if (!(await this.company.rediscover())) return response;
                this.sid = newSessionId();
                continue;
            }
            if (code === "invalid_token" && tokens && !refreshed) {
                refreshed = true;
                await this.#refresh(tokens);
                continue;
            }
            return response;
        }
    }

    // A JSON request through fetch(). Throws a PoppyError for an error response.
    async request<T = unknown>(
        method: string,
        url: string,
        body?: unknown,
        opts: { signedOut?: boolean; accept?: string; signal?: AbortSignal } = {},
    ): Promise<{ response: Response; json: T }> {
        const init: RequestInit = {
            method,
            ...(opts.signal ? { signal: opts.signal } : {}),
            headers: {
                accept: opts.accept ?? "application/json",
                ...(body !== undefined ? { "content-type": "application/json" } : {}),
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        };
        const response = await this.fetch(url, init, opts);
        if (!response.ok) throw await errorFromResponse(response);
        const text = await response.text();
        return { response, json: (text ? JSON.parse(text) : undefined) as T };
    }

    // The conversations of the Company Agent's first `poppy` protocol, or the one at `endpoint`
    // (spec 8).
    conversations(endpoint?: string): Conversations {
        const protocols = this.company.info.document.agent?.protocols ?? [];
        const url = endpoint ?? protocols.find((p) => p.type === "poppy")?.endpoint;
        if (!url)
            throw new PoppyError("not_offered", "the Company lists no poppy conversation protocol");
        return new Conversations(this, url);
    }

    // The tasks the Company doesn't offer, its skills, and its feedback endpoint (spec 9).
    async tasks(): Promise<Tasks> {
        const endpoint = this.company.info.document.tasks?.endpoint;
        if (!endpoint) return {};
        const { json } = await this.request("GET", endpoint, undefined, { signedOut: true });
        return validate<Tasks>("tasks.schema.json", json);
    }

    // Reports a task the User couldn't do (spec 9.3). Returns the Company's alternative, if any.
    async feedback(report: FeedbackReport): Promise<unknown> {
        const endpoint = (await this.tasks()).feedback?.endpoint;
        if (!endpoint) throw new PoppyError("not_offered", "the Company takes no feedback");
        validate("feedback-report.schema.json", report);
        return (await this.request("POST", endpoint, report)).json;
    }

    // Authorizes the code the Personal Agent's browser got from the browser-session page, so it
    // joins this Session (spec 6).
    async authorizeBrowser(code: string): Promise<void> {
        const endpoint = this.company.info.document.web?.browser_session_endpoint;
        if (!endpoint)
            throw new PoppyError("not_offered", "the Company lists no browser_session_endpoint");
        await this.request("POST", `${endpoint.replace(/\/+$/, "")}/authorize`, { code });
    }

    // Whether the User is signed in to the Company, as far as stored tokens say.
    async signedIn(): Promise<boolean> {
        return Boolean(await this.#context.tokens.get(this.company.identifier, this.userId));
    }

    // Starts Direct Sign-In (spec 4.2). Open `url` in the User's browser, then pass the redirect's
    // query to completeSignIn.
    startSignIn(options: {
        redirectUri: string;
        scope: string;
        sameDevice?: boolean;
    }): Promise<DirectSignIn> {
        return startDirectSignIn(this.#oauth(), options);
    }

    async completeSignIn(signIn: DirectSignIn, callback: URLSearchParams): Promise<void> {
        await this.#store(await completeDirectSignIn(this.#oauth(), signIn, callback));
    }

    // Starts Device Sign-In (spec 4.3). Show the User `device` with the Company's name and domain,
    // then await `done`, which polls until the User approves, declines, or the code expires.
    async startDeviceSignIn(options: { scope: string }): Promise<{
        device: DeviceAuthorizationResponse;
        done: Promise<void>;
    }> {
        const client = this.#oauth();
        const device = await startDeviceSignIn(client, {
            scope: options.scope,
            domain: this.company.info.domain,
        });
        const done = (async () => {
            let interval = device.interval ?? 5;
            const deadline = nowSeconds() + device.expires_in;
            while (nowSeconds() < deadline) {
                await this.#context.sleep(interval * 1000);
                const poll = await pollDeviceSignIn(client, device, interval);
                if (poll.status === "slow_down") interval = poll.interval;
                if (poll.status === "done") {
                    await this.#store(poll.tokens);
                    return;
                }
            }
            throw new PoppyError("expired_token", "the device code expired");
        })();
        return { device, done };
    }

    // Signs out by revoking the refresh token (spec 5.5). The Session continues signed out.
    async signOut(): Promise<void> {
        const tokens = await this.#context.tokens.get(this.company.identifier, this.userId);
        if (tokens?.refreshToken) await revokeToken(this.#oauth(false), tokens.refreshToken);
        await this.#context.tokens.delete(this.company.identifier, this.userId);
    }

    async #headers(
        init: RequestInit,
        url: string,
        accessToken: string | undefined,
    ): Promise<Headers> {
        const headers = new Headers(init.headers);
        const { key, delegation } = await this.#delegated();
        headers.set(
            SESSION_HEADER,
            await signSessionJwt({
                key,
                delegation,
                clientId: this.#context.clientId,
                audience: this.company.identifier,
                sid: this.sid,
                userId: this.userId,
                ...(this.#options.agentId !== undefined ? { agentId: this.#options.agentId } : {}),
                method: init.method ?? "GET",
                url,
                ...(accessToken !== undefined ? { accessToken } : {}),
            }),
        );
        const chosen = this.company.info.version;
        headers.set(
            VERSION_HEADER,
            this.#context.versions.find((v) => compatible(v, chosen)) ?? chosen,
        );
        const extensions = formatExtensions(this.#options.extensions ?? {});
        if (extensions) headers.set(EXTENSIONS_HEADER, extensions);
        if (accessToken !== undefined) headers.set("authorization", `Bearer ${accessToken}`);
        return headers;
    }

    // The delegated key for this User ID: one per User ID, never shared (spec 5.2), replaced
    // before its delegation expires.
    #delegated(): Promise<Delegated> {
        const delegations = this.#context.delegations;
        const cached = delegations.get(this.userId);
        const fresh = cached?.then((d) => (d.exp - nowSeconds() > 300 ? d : undefined));
        const next = (async () => {
            const existing = await fresh;
            if (existing) return existing;
            const key = await generateKey();
            const iat = nowSeconds();
            const lifetime = this.#context.delegationLifetime ?? 2 * 60 * 60;
            const delegation = await signDelegation({
                root: this.#context.key,
                delegated: key.publicJwk,
                clientId: this.#context.clientId,
                lifetime,
                iat,
            });
            return { key, delegation, exp: iat + lifetime };
        })();
        delegations.set(this.userId, next);
        next.catch(() => delegations.delete(this.userId));
        return next;
    }

    async #tokens(): Promise<StoredTokens | undefined> {
        const tokens = await this.#context.tokens.get(this.company.identifier, this.userId);
        if (!tokens?.expiresAt || tokens.expiresAt - nowSeconds() > 30) return tokens;
        return (await this.#refresh(tokens)) ?? undefined;
    }

    // One refresh at a time per Company and User, across Sessions, since refresh tokens rotate. On
    // invalid_grant the account is signed out (spec 5.5). A refresh that finishes after sign-out
    // stores nothing.
    #refresh(tokens: StoredTokens): Promise<StoredTokens | undefined> {
        const key = `${this.company.identifier}\n${this.userId}`;
        const pending = this.#context.refreshing.get(key);
        if (pending) return pending;
        const store = this.#context.tokens;
        const run = (async () => {
            try {
                if (!tokens.refreshToken) {
                    await store.delete(this.company.identifier, this.userId);
                    return undefined;
                }
                const response = await refreshToken(this.#oauth(false), tokens.refreshToken);
                const current = await store.get(this.company.identifier, this.userId);
                if (current?.refreshToken !== tokens.refreshToken) return current;
                return await this.#store(response, tokens.refreshToken);
            } catch (error) {
                if (error instanceof PoppyError && error.code === "invalid_grant") {
                    const current = await store.get(this.company.identifier, this.userId);
                    if (current?.refreshToken !== tokens.refreshToken) return current;
                    await store.delete(this.company.identifier, this.userId);
                    return undefined;
                }
                throw error;
            } finally {
                this.#context.refreshing.delete(key);
            }
        })();
        this.#context.refreshing.set(key, run);
        return run;
    }

    async #store(response: TokenResponse, previousRefresh?: string): Promise<StoredTokens> {
        const tokens: StoredTokens = {
            accessToken: response.access_token,
            ...((response.refresh_token ?? previousRefresh)
                ? { refreshToken: response.refresh_token ?? previousRefresh }
                : {}),
            ...(response.expires_in ? { expiresAt: nowSeconds() + response.expires_in } : {}),
            ...(response.scope ? { scope: response.scope } : {}),
        };
        await this.#context.tokens.set(this.company.identifier, this.userId, tokens);
        return tokens;
    }

    // `signIn` is false for refresh and revocation, which keep working after auth.disabled (spec
    // 3.2).
    #oauth(signIn = true): OAuthClient {
        const issuer = this.company.info.issuer;
        if (!issuer) throw new PoppyError("not_offered", "the Company has no OAuth issuer");
        if (signIn && this.company.info.document.auth?.disabled)
            throw new PoppyError("not_offered", "the Company offers no sign-in (auth.disabled)");
        return {
            clientId: this.#context.clientId,
            key: this.#context.key,
            issuer: issuer.issuer,
            metadata: issuer.metadata,
            http: this.#context.http,
        };
    }
}

function discoverWith(context: AgentContext, domain: string): Promise<Discovered> {
    return discover(domain, { ...context.http, versions: context.versions });
}
