/* eslint-disable @typescript-eslint/naming-convention */
import {strict as assert} from 'assert';
import {
    buildRejectTrackedChangesOperation,
    parseHistoryOtSnapshot,
    serializeHistoryOtOperations,
} from '../core/historyOt';
import {
    appendHistoryOtThreadEvent,
    HistoryOtSession,
    HistoryOtSessionError,
    parseHistoryOtJoinState,
    parseHistoryOtRealtimeEnvelope,
    serializeHistoryOtJoinState,
    serializeHistoryOtRealtimeEnvelope,
} from '../core/historyOtSession';

const timestamp = '2026-08-31T00:00:00.000Z';

function join(snapshot: unknown = {content: 'abc'}, version = 5) {
    return {
        snapshot,
        version,
        operations: [],
        ranges: {},
        otType: 'history-ot',
    };
}

function readySession(
    level: 'owner' | 'readAndWrite' | 'review' | 'readOnly' = 'owner',
    snapshot: unknown = {content: 'abc'},
    version = 5,
    userId = 'user-a',
): HistoryOtSession {
    const session = new HistoryOtSession('doc-a', 1, {level, userId});
    const result = session.acceptJoin(1, join(snapshot, version));
    assert.equal(result.kind, 'joined');
    return session;
}

function fullUpdate(version: number, operation: unknown, source = 'remote-source') {
    return {
        doc: 'doc-a',
        v: version,
        op: operation,
        meta: {source, user_id: 'remote-user', ts: 1770000000000},
    };
}

describe('History OT realtime envelope protocol', () => {
    it('distinguishes a version-only sender ACK from one exact collaborator operation', () => {
        const ack = parseHistoryOtRealtimeEnvelope({doc: 'doc-a', v: 7});
        assert.equal(ack.safe, true);
        assert.equal(ack.classification, 'sender-ack');
        assert.equal(ack.operation, undefined);

        const update = parseHistoryOtRealtimeEnvelope(fullUpdate(7, [
            {textOperation: [3, 'x']},
        ]));
        assert.equal(update.safe, true);
        assert.equal(update.classification, 'collaborator-update');
        assert.equal(update.operation?.safe, true);
    });

    it('uses the Wave 1 exact-one gate and never promotes an offline sequence to wire-safe', () => {
        const empty = parseHistoryOtRealtimeEnvelope(fullUpdate(7, []));
        const multiple = parseHistoryOtRealtimeEnvelope(fullUpdate(7, [
            {textOperation: [3]},
            {noOp: true},
        ]));
        assert.equal(empty.safe, false);
        assert.equal(multiple.safe, false);
        assert.match(multiple.unsafeReasons.join(' '), /exactly one/);
    });

    it('round-trips unknown metadata byte-for-JSON while marking it unsafe', () => {
        const raw = {
            doc: 'doc-a',
            v: 7,
            op: [{textOperation: [3, 'x']}],
            meta: {
                source: 'remote-source',
                user_id: {opaque: 'user'},
                ts: ['opaque', 42],
                future: {range: {from: 1, to: 2}, author: {id: 'u'}},
            },
        };
        const parsed = parseHistoryOtRealtimeEnvelope(raw);
        assert.equal(parsed.safe, false);
        assert.deepEqual(serializeHistoryOtRealtimeEnvelope(parsed), raw);
        assert.deepEqual(parsed.user, {opaque: 'user'});
        assert.deepEqual(parsed.time, ['opaque', 42]);
        assert.match(parsed.unsafeReasons.join(' '), /future is unknown metadata/);
    });

    it('accepts official lastV/hash on full updates and fails closed on malformed values', () => {
        const raw = {
            ...fullUpdate(7, [{textOperation: [3, 'x']}]),
            lastV: 6,
            hash: 'opaque-history-hash',
        };
        const parsed = parseHistoryOtRealtimeEnvelope(raw);
        assert.equal(parsed.safe, true);
        assert.equal(parsed.lastVersion, 6);
        assert.equal(parsed.hash, 'opaque-history-hash');
        assert.deepEqual(serializeHistoryOtRealtimeEnvelope(parsed), raw);

        const malformed = {
            ...raw,
            lastV: 6.5,
            hash: 42,
        };
        const rejected = parseHistoryOtRealtimeEnvelope(malformed);
        assert.equal(rejected.safe, false);
        assert.deepEqual(serializeHistoryOtRealtimeEnvelope(rejected), malformed);
        assert.match(rejected.unsafeReasons.join(' '), /lastV/);
        assert.match(rejected.unsafeReasons.join(' '), /hash/);
    });

    it('fails closed on malformed and non-JSON envelopes', () => {
        assert.equal(parseHistoryOtRealtimeEnvelope({doc: '', v: 1.5}).safe, false);
        assert.equal(parseHistoryOtRealtimeEnvelope({doc: 'doc-a', v: 1, op: null}).safe, false);
        assert.throws(
            () => parseHistoryOtRealtimeEnvelope({doc: 'doc-a', v: Number.NaN}),
            /non-finite number/,
        );
    });

    it('preserves an unsafe join payload without mistaking replay data for a full join', () => {
        const raw = {
            ...join(),
            operations: [{op: [{textOperation: [3, 'x']}]}],
            futureJoinField: {opaque: true},
        };
        const parsed = parseHistoryOtJoinState(raw);
        assert.equal(parsed.safe, false);
        assert.deepEqual(serializeHistoryOtJoinState(parsed), raw);
        assert.match(parsed.unsafeReasons.join(' '), /authoritative full join/);
        assert.match(parsed.unsafeReasons.join(' '), /futureJoinField/);
    });
});

describe('HistoryOtSession ordering and recovery', () => {
    it('does not treat queue acceptance as commit and rejoins after otUpdateApplied', () => {
        const session = readySession();
        const staged = session.stage(1, {
            operation: [{textOperation: [1, 'X', 2]}],
            intent: {kind: 'plain-write'},
            publicId: 'source-one',
        });
        assert.equal(staged.kind, 'staged');
        assert.equal(staged.state.version, 5);

        const queued = session.markQueueAccepted(1);
        assert.equal(queued.kind, 'queue-accepted');
        assert.equal(queued.state.hasPendingOperation, true);
        assert.equal(queued.state.pendingQueued, true);
        assert.equal(queued.state.snapshot && (queued.state.snapshot as any).content, 'abc');

        const committed = session.receiveApplied(1, {doc: 'doc-a', v: 5});
        assert.equal(committed.kind, 'sender-commit');
        assert.equal(committed.requiresRejoin, true);
        assert.equal(committed.state.hasPendingOperation, false);
        assert.equal(committed.state.snapshot, undefined);

        const duplicateAck = session.receiveApplied(1, {doc: 'doc-a', v: 5});
        assert.equal(duplicateAck.kind, 'late-ack-ignored');
        assert.equal(duplicateAck.applied, false);
    });

    it('applies two concurrent collaborator updates only once and in version order', () => {
        const session = readySession();
        const first = session.receiveApplied(1, fullUpdate(5, [
            {textOperation: [1, 'X', 2]},
        ], 'remote-one'));
        assert.equal(first.kind, 'collaborator-applied');
        assert.equal(first.applied, true);
        assert.equal((first.state.snapshot as any).content, 'aXbc');
        assert.equal(first.state.version, 6);

        const second = session.receiveApplied(1, fullUpdate(6, [
            {textOperation: [4, 'Y']},
        ], 'remote-two'));
        assert.equal(second.kind, 'collaborator-applied');
        assert.equal((second.state.snapshot as any).content, 'aXbcY');
        assert.equal(second.state.version, 7);

        const repeated = session.receiveApplied(1, fullUpdate(5, [
            {textOperation: [1, 'X', 2]},
        ], 'remote-one'));
        assert.equal(repeated.kind, 'duplicate-ignored');
        assert.equal(repeated.applied, false);
        assert.equal((repeated.state.snapshot as any).content, 'aXbcY');

        const lateAck = session.receiveApplied(1, {doc: 'doc-a', v: 5});
        assert.equal(lateAck.kind, 'late-ack-ignored');
        assert.equal((lateAck.state.snapshot as any).content, 'aXbcY');
    });

    it('requires rejoin on a version gap, wrong document, or malformed update', () => {
        const gap = readySession().receiveApplied(1, fullUpdate(6, [
            {textOperation: [3, 'x']},
        ]));
        assert.equal(gap.requiresRejoin, true);
        assert.match(gap.reason ?? '', /version-gap/);

        const wrong = readySession().receiveApplied(1, {
            ...fullUpdate(5, [{textOperation: [3, 'x']}]),
            doc: 'doc-b',
        });
        assert.equal(wrong.requiresRejoin, true);
        assert.equal(wrong.reason, 'wrong-document');

        const malformed = readySession().receiveApplied(1, fullUpdate(5, [
            {futureOperation: true},
        ]));
        assert.equal(malformed.requiresRejoin, true);
        assert.match(malformed.reason ?? '', /unsafe-update/);
    });

    it('ignores retired generations and rejects future-generation events', () => {
        const staleSession = readySession();
        const stale = staleSession.receiveApplied(0, fullUpdate(5, [
            {textOperation: [3, 'x']},
        ]));
        assert.equal(stale.kind, 'stale-generation-ignored');
        assert.equal(stale.state.phase, 'ready');
        assert.equal((stale.state.snapshot as any).content, 'abc');

        const future = readySession().receiveApplied(2, fullUpdate(5, [
            {textOperation: [3, 'x']},
        ]));
        assert.equal(future.requiresRejoin, true);
        assert.equal(future.reason, 'future-generation');
    });

    it('recovers with the exact original operation/version and all prior public ids', () => {
        const session = readySession('owner', {content: 'abc'}, 5);
        const originalOperation = [{textOperation: [1, 'X', 2]}];
        session.stage(1, {
            operation: originalOperation,
            meta: {ts: {opaque: 'client-time'}},
            intent: {kind: 'plain-write'},
            publicId: 'source-old',
        });
        session.markQueueAccepted(1);
        const reconnecting = session.reconnect(2);
        assert.equal(reconnecting.kind, 'reconnect-started');
        assert.equal(reconnecting.requiresRejoin, false);
        assert.equal(reconnecting.state.phase, 'joining');

        const rejoined = session.acceptJoin(2, join({content: 'aXbc'}, 6));
        assert.equal(rejoined.state.phase, 'recovery-ready');
        const recovered = session.prepareRecovery(2, 'source-new');
        assert.equal(recovered.kind, 'recovery-staged');
        assert.deepEqual(recovered.envelope, {
            doc: 'doc-a',
            v: 5,
            op: originalOperation,
            meta: {ts: {opaque: 'client-time'}, source: 'source-new'},
            dupIfSource: ['source-old'],
        });

        const duplicate = session.receiveApplied(2, {
            ...(recovered.envelope as object),
            dup: true,
        });
        assert.equal(duplicate.kind, 'duplicate-acknowledged');
        assert.equal(duplicate.applied, false);
        assert.equal(duplicate.state.phase, 'ready');
        assert.equal((duplicate.state.snapshot as any).content, 'aXbc');
        assert.equal(duplicate.state.version, 6);
    });

    it('does not call local tracked algebra authoritative when a sender commits', () => {
        const snapshot = {
            content: 'abc',
            trackedChanges: [],
        };
        const session = readySession('owner', snapshot, 9);
        session.stage(1, {
            operation: [{textOperation: [1, {
                i: 'X',
                tracking: {type: 'insert', userId: 'user-a', ts: timestamp},
            }, 2]}],
            meta: {tc: 'opaque-seed'},
            intent: {kind: 'tracked-write'},
            publicId: 'source-one',
        });
        const committed = session.receiveApplied(1, {doc: 'doc-a', v: 9});
        assert.equal(committed.requiresRejoin, true);
        assert.equal(committed.state.snapshot, undefined);
    });

    it('proves exact-one operations apply before exposing an enqueue envelope', () => {
        const overRetain = readySession();
        assert.throws(
            () => overRetain.stage(1, {
                operation: [{textOperation: [4]}],
                intent: {kind: 'plain-write'},
                publicId: 'source',
            }),
            (error: unknown) => error instanceof HistoryOtSessionError
                && error.code === 'OPERATION_NOT_APPLICABLE',
        );
        assert.equal(overRetain.getState().phase, 'ready');
        assert.equal(overRetain.getState().hasPendingOperation, false);

        const invalidComment = readySession();
        assert.throws(
            () => invalidComment.stage(1, {
                operation: [{commentId: 'comment-a', ranges: [{pos: 2, length: 2}]}],
                intent: {kind: 'comment-write'},
                publicId: 'source',
            }),
            (error: unknown) => error instanceof HistoryOtSessionError
                && error.code === 'OPERATION_NOT_APPLICABLE',
        );
        assert.equal(invalidComment.getState().phase, 'ready');
        assert.equal(invalidComment.getState().hasPendingOperation, false);
    });
});

describe('HistoryOtSession permission intent gate', () => {
    const trackedOperation = [{textOperation: [1, {
        i: 'X',
        tracking: {type: 'insert', userId: 'user-a', ts: timestamp},
    }, 2]}];

    it('denies readOnly, unknown permission, and review plain-write bypasses', () => {
        assert.throws(
            () => readySession('readOnly').stage(1, {
                operation: [{textOperation: [1, 'X', 2]}],
                intent: {kind: 'plain-write'},
                publicId: 'source',
            }),
            /Permission does not allow/,
        );
        assert.throws(
            () => readySession('review').stage(1, {
                operation: [{textOperation: [1, 'X', 2]}],
                meta: {tc: 'attempted-bypass'},
                intent: {kind: 'tracked-write'},
                publicId: 'source',
            }),
            /untracked mutation/,
        );

        const uncertain = readySession();
        const transition = uncertain.updatePermission(1, {level: 'future-permission'});
        assert.equal(transition.requiresRejoin, true);
        assert.equal(transition.reason, 'permission-uncertain');
    });

    it('requires a non-empty opaque string tc seed rather than a guessed boolean', () => {
        const missing = readySession('review');
        assert.throws(
            () => missing.stage(1, {
                operation: trackedOperation,
                intent: {kind: 'tracked-write'},
                publicId: 'source',
            }),
            /meta.tc string seed/,
        );
        const guessed = readySession('review');
        assert.throws(
            () => guessed.stage(1, {
                operation: trackedOperation,
                meta: {tc: true},
                intent: {kind: 'tracked-write'},
                publicId: 'source',
            }),
            /meta.tc string seed/,
        );
        const valid = readySession('review').stage(1, {
            operation: trackedOperation,
            meta: {tc: 'opaque-seed'},
            intent: {kind: 'tracked-write'},
            publicId: 'source',
        });
        assert.equal(valid.kind, 'staged');
    });

    it('permits review rejection only when snapshot authorship and operation match', () => {
        const snapshot = {
            content: 'aIb',
            trackedChanges: [{
                range: {pos: 1, length: 1},
                tracking: {type: 'insert', userId: 'user-a', ts: timestamp},
            }],
        };
        const selectedRanges = [{pos: 1, length: 1}];
        const rejection = serializeHistoryOtOperations(buildRejectTrackedChangesOperation(
            parseHistoryOtSnapshot(snapshot),
            selectedRanges,
        ));
        const permitted = readySession('review', snapshot).stage(1, {
            operation: rejection,
            meta: {tc: 'reject-seed'},
            intent: {kind: 'tracked-decision', decision: 'reject', selectedRanges},
            publicId: 'source',
        });
        assert.equal(permitted.kind, 'staged');

        const otherAuthor = {
            ...snapshot,
            trackedChanges: [{
                ...snapshot.trackedChanges[0],
                tracking: {...snapshot.trackedChanges[0].tracking, userId: 'user-b'},
            }],
        };
        const otherRejection = serializeHistoryOtOperations(buildRejectTrackedChangesOperation(
            parseHistoryOtSnapshot(otherAuthor),
            selectedRanges,
        ));
        assert.throws(
            () => readySession('review', otherAuthor).stage(1, {
                operation: otherRejection,
                meta: {tc: 'reject-seed'},
                intent: {kind: 'tracked-decision', decision: 'reject', selectedRanges},
                publicId: 'source',
            }),
            /proven to belong/,
        );
        assert.throws(
            () => readySession('review', snapshot).stage(1, {
                operation: rejection,
                meta: {tc: 'accept-bypass'},
                intent: {kind: 'tracked-decision', decision: 'accept', selectedRanges},
                publicId: 'source',
            }),
            /Permission does not allow/,
        );
    });

    it('invalidates a pending plain write when permission transitions to review', () => {
        const session = readySession('owner');
        session.stage(1, {
            operation: [{textOperation: [1, 'X', 2]}],
            intent: {kind: 'plain-write'},
            publicId: 'source',
        });
        const transition = session.updatePermission(1, {level: 'review', userId: 'user-a'});
        assert.equal(transition.requiresRejoin, true);
        assert.equal(transition.reason, 'permission-changed-with-pending-operation');
    });

    it('invalidates every pending operation when proven identity changes or disappears', () => {
        const tracked = readySession('review');
        tracked.stage(1, {
            operation: trackedOperation,
            meta: {tc: 'opaque-seed'},
            intent: {kind: 'tracked-write'},
            publicId: 'source',
        });
        const changed = tracked.updatePermission(1, {level: 'review', userId: 'user-b'});
        assert.equal(changed.requiresRejoin, true);
        assert.equal(changed.reason, 'identity-changed-with-pending-operation');

        const plain = readySession('owner');
        plain.stage(1, {
            operation: [{textOperation: [1, 'X', 2]}],
            intent: {kind: 'plain-write'},
            publicId: 'source',
        });
        const disappeared = plain.updatePermission(1, {level: 'owner'});
        assert.equal(disappeared.requiresRejoin, true);
        assert.equal(disappeared.reason, 'identity-changed-with-pending-operation');
    });
});

describe('History OT raw thread-event extension point', () => {
    it('retains opaque range, thread, and author fields without projection loss', () => {
        const comment = {
            id: 'comment-a',
            content: 'hello',
            ranges: [{from: 1, to: 4, future: {side: 'left'}}],
            author: {id: 'user-a', futureRole: 'reviewer'},
            futureThreadField: {x: 1},
        };
        const reduced = appendHistoryOtThreadEvent(
            {events: []},
            'new-comment',
            ['thread-a', comment],
        );
        assert.deepEqual(reduced.events, [{event: 'new-comment', args: ['thread-a', comment]}]);
        assert.throws(
            () => appendHistoryOtThreadEvent(reduced, 'delete-thread', []),
            /unexpected argument list/,
        );
    });
});
