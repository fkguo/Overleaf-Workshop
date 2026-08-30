import DiffMatchPatch = require('diff-match-patch');

interface TextChange {
    start: number;
    end: number;
    replacement: string;
}

export type ReplicaReconciliation =
    | {kind: 'absent'}
    | {kind: 'unchanged', content: Uint8Array}
    | {kind: 'write-local', content: Uint8Array}
    | {kind: 'write-remote', content: Uint8Array}
    | {kind: 'write-both', content: Uint8Array}
    | {kind: 'delete-local'}
    | {kind: 'delete-remote'}
    | {kind: 'conflict', reason: 'missing-base' | 'binary-change' | 'overlapping-change' | 'delete-vs-edit'};

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    if (left.length !== right.length) { return false; }
    return left.every((value, index) => value === right[index]);
}

function decodeUtf8(content: Uint8Array): string | undefined {
    try {
        return new TextDecoder('utf-8', {fatal: true}).decode(content);
    } catch {
        return undefined;
    }
}

function textChanges(base: string, target: string): TextChange[] {
    const dmp = new DiffMatchPatch();
    const diffs = dmp.diff_main(base, target, false);
    const changes: TextChange[] = [];
    let baseOffset = 0;
    let active: TextChange | undefined;

    const flush = () => {
        if (active) {
            changes.push(active);
            active = undefined;
        }
    };

    for (const [operation, text] of diffs) {
        if (operation === DiffMatchPatch.DIFF_EQUAL) {
            flush();
            baseOffset += text.length;
            continue;
        }

        active ??= {start: baseOffset, end: baseOffset, replacement: ''};
        if (operation === DiffMatchPatch.DIFF_DELETE) {
            baseOffset += text.length;
            active.end = baseOffset;
        } else if (operation === DiffMatchPatch.DIFF_INSERT) {
            active.replacement += text;
        }
    }
    flush();
    return changes;
}

function changesOverlap(left: TextChange, right: TextChange): boolean {
    const leftIsInsertion = left.start === left.end;
    const rightIsInsertion = right.start === right.end;
    if (leftIsInsertion && rightIsInsertion) {
        return left.start === right.start;
    }
    if (leftIsInsertion) {
        return left.start >= right.start && left.start <= right.end;
    }
    if (rightIsInsertion) {
        return right.start >= left.start && right.start <= left.end;
    }
    return left.start < right.end && right.start < left.end;
}

function applyChanges(base: string, changes: TextChange[]): string {
    return [...changes]
        .sort((left, right) => right.start - left.start || right.end - left.end)
        .reduce(
            (content, change) => content.slice(0, change.start) + change.replacement + content.slice(change.end),
            base,
        );
}

function mergeDisjointChanges(base: string, local: string, remote: string): string | undefined {
    const localChanges = textChanges(base, local);
    const remoteChanges = textChanges(base, remote);
    if (applyChanges(base, localChanges) !== local || applyChanges(base, remoteChanges) !== remote) {
        return undefined;
    }
    if (localChanges.some(localChange =>
        remoteChanges.some(remoteChange => changesOverlap(localChange, remoteChange))
    )) {
        return undefined;
    }
    return applyChanges(base, [...localChanges, ...remoteChanges]);
}

/**
 * Decide an initial local-replica reconciliation without performing I/O.
 *
 * When both copies exist but differ, missing ancestry and overlapping edits are
 * deliberately conflicts: guessing can overwrite offline work or publish a
 * corrupted fuzzy merge. A one-sided path is copied to the missing side so its
 * content is preserved.
 */
export function reconcileReplicaContents(
    base: Uint8Array | undefined,
    local: Uint8Array | undefined,
    remote: Uint8Array | undefined,
): ReplicaReconciliation {
    if (local === undefined && remote === undefined) {
        return {kind: 'absent'};
    }
    if (base === undefined) {
        if (local === undefined) {
            return {kind: 'write-local', content: remote!};
        }
        if (remote === undefined) {
            return {kind: 'write-remote', content: local};
        }
        if (bytesEqual(local, remote)) {
            return {kind: 'unchanged', content: local};
        }
        return {kind: 'conflict', reason: 'missing-base'};
    }
    if (local === undefined) {
        return bytesEqual(base, remote!) ?
            {kind: 'delete-remote'} : {kind: 'conflict', reason: 'delete-vs-edit'};
    }
    if (remote === undefined) {
        return bytesEqual(base, local) ?
            {kind: 'delete-local'} : {kind: 'conflict', reason: 'delete-vs-edit'};
    }
    if (bytesEqual(local, remote)) {
        return {kind: 'unchanged', content: local};
    }
    if (bytesEqual(base, local)) {
        return {kind: 'write-local', content: remote};
    }
    if (bytesEqual(base, remote)) {
        return {kind: 'write-remote', content: local};
    }

    const baseText = decodeUtf8(base);
    const localText = decodeUtf8(local);
    const remoteText = decodeUtf8(remote);
    if (baseText === undefined || localText === undefined || remoteText === undefined) {
        return {kind: 'conflict', reason: 'binary-change'};
    }
    const merged = mergeDisjointChanges(baseText, localText, remoteText);
    if (merged === undefined) {
        return {kind: 'conflict', reason: 'overlapping-change'};
    }
    return {kind: 'write-both', content: new TextEncoder().encode(merged)};
}
