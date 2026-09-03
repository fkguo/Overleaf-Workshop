/* eslint-disable @typescript-eslint/naming-convention */
import {randomUUID} from 'crypto';
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
    readonly origin?: JsonObject,
    readonly updateType?: 'external',
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
    readonly ranges?: JsonObject,
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

/**
 * Reconcile the enqueue RPC with the authoritative realtime commit witness.
 * The RPC only proves that the update reached the queue; a matching
 * otUpdateApplied event proves that it committed. An outcome-unknown enqueue
 * failure therefore remains recoverable when the commit witness arrives,
 * while a deterministic rejection always wins.
 */
export async function awaitHistoryOtSubmissionCommit(
    enqueue: Promise<void>,
    commit: Promise<void>,
    markQueueAccepted: () => void,
    isOutcomeUnknown: (error: unknown) => boolean,
): Promise<void> {
    const commitWitness = commit.then(
        () => ({committed: true as const}),
        error => ({committed: false as const, error}),
    );
    try {
        await enqueue;
    } catch (error) {
        if (!isOutcomeUnknown(error)) {
            throw error;
        }
        const result = await commitWitness;
        if (result.committed) {
            return;
        }
        throw error;
    }
    markQueueAccepted();
    const result = await commitWitness;
    if (!result.committed) {
        throw result.error;
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
    let origin: JsonObject | undefined;
    let updateType: 'external' | undefined;
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
                for (const key of unknownKeys(
                    raw.meta,
                    ['source', 'origin', 'type', 'user_id', 'ts', 'tc'],
                )) {
                    reasons.push(`$.meta.${key} is unknown metadata`);
                }
                source = raw.meta.source;
                if (hasOwn(raw.meta, 'source')
                    && (typeof source !== 'string' || source.length === 0)) {
                    reasons.push('$.meta.source must be a non-empty string when present');
                }
                if (hasOwn(raw.meta, 'origin')) {
                    if (!isJsonObject(raw.meta.origin)) {
                        reasons.push('$.meta.origin must be a JSON object when present');
                    } else {
                        origin = cloneObject(raw.meta.origin);
                    }
                }
                if (hasOwn(raw.meta, 'type')) {
                    if (raw.meta.type !== 'external') {
                        reasons.push('$.meta.type must be external when present');
                    } else {
                        updateType = 'external';
                    }
                }
                user = raw.meta.user_id;
                time = raw.meta.ts;
                trackChangesSeed = raw.meta.tc;
            }
        }
        if (classification === 'collaborator-update') {
            const hasValidSource = typeof source === 'string' && source.length > 0;
            const hasValidOrigin = origin !== undefined;
            if (!hasValidSource && !hasValidOrigin) {
                reasons.push('$.meta must carry a non-empty source or JSON-object origin on a full update');
            }
            if (hasValidSource && hasValidOrigin) {
                reasons.push('$.meta.source and $.meta.origin are mutually exclusive');
            }
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
        origin,
        updateType,
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
    let ranges: JsonObject | undefined;
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
        if (!isJsonObject(raw.ranges)) {
            reasons.push('$.ranges must be a JSON object');
        } else {
            ranges = cloneObject(raw.ranges);
        }
    }
    return {
        kind: 'history-ot-join-state',
        raw,
        safe: reasons.length === 0,
        unsafeReasons: reasons,
        version,
        snapshot,
        ranges,
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
    /**
     * Reserved fail-closed marker. A future adapter must split comment add,
     * state, and delete capabilities and prove authoritative thread ownership.
     */
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
    readonly ranges?: JsonObject,
    readonly hasPendingOperation: boolean,
    readonly pendingBaseVersion?: number,
    readonly pendingWireAttempted: boolean,
    readonly pendingQueued: boolean,
    readonly pendingRecoveryBlockedReason?: string,
    readonly rejoinReason?: string,
}

export type HistoryOtSessionResultKind =
    | 'joined'
    | 'staged'
    | 'wire-attempted'
    | 'queue-accepted'
    | 'staged-cancelled'
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
    readonly submissionToken?: string,
    readonly state: HistoryOtSessionView,
}

interface PendingUpdate {
    originalEnvelope: JsonObject,
    originalOperation: JsonValue,
    authorizedEnvelope: JsonValue,
    baseVersion: number,
    intent: HistoryOtWriteIntent,
    publicIds: string[],
    wireAttempted: boolean,
    queued: boolean,
    submissionToken?: string,
    recoveryAttempt: boolean,
    recoveryJoinVersion?: number,
    recoveryBlockedReason?: string,
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
    private ranges?: JsonObject;
    private pending?: PendingUpdate;
    private rejoinReason?: string;
    private lastCommittedBaseVersion?: number;
    private lastCommittedSubmissionToken?: string;
    private joinAnchorVersion?: number;
    private readonly appliedUpdateWitnesses = new Map<number, JsonValue>();
    private readonly sessionNonce = randomUUID();
    private submissionSequence = 0;

    constructor(
        readonly docId: string,
        private generation: number,
        permission: HistoryOtPermissionContext,
    ) {
        if (docId.length === 0 || !Number.isSafeInteger(generation) || generation < 0) {
            throw new HistoryOtSessionError('INVALID_SESSION', 'Document id and generation must be valid');
        }
        const normalized = normalizePermission(permission);
        this.permission = normalized.level === 'readOnly' || normalized.userId !== undefined
            ? normalized.level : undefined;
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
            ranges: authoritative && this.ranges !== undefined
                ? cloneObject(this.ranges)
                : undefined,
            hasPendingOperation: this.pending !== undefined,
            pendingBaseVersion: this.pending?.baseVersion,
            pendingWireAttempted: this.pending?.wireAttempted ?? false,
            pendingQueued: this.pending?.queued ?? false,
            pendingRecoveryBlockedReason: this.pending?.recoveryBlockedReason,
            rejoinReason: this.rejoinReason,
        };
    }

    private result(
        kind: HistoryOtSessionResultKind,
        applied = false,
        envelope?: JsonValue,
        reason?: string,
        submissionToken?: string,
    ): HistoryOtSessionResult {
        return {
            kind,
            applied,
            requiresRejoin: this.phase === 'rejoin-required',
            envelope: envelope === undefined ? undefined : deepCloneJson(envelope),
            submissionToken,
            reason,
            state: this.getState(),
        };
    }

    private nextSubmissionToken(): string {
        this.submissionSequence += 1;
        return `history-ot:${this.sessionNonce}:${this.generation}:${this.submissionSequence}`;
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
        const writableIdentityMissing = normalized.level !== undefined
            && normalized.level !== 'readOnly'
            && normalized.userId === undefined;
        if (normalized.level === undefined || writableIdentityMissing) {
            this.permission = undefined;
            this.userId = undefined;
            if (this.pending !== undefined) {
                this.pending.recoveryBlockedReason = writableIdentityMissing
                    ? 'identity-changed-with-pending-operation'
                    : 'permission-uncertain-with-pending-operation';
            }
            return this.requireRejoin(writableIdentityMissing
                ? (this.pending === undefined
                    ? 'identity-uncertain'
                    : 'identity-changed-with-pending-operation')
                : 'permission-uncertain');
        }
        const identityChanged = this.userId !== normalized.userId;
        this.permission = normalized.level;
        this.userId = normalized.userId;
        if (this.pending !== undefined && identityChanged) {
            this.pending.recoveryBlockedReason = 'identity-changed-with-pending-operation';
            return this.requireRejoin('identity-changed-with-pending-operation');
        }
        if (this.pending !== undefined && !this.permissionAllows(this.pending.intent)) {
            this.pending.recoveryBlockedReason = 'permission-changed-with-pending-operation';
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
        if (this.pending !== undefined && join.version < this.pending.baseVersion) {
            return this.requireRejoin('recovery-join-predates-pending-base');
        }
        this.version = join.version;
        this.snapshot = join.snapshot;
        this.ranges = join.ranges;
        this.joinAnchorVersion = join.version;
        this.appliedUpdateWitnesses.clear();
        if (this.pending === undefined) {
            this.phase = 'ready';
            this.rejoinReason = undefined;
        } else if (this.pending.recoveryBlockedReason !== undefined) {
            this.pending.recoveryJoinVersion = join.version;
            this.phase = 'rejoin-required';
            this.rejoinReason = this.pending.recoveryBlockedReason;
        } else {
            this.pending.recoveryJoinVersion = join.version;
            this.phase = 'recovery-ready';
            this.rejoinReason = undefined;
        }
        return this.result('joined');
    }

    private permissionAllows(intent: HistoryOtWriteIntent): boolean {
        if (intent.kind === 'comment-write' || this.userId === undefined) {
            return false;
        }
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
        if (intent.kind === 'comment-write' || isCommentOperation(operation)) {
            throw new HistoryOtSessionError(
                'UNSUPPORTED_COMMENT_WRITE',
                'Comment mutation is disabled until add/state/delete capabilities and '
                    + 'authoritative thread ownership are separately proven',
            );
        }
        if (!this.permissionAllows(intent)) {
            throw new HistoryOtSessionError('PERMISSION_DENIED', 'Permission does not allow this write intent');
        }
        if (intent.kind === 'plain-write') {
            if (hasTrackingDirective(operation) || hasOwn(meta, 'tc')) {
                throw new HistoryOtSessionError('INTENT_MISMATCH', 'Plain writes cannot carry tracking data');
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
        if (this.userId === undefined) {
            this.requireRejoin('identity-uncertain');
            throw new HistoryOtSessionError(
                'IDENTITY_UNCERTAIN',
                'A proven authenticated user identity is required for History OT writes',
            );
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
        const intent = deepCloneJson(request.intent) as HistoryOtWriteIntent;
        this.assertIntent(operation, operationRaw, metaRaw, intent);
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
        const submissionToken = this.nextSubmissionToken();
        this.pending = {
            originalEnvelope: cloneObject(raw),
            originalOperation: deepCloneJson(operationRaw),
            authorizedEnvelope: deepCloneJson(raw),
            baseVersion: this.version,
            intent,
            publicIds: [request.publicId],
            wireAttempted: false,
            queued: false,
            submissionToken,
            recoveryAttempt: false,
        };
        this.phase = 'pending';
        return this.result('staged', false, raw, undefined, submissionToken);
    }

    /** Mark the exact synchronous transition after final authorization and before emit. */
    markWireAttempted(
        eventGeneration: number,
        submissionToken: string,
    ): HistoryOtSessionResult {
        const generationResult = this.checkGeneration(eventGeneration);
        if (generationResult !== undefined) {
            return generationResult;
        }
        if (this.phase !== 'pending' || this.pending === undefined
            || this.pending.submissionToken !== submissionToken) {
            throw new HistoryOtSessionError(
                'NO_PENDING_OPERATION',
                'No exact pending History OT operation can cross the wire boundary',
            );
        }
        if (this.pending.wireAttempted) {
            throw new HistoryOtSessionError(
                'SUBMISSION_ALREADY_ATTEMPTED',
                'The exact History OT submission token has already crossed the wire boundary',
            );
        }
        this.pending.wireAttempted = true;
        return this.result('wire-attempted');
    }

    markQueueAccepted(
        eventGeneration: number,
        submissionToken: string,
    ): HistoryOtSessionResult {
        const generationResult = this.checkGeneration(eventGeneration);
        if (generationResult !== undefined) {
            return generationResult;
        }
        if (this.pending === undefined) {
            if (this.lastCommittedSubmissionToken === submissionToken) {
                return this.result('queue-accepted', false, undefined, 'commit-witness-arrived-first');
            }
            throw new HistoryOtSessionError('NO_PENDING_OPERATION', 'No pending operation can be queued');
        }
        if (this.pending.submissionToken !== submissionToken
            || !this.pending.wireAttempted) {
            throw new HistoryOtSessionError('NO_PENDING_OPERATION', 'No pending operation can be queued');
        }
        this.pending.queued = true;
        return this.result('queue-accepted');
    }

    /**
     * Cancel only the exact staged attempt after a deterministic zero-wire
     * rejection. A recovery retry is peeled off without deleting the durable
     * outcome-unknown operation it was attempting to recover.
     */
    cancelStagedSubmission(
        eventGeneration: number,
        submissionToken: string,
    ): HistoryOtSessionResult {
        const generationResult = this.checkGeneration(eventGeneration);
        if (generationResult !== undefined) {
            return generationResult;
        }
        if (this.pending === undefined
            || this.pending.submissionToken !== submissionToken) {
            throw new HistoryOtSessionError(
                'STAGED_SUBMISSION_MISMATCH',
                'Cancellation token does not match the exact staged History OT submission',
            );
        }
        if (this.pending.wireAttempted) {
            throw new HistoryOtSessionError(
                'SUBMISSION_OUTCOME_UNKNOWN',
                'A History OT submission that may have crossed the wire cannot be cancelled deterministically',
            );
        }
        if (this.pending.recoveryAttempt) {
            this.pending.publicIds.pop();
            this.pending.authorizedEnvelope = cloneObject(this.pending.originalEnvelope);
            this.pending.submissionToken = undefined;
            this.pending.recoveryAttempt = false;
            this.pending.wireAttempted = false;
            if (this.pending.recoveryBlockedReason === undefined
                && this.phase !== 'rejoin-required') {
                this.phase = 'recovery-ready';
                this.rejoinReason = undefined;
            }
        } else {
            this.pending = undefined;
            if (this.phase !== 'rejoin-required') {
                this.phase = 'ready';
                this.rejoinReason = undefined;
            }
        }
        return this.result('staged-cancelled');
    }

    reconnect(nextGeneration: number): HistoryOtSessionResult {
        if (!Number.isSafeInteger(nextGeneration) || nextGeneration <= this.generation) {
            throw new HistoryOtSessionError('INVALID_GENERATION', 'Reconnect generation must increase');
        }
        this.generation = nextGeneration;
        this.phase = 'joining';
        this.version = undefined;
        this.snapshot = undefined;
        this.ranges = undefined;
        this.joinAnchorVersion = undefined;
        this.appliedUpdateWitnesses.clear();
        this.rejoinReason = undefined;
        if (this.pending !== undefined) {
            this.pending.queued = false;
            this.pending.submissionToken = undefined;
            this.pending.recoveryAttempt = false;
            this.pending.wireAttempted = false;
            this.pending.recoveryJoinVersion = undefined;
        }
        return this.result('reconnect-started', false, undefined, 'reconnect-join-required');
    }

    prepareRecovery(eventGeneration: number, publicId: string): HistoryOtSessionResult {
        const generationResult = this.checkGeneration(eventGeneration);
        if (generationResult !== undefined) {
            return generationResult;
        }
        if (this.pending?.recoveryBlockedReason !== undefined) {
            throw new HistoryOtSessionError(
                'RECOVERY_BLOCKED',
                `Pending History OT recovery is blocked: ${this.pending.recoveryBlockedReason}`,
                [this.pending.recoveryBlockedReason],
            );
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
        const submissionToken = this.nextSubmissionToken();
        this.pending.authorizedEnvelope = deepCloneJson(recovery);
        this.pending.publicIds.push(publicId);
        this.pending.wireAttempted = false;
        this.pending.queued = false;
        this.pending.submissionToken = submissionToken;
        this.pending.recoveryAttempt = true;
        this.phase = 'pending';
        return this.result('recovery-staged', false, recovery, undefined, submissionToken);
    }

    /**
     * Bind the transport submission to the exact envelope and intent that passed
     * this session's permission, author, snapshot, and applicability gates.
     */
    assertPendingSubmission(
        eventGeneration: number,
        submissionToken: string,
        envelope: unknown,
        intent: HistoryOtWriteIntent,
    ): JsonValue {
        const generationResult = this.checkGeneration(eventGeneration);
        if (generationResult !== undefined) {
            throw new HistoryOtSessionError(
                'STALE_SUBMISSION',
                generationResult.reason ?? 'History OT submission belongs to a stale generation',
            );
        }
        if (this.phase !== 'pending' || this.pending === undefined
            || this.pending.submissionToken !== submissionToken) {
            throw new HistoryOtSessionError(
                'NO_AUTHORIZED_SUBMISSION',
                'History OT transport submission requires one staged pending operation',
            );
        }
        const rawEnvelope = deepCloneJson(envelope);
        const rawIntent = deepCloneJson(intent);
        const authorizedIntent = deepCloneJson(this.pending.intent);
        if (!jsonEqual(rawEnvelope, this.pending.authorizedEnvelope)
            || !jsonEqual(rawIntent, authorizedIntent)) {
            throw new HistoryOtSessionError(
                'UNAUTHORIZED_SUBMISSION',
                'History OT transport submission does not match the staged envelope and intent',
            );
        }
        // Transport must emit this private snapshot, never the caller-owned
        // object which was compared above. This closes the validation-to-emit
        // mutation window without exposing the session's stored recovery copy.
        return deepCloneJson(this.pending.authorizedEnvelope);
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
        if (update.classification === 'sender-ack') {
            return this.receiveSenderAck(update.version);
        }
        if (this.permission === undefined) {
            return this.requireRejoin('permission-uncertain');
        }
        if (update.operation === undefined) {
            return this.requireRejoin('missing-operation');
        }
        const operationRaw = serializeHistoryOtWireOperation(update.operation);
        if (this.pending !== undefined) {
            const knownSource = typeof update.source === 'string'
                && this.pending.publicIds.includes(update.source);
            if (knownSource) {
                return this.requireRejoin('unexpected-sender-full-update');
            }
        }
        if (update.duplicate) {
            return this.requireRejoin('unexpected-duplicate-full-update');
        }
        return this.receiveCollaboratorUpdate(update.version, operationRaw, update.raw);
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
        if (!this.pending.wireAttempted) {
            return this.requireRejoin('sender-ack-without-wire-attempt');
        }
        if (version < this.pending.baseVersion) {
            return this.result('late-ack-ignored', false, undefined, 'old-sender-ack');
        }
        if (version !== this.pending.baseVersion) {
            return this.requireRejoin('sender-ack-version-mismatch');
        }
        // The pinned real-time server emits only {doc, v} to the socket whose
        // current public id matches meta.source. The provider has already bound
        // this event to the current socket generation, and this session permits
        // exactly one pending submission, so the version-only event is the
        // authoritative sender commit witness for that exact pending envelope.
        this.lastCommittedBaseVersion = version;
        this.lastCommittedSubmissionToken = this.pending.submissionToken;
        this.pending = undefined;
        return this.senderCommitted('sender-commit-needs-authoritative-join');
    }

    private receiveCollaboratorUpdate(
        version: number,
        operationRaw: JsonValue,
        rawUpdate: JsonValue,
    ): HistoryOtSessionResult {
        if (this.version === undefined || this.snapshot === undefined) {
            return this.requireRejoin('update-without-authoritative-join');
        }
        if (version < this.version) {
            if (this.joinAnchorVersion !== undefined && version >= this.joinAnchorVersion) {
                const witnessed = this.appliedUpdateWitnesses.get(version);
                if (witnessed === undefined || !jsonEqual(witnessed, rawUpdate)) {
                    return this.requireRejoin('conflicting-duplicate-collaborator-update');
                }
            }
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
        this.appliedUpdateWitnesses.set(version, deepCloneJson(rawUpdate));
        this.version += 1;
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
