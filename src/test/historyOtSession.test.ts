/* eslint-disable @typescript-eslint/naming-convention */
import {strict as assert} from 'assert';
import {
    buildRejectTrackedChangesOperation,
    parseHistoryOtSnapshot,
    serializeHistoryOtOperations,
} from '../core/historyOt';
import {
    appendHistoryOtThreadEvent,
    awaitHistoryOtSubmissionCommit,
    HistoryOtSession,
    HistoryOtSessionError,
    parseHistoryOtJoinState,
    parseHistoryOtRealtimeEnvelope,
    serializeHistoryOtJoinState,
    serializeHistoryOtRealtimeEnvelope,
} from '../core/historyOtSession';

const timestamp = '2026-08-31T00:00:00.000Z';

function join(snapshot: unknown = {content: 'abc'}, version = 5, ranges: unknown = {}) {
    return {
        snapshot,
        version,
        operations: [],
        ranges,
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

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return {promise, resolve, reject};
}

describe('History OT submission confirmation', () => {
    it('accepts an authoritative commit when the enqueue ACK outcome is unknown', async () => {
        const enqueue = deferred<void>();
        const commit = deferred<void>();
        let marked = 0;
        const result = awaitHistoryOtSubmissionCommit(
            enqueue.promise,
            commit.promise,
            () => { marked += 1; },
            error => error === 'outcome-unknown',
        );

        commit.resolve();
        enqueue.reject('outcome-unknown');
        await result;
        assert.equal(marked, 0);
    });

    it('waits for the authoritative commit after a successful enqueue ACK', async () => {
        const enqueue = deferred<void>();
        const commit = deferred<void>();
        let marked = 0;
        let settled = false;
        const result = awaitHistoryOtSubmissionCommit(
            enqueue.promise,
            commit.promise,
            () => { marked += 1; },
            () => false,
        ).then(() => { settled = true; });

        enqueue.resolve();
        await Promise.resolve();
        assert.equal(marked, 1);
        assert.equal(settled, false);
        commit.resolve();
        await result;
        assert.equal(settled, true);
    });

    it('does not let a commit witness hide a deterministic enqueue rejection', async () => {
        const enqueue = deferred<void>();
        const commit = deferred<void>();
        const result = awaitHistoryOtSubmissionCommit(
            enqueue.promise,
            commit.promise,
            () => assert.fail('a rejected enqueue must not be marked accepted'),
            error => error === 'outcome-unknown',
        );

        commit.resolve();
        enqueue.reject('permission-denied');
        await assert.rejects(result, error => error === 'permission-denied');
    });

    it('preserves an outcome-unknown enqueue error when no commit can be proven', async () => {
        const enqueue = deferred<void>();
        const commit = deferred<void>();
        const result = awaitHistoryOtSubmissionCommit(
            enqueue.promise,
            commit.promise,
            () => assert.fail('an unknown enqueue outcome must not be marked accepted'),
            error => error === 'outcome-unknown',
        );

        enqueue.reject('outcome-unknown');
        commit.reject('commit-witness-lost');
        await assert.rejects(result, error => error === 'outcome-unknown');
    });
});

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

    it('accepts and round-trips official external source and object-origin metadata', () => {
        const externalSource = {
            ...fullUpdate(7, [{textOperation: [3, 'x']}], 'external-source'),
            meta: {
                source: 'external-source',
                type: 'external',
                user_id: null,
                ts: 1770000000000,
            },
        };
        const parsedExternal = parseHistoryOtRealtimeEnvelope(externalSource);
        assert.equal(parsedExternal.safe, true);
        assert.equal(parsedExternal.updateType, 'external');
        assert.deepEqual(serializeHistoryOtRealtimeEnvelope(parsedExternal), externalSource);

        const systemOrigin = {
            doc: 'doc-a',
            v: 7,
            op: [{textOperation: [3, 'x']}],
            meta: {
                origin: {
                    kind: 'history-resync',
                    provider: {name: 'system', opaqueToken: 42},
                },
                user_id: null,
                ts: 1770000000000,
            },
        };
        const parsedOrigin = parseHistoryOtRealtimeEnvelope(systemOrigin);
        assert.equal(parsedOrigin.safe, true);
        assert.deepEqual(parsedOrigin.origin, systemOrigin.meta.origin);
        assert.equal(parsedOrigin.source, undefined);
        assert.deepEqual(serializeHistoryOtRealtimeEnvelope(parsedOrigin), systemOrigin);
    });

    it('fails closed on unknown or ambiguous external/system metadata shapes', () => {
        const ordinaryWithoutSource = parseHistoryOtRealtimeEnvelope({
            doc: 'doc-a',
            v: 7,
            op: [{textOperation: [3, 'x']}],
            meta: {user_id: 'remote-user', ts: 1770000000000},
        });
        assert.equal(ordinaryWithoutSource.safe, false);
        assert.match(ordinaryWithoutSource.unsafeReasons.join(' '), /source or JSON-object origin/);

        const invalidType = parseHistoryOtRealtimeEnvelope({
            ...fullUpdate(7, [{textOperation: [3, 'x']}]),
            meta: {source: 'remote-source', type: 'internal'},
        });
        assert.equal(invalidType.safe, false);
        assert.match(invalidType.unsafeReasons.join(' '), /type must be external/);

        const invalidOrigin = parseHistoryOtRealtimeEnvelope({
            ...fullUpdate(7, [{textOperation: [3, 'x']}]),
            meta: {origin: ['not', 'an', 'object']},
        });
        assert.equal(invalidOrigin.safe, false);
        assert.match(invalidOrigin.unsafeReasons.join(' '), /origin must be a JSON object/);

        const ambiguous = parseHistoryOtRealtimeEnvelope({
            ...fullUpdate(7, [{textOperation: [3, 'x']}]),
            meta: {source: 'remote-source', origin: {kind: 'history-resync'}},
        });
        assert.equal(ambiguous.safe, false);
        assert.match(ambiguous.unsafeReasons.join(' '), /mutually exclusive/);
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

    it('accepts and preserves any JSON-object ranges returned by official history-ot joinDoc', () => {
        const ranges = {
            mock: 'ranges',
            comments: [{id: 'comment-a', range: {pos: 1, length: 2}}],
            futureRangeState: {opaque: [true, null, 42]},
        };
        const raw = join({content: 'abc'}, 42, ranges);
        const parsed = parseHistoryOtJoinState(raw);
        assert.equal(parsed.safe, true);
        assert.deepEqual(parsed.ranges, ranges);
        assert.deepEqual(serializeHistoryOtJoinState(parsed), raw);

        const session = new HistoryOtSession('doc-a', 1, {level: 'owner', userId: 'user-a'});
        const accepted = session.acceptJoin(1, raw);
        assert.equal(accepted.requiresRejoin, false);
        assert.deepEqual(accepted.state.ranges, ranges);

        const replay = parseHistoryOtJoinState({...raw, operations: [{v: 41}]});
        assert.equal(replay.safe, false);
        assert.match(replay.unsafeReasons.join(' '), /authoritative full join/);
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
        assert.ok(staged.envelope);
        const authorized = session.assertPendingSubmission(
            1,
            staged.envelope,
            {kind: 'plain-write'},
        );
        assert.notStrictEqual(authorized, staged.envelope);
        (staged.envelope as any).v = 99;
        assert.equal((authorized as any).v, 5);
        assert.throws(
            () => session.assertPendingSubmission(1, {
                ...(staged.envelope as object),
                v: 6,
            }, {kind: 'plain-write'}),
            (error: unknown) => error instanceof HistoryOtSessionError
                && error.code === 'UNAUTHORIZED_SUBMISSION',
        );

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

    it('does not commit a matching self full-update witness at the wrong base version', () => {
        const session = readySession();
        const operation = [{textOperation: [1, 'X', 2]}];
        session.stage(1, {
            operation,
            intent: {kind: 'plain-write'},
            publicId: 'source-one',
        });

        const mismatch = session.receiveApplied(1, fullUpdate(6, operation, 'source-one'));
        assert.equal(mismatch.kind, 'rejoin-required');
        assert.equal(mismatch.requiresRejoin, true);
        assert.equal(mismatch.reason, 'sender-full-update-version-mismatch');
        assert.equal(mismatch.state.hasPendingOperation, true);
        assert.equal(mismatch.state.pendingBaseVersion, 5);
    });

    it('does not commit a duplicate full-update witness at the wrong base version', () => {
        const session = readySession();
        const staged = session.stage(1, {
            operation: [{textOperation: [1, 'X', 2]}],
            intent: {kind: 'plain-write'},
            publicId: 'source-one',
        });
        assert.ok(staged.envelope);

        const mismatch = session.receiveApplied(1, {
            ...(staged.envelope as object),
            v: 6,
            dup: true,
        });
        assert.equal(mismatch.kind, 'rejoin-required');
        assert.equal(mismatch.requiresRejoin, true);
        assert.equal(mismatch.reason, 'duplicate-acknowledgement-version-mismatch');
        assert.equal(mismatch.state.hasPendingOperation, true);
        assert.equal(mismatch.state.pendingBaseVersion, 5);
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
        const unchanged = session.updatePermission(1, {level: 'owner', userId: 'user-a'});
        assert.equal(unchanged.requiresRejoin, false);
        assert.equal(unchanged.state.hasPendingOperation, true);
        assert.equal(unchanged.state.pendingRecoveryBlockedReason, undefined);
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
        assert.ok(recovered.envelope);
        session.assertPendingSubmission(2, recovered.envelope, {kind: 'plain-write'});

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
                && error.code === 'UNSUPPORTED_COMMENT_WRITE',
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

    it('keeps coarse comment mutation unsupported for every permission level', () => {
        for (const level of ['owner', 'readAndWrite', 'review', 'readOnly'] as const) {
            assert.throws(
                () => readySession(level).stage(1, {
                    operation: [{commentId: 'comment-a', resolved: true}],
                    intent: {kind: 'comment-write'},
                    publicId: 'source',
                }),
                (error: unknown) => error instanceof HistoryOtSessionError
                    && error.code === 'UNSUPPORTED_COMMENT_WRITE'
                    && /add\/state\/delete/.test(error.message)
                    && /ownership/.test(error.message),
                level,
            );
        }
        for (const operation of [
            {commentId: 'comment-a', ranges: [{pos: 0, length: 1}]},
            {deleteComment: 'comment-a'},
            {commentId: 'comment-a', resolved: true},
        ]) {
            assert.throws(
                () => readySession('owner').stage(1, {
                    operation: [operation],
                    intent: {kind: 'plain-write'},
                    publicId: 'source',
                }),
                (error: unknown) => error instanceof HistoryOtSessionError
                    && error.code === 'UNSUPPORTED_COMMENT_WRITE',
            );
        }
    });

    it('clones the authorized intent before permission and submission checks', () => {
        const session = readySession('owner');
        const intent: {kind: 'plain-write' | 'tracked-write'} = {kind: 'plain-write'};
        const staged = session.stage(1, {
            operation: [{textOperation: [1, 'X', 2]}],
            intent,
            publicId: 'source',
        });
        intent.kind = 'tracked-write';

        assert.throws(
            () => session.assertPendingSubmission(1, staged.envelope, intent),
            (error: unknown) => error instanceof HistoryOtSessionError
                && error.code === 'UNAUTHORIZED_SUBMISSION',
        );
        session.assertPendingSubmission(1, staged.envelope, {kind: 'plain-write'});
        const transition = session.updatePermission(1, {level: 'review', userId: 'user-a'});
        assert.equal(transition.requiresRejoin, true);
        assert.equal(transition.reason, 'permission-changed-with-pending-operation');
    });

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

    it('retires writable authority when the authenticated identity is absent', () => {
        const session = readySession('owner');
        const transition = session.updatePermission(1, {level: 'owner'});
        assert.equal(transition.requiresRejoin, true);
        assert.equal(transition.reason, 'identity-uncertain');
        assert.equal(transition.state.permission, undefined);
        assert.equal(transition.state.userId, undefined);
        assert.throws(
            () => session.stage(1, {
                operation: [{textOperation: [1, 'X', 2]}],
                intent: {kind: 'plain-write'},
                publicId: 'source',
            }),
            (error: unknown) => error instanceof HistoryOtSessionError
                && error.code === 'SESSION_NOT_READY',
        );

        const bornUnproven = new HistoryOtSession('doc-a', 1, {level: 'review'});
        const joined = bornUnproven.acceptJoin(1, join());
        assert.equal(joined.requiresRejoin, true);
        assert.equal(joined.state.permission, undefined);
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

    it('retains but blocks a pending write when permission no longer allows recovery', () => {
        const session = readySession('owner');
        session.stage(1, {
            operation: [{textOperation: [1, 'X', 2]}],
            intent: {kind: 'plain-write'},
            publicId: 'source',
        });
        const transition = session.updatePermission(1, {level: 'review', userId: 'user-a'});
        assert.equal(transition.requiresRejoin, true);
        assert.equal(transition.reason, 'permission-changed-with-pending-operation');
        assert.equal(transition.state.hasPendingOperation, true);
        assert.equal(
            transition.state.pendingRecoveryBlockedReason,
            'permission-changed-with-pending-operation',
        );

        session.reconnect(2);
        const joined = session.acceptJoin(2, join({content: 'abc'}, 5));
        assert.equal(joined.requiresRejoin, true);
        assert.equal(joined.state.hasPendingOperation, true);
        assert.throws(
            () => session.prepareRecovery(2, 'new-source'),
            (error: unknown) => error instanceof HistoryOtSessionError
                && error.code === 'RECOVERY_BLOCKED',
        );

        const review = readySession('review');
        review.stage(1, {
            operation: trackedOperation,
            meta: {tc: 'opaque-seed'},
            intent: {kind: 'tracked-write'},
            publicId: 'review-source',
        });
        const readOnly = review.updatePermission(1, {level: 'readOnly', userId: 'user-a'});
        assert.equal(readOnly.requiresRejoin, true);
        assert.equal(readOnly.state.hasPendingOperation, true);
        assert.equal(
            readOnly.state.pendingRecoveryBlockedReason,
            'permission-changed-with-pending-operation',
        );
    });

    it('retains the pending ledger but blocks recovery when proven identity changes', () => {
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
        assert.equal(changed.state.hasPendingOperation, true);
        assert.equal(
            changed.state.pendingRecoveryBlockedReason,
            'identity-changed-with-pending-operation',
        );
        tracked.reconnect(2);
        const joined = tracked.acceptJoin(2, join({content: 'abc'}, 5));
        assert.equal(joined.requiresRejoin, true);
        assert.equal(joined.state.hasPendingOperation, true);
        assert.throws(
            () => tracked.prepareRecovery(2, 'new-source'),
            (error: unknown) => error instanceof HistoryOtSessionError
                && error.code === 'RECOVERY_BLOCKED',
        );

        const plain = readySession('owner');
        plain.stage(1, {
            operation: [{textOperation: [1, 'X', 2]}],
            intent: {kind: 'plain-write'},
            publicId: 'source',
        });
        const disappeared = plain.updatePermission(1, {level: 'owner'});
        assert.equal(disappeared.requiresRejoin, true);
        assert.equal(disappeared.reason, 'identity-changed-with-pending-operation');
        assert.equal(disappeared.state.hasPendingOperation, true);
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
