export class HistoryOtCommitDuringJoinError extends Error {
    constructor(readonly docId: string) {
        super(`History OT commit for ${docId} raced with its authoritative join`);
        this.name = 'HistoryOtCommitDuringJoinError';
    }
}

export interface HistoryOtJoinAttemptResult<T> {
    readonly value: T,
    readonly attempts: 1 | 2,
}

/**
 * Run one authoritative join, with exactly one fresh attempt when a sender
 * commit invalidates the snapshot being joined. Installing and releasing each
 * attempt are synchronous hooks so the caller can transfer realtime-event
 * buffer ownership without an asynchronous gap.
 */
export async function runHistoryOtJoinWithCommitRefresh<T, Buffer>(
    install: (attempt: 0 | 1) => Buffer,
    execute: (buffer: Buffer, attempt: 0 | 1) => Promise<T>,
    release: (buffer: Buffer, attempt: 0 | 1) => void,
): Promise<HistoryOtJoinAttemptResult<T>> {
    for (const attempt of [0, 1] as const) {
        const buffer = install(attempt);
        try {
            return {
                value: await execute(buffer, attempt),
                attempts: (attempt + 1) as 1 | 2,
            };
        } catch (error) {
            if (!(error instanceof HistoryOtCommitDuringJoinError) || attempt === 1) {
                throw error;
            }
        } finally {
            release(buffer, attempt);
        }
    }
    throw new Error('History OT join attempt budget exhausted');
}
