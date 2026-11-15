// base64url, random IDs, and SHA-256, with only Web APIs, so core runs in any JavaScript runtime.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(input: string): Uint8Array<ArrayBuffer> {
    return encoder.encode(input);
}

export function fromUtf8(input: Uint8Array): string {
    return decoder.decode(input);
}

export function b64url(input: Uint8Array | ArrayBuffer | string): string {
    const bytes =
        typeof input === "string"
            ? encoder.encode(input)
            : input instanceof Uint8Array
              ? input
              : new Uint8Array(input);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(input: string): Uint8Array<ArrayBuffer> {
    if (!/^[A-Za-z0-9_-]*$/.test(input)) throw new Error("Not base64url.");
    const binary = atob(input.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

// A random base64url string with `bytes` random bytes. 16 bytes (22 characters) is unguessable and
// long enough for a Session ID or jti (spec 5.2).
export function randomId(bytes = 16): string {
    return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(input: string): Promise<string> {
    return b64url(await crypto.subtle.digest("SHA-256", encoder.encode(input)));
}

export function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
}
