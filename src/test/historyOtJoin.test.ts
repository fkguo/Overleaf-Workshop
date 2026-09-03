import {strict as assert} from 'assert';
import {
    HistoryOtCommitDuringJoinError,
    runHistoryOtJoinWithCommitRefresh,
} from '../core/historyOtJoin';

describe('History OT commit-during-join coordinator', () => {
    it('installs a new buffer synchronously before the one allowed refresh', async () => {
        const order: string[] = [];
        let active: {attempt: number} | undefined;

        const result = await runHistoryOtJoinWithCommitRefresh(
            attempt => {
                assert.equal(active, undefined);
                const buffer = {attempt};
                active = buffer;
                order.push(`install-${attempt}`);
                return buffer;
            },
            async (buffer, attempt) => {
                assert.strictEqual(active, buffer);
                order.push(`execute-${attempt}`);
                if (attempt === 0) {
                    throw new HistoryOtCommitDuringJoinError('doc-a');
                }
                return 'authoritative-v6';
            },
            (buffer, attempt) => {
                assert.strictEqual(active, buffer);
                active = undefined;
                order.push(`release-${attempt}`);
            },
        );

        assert.deepEqual(result, {value: 'authoritative-v6', attempts: 2});
        assert.deepEqual(order, [
            'install-0', 'execute-0', 'release-0',
            'install-1', 'execute-1', 'release-1',
        ]);
    });

    it('never makes a third attempt and does not retry unrelated failures', async () => {
        let attempts = 0;
        await assert.rejects(
            runHistoryOtJoinWithCommitRefresh(
                attempt => ({attempt}),
                async () => {
                    attempts += 1;
                    throw new HistoryOtCommitDuringJoinError('doc-a');
                },
                () => {},
            ),
            (error: unknown) => error instanceof HistoryOtCommitDuringJoinError,
        );
        assert.equal(attempts, 2);

        attempts = 0;
        await assert.rejects(
            runHistoryOtJoinWithCommitRefresh(
                attempt => ({attempt}),
                async () => {
                    attempts += 1;
                    throw new Error('join failed');
                },
                () => {},
            ),
            /join failed/,
        );
        assert.equal(attempts, 1);
    });
});
