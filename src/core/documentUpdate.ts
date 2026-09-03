export type TextOperation = {
    p: number,
    i?: string,
    d?: string,
};

type InsertionOperation = {p: number, i: string, d?: never};
type DeletionOperation = {p: number, d: string, i?: never};

export type ObservedTextChange = {
    rangeOffset: number,
    rangeLength: number,
    text: string,
};

export type CausalRemoteUpdate = {
    version: number,
    operations: TextOperation[],
};

export type CausalDocumentEvidence = {
    localOperations: TextOperation[],
    remoteUpdates: CausalRemoteUpdate[],
};

export type PreparedDocumentUpdate = {
    mergedContent: string,
    mergeApplied: boolean,
    operations: TextOperation[],
};

export type ExactDocumentBase = {
    version: number,
    content: string,
    pendingWrite: boolean,
};

export type ProvenDocumentUpdate =
    | {status: 'noop', prepared: PreparedDocumentUpdate}
    | {status: 'ready', prepared: PreparedDocumentUpdate}
    | {
        status: 'blocked',
        reason:
            | 'missing-base'
            | 'pending-write'
            | 'version-regression'
            | 'content-version-mismatch'
            | 'missing-local-causality'
            | 'missing-remote-causality'
            | 'invalid-causal-operations'
            | 'causal-conflict',
    };

type EditFootprint =
    | {kind: 'insert', position: number}
    | {kind: 'delete', start: number, end: number};

type PositionMarker = {
    origin?: number,
    anchor?: number,
};

export function isSenderConfirmation(update: {op?: unknown[]}): boolean {
    return update.op === undefined;
}

export function buildRecoveryUpdate<T extends object>(
    update: T,
    submittedPublicIds: string[],
): T & {dupIfSource: string[]} {
    return {
        ...update,
        dupIfSource: [...new Set(submittedPublicIds.filter(Boolean))],
    };
}

function isInsertion(operation: TextOperation): operation is InsertionOperation {
    return typeof operation.i === 'string' && operation.d === undefined;
}

function isDeletion(operation: TextOperation): operation is DeletionOperation {
    return typeof operation.d === 'string' && operation.i === undefined;
}

function assertValidComponent(operation: TextOperation): void {
    if (!Number.isInteger(operation.p) || operation.p < 0) {
        throw new Error('Text operation position must be a non-negative integer');
    }
    if (!isInsertion(operation) && !isDeletion(operation)) {
        throw new Error('Text operation must contain exactly one insertion or deletion');
    }
    if ((operation.i ?? operation.d)!.length === 0) {
        throw new Error('Empty text operation components are not causal evidence');
    }
}

/** Apply the fixed Overleaf ShareJS plain-text wire format with strict deletion checks. */
export function applyTextOperations(snapshot: string, operations: TextOperation[]): string {
    let result = snapshot;
    for (const operation of operations) {
        assertValidComponent(operation);
        if (operation.p > result.length) {
            throw new Error('Text operation position is outside the document');
        }
        if (isInsertion(operation)) {
            result = result.slice(0, operation.p) + operation.i + result.slice(operation.p);
            continue;
        }
        if (!isDeletion(operation)) { throw new Error('Invalid deletion component'); }
        const deleted = result.slice(operation.p, operation.p + operation.d.length);
        if (deleted !== operation.d) {
            throw new Error('Text operation deletion does not match the document');
        }
        result = result.slice(0, operation.p) + result.slice(operation.p + operation.d.length);
    }
    return result;
}

/**
 * Convert one observed VS Code change event into the exact sequential ShareJS
 * operation which it caused. Multiple contentChanges are deliberately rejected:
 * the supported host API does not prove a portable cross-change ordering.
 */
export function operationsFromObservedTextChanges(
    before: string,
    changes: readonly ObservedTextChange[],
    after: string,
): TextOperation[] | undefined {
    if (changes.length !== 1) { return undefined; }
    const change = changes[0];
    if (!Number.isInteger(change.rangeOffset)
        || !Number.isInteger(change.rangeLength)
        || change.rangeOffset < 0
        || change.rangeLength < 0
        || change.rangeOffset + change.rangeLength > before.length
        || typeof change.text !== 'string') {
        return undefined;
    }
    const operations: TextOperation[] = [];
    if (change.rangeLength > 0) {
        operations.push({
            p: change.rangeOffset,
            d: before.slice(change.rangeOffset, change.rangeOffset + change.rangeLength),
        });
    }
    if (change.text.length > 0) {
        operations.push({p: change.rangeOffset, i: change.text});
    }
    try {
        return applyTextOperations(before, operations) === after ? operations : undefined;
    } catch {
        return undefined;
    }
}

function cloneOperation(operation: TextOperation): TextOperation {
    if (isInsertion(operation)) { return {p: operation.p, i: operation.i}; }
    if (isDeletion(operation)) { return {p: operation.p, d: operation.d}; }
    throw new Error('Invalid text operation component');
}

function inject(first: string, position: number, second: string): string {
    return first.slice(0, position) + second + first.slice(position);
}

/** Fixed copy of the append semantics in Overleaf's pinned ShareJS text type. */
function appendOperation(destination: TextOperation[], component: TextOperation): void {
    assertValidComponent(component);
    const current = cloneOperation(component);
    const last = destination.at(-1);
    if (!last) {
        destination.push(current);
        return;
    }
    if (isInsertion(last)
        && isInsertion(current)
        && last.p <= current.p
        && current.p <= last.p + last.i.length) {
        destination[destination.length - 1] = {
            p: last.p,
            i: inject(last.i, current.p - last.p, current.i),
        };
        return;
    }
    if (isDeletion(last)
        && isDeletion(current)
        && current.p <= last.p
        && last.p <= current.p + current.d.length) {
        destination[destination.length - 1] = {
            p: current.p,
            d: inject(current.d, last.p - current.p, last.d),
        };
        return;
    }
    destination.push(current);
}

function transformPosition(position: number, other: TextOperation, insertAfter = false): number {
    assertValidComponent(other);
    if (isInsertion(other)) {
        return other.p < position || (other.p === position && insertAfter) ?
            position + other.i.length : position;
    }
    if (!isDeletion(other)) { throw new Error('Invalid transform component'); }
    if (position <= other.p) { return position; }
    if (position <= other.p + other.d.length) { return other.p; }
    return position - other.d.length;
}

/** Fixed copy of Overleaf's pinned ShareJS asymmetric text component transform. */
function transformComponent(
    destination: TextOperation[],
    component: TextOperation,
    other: TextOperation,
    side: 'left' | 'right',
): void {
    assertValidComponent(component);
    assertValidComponent(other);
    if (isInsertion(component)) {
        appendOperation(destination, {
            p: transformPosition(component.p, other, side === 'right'),
            i: component.i,
        });
        return;
    }
    if (!isDeletion(component)) { throw new Error('Invalid transform component'); }
    if (isInsertion(other)) {
        let deletion = component.d;
        if (component.p < other.p) {
            const prefixLength = other.p - component.p;
            appendOperation(destination, {p: component.p, d: deletion.slice(0, prefixLength)});
            deletion = deletion.slice(prefixLength);
        }
        if (deletion.length > 0) {
            appendOperation(destination, {p: component.p + other.i.length, d: deletion});
        }
        return;
    }
    if (!isDeletion(other)) { throw new Error('Invalid transform component'); }
    if (component.p >= other.p + other.d.length) {
        appendOperation(destination, {p: component.p - other.d.length, d: component.d});
        return;
    }
    if (component.p + component.d.length <= other.p) {
        appendOperation(destination, component);
        return;
    }

    let remaining = '';
    if (component.p < other.p) {
        remaining = component.d.slice(0, other.p - component.p);
    }
    if (component.p + component.d.length > other.p + other.d.length) {
        remaining += component.d.slice(other.p + other.d.length - component.p);
    }
    const intersectionStart = Math.max(component.p, other.p);
    const intersectionEnd = Math.min(
        component.p + component.d.length,
        other.p + other.d.length,
    );
    const componentIntersection = component.d.slice(
        intersectionStart - component.p,
        intersectionEnd - component.p,
    );
    const otherIntersection = other.d.slice(
        intersectionStart - other.p,
        intersectionEnd - other.p,
    );
    if (componentIntersection !== otherIntersection) {
        throw new Error('Concurrent deletions disagree about the common text');
    }
    if (remaining.length > 0) {
        appendOperation(destination, {
            p: transformPosition(component.p, other),
            d: remaining,
        });
    }
}

/**
 * Transform both operations exactly as Overleaf's pinned ShareJS helper does.
 * The first operation has left/server precedence; the second has right/client precedence.
 */
function transformOperationPair(
    leftInput: TextOperation[],
    rightInput: TextOperation[],
): [TextOperation[], TextOperation[]] {
    let left = leftInput.map(cloneOperation);
    const transformedRight: TextOperation[] = [];
    for (const originalRight of rightInput) {
        let right: TextOperation | undefined = cloneOperation(originalRight);
        const transformedLeft: TextOperation[] = [];
        let index = 0;
        while (index < left.length && right) {
            const nextRight: TextOperation[] = [];
            transformComponent(transformedLeft, left[index], right, 'left');
            transformComponent(nextRight, right, left[index], 'right');
            index += 1;
            if (nextRight.length === 1) {
                right = nextRight[0];
            } else if (nextRight.length === 0) {
                left.slice(index).forEach(component => appendOperation(transformedLeft, component));
                right = undefined;
            } else {
                const [remainingLeft, splitRight] = transformOperationPair(
                    left.slice(index),
                    nextRight,
                );
                remainingLeft.forEach(component => appendOperation(transformedLeft, component));
                splitRight.forEach(component => appendOperation(transformedRight, component));
                right = undefined;
            }
        }
        if (right) { appendOperation(transformedRight, right); }
        left = transformedLeft;
    }
    return [left, transformedRight];
}

function markerBoundary(markers: PositionMarker[], position: number, originalLength: number): number {
    for (let index = position; index < markers.length; index += 1) {
        const marker = markers[index];
        if (marker.origin !== undefined) { return marker.origin; }
        if (marker.anchor !== undefined) { return marker.anchor; }
    }
    for (let index = position - 1; index >= 0; index -= 1) {
        const marker = markers[index];
        if (marker.origin !== undefined) { return marker.origin + 1; }
        if (marker.anchor !== undefined) { return marker.anchor; }
    }
    return originalLength;
}

/** Map a sequential operation back to conservative ranges in its input snapshot. */
function operationFootprints(snapshot: string, operations: TextOperation[]): EditFootprint[] | undefined {
    const markers: PositionMarker[] = Array.from(
        {length: snapshot.length},
        (_, origin) => ({origin}),
    );
    const footprints: EditFootprint[] = [];
    let content = snapshot;
    try {
        for (const operation of operations) {
            const after = applyTextOperations(content, [operation]);
            if (isInsertion(operation)) {
                const position = markerBoundary(markers, operation.p, snapshot.length);
                footprints.push({kind: 'insert', position});
                markers.splice(
                    operation.p,
                    0,
                    ...Array.from({length: operation.i.length}, () => ({anchor: position})),
                );
            } else {
                if (!isDeletion(operation)) { return undefined; }
                const removed = markers.slice(operation.p, operation.p + operation.d.length);
                // A component which edits text inserted by an earlier component
                // has no unambiguous concurrent range. Reject instead of guessing.
                if (removed.some(marker => marker.origin === undefined)) { return undefined; }
                const origins = removed.map(marker => marker.origin!);
                if (origins.length === 0) { return undefined; }
                footprints.push({
                    kind: 'delete',
                    start: Math.min(...origins),
                    end: Math.max(...origins) + 1,
                });
                markers.splice(operation.p, operation.d.length);
            }
            content = after;
        }
    } catch {
        return undefined;
    }
    return footprints;
}

function footprintsConflict(left: EditFootprint, right: EditFootprint): boolean {
    if (left.kind === 'insert' && right.kind === 'insert') {
        return left.position === right.position;
    }
    if (left.kind === 'insert') {
        if (right.kind !== 'delete') { return false; }
        return left.position >= right.start && left.position <= right.end;
    }
    if (right.kind === 'insert') {
        return right.position >= left.start && right.position <= left.end;
    }
    return Math.max(left.start, right.start) < Math.min(left.end, right.end);
}

function operationsConflict(
    snapshot: string,
    left: TextOperation[],
    right: TextOperation[],
): boolean | undefined {
    const leftFootprints = operationFootprints(snapshot, left);
    const rightFootprints = operationFootprints(snapshot, right);
    if (!leftFootprints || !rightFootprints) { return undefined; }
    return leftFootprints.some(leftFootprint =>
        rightFootprints.some(rightFootprint => footprintsConflict(leftFootprint, rightFootprint))
    );
}

function noWire(content: string): PreparedDocumentUpdate {
    return {mergedContent: content, mergeApplied: true, operations: []};
}

/**
 * Authorize a write only from actual causal evidence. Snapshot alignment is not
 * evidence: repeated text can admit several incompatible edit histories.
 */
export function prepareProvenDocumentUpdate(
    base: ExactDocumentBase | undefined,
    remoteVersion: number,
    remoteContent: string,
    desiredContent: string,
    evidence?: CausalDocumentEvidence,
): ProvenDocumentUpdate {
    if (base && remoteVersion < base.version) {
        return {status: 'blocked', reason: 'version-regression'};
    }
    if (base && remoteVersion === base.version && base.content !== remoteContent) {
        return {status: 'blocked', reason: 'content-version-mismatch'};
    }
    if (base?.pendingWrite) { return {status: 'blocked', reason: 'pending-write'}; }
    if (remoteContent === desiredContent) {
        return {status: 'noop', prepared: noWire(remoteContent)};
    }
    if (!base) { return {status: 'blocked', reason: 'missing-base'}; }
    if (!evidence) { return {status: 'blocked', reason: 'missing-local-causality'}; }

    let localOperations: TextOperation[];
    try {
        localOperations = evidence.localOperations.map(cloneOperation);
        if (applyTextOperations(base.content, localOperations) !== desiredContent) {
            return {status: 'blocked', reason: 'missing-local-causality'};
        }
    } catch {
        return {status: 'blocked', reason: 'invalid-causal-operations'};
    }

    const expectedRemoteCount = remoteVersion - base.version;
    if (evidence.remoteUpdates.length !== expectedRemoteCount) {
        return {status: 'blocked', reason: 'missing-remote-causality'};
    }

    let remoteHead = base.content;
    let localBranch = desiredContent;
    for (let index = 0; index < evidence.remoteUpdates.length; index += 1) {
        const expectedVersion = base.version + index;
        const entry = evidence.remoteUpdates[index];
        if (entry.version !== expectedVersion || entry.operations.length === 0) {
            return {status: 'blocked', reason: 'missing-remote-causality'};
        }
        let remoteOperations: TextOperation[];
        let remoteNext: string;
        try {
            remoteOperations = entry.operations.map(cloneOperation);
            remoteNext = applyTextOperations(remoteHead, remoteOperations);
        } catch {
            return {status: 'blocked', reason: 'invalid-causal-operations'};
        }
        const conflict = operationsConflict(remoteHead, remoteOperations, localOperations);
        if (conflict === undefined) {
            return {status: 'blocked', reason: 'invalid-causal-operations'};
        }
        if (conflict) { return {status: 'blocked', reason: 'causal-conflict'}; }

        try {
            const [remoteAfterLocal, localAfterRemote] = transformOperationPair(
                remoteOperations,
                localOperations,
            );
            const remoteFirst = applyTextOperations(remoteNext, localAfterRemote);
            const localFirst = applyTextOperations(localBranch, remoteAfterLocal);
            if (remoteFirst !== localFirst) {
                return {status: 'blocked', reason: 'invalid-causal-operations'};
            }
            remoteHead = remoteNext;
            localBranch = localFirst;
            localOperations = localAfterRemote;
        } catch {
            return {status: 'blocked', reason: 'invalid-causal-operations'};
        }
    }

    if (remoteHead !== remoteContent) {
        return {status: 'blocked', reason: 'missing-remote-causality'};
    }
    let mergedContent: string;
    try {
        mergedContent = applyTextOperations(remoteContent, localOperations);
    } catch {
        return {status: 'blocked', reason: 'invalid-causal-operations'};
    }
    if (mergedContent !== localBranch) {
        return {status: 'blocked', reason: 'invalid-causal-operations'};
    }
    const prepared: PreparedDocumentUpdate = {
        mergedContent,
        mergeApplied: true,
        operations: localOperations,
    };
    return localOperations.length === 0 ?
        {status: 'noop', prepared} :
        {status: 'ready', prepared};
}
