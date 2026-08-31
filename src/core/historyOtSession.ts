/* eslint-disable @typescript-eslint/naming-convention */
import {
    applyHistoryOtOperations,
    buildAcceptTrackedChangesOperation,
    buildRejectTrackedChangesOperation,
    HistoryOtOperation,
    HistoryOtRange,
    JsonObject,
    JsonValue,
    ParsedHistoryOtSnapshot,
    ParsedHistoryOtWireOperation,
    parseHistoryOtOperations,
    parseHistoryOtSnapshot,
    parseHistoryOtWireOperation,
    serializeHistoryOtOperations,
    serializeHistoryOtSnapshot,
    serializeHistoryOtWireOperation,
    StringFileDataSnapshot,
} from './historyOt';
import {deepCloneJson, hasOwn, isJsonObject} from './historyOt/protocol';

export type HistoryOtRealtimeEnvelopeClassification =
    | 'sender-ack'
    | 'collaborator-update'
    | 'unknown';

export interface ParsedHistoryOtRealtimeEnvelope {
    readonly kind: 'history-ot-realtime-envelope',
    readonly raw: JsonValue,
    readonly classification: HistoryOtRealtimeEnvelopeClassification,
    readonly safe: boolean,
    readonly unsafeReasons: readonly string[],
    readonly doc?: string,
    readonly version?: number,
    readonly operation?: ParsedHistoryOtWireOperation,
    readonly meta?: JsonObject,
    readonly source?: JsonValue,
    readonly user?: JsonValue,
    readonly time?: JsonValue,
    readonly trackChangesSeed?: JsonValue,
    readonly dupIfSource: readonly string[],
    readonly duplicate: boolean,
    readonly lastVersion?: number,
    readonly hash?: string,
}

export interface ParsedHistoryOtJoinState {
    readonly kind: 'history-ot-join-state',
    readonly raw: JsonValue,
    readonly safe: boolean,
    readonly unsafeReasons: readonly string[],
    readonly version?: number,
    readonly snapshot?: ParsedHistoryOtSnapshot,
}

export class HistoryOtSessionError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly reasons: readonly string[] = [],
    ) {
        super(message);
        this.name = 'HistoryOtSessionError';
    }
}

function unknownKeys(value: JsonObject, allowed: readonly string[]): string[] {
    const allowedKeys = new Set(allowed);
    return Object.keys(value).filter(key => !allowedKeys.has(key));
}

function isVersion(value: JsonValue | undefined): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function cloneObject(value: JsonObject): JsonObject {
    return deepCloneJson(value) as JsonObject;
}

/** Parse an inbound/outbound realtime envelope without normalizing or dropping raw JSON. */
export function parseHistoryOtRealtimeEnvelope(input: unknown): ParsedHistoryOtRealtimeEnvelope {
    const raw = deepCloneJson(input);
    const reasons: string[] = [];
    let classification: HistoryOtRealtimeEnvelopeClassification = 'unknown';
    let doc: string | undefined;
    let version: number | undefined;
    let operation: ParsedHistoryOtWireOperation | undefined;
    let meta: JsonObject | undefined;
    let source: JsonValue | undefined;
    let user: JsonValue | undefined;
    let time: JsonValue | undefined;
    let trackChangesSeed: JsonValue | undefined;
    let dupIfSource: string[] = [];
    let duplicate = false;
    let lastVersion: number | undefined;
    let hash: string | undefined;

    if (!isJsonObject(raw)) {
        reasons.push('$ must be a realtime update object');
    } else {
        const hasOperation = hasOwn(raw, 'op');
        classification = hasOperation ? 'collaborator-update' : 'sender-ack';
        for (const key of unknownKeys(
            raw,
            ['doc', 'v', 'op', 'meta', 'dupIfSource', 'dup', 'lastV', 'hash'],
        )) {
            reasons.push(`$.${key} is an unknown realtime update key`);
        }
        if (typeof raw.doc !== 'string' || raw.doc.length === 0) {
            reasons.push('$.doc must be a non-empty string');
        } else {
            doc = raw.doc;
        }
        if (!isVersion(raw.v)) {
            reasons.push('$.v must be a non-negative safe integer');
        } else {
            version = raw.v;
        }
        if (hasOperation) {
            operation = parseHistoryOtWireOperation(raw.op);
            reasons.push(...operation.unsafeReasons.map(reason => `$.op${reason.slice(1)}`));
        }
        if (hasOwn(raw, 'meta')) {
            if (!isJsonObject(raw.meta)) {
                reasons.push('$.meta must be an object when present');
            } else {
                meta = cloneObject(raw.meta);
                for (const key of unknownKeys(raw.meta, ['source', 'user_id', 'ts', 'tc'])) {
                    reasons.push(`$.meta.${key} is unknown metadata`);
                }
                source = raw.meta.source;
                user = raw.meta.user_id;
                time = raw.meta.ts;
                trackChangesSeed = raw.meta.tc;
            }
        }
        if (classification === 'collaborator-update'
            && (typeof source !== 'string' || source.length === 0)) {
            reasons.push('$.meta.source must be a non-empty string on a full update');
        }
        if (hasOwn(raw, 'dupIfSource')) {
            if (!Array.isArray(raw.dupIfSource)) {
                reasons.push('$.dupIfSource must be an array of public source ids');
            } else {
                const seen = new Set<string>();
                for (const [index, value] of raw.dupIfSource.entries()) {
                    if (typeof value !== 'string' || value.length === 0) {
                        reasons.push(`$.dupIfSource[${index}] must be a non-empty string`);
                    } else if (seen.has(value)) {
                        reasons.push(`$.dupIfSource[${index}] duplicates an earlier source id`);
                    } else {
                        seen.add(value);
                        dupIfSource.push(value);
                    }
                }
            }
        }
        if (hasOwn(raw, 'dup')) {
            if (typeof raw.dup !== 'boolean') {
                reasons.push('$.dup must be boolean when present');
            } else {
                duplicate = raw.dup;
            }
        }
        if (hasOwn(raw, 'lastV')) {
            if (!isVersion(raw.lastV)) {
                reasons.push('$.lastV must be a non-negative safe integer when present');
            } else {
                lastVersion = raw.lastV;
            }
        }
        if (hasOwn(raw, 'hash')) {
            if (typeof raw.hash !== 'string') {
                reasons.push('$.hash must be a string when present');
            } else {
                hash = raw.hash;
            }
        }
        if (classification === 'sender-ack' && Object.keys(raw).some(key => key !== 'doc' && key !== 'v')) {
            reasons.push('$ sender acknowledgement must contain only doc and v');
        }
    }

    return {
        kind: 'history-ot-realtime-envelope',
        raw,
        classification,
        safe: reasons.length === 0,
        unsafeReasons: reasons,
        doc,
        version,
        operation,
        meta,
        source,
        user,
        time,
        trackChangesSeed,
        dupIfSource,
        duplicate,
        lastVersion,
        hash,
    };
}

export function serializeHistoryOtRealtimeEnvelope(
    input: ParsedHistoryOtRealtimeEnvelope | JsonValue,
): JsonValue {
    const parsed = typeof input === 'object' && input !== null && !Array.isArray(input)
        && 'kind' in input && input.kind === 'history-ot-realtime-envelope';
    return deepCloneJson(parsed ? (input as ParsedHistoryOtRealtimeEnvelope).raw : input);
}

export function assertHistoryOtRealtimeEnvelopeSafe(
    input: ParsedHistoryOtRealtimeEnvelope,
): void {
    if (!input.safe) {
        throw new HistoryOtSessionError(
            'UNSAFE_REALTIME_ENVELOPE',
            `Unsafe History OT realtime envelope: ${input.unsafeReasons.join('; ')}`,
            input.unsafeReasons,
        );
    }
}

/** Parse the normalized result of joinDoc(doc, {supportsHistoryOT: true}). */
export function parseHistoryOtJoinState(input: unknown): ParsedHistoryOtJoinState {
    const raw = deepCloneJson(input);
    const reasons: string[] = [];
    let version: number | undefined;
    let snapshot: ParsedHistoryOtSnapshot | undefined;
    if (!isJsonObject(raw)) {
        reasons.push('$ must be a History OT join object');
    } else {
        for (const key of unknownKeys(raw, ['snapshot', 'version', 'operations', 'ranges', 'otType'])) {
            reasons.push(`$.${key} is an unknown join-state key`);
        }
        if (raw.otType !== 'history-ot') {
            reasons.push('$.otType must be history-ot');
        }
        if (!isVersion(raw.version)) {
            reasons.push('$.version must be a non-negative safe integer');
        } else {
            version = raw.version;
        }
        if (!hasOwn(raw, 'snapshot')) {
            reasons.push('$.snapshot is required');
        } else {
            snapshot = parseHistoryOtSnapshot(raw.snapshot);
            reasons.push(...snapshot.unsafeReasons.map(reason => `$.snapshot${reason.slice(1)}`));
        }
        if (!Array.isArray(raw.operations) || raw.operations.length !== 0) {
            reasons.push('$.operations must be an empty array for an authoritative full join');
        }
        if (!isJsonObject(raw.ranges) || Object.keys(raw.ranges).length !== 0) {
            reasons.push('$.ranges must be an empty object for History OT snapshot authority');
        }
    }
    return {
        kind: 'history-ot-join-state',
        raw,
        safe: reasons.length === 0,
        unsafeReasons: reasons,
        version,
        snapshot,
    };
}

export function serializeHistoryOtJoinState(input: ParsedHistoryOtJoinState | JsonValue): JsonValue {
    const parsed = typeof input === 'object' && input !== null && !Array.isArray(input)
        && 'kind' in input && input.kind === 'history-ot-join-state';
    return deepCloneJson(parsed ? (input as ParsedHistoryOtJoinState).raw : input);
}

export type HistoryOtPermissionLevel = 'owner' | 'readAndWrite' | 'review' | 'readOnly';

export interface HistoryOtPermissionContext {
    readonly level?: unknown,
    readonly userId?: unknown,
}

export type HistoryOtWriteIntent =
    | {readonly kind: 'plain-write'}
    | {readonly kind: 'tracked-write'}
    | {
        readonly kind: 'tracked-decision',
        readonly decision: 'accept' | 'reject',
        readonly selectedRanges: readonly HistoryOtRange[],
    }
    | {readonly kind: 'comment-write'};

export interface HistoryOtStageRequest {
    readonly operation: unknown,
    readonly meta?: unknown,
    readonly intent: HistoryOtWriteIntent,
    readonly publicId: string,
}

export type HistoryOtSessionPhase =
    | 'joining'
    | 'ready'
    | 'pending'
    | 'recovery-ready'
    | 'rejoin-required';

export interface HistoryOtSessionView {
    readonly docId: string,
    readonly generation: number,
    readonly phase: HistoryOtSessionPhase,
    readonly permission?: HistoryOtPermissionLevel,
    readonly userId?: string,
    readonly version?: number,
    readonly snapshot?: JsonValue,
    readonly hasPendingOperation: boolean,
    readonly pendingBaseVersion?: number,
    readonly pendingQueued: boolean,
    readonly rejoinReason?: string,
}

export type HistoryOtSessionResultKind =
    | 'joined'
    | 'staged'
    | 'queue-accepted'
    | 'recovery-staged'
    | 'sender-commit'
    | 'collaborator-applied'
    | 'duplicate-ignored'
    | 'duplicate-acknowledged'
    | 'late-ack-ignored'
    | 'stale-generation-ignored'
    | 'permission-updated'
    | 'reconnect-started'
    | 'rejoin-required';

export interface HistoryOtSessionResult {
    readonly kind: HistoryOtSessionResultKind,
    readonly applied: boolean,
    readonly requiresRejoin: boolean,
    readonly reason?: string,
    readonly envelope?: JsonValue,
    readonly state: HistoryOtSessionView,
}

interface PendingUpdate {
    originalEnvelope: JsonObject,
    originalOperation: JsonValue,
    baseVersion: number,
    intent: HistoryOtWriteIntent,
    publicIds: string[],
    queued: boolean,
    recoveryJoinVersion?: number,
}

function normalizePermission(context: HistoryOtPermissionContext): {
    level?: HistoryOtPermissionLevel,
    userId?: string,
} {
    const level = context.level;
    const known = level === 'owner' || level === 'readAndWrite'
        || level === 'review' || level === 'readOnly';
    return {
        level: known ? level : undefined,
        userId: typeof context.userId === 'string' && context.userId.length > 0
            ? context.userId
            : undefined,
    };
}

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
    if (left === right) {
        return true;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left) && Array.isArray(right)
            && left.length === right.length
            && left.every((value, index) => jsonEqual(value, right[index]));
    }
    if (isJsonObject(left) && isJsonObject(right)) {
        const leftKeys = Object.keys(left).sort();
        const rightKeys = Object.keys(right).sort();
        return leftKeys.length === rightKeys.length
            && leftKeys.every((key, index) => key === rightKeys[index]
                && jsonEqual(left[key] as JsonValue, right[key] as JsonValue));
    }
    return false;
}

function hasTrackingDirective(operation: HistoryOtOperation): boolean {
    if (!hasOwn(operation, 'textOperation') || !Array.isArray(operation.textOperation)) {
        return false;
    }
    return operation.textOperation.some(scan => isJsonObject(scan) && hasOwn(scan, 'tracking'));
}

function validateTrackedWrite(operation: HistoryOtOperation, userId: string | undefined): string[] {
    const reasons: string[] = [];
    if (!hasOwn(operation, 'textOperation') || !Array.isArray(operation.textOperation)) {
        return ['tracked-write intent requires a text operation'];
    }
    let mutation = false;
    for (const [index, scan] of operation.textOperation.entries()) {
        if (typeof scan === 'string' || (typeof scan === 'number' && scan < 0)) {
            reasons.push(`textOperation[${index}] is an untracked mutation`);
            continue;
        }
        if (!isJsonObject(scan) || !hasOwn(scan, 'tracking')) {
            continue;
        }
        const tracking = scan.tracking;
        if (!isJsonObject(tracking) || (tracking.type !== 'insert' && tracking.type !== 'delete')) {
            reasons.push(`textOperation[${index}] is not a tracked insert/delete`);
            continue;
        }
        mutation = true;
        if (userId === undefined || tracking.userId !== userId) {
            reasons.push(`textOperation[${index}] tracking author is not the proven session user`);
        }
        if (hasOwn(scan, 'i') && tracking.type !== 'insert') {
            reasons.push(`textOperation[${index}] insertion must use insert tracking`);
        }
        if (hasOwn(scan, 'r') && tracking.type !== 'delete') {
            reasons.push(`textOperation[${index}] retained deletion must use delete tracking`);
        }
    }
    if (!mutation) {
        reasons.push('tracked-write intent contains no tracked mutation');
    }
    return reasons;
}

function hasNonEmptyTrackChangesSeed(meta: JsonObject): boolean {
    return typeof meta.tc === 'string' && meta.tc.length > 0;
}

function selectedChangesBelongTo(
    snapshot: StringFileDataSnapshot,
    ranges: readonly HistoryOtRange[],
    userId: string,
): boolean {
    return ranges.every(range => snapshot.trackedChanges?.some(change =>
        change.range.pos === range.pos
        && change.range.length === range.length
        && change.tracking.userId === userId,
    ) === true);
}

function isCommentOperation(operation: HistoryOtOperation): boolean {
    return hasOwn(operation, 'ranges') || hasOwn(operation, 'deleteComment')
        || (hasOwn(operation, 'commentId') && hasOwn(operation, 'resolved'));
}

/** No I/O and no timers: callers supply generation, permissions, joins, and socket events. */
export class HistoryOtSession {
    private phase: HistoryOtSessionPhase = 'joining';
    private permission?: HistoryOtPermissionLevel;
    private userId?: string;
    private version?: number;
    private snapshot?: ParsedHistoryOtSnapshot;
    private pending?: PendingUpdate;
    private rejoinReason?: string;
    private lastCommittedBaseVersion?: number;

    constructor(
        readonly docId: string,
        private generation: number,
        permission: HistoryOtPermissionContext,
    ) {
        if (docId.length === 0 || !Number.isSafeInteger(generation) || generation < 0) {
            throw new HistoryOtSessionError('INVALID_SESSION', 'Document id and generation must be valid');
        }
        const normalized = normalizePermission(permission);
        this.permission = normalized.level;
        this.userId = normalized.userId;
    }

    getState(): HistoryOtSessionView {
        const authoritative = this.phase === 'ready' || this.phase === 'pending'
            || this.phase === 'recovery-ready';
        return {
            docId: this.docId,
            generation: this.generation,
            phase: this.phase,
            permission: this.permission,
            userId: this.userId,
            version: authoritative ? this.version : undefined,
            snapshot: authoritative && this.snapshot !== undefined
                ? serializeHistoryOtSnapshot(this.snapshot)
                : undefined,
            hasPendingOperation: this.pending !== undefined,
            pendingBaseVersion: this.pending?.baseVersion,
            pendingQueued: this.pending?.queued ?? false,
            rejoinReason: this.rejoinReason,
        };
    }

    private result(
        kind: HistoryOtSessionResultKind,
        applied = false,
        envelope?: JsonValue,
        reason?: string,
    ): HistoryOtSessionResult {
        return {
            kind,
            applied,
            requiresRejoin: this.phase === 'rejoin-required',
            envelope: envelope === undefined ? undefined : deepCloneJson(envelope),
            reason,
            state: this.getState(),
        };
    }

    private requireRejoin(reason: string): HistoryOtSessionResult {
        this.phase = 'rejoin-required';
        this.rejoinReason = reason;
        return this.result('rejoin-required', false, undefined, reason);
    }

    private senderCommitted(reason: string): HistoryOtSessionResult {
        this.phase = 'rejoin-required';
        this.rejoinReason = reason;
        return this.result('sender-commit', false, undefined, reason);
    }

    private checkGeneration(eventGeneration: number): HistoryOtSessionResult | undefined {
        if (eventGeneration < this.generation) {
            return this.result('stale-generation-ignored', false, undefined, 'stale-generation');
        }
        if (eventGeneration > this.generation) {
            return this.requireRejoin('future-generation');
        }
        return undefined;
    }

    updatePermission(
        eventGeneration: number,
        context: HistoryOtPermissionContext,
    ): HistoryOtSessionResult {
        const generationResult = this.checkGeneration(eventGeneration);
        if (generationResult !== undefined) {
            return generationResult;
        }
        const normalized = normalizePermission(context);
        if (normalized.level === undefined) {
            this.permission = undefined;
            this.userId = undefined;
            return this.requireRejoin('permission-uncertain');
        }
        const identityChanged = this.userId !== normalized.userId;
        this.permission = normalized.level;
        this.userId = normalized.userId;
        if (this.pending !== undefined && identityChanged) {
            return this.requireRejoin('identity-changed-with-pending-operation');
        }
        if (this.pending !== undefined && !this.permissionAllows(this.pending.intent)) {
            return this.requireRejoin('permission-changed-with-pending-operation');
        }
        return this.result('permission-updated');
    }

    acceptJoin(eventGeneration: number, input: unknown): HistoryOtSessionResult {
        const generationResult = this.checkGeneration(eventGeneration);
        if (generationResult !== undefined) {
            return generationResult;
        }
        const join = parseHistoryOtJoinState(input);
        if (!join.safe || join.version === undefined || join.snapshot === undefined) {
            return this.requireRejoin(`unsafe-join: ${join.unsafeReasons.join('; ')}`);
        }
        if (this.permission === undefined) {
            return this.requireRejoin('permission-uncertain');
        }
        this.version = join.version;
        this.snapshot = join.snapshot;
        this.rejoinReason = undefined;
        if (this.pending === undefined) {
            this.phase = 'ready';
        } else {
            this.pending.recoveryJoinVersion = join.version;
            this.phase = 'recovery-ready';
        }
        return this.result('joined');
    }

    private permissionAllows(intent: HistoryOtWriteIntent): boolean {
        if (this.permission === 'owner' || this.permission === 'readAndWrite') {
            return true;
        }
        return this.permission === 'review'
            && (intent.kind === 'tracked-write'
                || (intent.kind === 'tracked-decision' && intent.decision === 'reject'));
    }

    private assertIntent(
        operation: HistoryOtOperation,
        operationRaw: JsonValue,
        meta: JsonObject,
        intent: HistoryOtWriteIntent,
    ): void {
        if (!this.permissionAllows(intent)) {
            throw new HistoryOtSessionError('PERMISSION_DENIED', 'Permission does not allow this write intent');
        }
        if (intent.kind === 'plain-write') {
            if (hasTrackingDirective(operation) || hasOwn(meta, 'tc')) {
                throw new HistoryOtSessionError('INTENT_MISMATCH', 'Plain writes cannot carry tracking data');
            }
            return;
        }
        if (intent.kind === 'comment-write') {
            if (!isCommentOperation(operation) || hasOwn(meta, 'tc')) {
                throw new HistoryOtSessionError('INTENT_MISMATCH', 'Comment intent requires one comment operation');
            }
            return;
        }
        if (!hasNonEmptyTrackChangesSeed(meta)) {
            throw new HistoryOtSessionError(
                'MISSING_TRACK_CHANGES_SEED',
                'Tracked writes require a non-empty opaque meta.tc string seed',
            );
        }
        if (intent.kind === 'tracked-write') {
            const reasons = validateTrackedWrite(operation, this.userId);
            if (reasons.length > 0) {
                throw new HistoryOtSessionError('UNSAFE_TRACKED_WRITE', reasons.join('; '), reasons);
            }
            return;
        }
        if (this.snapshot === undefined) {
            throw new HistoryOtSessionError('NO_AUTHORITATIVE_SNAPSHOT', 'Tracked decision requires a join snapshot');
        }
        const expected = intent.decision === 'accept'
            ? buildAcceptTrackedChangesOperation(this.snapshot, intent.selectedRanges)
            : buildRejectTrackedChangesOperation(this.snapshot, intent.selectedRanges);
        const expectedRaw = serializeHistoryOtOperations(expected);
        if (!jsonEqual(operationRaw, expectedRaw)) {
            throw new HistoryOtSessionError(
                'TRACKED_DECISION_MISMATCH',
                'Operation does not exactly implement the declared tracked-change decision',
            );
        }
        if (this.permission === 'review') {
            const snapshotRaw = serializeHistoryOtSnapshot(this.snapshot) as StringFileDataSnapshot;
            if (this.userId === undefined
                || !selectedChangesBelongTo(snapshotRaw, intent.selectedRanges, this.userId)) {
                throw new HistoryOtSessionError(
                    'UNPROVEN_AUTHOR',
                    'Review permission can reject only changes proven to belong to the session user',
                );
            }
        }
    }

    stage(eventGeneration: number, request: HistoryOtStageRequest): HistoryOtSessionResult {
        const generationResult = this.checkGeneration(eventGeneration);
        if (generationResult !== undefined) {
            return generationResult;
        }
        if (this.phase !== 'ready' || this.version === undefined || this.snapshot === undefined) {
            throw new HistoryOtSessionError('SESSION_NOT_READY', 'A safe authoritative join is required');
        }
        if (this.permission === undefined) {
            this.requireRejoin('permission-uncertain');
            throw new HistoryOtSessionError('PERMISSION_UNCERTAIN', 'Permission is unknown');
        }
        if (typeof request.publicId !== 'string' || request.publicId.length === 0) {
            throw new HistoryOtSessionError('INVALID_SOURCE', 'publicId must be a non-empty string');
        }
        const parsedOperation = parseHistoryOtWireOperation(request.operation);
        if (!parsedOperation.safe) {
            throw new HistoryOtSessionError(
                'UNSAFE_WIRE_OPERATION',
                parsedOperation.unsafeReasons.join('; '),
                parsedOperation.unsafeReasons,
            );
        }
        const operationRaw = serializeHistoryOtWireOperation(parsedOperation);
        const operation = (operationRaw as [HistoryOtOperation])[0];
        const metaRaw = request.meta === undefined ? {} : deepCloneJson(request.meta);
        if (!isJsonObject(metaRaw)) {
            throw new HistoryOtSessionError('INVALID_META', 'meta must be a JSON object');
        }
        if (hasOwn(metaRaw, 'source') && metaRaw.source !== request.publicId) {
            throw new HistoryOtSessionError('SOURCE_MISMATCH', 'meta.source does not match publicId');
        }
        metaRaw.source = request.publicId;
        this.assertIntent(operation, operationRaw, metaRaw, request.intent);
        try {
            applyHistoryOtOperations(this.snapshot, parseHistoryOtOperations(operationRaw));
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new HistoryOtSessionError(
                'OPERATION_NOT_APPLICABLE',
                `History OT operation is not applicable to the authoritative snapshot: ${reason}`,
                [reason],
            );
        }
        const envelope: JsonObject = {
            doc: this.docId,
            v: this.version,
            op: operationRaw,
            meta: metaRaw,
        };
        const parsedEnvelope = parseHistoryOtRealtimeEnvelope(envelope);
        assertHistoryOtRealtimeEnvelopeSafe(parsedEnvelope);
        const raw = serializeHistoryOtRealtimeEnvelope(parsedEnvelope) as JsonObject;
        this.pending = {
            originalEnvelope: cloneObject(raw),
            originalOperation: deepCloneJson(operationRaw),
            baseVersion: this.version,
            intent: request.intent,
            publicIds: [request.publicId],
            queued: false,
        };
        this.phase = 'pending';
        return this.result('staged', false, raw);
    }

    markQueueAccepted(eventGeneration: number): HistoryOtSessionResult {
        const generationResult = this.checkGeneration(eventGeneration);
        if (generationResult !== undefined) {
            return generationResult;
        }
        if (this.pending === undefined || this.phase !== 'pending') {
            throw new HistoryOtSessionError('NO_PENDING_OPERATION', 'No pending operation can be queued');
        }
        this.pending.queued = true;
        return this.result('queue-accepted');
    }

    reconnect(nextGeneration: number): HistoryOtSessionResult {
        if (!Number.isSafeInteger(nextGeneration) || nextGeneration <= this.generation) {
            throw new HistoryOtSessionError('INVALID_GENERATION', 'Reconnect generation must increase');
        }
        this.generation = nextGeneration;
        this.phase = 'joining';
        this.version = undefined;
        this.snapshot = undefined;
        this.rejoinReason = undefined;
        if (this.pending !== undefined) {
            this.pending.queued = false;
            this.pending.recoveryJoinVersion = undefined;
        }
        return this.result('reconnect-started', false, undefined, 'reconnect-join-required');
    }

    prepareRecovery(eventGeneration: number, publicId: string): HistoryOtSessionResult {
        const generationResult = this.checkGeneration(eventGeneration);
        if (generationResult !== undefined) {
            return generationResult;
        }
        if (this.phase !== 'recovery-ready' || this.pending === undefined) {
            throw new HistoryOtSessionError('RECOVERY_NOT_READY', 'Recovery requires an authoritative rejoin');
        }
        if (typeof publicId !== 'string' || publicId.length === 0) {
            throw new HistoryOtSessionError('INVALID_SOURCE', 'publicId must be a non-empty string');
        }
        if (!this.permissionAllows(this.pending.intent)) {
            return this.requireRejoin('permission-does-not-allow-recovery');
        }
        const priorIds = [...new Set(this.pending.publicIds)];
        const recovery = cloneObject(this.pending.originalEnvelope);
        recovery.op = deepCloneJson(this.pending.originalOperation);
        recovery.v = this.pending.baseVersion;
        recovery.dupIfSource = priorIds;
        const meta = cloneObject(recovery.meta as JsonObject);
        meta.source = publicId;
        recovery.meta = meta;
        const parsed = parseHistoryOtRealtimeEnvelope(recovery);
        assertHistoryOtRealtimeEnvelopeSafe(parsed);
        this.pending.publicIds.push(publicId);
        this.pending.queued = false;
        this.phase = 'pending';
        return this.result('recovery-staged', false, recovery);
    }

    receiveApplied(eventGeneration: number, input: unknown): HistoryOtSessionResult {
        const generationResult = this.checkGeneration(eventGeneration);
        if (generationResult !== undefined) {
            return generationResult;
        }
        const update = parseHistoryOtRealtimeEnvelope(input);
        if (!update.safe || update.doc === undefined || update.version === undefined) {
            return this.requireRejoin(`unsafe-update: ${update.unsafeReasons.join('; ')}`);
        }
        if (update.doc !== this.docId) {
            return this.requireRejoin('wrong-document');
        }
        if (this.permission === undefined) {
            return this.requireRejoin('permission-uncertain');
        }
        if (update.classification === 'sender-ack') {
            return this.receiveSenderAck(update.version);
        }
        if (update.operation === undefined) {
            return this.requireRejoin('missing-operation');
        }
        const operationRaw = serializeHistoryOtWireOperation(update.operation);
        if (update.duplicate) {
            return this.receiveDuplicateAcknowledgement(update, operationRaw);
        }
        if (this.pending !== undefined
            && typeof update.source === 'string'
            && this.pending.publicIds.includes(update.source)
            && jsonEqual(operationRaw, this.pending.originalOperation)) {
            this.lastCommittedBaseVersion = update.version;
            this.pending = undefined;
            return this.senderCommitted('sender-full-update-committed');
        }
        return this.receiveCollaboratorUpdate(update.version, operationRaw);
    }

    private receiveSenderAck(version: number): HistoryOtSessionResult {
        if (this.pending === undefined) {
            if (this.lastCommittedBaseVersion === version) {
                return this.result('late-ack-ignored', false, undefined, 'duplicate-sender-ack');
            }
            if (this.version !== undefined && version < this.version) {
                return this.result('late-ack-ignored', false, undefined, 'old-sender-ack');
            }
            return this.requireRejoin('unexpected-sender-ack');
        }
        if (version < this.pending.baseVersion) {
            return this.result('late-ack-ignored', false, undefined, 'old-sender-ack');
        }
        if (version !== this.pending.baseVersion) {
            return this.requireRejoin('sender-ack-version-gap');
        }
        this.lastCommittedBaseVersion = version;
        this.pending = undefined;
        return this.senderCommitted('sender-commit-needs-authoritative-join');
    }

    private receiveDuplicateAcknowledgement(
        update: ParsedHistoryOtRealtimeEnvelope,
        operationRaw: JsonValue,
    ): HistoryOtSessionResult {
        if (this.pending === undefined
            || !jsonEqual(operationRaw, this.pending.originalOperation)) {
            if (this.version !== undefined && (update.version as number) < this.version) {
                return this.result('duplicate-ignored');
            }
            return this.requireRejoin('unmatched-duplicate-acknowledgement');
        }
        const sourceMatches = typeof update.source === 'string'
            && this.pending.publicIds.includes(update.source);
        const dedupeMatches = update.dupIfSource.some(source => this.pending?.publicIds.includes(source));
        if (!sourceMatches && !dedupeMatches) {
            return this.requireRejoin('duplicate-source-mismatch');
        }
        const recoveryJoinVersion = this.pending.recoveryJoinVersion;
        const baseVersion = this.pending.baseVersion;
        this.lastCommittedBaseVersion = baseVersion;
        this.pending = undefined;
        if (recoveryJoinVersion !== undefined && this.snapshot !== undefined && this.version === recoveryJoinVersion
            && recoveryJoinVersion > baseVersion) {
            this.phase = 'ready';
            this.rejoinReason = undefined;
            return this.result('duplicate-acknowledged');
        }
        return this.requireRejoin('duplicate-confirmed-before-authoritative-join');
    }

    private receiveCollaboratorUpdate(version: number, operationRaw: JsonValue): HistoryOtSessionResult {
        if (this.version === undefined || this.snapshot === undefined) {
            return this.requireRejoin('update-without-authoritative-join');
        }
        if (version < this.version) {
            return this.result('duplicate-ignored');
        }
        if (version > this.version) {
            return this.requireRejoin('collaborator-version-gap');
        }
        try {
            this.snapshot = applyHistoryOtOperations(
                this.snapshot,
                parseHistoryOtOperations(operationRaw),
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return this.requireRejoin(`collaborator-operation-failed: ${message}`);
        }
        this.version += 1;
        if (this.pending !== undefined) {
            this.phase = 'rejoin-required';
            this.rejoinReason = 'collaborator-update-while-local-operation-pending';
            return this.result(
                'collaborator-applied',
                true,
                undefined,
                'collaborator-update-while-local-operation-pending',
            );
        }
        return this.result('collaborator-applied', true);
    }
}

export type HistoryOtThreadEventName =
    | 'new-comment'
    | 'edit-message'
    | 'delete-message'
    | 'resolve-thread'
    | 'reopen-thread'
    | 'delete-thread'
    | 'new-comment-threads';

export interface HistoryOtRawThreadEvent {
    readonly event: HistoryOtThreadEventName,
    readonly args: JsonValue[],
}

export interface HistoryOtRawThreadEventLog {
    readonly events: readonly HistoryOtRawThreadEvent[],
}

const threadEventArities: Record<HistoryOtThreadEventName, number> = {
    'new-comment': 2,
    'edit-message': 3,
    'delete-message': 2,
    'resolve-thread': 2,
    'reopen-thread': 1,
    'delete-thread': 1,
    'new-comment-threads': 1,
};

/** Lossless append-only reducer; semantic projection belongs to a caller-owned adapter. */
export function appendHistoryOtThreadEvent(
    state: HistoryOtRawThreadEventLog,
    event: HistoryOtThreadEventName,
    argsInput: unknown,
): HistoryOtRawThreadEventLog {
    const args = deepCloneJson(argsInput);
    if (!Array.isArray(args) || args.length !== threadEventArities[event]) {
        throw new HistoryOtSessionError('UNSAFE_THREAD_EVENT', `${event} has an unexpected argument list`);
    }
    if (event !== 'new-comment-threads' && (typeof args[0] !== 'string' || args[0].length === 0)) {
        throw new HistoryOtSessionError('UNSAFE_THREAD_EVENT', `${event} requires a thread id`);
    }
    return {
        events: [
            ...state.events.map(item => ({event: item.event, args: deepCloneJson(item.args) as JsonValue[]})),
            {event, args: deepCloneJson(args) as JsonValue[]},
        ],
    };
}
