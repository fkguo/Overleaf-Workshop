export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/**
 * Only read-only requests may be replayed automatically.
 *
 * A timed-out mutation can already have committed on the server. Replaying it can
 * create duplicates, delete a newly replaced entity, or reuse a consumed stream.
 */
export function shouldRetryHttpRequest(
    method: HttpMethod,
    statusCode: number | undefined,
    errorMessage = '',
): boolean {
    if (method !== 'GET') { return false; }
    if (statusCode !== undefined && (statusCode >= 500 || statusCode === 429)) {
        return true;
    }
    if (statusCode !== undefined) { return false; }
    return [
        'ECONNRESET',
        'ETIMEDOUT',
        'ECONNREFUSED',
        'ENOTFOUND',
        'socket hang up',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_SOCKET',
    ].some(fragment => errorMessage.includes(fragment));
}
