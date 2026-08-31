import { strict as assert } from 'assert';
import { reconcileReplicaContents } from '../scm/localReplicaSafety';

const encode = (content: string) => new TextEncoder().encode(content);
const decode = (content: Uint8Array) => new TextDecoder().decode(content);

describe('reconcileReplicaContents', () => {
    it('does not overwrite an existing local file without a trusted base', () => {
        const result = reconcileReplicaContents(undefined, encode('offline local'), encode('remote'));
        assert.deepEqual(result, {kind: 'conflict', reason: 'missing-base'});
    });

    it('preserves a one-sided untracked file by copying it to the missing side', () => {
        assert.equal(reconcileReplicaContents(undefined, encode('local'), undefined).kind, 'write-remote');
        assert.equal(reconcileReplicaContents(undefined, undefined, encode('remote')).kind, 'write-local');
    });

    it('establishes a base when both existing copies are identical', () => {
        const result = reconcileReplicaContents(undefined, encode('same'), encode('same'));
        assert.equal(result.kind, 'unchanged');
        if (result.kind === 'unchanged') {
            assert.equal(decode(result.content), 'same');
        }
    });

    it('propagates a change made on only one side', () => {
        const base = encode('base');
        assert.equal(reconcileReplicaContents(base, base, encode('remote')).kind, 'write-local');
        assert.equal(reconcileReplicaContents(base, encode('local'), base).kind, 'write-remote');
    });

    it('merges changes that modify disjoint base ranges', () => {
        const result = reconcileReplicaContents(
            encode('alpha middle omega'),
            encode('ALPHA middle omega'),
            encode('alpha middle OMEGA'),
        );
        assert.equal(result.kind, 'write-both');
        if (result.kind === 'write-both') {
            assert.equal(decode(result.content), 'ALPHA middle OMEGA');
        }
    });

    it('rejects overlapping edits instead of applying a fuzzy patch', () => {
        const result = reconcileReplicaContents(
            encode('same line\n'),
            encode('local line\n'),
            encode('remote line\n'),
        );
        assert.deepEqual(result, {kind: 'conflict', reason: 'overlapping-change'});
    });

    it('rejects concurrent binary changes', () => {
        const result = reconcileReplicaContents(
            new Uint8Array([0xff, 0]),
            new Uint8Array([0xff, 1]),
            new Uint8Array([0xff, 2]),
        );
        assert.deepEqual(result, {kind: 'conflict', reason: 'binary-change'});
    });

    it('propagates a deletion only when the surviving copy still matches the base', () => {
        const base = encode('base');
        assert.deepEqual(reconcileReplicaContents(base, undefined, base), {kind: 'delete-remote'});
        assert.deepEqual(reconcileReplicaContents(base, base, undefined), {kind: 'delete-local'});
        assert.deepEqual(
            reconcileReplicaContents(base, undefined, encode('remote edit')),
            {kind: 'conflict', reason: 'delete-vs-edit'},
        );
        assert.deepEqual(
            reconcileReplicaContents(base, encode('local edit'), undefined),
            {kind: 'conflict', reason: 'delete-vs-edit'},
        );
    });
});
