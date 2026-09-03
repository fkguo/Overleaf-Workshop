import {
    applyTextOperations,
    ObservedTextChange,
    operationsFromObservedTextChanges,
    TextOperation,
    transformConcurrentTextOperations,
} from './documentUpdate';

export type RealtimeEditorBridgeState = {
    socketGeneration: number,
    remoteEpoch: string,
    remoteVersion: number,
    remoteContent: string,
    documentVersion: number,
    editorContent: string,
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
        localOperations: state.localOperations.map(cloneOperation),
    };
}

export function createRealtimeEditorBridgeState(input: Omit<
    RealtimeEditorBridgeState,
    'localOperations' | 'valid'
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
    return {...input, localOperations: [], valid: true};
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
        const localOperations = [...state.localOperations, ...operations.map(cloneOperation)];
        if (applyUtf16TextOperations(state.remoteContent, localOperations) !== editorContent) {
            return {...state, documentVersion, editorContent, valid: false};
        }
        return {...state, documentVersion, editorContent, localOperations};
    } catch {
        return {...state, documentVersion, editorContent, valid: false};
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
        || applyUtf16TextOperations(state.remoteContent, state.localOperations) !== state.editorContent) {
        throw new Error('Realtime editor bridge has no exact remote/local base');
    }
    const remoteOperations = remoteOperationsInput.map(cloneOperation);
    applyUtf16TextOperations(state.remoteContent, remoteOperations);
    const transformed = transformConcurrentTextOperations(
        state.remoteContent,
        remoteOperations,
        state.localOperations,
    );
    if (transformed.localContent !== state.editorContent
        || applyUtf16TextOperations(state.editorContent, transformed.remoteAfterLocal)
            !== transformed.mergedContent
        || applyUtf16TextOperations(transformed.remoteContent, transformed.localAfterRemote)
            !== transformed.mergedContent) {
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
        remoteAfterLocal: transformed.remoteAfterLocal.map(cloneOperation),
        localAfterRemote: transformed.localAfterRemote.map(cloneOperation),
        nextRemoteContent: transformed.remoteContent,
        nextEditorContent: transformed.mergedContent,
        expectedChange: oneReplacement(state.editorContent, transformed.mergedContent),
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
        localOperations: transaction.localAfterRemote.map(cloneOperation),
    };
}
