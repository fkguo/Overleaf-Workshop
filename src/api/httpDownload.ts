import { constants as bufferConstants } from 'buffer';

export interface DownloadResponse {
    status: number;
    headers: {
        get(name: string): string | null;
    };
    arrayBuffer(): Promise<ArrayBuffer>;
}

export type DownloadFetch = (
    url: string,
    init: {
        method: 'GET',
        redirect: 'manual',
        headers: Record<string, string>,
    },
) => Promise<DownloadResponse>;

export interface DownloadLimits {
    maxBytes: number;
    maxChunks: number;
}

export const DEFAULT_DOWNLOAD_LIMITS: DownloadLimits = {
    // Preserve compatibility with large PDFs/project archives while refusing any
    // declared total which this Node runtime cannot represent as one Buffer.
    maxBytes: bufferConstants.MAX_LENGTH,
    maxChunks: 4096,
};

type ContentRange = {
    start: number,
    end: number,
    total: number,
};

function parseContentRange(value: string | null): ContentRange {
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? '');
    if (!match) {
        throw new Error(`Invalid or missing Content-Range: ${value ?? '<missing>'}`);
    }

    const start = Number(match[1]);
    const end = Number(match[2]);
    const total = Number(match[3]);
    if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        !Number.isSafeInteger(total) ||
        start < 0 ||
        end < start ||
        total <= end
    ) {
        throw new Error(`Invalid Content-Range bounds: ${value}`);
    }
    return {start, end, total};
}

function assertWithinLimit(size: number, limits: DownloadLimits) {
    if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxBytes) {
        throw new Error(`Download size ${size} exceeds the ${limits.maxBytes} byte limit`);
    }
}

/**
 * Download a response in one complete 200 response or contiguous 206 ranges.
 *
 * Every 206 response must identify the exact requested start offset and advance it.
 * This prevents a server which repeats the same partial response from causing an
 * infinite loop or silently duplicating bytes.
 */
export async function downloadWithRanges(
    url: string,
    baseHeaders: Record<string, string>,
    fetchResponse: DownloadFetch,
    limits: DownloadLimits = DEFAULT_DOWNLOAD_LIMITS,
): Promise<Buffer> {
    if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 0) {
        throw new Error('Download maxBytes must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(limits.maxChunks) || limits.maxChunks <= 0) {
        throw new Error('Download maxChunks must be a positive safe integer');
    }

    const chunks: Buffer[] = [];
    let nextOffset = 0;
    let expectedTotal: number | undefined;

    for (let requestCount = 0; requestCount < limits.maxChunks; requestCount += 1) {
        const requestedOffset = nextOffset;
        const headers = {...baseHeaders};
        // Byte ranges and Content-Range describe the identity representation.
        // Avoid transparent compression changing the number of buffered bytes.
        headers['accept-encoding'] = 'identity';
        // The first request deliberately has no Range header: an empty resource can
        // then return a normal zero-byte 200 instead of a legitimate 416. Continue
        // with an explicit offset only after the server elects to send a 206.
        if (requestCount > 0) { headers.range = `bytes=${requestedOffset}-`; }
        const response = await fetchResponse(url, {
            method: 'GET',
            redirect: 'manual',
            headers,
        });

        if (response.status === 200) {
            if (requestedOffset !== 0) {
                throw new Error('Server returned a full response after a partial download');
            }
            const contentLength = response.headers.get('content-length');
            if (contentLength !== null) {
                if (!/^\d+$/.test(contentLength)) {
                    throw new Error(`Invalid Content-Length: ${contentLength}`);
                }
                assertWithinLimit(Number(contentLength), limits);
            }
            const body = Buffer.from(await response.arrayBuffer());
            assertWithinLimit(body.length, limits);
            if (contentLength !== null && body.length !== Number(contentLength)) {
                throw new Error(
                    `Response length ${body.length} does not match Content-Length ${contentLength}`,
                );
            }
            return body;
        }

        if (response.status !== 206) {
            throw new Error(`Download failed with HTTP ${response.status}`);
        }

        const range = parseContentRange(response.headers.get('content-range'));
        if (range.start !== requestedOffset) {
            throw new Error(
                `Content-Range did not advance monotonically: requested ${requestedOffset}, received ${range.start}`,
            );
        }
        if (expectedTotal !== undefined && range.total !== expectedTotal) {
            throw new Error(`Content-Range total changed from ${expectedTotal} to ${range.total}`);
        }
        expectedTotal ??= range.total;
        assertWithinLimit(expectedTotal, limits);

        const body = Buffer.from(await response.arrayBuffer());
        const expectedLength = range.end - range.start + 1;
        if (body.length !== expectedLength) {
            throw new Error(
                `Partial response length ${body.length} does not match Content-Range length ${expectedLength}`,
            );
        }
        chunks.push(body);
        nextOffset = range.end + 1;

        if (nextOffset === expectedTotal) {
            const content = Buffer.concat(chunks);
            if (content.length !== expectedTotal) {
                throw new Error(`Downloaded ${content.length} bytes but expected ${expectedTotal}`);
            }
            return content;
        }
    }

    throw new Error(`Download exceeded the ${limits.maxChunks} chunk limit`);
}
