/* eslint-disable @typescript-eslint/naming-convention */
import {strict as assert} from 'assert';
import {SocketRequestError} from '../../api/socketRequest';
import {
    DocumentProvenanceStore,
    ProvenanceStorage,
} from '../../core/documentProvenance';
import {prepareDocumentUpdate} from '../../core/documentUpdate';

export type TextOperation = {
    p: number,
    i?: string,
    d?: string,
};

export type CapturedUpdate = {
    projectId: string,
    docId: string,
    publicId: string,
    update: {
        doc: string,
        v: number,
        op?: TextOperation[],
        dupIfSource?: string[],
        [key: string]: unknown,
    },
};

type EventHandlers = {
    onConnectionAccepted?: (publicId: string) => void,
    onProjectJoined?: (session: {
        publicId: string,
        permissionsLevel: string,
        protocolVersion: number,
        generation: number,
    }) => void,
    onDisconnected?: () => void,
    onFileChanged?: (update: {
        doc: string,
        v: number,
        op?: TextOperation[],
    }, sender?: {publicId: string, generation: number}) => void,
};

type StoredDocument = {
    id: string,
    name: string,
    content: string,
    version: number,
    applications: Array<{
        version: number,
        publicId: string,
    }>,
};

type StoredProject = {
    id: string,
    name: string,
    document: StoredDocument,
    additionalDocuments: StoredDocument[],
};

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

export function applyTextOperations(content: string, operations: TextOperation[] = []): string {
    let result = content;
    for (const operation of operations) {
        assert.ok(Number.isInteger(operation.p), 'OT positions must be integers');
        assert.ok(operation.p >= 0 && operation.p <= result.length, 'OT position is outside the document');
        if (operation.d !== undefined) {
            assert.equal(
                result.slice(operation.p, operation.p + operation.d.length),
                operation.d,
                'OT deletion must match authoritative text',
            );
            result = result.slice(0, operation.p) + result.slice(operation.p + operation.d.length);
        }
        if (operation.i !== undefined) {
            result = result.slice(0, operation.p) + operation.i + result.slice(operation.p);
        }
    }
    return result;
}

class UriStub {
    constructor(
        readonly scheme: string,
        readonly authority: string,
        readonly path: string,
        readonly query = '',
        readonly fragment = '',
    ) {}

    with(change: Partial<Pick<UriStub, 'scheme' | 'authority' | 'path' | 'query' | 'fragment'>>) {
        return new UriStub(
            change.scheme ?? this.scheme,
            change.authority ?? this.authority,
            change.path ?? this.path,
            change.query ?? this.query,
            change.fragment ?? this.fragment,
        );
    }

    toString(): string {
        const query = this.query ? `?${this.query}` : '';
        const fragment = this.fragment ? `#${this.fragment}` : '';
        return `${this.scheme}://${this.authority}${this.path}${query}${fragment}`;
    }

    static from(parts: {
        scheme: string,
        authority?: string,
        path?: string,
        query?: string,
        fragment?: string,
    }) {
        return new UriStub(
            parts.scheme,
            parts.authority ?? '',
            parts.path ?? '',
            parts.query ?? '',
            parts.fragment ?? '',
        );
    }

    static parse(value: string) {
        const parsed = new URL(value);
        return new UriStub(
            parsed.protocol.replace(/:$/, ''),
            parsed.host,
            parsed.pathname,
            parsed.search.replace(/^\?/, ''),
            parsed.hash.replace(/^#/, ''),
        );
    }

    static joinPath(base: UriStub, ...parts: string[]) {
        const suffix = parts.map(part => part.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
        const basePath = base.path.replace(/\/+$/, '');
        return base.with({path: `${basePath}/${suffix}`});
    }
}

class DisposableStub {
    private disposed = false;

    constructor(private readonly callback?: () => void) {}

    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;
        this.callback?.();
    }

    static from(...items: Array<{dispose(): void}>) {
        return new DisposableStub(() => items.forEach(item => item.dispose()));
    }
}

class EventEmitterStub<T> {
    readonly events: T[] = [];
    readonly event = () => new DisposableStub();

    fire(event: T): void {
        this.events.push(event);
    }

    dispose(): void {}
}

class FileSystemErrorStub extends Error {
    constructor(message: string, readonly code: string) {
        super(message);
        this.name = 'FileSystemError';
    }

    static FileNotFound(value?: unknown) {
        return new FileSystemErrorStub(String(value ?? 'File not found'), 'FileNotFound');
    }

    static FileExists(value?: unknown) {
        return new FileSystemErrorStub(String(value ?? 'File exists'), 'FileExists');
    }

    static NoPermissions(value?: unknown) {
        return new FileSystemErrorStub(String(value ?? 'No permissions'), 'NoPermissions');
    }

    static Unavailable(value?: unknown) {
        return new FileSystemErrorStub(String(value ?? 'Unavailable'), 'Unavailable');
    }
}

const workspaceDocuments: Array<{
    uri: UriStub,
    readonly isDirty: boolean,
    readonly isClosed: boolean,
    readonly version: number,
    getText(): string,
}> = [];

type HarnessTextDocument = typeof workspaceDocuments[number];

type DeferredWarningResponse = {
    resolve(response: string | undefined): void,
};

class ProductionWorkspaceEventHarness {
    private readonly didOpenListeners = new Set<(document: HarnessTextDocument) => void>();
    private readonly didChangeListeners = new Set<(event: {document: HarnessTextDocument}) => void>();
    private readonly willSaveListeners = new Set<(event: {document: HarnessTextDocument}) => void>();
    private readonly didSaveListeners = new Set<(document: HarnessTextDocument) => void>();
    private readonly didCloseListeners = new Set<(document: HarnessTextDocument) => void>();
    private readonly warningResponses: Array<Promise<string | undefined>> = [];
    readonly warningMessages: Array<{message: string, items: unknown[]}> = [];

    private subscribe<T>(listeners: Set<(value: T) => void>, listener: (value: T) => void) {
        listeners.add(listener);
        return new DisposableStub(() => listeners.delete(listener));
    }

    onDidOpen(listener: (document: HarnessTextDocument) => void) {
        return this.subscribe(this.didOpenListeners, listener);
    }

    onDidChange(listener: (event: {document: HarnessTextDocument}) => void) {
        return this.subscribe(this.didChangeListeners, listener);
    }

    onWillSave(listener: (event: {document: HarnessTextDocument}) => void) {
        return this.subscribe(this.willSaveListeners, listener);
    }

    onDidSave(listener: (document: HarnessTextDocument) => void) {
        return this.subscribe(this.didSaveListeners, listener);
    }

    onDidClose(listener: (document: HarnessTextDocument) => void) {
        return this.subscribe(this.didCloseListeners, listener);
    }

    fireDidOpen(document: HarnessTextDocument): void {
        this.didOpenListeners.forEach(listener => listener(document));
    }

    fireDidChange(document: HarnessTextDocument): void {
        this.didChangeListeners.forEach(listener => listener({document}));
    }

    fireWillSave(document: HarnessTextDocument): void {
        this.willSaveListeners.forEach(listener => listener({document}));
    }

    fireDidSave(document: HarnessTextDocument): void {
        this.didSaveListeners.forEach(listener => listener(document));
    }

    fireDidClose(document: HarnessTextDocument): void {
        this.didCloseListeners.forEach(listener => listener(document));
    }

    queueWarningResponse(response: string | undefined): void {
        this.warningResponses.push(Promise.resolve(response));
    }

    deferWarningResponse(): DeferredWarningResponse {
        let resolveResponse!: (response: string | undefined) => void;
        const response = new Promise<string | undefined>(resolve => {
            resolveResponse = resolve;
        });
        this.warningResponses.push(response);
        return {resolve: resolveResponse};
    }

    async showWarningMessage(message: string, ...items: unknown[]): Promise<string | undefined> {
        this.warningMessages.push({message, items});
        return (this.warningResponses.shift() ?? Promise.resolve(undefined));
    }

    reset(): void {
        this.didOpenListeners.clear();
        this.didChangeListeners.clear();
        this.willSaveListeners.clear();
        this.didSaveListeners.clear();
        this.didCloseListeners.clear();
        this.warningResponses.splice(0, this.warningResponses.length);
        this.warningMessages.splice(0, this.warningMessages.length);
    }
}

export const productionWorkspaceEvents = new ProductionWorkspaceEventHarness();

const workspaceFileBytes = new Map<string, Uint8Array>();

function workspaceFileKey(uri: UriStub): string {
    return uri.toString();
}

async function readWorkspaceFile(uri: UriStub): Promise<Uint8Array> {
    const value = workspaceFileBytes.get(workspaceFileKey(uri));
    if (!value) { throw FileSystemErrorStub.FileNotFound(uri); }
    return new Uint8Array(value);
}

async function writeWorkspaceFile(uri: UriStub, content: Uint8Array): Promise<void> {
    workspaceFileBytes.set(workspaceFileKey(uri), new Uint8Array(content));
}

async function readWorkspaceDirectory(uri: UriStub): Promise<Array<[string, number]>> {
    const prefix = `${workspaceFileKey(uri).replace(/\/+$/, '')}/`;
    const entries = [...workspaceFileBytes.keys()]
        .filter(key => key.startsWith(prefix))
        .map(key => key.slice(prefix.length))
        .filter(name => name.length > 0 && !name.includes('/'))
        .map((name): [string, number] => [name, 1]);
    return entries;
}

async function renameWorkspaceFile(
    source: UriStub,
    target: UriStub,
    options: {overwrite: boolean},
): Promise<void> {
    const sourceKey = workspaceFileKey(source);
    const targetKey = workspaceFileKey(target);
    const value = workspaceFileBytes.get(sourceKey);
    if (!value) { throw FileSystemErrorStub.FileNotFound(source); }
    if (!options.overwrite && workspaceFileBytes.has(targetKey)) {
        throw FileSystemErrorStub.FileExists(target);
    }
    workspaceFileBytes.set(targetKey, new Uint8Array(value));
    workspaceFileBytes.delete(sourceKey);
}

const vscodeStub = {
    Disposable: DisposableStub,
    EventEmitter: EventEmitterStub,
    FileSystemError: FileSystemErrorStub,
    FileType: {Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64},
    FilePermission: {Readonly: 1},
    FileChangeType: {Changed: 1, Created: 2, Deleted: 3},
    ProgressLocation: {Notification: 15},
    StatusBarAlignment: {Left: 1, Right: 2},
    Uri: UriStub,
    l10n: {
        t: (message: string, values?: Record<string, unknown>) => {
            if (!values) { return message; }
            return Object.entries(values).reduce(
                (result, [key, value]) => result.replace(`{${key}}`, String(value)),
                message,
            );
        },
    },
    workspace: {
        textDocuments: workspaceDocuments,
        workspaceFolders: undefined,
        registerFileSystemProvider: () => new DisposableStub(),
        onDidOpenTextDocument: (listener: (document: HarnessTextDocument) => void) =>
            productionWorkspaceEvents.onDidOpen(listener),
        onDidChangeTextDocument: (listener: (event: {document: HarnessTextDocument}) => void) =>
            productionWorkspaceEvents.onDidChange(listener),
        onWillSaveTextDocument: (listener: (event: {document: HarnessTextDocument}) => void) =>
            productionWorkspaceEvents.onWillSave(listener),
        onDidSaveTextDocument: (listener: (document: HarnessTextDocument) => void) =>
            productionWorkspaceEvents.onDidSave(listener),
        onDidCloseTextDocument: (listener: (document: HarnessTextDocument) => void) =>
            productionWorkspaceEvents.onDidClose(listener),
        getConfiguration: () => ({
            get: (_key: string, fallback: unknown) => fallback,
        }),
        fs: {
            readFile: readWorkspaceFile,
            writeFile: writeWorkspaceFile,
            readDirectory: readWorkspaceDirectory,
            createDirectory: async () => {},
            rename: renameWorkspaceFile,
            delete: async (uri: UriStub) => {
                workspaceFileBytes.delete(workspaceFileKey(uri));
            },
        },
    },
    window: {
        visibleTextEditors: [],
        activeTextEditor: undefined,
        withProgress: async (_options: unknown, task: () => Promise<unknown>) => task(),
        showErrorMessage: async () => undefined,
        showInformationMessage: async () => undefined,
        showWarningMessage: (message: string, ...items: unknown[]) =>
            productionWorkspaceEvents.showWarningMessage(message, ...items),
        showSaveDialog: async () => undefined,
        createStatusBarItem: () => ({show() {}, hide() {}, dispose() {}}),
        createTextEditorDecorationType: () => ({dispose() {}}),
    },
    commands: {
        executeCommand: async () => undefined,
        registerCommand: () => new DisposableStub(),
    },
};

class MemoryMemento {
    constructor(private readonly values = new Map<string, unknown>()) {}

    get<T>(key: string): T | undefined;
    get<T>(key: string, defaultValue: T): T;
    get<T>(key: string, defaultValue?: T): T | undefined {
        return this.values.has(key) ? this.values.get(key) as T : defaultValue;
    }

    async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) {
            this.values.delete(key);
        } else {
            this.values.set(key, clone(value));
        }
    }

    keys(): readonly string[] {
        return [...this.values.keys()];
    }

    setKeysForSync(_keys: readonly string[]): void {}
}

class MemoryProvenanceStorage implements ProvenanceStorage {
    constructor(private readonly values: Map<string, Uint8Array>) {}

    async list(): Promise<string[]> {
        return [...this.values.keys()];
    }

    async read(recordName: string): Promise<Uint8Array | undefined> {
        const value = this.values.get(recordName);
        return value && new Uint8Array(value);
    }

    async write(recordName: string, content: Uint8Array): Promise<void> {
        this.values.set(recordName, new Uint8Array(content));
    }

    async delete(recordName: string): Promise<void> {
        this.values.delete(recordName);
    }
}

export class HarnessStorage {
    readonly globalState = new MemoryMemento();
    private readonly workspaceStates = new Map<string, MemoryMemento>();
    private readonly provenanceBytes = new Map<string, Map<string, Uint8Array>>();
    private readonly provenanceStores = new Map<string, DocumentProvenanceStore>();
    private sessionSequence = 0;

    provenanceStore(windowId: string): DocumentProvenanceStore {
        let store = this.provenanceStores.get(windowId);
        if (!store) {
            let bytes = this.provenanceBytes.get(windowId);
            if (!bytes) {
                bytes = new Map<string, Uint8Array>();
                this.provenanceBytes.set(windowId, bytes);
            }
            this.sessionSequence += 1;
            store = new DocumentProvenanceStore(
                new MemoryProvenanceStorage(bytes),
                {sessionId: `${windowId}-session-${this.sessionSequence}`},
            );
            this.provenanceStores.set(windowId, store);
        }
        return store;
    }

    restartWindow(windowId: string): void {
        this.provenanceStores.delete(windowId);
    }

    context(server: DeterministicRealtimeServer, windowId: string) {
        let workspaceState = this.workspaceStates.get(windowId);
        if (!workspaceState) {
            workspaceState = new MemoryMemento();
            this.workspaceStates.set(windowId, workspaceState);
        }
        return {
            __realtimeServer: server,
            __windowId: windowId,
            globalState: this.globalState,
            workspaceState,
            subscriptions: [],
            extensionUri: UriStub.from({scheme: 'file', path: '/extension'}),
            storageUri: UriStub.from({scheme: 'file', path: `/storage/${windowId}`} ),
            globalStorageUri: UriStub.from({scheme: 'file', path: '/global-storage'}),
            logUri: UriStub.from({scheme: 'file', path: `/logs/${windowId}`} ),
            extensionMode: 3,
            secrets: {
                get: async () => undefined,
                store: async () => {},
                delete: async () => {},
                onDidChange: () => new DisposableStub(),
            },
            environmentVariableCollection: {
                persistent: false,
                replace() {}, append() {}, prepend() {}, get() {}, forEach() {}, delete() {}, clear() {},
                getScoped: () => undefined,
                description: undefined,
            },
            asAbsolutePath: (relativePath: string) => `/extension/${relativePath}`,
        };
    }
}

class NoopClientManager {
    readonly triggers: DisposableStub[] = [];
    updatePublicId(_publicId: string): void {}
}

class NoopSCMCollectionProvider {
    readonly triggers: DisposableStub[] = [];
}

interface ModuleLoader {
    _load(request: string, parent: NodeModule | null, isMain: boolean): unknown,
}

let VirtualFileSystemConstructor: any;
let RemoteFileSystemProviderConstructor: any;
let loadedRemotePath: string | undefined;
let loadedStatePath: string | undefined;
let previousRemoteModule: NodeModule | undefined;
let previousStateModule: NodeModule | undefined;
let loadedGlobalStateManager: any;
let originalInitSocketIOAPI: unknown;
let originalAuthenticate: unknown;
let originalCacheKeys: Set<string> | undefined;

function loadVirtualFileSystem(): any {
    if (VirtualFileSystemConstructor) { return VirtualFileSystemConstructor; }

    const moduleLoader = require('module') as ModuleLoader;
    const originalLoad = moduleLoader._load;
    originalCacheKeys = new Set(Object.keys(require.cache));
    moduleLoader._load = function(request, parent, isMain): unknown {
        if (request === 'vscode') { return vscodeStub; }
        if (request === '../collaboration/clientManager') {
            return {ClientManager: NoopClientManager};
        }
        if (request === '../scm/scmCollectionProvider') {
            return {SCMCollectionProvider: NoopSCMCollectionProvider};
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    try {
        const remotePath = require.resolve('../../core/remoteFileSystemProvider');
        const statePath = require.resolve('../../utils/globalStateManager');
        loadedRemotePath = remotePath;
        loadedStatePath = statePath;
        previousRemoteModule = require.cache[remotePath];
        previousStateModule = require.cache[statePath];
        delete require.cache[remotePath];
        delete require.cache[statePath];
        const remoteModule = require(remotePath) as typeof import('../../core/remoteFileSystemProvider');
        const {GlobalStateManager} = require(statePath) as typeof import('../../utils/globalStateManager');

        loadedGlobalStateManager = GlobalStateManager;
        originalInitSocketIOAPI = GlobalStateManager.initSocketIOAPI;
        originalAuthenticate = GlobalStateManager.authenticate;
        GlobalStateManager.initSocketIOAPI = ((context: {
            __realtimeServer: DeterministicRealtimeServer,
            __windowId: string,
        }, _name: string, projectId: string) => {
            return {
                ...context.__realtimeServer.createClient(projectId, context.__windowId),
                serverUrl: 'https://www.overleaf.com/',
                userId: 'test-user',
            };
        }) as unknown as typeof GlobalStateManager.initSocketIOAPI;
        GlobalStateManager.authenticate = (async () => ({
            csrfToken: 'csrf',
            cookies: 'session=test',
        })) as typeof GlobalStateManager.authenticate;
        VirtualFileSystemConstructor = remoteModule.VirtualFileSystem;
        RemoteFileSystemProviderConstructor = remoteModule.RemoteFileSystemProvider;
    } finally {
        moduleLoader._load = originalLoad;
    }

    return VirtualFileSystemConstructor;
}

class FakeProjectAPI {
    constructor(
        private readonly server: DeterministicRealtimeServer,
        private readonly projectId: string,
    ) {}

    async getProjectSettings() {
        return {
            type: 'success',
            settings: {
                compiler: 'pdflatex',
                rootDocId: undefined,
                spellCheckLanguage: 'en',
            },
        };
    }

    async addDoc(
        _identity: unknown,
        projectId: string,
        parentFolderId: string,
        filename: string,
    ) {
        assert.equal(projectId, this.projectId);
        this.server.addDocCallCount += 1;
        return this.server.createDocument(projectId, parentFolderId, filename, '');
    }

    async uploadFile(
        _identity: unknown,
        projectId: string,
        parentFolderId: string,
        filename: string,
        content: Uint8Array,
    ) {
        assert.equal(projectId, this.projectId);
        this.server.uploadFileCallCount += 1;
        return this.server.createDocument(
            projectId,
            parentFolderId,
            filename,
            new TextDecoder().decode(content),
        );
    }

    async projectEntitiesJson(_identity: unknown, projectId: string) {
        assert.equal(projectId, this.projectId);
        this.server.projectEntitiesReadCount += 1;
        return {
            type: 'success' as const,
            entities: this.server.projectEntities(projectId),
        };
    }
}

class DeterministicSocket {
    handlers: EventHandlers = {};
    connected = true;
    generation = 1;
    fatalError = undefined;
    isUsingAlternativeConnectionScheme = false;
    joinedDocuments = new Set<string>();
    publicId = '';

    constructor(
        private readonly server: DeterministicRealtimeServer,
        readonly projectId: string,
        readonly windowId: string,
    ) {
        this.startConnection();
    }

    get isConnected(): boolean {
        return this.connected;
    }

    get needsReinit(): boolean {
        return !this.connected;
    }

    get projectSession() {
        return this.connected ? {
            publicId: this.publicId,
            permissionsLevel: 'owner' as const,
            protocolVersion: 2,
            generation: this.generation,
        } : undefined;
    }

    updateEventHandlers(handlers: EventHandlers): void {
        this.handlers = {...this.handlers, ...handlers};
    }

    init(): void {
        if (this.connected) { return; }
        this.generation += 1;
        this.startConnection();
    }

    private startConnection(): void {
        this.connected = true;
        this.joinedDocuments.clear();
        this.publicId = this.server.allocatePublicId(this.windowId);
    }

    async waitUntilConnected(): Promise<number> {
        if (!this.connected) {
            throw new SocketRequestError('not_connected', 'Deterministic transport is disconnected', false);
        }
        return this.generation;
    }

    async joinProject(projectId: string) {
        assert.equal(projectId, this.projectId);
        const project = this.server.projectSnapshot(projectId);
        this.handlers.onConnectionAccepted?.(this.publicId);
        this.handlers.onProjectJoined?.({
            publicId: this.publicId,
            permissionsLevel: 'owner',
            protocolVersion: 2,
            generation: this.generation,
        });
        return project;
    }

    async joinDoc(docId: string) {
        const document = this.server.document(this.projectId, docId);
        this.joinedDocuments.add(docId);
        return {
            docLines: document.content.split('\n'),
            version: document.version,
            updates: [],
            ranges: {},
        };
    }

    async applyOtUpdate(docId: string, update: CapturedUpdate['update']): Promise<void> {
        return this.server.receiveUpdate(this, docId, update);
    }

    emitAnonymousSenderConfirmation(docId: string, version: number): void {
        this.handlers.onFileChanged?.({doc: docId, v: version});
    }

    disconnect(): void {
        if (!this.connected) { return; }
        this.connected = false;
        this.generation += 1;
        this.handlers.onDisconnected?.();
    }

    dropAcknowledgementConnection(): void {
        if (!this.connected) { return; }
        this.connected = false;
        this.generation += 1;
    }

    invalidateCurrentTransport(): void {
        this.disconnect();
    }

    dispose(): void {
        this.connected = false;
        this.handlers = {};
        this.server.removeSocket(this);
    }

    toggleAlternativeConnectionScheme(): void {
        throw new Error('Alternative connection mode is outside this fixture');
    }
}

export class DeterministicRealtimeServer {
    readonly capturedUpdates: CapturedUpdate[] = [];
    queueAcknowledgementCount = 0;
    logicalApplyCount = 0;
    senderConfirmationCount = 0;
    collaboratorBroadcastCount = 0;
    clientCreationCount = 0;
    documentCreationCount = 0;
    addDocCallCount = 0;
    uploadFileCallCount = 0;
    projectEntitiesReadCount = 0;
    private readonly projects = new Map<string, StoredProject>();
    private readonly sockets = new Set<DeterministicSocket>();
    private publicIdSequence = 0;
    private nextUpdateFault: 'before-apply' | 'after-apply' | undefined;
    private holdNextQueuedApplication = false;
    private heldApplication: (() => void) | undefined;
    private transformHeldApplication = false;

    addProject(spec: {
        projectId: string,
        projectName: string,
        docId?: string,
        fileName?: string,
        content: string,
        version?: number,
    }): void {
        const docId = spec.docId ?? 'shared-doc-id';
        this.projects.set(spec.projectId, {
            id: spec.projectId,
            name: spec.projectName,
            document: {
                id: docId,
                name: spec.fileName ?? 'main.tex',
                content: spec.content,
                version: spec.version ?? 1,
                applications: [],
            },
            additionalDocuments: [],
        });
    }

    createClient(projectId: string, windowId: string) {
        assert.ok(this.projects.has(projectId), `Unknown deterministic project ${projectId}`);
        this.clientCreationCount += 1;
        const socket = new DeterministicSocket(this, projectId, windowId);
        this.sockets.add(socket);
        return {api: new FakeProjectAPI(this, projectId), socket};
    }

    allocatePublicId(windowId: string): string {
        this.publicIdSequence += 1;
        return `${windowId}.P${this.publicIdSequence}`;
    }

    removeSocket(socket: DeterministicSocket): void {
        this.sockets.delete(socket);
    }

    projectSnapshot(projectId: string) {
        const project = this.projects.get(projectId);
        assert.ok(project, `Unknown deterministic project ${projectId}`);
        const doc = project.document;
        return {
            _id: project.id,
            name: project.name,
            rootDoc_id: doc.id,
            rootFolder: [{
                _id: `${project.id}-root`,
                name: 'root',
                docs: [doc, ...project.additionalDocuments].map(candidate => ({
                    _id: candidate.id,
                    name: candidate.name,
                    _type: 'doc',
                })),
                fileRefs: [],
                folders: [],
            }],
            publicAccessLevel: 'private',
            compiler: 'pdflatex',
            spellCheckLanguage: 'en',
            deletedDocs: [],
            members: [],
            invites: [],
            owner: {},
            features: {},
            settings: {},
        };
    }

    document(projectId: string, docId?: string): StoredDocument {
        const project = this.projects.get(projectId);
        assert.ok(project, `Unknown deterministic project ${projectId}`);
        const document = !docId ? project.document :
            [project.document, ...project.additionalDocuments].find(candidate => candidate.id === docId);
        assert.ok(document, `Unknown deterministic document ${docId}`);
        return document;
    }

    documentByName(projectId: string, name: string): StoredDocument | undefined {
        const project = this.projects.get(projectId);
        assert.ok(project, `Unknown deterministic project ${projectId}`);
        return [project.document, ...project.additionalDocuments].find(
            document => document.name === name,
        );
    }

    projectEntities(projectId: string): Array<{path: string, type: 'doc'}> {
        const project = this.projects.get(projectId);
        assert.ok(project, `Unknown deterministic project ${projectId}`);
        return [project.document, ...project.additionalDocuments].map(document => ({
            path: `/${document.name}`,
            type: 'doc' as const,
        }));
    }

    createDocument(
        projectId: string,
        parentFolderId: string,
        filename: string,
        content: string,
    ) {
        const project = this.projects.get(projectId);
        assert.ok(project, `Unknown deterministic project ${projectId}`);
        if (parentFolderId !== `${projectId}-root`) {
            return {type: 'error' as const, message: 'Unknown parent folder'};
        }
        if (this.documentByName(projectId, filename)) {
            return {type: 'error' as const, message: 'Document already exists'};
        }
        this.documentCreationCount += 1;
        const document: StoredDocument = {
            id: `${projectId}-created-${this.documentCreationCount}`,
            name: filename,
            content,
            version: 0,
            applications: [],
        };
        project.additionalDocuments.push(document);
        return {
            type: 'success' as const,
            entity: {_id: document.id, name: filename, _type: 'doc' as const},
        };
    }

    text(projectId: string): string {
        return this.document(projectId).content;
    }

    version(projectId: string): number {
        return this.document(projectId).version;
    }

    loseNextAckBeforeCommit(): void {
        this.nextUpdateFault = 'before-apply';
    }

    loseNextAckAfterCommit(): void {
        this.nextUpdateFault = 'after-apply';
    }

    holdNextApplicationAfterAck(): void {
        assert.equal(this.holdNextQueuedApplication, false, 'An application hold is already armed');
        assert.equal(this.heldApplication, undefined, 'A queued application is already held');
        this.holdNextQueuedApplication = true;
    }

    releaseHeldApplication(): void {
        assert.ok(this.heldApplication, 'No queued application is waiting for release');
        const apply = this.heldApplication;
        this.heldApplication = undefined;
        apply();
    }

    releaseHeldApplicationWithTransform(): void {
        this.transformHeldApplication = true;
        this.releaseHeldApplication();
    }

    collaboratorUpdate(projectId: string, operations: TextOperation[], docId?: string): void {
        const document = this.document(projectId, docId);
        const version = document.version;
        document.content = applyTextOperations(document.content, operations);
        document.version += 1;
        for (const socket of this.sockets) {
            if (
                socket.projectId === projectId &&
                socket.isConnected &&
                socket.joinedDocuments.has(document.id)
            ) {
                socket.handlers.onFileChanged?.({
                    doc: document.id,
                    v: version,
                    op: clone(operations),
                }, {publicId: socket.publicId, generation: socket.generation});
            }
        }
    }

    async receiveUpdate(
        sender: DeterministicSocket,
        docId: string,
        update: CapturedUpdate['update'],
    ): Promise<void> {
        const captured = clone(update);
        this.capturedUpdates.push({
            projectId: sender.projectId,
            docId,
            publicId: sender.publicId,
            update: captured,
        });

        const updateFault = this.nextUpdateFault;
        this.nextUpdateFault = undefined;
        if (updateFault === 'before-apply') {
            sender.dropAcknowledgementConnection();
            throw new SocketRequestError(
                'disconnected',
                'The queue acknowledgement was lost before the update was applied',
                true,
            );
        }

        if (updateFault === 'after-apply') {
            this.applyQueuedUpdate(sender, docId, captured, true);
            // Let the request report its outcome-unknown transport error before
            // the VFS version waiter sees any secondary disconnect signal.
            sender.dropAcknowledgementConnection();
            throw new SocketRequestError(
                'disconnected',
                'The update committed but its acknowledgement was lost',
                true,
            );
        }

        // Overleaf's applyOtUpdate callback acknowledges queueing. The later
        // otUpdateApplied event is the sender's authoritative commit boundary.
        // Keep those phases independently observable in every normal fixture run.
        this.queueAcknowledgementCount += 1;
        const document = this.document(sender.projectId, docId);
        const queuedBaseContent = document.content;
        const queuedDesiredContent = applyTextOperations(document.content, captured.op);
        const apply = () => this.applyQueuedUpdate(
            sender,
            docId,
            captured,
            false,
            {baseContent: queuedBaseContent, desiredContent: queuedDesiredContent},
        );
        if (this.holdNextQueuedApplication) {
            this.holdNextQueuedApplication = false;
            this.heldApplication = apply;
        } else {
            setImmediate(apply);
        }
    }

    private applyQueuedUpdate(
        sender: DeterministicSocket,
        docId: string,
        update: CapturedUpdate['update'],
        omitSenderConfirmation: boolean,
        queued?: {baseContent: string, desiredContent: string},
    ): void {
        const document = this.document(sender.projectId, docId);
        let effectiveUpdate = update;
        if (update.v !== document.version) {
            const duplicate = document.applications.find(application =>
                application.version >= update.v &&
                update.dupIfSource?.includes(application.publicId)
            );
            if (duplicate) {
                if (!omitSenderConfirmation) {
                    this.senderConfirmationCount += 1;
                    sender.handlers.onFileChanged?.(
                        {doc: docId, v: Math.max(update.v, document.version - 1)},
                        {publicId: sender.publicId, generation: sender.generation},
                    );
                }
                return;
            }
            if (!queued || !this.transformHeldApplication) {
                throw new SocketRequestError(
                    'server_error',
                    `Version mismatch: received ${update.v}, current ${document.version}`,
                    false,
                );
            }
            this.transformHeldApplication = false;
            const transformed = prepareDocumentUpdate(
                queued.baseContent,
                document.content,
                queued.desiredContent,
            );
            if (!transformed.mergeApplied || transformed.operations.length === 0) {
                throw new SocketRequestError(
                    'server_error',
                    'Queued update could not be transformed deterministically',
                    false,
                );
            }
            effectiveUpdate = {
                ...update,
                v: document.version,
                op: transformed.operations,
            };
        }

        const version = document.version;
        document.content = applyTextOperations(document.content, effectiveUpdate.op);
        document.version += 1;
        document.applications.push({version, publicId: sender.publicId});
        this.logicalApplyCount += 1;

        for (const socket of this.sockets) {
            if (
                socket.projectId !== sender.projectId ||
                !socket.isConnected ||
                !socket.joinedDocuments.has(docId)
            ) { continue; }
            if (socket === sender && omitSenderConfirmation) {
                continue;
            }
            if (socket === sender) {
                this.senderConfirmationCount += 1;
            } else {
                this.collaboratorBroadcastCount += 1;
            }
            socket.handlers.onFileChanged?.(
                socket === sender ?
                    {doc: docId, v: version} :
                    {doc: docId, v: version, op: clone(effectiveUpdate.op ?? [])},
                {publicId: socket.publicId, generation: socket.generation},
            );
        }
    }
}

export type VirtualProjectHarness = {
    vfs: any,
    uri: UriStub,
    socket: DeterministicSocket,
    notifications: unknown[][],
};

export function createVirtualProject(options: {
    server: DeterministicRealtimeServer,
    storage: HarnessStorage,
    windowId: string,
    projectId: string,
}): VirtualProjectHarness {
    const project = options.server.projectSnapshot(options.projectId);
    const context = options.storage.context(options.server, options.windowId);
    const uri = new UriStub(
        'overleaf-workshop',
        'www.overleaf.com',
        `/${project.name}/${project.rootFolder[0].docs[0].name}`,
        `user=test-user&project=${options.projectId}`,
    );
    const notifications: unknown[][] = [];
    const VirtualFileSystem = loadVirtualFileSystem();
    const vfs = new VirtualFileSystem(
        context,
        uri,
        (events: unknown[]) => notifications.push(events),
        options.storage.provenanceStore(options.windowId),
    );
    const socket = (vfs as {socket: DeterministicSocket}).socket;
    return {vfs, uri, socket, notifications};
}

export type AliasProviderHarness = {
    provider: any,
    vfs: any,
    decodedUri: UriStub,
    encodedUri: UriStub,
    reorderedUri: UriStub,
};

export async function createAliasProviderProject(options: {
    server: DeterministicRealtimeServer,
    storage: HarnessStorage,
    windowId: string,
    projectId: string,
}): Promise<AliasProviderHarness> {
    loadVirtualFileSystem();
    const project = options.server.projectSnapshot(options.projectId);
    const context = options.storage.context(options.server, options.windowId);
    const decodedQuery = `user=test-user&project=${options.projectId}`;
    const decodedUri = new UriStub(
        'overleaf-workshop',
        'www.overleaf.com',
        `/${project.name}/${project.rootFolder[0].docs[0].name}`,
        decodedQuery,
    );
    const encodedUri = decodedUri.with({query: encodeURIComponent(decodedQuery)});
    const reorderedUri = decodedUri.with({query: `project=${options.projectId}&user=test-user`});
    const provider = new RemoteFileSystemProviderConstructor(context);
    const [decodedVfs, encodedVfs, reorderedVfs] = await Promise.all([
        provider.prefetch(decodedUri),
        provider.prefetch(encodedUri),
        provider.prefetch(reorderedUri),
    ]);
    assert.strictEqual(encodedVfs, decodedVfs, 'encoded query must reuse the decoded VFS');
    assert.strictEqual(reorderedVfs, decodedVfs, 'reordered query must reuse the decoded VFS');
    return {provider, vfs: decodedVfs, decodedUri, encodedUri, reorderedUri};
}

export type EventWiredProviderHarness = AliasProviderHarness & {
    uri: UriStub,
    socket: DeterministicSocket,
    events: ProductionWorkspaceEventHarness,
    dispose(): void,
};

/**
 * Activate the real RemoteFileSystemProvider trigger registrations against the
 * deterministic vscode stub. Tests using this harness exercise the public
 * provider entrypoints and fire the same workspace lifecycle callbacks that
 * production registers.
 */
export async function createEventWiredProviderProject(options: {
    server: DeterministicRealtimeServer,
    storage: HarnessStorage,
    windowId: string,
    projectId: string,
}): Promise<EventWiredProviderHarness> {
    const aliases = await createAliasProviderProject(options);
    const triggers = aliases.provider.triggers as Array<{dispose(): void}>;
    const socket = (aliases.vfs as {socket: DeterministicSocket}).socket;
    let disposed = false;
    return {
        ...aliases,
        uri: aliases.decodedUri,
        socket,
        events: productionWorkspaceEvents,
        dispose: () => {
            if (disposed) { return; }
            disposed = true;
            triggers.forEach(trigger => trigger.dispose());
        },
    };
}

export class SimulatedDirtyEditor {
    dirty = true;
    closed = false;
    version = 1;
    private currentText: string;
    readonly document: {
        uri: UriStub,
        readonly isDirty: boolean,
        readonly isClosed: boolean,
        readonly version: number,
        getText(): string,
    };

    constructor(readonly uri: UriStub, text: string) {
        const editor = this;
        this.currentText = text;
        this.document = {
            uri,
            get isDirty() { return editor.dirty; },
            get isClosed() { return editor.closed; },
            get version() { return editor.version; },
            getText: () => editor.currentText,
        };
    }

    get text(): string {
        return this.currentText;
    }

    attach(): void {
        if (!workspaceDocuments.includes(this.document)) {
            workspaceDocuments.push(this.document);
        }
    }

    /** Keep the buffer alive while modelling another VS Code window's process. */
    hideFromCurrentWindow(): void {
        const index = workspaceDocuments.indexOf(this.document);
        if (index >= 0) { workspaceDocuments.splice(index, 1); }
    }

    detach(vfs?: any): void {
        const index = workspaceDocuments.indexOf(this.document);
        if (index >= 0) { workspaceDocuments.splice(index, 1); }
        this.closed = true;
        vfs?.forgetTextDocument(this.document);
    }

    /**
     * Model an explicit Reload Remote confirmation on this exact buffer
     * incarnation, followed by the user's dirty edit from that base.
     */
    async confirmStagedBase(vfs: any, baseText: string): Promise<void> {
        const desiredText = this.currentText;
        this.currentText = baseText;
        this.dirty = false;
        this.version += 1;
        vfs.observeTextDocument(this.document);
        assert.equal(
            await vfs.confirmEditorBase(this.document),
            true,
            'the deterministic exact remote reload must establish this buffer base',
        );
        this.currentText = desiredText;
        this.dirty = desiredText !== baseText;
        this.version += 1;
        vfs.observeTextDocument(this.document);
    }

    async reloadAuthoritative(vfs: any, authoritativeText: string): Promise<void> {
        this.currentText = authoritativeText;
        this.dirty = false;
        this.version += 1;
        vfs.observeTextDocument(this.document);
        assert.equal(
            await vfs.confirmEditorBase(this.document),
            true,
            'the exact authoritative reload must establish the refreshed editor base',
        );
    }

    /** Model a clean startup open followed by hot-exit overlay on the same object. */
    observeCleanThenOverlay(vfs: any, cleanText: string, restoredText: string): void {
        this.currentText = cleanText;
        this.dirty = false;
        this.version += 1;
        vfs.observeTextDocument(this.document);
        this.currentText = restoredText;
        this.dirty = true;
        this.version += 1;
        vfs.observeTextDocument(this.document);
    }

    edit(text: string): void {
        this.currentText = text;
        this.dirty = true;
        this.version += 1;
    }

    openClean(events: ProductionWorkspaceEventHarness, text = this.currentText): void {
        this.currentText = text;
        this.dirty = false;
        this.closed = false;
        this.version += 1;
        this.attach();
        events.fireDidOpen(this.document);
    }

    editThroughEvents(text: string, events: ProductionWorkspaceEventHarness): void {
        this.edit(text);
        events.fireDidChange(this.document);
    }

    refreshThroughEvents(text: string, events: ProductionWorkspaceEventHarness): void {
        this.currentText = text;
        this.dirty = false;
        this.version += 1;
        events.fireDidChange(this.document);
    }

    closeThroughEvents(events: ProductionWorkspaceEventHarness): void {
        const index = workspaceDocuments.indexOf(this.document);
        if (index >= 0) { workspaceDocuments.splice(index, 1); }
        this.closed = true;
        events.fireDidClose(this.document);
    }

    async saveThroughProvider(
        provider: any,
        events: ProductionWorkspaceEventHarness,
        options: {create: boolean, overwrite: boolean} = {create: false, overwrite: true},
    ): Promise<{saved: boolean, error?: unknown}> {
        try {
            events.fireWillSave(this.document);
            await provider.writeFile(
                this.uri,
                new TextEncoder().encode(this.currentText),
                options,
            );
            this.dirty = false;
            events.fireDidSave(this.document);
            return {saved: true};
        } catch (error) {
            return {saved: false, error};
        }
    }

    async save(vfs: any): Promise<{saved: boolean, error?: unknown}> {
        try {
            vfs.observeTextDocument(this.document);
            vfs.observeWillSaveTextDocument(this.document);
            await vfs.writeFile(this.uri, new TextEncoder().encode(this.currentText), false, true);
            this.dirty = false;
            vfs.observeTextDocument(this.document);
            return {saved: true};
        } catch (error) {
            return {saved: false, error};
        }
    }
}

export class SimulatedEditorHost {
    manualSaveCalls = 0;
    autoSaveCalls = 0;
    saveAllCalls = 0;

    manualSave(editor: SimulatedDirtyEditor, vfs: any) {
        this.manualSaveCalls += 1;
        return editor.save(vfs);
    }

    autoSave(editor: SimulatedDirtyEditor, vfs: any) {
        this.autoSaveCalls += 1;
        return editor.save(vfs);
    }

    async saveAll(
        editors: Array<{editor: SimulatedDirtyEditor, vfs: any}>,
    ): Promise<boolean> {
        this.saveAllCalls += 1;
        const results = await Promise.all(editors.map(({editor, vfs}) => editor.save(vfs)));
        return results.every(result => result.saved);
    }

    manualSaveThroughProvider(
        editor: SimulatedDirtyEditor,
        provider: any,
        events: ProductionWorkspaceEventHarness,
    ) {
        this.manualSaveCalls += 1;
        return editor.saveThroughProvider(provider, events);
    }

    autoSaveThroughProvider(
        editor: SimulatedDirtyEditor,
        provider: any,
        events: ProductionWorkspaceEventHarness,
    ) {
        this.autoSaveCalls += 1;
        return editor.saveThroughProvider(provider, events);
    }

    async saveAllThroughProvider(
        editors: Array<{
            editor: SimulatedDirtyEditor,
            provider: any,
            events: ProductionWorkspaceEventHarness,
        }>,
    ): Promise<boolean> {
        this.saveAllCalls += 1;
        const results = await Promise.all(editors.map(({editor, provider, events}) =>
            editor.saveThroughProvider(provider, events),
        ));
        return results.every(result => result.saved);
    }
}

export function resetHarnessDocuments(): void {
    workspaceDocuments.splice(0, workspaceDocuments.length);
    workspaceFileBytes.clear();
    productionWorkspaceEvents.reset();
}

export function resetHarnessRuntime(): void {
    resetHarnessDocuments();
    if (loadedGlobalStateManager) {
        loadedGlobalStateManager.initSocketIOAPI = originalInitSocketIOAPI;
        loadedGlobalStateManager.authenticate = originalAuthenticate;
    }
    if (originalCacheKeys) {
        for (const cacheKey of Object.keys(require.cache)) {
            if (!originalCacheKeys.has(cacheKey)) {
                delete require.cache[cacheKey];
            }
        }
    }
    if (loadedRemotePath) {
        if (previousRemoteModule) {
            require.cache[loadedRemotePath] = previousRemoteModule;
        } else {
            delete require.cache[loadedRemotePath];
        }
    }
    if (loadedStatePath) {
        if (previousStateModule) {
            require.cache[loadedStatePath] = previousStateModule;
        } else {
            delete require.cache[loadedStatePath];
        }
    }
    VirtualFileSystemConstructor = undefined;
    RemoteFileSystemProviderConstructor = undefined;
    loadedRemotePath = undefined;
    loadedStatePath = undefined;
    previousRemoteModule = undefined;
    previousStateModule = undefined;
    loadedGlobalStateManager = undefined;
    originalInitSocketIOAPI = undefined;
    originalAuthenticate = undefined;
    originalCacheKeys = undefined;
}

export async function openAuthoritativeText(
    harness: VirtualProjectHarness,
    _acceptAsEditorBase = true,
): Promise<string> {
    const bytes = await harness.vfs.openFile(harness.uri);
    return new TextDecoder().decode(bytes);
}

export async function settleAsyncWork(): Promise<void> {
    await Promise.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
}
