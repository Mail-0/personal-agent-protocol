// Runtime validation of wire documents against the protocol's JSON Schemas.

import { PoppyError } from "./errors.ts";
import { SCHEMAS } from "./generated/schemas.ts";
import { validateSchema, type SchemaError } from "./schema.ts";

export type { SchemaError };

const VALIDATION_SCHEMAS: Record<string, object> = {
    ...SCHEMAS,
    "poppy-0.4.schema.json": poppy04Schema(),
};

// The schema errors for a value, by schema file name, such as "poppy.schema.json", or a fragment,
// such as "poppy.schema.json#/$defs/https_url". Empty when it's valid.
export function schemaErrors(name: string, value: unknown): SchemaError[] {
    const [file] = name.split("#");
    if (!VALIDATION_SCHEMAS[file]) throw new Error(`No schema named ${file}.`);
    return validateSchema(
        name.includes("#") ? { $ref: name } : VALIDATION_SCHEMAS[file],
        value,
        VALIDATION_SCHEMAS,
    );
}

// Returns the value typed as T when it's valid, and throws invalid_response otherwise.
export function validate<T>(name: string, value: unknown): T {
    const errors = schemaErrors(name, value);
    if (errors.length) {
        const detail = errors
            .slice(0, 3)
            .map((e) => `${e.path || "/"} ${e.message}`)
            .join("; ");
        throw new PoppyError("invalid_response", `not a valid ${name}: ${detail}`);
    }
    return value as T;
}

function poppy04Schema(): object {
    const schema = structuredClone(SCHEMAS["poppy.schema.json"]) as {
        properties: { agent: { properties: { protocols: { items: { required: string[] } } } } };
    };
    const protocol = schema.properties.agent.properties.protocols.items;
    protocol.required = protocol.required.filter((field) => field !== "description");
    return schema;
}
