/* eslint-disable @typescript-eslint/naming-convention */
import {strict as assert} from 'assert';
import {SocketRequestError} from '../../api/socketRequest';

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
    }) => void,
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
    getText(): string,
}> = [];

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
        getConfiguration: () => ({
            get: (_key: string, fallback: unknown) => fallback,
        }),
        fs: {
            readFile: async () => new Uint8Array(),
            writeFile: async () => {},
        },
    },
    window: {
        visibleTextEditors: [],
        activeTextEditor: undefined,
        withProgress: async (_options: unknown, task: () => Promise<unknown>) => task(),
        showErrorMessage: async () => undefined,
        showInformationMessage: async () => undefined,
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

export class HarnessStorage {
    readonly globalState = new MemoryMemento();
    private readonly workspaceStates = new Map<string, MemoryMemento>();

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
            return context.__realtimeServer.createClient(projectId, context.__windowId);
        }) as unknown as typeof GlobalStateManager.initSocketIOAPI;
        GlobalStateManager.authenticate = (async () => ({
            csrfToken: 'csrf',
            cookies: 'session=test',
        })) as typeof GlobalStateManager.authenticate;
        VirtualFileSystemConstructor = remoteModule.VirtualFileSystem;
    } finally {
        moduleLoader._load = originalLoad;
    }

    return VirtualFileSystemConstructor;
}

class FakeProjectAPI {
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
    private readonly projects = new Map<string, StoredProject>();
    private readonly sockets = new Set<DeterministicSocket>();
    private publicIdSequence = 0;
    private nextUpdateFault: 'before-apply' | 'after-apply' | undefined;
    private holdNextQueuedApplication = false;
    private heldApplication: (() => void) | undefined;

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
        });
    }

    createClient(projectId: string, windowId: string) {
        assert.ok(this.projects.has(projectId), `Unknown deterministic project ${projectId}`);
        const socket = new DeterministicSocket(this, projectId, windowId);
        this.sockets.add(socket);
        return {api: new FakeProjectAPI(), socket};
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
                docs: [{_id: doc.id, name: doc.name, _type: 'doc'}],
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
        assert.ok(!docId || project.document.id === docId, `Unknown deterministic document ${docId}`);
        return project.document;
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

    collaboratorUpdate(projectId: string, operations: TextOperation[]): void {
        const document = this.document(projectId);
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
                });
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
        const apply = () => this.applyQueuedUpdate(sender, docId, captured, false);
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
    ): void {
        const document = this.document(sender.projectId, docId);
        if (update.v !== document.version) {
            const duplicate = document.applications.find(application =>
                application.version >= update.v &&
                update.dupIfSource?.includes(application.publicId)
            );
            if (!duplicate) {
                throw new SocketRequestError(
                    'server_error',
                    `Version mismatch: received ${update.v}, current ${document.version}`,
                    false,
                );
            }
            if (!omitSenderConfirmation) {
                this.senderConfirmationCount += 1;
                sender.handlers.onFileChanged?.({doc: docId, v: update.v});
            }
            return;
        }

        const version = document.version;
        document.content = applyTextOperations(document.content, update.op);
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
                    {doc: docId, v: version, op: clone(update.op ?? [])},
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
    );
    const socket = (vfs as {socket: DeterministicSocket}).socket;
    return {vfs, uri, socket, notifications};
}

export class SimulatedDirtyEditor {
    dirty = true;
    readonly document: {
        uri: UriStub,
        readonly isDirty: boolean,
        getText(): string,
    };

    constructor(readonly uri: UriStub, readonly text: string) {
        const editor = this;
        this.document = {
            uri,
            get isDirty() { return editor.dirty; },
            getText: () => editor.text,
        };
    }

    attach(): void {
        workspaceDocuments.push(this.document);
    }

    async save(vfs: any): Promise<{saved: boolean, error?: unknown}> {
        try {
            await vfs.writeFile(this.uri, new TextEncoder().encode(this.text), false, true);
            this.dirty = false;
            return {saved: true};
        } catch (error) {
            return {saved: false, error};
        }
    }
}

export function resetHarnessDocuments(): void {
    workspaceDocuments.splice(0, workspaceDocuments.length);
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
    loadedRemotePath = undefined;
    loadedStatePath = undefined;
    previousRemoteModule = undefined;
    previousStateModule = undefined;
    loadedGlobalStateManager = undefined;
    originalInitSocketIOAPI = undefined;
    originalAuthenticate = undefined;
    originalCacheKeys = undefined;
}

export async function openAuthoritativeText(harness: VirtualProjectHarness): Promise<string> {
    const bytes = await harness.vfs.openFile(harness.uri);
    return new TextDecoder().decode(bytes);
}

export async function settleAsyncWork(): Promise<void> {
    await Promise.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
}
