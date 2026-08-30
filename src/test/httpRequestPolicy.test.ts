import { strict as assert } from 'assert';
import { shouldRetryHttpRequest } from '../api/httpRequestPolicy';

describe('shouldRetryHttpRequest', () => {
    it('retries transient read failures', () => {
        assert.equal(shouldRetryHttpRequest('GET', undefined, 'fetch failed: ECONNRESET'), true);
        assert.equal(shouldRetryHttpRequest('GET', 429), true);
        assert.equal(shouldRetryHttpRequest('GET', 503), true);
    });

    it('does not retry permanent read failures', () => {
        assert.equal(shouldRetryHttpRequest('GET', 401), false);
        assert.equal(shouldRetryHttpRequest('GET', 404), false);
        assert.equal(shouldRetryHttpRequest('GET', undefined, 'Unexpected token in JSON'), false);
    });

    it('never automatically replays mutations after an ambiguous failure', () => {
        for (const method of ['POST', 'PUT', 'DELETE'] as const) {
            assert.equal(shouldRetryHttpRequest(method, undefined, 'ECONNRESET'), false);
            assert.equal(shouldRetryHttpRequest(method, 429), false);
            assert.equal(shouldRetryHttpRequest(method, 503), false);
        }
    });
});
