import {
    HistoryOtOperationArray,
    HistoryOtOperation,
    HistoryOtOperationsInput,
    HistoryOtRange,
    HistoryOtSnapshotInput,
    JsonObject,
    JsonValue,
    ParsedHistoryOtOperations,
    ParsedHistoryOtSnapshot,
    ParsedHistoryOtWireOperation,
    StringFileDataSnapshot,
    HistoryOtWireOperationArray,
    HistoryOtWireOperationInput,
} from './types';

export const HISTORY_OT_MAX_STRING_LENGTH = 2 * 1024 * 1024;

const parsedSnapshots = new WeakSet<object>();
const parsedOperations = new WeakSet<object>();
const parsedWireOperations = new WeakSet<object>();

export class HistoryOtProtocolError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly unsafeReasons: readonly string[] = [],
    ) {
        super(message);
        this.name = 'HistoryOtProtocolError';
    }
}

function cloneJson(value: unknown, path: string, ancestors: Set<object>): JsonValue {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new HistoryOtProtocolError('NOT_JSON', `${path} contains a non-finite number`);
        }
        return value;
    }
    if (typeof value !== 'object') {
        throw new HistoryOtProtocolError('NOT_JSON', `${path} is not JSON-compatible`);
    }
    if (ancestors.has(value)) {
        throw new HistoryOtProtocolError('NOT_JSON', `${path} contains a cycle`);
    }
    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            return value.map((item, index) => cloneJson(item, `${path}[${index}]`, ancestors));
        }
        const prototype = Object.getPrototypeOf(value) as unknown;
        if (prototype !== Object.prototype && prototype !== null) {
            throw new HistoryOtProtocolError('NOT_JSON', `${path} is not a plain JSON object`);
        }
        const result: JsonObject = {};
        for (const [key, child] of Object.entries(value)) {
            if (child === undefined) {
                throw new HistoryOtProtocolError(
                    'NOT_JSON', `${path}.${key} is undefined and cannot round-trip through JSON`,
                );
            }
            Object.defineProperty(result, key, {
                value: cloneJson(child, `${path}.${key}`, ancestors),
                enumerable: true,
                configurable: true,
                writable: true,
            });
        }
        return result;
    } finally {
        ancestors.delete(value);
    }
}

export function deepCloneJson(value: unknown): JsonValue {
    return cloneJson(value, '$', new Set());
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function hasOwn(value: JsonObject, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function isNonNegativeInteger(value: JsonValue | undefined): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

const ISO_8601_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

/** Accept an ISO-8601 date-time only when it identifies an unambiguous instant. */
export function isValidHistoryOtTimestamp(value: unknown): value is string {
    if (typeof value !== 'string') {
        return false;
    }
    const match = ISO_8601_INSTANT.exec(value);
    if (match === null || !Number.isFinite(Date.parse(value))) {
        return false;
    }
    const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw] = match;
    const [year, month, day, hour, minute, second] = [
        yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw,
    ].map(component => Number(component));
    if (hour > 23 || minute > 59 || second > 59) {
        return false;
    }
    const calendar = new Date(0);
    calendar.setUTCFullYear(year, month - 1, day);
    calendar.setUTCHours(hour, minute, second, 0);
    return calendar.getUTCFullYear() === year
        && calendar.getUTCMonth() === month - 1
        && calendar.getUTCDate() === day
        && calendar.getUTCHours() === hour
        && calendar.getUTCMinutes() === minute
        && calendar.getUTCSeconds() === second;
}

export function normalizeHistoryOtTimestamp(value: string): string {
    if (!isValidHistoryOtTimestamp(value)) {
        throw new HistoryOtProtocolError(
            'INVALID_TRACKING', 'Tracked edits require a valid ISO-8601 timestamp with a timezone',
        );
    }
    return new Date(value).toISOString();
}

function validateRange(
    value: JsonValue | undefined,
    path: string,
    reasons: string[],
    maximum?: number,
    allowEmpty = false,
): value is HistoryOtRange {
    if (!isJsonObject(value)) {
        reasons.push(`${path} must be an object`);
        return false;
    }
    for (const key of unknownKeys(value, ['pos', 'length'])) {
        reasons.push(`${path}.${key} is an unknown range key`);
    }
    const pos = value.pos;
    const length = value.length;
    let valid = true;
    if (!isNonNegativeInteger(pos)) {
        reasons.push(`${path}.pos must be a non-negative safe integer`);
        valid = false;
    }
    if (!isNonNegativeInteger(length) || (!allowEmpty && length === 0)) {
        reasons.push(`${path}.length must be a ${allowEmpty ? 'non-negative' : 'positive'} safe integer`);
        valid = false;
    }
    if (valid) {
        const end = (pos as number) + (length as number);
        if (!Number.isSafeInteger(end)) {
            reasons.push(`${path} endpoint must be a safe integer`);
            valid = false;
        } else if (maximum !== undefined && end > maximum) {
            reasons.push(`${path} extends past the snapshot content`);
            valid = false;
        }
    }
    return valid;
}

function validateCanonicalRanges(
    ranges: JsonValue | undefined,
    path: string,
    reasons: string[],
    maximum?: number,
): ranges is HistoryOtRange[] {
    if (!Array.isArray(ranges)) {
        reasons.push(`${path} must be an array`);
        return false;
    }
    let previousEnd = -1;
    let valid = true;
    for (let index = 0; index < ranges.length; index += 1) {
        const range = ranges[index];
        if (!validateRange(range, `${path}[${index}]`, reasons, maximum)) {
            valid = false;
            continue;
        }
        if (range.pos <= previousEnd) {
            reasons.push(
                `${path}[${index}] overlaps, precedes, or touches the previous range; `
                + 'this adapter requires upstream-canonical pre-merged comment ranges',
            );
            valid = false;
        }
        previousEnd = range.pos + range.length;
    }
    return valid;
}

function validateTracking(
    value: JsonValue | undefined,
    path: string,
    reasons: string[],
    allowClear: boolean,
): boolean {
    if (!isJsonObject(value)) {
        reasons.push(`${path} must be an object`);
        return false;
    }
    if (value.type === 'none') {
        for (const key of unknownKeys(value, ['type'])) {
            reasons.push(`${path}.${key} is an unknown clear-tracking key`);
        }
        if (!allowClear) {
            reasons.push(`${path}.type cannot be none here`);
            return false;
        }
        return true;
    }
    for (const key of unknownKeys(value, ['type', 'userId', 'ts'])) {
        reasons.push(`${path}.${key} is an unknown tracking key`);
    }
    let valid = true;
    if (value.type !== 'insert' && value.type !== 'delete') {
        reasons.push(`${path}.type must be insert or delete${allowClear ? ', or none' : ''}`);
        valid = false;
    }
    if (typeof value.userId !== 'string' || value.userId.length === 0) {
        reasons.push(`${path}.userId must be a non-empty string`);
        valid = false;
    }
    if (!isValidHistoryOtTimestamp(value.ts)) {
        reasons.push(`${path}.ts must be a valid ISO-8601 timestamp string with a timezone`);
        valid = false;
    }
    return valid;
}

function validateSnapshotRaw(raw: JsonValue): string[] {
    const reasons: string[] = [];
    if (!isJsonObject(raw)) {
        return ['$ must be a StringFileData object'];
    }
    for (const key of unknownKeys(raw, ['content', 'comments', 'trackedChanges'])) {
        reasons.push(`$.${key} is an unknown StringFileData key`);
    }
    if (typeof raw.content !== 'string') {
        reasons.push('$.content must be a string');
        return reasons;
    }
    const contentLength = raw.content.length;
    if (contentLength > HISTORY_OT_MAX_STRING_LENGTH) {
        reasons.push(`$.content exceeds ${HISTORY_OT_MAX_STRING_LENGTH} UTF-16 code units`);
    }

    if (hasOwn(raw, 'comments')) {
        if (!Array.isArray(raw.comments)) {
            reasons.push('$.comments must be an array when present');
        } else {
            const ids = new Set<string>();
            raw.comments.forEach((comment, index) => {
                const path = `$.comments[${index}]`;
                if (!isJsonObject(comment)) {
                    reasons.push(`${path} must be an object`);
                    return;
                }
                for (const key of unknownKeys(comment, ['id', 'ranges', 'resolved'])) {
                    reasons.push(`${path}.${key} is an unknown comment key`);
                }
                if (typeof comment.id !== 'string' || comment.id.length === 0) {
                    reasons.push(`${path}.id must be a non-empty string`);
                } else if (ids.has(comment.id)) {
                    reasons.push(`${path}.id duplicates an earlier comment`);
                } else {
                    ids.add(comment.id);
                }
                validateCanonicalRanges(comment.ranges, `${path}.ranges`, reasons, contentLength);
                if (hasOwn(comment, 'resolved') && typeof comment.resolved !== 'boolean') {
                    reasons.push(`${path}.resolved must be boolean when present`);
                }
            });
        }
    }

    if (hasOwn(raw, 'trackedChanges')) {
        if (!Array.isArray(raw.trackedChanges)) {
            reasons.push('$.trackedChanges must be an array when present');
        } else {
            let previousEnd = -1;
            raw.trackedChanges.forEach((change, index) => {
                const path = `$.trackedChanges[${index}]`;
                if (!isJsonObject(change)) {
                    reasons.push(`${path} must be an object`);
                    return;
                }
                for (const key of unknownKeys(change, ['range', 'tracking'])) {
                    reasons.push(`${path}.${key} is an unknown tracked-change key`);
                }
                if (validateRange(change.range, `${path}.range`, reasons, contentLength)) {
                    if (change.range.pos < previousEnd) {
                        reasons.push(`${path}.range overlaps or precedes the previous tracked change`);
                    }
                    previousEnd = change.range.pos + change.range.length;
                }
                validateTracking(change.tracking, `${path}.tracking`, reasons, false);
            });
        }
    }
    return reasons;
}

function unknownKeys(value: JsonObject, allowed: readonly string[]): string[] {
    const allowedKeys = new Set(allowed);
    return Object.keys(value).filter(key => !allowedKeys.has(key));
}

function validateCommentIds(value: JsonValue | undefined, path: string, reasons: string[]): void {
    if (!Array.isArray(value)) {
        reasons.push(`${path} must be an array of strings`);
        return;
    }
    const ids = new Set<string>();
    value.forEach((id, index) => {
        if (typeof id !== 'string' || id.length === 0) {
            reasons.push(`${path}[${index}] must be a non-empty string`);
        } else if (ids.has(id)) {
            reasons.push(`${path}[${index}] duplicates an earlier comment id`);
        } else {
            ids.add(id);
        }
    });
}

export function containsUnsupportedHistoryOtInsertion(value: string): boolean {
    return /[\uD800-\uDBFF]/.test(value);
}

function validateScanOperation(value: JsonValue, path: string, reasons: string[]): void {
    if (typeof value === 'number') {
        if (!Number.isSafeInteger(value) || value === 0) {
            reasons.push(`${path} numeric scan length must be a non-zero safe integer`);
        }
        return;
    }
    if (typeof value === 'string') {
        if (value.length === 0) {
            reasons.push(`${path} cannot insert an empty string`);
        }
        if (containsUnsupportedHistoryOtInsertion(value)) {
            reasons.push(`${path} insertion contains a non-BMP character`);
        }
        return;
    }
    if (!isJsonObject(value)) {
        reasons.push(`${path} is not a supported scan operation`);
        return;
    }
    const hasInsert = hasOwn(value, 'i');
    const hasRetain = hasOwn(value, 'r');
    if (hasInsert === hasRetain) {
        reasons.push(`${path} must contain exactly one of i or r`);
        return;
    }
    if (hasInsert) {
        for (const key of unknownKeys(value, ['i', 'tracking', 'commentIds'])) {
            reasons.push(`${path}.${key} is an unknown insert scan-operation key`);
        }
        if (typeof value.i !== 'string' || value.i.length === 0) {
            reasons.push(`${path}.i must be a non-empty string`);
        } else if (containsUnsupportedHistoryOtInsertion(value.i)) {
            reasons.push(`${path}.i contains a non-BMP character`);
        }
        if (hasOwn(value, 'tracking')) {
            validateTracking(value.tracking, `${path}.tracking`, reasons, false);
        }
        if (hasOwn(value, 'commentIds')) {
            validateCommentIds(value.commentIds, `${path}.commentIds`, reasons);
        }
        return;
    }
    for (const key of unknownKeys(value, ['r', 'tracking'])) {
        reasons.push(`${path}.${key} is an unknown retain scan-operation key`);
    }
    if (typeof value.r !== 'number' || !Number.isSafeInteger(value.r) || value.r <= 0) {
        reasons.push(`${path}.r must be a positive safe integer`);
    }
    if (hasOwn(value, 'tracking')) {
        validateTracking(value.tracking, `${path}.tracking`, reasons, true);
    }
}

function scanLengths(value: JsonValue): {base: number, target: number} | undefined {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value !== 0) {
        return value > 0
            ? {base: value, target: value}
            : {base: -value, target: 0};
    }
    if (typeof value === 'string' && value.length > 0) {
        return {base: 0, target: value.length};
    }
    if (!isJsonObject(value)) {
        return undefined;
    }
    if (typeof value.i === 'string' && value.i.length > 0) {
        return {base: 0, target: value.i.length};
    }
    if (typeof value.r === 'number' && Number.isSafeInteger(value.r) && value.r > 0) {
        return {base: value.r, target: value.r};
    }
    return undefined;
}

function validateTextOperationLengths(
    scans: JsonValue[],
    path: string,
    reasons: string[],
): void {
    let baseLength = 0;
    let targetLength = 0;
    let overflow = false;
    for (const scan of scans) {
        const lengths = scanLengths(scan);
        if (lengths === undefined) {
            continue;
        }
        baseLength += lengths.base;
        targetLength += lengths.target;
        if (!Number.isSafeInteger(baseLength) || !Number.isSafeInteger(targetLength)) {
            overflow = true;
        }
    }
    if (overflow) {
        reasons.push(`${path} cumulative lengths must remain safe integers`);
    }
    if (baseLength > HISTORY_OT_MAX_STRING_LENGTH) {
        reasons.push(`${path} base length exceeds ${HISTORY_OT_MAX_STRING_LENGTH} UTF-16 code units`);
    }
    if (targetLength > HISTORY_OT_MAX_STRING_LENGTH) {
        reasons.push(`${path} target length exceeds ${HISTORY_OT_MAX_STRING_LENGTH} UTF-16 code units`);
    }
}

function validateOperation(value: JsonValue, path: string, reasons: string[]): void {
    if (!isJsonObject(value)) {
        reasons.push(`${path} must be an operation object`);
        return;
    }
    const candidates = [
        hasOwn(value, 'textOperation'),
        hasOwn(value, 'ranges') || (hasOwn(value, 'commentId') && !hasOwn(value, 'resolved')),
        hasOwn(value, 'deleteComment'),
        hasOwn(value, 'commentId') && hasOwn(value, 'resolved') && !hasOwn(value, 'ranges'),
        hasOwn(value, 'noOp'),
    ].filter(Boolean).length;
    if (candidates !== 1) {
        reasons.push(`${path} has an unknown, incomplete, or ambiguous operation kind`);
        return;
    }

    if (hasOwn(value, 'textOperation')) {
        for (const key of unknownKeys(value, ['textOperation', 'contentHash'])) {
            reasons.push(`${path}.${key} is unsupported operation metadata`);
        }
        if (!Array.isArray(value.textOperation)) {
            reasons.push(`${path}.textOperation must be an array`);
        } else {
            value.textOperation.forEach((scan, index) =>
                validateScanOperation(scan, `${path}.textOperation[${index}]`, reasons));
            validateTextOperationLengths(value.textOperation, `${path}.textOperation`, reasons);
        }
        if (hasOwn(value, 'contentHash') && typeof value.contentHash !== 'string') {
            reasons.push(`${path}.contentHash must be a string when present`);
        }
        return;
    }

    if (hasOwn(value, 'ranges')) {
        for (const key of unknownKeys(value, ['commentId', 'ranges', 'resolved'])) {
            reasons.push(`${path}.${key} is unsupported operation metadata`);
        }
        if (typeof value.commentId !== 'string' || value.commentId.length === 0) {
            reasons.push(`${path}.commentId must be a non-empty string`);
        }
        validateCanonicalRanges(
            value.ranges, `${path}.ranges`, reasons, HISTORY_OT_MAX_STRING_LENGTH,
        );
        if (hasOwn(value, 'resolved') && typeof value.resolved !== 'boolean') {
            reasons.push(`${path}.resolved must be boolean when present`);
        }
        return;
    }

    if (hasOwn(value, 'deleteComment')) {
        for (const key of unknownKeys(value, ['deleteComment'])) {
            reasons.push(`${path}.${key} is unsupported operation metadata`);
        }
        if (typeof value.deleteComment !== 'string' || value.deleteComment.length === 0) {
            reasons.push(`${path}.deleteComment must be a non-empty string`);
        }
        return;
    }

    if (hasOwn(value, 'commentId')) {
        for (const key of unknownKeys(value, ['commentId', 'resolved'])) {
            reasons.push(`${path}.${key} is unsupported operation metadata`);
        }
        if (typeof value.commentId !== 'string' || value.commentId.length === 0) {
            reasons.push(`${path}.commentId must be a non-empty string`);
        }
        if (typeof value.resolved !== 'boolean') {
            reasons.push(`${path}.resolved must be boolean`);
        }
        return;
    }

    for (const key of unknownKeys(value, ['noOp'])) {
        reasons.push(`${path}.${key} is unsupported operation metadata`);
    }
    if (value.noOp !== true) {
        reasons.push(`${path}.noOp must be true`);
    }
}

function validateOperationsRaw(raw: JsonValue): string[] {
    if (!Array.isArray(raw)) {
        return ['$ must be an operation array'];
    }
    const reasons: string[] = [];
    raw.forEach((operation, index) => validateOperation(operation, `$[${index}]`, reasons));
    return reasons;
}

function validateWireOperationRaw(raw: JsonValue): string[] {
    const reasons = validateOperationsRaw(raw);
    if (Array.isArray(raw) && raw.length !== 1) {
        reasons.unshift('$ realtime update.op must contain exactly one logical operation');
    }
    return reasons;
}

export function parseHistoryOtSnapshot(input: unknown): ParsedHistoryOtSnapshot {
    const raw = deepCloneJson(input);
    const unsafeReasons = validateSnapshotRaw(raw);
    const parsed: ParsedHistoryOtSnapshot = {
        kind: 'history-ot-snapshot',
        raw,
        safe: unsafeReasons.length === 0,
        unsafeReasons,
    };
    parsedSnapshots.add(parsed);
    return parsed;
}

export function parseHistoryOtOperations(input: unknown): ParsedHistoryOtOperations {
    const raw = deepCloneJson(input);
    const unsafeReasons = validateOperationsRaw(raw);
    const parsed: ParsedHistoryOtOperations = {
        kind: 'history-ot-operations',
        raw,
        safe: unsafeReasons.length === 0,
        unsafeReasons,
    };
    parsedOperations.add(parsed);
    return parsed;
}

/** Parse an exact-one realtime `update.op` envelope without losing unsafe input. */
export function parseHistoryOtWireOperation(input: unknown): ParsedHistoryOtWireOperation {
    const raw = deepCloneJson(input);
    const unsafeReasons = validateWireOperationRaw(raw);
    const parsed: ParsedHistoryOtWireOperation = {
        kind: 'history-ot-wire-operation',
        raw,
        safe: unsafeReasons.length === 0,
        unsafeReasons,
    };
    parsedWireOperations.add(parsed);
    return parsed;
}

function isParsedSnapshot(input: HistoryOtSnapshotInput): input is ParsedHistoryOtSnapshot {
    return typeof input === 'object' && input !== null && parsedSnapshots.has(input);
}

function isParsedOperations(input: HistoryOtOperationsInput): input is ParsedHistoryOtOperations {
    return typeof input === 'object' && input !== null && parsedOperations.has(input);
}

function isParsedWireOperation(
    input: HistoryOtWireOperationInput,
): input is ParsedHistoryOtWireOperation {
    return typeof input === 'object' && input !== null && parsedWireOperations.has(input);
}

export function serializeHistoryOtSnapshot(input: HistoryOtSnapshotInput): JsonValue {
    return deepCloneJson(isParsedSnapshot(input) ? input.raw : input);
}

export function serializeHistoryOtOperations(input: HistoryOtOperationsInput): JsonValue {
    return deepCloneJson(isParsedOperations(input) ? input.raw : input);
}

export function serializeHistoryOtWireOperation(input: HistoryOtWireOperationInput): JsonValue {
    return deepCloneJson(isParsedWireOperation(input) ? input.raw : input);
}

export function assertHistoryOtSnapshotSafe(
    input: HistoryOtSnapshotInput,
): asserts input is ParsedHistoryOtSnapshot | StringFileDataSnapshot {
    const parsed = isParsedSnapshot(input) ? parseHistoryOtSnapshot(input.raw) : parseHistoryOtSnapshot(input);
    if (!parsed.safe) {
        throw new HistoryOtProtocolError(
            'UNSAFE_SNAPSHOT',
            `Unsafe History-OT snapshot: ${parsed.unsafeReasons.join('; ')}`,
            parsed.unsafeReasons,
        );
    }
}

export function assertHistoryOtOperationsSafe(
    input: HistoryOtOperationsInput,
): asserts input is ParsedHistoryOtOperations | HistoryOtOperationArray {
    const parsed = isParsedOperations(input) ? parseHistoryOtOperations(input.raw) : parseHistoryOtOperations(input);
    if (!parsed.safe) {
        throw new HistoryOtProtocolError(
            'UNSAFE_OPERATIONS',
            `Unsafe History-OT operations: ${parsed.unsafeReasons.join('; ')}`,
            parsed.unsafeReasons,
        );
    }
}

export function assertHistoryOtWireOperationSafe(
    input: HistoryOtWireOperationInput,
): asserts input is ParsedHistoryOtWireOperation | HistoryOtWireOperationArray {
    const parsed = isParsedWireOperation(input)
        ? parseHistoryOtWireOperation(input.raw)
        : parseHistoryOtWireOperation(input);
    if (!parsed.safe) {
        throw new HistoryOtProtocolError(
            'UNSAFE_WIRE_OPERATION',
            `Unsafe realtime History-OT update.op: ${parsed.unsafeReasons.join('; ')}`,
            parsed.unsafeReasons,
        );
    }
}

export function getSafeSnapshotRaw(input: HistoryOtSnapshotInput): StringFileDataSnapshot {
    const parsed = isParsedSnapshot(input) ? parseHistoryOtSnapshot(input.raw) : parseHistoryOtSnapshot(input);
    assertHistoryOtSnapshotSafe(parsed);
    return deepCloneJson(parsed.raw) as StringFileDataSnapshot;
}

export function getSafeOperationsRaw(input: HistoryOtOperationsInput): HistoryOtOperationArray {
    const parsed = isParsedOperations(input) ? parseHistoryOtOperations(input.raw) : parseHistoryOtOperations(input);
    assertHistoryOtOperationsSafe(parsed);
    return deepCloneJson(parsed.raw) as HistoryOtOperationArray;
}

/** Return the single logical operation only after the realtime exact-one gate passes. */
export function getSafeHistoryOtWireOperation(
    input: HistoryOtWireOperationInput,
): HistoryOtOperation {
    const parsed = isParsedWireOperation(input)
        ? parseHistoryOtWireOperation(input.raw)
        : parseHistoryOtWireOperation(input);
    assertHistoryOtWireOperationSafe(parsed);
    return deepCloneJson((parsed.raw as HistoryOtWireOperationArray)[0]) as HistoryOtOperation;
}

/** Explicitly named aliases for the offline/local sequence API. */
export const parseHistoryOtOperationSequence = parseHistoryOtOperations;
export const serializeHistoryOtOperationSequence = serializeHistoryOtOperations;
export const assertHistoryOtOperationSequenceSafe = assertHistoryOtOperationsSafe;
