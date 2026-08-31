import { strict as assert } from 'assert';
import {
    buildRecoveryUpdate,
    desiredChangesArePresent,
    isSenderConfirmation,
    prepareDocumentUpdate,
    requiresVersionConfirmation,
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

describe('requiresVersionConfirmation', () => {
    it('waits for realtime OT version events in the normal connection mode', () => {
        assert.equal(requiresVersionConfirmation(false), true);
    });

    it('accepts the HTTP-backed alternative mode acknowledgement without an OT event', () => {
        assert.equal(requiresVersionConfirmation(true), false);
    });
});

describe('realtime update recovery', () => {
    it('distinguishes the sender version bump from a collaborator operation', () => {
        assert.equal(isSenderConfirmation({}), true);
        assert.equal(isSenderConfirmation({op: [{p: 0, i: 'remote'}]}), false);
    });

    it('resubmits the exact original operation and version with prior source ids', () => {
        const original = {doc: 'doc', v: 7, op: [{p: 1, i: 'x'}]};
        const recovery = buildRecoveryUpdate(original, ['old-id', 'old-id', '', 'older-id']);
        assert.equal(recovery.v, 7);
        assert.strictEqual(recovery.op, original.op);
        assert.deepEqual(recovery.dupIfSource, ['old-id', 'older-id']);
        assert.equal('dupIfSource' in original, false);
    });

    it('confirms local intent only when every desired change is in the authoritative text', () => {
        assert.equal(desiredChangesArePresent('abc', 'aXbYc', 'abYc'), true);
        assert.equal(desiredChangesArePresent('abc', 'aXbc', 'abYc'), false);
        assert.equal(desiredChangesArePresent('abc', 'aXc', 'aYc'), false);
    });
});
