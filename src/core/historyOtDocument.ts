import {
    applyHistoryOtOperations,
    buildHistoryOtTextUpdate,
    getVisibleHistoryOtText,
    historyOtJsonEqual,
    HistoryOtProtocolError,
    HistoryOtSnapshotInput,
    HistoryOtTextEdit,
    HistoryOtTracking,
    HistoryOtTrackingDirective,
    HistoryOtTrackingInput,
    parseHistoryOtOperations,
    ParsedHistoryOtOperations,
    serializeHistoryOtSnapshot,
    StringFileDataSnapshot,
    visibleOffsetToSnapshot,
} from './historyOt';
import {TextOperationAccumulator} from './historyOt/text';
import {applyTextOperations, TextOperation} from './documentUpdate';

export interface PreparedHistoryOtDocumentUpdate {
    readonly remoteVisibleContent: string,
    readonly mergedVisibleContent: string,
    readonly mergeApplied: boolean,
    readonly operation?: ParsedHistoryOtOperations,
    readonly snapshotEdits: readonly HistoryOtTextEdit[],
}

function splitsSurrogatePair(text: string, offset: number): boolean {
    if (offset <= 0 || offset >= text.length) { return false; }
    const previous = text.charCodeAt(offset - 1);
    const next = text.charCodeAt(offset);
    return previous >= 0xD800 && previous <= 0xDBFF
        && next >= 0xDC00 && next <= 0xDFFF;
}

function assertVisibleOperation(current: string, operation: TextOperation): void {
    const deleted = operation.d;
    const inserted = operation.i;
    const end = operation.p + (deleted?.length ?? 0);
    if (Number.isSafeInteger(operation.p)
        && operation.p >= 0
        && end <= current.length
        && (splitsSurrogatePair(current, operation.p)
            || splitsSurrogatePair(current, end))) {
        throw new HistoryOtProtocolError(
            'SURROGATE_BOUNDARY_EDIT',
            'History-OT cannot edit inside an existing non-BMP character',
        );
    }
    if (!Number.isSafeInteger(operation.p)
        || operation.p < 0
        || end > current.length
        || (inserted === undefined) === (deleted === undefined)
        || (deleted !== undefined && current.slice(operation.p, end) !== deleted)) {
        throw new HistoryOtProtocolError(
            'INVALID_VISIBLE_OPERATION',
            'History-OT requires exact sequential visible editor operations',
        );
    }
}

function assertVisibleSurrogatesContiguous(
    snapshot: HistoryOtSnapshotInput,
    visible: string,
): void {
    for (let offset = 0; offset + 1 < visible.length; offset += 1) {
        const high = visible.charCodeAt(offset);
        const low = visible.charCodeAt(offset + 1);
        if (high < 0xD800 || high > 0xDBFF || low < 0xDC00 || low > 0xDFFF) {
            continue;
        }
        const start = visibleOffsetToSnapshot(snapshot, offset, 'right');
        const middleLeft = visibleOffsetToSnapshot(snapshot, offset + 1, 'left');
        const middleRight = visibleOffsetToSnapshot(snapshot, offset + 1, 'right');
        const end = visibleOffsetToSnapshot(snapshot, offset + 2, 'left');
        if (middleLeft !== start + 1
            || middleRight !== middleLeft
            || end !== middleRight + 1) {
            throw new HistoryOtProtocolError(
                'NONCONTIGUOUS_VISIBLE_SURROGATE',
                'History-OT visible surrogate pairs must be contiguous in the snapshot',
            );
        }
        offset += 1;
    }
}

function nextUtf16Boundary(text: string, offset: number): number {
    const code = text.charCodeAt(offset);
    return code >= 0xD800 && code <= 0xDBFF ? offset + 2 : offset + 1;
}

/** Map only visible source characters, retaining hidden tracked deletions between them. */
function snapshotDeletionSpans(
    snapshot: HistoryOtSnapshotInput,
    visible: string,
    start: number,
    end: number,
): Array<{start: number, end: number}> {
    const spans: Array<{start: number, end: number}> = [];
    for (let offset = start; offset < end;) {
        const next = nextUtf16Boundary(visible, offset);
        const snapshotStart = visibleOffsetToSnapshot(snapshot, offset, 'right');
        const snapshotEnd = visibleOffsetToSnapshot(snapshot, next, 'left');
        if (snapshotEnd - snapshotStart !== next - offset) {
            throw new HistoryOtProtocolError(
                'INVALID_VISIBLE_MAPPING',
                'History-OT could not map a contiguous visible character without consuming hidden text',
            );
        }
        const previous = spans.at(-1);
        if (previous?.end === snapshotStart) {
            previous.end = snapshotEnd;
        } else {
            spans.push({start: snapshotStart, end: snapshotEnd});
        }
        offset = next;
    }
    return spans;
}

function snapshotEditsForOperation(
    snapshot: HistoryOtSnapshotInput,
    visible: string,
    operation: TextOperation,
    tracking?: HistoryOtTrackingInput,
): HistoryOtTextEdit[] {
    assertVisibleOperation(visible, operation);
    if (operation.i !== undefined) {
        return [{
            pos: visibleOffsetToSnapshot(snapshot, operation.p, 'left'),
            deleteLength: 0,
            insertText: operation.i,
            tracking,
        }];
    }
    return snapshotDeletionSpans(
        snapshot,
        visible,
        operation.p,
        operation.p + operation.d!.length,
    ).map(span => ({
        pos: span.start,
        deleteLength: span.end - span.start,
        insertText: '',
        tracking,
    }));
}

type SnapshotMarker = {origin: number, text: string} | {text: string};

function applySnapshotEditsToMarkers(
    markers: SnapshotMarker[],
    edits: readonly HistoryOtTextEdit[],
): void {
    let offsetDelta = 0;
    for (const edit of edits) {
        const inserted = edit.insertText ?? '';
        const destination = edit.pos + offsetDelta;
        if (inserted.length > 0) {
            markers.splice(
                destination,
                0,
                ...Array.from({length: inserted.length}, (_, offset) => ({
                    text: inserted.charAt(offset),
                })),
            );
            offsetDelta += inserted.length;
        }
        const deleted = edit.deleteLength ?? 0;
        if (deleted > 0 && edit.tracking === undefined) {
            markers.splice(destination + inserted.length, deleted);
            offsetDelta -= deleted;
        }
    }
}

function trackingAt(
    snapshot: StringFileDataSnapshot,
    offset: number,
): HistoryOtTracking | undefined {
    return snapshot.trackedChanges?.find(change =>
        change.range.pos <= offset
        && offset < change.range.pos + change.range.length)?.tracking;
}

function sameTracking(
    left: HistoryOtTracking | undefined,
    right: HistoryOtTracking | undefined,
): boolean {
    if (left === undefined || right === undefined) {
        return left === right;
    }
    return left.type === right.type
        && left.userId === right.userId
        && Date.parse(left.ts) === Date.parse(right.ts);
}

function commentIdsAt(
    snapshot: StringFileDataSnapshot,
    offset: number,
): string[] | undefined {
    const ids = snapshot.comments
        ?.filter(comment => comment.ranges.some(range =>
            range.pos <= offset && offset < range.pos + range.length))
        .map(comment => comment.id);
    return ids === undefined || ids.length === 0 ? undefined : ids;
}

/** Synthesize one source-snapshot scan with the exact sequentially derived state. */
function synthesizeSequentialOperation(
    source: HistoryOtSnapshotInput,
    expected: HistoryOtSnapshotInput,
    markers: readonly SnapshotMarker[],
): ParsedHistoryOtOperations {
    const sourceRaw = serializeHistoryOtSnapshot(source) as StringFileDataSnapshot;
    const expectedRaw = serializeHistoryOtSnapshot(expected) as StringFileDataSnapshot;
    if (markers.map(marker => marker.text).join('') !== expectedRaw.content) {
        throw new HistoryOtProtocolError(
            'INVALID_SEQUENTIAL_PROVENANCE',
            'History-OT sequential mapping lost raw snapshot character provenance',
        );
    }

    const builder = new TextOperationAccumulator();
    let sourceCursor = 0;
    for (const [targetOffset, marker] of markers.entries()) {
        const targetTracking = trackingAt(expectedRaw, targetOffset);
        if (!('origin' in marker)) {
            builder.insert(
                marker.text,
                targetTracking,
                commentIdsAt(expectedRaw, targetOffset),
            );
            continue;
        }
        if (marker.origin < sourceCursor || marker.text !== sourceRaw.content.charAt(marker.origin)) {
            throw new HistoryOtProtocolError(
                'INVALID_SEQUENTIAL_PROVENANCE',
                'History-OT sequential mapping reordered source snapshot characters',
            );
        }
        builder.remove(marker.origin - sourceCursor);
        sourceCursor = marker.origin;
        const sourceTracking = trackingAt(sourceRaw, marker.origin);
        const directive: HistoryOtTrackingDirective | undefined = sameTracking(
            sourceTracking,
            targetTracking,
        )
            ? undefined
            : targetTracking ?? {type: 'none'};
        builder.retain(1, directive);
        sourceCursor += 1;
    }
    builder.remove(sourceRaw.content.length - sourceCursor);
    const operation = parseHistoryOtOperations([builder.toRaw()]);
    const applied = applyHistoryOtOperations(source, operation);
    if (!historyOtJsonEqual(
        serializeHistoryOtSnapshot(applied),
        serializeHistoryOtSnapshot(expected),
    )) {
        throw new HistoryOtProtocolError(
            'UNREPRESENTABLE_SEQUENTIAL_UPDATE',
            'History-OT cannot encode the exact sequential snapshot state as one logical text operation',
        );
    }
    return operation;
}

/**
 * Map exact observed visible editor operations into History-OT snapshot
 * coordinates. String re-diff/three-way merge is intentionally not accepted as
 * causal evidence: callers must first transform the observed local operation
 * through every collaborator update.
 */
export function prepareHistoryOtDocumentUpdate(
    snapshot: HistoryOtSnapshotInput,
    localVisibleBase: string,
    desiredVisibleContent: string,
    localVisibleOperations: readonly TextOperation[],
    tracking?: HistoryOtTrackingInput,
): PreparedHistoryOtDocumentUpdate {
    const remoteVisibleContent = getVisibleHistoryOtText(snapshot);
    if (remoteVisibleContent !== localVisibleBase) {
        return {
            remoteVisibleContent,
            mergedVisibleContent: remoteVisibleContent,
            mergeApplied: false,
            snapshotEdits: [],
        };
    }
    assertVisibleSurrogatesContiguous(snapshot, remoteVisibleContent);

    try {
        if (applyTextOperations(localVisibleBase, [...localVisibleOperations])
            !== desiredVisibleContent) {
            return {
                remoteVisibleContent,
                mergedVisibleContent: remoteVisibleContent,
                mergeApplied: false,
                snapshotEdits: [],
            };
        }
    } catch {
        return {
            remoteVisibleContent,
            mergedVisibleContent: remoteVisibleContent,
            mergeApplied: false,
            snapshotEdits: [],
        };
    }

    const snapshotEdits: HistoryOtTextEdit[] = [];
    let currentSnapshot: HistoryOtSnapshotInput = snapshot;
    let currentVisibleContent = remoteVisibleContent;
    const sourceRaw = serializeHistoryOtSnapshot(snapshot) as StringFileDataSnapshot;
    const markers: SnapshotMarker[] = Array.from(
        {length: sourceRaw.content.length},
        (_, origin) => ({origin, text: sourceRaw.content.charAt(origin)}),
    );
    for (const visibleOperation of localVisibleOperations) {
        assertVisibleSurrogatesContiguous(currentSnapshot, currentVisibleContent);
        const edits = snapshotEditsForOperation(
            currentSnapshot,
            currentVisibleContent,
            visibleOperation,
            tracking,
        );
        const mappedOperation = buildHistoryOtTextUpdate(currentSnapshot, edits);
        applySnapshotEditsToMarkers(markers, edits);
        snapshotEdits.push(...edits);
        currentSnapshot = applyHistoryOtOperations(currentSnapshot, mappedOperation);
        currentVisibleContent = applyTextOperations(
            currentVisibleContent,
            [{...visibleOperation}],
        );
        if (getVisibleHistoryOtText(currentSnapshot) !== currentVisibleContent) {
            throw new Error('History OT sequential visible/snapshot mapping failed its apply witness');
        }
    }

    if (snapshotEdits.length === 0) {
        return {
            remoteVisibleContent,
            mergedVisibleContent: desiredVisibleContent,
            mergeApplied: true,
            snapshotEdits,
        };
    }
    const operation = synthesizeSequentialOperation(snapshot, currentSnapshot, markers);
    const applied = applyHistoryOtOperations(snapshot, operation);
    if (currentVisibleContent !== desiredVisibleContent
        || !historyOtJsonEqual(
            serializeHistoryOtSnapshot(applied),
            serializeHistoryOtSnapshot(currentSnapshot),
        )) {
        throw new Error('History OT exact sequential mapping failed its apply witness');
    }
    return {
        remoteVisibleContent,
        mergedVisibleContent: desiredVisibleContent,
        mergeApplied: true,
        operation,
        snapshotEdits,
    };
}
