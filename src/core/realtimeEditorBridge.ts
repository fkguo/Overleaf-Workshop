import {
    applyTextOperations,
    ObservedTextChange,
    operationsFromObservedTextChanges,
    TextOperation,
    transformOperationPair,
} from './documentUpdate';
import {
    applyHistoryOtOperations,
    HistoryOtOperationsInput,
    HistoryOtSnapshotInput,
    parseHistoryOtOperations,
    ParsedHistoryOtOperations,
    ParsedHistoryOtSnapshot,
    serializeHistoryOtOperations,
    transformHistoryOtOperations,
} from './historyOt';

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
    if (local.inflightView !== undefined) {
        [editorOperations, inflightView] = transformHistoryOtOperations(
            editorOperations,
            local.inflightView,
        );
    }
    if (local.pending !== undefined) {
        [editorOperations, pending] = transformHistoryOtOperations(
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
    if (JSON.stringify(visibleFromEditor.raw) !== JSON.stringify(visibleFromServer.raw)) {
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
