/* eslint-disable @typescript-eslint/naming-convention */
import {strict as assert} from 'assert';
import {SocketRequestError} from '../api/socketRequest';
import {
    DocumentProvenanceIdentity,
    DocumentProvenanceStore,
    ProvenanceStorage,
} from '../core/documentProvenance';

type RemoteModule = typeof import('../core/remoteFileSystemProvider');

interface ModuleLoader {
    _load(request: string, parent: NodeModule | null, isMain: boolean): unknown,
}

class DisposableStub {
    constructor(private readonly callback?: () => void) {}
    dispose(): void { this.callback?.(); }
    static from(...items: DisposableStub[]): DisposableStub {
        return new DisposableStub(() => items.forEach(item => item.dispose()));
    }
}

class EventEmitterStub {
    readonly event = () => new DisposableStub();
    fire(): void {}
    dispose(): void {}
}

class FileSystemErrorStub extends Error {
    static Unavailable(message?: string): FileSystemErrorStub {
        return new FileSystemErrorStub(message ?? 'Unavailable');
    }
    static NoPermissions(message?: string): FileSystemErrorStub {
        return new FileSystemErrorStub(message ?? 'NoPermissions');
    }
    static FileNotFound(): FileSystemErrorStub {
        return new FileSystemErrorStub('FileNotFound');
    }
    static FileExists(): FileSystemErrorStub {
        return new FileSystemErrorStub('FileExists');
    }
}

class ValueStub {
    constructor(..._args: unknown[]) {}
}

const vscodeStub = {
    Disposable: DisposableStub,
    EventEmitter: EventEmitterStub,
    FileSystemError: FileSystemErrorStub,
    FileType: {File: 1, Directory: 2},
    FilePermission: {Readonly: 1},
    FileChangeType: {Changed: 1, Created: 2, Deleted: 3},
    StatusBarAlignment: {Left: 1, Right: 2},
    TreeItemCollapsibleState: {None: 0},
    UIKind: {Desktop: 1},
    ProgressLocation: {Notification: 1},
    env: {uiKind: 1},
    l10n: {
        t: (message: string, values?: Record<string, unknown>) => message.replace(
            /\{([^}]+)\}/g,
            (_match, key: string) => String(values?.[key] ?? `{${key}}`),
        ),
    },
    TreeItem: ValueStub,
    ThemeIcon: ValueStub,
    ThemeColor: ValueStub,
    MarkdownString: ValueStub,
    Hover: ValueStub,
    Range: ValueStub,
    Position: ValueStub,
    Selection: ValueStub,
    RelativePattern: ValueStub,
    Uri: {
        joinPath: (base: TestUri, ...parts: string[]) => makeUri(`${base.path}/${parts.join('/')}`),
        file: (path: string) => makeUri(path, 'file'),
        parse: (value: string) => makeUri(value),
        from: (parts: {scheme?: string, authority?: string, path?: string, query?: string}) =>
            makeUri(parts.path ?? '/', parts.scheme, parts.authority, parts.query),
    },
    workspace: {
        workspaceFolders: undefined,
        textDocuments: [],
        fs: {writeFile: async () => {}},
        getConfiguration: () => ({get: (_key: string, fallback: unknown) => fallback}),
        onDidOpenTextDocument: () => new DisposableStub(),
        onDidChangeTextDocument: () => new DisposableStub(),
        onDidSaveTextDocument: () => new DisposableStub(),
        registerFileSystemProvider: () => new DisposableStub(),
        createFileSystemWatcher: () => ({
            onDidCreate: () => new DisposableStub(),
            onDidChange: () => new DisposableStub(),
            onDidDelete: () => new DisposableStub(),
            dispose: () => {},
        }),
    },
    window: {
        showErrorMessage: async () => undefined,
        showWarningMessage: async () => undefined,
        showInformationMessage: async () => undefined,
        showSaveDialog: async () => undefined,
        showTextDocument: async () => undefined,
        withProgress: async (_options: unknown, task: () => Promise<unknown>) => task(),
        createStatusBarItem: () => ({show: () => {}, hide: () => {}, dispose: () => {}}),
        createTreeView: () => ({dispose: () => {}}),
    },
    commands: {
        executeCommand: async () => undefined,
        registerCommand: () => new DisposableStub(),
    },
    languages: {
        registerHoverProvider: () => new DisposableStub(),
        createDiagnosticCollection: () => ({set: () => {}, clear: () => {}, dispose: () => {}}),
    },
};

const moduleLoader = require('module') as ModuleLoader;
const originalLoad = moduleLoader._load;
const originalCacheKeys = new Set(Object.keys(require.cache));
let remoteModule: RemoteModule;
moduleLoader._load = function(request, parent, isMain): unknown {
    if (request === 'vscode') { return vscodeStub; }
    return originalLoad.call(this, request, parent, isMain);
};
try {
    remoteModule = require('../core/remoteFileSystemProvider') as RemoteModule;
} finally {
    moduleLoader._load = originalLoad;
    for (const cacheKey of Object.keys(require.cache)) {
        if (!originalCacheKeys.has(cacheKey)) {
            delete require.cache[cacheKey];
        }
    }
}

type TestUri = {
    scheme: string,
    authority: string,
    path: string,
    query: string,
    fsPath: string,
    toString(): string,
    with(change: Partial<TestUri>): TestUri,
};

function makeUri(
    path: string,
    scheme = 'overleaf-workshop',
    authority = 'server',
    query = 'user=user-1&project=project-1',
): TestUri {
    const uri: TestUri = {
        scheme,
        authority,
        path,
        query,
        fsPath: path,
        toString: () => `${scheme}://${authority}${path}?${query}`,
        with: change => makeUri(
            change.path ?? path,
            change.scheme ?? scheme,
            change.authority ?? authority,
            change.query ?? query,
        ),
    };
    return uri;
}

class MemoryStorage implements ProvenanceStorage {
    readonly records = new Map<string, Uint8Array>();
    beforeDelete?: () => void | Promise<void>;
    afterWrite?: (name: string, content: Uint8Array) => void | Promise<void>;

    async list(): Promise<string[]> {
        return [...this.records.keys()];
    }
    async read(name: string): Promise<Uint8Array | undefined> {
        const value = this.records.get(name);
        return value && new Uint8Array(value);
    }
    async write(name: string, content: Uint8Array): Promise<void> {
        this.records.set(name, new Uint8Array(content));
        await this.afterWrite?.(name, content);
    }
    async delete(name: string): Promise<void> {
        await this.beforeDelete?.();
        this.records.delete(name);
    }
}

type HarnessOptions = {
    storage?: MemoryStorage,
    sessionId?: string,
    projectId?: string,
    userId?: string,
    docId?: string,
    protocolVersion?: number,
    remoteText?: string,
    remoteVersion?: number,
    applyError?: Error,
    applyBeforeError?: boolean,
    versionError?: Error,
};

type Harness = {
    vfs: any,
    uri: TestUri,
    doc: import('../core/remoteFileSystemProvider').DocumentEntity,
    identity: DocumentProvenanceIdentity,
    storage: MemoryStorage,
    store: DocumentProvenanceStore,
    submissions: Array<{docId: string, update: any}>,
    getRemoteText(): string,
    setRemoteText(value: string): void,
};

function applyOperations(text: string, operations: Array<{p: number, i?: string, d?: string}>): string {
    let result = text;
    for (const operation of operations) {
        if (operation.d !== undefined) {
            assert.equal(result.slice(operation.p, operation.p + operation.d.length), operation.d);
            result = result.slice(0, operation.p) + result.slice(operation.p + operation.d.length);
        }
        if (operation.i !== undefined) {
            result = result.slice(0, operation.p) + operation.i + result.slice(operation.p);
        }
    }
    return result;
}

function makeHarness(options: HarnessOptions = {}): Harness {
    const storage = options.storage ?? new MemoryStorage();
    const store = new DocumentProvenanceStore(storage, {
        sessionId: options.sessionId ?? 'current-window',
        now: (() => {
            let tick = 100;
            return () => tick++;
        })(),
    });
    const projectId = options.projectId ?? 'project-1';
    const userId = options.userId ?? 'user-1';
    const docId = options.docId ?? 'doc-1';
    const protocolVersion = options.protocolVersion ?? 1;
    const remoteVersion = options.remoteVersion ?? 7;
    let remoteText = options.remoteText ?? 'remote text';
    const uri = makeUri(`/Project/main.tex`, 'overleaf-workshop', 'server',
        `user=${userId}&project=${projectId}`);
    const doc: import('../core/remoteFileSystemProvider').DocumentEntity = {
        _id: docId,
        name: 'main.tex',
        _type: 'doc',
        version: remoteVersion,
        remoteCache: remoteText,
    };
    const rootFolder = {
        _id: 'root-folder',
        name: 'Project',
        docs: [doc],
        fileRefs: [],
        folders: [],
    };
    const project = {rootFolder: [rootFolder]};
    const submissions: Array<{docId: string, update: any}> = [];
    const vfs = Object.create(remoteModule.VirtualFileSystem.prototype) as any;
    Object.assign(vfs, {
        serverUrl: 'https://example.test',
        userId,
        projectId,
        protocolVersion,
        publicId: 'public-1',
        sourceRevision: 0,
        isDirty: false,
        root: project,
        previousRoot: project,
        joiningProject: undefined,
        documentVersionWaiters: new Map(),
        documentWrites: new Map(),
        documentJoinTasks: new Map(),
        joiningDocuments: new Map(),
        pendingDocumentUpdates: new Map(),
        stagedEditorBases: new Map(),
        activeEditorBases: new Map(),
        documentIdsByPath: new Map([[uri.path, docId]]),
        recoveryNotifications: new Set(),
        provenanceStore: store,
        notify: () => {},
        socket: {
            generation: 1,
            isUsingAlternativeConnectionScheme: false,
            fatalError: undefined,
            applyOtUpdate: async (submittedDocId: string, update: any) => {
                submissions.push({docId: submittedDocId, update});
                if (options.applyError && !options.applyBeforeError) { throw options.applyError; }
                remoteText = applyOperations(remoteText, update.op ?? []);
                if (options.applyError) { throw options.applyError; }
            },
        },
        _resolveUri: async () => ({fileType: 'doc', fileEntity: doc}),
        ensureDocumentSession: async () => {
            doc.version = remoteVersion;
            doc.remoteCache = remoteText;
            return {doc, content: remoteText};
        },
        waitForDocumentVersion: () => ({
            promise: options.versionError ? Promise.reject(options.versionError) : Promise.resolve(),
            cancel: () => {},
        }),
        joinFreshDocumentSession: async () => {
            doc.version = remoteVersion + 1;
            doc.remoteCache = remoteText;
            return {doc, content: remoteText};
        },
        showDocumentRecovery: () => {},
    });
    const identity: DocumentProvenanceIdentity = {
        canonicalServerUrl: 'https://example.test',
        userId,
        projectId,
        docId,
        otType: 'sharejs-text-ot',
        protocolVersion,
    };
    return {
        vfs,
        uri,
        doc,
        identity,
        storage,
        store,
        submissions,
        getRemoteText: () => remoteText,
        setRemoteText: value => { remoteText = value; },
    };
}

async function write(harness: Harness, text: string): Promise<void> {
    await harness.vfs.writeFileNow(
        harness.uri,
        new TextEncoder().encode(text),
        false,
        true,
    );
}

async function seedColdRecord(
    storage: MemoryStorage,
    identity: DocumentProvenanceIdentity,
    sessionId: string,
    baseVersion: number,
    baseText: string,
    dirtyText: string,
): Promise<string> {
    const store = new DocumentProvenanceStore(storage, {sessionId, now: () => 50});
    const record = await store.createOrUpdateCurrent({identity, baseVersion, baseText, dirtyText});
    await store.flush();
    return record.recordName;
}

describe('remote document exact-base write gate', () => {
    it('rejects a cold stale hot-exit buffer against newer remote text without submitting OT', async () => {
        const harness = makeHarness({remoteText: 'collaborator revision', remoteVersion: 12});
        await seedColdRecord(
            harness.storage,
            harness.identity,
            'pre-crash-window',
            11,
            'old remote text',
            'stale local buffer',
        );

        await assert.rejects(write(harness, 'stale local buffer'), /save blocked/i);

        assert.equal(harness.submissions.length, 0);
        assert.equal(harness.getRemoteText(), 'collaborator revision');
    });

    it('fails closed for missing, corrupt, and ambiguous cold provenance', async () => {
        const missing = makeHarness({sessionId: 'missing-reader'});
        await assert.rejects(write(missing, 'dirty text'));
        assert.equal(missing.submissions.length, 0);

        const corrupt = makeHarness({sessionId: 'corrupt-reader'});
        const corruptName = await seedColdRecord(
            corrupt.storage, corrupt.identity, 'corrupt-writer', 7, 'remote text', 'dirty text',
        );
        corrupt.storage.records.set(corruptName, new TextEncoder().encode('{not json'));
        await assert.rejects(write(corrupt, 'dirty text'));
        assert.equal(corrupt.submissions.length, 0);

        const ambiguous = makeHarness({sessionId: 'ambiguous-reader'});
        await seedColdRecord(
            ambiguous.storage, ambiguous.identity, 'window-a', 7, 'remote text', 'dirty text',
        );
        await seedColdRecord(
            ambiguous.storage, ambiguous.identity, 'window-b', 7, 'remote text', 'dirty text',
        );
        await assert.rejects(write(ambiguous, 'dirty text'));
        assert.equal(ambiguous.submissions.length, 0);

        const missingPath = makeHarness();
        missingPath.vfs._resolveUri = async () => ({fileType: undefined, fileEntity: undefined});
        let createCalls = 0;
        missingPath.vfs.createFile = async () => { createCalls += 1; };
        await assert.rejects(missingPath.vfs.writeFileNow(
            missingPath.uri,
            new TextEncoder().encode('restored stale document'),
            true,
            true,
        ));
        assert.equal(createCalls, 0);
        assert.equal(missingPath.submissions.length, 0);
    });

    it('submits exactly one OT update from an exact acknowledged base and reconciles it', async () => {
        const harness = makeHarness({remoteText: 'hello', remoteVersion: 7});
        harness.vfs.activeEditorBases.set('doc-1', {
            identity: harness.identity,
            version: 7,
            content: 'hello',
        });

        await write(harness, 'hello world');

        assert.equal(harness.submissions.length, 1);
        assert.equal(harness.submissions[0].docId, 'doc-1');
        assert.equal(harness.submissions[0].update.v, 7);
        assert.equal(harness.getRemoteText(), 'hello world');
        assert.equal(harness.doc.localCache, 'hello world');
        assert.equal(harness.doc.remoteCache, 'hello world');
        assert.deepEqual(await harness.storage.list(), []);
    });

    it('promotes only a clean provider read and persists the later dirty editor text', async () => {
        const harness = makeHarness({remoteText: 'clean base', remoteVersion: 7});
        harness.vfs.stageEditorBase(harness.uri, harness.doc, 'clean base');
        harness.vfs.observeTextDocument(harness.uri, 'clean base', false);
        harness.vfs.observeTextDocument(harness.uri, 'dirty edit', true);
        await harness.store.flush();

        const active = harness.vfs.activeEditorBases.get('doc-1');
        assert.equal(active?.version, 7);
        assert.equal(active?.content, 'clean base');
        const persisted = await harness.store.resolveCurrentRecord(active.recordName, {
            identity: harness.identity,
            baseVersion: 7,
            baseText: 'clean base',
            dirtyText: 'dirty edit',
        });
        assert.equal(persisted.kind, 'valid');

        await write(harness, 'dirty edit');
        assert.equal(harness.submissions.length, 1);
        assert.equal(harness.getRemoteText(), 'dirty edit');
    });

    it('does not pair an older acknowledged snapshot with a newer realtime version during cleanup', async () => {
        const harness = makeHarness({remoteText: 'hello', remoteVersion: 7});
        harness.vfs.activeEditorBases.set('doc-1', {
            identity: harness.identity,
            version: 7,
            content: 'hello',
        });
        harness.storage.beforeDelete = () => {
            harness.setRemoteText('hello world + collaborator');
            harness.doc.version = 9;
            harness.doc.remoteCache = 'hello world + collaborator';
        };

        await assert.rejects(write(harness, 'hello world'), /moved while/i);

        assert.equal(harness.submissions.length, 1);
        assert.equal(harness.doc.version, 9);
        assert.equal(harness.doc.remoteCache, 'hello world + collaborator');
        assert.equal(harness.getRemoteText(), 'hello world + collaborator');
    });

    it('rechecks remote authority after durable provenance I/O and immediately before submission', async () => {
        const duringPending = makeHarness({remoteText: 'base', remoteVersion: 7});
        duringPending.vfs.activeEditorBases.set('doc-1', {
            identity: duringPending.identity,
            version: 7,
            content: 'base',
        });
        duringPending.storage.afterWrite = (_name, bytes) => {
            const record = JSON.parse(new TextDecoder().decode(bytes)) as {pendingWrite?: unknown};
            if (record.pendingWrite === undefined) { return; }
            duringPending.setRemoteText('base + collaborator');
            duringPending.doc.version = 8;
            duringPending.doc.remoteCache = 'base + collaborator';
        };

        await assert.rejects(write(duringPending, 'base + local'), /changed before/i);
        assert.equal(duringPending.submissions.length, 0);
        assert.equal(duringPending.getRemoteText(), 'base + collaborator');
        assert.equal(duringPending.vfs.sourceRevision, 0);

        const resolutionRace = makeHarness({remoteText: 'base', remoteVersion: 7});
        resolutionRace.vfs.activeEditorBases.set('doc-1', {
            identity: resolutionRace.identity,
            version: 7,
            content: 'base',
        });
        let firstWrite = true;
        resolutionRace.storage.afterWrite = () => {
            if (!firstWrite) { return; }
            firstWrite = false;
            resolutionRace.setRemoteText('collaborator first');
            resolutionRace.doc.version = 8;
            resolutionRace.doc.remoteCache = 'collaborator first';
        };

        await assert.rejects(write(resolutionRace, 'base + local'), /provenance was being checked/i);
        assert.equal(resolutionRace.submissions.length, 0);
        assert.equal(resolutionRace.getRemoteText(), 'collaborator first');
    });

    it('does not duplicate a write after an unknown outcome in the same or a restarted window', async () => {
        const storage = new MemoryStorage();
        const unknown = new SocketRequestError('timeout', 'unknown acknowledgement', true);
        const first = makeHarness({storage, sessionId: 'submitting-window', applyError: unknown});
        first.vfs.activeEditorBases.set('doc-1', {
            identity: first.identity,
            version: 7,
            content: 'remote text',
        });

        await assert.rejects(write(first, 'local edit'), error => error === unknown);
        assert.equal(first.submissions.length, 1);

        await assert.rejects(write(first, 'local edit'), /save blocked/i);
        assert.equal(first.submissions.length, 1);

        const restarted = makeHarness({storage, sessionId: 'restarted-window'});
        await assert.rejects(write(restarted, 'local edit'), /save blocked/i);
        assert.equal(restarted.submissions.length, 0);
        assert.equal(restarted.getRemoteText(), 'remote text');

        const waiterStorage = new MemoryStorage();
        const waiter = makeHarness({
            storage: waiterStorage,
            sessionId: 'waiter-disconnected-window',
            versionError: new Error('Document session disconnected'),
        });
        waiter.vfs.activeEditorBases.set('doc-1', {
            identity: waiter.identity,
            version: 7,
            content: 'remote text',
        });
        await assert.rejects(write(waiter, 'local edit'), (error: unknown) =>
            error instanceof SocketRequestError && error.outcomeUnknown
        );
        assert.equal(waiter.submissions.length, 1);
        const retainedAfterPlainWaiterError = await waiter.store.recoverCold(
            waiter.identity,
            'local edit',
        );
        assert.equal(retainedAfterPlainWaiterError.kind, 'valid');
        if (retainedAfterPlainWaiterError.kind === 'valid') {
            assert.notEqual(retainedAfterPlainWaiterError.record.pendingWrite, undefined);
        }

        const appliedStorage = new MemoryStorage();
        const applied = makeHarness({
            storage: appliedStorage,
            sessionId: 'ack-lost-window',
            applyError: unknown,
            applyBeforeError: true,
        });
        applied.vfs.activeEditorBases.set('doc-1', {
            identity: applied.identity,
            version: 7,
            content: 'remote text',
        });
        await assert.rejects(write(applied, 'local edit'), error => error === unknown);
        assert.equal(applied.submissions.length, 1);
        assert.equal(applied.getRemoteText(), 'local edit');

        const afterAckLoss = makeHarness({
            storage: appliedStorage,
            sessionId: 'after-ack-loss-window',
            remoteText: 'local edit',
            remoteVersion: 8,
        });
        await write(afterAckLoss, 'local edit');
        assert.equal(afterAckLoss.submissions.length, 0);
        const retainedForeignRecords = await appliedStorage.list();
        assert.equal(retainedForeignRecords.length, 1);
        const retained = await afterAckLoss.store.recoverCold(afterAckLoss.identity, 'local edit');
        assert.equal(retained.kind, 'valid');
        if (retained.kind === 'valid') {
            assert.notEqual(retained.record.pendingWrite, undefined);
        }
    });

    it('does not authorize with provenance from another server, account, project, document, protocol, or window', async () => {
        const dimensions: Array<keyof DocumentProvenanceIdentity> = [
            'canonicalServerUrl', 'userId', 'projectId', 'docId', 'protocolVersion',
        ];
        for (const dimension of dimensions) {
            const harness = makeHarness({sessionId: `reader-${dimension}`});
            const foreignIdentity = {...harness.identity} as DocumentProvenanceIdentity;
            if (dimension === 'protocolVersion') {
                foreignIdentity.protocolVersion += 1;
            } else if (dimension === 'canonicalServerUrl') {
                foreignIdentity.canonicalServerUrl = 'https://foreign.example.test';
            } else {
                (foreignIdentity as any)[dimension] = `foreign-${dimension}`;
            }
            await seedColdRecord(
                harness.storage,
                foreignIdentity,
                `foreign-${dimension}`,
                7,
                'remote text',
                'local edit',
            );

            await assert.rejects(write(harness, 'local edit'));
            assert.equal(harness.submissions.length, 0, dimension);
        }

        const differentWindowBuffer = makeHarness({sessionId: 'reader-window'});
        await seedColdRecord(
            differentWindowBuffer.storage,
            differentWindowBuffer.identity,
            'other-window',
            7,
            'remote text',
            'another window edit',
        );
        await assert.rejects(write(differentWindowBuffer, 'local edit'));
        assert.equal(differentWindowBuffer.submissions.length, 0);

        const sharedCold = makeHarness({sessionId: 'cold-reader-a'});
        await seedColdRecord(
            sharedCold.storage,
            sharedCold.identity,
            'pre-crash-owner',
            7,
            'remote text',
            'local edit',
        );
        const otherCold = makeHarness({
            storage: sharedCold.storage,
            sessionId: 'cold-reader-b',
        });
        await Promise.all([
            assert.rejects(write(sharedCold, 'local edit')),
            assert.rejects(write(otherCold, 'local edit')),
        ]);
        assert.equal(sharedCold.submissions.length, 0);
        assert.equal(otherCold.submissions.length, 0);

        const unknownProtocol = makeHarness();
        unknownProtocol.vfs.protocolVersion = undefined;
        await assert.rejects(write(unknownProtocol, 'local edit'));
        assert.equal(unknownProtocol.submissions.length, 0);

        const invisible = makeHarness();
        invisible.vfs.socket.isUsingAlternativeConnectionScheme = true;
        invisible.vfs.activeEditorBases.set('doc-1', {
            identity: invisible.identity,
            version: 7,
            content: 'remote text',
        });
        await assert.rejects(write(invisible, 'local edit'));
        assert.equal(invisible.submissions.length, 0);
    });
});
