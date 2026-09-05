import { strict as assert } from 'assert';
import {
    applyTextOperations,
    isSenderConfirmation,
    operationsFromObservedTextChanges,
    prepareProvenDocumentUpdate,
    TextOperation,
} from '../core/documentUpdate';

const base = (version: number, content: string, pendingWrite = false) => ({
    version,
    content,
    pendingWrite,
});

const evidence = (
    localOperations: TextOperation[],
    remoteUpdates: Array<{version: number, operations: TextOperation[]}> = [],
) => ({localOperations, remoteUpdates});

describe('observed editor operations', () => {
    it('blocks unsupported wire insertions, including cancelled intermediate inserts', () => {
        for (const inserted of ['\u0000', '🙂', '\uD800', '\uDC00']) {
            assert.deepEqual(prepareProvenDocumentUpdate(
                base(1, 'abc'), 1, 'abc', `abc${inserted}`,
                evidence([{p: 3, i: inserted}]),
            ), {status: 'blocked', reason: 'unsupported-text'});
            assert.deepEqual(prepareProvenDocumentUpdate(
                base(1, 'abc'), 1, 'abc', 'abcL',
                evidence([{p: 3, i: inserted}, {p: 3, d: inserted}, {p: 3, i: 'L'}]),
            ), {status: 'blocked', reason: 'unsupported-text'});
        }
        assert.equal(prepareProvenDocumentUpdate(
            base(1, 'abc'), 1, 'abc', 'abc中文', evidence([{p: 3, i: '中文'}]),
        ).status, 'ready');
    });
    it('records an exact insertion and replacement from one content change', () => {
        assert.deepEqual(
            operationsFromObservedTextChanges(
                'abc',
                [{rangeOffset: 1, rangeLength: 0, text: 'R'}],
                'aRbc',
            ),
            [{p: 1, i: 'R'}],
        );
        assert.deepEqual(
            operationsFromObservedTextChanges(
                'abc',
                [{rangeOffset: 1, rangeLength: 1, text: 'XY'}],
                'aXYc',
            ),
            [{p: 1, d: 'b'}, {p: 1, i: 'XY'}],
        );
    });

    it('records a multi-change transaction in the exact host event order', () => {
        assert.deepEqual(
            operationsFromObservedTextChanges(
                'abc',
                [
                    {rangeOffset: 3, rangeLength: 0, text: 'Y'},
                    {rangeOffset: 0, rangeLength: 0, text: 'X'},
                ],
                'XabcY',
            ),
            [{p: 3, i: 'Y'}, {p: 0, i: 'X'}],
        );
        assert.deepEqual(
            operationsFromObservedTextChanges(
                'abcdef',
                [
                    {rangeOffset: 4, rangeLength: 2, text: 'XY'},
                    {rangeOffset: 1, rangeLength: 2, text: 'Q'},
                ],
                'aQdXY',
            ),
            [
                {p: 4, d: 'ef'},
                {p: 4, i: 'XY'},
                {p: 1, d: 'bc'},
                {p: 1, i: 'Q'},
            ],
        );
    });

    it('rejects a multi-change transaction whose event order cannot replay the snapshot', () => {
        assert.equal(
            operationsFromObservedTextChanges(
                'abc',
                [
                    {rangeOffset: 0, rangeLength: 0, text: 'X'},
                    {rangeOffset: 3, rangeLength: 0, text: 'Y'},
                ],
                'XabcY',
            ),
            undefined,
        );
    });

    it('rejects a false single-change replay', () => {
        assert.equal(
            operationsFromObservedTextChanges(
                'abc',
                [{rangeOffset: 1, rangeLength: 1, text: 'X'}],
                'wrong',
            ),
            undefined,
        );
    });
});

describe('prepareProvenDocumentUpdate', () => {
    it('blocks a stale buffer with no exact base', () => {
        assert.deepEqual(
            prepareProvenDocumentUpdate(undefined, 12, 'remote', 'local'),
            {status: 'blocked', reason: 'missing-base'},
        );
    });

    it('allows an exact local operation at the acknowledged revision', () => {
        const result = prepareProvenDocumentUpdate(
            base(12, 'current'),
            12,
            'current',
            'current local',
            evidence([{p: 7, i: ' local'}]),
        );
        assert.equal(result.status, 'ready');
        if (result.status === 'ready') {
            assert.deepEqual(result.prepared.operations, [{p: 7, i: ' local'}]);
            assert.equal(result.prepared.mergedContent, 'current local');
        }
    });

    it('transforms an actual local operation through an independent remote operation', () => {
        const result = prepareProvenDocumentUpdate(
            base(12, 'abc'),
            13,
            'aRbc',
            'abcL',
            evidence(
                [{p: 3, i: 'L'}],
                [{version: 12, operations: [{p: 1, i: 'R'}]}],
            ),
        );
        assert.equal(result.status, 'ready');
        if (result.status === 'ready') {
            assert.deepEqual(result.prepared.operations, [{p: 4, i: 'L'}]);
            assert.equal(result.prepared.mergedContent, 'aRbcL');
            assert.equal(
                applyTextOperations('aRbc', result.prepared.operations),
                result.prepared.mergedContent,
            );
        }
    });

    it('uses causal positions for repeated text instead of snapshot alignment', () => {
        const result = prepareProvenDocumentUpdate(
            base(10, 'bb'),
            11,
            'bbb',
            'bRb',
            evidence(
                [{p: 1, i: 'R'}],
                [{version: 10, operations: [{p: 0, i: 'b'}]}],
            ),
        );
        assert.equal(result.status, 'ready');
        if (result.status === 'ready') {
            assert.deepEqual(result.prepared.operations, [{p: 2, i: 'R'}]);
            assert.equal(result.prepared.mergedContent, 'bbRb');
        }
    });

    it('blocks the overlapping-delete counterexample with zero wire operations', () => {
        const result = prepareProvenDocumentUpdate(
            base(10, 'ab'),
            11,
            'b',
            'ba',
            evidence(
                [{p: 0, d: 'ab'}, {p: 0, i: 'ba'}],
                [{version: 10, operations: [{p: 0, d: 'a'}]}],
            ),
        );
        assert.deepEqual(result, {status: 'blocked', reason: 'causal-conflict'});
    });

    it('blocks shared boundaries and same-position insertions conservatively', () => {
        assert.deepEqual(
            prepareProvenDocumentUpdate(
                base(4, 'abc'),
                5,
                'ac',
                'aXbc',
                evidence(
                    [{p: 1, i: 'X'}],
                    [{version: 4, operations: [{p: 1, d: 'b'}]}],
                ),
            ),
            {status: 'blocked', reason: 'causal-conflict'},
        );
        assert.deepEqual(
            prepareProvenDocumentUpdate(
                base(4, 'abc'),
                5,
                'aRbc',
                'aLbc',
                evidence(
                    [{p: 1, i: 'L'}],
                    [{version: 4, operations: [{p: 1, i: 'R'}]}],
                ),
            ),
            {status: 'blocked', reason: 'causal-conflict'},
        );
    });

    it('requires a complete, consecutive and exactly replayable remote chain', () => {
        assert.deepEqual(
            prepareProvenDocumentUpdate(
                base(7, 'abc'),
                8,
                'aRbc',
                'abcL',
                evidence([{p: 3, i: 'L'}]),
            ),
            {status: 'blocked', reason: 'missing-remote-causality'},
        );
        assert.deepEqual(
            prepareProvenDocumentUpdate(
                base(7, 'abc'),
                8,
                'aRbc',
                'abcL',
                evidence(
                    [{p: 3, i: 'L'}],
                    [{version: 8, operations: [{p: 1, i: 'R'}]}],
                ),
            ),
            {status: 'blocked', reason: 'missing-remote-causality'},
        );
        assert.deepEqual(
            prepareProvenDocumentUpdate(
                base(7, 'abc'),
                8,
                'aRbc',
                'abcL',
                evidence(
                    [{p: 3, i: 'L'}],
                    [{version: 7, operations: [{p: 1, d: 'wrong'}]}],
                ),
            ),
            {status: 'blocked', reason: 'invalid-causal-operations'},
        );
    });

    it('blocks missing or non-replaying local causality', () => {
        assert.deepEqual(
            prepareProvenDocumentUpdate(base(3, 'abc'), 3, 'abc', 'abcL'),
            {status: 'blocked', reason: 'missing-local-causality'},
        );
        assert.deepEqual(
            prepareProvenDocumentUpdate(
                base(3, 'abc'),
                3,
                'abc',
                'abcL',
                evidence([{p: 0, i: 'wrong'}]),
            ),
            {status: 'blocked', reason: 'missing-local-causality'},
        );
    });

    it('blocks impossible version/content pairs before a zero-wire completion', () => {
        assert.deepEqual(
            prepareProvenDocumentUpdate(base(12, 'base'), 11, 'desired', 'desired'),
            {status: 'blocked', reason: 'version-regression'},
        );
        assert.deepEqual(
            prepareProvenDocumentUpdate(base(12, 'base'), 12, 'desired', 'desired'),
            {status: 'blocked', reason: 'content-version-mismatch'},
        );
    });

    it('never clears or replays a pending write from snapshot coincidence', () => {
        assert.deepEqual(
            prepareProvenDocumentUpdate(
                base(12, 'base', true),
                12,
                'base',
                'desired',
                evidence([{p: 0, d: 'base'}, {p: 0, i: 'desired'}]),
            ),
            {status: 'blocked', reason: 'pending-write'},
        );
        assert.deepEqual(
            prepareProvenDocumentUpdate(
                base(12, 'base', true),
                13,
                'desired',
                'desired',
            ),
            {status: 'blocked', reason: 'pending-write'},
        );
    });
});

describe('realtime update classification', () => {
    it('distinguishes the sender version bump from a collaborator operation', () => {
        assert.equal(isSenderConfirmation({}), true);
        assert.equal(isSenderConfirmation({op: []}), false);
        assert.equal(isSenderConfirmation({op: [{p: 0, i: 'remote'}]}), false);
    });
});
