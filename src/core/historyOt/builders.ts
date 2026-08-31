import {
    HistoryOtRange,
    HistoryOtSnapshotInput,
    HistoryOtTextEdit,
    HistoryOtTrackedChange,
    HistoryOtTrackingInput,
    ParsedHistoryOtOperations,
} from './types';
import {
    getSafeSnapshotRaw,
    HistoryOtProtocolError,
    normalizeHistoryOtTimestamp,
    parseHistoryOtOperations,
} from './protocol';
import {TextOperationAccumulator} from './text';

function assertTrackingInput(tracking: HistoryOtTrackingInput): void {
    if (typeof tracking.userId !== 'string' || tracking.userId.length === 0) {
        throw new HistoryOtProtocolError('INVALID_TRACKING', 'Tracked edits require a non-empty userId');
    }
    normalizeHistoryOtTimestamp(tracking.ts);
}

function assertInsertedText(text: string): void {
    if (/[\uD800-\uDBFF]/.test(text)) {
        throw new HistoryOtProtocolError(
            'NON_BMP_INSERTION', 'History-OT does not support inserted non-BMP characters',
        );
    }
}

function editLength(value: number | undefined, label: string): number {
    if (value === undefined) {
        return 0;
    }
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new HistoryOtProtocolError('INVALID_EDIT', `${label} must be a non-negative safe integer`);
    }
    return value;
}

/**
 * Build one full-snapshot text operation from ordered source-coordinate edits.
 * A replacement inserts first and then consumes deleteLength at the same source position.
 */
export function buildHistoryOtTextUpdate(
    snapshotInput: HistoryOtSnapshotInput,
    edits: readonly HistoryOtTextEdit[],
): ParsedHistoryOtOperations {
    const snapshot = getSafeSnapshotRaw(snapshotInput);
    const builder = new TextOperationAccumulator();
    let sourceCursor = 0;
    for (const [index, edit] of edits.entries()) {
        if (!Number.isSafeInteger(edit.pos) || edit.pos < sourceCursor || edit.pos > snapshot.content.length) {
            throw new HistoryOtProtocolError(
                'OUT_OF_ORDER_EDIT',
                `Edit ${index} position must be ordered and between ${sourceCursor} and ${snapshot.content.length}`,
            );
        }
        const deleteLength = editLength(edit.deleteLength, `Edit ${index} deleteLength`);
        const insertText = edit.insertText ?? '';
        if (typeof insertText !== 'string') {
            throw new HistoryOtProtocolError('INVALID_EDIT', `Edit ${index} insertText must be a string`);
        }
        if (edit.pos + deleteLength > snapshot.content.length) {
            throw new HistoryOtProtocolError('INVALID_EDIT', `Edit ${index} deletion extends past the snapshot`);
        }
        assertInsertedText(insertText);
        if (edit.tracking !== undefined) {
            assertTrackingInput(edit.tracking);
        }
        const trackingTimestamp = edit.tracking === undefined
            ? undefined
            : normalizeHistoryOtTimestamp(edit.tracking.ts);

        builder.retain(edit.pos - sourceCursor);
        sourceCursor = edit.pos;
        if (insertText.length > 0) {
            builder.insert(
                insertText,
                edit.tracking === undefined ? undefined : {
                    type: 'insert',
                    userId: edit.tracking.userId,
                    ts: trackingTimestamp as string,
                },
            );
        }
        if (deleteLength > 0) {
            if (edit.tracking === undefined) {
                builder.remove(deleteLength);
            } else {
                builder.retain(deleteLength, {
                    type: 'delete',
                    userId: edit.tracking.userId,
                    ts: trackingTimestamp as string,
                });
            }
            sourceCursor += deleteLength;
        }
    }
    builder.retain(snapshot.content.length - sourceCursor);
    return parseHistoryOtOperations([builder.toRaw()]);
}

function resolveSelectedChanges(
    snapshotInput: HistoryOtSnapshotInput,
    selectedRanges: readonly HistoryOtRange[],
): {snapshotLength: number, changes: HistoryOtTrackedChange[]} {
    const snapshot = getSafeSnapshotRaw(snapshotInput);
    const selectedKeys = new Set<string>();
    const changes: HistoryOtTrackedChange[] = [];
    for (const [index, selected] of selectedRanges.entries()) {
        if (!Number.isSafeInteger(selected.pos) || selected.pos < 0
            || !Number.isSafeInteger(selected.length) || selected.length <= 0) {
            throw new HistoryOtProtocolError(
                'INVALID_SELECTION', `Selected tracked range ${index} is invalid`,
            );
        }
        const key = `${selected.pos}:${selected.length}`;
        if (selectedKeys.has(key)) {
            throw new HistoryOtProtocolError(
                'DUPLICATE_SELECTION', `Selected tracked range ${index} is duplicated`,
            );
        }
        selectedKeys.add(key);
        const match = snapshot.trackedChanges?.find(change =>
            change.range.pos === selected.pos && change.range.length === selected.length);
        if (match === undefined) {
            throw new HistoryOtProtocolError(
                'UNKNOWN_TRACKED_RANGE',
                `Selected range ${key} does not exactly identify a tracked change`,
            );
        }
        changes.push(match);
    }
    changes.sort((left, right) => left.range.pos - right.range.pos);
    return {snapshotLength: snapshot.content.length, changes};
}

function buildTrackedDecision(
    snapshotInput: HistoryOtSnapshotInput,
    selectedRanges: readonly HistoryOtRange[],
    decision: 'accept' | 'reject',
): ParsedHistoryOtOperations {
    const {snapshotLength, changes} = resolveSelectedChanges(snapshotInput, selectedRanges);
    const builder = new TextOperationAccumulator();
    let cursor = 0;
    for (const change of changes) {
        builder.retain(change.range.pos - cursor);
        const physicallyRemove = decision === 'accept'
            ? change.tracking.type === 'delete'
            : change.tracking.type === 'insert';
        if (physicallyRemove) {
            builder.remove(change.range.length);
        } else {
            builder.retain(change.range.length, {type: 'none'});
        }
        cursor = change.range.pos + change.range.length;
    }
    builder.retain(snapshotLength - cursor);
    return parseHistoryOtOperations([builder.toRaw()]);
}

export function buildAcceptTrackedChangesOperation(
    snapshotInput: HistoryOtSnapshotInput,
    selectedRanges: readonly HistoryOtRange[],
): ParsedHistoryOtOperations {
    return buildTrackedDecision(snapshotInput, selectedRanges, 'accept');
}

export function buildRejectTrackedChangesOperation(
    snapshotInput: HistoryOtSnapshotInput,
    selectedRanges: readonly HistoryOtRange[],
): ParsedHistoryOtOperations {
    return buildTrackedDecision(snapshotInput, selectedRanges, 'reject');
}
