import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { discover } from "../src/discovery.ts";
import { fakeFetch } from "./fake.ts";

for (const domain of ["allbirds.com", "kith.com"]) {
    const fixture = JSON.parse(
        readFileSync(new URL(`./fixtures/${domain}.json`, import.meta.url), "utf8"),
    );
    const routes = fixture.responses;

    test(`${domain}: opt-in 0.4 discovery verifies recorded resource and issuer metadata`, async () => {
        const fetch = fakeFetch(routes);
        const result = await discover(domain, { versions: ["1.0", "0.4"], fetch });
        assert.equal(result.version, "0.4");
        assert.equal(result.domain, domain);
        assert.equal(result.identifier, fixture.issuer);
        assert.equal(result.issuer?.metadata.issuer, fixture.issuer);
        assert.equal(result.protectedResource?.resource, `https://${domain}`);
        assert.equal(result.document.agent?.protocols[0].description, undefined);
        assert.equal(fetch.calls.length, 3);
    });

    test(`${domain}: default discovery rejects 0.4`, async () => {
        await assert.rejects(
            discover(domain, { fetch: fakeFetch(routes) }),
            /version_unsupported|invalid_response/,
        );
    });

    test(`${domain}: 1.0 still requires protocol descriptions even with 0.4 enabled`, async () => {
        const url = `https://${domain}/.well-known/poppy.json`;
        await assert.rejects(
            discover(domain, {
                versions: ["1.0", "0.4"],
                fetch: fakeFetch({ ...routes, [url]: { ...routes[url], protocol_version: "1.0" } }),
            }),
            /invalid_response:.*description is required/,
        );
    });

    test(`${domain}: selects and validates an alternate 0.4 document`, async () => {
        const url = `https://${domain}/.well-known/poppy.json`;
        const alternate = `https://${domain}/poppy-0.4.json`;
        const fetch = fakeFetch({
            ...routes,
            [url]: {
                ...routes[url],
                protocol_version: "1.0",
                agent: {
                    protocols: [{ ...routes[url].agent.protocols[0], description: "Shopping" }],
                },
                supported_versions: { "0.4": alternate },
            },
            [alternate]: routes[url],
        });
        const result = await discover(domain, { versions: ["0.4"], fetch });
        assert.equal(result.url, alternate);
        assert.equal(result.document.agent?.protocols[0].description, undefined);
    });

    test(`${domain}: 0.4 still requires nonempty protocols and HTTPS endpoints`, async () => {
        const url = `https://${domain}/.well-known/poppy.json`;
        for (const protocols of [
            [],
            [{ type: "ucp" }],
            [{ type: "ucp", endpoint: "http://example.com" }],
        ]) {
            await assert.rejects(
                discover(domain, {
                    versions: ["1.0", "0.4"],
                    fetch: fakeFetch({
                        ...routes,
                        [url]: { ...routes[url], agent: { protocols } },
                    }),
                }),
                /invalid_response/,
            );
        }
    });

    test(`${domain}: 0.4 still verifies the issuer's ownership of the store`, async () => {
        const issuerUrl = Object.keys(routes).find((url) =>
            url.includes("oauth-authorization-server"),
        )!;
        await assert.rejects(
            discover(domain, {
                versions: ["1.0", "0.4"],
                fetch: fakeFetch({
                    ...routes,
                    [issuerUrl]: {
                        ...routes[issuerUrl],
                        protected_resources: ["https://other.example"],
                    },
                }),
            }),
            /protected_resources/,
        );
    });
}
