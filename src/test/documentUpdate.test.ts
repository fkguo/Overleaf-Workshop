import { strict as assert } from 'assert';
import {
    isSenderConfirmation,
    prepareDocumentUpdate,
    prepareProvenDocumentUpdate,
} from '../core/documentUpdate';

describe('prepareDocumentUpdate', () => {
    it('produces no OT operation when the desired text already matches remote', () => {
        const prepared = prepareDocumentUpdate('same', 'same', 'same');
        assert.equal(prepared.mergedContent, 'same');
        assert.equal(prepared.mergeApplied, true);
        assert.deepEqual(prepared.operations, []);
    });

    it('turns a local insertion into one remote-relative OT operation', () => {
        const prepared = prepareDocumentUpdate('abc', 'abc', 'abXc');
        assert.equal(prepared.mergedContent, 'abXc');
        assert.deepEqual(prepared.operations, [{p: 2, i: 'X', d: undefined}]);
    });

    it('preserves independent remote and local edits during recovery', () => {
        const prepared = prepareDocumentUpdate('abc', 'aRbc', 'abcL');
        assert.equal(prepared.mergeApplied, true);
        assert.equal(prepared.mergedContent, 'aRbcL');
        assert.deepEqual(prepared.operations, [{p: 4, i: 'L', d: undefined}]);
    });

    it('uses offsets relative to the current remote text for deletions', () => {
        const prepared = prepareDocumentUpdate('abcdef', 'abcdef', 'abef');
        assert.deepEqual(prepared.operations, [{p: 2, i: undefined, d: 'cd'}]);
    });

    it('rejects two different replacements of the same base range', () => {
        const prepared = prepareDocumentUpdate('abc', 'aXc', 'aYc');
        assert.equal(prepared.mergeApplied, false);
        assert.deepEqual(prepared.operations, []);
    });

    it('does not duplicate an insertion which is already present remotely', () => {
        const prepared = prepareDocumentUpdate('a', 'ab', 'ab');
        assert.equal(prepared.mergeApplied, true);
        assert.equal(prepared.mergedContent, 'ab');
        assert.deepEqual(prepared.operations, []);
    });

    it('rejects ambiguous different insertions at the same position', () => {
        const prepared = prepareDocumentUpdate('ac', 'aXc', 'aYc');
        assert.equal(prepared.mergeApplied, false);
    });

    it('preserves a remote-only edit when local content already contains another remote edit', () => {
        const prepared = prepareDocumentUpdate('abcd', 'aXbcdR', 'aXbcd');
        assert.equal(prepared.mergeApplied, true);
        assert.equal(prepared.mergedContent, 'aXbcdR');
        assert.deepEqual(prepared.operations, []);
    });
});

describe('prepareProvenDocumentUpdate', () => {
    it('blocks a cold-restored stale buffer instead of manufacturing the fresh remote as its base', () => {
        const result = prepareProvenDocumentUpdate(
            undefined,
            12,
            'collaborator edit\ncurrent ending',
            'old opening\nold ending',
        );
        assert.deepEqual(result, {status: 'blocked', reason: 'missing-base'});
    });

    it('allows an ordinary edit from the exact acknowledged version and content', () => {
        const result = prepareProvenDocumentUpdate(
            {version: 12, content: 'current', pendingWrite: false},
            12,
            'current',
            'current local',
        );
        assert.equal(result.status, 'ready');
        if (result.status === 'ready') {
            assert.deepEqual(result.prepared.operations, [{p: 7, i: ' local', d: undefined}]);
        }
    });

    it('fails closed for remote version or content movement, including non-overlapping edits', () => {
        assert.deepEqual(
            prepareProvenDocumentUpdate(
                {version: 12, content: 'abc', pendingWrite: false},
                13,
                'aRbc',
                'abcL',
            ),
            {status: 'blocked', reason: 'version-mismatch'},
        );
        assert.deepEqual(
            prepareProvenDocumentUpdate(
                {version: 12, content: 'abc', pendingWrite: false},
                12,
                'aRbc',
                'abcL',
            ),
            {status: 'blocked', reason: 'content-mismatch'},
        );
    });

    it('never replays a pending write, but accepts an authoritative exact desired snapshot as a no-op', () => {
        assert.deepEqual(
            prepareProvenDocumentUpdate(
                {version: 12, content: 'base', pendingWrite: true},
                12,
                'base',
                'desired',
            ),
            {status: 'blocked', reason: 'pending-write'},
        );
        const confirmed = prepareProvenDocumentUpdate(
            {version: 12, content: 'base', pendingWrite: true},
            13,
            'desired',
            'desired',
        );
        assert.equal(confirmed.status, 'noop');
        if (confirmed.status === 'noop') {
            assert.deepEqual(confirmed.prepared.operations, []);
        }
    });
});

describe('realtime update classification', () => {
    it('distinguishes the sender version bump from a collaborator operation', () => {
        assert.equal(isSenderConfirmation({}), true);
        assert.equal(isSenderConfirmation({op: [{p: 0, i: 'remote'}]}), false);
    });
});
