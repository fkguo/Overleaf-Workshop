/* eslint-disable @typescript-eslint/naming-convention */
import * as vscode from 'vscode';
import { BaseAPI, CompileOutputFileSchema, Identity, MemberEntity, ProjectSettingsSchema } from '../api/base';
import {
    OtUpdateErrorSchema,
    PermissionsLevel,
    ProjectSessionSchema,
    ProjectSenderWitness,
    RealtimeFatalError,
    SocketIOAPI,
    UpdateSchema,
} from '../api/socketio';
import { OUTPUT_FOLDER_NAME, ROOT_NAME } from '../consts';
import { GlobalStateManager } from '../utils/globalStateManager';
import { ClientManager } from '../collaboration/clientManager';
import { EventBus } from '../utils/eventBus';
import { SCMCollectionProvider } from '../scm/scmCollectionProvider';
import { ExtendedBaseAPI, ProjectLinkedFileProvider, UrlLinkedFileProvider } from '../api/extendedBase';
import { assertCurrentConnection, SocketRequestError, withTimeout } from '../api/socketRequest';
import {
    applyTextOperations,
    buildRecoveryUpdate,
    CausalDocumentEvidence,
    isSenderConfirmation,
    prepareProvenDocumentUpdate,
    TextOperation,
} from './documentUpdate';
import {
    beginLocalEditorSubmission,
    commitRemoteEditorTransaction,
    confirmLocalEditorSubmission,
    createRealtimeEditorBridgeState,
    prepareRemoteEditorTransaction,
    recordLocalEditorChange,
    rejectLocalEditorSubmission,
    RealtimeEditorBridgeState,
    RemoteEditorTransaction,
} from './realtimeEditorBridge';
import { randomUUID } from 'crypto';
import { resolveSynctexOutputIdentity } from '../compile/synctex';
import {
    CompileOutcome,
    CompileOutputRouting,
    CompileRequestKind,
    hasUsableCachedPdfIdentity,
    isCachedCompileCompatible,
    mergeCompileOutputs,
    normalizeCompileStatus,
    resolveCompileOutputRouting,
} from '../compile/compileResult';
import { parseProjectUri, projectConnectionKey } from './projectUri';
import {
    DocumentProvenanceIdentity,
    DocumentProvenanceRecord,
    DocumentProvenanceStore,
    JsonValue,
} from './documentProvenance';
import { WorkspaceProvenanceStorage } from './workspaceProvenanceStorage';

const __OUTPUTS_ID = `${ROOT_NAME}-outputs`;
const SUPPORTED_WRITE_PROTOCOL_VERSION = 2;

export type FileType = 'doc' | 'file' | 'folder' | 'outputs';
export type FolderKey = 'docs' | 'fileRefs' | 'folders' | 'outputs';
const FolderKeys: {[_type:string]: FolderKey} = {
    'folder': 'folders',
    'doc': 'docs',
    'file': 'fileRefs',
    'outputs': 'outputs',
};

export interface FileEntity {
    _id: string,
    name: string,
    _type?: FileType,
    readonly?: boolean,
}

export interface DocumentEntity extends FileEntity {
    version?: number,
    mtime?: number,
    lastVersion?: number,
    localCache?: string,
    remoteCache?: string,
}

export interface FileRefEntity extends FileEntity {
    linkedFileData: ProjectLinkedFileProvider | UrlLinkedFileProvider | null,
    created: string, //ISO date string
}

export interface OutputFileEntity extends FileEntity, CompileOutputFileSchema {
    /** Download routing is build-specific; failed and successful outputs may live on different CLSI nodes. */
    compileRouting?: CompileOutputRouting,
}

export interface FolderEntity extends FileEntity {
    docs: Array<DocumentEntity>,
    fileRefs: Array<FileRefEntity>,
    folders: Array<FolderEntity>,
    outputs?: Array<OutputFileEntity>,
}

export interface ProjectEntity {
    _id: string,
    name: string,
    rootDoc_id: string,
    rootFolder: Array<FolderEntity>,
    publicAccessLevel: string, //"tokenBased"
    compiler: string,
    spellCheckLanguage: string,
    deletedDocs: Array<{
        _id: string,
        name: string,
        deletedAt: string,
    }>,
    members: Array<MemberEntity>,
    invites: Array<MemberEntity>,
    owner: MemberEntity,
    features: {[key:string]:any},
    settings: ProjectSettingsSchema,
}

type DocumentVersionWaiter = {
    expectedVersion: number,
    resolve: (confirmedVersion: number) => void,
    reject: (error: Error) => void,
    timer: NodeJS.Timeout,
};

type ReceivedDocumentUpdate = {
    update: unknown,
    sender?: ProjectSenderWitness,
};

type PreparedDocumentJoin = {
    anchorVersion: number,
    anchorContent: string,
    headVersion: number,
    headContent: string,
    updates: Map<number, TextOperation[]>,
};

type PendingDocumentUpdate = {
    docId: string,
    bufferId: string,
    provenanceRecordName: string,
    update: UpdateSchema,
    desiredContent: string,
    mergedContent: string,
    baseVersion: number,
    baseContent: string,
    submittedPublicIds: string[],
    socketGeneration: number,
    submissionToken: string,
    confirmationVersion?: number,
};

type StagedEditorBase = {
    docId: string,
    canonicalEditorUri: string,
    version: number,
    content: string,
};

type ProviderReadTicket = StagedEditorBase & {
    token: string,
    resourceKey: string,
    publicId: string,
    socketGeneration: number,
    requiresExplicitConfirmation: boolean,
};

type BoundProviderReadCandidate = {
    ticket: ProviderReadTicket,
    bufferId: string,
    document: vscode.TextDocument,
    documentVersion: number,
};

type EditorDocumentBase = {
    identity: DocumentProvenanceIdentity,
    bufferId: string,
    version: number,
    content: string,
    recordName?: string,
    persistence?: Promise<DocumentProvenanceRecord>,
    causality: RealtimeEditorBridgeState,
};

type PendingRemoteEditorTransaction = {
    document: vscode.TextDocument,
    active: EditorDocumentBase,
    transaction: RemoteEditorTransaction,
    consumed: boolean,
};

type PreparedLiveRemoteEditorUpdate = {
    bufferId: string,
    document: vscode.TextDocument,
    active: EditorDocumentBase,
    transaction: RemoteEditorTransaction,
};

type RemoteDocumentCausality = {
    socketGeneration: number,
    epoch: string,
    anchorVersion: number,
    headVersion: number,
    headContent: string,
    updates: Map<number, TextOperation[]>,
    valid: boolean,
};

type EditorBufferState = {
    bufferId: string,
    document: vscode.TextDocument,
    resourceKey: string,
    canonicalEditorUri: string,
    docId: string,
};

type EditorBufferWitness = EditorBufferState & {
    documentVersion: number,
    content: string,
};

type EditorSaveReceipt = {
    bufferId: string,
    document: vscode.TextDocument,
    identity: DocumentProvenanceIdentity,
    version: number,
    content: string,
};

type UnboundEditorSaveIntent = {
    resourceKey: string,
    documentVersion: number,
    content: string,
};

type ResolvedEditorProvenance = {
    record: DocumentProvenanceRecord,
    recordsToClear: string[],
};

type EditorProvenanceResolution =
    | {kind: 'valid', value: ResolvedEditorProvenance}
    | {kind: 'blocked', reason: string};

export class File implements vscode.FileStat {
    type: vscode.FileType;
    name: string;
    ctime: number;
    mtime: number;
    size: number;
    permissions?: vscode.FilePermission;
    constructor(name: string, type: vscode.FileType, ctime?: number, permissions?:vscode.FilePermission) {
        this.type = type;
        this.name = name;
        this.ctime = ctime || Date.now();
        this.mtime = Date.now();
        this.size = 0;
        this.permissions = permissions;
    }
}

function isPlainObject(value: unknown): value is {[key: string]: unknown} {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonnegativeSafeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function parseUri(uri: vscode.Uri) {
    return parseProjectUri(uri.authority, uri.path, uri.query);
}

export class VirtualFileSystem extends vscode.Disposable {
    private root?: ProjectEntity;
    private joiningProject?: ProjectEntity;
    private currentVersion?: number;
    private context: vscode.ExtensionContext;
    private api: BaseAPI;
    private socket: SocketIOAPI;
    private publicId?: string;
    private userId: string;
    private isDirty: boolean = true;
    private initializing?: Promise<ProjectEntity>;
    private reconnectingNotification: boolean = false;
    private previousRoot?: ProjectEntity;
    private hasCompletedInitialConnection = false;
    private connectionRequested = false;
    private documentWrites = new Map<string, Promise<void>>();
    private documentRemoteUpdateQueues?: Map<string, Promise<void>>;
    private documentJoinTasks = new Map<string, Promise<{doc: DocumentEntity, content: string}>>();
    private joiningDocuments = new Map<string, {
        generation: number,
        updates: ReceivedDocumentUpdate[],
        invalid?: Error,
    }>();
    private documentVersionWaiters = new Map<string, Set<DocumentVersionWaiter>>();
    private pendingDocumentUpdates = new Map<string, PendingDocumentUpdate>();
    private stagedEditorBases = new Map<string, StagedEditorBase>();
    private pendingReadTickets = new Map<string, ProviderReadTicket>();
    private boundReadCandidates = new Map<string, BoundProviderReadCandidate>();
    private activeEditorBases = new Map<string, EditorDocumentBase>();
    private remoteDocumentCausality = new Map<string, RemoteDocumentCausality>();
    private documentIdsByPath = new Map<string, string>();
    private editorBufferIds = new WeakMap<vscode.TextDocument, string>();
    private editorBuffers = new Map<string, EditorBufferState>();
    private editorSaveIntents = new Map<string, EditorBufferWitness>();
    private unboundEditorSaveIntents = new WeakMap<vscode.TextDocument, UnboundEditorSaveIntent>();
    private unboundEditorIncarnations = new WeakSet<vscode.TextDocument>();
    private editorSaveReceipts = new Map<string, EditorSaveReceipt>();
    private pendingRemoteEditorTransactions?: Map<string, PendingRemoteEditorTransaction>;
    private recoveryNotifications = new Set<string>();
    private freshConnectionRequested = false;
    private sourceRevision = 0;
    private permissionsLevel?: PermissionsLevel;
    private protocolVersion?: number;
    private terminalRealtimeError?: RealtimeFatalError;
    private disposed = false;
    private outputBuildId?: string;
    private compileGroup?: string;
    private clsiServerId?: string;
    private readonly editorId = randomUUID();
    private outputEditorId?: string;
    private pdfDownloadDomain?: string;
    private notify: (events:vscode.FileChangeEvent[])=>void;
    private clientManagerItem?: {manager: ClientManager, triggers: vscode.Disposable[]};
    private scmCollectionItem?: {collection: SCMCollectionProvider, triggers: vscode.Disposable[]};

    public readonly origin: vscode.Uri;
    public readonly projectName: string;
    public readonly serverName: string;
    public readonly serverUrl: string;
    public readonly projectId: string;

    constructor(
        context: vscode.ExtensionContext,
        uri: vscode.Uri,
        notify: (events:vscode.FileChangeEvent[])=>void,
        private readonly provenanceStore: DocumentProvenanceStore,
        private readonly wasDocumentOpenBeforeProviderRead: (document: vscode.TextDocument) => boolean,
        onDispose?: () => void,
    ) {
        // define the dispose behavior
        super(() => {
            this.disposed = true;
            // dispose all triggers of clientManager
            this.clientManagerItem?.triggers.forEach((trigger) => trigger.dispose());
            this.clientManagerItem = undefined;
            // dispose all triggers of scmCollection
            this.scmCollectionItem?.triggers.forEach((trigger) => trigger.dispose());
            this.scmCollectionItem = undefined;
            // disconnect socketio
            try {
                this.socket.dispose();
            } catch (error) {
                console.warn('Unable to disconnect disposed Overleaf socket', error);
            } finally {
                onDispose?.();
            }
        });

        const {userId: uriUserId,projectId,serverName,projectName} = parseUri(uri);
        this.serverName = serverName;
        this.projectName = projectName;
        this.origin = uri.with({path: '/'+projectName});
        this.projectId = projectId;
        this.context = context;
        this.notify = notify;

        const res = GlobalStateManager.initSocketIOAPI(this.context, this.serverName, projectId);
        if (res) {
            this.api = res.api;
            this.socket = res.socket;
            this.serverUrl = res.serverUrl;
            this.userId = res.userId;
            if (uriUserId !== res.userId) {
                this.socket.dispose();
                throw new Error(
                    'The restored Overleaf project belongs to a different authenticated account; reopen the project before editing',
                );
            }
        } else {
            throw new Error( vscode.l10n.t('Cannot init SocketIOAPI for {serverName}', {serverName}) );
        }
        // Register one logical handler set for the lifetime of this VFS. SocketIOAPI
        // rebinds this set when a connection scheme requires a new physical socket.
        this.remoteWatch();
    }

    get _userId() {
        return this.userId;
    }

    get isReady() {
        return !this.disposed && this.root !== undefined && this.socket.isConnected;
    }

    async init() : Promise<ProjectEntity> {
        if (this.disposed) {
            throw vscode.FileSystemError.Unavailable('The Overleaf project is closed');
        }
        this.connectionRequested = true;
        if (this.root) {
            return Promise.resolve(this.root);
        }

        return this.startInitialization(false);
    }

    private startInitialization(showProgress: boolean): Promise<ProjectEntity> {
        if (this.disposed) {
            return Promise.reject(vscode.FileSystemError.Unavailable('The Overleaf project is closed'));
        }
        if (this.root) {
            return Promise.resolve(this.root);
        }
        if (this.initializing) {
            if (showProgress) { this.showReconnectProgress(this.initializing); }
            return this.initializing;
        }

        // Schedule the body after publishing the single-flight promise. Some
        // alternative transports emit disconnect synchronously during init.
        const operation = Promise.resolve().then(() => this.connectWithRetry());
        let tracked!: Promise<ProjectEntity>;
        tracked = operation.finally(() => {
            if (this.initializing === tracked) {
                this.initializing = undefined;
            }
        });
        this.initializing = tracked;
        if (showProgress) { this.showReconnectProgress(tracked); }
        return tracked;
    }

    private showReconnectProgress(operation: Promise<ProjectEntity>) {
        if (this.reconnectingNotification) { return; }
        this.reconnectingNotification = true;
        void vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t('Reconnecting to {serverName}...', {serverName:this.serverName}),
            cancellable: false,
        }, async () => {
            try {
                await operation;
            } catch {
                // The connection failure dialog is emitted by connectWithRetry.
            } finally {
                this.reconnectingNotification = false;
            }
        });
    }

    private async connectWithRetry(): Promise<ProjectEntity> {
        const MAX_RETRIES = 5;
        const BASE_DELAY_MS = 1000; // 1 second base delay
        let lastError: unknown;

        for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
            if (this.disposed) {
                throw vscode.FileSystemError.Unavailable('The Overleaf project is closed');
            }
            if (this.socket.fatalError) {
                throw this.socket.fatalError;
            }
            const delayMs = attempt > 0 ? Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), 16000) : 0;
            if (delayMs > 0) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
            if (this.disposed) {
                throw vscode.FileSystemError.Unavailable('The Overleaf project is closed');
            }

            if (this.socket.needsReinit) {
                this.socket.init();
            }

            try {
                const connectionGeneration = await this.socket.waitUntilConnected();
                const project = await this.socket.joinProject(this.projectId);
                if (project._id !== this.projectId) {
                    throw new RealtimeFatalError(
                        'project_unavailable',
                        `Realtime joined project ${project._id || '<missing>'} instead of ${this.projectId}`,
                        {expectedProjectId: this.projectId, actualProjectId: project._id},
                    );
                }
                assertCurrentConnection(
                    connectionGeneration,
                    this.socket.generation,
                    this.socket.isConnected,
                );
                // Realtime events may arrive after joinProject but before the
                // settings request completes. Apply them to this candidate tree;
                // it is not exposed as ready until the generation is rechecked.
                this.joiningProject = project;
                const settingsResponse = await withTimeout(
                    GlobalStateManager.authenticate(this.context, this.serverName).then(
                        identity => this.api.getProjectSettings(identity, this.projectId),
                    ),
                    'project settings',
                    15000,
                );
                if (settingsResponse.type !== 'success' || !settingsResponse.settings) {
                    throw new SocketRequestError(
                        'server_error',
                        `Unable to load project settings: ${settingsResponse.message || 'missing settings'}`,
                        false,
                    );
                }
                project.settings = settingsResponse.settings;
                assertCurrentConnection(
                    connectionGeneration,
                    this.socket.generation,
                    this.socket.isConnected,
                );
                if (this.disposed) {
                    throw vscode.FileSystemError.Unavailable('The Overleaf project is closed');
                }
                this.restoreDocumentRuntime(this.previousRoot, project);
                this.root = project;
                this.joiningProject = undefined;
                this.previousRoot = project;
                const activeCondition = (vscode.workspace.workspaceFolders===undefined) || (vscode.workspace.workspaceFolders?.[0].uri.scheme!==ROOT_NAME) || (vscode.workspace.workspaceFolders?.[0].uri===this.origin);
                if (activeCondition && !this.clientManagerItem) {
                    const clientManager = new ClientManager(this, this.context, this.publicId||'', this.socket);
                    this.clientManagerItem = {
                        manager: clientManager,
                        triggers: clientManager.triggers,
                    };
                }
                if (activeCondition && !this.scmCollectionItem) {
                    const scmCollection = new SCMCollectionProvider(this, this.context);
                    this.scmCollectionItem = {
                        collection: scmCollection,
                        triggers: scmCollection.triggers,
                    };
                }
                if (!this.hasCompletedInitialConnection) {
                    this.hasCompletedInitialConnection = true;
                    vscode.commands.executeCommand(
                        `${ROOT_NAME}.compileManager.compile`,
                        'initial-project',
                        this.origin,
                    );
                }
                return project;
            } catch (error) {
                if (this.disposed) {
                    throw error;
                }
                const fatalError = error instanceof RealtimeFatalError ? error : this.socket.fatalError;
                if (fatalError) {
                    throw fatalError;
                }
                lastError = error;
                this.root = undefined;
                this.joiningProject = undefined;
                // A failed/disconnected legacy transport is not reused. The
                // socket state machine normally retires it immediately; this
                // timeout guard also retires a transport which never emitted a
                // terminal event.
                if (
                    error instanceof SocketRequestError &&
                    error.code === 'timeout' &&
                    !this.socket.isConnected
                ) {
                    this.socket.invalidateCurrentTransport();
                }
            }
        }

        console.error('Overleaf project connection failed', lastError);
        void vscode.window.showErrorMessage(
            vscode.l10n.t('Connection lost: {serverName}', {serverName:this.serverName}),
            vscode.l10n.t('Reload'),
            vscode.l10n.t('Retry'),
        ).then((choice) => {
            if (choice === vscode.l10n.t('Reload')) {
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            } else if (choice === vscode.l10n.t('Retry')) {
                this.socket.init();
                void this.startInitialization(true).catch(() => {});
            }
        });
        throw new Error(vscode.l10n.t('Connection lost'));
    }

    private documentMap(project?: ProjectEntity): Map<string, DocumentEntity> {
        const result = new Map<string, DocumentEntity>();
        const visit = (folder: FolderEntity) => {
            folder.docs.forEach(doc => result.set(doc._id, doc));
            folder.folders.forEach(visit);
        };
        project?.rootFolder.forEach(visit);
        return result;
    }

    private resourceKey(uri: vscode.Uri): string {
        return uri.toString();
    }

    private remoteUpdateQueueMap(): Map<string, Promise<void>> {
        return this.documentRemoteUpdateQueues ??= new Map();
    }

    private remoteEditorTransactionMap(): Map<string, PendingRemoteEditorTransaction> {
        return this.pendingRemoteEditorTransactions ??= new Map();
    }

    private canonicalEditorUri(docId: string): string {
        return JSON.stringify([
            ROOT_NAME,
            this.serverUrl,
            this.userId,
            this.projectId,
            docId,
        ]);
    }

    private currentSenderWitness(): {publicId: string, generation: number} | undefined {
        const session = this.socket.projectSession;
        if (this.protocolVersion !== SUPPORTED_WRITE_PROTOCOL_VERSION
            || !this.publicId
            || !session
            || session.publicId !== this.publicId
            || session.protocolVersion !== SUPPORTED_WRITE_PROTOCOL_VERSION
            || session.generation !== this.socket.generation
            || !this.socket.isConnected) {
            return undefined;
        }
        return {publicId: session.publicId, generation: session.generation};
    }

    private startRemoteCausality(
        docId: string,
        version: number,
        content: string,
        socketGeneration: number,
    ): RemoteDocumentCausality {
        if (!isNonnegativeSafeInteger(version)) {
            throw new Error('Document causal ledger has an invalid anchor revision');
        }
        const ledger: RemoteDocumentCausality = {
            socketGeneration,
            epoch: randomUUID(),
            anchorVersion: version,
            headVersion: version,
            headContent: content,
            updates: new Map(),
            valid: true,
        };
        this.remoteDocumentCausality.set(docId, ledger);
        return ledger;
    }

    private startPreparedRemoteCausality(
        docId: string,
        prepared: PreparedDocumentJoin,
        socketGeneration: number,
    ): RemoteDocumentCausality {
        if (!isNonnegativeSafeInteger(prepared.headVersion)
            || [...prepared.updates.keys()].some(version => !isNonnegativeSafeInteger(version))) {
            throw new Error('Document causal ledger contains an invalid revision');
        }
        const ledger = this.startRemoteCausality(
            docId,
            prepared.anchorVersion,
            prepared.anchorContent,
            socketGeneration,
        );
        ledger.headVersion = prepared.headVersion;
        ledger.headContent = prepared.headContent;
        ledger.updates = new Map([...prepared.updates].map(([version, operations]) => [
            version,
            operations.map(operation => ({...operation})),
        ]));
        return ledger;
    }

    private invalidateRemoteCausality(docId: string) {
        const ledger = this.remoteDocumentCausality.get(docId);
        if (ledger) { ledger.valid = false; }
    }

    private createLocalEditorCausality(
        document: vscode.TextDocument,
        docId: string,
        version: number,
        content: string,
    ): RealtimeEditorBridgeState {
        const sender = this.currentSenderWitness();
        const remote = this.remoteDocumentCausality.get(docId);
        const valid = Boolean(
            sender
            && isNonnegativeSafeInteger(version)
            && remote
            && remote.valid
            && isNonnegativeSafeInteger(remote.anchorVersion)
            && isNonnegativeSafeInteger(remote.headVersion)
            && remote.socketGeneration === sender.generation
            && remote.headVersion === version
            && remote.headContent === content
            && document.getText() === content
        );
        const input = {
            socketGeneration: sender?.generation ?? -1,
            remoteEpoch: remote?.epoch ?? '',
            remoteVersion: version,
            remoteContent: content,
            documentVersion: document.version,
            editorContent: document.getText(),
        };
        if (valid) {
            return createRealtimeEditorBridgeState(input);
        }
        return {...input, pendingOperations: [], localOperations: [], valid: false};
    }

    private causalEvidenceForWrite(
        docId: string,
        base: {version: number, content: string},
        remoteVersion: number,
        desiredContent: string,
        witness: EditorBufferWitness,
    ): CausalDocumentEvidence | undefined {
        const sender = this.currentSenderWitness();
        const active = this.activeEditorBases.get(witness.bufferId);
        const local = active?.causality;
        const remote = this.remoteDocumentCausality.get(docId);
        if (!sender
            || !isNonnegativeSafeInteger(base.version)
            || !isNonnegativeSafeInteger(remoteVersion)
            || !active
            || active.identity.docId !== docId
            || active.version !== base.version
            || active.content !== base.content
            || !local
            || !local.valid
            || local.socketGeneration !== sender.generation
            || local.documentVersion !== witness.documentVersion
            || local.editorContent !== desiredContent
            || local.remoteVersion !== base.version
            || local.remoteContent !== base.content
            || !remote
            || !remote.valid
            || !isNonnegativeSafeInteger(remote.anchorVersion)
            || !isNonnegativeSafeInteger(remote.headVersion)
            || remote.socketGeneration !== sender.generation
            || remote.epoch !== local.remoteEpoch
            || remote.anchorVersion > base.version
            || remote.headVersion !== remoteVersion
            || remote.headContent !== this.currentDocument(docId).remoteCache) {
            return undefined;
        }
        const remoteUpdates = [];
        for (let version = base.version; version < remoteVersion; version += 1) {
            const operations = remote.updates.get(version);
            if (!operations) { return undefined; }
            remoteUpdates.push({
                version,
                operations: operations.map(operation => ({...operation})),
            });
        }
        return {
            localOperations: local.localOperations.map(operation => ({...operation})),
            remoteUpdates,
        };
    }

    private documentProvenanceIdentity(
        docId: string,
        buffer: Pick<EditorBufferState, 'bufferId' | 'canonicalEditorUri'>,
    ): DocumentProvenanceIdentity | undefined {
        if (!this.currentSenderWitness()) { return undefined; }
        return {
            canonicalServerUrl: this.serverUrl,
            userId: this.userId,
            projectId: this.projectId,
            docId,
            canonicalEditorUri: buffer.canonicalEditorUri,
            otType: 'sharejs-text-ot',
            protocolVersion: SUPPORTED_WRITE_PROTOCOL_VERSION,
        };
    }

    private sameDocumentProvenanceIdentity(
        left: DocumentProvenanceIdentity,
        right: DocumentProvenanceIdentity,
    ): boolean {
        return left.canonicalServerUrl === right.canonicalServerUrl
            && left.userId === right.userId
            && left.projectId === right.projectId
            && left.docId === right.docId
            && left.canonicalEditorUri === right.canonicalEditorUri
            && left.otType === right.otType
            && left.protocolVersion === right.protocolVersion;
    }

    private stageEditorBase(uri: vscode.Uri, doc: DocumentEntity, content: string) {
        const resourceKey = this.resourceKey(uri);
        if (!isNonnegativeSafeInteger(doc.version)
            || typeof doc._id !== 'string'
            || doc._id.length === 0) {
            this.stagedEditorBases.delete(resourceKey);
            this.documentIdsByPath.delete(resourceKey);
            return;
        }
        this.documentIdsByPath.set(resourceKey, doc._id);
        this.stagedEditorBases.set(resourceKey, {
            docId: doc._id,
            canonicalEditorUri: this.canonicalEditorUri(doc._id),
            version: doc.version,
            content,
        });
    }

    private stageProviderRead(uri: vscode.Uri, doc: DocumentEntity, content: string) {
        this.stageEditorBase(uri, doc, content);
        const resourceKey = this.resourceKey(uri);
        const sender = this.currentSenderWitness();
        if (!isNonnegativeSafeInteger(doc.version) || !sender) {
            this.pendingReadTickets.delete(resourceKey);
            return;
        }
        const alreadyObservedDocuments = vscode.workspace.textDocuments.filter(document =>
            !document.isClosed
            && this.resourceKey(document.uri) === resourceKey
            && this.wasDocumentOpenBeforeProviderRead(document)
        );
        this.pendingReadTickets.set(resourceKey, {
            token: randomUUID(),
            resourceKey,
            docId: doc._id,
            canonicalEditorUri: this.canonicalEditorUri(doc._id),
            version: doc.version,
            content,
            publicId: sender.publicId,
            socketGeneration: sender.generation,
            requiresExplicitConfirmation: alreadyObservedDocuments.length > 0,
        });
        // A restored editor can be published to workspace.textDocuments before
        // the file-system read which activates/constructs this VFS. In that
        // ordering its onDidOpen notification cannot consume the read ticket.
        // Revisit only the exact already-open URI now that the authoritative
        // read exists. Dirty hot-exit buffers are still rejected by
        // observeOpenedTextDocument and never become active editor bases.
        vscode.workspace.textDocuments.forEach(document => {
            if (!document.isClosed && this.resourceKey(document.uri) === resourceKey) {
                this.observeOpenedTextDocument(document);
            }
        });
    }

    private cachedDocumentIdForUri(uri: vscode.Uri): string | undefined {
        if (uri.scheme !== ROOT_NAME || !this.root) { return undefined; }
        let parsed;
        try {
            parsed = parseUri(uri);
        } catch {
            return undefined;
        }
        if (parsed.serverName !== this.serverName
            || parsed.userId !== this.userId
            || parsed.projectId !== this.projectId) {
            return undefined;
        }
        let folder = this.root.rootFolder[0];
        if (!folder) { return undefined; }
        for (const folderName of parsed.pathParts.slice(0, -1)) {
            const child = folder.folders.find(candidate => candidate.name === folderName);
            if (!child) { return undefined; }
            folder = child;
        }
        const fileName = parsed.pathParts.at(-1);
        return folder.docs.find(candidate => candidate.name === fileName)?._id;
    }

    private observeEditorBuffer(document: vscode.TextDocument): EditorBufferState | undefined {
        const resourceKey = this.resourceKey(document.uri);
        const staged = this.stagedEditorBases.get(resourceKey);
        const existingBufferId = this.editorBufferIds.get(document);
        const existingBuffer = existingBufferId ? this.editorBuffers.get(existingBufferId) : undefined;
        if (this.unboundEditorIncarnations.has(document)
            || (document.isDirty
                && (!existingBuffer
                    || existingBuffer.document !== document
                    || existingBuffer.resourceKey !== resourceKey)
                && !staged)) {
            // A dirty editor incarnation without even a staged provider read
            // cannot acquire a remote identity from a mutable path cache. A
            // staged read may identify the path, but only a confirmed clean
            // document can acquire an active base and authorize an operation.
            this.unboundEditorIncarnations.add(document);
            return undefined;
        }
        const docId = staged?.docId
            ?? this.documentIdsByPath.get(resourceKey)
            ?? this.cachedDocumentIdForUri(document.uri);
        if (!docId) { return undefined; }
        if (staged?.docId === docId) {
            this.documentIdsByPath.set(resourceKey, docId);
        }
        let bufferId = this.editorBufferIds.get(document);
        if (!bufferId) {
            bufferId = randomUUID();
            this.editorBufferIds.set(document, bufferId);
        }
        const state: EditorBufferState = {
            bufferId,
            document,
            resourceKey,
            canonicalEditorUri: this.canonicalEditorUri(docId),
            docId,
        };
        this.editorBuffers.set(bufferId, state);
        const unboundIntent = this.unboundEditorSaveIntents.get(document);
        if (unboundIntent
            && unboundIntent.resourceKey === resourceKey
            && unboundIntent.documentVersion === document.version
            && unboundIntent.content === document.getText()
            && document.isDirty) {
            this.editorSaveIntents.set(bufferId, {
                ...state,
                documentVersion: unboundIntent.documentVersion,
                content: unboundIntent.content,
            });
            this.unboundEditorSaveIntents.delete(document);
        }
        return state;
    }

    /** Bind a fresh exact provider read automatically; restored opens remain quarantined. */
    observeOpenedTextDocument(document: vscode.TextDocument) {
        const buffer = this.observeEditorBuffer(document);
        if (!buffer || document.isClosed || document.isDirty) { return; }
        const ticket = this.pendingReadTickets.get(buffer.resourceKey);
        const sender = this.currentSenderWitness();
        if (!ticket
            || ticket.resourceKey !== buffer.resourceKey
            || ticket.docId !== buffer.docId
            || ticket.canonicalEditorUri !== buffer.canonicalEditorUri
            || ticket.content !== document.getText()
            || sender?.publicId !== ticket.publicId
            || sender.generation !== ticket.socketGeneration) {
            return;
        }
        const active = this.activeEditorBases.get(buffer.bufferId);
        if (active
            && active.identity.docId === ticket.docId
            && active.version === ticket.version
            && active.content === ticket.content
            && active.causality.valid
            && active.causality.socketGeneration === ticket.socketGeneration) {
            this.pendingReadTickets.delete(buffer.resourceKey);
            return;
        }
        const existingCandidate = this.boundReadCandidates.get(buffer.bufferId);
        if (existingCandidate?.document === document
            && existingCandidate.ticket.docId === ticket.docId
            && existingCandidate.ticket.version === ticket.version
            && existingCandidate.ticket.content === ticket.content
            && existingCandidate.ticket.publicId === ticket.publicId
            && existingCandidate.ticket.socketGeneration === ticket.socketGeneration) {
            this.pendingReadTickets.delete(buffer.resourceKey);
            return;
        }
        this.pendingReadTickets.delete(buffer.resourceKey);
        const candidate: BoundProviderReadCandidate = {
            ticket,
            bufferId: buffer.bufferId,
            document,
            documentVersion: document.version,
        };
        this.boundReadCandidates.set(buffer.bufferId, candidate);

        if (!ticket.requiresExplicitConfirmation) {
            void this.confirmBoundReadCandidate(candidate).then(confirmed => {
                if (!confirmed) {
                    void vscode.window.showErrorMessage(vscode.l10n.t(
                        'The fresh Overleaf editor could not prove its remote base and remains read-only for saving.',
                    ));
                }
            }).catch(error => {
                if (this.boundReadCandidates.get(buffer.bufferId) === candidate) {
                    this.boundReadCandidates.delete(buffer.bufferId);
                }
                console.warn('Unable to bind the fresh Overleaf editor base', error);
            });
            return;
        }

        const enable = vscode.l10n.t('Reload Remote and Enable Editing');
        const message = vscode.l10n.t(
            'Confirm the current Overleaf text before editing. Restored unsaved buffers must remain unconfirmed.',
        );
        void Promise.resolve(vscode.window.showWarningMessage(
            message,
            {modal: true},
            enable,
        )).then(async choice => {
            if (choice !== enable) {
                if (this.boundReadCandidates.get(buffer.bufferId) === candidate) {
                    this.boundReadCandidates.delete(buffer.bufferId);
                }
                return;
            }
            if (!await this.confirmBoundReadCandidate(candidate)) {
                void vscode.window.showErrorMessage(vscode.l10n.t(
                    'The editor or remote document changed before it could be enabled. Reload it before editing.',
                ));
            }
        }).catch(error => {
            if (this.boundReadCandidates.get(buffer.bufferId) === candidate) {
                this.boundReadCandidates.delete(buffer.bufferId);
            }
            console.warn('Unable to confirm the clean Overleaf editor base', error);
        });
    }

    private async confirmBoundReadCandidate(candidate: BoundProviderReadCandidate): Promise<boolean> {
        const {document, ticket, bufferId} = candidate;
        const discardCandidate = () => {
            if (this.boundReadCandidates.get(bufferId) === candidate) {
                this.boundReadCandidates.delete(bufferId);
            }
        };
        vscode.workspace.textDocuments.forEach(openDocument => {
            this.observeEditorBuffer(openDocument);
        });
        const buffer = this.editorBuffers.get(bufferId);
        const sender = this.currentSenderWitness();
        const hasOtherDirtyAlias = [...this.editorBuffers.values()].some(other =>
            other.bufferId !== bufferId
            && other.canonicalEditorUri === ticket.canonicalEditorUri
            && vscode.workspace.textDocuments.includes(other.document)
            && !other.document.isClosed
            && other.document.isDirty
        );
        if (this.boundReadCandidates.get(bufferId) !== candidate
            || buffer?.document !== document
            || buffer.resourceKey !== ticket.resourceKey
            || buffer.docId !== ticket.docId
            || buffer.canonicalEditorUri !== ticket.canonicalEditorUri
            || this.exactOpenDocument(document.uri) !== document
            || document.isClosed
            || document.isDirty
            || document.version < candidate.documentVersion
            || document.getText() !== ticket.content
            || sender?.publicId !== ticket.publicId
            || sender.generation !== ticket.socketGeneration
            || hasOtherDirtyAlias) {
            discardCandidate();
            return false;
        }

        let authoritative: {doc: DocumentEntity, content: string};
        try {
            authoritative = await this.joinFreshDocumentSession(ticket.docId);
        } catch {
            discardCandidate();
            return false;
        }
        vscode.workspace.textDocuments.forEach(openDocument => {
            this.observeEditorBuffer(openDocument);
        });
        const senderAfter = this.currentSenderWitness();
        const bufferAfter = this.editorBuffers.get(bufferId);
        const identity = bufferAfter ?
            this.documentProvenanceIdentity(ticket.docId, bufferAfter) : undefined;
        const hasOtherDirtyAliasAfter = [...this.editorBuffers.values()].some(other =>
            other.bufferId !== bufferId
            && other.canonicalEditorUri === ticket.canonicalEditorUri
            && vscode.workspace.textDocuments.includes(other.document)
            && !other.document.isClosed
            && other.document.isDirty
        );
        if (this.boundReadCandidates.get(bufferId) !== candidate
            || bufferAfter?.document !== document
            || bufferAfter.resourceKey !== ticket.resourceKey
            || bufferAfter.docId !== ticket.docId
            || bufferAfter.canonicalEditorUri !== ticket.canonicalEditorUri
            || this.exactOpenDocument(document.uri) !== document
            || document.isClosed
            || document.isDirty
            || document.version < candidate.documentVersion
            || document.getText() !== ticket.content
            || authoritative.doc.version !== ticket.version
            || authoritative.content !== ticket.content
            || !this.documentMatchesAuthority(
                authoritative.doc,
                ticket.version,
                ticket.content,
            )
            || senderAfter?.publicId !== ticket.publicId
            || senderAfter.generation !== ticket.socketGeneration
            || hasOtherDirtyAliasAfter
            || !identity) {
            discardCandidate();
            return false;
        }

        this.activeEditorBases.set(bufferId, {
            identity,
            bufferId,
            version: ticket.version,
            content: ticket.content,
            causality: this.createLocalEditorCausality(
                document,
                ticket.docId,
                ticket.version,
                ticket.content,
            ),
        });
        authoritative.doc.localCache = ticket.content;
        discardCandidate();
        return true;
    }

    observeChangedTextDocument(event: vscode.TextDocumentChangeEvent) {
        const document = event.document;
        const bufferId = this.editorBufferIds.get(document);
        const candidate = bufferId ? this.boundReadCandidates.get(bufferId) : undefined;
        if (candidate?.document === document) {
            if (event.contentChanges.length > 0
                || document.isDirty
                || document.version < candidate.documentVersion
                || document.getText() !== candidate.ticket.content) {
                this.boundReadCandidates.delete(bufferId!);
            } else {
                candidate.documentVersion = document.version;
            }
        }
        const buffer = this.observeEditorBuffer(document);
        const active = buffer ? this.activeEditorBases.get(buffer.bufferId) : undefined;
        if (active) {
            const sender = this.currentSenderWitness();
            const changes = event.contentChanges.map(change => ({
                rangeOffset: change.rangeOffset,
                rangeLength: change.rangeLength,
                text: change.text,
            }));
            const pendingRemote = buffer ?
                this.remoteEditorTransactionMap().get(buffer.bufferId) : undefined;
            if (pendingRemote) {
                let next = commitRemoteEditorTransaction(
                    active.causality,
                    pendingRemote.transaction,
                    document.version,
                    changes,
                    document.getText(),
                );
                if (pendingRemote.document !== document
                    || pendingRemote.active !== active
                    || sender?.generation !== next.socketGeneration) {
                    next = {...next, valid: false};
                }
                active.causality = next;
                pendingRemote.consumed = next.valid;
                this.remoteEditorTransactionMap().delete(buffer!.bufferId);
                if (next.valid) {
                    active.version = next.remoteVersion;
                    active.content = next.remoteContent;
                    active.recordName = undefined;
                    active.persistence = undefined;
                }
            } else if (changes.length === 0) {
                // onDidChangeTextDocument also reports dirty-state and encoding
                // changes. They are not missing text operations when the text
                // itself is unchanged.
                active.causality.valid = active.causality.valid
                    && sender?.generation === active.causality.socketGeneration
                    && document.version >= active.causality.documentVersion
                    && document.getText() === active.causality.editorContent;
                active.causality.documentVersion = document.version;
            } else {
                active.causality = recordLocalEditorChange(
                    active.causality,
                    document.version,
                    changes,
                    document.getText(),
                );
                if (sender?.generation !== active.causality.socketGeneration) {
                    active.causality.valid = false;
                }
            }
        }
        this.observeTextDocument(document);
    }

    /** A clean open remains quarantined until an explicit confirmed reload. */
    observeTextDocument(document: vscode.TextDocument) {
        const buffer = this.observeEditorBuffer(document);
        if (!buffer) { return; }
        if (!document.isDirty) {
            const receipt = this.editorSaveReceipts.get(buffer.bufferId);
            if (receipt
                && receipt.document === document
                && receipt.content === document.getText()
                && receipt.identity.canonicalEditorUri === buffer.canonicalEditorUri) {
                const existing = this.activeEditorBases.get(buffer.bufferId);
                this.activeEditorBases.set(buffer.bufferId, {
                    identity: receipt.identity,
                    bufferId: buffer.bufferId,
                    version: receipt.version,
                    content: receipt.content,
                    recordName: existing?.recordName,
                    persistence: existing?.persistence,
                    causality: this.createLocalEditorCausality(
                        document,
                        receipt.identity.docId,
                        receipt.version,
                        receipt.content,
                    ),
                });
                this.editorSaveReceipts.delete(buffer.bufferId);
            }
            return;
        }

        const active = this.activeEditorBases.get(buffer.bufferId);
        if (!active) { return; }
        const pending = this.pendingDocumentUpdates.get(buffer.bufferId);
        if (pending) {
            const persistence = this.provenanceStore.updatePendingDirtyText(
                pending.provenanceRecordName,
                this.pendingWritePayload(pending),
                document.getText(),
            );
            active.persistence = persistence;
            void persistence.then(record => {
                if (this.activeEditorBases.get(buffer.bufferId) === active
                    && active.persistence === persistence) {
                    active.recordName = record.recordName;
                }
            }).catch(error => {
                if (this.pendingDocumentUpdates.get(buffer.bufferId) === pending
                    && active.persistence === persistence) {
                    console.warn('Unable to persist post-submit dirty Overleaf text', error);
                }
            });
            return;
        }
        const persistence = this.provenanceStore.createOrUpdateCurrent({
            identity: active.identity,
            bufferIncarnationId: buffer.bufferId,
            baseVersion: active.version,
            baseText: active.content,
            dirtyText: document.getText(),
        });
        active.persistence = persistence;
        void persistence.then(record => {
            if (this.activeEditorBases.get(buffer.bufferId) === active
                && active.persistence === persistence) {
                active.recordName = record.recordName;
            }
        }).catch(error => {
            console.warn('Unable to persist dirty Overleaf document provenance', error);
        });
    }

    observeWillSaveTextDocument(document: vscode.TextDocument) {
        this.unboundEditorSaveIntents.set(document, {
            resourceKey: this.resourceKey(document.uri),
            documentVersion: document.version,
            content: document.getText(),
        });
        const buffer = this.observeEditorBuffer(document);
        if (!buffer || !document.isDirty) { return; }
        this.editorSaveIntents.set(buffer.bufferId, {
            ...buffer,
            documentVersion: document.version,
            content: document.getText(),
        });
        this.unboundEditorSaveIntents.delete(document);
    }

    private matchesUnboundEditorSave(uri: vscode.Uri, content: Uint8Array): boolean {
        const resourceKey = this.resourceKey(uri);
        const desiredContent = new TextDecoder().decode(content);
        return vscode.workspace.textDocuments.some(document => {
            if (!this.unboundEditorIncarnations.has(document)
                || document.isClosed
                || document.uri.toString() !== resourceKey) {
                return false;
            }
            const intent = this.unboundEditorSaveIntents.get(document);
            return intent?.resourceKey === resourceKey
                && intent.documentVersion === document.version
                && intent.content === desiredContent
                && document.isDirty
                && document.getText() === desiredContent;
        });
    }

    forgetTextDocument(document: vscode.TextDocument) {
        this.unboundEditorSaveIntents.delete(document);
        this.unboundEditorIncarnations.delete(document);
        const bufferId = this.editorBufferIds.get(document);
        if (!bufferId) { return; }
        this.editorBuffers.delete(bufferId);
        this.activeEditorBases.delete(bufferId);
        this.editorSaveIntents.delete(bufferId);
        this.editorSaveReceipts.delete(bufferId);
        this.boundReadCandidates.delete(bufferId);
        this.remoteEditorTransactionMap().delete(bufferId);
        this.pendingReadTickets.delete(this.resourceKey(document.uri));
        this.editorBufferIds.delete(document);
    }

    async confirmEditorBase(document: vscode.TextDocument): Promise<boolean> {
        const buffer = this.observeEditorBuffer(document);
        if (!buffer || document.isDirty) { return false; }
        const staged = this.stagedEditorBases.get(buffer.resourceKey);
        if (!staged
            || staged.docId !== buffer.docId
            || staged.canonicalEditorUri !== buffer.canonicalEditorUri
            || staged.content !== document.getText()) {
            return false;
        }
        const identity = this.documentProvenanceIdentity(buffer.docId, buffer);
        if (!identity) { return false; }
        const current = this.currentDocument(buffer.docId);
        if (!this.documentMatchesAuthority(current, staged.version, staged.content)) {
            return false;
        }
        const identityAfterCheck = this.documentProvenanceIdentity(buffer.docId, buffer);
        if (document.isClosed
            || document.isDirty
            || document.getText() !== staged.content
            || !this.documentMatchesAuthority(current, staged.version, staged.content)
            || !identityAfterCheck
            || !this.sameDocumentProvenanceIdentity(identity, identityAfterCheck)) {
            return false;
        }
        this.activeEditorBases.set(buffer.bufferId, {
            identity,
            bufferId: buffer.bufferId,
            version: staged.version,
            content: staged.content,
            causality: this.createLocalEditorCausality(
                document,
                staged.docId,
                staged.version,
                staged.content,
            ),
        });
        this.pendingReadTickets.delete(buffer.resourceKey);
        this.boundReadCandidates.delete(buffer.bufferId);
        current.localCache = staged.content;
        return true;
    }

    private resolveWritingBuffer(
        uri: vscode.Uri,
        docId: string,
        desiredContent: string,
    ): {kind: 'valid', witness: EditorBufferWitness} | {kind: 'blocked', reason: string} {
        const canonicalEditorUri = this.canonicalEditorUri(docId);
        const openDocuments = new Set(vscode.workspace.textDocuments);
        // An editor can predate VFS construction (notably hot exit) and thus
        // have missed onDidOpen/onDidChange. Bind every currently open project
        // document before deciding uniqueness; otherwise a second dirty alias
        // could remain invisible until its own save attempt.
        openDocuments.forEach(document => {
            this.observeEditorBuffer(document);
        });
        const dirty = [...this.editorBuffers.values()].filter(buffer =>
            buffer.canonicalEditorUri === canonicalEditorUri
            && openDocuments.has(buffer.document)
            && buffer.document.isDirty
        );
        if (dirty.length > 1) {
            return {
                kind: 'blocked',
                reason: 'multiple dirty editor buffers refer to the same remote document',
            };
        }
        const resourceKey = this.resourceKey(uri);
        const matchingIntents = [...this.editorSaveIntents.values()].filter(intent =>
            intent.canonicalEditorUri === canonicalEditorUri
            && intent.resourceKey === resourceKey
            && openDocuments.has(intent.document)
        );
        const exactIntents = matchingIntents.filter(intent =>
            intent.docId === docId
            && intent.documentVersion === intent.document.version
            && intent.content === desiredContent
            && this.bufferMatchesWitness(intent)
        );
        matchingIntents.forEach(intent => {
            if (!exactIntents.includes(intent)) {
                this.editorSaveIntents.delete(intent.bufferId);
            }
        });
        if (exactIntents.length > 1) {
            return {
                kind: 'blocked',
                reason: 'the editor URI resolves to multiple dirty buffer incarnations',
            };
        }
        let witness = exactIntents[0];
        if (witness) {
            this.editorSaveIntents.delete(witness.bufferId);
        } else {
            // VS Code explicitly permits saves which omit onWillSaveTextDocument.
            // It can also apply format-on-save edits after onWillSave. In both
            // paths, writeFile's exact URI and bytes can identify an
            // already-confirmed live buffer without granting a new identity.
            const live = [...this.editorBuffers.values()].filter(buffer =>
                buffer.canonicalEditorUri === canonicalEditorUri
                && buffer.resourceKey === resourceKey
                && openDocuments.has(buffer.document)
                && buffer.document.getText() === desiredContent
                && this.activeEditorBases.has(buffer.bufferId)
            );
            if (live.length !== 1) {
                return {
                    kind: 'blocked',
                    reason: 'no unique confirmed editor buffer matches this save',
                };
            }
            witness = {
                ...live[0],
                documentVersion: live[0].document.version,
                content: desiredContent,
            };
        }
        if (witness.docId !== docId
            || witness.content !== desiredContent
            || !this.bufferMatchesWitness(witness)) {
            return {kind: 'blocked', reason: 'the editor buffer changed before save authorization'};
        }
        return {kind: 'valid', witness};
    }

    private bufferMatchesWitness(witness: EditorBufferWitness): boolean {
        return this.bufferMatchesIncarnation(witness)
            && vscode.workspace.textDocuments.includes(witness.document)
            && witness.document.version === witness.documentVersion
            && witness.document.getText() === witness.content;
    }

    private bufferMatchesIncarnation(
        buffer: Pick<EditorBufferState, 'bufferId' | 'document' | 'resourceKey' | 'docId' | 'canonicalEditorUri'>,
    ): boolean {
        const current = this.editorBuffers.get(buffer.bufferId);
        return this.editorBufferIds.get(buffer.document) === buffer.bufferId
            && current?.document === buffer.document
            && current.resourceKey === buffer.resourceKey
            && current.docId === buffer.docId
            && current.canonicalEditorUri === buffer.canonicalEditorUri
            && vscode.workspace.textDocuments.includes(buffer.document)
            && !buffer.document.isClosed
            && buffer.document.uri.toString() === buffer.resourceKey;
    }

    private async resolveEditorProvenance(
        docId: string,
        desiredContent: string,
        witness: EditorBufferWitness,
    ): Promise<EditorProvenanceResolution> {
        const identity = this.documentProvenanceIdentity(docId, witness);
        if (!identity) {
            return {kind: 'blocked', reason: 'the realtime protocol or sender identity is unproven'};
        }

        const active = this.activeEditorBases.get(witness.bufferId);
        if (active) {
            if (active.bufferId !== witness.bufferId
                || !this.sameDocumentProvenanceIdentity(active.identity, identity)) {
                return {kind: 'blocked', reason: 'the active editor belongs to a different project session'};
            }
            try {
                const record = await this.provenanceStore.createOrUpdateCurrent({
                    identity,
                    bufferIncarnationId: witness.bufferId,
                    baseVersion: active.version,
                    baseText: active.content,
                    dirtyText: desiredContent,
                });
                active.recordName = record.recordName;
                active.persistence = Promise.resolve(record);
                const resolved = await this.provenanceStore.resolveCurrentRecord(record.recordName, {
                    identity,
                    bufferIncarnationId: witness.bufferId,
                    baseVersion: active.version,
                    baseText: active.content,
                    dirtyText: desiredContent,
                });
                if (resolved.kind !== 'valid') {
                    return {kind: 'blocked', reason: `the live provenance record is ${resolved.kind}`};
                }
                return {
                    kind: 'valid',
                    value: {record: resolved.record, recordsToClear: [resolved.record.recordName]},
                };
            } catch (error) {
                return {
                    kind: 'blocked',
                    reason: `the live provenance record could not be persisted: ${String(error)}`,
                };
            }
        }

        let recovered;
        try {
            recovered = await this.provenanceStore.recoverCold(identity, desiredContent);
        } catch (error) {
            return {
                kind: 'blocked',
                reason: `saved provenance could not be read: ${String(error)}`,
            };
        }
        if (recovered.kind !== 'valid') {
            const detail = recovered.kind === 'ambiguous' ?
                'multiple windows recorded the same dirty buffer with ambiguous ownership' :
                recovered.kind === 'invalid' ?
                    `saved provenance is invalid (${recovered.reason})` :
                    'no exact saved base matches this dirty buffer';
            return {kind: 'blocked', reason: detail};
        }
        // The repository has no stable VS Code/Cursor buffer-owner identifier
        // across hot exit, nor an atomic cross-window claim primitive. Two
        // restarted windows could otherwise adopt the same record and submit
        // the same edit with different socket ids. A cold record is therefore
        // diagnostic/recovery evidence only. An exact authoritative no-op is
        // still accepted by the caller because it sends no operation.
        return {
            kind: 'blocked',
            reason: recovered.record.pendingWrite !== undefined ?
                'a previous-window write has an unknown or unreconciled outcome' :
                'the saved base belongs to a previous window whose ownership cannot be proven',
        };
    }

    private documentMatchesAuthority(
        doc: DocumentEntity,
        expectedVersion: number,
        expectedContent: string,
    ): boolean {
        try {
            return isNonnegativeSafeInteger(expectedVersion)
                && this.currentDocument(doc._id) === doc
                && doc.version === expectedVersion
                && doc.remoteCache === expectedContent;
        } catch {
            return false;
        }
    }

    private async acceptEditorBase(
        witness: EditorBufferWitness,
        doc: DocumentEntity,
        expectedVersion: number,
        authoritativeContent: string,
        recordsToClear: string[] = [],
    ) {
        if (!this.documentMatchesAuthority(doc, expectedVersion, authoritativeContent)
            || !this.bufferMatchesWitness(witness)
            || authoritativeContent !== witness.content) {
            throw new Error('The remote document moved before its editor base could be committed');
        }
        const identity = this.documentProvenanceIdentity(doc._id, witness);
        if (!identity) {
            throw new Error('The confirmed sender identity changed before accepting the editor base');
        }
        const record = recordsToClear.length > 0 ?
            await this.provenanceStore.createOrUpdateCurrent({
                identity,
                bufferIncarnationId: witness.bufferId,
                baseVersion: expectedVersion,
                baseText: authoritativeContent,
                dirtyText: authoritativeContent,
            }) : undefined;
        const identityAfterWrite = this.documentProvenanceIdentity(doc._id, witness);
        if (!this.documentMatchesAuthority(doc, expectedVersion, authoritativeContent)
            || !this.bufferMatchesWitness(witness)
            || !identityAfterWrite
            || !this.sameDocumentProvenanceIdentity(identity, identityAfterWrite)) {
            throw new Error('The editor or sender changed while its confirmed base was persisted');
        }

        doc.localCache = authoritativeContent;
        this.stageEditorBase(witness.document.uri, doc, authoritativeContent);
        this.activeEditorBases.set(witness.bufferId, {
            identity,
            bufferId: witness.bufferId,
            version: expectedVersion,
            content: authoritativeContent,
            recordName: record?.recordName,
            persistence: record ? Promise.resolve(record) : undefined,
            causality: this.createLocalEditorCausality(
                witness.document,
                doc._id,
                expectedVersion,
                authoritativeContent,
            ),
        });
        this.editorSaveReceipts.set(witness.bufferId, {
            document: witness.document,
            identity,
            bufferId: witness.bufferId,
            version: expectedVersion,
            content: authoritativeContent,
        });
    }

    private exactOpenDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
        const matches = vscode.workspace.textDocuments.filter(
            candidate => candidate.uri.toString() === uri.toString(),
        );
        return matches.length === 1 ? matches[0] : undefined;
    }

    private showDocumentRecovery(uri: vscode.Uri, _content: Uint8Array, reason: string) {
        const key = uri.toString();
        if (this.recoveryNotifications.has(key)) { return; }
        this.recoveryNotifications.add(key);
        // Bind both recovery actions to the concrete buffer incarnation which
        // was blocked. Reopening an alias while either dialog is pending must
        // not substitute a different TextDocument object.
        const originalDocument = this.exactOpenDocument(uri);
        const originalBufferId = originalDocument && this.editorBufferIds.get(originalDocument);
        const stillOriginalDocument = (): vscode.TextDocument | undefined => {
            const current = this.exactOpenDocument(uri);
            return current
                && current === originalDocument
                && this.editorBufferIds.get(current) === originalBufferId ?
                current : undefined;
        };
        const originalBuffer = originalBufferId ? this.editorBuffers.get(originalBufferId) : undefined;
        const originalDocId = originalBuffer && originalBuffer.document === originalDocument ?
            originalBuffer.docId : undefined;
        const stillOriginalBuffer = (): EditorBufferState | undefined => {
            const document = stillOriginalDocument();
            const buffer = originalBufferId ? this.editorBuffers.get(originalBufferId) : undefined;
            return document
                && originalDocId
                && buffer?.document === document
                && buffer.docId === originalDocId
                && buffer.resourceKey === key ?
                buffer : undefined;
        };
        const saveCopy = vscode.l10n.t('Save Recovery Copy...');
        const reloadRemote = vscode.l10n.t('Reload Remote');
        const message = vscode.l10n.t(
            'Overleaf did not send this document because {reason}. The editor remains dirty. Save a local recovery copy, reload the remote text, or keep editing.',
            {reason},
        );
        void Promise.resolve(vscode.window.showErrorMessage(message, saveCopy, reloadRemote)).then(async choice => {
            if (choice === saveCopy) {
                const target = await vscode.window.showSaveDialog({saveLabel: saveCopy});
                if (!target) { return; }
                if (target.scheme === ROOT_NAME) {
                    void vscode.window.showErrorMessage(
                        vscode.l10n.t('Choose a local or non-Overleaf location for the recovery copy.'),
                    );
                    return;
                }
                const document = stillOriginalDocument();
                if (!document) {
                    void vscode.window.showErrorMessage(
                        vscode.l10n.t('The blocked editor is no longer uniquely open; no recovery copy was written.'),
                    );
                    return;
                }
                await vscode.workspace.fs.writeFile(
                    target,
                    new TextEncoder().encode(document.getText()),
                );
                void vscode.window.showInformationMessage(
                    vscode.l10n.t('Recovery copy saved to {path}.', {path: target.fsPath || target.toString()}),
                );
            } else if (choice === reloadRemote) {
                const confirmed = await vscode.window.showWarningMessage(
                    vscode.l10n.t('Reloading discards the unsaved editor text. Continue only after saving a recovery copy if needed.'),
                    {modal: true},
                    reloadRemote,
                );
                if (confirmed !== reloadRemote) { return; }
                const document = stillOriginalDocument();
                if (!document) {
                    void vscode.window.showErrorMessage(
                        vscode.l10n.t('The blocked document is no longer open; no editor was reloaded.'),
                    );
                    return;
                }
                const buffer = stillOriginalBuffer();
                const sender = this.currentSenderWitness();
                if (!buffer || !sender) {
                    void vscode.window.showErrorMessage(
                        vscode.l10n.t('The blocked editor has no current remote identity; no editor was reloaded.'),
                    );
                    return;
                }
                const blockedVersion = document.version;
                const blockedText = document.getText();
                const editor = await vscode.window.showTextDocument(document, {preserveFocus: false});
                const authoritative = await this.joinFreshDocumentSession(buffer.docId);
                const authoritativeVersion = authoritative.doc.version;
                const authoritativeText = authoritative.content;
                const senderAfterJoin = this.currentSenderWitness();
                const editTarget = stillOriginalDocument();
                const bufferAfterJoin = stillOriginalBuffer();
                if (!editTarget
                    || editTarget !== document
                    || editor.document !== document
                    || bufferAfterJoin?.docId !== buffer.docId
                    || document.version !== blockedVersion
                    || document.getText() !== blockedText
                    || !isNonnegativeSafeInteger(authoritativeVersion)
                    || senderAfterJoin?.publicId !== sender.publicId
                    || senderAfterJoin.generation !== sender.generation
                    || !this.documentMatchesAuthority(
                        authoritative.doc,
                        authoritativeVersion,
                        authoritativeText,
                    )) {
                    void vscode.window.showErrorMessage(
                        vscode.l10n.t('The blocked editor changed before reload; no text was replaced.'),
                    );
                    return;
                }
                this.stageEditorBase(uri, authoritative.doc, authoritativeText);
                const replaced = await editor.edit(edit => {
                    edit.replace(
                        new vscode.Range(
                            document.positionAt(0),
                            document.positionAt(blockedText.length),
                        ),
                        authoritativeText,
                    );
                });
                if (!replaced
                    || stillOriginalDocument() !== document
                    || document.getText() !== authoritativeText) {
                    void vscode.window.showErrorMessage(
                        vscode.l10n.t('The blocked editor could not be replaced safely; it was not saved.'),
                    );
                    return;
                }
                const senderBeforeSave = this.currentSenderWitness();
                if (stillOriginalBuffer()?.docId !== buffer.docId
                    || senderBeforeSave?.publicId !== sender.publicId
                    || senderBeforeSave.generation !== sender.generation
                    || !this.documentMatchesAuthority(
                        authoritative.doc,
                        authoritativeVersion,
                        authoritativeText,
                    )) {
                    void vscode.window.showErrorMessage(
                        vscode.l10n.t('The remote document changed during reload; the replacement remains unsaved.'),
                    );
                    return;
                }
                const saved = await document.save();
                const reloaded = stillOriginalDocument();
                if (!saved
                    || !reloaded
                    || reloaded !== document
                    || reloaded.isDirty
                    || reloaded.getText() !== authoritativeText
                    || !await this.confirmEditorBase(reloaded)) {
                    void vscode.window.showErrorMessage(
                        vscode.l10n.t('The remote document was reloaded but its exact editor base could not be confirmed.'),
                    );
                }
            }
        }).catch(error => {
            console.error('Unable to offer Overleaf document recovery', error);
        }).finally(() => {
            this.recoveryNotifications.delete(key);
        });
    }

    private blockDocumentWrite(uri: vscode.Uri, content: Uint8Array, reason: string): never {
        this.showDocumentRecovery(uri, content, reason);
        throw vscode.FileSystemError.Unavailable(
            vscode.l10n.t('Overleaf save blocked: {reason}', {reason}),
        );
    }

    private invalidateDocumentSessions(project?: ProjectEntity) {
        this.pendingReadTickets.clear();
        this.boundReadCandidates.clear();
        this.remoteEditorTransactionMap().clear();
        const documentIds = new Set(this.documentMap(project).keys());
        this.activeEditorBases.forEach(active => {
            if (documentIds.has(active.identity.docId)) {
                active.causality.valid = false;
            }
        });
        this.documentMap(project).forEach((doc) => {
            this.invalidateRemoteCausality(doc._id);
            doc.version = undefined;
            doc.remoteCache = undefined;
            doc.lastVersion = undefined;
            this.rejectDocumentVersionWaiters(doc._id, new Error('Document session disconnected'));
        });
    }

    private invalidateDocumentSession(docId: string, error: Error) {
        this.invalidateRemoteCausality(docId);
        this.activeEditorBases.forEach((active, bufferId) => {
            if (active.identity.docId === docId) {
                active.causality.valid = false;
                this.remoteEditorTransactionMap().delete(bufferId);
            }
        });
        for (const [resourceKey, ticket] of this.pendingReadTickets) {
            if (ticket.docId === docId) { this.pendingReadTickets.delete(resourceKey); }
        }
        for (const [bufferId, candidate] of this.boundReadCandidates) {
            if (candidate.ticket.docId === docId) { this.boundReadCandidates.delete(bufferId); }
        }
        const documents = new Set<DocumentEntity>();
        [this.root, this.joiningProject, this.previousRoot].forEach(project => {
            const doc = this.documentMap(project).get(docId);
            if (doc) { documents.add(doc); }
        });
        documents.forEach(doc => {
            doc.version = undefined;
            doc.remoteCache = undefined;
            doc.lastVersion = undefined;
        });
        this.rejectDocumentVersionWaiters(docId, error);
    }

    private isProjectReadOnly() {
        return this.permissionsLevel === 'readOnly' || this.permissionsLevel === 'review';
    }

    private markSourceDirty() {
        this.sourceRevision += 1;
        this.isDirty = true;
    }

    private realtimeUnavailableMessage() {
        return (this.terminalRealtimeError ?? this.socket.fatalError)?.message;
    }

    private async assertProjectWritable(action: string) {
        const unavailableBeforeJoin = this.realtimeUnavailableMessage();
        if (unavailableBeforeJoin) {
            throw vscode.FileSystemError.Unavailable(unavailableBeforeJoin);
        }
        // Permission metadata arrives with joinProject. Do not allow a mutation
        // to race ahead while the project is still being restored.
        await this.init();
        const unavailableAfterJoin = this.realtimeUnavailableMessage();
        if (unavailableAfterJoin) {
            throw vscode.FileSystemError.Unavailable(unavailableAfterJoin);
        }
        if (this.isProjectReadOnly()) {
            throw vscode.FileSystemError.NoPermissions(
                this.permissionsLevel === 'review' ?
                    `${action}: Track Changes sessions are read-only because this client does not support History OT` :
                    `${action}: this Overleaf project is read-only`,
            );
        }
    }

    private handleFatalRealtime(error: RealtimeFatalError) {
        if (this.disposed || this.terminalRealtimeError) { return; }
        this.terminalRealtimeError = error;
        if (this.root) { this.previousRoot = this.root; }
        this.invalidateDocumentSessions(this.previousRoot);
        this.pendingDocumentUpdates.clear();
        this.root = undefined;
        this.joiningProject = undefined;
        this.publicId = undefined;
        this.permissionsLevel = undefined;
        this.protocolVersion = undefined;
        void vscode.window.showErrorMessage(
            vscode.l10n.t('Overleaf realtime connection stopped: {message}', {message: error.message}),
            vscode.l10n.t('Reload'),
        ).then(choice => {
            if (choice === vscode.l10n.t('Reload')) {
                void vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        });
    }

    private handleOtUpdateError(error: OtUpdateErrorSchema) {
        if (this.disposed || (error.projectId && error.projectId !== this.projectId)) { return; }
        // Official otUpdateError is broadcast to the whole document room and
        // contains no sender publicId or operation identity. It cannot prove
        // that this client's pending operation failed; it may describe a
        // collaborator operation while ours is already queued behind it.
        const uncertainty = new SocketRequestError(
            'server_error',
            `An Overleaf document update failed with unknown local outcome: ${error.message}`,
            true,
            error.details,
        );
        if (error.docId) {
            this.invalidateDocumentSession(error.docId, uncertainty);
            return;
        }
        [this.root, this.joiningProject, this.previousRoot].forEach(project =>
            this.invalidateDocumentSessions(project)
        );
    }

    private restoreDocumentRuntime(previous: ProjectEntity | undefined, current: ProjectEntity) {
        const previousDocs = this.documentMap(previous);
        this.documentMap(current).forEach((doc, id) => {
            const oldDoc = previousDocs.get(id);
            if (!oldDoc) { return; }
            // Only a cache which was already associated with the editor may
            // survive a warm reconnect. A remote snapshot is never promoted to
            // an editor base merely because the old transport observed it.
            doc.localCache = oldDoc.localCache;
            doc.remoteCache = undefined;
            doc.version = undefined;
            doc.lastVersion = undefined;
            doc.mtime = oldDoc.mtime;
        });
    }

    private waitForDocumentVersion(docId: string, expectedVersion: number, timeoutMs = 15000) {
        if (!isNonnegativeSafeInteger(expectedVersion)) {
            throw new Error('Cannot wait for an invalid document revision');
        }
        let waiter!: DocumentVersionWaiter;
        const promise = new Promise<number>((resolve, reject) => {
            waiter = {
                expectedVersion,
                resolve,
                reject,
                timer: setTimeout(() => {
                    this.removeDocumentVersionWaiter(docId, waiter);
                    reject(new SocketRequestError(
                        'timeout',
                        `Timed out waiting for document ${docId} version ${expectedVersion}`,
                        true,
                    ));
                }, timeoutMs),
            };
            const waiters = this.documentVersionWaiters.get(docId) ?? new Set<DocumentVersionWaiter>();
            waiters.add(waiter);
            this.documentVersionWaiters.set(docId, waiters);
        });
        return {
            promise,
            cancel: () => this.removeDocumentVersionWaiter(docId, waiter),
        };
    }

    private removeDocumentVersionWaiter(docId: string, waiter: DocumentVersionWaiter) {
        clearTimeout(waiter.timer);
        const waiters = this.documentVersionWaiters.get(docId);
        waiters?.delete(waiter);
        if (waiters?.size === 0) {
            this.documentVersionWaiters.delete(docId);
        }
    }

    private resolveDocumentVersionWaiters(docId: string, version: number) {
        const waiters = this.documentVersionWaiters.get(docId);
        waiters?.forEach((waiter) => {
            if (version >= waiter.expectedVersion) {
                this.removeDocumentVersionWaiter(docId, waiter);
                waiter.resolve(version);
            }
        });
    }

    private rejectDocumentVersionWaiters(docId: string, error: Error) {
        const waiters = this.documentVersionWaiters.get(docId);
        waiters?.forEach((waiter) => {
            this.removeDocumentVersionWaiter(docId, waiter);
            waiter.reject(error);
        });
    }

    get isInvisibleMode() {
        return this.socket.isUsingAlternativeConnectionScheme;
    }

    toggleInvisibleMode() {
        if (!this.isInvisibleMode && this.pendingDocumentUpdates.size > 0) {
            void vscode.window.showErrorMessage(
                vscode.l10n.t('Wait for pending realtime document saves before enabling Invisible Mode.'),
            );
            return;
        }
        this.socket.toggleAlternativeConnectionScheme(this.origin.toString(), this.root);
        this.socket.disconnect(); // jump to `onDisconnected` handler
    }

    async _resolveUri(uri: vscode.Uri) {
        // resolve path
        const [parentFolder, fileName] = await (async () => {
            const {pathParts} = parseUri(uri);
            const root = await this.init();

            let currentFolder = root.rootFolder[0];
            for (let i = 0; i < pathParts.length-1; i++) {
                const folderName = pathParts[i];
                const folder = currentFolder.folders.find((folder) => folder.name === folderName);
                if (folder) {
                    currentFolder = folder;
                } else {
                    throw vscode.FileSystemError.FileNotFound(uri);
                }
            }
            const fileName = pathParts[pathParts.length-1];
            return [currentFolder, fileName];
        })();
        // resolve file
        const [fileEntity, fileType, fileId] = (() => {
            for (const _type of Object.keys(FolderKeys)) {
                let entity = parentFolder[ FolderKeys[_type] ]?.find((entity) => entity.name === fileName);
                if (!fileName && _type==='folder') { entity = parentFolder; }
                if (entity) {
                    return [entity, _type as FileType, entity._id];
                }
            }
            return [];
        })();
        return {parentFolder, fileName, fileEntity, fileType, fileId};
    }

    private resolveUriInProject(project: ProjectEntity, uri: vscode.Uri) {
        const {pathParts} = parseUri(uri);
        let parentFolder = project.rootFolder[0];
        if (!parentFolder) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        for (const folderName of pathParts.slice(0, -1)) {
            const child = parentFolder.folders.find(folder => folder.name === folderName);
            if (!child) {
                throw vscode.FileSystemError.FileNotFound(uri);
            }
            parentFolder = child;
        }
        const fileName = pathParts.at(-1) ?? '';
        for (const candidateType of Object.keys(FolderKeys)) {
            const fileEntity = parentFolder[FolderKeys[candidateType]]?.find(
                entity => entity.name === fileName,
            );
            if (fileEntity) {
                return {
                    parentFolder,
                    fileName,
                    fileEntity,
                    fileType: candidateType as FileType,
                };
            }
        }
        return {parentFolder, fileName, fileEntity: undefined, fileType: undefined};
    }

    _resolveById(entityId: string, root?: FolderEntity, path?:string):{
        parentFolder: FolderEntity, fileEntity: FileEntity, fileType:FileType, path:string
    } | undefined {
        const project = this.root ?? this.joiningProject;
        if (!project) {
            return undefined;
        }
        root = root || project.rootFolder[0];
        path = path || '/';

        if (root._id === entityId) {
            return {parentFolder: root, fileType: 'folder', fileEntity: root, path};
        } else {
            // search files in root
            for (const _type of Object.keys(FolderKeys)) {
                const key = FolderKeys[_type];
                if (key==='folders') { continue; }
                const entity = root[key]?.find((entity) => entity._id === entityId);
                if (entity) {
                    return {parentFolder: root, fileType: _type as FileType, fileEntity: entity, path:path+entity.name};
                }
            }
            // recursive search
            for (const folder of root.folders) {
                const res = this._resolveById(entityId, folder, path+folder.name+'/');
                if (res) { return res; }
            }
        }
        return undefined;
    }

    walk(filter:(entity:FileEntity)=>boolean): {entity:FileEntity, path:string}[] {
        const result: {entity:FileEntity, path:string}[] = [];
        const folders = this.root ? [{entity:this.root.rootFolder[0], path:'/'}] : [];
        if (folders.length === 0) { return result; }

        // apply filter to root folder
        filter(folders[0].entity) && result.push(folders[0]);
        // walk through all folders
        for (const folder of folders) {
            for (const [key,value] of Object.entries(FolderKeys)) {
                if (value==='folders') {
                    folder.entity[value]?.forEach((entity) => {
                        folders.push({entity, path:folder.path+entity.name+'/'});
                    });
                }
                folder.entity[value]?.forEach((entity) => {
                    entity._type = key as FileType;
                    filter(entity) && result.push({ entity, path:folder.path+entity.name });
                });
            };
        }

        return result;
    }

    private insertEntity(parentFolder: FolderEntity, fileType:FileType, entity: FileEntity) {
        const key = FolderKeys[fileType];
        const index = parentFolder[key]?.findIndex((e) => e._id === entity._id);
        if (index===undefined || index<0) {
            parentFolder[key]?.push(entity as any);
        }
    }

    private removeEntity(parentFolder: FolderEntity, fileType:FileType, entity: FileEntity) {
        const key = FolderKeys[fileType];
        const index = parentFolder[key]?.findIndex((e) => e._id === entity._id);
        if (index!==undefined && index>=0) {
            parentFolder[key]?.splice(index, 1);
            return true;
        } else {
            return false;
        }
    }

    private removeEntityById(parentFolder: FolderEntity, fileType:FileType, entityId: string, recursive?:boolean) {
        const key = FolderKeys[fileType];
        const index = parentFolder[key]?.findIndex((e) => e._id === entityId);
        if (index!==undefined && index>=0) {
            parentFolder[key]?.splice(index, 1);
            return true;
        } else {
            return false;
        }
    }

    private mutationError(action: string, message?: string): vscode.FileSystemError {
        const detail = message?.trim();
        return vscode.FileSystemError.Unavailable(detail ? `${action}: ${detail}` : `${action} failed`);
    }

    private isCreatedEntity(
        entity: FileEntity | undefined,
        allowedTypes: FileType[],
    ): entity is FileEntity & {_type: FileType} {
        return Boolean(
            entity &&
            typeof entity._id === 'string' &&
            entity._id.length > 0 &&
            entity._type &&
            allowedTypes.includes(entity._type),
        );
    }

    private resolveCachedEntity(entityId: string, root?: FolderEntity, path = '/'):{
        parentFolder: FolderEntity,
        fileEntity: FileEntity,
        fileType: FileType,
        path: string,
    } | undefined {
        const projectRoot = root ?? (this.root ?? this.joiningProject)?.rootFolder[0];
        if (!projectRoot) { return undefined; }
        if (projectRoot._id === entityId) {
            return {
                parentFolder: projectRoot,
                fileEntity: projectRoot,
                fileType: 'folder',
                path,
            };
        }

        for (const [type, key] of Object.entries(FolderKeys)) {
            const entity = projectRoot[key]?.find(candidate => candidate._id === entityId);
            if (entity) {
                return {
                    parentFolder: projectRoot,
                    fileEntity: entity,
                    fileType: type as FileType,
                    path: path + entity.name,
                };
            }
        }
        for (const folder of projectRoot.folders) {
            const resolved = this.resolveCachedEntity(entityId, folder, path + folder.name + '/');
            if (resolved) { return resolved; }
        }
        return undefined;
    }

    private cachedEntityIsAt(entityId: string, parentFolderId: string, name: string): boolean {
        const current = this.resolveCachedEntity(entityId);
        return Boolean(
            current &&
            current.parentFolder._id === parentFolderId &&
            current.fileEntity.name === name,
        );
    }

    private cachedChildAt(parentFolderId: string, name: string, allowedTypes: FileType[]) {
        const parent = this.resolveCachedEntity(parentFolderId);
        if (parent?.fileType !== 'folder') { return undefined; }
        const folder = parent.fileEntity as FolderEntity;
        for (const fileType of allowedTypes) {
            const entity = folder[FolderKeys[fileType]]?.find(candidate => candidate.name === name);
            if (entity) { return {fileType, entity}; }
        }
        return undefined;
    }

    private async cachedFileMatches(
        uri: vscode.Uri,
        parentFolderId: string,
        name: string,
        allowedTypes: FileType[],
        expectedContent: Uint8Array,
    ): Promise<boolean> {
        if (!this.isReady || !this.cachedChildAt(parentFolderId, name, allowedTypes)) {
            return false;
        }
        try {
            const actualContent = await this.openFile(uri);
            return Buffer.from(actualContent).equals(Buffer.from(expectedContent));
        } catch {
            return false;
        }
    }

    private async currentFolder(folderId: string, action: string): Promise<FolderEntity> {
        await this.init();
        const current = this.resolveCachedEntity(folderId);
        if (current?.fileType !== 'folder') {
            throw this.mutationError(action, 'The destination folder is no longer available');
        }
        return current.fileEntity as FolderEntity;
    }

    private reconcileEntityLocation(
        fileType: FileType,
        fallbackEntity: FileEntity,
        targetFolder: FolderEntity,
        name: string,
        fallbackUri: vscode.Uri,
    ): vscode.FileChangeEvent[] {
        const current = this.resolveCachedEntity(fallbackEntity._id);
        const currentUri = current ? this.pathToUri(current.path) : undefined;
        const entity = current?.fileEntity ?? fallbackEntity;
        if (current) {
            this.removeEntity(current.parentFolder, current.fileType, entity);
        }

        const currentTarget = this._resolveById(targetFolder._id);
        const resolvedTarget = currentTarget?.fileType === 'folder' ?
            currentTarget.fileEntity as FolderEntity : targetFolder;
        entity.name = name;
        this.insertEntity(resolvedTarget, fileType, entity);

        const updated = this.resolveCachedEntity(entity._id);
        const updatedUri = updated ? this.pathToUri(updated.path) : fallbackUri;
        if (currentUri?.toString() === updatedUri.toString()) {
            return [];
        }
        return [
            ...(currentUri ? [{type: vscode.FileChangeType.Deleted, uri: currentUri}] : []),
            {type: vscode.FileChangeType.Created, uri: updatedUri},
        ];
    }

    private normalizeRealtimeTextOperations(update: UpdateSchema): TextOperation[] {
        if (!Array.isArray(update.op)) {
            throw new Error('Realtime update has no text operation');
        }
        return update.op.map(operation => {
            if (!isPlainObject(operation)
                || !Number.isInteger(operation.p)
                || (operation.p as number) < 0) {
                throw new Error('Malformed realtime text operation');
            }
            if (typeof operation.i === 'string'
                && operation.i.length > 0
                && operation.d === undefined) {
                return {p: operation.p, i: operation.i};
            }
            if (typeof operation.d === 'string'
                && operation.d.length > 0
                && operation.i === undefined) {
                return {
                    p: operation.p,
                    d: Buffer.from(operation.d, 'ascii').toString('utf-8'),
                };
            }
            throw new Error('Malformed realtime text operation');
        });
    }

    private snapshotReceivedDocumentUpdate(
        update: unknown,
        sender?: ProjectSenderWitness,
    ): ReceivedDocumentUpdate {
        if (!isPlainObject(update)) {
            return {update, sender: sender ? {...sender} : undefined};
        }
        const snapshot: {[key: string]: unknown} = {...update};
        if (Array.isArray(update.op)) {
            snapshot.op = update.op.map(operation =>
                isPlainObject(operation) ? {...operation} : operation
            );
        }
        return {
            update: snapshot,
            sender: sender ? {...sender} : undefined,
        };
    }

    private sameTextOperations(left: TextOperation[], right: TextOperation[]): boolean {
        return left.length === right.length && left.every((operation, index) => {
            const other = right[index];
            return operation.p === other.p
                && operation.i === other.i
                && operation.d === other.d;
        });
    }

    private prepareDocumentJoin(
        docId: string,
        response: unknown,
        receivedUpdates: readonly ReceivedDocumentUpdate[],
    ): PreparedDocumentJoin {
        if (!isPlainObject(response)
            || !Array.isArray(response.docLines)
            || !response.docLines.every(line => typeof line === 'string')
            || !isNonnegativeSafeInteger(response.version)
            || !Array.isArray(response.updates)) {
            throw new Error('Document join response has an invalid snapshot');
        }
        if (response.updates.length !== 0) {
            throw new Error('Document join response contains unexpected catch-up operations');
        }

        const anchorVersion = response.version;
        const anchorContent = response.docLines.join('\n');
        const normalized = receivedUpdates.map((received, index) => {
            const update = received.update;
            if (!isPlainObject(update)
                || !isNonnegativeSafeInteger(update.v)) {
                throw new Error(`Document join update ${index} has an invalid revision`);
            }
            if (update.doc !== docId) {
                throw new Error(`Document join update ${index} has an invalid document identity`);
            }
            if (update.v < anchorVersion) {
                throw new Error(`Document join update ${index} predates its snapshot revision`);
            }
            if (update.op === undefined) {
                return {version: update.v, operations: undefined};
            }
            if (!Array.isArray(update.op)) {
                throw new Error(`Document join update ${index} has a malformed operation`);
            }
            const operations = this.normalizeRealtimeTextOperations({
                ...update,
                doc: docId,
                v: update.v,
                op: update.op,
            } as UpdateSchema);
            return {version: update.v, operations};
        });

        const uniqueUpdates = new Map<number, TextOperation[]>();
        for (const update of normalized) {
            if (update.operations === undefined) {
                throw new Error('Document join contains an unproven sender confirmation');
            }
            const duplicate = uniqueUpdates.get(update.version);
            if (duplicate) {
                if (!this.sameTextOperations(duplicate, update.operations)) {
                    throw new Error('Document join contains conflicting duplicate revisions');
                }
                continue;
            }
            uniqueUpdates.set(
                update.version,
                update.operations.map(operation => ({...operation})),
            );
        }

        let headVersion = anchorVersion;
        let headContent = anchorContent;
        const causalUpdates = new Map<number, TextOperation[]>();
        const revisions = [...uniqueUpdates.keys()].sort(
            (left, right) => left - right,
        );
        for (const revision of revisions) {
            if (revision !== headVersion) {
                throw new Error('Document join catch-up revisions are not contiguous');
            }
            if (!isNonnegativeSafeInteger(headVersion + 1)) {
                throw new Error('Document join catch-up exceeds the safe revision range');
            }
            const operations = uniqueUpdates.get(revision)!;
            headContent = applyTextOperations(headContent, operations);
            causalUpdates.set(
                revision,
                operations.map(operation => ({...operation})),
            );
            headVersion += 1;
        }

        return {
            anchorVersion,
            anchorContent,
            headVersion,
            headContent,
            updates: causalUpdates,
        };
    }

    private prepareLiveRemoteEditorUpdate(
        docId: string,
        remoteVersion: number,
        remoteContent: string,
        operations: TextOperation[],
    ): PreparedLiveRemoteEditorUpdate | undefined {
        const candidates = [...this.activeEditorBases.entries()].filter(([bufferId, active]) => {
            const buffer = this.editorBuffers.get(bufferId);
            return active.identity.docId === docId
                && buffer !== undefined
                && this.bufferMatchesIncarnation(buffer);
        });
        if (candidates.length === 0) { return undefined; }
        if (candidates.length !== 1) {
            candidates.forEach(([, active]) => { active.causality.valid = false; });
            return undefined;
        }
        const [bufferId, active] = candidates[0];
        const buffer = this.editorBuffers.get(bufferId)!;
        const sender = this.currentSenderWitness();
        const pendingSubmission = this.pendingDocumentUpdates.get(bufferId);
        const submissionMatches = pendingSubmission ?
            active.causality.inflightToken === pendingSubmission.submissionToken
                && active.causality.inflightWire !== undefined
                && this.sameTextOperations(
                    active.causality.inflightWire,
                    pendingSubmission.update.op ?? [],
                ) : active.causality.inflightWire === undefined
                && active.causality.inflightToken === undefined;
        if (!sender
            || this.remoteEditorTransactionMap().has(bufferId)
            || !submissionMatches
            || !active.causality.valid
            || active.causality.socketGeneration !== sender.generation
            || active.causality.remoteVersion !== remoteVersion
            || active.causality.remoteContent !== remoteContent
            || active.causality.documentVersion !== buffer.document.version
            || active.causality.editorContent !== buffer.document.getText()) {
            active.causality.valid = false;
            return undefined;
        }
        try {
            const transaction = prepareRemoteEditorTransaction(
                active.causality,
                randomUUID(),
                remoteVersion,
                operations,
            );
            if (!buffer.document.isDirty && transaction.expectedChange !== undefined) {
                // A provider change notification lets VS Code refresh a clean
                // document without manufacturing a local dirty edit. Until the
                // host adopts that refresh, the old editor base is no longer a
                // causal authority for saving.
                active.causality.valid = false;
                return undefined;
            }
            return {
                bufferId,
                document: buffer.document,
                active,
                transaction,
            };
        } catch {
            active.causality.valid = false;
            return undefined;
        }
    }

    private commitMetadataOnlyRemoteEditorUpdate(
        prepared: PreparedLiveRemoteEditorUpdate,
    ): boolean {
        const {active, bufferId, document, transaction} = prepared;
        const buffer = this.editorBuffers.get(bufferId);
        if (transaction.expectedChange !== undefined
            || buffer?.document !== document
            || !this.bufferMatchesIncarnation(buffer)
            || this.activeEditorBases.get(bufferId) !== active) {
            active.causality.valid = false;
            return false;
        }
        const next = commitRemoteEditorTransaction(
            active.causality,
            transaction,
            document.version,
            [],
            document.getText(),
        );
        active.causality = next;
        if (!next.valid) { return false; }
        active.version = next.remoteVersion;
        active.content = next.remoteContent;
        active.recordName = undefined;
        active.persistence = undefined;
        return true;
    }

    private async applyPreparedRemoteEditorUpdate(
        prepared: PreparedLiveRemoteEditorUpdate,
    ): Promise<boolean> {
        const {active, bufferId, document, transaction} = prepared;
        if (!transaction.expectedChange) {
            return this.commitMetadataOnlyRemoteEditorUpdate(prepared);
        }
        const buffer = this.editorBuffers.get(bufferId);
        const sender = this.currentSenderWitness();
        if (buffer?.document !== document
            || !this.bufferMatchesIncarnation(buffer)
            || this.activeEditorBases.get(bufferId) !== active
            || document.version !== transaction.beforeDocumentVersion
            || document.getText() !== transaction.beforeEditorContent
            || sender?.generation !== transaction.socketGeneration) {
            active.causality.valid = false;
            return false;
        }

        const pending: PendingRemoteEditorTransaction = {
            document,
            active,
            transaction,
            consumed: false,
        };
        this.remoteEditorTransactionMap().set(bufferId, pending);
        const edit = new vscode.WorkspaceEdit();
        const change = transaction.expectedChange;
        edit.replace(
            document.uri,
            new vscode.Range(
                document.positionAt(change.rangeOffset),
                document.positionAt(change.rangeOffset + change.rangeLength),
            ),
            change.text,
        );
        let applied = false;
        try {
            applied = await vscode.workspace.applyEdit(edit);
        } catch (error) {
            console.warn('Unable to apply a witnessed Overleaf collaborator edit', error);
        }
        if (this.remoteEditorTransactionMap().get(bufferId) === pending) {
            this.remoteEditorTransactionMap().delete(bufferId);
        }
        const committed = applied
            && pending.consumed
            && active.causality.valid
            && active.causality.remoteVersion === transaction.baseRemoteVersion + 1
            && active.causality.remoteContent === transaction.nextRemoteContent
            && active.causality.editorContent === transaction.nextEditorContent
            && document.getText() === transaction.nextEditorContent;
        if (!committed) {
            active.causality.valid = false;
        }
        return committed;
    }

    private async applyDocumentUpdate(update: UpdateSchema, eventSender?: ProjectSenderWitness) {
        const res = this._resolveById(update.doc);
        if (res===undefined) { return; }

        const doc = res.fileEntity as DocumentEntity;
        const currentSender = this.currentSenderWitness();
        if (!currentSender
            || eventSender?.publicId !== currentSender.publicId
            || eventSender.generation !== currentSender.generation) {
            this.invalidateDocumentSession(
                doc._id,
                new Error('Document update belongs to an unproven realtime generation'),
            );
            return;
        }
        if (!isNonnegativeSafeInteger(update.v)) {
            this.invalidateDocumentSession(
                doc._id,
                new Error('Document update has an invalid revision'),
            );
            return;
        }
        if (doc.version !== undefined && !isNonnegativeSafeInteger(doc.version)) {
            this.invalidateDocumentSession(
                doc._id,
                new Error('Document session has an invalid revision'),
            );
            return;
        }
        const senderConfirmation = isSenderConfirmation(update);
        let confirmedPending: PendingDocumentUpdate | undefined;
        if (senderConfirmation) {
            const sender = this.currentSenderWitness();
            const matchingPending = [...this.pendingDocumentUpdates.values()].filter(pending =>
                pending.docId === update.doc
                && update.v >= pending.update.v
                && pending.socketGeneration === sender?.generation
                && pending.submittedPublicIds.includes(sender?.publicId ?? '')
            );
            if (!sender
                || eventSender?.publicId !== sender.publicId
                || eventSender.generation !== sender.generation
                || matchingPending.length !== 1) {
                this.invalidateDocumentSession(
                    update.doc,
                    new Error('Unproven sender confirmation for a document update'),
                );
                return;
            }
            confirmedPending = matchingPending[0];
        }
        if (doc.version === undefined) {
            doc.remoteCache = undefined;
            doc.lastVersion = undefined;
            this.rejectDocumentVersionWaiters(doc._id, new Error('Document update arrived without an active session'));
            return;
        }
        if (update.v < doc.version) {
            // The update is already represented by a newer joinDoc snapshot.
            if (senderConfirmation) {
                this.resolveDocumentVersionWaiters(doc._id, update.v);
                return;
            }
            const ledger = this.remoteDocumentCausality.get(doc._id);
            if (!ledger
                || !ledger.valid
                || ledger.socketGeneration !== this.socket.generation
                || ledger.headVersion !== doc.version
                || ledger.headContent !== doc.remoteCache) {
                this.invalidateDocumentSession(
                    doc._id,
                    new Error('A stale document update has no exact causal epoch'),
                );
                return;
            }
            if (update.v < ledger.anchorVersion) {
                return;
            }
            let duplicate: TextOperation[];
            try {
                duplicate = this.normalizeRealtimeTextOperations(update);
            } catch (error) {
                this.invalidateDocumentSession(
                    doc._id,
                    error instanceof Error ? error : new Error(String(error)),
                );
                return;
            }
            const recorded = ledger.updates.get(update.v);
            if (!recorded || !this.sameTextOperations(recorded, duplicate)) {
                this.invalidateDocumentSession(
                    doc._id,
                    new Error('Conflicting operations were observed for one document revision'),
                );
            }
            return;
        }
        if (update.v > doc.version) {
            this.invalidateRemoteCausality(doc._id);
            doc.remoteCache = undefined;
            doc.version = undefined;
            doc.lastVersion = undefined;
            this.rejectDocumentVersionWaiters(doc._id, new Error('Document version changed unexpectedly'));
            return;
        }

        if (!isNonnegativeSafeInteger(doc.version + 1)) {
            this.invalidateDocumentSession(
                doc._id,
                new Error('Document update exceeds the safe revision range'),
            );
            return;
        }
        const beforeVersion = doc.version;
        const beforeContent = doc.remoteCache;
        if (senderConfirmation) {
            const pending = confirmedPending!;
            const active = this.activeEditorBases.get(pending.bufferId);
            const buffer = this.editorBuffers.get(pending.bufferId);
            const inflightView = active?.causality.inflightView?.map(operation => ({...operation}));
            const bridgeMatches = beforeContent !== undefined
                && active !== undefined
                && buffer !== undefined
                && this.bufferMatchesIncarnation(buffer)
                && active.identity.docId === doc._id
                && active.causality.valid
                && active.causality.remoteVersion === beforeVersion
                && active.causality.remoteContent === beforeContent
                && active.causality.documentVersion === buffer.document.version
                && active.causality.editorContent === buffer.document.getText()
                && active.causality.inflightToken === pending.submissionToken
                && active.causality.inflightWire !== undefined
                && this.sameTextOperations(
                    active.causality.inflightWire,
                    pending.update.op ?? [],
                )
                && inflightView !== undefined;
            if (bridgeMatches) {
                const next = confirmLocalEditorSubmission(
                    active!.causality,
                    pending.submissionToken,
                    beforeVersion,
                    pending.update.op ?? [],
                );
                if (next.valid) {
                    const ledger = this.remoteDocumentCausality.get(doc._id);
                    if (ledger?.valid) {
                        if (ledger.socketGeneration !== this.socket.generation
                            || ledger.headVersion !== beforeVersion
                            || ledger.headContent !== beforeContent
                            || ledger.updates.has(beforeVersion)) {
                            ledger.valid = false;
                        } else {
                            ledger.updates.set(beforeVersion, inflightView!);
                            ledger.headVersion = beforeVersion + 1;
                            ledger.headContent = next.remoteContent;
                        }
                    }
                    active!.causality = next;
                    active!.version = next.remoteVersion;
                    active!.content = next.remoteContent;
                    doc.version = next.remoteVersion;
                    doc.remoteCache = next.remoteContent;
                    if (next.localOperations.length === 0
                        && buffer!.document.getText() === next.remoteContent) {
                        doc.localCache = next.remoteContent;
                    }
                    this.markSourceDirty();
                    this.resolveDocumentVersionWaiters(doc._id, update.v);
                    return;
                }
            }

            // The ACK proves that the pending operation committed, but without
            // an exact live bridge it cannot reveal the transformed text. Force
            // the save path to reconcile from a fresh authoritative snapshot.
            if (active) { active.causality.valid = false; }
            this.invalidateRemoteCausality(doc._id);
            doc.version = undefined;
            doc.remoteCache = undefined;
            doc.lastVersion = undefined;
            this.resolveDocumentVersionWaiters(doc._id, update.v);
            return;
        }
        doc.version += 1;
        if (update.op && beforeContent !== undefined) {
            let operations: TextOperation[];
            let content: string;
            let preparedLiveUpdate: PreparedLiveRemoteEditorUpdate | undefined;
            try {
                operations = this.normalizeRealtimeTextOperations(update);
                content = applyTextOperations(beforeContent, operations);
                preparedLiveUpdate = this.prepareLiveRemoteEditorUpdate(
                    doc._id,
                    beforeVersion,
                    beforeContent,
                    operations,
                );
            } catch (error) {
                this.invalidateDocumentSession(
                    doc._id,
                    error instanceof Error ? error : new Error(String(error)),
                );
                return;
            }
            const ledger = this.remoteDocumentCausality.get(doc._id);
            if (ledger?.valid) {
                if (ledger.socketGeneration !== this.socket.generation
                    || ledger.headVersion !== beforeVersion
                    || ledger.headContent !== beforeContent
                    || ledger.updates.has(beforeVersion)) {
                    ledger.valid = false;
                } else {
                    ledger.updates.set(
                        beforeVersion,
                        operations.map(operation => ({...operation})),
                    );
                    ledger.headVersion = beforeVersion + 1;
                    ledger.headContent = content;
                }
            }
            const _uri = this.pathToUri(res.path).toString();
            const _doc = vscode.workspace.textDocuments.find((doc) => doc.uri.toString()===_uri);
            doc.remoteCache = content;
            const appliedToLiveEditor = preparedLiveUpdate ?
                await this.applyPreparedRemoteEditorUpdate(preparedLiveUpdate) : false;
            if (appliedToLiveEditor
                && preparedLiveUpdate?.active.causality.localOperations.length === 0) {
                doc.localCache = content;
            } else if (!preparedLiveUpdate && _doc && !_doc.isDirty) {
                // A clean unbound document may be refreshed by the provider
                // notification. A dirty or failed bridge is never overwritten.
                doc.localCache = content;
            }
            this.markSourceDirty();
            this.notify([
                {type: vscode.FileChangeType.Changed, uri: this.pathToUri(res.path)}
            ]);
        }
    }

    private queueDocumentUpdate(update: UpdateSchema, sender?: ProjectSenderWitness) {
        const queues = this.remoteUpdateQueueMap();
        const previous = queues.get(update.doc);
        const applyIfCurrent = () => {
            const current = this.currentSenderWitness();
            if (!sender
                || current?.publicId !== sender.publicId
                || current.generation !== sender.generation) {
                return Promise.resolve();
            }
            return this.applyDocumentUpdate(update, sender);
        };
        const operation = previous ? previous.catch(() => {}).then(
            applyIfCurrent,
        ) : applyIfCurrent();
        let queued!: Promise<void>;
        queued = operation.catch(error => {
            this.invalidateDocumentSession(
                update.doc,
                error instanceof Error ? error : new Error(String(error)),
            );
        }).finally(() => {
            if (queues.get(update.doc) === queued) {
                queues.delete(update.doc);
            }
        });
        queues.set(update.doc, queued);
    }

    private remoteWatch(): void {
        this.socket.updateEventHandlers({
            onDisconnected: () => {
                console.log("Disconnected");
                if (this.disposed) { return; }
                // A constructor-only prefetch is not an active project session.
                // Do not let its first disconnect trigger project initialization,
                // retries, and user-facing connection-loss notifications.
                if (!this.connectionRequested && !this.initializing && !this.hasCompletedInitialConnection) {
                    return;
                }
                if (this.root) {
                    this.previousRoot = this.root;
                }
                this.invalidateDocumentSessions(this.previousRoot);
                this.root = undefined;
                this.joiningProject = undefined;
                this.publicId = undefined;
                this.permissionsLevel = undefined;
                this.protocolVersion = undefined;
                // Gate filesystem operations immediately. The shared initialization
                // task waits for transport reconnect and then joins the project.
                void this.startInitialization(true).catch(() => {});
            },
            onConnectionAccepted: (publicId:string) => {
                if (this.disposed) { return; }
                // connectionAccepted is transport-level only. Project readiness is
                // established exclusively by connectWithRetry after joinProject.
                this.publicId = publicId;
                this.clientManagerItem?.manager.updatePublicId(publicId);
            },
            onProjectJoined: (session: ProjectSessionSchema) => {
                if (this.disposed) { return; }
                this.publicId = session.publicId;
                this.permissionsLevel = session.permissionsLevel;
                this.protocolVersion = session.protocolVersion;
                this.clientManagerItem?.manager.updatePublicId(session.publicId);
            },
            onOtUpdateError: (error: OtUpdateErrorSchema) => {
                this.handleOtUpdateError(error);
            },
            onFatalError: (error: RealtimeFatalError) => {
                this.handleFatalRealtime(error);
            },
            onFileCreated: (parentFolderId:string, type:FileType, entity:FileEntity) => {
                const res = this._resolveById(parentFolderId);
                if (res) {
                    const {fileEntity,path} = res;
                    const entityPath = path + entity.name;
                    this.insertEntity(fileEntity as FolderEntity, type, entity);
                    this.markSourceDirty();
                    this.notify([
                        {type: vscode.FileChangeType.Created, uri: this.pathToUri(entityPath)}
                    ]);
                }
            },
            onFileRenamed: (entityId:string, newName:string) => {
                const res = this._resolveById(entityId);
                if (res) {
                    const {fileEntity} = res;
                    const oldName = fileEntity.name;
                    if (oldName === newName) { return; }
                    fileEntity.name = newName;
                    this.markSourceDirty();
                    this.notify([
                        {type: vscode.FileChangeType.Deleted, uri: this.pathToUri(res.path)},
                        {type: vscode.FileChangeType.Created, uri: this.pathToUri(res.path.replace(oldName, newName))}
                    ]);
                }
            },
            onFileRemoved: (entityId:string) => {
                const res = this._resolveById(entityId);
                if (res) {
                    const {parentFolder, fileType, fileEntity} = res;
                    this.removeEntity(parentFolder, fileType, fileEntity);
                    this.markSourceDirty();
                    this.notify([
                        {type: vscode.FileChangeType.Deleted, uri: this.pathToUri(res.path)}
                    ]);
                }
            },
            onFileMoved: (entityId:string, folderId:string) => {
                const oldPath = this._resolveById(entityId);
                const newPath = this._resolveById(folderId);
                if (oldPath && newPath) {
                    const newParentFolder = newPath.fileEntity as FolderEntity;
                    if (oldPath.parentFolder._id === newParentFolder._id) { return; }
                    this.removeEntity(oldPath.parentFolder, oldPath.fileType, oldPath.fileEntity);
                    this.insertEntity(newParentFolder, oldPath.fileType, oldPath.fileEntity);
                    this.markSourceDirty();
                    this.notify([
                        {type: vscode.FileChangeType.Deleted, uri: this.pathToUri(oldPath.path)},
                        {type: vscode.FileChangeType.Created, uri: this.pathToUri(newPath.path, oldPath.fileEntity.name)}
                    ]);
                }
            },
            onFileChanged: (update:UpdateSchema, sender?: ProjectSenderWitness) => {
                if (!isPlainObject(update) || typeof update.doc !== 'string') {
                    const error = new Error('Realtime document update has no valid document identity');
                    this.joiningDocuments.forEach(joining => {
                        joining.invalid = error;
                    });
                    this.invalidateDocumentSessions(this.root);
                    return;
                }
                const joining = this.joiningDocuments.get(update.doc);
                if (joining && joining.generation === this.socket.generation) {
                    joining.updates.push(this.snapshotReceivedDocumentUpdate(update, sender));
                    return;
                }
                this.queueDocumentUpdate(update, sender);
            },
            onSpellCheckLanguageUpdated: (language:string) => {
                if (this.root) {
                    this.root.spellCheckLanguage = language;
                    EventBus.fire('spellCheckLanguageUpdateEvent', {language});
                }
            },
            onCompilerUpdated: (compiler:string) => {
                if (this.root) {
                    this.root.compiler = compiler;
                    EventBus.fire('compilerUpdateEvent', {compiler});
                }
            },
            onRootDocUpdated: (rootDocId:string) => {
                //NOTE: do not sync rootDocId
                // if (this.root) {
                //     this.root.rootDoc_id = rootDocId;
                //     EventBus.fire('rootDocUpdateEvent', {rootDocId});
                // }
            },
        });
    }

    pathToUri(...path: string[]): vscode.Uri {
        return vscode.Uri.joinPath(this.origin, ...path);
    }

    async resolve(uri: vscode.Uri): Promise<File> {
        const {fileName, fileEntity, fileType} = await this._resolveUri(uri);
        const readonly = fileEntity?.readonly || this.isProjectReadOnly() ?
            vscode.FilePermission.Readonly : undefined;
        switch (fileType) {
            case undefined:
                throw vscode.FileSystemError.FileNotFound(uri);
            case 'folder':
                return new File(fileName, vscode.FileType.Directory, undefined, readonly);
            case 'file':
                if ((fileEntity as FileRefEntity).linkedFileData!==null) {
                    return new File(fileName, vscode.FileType.File | vscode.FileType.SymbolicLink, Date.parse((fileEntity as FileRefEntity).created), readonly);
                } else {
                    return new File(fileName, vscode.FileType.File, Date.parse((fileEntity as FileRefEntity).created), readonly);
                }
            default:
                return new File(fileName, vscode.FileType.File, undefined, readonly);
        }
    }

    async list(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        const {fileEntity} = await this._resolveUri(uri);
        const folder = fileEntity as FolderEntity;
        let results:[string, vscode.FileType][] = [];
        if (folder) {
            Object.values(FolderKeys).forEach((key) => {
                const _type = key==='folders'? vscode.FileType.Directory : vscode.FileType.File;
                folder[key]?.forEach((entity) => {
                    results.push([entity.name, _type]);
                });
            });
        }
        return results;
    }

    async openFile(uri: vscode.Uri): Promise<Uint8Array> {
        const {fileType, fileEntity} = await this._resolveUri(uri);
        if (!fileEntity) {
            throw vscode.FileSystemError.FileNotFound();
        }

        if (fileType==='doc') {
            const doc = fileEntity as DocumentEntity;
            if (doc.remoteCache!==undefined) {
                const content = doc.remoteCache;
                this.stageProviderRead(uri, doc, content);
                EventBus.fire('fileWillOpenEvent', {uri});
                return new TextEncoder().encode(content);
            } else {
                const {doc: joinedDoc, content} = await this.ensureDocumentSession(doc._id);
                this.stageProviderRead(uri, joinedDoc, content);
                EventBus.fire('fileWillOpenEvent', {uri});
                return new TextEncoder().encode(content);
            }
        } else if (fileType==='outputs') {
            const output = fileEntity as OutputFileEntity;
            // Presence of compileRouting is significant even when every value
            // is undefined: it means this output belongs to a legacy/standard
            // route and must not inherit another build's CDN route.
            const routing = resolveCompileOutputRouting(output.compileRouting, {
                compileGroup: this.compileGroup,
                clsiServerId: this.clsiServerId,
                pdfDownloadDomain: this.pdfDownloadDomain,
            });
            return GlobalStateManager.authenticate(this.context, this.serverName)
            .then((identity) => {
                return this.api.getFileFromClsi(
                    identity,
                    output.url,
                    routing.compileGroup || 'standard',
                    routing.clsiServerId,
                    routing.pdfDownloadDomain,
                )
                .then((res) => {
                    if (res.type==='success') {
                        EventBus.fire('fileWillOpenEvent', {uri});
                        return res.content;
                    } else {
                        return new Uint8Array(0);
                    }
                });
            });
        } else {
            const fileId = fileEntity._id;
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            const res = await this.api.getFile(identity, this.projectId, fileId);
            if (res.type==='success' && res.content) {
                EventBus.fire('fileWillOpenEvent', {uri});
                return res.content;
            } else {
                return new Uint8Array(0);
            }
        }
    }

    async createFile(
        _uri: vscode.Uri,
        _content: Uint8Array,
        _overwrite?: boolean,
    ): Promise<void> {
        throw vscode.FileSystemError.Unavailable(
            vscode.l10n.t(
                'Direct remote file creation is disabled because no safe atomic creation contract is available.',
            ),
        );
    }

    async refreshLinkedFile(uri: vscode.Uri) {
        await this.assertProjectWritable('Unable to refresh linked file');
        const {fileType, fileEntity} = await this._resolveUri(uri);
        if (fileType==='file' && fileEntity) {
            if ((fileEntity as FileRefEntity).linkedFileData===null) { return; }

            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `${vscode.l10n.t('Refreshing')} ${fileEntity.name}`,
                cancellable: true,
            }, async (progress, token) => {
                token.onCancellationRequested(() => {});
                
                const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
                const res = await (this.api as ExtendedBaseAPI).refreshLinkedFile(identity, this.projectId, fileEntity._id);

                if (res.type==='success' && res.message!==undefined) {
                    // refresh the entity id
                    fileEntity._id = res.message;
                    this.markSourceDirty();
                    this.notify([
                        {type: vscode.FileChangeType.Changed, uri: uri},
                    ]);
                    progress.report({message: vscode.l10n.t('Done')});
                } else {
                    if (res.message!==undefined) {
                        throw new Error(res.message);
                    }
                }
            });
        }
    }

    async createLinkedFile(uri: vscode.Uri) {
        await this.assertProjectWritable('Unable to create linked file');
        const res = await this._resolveUri(uri);
        const parentFolder = res.fileType==='folder' ? res.fileEntity as FolderEntity : res.parentFolder;

        const supportedProviders = [
            vscode.l10n.t('From Another Project'),
            vscode.l10n.t('From External URL'),
        ];
        const selection = await vscode.window.showQuickPick(supportedProviders, {
            placeHolder: vscode.l10n.t('Import file from...'),
        });

        let provider = undefined, entityId = undefined, fileName = undefined, data = undefined;
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        if (selection === vscode.l10n.t('From Another Project')) {
            provider = 'project_file';
            const allTags = (await this.api.getAllTags(identity)).tags || [];
            const projectId = await vscode.window.showQuickPick(
                (await this.api.userProjectsJson(identity)).projects!
                .filter(project => project.id!==this.projectId)
                .map(project => {
                    let detail = '';
                    for (const tag of allTags) {
                        if (tag.project_ids.includes(project.id)) {
                            detail += `$(tag) ${tag.name} `;
                        }
                    }
                    return {label: project.name, id: project.id, detail};
                }),
                {
                    title: vscode.l10n.t('Select a Project'),
                    ignoreFocusOut: true,
                }
            );
            const filePath = projectId && await vscode.window.showQuickPick(
                (await this.api.projectEntitiesJson(identity, projectId!.id)).entities!.map(entity => entity.path),
                {
                    title: vscode.l10n.t('Select a File'),
                    ignoreFocusOut: true,
                }
            );
            fileName = filePath && await vscode.window.showInputBox({
                title: vscode.l10n.t('File Name In This Project'),
                value: filePath?.split('/').pop(),
                ignoreFocusOut: true,
                validateInput: (value) => {
                    if (value==='' || value===undefined || value.match(/^[^\/?%*:|"<>]+$/g)===null) {
                        return vscode.l10n.t('File name is empty or contains invalid characters');
                    } else if (parentFolder.fileRefs.find((fileRef) => fileRef.name===value) !== undefined) {
                        return vscode.l10n.t('A file or folder with this name already exists');
                    }
                }
            });
            //
            data = {source_entity_path: filePath!, source_project_id: projectId!.id};
            const res = await (this.api as ExtendedBaseAPI).createLinkedFile(identity, this.projectId, parentFolder._id, fileName!, provider, data);
            if (res.type==='success' && res.message!==undefined) {
                entityId = res.message;
            }
        } else if (selection === vscode.l10n.t('From External URL')) {
            provider = 'url';
            const url = await vscode.window.showInputBox({
                title: vscode.l10n.t('URL to fetch the file from'),
                placeHolder: 'https://example.com/my-file.png',
                ignoreFocusOut: true,
            });
            fileName = url && await vscode.window.showInputBox({
                title: vscode.l10n.t('File Name In This Project'),
                value: url?.split('/').pop(),
                ignoreFocusOut: true,
                validateInput: (value) => {
                    if (value==='' || value===undefined || value.match(/^[^\/?%*:|"<>]+$/g)===null) {
                        return vscode.l10n.t('File name is empty or contains invalid characters');
                    } else if (parentFolder.fileRefs.find((fileRef) => fileRef.name===value) !== undefined) {
                        return vscode.l10n.t('A file or folder with this name already exists');
                    }
                }
            });
            //
            data = {url:url!};
            const res = await (this.api as ExtendedBaseAPI).createLinkedFile(identity, this.projectId, parentFolder._id, fileName!, provider, data);
            if (res.type==='success' && res.message!==undefined) {
                entityId = res.message;
            }
        } else {
            return;
        }

        // insert entity
        const entity = {
            _id: entityId!, name: fileName!, _type: 'file', readonly: false,
            linkedFileData: { provider, ...data! },
            created: new Date().toISOString(),
        } as FileRefEntity;
        this.insertEntity(parentFolder, 'file', entity);
        this.markSourceDirty();
        const {path} = this._resolveById(entityId!)!;
        this.notify([
            {type: vscode.FileChangeType.Created, uri: uri.with({path:`/${this.projectName}${path}`})},
        ]);
    }

    private currentDocument(docId: string): DocumentEntity {
        const resolved = this._resolveById(docId);
        if (!resolved || resolved.fileType !== 'doc') {
            throw vscode.FileSystemError.FileNotFound();
        }
        return resolved.fileEntity as DocumentEntity;
    }

    private async joinFreshDocumentSession(docId: string): Promise<{doc: DocumentEntity, content: string}> {
        const previous = this.documentJoinTasks.get(docId) ?? Promise.resolve(undefined);
        const task = previous.catch(() => undefined).then(() => this.performDocumentJoin(docId));
        this.documentJoinTasks.set(docId, task);
        try {
            return await task;
        } finally {
            if (this.documentJoinTasks.get(docId) === task) {
                this.documentJoinTasks.delete(docId);
            }
        }
    }

    private async performDocumentJoin(docId: string): Promise<{doc: DocumentEntity, content: string}> {
        // init() is a project-ready barrier. joinDoc then creates a fresh document
        // session for the current socket generation. The snapshot and every
        // catch-up packet are validated and replayed before any session state is
        // committed.
        await this.init();
        const connectionGeneration = await this.socket.waitUntilConnected();
        const joining: {
            generation: number,
            updates: ReceivedDocumentUpdate[],
            invalid?: Error,
        } = {generation: connectionGeneration, updates: []};
        this.joiningDocuments.set(docId, joining);
        try {
            const joiningSender = this.currentSenderWitness();
            if (!joiningSender || joiningSender.generation !== connectionGeneration) {
                throw new Error('Document join started without a current sender witness');
            }
            const response: unknown = await this.socket.joinDoc(docId);
            assertCurrentConnection(
                connectionGeneration,
                this.socket.generation,
                this.socket.isConnected,
            );
            // The project tree may have been replaced while the async join was in
            // progress. Commit session state only to the current entity generation.
            const doc = this.currentDocument(docId);
            const queuedUpdateCount = joining.updates.length;
            if (joining.invalid) { throw joining.invalid; }
            const prepared = this.prepareDocumentJoin(
                docId,
                response,
                joining.updates.slice(),
            );
            const sender = this.currentSenderWitness();
            assertCurrentConnection(
                connectionGeneration,
                this.socket.generation,
                this.socket.isConnected,
            );
            if (this.joiningDocuments.get(docId) !== joining
                || joining.updates.length !== queuedUpdateCount
                || this.currentDocument(docId) !== doc
                || joining.invalid
                || sender?.publicId !== joiningSender.publicId
                || sender.generation !== joiningSender.generation) {
                throw new Error('Document join authority changed before the causal state could be committed');
            }

            const ledger = this.startPreparedRemoteCausality(
                docId,
                prepared,
                connectionGeneration,
            );
            doc.version = prepared.headVersion;
            doc.remoteCache = prepared.headContent;
            doc.lastVersion = undefined;
            if (!ledger.valid
                || ledger.socketGeneration !== connectionGeneration
                || ledger.anchorVersion !== prepared.anchorVersion
                || ledger.headVersion !== doc.version
                || ledger.headContent !== doc.remoteCache
                || ledger.updates.size !== prepared.updates.size
                || [...prepared.updates].some(([version, operations]) => {
                    const recorded = ledger.updates.get(version);
                    return !recorded || !this.sameTextOperations(recorded, operations);
                })) {
                throw new Error('Document join replay does not match its authoritative causal witness');
            }
            this.joiningDocuments.delete(docId);
            if (prepared.headVersion !== prepared.anchorVersion) {
                this.markSourceDirty();
                const resolved = this._resolveById(docId);
                if (resolved) {
                    this.notify([{
                        type: vscode.FileChangeType.Changed,
                        uri: this.pathToUri(resolved.path),
                    }]);
                }
            }
            return {doc, content: prepared.headContent};
        } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            this.invalidateDocumentSession(docId, failure);
            throw failure;
        } finally {
            if (this.joiningDocuments.get(docId) === joining) {
                this.joiningDocuments.delete(docId);
            }
        }
    }

    private async ensureDocumentSession(docId: string): Promise<{doc: DocumentEntity, content: string}> {
        await this.init();
        const doc = this.currentDocument(docId);
        if (isNonnegativeSafeInteger(doc.version) && doc.remoteCache !== undefined) {
            return {doc, content: doc.remoteCache};
        }
        if (doc.version !== undefined || doc.remoteCache !== undefined) {
            this.invalidateDocumentSession(
                docId,
                new Error('Cached document session has an invalid revision or snapshot'),
            );
        }
        return this.joinFreshDocumentSession(docId);
    }

    async writeFile(uri: vscode.Uri, content:Uint8Array, create:boolean, overwrite:boolean) {
        if (this.matchesUnboundEditorSave(uri, content)) {
            this.blockDocumentWrite(
                uri,
                content,
                'this dirty editor was never bound to a remote document identity',
            );
        }
        await this.assertProjectWritable('Unable to write file');
        const resolved = await this._resolveUri(uri);
        const keys = [
            `path:${this.projectId}:${parseUri(uri).pathParts.join('/')}`,
            ...(resolved.fileType === 'doc' && resolved.fileEntity ?
                [`doc:${resolved.fileEntity._id}`] : []),
        ];
        const previous = [...new Set(
            keys.map(key => this.documentWrites.get(key)).filter(
                (value): value is Promise<void> => value !== undefined,
            ),
        )];
        const operation = Promise.all(previous.map(value => value.catch(() => {}))).then(
            () => this.writeFileNow(uri, content, create, overwrite),
        ).catch((error) => {
            if (error instanceof SocketRequestError && error.outcomeUnknown) {
                this.forceFreshConnection();
            }
            throw error;
        });
        keys.forEach(key => this.documentWrites.set(key, operation));
        try {
            await operation;
        } finally {
            keys.forEach(key => {
                if (this.documentWrites.get(key) === operation) {
                    this.documentWrites.delete(key);
                }
            });
        }
    }

    private forceFreshConnection() {
        if (this.freshConnectionRequested || this.socket.fatalError) { return; }
        this.freshConnectionRequested = true;
        if (this.root) {
            this.previousRoot = this.root;
        }
        this.invalidateDocumentSessions(this.previousRoot);
        this.root = undefined;
        this.socket.init();
        void this.startInitialization(true).finally(() => {
            this.freshConnectionRequested = false;
        }).catch(() => {});
    }

    private pendingDocumentUpdateHasSafeRevisions(pending: PendingDocumentUpdate): boolean {
        return isNonnegativeSafeInteger(pending.baseVersion)
            && isNonnegativeSafeInteger(pending.update.v)
            && isNonnegativeSafeInteger(pending.update.v + 1)
            && (pending.update.lastV === undefined
                || isNonnegativeSafeInteger(pending.update.lastV))
            && (pending.confirmationVersion === undefined
                || isNonnegativeSafeInteger(pending.confirmationVersion));
    }

    private pendingWritePayload(
        pending: PendingDocumentUpdate,
        state = 'submitted',
        extra: {[key: string]: JsonValue} = {},
    ): JsonValue {
        return JSON.parse(JSON.stringify({
            state,
            docId: pending.docId,
            bufferId: pending.bufferId,
            update: pending.update,
            desiredContent: pending.desiredContent,
            mergedContent: pending.mergedContent,
            baseVersion: pending.baseVersion,
            baseContent: pending.baseContent,
            submittedPublicIds: pending.submittedPublicIds,
            socketGeneration: pending.socketGeneration,
            submissionToken: pending.submissionToken,
            ...extra,
        })) as JsonValue;
    }

    private pendingRecordMatches(
        record: DocumentProvenanceRecord,
        pending: PendingDocumentUpdate,
    ): boolean {
        return record.pendingWrite !== undefined
            && JSON.stringify(record.pendingWrite) === JSON.stringify(this.pendingWritePayload(pending));
    }

    private async reconcileConfirmedPending(
        pending: PendingDocumentUpdate,
        authoritative: {doc: DocumentEntity, content: string},
        submissionWitness: EditorBufferWitness,
    ): Promise<{
        submissionWitnessStillMatches: boolean,
        currentMatchesAuthoritative: boolean,
    }> {
        const authoritativeVersion = authoritative.doc.version;
        if (!isNonnegativeSafeInteger(authoritativeVersion)) {
            throw new Error('The confirmed write has no authoritative revision');
        }
        if (!this.pendingDocumentUpdateHasSafeRevisions(pending)) {
            throw new Error('The confirmed write contains an invalid document revision');
        }
        if (pending.confirmationVersion === undefined) {
            throw new Error('The confirmed write has no observed sender-confirmation revision');
        }
        if (authoritativeVersion < pending.confirmationVersion + 1) {
            throw new Error('The authoritative revision is behind the observed sender confirmation');
        }
        if (this.pendingDocumentUpdates.get(pending.bufferId) !== pending) {
            throw new Error('The in-memory pending intent changed before reconciliation');
        }
        const live = this.editorBuffers.get(pending.bufferId);
        const sameBufferIncarnation = Boolean(live && this.bufferMatchesIncarnation(live));
        const liveText = sameBufferIncarnation ? live!.document.getText() : authoritative.content;
        const previousActive = this.activeEditorBases.get(pending.bufferId);
        // The sender ACK plus this fresh join establishes the next durable
        // remote base even when later local typing cannot be safely rebased.
        // In that latter case the dirty text is preserved but its bridge is
        // invalid, so a later save remains fail-closed.
        const baseVersion = authoritativeVersion;
        const baseContent = authoritative.content;

        const identitySource = live ?? submissionWitness;
        const identity = this.documentProvenanceIdentity(pending.docId, identitySource);
        if (!identity) {
            throw new Error('The sender identity changed before confirmed-state reconciliation');
        }
        const reconciled = await this.provenanceStore.reconcilePendingWrite(
            pending.provenanceRecordName,
            this.pendingWritePayload(pending),
            {
                identity,
                bufferIncarnationId: pending.bufferId,
                baseVersion,
                baseText: baseContent,
                dirtyText: liveText,
            },
        );

        // The server outcome is now represented durably without pendingWrite.
        // Never retain an in-memory retry intent after this durability point.
        if (this.pendingDocumentUpdates.get(pending.bufferId) === pending) {
            this.pendingDocumentUpdates.delete(pending.bufferId);
        }

        if (sameBufferIncarnation) {
            const ledger = this.remoteDocumentCausality.get(pending.docId);
            const pendingOperations = previousActive?.causality.pendingOperations.map(
                operation => ({...operation}),
            ) ?? [];
            let preservesPendingCausality = Boolean(
                previousActive
                && previousActive.bufferId === pending.bufferId
                && previousActive.identity.docId === pending.docId
                && previousActive.causality.valid
                && previousActive.causality.inflightWire === undefined
                && previousActive.causality.inflightView === undefined
                && previousActive.causality.inflightToken === undefined
                && ledger?.valid
                && ledger.socketGeneration === this.socket.generation
                && ledger.headVersion === authoritativeVersion
                && ledger.headContent === authoritative.content,
            );
            if (preservesPendingCausality) {
                try {
                    preservesPendingCausality = applyTextOperations(
                        authoritative.content,
                        pendingOperations,
                    ) === liveText;
                } catch {
                    preservesPendingCausality = false;
                }
            }
            const causality: RealtimeEditorBridgeState = {
                socketGeneration: ledger?.socketGeneration ?? -1,
                remoteEpoch: ledger?.epoch ?? '',
                remoteVersion: authoritativeVersion,
                remoteContent: authoritative.content,
                documentVersion: live!.document.version,
                editorContent: liveText,
                pendingOperations,
                localOperations: pendingOperations.map(operation => ({...operation})),
                valid: preservesPendingCausality,
            };
            if (liveText === authoritative.content && pendingOperations.length === 0) {
                causality.valid = Boolean(
                    ledger?.valid
                    && ledger.socketGeneration === this.socket.generation
                    && ledger.headVersion === authoritativeVersion
                    && ledger.headContent === authoritative.content,
                );
            }
            const active: EditorDocumentBase = {
                identity,
                bufferId: pending.bufferId,
                version: baseVersion,
                content: baseContent,
                recordName: reconciled.recordName,
                persistence: Promise.resolve(reconciled),
                causality,
            };
            this.activeEditorBases.set(pending.bufferId, active);

            // Close the small window in which the editor could advance while
            // the atomic reconciliation write was in flight.
            const latestLive = this.editorBuffers.get(pending.bufferId);
            if (latestLive && this.bufferMatchesIncarnation(latestLive)) {
                const latestText = latestLive.document.getText();
                if (latestText !== liveText) {
                    active.causality.valid = false;
                    const latestRecord = await this.provenanceStore.createOrUpdateCurrent({
                        identity,
                        bufferIncarnationId: pending.bufferId,
                        baseVersion,
                        baseText: baseContent,
                        dirtyText: latestText,
                    });
                    active.recordName = latestRecord.recordName;
                    active.persistence = Promise.resolve(latestRecord);
                }
                if (latestLive.document.getText() === authoritative.content
                    && this.documentMatchesAuthority(
                        authoritative.doc,
                        authoritativeVersion,
                        authoritative.content,
                    )) {
                    this.editorSaveReceipts.set(pending.bufferId, {
                        document: latestLive.document,
                        identity,
                        bufferId: pending.bufferId,
                        version: authoritativeVersion,
                        content: authoritative.content,
                    });
                } else {
                    this.editorSaveReceipts.delete(pending.bufferId);
                }
            }
        } else {
            this.activeEditorBases.delete(pending.bufferId);
            this.editorSaveReceipts.delete(pending.bufferId);
        }

        if (this.documentMatchesAuthority(
            authoritative.doc,
            authoritativeVersion,
            authoritative.content,
        )) {
            this.stageEditorBase(submissionWitness.document.uri, authoritative.doc, authoritative.content);
            const currentEditor = this.editorBuffers.get(pending.bufferId)?.document;
            if (currentEditor && currentEditor.getText() === authoritative.content) {
                authoritative.doc.localCache = authoritative.content;
            }
        }

        const current = this.editorBuffers.get(pending.bufferId);
        return {
            submissionWitnessStillMatches: this.bufferMatchesWitness(submissionWitness),
            currentMatchesAuthoritative: Boolean(
                current
                && this.bufferMatchesIncarnation(current)
                && current.document.getText() === authoritative.content
                && this.documentMatchesAuthority(
                    authoritative.doc,
                    authoritativeVersion,
                    authoritative.content,
                )
            ),
        };
    }

    /**
     * Retry an outcome-unknown write only inside the same extension-host
     * session, from its exact durable intent, and under a fresh socket public
     * id. dupIfSource makes either possible server outcome idempotent: an
     * unapplied write is committed once, while an already-applied write is only
     * confirmed to the new sender and is not broadcast again.
     */
    private async recoverPendingDocumentUpdate(
        uri: vscode.Uri,
        content: Uint8Array,
        docId: string,
        desiredContent: string,
        witness: EditorBufferWitness,
    ): Promise<boolean> {
        const pending = this.pendingDocumentUpdates.get(witness.bufferId);
        if (!pending) { return false; }
        if (pending.docId !== docId
            || pending.bufferId !== witness.bufferId) {
            this.blockDocumentWrite(
                uri,
                content,
                'an outcome-unknown write belongs to a different remote document',
            );
        }
        if (!this.pendingDocumentUpdateHasSafeRevisions(pending)) {
            this.blockDocumentWrite(
                uri,
                content,
                'the pending write contains an invalid document revision',
            );
        }
        if (pending.confirmationVersion === undefined
            && pending.desiredContent !== desiredContent) {
            this.blockDocumentWrite(
                uri,
                content,
                'an outcome-unknown write exists for different editor text',
            );
        }
        if (this.isInvisibleMode) {
            this.blockDocumentWrite(
                uri,
                content,
                'a pending realtime write cannot be recovered in Invisible Mode',
            );
        }

        const identity = this.documentProvenanceIdentity(docId, witness);
        if (!identity) {
            this.blockDocumentWrite(uri, content, 'the realtime protocol or sender identity is unproven');
        }
        const resolved = await this.provenanceStore.resolveCurrentRecord(
            pending.provenanceRecordName,
            {
                identity,
                bufferIncarnationId: witness.bufferId,
                baseVersion: pending.baseVersion,
                baseText: pending.baseContent,
                dirtyText: pending.desiredContent,
            },
        );
        if (resolved.kind !== 'valid' || !this.pendingRecordMatches(resolved.record, pending)) {
            this.blockDocumentWrite(
                uri,
                content,
                'the durable pending-write record no longer matches the exact submitted operation',
            );
        }

        if (pending.confirmationVersion !== undefined) {
            let authoritative: {doc: DocumentEntity, content: string};
            try {
                authoritative = await this.joinFreshDocumentSession(docId);
                const state = await this.reconcileConfirmedPending(
                    pending,
                    authoritative,
                    witness,
                );
                // If the exact bytes being saved are already authoritative,
                // this retry is a zero-wire completion. Otherwise continue
                // through the ordinary exact-base authorization for new input.
                return state.currentMatchesAuthoritative;
            } catch (error) {
                this.showDocumentRecovery(
                    uri,
                    content,
                    `the confirmed server outcome could not be reconciled durably: ${String(error)}`,
                );
                throw error;
            }
        }

        const retrySession = await this.ensureDocumentSession(docId);
        const retrySessionVersion = retrySession.doc.version;
        if (!isNonnegativeSafeInteger(retrySessionVersion)
            || !isNonnegativeSafeInteger(retrySessionVersion + 1)) {
            this.blockDocumentWrite(
                uri,
                content,
                'the current document revision cannot accept a safe deduplicated retry',
            );
        }
        const sender = this.currentSenderWitness();
        const retryPublicId = sender?.publicId;
        const retryGeneration = sender?.generation;
        if (!retryPublicId
            || retryGeneration === undefined
            || pending.submittedPublicIds.includes(retryPublicId)) {
            this.blockDocumentWrite(
                uri,
                content,
                'the pending write requires a fresh acknowledged realtime identity before retry',
            );
        }

        const retryUpdate = buildRecoveryUpdate(
            pending.update,
            pending.submittedPublicIds,
        ) as UpdateSchema;
        const retryPending: PendingDocumentUpdate = {
            ...pending,
            submittedPublicIds: [...pending.submittedPublicIds, retryPublicId],
            socketGeneration: retryGeneration,
        };
        await this.provenanceStore.markPendingWrite(
            retryPending.provenanceRecordName,
            this.pendingWritePayload(retryPending),
        );
        const senderBeforeRetry = this.currentSenderWitness();
        const retryAuthorityStillCurrent = this.documentMatchesAuthority(
            retrySession.doc,
            retrySessionVersion,
            retrySession.content,
        ) && isNonnegativeSafeInteger(retrySession.doc.version)
            && isNonnegativeSafeInteger(retrySession.doc.version + 1);
        if (senderBeforeRetry?.publicId !== retryPublicId
            || senderBeforeRetry.generation !== retryGeneration
            || !retryAuthorityStillCurrent
            || this.pendingDocumentUpdates.get(witness.bufferId) !== pending
            || !this.bufferMatchesWitness(witness)) {
            await this.provenanceStore.markPendingWrite(
                pending.provenanceRecordName,
                this.pendingWritePayload(pending),
            );
            this.blockDocumentWrite(
                uri,
                content,
                'the document authority or realtime identity changed before the pending operation could be retried',
            );
        }
        this.pendingDocumentUpdates.set(witness.bufferId, retryPending);

        const versionWaiter = this.waitForDocumentVersion(docId, pending.update.v);
        try {
            const [, confirmationVersion] = await Promise.all([
                this.socket.applyOtUpdate(docId, retryUpdate, {
                    publicId: retryPublicId,
                    generation: retryGeneration,
                }),
                versionWaiter.promise,
            ]);
            retryPending.confirmationVersion = confirmationVersion;
        } catch (error) {
            versionWaiter.cancel();
            const outcomeUnknown = !(error instanceof SocketRequestError) || error.outcomeUnknown;
            this.invalidateDocumentSession(
                docId,
                error instanceof Error ? error : new Error(String(error)),
            );
            if (!outcomeUnknown) {
                // A known failure of the deduplicated retry says nothing about
                // whether the original, outcome-unknown send under an earlier
                // public id committed. Restore that original durable intent;
                // clearing it would let a later ordinary save bypass dupIfSource.
                await this.provenanceStore.markPendingWrite(
                    pending.provenanceRecordName,
                    this.pendingWritePayload(pending),
                );
                this.pendingDocumentUpdates.set(witness.bufferId, pending);
            }
            this.showDocumentRecovery(
                uri,
                content,
                outcomeUnknown ?
                    'the deduplicated retry also has an unknown outcome' :
                    `the realtime server rejected the deduplicated retry: ${String(error)}`,
            );
            if (outcomeUnknown && !(error instanceof SocketRequestError)) {
                throw new SocketRequestError(
                    'stale_connection',
                    `The document retry outcome is unknown: ${String(error)}`,
                    true,
                    error,
                );
            }
            throw error;
        }

        let authoritative: {doc: DocumentEntity, content: string};
        try {
            authoritative = await this.joinFreshDocumentSession(docId);
        } catch (error) {
            this.showDocumentRecovery(
                uri,
                content,
                'the confirmed deduplicated retry could not be reconciled with a fresh snapshot',
            );
            throw error;
        }
        const authoritativeVersion = authoritative.doc.version;
        if (!isNonnegativeSafeInteger(authoritativeVersion)) {
            this.blockDocumentWrite(
                uri,
                content,
                'the confirmed retry returned without an authoritative revision',
            );
        }
        const reconciled = await this.reconcileConfirmedPending(
            retryPending,
            authoritative,
            witness,
        );
        setTimeout(() => {
            this.notify([{type: vscode.FileChangeType.Changed, uri}]);
        }, 10);
        authoritative.doc.lastVersion = pending.update.v;
        if (reconciled.submissionWitnessStillMatches
            && !reconciled.currentMatchesAuthoritative) {
            this.blockDocumentWrite(
                uri,
                content,
                'the remote save was confirmed with collaborator text absent from this editor',
            );
        }
        return true;
    }

    private async writeFileNow(uri: vscode.Uri, content:Uint8Array, create:boolean, _overwrite:boolean) {
        if (this.matchesUnboundEditorSave(uri, content)) {
            this.blockDocumentWrite(
                uri,
                content,
                'this dirty editor was never bound to a remote document identity',
            );
        }
        const {parentFolder, fileName, fileType, fileEntity} = await this._resolveUri(uri);

        // if non-exists --> create it
        if (!fileType && create) {
            this.blockDocumentWrite(
                uri,
                content,
                'the official protocol cannot atomically bind a new path, document identity, and initial text',
            );
        }

        // A text-editor save must never reach uploadFile. The upload endpoint is
        // an upsert, so re-resolving a non-doc path through createFile would
        // reopen a remote delete/create race and could replace a collaborator's
        // entity.
        if (fileType && fileType!=='doc') {
            throw vscode.FileSystemError.Unavailable(
                vscode.l10n.t('Only Overleaf text documents can be written without replacement.'),
            );
        }

        // if exists and is doc --> update
        if (fileType && fileType==='doc' && fileEntity) {
            const docId = fileEntity._id;
            const _content = new TextDecoder().decode(content);
            if (this.isInvisibleMode) {
                this.blockDocumentWrite(
                    uri,
                    content,
                    'Invisible Mode cannot prove a revision-bound document write',
                );
            }
            const bufferResolution = this.resolveWritingBuffer(uri, docId, _content);
            if (bufferResolution.kind === 'blocked') {
                this.blockDocumentWrite(uri, content, bufferResolution.reason);
            }
            const witness = bufferResolution.witness;
            if (await this.recoverPendingDocumentUpdate(
                uri,
                content,
                docId,
                _content,
                witness,
            )) {
                return;
            }
            const session = await this.ensureDocumentSession(docId);
            const doc = session.doc;
            const remoteContent = session.content;
            const sessionVersion = doc.version;
            if (!isNonnegativeSafeInteger(sessionVersion)) {
                this.blockDocumentWrite(uri, content, 'the joined document revision is invalid');
            }
            if (!isNonnegativeSafeInteger(sessionVersion + 1)) {
                this.blockDocumentWrite(
                    uri,
                    content,
                    'the next document revision cannot be represented safely',
                );
            }

            const provenance = await this.resolveEditorProvenance(docId, _content, witness);
            if (!this.documentMatchesAuthority(doc, sessionVersion, remoteContent)
                || !this.bufferMatchesWitness(witness)) {
                this.blockDocumentWrite(
                    uri,
                    content,
                    'the remote document changed while its provenance was being checked',
                );
            }
            const exactBase = provenance.kind === 'valid' ? {
                version: provenance.value.record.baseVersion,
                content: provenance.value.record.baseText,
                pendingWrite: provenance.value.record.pendingWrite !== undefined,
            } : undefined;
            const authorization = prepareProvenDocumentUpdate(
                exactBase,
                sessionVersion,
                remoteContent,
                _content,
                exactBase ? this.causalEvidenceForWrite(
                    docId,
                    exactBase,
                    sessionVersion,
                    _content,
                    witness,
                ) : undefined,
            );

            if (authorization.status === 'noop') {
                if (witness.content !== remoteContent) {
                    this.blockDocumentWrite(
                        uri,
                        content,
                        'the remote document contains confirmed text absent from this editor',
                    );
                }
                try {
                    await this.acceptEditorBase(
                        witness,
                        doc,
                        sessionVersion,
                        remoteContent,
                        provenance.kind === 'valid' ? provenance.value.recordsToClear : [],
                    );
                } catch (error) {
                    this.showDocumentRecovery(
                        uri,
                        content,
                        `the confirmed provenance record could not be cleared: ${String(error)}`,
                    );
                    throw error;
                }
                return;
            }
            if (provenance.kind === 'blocked') {
                this.blockDocumentWrite(uri, content, provenance.reason);
            }
            if (authorization.status === 'blocked') {
                const reasons = {
                    'missing-base': 'no exact editor base is available',
                    'pending-write': 'a previous write has an unknown or unreconciled outcome',
                    'version-regression': 'the remote revision moved behind this editor base',
                    'content-version-mismatch': 'the remote text changed without a matching revision advance',
                    'missing-local-causality': 'the editor change events do not prove the exact local operation',
                    'missing-remote-causality': 'the remote operation ancestry is incomplete for this editor base',
                    'invalid-causal-operations': 'the observed operation chain cannot be replayed exactly',
                    'causal-conflict': 'remote and local operations overlap or share a boundary',
                } as const;
                this.blockDocumentWrite(uri, content, reasons[authorization.reason]);
            }

            const prepared = authorization.prepared;
            const mergeRes = prepared.mergedContent;
            if (!prepared.mergeApplied || prepared.operations.length === 0) {
                this.blockDocumentWrite(uri, content, 'the exact-base edit could not be represented safely');
            }
            const sender = this.currentSenderWitness();
            if (!sender) {
                this.blockDocumentWrite(uri, content, 'the realtime session has no accepted connection identity');
            }

            const update: UpdateSchema = {
                doc: doc._id,
                lastV: doc.lastVersion,
                v: sessionVersion,
                // Reference: services/web/frontend/js/vendor/libs/sharejs.js#L1288
                hash: (() => {
                    if (!doc.mtime || Date.now() - doc.mtime > 5000) {
                        doc.mtime = Date.now();
                        return require('crypto').createHash('sha1').update(
                            "blob " + mergeRes.length + "\x00" + mergeRes
                        ).digest('hex');
                    }
                })(),
                op: prepared.operations,
            };
            const pending: PendingDocumentUpdate = {
                docId: doc._id,
                bufferId: witness.bufferId,
                provenanceRecordName: provenance.value.record.recordName,
                update,
                desiredContent: _content,
                mergedContent: mergeRes,
                baseVersion: provenance.value.record.baseVersion,
                baseContent: provenance.value.record.baseText,
                submittedPublicIds: [sender.publicId],
                socketGeneration: sender.generation,
                submissionToken: randomUUID(),
            };
            let pendingRecord: DocumentProvenanceRecord;
            try {
                pendingRecord = await this.provenanceStore.markPendingWrite(
                    pending.provenanceRecordName,
                    this.pendingWritePayload(pending),
                );
            } catch (error) {
                this.showDocumentRecovery(
                    uri,
                    content,
                    `the write-ahead recovery record could not be persisted: ${String(error)}`,
                );
                throw error;
            }
            const senderBeforeSend = this.currentSenderWitness();
            if (!this.documentMatchesAuthority(doc, sessionVersion, remoteContent)
                || !this.bufferMatchesWitness(witness)
                || senderBeforeSend?.publicId !== sender.publicId
                || senderBeforeSend?.generation !== sender.generation) {
                try {
                    await this.provenanceStore.clearPendingWrite(pendingRecord.recordName);
                } catch (error) {
                    this.showDocumentRecovery(
                        uri,
                        content,
                        `the unsent write could not be cleared from recovery state: ${String(error)}`,
                    );
                    throw error;
                }
                this.blockDocumentWrite(
                    uri,
                    content,
                    'the remote document changed before the authorized operation could be sent',
                );
            }
            const submissionActive = this.activeEditorBases.get(witness.bufferId);
            try {
                if (!submissionActive
                    || submissionActive.identity.docId !== doc._id
                    || submissionActive.version !== sessionVersion
                    || submissionActive.content !== remoteContent) {
                    throw new Error('The active editor base changed before submission');
                }
                submissionActive.causality = beginLocalEditorSubmission(
                    submissionActive.causality,
                    pending.submissionToken,
                    pending.update.op ?? [],
                );
            } catch (error) {
                try {
                    await this.provenanceStore.clearPendingWrite(pendingRecord.recordName);
                } catch (persistenceError) {
                    this.showDocumentRecovery(
                        uri,
                        content,
                        `the unsent write could not be cleared from recovery state: ${String(persistenceError)}`,
                    );
                    throw persistenceError;
                }
                this.blockDocumentWrite(
                    uri,
                    content,
                    `the exact local operation could not enter the in-flight state: ${String(error)}`,
                );
            }
            this.pendingDocumentUpdates.set(witness.bufferId, pending);
            this.markSourceDirty();

            const sentVersion = sessionVersion;
            const versionWaiter = this.waitForDocumentVersion(doc._id, sentVersion);
            try {
                const [, confirmationVersion] = await Promise.all([
                    this.socket.applyOtUpdate(doc._id, update, sender),
                    versionWaiter.promise,
                ]);
                pending.confirmationVersion = confirmationVersion;
            } catch (error) {
                versionWaiter.cancel();
                const outcomeUnknown = !(error instanceof SocketRequestError) || error.outcomeUnknown;
                if (outcomeUnknown) {
                    this.invalidateDocumentSession(
                        doc._id,
                        error instanceof Error ? error : new Error(String(error)),
                    );
                } else {
                    const rejectedActive = this.activeEditorBases.get(witness.bufferId);
                    if (rejectedActive) {
                        rejectedActive.causality = rejectLocalEditorSubmission(
                            rejectedActive.causality,
                            pending.submissionToken,
                            pending.update.op ?? [],
                        );
                    }
                    this.pendingDocumentUpdates.delete(witness.bufferId);
                    try {
                        await this.provenanceStore.clearPendingWrite(pending.provenanceRecordName);
                    } catch (persistenceError) {
                        this.showDocumentRecovery(
                            uri,
                            content,
                            `the rejected write could not be cleared from recovery state: ${String(persistenceError)}`,
                        );
                        throw persistenceError;
                    }
                }
                this.showDocumentRecovery(
                    uri,
                    content,
                    outcomeUnknown ?
                        'the server may have applied the write; retry requires a fresh deduplicated sender identity' :
                        `the realtime server rejected the write: ${String(error)}`,
                );
                if (outcomeUnknown && !(error instanceof SocketRequestError)) {
                    throw new SocketRequestError(
                        'stale_connection',
                        `The document write outcome is unknown: ${String(error)}`,
                        true,
                        error,
                    );
                }
                throw error;
            }

            let authoritative: {doc: DocumentEntity, content: string};
            try {
                authoritative = await this.joinFreshDocumentSession(doc._id);
            } catch (error) {
                this.showDocumentRecovery(
                    uri,
                    content,
                    'the acknowledged write could not be reconciled with a fresh remote snapshot',
                );
                throw error;
            }
            const authoritativeVersion = authoritative.doc.version;
            if (!isNonnegativeSafeInteger(authoritativeVersion)) {
                this.blockDocumentWrite(
                    uri,
                    content,
                    'the acknowledged write returned without an authoritative revision',
                );
            }
            let reconciled: {
                submissionWitnessStillMatches: boolean,
                currentMatchesAuthoritative: boolean,
            };
            try {
                reconciled = await this.reconcileConfirmedPending(
                    pending,
                    authoritative,
                    witness,
                );
            } catch (error) {
                this.showDocumentRecovery(
                    uri,
                    content,
                    `the acknowledged write could not persist its confirmed state: ${String(error)}`,
                );
                throw error;
            }
            setTimeout(() => {
                this.notify([
                    {type: vscode.FileChangeType.Changed, uri: uri}
                ]);
            }, 10);
            authoritative.doc.lastVersion = sentVersion;
            if (reconciled.submissionWitnessStillMatches
                && !reconciled.currentMatchesAuthoritative) {
                this.blockDocumentWrite(
                    uri,
                    content,
                    'the remote save was confirmed with collaborator text absent from this editor',
                );
            }
            return;
        }
        if (!fileType) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        throw vscode.FileSystemError.Unavailable(
            vscode.l10n.t('Only Overleaf text documents can be written without create intent.'),
        );
    }

    async mkdir(uri: vscode.Uri) {
        await this.assertProjectWritable('Unable to create folder');
        const {parentFolder, fileName, fileEntity} = await this._resolveUri(uri);
        if (fileEntity) {
            throw vscode.FileSystemError.FileExists(uri);
        }
        const [folderName, parentFolderId] = [fileName, parentFolder._id];
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.addFolder(identity, this.projectId, folderName, parentFolderId);

        if (res.type !== 'success') {
            if (this.isReady && this.cachedChildAt(parentFolderId, folderName, ['folder'])) { return; }
            throw this.mutationError(`Unable to create folder ${folderName}`, res.message);
        }
        if (!res.entity || typeof res.entity._id !== 'string' || res.entity._id.length === 0) {
            throw this.mutationError(`Unable to create folder ${folderName}`, 'The server returned no folder');
        }
        const liveParent = await this.currentFolder(parentFolderId, `Unable to create folder ${folderName}`);
        const alreadyCached = Boolean(this.resolveCachedEntity(res.entity._id));
        this.insertEntity(liveParent, 'folder', res.entity as FolderEntity);
        this.markSourceDirty();
        if (alreadyCached) { return; }
        this.notify([
            {type: vscode.FileChangeType.Created, uri: uri},
        ]);
    }

    async remove(uri: vscode.Uri, recursive: boolean) {
        await this.assertProjectWritable('Unable to delete file');
        const {parentFolder, fileType, fileEntity} = await this._resolveUri(uri);
        if (!fileType || !fileEntity) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.deleteEntity(identity, this.projectId, fileType, fileEntity._id);
        if (res.type !== 'success') {
            if (!this.isReady || this.resolveCachedEntity(fileEntity._id)) {
                throw this.mutationError(`Unable to delete ${fileEntity.name}`, res.message);
            }
            return;
        }
        this.removeEntityById(parentFolder, fileType, fileEntity._id, recursive);
        this.markSourceDirty();
        this.notify([
            {type: vscode.FileChangeType.Deleted, uri: uri},
        ]);
    }

    async rename(oldUri: vscode.Uri, newUri: vscode.Uri, force: boolean) {
        await this.assertProjectWritable('Unable to rename file');
        const oldPath = await this._resolveUri(oldUri);
        const newPath = await this._resolveUri(newUri);

        if (!oldPath.fileType || !oldPath.fileEntity) {
            throw vscode.FileSystemError.FileNotFound(oldUri);
        }
        if (oldUri.toString() === newUri.toString() || oldPath.fileEntity._id === newPath.fileEntity?._id) {
            return;
        }
        if (newPath.fileType && newPath.fileEntity) {
            if (!force) {
                throw vscode.FileSystemError.FileExists(newUri);
            }
            // Overleaf has no atomic replace/move endpoint. Deleting the target
            // first would irreversibly lose it if the following request failed.
            throw this.mutationError(
                `Unable to replace ${newPath.fileName}`,
                'Safe overwrite is not supported for remote rename operations',
            );
        }

        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const entityType = oldPath.fileType;
        const entity = oldPath.fileEntity;
        const entityId = entity._id;
        const originalName = entity.name;
        const targetName = newPath.fileName;
        const sameParent = oldPath.parentFolder._id === newPath.parentFolder._id;

        if (sameParent) {
            if (originalName === targetName) { return; }
            const res = await this.api.renameEntity(
                identity,
                this.projectId,
                entityType,
                entityId,
                targetName,
            );
            if (res.type !== 'success') {
                if (!this.cachedEntityIsAt(entityId, newPath.parentFolder._id, targetName)) {
                    throw this.mutationError(`Unable to rename ${originalName}`, res.message);
                }
            }
            const events = this.reconcileEntityLocation(
                entityType,
                entity,
                newPath.parentFolder,
                targetName,
                newUri,
            );
            this.markSourceDirty();
            if (events.length > 0) { this.notify(events); }
            return;
        }

        const moveRes = await this.api.moveEntity(
            identity,
            this.projectId,
            entityType,
            entityId,
            newPath.parentFolder._id,
        );
        if (moveRes.type !== 'success') {
            const moveConfirmed = this.cachedEntityIsAt(
                entityId,
                newPath.parentFolder._id,
                originalName,
            ) || this.cachedEntityIsAt(entityId, newPath.parentFolder._id, targetName);
            if (!moveConfirmed) {
                throw this.mutationError(`Unable to move ${originalName}`, moveRes.message);
            }
        }

        if (originalName !== targetName &&
            !this.cachedEntityIsAt(entityId, newPath.parentFolder._id, targetName)) {
            const renameRes = await this.api.renameEntity(
                identity,
                this.projectId,
                entityType,
                entityId,
                targetName,
            );
            if (renameRes.type !== 'success') {
                // The move is confirmed but the rename is not. Keep the cache at
                // the last confirmed remote state and surface the partial failure.
                if (this.cachedEntityIsAt(entityId, newPath.parentFolder._id, targetName)) {
                    return;
                }
                const intermediateUri = vscode.Uri.joinPath(newUri, '..', originalName);
                const events = this.reconcileEntityLocation(
                    entityType,
                    entity,
                    newPath.parentFolder,
                    originalName,
                    intermediateUri,
                );
                if (events.length > 0) { this.notify(events); }
                throw this.mutationError(
                    `Moved ${originalName}, but could not rename it to ${targetName}`,
                    renameRes.message,
                );
            }
        }

        const events = this.reconcileEntityLocation(
            entityType,
            entity,
            newPath.parentFolder,
            targetName,
            newUri,
        );
        this.markSourceDirty();
        if (events.length > 0) { this.notify(events); }
    }

    private compileRootResourcePath(rootDocId?: string): string | null {
        const resolvedRootDocId = rootDocId ?? this.root?.rootDoc_id ?? null;
        if (!resolvedRootDocId) { return null; }

        const rootEntry = this._resolveById(resolvedRootDocId);
        if (rootEntry?.path) {
            return rootEntry.path.replace(/^\//, '');
        }
        console.warn(`Unable to resolve root document id '${resolvedRootDocId}' to a path; compiling without explicit rootResourcePath.`);
        return null;
    }

    /**
     * Probe the optional recent-build cache used by current Overleaf SaaS.
     * Unsupported/self-hosted endpoints and incompatible cached settings are
     * intentionally indistinguishable here: both fall back to a real compile.
     */
    async adoptCachedCompile(
        draft:boolean=false,
        stopOnFirstError:boolean=false,
        rootDocId?:string,
        isCurrent: () => boolean = () => true,
    ): Promise<CompileOutcome | undefined> {
        try {
            const sourceRevision = this.sourceRevision;
            const rootResourcePath = this.compileRootResourcePath(rootDocId);
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            if (!isCurrent()) { return undefined; }
            const res = await this.api.getCachedCompile(identity, this.projectId);
            if (
                !isCurrent() ||
                sourceRevision !== this.sourceRevision ||
                res.type !== 'success' ||
                !res.compile
            ) { return undefined; }

            const cached = res.compile;
            if (!isCachedCompileCompatible(
                cached.status,
                cached.outputFiles,
                cached.options,
                {rootResourcePath, draft, stopOnFirstError},
            )) { return undefined; }

            const cachedPdf = cached.outputFiles.find(output => output.path === 'output.pdf');
            // A cached build belongs to the editor session which produced it.
            // Guessing the current session id would make SyncTeX target a build
            // identity which never existed, so older cache schemas fail closed.
            if (!hasUsableCachedPdfIdentity(cached.outputFiles) || !cachedPdf?.editorId) {
                return undefined;
            }
            const outputIdentity = resolveSynctexOutputIdentity(cached.outputFiles, cachedPdf.editorId);
            if (!outputIdentity.buildId || !outputIdentity.editorId) { return undefined; }

            this.updateOutputs(cached.outputFiles, true, {
                compileGroup: cached.compileGroup,
                clsiServerId: cached.clsiServerId,
                pdfDownloadDomain: cached.pdfDownloadDomain,
            });
            this.isDirty = false;
            return {
                status: 'success',
                successful: true,
                outputsUpdated: true,
                hasLog: cached.outputFiles.some(output => output.path === 'output.log'),
            };
        } catch {
            return undefined;
        }
    }

    async compile(
        force:boolean=false,
        draft:boolean=false,
        stopOnFirstError:boolean=false,
        rootDocId?:string,
        requestKind: CompileRequestKind = 'manual',
        isCurrent: () => boolean = () => true,
        onServerCompileStarted: () => void = () => {},
    ): Promise<CompileOutcome | undefined> {
        if (force || (this.root && this.isDirty)) {
            const wasDirty = this.isDirty;
            const cancelled = () => {
                return !isCurrent();
            };
            this.isDirty = false;
            try {
                let needCacheClearFirst = false;
                try{
                    await this.resolve(this.pathToUri(OUTPUT_FOLDER_NAME, "output.log"));
                }
                catch (e) {
                    needCacheClearFirst = true;
                }
                if (cancelled()) { return undefined; }
                const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
                if (cancelled()) { return undefined; }
                // clear cache if needed
                if (needCacheClearFirst) {
                    await this.api.deleteAuxFiles(identity, this.projectId);
                    if (cancelled()) { return undefined; }
                }
                // compile project
                const rootResourcePath = this.compileRootResourcePath(rootDocId);
                if (cancelled()) { return undefined; }
                onServerCompileStarted();
                const res = await this.api.compile(
                    identity,
                    this.projectId,
                    rootResourcePath,
                    draft,
                    stopOnFirstError,
                    this.editorId,
                    requestKind === 'automatic',
                );
                if (cancelled()) { return undefined; }
                const response = res.compile;
                const status = normalizeCompileStatus(response?.status, res.message);
                const successful = res.type === 'success' && status === 'success';
                const incomingOutputs = res.type === 'success' && response && Array.isArray(response.outputFiles) ?
                    response.outputFiles : [];
                const outputsUpdated = incomingOutputs.length > 0;
                if (outputsUpdated) {
                    this.updateOutputs(
                        incomingOutputs,
                        successful,
                        {
                            compileGroup: response?.compileGroup,
                            clsiServerId: response?.clsiServerId,
                            pdfDownloadDomain: response?.pdfDownloadDomain,
                        },
                    );
                }
                if (!successful && res.message!==undefined) {
                    console.error(`Compile ${status}.`, res.message);
                }
                // Backoff, rate limits, validation failures and transport-level
                // errors can finish without compiling anything. Keep the dirty
                // marker so a later automatic trigger is not mistaken for an
                // already-compiled source tree.
                if (!successful && !outputsUpdated) {
                    this.isDirty = this.isDirty || wasDirty;
                }
                return {
                    status,
                    successful,
                    outputsUpdated,
                    hasLog: incomingOutputs.some(output => output.path === 'output.log'),
                    message: res.message,
                    validationProblems: response?.validationProblems,
                };
            } catch (error) {
                this.isDirty = this.isDirty || wasDirty;
                throw error;
            } finally {
                if (cancelled()) {
                    this.isDirty = this.isDirty || wasDirty;
                }
            }
        }
        return Promise.resolve(undefined);
    }

    async stopCompile() {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.stopCompile(identity, this.projectId);
        if (res.type==='success') {
            return true;
        } else {
            if (res.message!==undefined) {
                vscode.window.showErrorMessage(res.message);
            }
            return false;
        }
    }

    updateOutputs(
        outputs: Array<CompileOutputFileSchema>,
        successful: boolean = true,
        routing: CompileOutputRouting = {},
    ) {
        if (this.root) {
            const rootFolder = this.root.rootFolder[0];
            const previousOutputFolder = rootFolder.folders.find(folder => folder._id === __OUTPUTS_ID);
            const decoratedOutputs = outputs.map(file => ({
                ...file,
                compileRouting: {...routing},
            }));
            const committedOutputs = mergeCompileOutputs<CompileOutputFileSchema & {
                compileRouting?: CompileOutputRouting,
            }>(
                previousOutputFolder?.outputs ?? [],
                decoratedOutputs,
                successful,
            );

            if (successful) {
                const outputIdentity = resolveSynctexOutputIdentity(committedOutputs, this.editorId);
                this.outputBuildId = outputIdentity.buildId;
                this.outputEditorId = outputIdentity.editorId;
                this.compileGroup = routing.compileGroup;
                this.clsiServerId = routing.clsiServerId;
                this.pdfDownloadDomain = routing.pdfDownloadDomain;
            }

            if (this.removeEntityById(rootFolder, 'folder', __OUTPUTS_ID)) {
                this.notify([
                    {type:vscode.FileChangeType.Deleted, uri:this.pathToUri(OUTPUT_FOLDER_NAME)}
                ]);
            }

            this.insertEntity(rootFolder, 'folder', {
                _id: __OUTPUTS_ID,
                name: OUTPUT_FOLDER_NAME,
                readonly: true,
                docs: [], fileRefs: [], folders:[],
                outputs: committedOutputs.map((file) => {
                    return {
                        ...file,
                        _id: __OUTPUTS_ID,
                        name: file.path,
                        readonly: true,
                    };
                })
            } as FolderEntity);
            this.notify([
                {type:vscode.FileChangeType.Created, uri:this.pathToUri(OUTPUT_FOLDER_NAME)},
                ...(committedOutputs.map((file) => {
                    return {type:vscode.FileChangeType.Changed, uri:this.pathToUri(OUTPUT_FOLDER_NAME, file.path)};
                }))
            ]);
        }
    }

    async syncCode(filePath: string, line:number, column:number) {
        if (!this.outputBuildId || !this.outputEditorId) {
            vscode.window.showErrorMessage(vscode.l10n.t('SyncTeX is unavailable until the PDF has been compiled successfully.'));
            return undefined;
        }
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.proxySyncCode(
            identity,
            this.projectId,
            filePath,
            line,
            column,
            this.outputEditorId,
            this.outputBuildId,
            this.clsiServerId,
        );
        if (res.type==='success') {
            return res.syncCode;
        } else {
            if (res.message!==undefined) {
                vscode.window.showErrorMessage(res.message);
            }
            return undefined;
        }
    }

    async syncPdf(page:number, h:number, v:number) {
        if (!this.outputBuildId || !this.outputEditorId) {
            vscode.window.showErrorMessage(vscode.l10n.t('SyncTeX is unavailable until the PDF has been compiled successfully.'));
            return undefined;
        }
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.proxySyncPdf(
            identity,
            this.projectId,
            page,
            h,
            v,
            this.outputEditorId,
            this.outputBuildId,
            this.clsiServerId,
        );
        if (res.type==='success') {
            return res.syncPdf;
        } else {
            if (res.message!==undefined) {
                vscode.window.showErrorMessage(res.message);
            }
            return undefined;
        }
    }

    async spellCheck(uri: vscode.Uri, words: string[]) {
        if (this.root?.spellCheckLanguage==='') { return []; }

        const {fileType} = await this._resolveUri(uri);
        if (fileType==='doc' || fileType==='file') {
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            const res = this.root && await this.api.proxyRequestToSpellingApi(identity, this.root.spellCheckLanguage, this.userId, words);
            if (res?.type==='success') {
                return res.misspellings;
            }
        }
    }

    async spellLearn(word: string) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.spellingControllerLearn(identity, this.userId, word);
        if (res.type==='success') {
            this.root?.settings.learnedWords.push(word);
            return true;
        } else {
            return false;
        }
    }

    async spellUnlearn(word: string) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.spellingControllerUnlearn(identity, word);
        if (res.type==='success') {
            const index = this.root?.settings.learnedWords.findIndex((w) => w===word);
            if (index!==undefined && index>=0) {
                this.root?.settings.learnedWords.splice(index, 1);
            }
            return true;
        } else {
            return false;
        }
    }

    getSpellCheckLanguage() {
        const language = this.root?.spellCheckLanguage;
        if (language==='') {
            return {name:'Off', code:''};
        } else {
            return this.root?.settings.languages.find(item => item.code===language);
        }
    }

    getAllSpellCheckLanguages() {
        return this.root?.settings.languages;
    }

    getCompiler() {
        const compiler = this.root?.compiler;
        const compilerItem = this.root?.settings.compilers.find(item => item.code===compiler);
        return compilerItem;
    }

    getAllCompilers() {
        return this.root?.settings.compilers;
    }

    getDictionary() {
        return this.root?.settings.learnedWords;
    }

    getRootDocName() {
        return this._resolveById(this.root?.rootDoc_id!)?.path ?? '';
    }

    getValidMainDocs() {
        return this.walk((entity) => {
            return entity._type==='doc' && entity.name.match(/\.tex$/g)!==null;
        });
    }

    getProjectSCMPersist(scmKey: string) {
        const scmPersists = GlobalStateManager.getServerProjectSCMPersists(this.context, this.serverName, this.projectId);
        return scmPersists[scmKey];
    }

    setProjectSCMPersist(scmKey: string, persist: any) {
        GlobalStateManager.updateServerProjectSCMPersist(this.context, this.serverName, this.projectId, scmKey, persist);
    }

    async updateSettings(setting: any) {
        await this.assertProjectWritable('Unable to update project settings');
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.updateProjectSettings(identity, this.projectId, setting);
        if (res.type==='success') {
            const keys = Object.keys(setting);
            if (keys.includes('spellCheckLanguage')) {
                this.root!.spellCheckLanguage = setting.spellCheckLanguage;
            }
            if (keys.includes('compiler')) {
                this.root!.compiler = setting.compiler;
            }
            if (keys.includes('rootDocId')) {
                this.root!.rootDoc_id = setting.rootDocId;
            }
        }
        return res.type==='success'? true : false;
    }

    async metadata() {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.getMetadata(identity, this.projectId);
        if (res.type==='success') {
            return res.meta?.projectMeta;
        } else {
            return undefined;
        }
    }

    async getUpdates(before?: number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.proxyToHistoryApiAndGetUpdates(identity, this.projectId, before);
        if (res.type==='success') {
            return res.updates;
        } else {
            return undefined;
        }
    }

    async getFileDiff(pathname:string, from:number, to:number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.proxyToHistoryApiAndGetFileDiff(identity, this.projectId, pathname, from, to);
        if (res.type==='success') {
            return res.diff;
        } else {
            return undefined;
        }
    }

    async getFileTreeDiff(from:number, to:number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.proxyToHistoryApiAndGetFileTreeDiff(identity, this.projectId, from, to);
        if (res.type==='success') {
            return res.treeDiff;
        } else {
            return undefined;
        }
    }

    async getCurrentVersion() {
        const base = this.currentVersion ?? 0;
        let lb = base;
        let rb = base+2**4;
        // firstly try: a) no update `+1`, b) one update `+2`
        const res = await this.getFileTreeDiff(base+1, base+1);
        if (res===undefined) {
            this.currentVersion = base;
            return base;
        }
        const res2 = await this.getFileTreeDiff(base+2, base+2);
        if (res2===undefined) {
            this.currentVersion = base+1;
            return this.currentVersion;
        }
        // locate the actual upper bound
        do {
            const res = await this.getFileTreeDiff(rb, rb);
            if (res!==undefined) {
                rb = lb + (rb-lb)*2;
            } else {
                break;
            }
        } while (true);
        // binary search the current version
        while (lb<rb) {
            const mid = Math.floor((lb+rb)/2);
            const res = await this.getFileTreeDiff(mid, mid);
            if (res!==undefined) {
                lb = mid+1;
            } else {
                rb = mid;
            }
        }
        // update current version
        this.currentVersion = rb-1;
        return this.currentVersion;
    }

    async createLabel(comment: string, version: number) {
        await this.assertProjectWritable('Unable to create history label');
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.createLabel(identity, this.projectId, comment, version);
        if (res.type==='success') {
            return res.labels?.at(0);
        } else {
            return undefined;
        }
    }

    async deleteLabel(labelId: string) {
        await this.assertProjectWritable('Unable to delete history label');
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.deleteLabel(identity, this.projectId, labelId);
        if (res.type==='success') {
            return true;
        } else {
            return false;
        }
    }

    async downloadProjectArchive(version: number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.downloadZipOfVersion(identity, this.projectId, version);
        return res.content;
    }

    async getMessages() {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.getMessages(identity, this.projectId);
        if (res.type==='success') {
            return res.messages;
        } else {
            return undefined;
        }
    }

    async sendMessage(publicId:string, content: string) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.sendMessage(identity, this.projectId, publicId, content);
        if (res.type==='success') {
            return true;
        } else {
            return false;
        }
    }
}

export class RemoteFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
    private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

    private vfss: {[key:string]:VirtualFileSystem};
    private readonly provenanceStore: DocumentProvenanceStore;
    private readonly observedOpenDocuments = new WeakSet<vscode.TextDocument>();

    constructor(private context: vscode.ExtensionContext) {
        this.context = context;
        this.vfss = {};
        vscode.workspace.textDocuments.forEach(document => {
            this.observedOpenDocuments.add(document);
        });
        this.provenanceStore = new DocumentProvenanceStore(
            new WorkspaceProvenanceStorage(context.storageUri),
        );
    }

    private vfsKey(uri: vscode.Uri): string {
        // Raw query serialization can differ between a restored workspace root
        // and its restored editors. Canonical identity prevents duplicate VFS
        // instances and duplicate realtime sockets for the same project.
        return projectConnectionKey(uri.authority, uri.query);
    }

    private getVFS(uri: vscode.Uri): Promise<VirtualFileSystem> {
        const key = this.vfsKey(uri);
        const vfs = this.vfss[key];
        if (vfs) {
            return Promise.resolve(vfs);
        } else {
            const vfs = new VirtualFileSystem(
                this.context,
                uri,
                this.notify.bind(this),
                this.provenanceStore,
                document => this.observedOpenDocuments.has(document),
                () => {
                    if (this.vfss[key] === vfs) {
                        delete this.vfss[key];
                    }
                },
            );
            this.vfss[key] = vfs;
            return Promise.resolve(vfs);
        }
    }

    private observeTextDocument(document: vscode.TextDocument) {
        if (document.uri.scheme !== ROOT_NAME) { return; }
        const vfs = this.vfss[this.vfsKey(document.uri)];
        vfs?.observeTextDocument(document);
    }

    private observeOpenedTextDocument(document: vscode.TextDocument) {
        if (document.uri.scheme !== ROOT_NAME) { return; }
        const vfs = this.vfss[this.vfsKey(document.uri)];
        vfs?.observeOpenedTextDocument(document);
    }

    private observeChangedTextDocument(event: vscode.TextDocumentChangeEvent) {
        if (event.document.uri.scheme !== ROOT_NAME) { return; }
        const vfs = this.vfss[this.vfsKey(event.document.uri)];
        vfs?.observeChangedTextDocument(event);
    }

    private forgetTextDocument(document: vscode.TextDocument) {
        if (document.uri.scheme !== ROOT_NAME) { return; }
        const vfs = this.vfss[this.vfsKey(document.uri)];
        vfs?.forgetTextDocument(document);
    }

    async flushProvenance() {
        await this.provenanceStore.flush();
    }

    dispose() {
        const vfss = Object.values(this.vfss);
        this.vfss = {};
        vfss.forEach(vfs => vfs.dispose());
        this._emitter.dispose();
    }

    prefetch(uri: vscode.Uri): Promise<VirtualFileSystem> {
        return this.getVFS(uri).then((vfs) => {return vfs;});
    }

    notify(events :vscode.FileChangeEvent[]) {
        this._emitter.fire(events);
    }

    stat(uri: vscode.Uri): Thenable<vscode.FileStat> {
        return this.getVFS(uri).then( vfs => vfs.resolve(uri) );
    }

    watch(uri: vscode.Uri, options: { recursive: boolean; excludes: string[]; }): vscode.Disposable {
        return new vscode.Disposable(() => {});
    }

    readDirectory(uri: vscode.Uri): Thenable<[string, vscode.FileType][]> {
        return this.getVFS(uri).then( vfs => vfs.list(uri) );
    }

    createDirectory(uri: vscode.Uri): Thenable<void> {
        return this.getVFS(uri).then( vfs => vfs.mkdir(uri) );
    }

    readFile(uri: vscode.Uri): Thenable<Uint8Array> {
        return this.getVFS(uri).then( vfs => vfs.openFile(uri) );
    }

    writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean; }): Thenable<void> {
        return this.getVFS(uri).then( vfs => vfs.writeFile(uri, content, options.create, options.overwrite) );
    }

    delete(uri: vscode.Uri, options: { recursive: boolean; }): Thenable<void> {
        return this.getVFS(uri).then( vfs => vfs.remove(uri, options.recursive) );
    }

    rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean; }) {
        if (oldUri.authority !== newUri.authority || oldUri.query !== newUri.query) {
            return Promise.reject(vscode.FileSystemError.Unavailable(
                vscode.l10n.t('Cannot rename across Overleaf projects'),
            ));
        } else {
            return this.getVFS(oldUri).then( vfs => vfs.rename(oldUri, newUri, options.overwrite) );
        }
    }

    get triggers() {
        return [
            // register file system provider
            vscode.workspace.registerFileSystemProvider(ROOT_NAME, this, { isCaseSensitive: true }),
            // register commands
            vscode.commands.registerCommand(`${ROOT_NAME}.remoteFileSystem.refreshLinkedFile`, (uri: vscode.Uri) => {
                return this.prefetch(uri).then((vfs) => vfs.refreshLinkedFile(uri));
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.remoteFileSystem.createLinkedFile`, (uri?: vscode.Uri) => {
                uri = uri || vscode.workspace.workspaceFolders?.[0].uri;
                if (uri) {
                    return this.prefetch(uri).then((vfs) => vfs.createLinkedFile(uri!));
                }                
            }),
            vscode.commands.registerCommand('remoteFileSystem.prefetch', (uri: vscode.Uri) => {
                return this.prefetch(uri);
            }),
            vscode.workspace.onDidOpenTextDocument(document => {
                this.observedOpenDocuments.add(document);
                this.observeOpenedTextDocument(document);
            }),
            vscode.workspace.onDidChangeTextDocument(event => {
                this.observeChangedTextDocument(event);
            }),
            vscode.workspace.onWillSaveTextDocument(event => {
                if (event.document.uri.scheme !== ROOT_NAME) { return; }
                const vfs = this.vfss[this.vfsKey(event.document.uri)];
                vfs?.observeWillSaveTextDocument(event.document);
            }),
            vscode.workspace.onDidSaveTextDocument(document => {
                this.observeTextDocument(document);
            }),
            vscode.workspace.onDidCloseTextDocument(document => {
                this.forgetTextDocument(document);
            }),
            new vscode.Disposable(() => this.dispose()),
        ];
    }
}
