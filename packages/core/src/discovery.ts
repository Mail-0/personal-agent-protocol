// Discovery (spec 3): fetching poppy.json, checking which Company it speaks for, choosing a
// version, and finding and verifying the Company's issuer.

import { PoppyError } from "./errors.ts";
import type {
    AuthorizationServerMetadata,
    Poppy,
    ProtectedResourceMetadata,
} from "./generated/types.ts";
import { getJson, type HttpOptions } from "./http.ts";
import { validate } from "./validate.ts";
import { compatible } from "./session.ts";

export const WELL_KNOWN_PATH = "/.well-known/poppy.json";
const MAX_REDIRECTS = 5;

export type Poppy04 = Omit<Poppy, "protocol_version" | "agent"> & {
    protocol_version: "0.4";
    agent?: {
        protocols: (Omit<NonNullable<Poppy["agent"]>["protocols"][number], "description"> & {
            description?: string;
        })[];
    };
};

export type DiscoveryDocument = Poppy | Poppy04;

export type Discovered = {
    // The chosen version's document.
    document: DiscoveryDocument;
    // The URL the chosen document came from, after redirects.
    url: string;
    // The protocol version chosen, as "major.minor".
    version: string;
    // organization.domain: the host that served poppy.json.
    domain: string;
    // The Company's identifier: its issuer, or https://{domain} (spec 3.2).
    identifier: string;
    // The issuer and its verified metadata, when the Company has one.
    issuer?: { issuer: string; metadata: AuthorizationServerMetadata };
    // The domain's protected resource metadata, when it publishes it.
    protectedResource?: ProtectedResourceMetadata;
};

export type DiscoverOptions = HttpOptions & {
    // The protocol versions the Personal Agent implements. Defaults to ["1.0"].
    versions?: string[];
};

// Discovers a Company from its domain, as spec 3 requires before a Personal Agent uses poppy.json.
export async function discover(domain: string, options: DiscoverOptions = {}): Promise<Discovered> {
    const fetched = await getJson(`https://${domain}${WELL_KNOWN_PATH}`, options, MAX_REDIRECTS, {
        "cache-control": "no-cache",
    });
    const final = new URL(fetched.url);
    if (final.pathname !== WELL_KNOWN_PATH || final.search)
        throw discovery(`poppy.json redirected to ${fetched.url}, which isn't ${WELL_KNOWN_PATH}`);
    if (!fetched.response.ok)
        throw discovery(`${fetched.url} returned HTTP ${fetched.response.status}`);
    const preferred = validateDocument(fetched.json, options.versions ?? ["1.0"]);
    if (preferred.organization.domain.toLowerCase() !== final.host)
        throw discovery(
            `organization.domain is ${preferred.organization.domain}, but ${final.host} served it`,
        );

    const version = selectVersion(preferred, options.versions ?? ["1.0"]);
    if (!version) throw new PoppyError("version_unsupported", "no compatible protocol version");
    let document = preferred;
    let url = fetched.url;
    if (version !== preferred.protocol_version) {
        url = preferred.supported_versions![version]!;
        if (new URL(url).host !== final.host)
            throw discovery(`the ${version} document isn't on ${final.host}`);
        const other = await getJson(url, options, 0);
        if (!other.response.ok) throw discovery(`${url} returned HTTP ${other.response.status}`);
        document = validateDocument(other.json, options.versions ?? ["1.0"]);
        if (document.protocol_version !== version || document.supported_versions)
            throw discovery(`${url} isn't a ${version} document`);
        if (document.organization.domain.toLowerCase() !== final.host)
            throw discovery(`${url} names another organization.domain`);
    }

    const resource = `https://${final.host}`;
    const protectedResource = await fetchProtectedResource(resource, options);
    const servers = protectedResource?.authorization_servers ?? [];
    const declared = document.auth?.issuer;
    if (!servers.length) {
        if (declared)
            throw discovery(`auth.issuer is ${declared}, but ${resource} lists no issuer`);
        return {
            document,
            url,
            version,
            domain: final.host,
            identifier: resource,
            ...(protectedResource ? { protectedResource } : {}),
        };
    }
    const issuer = declared ?? (servers.length === 1 ? servers[0] : undefined);
    if (!issuer)
        throw discovery(
            "the protected resource metadata lists several issuers and auth.issuer is missing",
        );
    if (!servers.includes(issuer))
        throw discovery(`auth.issuer ${issuer} isn't in the protected resource metadata`);
    const metadata = await fetchIssuerMetadata(issuer, resource, options);
    return {
        document,
        url,
        version,
        domain: final.host,
        identifier: issuer,
        issuer: { issuer, metadata },
        protectedResource: protectedResource!,
    };
}

// The newest version among protocol_version and supported_versions that is compatible with one
// the Personal Agent implements (spec 3.4).
export function selectVersion(
    document: DiscoveryDocument,
    implemented: string[],
): string | undefined {
    const offered = [document.protocol_version, ...Object.keys(document.supported_versions ?? {})];
    return offered
        .filter((v) => implemented.some((i) => compatible(i, v)))
        .sort((a, b) => {
            const [am, an] = a.split(".").map(Number);
            const [bm, bn] = b.split(".").map(Number);
            return bm - am || bn - an;
        })[0];
}

// RFC 8414 §3.1: /.well-known/oauth-authorization-server goes between the host and the path.
export function issuerMetadataUrl(issuer: string): string {
    const u = new URL(issuer);
    const path = u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, "");
    return `${u.origin}/.well-known/oauth-authorization-server${path}`;
}

async function fetchProtectedResource(
    resource: string,
    options: HttpOptions,
): Promise<ProtectedResourceMetadata | undefined> {
    const result = await getJson(`${resource}/.well-known/oauth-protected-resource`, options, 0);
    if (result.response.status === 404) return undefined;
    if (!result.response.ok)
        throw discovery(`protected resource metadata returned HTTP ${result.response.status}`);
    const metadata = validate<ProtectedResourceMetadata>(
        "protected-resource-metadata.schema.json",
        result.json,
    );
    if (metadata.resource !== resource)
        throw discovery(`the protected resource metadata's resource isn't ${resource}`);
    return metadata;
}

async function fetchIssuerMetadata(
    issuer: string,
    resource: string,
    options: HttpOptions,
): Promise<AuthorizationServerMetadata> {
    const result = await getJson(issuerMetadataUrl(issuer), options, 0);
    if (!result.response.ok)
        throw discovery(`the issuer's metadata returned HTTP ${result.response.status}`);
    const metadata = validate<AuthorizationServerMetadata>(
        "authorization-server-metadata.schema.json",
        result.json,
    );
    if (metadata.issuer !== issuer) throw discovery(`the metadata's issuer isn't ${issuer}`);
    const listed = (metadata.protected_resources ?? []).some((r) => sameResource(r, resource));
    if (!listed) throw discovery(`the issuer's protected_resources doesn't list ${resource}`);
    return metadata;
}

function sameResource(a: string, b: string): boolean {
    try {
        const x = new URL(a);
        const y = new URL(b);
        return (
            x.protocol === y.protocol && x.host === y.host && x.pathname === y.pathname && !x.search
        );
    } catch {
        return false;
    }
}

function discovery(description: string): PoppyError {
    return new PoppyError("discovery_failed", description);
}

function validateDocument(value: unknown, implemented: string[]): DiscoveryDocument {
    const legacy =
        typeof value === "object" &&
        value !== null &&
        "protocol_version" in value &&
        value.protocol_version === "0.4" &&
        implemented.includes("0.4");
    return validate<DiscoveryDocument>(
        legacy ? "poppy-0.4.schema.json" : "poppy.schema.json",
        value,
    );
}
