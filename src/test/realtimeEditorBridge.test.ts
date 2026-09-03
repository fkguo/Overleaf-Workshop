import {strict as assert} from 'assert';
import {applyTextOperations} from '../core/documentUpdate';
import {
    applyUtf16TextOperations,
    commitRemoteEditorTransaction,
    createRealtimeEditorBridgeState,
    prepareRemoteEditorTransaction,
    recordLocalEditorChange,
} from '../core/realtimeEditorBridge';

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
});
