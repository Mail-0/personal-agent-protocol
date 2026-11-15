// The Poppy-Version and Poppy-Extensions request headers (spec 3.4).

export const SESSION_HEADER = "Poppy-Session";
export const VERSION_HEADER = "Poppy-Version";
export const EXTENSIONS_HEADER = "Poppy-Extensions";

// Extension names mapped to the versions used, such as { operations: "3" }.
export type ExtensionVersions = Record<string, string>;

// Poppy-Extensions as an RFC 9651 List of Strings with a `v` parameter, such as
// `"operations";v="3", "links";v="1"`.
export function formatExtensions(extensions: ExtensionVersions): string | undefined {
    const items = Object.entries(extensions).map(([name, v]) => `${quote(name)};v=${quote(v)}`);
    return items.length ? items.join(", ") : undefined;
}

// Parses Poppy-Extensions. A header that fails to parse declares no extensions (spec 3.4).
export function parseExtensions(value: string | null | undefined): ExtensionVersions {
    if (!value?.trim()) return {};
    const result: ExtensionVersions = {};
    const item =
        /^\s*"((?:[^"\\]|\\["\\])*)"((?:\s*;\s*[a-z*][a-z0-9_.*-]*(?:=(?:"(?:[^"\\]|\\["\\])*"|[^\s;,]+))?)*)\s*(?:,|$)/;
    let rest = value;
    while (rest.trim()) {
        const m = item.exec(rest);
        if (!m) return {};
        const versions = [...m[2].matchAll(/;\s*v\s*=\s*"((?:[^"\\]|\\["\\])*)"/g)];
        const last = versions.at(-1);
        if (last) result[unquote(m[1])] = unquote(last[1]);
        rest = rest.slice(m[0].length);
        if (m[0].trimEnd().endsWith(",") && !rest.trim()) return {};
    }
    return result;
}

function quote(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function unquote(value: string): string {
    return value.replace(/\\(["\\])/g, "$1");
}
