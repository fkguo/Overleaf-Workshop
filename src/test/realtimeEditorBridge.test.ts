import {strict as assert} from 'assert';
import {applyTextOperations, TextOperation} from '../core/documentUpdate';
import {
    applyUtf16TextOperations,
    beginLocalEditorSubmission,
    commitRemoteEditorTransaction,
    confirmLocalEditorSubmission,
    createRealtimeEditorBridgeState,
    prepareRemoteEditorTransaction,
    recordLocalEditorChange,
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

    it('invalidates missed or multi-change local causality with zero usable OT', () => {
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
                {rangeOffset: 0, rangeLength: 0, text: 'L'},
                {rangeOffset: 3, rangeLength: 0, text: 'R'},
            ],
            'LabcR',
        );
        assert.equal(multi.valid, false);
        assert.throws(
            () => prepareRemoteEditorTransaction(multi, 'blocked', 12, [{p: 0, i: 'X'}]),
            /no exact remote\/local base/,
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
});
