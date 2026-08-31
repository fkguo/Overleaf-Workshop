import {
    HistoryOtComment,
    HistoryOtOffsetAffinity,
    HistoryOtRange,
    HistoryOtTextOperation,
    HistoryOtTrackedChange,
    HistoryOtTracking,
    HistoryOtTrackingDirective,
    StringFileDataSnapshot,
} from './types';
import {
    deepCloneJson,
    HISTORY_OT_MAX_STRING_LENGTH,
    HistoryOtProtocolError,
} from './protocol';
import {decodeTextOperation, TextOperationAccumulator} from './text';

function clone<T>(value: T): T {
    return deepCloneJson(value) as T;
}

function rangeEnd(range: HistoryOtRange): number {
    return range.pos + range.length;
}

function changedRange(range: HistoryOtRange, pos: number, length: number): HistoryOtRange {
    const result = clone(range);
    result.pos = pos;
    result.length = length;
    return result;
}

function rangesOverlap(left: HistoryOtRange, right: HistoryOtRange): boolean {
    return left.pos < rangeEnd(right) && rangeEnd(left) > right.pos;
}

function rangeContains(outer: HistoryOtRange, inner: HistoryOtRange): boolean {
    return outer.pos <= inner.pos && rangeEnd(outer) >= rangeEnd(inner);
}

function normalizeCommentRanges(ranges: HistoryOtRange[]): HistoryOtRange[] {
    const sorted = ranges
        .filter(range => range.length > 0)
        .map(range => clone(range))
        .sort((left, right) => left.pos - right.pos);
    const result: HistoryOtRange[] = [];
    for (const range of sorted) {
        const previous = result[result.length - 1];
        if (previous === undefined) {
            result.push(range);
        } else if (rangesOverlap(previous, range)) {
            throw new HistoryOtProtocolError('COMMENT_RANGE_OVERLAP', 'A text edit produced overlapping comment ranges');
        } else if (rangeEnd(previous) === range.pos) {
            previous.length = rangeEnd(range) - previous.pos;
        } else {
            result.push(range);
        }
    }
    return result;
}

function insertIntoComment(
    comment: HistoryOtComment,
    pos: number,
    length: number,
    attach: boolean,
): HistoryOtComment {
    const result = clone(comment);
    const ranges: HistoryOtRange[] = [];
    let extended = false;
    for (const range of comment.ranges) {
        const end = rangeEnd(range);
        if (pos === end) {
            if (attach) {
                ranges.push(changedRange(range, range.pos, range.length + length));
                extended = true;
            } else {
                ranges.push(clone(range));
            }
        } else if (pos === range.pos) {
            if (attach) {
                ranges.push(changedRange(range, range.pos, range.length + length));
                extended = true;
            } else {
                ranges.push(changedRange(range, range.pos + length, range.length));
            }
        } else if (range.pos > pos) {
            ranges.push(changedRange(range, range.pos + length, range.length));
        } else if (range.pos < pos && pos < end) {
            if (attach) {
                ranges.push(changedRange(range, range.pos, range.length + length));
                extended = true;
            } else {
                ranges.push(changedRange(range, range.pos, pos - range.pos));
                ranges.push(changedRange(range, pos + length, end - pos));
            }
        } else {
            ranges.push(clone(range));
        }
    }
    if (attach && !extended) {
        ranges.push({pos, length});
    }
    result.ranges = normalizeCommentRanges(ranges);
    return result;
}

function deleteFromRange(range: HistoryOtRange, deleted: HistoryOtRange): HistoryOtRange | undefined {
    const start = range.pos;
    const end = rangeEnd(range);
    const deletedStart = deleted.pos;
    const deletedEnd = rangeEnd(deleted);
    if (end <= deletedStart) {
        return clone(range);
    }
    if (start >= deletedEnd) {
        return changedRange(range, start - deleted.length, range.length);
    }
    const leftLength = Math.max(0, deletedStart - start);
    const rightLength = Math.max(0, end - deletedEnd);
    const remaining = leftLength + rightLength;
    if (remaining === 0) {
        return undefined;
    }
    const newStart = leftLength > 0 ? start : deletedStart;
    return changedRange(range, newStart, remaining);
}

function deleteFromComment(
    comment: HistoryOtComment,
    pos: number,
    length: number,
): HistoryOtComment {
    const result = clone(comment);
    const deleted = {pos, length};
    result.ranges = normalizeCommentRanges(
        comment.ranges
            .map(range => deleteFromRange(range, deleted))
            .filter((range): range is HistoryOtRange => range !== undefined),
    );
    return result;
}

function applyInsertToComments(
    comments: HistoryOtComment[],
    pos: number,
    length: number,
    commentIds: string[] | undefined,
): HistoryOtComment[] {
    return comments.map(comment => insertIntoComment(
        comment,
        pos,
        length,
        commentIds?.includes(comment.id) ?? false,
    ));
}

function applyDeleteToComments(
    comments: HistoryOtComment[],
    pos: number,
    length: number,
): HistoryOtComment[] {
    return comments.map(comment => deleteFromComment(comment, pos, length));
}

function changedTrackedChange(
    change: HistoryOtTrackedChange,
    range: HistoryOtRange,
): HistoryOtTrackedChange {
    const result = clone(change);
    result.range = range;
    return result;
}

function trackingCanMerge(left: HistoryOtTracking, right: HistoryOtTracking): boolean {
    return left.type === right.type && left.userId === right.userId;
}

function normalizeTrackedChanges(changes: HistoryOtTrackedChange[]): HistoryOtTrackedChange[] {
    const sorted = changes
        .filter(change => change.range.length > 0)
        .map(change => clone(change))
        .sort((left, right) => left.range.pos - right.range.pos);
    const result: HistoryOtTrackedChange[] = [];
    for (const change of sorted) {
        const previous = result[result.length - 1];
        if (previous === undefined) {
            result.push(change);
            continue;
        }
        if (rangesOverlap(previous.range, change.range)) {
            throw new HistoryOtProtocolError('TRACKED_RANGE_OVERLAP', 'A text edit produced overlapping tracked ranges');
        }
        if (rangeEnd(previous.range) === change.range.pos
            && trackingCanMerge(previous.tracking, change.tracking)) {
            previous.range.length = rangeEnd(change.range) - previous.range.pos;
            if (Date.parse(change.tracking.ts) < Date.parse(previous.tracking.ts)) {
                previous.tracking = clone(change.tracking);
            }
        } else {
            result.push(change);
        }
    }
    return result;
}

function applyInsertToTrackedChanges(
    changes: HistoryOtTrackedChange[],
    pos: number,
    text: string,
    tracking?: HistoryOtTracking,
): HistoryOtTrackedChange[] {
    const result: HistoryOtTrackedChange[] = [];
    for (const change of changes) {
        const start = change.range.pos;
        const end = rangeEnd(change.range);
        if (start >= pos) {
            result.push(changedTrackedChange(
                change, changedRange(change.range, start + text.length, change.range.length),
            ));
        } else if (pos === end) {
            result.push(clone(change));
        } else if (start < pos && pos < end) {
            const leftLength = pos - start;
            const rightLength = end - pos;
            if (leftLength > 0) {
                result.push(changedTrackedChange(
                    change, changedRange(change.range, start, leftLength),
                ));
            }
            if (rightLength > 0) {
                result.push(changedTrackedChange(
                    change, changedRange(change.range, pos + text.length, rightLength),
                ));
            }
        } else {
            result.push(clone(change));
        }
    }
    if (tracking !== undefined) {
        result.push({
            range: {pos, length: text.length},
            tracking: clone(tracking),
        });
    }
    return result;
}

function applyDeleteToTrackedChanges(
    changes: HistoryOtTrackedChange[],
    pos: number,
    length: number,
): HistoryOtTrackedChange[] {
    const deleted = {pos, length};
    const result: HistoryOtTrackedChange[] = [];
    for (const change of changes) {
        const range = deleteFromRange(change.range, deleted);
        if (range !== undefined) {
            result.push(changedTrackedChange(change, range));
        }
    }
    return result;
}

function subtractTrackedRange(
    change: HistoryOtTrackedChange,
    removedTracking: HistoryOtRange,
): HistoryOtTrackedChange[] {
    if (!rangesOverlap(change.range, removedTracking)) {
        return [clone(change)];
    }
    const result: HistoryOtTrackedChange[] = [];
    const start = change.range.pos;
    const end = rangeEnd(change.range);
    if (start < removedTracking.pos) {
        result.push(changedTrackedChange(
            change,
            changedRange(change.range, start, removedTracking.pos - start),
        ));
    }
    const removedEnd = rangeEnd(removedTracking);
    if (end > removedEnd) {
        result.push(changedTrackedChange(
            change,
            changedRange(change.range, removedEnd, end - removedEnd),
        ));
    }
    return result;
}

function applyRetainToTrackedChanges(
    changes: HistoryOtTrackedChange[],
    pos: number,
    length: number,
    tracking?: HistoryOtTrackingDirective,
): HistoryOtTrackedChange[] {
    if (tracking === undefined) {
        return changes.map(change => clone(change));
    }
    const retained = {pos, length};
    const result = changes.flatMap(change => subtractTrackedRange(change, retained));
    if (tracking.type !== 'none') {
        result.push({range: clone(retained), tracking: clone(tracking)});
    }
    return result;
}

export function applyTextOperationToSnapshot(
    snapshot: StringFileDataSnapshot,
    operation: HistoryOtTextOperation,
): StringFileDataSnapshot {
    const decoded = decodeTextOperation(operation);
    if (decoded.baseLength !== snapshot.content.length) {
        throw new HistoryOtProtocolError(
            'APPLY_LENGTH_MISMATCH',
            `Text operation base length ${decoded.baseLength} does not match snapshot length ${snapshot.content.length}`,
        );
    }
    if (decoded.targetLength > HISTORY_OT_MAX_STRING_LENGTH) {
        throw new HistoryOtProtocolError(
            'RESULT_TOO_LONG',
            `Text operation result exceeds ${HISTORY_OT_MAX_STRING_LENGTH} UTF-16 code units`,
        );
    }

    const result = clone(snapshot);
    let comments = (snapshot.comments ?? []).map(comment => clone(comment));
    let trackedChanges = (snapshot.trackedChanges ?? []).map(change => clone(change));
    let sourceCursor = 0;
    let destinationCursor = 0;
    let content = '';

    for (const scan of decoded.scans) {
        if (scan.kind === 'retain') {
            if (sourceCursor + scan.length > snapshot.content.length) {
                throw new HistoryOtProtocolError('OVER_RETAIN', 'Text operation retains beyond the source snapshot');
            }
            content += snapshot.content.slice(sourceCursor, sourceCursor + scan.length);
            sourceCursor += scan.length;
            destinationCursor += scan.length;
        } else if (scan.kind === 'insert') {
            comments = applyInsertToComments(
                comments, destinationCursor, scan.text.length, scan.commentIds,
            );
            content += scan.text;
            destinationCursor += scan.text.length;
        } else {
            if (sourceCursor + scan.length > snapshot.content.length) {
                throw new HistoryOtProtocolError('OVER_REMOVE', 'Text operation removes beyond the source snapshot');
            }
            comments = applyDeleteToComments(comments, destinationCursor, scan.length);
            sourceCursor += scan.length;
        }
    }
    if (sourceCursor !== snapshot.content.length) {
        throw new HistoryOtProtocolError('INCOMPLETE_SCAN', 'Text operation does not consume the whole source snapshot');
    }

    let trackedCursor = 0;
    for (const scan of decoded.scans) {
        if (scan.kind === 'retain') {
            trackedChanges = applyRetainToTrackedChanges(
                trackedChanges, trackedCursor, scan.length, scan.tracking,
            );
            trackedCursor += scan.length;
        } else if (scan.kind === 'insert') {
            trackedChanges = applyInsertToTrackedChanges(
                trackedChanges, trackedCursor, scan.text, scan.tracking,
            );
            trackedCursor += scan.text.length;
        } else {
            trackedChanges = applyDeleteToTrackedChanges(
                trackedChanges, trackedCursor, scan.length,
            );
        }
    }

    result.content = content;
    if (snapshot.comments !== undefined || comments.length > 0) {
        result.comments = comments;
    }
    if (snapshot.trackedChanges !== undefined || trackedChanges.length > 0) {
        result.trackedChanges = normalizeTrackedChanges(trackedChanges);
    }
    return result;
}

function coveringCommentIds(
    comments: HistoryOtComment[],
    range: HistoryOtRange,
): string[] | undefined {
    const ids = comments
        .filter(comment => comment.ranges.some(commentRange => rangeContains(commentRange, range)))
        .map(comment => comment.id);
    return ids.length === 0 ? undefined : ids;
}

function trackingCoveringRange(
    changes: HistoryOtTrackedChange[],
    range: HistoryOtRange,
): HistoryOtTracking | undefined {
    return changes.find(change => rangeContains(change.range, range))?.tracking;
}

function hasOpaqueRangeFields(range: HistoryOtRange): boolean {
    return Object.keys(range).some(key => key !== 'pos' && key !== 'length');
}

function hasOpaqueTrackedRangeFields(change: HistoryOtTrackedChange): boolean {
    return hasOpaqueRangeFields(change.range)
        || Object.keys(change).some(key => key !== 'range' && key !== 'tracking');
}

function assertInvertibleRangeMetadata(snapshot: StringFileDataSnapshot, affected: HistoryOtRange): void {
    const opaqueCommentRange = (snapshot.comments ?? []).some(comment =>
        comment.ranges.some(range => rangesOverlap(range, affected) && hasOpaqueRangeFields(range)));
    const opaqueTrackedRange = (snapshot.trackedChanges ?? []).some(change =>
        rangesOverlap(change.range, affected) && hasOpaqueTrackedRangeFields(change));
    if (opaqueCommentRange || opaqueTrackedRange) {
        throw new HistoryOtProtocolError(
            'OPAQUE_RANGE_NOT_INVERTIBLE',
            'The operation touches opaque range metadata that History-OT scan operations cannot reconstruct',
        );
    }
}

export function invertTextOperation(
    snapshot: StringFileDataSnapshot,
    operation: HistoryOtTextOperation,
): HistoryOtTextOperation {
    const decoded = decodeTextOperation(operation);
    if (decoded.baseLength !== snapshot.content.length) {
        throw new HistoryOtProtocolError(
            'INVERT_LENGTH_MISMATCH',
            `Text operation base length ${decoded.baseLength} does not match snapshot length ${snapshot.content.length}`,
        );
    }
    const inverse = new TextOperationAccumulator();
    let sourceCursor = 0;
    for (const scan of decoded.scans) {
        if (scan.kind === 'insert') {
            inverse.remove(scan.text.length);
            continue;
        }
        if (scan.kind === 'retain') {
            if (scan.tracking === undefined) {
                inverse.retain(scan.length);
                sourceCursor += scan.length;
                continue;
            }
            const affected = {pos: sourceCursor, length: scan.length};
            assertInvertibleRangeMetadata(snapshot, affected);
            const target = sourceCursor + scan.length;
            const previous = (snapshot.trackedChanges ?? [])
                .map(change => {
                    const start = Math.max(change.range.pos, affected.pos);
                    const end = Math.min(rangeEnd(change.range), rangeEnd(affected));
                    return end > start
                        ? {range: {pos: start, length: end - start}, tracking: change.tracking}
                        : undefined;
                })
                .filter((change): change is {range: HistoryOtRange, tracking: HistoryOtTracking} =>
                    change !== undefined);
            for (const change of previous) {
                if (sourceCursor < change.range.pos) {
                    inverse.retain(change.range.pos - sourceCursor, {type: 'none'});
                    sourceCursor = change.range.pos;
                }
                inverse.retain(change.range.length, change.tracking);
                sourceCursor += change.range.length;
            }
            if (sourceCursor < target) {
                inverse.retain(target - sourceCursor, {type: 'none'});
                sourceCursor = target;
            }
            continue;
        }

        const affected = {pos: sourceCursor, length: scan.length};
        assertInvertibleRangeMetadata(snapshot, affected);
        const boundaries = new Set<number>([affected.pos, rangeEnd(affected)]);
        for (const comment of snapshot.comments ?? []) {
            for (const range of comment.ranges) {
                if (rangesOverlap(range, affected)) {
                    boundaries.add(Math.max(range.pos, affected.pos));
                    boundaries.add(Math.min(rangeEnd(range), rangeEnd(affected)));
                }
            }
        }
        for (const change of snapshot.trackedChanges ?? []) {
            if (rangesOverlap(change.range, affected)) {
                boundaries.add(Math.max(change.range.pos, affected.pos));
                boundaries.add(Math.min(rangeEnd(change.range), rangeEnd(affected)));
            }
        }
        const ordered = [...boundaries].sort((left, right) => left - right);
        for (let index = 1; index < ordered.length; index += 1) {
            const start = ordered[index - 1];
            const end = ordered[index];
            const range = {pos: start, length: end - start};
            inverse.insert(
                snapshot.content.slice(start, end),
                trackingCoveringRange(snapshot.trackedChanges ?? [], range),
                coveringCommentIds(snapshot.comments ?? [], range),
            );
        }
        sourceCursor += scan.length;
    }
    if (sourceCursor !== snapshot.content.length) {
        throw new HistoryOtProtocolError('INCOMPLETE_SCAN', 'Text operation does not consume the whole source snapshot');
    }
    return inverse.toRaw();
}

export function transformCommentThroughTextOperation(
    comment: HistoryOtComment,
    operation: HistoryOtTextOperation,
): HistoryOtComment {
    const decoded = decodeTextOperation(operation);
    for (const range of comment.ranges) {
        if (rangeEnd(range) > decoded.baseLength) {
            throw new HistoryOtProtocolError(
                'COMMENT_RANGE_OUT_OF_BOUNDS',
                'A concurrent add-comment range extends past the text operation base document',
            );
        }
    }
    let result = clone(comment);
    let cursor = 0;
    for (const scan of decoded.scans) {
        if (scan.kind === 'retain') {
            cursor += scan.length;
        } else if (scan.kind === 'insert') {
            result = insertIntoComment(
                result,
                cursor,
                scan.text.length,
                scan.commentIds?.includes(comment.id) ?? false,
            );
            cursor += scan.text.length;
        } else {
            result = deleteFromComment(result, cursor, scan.length);
        }
    }
    return result;
}

function trackedDeletions(snapshot: StringFileDataSnapshot): HistoryOtRange[] {
    return (snapshot.trackedChanges ?? [])
        .filter(change => change.tracking.type === 'delete')
        .map(change => change.range);
}

export function visibleText(snapshot: StringFileDataSnapshot): string {
    let cursor = 0;
    let result = '';
    for (const range of trackedDeletions(snapshot)) {
        result += snapshot.content.slice(cursor, range.pos);
        cursor = rangeEnd(range);
    }
    result += snapshot.content.slice(cursor);
    return result;
}

function assertOffset(offset: number, maximum: number, label: string): void {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > maximum) {
        throw new HistoryOtProtocolError(
            'INVALID_OFFSET', `${label} must be a safe integer between 0 and ${maximum}`,
        );
    }
}

export function mapSnapshotOffsetToVisible(
    snapshot: StringFileDataSnapshot,
    offset: number,
): number {
    assertOffset(offset, snapshot.content.length, 'Snapshot offset');
    let hidden = 0;
    for (const range of trackedDeletions(snapshot)) {
        if (offset < range.pos) {
            break;
        }
        if (offset <= rangeEnd(range)) {
            return range.pos - hidden;
        }
        hidden += range.length;
    }
    return offset - hidden;
}

export function mapVisibleOffsetToSnapshot(
    snapshot: StringFileDataSnapshot,
    offset: number,
    affinity: HistoryOtOffsetAffinity = 'left',
): number {
    const visibleLength = visibleText(snapshot).length;
    assertOffset(offset, visibleLength, 'Visible offset');
    let hidden = 0;
    for (const range of trackedDeletions(snapshot)) {
        const boundary = range.pos - hidden;
        if (affinity === 'left' ? offset <= boundary : offset < boundary) {
            return offset + hidden;
        }
        hidden += range.length;
    }
    return offset + hidden;
}
