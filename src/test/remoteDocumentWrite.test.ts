/* eslint-disable @typescript-eslint/naming-convention */
import {strict as assert} from 'assert';
import {SocketRequestError} from '../api/socketRequest';
import {RealtimeFatalError} from '../api/socketio';
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

const openTextDocuments: any[] = [];

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
        textDocuments: openTextDocuments,
        fs: {writeFile: async (..._args: any[]) => {}},
        getConfiguration: () => ({get: (_key: string, fallback: unknown) => fallback}),
        onDidOpenTextDocument: () => new DisposableStub(),
        onDidChangeTextDocument: () => new DisposableStub(),
        onWillSaveTextDocument: () => new DisposableStub(),
        onDidSaveTextDocument: () => new DisposableStub(),
        onDidCloseTextDocument: () => new DisposableStub(),
        registerFileSystemProvider: () => new DisposableStub(),
        createFileSystemWatcher: () => ({
            onDidCreate: () => new DisposableStub(),
            onDidChange: () => new DisposableStub(),
            onDidDelete: () => new DisposableStub(),
            dispose: () => {},
        }),
    },
    window: {
        activeTextEditor: undefined as any,
        showErrorMessage: async (..._args: any[]): Promise<any> => undefined,
        showWarningMessage: async (..._args: any[]): Promise<any> => undefined,
        showInformationMessage: async (..._args: any[]): Promise<any> => undefined,
        showSaveDialog: async (..._args: any[]): Promise<any> => undefined,
        showTextDocument: async (..._args: any[]): Promise<any> => undefined,
        withProgress: async (_options: unknown, task: () => Promise<unknown>) => task(),
        createStatusBarItem: () => ({show: () => {}, hide: () => {}, dispose: () => {}}),
        createTreeView: () => ({dispose: () => {}}),
    },
    commands: {
        executeCommand: async (..._args: any[]): Promise<any> => undefined,
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

class TestTextDocument {
    isDirty = false;
    isClosed = false;
    version = 1;
    saveHandler?: () => Promise<boolean>;

    constructor(readonly uri: TestUri, private text: string) {}

    getText(): string {
        return this.text;
    }

    setDirtyText(text: string): void {
        if (this.text !== text) {
            this.text = text;
            this.version += 1;
        }
        this.isDirty = true;
    }

    markClean(): void {
        this.isDirty = false;
    }

    positionAt(offset: number): number {
        return offset;
    }

    save(): Promise<boolean> {
        return this.saveHandler?.() ?? Promise.resolve(false);
    }
}

class MemoryStorage implements ProvenanceStorage {
    readonly records = new Map<string, Uint8Array>();
    beforeWrite?: (name: string, content: Uint8Array) => void | Promise<void>;
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
        await this.beforeWrite?.(name, content);
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
    confirmationVersion?: number,
};

type Harness = {
    vfs: any,
    uri: TestUri,
    document: TestTextDocument,
    doc: import('../core/remoteFileSystemProvider').DocumentEntity,
    identity: DocumentProvenanceIdentity,
    storage: MemoryStorage,
    store: DocumentProvenanceStore,
    submissions: Array<{docId: string, update: any}>,
    getRemoteText(): string,
    setRemoteText(value: string): void,
    setRemoteVersion(value: number): void,
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
    const protocolVersion = options.protocolVersion ?? 2;
    let remoteVersion = options.remoteVersion ?? 7;
    let remoteText = options.remoteText ?? 'remote text';
    const uri = makeUri(`/Project/main.tex`, 'overleaf-workshop', 'server',
        `user=${userId}&project=${projectId}`);
    const document = new TestTextDocument(uri, remoteText);
    openTextDocuments.push(document);
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
    const project = {_id: projectId, rootFolder: [rootFolder]};
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
        pendingReadTickets: new Map(),
        boundReadCandidates: new Map(),
        activeEditorBases: new Map(),
        documentIdsByPath: new Map([[uri.toString(), docId]]),
        editorBufferIds: new WeakMap(),
        editorBuffers: new Map(),
        editorSaveIntents: new Map(),
        unboundEditorSaveIntents: new WeakMap(),
        editorSaveReceipts: new Map(),
        recoveryNotifications: new Set(),
        provenanceStore: store,
        notify: () => {},
        socket: {
            generation: 1,
            isConnected: true,
            isUsingAlternativeConnectionScheme: false,
            fatalError: undefined,
            projectSession: {
                publicId: 'public-1',
                permissionsLevel: 'owner',
                protocolVersion,
                generation: 1,
            },
            applyOtUpdate: async (submittedDocId: string, update: any) => {
                submissions.push({docId: submittedDocId, update});
                if (options.applyError && !options.applyBeforeError) { throw options.applyError; }
                remoteText = applyOperations(remoteText, update.op ?? []);
                remoteVersion = Math.max(remoteVersion, update.v + 1);
                if (options.applyError) { throw options.applyError; }
            },
        },
        _resolveUri: async () => ({fileType: 'doc', fileEntity: doc}),
        ensureDocumentSession: async () => {
            doc.version = remoteVersion;
            doc.remoteCache = remoteText;
            return {doc, content: remoteText};
        },
        waitForDocumentVersion: (_docId: string, expectedVersion: number) => ({
            promise: options.versionError ?
                Promise.reject(options.versionError) :
                Promise.resolve(options.confirmationVersion ?? expectedVersion),
            cancel: () => {},
        }),
        joinFreshDocumentSession: async () => {
            doc.version = remoteVersion;
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
        canonicalEditorUri: JSON.stringify([
            'overleaf-workshop',
            'https://example.test',
            userId,
            projectId,
            docId,
        ]),
        otType: 'sharejs-text-ot',
        protocolVersion,
    };
    return {
        vfs,
        uri,
        document,
        doc,
        identity,
        storage,
        store,
        submissions,
        getRemoteText: () => remoteText,
        setRemoteText: value => { remoteText = value; },
        setRemoteVersion: value => { remoteVersion = value; },
    };
}

async function write(harness: Harness, text: string): Promise<void> {
    harness.document.setDirtyText(text);
    harness.vfs.observeTextDocument(harness.document);
    harness.vfs.observeWillSaveTextDocument(harness.document);
    await harness.vfs.writeFileNow(harness.uri, new TextEncoder().encode(text), false, true);
    harness.document.markClean();
    harness.vfs.observeTextDocument(harness.document);
}

async function confirmBase(harness: Harness, text: string): Promise<string> {
    harness.vfs.stageEditorBase(harness.uri, harness.doc, text);
    assert.equal(await harness.vfs.confirmEditorBase(harness.document), true);
    const bufferId = harness.vfs.editorBufferIds.get(harness.document);
    assert.equal(typeof bufferId, 'string');
    return bufferId;
}

function closeHarnessDocument(harness: Harness): void {
    harness.document.isClosed = true;
    harness.vfs.forgetTextDocument(harness.document);
    const index = openTextDocuments.indexOf(harness.document);
    if (index >= 0) { openTextDocuments.splice(index, 1); }
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
    const record = await store.createOrUpdateCurrent({
        identity,
        bufferIncarnationId: `${sessionId}-buffer`,
        baseVersion,
        baseText,
        dirtyText,
    });
    await store.flush();
    return record.recordName;
}

describe('remote document exact-base write gate', () => {
    beforeEach(() => {
        openTextDocuments.length = 0;
    });

    it('rejects a mismatched joined project before exposing state or compiling', async () => {
        const harness = makeHarness();
        let compileCommands = 0;
        const originalExecute = vscodeStub.commands.executeCommand;
        try {
            vscodeStub.commands.executeCommand = async (command: string) => {
                if (command === 'overleaf-workshop.compileManager.compile') {
                    compileCommands += 1;
                }
            };
            harness.vfs.disposed = false;
            harness.vfs.root = undefined;
            harness.vfs.joiningProject = undefined;
            harness.vfs.socket = {
                fatalError: undefined,
                needsReinit: false,
                generation: 1,
                isConnected: true,
                waitUntilConnected: async () => 1,
                joinProject: async () => ({_id: 'wrong-project', rootFolder: []}),
            };

            await assert.rejects(
                harness.vfs.connectWithRetry(),
                (error: unknown) => error instanceof RealtimeFatalError
                    && error.code === 'project_unavailable',
            );
            assert.equal(harness.vfs.root, undefined);
            assert.equal(harness.vfs.joiningProject, undefined);
            assert.equal(compileCommands, 0);
        } finally {
            vscodeStub.commands.executeCommand = originalExecute;
        }
    });

    it('serializes a path-key creation with a doc-key follow-up save', async () => {
        const harness = makeHarness();
        let resolveFirst!: () => void;
        let signalFirstStarted!: () => void;
        const holdFirst = new Promise<void>(resolve => { resolveFirst = resolve; });
        const firstStarted = new Promise<void>(resolve => { signalFirstStarted = resolve; });
        const executions: string[] = [];
        let resolutions = 0;
        harness.vfs._resolveUri = async () => {
            resolutions += 1;
            return resolutions === 1 ?
                {fileType: undefined, fileEntity: undefined} :
                {fileType: 'doc', fileEntity: harness.doc};
        };
        harness.vfs.writeFileNow = async (
            _uri: TestUri,
            content: Uint8Array,
        ) => {
            executions.push(new TextDecoder().decode(content));
            if (executions.length === 1) {
                signalFirstStarted();
                await holdFirst;
            }
        };

        const first = harness.vfs.writeFile(
            harness.uri,
            new TextEncoder().encode('initial create'),
            true,
            false,
        );
        await firstStarted;
        const second = harness.vfs.writeFile(
            harness.uri,
            new TextEncoder().encode('follow-up save'),
            false,
            true,
        );
        await new Promise(resolve => setImmediate(resolve));

        assert.deepEqual(executions, ['initial create']);
        resolveFirst();
        await Promise.all([first, second]);
        assert.deepEqual(executions, ['initial create', 'follow-up save']);
        assert.equal(harness.vfs.documentWrites.size, 0);
    });

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

    it('rejects missing paths and never re-resolves non-document entities through upload creation', async () => {
        const missing = makeHarness();
        missing.vfs._resolveUri = async () => ({fileType: undefined, fileEntity: undefined});
        let missingCreateCalls = 0;
        missing.vfs.createFile = async () => { missingCreateCalls += 1; };
        await assert.rejects(
            missing.vfs.writeFileNow(
                missing.uri,
                new TextEncoder().encode('must not be created'),
                false,
                true,
            ),
            /FileNotFound/,
        );
        assert.equal(missingCreateCalls, 0);
        assert.equal(missing.submissions.length, 0);

        const binary = makeHarness();
        let binaryResolutions = 0;
        binary.vfs._resolveUri = async () => {
            binaryResolutions += 1;
            return binaryResolutions === 1 ? {
                fileType: 'file',
                fileEntity: {_id: 'binary-1', name: 'image.png', _type: 'file'},
            } : {
                fileType: undefined,
                fileEntity: undefined,
            };
        };
        let binaryCreateCalls = 0;
        binary.vfs.createFile = async () => { binaryCreateCalls += 1; };
        await assert.rejects(
            binary.vfs.writeFileNow(
                binary.uri,
                new TextEncoder().encode('must not overwrite'),
                true,
                true,
            ),
            /Only Overleaf text documents/i,
        );
        assert.equal(binaryResolutions, 1, 'the non-doc path must not be resolved again');
        assert.equal(binaryCreateCalls, 0);
        assert.equal(binary.submissions.length, 0);

        const binaryWithoutCreate = makeHarness();
        binaryWithoutCreate.vfs._resolveUri = async () => ({
            fileType: 'file',
            fileEntity: {_id: 'binary-2', name: 'image.png', _type: 'file'},
        });
        await assert.rejects(
            binaryWithoutCreate.vfs.writeFileNow(
                binaryWithoutCreate.uri,
                new TextEncoder().encode('must not overwrite'),
                false,
                true,
            ),
            /Only Overleaf text documents/i,
        );
        assert.equal(binaryWithoutCreate.submissions.length, 0);
    });

    it('writes recovery-copy bytes from the same editor at dialog completion', async () => {
        const harness = makeHarness({remoteText: 'authoritative'});
        harness.vfs.observeTextDocument(harness.document);
        harness.document.setDirtyText('initial blocked bytes');
        harness.vfs.observeTextDocument(harness.document);
        const target = makeUri('/recovery.tex', 'file', '', '');
        const writes: Array<{target: TestUri, content: Uint8Array}> = [];
        const originalError = vscodeStub.window.showErrorMessage;
        const originalSave = vscodeStub.window.showSaveDialog;
        const originalWrite = vscodeStub.workspace.fs.writeFile;
        try {
            vscodeStub.window.showErrorMessage = async () => 'Save Recovery Copy...';
            vscodeStub.window.showSaveDialog = async () => {
                harness.document.setDirtyText('latest bytes at dialog completion');
                return target;
            };
            vscodeStub.workspace.fs.writeFile = async (writtenTarget: TestUri, content: Uint8Array) => {
                writes.push({target: writtenTarget, content: new Uint8Array(content)});
            };
            delete harness.vfs.showDocumentRecovery;

            harness.vfs.showDocumentRecovery(
                harness.uri,
                new TextEncoder().encode('captured bytes must be ignored'),
                'test recovery',
            );
            for (let attempt = 0; attempt < 10 && writes.length === 0; attempt += 1) {
                await new Promise<void>(resolve => setImmediate(resolve));
            }

            assert.equal(writes.length, 1);
            assert.strictEqual(writes[0].target, target);
            assert.equal(
                new TextDecoder().decode(writes[0].content),
                'latest bytes at dialog completion',
            );
            assert.equal(harness.submissions.length, 0);
            assert.equal(harness.document.isDirty, true);
        } finally {
            vscodeStub.window.showErrorMessage = originalError;
            vscodeStub.window.showSaveDialog = originalSave;
            vscodeStub.workspace.fs.writeFile = originalWrite;
        }
    });

    it('does not let an old recovery prompt write a reopened buffer incarnation', async () => {
        const harness = makeHarness({remoteText: 'authoritative'});
        harness.vfs.observeTextDocument(harness.document);
        harness.document.setDirtyText('old blocked buffer');
        harness.vfs.observeTextDocument(harness.document);
        const target = makeUri('/must-not-write.tex', 'file', '', '');
        let writes = 0;
        let reopened: TestTextDocument | undefined;
        const originalError = vscodeStub.window.showErrorMessage;
        const originalSave = vscodeStub.window.showSaveDialog;
        const originalWrite = vscodeStub.workspace.fs.writeFile;
        try {
            vscodeStub.window.showErrorMessage = async () => 'Save Recovery Copy...';
            vscodeStub.window.showSaveDialog = async () => {
                harness.document.isClosed = true;
                openTextDocuments.splice(0, openTextDocuments.length);
                reopened = new TestTextDocument(harness.uri, 'new reopened buffer');
                openTextDocuments.push(reopened);
                return target;
            };
            vscodeStub.workspace.fs.writeFile = async () => { writes += 1; };
            delete harness.vfs.showDocumentRecovery;

            harness.vfs.showDocumentRecovery(
                harness.uri,
                new TextEncoder().encode('old blocked buffer'),
                'test reopened buffer',
            );
            for (let attempt = 0; attempt < 5; attempt += 1) {
                await new Promise<void>(resolve => setImmediate(resolve));
            }

            assert.equal(writes, 0);
            assert.equal(reopened?.getText(), 'new reopened buffer');
            assert.equal(reopened?.isDirty, false);
            assert.equal(harness.submissions.length, 0);
        } finally {
            vscodeStub.window.showErrorMessage = originalError;
            vscodeStub.window.showSaveDialog = originalSave;
            vscodeStub.workspace.fs.writeFile = originalWrite;
        }
    });

    it('does not let an old reload prompt revert a reopened buffer incarnation', async () => {
        const harness = makeHarness({remoteText: 'authoritative'});
        harness.vfs.observeTextDocument(harness.document);
        harness.document.setDirtyText('old blocked buffer');
        harness.vfs.observeTextDocument(harness.document);
        let reopened: TestTextDocument | undefined;
        let exactEditorEdits = 0;
        const originalError = vscodeStub.window.showErrorMessage;
        const originalWarning = vscodeStub.window.showWarningMessage;
        const originalShowDocument = vscodeStub.window.showTextDocument;
        const originalActive = vscodeStub.window.activeTextEditor;
        try {
            vscodeStub.window.showErrorMessage = async () => 'Reload Remote';
            vscodeStub.window.showWarningMessage = async () => 'Reload Remote';
            vscodeStub.window.showTextDocument = async () => {
                harness.document.isClosed = true;
                reopened = new TestTextDocument(harness.uri, 'new reopened buffer');
                openTextDocuments.splice(0, openTextDocuments.length, reopened);
                vscodeStub.window.activeTextEditor = {document: reopened};
                return {
                    document: reopened,
                    edit: async () => {
                        exactEditorEdits += 1;
                        return true;
                    },
                };
            };
            delete harness.vfs.showDocumentRecovery;

            harness.vfs.showDocumentRecovery(
                harness.uri,
                new TextEncoder().encode('old blocked buffer'),
                'test reopened reload',
            );
            for (let attempt = 0; attempt < 5; attempt += 1) {
                await new Promise<void>(resolve => setImmediate(resolve));
            }

            assert.equal(exactEditorEdits, 0);
            assert.equal(reopened?.getText(), 'new reopened buffer');
            assert.equal(reopened?.isDirty, false);
            assert.equal(harness.submissions.length, 0);
        } finally {
            vscodeStub.window.showErrorMessage = originalError;
            vscodeStub.window.showWarningMessage = originalWarning;
            vscodeStub.window.showTextDocument = originalShowDocument;
            vscodeStub.window.activeTextEditor = originalActive;
        }
    });

    it('freshly reloads only the exact blocked editor even if focus changes', async () => {
        const harness = makeHarness({remoteText: 'cached authoritative', remoteVersion: 7});
        harness.vfs.observeTextDocument(harness.document);
        harness.document.setDirtyText('blocked local bytes');
        harness.vfs.observeTextDocument(harness.document);
        harness.setRemoteText('fresh authoritative + collaborator');
        harness.setRemoteVersion(8);
        const unrelated = new TestTextDocument(makeUri('/unrelated.tex'), 'unrelated bytes');
        openTextDocuments.push(unrelated);
        let exactEditorEdits = 0;
        let globalReverts = 0;
        const originalError = vscodeStub.window.showErrorMessage;
        const originalWarning = vscodeStub.window.showWarningMessage;
        const originalShowDocument = vscodeStub.window.showTextDocument;
        const originalActive = vscodeStub.window.activeTextEditor;
        const originalExecute = vscodeStub.commands.executeCommand;
        try {
            vscodeStub.window.showErrorMessage = async () => 'Reload Remote';
            vscodeStub.window.showWarningMessage = async () => 'Reload Remote';
            vscodeStub.window.showTextDocument = async (document: TestTextDocument) => ({
                document,
                edit: async (callback: (edit: {replace: (_range: unknown, text: string) => void}) => void) => {
                    let replacement: string | undefined;
                    callback({replace: (_range, text) => { replacement = text; }});
                    if (replacement === undefined) { return false; }
                    exactEditorEdits += 1;
                    document.setDirtyText(replacement);
                    return true;
                },
            });
            const joinFresh = harness.vfs.joinFreshDocumentSession.bind(harness.vfs);
            harness.vfs.joinFreshDocumentSession = async (docId: string) => {
                const authoritative = await joinFresh(docId);
                vscodeStub.window.activeTextEditor = {document: unrelated};
                return authoritative;
            };
            harness.document.saveHandler = async () => {
                harness.document.markClean();
                return true;
            };
            vscodeStub.commands.executeCommand = async (command: string) => {
                if (command === 'workbench.action.files.revert') { globalReverts += 1; }
            };
            delete harness.vfs.showDocumentRecovery;

            harness.vfs.showDocumentRecovery(
                harness.uri,
                new TextEncoder().encode('blocked local bytes'),
                'test exact-object reload',
            );
            for (let attempt = 0; attempt < 10 && exactEditorEdits === 0; attempt += 1) {
                await new Promise<void>(resolve => setImmediate(resolve));
            }

            assert.equal(exactEditorEdits, 1);
            assert.equal(globalReverts, 0);
            assert.equal(harness.document.getText(), 'fresh authoritative + collaborator');
            assert.equal(harness.document.isDirty, false);
            assert.equal(unrelated.getText(), 'unrelated bytes');
            assert.equal(unrelated.isDirty, false);
        } finally {
            vscodeStub.window.showErrorMessage = originalError;
            vscodeStub.window.showWarningMessage = originalWarning;
            vscodeStub.window.showTextDocument = originalShowDocument;
            vscodeStub.window.activeTextEditor = originalActive;
            vscodeStub.commands.executeCommand = originalExecute;
        }
    });

    it('submits exactly one OT update from an exact acknowledged base and reconciles it', async () => {
        const harness = makeHarness({remoteText: 'hello', remoteVersion: 7});
        await confirmBase(harness, 'hello');

        await write(harness, 'hello world');

        assert.equal(harness.submissions.length, 1);
        assert.equal(harness.submissions[0].docId, 'doc-1');
        assert.equal(harness.submissions[0].update.v, 7);
        assert.equal(harness.getRemoteText(), 'hello world');
        assert.equal(harness.doc.localCache, 'hello world');
        assert.equal(harness.doc.remoteCache, 'hello world');
        const records = await harness.storage.list();
        assert.equal(records.length, 1);
        const reconciled = await harness.store.resolveCurrentRecord(records[0], {
            identity: harness.identity,
            bufferIncarnationId: harness.vfs.editorBufferIds.get(harness.document),
            baseVersion: 8,
            baseText: 'hello world',
            dirtyText: 'hello world',
        });
        assert.equal(reconciled.kind, 'valid');
        if (reconciled.kind === 'valid') {
            assert.equal(reconciled.record.pendingWrite, undefined);
        }
    });

    it('promotes only an explicitly confirmed clean provider read and persists the later dirty editor text', async () => {
        const harness = makeHarness({remoteText: 'clean base', remoteVersion: 7});
        harness.vfs.stageEditorBase(harness.uri, harness.doc, 'clean base');
        harness.vfs.observeTextDocument(harness.document);
        const bufferId = harness.vfs.editorBufferIds.get(harness.document);
        assert.equal(harness.vfs.activeEditorBases.has(bufferId), false);
        assert.equal(await harness.vfs.confirmEditorBase(harness.document), true);
        harness.document.setDirtyText('dirty edit');
        harness.vfs.observeTextDocument(harness.document);
        await harness.store.flush();

        const active = harness.vfs.activeEditorBases.get(bufferId);
        assert.equal(active?.version, 7);
        assert.equal(active?.content, 'clean base');
        const persisted = await harness.store.resolveCurrentRecord(active.recordName, {
            identity: harness.identity,
            bufferIncarnationId: bufferId,
            baseVersion: 7,
            baseText: 'clean base',
            dirtyText: 'dirty edit',
        });
        assert.equal(persisted.kind, 'valid');

        await write(harness, 'dirty edit');
        assert.equal(harness.submissions.length, 1);
        assert.equal(harness.getRemoteText(), 'dirty edit');
    });

    it('keeps the host dirty when realtime advances during acknowledged cleanup', async () => {
        const harness = makeHarness({remoteText: 'hello', remoteVersion: 7});
        await confirmBase(harness, 'hello');
        let advanced = false;
        harness.storage.afterWrite = (_name, bytes) => {
            const record = JSON.parse(new TextDecoder().decode(bytes)) as {
                pendingWrite?: unknown,
                baseVersion?: number,
                baseText?: string,
            };
            if (advanced
                || record.pendingWrite !== undefined
                || record.baseVersion !== 8
                || record.baseText !== 'hello world') { return; }
            advanced = true;
            harness.setRemoteText('hello world + collaborator');
            harness.doc.version = 9;
            harness.doc.remoteCache = 'hello world + collaborator';
        };

        await assert.rejects(
            write(harness, 'hello world'),
            /confirmed with collaborator text absent from this editor/i,
        );

        assert.equal(harness.submissions.length, 1);
        assert.equal(harness.document.isDirty, true);
        assert.equal(harness.document.getText(), 'hello world');
        assert.equal(harness.doc.version, 9);
        assert.equal(harness.doc.remoteCache, 'hello world + collaborator');
        assert.equal(harness.getRemoteText(), 'hello world + collaborator');
    });

    it('rejects a fresh snapshot behind the observed transformed confirmation', async () => {
        const harness = makeHarness({
            remoteText: 'hello',
            remoteVersion: 7,
            confirmationVersion: 9,
        });
        const bufferId = await confirmBase(harness, 'hello');

        await assert.rejects(
            write(harness, 'hello world'),
            /authoritative revision is behind the observed sender confirmation/i,
        );

        assert.equal(harness.submissions.length, 1);
        assert.equal(harness.getRemoteText(), 'hello world');
        assert.equal(harness.document.isDirty, true);
        assert.equal(harness.document.getText(), 'hello world');
        const pending = harness.vfs.pendingDocumentUpdates.get(bufferId);
        assert.equal(pending?.confirmationVersion, 9);
        const records = await harness.storage.list();
        assert.equal(records.length, 1);
        const persisted = JSON.parse(new TextDecoder().decode(
            harness.storage.records.get(records[0])!,
        )) as {pendingWrite?: unknown};
        assert.notEqual(persisted.pendingWrite, undefined);
    });

    it('keeps the acknowledged base when the same buffer changes during cleanup', async () => {
        const harness = makeHarness({remoteText: 'hello', remoteVersion: 7});
        const bufferId = await confirmBase(harness, 'hello');
        harness.document.setDirtyText('hello world');
        harness.vfs.observeTextDocument(harness.document);
        harness.vfs.observeWillSaveTextDocument(harness.document);
        let advanced = false;
        harness.storage.afterWrite = (_name, bytes) => {
            const record = JSON.parse(new TextDecoder().decode(bytes)) as {
                pendingWrite?: unknown,
                baseVersion?: number,
                baseText?: string,
            };
            if (advanced
                || record.pendingWrite !== undefined
                || record.baseVersion !== 8
                || record.baseText !== 'hello world') { return; }
            advanced = true;
            harness.document.setDirtyText('hello world + next local edit');
            harness.vfs.observeTextDocument(harness.document);
        };

        await harness.vfs.writeFileNow(
            harness.uri,
            new TextEncoder().encode('hello world'),
            false,
            true,
        );

        assert.equal(harness.submissions.length, 1);
        assert.equal(harness.getRemoteText(), 'hello world');
        assert.equal(harness.document.isDirty, true);
        assert.equal(harness.document.getText(), 'hello world + next local edit');
        const active = harness.vfs.activeEditorBases.get(bufferId);
        assert.equal(active?.version, 8);
        assert.equal(active?.content, 'hello world');

        harness.vfs.observeTextDocument(harness.document);
        await harness.store.flush();
        assert.equal(typeof active?.recordName, 'string');
        const persisted = await harness.store.resolveCurrentRecord(active.recordName, {
            identity: harness.identity,
            bufferIncarnationId: bufferId,
            baseVersion: 8,
            baseText: 'hello world',
            dirtyText: 'hello world + next local edit',
        });
        assert.equal(persisted.kind, 'valid');

        harness.storage.afterWrite = undefined;
        harness.vfs.observeWillSaveTextDocument(harness.document);
        await harness.vfs.writeFileNow(
            harness.uri,
            new TextEncoder().encode('hello world + next local edit'),
            false,
            true,
        );
        assert.equal(harness.submissions.length, 2, 'only the later edit may produce the second OT');
        assert.equal(harness.getRemoteText(), 'hello world + next local edit');
    });

    it('retries confirmed-state persistence without resending the acknowledged OT', async () => {
        const harness = makeHarness({remoteText: 'hello', remoteVersion: 7});
        const bufferId = await confirmBase(harness, 'hello');
        let failedReconciliation = false;
        harness.storage.beforeWrite = (_name, bytes) => {
            const record = JSON.parse(new TextDecoder().decode(bytes)) as {
                pendingWrite?: unknown,
                baseVersion?: number,
                baseText?: string,
            };
            if (failedReconciliation
                || record.pendingWrite !== undefined
                || record.baseVersion !== 8
                || record.baseText !== 'hello world') { return; }
            failedReconciliation = true;
            throw new Error('injected confirmed-state persistence failure');
        };

        await assert.rejects(
            write(harness, 'hello world'),
            /confirmed-state persistence failure/,
        );
        assert.equal(harness.submissions.length, 1);
        assert.equal(harness.getRemoteText(), 'hello world');
        assert.equal(harness.document.isDirty, true);
        const pending = harness.vfs.pendingDocumentUpdates.get(bufferId);
        assert.equal(pending?.confirmationVersion, 7);

        harness.storage.beforeWrite = undefined;
        await write(harness, 'hello world');
        assert.equal(harness.submissions.length, 1, 'confirmed recovery must emit zero duplicate OT');
        assert.equal(harness.document.isDirty, false);
        assert.equal(harness.vfs.pendingDocumentUpdates.has(bufferId), false);
        const active = harness.vfs.activeEditorBases.get(bufferId);
        const resolved = await harness.store.resolveCurrentRecord(active.recordName, {
            identity: harness.identity,
            bufferIncarnationId: bufferId,
            baseVersion: 8,
            baseText: 'hello world',
            dirtyText: 'hello world',
        });
        assert.equal(resolved.kind, 'valid', JSON.stringify(resolved));
        if (resolved.kind === 'valid') {
            assert.equal(resolved.record.pendingWrite, undefined);
        }
    });

    it('does not make record deletion part of acknowledged-write completion', async () => {
        const harness = makeHarness({remoteText: 'hello', remoteVersion: 7});
        await confirmBase(harness, 'hello');
        let deleteCalls = 0;
        harness.storage.beforeDelete = () => {
            deleteCalls += 1;
            throw new Error('injected delete failure');
        };

        await write(harness, 'hello world');

        assert.equal(deleteCalls, 0);
        assert.equal(harness.submissions.length, 1);
        assert.equal(harness.getRemoteText(), 'hello world');
        const records = await harness.storage.list();
        assert.equal(records.length, 1);
        const parsed = JSON.parse(new TextDecoder().decode(
            harness.storage.records.get(records[0])!,
        )) as {pendingWrite?: unknown};
        assert.equal(parsed.pendingWrite, undefined);
    });

    it('rechecks remote authority after durable provenance I/O and immediately before submission', async () => {
        const duringPending = makeHarness({remoteText: 'base', remoteVersion: 7});
        await confirmBase(duringPending, 'base');
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
        closeHarnessDocument(duringPending);

        const resolutionRace = makeHarness({remoteText: 'base', remoteVersion: 7});
        await confirmBase(resolutionRace, 'base');
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
        await confirmBase(first, 'remote text');

        await assert.rejects(write(first, 'local edit'), error => error === unknown);
        assert.equal(first.submissions.length, 1);

        await assert.rejects(write(first, 'local edit'), /save blocked/i);
        assert.equal(first.submissions.length, 1);
        closeHarnessDocument(first);

        const restarted = makeHarness({storage, sessionId: 'restarted-window'});
        await assert.rejects(write(restarted, 'local edit'), /save blocked/i);
        assert.equal(restarted.submissions.length, 0);
        assert.equal(restarted.getRemoteText(), 'remote text');
        closeHarnessDocument(restarted);

        const waiterStorage = new MemoryStorage();
        const waiter = makeHarness({
            storage: waiterStorage,
            sessionId: 'waiter-disconnected-window',
            versionError: new Error('Document session disconnected'),
        });
        await confirmBase(waiter, 'remote text');
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
        closeHarnessDocument(waiter);

        const appliedStorage = new MemoryStorage();
        const applied = makeHarness({
            storage: appliedStorage,
            sessionId: 'ack-lost-window',
            applyError: unknown,
            applyBeforeError: true,
        });
        await confirmBase(applied, 'remote text');
        await assert.rejects(write(applied, 'local edit'), error => error === unknown);
        assert.equal(applied.submissions.length, 1);
        assert.equal(applied.getRemoteText(), 'local edit');
        closeHarnessDocument(applied);

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

    it('restores the original pending intent when a deduplicated retry is known to fail', async () => {
        const unknown = new SocketRequestError('timeout', 'original outcome unknown', true);
        const harness = makeHarness({applyError: unknown});
        const bufferId = await confirmBase(harness, 'remote text');
        await assert.rejects(write(harness, 'local edit'), error => error === unknown);
        const originalPending = harness.vfs.pendingDocumentUpdates.get(bufferId);
        assert.ok(originalPending);
        const originalRecord = await harness.store.recoverCold(harness.identity, 'local edit');
        assert.equal(originalRecord.kind, 'valid');
        assert.ok(originalRecord.kind === 'valid');
        const originalPayload = originalRecord.record.pendingWrite;

        harness.vfs.publicId = 'public-2';
        harness.vfs.socket.generation = 2;
        harness.vfs.socket.projectSession = {
            publicId: 'public-2',
            permissionsLevel: 'owner',
            protocolVersion: 2,
            generation: 2,
        };
        const knownRetryFailure = new SocketRequestError(
            'server_error',
            'deduplicated retry rejected',
            false,
        );
        const retryUpdates: any[] = [];
        harness.vfs.socket.applyOtUpdate = async (_docId: string, update: any) => {
            retryUpdates.push(update);
            throw knownRetryFailure;
        };

        await assert.rejects(write(harness, 'local edit'), error => error === knownRetryFailure);

        assert.equal(retryUpdates.length, 1);
        assert.deepEqual(retryUpdates[0].dupIfSource, ['public-1']);
        const restoredPending = harness.vfs.pendingDocumentUpdates.get(bufferId);
        assert.deepEqual(restoredPending.submittedPublicIds, ['public-1']);
        assert.deepEqual(restoredPending.update, originalPending.update);
        const restoredRecord = await harness.store.recoverCold(harness.identity, 'local edit');
        assert.equal(restoredRecord.kind, 'valid');
        assert.ok(restoredRecord.kind === 'valid');
        assert.deepEqual(restoredRecord.record.pendingWrite, originalPayload);
    });

    it('does not authorize with provenance from another server, account, project, document, protocol, or window', async () => {
        const dimensions: Array<keyof DocumentProvenanceIdentity> = [
            'canonicalServerUrl', 'userId', 'projectId', 'docId', 'canonicalEditorUri',
            'protocolVersion',
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
        await confirmBase(unknownProtocol, 'remote text');
        unknownProtocol.vfs.protocolVersion = undefined;
        await assert.rejects(write(unknownProtocol, 'local edit'));
        assert.equal(unknownProtocol.submissions.length, 0);

        const invisible = makeHarness();
        await confirmBase(invisible, 'remote text');
        invisible.vfs.socket.isUsingAlternativeConnectionScheme = true;
        await assert.rejects(write(invisible, 'local edit'));
        assert.equal(invisible.submissions.length, 0);
    });
});
