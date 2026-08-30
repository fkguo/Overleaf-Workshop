import { strict as assert } from 'assert';
import {
    DownloadFetch,
    DownloadResponse,
    downloadWithRanges,
} from '../api/httpDownload';

class HeadersStub {
    constructor(private readonly values: Record<string, string> = {}) {}

    get(name: string): string | null {
        return this.values[name.toLowerCase()] ?? null;
    }
}

function response(
    status: number,
    body: string,
    contentRange?: string,
    contentLength?: string,
): DownloadResponse {
    const bytes = Buffer.from(body);
    const headers: Record<string, string> = {};
    if (contentRange) { headers['content-range'] = contentRange; }
    if (contentLength) { headers['content-length'] = contentLength; }
    return {
        status,
        headers: new HeadersStub(headers),
        arrayBuffer: async () => bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
    };
}

function fetchSequence(responses: DownloadResponse[]) {
    const requests: Array<{url: string, range?: string, acceptEncoding?: string}> = [];
    const fetchResponse: DownloadFetch = async (url, init) => {
        requests.push({
            url,
            range: init.headers.range,
            acceptEncoding: init.headers['accept-encoding'],
        });
        const next = responses.shift();
        if (!next) { throw new Error('Unexpected extra request'); }
        return next;
    };
    return {fetchResponse, requests};
}

describe('downloadWithRanges', () => {
    it('accepts one complete 200 response', async () => {
        const mock = fetchSequence([response(200, 'complete')]);
        const content = await downloadWithRanges('https://example.test/file', {}, mock.fetchResponse);
        assert.equal(content.toString(), 'complete');
        assert.deepEqual(mock.requests, [{
            url: 'https://example.test/file',
            range: undefined,
            acceptEncoding: 'identity',
        }]);
    });

    it('requests contiguous ranges until the declared total is complete', async () => {
        const mock = fetchSequence([
            response(206, 'abc', 'bytes 0-2/6'),
            response(206, 'def', 'bytes 3-5/6'),
        ]);
        const content = await downloadWithRanges('https://example.test/file', {}, mock.fetchResponse);
        assert.equal(content.toString(), 'abcdef');
        assert.deepEqual(mock.requests.map(request => request.range), [undefined, 'bytes=3-']);
    });

    it('rejects a repeated 206 range instead of requesting it indefinitely', async () => {
        const mock = fetchSequence([
            response(206, 'abc', 'bytes 0-2/6'),
            response(206, 'abc', 'bytes 0-2/6'),
        ]);
        await assert.rejects(
            downloadWithRanges('https://example.test/file', {}, mock.fetchResponse),
            /did not advance monotonically/,
        );
        assert.deepEqual(mock.requests.map(request => request.range), [undefined, 'bytes=3-']);
    });

    it('rejects missing or malformed Content-Range metadata', async () => {
        for (const contentRange of [undefined, 'bytes */6', 'bytes 0-6/6']) {
            const mock = fetchSequence([response(206, 'abc', contentRange)]);
            await assert.rejects(
                downloadWithRanges('https://example.test/file', {}, mock.fetchResponse),
                /Content-Range/,
            );
        }
    });

    it('rejects a changed total and a body which disagrees with its range', async () => {
        const changedTotal = fetchSequence([
            response(206, 'abc', 'bytes 0-2/6'),
            response(206, 'defg', 'bytes 3-6/7'),
        ]);
        await assert.rejects(
            downloadWithRanges('https://example.test/file', {}, changedTotal.fetchResponse),
            /total changed/,
        );

        const wrongLength = fetchSequence([response(206, 'ab', 'bytes 0-2/3')]);
        await assert.rejects(
            downloadWithRanges('https://example.test/file', {}, wrongLength.fetchResponse),
            /does not match Content-Range length/,
        );
    });

    it('rejects redirects, authentication failures, and server failures', async () => {
        for (const status of [302, 401, 500]) {
            const mock = fetchSequence([response(status, '')]);
            await assert.rejects(
                downloadWithRanges('https://example.test/file', {}, mock.fetchResponse),
                new RegExp(`HTTP ${status}`),
            );
        }
    });

    it('enforces the declared total and complete-response byte limit', async () => {
        const partial = fetchSequence([response(206, 'a', 'bytes 0-0/4')]);
        await assert.rejects(
            downloadWithRanges(
                'https://example.test/file',
                {},
                partial.fetchResponse,
                {maxBytes: 3, maxChunks: 4},
            ),
            /exceeds the 3 byte limit/,
        );

        const complete = fetchSequence([response(200, 'abcd')]);
        await assert.rejects(
            downloadWithRanges(
                'https://example.test/file',
                {},
                complete.fetchResponse,
                {maxBytes: 3, maxChunks: 4},
            ),
            /exceeds the 3 byte limit/,
        );
    });

    it('accepts an empty 200 response without sending an initial Range header', async () => {
        const mock = fetchSequence([response(200, '', undefined, '0')]);
        const content = await downloadWithRanges('https://example.test/empty', {}, mock.fetchResponse);
        assert.equal(content.length, 0);
        assert.equal(mock.requests[0].range, undefined);
    });

    it('rejects invalid or inconsistent Content-Length metadata', async () => {
        const invalid = fetchSequence([response(200, 'abc', undefined, 'unknown')]);
        await assert.rejects(
            downloadWithRanges('https://example.test/file', {}, invalid.fetchResponse),
            /Invalid Content-Length/,
        );

        const inconsistent = fetchSequence([response(200, 'abc', undefined, '4')]);
        await assert.rejects(
            downloadWithRanges('https://example.test/file', {}, inconsistent.fetchResponse),
            /does not match Content-Length/,
        );
    });

    it('rejects a full response which arrives after partial data', async () => {
        const mock = fetchSequence([
            response(206, 'abc', 'bytes 0-2/6'),
            response(200, 'abcdef'),
        ]);
        await assert.rejects(
            downloadWithRanges('https://example.test/file', {}, mock.fetchResponse),
            /full response after a partial download/,
        );
    });

    it('enforces a chunk-count upper bound', async () => {
        const mock = fetchSequence([
            response(206, 'a', 'bytes 0-0/3'),
            response(206, 'b', 'bytes 1-1/3'),
        ]);
        await assert.rejects(
            downloadWithRanges(
                'https://example.test/file',
                {},
                mock.fetchResponse,
                {maxBytes: 3, maxChunks: 2},
            ),
            /chunk limit/,
        );
        assert.deepEqual(mock.requests.map(request => request.range), [undefined, 'bytes=1-']);
    });
});
