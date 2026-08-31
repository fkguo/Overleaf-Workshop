export type JsonPrimitive = null | boolean | number | string;

export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

export interface JsonObject {
    [key: string]: JsonValue | undefined,
}

/** A half-open UTF-16 code-unit range [pos, pos + length). */
export interface HistoryOtRange extends JsonObject {
    pos: number,
    length: number,
}

export interface HistoryOtTracking extends JsonObject {
    type: 'insert' | 'delete',
    userId: string,
    ts: string,
}

export interface HistoryOtClearTracking extends JsonObject {
    type: 'none',
}

export type HistoryOtTrackingDirective = HistoryOtTracking | HistoryOtClearTracking;

export interface HistoryOtComment extends JsonObject {
    id: string,
    /** Adapter-safe input must already use upstream-canonical, non-touching ranges. */
    ranges: HistoryOtRange[],
    resolved?: boolean,
}

export interface HistoryOtTrackedChange extends JsonObject {
    range: HistoryOtRange,
    tracking: HistoryOtTracking,
}

export interface StringFileDataSnapshot extends JsonObject {
    content: string,
    comments?: HistoryOtComment[],
    trackedChanges?: HistoryOtTrackedChange[],
}

export interface HistoryOtInsertScanOperation extends JsonObject {
    i: string,
    tracking?: HistoryOtTracking,
    commentIds?: string[],
}

export interface HistoryOtRetainScanOperation extends JsonObject {
    r: number,
    tracking?: HistoryOtTrackingDirective,
}

/**
 * Positive numbers retain, negative numbers remove, and strings insert.
 * Object forms carry History-OT range metadata.
 */
export type HistoryOtScanOperation =
    | number
    | string
    | HistoryOtInsertScanOperation
    | HistoryOtRetainScanOperation;

export interface HistoryOtTextOperation extends JsonObject {
    textOperation: HistoryOtScanOperation[],
    contentHash?: string,
}

export interface HistoryOtAddCommentOperation extends JsonObject {
    commentId: string,
    ranges: HistoryOtRange[],
    resolved?: boolean,
}

export interface HistoryOtDeleteCommentOperation extends JsonObject {
    deleteComment: string,
}

export interface HistoryOtSetCommentStateOperation extends JsonObject {
    commentId: string,
    resolved: boolean,
}

export interface HistoryOtNoOperation extends JsonObject {
    noOp: true,
}

export type HistoryOtOperation =
    | HistoryOtTextOperation
    | HistoryOtAddCommentOperation
    | HistoryOtDeleteCommentOperation
    | HistoryOtSetCommentStateOperation
    | HistoryOtNoOperation;

/** An ordered offline/local sequence. Never pass this directly as realtime `update.op`. */
export type HistoryOtOperationSequence = HistoryOtOperation[];

/** @deprecated Use HistoryOtOperationSequence for offline/local sequencing. */
export type HistoryOtOperationArray = HistoryOtOperationSequence;

/** The realtime `update.op` envelope contains exactly one logical operation. */
export type HistoryOtWireOperationArray = [HistoryOtOperation];

export interface ParsedHistoryOtSnapshot {
    readonly kind: 'history-ot-snapshot',
    readonly raw: JsonValue,
    readonly safe: boolean,
    readonly unsafeReasons: readonly string[],
}

export interface ParsedHistoryOtOperations {
    readonly kind: 'history-ot-operations',
    readonly raw: JsonValue,
    readonly safe: boolean,
    readonly unsafeReasons: readonly string[],
}

export interface ParsedHistoryOtWireOperation {
    readonly kind: 'history-ot-wire-operation',
    readonly raw: JsonValue,
    readonly safe: boolean,
    readonly unsafeReasons: readonly string[],
}

export type HistoryOtSnapshotInput = ParsedHistoryOtSnapshot | JsonValue;
/** Offline/local operation-sequence input; not a realtime wire envelope. */
export type HistoryOtOperationsInput = ParsedHistoryOtOperations | JsonValue;
export type HistoryOtWireOperationInput = ParsedHistoryOtWireOperation | JsonValue;

export interface HistoryOtTrackingInput {
    userId: string,
    /** An ISO-8601 instant with a timezone. Generated operations normalize it to UTC. */
    ts: string,
}

export interface HistoryOtTextEdit {
    /** Source-snapshot offset in UTF-16 code units. */
    pos: number,
    deleteLength?: number,
    insertText?: string,
    /** Omit for a plain edit; provide for a tracked insert/delete. */
    tracking?: HistoryOtTrackingInput,
}

export type HistoryOtOffsetAffinity = 'left' | 'right';
