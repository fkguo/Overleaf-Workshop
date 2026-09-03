/* eslint-disable @typescript-eslint/naming-convention */
import {strict as assert} from 'assert';
import {
    HistoryOtThreadEventError,
    reduceHistoryOtThreadEvent,
    reduceHistoryOtThreadEvents,
} from '../core/historyOtThreads';

describe('History OT live comment thread reducer', () => {
    it('replays queued events after REST state without losing opaque fields', () => {
        const reduced = reduceHistoryOtThreadEvents({
            opaqueDirectory: {keep: true},
            threadA: {
                opaqueThread: 'keep',
                messages: [{id: 'messageA', content: 'old', opaqueMessage: 7}],
            },
        }, [
            {event: 'edit-message', args: ['threadA', 'messageA', 'new']},
            {event: 'new-comment', args: ['threadA', {
                id: 'messageB', content: 'reply', timestamp: 123, future: {keep: true},
            }]},
            {event: 'resolve-thread', args: ['threadA', {id: 'userA', futureUser: true}]},
        ], () => '2026-08-31T12:34:56.000Z');

        assert.deepEqual(reduced, {
            opaqueDirectory: {keep: true},
            threadA: {
                opaqueThread: 'keep',
                messages: [
                    {id: 'messageA', content: 'new', opaqueMessage: 7},
                    {id: 'messageB', content: 'reply', timestamp: 123, future: {keep: true}},
                ],
                resolved: true,
                resolved_by_user: {id: 'userA', futureUser: true},
                resolved_at: '2026-08-31T12:34:56.000Z',
            },
        });
    });

    it('merges thread batches, reopens, deletes messages, and deletes threads', () => {
        const batch = reduceHistoryOtThreadEvent({threadA: {local: true, messages: []}}, {
            event: 'new-comment-threads',
            args: [{
                threadA: {server: true, messages: [{id: 'a'}]},
                threadB: {future: 1, messages: [{id: 'b'}]},
            }],
        });
        const reopened = reduceHistoryOtThreadEvent({
            ...batch,
            threadA: {...batch.threadA as object, resolved: true, resolved_at: 'old'},
        }, {event: 'reopen-thread', args: ['threadA']});
        const withoutMessage = reduceHistoryOtThreadEvent(reopened, {
            event: 'delete-message', args: ['threadB', 'b'],
        });
        const deleted = reduceHistoryOtThreadEvent(withoutMessage, {
            event: 'delete-thread', args: ['threadA'],
        });

        assert.equal(deleted.threadA, undefined);
        assert.deepEqual(deleted.threadB, {future: 1, messages: []});
    });

    it('rejects malformed official-event shapes instead of mutating the projection', () => {
        for (const event of [
            {event: 'new-comment', args: ['threadA', {id: 'messageA'}]},
            {event: 'edit-message', args: ['threadA', {}, 'content']},
            {event: 'resolve-thread', args: ['threadA', {email: 'missing-id'}]},
            {event: 'new-comment-threads', args: [{threadA: {messages: 'not-an-array'}}]},
        ] as const) {
            assert.throws(
                () => reduceHistoryOtThreadEvent({}, event as any),
                (error: unknown) => error instanceof HistoryOtThreadEventError,
            );
        }
    });
});
