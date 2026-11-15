import assert from "node:assert/strict";
import { test } from "node:test";
import { discover, issuerMetadataUrl, selectVersion } from "../src/discovery.ts";
import { PoppyError } from "../src/errors.ts";
import { COMPANY_ROUTES, fakeFetch, POPPY, redirect } from "./fake.ts";

async function fails(promise: Promise<unknown>, match: RegExp) {
    await assert.rejects(promise, (e: unknown) => e instanceof PoppyError && match.test(e.message));
}

test("discovers a Company with an issuer, as in spec 3.2", async () => {
    const company = await discover("example.com", { fetch: fakeFetch(COMPANY_ROUTES) });
    assert.equal(company.identifier, "https://auth.example.com");
    assert.equal(company.version, "1.0");
    assert.equal(company.issuer?.metadata.token_endpoint, "https://auth.example.com/oauth/token");
});

test("follows HTTPS redirects that end at the well-known path", async () => {
    const fetch = fakeFetch({
        ...COMPANY_ROUTES,
        "https://www.example.com/.well-known/poppy.json": () =>
            redirect("https://example.com/.well-known/poppy.json"),
    });
    assert.equal((await discover("www.example.com", { fetch })).domain, "example.com");
});

test("refuses a redirect to another path, or to plain HTTP", async () => {
    await fails(
        discover("example.com", {
            fetch: fakeFetch({
                "https://example.com/.well-known/poppy.json": () =>
                    redirect("https://example.com/uploads/poppy.json"),
            }),
        }),
        /isn't \/.well-known\/poppy.json/,
    );
    await fails(
        discover("example.com", {
            fetch: fakeFetch({
                "https://example.com/.well-known/poppy.json": () =>
                    redirect("http://example.com/.well-known/poppy.json"),
            }),
        }),
        /HTTPS/,
    );
});

test("a copied document doesn't speak for another domain", async () => {
    const fetch = fakeFetch({ "https://copy.example/.well-known/poppy.json": POPPY });
    await fails(discover("copy.example", { fetch }), /organization.domain/);
});

test("an issuer must list the domain in protected_resources", async () => {
    const fetch = fakeFetch({
        ...COMPANY_ROUTES,
        "https://auth.example.com/.well-known/oauth-authorization-server": {
            ...COMPANY_ROUTES["https://auth.example.com/.well-known/oauth-authorization-server"],
            protected_resources: ["https://other.example"],
        },
    });
    await fails(discover("example.com", { fetch }), /protected_resources/);
});

test("without protected resource metadata the identifier is the domain", async () => {
    const fetch = fakeFetch({ "https://example.com/.well-known/poppy.json": POPPY });
    assert.equal((await discover("example.com", { fetch })).identifier, "https://example.com");
});

test("an error from the protected resource metadata doesn't fall back to the domain", async () => {
    const fetch = fakeFetch({
        "https://example.com/.well-known/poppy.json": POPPY,
        "https://example.com/.well-known/oauth-protected-resource": () =>
            new Response("", { status: 500 }),
    });
    await fails(discover("example.com", { fetch }), /HTTP 500/);
});

test("chooses the newest compatible version (spec 3.4)", () => {
    const doc = {
        ...POPPY,
        protocol_version: "2.0",
        supported_versions: {
            "1.0": "https://example.com/1.json",
            "0.4": "https://example.com/0.4.json",
        },
    };
    assert.equal(selectVersion(doc, ["1.0"]), "1.0");
    assert.equal(selectVersion(doc, ["0.4"]), "0.4");
    assert.equal(selectVersion(doc, ["0.3"]), undefined);
});

test("issuer metadata URLs put the well-known path before the issuer's path", () => {
    assert.equal(
        issuerMetadataUrl("https://auth.provider.example/shop-a"),
        "https://auth.provider.example/.well-known/oauth-authorization-server/shop-a",
    );
    assert.equal(
        issuerMetadataUrl("https://auth.example.com"),
        "https://auth.example.com/.well-known/oauth-authorization-server",
    );
});

test("refuses private addresses unless allowed", async () => {
    await fails(discover("127.0.0.1", { fetch: fakeFetch({}) }), /loopback/);
    await fails(
        discover("example.com", {
            fetch: fakeFetch(COMPANY_ROUTES),
            lookup: async () => ["10.0.0.1"],
        }),
        /private/,
    );
});
