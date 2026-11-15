// The address rules for URLs the other party gives you (spec 3): HTTPS only, and never a loopback,
// private, or link-local address unless configured to on purpose. Pure, so it runs anywhere; DNS
// resolution is passed in where the runtime has it.

import { PoppyError } from "./errors.ts";

// Resolves a host name to every address it has.
export type LookupAll = (host: string) => Promise<string[]>;

export type AddressPolicy = {
    // Connect to loopback, private, and link-local addresses too, such as for a local deployment.
    allowPrivateAddresses?: boolean;
    // Checks the addresses a host name resolves to. Without it, only IP literals are checked.
    lookup?: LookupAll;
};

const IPV4_BLOCKED: [string, number][] = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
];

const IPV6_BLOCKED: [string, number][] = [
    ["::", 128],
    ["::1", 128],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
];

// Why an address isn't public, or undefined if it is (or isn't an IP address).
export function blockedAddress(address: string): string | undefined {
    const bare = address.replace(/^\[|\]$/g, "");
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
    if (mapped) return blockedAddress(mapped[1]);
    const v4 = parseIpv4(bare);
    const v6 = v4 === undefined ? parseIpv6(bare) : undefined;
    if (v4 === undefined && v6 === undefined) return undefined;
    const blocked =
        v4 !== undefined
            ? IPV4_BLOCKED.some(([net, prefix]) => inRange(v4, parseIpv4(net)!, prefix, 32))
            : IPV6_BLOCKED.some(([net, prefix]) => inRange(v6!, parseIpv6(net)!, prefix, 128));
    if (!blocked) return undefined;
    if (/^127\./.test(bare) || bare === "::1") return `${bare} is a loopback address`;
    if (/^169\.254\./.test(bare) || /^fe[89ab]/i.test(bare))
        return `${bare} is a link-local address`;
    return `${bare} is a private or reserved address`;
}

// Throws when a URL from the other party may not be used: not HTTPS, or a non-public address.
export async function assertUsableUrl(url: string, policy: AddressPolicy = {}): Promise<URL> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new PoppyError("invalid_url", `${url} isn't a valid URL.`);
    }
    if (parsed.protocol !== "https:")
        throw new PoppyError("invalid_url", `${url} isn't an HTTPS URL (spec 3).`);
    if (policy.allowPrivateAddresses) return parsed;
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    const literal = blockedAddress(host);
    if (literal) throw new PoppyError("blocked_address", `${url}: ${literal} (spec 3).`);
    if (parseIpv4(host) !== undefined || parseIpv6(host) !== undefined || !policy.lookup)
        return parsed;
    const bad = (await policy.lookup(host)).map(blockedAddress).find(Boolean);
    if (bad) throw new PoppyError("blocked_address", `${host} resolves to ${bad} (spec 3).`);
    return parsed;
}

function parseIpv4(input: string): bigint | undefined {
    const parts = input.split(".");
    if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255))
        return undefined;
    return parts.reduce((acc, p) => (acc << 8n) | BigInt(p), 0n);
}

function parseIpv6(input: string): bigint | undefined {
    if (!input.includes(":") || !/^[0-9a-f:.]+$/i.test(input)) return undefined;
    let text = input;
    const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
    if (tail) {
        const v4 = parseIpv4(tail[1]);
        if (v4 === undefined) return undefined;
        text =
            text.slice(0, -tail[1].length) +
            ((v4 >> 16n) & 0xffffn).toString(16) +
            ":" +
            (v4 & 0xffffn).toString(16);
    }
    const halves = text.split("::");
    if (halves.length > 2) return undefined;
    const head = halves[0] ? halves[0].split(":") : [];
    const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const missing = 8 - head.length - rest.length;
    if (halves.length === 1 ? head.length !== 8 : missing < 1) return undefined;
    const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
    if (!groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return undefined;
    return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

function inRange(address: bigint, net: bigint, prefix: number, bits: number): boolean {
    const shift = BigInt(bits - prefix);
    return address >> shift === net >> shift;
}
