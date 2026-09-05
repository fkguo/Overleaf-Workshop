import DiffMatchPatch = require('diff-match-patch');
import {createHash} from 'crypto';

interface TextChange {
    start: number;
    end: number;
    replacement: string;
}

export type ReplicaReconciliation =
    | {kind: 'absent'}
    | {kind: 'unchanged', content: Uint8Array}
    | {kind: 'write-local', content: Uint8Array}
    | {kind: 'write-remote', content: Uint8Array}
    | {kind: 'write-both', content: Uint8Array}
    | {kind: 'delete-local'}
    | {kind: 'delete-remote'}
    | {kind: 'conflict', reason: 'missing-base' | 'binary-change' | 'overlapping-change' | 'delete-vs-edit'};

export interface ReplicaReconciliationOptions {
    /**
     * A newly-created replica may hydrate paths that are known to exist only
     * on the remote side. This never authorizes a local-to-remote mutation.
     */
    allowRemoteHydration?: boolean;
}

export type ReplicaDirectoryReconciliation =
    | {kind: 'unchanged'}
    | {kind: 'create-local'}
    | {kind: 'conflict', reason: 'missing-base'};

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    if (left.length !== right.length) { return false; }
    return left.every((value, index) => value === right[index]);
}

export interface ReplicaExclusiveCreate {
    create(content: Uint8Array): PromiseLike<boolean>;
}

export interface ReplicaExclusivePublish {
    prepare(content: Uint8Array): PromiseLike<void>;
    publish(): PromiseLike<boolean>;
    cleanup(): PromiseLike<void>;
}

/** Publish prepared bytes atomically only if the destination is still absent. */
export async function publishPreparedReplicaFile(
    content: Uint8Array,
    publication: ReplicaExclusivePublish,
): Promise<boolean> {
    try {
        await publication.prepare(content);
        return await publication.publish();
    } finally {
        await publication.cleanup();
    }
}

/**
 * Apply a remote result without ever overwriting or deleting an existing local
 * replica file. Existing equal bytes need no write. A missing local path may be
 * hydrated only through an OS-backed exclusive create; `false` means another
 * writer created the path first and its bytes must be preserved.
 */
export async function applyReplicaMutationWithoutOverwrite(
    capturedLocal: Uint8Array | undefined,
    desiredLocal: Uint8Array | undefined,
    local: ReplicaExclusiveCreate,
): Promise<boolean> {
    if (capturedLocal !== undefined) {
        return desiredLocal !== undefined && bytesEqual(capturedLocal, desiredLocal);
    }
    if (desiredLocal === undefined) { return true; }
    return local.create(desiredLocal);
}

/** Serialize synchronization work for the same replica path. */
export class ReplicaPathOperationQueue {
    private readonly pending = new Map<string, Promise<void>>();

    run<T>(path: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.pending.get(path) ?? Promise.resolve();
        const result = previous.catch(() => undefined).then(operation);
        const settled = result.then(() => undefined, () => undefined);
        this.pending.set(path, settled);
        void settled.finally(() => {
            if (this.pending.get(path) === settled) {
                this.pending.delete(path);
            }
        });
        return result;
    }
}

/** Build a short Windows/macOS/Linux-safe name for an unapplied remote copy. */
export function incomingReplicaFileName(relPath: string, timestamp: number, attempt: number): string {
    const leaf = relPath.split('/').filter(Boolean).at(-1) ?? 'file';
    let stem = leaf.replace(/[^A-Za-z0-9._-]/g, '_').replace(/[. ]+$/g, '').slice(0, 24);
    if (stem === '' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(stem)) {
        stem = `_${stem || 'file'}`;
    }
    const digest = createHash('sha256').update(relPath).digest('hex').slice(0, 10);
    const stamp = Math.max(0, Math.trunc(timestamp)).toString(36).slice(-10);
    const suffix = Math.max(0, Math.trunc(attempt)).toString(36).slice(-2);
    return `remote-${stem}-${digest}-${stamp}-${suffix}.bin`;
}

export function replicaTempFileName(timestamp: number, processId: number, attempt: number): string {
    const stamp = Math.max(0, Math.trunc(timestamp)).toString(36).slice(-10);
    const pid = Math.max(0, Math.trunc(processId)).toString(36).slice(-6);
    const suffix = Math.max(0, Math.trunc(attempt)).toString(36).slice(-2);
    return `.owtmp-${pid}-${stamp}-${suffix}`;
}

export interface WitnessedReplicaTextWrite {
    write(content: Uint8Array): PromiseLike<void>;
    readBack(): PromiseLike<Uint8Array>;
}

/**
 * Complete a text-file push from the exact bytes returned by the immediately
 * preceding remote read. The remote FileSystemProvider owns the witness,
 * causal rebase, transport acknowledgement, and conflict decision; this layer
 * only refuses calls which have no read witness and returns its authoritative
 * post-write bytes for the local replica.
 */
export async function writeWitnessedReplicaText(
    witnessedRemote: Uint8Array | undefined,
    desired: Uint8Array,
    remote: WitnessedReplicaTextWrite,
): Promise<Uint8Array> {
    if (witnessedRemote === undefined) {
        throw new Error('Local replica remote write blocked without an exact read witness');
    }
    if (decodeUtf8(witnessedRemote) === undefined || decodeUtf8(desired) === undefined) {
        throw new Error('Local replica remote write blocked for non-UTF-8 content');
    }
    await remote.write(desired);
    const authoritative = new Uint8Array(await remote.readBack());
    if (decodeUtf8(authoritative) === undefined) {
        throw new Error('Local replica remote write returned non-UTF-8 content');
    }
    return authoritative;
}

function decodeUtf8(content: Uint8Array): string | undefined {
    try {
        return new TextDecoder('utf-8', {fatal: true}).decode(content);
    } catch {
        return undefined;
    }
}

function textChanges(base: string, target: string): TextChange[] {
    const dmp = new DiffMatchPatch();
    const diffs = dmp.diff_main(base, target, false);
    const changes: TextChange[] = [];
    let baseOffset = 0;
    let active: TextChange | undefined;

    const flush = () => {
        if (active) {
            changes.push(active);
            active = undefined;
        }
    };

    for (const [operation, text] of diffs) {
        if (operation === DiffMatchPatch.DIFF_EQUAL) {
            flush();
            baseOffset += text.length;
            continue;
        }

        active ??= {start: baseOffset, end: baseOffset, replacement: ''};
        if (operation === DiffMatchPatch.DIFF_DELETE) {
            baseOffset += text.length;
            active.end = baseOffset;
        } else if (operation === DiffMatchPatch.DIFF_INSERT) {
            active.replacement += text;
        }
    }
    flush();
    return changes;
}

function changesOverlap(left: TextChange, right: TextChange): boolean {
    const leftIsInsertion = left.start === left.end;
    const rightIsInsertion = right.start === right.end;
    if (leftIsInsertion && rightIsInsertion) {
        return left.start === right.start;
    }
    if (leftIsInsertion) {
        return left.start >= right.start && left.start <= right.end;
    }
    if (rightIsInsertion) {
        return right.start >= left.start && right.start <= left.end;
    }
    return left.start < right.end && right.start < left.end;
}

function applyChanges(base: string, changes: TextChange[]): string {
    return [...changes]
        .sort((left, right) => right.start - left.start || right.end - left.end)
        .reduce(
            (content, change) => content.slice(0, change.start) + change.replacement + content.slice(change.end),
            base,
        );
}

function mergeDisjointChanges(base: string, local: string, remote: string): string | undefined {
    const localChanges = textChanges(base, local);
    const remoteChanges = textChanges(base, remote);
    if (applyChanges(base, localChanges) !== local || applyChanges(base, remoteChanges) !== remote) {
        return undefined;
    }
    if (localChanges.some(localChange =>
        remoteChanges.some(remoteChange => changesOverlap(localChange, remoteChange))
    )) {
        return undefined;
    }
    return applyChanges(base, [...localChanges, ...remoteChanges]);
}

/**
 * Decide an initial local-replica reconciliation without performing I/O.
 *
 * When both copies exist but differ, missing ancestry and overlapping edits are
 * deliberately conflicts: guessing can overwrite offline work or publish a
 * corrupted fuzzy merge. A one-sided path is also a conflict unless this is a
 * proven first hydration from remote into a newly-created replica. In
 * particular, no missing-base decision ever authorizes a remote mutation.
 */
export function reconcileReplicaContents(
    base: Uint8Array | undefined,
    local: Uint8Array | undefined,
    remote: Uint8Array | undefined,
    options: ReplicaReconciliationOptions = {},
): ReplicaReconciliation {
    if (local === undefined && remote === undefined) {
        return {kind: 'absent'};
    }
    if (base === undefined) {
        if (local === undefined) {
            return options.allowRemoteHydration ?
                {kind: 'write-local', content: remote!} :
                {kind: 'conflict', reason: 'missing-base'};
        }
        if (remote === undefined) {
            return {kind: 'conflict', reason: 'missing-base'};
        }
        if (bytesEqual(local, remote)) {
            return {kind: 'unchanged', content: local};
        }
        return {kind: 'conflict', reason: 'missing-base'};
    }
    if (local === undefined) {
        return bytesEqual(base, remote!) ?
            {kind: 'delete-remote'} : {kind: 'conflict', reason: 'delete-vs-edit'};
    }
    if (remote === undefined) {
        return bytesEqual(base, local) ?
            {kind: 'delete-local'} : {kind: 'conflict', reason: 'delete-vs-edit'};
    }
    if (bytesEqual(local, remote)) {
        return {kind: 'unchanged', content: local};
    }
    if (bytesEqual(base, local)) {
        return {kind: 'write-local', content: remote};
    }
    if (bytesEqual(base, remote)) {
        return {kind: 'write-remote', content: local};
    }

    const baseText = decodeUtf8(base);
    const localText = decodeUtf8(local);
    const remoteText = decodeUtf8(remote);
    if (baseText === undefined || localText === undefined || remoteText === undefined) {
        return {kind: 'conflict', reason: 'binary-change'};
    }
    const merged = mergeDisjointChanges(baseText, localText, remoteText);
    if (merged === undefined) {
        return {kind: 'conflict', reason: 'overlapping-change'};
    }
    return {kind: 'write-both', content: new TextEncoder().encode(merged)};
}

/**
 * Reconcile a path which is a directory on its existing side(s).
 *
 * Directories have no content base in the current replica format, so a
 * one-sided directory is ambiguous after restart. Only an explicitly proven
 * first remote hydration may create the corresponding local directory.
 */
export function reconcileReplicaDirectory(
    localExists: boolean,
    remoteExists: boolean,
    options: ReplicaReconciliationOptions = {},
): ReplicaDirectoryReconciliation {
    if (localExists === remoteExists) {
        return {kind: 'unchanged'};
    }
    if (!localExists && remoteExists && options.allowRemoteHydration) {
        return {kind: 'create-local'};
    }
    return {kind: 'conflict', reason: 'missing-base'};
}

/**
 * Keep watcher event delivery behind a successful initial reconciliation.
 * Cancellation, conflicts (reported as false), and thrown failures all dispose
 * the provisional subscriptions without replaying queued events.
 */
export async function completeInitialReplicaSync(
    synchronize: () => Promise<boolean | undefined>,
    dispose: () => void,
    replayQueued: () => Promise<void>,
): Promise<void> {
    try {
        const completed = await synchronize();
        if (completed !== true) {
            throw new Error('Local replica initial synchronization did not complete');
        }
        await replayQueued();
    } catch (error) {
        dispose();
        throw error;
    }
}

/**
 * Finish setup while watcher callbacks still queue their work. Preparation may
 * await I/O; afterwards the queue is drained to quiescence and activation is a
 * synchronous state flip, leaving no await gap in which an event can be lost.
 */
export async function finishInitialReplicaActivation(
    prepare: () => Promise<void>,
    queuedEvents: Array<() => Promise<void>>,
    activate: () => void,
): Promise<void> {
    await prepare();
    while (queuedEvents.length > 0) {
        await queuedEvents.shift()!();
    }
    activate();
}
