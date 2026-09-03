/* eslint-disable @typescript-eslint/naming-convention */
import {strict as assert} from 'assert';
import {SocketRequestError} from '../api/socketRequest';
import {RealtimeFatalError} from '../api/socketio';
import {
    DocumentProvenanceIdentity,
    DocumentProvenanceStore,
    ProvenanceStorage,
} from '../core/documentProvenance';
import {HistoryOtSession} from '../core/historyOtSession';
import {
    applyHistoryOtOperations,
    getVisibleHistoryOtText,
    parseHistoryOtOperations,
    parseHistoryOtSnapshot,
    serializeHistoryOtSnapshot,
} from '../core/historyOt';

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

class RangeStub {
    constructor(readonly start: number, readonly end: number) {}
}

class WorkspaceEditStub {
    readonly replacements: Array<{
        uri: TestUri,
        range: RangeStub,
        text: string,
    }> = [];
    replace(uri: TestUri, range: RangeStub, text: string): void {
        this.replacements.push({uri, range, text});
    }
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
    Range: RangeStub,
    WorkspaceEdit: WorkspaceEditStub,
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
        applyEdit: async (..._args: any[]) => false,
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
    private lastChanges: Array<{rangeOffset: number, rangeLength: number, text: string}> = [];

    constructor(readonly uri: TestUri, private text: string) {}

    getText(): string {
        return this.text;
    }

    setDirtyText(text: string): void {
        if (this.text !== text) {
            const before = this.text;
            let prefix = 0;
            while (prefix < before.length
                && prefix < text.length
                && before[prefix] === text[prefix]) {
                prefix += 1;
            }
            let suffix = 0;
            while (suffix < before.length - prefix
                && suffix < text.length - prefix
                && before[before.length - suffix - 1] === text[text.length - suffix - 1]) {
                suffix += 1;
            }
            this.lastChanges = [{
                rangeOffset: prefix,
                rangeLength: before.length - prefix - suffix,
                text: text.slice(prefix, text.length - suffix),
            }];
            this.text = text;
            this.version += 1;
        }
        this.isDirty = true;
    }

    setProviderText(text: string): void {
        this.setDirtyText(text);
        this.isDirty = false;
    }

    setProviderTextWithChanges(
        text: string,
        changes: Array<{rangeOffset: number, rangeLength: number, text: string}>,
        versionAdvance = 1,
    ): void {
        this.text = text;
        this.version += versionAdvance;
        this.lastChanges = changes.map(change => ({...change}));
        this.isDirty = false;
    }

    markClean(): void {
        this.isDirty = false;
        this.lastChanges = [];
    }

    takeContentChanges(): Array<{rangeOffset: number, rangeLength: number, text: string}> {
        const changes = this.lastChanges;
        this.lastChanges = [];
        return changes;
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
        otType: 'sharejs-text-ot',
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
    const project = {
        _id: projectId,
        owner: {_id: userId},
        members: [],
        rootFolder: [rootFolder],
    };
    const submissions: Array<{docId: string, update: any}> = [];
    const vfs = Object.create(remoteModule.VirtualFileSystem.prototype) as any;
    Object.assign(vfs, {
        context: {
            globalState: {
                get: () => ({
                    server: {login: {userId, identity: {cookies: {}}}},
                }),
            },
        },
        serverName: 'server',
        serverUrl: 'https://example.test',
        origin: uri.with({path: '/Project'}),
        userId,
        projectId,
        protocolVersion,
        publicId: 'public-1',
        sourceRevision: 0,
        isDirty: false,
        editorId: 'editor-session',
        synctexOutputIdentityGeneration: 0,
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
        remoteDocumentCausality: new Map(),
        documentIdsByPath: new Map([[uri.toString(), docId]]),
        editorBufferIds: new WeakMap(),
        editorBuffers: new Map(),
        editorSaveIntents: new Map(),
        unboundEditorSaveIntents: new WeakMap(),
        unboundEditorIncarnations: new WeakSet(),
        editorSaveReceipts: new Map(),
        recoveryNotifications: new Set(),
        freshConnectionRequested: false,
        wasDocumentOpenBeforeProviderRead: () => true,
        provenanceStore: store,
        notify: () => {},
        socket: {
            generation: 1,
            isConnected: true,
            isUsingAlternativeConnectionScheme: false,
            fatalError: undefined,
            init: () => {},
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
            vfs.startRemoteCausality(docId, remoteVersion, remoteText, 1);
            return {doc, content: remoteText};
        },
        showDocumentRecovery: () => {},
        startInitialization: async () => undefined,
    });
    vfs.startRemoteCausality(docId, remoteVersion, remoteText, 1);
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

function makeHistoryWriteHarness(
    options: {
        remoteText?: string,
        remoteVersion?: number,
        remoteSnapshot?: unknown,
        permission?: 'owner' | 'readAndWrite' | 'review',
    } = {},
) {
    const initialSnapshot = options.remoteSnapshot ?? {content: options.remoteText ?? 'abc'};
    const initialVisibleText = getVisibleHistoryOtText(parseHistoryOtSnapshot(initialSnapshot));
    const harness = makeHarness({
        remoteText: initialVisibleText,
        remoteVersion: options.remoteVersion ?? 5,
    });
    let remoteVersion = options.remoteVersion ?? 5;
    let remoteSnapshot = parseHistoryOtSnapshot(initialSnapshot);
    const permission = options.permission ?? 'owner';
    const session = new HistoryOtSession('doc-1', 1, {
        level: permission,
        userId: 'user-1',
    });
    session.acceptJoin(1, {
        snapshot: serializeHistoryOtSnapshot(remoteSnapshot),
        version: remoteVersion,
        operations: [],
        ranges: {},
        otType: 'history-ot',
    });
    harness.doc.otType = 'history-ot';
    harness.doc.historyOtSession = session;
    harness.doc.historyOtSnapshot = serializeHistoryOtSnapshot(remoteSnapshot);
    harness.doc.historyOtEpoch = 'history-epoch-1';
    harness.vfs.waitForDocumentVersion = (docId: string, expectedVersion: number) =>
        (remoteModule.VirtualFileSystem.prototype as any).waitForDocumentVersion.call(
            harness.vfs,
            docId,
            expectedVersion,
            10,
        );
    harness.vfs.permissionsLevel = permission;
    harness.vfs.socket.projectSession.permissionsLevel = permission;
    const submissions: Array<{
        envelope: any,
        intent: any,
        submissionToken: string,
    }> = [];
    let nextSubmissionMode:
        'success' | 'deterministic-reject' | 'deterministic-wire-reject' | 'permission-downgrade'
        | 'unknown-unapplied' | 'unknown-applied' = 'success';
    const appliedSources = new Set<string>();
    let beforeNextAck: (() => Promise<void> | void) | undefined;
    let afterNextAck: (() => Promise<void> | void) | undefined;
    let joinCount = 0;
    const recoveryReasons: string[] = [];
    harness.vfs.showDocumentRecovery = (
        _uri: TestUri,
        _content: Uint8Array,
        reason: string,
    ) => { recoveryReasons.push(reason); };
    harness.vfs.socket.applyHistoryOtUpdate = async (
        docId: string,
        envelope: any,
        intent: any,
        submissionToken: string,
        submittedSession: HistoryOtSession,
        sender: {publicId: string, generation: number},
    ) => {
        assert.equal(docId, 'doc-1');
        assert.strictEqual(submittedSession, session);
        const mode = nextSubmissionMode;
        nextSubmissionMode = 'success';
        if (mode === 'permission-downgrade') {
            submittedSession.updatePermission(sender.generation, {
                level: 'readOnly',
                userId: 'user-1',
            });
            harness.vfs.permissionsLevel = 'readOnly';
            harness.vfs.socket.projectSession.permissionsLevel = 'readOnly';
            throw new SocketRequestError('server_error', 'History permission changed', false);
        }
        if (mode === 'deterministic-reject') {
            throw new SocketRequestError('server_error', 'History write rejected', false);
        }
        submittedSession.assertPendingSubmission(
            sender.generation,
            submissionToken,
            envelope,
            intent,
        );
        submittedSession.markWireAttempted(sender.generation, submissionToken);
        submissions.push({
            envelope: JSON.parse(JSON.stringify(envelope)),
            intent: JSON.parse(JSON.stringify(intent)),
            submissionToken,
        });
        if (mode === 'deterministic-wire-reject') {
            throw new SocketRequestError('server_error', 'History write rejected by ACK', false);
        }
        const source = envelope.meta.source as string;
        const duplicate = Array.isArray(envelope.dupIfSource)
            && envelope.dupIfSource.some((item: string) => appliedSources.has(item));
        const acknowledgedBase = envelope.v as number;
        if (mode !== 'unknown-unapplied' && !duplicate) {
            remoteSnapshot = applyHistoryOtOperations(
                remoteSnapshot,
                parseHistoryOtOperations(envelope.op),
            );
            remoteVersion += 1;
            appliedSources.add(source);
            harness.setRemoteVersion(remoteVersion);
            harness.setRemoteText(getVisibleHistoryOtText(remoteSnapshot));
        }
        if (mode !== 'success') {
            throw new SocketRequestError('timeout', 'History outcome unknown', true);
        }
        const beforeAck = beforeNextAck;
        beforeNextAck = undefined;
        await beforeAck?.();
        await harness.vfs.applyHistoryOtDocumentUpdate(
            {doc: 'doc-1', v: acknowledgedBase},
            sender,
        );
        const afterAck = afterNextAck;
        afterNextAck = undefined;
        await afterAck?.();
    };
    harness.vfs.joinFreshDocumentSession = async () => {
        joinCount += 1;
        const generation = harness.vfs.socket.generation;
        const joined = session.acceptJoin(generation, {
            snapshot: serializeHistoryOtSnapshot(remoteSnapshot),
            version: remoteVersion,
            operations: [],
            ranges: {},
            otType: 'history-ot',
        });
        assert.equal(joined.requiresRejoin, false);
        harness.doc.otType = 'history-ot';
        harness.doc.historyOtSession = session;
        harness.doc.historyOtSnapshot = serializeHistoryOtSnapshot(remoteSnapshot);
        harness.doc.historyOtEpoch = `history-epoch-${remoteVersion}`;
        harness.doc.version = remoteVersion;
        harness.doc.remoteCache = getVisibleHistoryOtText(remoteSnapshot);
        return {doc: harness.doc, content: harness.doc.remoteCache};
    };
    return {
        ...harness,
        historySession: session,
        historySubmissions: submissions,
        getRemoteSnapshot: () => serializeHistoryOtSnapshot(remoteSnapshot),
        setNextSubmissionMode: (
            mode: 'success' | 'deterministic-reject' | 'deterministic-wire-reject'
            | 'permission-downgrade'
            | 'unknown-unapplied' | 'unknown-applied',
        ) => { nextSubmissionMode = mode; },
        setBeforeNextAck: (hook: () => Promise<void> | void) => {
            beforeNextAck = hook;
        },
        setAfterNextAck: (hook: () => Promise<void> | void) => {
            afterNextAck = hook;
        },
        getJoinCount: () => joinCount,
        recoveryReasons,
        reconnectForRecovery: (
            generation = 2,
            publicId = 'public-2',
        ) => {
            session.reconnect(generation);
            session.updatePermission(generation, {level: permission, userId: 'user-1'});
            const joined = session.acceptJoin(generation, {
                snapshot: serializeHistoryOtSnapshot(remoteSnapshot),
                version: remoteVersion,
                operations: [],
                ranges: {},
                otType: 'history-ot',
            });
            assert.equal(joined.state.phase, 'recovery-ready');
            harness.vfs.socket.generation = generation;
            harness.vfs.socket.projectSession = {
                publicId,
                permissionsLevel: permission,
                protocolVersion: 2,
                generation,
            };
            harness.vfs.publicId = publicId;
            harness.doc.otType = 'history-ot';
            harness.doc.historyOtSession = session;
            harness.doc.historyOtSnapshot = serializeHistoryOtSnapshot(remoteSnapshot);
            harness.doc.historyOtEpoch = `history-recovery-epoch-${generation}`;
            harness.doc.version = remoteVersion;
            harness.doc.remoteCache = getVisibleHistoryOtText(remoteSnapshot);
        },
        reconnectAfterConfirmedAck: (
            generation = 2,
            publicId = 'public-2',
        ) => {
            const previousProject = harness.vfs.previousRoot;
            assert.ok(previousProject);
            const replacementDoc: import('../core/remoteFileSystemProvider').DocumentEntity = {
                _id: harness.doc._id,
                name: harness.doc.name,
                _type: 'doc',
                otType: 'history-ot',
            };
            const replacementProject = {
                _id: 'project-1',
                owner: {_id: 'user-1'},
                members: [],
                rootFolder: [{
                    _id: 'root-folder',
                    name: 'Project',
                    docs: [replacementDoc],
                    fileRefs: [],
                    folders: [],
                }],
            };
            harness.vfs.restoreDocumentRuntime(previousProject, replacementProject);
            assert.strictEqual(replacementDoc.historyOtSession, session);
            harness.vfs.root = replacementProject;
            harness.vfs.previousRoot = replacementProject;
            harness.doc = replacementDoc;
            harness.vfs._resolveUri = async () => ({
                fileType: 'doc',
                fileEntity: replacementDoc,
            });
            harness.vfs.ensureDocumentSession = async () => {
                if (Number.isSafeInteger(replacementDoc.version)
                    && replacementDoc.remoteCache !== undefined) {
                    return {doc: replacementDoc, content: replacementDoc.remoteCache};
                }
                return harness.vfs.joinFreshDocumentSession(replacementDoc._id);
            };
            session.reconnect(generation);
            session.updatePermission(generation, {level: permission, userId: 'user-1'});
            const joined = session.acceptJoin(generation, {
                snapshot: serializeHistoryOtSnapshot(remoteSnapshot),
                version: remoteVersion,
                operations: [],
                ranges: {},
                otType: 'history-ot',
            });
            assert.equal(joined.state.phase, 'ready');
            harness.vfs.socket.isConnected = true;
            harness.vfs.socket.generation = generation;
            harness.vfs.socket.projectSession = {
                publicId,
                permissionsLevel: permission,
                protocolVersion: 2,
                generation,
            };
            harness.vfs.publicId = publicId;
            harness.vfs.permissionsLevel = permission;
            harness.vfs.protocolVersion = 2;
            harness.vfs.freshConnectionRequested = false;
            harness.doc.otType = 'history-ot';
            harness.doc.historyOtSession = session;
            harness.doc.historyOtSnapshot = serializeHistoryOtSnapshot(remoteSnapshot);
            harness.doc.historyOtEpoch = `history-confirmed-epoch-${generation}`;
            harness.doc.version = remoteVersion;
            harness.doc.remoteCache = getVisibleHistoryOtText(remoteSnapshot);
        },
        applyCollaborator: async (operation: unknown, source = 'remote-source') => {
            const baseVersion = remoteVersion;
            remoteSnapshot = applyHistoryOtOperations(
                remoteSnapshot,
                parseHistoryOtOperations(operation),
            );
            remoteVersion += 1;
            harness.setRemoteVersion(remoteVersion);
            harness.setRemoteText(getVisibleHistoryOtText(remoteSnapshot));
            await harness.vfs.applyHistoryOtDocumentUpdate({
                doc: 'doc-1',
                v: baseVersion,
                op: operation,
                meta: {source},
            }, {
                publicId: harness.vfs.socket.projectSession.publicId,
                generation: harness.vfs.socket.generation,
            });
        },
        emitCollaborator: async (operation: unknown, source = 'remote-source') => {
            const baseVersion = remoteVersion;
            remoteSnapshot = applyHistoryOtOperations(
                remoteSnapshot,
                parseHistoryOtOperations(operation),
            );
            remoteVersion += 1;
            harness.setRemoteVersion(remoteVersion);
            harness.setRemoteText(getVisibleHistoryOtText(remoteSnapshot));
            const update = {
                doc: 'doc-1',
                v: baseVersion,
                op: operation,
                meta: {source},
            };
            const sender = {
                publicId: harness.vfs.socket.projectSession.publicId,
                generation: harness.vfs.socket.generation,
            };
            const deferred = harness.vfs.recordConfirmedHistoryCollaboratorUpdate(
                update,
                sender,
            );
            if (!deferred) {
                await harness.vfs.queueHistoryOtDocumentUpdate(update, sender);
            }
            return deferred;
        },
        advanceRemoteWithoutEvent: (operation: unknown) => {
            remoteSnapshot = applyHistoryOtOperations(
                remoteSnapshot,
                parseHistoryOtOperations(operation),
            );
            remoteVersion += 1;
            harness.setRemoteVersion(remoteVersion);
            harness.setRemoteText(getVisibleHistoryOtText(remoteSnapshot));
        },
        replaceRemoteSnapshotWithoutVersion: (snapshot: unknown) => {
            remoteSnapshot = parseHistoryOtSnapshot(snapshot);
            harness.setRemoteText(getVisibleHistoryOtText(remoteSnapshot));
        },
    };
}

async function write(harness: Harness, text: string): Promise<void> {
    harness.document.setDirtyText(text);
    const contentChanges = harness.document.takeContentChanges();
    if (contentChanges.length > 0) {
        harness.vfs.observeChangedTextDocument({document: harness.document, contentChanges});
    } else {
        harness.vfs.observeTextDocument(harness.document);
    }
    harness.vfs.observeWillSaveTextDocument(harness.document);
    await harness.vfs.writeFileNow(harness.uri, new TextEncoder().encode(text), false, true);
    harness.document.markClean();
    harness.vfs.observeTextDocument(harness.document);
}

function observeDirtyChange(harness: Harness): void {
    const contentChanges = harness.document.takeContentChanges();
    assert.equal(contentChanges.length, 1, 'the fixture must expose one actual editor change');
    harness.vfs.observeChangedTextDocument({document: harness.document, contentChanges});
}

async function applyFirstWorkspaceReplacement(
    harness: Harness,
    edit: WorkspaceEditStub,
): Promise<boolean> {
    const replacement = edit.replacements[0];
    assert.ok(replacement);
    const before = harness.document.getText();
    harness.document.setDirtyText(
        before.slice(0, replacement.range.start)
        + replacement.text
        + before.slice(replacement.range.end),
    );
    harness.vfs.observeChangedTextDocument({
        document: harness.document,
        contentChanges: harness.document.takeContentChanges(),
    });
    return true;
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

describe('SyncTeX output identity generation', () => {
    it('advances before a later output-tree publication failure', () => {
        const harness = makeHarness();
        const before = harness.vfs.outputIdentityGeneration;
        harness.vfs.notify = () => { throw new Error('output publication failed'); };

        assert.throws(() => harness.vfs.updateOutputs([{
            path: 'output.pdf',
            url: '/build/editor-build/output/output.pdf',
            build: 'build',
            editorId: 'editor',
        }], true), /output publication failed/);

        assert.equal(harness.vfs.outputIdentityGeneration, before + 1);
        assert.equal(harness.vfs.outputBuildId, 'build');
        assert.equal(harness.vfs.outputEditorId, 'editor');
    });

    it('reports manual SyncTeX failures by default and suppresses automatic failures', async () => {
        const harness = makeHarness();
        const shownErrors: string[] = [];
        const originalShowErrorMessage = vscodeStub.window.showErrorMessage;
        vscodeStub.window.showErrorMessage = async (message: string) => {
            shownErrors.push(message);
            return undefined;
        };

        try {
            await harness.vfs.syncCode('main.tex', 1, 0);
            assert.deepEqual(shownErrors, [
                'SyncTeX is unavailable until the PDF has been compiled successfully.',
            ]);

            shownErrors.length = 0;
            await harness.vfs.syncCode('main.tex', 1, 0, false);
            assert.deepEqual(shownErrors, []);

            harness.vfs.outputBuildId = 'build';
            harness.vfs.outputEditorId = 'editor';
            harness.vfs.api = {
                proxySyncCode: async () => ({type: 'error', message: 'SyncTeX proxy failed'}),
            };

            await harness.vfs.syncCode('main.tex', 1, 0, false);
            assert.deepEqual(shownErrors, []);

            await harness.vfs.syncCode('main.tex', 1, 0);
            assert.deepEqual(shownErrors, ['SyncTeX proxy failed']);
        } finally {
            vscodeStub.window.showErrorMessage = originalShowErrorMessage;
        }
    });
});

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

function makeHistoryJoinHarness(
    responses: unknown[],
    duringJoin?: (vfs: any, call: number) => void,
) {
    const doc = {
        _id: 'history-doc',
        name: 'main.tex',
        _type: 'doc',
    } as import('../core/remoteFileSystemProvider').DocumentEntity;
    const root = {
        _id: 'project-1',
        name: 'Project',
        owner: {_id: 'user-1'},
        members: [],
        rootFolder: [{
            _id: 'root-folder',
            name: 'Project',
            docs: [doc],
            fileRefs: [],
            folders: [],
        }],
    };
    const uri = makeUri('/Project/main.tex');
    const notifications: unknown[] = [];
    let joinCalls = 0;
    let metadataLoads = 0;
    const socket = {
        generation: 1,
        isConnected: true,
        fatalError: undefined,
        projectSession: {
            publicId: 'public-1',
            permissionsLevel: 'owner' as const,
            protocolVersion: 2,
            generation: 1,
        },
        waitUntilConnected: async () => 1,
        joinDoc: async () => {
            joinCalls += 1;
            duringJoin?.(vfs, joinCalls);
            const response = responses[joinCalls - 1];
            if (!response) { throw new Error('Missing deterministic join response'); }
            return JSON.parse(JSON.stringify(response));
        },
    };
    const vfs = Object.create(remoteModule.VirtualFileSystem.prototype) as any;
    Object.assign(vfs, {
        root,
        previousRoot: root,
        joiningProject: undefined,
        serverUrl: 'https://example.test',
        serverName: 'server',
        userId: 'user-1',
        projectId: 'project-1',
        publicId: 'public-1',
        permissionsLevel: 'owner',
        protocolVersion: 2,
        socket,
        documentJoinTasks: new Map(),
        joiningDocuments: new Map(),
        documentVersionWaiters: new Map(),
        pendingDocumentUpdates: new Map(),
        pendingReadTickets: new Map(),
        boundReadCandidates: new Map(),
        activeEditorBases: new Map(),
        remoteDocumentCausality: new Map(),
        editorBuffers: new Map(),
        stagedEditorBases: new Map(),
        sourceRevision: 0,
        isDirty: false,
        historyOtThreadEvents: {events: []},
        appliedHistoryOtThreadEventCount: 0,
        changesUsersEpoch: 0,
        commentThreadsEpoch: 0,
        init: async () => root,
        _resolveById: (id: string) => id === doc._id
            ? {fileType: 'doc', fileEntity: doc, path: '/main.tex'}
            : undefined,
        pathToUri: () => uri,
        notify: (events: unknown[]) => { notifications.push(...events); },
        ensureCommentThreads: async () => {
            metadataLoads += 1;
            return undefined;
        },
        ensureChangesUsers: async () => {
            metadataLoads += 1;
            return undefined;
        },
    });
    return {
        vfs,
        doc,
        socket,
        notifications,
        get joinCalls() { return joinCalls; },
        get metadataLoads() { return metadataLoads; },
    };
}

function historyJoin(snapshot: unknown = {content: 'abc'}, version = 5) {
    return {
        otType: 'history-ot',
        snapshot,
        version,
        updates: [],
        ranges: {opaqueRangeState: {preserved: true}},
    };
}

function historyUpdate(version: number, operation: unknown, source = 'remote-source') {
    return {
        doc: 'history-doc',
        v: version,
        op: operation,
        meta: {source, user_id: 'remote-user', ts: 1770000000000},
    };
}

describe('History OT VFS join gate', () => {
    beforeEach(() => {
        openTextDocuments.length = 0;
    });

    it('installs the full authoritative snapshot and starts metadata loading after join', async () => {
        const harness = makeHistoryJoinHarness([historyJoin({
            content: 'abc',
            comments: [{id: 'c1', ranges: [{pos: 0, length: 1}], resolved: true}],
        })]);

        const joined = await harness.vfs.performDocumentJoin('history-doc');

        assert.equal(joined.content, 'abc');
        assert.equal(harness.doc.otType, 'history-ot');
        assert.equal(harness.doc.version, 5);
        assert.deepEqual(harness.doc.historyOtSnapshot, {
            content: 'abc',
            comments: [{id: 'c1', ranges: [{pos: 0, length: 1}], resolved: true}],
        });
        assert.deepEqual(
            harness.doc.historyOtSession?.getState().ranges,
            {opaqueRangeState: {preserved: true}},
        );
        assert.equal(harness.metadataLoads, 2);
    });

    it('replays a losslessly buffered collaborator update before publishing the join', async () => {
        const update = historyUpdate(5, [{textOperation: [1, 'X', 2]}]);
        const harness = makeHistoryJoinHarness([historyJoin()], (vfs) => {
            const joining = vfs.joiningDocuments.get('history-doc');
            joining.updates.push(vfs.snapshotReceivedDocumentUpdate(
                update,
                {publicId: 'public-1', generation: 1},
            ));
            (update.meta as {source: string}).source = 'mutated-after-buffer';
        });

        const joined = await harness.vfs.performDocumentJoin('history-doc');

        assert.equal(joined.content, 'aXbc');
        assert.equal(harness.doc.version, 6);
        assert.equal(harness.doc.historyOtPresentation?.visibleText, 'aXbc');
        assert.equal(harness.notifications.length, 2);
    });

    it('rejects a buffered event whose sender witness is not current', async () => {
        const harness = makeHistoryJoinHarness([historyJoin()], (vfs) => {
            vfs.joiningDocuments.get('history-doc').updates.push({
                update: historyUpdate(5, [{textOperation: [1, 'X', 2]}]),
                sender: {publicId: 'other-public-id', generation: 1},
            });
        });

        await assert.rejects(
            harness.vfs.performDocumentJoin('history-doc'),
            /unproven realtime generation/,
        );
        assert.equal(harness.doc.version, undefined);
        assert.equal(harness.doc.remoteCache, undefined);
    });

    it('retries exactly once after the official sender-only commit event', async () => {
        const harness = makeHistoryJoinHarness([historyJoin(), historyJoin()]);
        const session = new HistoryOtSession('history-doc', 1, {
            level: 'owner',
            userId: 'user-1',
        });
        const initial = historyJoin();
        session.acceptJoin(1, {
            snapshot: initial.snapshot,
            version: initial.version,
            operations: [],
            ranges: initial.ranges,
            otType: initial.otType,
        });
        const staged = session.stage(1, {
            operation: [{textOperation: [1, 'L', 2]}],
            intent: {kind: 'plain-write'},
            publicId: 'public-1',
        });
        assert.ok(staged.submissionToken);
        session.markWireAttempted(1, staged.submissionToken);
        harness.doc.otType = 'history-ot';
        harness.doc.historyOtSession = session;
        const originalJoin = harness.socket.joinDoc;
        harness.socket.joinDoc = async () => {
            const response = await originalJoin();
            if (harness.joinCalls === 1) {
                harness.vfs.joiningDocuments.get('history-doc').updates.push({
                    update: {doc: 'history-doc', v: 5},
                    sender: {publicId: 'public-1', generation: 1},
                });
            }
            return response;
        };

        const joined = await harness.vfs.performDocumentJoin('history-doc');

        assert.equal(joined.content, 'abc');
        assert.equal(harness.joinCalls, 2);
        assert.equal(harness.doc.historyOtSession?.getState().hasPendingOperation, false);
    });

    it('carries only one exact same-host pending History session across a project-tree replacement', () => {
        const harness = makeHistoryJoinHarness([historyJoin()]);
        const session = new HistoryOtSession('history-doc', 1, {
            level: 'owner',
            userId: 'user-1',
        });
        session.acceptJoin(1, {
            snapshot: {content: 'abc'},
            version: 5,
            operations: [],
            ranges: {},
            otType: 'history-ot',
        });
        const staged = session.stage(1, {
            operation: [{textOperation: [1, 'L', 2]}],
            intent: {kind: 'plain-write'},
            publicId: 'public-1',
        });
        assert.ok(staged.submissionToken);
        session.markWireAttempted(1, staged.submissionToken);
        harness.doc.otType = 'history-ot';
        harness.doc.historyOtSession = session;
        harness.vfs.pendingDocumentUpdates.set('buffer-one', {
            otType: 'history-ot',
            docId: 'history-doc',
            bufferId: 'buffer-one',
            provenanceRecordName: 'record-one',
            update: staged.envelope,
            desiredContent: 'aLbc',
            mergedContent: 'aLbc',
            baseVersion: 5,
            baseContent: 'abc',
            submittedPublicIds: ['public-1'],
            socketGeneration: 1,
            submissionToken: staged.submissionToken,
            historyIntent: {kind: 'plain-write'},
            historySession: session,
        });
        const replacement = JSON.parse(JSON.stringify(harness.vfs.root));
        const replacementDoc = replacement.rootFolder[0].docs[0];

        harness.vfs.restoreDocumentRuntime(harness.vfs.root, replacement);

        assert.strictEqual(replacementDoc.historyOtSession, session);
        assert.equal(replacementDoc.version, undefined);
        assert.equal(replacementDoc.remoteCache, undefined);

        const ambiguous = JSON.parse(JSON.stringify(harness.vfs.root));
        delete ambiguous.rootFolder[0].docs[0].historyOtSession;
        harness.vfs.pendingDocumentUpdates.set('buffer-two', {
            ...harness.vfs.pendingDocumentUpdates.get('buffer-one'),
            bufferId: 'buffer-two',
        });
        harness.vfs.restoreDocumentRuntime(harness.vfs.root, ambiguous);
        assert.equal(ambiguous.rootFolder[0].docs[0].historyOtSession, undefined);
    });

    it('submits one plain History operation and accepts only the exact fresh snapshot witness', async () => {
        const harness = makeHistoryWriteHarness({remoteText: 'abc', remoteVersion: 5});
        await confirmBase(harness, 'abc');

        await write(harness, 'aLbc');

        assert.equal(harness.historySubmissions.length, 1);
        assert.deepEqual(harness.historySubmissions[0].intent, {kind: 'plain-write'});
        assert.equal(harness.historySubmissions[0].envelope.v, 5);
        assert.equal(harness.getRemoteText(), 'aLbc');
        assert.equal(harness.doc.version, 6);
        assert.equal(harness.doc.remoteCache, 'aLbc');
        assert.equal(harness.historySession.getState().hasPendingOperation, false);
        const bufferId = harness.vfs.editorBufferIds.get(harness.document);
        const active = harness.vfs.activeEditorBases.get(bufferId);
        assert.equal(active.historyCausality.valid, true);
        assert.equal(active.historyCausality.authority, 'ready');
        assert.equal(active.historyCausality.remoteVersion, 6);
    });

    it('forces tracked History writes for review permission and keeps non-doc entities readonly', async () => {
        const harness = makeHistoryWriteHarness({permission: 'review'});
        await confirmBase(harness, 'abc');
        harness.vfs._resolveUri = async () => ({
            fileName: 'main.tex',
            fileType: 'doc',
            fileEntity: harness.doc,
        });
        assert.equal((await harness.vfs.resolve(harness.uri)).permissions, undefined);

        harness.document.setDirtyText('abLc');
        observeDirtyChange(harness);
        harness.vfs.observeWillSaveTextDocument(harness.document);
        await harness.vfs.writeFile(
            harness.uri,
            new TextEncoder().encode('abLc'),
            false,
            true,
        );

        assert.equal(harness.historySubmissions.length, 1);
        assert.deepEqual(harness.historySubmissions[0].intent, {kind: 'tracked-write'});
        assert.equal(typeof harness.historySubmissions[0].envelope.meta.tc, 'string');
        assert.match(JSON.stringify(harness.historySubmissions[0].envelope.op), /tracking/);

        harness.vfs._resolveUri = async () => ({
            fileName: 'figure.pdf',
            fileType: 'file',
            fileEntity: {
                _id: 'file-1',
                name: 'figure.pdf',
                _type: 'file',
                linkedFileData: null,
                created: new Date(0).toISOString(),
            },
        });
        assert.equal(
            (await harness.vfs.resolve(harness.uri)).permissions,
            vscodeStub.FilePermission.Readonly,
        );
    });

    it('uses the resource-scoped tracked-write opt-in for an owner', async () => {
        const harness = makeHistoryWriteHarness({permission: 'owner'});
        await confirmBase(harness, 'abc');
        const originalConfiguration = vscodeStub.workspace.getConfiguration;
        try {
            vscodeStub.workspace.getConfiguration = () => ({
                get: (key: string, fallback: unknown) =>
                    key === 'trackChanges.enabled' ? true : fallback,
            });
            await write(harness, 'abcL');
        } finally {
            vscodeStub.workspace.getConfiguration = originalConfiguration;
        }

        assert.deepEqual(harness.historySubmissions[0].intent, {kind: 'tracked-write'});
        assert.match(JSON.stringify(harness.historySubmissions[0].envelope.op), /tracking/);
    });

    it('blocks a History save when the authenticated account rotates after editor binding', async () => {
        const harness = makeHistoryWriteHarness();
        await confirmBase(harness, 'abc');
        harness.document.setDirtyText('abcL');
        observeDirtyChange(harness);
        harness.vfs.observeWillSaveTextDocument(harness.document);
        harness.vfs.context.globalState.get = () => ({
            server: {login: {userId: 'other-user', identity: {cookies: {}}}},
        });

        await assert.rejects(
            harness.vfs.writeFile(
                harness.uri,
                new TextEncoder().encode('abcL'),
                false,
                true,
            ),
            /authenticated Overleaf account changed/i,
        );
        assert.equal(harness.historySubmissions.length, 0);
        assert.equal(harness.document.isDirty, true);
        assert.equal(harness.getRemoteText(), 'abc');
    });

    it('rebases a collaborator operation through a dirty History editor with one targeted edit', async () => {
        const harness = makeHistoryWriteHarness();
        await confirmBase(harness, 'abc');
        harness.document.setDirtyText('abcL');
        observeDirtyChange(harness);
        const originalApplyEdit = vscodeStub.workspace.applyEdit;
        let targetedEdits = 0;
        try {
            vscodeStub.workspace.applyEdit = async (edit: WorkspaceEditStub) => {
                const replacement = edit.replacements[0];
                assert.ok(replacement);
                targetedEdits += 1;
                const before = harness.document.getText();
                harness.document.setDirtyText(
                    before.slice(0, replacement.range.start)
                    + replacement.text
                    + before.slice(replacement.range.end),
                );
                harness.vfs.observeChangedTextDocument({
                    document: harness.document,
                    contentChanges: harness.document.takeContentChanges(),
                });
                return true;
            };

            await harness.applyCollaborator([{textOperation: [1, 'R', 2]}]);
        } finally {
            vscodeStub.workspace.applyEdit = originalApplyEdit;
        }

        assert.equal(targetedEdits, 1);
        assert.equal(harness.document.getText(), 'aRbcL');
        assert.equal(harness.document.isDirty, true);
        assert.equal(harness.doc.remoteCache, 'aRbc');
        assert.equal(harness.doc.localCache, undefined);
        const active = harness.vfs.activeEditorBases.get(
            harness.vfs.editorBufferIds.get(harness.document),
        );
        assert.equal(active.historyCausality.valid, true);
        assert.equal(active.historyCausality.remoteVersion, 6);
        assert.equal(getVisibleHistoryOtText(active.historyCausality.remoteSnapshot), 'aRbc');
    });

    it('commits a metadata-only History revision without inventing an editor edit', async () => {
        const harness = makeHistoryWriteHarness({
            remoteSnapshot: {
                content: 'abc',
                comments: [{id: 'c', ranges: [{pos: 0, length: 1}], resolved: false}],
            },
        });
        await confirmBase(harness, 'abc');
        const originalApplyEdit = vscodeStub.workspace.applyEdit;
        let targetedEdits = 0;
        try {
            vscodeStub.workspace.applyEdit = async () => {
                targetedEdits += 1;
                return false;
            };
            await harness.applyCollaborator([{commentId: 'c', resolved: true}]);
        } finally {
            vscodeStub.workspace.applyEdit = originalApplyEdit;
        }

        assert.equal(targetedEdits, 0);
        assert.equal(harness.document.getText(), 'abc');
        assert.equal(harness.document.version, 1);
        const active = harness.vfs.activeEditorBases.get(
            harness.vfs.editorBufferIds.get(harness.document),
        );
        assert.equal(active.historyCausality.valid, true);
        assert.equal(active.historyCausality.remoteVersion, 6);
        assert.equal((harness.getRemoteSnapshot() as any).comments[0].resolved, true);
    });

    it('promotes a clean History provider refresh only after its exact editor callback', async () => {
        const harness = makeHistoryWriteHarness();
        await confirmBase(harness, 'abc');

        await harness.applyCollaborator([{textOperation: [1, 'R', 2]}]);

        const bufferId = harness.vfs.editorBufferIds.get(harness.document);
        assert.equal(harness.document.getText(), 'abc');
        assert.equal(harness.vfs.historyCleanEditorRefreshMap().has(bufferId), true);
        harness.vfs.stageProviderRead(harness.uri, harness.doc, 'aRbc');
        assert.equal(
            harness.vfs.pendingReadTickets.get(harness.uri.toString())
                ?.requiresExplicitConfirmation,
            false,
        );
        harness.document.setProviderText('aRbc');
        harness.vfs.observeChangedTextDocument({
            document: harness.document,
            contentChanges: harness.document.takeContentChanges(),
        });

        const active = harness.vfs.activeEditorBases.get(bufferId);
        assert.equal(active.historyCausality.valid, true);
        assert.equal(active.historyCausality.remoteVersion, 6);
        assert.equal(harness.document.getText(), 'aRbc');
        assert.equal(harness.document.isDirty, false);
        assert.equal(harness.doc.localCache, 'aRbc');
        assert.equal(harness.vfs.historyCleanEditorRefreshMap().has(bufferId), false);

        harness.document.setDirtyText('aRbcL');
        observeDirtyChange(harness);
        harness.vfs.observeWillSaveTextDocument(harness.document);
        await harness.vfs.writeFileNow(
            harness.uri,
            new TextEncoder().encode('aRbcL'),
            false,
            true,
        );
        assert.equal(harness.getRemoteText(), 'aRbcL');
    });

    for (const cleanReload of [
        {
            label: 'line replacement',
            changes: [{rangeOffset: 0, rangeLength: 3, text: 'aRbc'}],
            versionAdvance: 1,
        },
        {
            label: 'full setValue',
            changes: [{rangeOffset: 0, rangeLength: 7, text: 'aRbc\ndef'}],
            versionAdvance: 1,
        },
        {
            label: 'empty change list',
            changes: [],
            versionAdvance: 1,
        },
        {
            label: 'document version jump',
            changes: [{rangeOffset: 1, rangeLength: 0, text: 'R'}],
            versionAdvance: 4,
        },
    ]) {
        it(`accepts a clean History provider reload reported as ${cleanReload.label}`, async () => {
            const harness = makeHistoryWriteHarness({remoteText: 'abc\ndef'});
            await confirmBase(harness, 'abc\ndef');
            await harness.applyCollaborator([{textOperation: [1, 'R', 6]}]);
            const bufferId = harness.vfs.editorBufferIds.get(harness.document);

            harness.document.setProviderTextWithChanges(
                'aRbc\ndef',
                cleanReload.changes,
                cleanReload.versionAdvance,
            );
            harness.vfs.observeChangedTextDocument({
                document: harness.document,
                contentChanges: harness.document.takeContentChanges(),
            });

            const active = harness.vfs.activeEditorBases.get(bufferId);
            assert.equal(active.historyCausality.valid, true);
            assert.equal(active.historyCausality.remoteVersion, 6);
            assert.equal(active.historyCausality.documentVersion, harness.document.version);
            assert.equal(harness.vfs.historyCleanEditorRefreshMap().has(bufferId), false);
        });
    }

    it('rejects a clean History provider callback with the wrong final text', async () => {
        const harness = makeHistoryWriteHarness();
        await confirmBase(harness, 'abc');
        await harness.applyCollaborator([{textOperation: [1, 'R', 2]}]);
        const bufferId = harness.vfs.editorBufferIds.get(harness.document);

        harness.document.setProviderTextWithChanges(
            'wrong',
            [{rangeOffset: 0, rangeLength: 3, text: 'wrong'}],
        );
        harness.vfs.observeChangedTextDocument({
            document: harness.document,
            contentChanges: harness.document.takeContentChanges(),
        });

        assert.equal(
            harness.vfs.activeEditorBases.get(bufferId).historyCausality.valid,
            false,
        );
        assert.equal(harness.vfs.historyCleanEditorRefreshMap().has(bufferId), false);
    });

    it('rejects a History provider refresh if the editor became dirty', async () => {
        const harness = makeHistoryWriteHarness();
        await confirmBase(harness, 'abc');
        await harness.applyCollaborator([{textOperation: [1, 'R', 2]}]);
        const bufferId = harness.vfs.editorBufferIds.get(harness.document);

        harness.document.setDirtyText('aRbc');
        harness.vfs.observeChangedTextDocument({
            document: harness.document,
            contentChanges: harness.document.takeContentChanges(),
        });

        assert.equal(
            harness.vfs.activeEditorBases.get(bufferId).historyCausality.valid,
            false,
        );
    });

    it('rejects a History clean refresh after active-buffer or sender-generation rebinding', async () => {
        for (const mutation of ['active', 'generation'] as const) {
            const harness = makeHistoryWriteHarness();
            await confirmBase(harness, 'abc');
            await harness.applyCollaborator([{textOperation: [1, 'R', 2]}]);
            const bufferId = harness.vfs.editorBufferIds.get(harness.document);
            if (mutation === 'active') {
                const active = harness.vfs.activeEditorBases.get(bufferId);
                harness.vfs.activeEditorBases.set(bufferId, {...active});
            } else {
                harness.vfs.socket.generation += 1;
            }
            harness.document.setProviderText('aRbc');
            harness.vfs.observeChangedTextDocument({
                document: harness.document,
                contentChanges: harness.document.takeContentChanges(),
            });
            assert.equal(
                harness.vfs.activeEditorBases.get(bufferId).historyCausality.valid,
                false,
                mutation,
            );
        }
    });

    it('keeps dirty History WorkspaceEdit feedback shape-strict', async () => {
        const harness = makeHistoryWriteHarness();
        await confirmBase(harness, 'abc');
        harness.document.setDirtyText('abcL');
        observeDirtyChange(harness);
        const originalApplyEdit = vscodeStub.workspace.applyEdit;
        try {
            vscodeStub.workspace.applyEdit = async (edit: WorkspaceEditStub) => {
                const replacement = edit.replacements[0];
                assert.ok(replacement);
                const before = harness.document.getText();
                const after = before.slice(0, replacement.range.start)
                    + replacement.text
                    + before.slice(replacement.range.end);
                harness.document.setProviderTextWithChanges(after, [{
                    rangeOffset: 0,
                    rangeLength: before.length,
                    text: after,
                }]);
                harness.document.isDirty = true;
                harness.vfs.observeChangedTextDocument({
                    document: harness.document,
                    contentChanges: harness.document.takeContentChanges(),
                });
                return true;
            };
            await harness.applyCollaborator([{textOperation: [1, 'R', 2]}]);
        } finally {
            vscodeStub.workspace.applyEdit = originalApplyEdit;
        }

        const bufferId = harness.vfs.editorBufferIds.get(harness.document);
        assert.equal(
            harness.vfs.activeEditorBases.get(bufferId).historyCausality.valid,
            false,
        );
    });

    it('reconciles a confirmed History write through a contiguous advanced fresh join', async () => {
        const harness = makeHistoryWriteHarness();
        const bufferId = await confirmBase(harness, 'abc');
        harness.document.setDirtyText('abcL');
        observeDirtyChange(harness);
        harness.vfs.observeWillSaveTextDocument(harness.document);
        harness.setAfterNextAck(() => harness.applyCollaborator([
            {textOperation: ['R', 4]},
        ]));
        const originalApplyEdit = vscodeStub.workspace.applyEdit;
        try {
            vscodeStub.workspace.applyEdit = async (edit: WorkspaceEditStub) =>
                applyFirstWorkspaceReplacement(harness, edit);
            await harness.vfs.writeFileNow(
                harness.uri,
                new TextEncoder().encode('abcL'),
                false,
                true,
            );
        } finally {
            vscodeStub.workspace.applyEdit = originalApplyEdit;
        }

        const active = harness.vfs.activeEditorBases.get(bufferId);
        assert.equal(harness.historySubmissions.length, 1);
        assert.equal(harness.getJoinCount(), 1);
        assert.equal(harness.getRemoteText(), 'RabcL');
        assert.equal(harness.document.getText(), 'RabcL');
        assert.equal(harness.vfs.pendingDocumentUpdates.has(bufferId), false);
        assert.equal(active.historyCausality.valid, true);
        assert.equal(active.historyCausality.authority, 'ready');
        assert.equal(active.historyCausality.remoteVersion, 7);
        assert.deepEqual(harness.recoveryReasons, []);
        const record = await harness.store.resolveCurrentRecord(active.recordName, {
            identity: active.identity,
            bufferIncarnationId: bufferId,
            baseVersion: 7,
            baseText: 'RabcL',
            dirtyText: 'RabcL',
        });
        assert.equal(record.kind, 'valid');
        if (record.kind === 'valid') {
            assert.equal(record.record.pendingWrite, undefined);
        }

        harness.vfs.observeWillSaveTextDocument(harness.document);
        await harness.vfs.writeFileNow(
            harness.uri,
            new TextEncoder().encode('RabcL'),
            false,
            true,
        );
        assert.equal(harness.historySubmissions.length, 1);
    });

    it('hands a post-join History update across the durable reconciliation barrier exactly once', async () => {
        const harness = makeHistoryWriteHarness();
        const bufferId = await confirmBase(harness, 'abc');
        harness.document.setDirtyText('abcL');
        observeDirtyChange(harness);
        harness.vfs.observeWillSaveTextDocument(harness.document);

        const store = harness.store as any;
        const originalReplacePendingWrite = store.replacePendingWrite.bind(store);
        let releaseMarker!: () => void;
        let markerEntered!: () => void;
        const markerGate = new Promise<void>(resolve => { releaseMarker = resolve; });
        const entered = new Promise<void>(resolve => { markerEntered = resolve; });
        store.replacePendingWrite = async (...args: any[]) => {
            const record = await originalReplacePendingWrite(...args);
            markerEntered();
            await markerGate;
            return record;
        };

        const originalApplyEdit = vscodeStub.workspace.applyEdit;
        try {
            vscodeStub.workspace.applyEdit = async (edit: WorkspaceEditStub) =>
                applyFirstWorkspaceReplacement(harness, edit);
            const writePromise = harness.vfs.writeFileNow(
                harness.uri,
                new TextEncoder().encode('abcL'),
                false,
                true,
            );
            await entered;
            const activeAtMarker = harness.vfs.activeEditorBases.get(bufferId);
            const markerRecord = await harness.store.resolveCurrentRecord(activeAtMarker.recordName, {
                identity: activeAtMarker.identity,
                bufferIncarnationId: bufferId,
                baseVersion: 5,
                baseText: 'abc',
                dirtyText: 'abcL',
            });
            assert.equal(markerRecord.kind, 'valid');
            if (markerRecord.kind === 'valid') {
                assert.equal((markerRecord.record.pendingWrite as any)?.state, 'confirmed-reconciling');
                assert.equal(
                    (markerRecord.record.pendingWrite as any)?.historyConfirmationVersion,
                    5,
                );
            }

            await harness.applyCollaborator([{textOperation: ['R', 4]}]);
            releaseMarker();
            await writePromise;
        } finally {
            releaseMarker();
            vscodeStub.workspace.applyEdit = originalApplyEdit;
            store.replacePendingWrite = originalReplacePendingWrite;
        }

        const active = harness.vfs.activeEditorBases.get(bufferId);
        assert.equal(harness.historySubmissions.length, 1);
        assert.equal(harness.getJoinCount(), 1);
        assert.equal(harness.getRemoteText(), 'RabcL');
        assert.equal(harness.document.getText(), 'RabcL');
        assert.equal(harness.doc.version, 7);
        assert.equal(active.historyCausality.remoteVersion, 7);
        assert.equal(active.historyCausality.authority, 'ready');
        assert.equal(harness.vfs.pendingDocumentUpdates.has(bufferId), false);
        const record = await harness.store.resolveCurrentRecord(active.recordName, {
            identity: active.identity,
            bufferIncarnationId: bufferId,
            baseVersion: 7,
            baseText: 'RabcL',
            dirtyText: 'RabcL',
        });
        assert.equal(record.kind, 'valid');
        if (record.kind === 'valid') {
            assert.equal(record.record.pendingWrite, undefined);
        }
    });

    it('persists local dirty text against the new marker when marker replacement is in flight', async () => {
        const harness = makeHistoryWriteHarness();
        const bufferId = await confirmBase(harness, 'abc');
        harness.document.setDirtyText('abcL');
        observeDirtyChange(harness);
        harness.vfs.observeWillSaveTextDocument(harness.document);

        const store = harness.store as any;
        const originalReplacePendingWrite = store.replacePendingWrite.bind(store);
        const originalReconcilePendingWrite = store.reconcilePendingWrite.bind(store);
        let releaseReplace!: () => void;
        let replaceEntered!: () => void;
        let releaseReconcile!: () => void;
        let reconcileEntered!: () => void;
        const replaceGate = new Promise<void>(resolve => { releaseReplace = resolve; });
        const replaceStarted = new Promise<void>(resolve => { replaceEntered = resolve; });
        const reconcileGate = new Promise<void>(resolve => { releaseReconcile = resolve; });
        const reconcileStarted = new Promise<void>(resolve => { reconcileEntered = resolve; });
        store.replacePendingWrite = async (...args: any[]) => {
            replaceEntered();
            await replaceGate;
            return originalReplacePendingWrite(...args);
        };
        store.reconcilePendingWrite = async (...args: any[]) => {
            reconcileEntered();
            await reconcileGate;
            return originalReconcilePendingWrite(...args);
        };

        let writePromise!: Promise<void>;
        try {
            writePromise = harness.vfs.writeFileNow(
                harness.uri,
                new TextEncoder().encode('abcL'),
                false,
                true,
            );
            void writePromise.catch(() => {});
            await replaceStarted;
            harness.document.setDirtyText('abcL!');
            observeDirtyChange(harness);
            releaseReplace();
            await reconcileStarted;

            const activeAtMarker = harness.vfs.activeEditorBases.get(bufferId);
            const markerRecord = await harness.store.resolveCurrentRecord(activeAtMarker.recordName, {
                identity: activeAtMarker.identity,
                bufferIncarnationId: bufferId,
                baseVersion: 5,
                baseText: 'abc',
                dirtyText: 'abcL!',
            });
            assert.equal(markerRecord.kind, 'valid');
            if (markerRecord.kind === 'valid') {
                assert.equal((markerRecord.record.pendingWrite as any)?.state, 'confirmed-reconciling');
                assert.equal(
                    (markerRecord.record.pendingWrite as any)?.historyConfirmationVersion,
                    5,
                );
            }
            harness.document.setDirtyText('abcL!?');
            observeDirtyChange(harness);
            releaseReconcile();
            await writePromise;
        } finally {
            releaseReplace();
            releaseReconcile();
            store.replacePendingWrite = originalReplacePendingWrite;
            store.reconcilePendingWrite = originalReconcilePendingWrite;
        }

        const active = harness.vfs.activeEditorBases.get(bufferId);
        assert.equal(harness.historySubmissions.length, 1);
        assert.equal(harness.getJoinCount(), 1);
        assert.equal(harness.getRemoteText(), 'abcL');
        assert.equal(harness.document.getText(), 'abcL!?');
        assert.equal(active.historyCausality.remoteVersion, 6);
        assert.ok(active.historyCausality.pending);
        assert.equal(harness.vfs.pendingDocumentUpdates.has(bufferId), false);
        const record = await harness.store.resolveCurrentRecord(active.recordName, {
            identity: active.identity,
            bufferIncarnationId: bufferId,
            baseVersion: 6,
            baseText: 'abcL',
            dirtyText: 'abcL!?',
        });
        assert.equal(record.kind, 'valid');
        if (record.kind === 'valid') {
            assert.equal(record.record.pendingWrite, undefined);
        }
    });

    it('retains a confirmed-reconciling owner when authority disappears before finalization', async () => {
        const harness = makeHistoryWriteHarness();
        const bufferId = await confirmBase(harness, 'abc');
        harness.document.setDirtyText('abcL');
        observeDirtyChange(harness);
        harness.vfs.observeWillSaveTextDocument(harness.document);

        const originalEnqueue = harness.vfs.enqueueConfirmedHistoryDeferredBatch.bind(harness.vfs);
        let releasePhase!: () => void;
        let phaseEntered!: () => void;
        const phaseGate = new Promise<void>(resolve => { releasePhase = resolve; });
        const phaseStarted = new Promise<void>(resolve => { phaseEntered = resolve; });
        harness.vfs.enqueueConfirmedHistoryDeferredBatch = (...args: any[]) => {
            const handoff = originalEnqueue(...args);
            const pending = args[0];
            if ((pending.durablePendingWrite as any)?.state !== 'confirmed-reconciling') {
                return handoff;
            }
            return {
                ...handoff,
                beforeBarrier: handoff.beforeBarrier.then(async () => {
                    phaseEntered();
                    await phaseGate;
                }),
            };
        };

        let firstWrite!: Promise<void>;
        let originalEnvelope: unknown;
        let originalToken: string;
        try {
            firstWrite = harness.vfs.writeFileNow(
                harness.uri,
                new TextEncoder().encode('abcL'),
                false,
                true,
            );
            void firstWrite.catch(() => {});
            await phaseStarted;
            const pending = harness.vfs.pendingDocumentUpdates.get(bufferId);
            assert.ok(pending);
            originalEnvelope = JSON.parse(JSON.stringify(pending.update));
            originalToken = pending.submissionToken;
            assert.equal(pending.confirmationVersion, 5);
            assert.equal((pending.durablePendingWrite as any)?.state, 'confirmed-reconciling');
            assert.equal(
                (pending.durablePendingWrite as any)?.historyReconciliationVersion,
                6,
            );

            harness.vfs.forceFreshConnection();
            releasePhase();
            await assert.rejects(firstWrite, /lost its document authority/i);
        } finally {
            releasePhase();
            harness.vfs.enqueueConfirmedHistoryDeferredBatch = originalEnqueue;
        }

        const retained = harness.vfs.pendingDocumentUpdates.get(bufferId);
        assert.ok(retained);
        assert.deepEqual(retained.update, originalEnvelope);
        assert.equal(retained.submissionToken, originalToken);
        assert.equal((retained.durablePendingWrite as any)?.state, 'confirmed-reconciling');
        assert.equal(harness.historySubmissions.length, 1);
        let record = await harness.store.resolveCurrentRecord(
            retained.provenanceRecordName,
            {
                identity: retained.identity,
                bufferIncarnationId: bufferId,
                baseVersion: 5,
                baseText: 'abc',
                dirtyText: 'abcL',
            },
        );
        assert.equal(record.kind, 'valid');
        assert.equal((record.kind === 'valid' ? record.record.pendingWrite : undefined as any)?.state,
            'confirmed-reconciling');

        harness.reconnectAfterConfirmedAck();
        harness.vfs.observeWillSaveTextDocument(harness.document);
        await assert.rejects(
            harness.vfs.writeFileNow(
                harness.uri,
                new TextEncoder().encode('abcL'),
                false,
                true,
            ),
            /lost its original editor incarnation|incomplete collaborator ancestry/i,
        );

        assert.equal(harness.historySubmissions.length, 1);
        assert.equal(harness.vfs.pendingDocumentUpdates.has(bufferId), false);
        const active = harness.vfs.activeEditorBases.get(bufferId);
        record = await harness.store.resolveCurrentRecord(active.recordName, {
            identity: active.identity,
            bufferIncarnationId: bufferId,
            baseVersion: 6,
            baseText: 'abcL',
            dirtyText: 'abcL',
        });
        assert.equal(record.kind, 'valid');
        if (record.kind === 'valid') {
            assert.equal(record.record.pendingWrite, undefined);
        }

        harness.vfs.observeWillSaveTextDocument(harness.document);
        await harness.vfs.writeFileNow(
            harness.uri,
            new TextEncoder().encode('abcL'),
            false,
            true,
        );
        assert.equal(harness.historySubmissions.length, 1);
    });

    it('keeps a confirmed History owner during fatal realtime shutdown', async () => {
        const harness = makeHistoryWriteHarness();
        const bufferId = await confirmBase(harness, 'abc');
        harness.document.setDirtyText('abcL');
        observeDirtyChange(harness);
        harness.vfs.observeWillSaveTextDocument(harness.document);

        const originalEnqueue = harness.vfs.enqueueConfirmedHistoryDeferredBatch.bind(harness.vfs);
        let releasePhase!: () => void;
        let phaseEntered!: () => void;
        const phaseGate = new Promise<void>(resolve => { releasePhase = resolve; });
        const phaseStarted = new Promise<void>(resolve => { phaseEntered = resolve; });
        harness.vfs.enqueueConfirmedHistoryDeferredBatch = (...args: any[]) => {
            const handoff = originalEnqueue(...args);
            const pending = args[0];
            if ((pending.durablePendingWrite as any)?.state !== 'confirmed-reconciling') {
                return handoff;
            }
            return {
                ...handoff,
                beforeBarrier: handoff.beforeBarrier.then(async () => {
                    phaseEntered();
                    await phaseGate;
                }),
            };
        };

        try {
            const saving = harness.vfs.writeFileNow(
                harness.uri,
                new TextEncoder().encode('abcL'),
                false,
                true,
            );
            void saving.catch(() => {});
            await phaseStarted;
            const pending = harness.vfs.pendingDocumentUpdates.get(bufferId);
            assert.ok(pending);
            assert.equal((pending.durablePendingWrite as any)?.state, 'confirmed-reconciling');

            harness.vfs.handleFatalRealtime(
                new RealtimeFatalError('force_disconnect', 'maintenance'),
            );
            releasePhase();
            await assert.rejects(saving, /lost its document authority/i);

            assert.strictEqual(harness.vfs.pendingDocumentUpdates.get(bufferId), pending);
            assert.equal(harness.historySubmissions.length, 1);
            const record = await harness.store.resolveCurrentRecord(
                pending.provenanceRecordName,
                {
                    identity: pending.identity,
                    bufferIncarnationId: bufferId,
                    baseVersion: 5,
                    baseText: 'abc',
                    dirtyText: 'abcL',
                },
            );
            assert.equal(record.kind, 'valid');
            assert.equal(
                (record.kind === 'valid' ? record.record.pendingWrite : undefined as any)?.state,
                'confirmed-reconciling',
            );
        } finally {
            releasePhase();
            harness.vfs.enqueueConfirmedHistoryDeferredBatch = originalEnqueue;
        }
    });

    it('retries a confirmed-retiring owner idempotently across repeated authority loss', async () => {
        const harness = makeHistoryWriteHarness();
        const bufferId = await confirmBase(harness, 'abc');
        harness.document.setDirtyText('abcL');
        observeDirtyChange(harness);
        harness.vfs.observeWillSaveTextDocument(harness.document);
        harness.setAfterNextAck(() => {
            harness.advanceRemoteWithoutEvent([{textOperation: [4, 'X']}]);
        });

        const controls = Array.from({length: 2}, () => {
            let release!: () => void;
            let enter!: () => void;
            return {
                gate: new Promise<void>(resolve => { release = resolve; }),
                started: new Promise<void>(resolve => { enter = resolve; }),
                release: () => release(),
                enter: () => enter(),
            };
        });
        const originalEnqueue = harness.vfs.enqueueConfirmedHistoryDeferredBatch.bind(harness.vfs);
        const store = harness.store as any;
        const originalReplacePendingWrite = store.replacePendingWrite.bind(store);
        let injectedGenerationThreeUpdate = false;
        store.replacePendingWrite = async (...args: any[]) => {
            const record = await originalReplacePendingWrite(...args);
            const nextMarker = args[2];
            if (!injectedGenerationThreeUpdate
                && harness.vfs.socket.generation === 3
                && nextMarker?.state === 'confirmed-retiring') {
                injectedGenerationThreeUpdate = true;
                assert.equal(
                    await harness.emitCollaborator(
                        [{textOperation: [5, 'Y']}],
                        'remote-generation-3',
                    ),
                    true,
                );
            }
            return record;
        };
        let heldPhases = 0;
        harness.vfs.enqueueConfirmedHistoryDeferredBatch = (...args: any[]) => {
            const handoff = originalEnqueue(...args);
            const pending = args[0];
            if ((pending.durablePendingWrite as any)?.state !== 'confirmed-retiring'
                || heldPhases >= controls.length) {
                return handoff;
            }
            const control = controls[heldPhases++];
            return {
                ...handoff,
                beforeBarrier: handoff.beforeBarrier.then(async () => {
                    control.enter();
                    await control.gate;
                }),
            };
        };

        const attempt = async (controlIndex: number, text: string) => {
            harness.vfs.observeWillSaveTextDocument(harness.document);
            const saving = harness.vfs.writeFileNow(
                harness.uri,
                new TextEncoder().encode(text),
                false,
                true,
            );
            void saving.catch(() => {});
            await controls[controlIndex].started;
            const pending = harness.vfs.pendingDocumentUpdates.get(bufferId);
            assert.ok(pending);
            assert.equal((pending.durablePendingWrite as any)?.state, 'confirmed-retiring');
            assert.equal(
                (pending.durablePendingWrite as any)?.historyReconciliationVersion,
                7,
            );
            harness.vfs.forceFreshConnection();
            controls[controlIndex].release();
            await assert.rejects(saving, /lost its authoritative base/i);
            assert.strictEqual(harness.vfs.pendingDocumentUpdates.get(bufferId), pending);
            assert.equal(harness.historySubmissions.length, 1);
        };

        try {
            await attempt(0, 'abcL');
            harness.document.setDirtyText('abcL!');
            observeDirtyChange(harness);
            await harness.store.flush();
            harness.reconnectAfterConfirmedAck();

            await attempt(1, 'abcL!');
            harness.document.setDirtyText('abcL!?');
            observeDirtyChange(harness);
            await harness.store.flush();
            harness.reconnectAfterConfirmedAck(3, 'public-3');
            const generationThreePending = harness.vfs.pendingDocumentUpdates.get(bufferId);
            assert.ok(generationThreePending?.historyConfirmedAdvance);
            generationThreePending.historyConfirmedAdvance.invalidReason =
                'pre-join event belonged to the retired sender generation';

            harness.vfs.observeWillSaveTextDocument(harness.document);
            await assert.rejects(
                harness.vfs.writeFileNow(
                    harness.uri,
                    new TextEncoder().encode('abcL!?'),
                    false,
                    true,
                ),
                /lost its original editor incarnation|incomplete collaborator ancestry|retired sender generation/i,
            );
        } finally {
            controls.forEach(control => control.release());
            harness.vfs.enqueueConfirmedHistoryDeferredBatch = originalEnqueue;
            store.replacePendingWrite = originalReplacePendingWrite;
        }

        assert.equal(injectedGenerationThreeUpdate, true);
        assert.equal(harness.historySubmissions.length, 1);
        assert.equal(harness.vfs.pendingDocumentUpdates.has(bufferId), false);
        assert.equal(harness.document.getText(), 'abcL!?');
        assert.equal(harness.getRemoteText(), 'abcLXY');
        const active = harness.vfs.activeEditorBases.get(bufferId);
        assert.equal(active.historyCausality.valid, false);
        const record = await harness.store.resolveCurrentRecord(active.recordName, {
            identity: active.identity,
            bufferIncarnationId: bufferId,
            baseVersion: 8,
            baseText: 'abcLXY',
            dirtyText: 'abcL!?',
        });
        assert.equal(record.kind, 'valid');
        if (record.kind === 'valid') {
            assert.equal(record.record.pendingWrite, undefined);
        }
    });

    for (const gapCase of ['missing-first', 'missing-middle'] as const) {
        it(`retires a confirmed History write with ${gapCase} collaborator ancestry`, async () => {
            const harness = makeHistoryWriteHarness();
            const bufferId = await confirmBase(harness, 'abc');
            harness.document.setDirtyText('abcL');
            observeDirtyChange(harness);
            harness.vfs.observeWillSaveTextDocument(harness.document);
            if (gapCase === 'missing-first') {
                harness.setAfterNextAck(() => {
                    harness.advanceRemoteWithoutEvent([{textOperation: [4, 'X']}]);
                });
            } else {
                harness.setAfterNextAck(async () => {
                    await harness.applyCollaborator([{textOperation: [4, 'X']}], 'remote-one');
                    harness.advanceRemoteWithoutEvent([{textOperation: [5, 'Y']}]);
                    await harness.applyCollaborator([{textOperation: [6, 'Z']}], 'remote-two');
                });
            }

            await assert.rejects(
                harness.vfs.writeFileNow(
                    harness.uri,
                    new TextEncoder().encode('abcL'),
                    false,
                    true,
                ),
                /missing revision|incomplete collaborator ancestry/,
            );

            const active = harness.vfs.activeEditorBases.get(bufferId);
            const joinedVersion = harness.doc.version as number;
            const joinedText = harness.getRemoteText();
            assert.equal(harness.historySubmissions.length, 1);
            assert.equal(harness.getJoinCount(), 1);
            assert.equal(harness.document.getText(), 'abcL');
            assert.equal(harness.vfs.pendingDocumentUpdates.has(bufferId), false);
            assert.equal(active.historyCausality.valid, false);
            assert.equal(harness.recoveryReasons.length, 1);
            const record = await harness.store.resolveCurrentRecord(active.recordName, {
                identity: active.identity,
                bufferIncarnationId: bufferId,
                baseVersion: joinedVersion,
                baseText: joinedText,
                dirtyText: 'abcL',
            });
            assert.equal(record.kind, 'valid');
            if (record.kind === 'valid') {
                assert.equal(record.record.pendingWrite, undefined);
            }

            harness.vfs.observeWillSaveTextDocument(harness.document);
            await assert.rejects(harness.vfs.writeFileNow(
                harness.uri,
                new TextEncoder().encode('abcL'),
                false,
                true,
            ));
            assert.equal(harness.historySubmissions.length, 1);
            assert.equal(harness.getJoinCount(), 1);
        });
    }

    it('retires a confirmed History write when replayed ancestry mismatches the fresh snapshot', async () => {
        const harness = makeHistoryWriteHarness();
        const bufferId = await confirmBase(harness, 'abc');
        harness.document.setDirtyText('abcL');
        observeDirtyChange(harness);
        harness.vfs.observeWillSaveTextDocument(harness.document);
        harness.setAfterNextAck(async () => {
            await harness.applyCollaborator([{textOperation: [4, 'X']}]);
            harness.replaceRemoteSnapshotWithoutVersion({content: 'different'});
        });

        await assert.rejects(
            harness.vfs.writeFileNow(
                harness.uri,
                new TextEncoder().encode('abcL'),
                false,
                true,
            ),
            /does not match the fresh snapshot/,
        );

        const active = harness.vfs.activeEditorBases.get(bufferId);
        assert.equal(harness.historySubmissions.length, 1);
        assert.equal(harness.getJoinCount(), 1);
        assert.equal(harness.vfs.pendingDocumentUpdates.has(bufferId), false);
        assert.equal(active.historyCausality.valid, false);
        assert.equal(harness.recoveryReasons.length, 1);
        const record = await harness.store.resolveCurrentRecord(active.recordName, {
            identity: active.identity,
            bufferIncarnationId: bufferId,
            baseVersion: 7,
            baseText: 'different',
            dirtyText: 'abcL',
        });
        assert.equal(record.kind, 'valid');
        if (record.kind === 'valid') {
            assert.equal(record.record.pendingWrite, undefined);
        }
    });

    it('retires confirmed History recovery without grafting it onto a reopened editor', async () => {
        const harness = makeHistoryWriteHarness();
        const oldBufferId = await confirmBase(harness, 'abc');
        harness.document.setDirtyText('abcL');
        observeDirtyChange(harness);
        harness.vfs.observeWillSaveTextDocument(harness.document);
        const oldActive = harness.vfs.activeEditorBases.get(oldBufferId);
        await harness.store.flush();
        let replacement: TestTextDocument | undefined;
        harness.setAfterNextAck(async () => {
            await harness.applyCollaborator([{textOperation: ['R', 4]}]);
            closeHarnessDocument(harness);
            replacement = new TestTextDocument(harness.uri, 'replacement sentinel');
            openTextDocuments.push(replacement);
            harness.vfs.observeOpenedTextDocument(replacement);
        });

        await assert.rejects(
            harness.vfs.writeFileNow(
                harness.uri,
                new TextEncoder().encode('abcL'),
                false,
                true,
            ),
            /lost its original editor incarnation/,
        );

        assert.ok(replacement);
        const newBufferId = harness.vfs.editorBufferIds.get(replacement);
        assert.notEqual(newBufferId, oldBufferId);
        assert.equal(replacement.getText(), 'replacement sentinel');
        assert.equal(replacement.isDirty, false);
        assert.equal(harness.vfs.activeEditorBases.has(newBufferId), false);
        assert.equal(harness.vfs.pendingDocumentUpdates.has(oldBufferId), false);
        assert.equal(harness.historySubmissions.length, 1);
        assert.equal(harness.recoveryReasons.length, 1);
        const retired = await harness.store.resolveCurrentRecord(oldActive.recordName, {
            identity: oldActive.identity,
            bufferIncarnationId: oldBufferId,
            baseVersion: 7,
            baseText: 'RabcL',
            dirtyText: 'abcL',
        });
        assert.equal(retired.kind, 'valid');
        if (retired.kind === 'valid') {
            assert.equal(retired.record.pendingWrite, undefined);
        }
    });

    it('rebases a post-submit History edit through the advanced join and sends only the remainder', async () => {
        const harness = makeHistoryWriteHarness();
        const bufferId = await confirmBase(harness, 'abc');
        harness.document.setDirtyText('abcL');
        observeDirtyChange(harness);
        harness.vfs.observeWillSaveTextDocument(harness.document);
        harness.setBeforeNextAck(() => {
            harness.document.setDirtyText('abcL!');
            observeDirtyChange(harness);
        });
        harness.setAfterNextAck(() => harness.applyCollaborator([
            {textOperation: ['R', 4]},
        ]));
        const originalApplyEdit = vscodeStub.workspace.applyEdit;
        try {
            vscodeStub.workspace.applyEdit = async (edit: WorkspaceEditStub) =>
                applyFirstWorkspaceReplacement(harness, edit);
            await harness.vfs.writeFileNow(
                harness.uri,
                new TextEncoder().encode('abcL'),
                false,
                true,
            );
        } finally {
            vscodeStub.workspace.applyEdit = originalApplyEdit;
        }

        let active = harness.vfs.activeEditorBases.get(bufferId);
        assert.equal(harness.historySubmissions.length, 1);
        assert.equal(harness.getRemoteText(), 'RabcL');
        assert.equal(harness.document.getText(), 'RabcL!');
        assert.equal(active.historyCausality.valid, true);
        assert.equal(active.historyCausality.remoteVersion, 7);
        assert.ok(active.historyCausality.pending);
        let record = await harness.store.resolveCurrentRecord(active.recordName, {
            identity: active.identity,
            bufferIncarnationId: bufferId,
            baseVersion: 7,
            baseText: 'RabcL',
            dirtyText: 'RabcL!',
        });
        assert.equal(record.kind, 'valid');
        if (record.kind === 'valid') {
            assert.equal(record.record.pendingWrite, undefined);
        }

        harness.vfs.observeWillSaveTextDocument(harness.document);
        await harness.vfs.writeFileNow(
            harness.uri,
            new TextEncoder().encode('RabcL!'),
            false,
            true,
        );
        active = harness.vfs.activeEditorBases.get(bufferId);
        assert.equal(harness.historySubmissions.length, 2);
        assert.equal(harness.historySubmissions[1].envelope.v, 7);
        assert.equal(harness.getRemoteText(), 'RabcL!');
        assert.equal(active.historyCausality.remoteVersion, 8);
        assert.equal(active.historyCausality.pending, undefined);
    });

    for (const firstOutcome of ['unknown-unapplied', 'unknown-applied'] as const) {
        it(`recovers an ${firstOutcome} History submission exactly once with dupIfSource`, async () => {
            const harness = makeHistoryWriteHarness();
            await confirmBase(harness, 'abc');
            harness.document.setDirtyText('abcL');
            observeDirtyChange(harness);
            harness.vfs.observeWillSaveTextDocument(harness.document);
            harness.setNextSubmissionMode(firstOutcome);

            await assert.rejects(
                harness.vfs.writeFileNow(
                    harness.uri,
                    new TextEncoder().encode('abcL'),
                    false,
                    true,
                ),
                (error: unknown) => error instanceof SocketRequestError && error.outcomeUnknown,
            );
            const bufferId = harness.vfs.editorBufferIds.get(harness.document);
            assert.equal(harness.vfs.pendingDocumentUpdates.has(bufferId), true);
            assert.equal(harness.document.getText(), 'abcL');

            harness.reconnectForRecovery();
            harness.vfs.observeWillSaveTextDocument(harness.document);
            await harness.vfs.writeFileNow(
                harness.uri,
                new TextEncoder().encode('abcL'),
                false,
                true,
            );

            assert.equal(harness.historySubmissions.length, 2);
            assert.deepEqual(
                harness.historySubmissions[1].envelope.dupIfSource,
                ['public-1'],
            );
            assert.equal(harness.historySubmissions[1].envelope.meta.source, 'public-2');
            assert.equal(harness.historySubmissions[1].envelope.v, 5);
            assert.equal(harness.getRemoteText(), 'abcL');
            assert.equal(harness.doc.version, 6);
            assert.equal(harness.vfs.pendingDocumentUpdates.has(bufferId), false);
            assert.equal(harness.historySession.getState().hasPendingOperation, false);
            closeHarnessDocument(harness);
        });
    }

    it('rolls back only an exact zero-wire History rejection', async () => {
        const harness = makeHistoryWriteHarness();
        await confirmBase(harness, 'abc');
        harness.document.setDirtyText('abcL');
        observeDirtyChange(harness);
        harness.vfs.observeWillSaveTextDocument(harness.document);
        harness.setNextSubmissionMode('deterministic-reject');

        await assert.rejects(
            harness.vfs.writeFileNow(
                harness.uri,
                new TextEncoder().encode('abcL'),
                false,
                true,
            ),
            (error: unknown) => error instanceof SocketRequestError && !error.outcomeUnknown,
        );

        const bufferId = harness.vfs.editorBufferIds.get(harness.document);
        const active = harness.vfs.activeEditorBases.get(bufferId);
        assert.equal(harness.historySubmissions.length, 0);
        assert.equal(harness.vfs.pendingDocumentUpdates.has(bufferId), false);
        assert.equal(harness.historySession.getState().hasPendingOperation, false);
        assert.equal(active.historyCausality.valid, true);
        assert.equal(active.historyCausality.inflightWire, undefined);
        assert.ok(active.historyCausality.pending);
        assert.equal(harness.document.getText(), 'abcL');
        assert.equal(harness.getRemoteText(), 'abc');
    });

    it('clears an unsent History intent without resurrecting downgraded permission', async () => {
        const harness = makeHistoryWriteHarness();
        const bufferId = await confirmBase(harness, 'abc');
        harness.document.setDirtyText('abcL');
        observeDirtyChange(harness);
        harness.vfs.observeWillSaveTextDocument(harness.document);
        harness.setNextSubmissionMode('permission-downgrade');

        await assert.rejects(
            harness.vfs.writeFileNow(
                harness.uri,
                new TextEncoder().encode('abcL'),
                false,
                true,
            ),
            (error: unknown) => error instanceof SocketRequestError && !error.outcomeUnknown,
        );

        const active = harness.vfs.activeEditorBases.get(bufferId);
        const sessionState = harness.historySession.getState();
        assert.equal(harness.historySubmissions.length, 0);
        assert.equal(sessionState.hasPendingOperation, false);
        assert.equal(sessionState.phase, 'rejoin-required');
        assert.equal(sessionState.permission, 'readOnly');
        assert.equal(harness.vfs.pendingDocumentUpdates.has(bufferId), false);
        assert.equal(active.historyCausality.valid, true);
        const record = await harness.store.resolveCurrentRecord(active.recordName, {
            identity: active.identity,
            bufferIncarnationId: bufferId,
            baseVersion: 5,
            baseText: 'abc',
            dirtyText: 'abcL',
        });
        assert.equal(record.kind, 'valid');
        if (record.kind === 'valid') {
            assert.equal(record.record.pendingWrite, undefined);
        }
        assert.equal(harness.getRemoteText(), 'abc');
    });

    it('rolls back an exact History error ACK after the wire attempt', async () => {
        const harness = makeHistoryWriteHarness();
        const bufferId = await confirmBase(harness, 'abc');
        harness.document.setDirtyText('abcL');
        observeDirtyChange(harness);
        harness.vfs.observeWillSaveTextDocument(harness.document);
        harness.setNextSubmissionMode('deterministic-wire-reject');

        await assert.rejects(
            harness.vfs.writeFileNow(
                harness.uri,
                new TextEncoder().encode('abcL'),
                false,
                true,
            ),
            (error: unknown) => error instanceof SocketRequestError && !error.outcomeUnknown,
        );

        const active = harness.vfs.activeEditorBases.get(bufferId);
        assert.equal(harness.historySubmissions.length, 1);
        assert.equal(harness.vfs.pendingDocumentUpdates.has(bufferId), false);
        assert.equal(harness.historySession.getState().hasPendingOperation, false);
        assert.equal(active.historyCausality.valid, true);
        assert.equal(active.historyCausality.inflightWire, undefined);
        assert.ok(active.historyCausality.pending);
        const record = await harness.store.resolveCurrentRecord(active.recordName, {
            identity: active.identity,
            bufferIncarnationId: bufferId,
            baseVersion: 5,
            baseText: 'abc',
            dirtyText: 'abcL',
        });
        assert.equal(record.kind, 'valid');
        if (record.kind === 'valid') {
            assert.equal(record.record.pendingWrite, undefined);
        }
        assert.equal(harness.getRemoteText(), 'abc');
    });

    it('restores the original History pending intent after a rejected recovery error ACK', async () => {
        const harness = makeHistoryWriteHarness();
        const bufferId = await confirmBase(harness, 'abc');
        harness.document.setDirtyText('abcL');
        observeDirtyChange(harness);
        harness.vfs.observeWillSaveTextDocument(harness.document);
        harness.setNextSubmissionMode('unknown-unapplied');
        await assert.rejects(
            harness.vfs.writeFileNow(
                harness.uri,
                new TextEncoder().encode('abcL'),
                false,
                true,
            ),
            (error: unknown) => error instanceof SocketRequestError && error.outcomeUnknown,
        );
        const originalPending = harness.vfs.pendingDocumentUpdates.get(bufferId);
        assert.ok(originalPending);
        const active = harness.vfs.activeEditorBases.get(bufferId);
        const originalRecord = await harness.store.resolveCurrentRecord(active.recordName, {
            identity: active.identity,
            bufferIncarnationId: bufferId,
            baseVersion: 5,
            baseText: 'abc',
            dirtyText: 'abcL',
        });
        assert.equal(originalRecord.kind, 'valid');
        assert.ok(originalRecord.kind === 'valid');
        const originalPayload = originalRecord.record.pendingWrite;

        harness.reconnectForRecovery();
        harness.vfs.observeWillSaveTextDocument(harness.document);
        harness.setNextSubmissionMode('deterministic-wire-reject');
        await assert.rejects(
            harness.vfs.writeFileNow(
                harness.uri,
                new TextEncoder().encode('abcL'),
                false,
                true,
            ),
            (error: unknown) => error instanceof SocketRequestError && !error.outcomeUnknown,
        );

        assert.equal(harness.historySubmissions.length, 2);
        assert.deepEqual(harness.historySubmissions[1].envelope.dupIfSource, ['public-1']);
        const restoredPending = harness.vfs.pendingDocumentUpdates.get(bufferId);
        assert.deepEqual(restoredPending.submittedPublicIds, ['public-1']);
        assert.deepEqual(restoredPending.update, originalPending.update);
        const restoredRecord = await harness.store.resolveCurrentRecord(active.recordName, {
            identity: active.identity,
            bufferIncarnationId: bufferId,
            baseVersion: 5,
            baseText: 'abc',
            dirtyText: 'abcL',
        });
        assert.equal(restoredRecord.kind, 'valid');
        assert.ok(restoredRecord.kind === 'valid');
        assert.deepEqual(restoredRecord.record.pendingWrite, originalPayload);
        assert.equal(harness.getRemoteText(), 'abc');
    });
});

describe('remote document exact-base write gate', () => {
    beforeEach(() => {
        openTextDocuments.length = 0;
    });

    it('keeps ShareJS and create mutations blocked for review permission', async () => {
        const harness = makeHarness({remoteText: 'abc'});
        harness.vfs.permissionsLevel = 'review';
        harness.vfs.socket.projectSession.permissionsLevel = 'review';

        await assert.rejects(
            harness.vfs.writeFile(
                harness.uri,
                new TextEncoder().encode('abc'),
                false,
                true,
            ),
            /Track Changes sessions are read-only/i,
        );
        await assert.rejects(
            harness.vfs.writeFile(
                harness.uri,
                new TextEncoder().encode('new'),
                true,
                false,
            ),
            /Track Changes sessions are read-only/i,
        );
        assert.equal(harness.submissions.length, 0);
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

    it('blocks a multi-change editor transaction without sending OT', async () => {
        const harness = makeHarness({remoteText: 'abc', remoteVersion: 7});
        await confirmBase(harness, 'abc');
        harness.document.setDirtyText('XabcY');
        harness.document.takeContentChanges();
        harness.vfs.observeChangedTextDocument({
            document: harness.document,
            contentChanges: [
                {rangeOffset: 0, rangeLength: 0, text: 'X'},
                {rangeOffset: 3, rangeLength: 0, text: 'Y'},
            ],
        });
        harness.vfs.observeWillSaveTextDocument(harness.document);

        await assert.rejects(
            harness.vfs.writeFileNow(
                harness.uri,
                new TextEncoder().encode('XabcY'),
                false,
                true,
            ),
            /editor change events do not prove the exact local operation/i,
        );
        assert.equal(harness.submissions.length, 0);
        assert.equal(harness.getRemoteText(), 'abc');
        assert.equal(harness.document.isDirty, true);
    });

    it('blocks a missed editor version without sending OT', async () => {
        const harness = makeHarness({remoteText: 'abc', remoteVersion: 7});
        await confirmBase(harness, 'abc');
        harness.document.setDirtyText('abcL');
        const contentChanges = harness.document.takeContentChanges();
        harness.document.version += 1;
        harness.vfs.observeChangedTextDocument({document: harness.document, contentChanges});
        harness.vfs.observeWillSaveTextDocument(harness.document);

        await assert.rejects(
            harness.vfs.writeFileNow(
                harness.uri,
                new TextEncoder().encode('abcL'),
                false,
                true,
            ),
            /editor change events do not prove the exact local operation/i,
        );
        assert.equal(harness.submissions.length, 0);
        assert.equal(harness.getRemoteText(), 'abc');
        assert.equal(harness.document.isDirty, true);
    });

    it('promotes only an explicitly confirmed clean provider read and persists the later dirty editor text', async () => {
        const harness = makeHarness({remoteText: 'clean base', remoteVersion: 7});
        harness.vfs.stageEditorBase(harness.uri, harness.doc, 'clean base');
        harness.vfs.observeTextDocument(harness.document);
        const bufferId = harness.vfs.editorBufferIds.get(harness.document);
        assert.equal(harness.vfs.activeEditorBases.has(bufferId), false);
        assert.equal(await harness.vfs.confirmEditorBase(harness.document), true);
        harness.document.setDirtyText('dirty edit');
        observeDirtyChange(harness);
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
        observeDirtyChange(harness);
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
            observeDirtyChange(harness);
            assert.equal(
                harness.vfs.pendingDocumentUpdates.get(bufferId)?.durablePendingWriteTransition,
                undefined,
                'ShareJS cleanup must not inherit the History durability barrier',
            );
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
        await assert.rejects(
            harness.vfs.writeFileNow(
                harness.uri,
                new TextEncoder().encode('hello world + next local edit'),
                false,
                true,
            ),
            /editor change events do not prove the exact local operation/i,
        );
        assert.equal(harness.submissions.length, 1, 'the cleanup-window edit must not be inferred from snapshots');
        assert.equal(harness.getRemoteText(), 'hello world');
        assert.equal(harness.document.isDirty, true);
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
        afterAckLoss.vfs.stageEditorBase(
            afterAckLoss.uri,
            afterAckLoss.doc,
            'local edit',
        );
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
