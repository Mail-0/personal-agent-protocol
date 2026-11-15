// Where the Personal Agent keeps a User's tokens for a Company. Tokens belong to the Company's
// identifier and the User ID, not to a Session (spec 4.4).

export type StoredTokens = {
    accessToken: string;
    refreshToken?: string;
    // Unix seconds, when the access token expires.
    expiresAt?: number;
    scope?: string;
};

export type TokenStore = {
    get(identifier: string, userId: string): Promise<StoredTokens | undefined>;
    set(identifier: string, userId: string, tokens: StoredTokens): Promise<void>;
    delete(identifier: string, userId: string): Promise<void>;
};

// Tokens in memory, lost when the process exits. Use a durable store in production.
export function memoryTokenStore(): TokenStore {
    const tokens = new Map<string, StoredTokens>();
    const key = (identifier: string, userId: string) => `${identifier}\n${userId}`;
    return {
        async get(identifier, userId) {
            return tokens.get(key(identifier, userId));
        },
        async set(identifier, userId, value) {
            tokens.set(key(identifier, userId), value);
        },
        async delete(identifier, userId) {
            tokens.delete(key(identifier, userId));
        },
    };
}
