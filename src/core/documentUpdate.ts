import * as DiffMatchPatch from 'diff-match-patch';

export type TextOperation = {
    p: number,
    i?: string,
    d?: string,
};

type TextEdit = {
    start: number,
    end: number,
    text: string,
};

export type PreparedDocumentUpdate = {
    mergedContent: string,
    mergeApplied: boolean,
    operations: TextOperation[],
};

export type ExactDocumentBase = {
    version: number,
    content: string,
    pendingWrite: boolean,
};

export type ProvenDocumentUpdate =
    | {status: 'noop', prepared: PreparedDocumentUpdate}
    | {status: 'ready', prepared: PreparedDocumentUpdate}
    | {
        status: 'blocked',
        reason: 'missing-base' | 'pending-write' | 'version-mismatch' | 'content-mismatch',
    };

export function isSenderConfirmation(update: {op?: unknown[]}): boolean {
    return update.op === undefined;
}

/**
 * Authorize a document write only from the exact remote state which the editor
 * previously acknowledged. A current remote snapshot is not a substitute for a
 * missing editor base: that would turn an old hot-exit buffer into a valid bulk
 * edit. Any remote version/content movement therefore fails closed. The caller
 * may later add a separately proven merge path without weakening this gate.
 */
export function prepareProvenDocumentUpdate(
    base: ExactDocumentBase | undefined,
    remoteVersion: number,
    remoteContent: string,
    desiredContent: string,
): ProvenDocumentUpdate {
    if (remoteContent === desiredContent) {
        return {
            status: 'noop',
            prepared: prepareDocumentUpdate(remoteContent, remoteContent, desiredContent),
        };
    }
    if (!base) {
        return {status: 'blocked', reason: 'missing-base'};
    }
    if (base.pendingWrite) {
        return {status: 'blocked', reason: 'pending-write'};
    }
    if (base.version !== remoteVersion) {
        return {status: 'blocked', reason: 'version-mismatch'};
    }
    if (base.content !== remoteContent) {
        return {status: 'blocked', reason: 'content-mismatch'};
    }
    return {
        status: 'ready',
        prepared: prepareDocumentUpdate(base.content, remoteContent, desiredContent),
    };
}

function editsFromBase(base: string, target: string): TextEdit[] {
    const dmp = new DiffMatchPatch();
    const diffs = dmp.diff_main(base, target);
    const edits: TextEdit[] = [];
    let basePosition = 0;
    let pending: TextEdit | undefined;

    const flush = () => {
        if (pending) {
            edits.push(pending);
            pending = undefined;
        }
    };

    for (const [kind, text] of diffs) {
        if (kind === 0) {
            flush();
            basePosition += text.length;
        } else if (kind === -1) {
            pending ??= {start: basePosition, end: basePosition, text: ''};
            pending.end += text.length;
            basePosition += text.length;
        } else {
            pending ??= {start: basePosition, end: basePosition, text: ''};
            pending.text += text;
        }
    }
    flush();
    return edits;
}

function sameEdit(left: TextEdit, right: TextEdit): boolean {
    return left.start === right.start && left.end === right.end && left.text === right.text;
}

/**
 * Be deliberately conservative at shared boundaries. An insertion exactly at
 * the start/end of a replacement has an ambiguous ordering, so it is surfaced
 * as a conflict rather than guessed.
 */
function editsConflict(left: TextEdit, right: TextEdit): boolean {
    if (sameEdit(left, right)) { return false; }
    const leftInsertion = left.start === left.end;
    const rightInsertion = right.start === right.end;
    if (leftInsertion && rightInsertion) {
        return left.start === right.start;
    }
    if (leftInsertion) {
        return left.start >= right.start && left.start <= right.end;
    }
    if (rightInsertion) {
        return right.start >= left.start && right.start <= left.end;
    }
    return Math.max(left.start, right.start) < Math.min(left.end, right.end);
}

function mergeIndependentEdits(
    base: string,
    remoteEdits: TextEdit[],
    localEdits: TextEdit[],
): {content: string, applied: boolean} {
    for (const remote of remoteEdits) {
        if (localEdits.some(local => editsConflict(remote, local))) {
            return {content: base, applied: false};
        }
    }

    const unique = [...remoteEdits];
    for (const local of localEdits) {
        if (!unique.some(remote => sameEdit(remote, local))) {
            unique.push(local);
        }
    }
    unique.sort((left, right) => right.start - left.start || right.end - left.end);

    let content = base;
    for (const edit of unique) {
        content = content.slice(0, edit.start) + edit.text + content.slice(edit.end);
    }
    return {content, applied: true};
}

function operationsBetween(from: string, to: string): TextOperation[] {
    const dmp = new DiffMatchPatch();
    let currentPosition = 0;
    return dmp.diff_main(from, to)
        .map((part): TextOperation | undefined => {
            const advance = part[0] === -1 ? 0 : part[1].length;
            currentPosition += advance;
            if (part[0] === 0) { return undefined; }
            return {
                p: currentPosition - advance,
                i: part[0] === 1 ? part[1] : undefined,
                d: part[0] === -1 ? part[1] : undefined,
            };
        })
        .filter((operation): operation is TextOperation => operation !== undefined);
}

/**
 * Three-way merge the editor text with the authoritative remote text. Only
 * independent edits (or byte-for-byte identical edits) are merged. Overlapping
 * changes fail closed so VS Code keeps the document dirty instead of silently
 * choosing one side.
 */
export function prepareDocumentUpdate(
    localBase: string,
    remoteContent: string,
    desiredContent: string,
): PreparedDocumentUpdate {
    const merged = mergeIndependentEdits(
        localBase,
        editsFromBase(localBase, remoteContent),
        editsFromBase(localBase, desiredContent),
    );
    return {
        mergedContent: merged.content,
        mergeApplied: merged.applied,
        operations: merged.applied ? operationsBetween(remoteContent, merged.content) : [],
    };
}
