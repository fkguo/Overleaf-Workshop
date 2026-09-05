import {strict as assert} from 'assert';
import {applyTextOperations, TextOperation} from '../core/documentUpdate';
import {
    acknowledgeHistorySubmission,
    applyUtf16TextOperations,
    beginHistorySubmission,
    beginLocalEditorSubmission,
    commitHistoryCleanRemoteEditorTransaction,
    commitHistoryRemoteEditorTransaction,
    commitRemoteEditorTransaction,
    confirmLocalEditorSubmission,
    createHistoryRealtimeEditorBridgeState,
    createRealtimeEditorBridgeState,
    prepareHistoryRemoteEditorTransaction,
    prepareRemoteEditorTransaction,
    rebindHistorySubmissionForRecovery,
    rebindLocalEditorPendingOperations,
    reconcileHistoryEditorAfterJoin,
    recordHistoryLocalEditorChange,
    recordLocalEditorChange,
    rejectHistorySubmission,
    rejectLocalEditorSubmission,
    transformHistoryRemoteOperation,
    transformLegacyRemoteOperation,
} from '../core/realtimeEditorBridge';
import {
    applyHistoryOtOperations,
    buildHistoryOtTextUpdate,
    getVisibleHistoryOtText,
    parseHistoryOtOperations,
    parseHistoryOtSnapshot,
    serializeHistoryOtOperations,
    serializeHistoryOtSnapshot,
    StringFileDataSnapshot,
} from '../core/historyOt';

const historyTimestamp = '2026-08-31T06:00:00.000Z';

function bound(content = 'abc') {
    return createRealtimeEditorBridgeState({
        socketGeneration: 4,
        remoteEpoch: 'epoch-1',
        remoteVersion: 12,
        remoteContent: content,
        documentVersion: 7,
        editorContent: content,
    });
}

describe('realtime editor bridge', () => {
    it('rebinds pending operations only when they exactly reproduce the editor text', () => {
        const exact = rebindLocalEditorPendingOperations(
            bound('aRbc'),
            7,
            'aRbcL',
            [{p: 4, i: 'L'}],
        );
        const contradictory = rebindLocalEditorPendingOperations(
            bound('aRbc'),
            7,
            'aRbcL',
            [{p: 0, i: 'X'}],
        );
        const wrongDocumentVersion = rebindLocalEditorPendingOperations(
            bound('aRbc'),
            8,
            'aRbcL',
            [{p: 4, i: 'L'}],
        );

        assert.equal(exact.valid, true);
        assert.deepEqual(exact.pendingOperations, [{p: 4, i: 'L'}]);
        assert.deepEqual(exact.localOperations, [{p: 4, i: 'L'}]);
        assert.equal(exact.inflightWire, undefined);
        assert.equal(contradictory.valid, false);
        assert.equal(wrongDocumentVersion.valid, false);
    });

    it('rebases a local insertion while applying a collaborator insertion to a dirty buffer', () => {
        const dirty = recordLocalEditorChange(
            bound(),
            8,
            [{rangeOffset: 3, rangeLength: 0, text: 'L'}],
            'abcL',
        );
        const transaction = prepareRemoteEditorTransaction(
            dirty,
            'remote-1',
            12,
            [{p: 1, i: 'R'}],
        );
        assert.deepEqual(transaction.remoteAfterLocal, [{p: 1, i: 'R'}]);
        assert.deepEqual(transaction.localAfterRemote, [{p: 4, i: 'L'}]);
        assert.deepEqual(transaction.expectedChange, {
            rangeOffset: 1,
            rangeLength: 0,
            text: 'R',
        });

        const committed = commitRemoteEditorTransaction(
            dirty,
            transaction,
            9,
            [transaction.expectedChange!],
            'aRbcL',
        );
        assert.equal(committed.valid, true);
        assert.equal(committed.remoteVersion, 13);
        assert.equal(committed.remoteContent, 'aRbc');
        assert.equal(committed.editorContent, 'aRbcL');
        assert.deepEqual(committed.localOperations, [{p: 4, i: 'L'}]);
    });

    it('gives the server deterministic precedence for same-position insertions', () => {
        const dirty = recordLocalEditorChange(
            bound(),
            8,
            [{rangeOffset: 1, rangeLength: 0, text: 'L'}],
            'aLbc',
        );
        const transaction = prepareRemoteEditorTransaction(
            dirty,
            'remote-tie',
            12,
            [{p: 1, i: 'R'}],
        );
        assert.deepEqual(transaction.remoteAfterLocal, [{p: 1, i: 'R'}]);
        assert.deepEqual(transaction.localAfterRemote, [{p: 2, i: 'L'}]);
        assert.equal(transaction.nextEditorContent, 'aRLbc');
        assert.equal(
            applyTextOperations(transaction.nextRemoteContent, transaction.localAfterRemote),
            transaction.nextEditorContent,
        );
    });

    it('converges overlapping deletions when their common text agrees', () => {
        const initial = bound('abcd');
        const dirty = recordLocalEditorChange(
            initial,
            8,
            [{rangeOffset: 1, rangeLength: 2, text: ''}],
            'ad',
        );
        const transaction = prepareRemoteEditorTransaction(
            dirty,
            'remote-delete',
            12,
            [{p: 2, d: 'cd'}],
        );
        assert.equal(transaction.nextRemoteContent, 'ab');
        assert.equal(transaction.nextEditorContent, 'a');
        assert.equal(
            applyTextOperations(transaction.nextRemoteContent, transaction.localAfterRemote),
            'a',
        );
        assert.equal(
            applyTextOperations(dirty.editorContent, transaction.remoteAfterLocal),
            'a',
        );
    });

    it('consumes the exact programmatic change without recording it as local input', () => {
        const state = bound();
        const transaction = prepareRemoteEditorTransaction(
            state,
            'remote-clean',
            12,
            [{p: 1, i: 'R'}],
        );
        const committed = commitRemoteEditorTransaction(
            state,
            transaction,
            8,
            [transaction.expectedChange!],
            'aRbc',
        );
        assert.deepEqual(committed.localOperations, []);
        assert.equal(committed.valid, true);
    });

    it('invalidates on feedback mismatch and on a zero-event visible update', () => {
        const state = bound();
        const transaction = prepareRemoteEditorTransaction(
            state,
            'remote-mismatch',
            12,
            [{p: 1, i: 'R'}],
        );
        const mismatched = commitRemoteEditorTransaction(
            state,
            transaction,
            8,
            [{rangeOffset: 2, rangeLength: 0, text: 'R'}],
            'abRc',
        );
        assert.equal(mismatched.valid, false);

        const missing = commitRemoteEditorTransaction(
            state,
            transaction,
            7,
            [],
            'abc',
        );
        assert.equal(missing.valid, false);
    });

    it('commits a metadata-only revision without inventing a text change', () => {
        const state = bound();
        const transaction = prepareRemoteEditorTransaction(
            state,
            'remote-metadata',
            12,
            [],
        );
        assert.equal(transaction.expectedChange, undefined);
        const committed = commitRemoteEditorTransaction(
            state,
            transaction,
            7,
            [],
            'abc',
        );
        assert.equal(committed.remoteVersion, 13);
        assert.deepEqual(committed.localOperations, []);
        assert.equal(committed.valid, true);
    });

    it('uses UTF-16 code units without allowing surrogate-splitting operations', () => {
        assert.equal(applyUtf16TextOperations('a😀b', [{p: 3, i: 'X'}]), 'a😀Xb');
        assert.throws(
            () => applyUtf16TextOperations('a😀b', [{p: 2, i: 'X'}]),
            /UTF-16 character boundary/,
        );
        assert.throws(
            () => applyUtf16TextOperations('a😀b', [{p: 1, d: '\uD83D'}]),
            /UTF-16 character boundary|well-formed UTF-16/,
        );
    });

    it('records exact multi-change local causality but invalidates a missed version', () => {
        const missed = recordLocalEditorChange(
            bound(),
            9,
            [{rangeOffset: 3, rangeLength: 0, text: 'L'}],
            'abcL',
        );
        assert.equal(missed.valid, false);

        const multi = recordLocalEditorChange(
            bound(),
            8,
            [
                {rangeOffset: 3, rangeLength: 0, text: 'R'},
                {rangeOffset: 0, rangeLength: 0, text: 'L'},
            ],
            'LabcR',
        );
        assert.equal(multi.valid, true);
        assert.deepEqual(multi.pendingOperations, [{p: 3, i: 'R'}, {p: 0, i: 'L'}]);
        assert.equal(
            applyTextOperations(multi.remoteContent, multi.localOperations),
            multi.editorContent,
        );
    });

    it('keeps insert-then-delete input causally valid when the visible text returns to base', () => {
        const inserted = recordLocalEditorChange(
            bound(),
            8,
            [{rangeOffset: 3, rangeLength: 0, text: 'XYZ'}],
            'abcXYZ',
        );
        const deleted = recordLocalEditorChange(
            inserted,
            9,
            [{rangeOffset: 3, rangeLength: 3, text: ''}],
            'abc',
        );

        assert.equal(deleted.valid, true);
        assert.deepEqual(deleted.pendingOperations, [
            {p: 3, i: 'XYZ'},
            {p: 3, d: 'XYZ'},
        ]);
        assert.equal(
            applyTextOperations(deleted.remoteContent, deleted.localOperations),
            deleted.editorContent,
        );
    });

    it('keeps the sent wire immutable while rebasing its view and later local input', () => {
        const dirty = recordLocalEditorChange(
            bound('ab'),
            8,
            [{rangeOffset: 1, rangeLength: 0, text: 'L'}],
            'aLb',
        );
        const originalWire: TextOperation[] = [{p: 1, i: 'L'}];
        const submitted = beginLocalEditorSubmission(dirty, 'submission-1', originalWire);
        originalWire[0].p = 0;
        const typedAgain = recordLocalEditorChange(
            submitted,
            9,
            [{rangeOffset: 3, rangeLength: 0, text: '!'}],
            'aLb!',
        );
        const transaction = prepareRemoteEditorTransaction(
            typedAgain,
            'remote-inflight',
            12,
            [{p: 1, i: 'R'}],
        );
        const remoteCommitted = commitRemoteEditorTransaction(
            typedAgain,
            transaction,
            10,
            [transaction.expectedChange!],
            'aRLb!',
        );

        assert.deepEqual(remoteCommitted.inflightWire, [{p: 1, i: 'L'}]);
        assert.deepEqual(remoteCommitted.inflightView, [{p: 2, i: 'L'}]);
        assert.deepEqual(remoteCommitted.pendingOperations, [{p: 4, i: '!'}]);
        const acknowledged = confirmLocalEditorSubmission(
            remoteCommitted,
            'submission-1',
            13,
            [{p: 1, i: 'L'}],
        );
        assert.equal(acknowledged.valid, true);
        assert.equal(acknowledged.remoteVersion, 14);
        assert.equal(acknowledged.remoteContent, 'aRLb');
        assert.equal(acknowledged.editorContent, 'aRLb!');
        assert.equal(acknowledged.documentVersion, 10, 'ACK emits no editor change');
        assert.equal(acknowledged.inflightWire, undefined);
        assert.equal(acknowledged.inflightView, undefined);
        assert.deepEqual(acknowledged.localOperations, [{p: 4, i: '!'}]);
    });

    it('rejects a repeated-text wire that is textually equal but causally different', () => {
        const dirty = recordLocalEditorChange(
            bound('aaaa'),
            8,
            [{rangeOffset: 0, rangeLength: 1, text: ''}],
            'aaa',
        );
        assert.throws(
            () => beginLocalEditorSubmission(
                dirty,
                'ambiguous-wire',
                [{p: 1, d: 'a'}],
            ),
            /exact unsent local operation/,
        );
        const submitted = beginLocalEditorSubmission(
            dirty,
            'exact-wire',
            [{p: 0, d: 'a'}],
        );
        assert.deepEqual(submitted.inflightWire, [{p: 0, d: 'a'}]);
    });

    it('restores a known-rejected rebased wire view ahead of later pending input', () => {
        const dirty = recordLocalEditorChange(
            bound('ab'),
            8,
            [{rangeOffset: 1, rangeLength: 0, text: 'L'}],
            'aLb',
        );
        const submitted = beginLocalEditorSubmission(
            dirty,
            'submission-reject',
            [{p: 1, i: 'L'}],
        );
        const typedAgain = recordLocalEditorChange(
            submitted,
            9,
            [{rangeOffset: 3, rangeLength: 0, text: '!'}],
            'aLb!',
        );
        const remote = prepareRemoteEditorTransaction(
            typedAgain,
            'remote-before-reject',
            12,
            [{p: 1, i: 'R'}],
        );
        const committed = commitRemoteEditorTransaction(
            typedAgain,
            remote,
            10,
            [remote.expectedChange!],
            'aRLb!',
        );
        const rejected = rejectLocalEditorSubmission(
            committed,
            'submission-reject',
            [{p: 1, i: 'L'}],
        );
        assert.equal(rejected.valid, true);
        assert.equal(rejected.inflightWire, undefined);
        assert.deepEqual(rejected.pendingOperations, [
            {p: 2, i: 'L'},
            {p: 4, i: '!'},
        ]);
        assert.equal(
            applyTextOperations(rejected.remoteContent, rejected.localOperations),
            rejected.editorContent,
        );
        assert.equal(
            confirmLocalEditorSubmission(
                committed,
                'wrong-token',
                13,
                [{p: 1, i: 'L'}],
            ).valid,
            false,
        );
    });

    it('exposes convergent layered transforms for legacy and History OT', () => {
        const wire: TextOperation[] = [{p: 1, i: 'L'}];
        const legacy = transformLegacyRemoteOperation(
            'ab',
            [{p: 1, i: 'R'}],
            {
                inflightWire: wire,
                inflightView: wire,
                pending: [{p: 3, i: '!'}],
            },
        );
        assert.deepEqual(legacy.inflightWire, wire);
        assert.deepEqual(legacy.inflightView, [{p: 2, i: 'L'}]);
        assert.equal(legacy.serverContent, 'aRb');
        assert.equal(legacy.visibleContent, 'aRLb!');

        const server = parseHistoryOtSnapshot({content: 'ab'});
        const local = parseHistoryOtOperations([{textOperation: [1, 'L', 1]}]);
        const historyRemote = parseHistoryOtOperations([{textOperation: [1, 'R', 1]}]);
        const history = transformHistoryRemoteOperation(
            server,
            historyRemote,
            {pending: local},
        );
        assert.equal(getVisibleHistoryOtText(history.serverSnapshot), 'aRb');
        assert.equal(getVisibleHistoryOtText(history.visibleSnapshot), 'aRLb');
        assert.deepEqual(
            serializeHistoryOtOperations(history.pending!),
            [{textOperation: [2, 'L', 1]}],
        );
    });

    it('rebases tracked inflight and later pending layers from their exact evolving bases', () => {
        const server = parseHistoryOtSnapshot({content: 'ab'});
        const inflight = buildHistoryOtTextUpdate(server, [{
            pos: 1,
            insertText: 'L',
            tracking: {userId: 'local-inflight', ts: historyTimestamp},
        }]);
        const pendingBase = applyHistoryOtOperations(server, inflight);
        const pending = buildHistoryOtTextUpdate(pendingBase, [{
            pos: 2,
            deleteLength: 1,
            tracking: {userId: 'local-pending', ts: historyTimestamp},
        }]);
        const remote = buildHistoryOtTextUpdate(server, [{
            pos: 1,
            insertText: 'R',
            tracking: {userId: 'remote', ts: historyTimestamp},
        }]);
        const immutableWire = serializeHistoryOtOperations(inflight);

        const transformed = transformHistoryRemoteOperation(server, remote, {
            inflightWire: inflight,
            inflightView: inflight,
            pending,
        });

        assert.deepEqual(serializeHistoryOtOperations(inflight), immutableWire);
        assert.deepEqual(
            serializeHistoryOtOperations(transformed.inflightWire!),
            immutableWire,
        );
        assert.deepEqual(serializeHistoryOtOperations(transformed.pending!), [{
            textOperation: [3, {
                r: 1,
                tracking: {
                    type: 'delete',
                    userId: 'local-pending',
                    ts: historyTimestamp,
                },
            }],
        }]);
        assert.equal(getVisibleHistoryOtText(transformed.visibleSnapshot), 'aRL');
        assert.deepEqual(serializeHistoryOtSnapshot(transformed.visibleSnapshot), {
            content: 'aRLb',
            trackedChanges: [
                {
                    range: {pos: 1, length: 1},
                    tracking: {type: 'insert', userId: 'remote', ts: historyTimestamp},
                },
                {
                    range: {pos: 2, length: 1},
                    tracking: {type: 'insert', userId: 'local-inflight', ts: historyTimestamp},
                },
                {
                    range: {pos: 3, length: 1},
                    tracking: {type: 'delete', userId: 'local-pending', ts: historyTimestamp},
                },
            ],
        });
    });

    it('accepts structurally equal tracked/comment branches with different object key order', () => {
        const server = parseHistoryOtSnapshot({
            trackedChanges: [{
                tracking: {ts: historyTimestamp, userId: 'old', type: 'insert'},
                range: {length: 1, pos: 0},
            }],
            comments: [{ranges: [{length: 2, pos: 0}], id: 'c'}],
            content: 'ab',
        });
        const remoteClear = parseHistoryOtOperations([{
            textOperation: [{r: 1, tracking: {type: 'none'}}, 1],
        }]);
        const pendingInsert = parseHistoryOtOperations([{
            textOperation: [1, {
                i: 'X',
                tracking: {ts: historyTimestamp, userId: 'new', type: 'insert'},
            }, 1],
        }]);

        const transformed = transformHistoryRemoteOperation(
            server,
            remoteClear,
            {pending: pendingInsert},
        );
        assert.deepEqual(serializeHistoryOtSnapshot(transformed.visibleSnapshot), {
            trackedChanges: [{
                range: {pos: 1, length: 1},
                tracking: {ts: historyTimestamp, userId: 'new', type: 'insert'},
            }],
            comments: [{ranges: [{length: 1, pos: 0}, {length: 1, pos: 2}], id: 'c'}],
            content: 'aXb',
        });
    });

    it('records tracked local metadata and composes only under one frozen descriptor', () => {
        const descriptor = {
            kind: 'tracked-write' as const,
            tracking: {userId: 'local-user', ts: '2026-08-31T08:00:00+02:00'},
        };
        const base = createHistoryRealtimeEditorBridgeState({
            socketGeneration: 4,
            remoteEpoch: 'history-epoch',
            remoteVersion: 12,
            remoteSnapshot: {content: 'ab'},
            documentVersion: 7,
            editorContent: 'ab',
        });
        const inserted = recordHistoryLocalEditorChange(
            base,
            8,
            [{rangeOffset: 1, rangeLength: 0, text: 'L'}],
            'aLb',
            descriptor,
        );
        const deleted = recordHistoryLocalEditorChange(
            inserted,
            9,
            [{rangeOffset: 2, rangeLength: 1, text: ''}],
            'aL',
            descriptor,
        );

        assert.equal(deleted.valid, true);
        assert.deepEqual(deleted.pendingWriteDescriptor, {
            kind: 'tracked-write',
            tracking: {userId: 'local-user', ts: historyTimestamp},
        });
        assert.deepEqual(serializeHistoryOtSnapshot(
            applyHistoryOtOperations(deleted.remoteSnapshot, deleted.pending!),
        ), {
            content: 'aLb',
            trackedChanges: [
                {
                    range: {pos: 1, length: 1},
                    tracking: {
                        type: 'insert',
                        userId: 'local-user',
                        ts: historyTimestamp,
                    },
                },
                {
                    range: {pos: 2, length: 1},
                    tracking: {
                        type: 'delete',
                        userId: 'local-user',
                        ts: historyTimestamp,
                    },
                },
            ],
        });
    });

    it('records one exact multi-change event for a History OT document', () => {
        const base = createHistoryRealtimeEditorBridgeState({
            socketGeneration: 4,
            remoteEpoch: 'history-epoch',
            remoteVersion: 12,
            remoteSnapshot: {content: 'abc'},
            documentVersion: 7,
            editorContent: 'abc',
        });
        const changed = recordHistoryLocalEditorChange(
            base,
            8,
            [
                {rangeOffset: 3, rangeLength: 0, text: 'Y'},
                {rangeOffset: 0, rangeLength: 0, text: 'X'},
            ],
            'XabcY',
        );

        assert.equal(changed.valid, true);
        assert.ok(changed.pending);
        assert.equal(
            getVisibleHistoryOtText(
                applyHistoryOtOperations(changed.remoteSnapshot, changed.pending),
            ),
            'XabcY',
        );
    });

    it('fails closed when rejoin-required History state has no sender commit witness', () => {
        const base = createHistoryRealtimeEditorBridgeState({
            socketGeneration: 4,
            remoteEpoch: 'history-epoch',
            remoteVersion: 12,
            remoteSnapshot: {content: 'ab'},
            documentVersion: 7,
            editorContent: 'ab',
        });
        const malformed = {
            ...base,
            authority: 'rejoin-required' as const,
            senderCommitWitness: undefined,
        };

        const changed = recordHistoryLocalEditorChange(
            malformed,
            8,
            [{rangeOffset: 1, rangeLength: 0, text: 'L'}],
            'aLb',
        );

        assert.equal(changed.valid, false);
        assert.equal(changed.pending, undefined);
    });

    it('keeps History wire immutable through a remote interleave and later local input', () => {
        const base = createHistoryRealtimeEditorBridgeState({
            socketGeneration: 4,
            remoteEpoch: 'history-epoch',
            remoteVersion: 12,
            remoteSnapshot: {content: 'ab'},
            documentVersion: 7,
            editorContent: 'ab',
        });
        const dirty = recordHistoryLocalEditorChange(
            base,
            8,
            [{rangeOffset: 1, rangeLength: 0, text: 'L'}],
            'aLb',
        );
        const wire = serializeHistoryOtOperations(dirty.pending!);
        const submitted = beginHistorySubmission(
            dirty,
            'history-submission-1',
            dirty.pending!,
        );
        const remote = prepareHistoryRemoteEditorTransaction(
            submitted,
            'history-remote-1',
            12,
            [{textOperation: [1, 'R', 1]}],
        );
        const remoteCommitted = commitHistoryRemoteEditorTransaction(
            submitted,
            remote,
            9,
            [remote.expectedChange!],
            'aRLb',
        );
        const later = recordHistoryLocalEditorChange(
            remoteCommitted,
            10,
            [{rangeOffset: 4, rangeLength: 0, text: '!'}],
            'aRLb!',
        );

        assert.equal(later.valid, true);
        assert.deepEqual(serializeHistoryOtOperations(later.inflightWire!), wire);
        assert.deepEqual(
            serializeHistoryOtOperations(later.inflightView!),
            [{textOperation: [2, 'L', 1]}],
        );
        assert.deepEqual(
            serializeHistoryOtOperations(later.pending!),
            [{textOperation: [4, '!']}],
        );

        const rejected = rejectHistorySubmission(later, 'history-submission-1');
        assert.equal(rejected.valid, true);
        assert.equal(rejected.inflightWire, undefined);
        assert.equal(rejected.inflightView, undefined);
        assert.equal(
            getVisibleHistoryOtText(
                applyHistoryOtOperations(rejected.remoteSnapshot, rejected.pending!),
            ),
            'aRLb!',
        );
    });

    it('binds zero-wire rejection and sender commit to the exact submission token', () => {
        const base = createHistoryRealtimeEditorBridgeState({
            socketGeneration: 4,
            remoteEpoch: 'history-epoch',
            remoteVersion: 12,
            remoteSnapshot: {content: 'ab'},
            documentVersion: 7,
            editorContent: 'ab',
        });
        const dirty = recordHistoryLocalEditorChange(
            base,
            8,
            [{rangeOffset: 1, rangeLength: 0, text: 'L'}],
            'aLb',
        );
        const submitted = beginHistorySubmission(dirty, 'exact-token', dirty.pending!);

        assert.equal(rejectHistorySubmission(submitted, 'wrong-token').valid, false);
        assert.equal(
            acknowledgeHistorySubmission(submitted, 'wrong-token', 12).valid,
            false,
        );
        assert.equal(rejectHistorySubmission(submitted, 'exact-token').valid, true);
    });

    it('rebinds an outcome-unknown History submission only to exact recovery joins', () => {
        const descriptor = {
            kind: 'tracked-write' as const,
            tracking: {userId: 'local-user', ts: historyTimestamp},
        };
        const base = createHistoryRealtimeEditorBridgeState({
            socketGeneration: 4,
            remoteEpoch: 'history-epoch',
            remoteVersion: 12,
            remoteSnapshot: {
                content: 'ab',
                comments: [{id: 'c', ranges: [{pos: 0, length: 2}]}],
            },
            documentVersion: 7,
            editorContent: 'ab',
        });
        const dirty = recordHistoryLocalEditorChange(
            base,
            8,
            [{rangeOffset: 1, rangeLength: 0, text: 'L'}],
            'aLb',
            descriptor,
        );
        const inflight = beginHistorySubmission(
            dirty,
            'old-submission-token',
            dirty.pending!,
            descriptor,
        );
        const state = recordHistoryLocalEditorChange(
            inflight,
            9,
            [{rangeOffset: 3, rangeLength: 0, text: '!'}],
            'aLb!',
            descriptor,
        );
        const remoteBefore = serializeHistoryOtSnapshot(state.remoteSnapshot);
        const wireBefore = serializeHistoryOtOperations(state.inflightWire!);
        const viewBefore = serializeHistoryOtOperations(state.inflightView!);
        const pendingBefore = serializeHistoryOtOperations(state.pending!);

        const unapplied = rebindHistorySubmissionForRecovery(state, {
            socketGeneration: 5,
            remoteEpoch: 'recovery-epoch-unapplied',
            submissionToken: 'recovery-token-unapplied',
            joinVersion: 12,
            joinSnapshot: {
                comments: [{ranges: [{length: 2, pos: 0}], id: 'c'}],
                content: 'ab',
            },
            documentVersion: 9,
            editorContent: 'aLb!',
        });
        assert.equal(unapplied.valid, true);
        assert.equal(unapplied.socketGeneration, 5);
        assert.equal(unapplied.remoteEpoch, 'recovery-epoch-unapplied');
        assert.equal(unapplied.inflightToken, 'recovery-token-unapplied');

        const predicted = serializeHistoryOtSnapshot(applyHistoryOtOperations(
            state.remoteSnapshot,
            state.inflightView!,
        )) as StringFileDataSnapshot;
        const appliedWithoutAck = rebindHistorySubmissionForRecovery(state, {
            socketGeneration: 6,
            remoteEpoch: 'recovery-epoch-applied',
            submissionToken: 'recovery-token-applied',
            joinVersion: 13,
            joinSnapshot: {
                trackedChanges: predicted.trackedChanges,
                comments: predicted.comments?.map(comment => ({
                    ranges: comment.ranges.map(range => ({
                        length: range.length,
                        pos: range.pos,
                    })),
                    id: comment.id,
                })),
                content: predicted.content,
            },
            documentVersion: 9,
            editorContent: 'aLb!',
        });
        assert.equal(appliedWithoutAck.valid, true);
        assert.equal(appliedWithoutAck.socketGeneration, 6);
        assert.equal(appliedWithoutAck.remoteEpoch, 'recovery-epoch-applied');
        assert.equal(appliedWithoutAck.inflightToken, 'recovery-token-applied');

        for (const rebound of [unapplied, appliedWithoutAck]) {
            assert.equal(rebound.remoteVersion, 12);
            assert.equal(rebound.documentVersion, 9);
            assert.equal(rebound.editorContent, 'aLb!');
            assert.deepEqual(serializeHistoryOtSnapshot(rebound.remoteSnapshot), remoteBefore);
            assert.deepEqual(serializeHistoryOtOperations(rebound.inflightWire!), wireBefore);
            assert.deepEqual(serializeHistoryOtOperations(rebound.inflightView!), viewBefore);
            assert.deepEqual(serializeHistoryOtOperations(rebound.pending!), pendingBefore);
            assert.deepEqual(rebound.inflightWriteDescriptor, state.inflightWriteDescriptor);
            assert.deepEqual(rebound.pendingWriteDescriptor, state.pendingWriteDescriptor);
        }

        const collaboratorDifference = rebindHistorySubmissionForRecovery(state, {
            socketGeneration: 5,
            remoteEpoch: 'recovery-epoch-collaborator',
            submissionToken: 'recovery-token-collaborator',
            joinVersion: 13,
            joinSnapshot: {content: 'Rab'},
            documentVersion: 9,
            editorContent: 'aLb!',
        });
        assert.equal(collaboratorDifference.valid, false);
        assert.equal(rebindHistorySubmissionForRecovery(state, {
            socketGeneration: 5,
            remoteEpoch: 'recovery-epoch-stale-token',
            submissionToken: 'old-submission-token',
            joinVersion: 12,
            joinSnapshot: remoteBefore,
            documentVersion: 9,
            editorContent: 'aLb!',
        }).valid, false);
    });

    it('fails closed if tracking mode changes while a logical local batch is pending', () => {
        const tracked = {
            kind: 'tracked-write' as const,
            tracking: {userId: 'local-user', ts: historyTimestamp},
        };
        const base = createHistoryRealtimeEditorBridgeState({
            socketGeneration: 4,
            remoteEpoch: 'history-epoch',
            remoteVersion: 12,
            remoteSnapshot: {content: 'ab'},
            documentVersion: 7,
            editorContent: 'ab',
        });
        const pending = recordHistoryLocalEditorChange(
            base,
            8,
            [{rangeOffset: 2, rangeLength: 0, text: 'L'}],
            'abL',
            tracked,
        );
        assert.equal(recordHistoryLocalEditorChange(
            pending,
            9,
            [{rangeOffset: 3, rangeLength: 0, text: '!'}],
            'abL!',
            {kind: 'plain-write'},
        ).valid, false);

        const inflight = beginHistorySubmission(
            pending,
            'tracked-token',
            pending.pending!,
            tracked,
        );
        assert.equal(recordHistoryLocalEditorChange(
            inflight,
            9,
            [{rangeOffset: 3, rangeLength: 0, text: '!'}],
            'abL!',
            {kind: 'plain-write'},
        ).valid, false);
    });

    it('advances a metadata-only History revision without inventing an editor change', () => {
        const base = createHistoryRealtimeEditorBridgeState({
            socketGeneration: 4,
            remoteEpoch: 'history-epoch',
            remoteVersion: 12,
            remoteSnapshot: {
                content: 'ab',
                trackedChanges: [{
                    range: {pos: 0, length: 1},
                    tracking: {type: 'insert', userId: 'old', ts: historyTimestamp},
                }],
            },
            documentVersion: 7,
            editorContent: 'ab',
        });
        const transaction = prepareHistoryRemoteEditorTransaction(
            base,
            'metadata-only',
            12,
            [{textOperation: [{r: 1, tracking: {type: 'none'}}, 1]}],
        );
        assert.equal(transaction.expectedChange, undefined);
        const committed = commitHistoryRemoteEditorTransaction(
            base,
            transaction,
            7,
            [],
            'ab',
        );
        assert.equal(committed.valid, true);
        assert.equal(committed.remoteVersion, 13);
        assert.deepEqual(serializeHistoryOtSnapshot(committed.remoteSnapshot), {content: 'ab'});

        const emptyRevision = prepareHistoryRemoteEditorTransaction(
            committed,
            'empty-metadata-revision',
            13,
            [],
        );
        const emptyCommitted = commitHistoryRemoteEditorTransaction(
            committed,
            emptyRevision,
            7,
            [],
            'ab',
        );
        assert.equal(emptyCommitted.valid, true);
        assert.equal(emptyCommitted.remoteVersion, 14);
    });

    it('commits an exact clean History reload independently of provider callback shape', () => {
        const base = createHistoryRealtimeEditorBridgeState({
            socketGeneration: 4,
            remoteEpoch: 'history-epoch',
            remoteVersion: 12,
            remoteSnapshot: {content: 'abc'},
            documentVersion: 7,
            editorContent: 'abc',
        });
        const transaction = prepareHistoryRemoteEditorTransaction(
            base,
            'clean-provider-reload',
            12,
            [{textOperation: [1, 'R', 2]}],
        );
        const committed = commitHistoryCleanRemoteEditorTransaction(
            base,
            transaction,
            11,
            'aRbc',
        );
        assert.equal(committed.valid, true);
        assert.equal(committed.remoteVersion, 13);
        assert.equal(committed.documentVersion, 11);
        assert.equal(
            commitHistoryCleanRemoteEditorTransaction(base, transaction, 11, 'wrong').valid,
            false,
        );
    });

    it('rejects History local and remote operations that split a surrogate pair', () => {
        const base = createHistoryRealtimeEditorBridgeState({
            socketGeneration: 4,
            remoteEpoch: 'history-epoch',
            remoteVersion: 12,
            remoteSnapshot: {content: 'a😀b'},
            documentVersion: 7,
            editorContent: 'a😀b',
        });
        assert.equal(recordHistoryLocalEditorChange(
            base,
            8,
            [{rangeOffset: 2, rangeLength: 0, text: 'X'}],
            'a\uD83DX\uDE00b',
        ).valid, false);
        assert.throws(
            () => prepareHistoryRemoteEditorTransaction(
                base,
                'surrogate-split',
                12,
                [{textOperation: [2, 'X', 2]}],
            ),
            /surrogate|UTF-16/i,
        );
    });

    it('treats a sender ACK prediction as non-authoritative until an exact fresh join', () => {
        const descriptor = {
            kind: 'tracked-write' as const,
            tracking: {userId: 'local-user', ts: historyTimestamp},
        };
        const base = createHistoryRealtimeEditorBridgeState({
            socketGeneration: 4,
            remoteEpoch: 'history-epoch',
            remoteVersion: 12,
            remoteSnapshot: {content: 'ab'},
            documentVersion: 7,
            editorContent: 'ab',
        });
        const dirty = recordHistoryLocalEditorChange(
            base,
            8,
            [{rangeOffset: 1, rangeLength: 0, text: 'L'}],
            'aLb',
            descriptor,
        );
        const submitted = beginHistorySubmission(
            dirty,
            'sender-token',
            dirty.pending!,
            descriptor,
        );
        const later = recordHistoryLocalEditorChange(
            submitted,
            9,
            [{rangeOffset: 3, rangeLength: 0, text: '!'}],
            'aLb!',
            descriptor,
        );
        const acknowledged = acknowledgeHistorySubmission(
            later,
            'sender-token',
            12,
        );

        assert.equal(acknowledged.valid, true);
        assert.equal(acknowledged.authority, 'rejoin-required');
        assert.equal(acknowledged.remoteVersion, 12);
        assert.deepEqual(serializeHistoryOtSnapshot(acknowledged.remoteSnapshot), {content: 'ab'});
        assert.equal(
            getVisibleHistoryOtText(acknowledged.senderCommitWitness!.predictedRemoteSnapshot),
            'aLb',
        );
        assert.throws(
            () => prepareHistoryRemoteEditorTransaction(
                acknowledged,
                'blocked-before-join',
                12,
                [],
            ),
            /no exact remote\/local base/,
        );

        const reconciled = reconcileHistoryEditorAfterJoin(acknowledged, {
            socketGeneration: 5,
            remoteEpoch: 'history-epoch-2',
            remoteVersion: 13,
            remoteSnapshot: {
                trackedChanges: [{
                    tracking: {
                        ts: historyTimestamp,
                        type: 'insert',
                        userId: 'local-user',
                    },
                    range: {length: 1, pos: 1},
                }],
                content: 'aLb',
            },
            documentVersion: 9,
            editorContent: 'aLb!',
        });
        assert.equal(reconciled.valid, true);
        assert.equal(reconciled.authority, 'ready');
        assert.equal(reconciled.remoteVersion, 13);
        assert.equal(reconciled.socketGeneration, 5);
        assert.equal(reconciled.senderCommitWitness, undefined);
        assert.ok(reconciled.pending);
        assert.equal(
            getVisibleHistoryOtText(
                applyHistoryOtOperations(reconciled.remoteSnapshot, reconciled.pending),
            ),
            'aLb!',
        );
    });

    it('preserves a History edit made after sender ACK while the fresh join is pending', () => {
        const descriptor = {
            kind: 'tracked-write' as const,
            tracking: {userId: 'local-user', ts: historyTimestamp},
        };
        const base = createHistoryRealtimeEditorBridgeState({
            socketGeneration: 4,
            remoteEpoch: 'history-epoch',
            remoteVersion: 12,
            remoteSnapshot: {content: 'ab'},
            documentVersion: 7,
            editorContent: 'ab',
        });
        const dirty = recordHistoryLocalEditorChange(
            base,
            8,
            [{rangeOffset: 1, rangeLength: 0, text: 'L'}],
            'aLb',
            descriptor,
        );
        const submitted = beginHistorySubmission(
            dirty,
            'sender-token',
            dirty.pending!,
            descriptor,
        );
        const acknowledged = acknowledgeHistorySubmission(
            submitted,
            'sender-token',
            12,
        );
        const later = recordHistoryLocalEditorChange(
            acknowledged,
            9,
            [{rangeOffset: 3, rangeLength: 0, text: '!'}],
            'aLb!',
            descriptor,
        );

        assert.equal(later.valid, true);
        assert.equal(later.authority, 'rejoin-required');
        assert.deepEqual(later.pendingWriteDescriptor, descriptor);
        assert.ok(later.pending);
        assert.equal(
            getVisibleHistoryOtText(applyHistoryOtOperations(
                later.senderCommitWitness!.predictedRemoteSnapshot,
                later.pending,
            )),
            'aLb!',
        );

        const reconciled = reconcileHistoryEditorAfterJoin(later, {
            socketGeneration: 5,
            remoteEpoch: 'history-epoch-2',
            remoteVersion: 13,
            remoteSnapshot: serializeHistoryOtSnapshot(
                later.senderCommitWitness!.predictedRemoteSnapshot,
            ),
            documentVersion: 9,
            editorContent: 'aLb!',
        });
        assert.equal(reconciled.valid, true);
        assert.equal(reconciled.authority, 'ready');
        assert.deepEqual(reconciled.pendingWriteDescriptor, descriptor);
        assert.ok(reconciled.pending);
        assert.equal(
            getVisibleHistoryOtText(
                applyHistoryOtOperations(reconciled.remoteSnapshot, reconciled.pending),
            ),
            'aLb!',
        );
    });
});
