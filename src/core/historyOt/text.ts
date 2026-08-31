import {
    HistoryOtClearTracking,
    HistoryOtInsertScanOperation,
    HistoryOtRetainScanOperation,
    HistoryOtScanOperation,
    HistoryOtTextOperation,
    HistoryOtTracking,
    HistoryOtTrackingDirective,
    JsonValue,
} from './types';
import {
    deepCloneJson,
    HistoryOtProtocolError,
    isJsonObject,
    normalizeHistoryOtTimestamp,
} from './protocol';

export interface RetainScan {
    kind: 'retain',
    length: number,
    tracking?: HistoryOtTrackingDirective,
}

export interface InsertScan {
    kind: 'insert',
    text: string,
    tracking?: HistoryOtTracking,
    commentIds?: string[],
}

export interface RemoveScan {
    kind: 'remove',
    length: number,
}

export type DecodedScan = RetainScan | InsertScan | RemoveScan;

export interface DecodedTextOperation {
    scans: DecodedScan[],
    baseLength: number,
    targetLength: number,
    contentHash?: string,
}

function appendCanonicalScan(scans: DecodedScan[], scan: DecodedScan): void {
    const next = cloneScan(scan);
    const previous = scans[scans.length - 1];
    if (next.kind === 'retain') {
        if (previous?.kind === 'retain' && trackingCanMerge(previous.tracking, next.tracking)) {
            previous.length += next.length;
            if (previous.tracking !== undefined && next.tracking !== undefined) {
                previous.tracking = mergeTracking(previous.tracking, next.tracking);
            }
        } else {
            scans.push(next);
        }
        return;
    }
    if (next.kind === 'remove') {
        if (previous?.kind === 'remove') {
            previous.length += next.length;
        } else {
            scans.push(next);
        }
        return;
    }
    if (previous?.kind === 'insert'
        && trackingCanMerge(previous.tracking, next.tracking)
        && sameCommentIds(previous.commentIds, next.commentIds)) {
        previous.text += next.text;
        if (previous.tracking !== undefined && next.tracking !== undefined) {
            previous.tracking = mergeTracking(previous.tracking, next.tracking) as HistoryOtTracking;
        }
        return;
    }
    if (previous?.kind === 'remove') {
        const beforeRemove = scans[scans.length - 2];
        if (beforeRemove?.kind === 'insert'
            && trackingCanMerge(beforeRemove.tracking, next.tracking)
            && sameCommentIds(beforeRemove.commentIds, next.commentIds)) {
            beforeRemove.text += next.text;
            if (beforeRemove.tracking !== undefined && next.tracking !== undefined) {
                beforeRemove.tracking = mergeTracking(
                    beforeRemove.tracking, next.tracking,
                ) as HistoryOtTracking;
            }
        } else {
            scans.splice(scans.length - 1, 0, next);
        }
        return;
    }
    scans.push(next);
}

function clone<T extends JsonValue>(value: T): T {
    return deepCloneJson(value) as T;
}

function cloneTracking<T extends HistoryOtTrackingDirective>(tracking: T | undefined): T | undefined {
    return tracking === undefined ? undefined : clone(tracking);
}

function canonicalTracking<T extends HistoryOtTrackingDirective>(tracking: T): T {
    const result = clone(tracking);
    if (result.type !== 'none') {
        result.ts = normalizeHistoryOtTimestamp(result.ts);
    }
    return result;
}

function cloneScan(scan: DecodedScan): DecodedScan {
    switch (scan.kind) {
        case 'retain':
            return {kind: 'retain', length: scan.length, tracking: cloneTracking(scan.tracking)};
        case 'insert':
            return {
                kind: 'insert',
                text: scan.text,
                tracking: cloneTracking(scan.tracking),
                commentIds: scan.commentIds?.slice(),
            };
        case 'remove':
            return {kind: 'remove', length: scan.length};
    }
}

export function decodeTextOperation(operation: HistoryOtTextOperation): DecodedTextOperation {
    const rawScans: DecodedScan[] = operation.textOperation.map(scan => {
        if (typeof scan === 'number') {
            return scan > 0
                ? {kind: 'retain', length: scan}
                : {kind: 'remove', length: -scan};
        }
        if (typeof scan === 'string') {
            return {kind: 'insert', text: scan};
        }
        if ('i' in scan) {
            const insert = scan as HistoryOtInsertScanOperation;
            return {
                kind: 'insert',
                text: insert.i,
                tracking: insert.tracking === undefined ? undefined : clone(insert.tracking),
                commentIds: insert.commentIds?.slice(),
            };
        }
        const retain = scan as HistoryOtRetainScanOperation;
        return {
            kind: 'retain',
            length: retain.r,
            tracking: retain.tracking === undefined ? undefined : clone(retain.tracking),
        };
    });
    const scans: DecodedScan[] = [];
    for (const scan of rawScans) {
        appendCanonicalScan(scans, scan);
    }
    let baseLength = 0;
    let targetLength = 0;
    for (const scan of scans) {
        if (scan.kind === 'retain') {
            baseLength += scan.length;
            targetLength += scan.length;
        } else if (scan.kind === 'insert') {
            targetLength += scan.text.length;
        } else {
            baseLength += scan.length;
        }
    }
    return {
        scans,
        baseLength,
        targetLength,
        contentHash: operation.contentHash,
    };
}

function sameCommentIds(left: string[] | undefined, right: string[] | undefined): boolean {
    if (left === undefined || right === undefined) {
        return left === right;
    }
    return left.length === right.length && left.every(id => right.includes(id));
}

function trackingCanMerge(
    left: HistoryOtTrackingDirective | undefined,
    right: HistoryOtTrackingDirective | undefined,
): boolean {
    if (left === undefined || right === undefined) {
        return left === right;
    }
    if (left.type === 'none' || right.type === 'none') {
        return left.type === 'none' && right.type === 'none';
    }
    return left.type === right.type && left.userId === right.userId;
}

function mergeTracking(
    left: HistoryOtTrackingDirective,
    right: HistoryOtTrackingDirective,
): HistoryOtTrackingDirective {
    if (left.type === 'none' || right.type === 'none') {
        return clone(left as HistoryOtClearTracking);
    }
    return Date.parse(left.ts) <= Date.parse(right.ts) ? clone(left) : clone(right);
}

/** Canonical scan builder with the same insert-before-remove ordering as History-OT. */
export class TextOperationAccumulator {
    readonly scans: DecodedScan[] = [];
    baseLength = 0;
    targetLength = 0;

    retain(length: number, tracking?: HistoryOtTrackingDirective): this {
        if (length === 0) {
            return this;
        }
        this.baseLength += length;
        this.targetLength += length;
        const next: RetainScan = {kind: 'retain', length, tracking: cloneTracking(tracking)};
        const previous = this.scans[this.scans.length - 1];
        if (previous?.kind === 'retain' && trackingCanMerge(previous.tracking, next.tracking)) {
            previous.length += length;
            if (previous.tracking !== undefined && next.tracking !== undefined) {
                previous.tracking = mergeTracking(previous.tracking, next.tracking);
            }
        } else {
            this.scans.push(next);
        }
        return this;
    }

    insert(text: string, tracking?: HistoryOtTracking, commentIds?: string[]): this {
        if (text.length === 0) {
            return this;
        }
        this.targetLength += text.length;
        const next: InsertScan = {
            kind: 'insert',
            text,
            tracking: cloneTracking(tracking),
            commentIds: commentIds?.slice(),
        };
        const previous = this.scans[this.scans.length - 1];
        if (previous?.kind === 'insert'
            && trackingCanMerge(previous.tracking, next.tracking)
            && sameCommentIds(previous.commentIds, next.commentIds)) {
            previous.text += text;
            if (previous.tracking !== undefined && next.tracking !== undefined) {
                previous.tracking = mergeTracking(previous.tracking, next.tracking) as HistoryOtTracking;
            }
            return this;
        }
        if (previous?.kind === 'remove') {
            const beforeRemove = this.scans[this.scans.length - 2];
            if (beforeRemove?.kind === 'insert'
                && trackingCanMerge(beforeRemove.tracking, next.tracking)
                && sameCommentIds(beforeRemove.commentIds, next.commentIds)) {
                beforeRemove.text += text;
                if (beforeRemove.tracking !== undefined && next.tracking !== undefined) {
                    beforeRemove.tracking = mergeTracking(
                        beforeRemove.tracking, next.tracking,
                    ) as HistoryOtTracking;
                }
            } else {
                this.scans.splice(this.scans.length - 1, 0, next);
            }
            return this;
        }
        this.scans.push(next);
        return this;
    }

    remove(length: number): this {
        if (length === 0) {
            return this;
        }
        this.baseLength += length;
        const previous = this.scans[this.scans.length - 1];
        if (previous?.kind === 'remove') {
            previous.length += length;
        } else {
            this.scans.push({kind: 'remove', length});
        }
        return this;
    }

    decoded(): DecodedTextOperation {
        return {
            scans: this.scans.map(cloneScan),
            baseLength: this.baseLength,
            targetLength: this.targetLength,
        };
    }

    toRaw(): HistoryOtTextOperation {
        return encodeTextOperation(this.decoded());
    }
}

export function encodeTextOperation(operation: DecodedTextOperation): HistoryOtTextOperation {
    const textOperation: HistoryOtScanOperation[] = operation.scans.map(scan => {
        if (scan.kind === 'remove') {
            return -scan.length;
        }
        if (scan.kind === 'retain') {
            if (scan.tracking === undefined) {
                return scan.length;
            }
            const raw: HistoryOtRetainScanOperation = {
                r: scan.length,
                tracking: canonicalTracking(scan.tracking),
            };
            return raw;
        }
        if (scan.tracking === undefined && scan.commentIds === undefined) {
            return scan.text;
        }
        const raw: HistoryOtInsertScanOperation = {i: scan.text};
        if (scan.tracking !== undefined) {
            raw.tracking = canonicalTracking(scan.tracking);
        }
        if (scan.commentIds !== undefined) {
            raw.commentIds = scan.commentIds.slice();
        }
        return raw;
    });
    const raw: HistoryOtTextOperation = {textOperation};
    if (operation.contentHash !== undefined) {
        raw.contentHash = operation.contentHash;
    }
    return raw;
}

function shorten(scan: DecodedScan, consumed: number): DecodedScan | undefined {
    const remaining = scan.kind === 'insert' ? scan.text.length - consumed : scan.length - consumed;
    if (remaining === 0) {
        return undefined;
    }
    if (scan.kind === 'insert') {
        return {
            kind: 'insert',
            text: scan.text.slice(consumed),
            tracking: cloneTracking(scan.tracking),
            commentIds: scan.commentIds?.slice(),
        };
    }
    return scan.kind === 'retain'
        ? {kind: 'retain', length: remaining, tracking: cloneTracking(scan.tracking)}
        : {kind: 'remove', length: remaining};
}

function takeLength(scan: DecodedScan): number {
    return scan.kind === 'insert' ? scan.text.length : scan.length;
}

export function composeTextOperations(
    firstRaw: HistoryOtTextOperation,
    secondRaw: HistoryOtTextOperation,
): HistoryOtTextOperation {
    const first = decodeTextOperation(firstRaw);
    const second = decodeTextOperation(secondRaw);
    if (first.targetLength !== second.baseLength) {
        throw new HistoryOtProtocolError(
            'COMPOSE_LENGTH_MISMATCH',
            `Cannot compose text operations with intermediate lengths ${first.targetLength} and ${second.baseLength}`,
        );
    }
    const out = new TextOperationAccumulator();
    let firstIndex = 0;
    let secondIndex = 0;
    let left = first.scans[firstIndex++];
    let right = second.scans[secondIndex++];

    while (left !== undefined || right !== undefined) {
        if (left?.kind === 'remove') {
            out.remove(left.length);
            left = first.scans[firstIndex++];
            continue;
        }
        if (right?.kind === 'insert') {
            out.insert(right.text, right.tracking, right.commentIds);
            right = second.scans[secondIndex++];
            continue;
        }
        if (left === undefined || right === undefined) {
            throw new HistoryOtProtocolError(
                'COMPOSE_SCAN_MISMATCH',
                `Text operation scans do not cover the same intermediate document`,
            );
        }

        const amount = Math.min(takeLength(left), takeLength(right));
        if (left.kind === 'retain' && right.kind === 'retain') {
            out.retain(amount, right.tracking ?? left.tracking);
        } else if (left.kind === 'insert' && right.kind === 'remove') {
            // The later removal cancels this portion of the earlier insertion.
        } else if (left.kind === 'insert' && right.kind === 'retain') {
            const tracking = right.tracking?.type === 'none'
                ? undefined
                : right.tracking ?? left.tracking;
            out.insert(left.text.slice(0, amount), tracking, left.commentIds);
        } else if (left.kind === 'retain' && right.kind === 'remove') {
            out.remove(amount);
        } else {
            throw new HistoryOtProtocolError('COMPOSE_INCOMPATIBLE', 'Incompatible text scans during compose');
        }

        const leftRemainder = shorten(left, amount);
        const rightRemainder = shorten(right, amount);
        left = leftRemainder ?? first.scans[firstIndex++];
        right = rightRemainder ?? second.scans[secondIndex++];
    }
    // contentHash is intentionally omitted: neither input hash identifies the composed wire op.
    return out.toRaw();
}

export function transformTextOperations(
    firstRaw: HistoryOtTextOperation,
    secondRaw: HistoryOtTextOperation,
): [HistoryOtTextOperation, HistoryOtTextOperation] {
    const first = decodeTextOperation(firstRaw);
    const second = decodeTextOperation(secondRaw);
    if (first.baseLength !== second.baseLength) {
        throw new HistoryOtProtocolError(
            'TRANSFORM_LENGTH_MISMATCH',
            `Concurrent text operations have base lengths ${first.baseLength} and ${second.baseLength}`,
        );
    }
    const firstPrime = new TextOperationAccumulator();
    const secondPrime = new TextOperationAccumulator();
    let firstIndex = 0;
    let secondIndex = 0;
    let left = first.scans[firstIndex++];
    let right = second.scans[secondIndex++];

    while (left !== undefined || right !== undefined) {
        if (left?.kind === 'insert') {
            firstPrime.insert(left.text, left.tracking, left.commentIds);
            secondPrime.retain(left.text.length);
            left = first.scans[firstIndex++];
            continue;
        }
        if (right?.kind === 'insert') {
            firstPrime.retain(right.text.length);
            secondPrime.insert(right.text, right.tracking, right.commentIds);
            right = second.scans[secondIndex++];
            continue;
        }
        if (left === undefined || right === undefined) {
            throw new HistoryOtProtocolError(
                'TRANSFORM_SCAN_MISMATCH',
                'Concurrent text operation scans do not cover the same base document',
            );
        }

        const amount = Math.min(left.length, right.length);
        if (left.kind === 'retain' && right.kind === 'retain') {
            if (left.tracking !== undefined) {
                firstPrime.retain(amount, left.tracking);
                secondPrime.retain(amount);
            } else {
                firstPrime.retain(amount);
                secondPrime.retain(amount, right.tracking);
            }
        } else if (left.kind === 'remove' && right.kind === 'remove') {
            // Both sides already removed this portion.
        } else if (left.kind === 'remove' && right.kind === 'retain') {
            firstPrime.remove(amount);
        } else if (left.kind === 'retain' && right.kind === 'remove') {
            secondPrime.remove(amount);
        } else {
            throw new HistoryOtProtocolError('TRANSFORM_INCOMPATIBLE', 'Incompatible text scans during transform');
        }

        const leftRemainder = shorten(left, amount);
        const rightRemainder = shorten(right, amount);
        left = leftRemainder ?? first.scans[firstIndex++];
        right = rightRemainder ?? second.scans[secondIndex++];
    }
    return [firstPrime.toRaw(), secondPrime.toRaw()];
}

export function isTextOperation(value: JsonValue): value is HistoryOtTextOperation {
    return isJsonObject(value) && Array.isArray(value.textOperation);
}
