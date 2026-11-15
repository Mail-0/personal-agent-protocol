// Server-sent events, as conversation streams use them (spec 8.6).

export type ServerSentEvent = { id?: string; event: string; data: string };

// Parses a server-sent event stream. `event` defaults to "message", as in the SSE spec.
export async function* parseServerSentEvents(
    body: ReadableStream<Uint8Array>,
): AsyncGenerator<ServerSentEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let event: { id?: string; event?: string; data?: string } = {};

    function* lines(complete: string[]): Generator<ServerSentEvent> {
        for (const line of complete) {
            if (line === "") {
                if (event.data !== undefined) {
                    yield {
                        event: event.event || "message",
                        data: event.data,
                        ...(event.id !== undefined ? { id: event.id } : {}),
                    };
                }
                event = {};
                continue;
            }
            if (line.startsWith(":")) continue;
            const colon = line.indexOf(":");
            const field = colon === -1 ? line : line.slice(0, colon);
            const raw = colon === -1 ? "" : line.slice(colon + 1);
            const v = raw.startsWith(" ") ? raw.slice(1) : raw;
            if (field === "data") event.data = event.data === undefined ? v : `${event.data}\n${v}`;
            else if (field === "event") event.event = v;
            else if (field === "id" && !v.includes("\0")) event.id = v;
        }
    }

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            // A trailing \r may be the first half of \r\n, so it waits for the next chunk.
            const complete = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
            const split = complete.split(/\r\n|\r|\n/);
            buffer = (split.pop() ?? "") + buffer.slice(complete.length);
            yield* lines(split);
        }
        // At the end of the stream, a held \r ends its line.
        buffer += decoder.decode();
        if (buffer.endsWith("\r")) yield* lines(buffer.slice(0, -1).split(/\r\n|\r|\n/));
    } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}
