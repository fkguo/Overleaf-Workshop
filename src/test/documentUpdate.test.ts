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

    it('preserves non-overlapping remote movement and blocks impossible or conflicting movement', () => {
        const independent = prepareProvenDocumentUpdate(
            {version: 12, content: 'abc', pendingWrite: false},
            13,
            'aRbc',
            'abcL',
        );
        assert.equal(independent.status, 'ready');
        if (independent.status === 'ready') {
            assert.equal(independent.prepared.mergedContent, 'aRbcL');
            assert.deepEqual(independent.prepared.operations, [{p: 4, i: 'L', d: undefined}]);
        }
        assert.deepEqual(
            prepareProvenDocumentUpdate(
                {version: 12, content: 'abc', pendingWrite: false},
                12,
                'aRbc',
                'abcL',
            ),
            {status: 'blocked', reason: 'content-version-mismatch'},
        );
        assert.deepEqual(
            prepareProvenDocumentUpdate(
                {version: 12, content: 'abc', pendingWrite: false},
                11,
                'abc',
                'abcL',
            ),
            {status: 'blocked', reason: 'version-regression'},
        );
        assert.deepEqual(
            prepareProvenDocumentUpdate(
                {version: 12, content: 'same line', pendingWrite: false},
                13,
                'remote line',
                'local line',
            ),
            {status: 'blocked', reason: 'merge-conflict'},
        );
    });

    it('allows a deletion only when the exact buffer base already contained the deleted text', () => {
        const base = 'confirmed user text\nshared tail\n';
        const remote = 'confirmed user text\nshared tail\nremote addition\n';
        const desired = 'shared tail\n';
        const result = prepareProvenDocumentUpdate(
            {version: 20, content: base, pendingWrite: false},
            21,
            remote,
            desired,
        );
        assert.equal(result.status, 'ready');
        if (result.status === 'ready') {
            assert.equal(result.prepared.mergedContent, 'shared tail\nremote addition\n');
        }

        const unprovenDeletion = prepareProvenDocumentUpdate(
            {version: 20, content: 'shared tail\n', pendingWrite: false},
            21,
            remote,
            'shared tail\n',
        );
        assert.equal(unprovenDeletion.status, 'noop');
        if (unprovenDeletion.status === 'noop') {
            assert.equal(unprovenDeletion.prepared.mergedContent, remote);
            assert.deepEqual(unprovenDeletion.prepared.operations, []);
        }
    });

    it('preserves post-base remote edits across deterministic non-overlap and overlap series', () => {
        const apply = (text: string, operations: Array<{p: number, i?: string, d?: string}>) => {
            let result = text;
            for (const operation of operations) {
                if (operation.d !== undefined) {
                    assert.equal(result.slice(operation.p, operation.p + operation.d.length), operation.d);
                    result = result.slice(0, operation.p) + result.slice(operation.p + operation.d.length);
                }
                if (operation.i !== undefined) {
                    result = result.slice(0, operation.p) + operation.i + result.slice(operation.p);
                }
            }
            return result;
        };
        const replace = (text: string, from: string, to: string) => {
            const position = text.indexOf(from);
            assert.notEqual(position, -1);
            return text.slice(0, position) + to + text.slice(position + from.length);
        };
        let state = 0x5eed1234;
        const next = () => {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            return state;
        };

        for (let sample = 0; sample < 128; sample += 1) {
            const slots = Array.from({length: 9}, (_, index) => `slot-${index}=BASE-${index}`);
            const base = `${slots.join('\n')}\n`;
            const remoteIndex = next() % slots.length;
            let localIndex = next() % slots.length;
            if (localIndex === remoteIndex) { localIndex = (localIndex + 1) % slots.length; }
            const remoteToken = `slot-${remoteIndex}=REMOTE-${sample}`;
            const localToken = `slot-${localIndex}=LOCAL-${sample}`;
            const remote = replace(base, slots[remoteIndex], remoteToken);
            const desired = replace(base, slots[localIndex], localToken);
            const independent = prepareProvenDocumentUpdate(
                {version: 100 + sample, content: base, pendingWrite: false},
                101 + sample,
                remote,
                desired,
            );
            assert.equal(independent.status, 'ready', `non-overlap sample ${sample}`);
            if (independent.status === 'ready') {
                const expected = replace(remote, slots[localIndex], localToken);
                assert.equal(
                    independent.prepared.mergedContent,
                    expected,
                    `exact merged content sample ${sample}`,
                );
                assert.equal(
                    apply(remote, independent.prepared.operations),
                    expected,
                    `wire replay sample ${sample}`,
                );
            }

            const conflictingDesired = replace(
                base,
                slots[remoteIndex],
                `slot-${remoteIndex}=LOCAL-CONFLICT-${sample}`,
            );
            assert.deepEqual(
                prepareProvenDocumentUpdate(
                    {version: 100 + sample, content: base, pendingWrite: false},
                    101 + sample,
                    remote,
                    conflictingDesired,
                ),
                {status: 'blocked', reason: 'merge-conflict'},
                `overlap sample ${sample} must emit zero operations`,
            );
        }
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
