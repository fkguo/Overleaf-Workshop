import {
    applyTextOperations,
    ObservedTextChange,
    operationsFromObservedTextChanges,
    TextOperation,
    transformOperationPair,
} from './documentUpdate';
import {
    applyHistoryOtOperations,
    composeHistoryOtOperationsWithSnapshot,
    getVisibleHistoryOtText,
    HistoryOtOperationsInput,
    HistoryOtSnapshotInput,
    HistoryOtTrackingInput,
    historyOtJsonEqual,
    parseHistoryOtOperations,
    parseHistoryOtSnapshot,
    ParsedHistoryOtOperations,
    ParsedHistoryOtSnapshot,
    serializeHistoryOtOperations,
    serializeHistoryOtSnapshot,
    transformHistoryOtOperationsWithSnapshot,
} from './historyOt';
import {prepareHistoryOtDocumentUpdate} from './historyOtDocument';
import {normalizeHistoryOtTimestamp} from './historyOt/protocol';

export type RealtimeEditorBridgeState = {
    socketGeneration: number,
    remoteEpoch: string,
    remoteVersion: number,
    remoteContent: string,
    documentVersion: number,
    editorContent: string,
    /** Exact local operation already sent. Never rebase or mutate this wire copy. */
    inflightWire?: TextOperation[],
    /** Binds the immutable wire copy to one provider pending-write intent. */
    inflightToken?: string,
    /** The sent operation rebased through causally earlier server operations. */
    inflightView?: TextOperation[],
    /** Local operations observed after the in-flight operation was sent. */
    pendingOperations: TextOperation[],
    /** Sequential inflightView + pendingOperations, retained as the save witness. */
    localOperations: TextOperation[],
    valid: boolean,
};

export type RemoteEditorTransaction = {
    token: string,
    socketGeneration: number,
    remoteEpoch: string,
    baseRemoteVersion: number,
    beforeDocumentVersion: number,
    beforeEditorContent: string,
    remoteOperations: TextOperation[],
    remoteAfterLocal: TextOperation[],
    localAfterRemote: TextOperation[],
    nextInflightView?: TextOperation[],
    nextPendingOperations: TextOperation[],
    nextRemoteContent: string,
    nextEditorContent: string,
    expectedChange?: ObservedTextChange,
};

function cloneOperation(operation: TextOperation): TextOperation {
    if (typeof operation.i === 'string' && operation.d === undefined) {
        return {p: operation.p, i: operation.i};
    }
    if (typeof operation.d === 'string' && operation.i === undefined) {
        return {p: operation.p, d: operation.d};
    }
    throw new Error('Invalid realtime editor operation');
}

function isHighSurrogate(codeUnit: number): boolean {
    return codeUnit >= 0xD800 && codeUnit <= 0xDBFF;
}

function isLowSurrogate(codeUnit: number): boolean {
    return codeUnit >= 0xDC00 && codeUnit <= 0xDFFF;
}

export function isWellFormedUtf16(text: string): boolean {
    for (let index = 0; index < text.length; index += 1) {
        const codeUnit = text.charCodeAt(index);
        if (isHighSurrogate(codeUnit)) {
            if (index + 1 >= text.length || !isLowSurrogate(text.charCodeAt(index + 1))) {
                return false;
            }
            index += 1;
        } else if (isLowSurrogate(codeUnit)) {
            return false;
        }
    }
    return true;
}

function splitsSurrogatePair(text: string, offset: number): boolean {
    return offset > 0
        && offset < text.length
        && isHighSurrogate(text.charCodeAt(offset - 1))
        && isLowSurrogate(text.charCodeAt(offset));
}

/** Validate every sequential operation against UTF-16 code-point boundaries. */
export function applyUtf16TextOperations(
    content: string,
    operations: readonly TextOperation[],
): string {
    if (!isWellFormedUtf16(content)) {
        throw new Error('Realtime editor content is not well-formed UTF-16');
    }
    let current = content;
    for (const operation of operations) {
        if (!Number.isSafeInteger(operation.p)
            || operation.p < 0
            || operation.p > current.length
            || splitsSurrogatePair(current, operation.p)) {
            throw new Error('Realtime editor operation splits a UTF-16 character boundary');
        }
        const inserted = operation.i;
        const deleted = operation.d;
        if (inserted !== undefined && !isWellFormedUtf16(inserted)) {
            throw new Error('Realtime editor insertion is not well-formed UTF-16');
        }
        if (deleted !== undefined) {
            const end = operation.p + deleted.length;
            if (!isWellFormedUtf16(deleted)
                || end > current.length
                || splitsSurrogatePair(current, end)) {
                throw new Error('Realtime editor deletion splits a UTF-16 character boundary');
            }
        }
        current = applyTextOperations(current, [cloneOperation(operation)]);
        if (!isWellFormedUtf16(current)) {
            throw new Error('Realtime editor operation produced malformed UTF-16');
        }
    }
    return current;
}

function cloneState(state: RealtimeEditorBridgeState): RealtimeEditorBridgeState {
    return {
        ...state,
        inflightWire: state.inflightWire?.map(cloneOperation),
        inflightView: state.inflightView?.map(cloneOperation),
        pendingOperations: state.pendingOperations.map(cloneOperation),
        localOperations: state.localOperations.map(cloneOperation),
    };
}

function sameOperations(
    left: readonly TextOperation[],
    right: readonly TextOperation[],
): boolean {
    return left.length === right.length && left.every((operation, index) => {
        const other = right[index];
        return operation.p === other.p
            && operation.i === other.i
            && operation.d === other.d;
    });
}

function combinedLocalOperations(
    inflightView: readonly TextOperation[] | undefined,
    pending: readonly TextOperation[],
): TextOperation[] {
    return [
        ...(inflightView ?? []).map(cloneOperation),
        ...pending.map(cloneOperation),
    ];
}

function hasExactLocalState(state: RealtimeEditorBridgeState): boolean {
    if ((state.inflightWire === undefined) !== (state.inflightView === undefined)) {
        return false;
    }
    if ((state.inflightWire === undefined) !== (state.inflightToken === undefined)) {
        return false;
    }
    const combined = combinedLocalOperations(state.inflightView, state.pendingOperations);
    if (!sameOperations(state.localOperations, combined)) { return false; }
    try {
        return applyUtf16TextOperations(state.remoteContent, combined) === state.editorContent;
    } catch {
        return false;
    }
}

export function createRealtimeEditorBridgeState(input: Omit<
    RealtimeEditorBridgeState,
    | 'inflightWire'
    | 'inflightToken'
    | 'inflightView'
    | 'pendingOperations'
    | 'localOperations'
    | 'valid'
>): RealtimeEditorBridgeState {
    if (!Number.isSafeInteger(input.socketGeneration)
        || input.socketGeneration < 0
        || !input.remoteEpoch
        || !Number.isSafeInteger(input.remoteVersion)
        || input.remoteVersion < 0
        || !Number.isSafeInteger(input.documentVersion)
        || input.documentVersion < 0
        || input.remoteContent !== input.editorContent
        || !isWellFormedUtf16(input.remoteContent)) {
        throw new Error('Realtime editor bridge requires one exact UTF-16 base');
    }
    return {...input, pendingOperations: [], localOperations: [], valid: true};
}

export function recordLocalEditorChange(
    stateInput: RealtimeEditorBridgeState,
    documentVersion: number,
    changes: readonly ObservedTextChange[],
    editorContent: string,
): RealtimeEditorBridgeState {
    const state = cloneState(stateInput);
    if (!state.valid
        || documentVersion !== state.documentVersion + 1
        || !isWellFormedUtf16(editorContent)) {
        return {...state, documentVersion, editorContent, valid: false};
    }
    const operations = operationsFromObservedTextChanges(
        state.editorContent,
        changes,
        editorContent,
    );
    if (!operations) {
        return {...state, documentVersion, editorContent, valid: false};
    }
    try {
        const next = applyUtf16TextOperations(state.editorContent, operations);
        if (next !== editorContent) {
            return {...state, documentVersion, editorContent, valid: false};
        }
        const pendingOperations = [
            ...state.pendingOperations,
            ...operations.map(cloneOperation),
        ];
        const localOperations = combinedLocalOperations(state.inflightView, pendingOperations);
        if (applyUtf16TextOperations(state.remoteContent, localOperations) !== editorContent) {
            return {...state, documentVersion, editorContent, valid: false};
        }
        return {
            ...state,
            documentVersion,
            editorContent,
            pendingOperations,
            localOperations,
        };
    } catch {
        return {...state, documentVersion, editorContent, valid: false};
    }
}

export interface LegacyLocalOperationState {
    /** Exact operation already sent on the wire. It is immutable until ACK/recovery. */
    readonly inflightWire?: readonly TextOperation[],
    /** Rebased local view of the in-flight operation. */
    readonly inflightView?: readonly TextOperation[],
    /** Local operations captured after the in-flight operation was sent. */
    readonly pending: readonly TextOperation[],
}

export interface LegacyRemoteTransformResult {
    readonly serverContent: string,
    readonly visibleContent: string,
    readonly editorOperations: readonly TextOperation[],
    readonly inflightWire?: readonly TextOperation[],
    readonly inflightView?: readonly TextOperation[],
    readonly pending: readonly TextOperation[],
}

/**
 * Transform one causally-next server operation through an immutable sent wire
 * operation and any later local input. Only the local view is rebased.
 */
export function transformLegacyRemoteOperation(
    serverContent: string,
    remoteInput: readonly TextOperation[],
    local: LegacyLocalOperationState,
): LegacyRemoteTransformResult {
    const remote = remoteInput.map(cloneOperation);
    const inflightWire = local.inflightWire?.map(cloneOperation);
    let inflightView = local.inflightView?.map(cloneOperation);
    let pending = local.pending.map(cloneOperation);
    if ((inflightWire === undefined) !== (inflightView === undefined)) {
        throw new Error('Legacy OT in-flight wire/view state is incomplete');
    }

    const visibleBefore = applyUtf16TextOperations(
        applyUtf16TextOperations(serverContent, inflightView ?? []),
        pending,
    );
    const serverAfter = applyUtf16TextOperations(serverContent, remote);
    let editorOperations = remote;
    if (inflightView) {
        [editorOperations, inflightView] = transformOperationPair(
            editorOperations,
            inflightView,
        );
    }
    [editorOperations, pending] = transformOperationPair(editorOperations, pending);

    const visibleFromEditor = applyUtf16TextOperations(visibleBefore, editorOperations);
    const visibleFromServer = applyUtf16TextOperations(
        applyUtf16TextOperations(serverAfter, inflightView ?? []),
        pending,
    );
    if (visibleFromEditor !== visibleFromServer) {
        throw new Error('Legacy OT remote/local transform failed its convergence witness');
    }
    return {
        serverContent: serverAfter,
        visibleContent: visibleFromEditor,
        editorOperations,
        inflightWire,
        inflightView,
        pending,
    };
}

export interface HistoryLocalOperationState {
    readonly inflightWire?: HistoryOtOperationsInput,
    readonly inflightView?: HistoryOtOperationsInput,
    readonly pending?: HistoryOtOperationsInput,
}

export interface HistoryRemoteTransformResult {
    readonly serverSnapshot: ParsedHistoryOtSnapshot,
    readonly visibleSnapshot: ParsedHistoryOtSnapshot,
    readonly editorOperations: ParsedHistoryOtOperations,
    readonly inflightWire?: HistoryOtOperationsInput,
    readonly inflightView?: ParsedHistoryOtOperations,
    readonly pending?: ParsedHistoryOtOperations,
}

/** History-OT counterpart of transformLegacyRemoteOperation. */
export function transformHistoryRemoteOperation(
    serverSnapshot: HistoryOtSnapshotInput,
    remoteInput: HistoryOtOperationsInput,
    local: HistoryLocalOperationState,
): HistoryRemoteTransformResult {
    if ((local.inflightWire === undefined) !== (local.inflightView === undefined)) {
        throw new Error('History OT in-flight wire/view state is incomplete');
    }
    const inflightWire = local.inflightWire === undefined ?
        undefined : parseHistoryOtOperations(serializeHistoryOtOperations(local.inflightWire));
    let editorOperations = parseHistoryOtOperations(serializeHistoryOtOperations(remoteInput));
    let inflightView: ParsedHistoryOtOperations | undefined;
    let pending: ParsedHistoryOtOperations | undefined;
    let localBase: HistoryOtSnapshotInput = serverSnapshot;
    if (local.inflightView !== undefined) {
        [editorOperations, inflightView] = transformHistoryOtOperationsWithSnapshot(
            localBase,
            editorOperations,
            local.inflightView,
        );
        localBase = applyHistoryOtOperations(localBase, local.inflightView);
    }
    if (local.pending !== undefined) {
        [editorOperations, pending] = transformHistoryOtOperationsWithSnapshot(
            localBase,
            editorOperations,
            local.pending,
        );
    }

    const visibleBefore = applyHistoryOtOperations(
        applyHistoryOtOperations(serverSnapshot, local.inflightView ?? []),
        local.pending ?? [],
    );
    const serverAfter = applyHistoryOtOperations(serverSnapshot, remoteInput);
    const visibleFromEditor = applyHistoryOtOperations(visibleBefore, editorOperations);
    const visibleFromServer = applyHistoryOtOperations(
        applyHistoryOtOperations(serverAfter, inflightView ?? []),
        pending ?? [],
    );
    if (!historyOtJsonEqual(visibleFromEditor.raw, visibleFromServer.raw)) {
        throw new Error('History OT remote/local transform failed its convergence witness');
    }
    return {
        serverSnapshot: serverAfter,
        visibleSnapshot: visibleFromEditor,
        editorOperations,
        inflightWire,
        inflightView,
        pending,
    };
}

export type HistoryEditorWriteDescriptor =
    | {readonly kind: 'plain-write'}
    | {
        readonly kind: 'tracked-write',
        readonly tracking: HistoryOtTrackingInput,
    };

export interface HistorySenderCommitWitness {
    readonly submissionToken: string,
    readonly acknowledgedBaseVersion: number,
    readonly committedVersion: number,
    readonly predictedRemoteSnapshot: ParsedHistoryOtSnapshot,
    readonly wire: ParsedHistoryOtOperations,
    readonly writeDescriptor: HistoryEditorWriteDescriptor,
}

export interface HistoryRealtimeEditorBridgeState extends HistoryLocalOperationState {
    readonly socketGeneration: number,
    readonly remoteEpoch: string,
    readonly remoteVersion: number,
    readonly remoteSnapshot: ParsedHistoryOtSnapshot,
    readonly documentVersion: number,
    readonly editorContent: string,
    readonly inflightToken?: string,
    readonly inflightBaseVersion?: number,
    readonly inflightWriteDescriptor?: HistoryEditorWriteDescriptor,
    readonly pendingWriteDescriptor?: HistoryEditorWriteDescriptor,
    readonly authority: 'ready' | 'rejoin-required',
    readonly senderCommitWitness?: HistorySenderCommitWitness,
    readonly valid: boolean,
}

export interface HistoryRemoteEditorTransaction {
    readonly token: string,
    readonly socketGeneration: number,
    readonly remoteEpoch: string,
    readonly baseRemoteVersion: number,
    readonly nextRemoteVersion: number,
    readonly beforeDocumentVersion: number,
    readonly beforeEditorContent: string,
    readonly transformed: HistoryRemoteTransformResult,
    readonly expectedChange?: ObservedTextChange,
}

function cloneHistoryOperations(
    operations: HistoryOtOperationsInput | undefined,
): ParsedHistoryOtOperations | undefined {
    return operations === undefined ? undefined : parseHistoryOtOperations(
        serializeHistoryOtOperations(operations),
    );
}

function cloneHistorySnapshot(snapshot: HistoryOtSnapshotInput): ParsedHistoryOtSnapshot {
    return parseHistoryOtSnapshot(serializeHistoryOtSnapshot(snapshot));
}

function cloneWriteDescriptor(
    descriptor: HistoryEditorWriteDescriptor | undefined,
): HistoryEditorWriteDescriptor | undefined {
    if (descriptor === undefined || descriptor.kind === 'plain-write') {
        return descriptor;
    }
    return {
        kind: 'tracked-write',
        tracking: {...descriptor.tracking},
    };
}

function normalizeWriteDescriptor(
    descriptor: HistoryEditorWriteDescriptor | undefined,
): HistoryEditorWriteDescriptor {
    if (descriptor === undefined || descriptor.kind === 'plain-write') {
        return {kind: 'plain-write'};
    }
    const {userId, ts} = descriptor.tracking;
    if (typeof userId !== 'string' || userId.length === 0 || typeof ts !== 'string') {
        throw new Error('History OT tracked writes require an exact user and timestamp');
    }
    return {
        kind: 'tracked-write',
        tracking: {userId, ts: normalizeHistoryOtTimestamp(ts)},
    };
}

function sameWriteDescriptor(
    left: HistoryEditorWriteDescriptor | undefined,
    right: HistoryEditorWriteDescriptor | undefined,
): boolean {
    if (left === undefined || right === undefined) { return left === right; }
    if (left.kind !== right.kind) { return false; }
    return left.kind === 'plain-write'
        || (right.kind === 'tracked-write'
            && left.tracking.userId === right.tracking.userId
            && left.tracking.ts === right.tracking.ts);
}

function cloneSenderCommitWitness(
    witness: HistorySenderCommitWitness | undefined,
): HistorySenderCommitWitness | undefined {
    return witness === undefined ? undefined : {
        ...witness,
        predictedRemoteSnapshot: cloneHistorySnapshot(witness.predictedRemoteSnapshot),
        wire: cloneHistoryOperations(witness.wire)!,
        writeDescriptor: cloneWriteDescriptor(witness.writeDescriptor)!,
    };
}

function cloneHistoryState(
    state: HistoryRealtimeEditorBridgeState,
): HistoryRealtimeEditorBridgeState {
    return {
        ...state,
        remoteSnapshot: cloneHistorySnapshot(state.remoteSnapshot),
        inflightWire: cloneHistoryOperations(state.inflightWire),
        inflightView: cloneHistoryOperations(state.inflightView),
        pending: cloneHistoryOperations(state.pending),
        inflightWriteDescriptor: cloneWriteDescriptor(state.inflightWriteDescriptor),
        pendingWriteDescriptor: cloneWriteDescriptor(state.pendingWriteDescriptor),
        senderCommitWitness: cloneSenderCommitWitness(state.senderCommitWitness),
    };
}

function historyVisibleSnapshot(
    state: HistoryRealtimeEditorBridgeState,
): ParsedHistoryOtSnapshot {
    if (state.authority === 'rejoin-required') {
        if (state.senderCommitWitness === undefined) {
            throw new Error('History OT editor bridge lost its sender commit witness');
        }
        return applyHistoryOtOperations(
            state.senderCommitWitness.predictedRemoteSnapshot,
            state.pending ?? [],
        );
    }
    return applyHistoryOtOperations(
        applyHistoryOtOperations(state.remoteSnapshot, state.inflightView ?? []),
        state.pending ?? [],
    );
}

function hasExactHistoryState(state: HistoryRealtimeEditorBridgeState): boolean {
    const hasInflight = state.inflightWire !== undefined;
    if (hasInflight !== (state.inflightView !== undefined)
        || hasInflight !== (state.inflightToken !== undefined)
        || hasInflight !== (state.inflightBaseVersion !== undefined)
        || hasInflight !== (state.inflightWriteDescriptor !== undefined)
        || (state.pending !== undefined) !== (state.pendingWriteDescriptor !== undefined)
        || (state.authority === 'ready') !== (state.senderCommitWitness === undefined)
        || (state.authority === 'rejoin-required' && hasInflight)) {
        return false;
    }
    try {
        const visible = historyVisibleSnapshot(state);
        return visible.safe
            && getVisibleHistoryOtText(visible) === state.editorContent
            && isWellFormedUtf16(state.editorContent);
    } catch {
        return false;
    }
}

export function createHistoryRealtimeEditorBridgeState(input: {
    socketGeneration: number,
    remoteEpoch: string,
    remoteVersion: number,
    remoteSnapshot: HistoryOtSnapshotInput,
    documentVersion: number,
    editorContent: string,
}): HistoryRealtimeEditorBridgeState {
    const remoteSnapshot = cloneHistorySnapshot(input.remoteSnapshot);
    const visible = getVisibleHistoryOtText(remoteSnapshot);
    if (!remoteSnapshot.safe
        || !Number.isSafeInteger(input.socketGeneration)
        || input.socketGeneration < 0
        || !input.remoteEpoch
        || !Number.isSafeInteger(input.remoteVersion)
        || input.remoteVersion < 0
        || !Number.isSafeInteger(input.documentVersion)
        || input.documentVersion < 0
        || input.editorContent !== visible
        || !isWellFormedUtf16(visible)) {
        throw new Error('History OT editor bridge requires one exact UTF-16 base');
    }
    return {
        ...input,
        remoteSnapshot,
        authority: 'ready',
        valid: true,
    };
}

export function recordHistoryLocalEditorChange(
    stateInput: HistoryRealtimeEditorBridgeState,
    documentVersion: number,
    changes: readonly ObservedTextChange[],
    editorContent: string,
    descriptorInput?: HistoryEditorWriteDescriptor,
): HistoryRealtimeEditorBridgeState {
    const state = cloneHistoryState(stateInput);
    const senderCommitWitness = state.senderCommitWitness;
    let descriptor: HistoryEditorWriteDescriptor;
    try {
        descriptor = normalizeWriteDescriptor(descriptorInput);
    } catch {
        return {...state, documentVersion, editorContent, valid: false};
    }
    if (!state.valid
        || (state.authority !== 'ready' && state.authority !== 'rejoin-required')
        || (state.authority === 'rejoin-required' && senderCommitWitness === undefined)
        || !hasExactHistoryState(state)
        || documentVersion !== state.documentVersion + 1
        || !isWellFormedUtf16(editorContent)
        || (state.inflightWriteDescriptor !== undefined
            && !sameWriteDescriptor(state.inflightWriteDescriptor, descriptor))
        || (state.pendingWriteDescriptor !== undefined
            && !sameWriteDescriptor(state.pendingWriteDescriptor, descriptor))) {
        return {...state, documentVersion, editorContent, valid: false};
    }
    const operations = operationsFromObservedTextChanges(
        state.editorContent,
        changes,
        editorContent,
    );
    if (!operations || operations.length === 0) {
        return {...state, documentVersion, editorContent, valid: false};
    }
    try {
        const visibleBefore = historyVisibleSnapshot(state);
        const prepared = prepareHistoryOtDocumentUpdate(
            visibleBefore,
            state.editorContent,
            editorContent,
            operations,
            descriptor.kind === 'tracked-write' ? descriptor.tracking : undefined,
        );
        if (!prepared.mergeApplied || prepared.operation === undefined) {
            return {...state, documentVersion, editorContent, valid: false};
        }
        let pendingBase: ParsedHistoryOtSnapshot;
        if (state.authority === 'rejoin-required') {
            if (senderCommitWitness === undefined) {
                return {...state, documentVersion, editorContent, valid: false};
            }
            pendingBase = senderCommitWitness.predictedRemoteSnapshot;
        } else {
            pendingBase = applyHistoryOtOperations(
                state.remoteSnapshot,
                state.inflightView ?? [],
            );
        }
        const pending = state.pending === undefined
            ? cloneHistoryOperations(prepared.operation)!
            : composeHistoryOtOperationsWithSnapshot(
                pendingBase,
                state.pending,
                prepared.operation,
            );
        const expected = applyHistoryOtOperations(visibleBefore, prepared.operation);
        const actual = applyHistoryOtOperations(pendingBase, pending);
        if (!historyOtJsonEqual(expected.raw, actual.raw)
            || getVisibleHistoryOtText(actual) !== editorContent) {
            return {...state, documentVersion, editorContent, valid: false};
        }
        return {
            ...state,
            documentVersion,
            editorContent,
            pending,
            pendingWriteDescriptor: cloneWriteDescriptor(descriptor),
        };
    } catch {
        return {...state, documentVersion, editorContent, valid: false};
    }
}

/**
 * Rebind exact unsent operations to one freshly-authoritative clean base.
 * The returned state is invalid unless the operations reproduce editorContent.
 */
export function rebindLocalEditorPendingOperations(
    stateInput: RealtimeEditorBridgeState,
    documentVersion: number,
    editorContent: string,
    operationsInput: readonly TextOperation[],
): RealtimeEditorBridgeState {
    const state = cloneState(stateInput);
    let operations: TextOperation[];
    try {
        operations = operationsInput.map(cloneOperation);
    } catch {
        return {...state, documentVersion, editorContent, valid: false};
    }
    if (!state.valid
        || !hasExactLocalState(state)
        || state.inflightWire !== undefined
        || state.pendingOperations.length !== 0
        || documentVersion !== state.documentVersion
        || operations.length === 0) {
        return {...state, documentVersion, editorContent, valid: false};
    }
    const next: RealtimeEditorBridgeState = {
        ...state,
        documentVersion,
        editorContent,
        pendingOperations: operations.map(cloneOperation),
        localOperations: operations.map(cloneOperation),
    };
    return hasExactLocalState(next) ? next : {...next, valid: false};
}

export function prepareHistoryRemoteEditorTransaction(
    stateInput: HistoryRealtimeEditorBridgeState,
    token: string,
    remoteVersion: number,
    remoteOperations: HistoryOtOperationsInput,
): HistoryRemoteEditorTransaction {
    const state = cloneHistoryState(stateInput);
    if (!state.valid
        || state.authority !== 'ready'
        || !token
        || remoteVersion !== state.remoteVersion
        || !Number.isSafeInteger(remoteVersion + 1)
        || !hasExactHistoryState(state)) {
        throw new Error('History OT editor bridge has no exact remote/local base');
    }
    const transformed = transformHistoryRemoteOperation(
        state.remoteSnapshot,
        remoteOperations,
        state,
    );
    const nextEditorContent = getVisibleHistoryOtText(transformed.visibleSnapshot);
    if (!historyOtJsonEqual(
        applyHistoryOtOperations(state.remoteSnapshot, remoteOperations).raw,
        transformed.serverSnapshot.raw,
    ) || !historyOtJsonEqual(
        applyHistoryOtOperations(historyVisibleSnapshot(state), transformed.editorOperations).raw,
        transformed.visibleSnapshot.raw,
    ) || !historyOtJsonEqual(
        serializeHistoryOtOperations(transformed.inflightWire ?? []),
        serializeHistoryOtOperations(state.inflightWire ?? []),
    )) {
        throw new Error('History OT editor transaction failed its exact snapshot witness');
    }
    return {
        token,
        socketGeneration: state.socketGeneration,
        remoteEpoch: state.remoteEpoch,
        baseRemoteVersion: state.remoteVersion,
        nextRemoteVersion: state.remoteVersion + 1,
        beforeDocumentVersion: state.documentVersion,
        beforeEditorContent: state.editorContent,
        transformed,
        expectedChange: oneReplacement(state.editorContent, nextEditorContent),
    };
}

export function commitHistoryRemoteEditorTransaction(
    stateInput: HistoryRealtimeEditorBridgeState,
    transaction: HistoryRemoteEditorTransaction,
    documentVersion: number,
    changes: readonly ObservedTextChange[],
    editorContent: string,
): HistoryRealtimeEditorBridgeState {
    const state = cloneHistoryState(stateInput);
    const expectedChanges = transaction.expectedChange ? [transaction.expectedChange] : [];
    const nextEditorContent = getVisibleHistoryOtText(transaction.transformed.visibleSnapshot);
    const matches = state.valid
        && state.authority === 'ready'
        && hasExactHistoryState(state)
        && transaction.socketGeneration === state.socketGeneration
        && transaction.remoteEpoch === state.remoteEpoch
        && transaction.baseRemoteVersion === state.remoteVersion
        && Number.isSafeInteger(transaction.nextRemoteVersion)
        && transaction.nextRemoteVersion > state.remoteVersion
        && transaction.beforeDocumentVersion === state.documentVersion
        && transaction.beforeEditorContent === state.editorContent
        && documentVersion === state.documentVersion + (transaction.expectedChange ? 1 : 0)
        && changes.length === expectedChanges.length
        && changes.every((change, index) => sameChange(change, expectedChanges[index]))
        && editorContent === nextEditorContent
        && historyOtJsonEqual(
            serializeHistoryOtOperations(transaction.transformed.inflightWire ?? []),
            serializeHistoryOtOperations(state.inflightWire ?? []),
        );
    if (!matches) {
        return {...state, documentVersion, editorContent, valid: false};
    }
    const next: HistoryRealtimeEditorBridgeState = {
        ...state,
        remoteVersion: transaction.nextRemoteVersion,
        remoteSnapshot: cloneHistorySnapshot(transaction.transformed.serverSnapshot),
        documentVersion,
        editorContent,
        inflightView: cloneHistoryOperations(transaction.transformed.inflightView),
        pending: cloneHistoryOperations(transaction.transformed.pending),
    };
    return hasExactHistoryState(next) ? next : {...next, valid: false};
}

/**
 * Commit a provider-driven refresh for an exact clean History editor. VS Code
 * and Cursor are free to report the reload as a line replacement, a full
 * setValue, or no individual changes, and may advance the document version by
 * more than one. The final buffer and every causal/authority witness must still
 * match exactly. Dirty WorkspaceEdit feedback continues to use the stricter
 * commitHistoryRemoteEditorTransaction contract above.
 */
export function commitHistoryCleanRemoteEditorTransaction(
    stateInput: HistoryRealtimeEditorBridgeState,
    transaction: HistoryRemoteEditorTransaction,
    documentVersion: number,
    editorContent: string,
): HistoryRealtimeEditorBridgeState {
    const state = cloneHistoryState(stateInput);
    const nextEditorContent = getVisibleHistoryOtText(transaction.transformed.visibleSnapshot);
    const matches = state.valid
        && state.authority === 'ready'
        && hasExactHistoryState(state)
        && transaction.token.length > 0
        && transaction.socketGeneration === state.socketGeneration
        && transaction.remoteEpoch === state.remoteEpoch
        && transaction.baseRemoteVersion === state.remoteVersion
        && Number.isSafeInteger(transaction.nextRemoteVersion)
        && transaction.nextRemoteVersion > state.remoteVersion
        && transaction.beforeDocumentVersion === state.documentVersion
        && transaction.beforeEditorContent === state.editorContent
        && Number.isSafeInteger(documentVersion)
        && documentVersion > state.documentVersion
        && editorContent === nextEditorContent
        && state.inflightWire === undefined
        && state.inflightView === undefined
        && state.inflightToken === undefined
        && state.inflightBaseVersion === undefined
        && state.inflightWriteDescriptor === undefined
        && state.pending === undefined
        && state.pendingWriteDescriptor === undefined
        && transaction.transformed.inflightWire === undefined
        && transaction.transformed.inflightView === undefined
        && transaction.transformed.pending === undefined;
    if (!matches) {
        return {...state, documentVersion, editorContent, valid: false};
    }
    const next: HistoryRealtimeEditorBridgeState = {
        ...state,
        remoteVersion: transaction.nextRemoteVersion,
        remoteSnapshot: cloneHistorySnapshot(transaction.transformed.serverSnapshot),
        documentVersion,
        editorContent,
    };
    return hasExactHistoryState(next) ? next : {...next, valid: false};
}

/**
 * Prepare one exact editor transaction for a continuous, already-witnessed
 * sequence of remote History revisions. The caller proves revision continuity;
 * this helper proves that their composition reaches the exact fresh-join
 * snapshot while converging with the local editor projection.
 */
export function prepareHistoryRemoteEditorCatchupTransaction(
    state: HistoryRealtimeEditorBridgeState,
    token: string,
    nextRemoteVersion: number,
    remoteOperations: HistoryOtOperationsInput,
    nextRemoteSnapshot: HistoryOtSnapshotInput,
): HistoryRemoteEditorTransaction {
    if (!Number.isSafeInteger(nextRemoteVersion)
        || nextRemoteVersion <= state.remoteVersion) {
        throw new Error('History OT catch-up requires a later exact remote revision');
    }
    const transaction = prepareHistoryRemoteEditorTransaction(
        state,
        token,
        state.remoteVersion,
        remoteOperations,
    );
    const expected = cloneHistorySnapshot(nextRemoteSnapshot);
    if (!historyOtJsonEqual(transaction.transformed.serverSnapshot.raw, expected.raw)) {
        throw new Error('History OT catch-up does not reach the exact fresh-join snapshot');
    }
    return {...transaction, nextRemoteVersion};
}

export function beginHistorySubmission(
    stateInput: HistoryRealtimeEditorBridgeState,
    submissionToken: string,
    wireInput: HistoryOtOperationsInput,
    descriptorInput?: HistoryEditorWriteDescriptor,
): HistoryRealtimeEditorBridgeState {
    const state = cloneHistoryState(stateInput);
    const descriptor = normalizeWriteDescriptor(descriptorInput);
    const wire = cloneHistoryOperations(wireInput)!;
    const wireRaw = serializeHistoryOtOperations(wire);
    if (!state.valid
        || state.authority !== 'ready'
        || !hasExactHistoryState(state)
        || state.inflightWire !== undefined
        || !submissionToken
        || state.pending === undefined
        || !sameWriteDescriptor(state.pendingWriteDescriptor, descriptor)
        || !Array.isArray(wireRaw)
        || wireRaw.length !== 1
        || !historyOtJsonEqual(wireRaw, serializeHistoryOtOperations(state.pending))) {
        throw new Error('History OT editor bridge cannot bind this exact submission');
    }
    return {
        ...state,
        inflightWire: cloneHistoryOperations(wire),
        inflightView: cloneHistoryOperations(wire),
        inflightToken: submissionToken,
        inflightBaseVersion: state.remoteVersion,
        inflightWriteDescriptor: cloneWriteDescriptor(descriptor),
        pending: undefined,
        pendingWriteDescriptor: undefined,
    };
}

/** Restore a definitely-unapplied rebased operation ahead of later local input. */
export function rejectHistorySubmission(
    stateInput: HistoryRealtimeEditorBridgeState,
    submissionToken: string,
): HistoryRealtimeEditorBridgeState {
    const state = cloneHistoryState(stateInput);
    if (!state.valid
        || state.authority !== 'ready'
        || !hasExactHistoryState(state)
        || state.inflightWire === undefined
        || state.inflightView === undefined
        || state.inflightToken !== submissionToken
        || state.inflightWriteDescriptor === undefined
        || (state.pendingWriteDescriptor !== undefined
            && !sameWriteDescriptor(
                state.inflightWriteDescriptor,
                state.pendingWriteDescriptor,
            ))) {
        return {...state, valid: false};
    }
    try {
        const pending = state.pending === undefined
            ? cloneHistoryOperations(state.inflightView)!
            : composeHistoryOtOperationsWithSnapshot(
                state.remoteSnapshot,
                state.inflightView,
                state.pending,
            );
        const expected = historyVisibleSnapshot(state);
        const actual = applyHistoryOtOperations(state.remoteSnapshot, pending);
        if (!historyOtJsonEqual(expected.raw, actual.raw)
            || getVisibleHistoryOtText(actual) !== state.editorContent) {
            return {...state, valid: false};
        }
        return {
            ...state,
            inflightWire: undefined,
            inflightView: undefined,
            inflightToken: undefined,
            inflightBaseVersion: undefined,
            inflightWriteDescriptor: undefined,
            pending,
            pendingWriteDescriptor: cloneWriteDescriptor(state.inflightWriteDescriptor),
        };
    } catch {
        return {...state, valid: false};
    }
}

/**
 * Rebind an outcome-unknown submission to one new socket session. A fresh join
 * is accepted only when it proves either that the frozen wire was not applied,
 * or that exactly its rebased view was applied and only the sender ACK was lost.
 */
export function rebindHistorySubmissionForRecovery(
    stateInput: HistoryRealtimeEditorBridgeState,
    input: {
        socketGeneration: number,
        remoteEpoch: string,
        submissionToken: string,
        joinVersion: number,
        joinSnapshot: HistoryOtSnapshotInput,
        documentVersion: number,
        editorContent: string,
    },
): HistoryRealtimeEditorBridgeState {
    const state = cloneHistoryState(stateInput);
    let joinSnapshot: ParsedHistoryOtSnapshot;
    try {
        joinSnapshot = cloneHistorySnapshot(input.joinSnapshot);
    } catch {
        return {...state, valid: false};
    }
    if (!state.valid
        || state.authority !== 'ready'
        || !hasExactHistoryState(state)
        || state.inflightWire === undefined
        || state.inflightView === undefined
        || state.inflightToken === undefined
        || state.inflightBaseVersion === undefined
        || state.inflightWriteDescriptor === undefined
        || state.remoteVersion !== state.inflightBaseVersion
        || !joinSnapshot.safe
        || !Number.isSafeInteger(input.socketGeneration)
        || input.socketGeneration <= state.socketGeneration
        || typeof input.remoteEpoch !== 'string'
        || !input.remoteEpoch
        || input.remoteEpoch === state.remoteEpoch
        || typeof input.submissionToken !== 'string'
        || !input.submissionToken
        || input.submissionToken === state.inflightToken
        || input.documentVersion !== state.documentVersion
        || input.editorContent !== state.editorContent) {
        return {...state, valid: false};
    }
    try {
        const unapplied = input.joinVersion === state.inflightBaseVersion
            && historyOtJsonEqual(joinSnapshot.raw, state.remoteSnapshot.raw);
        const predictedApplied = applyHistoryOtOperations(
            state.remoteSnapshot,
            state.inflightView,
        );
        const appliedWithoutAck = input.joinVersion === state.inflightBaseVersion + 1
            && historyOtJsonEqual(joinSnapshot.raw, predictedApplied.raw);
        if (!unapplied && !appliedWithoutAck) {
            return {...state, valid: false};
        }
        return {
            ...state,
            socketGeneration: input.socketGeneration,
            remoteEpoch: input.remoteEpoch,
            inflightToken: input.submissionToken,
        };
    } catch {
        return {...state, valid: false};
    }
}

/**
 * Record a sender ACK only as a prediction witness. The old remote snapshot is
 * deliberately retained and all further edits remain blocked until a fresh
 * authoritative join exactly confirms the prediction.
 */
export function acknowledgeHistorySubmission(
    stateInput: HistoryRealtimeEditorBridgeState,
    submissionToken: string,
    acknowledgedBaseVersion: number,
): HistoryRealtimeEditorBridgeState {
    const state = cloneHistoryState(stateInput);
    if (!state.valid
        || state.authority !== 'ready'
        || !hasExactHistoryState(state)
        || state.inflightWire === undefined
        || state.inflightView === undefined
        || state.inflightToken !== submissionToken
        || state.inflightBaseVersion === undefined
        || state.inflightWriteDescriptor === undefined
        || acknowledgedBaseVersion !== state.remoteVersion
        || !Number.isSafeInteger(acknowledgedBaseVersion + 1)) {
        return {...state, valid: false};
    }
    try {
        const predictedRemoteSnapshot = applyHistoryOtOperations(
            state.remoteSnapshot,
            state.inflightView,
        );
        const visible = applyHistoryOtOperations(
            predictedRemoteSnapshot,
            state.pending ?? [],
        );
        if (!historyOtJsonEqual(visible.raw, historyVisibleSnapshot(state).raw)
            || getVisibleHistoryOtText(visible) !== state.editorContent) {
            return {...state, valid: false};
        }
        const senderCommitWitness: HistorySenderCommitWitness = {
            submissionToken,
            acknowledgedBaseVersion,
            committedVersion: acknowledgedBaseVersion + 1,
            predictedRemoteSnapshot: cloneHistorySnapshot(predictedRemoteSnapshot),
            wire: cloneHistoryOperations(state.inflightWire)!,
            writeDescriptor: cloneWriteDescriptor(state.inflightWriteDescriptor)!,
        };
        return {
            ...state,
            inflightWire: undefined,
            inflightView: undefined,
            inflightToken: undefined,
            inflightBaseVersion: undefined,
            inflightWriteDescriptor: undefined,
            authority: 'rejoin-required',
            senderCommitWitness,
        };
    } catch {
        return {...state, valid: false};
    }
}

export function reconcileHistoryEditorAfterJoin(
    stateInput: HistoryRealtimeEditorBridgeState,
    input: {
        socketGeneration: number,
        remoteEpoch: string,
        remoteVersion: number,
        remoteSnapshot: HistoryOtSnapshotInput,
        documentVersion: number,
        editorContent: string,
    },
): HistoryRealtimeEditorBridgeState {
    const state = cloneHistoryState(stateInput);
    const remoteSnapshot = cloneHistorySnapshot(input.remoteSnapshot);
    const witness = state.senderCommitWitness;
    if (!state.valid
        || state.authority !== 'rejoin-required'
        || witness === undefined
        || !hasExactHistoryState(state)
        || !remoteSnapshot.safe
        || !Number.isSafeInteger(input.socketGeneration)
        || input.socketGeneration < 0
        || !input.remoteEpoch
        || input.remoteVersion !== witness.committedVersion
        || !Number.isSafeInteger(input.documentVersion)
        || input.documentVersion < 0
        || input.documentVersion !== state.documentVersion
        || input.editorContent !== state.editorContent
        || !historyOtJsonEqual(remoteSnapshot.raw, witness.predictedRemoteSnapshot.raw)) {
        return {...state, valid: false};
    }
    try {
        const visible = applyHistoryOtOperations(remoteSnapshot, state.pending ?? []);
        if (!historyOtJsonEqual(visible.raw, historyVisibleSnapshot(state).raw)
            || getVisibleHistoryOtText(visible) !== input.editorContent) {
            return {...state, valid: false};
        }
        const next: HistoryRealtimeEditorBridgeState = {
            ...state,
            socketGeneration: input.socketGeneration,
            remoteEpoch: input.remoteEpoch,
            remoteVersion: input.remoteVersion,
            remoteSnapshot,
            documentVersion: input.documentVersion,
            editorContent: input.editorContent,
            authority: 'ready',
            senderCommitWitness: undefined,
        };
        return hasExactHistoryState(next) ? next : {...next, valid: false};
    } catch {
        return {...state, valid: false};
    }
}

/** Freeze exactly what is about to be sent while retaining a separate rebasable view. */
export function beginLocalEditorSubmission(
    stateInput: RealtimeEditorBridgeState,
    token: string,
    wireInput: readonly TextOperation[],
): RealtimeEditorBridgeState {
    const state = cloneState(stateInput);
    const wire = wireInput.map(cloneOperation);
    if (!state.valid
        || !hasExactLocalState(state)
        || state.inflightWire !== undefined
        || !token
        || wire.length === 0
        || !sameOperations(wire, state.pendingOperations)
        || applyUtf16TextOperations(state.remoteContent, wire) !== state.editorContent) {
        throw new Error('Realtime editor submission has no exact unsent local operation');
    }
    return {
        ...state,
        inflightWire: wire.map(cloneOperation),
        inflightToken: token,
        inflightView: wire.map(cloneOperation),
        pendingOperations: [],
        localOperations: wire.map(cloneOperation),
    };
}

/** Restore a known-rejected wire operation to the unsent local queue. */
export function rejectLocalEditorSubmission(
    stateInput: RealtimeEditorBridgeState,
    token: string,
    wireInput: readonly TextOperation[],
): RealtimeEditorBridgeState {
    const state = cloneState(stateInput);
    if (!state.valid
        || !hasExactLocalState(state)
        || !state.inflightWire
        || !state.inflightView
        || state.inflightToken !== token
        || !sameOperations(state.inflightWire, wireInput)) {
        return {...state, valid: false};
    }
    const pendingOperations = combinedLocalOperations(
        state.inflightView,
        state.pendingOperations,
    );
    return {
        ...state,
        inflightWire: undefined,
        inflightToken: undefined,
        inflightView: undefined,
        pendingOperations,
        localOperations: pendingOperations.map(cloneOperation),
    };
}

/** Consume the sender-only ACK without generating a synthetic editor change. */
export function confirmLocalEditorSubmission(
    stateInput: RealtimeEditorBridgeState,
    token: string,
    remoteVersion: number,
    wireInput: readonly TextOperation[],
): RealtimeEditorBridgeState {
    const state = cloneState(stateInput);
    if (!state.valid
        || !hasExactLocalState(state)
        || remoteVersion !== state.remoteVersion
        || !Number.isSafeInteger(remoteVersion + 1)
        || !state.inflightWire
        || !state.inflightView
        || state.inflightToken !== token
        || !sameOperations(state.inflightWire, wireInput)) {
        return {...state, valid: false};
    }
    try {
        const remoteContent = applyUtf16TextOperations(state.remoteContent, state.inflightView);
        if (applyUtf16TextOperations(remoteContent, state.pendingOperations) !== state.editorContent) {
            return {...state, valid: false};
        }
        return {
            ...state,
            remoteVersion: state.remoteVersion + 1,
            remoteContent,
            inflightWire: undefined,
            inflightToken: undefined,
            inflightView: undefined,
            localOperations: state.pendingOperations.map(cloneOperation),
        };
    } catch {
        return {...state, valid: false};
    }
}

function oneReplacement(before: string, after: string): ObservedTextChange | undefined {
    if (before === after) { return undefined; }
    let prefix = 0;
    while (prefix < before.length
        && prefix < after.length
        && before.charCodeAt(prefix) === after.charCodeAt(prefix)) {
        prefix += 1;
    }
    while (splitsSurrogatePair(before, prefix) || splitsSurrogatePair(after, prefix)) {
        prefix -= 1;
    }

    let beforeEnd = before.length;
    let afterEnd = after.length;
    while (beforeEnd > prefix
        && afterEnd > prefix
        && before.charCodeAt(beforeEnd - 1) === after.charCodeAt(afterEnd - 1)) {
        beforeEnd -= 1;
        afterEnd -= 1;
    }
    while (splitsSurrogatePair(before, beforeEnd) || splitsSurrogatePair(after, afterEnd)) {
        beforeEnd += 1;
        afterEnd += 1;
    }
    return {
        rangeOffset: prefix,
        rangeLength: beforeEnd - prefix,
        text: after.slice(prefix, afterEnd),
    };
}

/**
 * Derive one conservative replacement from two exact UTF-16 snapshots. This is
 * suitable only when the caller owns a read witness for `before`; it does not
 * infer ancestry from two otherwise unrelated strings.
 */
export function operationsFromContentSnapshots(
    before: string,
    after: string,
): TextOperation[] | undefined {
    if (!isWellFormedUtf16(before) || !isWellFormedUtf16(after)) { return undefined; }
    const replacement = oneReplacement(before, after);
    if (!replacement) { return before === after ? [] : undefined; }
    return operationsFromObservedTextChanges(before, [replacement], after);
}

export function prepareRemoteEditorTransaction(
    stateInput: RealtimeEditorBridgeState,
    token: string,
    remoteVersion: number,
    remoteOperationsInput: readonly TextOperation[],
): RemoteEditorTransaction {
    const state = cloneState(stateInput);
    if (!state.valid
        || !token
        || remoteVersion !== state.remoteVersion
        || !Number.isSafeInteger(remoteVersion + 1)
        || !hasExactLocalState(state)) {
        throw new Error('Realtime editor bridge has no exact remote/local base');
    }
    const remoteOperations = remoteOperationsInput.map(cloneOperation);
    applyUtf16TextOperations(state.remoteContent, remoteOperations);
    const transformed = transformLegacyRemoteOperation(
        state.remoteContent,
        remoteOperations,
        {
            inflightWire: state.inflightWire,
            inflightView: state.inflightView,
            pending: state.pendingOperations,
        },
    );
    const localAfterRemote = combinedLocalOperations(
        transformed.inflightView,
        transformed.pending,
    );
    if (applyUtf16TextOperations(state.editorContent, transformed.editorOperations)
            !== transformed.visibleContent
        || applyUtf16TextOperations(transformed.serverContent, localAfterRemote)
            !== transformed.visibleContent
        || !sameOperations(transformed.inflightWire ?? [], state.inflightWire ?? [])) {
        throw new Error('Realtime editor transform failed its convergence witness');
    }
    return {
        token,
        socketGeneration: state.socketGeneration,
        remoteEpoch: state.remoteEpoch,
        baseRemoteVersion: state.remoteVersion,
        beforeDocumentVersion: state.documentVersion,
        beforeEditorContent: state.editorContent,
        remoteOperations,
        remoteAfterLocal: transformed.editorOperations.map(cloneOperation),
        localAfterRemote,
        nextInflightView: transformed.inflightView?.map(cloneOperation),
        nextPendingOperations: transformed.pending.map(cloneOperation),
        nextRemoteContent: transformed.serverContent,
        nextEditorContent: transformed.visibleContent,
        expectedChange: oneReplacement(state.editorContent, transformed.visibleContent),
    };
}

function sameChange(left: ObservedTextChange, right: ObservedTextChange): boolean {
    return left.rangeOffset === right.rangeOffset
        && left.rangeLength === right.rangeLength
        && left.text === right.text;
}

/**
 * Consume exactly the one TextDocument change caused by a prepared remote edit.
 * Any extra/missing/mismatched change invalidates the bridge instead of being
 * mistaken for user input.
 */
export function commitRemoteEditorTransaction(
    stateInput: RealtimeEditorBridgeState,
    transaction: RemoteEditorTransaction,
    documentVersion: number,
    changes: readonly ObservedTextChange[],
    editorContent: string,
): RealtimeEditorBridgeState {
    const state = cloneState(stateInput);
    const expectedChanges = transaction.expectedChange ? [transaction.expectedChange] : [];
    const matches = state.valid
        && transaction.socketGeneration === state.socketGeneration
        && transaction.remoteEpoch === state.remoteEpoch
        && transaction.baseRemoteVersion === state.remoteVersion
        && transaction.beforeDocumentVersion === state.documentVersion
        && transaction.beforeEditorContent === state.editorContent
        && documentVersion === state.documentVersion + (transaction.expectedChange ? 1 : 0)
        && changes.length === expectedChanges.length
        && changes.every((change, index) => sameChange(change, expectedChanges[index]))
        && editorContent === transaction.nextEditorContent;
    if (!matches) {
        return {...state, documentVersion, editorContent, valid: false};
    }
    return {
        ...state,
        remoteVersion: state.remoteVersion + 1,
        remoteContent: transaction.nextRemoteContent,
        documentVersion,
        editorContent,
        inflightView: transaction.nextInflightView?.map(cloneOperation),
        pendingOperations: transaction.nextPendingOperations.map(cloneOperation),
        localOperations: transaction.localAfterRemote.map(cloneOperation),
    };
}
