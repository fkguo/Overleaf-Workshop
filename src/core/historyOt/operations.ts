import {
    HistoryOtAddCommentOperation,
    HistoryOtComment,
    HistoryOtDeleteCommentOperation,
    HistoryOtNoOperation,
    HistoryOtOperation,
    HistoryOtOperationArray,
    HistoryOtOperationsInput,
    HistoryOtSetCommentStateOperation,
    HistoryOtSnapshotInput,
    HistoryOtTextOperation,
    ParsedHistoryOtOperations,
    ParsedHistoryOtSnapshot,
    StringFileDataSnapshot,
} from './types';
import {
    deepCloneJson,
    getSafeOperationsRaw,
    getSafeSnapshotRaw,
    hasOwn,
    HistoryOtProtocolError,
    normalizeHistoryOtTimestamp,
    parseHistoryOtOperations,
    parseHistoryOtSnapshot,
} from './protocol';
import {
    composeTextOperations,
    decodeTextOperation,
    encodeTextOperation,
    transformTextOperations,
} from './text';
import {
    applyTextOperationToSnapshot,
    invertTextOperation,
    transformCommentThroughTextOperation,
} from './snapshot';

function clone<T>(value: T): T {
    return deepCloneJson(value) as T;
}

function operationKind(operation: HistoryOtOperation):
    'text' | 'add-comment' | 'delete-comment' | 'set-comment-state' | 'no-op' {
    if (hasOwn(operation, 'textOperation')) {
        return 'text';
    }
    if (hasOwn(operation, 'ranges')) {
        return 'add-comment';
    }
    if (hasOwn(operation, 'deleteComment')) {
        return 'delete-comment';
    }
    if (hasOwn(operation, 'commentId')) {
        return 'set-comment-state';
    }
    return 'no-op';
}

function asText(operation: HistoryOtOperation): HistoryOtTextOperation {
    return operation as HistoryOtTextOperation;
}

function asAdd(operation: HistoryOtOperation): HistoryOtAddCommentOperation {
    return operation as HistoryOtAddCommentOperation;
}

function asDelete(operation: HistoryOtOperation): HistoryOtDeleteCommentOperation {
    return operation as HistoryOtDeleteCommentOperation;
}

function asState(operation: HistoryOtOperation): HistoryOtSetCommentStateOperation {
    return operation as HistoryOtSetCommentStateOperation;
}

function noOperation(): HistoryOtNoOperation {
    return {noOp: true};
}

function hasTrackingDirective(operation: HistoryOtOperation): boolean {
    return operationKind(operation) === 'text'
        && asText(operation).textOperation.some(scan =>
            typeof scan === 'object' && scan !== null && hasOwn(scan, 'tracking'));
}

function assertSnapshotIndependentAlgebraDomain(
    operations: HistoryOtOperationArray,
    algebra: 'compose' | 'transform',
): void {
    if (operations.some(hasTrackingDirective)) {
        throw new HistoryOtProtocolError(
            'UNSUPPORTED_TRACKED_ALGEBRA',
            `History-OT ${algebra} cannot preserve authoritative tracking metadata without the base snapshot`,
        );
    }
}

function assertCommentTransformOrderDomain(
    left: HistoryOtOperationArray,
    right: HistoryOtOperationArray,
): void {
    const leftAdds = left.some(operation => operationKind(operation) === 'add-comment');
    const rightAdds = right.some(operation => operationKind(operation) === 'add-comment');
    if (leftAdds && rightAdds) {
        throw new HistoryOtProtocolError(
            'UNSUPPORTED_COMMENT_ORDER_TRANSFORM',
            'Concurrent add-comment operations cannot guarantee exact CommentList wire order',
        );
    }
}

function canonicalizeGeneratedOperation(operation: HistoryOtOperation): HistoryOtOperation {
    const kind = operationKind(operation);
    if (kind === 'text') {
        return encodeTextOperation(decodeTextOperation(asText(operation)));
    }
    const result = clone(operation);
    if (kind === 'add-comment' && asAdd(result).resolved !== true) {
        delete asAdd(result).resolved;
    }
    return result;
}

function commentFromAdd(operation: HistoryOtAddCommentOperation): HistoryOtComment {
    const comment: HistoryOtComment = {
        id: operation.commentId,
        ranges: clone(operation.ranges),
    };
    if (operation.resolved !== undefined) {
        comment.resolved = operation.resolved;
    }
    return comment;
}

function addFromComment(comment: HistoryOtComment): HistoryOtAddCommentOperation {
    const operation: HistoryOtAddCommentOperation = {
        commentId: comment.id,
        ranges: clone(comment.ranges),
    };
    if (comment.resolved === true) {
        operation.resolved = true;
    }
    return operation;
}

function canonicalizeAppliedSnapshot(snapshot: StringFileDataSnapshot): StringFileDataSnapshot {
    const result = clone(snapshot);
    if (result.comments === undefined || result.comments.length === 0) {
        delete result.comments;
    } else {
        result.comments = result.comments.map(comment => {
            const canonical = clone(comment);
            if (canonical.resolved !== true) {
                delete canonical.resolved;
            }
            return canonical;
        });
    }
    if (result.trackedChanges === undefined || result.trackedChanges.length === 0) {
        delete result.trackedChanges;
    } else {
        result.trackedChanges = result.trackedChanges.map(change => {
            const canonical = clone(change);
            canonical.tracking.ts = normalizeHistoryOtTimestamp(canonical.tracking.ts);
            return canonical;
        });
    }
    return result;
}

function assertAddRangesFit(
    operation: HistoryOtAddCommentOperation,
    snapshot: StringFileDataSnapshot,
): void {
    if (operation.ranges.some(range => range.pos + range.length > snapshot.content.length)) {
        throw new HistoryOtProtocolError(
            'COMMENT_RANGE_OUT_OF_BOUNDS',
            'Add-comment operation contains a range beyond the current snapshot',
        );
    }
}

function applySingleOperation(
    snapshot: StringFileDataSnapshot,
    operation: HistoryOtOperation,
): StringFileDataSnapshot {
    const kind = operationKind(operation);
    if (kind === 'text') {
        return applyTextOperationToSnapshot(snapshot, asText(operation));
    }
    const result = clone(snapshot);
    if (kind === 'add-comment') {
        const add = asAdd(operation);
        assertAddRangesFit(add, snapshot);
        const comments = (snapshot.comments ?? []).map(comment => clone(comment));
        const existing = comments.findIndex(comment => comment.id === add.commentId);
        const next = commentFromAdd(add);
        if (existing < 0) {
            comments.push(next);
        } else {
            comments[existing] = next;
        }
        result.comments = comments;
    } else if (kind === 'delete-comment') {
        if (snapshot.comments !== undefined) {
            result.comments = snapshot.comments
                .filter(comment => comment.id !== asDelete(operation).deleteComment)
                .map(comment => clone(comment));
        }
    } else if (kind === 'set-comment-state') {
        const state = asState(operation);
        if (snapshot.comments !== undefined) {
            result.comments = snapshot.comments.map(comment => {
                const next = clone(comment);
                if (next.id === state.commentId) {
                    next.resolved = state.resolved;
                }
                return next;
            });
        }
    }
    return result;
}

export function applyHistoryOtOperations(
    snapshotInput: HistoryOtSnapshotInput,
    operationsInput: HistoryOtOperationsInput,
): ParsedHistoryOtSnapshot {
    let snapshot = getSafeSnapshotRaw(snapshotInput);
    const operations = getSafeOperationsRaw(operationsInput);
    for (const operation of operations) {
        snapshot = applySingleOperation(snapshot, operation);
    }
    const parsed = parseHistoryOtSnapshot(canonicalizeAppliedSnapshot(snapshot));
    if (!parsed.safe) {
        throw new HistoryOtProtocolError(
            'UNSAFE_APPLY_RESULT',
            `History-OT apply produced an unsafe snapshot: ${parsed.unsafeReasons.join('; ')}`,
            parsed.unsafeReasons,
        );
    }
    return parsed;
}

function canCompose(left: HistoryOtOperation, right: HistoryOtOperation): boolean {
    const leftKind = operationKind(left);
    const rightKind = operationKind(right);
    if (leftKind === 'text' && rightKind === 'text') {
        return decodeTextOperation(asText(left)).targetLength
            === decodeTextOperation(asText(right)).baseLength;
    }
    if (leftKind === 'add-comment') {
        const id = asAdd(left).commentId;
        return (rightKind === 'add-comment' && asAdd(right).commentId === id)
            || (rightKind === 'delete-comment' && asDelete(right).deleteComment === id)
            || (rightKind === 'set-comment-state' && asState(right).commentId === id);
    }
    if (leftKind === 'set-comment-state') {
        const id = asState(left).commentId;
        return (rightKind === 'set-comment-state' && asState(right).commentId === id)
            || (rightKind === 'delete-comment' && asDelete(right).deleteComment === id);
    }
    return false;
}

function composePair(left: HistoryOtOperation, right: HistoryOtOperation): HistoryOtOperation {
    const leftKind = operationKind(left);
    const rightKind = operationKind(right);
    if (leftKind === 'text' && rightKind === 'text') {
        return composeTextOperations(asText(left), asText(right));
    }
    if (leftKind === 'add-comment') {
        if (rightKind === 'add-comment' || rightKind === 'delete-comment') {
            return clone(right);
        }
        if (rightKind === 'set-comment-state') {
            const result = clone(asAdd(left));
            if (asState(right).resolved) {
                result.resolved = true;
            } else {
                delete result.resolved;
            }
            return result;
        }
    }
    if (leftKind === 'set-comment-state'
        && (rightKind === 'set-comment-state' || rightKind === 'delete-comment')) {
        return clone(right);
    }
    throw new HistoryOtProtocolError('UNSUPPORTED_COMPOSE', 'These History-OT operations cannot be composed');
}

export function composeHistoryOtOperations(
    firstInput: HistoryOtOperationsInput,
    secondInput: HistoryOtOperationsInput,
): ParsedHistoryOtOperations {
    const first = getSafeOperationsRaw(firstInput);
    const second = getSafeOperationsRaw(secondInput);
    assertSnapshotIndependentAlgebraDomain(first, 'compose');
    assertSnapshotIndependentAlgebraDomain(second, 'compose');
    const operations = [
        ...first,
        ...second,
    ].map(operation => clone(operation));
    if (operations.length === 0) {
        return parseHistoryOtOperations([]);
    }
    const result: HistoryOtOperationArray = [];
    let current = operations[0];
    for (let index = 1; index < operations.length; index += 1) {
        const next = operations[index];
        if (canCompose(current, next)) {
            current = composePair(current, next);
        } else {
            result.push(current);
            current = next;
        }
    }
    result.push(current);
    return parseHistoryOtOperations(result.map(canonicalizeGeneratedOperation));
}

function transformAddThroughText(
    text: HistoryOtTextOperation,
    add: HistoryOtAddCommentOperation,
): HistoryOtAddCommentOperation {
    return addFromComment(transformCommentThroughTextOperation(commentFromAdd(add), text));
}

function transformPair(
    left: HistoryOtOperation,
    right: HistoryOtOperation,
): [HistoryOtOperation, HistoryOtOperation] {
    const leftKind = operationKind(left);
    const rightKind = operationKind(right);
    if (leftKind === 'no-op' || rightKind === 'no-op') {
        return [clone(left), clone(right)];
    }
    if (leftKind === 'text' && rightKind === 'text') {
        return transformTextOperations(asText(left), asText(right));
    }
    if (leftKind === 'text') {
        return rightKind === 'add-comment'
            ? [clone(left), transformAddThroughText(asText(left), asAdd(right))]
            : [clone(left), clone(right)];
    }
    if (rightKind === 'text') {
        const [rightPrime, leftPrime] = transformPair(right, left);
        return [leftPrime, rightPrime];
    }

    if (leftKind === 'add-comment' && rightKind === 'add-comment') {
        return asAdd(left).commentId === asAdd(right).commentId
            ? [noOperation(), clone(right)]
            : [clone(left), clone(right)];
    }
    if (leftKind === 'add-comment' && rightKind === 'delete-comment') {
        return asAdd(left).commentId === asDelete(right).deleteComment
            ? [noOperation(), clone(right)]
            : [clone(left), clone(right)];
    }
    if (leftKind === 'delete-comment' && rightKind === 'add-comment') {
        const [rightPrime, leftPrime] = transformPair(right, left);
        return [leftPrime, rightPrime];
    }
    if (leftKind === 'add-comment' && rightKind === 'set-comment-state') {
        if (asAdd(left).commentId !== asState(right).commentId) {
            return [clone(left), clone(right)];
        }
        const add = clone(asAdd(left));
        if (asState(right).resolved) {
            add.resolved = true;
        } else {
            delete add.resolved;
        }
        return [add, clone(right)];
    }
    if (leftKind === 'set-comment-state' && rightKind === 'add-comment') {
        const [rightPrime, leftPrime] = transformPair(right, left);
        return [leftPrime, rightPrime];
    }
    if (leftKind === 'delete-comment' && rightKind === 'delete-comment') {
        return asDelete(left).deleteComment === asDelete(right).deleteComment
            ? [noOperation(), noOperation()]
            : [clone(left), clone(right)];
    }
    if (leftKind === 'delete-comment' && rightKind === 'set-comment-state') {
        return asDelete(left).deleteComment === asState(right).commentId
            ? [clone(left), noOperation()]
            : [clone(left), clone(right)];
    }
    if (leftKind === 'set-comment-state' && rightKind === 'delete-comment') {
        const [rightPrime, leftPrime] = transformPair(right, left);
        return [leftPrime, rightPrime];
    }
    if (leftKind === 'set-comment-state' && rightKind === 'set-comment-state') {
        const leftState = asState(left);
        const rightState = asState(right);
        if (leftState.commentId !== rightState.commentId) {
            return [clone(left), clone(right)];
        }
        if (leftState.resolved === rightState.resolved) {
            return [noOperation(), noOperation()];
        }
        return leftState.resolved
            ? [noOperation(), clone(right)]
            : [clone(left), noOperation()];
    }
    throw new HistoryOtProtocolError('UNSUPPORTED_TRANSFORM', 'Unsupported History-OT transform pair');
}

export function transformHistoryOtOperations(
    firstInput: HistoryOtOperationsInput,
    secondInput: HistoryOtOperationsInput,
): [ParsedHistoryOtOperations, ParsedHistoryOtOperations] {
    const left = getSafeOperationsRaw(firstInput).map(operation => clone(operation));
    const right = getSafeOperationsRaw(secondInput).map(operation => clone(operation));
    assertSnapshotIndependentAlgebraDomain(left, 'transform');
    assertSnapshotIndependentAlgebraDomain(right, 'transform');
    assertCommentTransformOrderDomain(left, right);
    for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
        for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
            [left[leftIndex], right[rightIndex]] = transformPair(
                left[leftIndex], right[rightIndex],
            );
        }
    }
    return [
        parseHistoryOtOperations(left.map(canonicalizeGeneratedOperation)),
        parseHistoryOtOperations(right.map(canonicalizeGeneratedOperation)),
    ];
}

function assertCommentCanBeEncoded(comment: HistoryOtComment): void {
    const commentHasOpaque = Object.keys(comment).some(
        key => key !== 'id' && key !== 'ranges' && key !== 'resolved',
    );
    const rangeHasOpaque = comment.ranges.some(range =>
        Object.keys(range).some(key => key !== 'pos' && key !== 'length'));
    if (commentHasOpaque || rangeHasOpaque) {
        throw new HistoryOtProtocolError(
            'OPAQUE_COMMENT_NOT_INVERTIBLE',
            'The previous comment has opaque metadata that an add-comment operation cannot reconstruct',
        );
    }
}

function invertSingleOperation(
    snapshot: StringFileDataSnapshot,
    operation: HistoryOtOperation,
): HistoryOtOperation {
    const kind = operationKind(operation);
    if (kind === 'text') {
        return invertTextOperation(snapshot, asText(operation));
    }
    if (kind === 'no-op') {
        return noOperation();
    }
    const id = kind === 'delete-comment'
        ? asDelete(operation).deleteComment
        : (operation as HistoryOtAddCommentOperation | HistoryOtSetCommentStateOperation).commentId;
    const previous = snapshot.comments?.find(comment => comment.id === id);
    if (kind === 'set-comment-state') {
        return previous === undefined
            ? noOperation()
            : {commentId: id, resolved: previous.resolved ?? false};
    }
    if (previous === undefined) {
        return kind === 'add-comment' ? {deleteComment: id} : noOperation();
    }
    if (kind === 'delete-comment') {
        const previousIndex = snapshot.comments?.findIndex(comment => comment.id === id) ?? -1;
        if (previousIndex !== (snapshot.comments?.length ?? 0) - 1) {
            throw new HistoryOtProtocolError(
                'UNSUPPORTED_COMMENT_ORDER_INVERSE',
                'Deleting a non-final comment cannot be inverted with exact CommentList wire order',
            );
        }
    }
    assertCommentCanBeEncoded(previous);
    return addFromComment(previous);
}

export function invertHistoryOtOperations(
    snapshotInput: HistoryOtSnapshotInput,
    operationsInput: HistoryOtOperationsInput,
): ParsedHistoryOtOperations {
    let snapshot = getSafeSnapshotRaw(snapshotInput);
    const operations = getSafeOperationsRaw(operationsInput);
    const inverses: HistoryOtOperation[] = [];
    for (const operation of operations) {
        inverses.push(invertSingleOperation(snapshot, operation));
        snapshot = applySingleOperation(snapshot, operation);
    }
    inverses.reverse();
    const parsed = parseHistoryOtOperations(inverses.map(canonicalizeGeneratedOperation));
    if (!parsed.safe) {
        throw new HistoryOtProtocolError(
            'UNSAFE_INVERSE_RESULT',
            `History-OT inverse is outside the safe operation domain: ${parsed.unsafeReasons.join('; ')}`,
            parsed.unsafeReasons,
        );
    }
    return parsed;
}
