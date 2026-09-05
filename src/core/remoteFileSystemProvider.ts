/* eslint-disable @typescript-eslint/naming-convention */
import * as vscode from 'vscode';
import {
    BaseAPI,
    ChangesUserSchema,
    CompileOutputFileSchema,
    Identity,
    MemberEntity,
    ProjectSettingsSchema,
} from '../api/base';
import {
    DocumentJoin,
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
    transformOperationPair,
} from './documentUpdate';
import {
    applyUtf16TextOperations,
    acknowledgeHistorySubmission,
    beginHistorySubmission,
    beginLocalEditorSubmission,
    commitHistoryCleanRemoteEditorTransaction,
    commitHistoryRemoteEditorTransaction,
    commitRemoteEditorTransaction,
    confirmLocalEditorSubmission,
    createHistoryRealtimeEditorBridgeState,
    createRealtimeEditorBridgeState,
    HistoryEditorWriteDescriptor,
    HistoryRealtimeEditorBridgeState,
    HistoryRemoteEditorTransaction,
    operationsFromContentSnapshots,
    prepareHistoryRemoteEditorTransaction,
    prepareHistoryRemoteEditorCatchupTransaction,
    prepareRemoteEditorTransaction,
    rebindLocalEditorPendingOperations,
    rebindHistorySubmissionForRecovery,
    reconcileHistoryEditorAfterJoin,
    recordHistoryLocalEditorChange,
    recordLocalEditorChange,
    rejectHistorySubmission,
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
    JsonValue as ProvenanceJsonValue,
} from './documentProvenance';
import { WorkspaceProvenanceStorage } from './workspaceProvenanceStorage';
import {
    applyHistoryOtOperations,
    composeHistoryOtOperationsWithSnapshot,
    getVisibleHistoryOtText,
    historyOtJsonEqual,
    JsonValue as HistoryJsonValue,
    parseHistoryOtOperations,
    parseHistoryOtSnapshot,
    serializeHistoryOtOperations,
    serializeHistoryOtSnapshot,
    serializeHistoryOtWireOperation,
} from './historyOt';
import {
    appendHistoryOtThreadEvent,
    awaitHistoryOtSubmissionCommit,
    HistoryOtRawThreadEventLog,
    HistoryOtSession,
    HistoryOtSessionResult,
    HistoryOtThreadEventName,
    HistoryOtWriteIntent,
    parseHistoryOtRealtimeEnvelope,
} from './historyOtSession';
import {
    buildRealtimeHistoryOtPresentation,
    HistoryOtMemberDirectory,
    RealtimeHistoryOtPresentationModel,
} from '../scm/trackChangesPresentation';
import { deepCloneJson } from './historyOt/protocol';
import {
    reduceHistoryOtThreadEvent,
    reduceHistoryOtThreadEvents,
} from './historyOtThreads';
import {
    HistoryOtCommitDuringJoinError,
    runHistoryOtJoinWithCommitRefresh,
} from './historyOtJoin';
import {mergeHistoryOtMemberDirectory} from './historyOtAuthors';

const __OUTPUTS_ID = `${ROOT_NAME}-outputs`;
const SUPPORTED_WRITE_PROTOCOL_VERSION = 2;
const LIVE_EDITOR_SUBMIT_DEBOUNCE_MS = 100;

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
    providerMtime?: number,
    providerSize?: number,
    lastVersion?: number,
    localCache?: string,
    remoteCache?: string,
    otType?: 'sharejs-text-ot' | 'history-ot',
    historyOtSnapshot?: HistoryJsonValue,
    historyOtSession?: HistoryOtSession,
    historyOtPresentation?: RealtimeHistoryOtPresentationModel,
    historyOtEpoch?: string,
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

type PreparedShareJsDocumentJoin = {
    anchorVersion: number,
    anchorContent: string,
    headVersion: number,
    headContent: string,
    updates: Map<number, TextOperation[]>,
};

type PendingDocumentUpdate = {
    otType?: 'sharejs-text-ot' | 'history-ot',
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
    historyIntent?: import('./historyOtSession').HistoryOtWriteIntent,
    /** Exact original editor/protocol identity; never serialized into the wire envelope. */
    identity?: DocumentProvenanceIdentity,
    /** Current crash-safe marker while a confirmed History outcome is handed off. */
    durablePendingWrite?: ProvenanceJsonValue,
    /** Serializes marker transitions with dirty recovery-text persistence. */
    durablePendingWriteTransition?: Promise<void>,
    /** Proven base used by dirty updates after the confirmed marker is cleared. */
    durableReconciledBase?: {
        identity: DocumentProvenanceIdentity,
        baseVersion: number,
        baseText: string,
    },
    durablePendingWriteCleared?: boolean,
    /** Same-generation collaborator evidence observed after a sender ACK. */
    historyConfirmedAdvance?: {
        publicId: string,
        socketGeneration: number,
        committedVersion: number,
        updates: Map<number, {
            raw: HistoryJsonValue,
            operation: HistoryJsonValue,
        }>,
        /** Fresh-join cutoff while later socket events are held for ordered handoff. */
        reconcilingVersion?: number,
        /** Current fresh-join sender which owns the deferred event handoff. */
        reconcilingPublicId?: string,
        reconcilingSocketGeneration?: number,
        deferredUpdates?: ReceivedDocumentUpdate[],
        handoffInstalled?: boolean,
        invalidReason?: string,
    },
    /** Same-host recovery authority only; never serialized to provenance. */
    historySession?: HistoryOtSession,
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

type ProviderDocumentReadWitness = {
    token: string,
    resourceKey: string,
    docId: string,
    canonicalEditorUri: string,
    version: number,
    content: string,
    publicId: string,
    socketGeneration: number,
    remoteEpoch: string,
};

type ProviderDocumentStat = {
    mtime: number,
    size: number,
};

type PendingConditionalDocumentUpdate = {
    token: string,
    resourceKey: string,
    docId: string,
    update: UpdateSchema,
    desiredContent: string,
    mergedContent: string,
    baseVersion: number,
    baseContent: string,
    publicId: string,
    socketGeneration: number,
    inflightView: TextOperation[],
    identity: DocumentProvenanceIdentity,
    bufferIncarnationId: string,
    provenanceRecordName: string,
    durablePendingWrite: ProvenanceJsonValue,
    confirmationVersion?: number,
};

type ConditionalRemoteAcceptanceWitness = {
    pendingToken: string,
    provenanceRecordName: string,
    resourceKey: string,
    docId: string,
    document: vscode.TextDocument,
    bufferId: string,
    publicId: string,
    socketGeneration: number,
    remoteEpoch: string,
    version: number,
    content: string,
};

type EditorDocumentBase = {
    identity: DocumentProvenanceIdentity,
    bufferId: string,
    version: number,
    content: string,
    recordName?: string,
    persistence?: Promise<DocumentProvenanceRecord>,
    providerStat?: ProviderDocumentStat,
    causality: RealtimeEditorBridgeState,
    historyCausality?: HistoryRealtimeEditorBridgeState,
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
    delivery: 'workspace-edit' | 'provider-refresh',
    cleanRefresh?: PendingCleanEditorRefresh,
};

type PendingCleanEditorRefresh = {
    document: vscode.TextDocument,
    active: EditorDocumentBase,
    transaction: RemoteEditorTransaction,
    nextRemoteVersion: number,
    nextRemoteContent: string,
    candidateContents: Set<string>,
};

type PendingHistoryRemoteEditorTransaction = {
    document: vscode.TextDocument,
    active: EditorDocumentBase,
    transaction: HistoryRemoteEditorTransaction,
    consumed: boolean,
};

type PendingHistoryCleanEditorRefresh = {
    bufferId: string,
    docId: string,
    publicId: string,
    document: vscode.TextDocument,
    active: EditorDocumentBase,
    transaction: HistoryRemoteEditorTransaction,
    nextRemoteVersion: number,
    nextRemoteSnapshot: HistoryJsonValue,
    nextRemoteContent: string,
    candidateContents: Set<string>,
};

type PreparedHistoryRemoteEditorUpdate = {
    bufferId: string,
    document: vscode.TextDocument,
    active: EditorDocumentBase,
    transaction: HistoryRemoteEditorTransaction,
    delivery: 'workspace-edit' | 'provider-refresh',
    cleanRefresh?: PendingHistoryCleanEditorRefresh,
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

type LiveEditorSubmissionState = {
    bufferId: string,
    document: vscode.TextDocument,
    requested: boolean,
    timer?: NodeJS.Timeout,
    running?: Promise<void>,
};

type LiveEditorWriteSnapshot = {
    bufferId: string,
    document: vscode.TextDocument,
    documentVersion: number,
    content: string,
};

class StaleLiveEditorSnapshotError extends Error {
    constructor() {
        super('The live editor advanced while its previous snapshot was waiting to write');
        this.name = 'StaleLiveEditorSnapshotError';
    }
}

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

function isRealtimeUpdateSchema(value: unknown): value is UpdateSchema {
    return isPlainObject(value)
        && typeof value.doc === 'string'
        && value.doc.length > 0
        && isNonnegativeSafeInteger(value.v)
        && (value.op === undefined || Array.isArray(value.op));
}

function realtimeUpdateDocId(value: unknown): string | undefined {
    return isPlainObject(value) && typeof value.doc === 'string' && value.doc.length > 0
        ? value.doc
        : undefined;
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
    private providerReadWitnesses = new Map<string, ProviderDocumentReadWitness[]>();
    private pendingConditionalDocumentUpdates = new Map<string, PendingConditionalDocumentUpdate>();
    private conditionalRemoteAcceptances = new Map<string, ConditionalRemoteAcceptanceWitness>();
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
    private liveEditorSubmissions = new Map<string, LiveEditorSubmissionState>();
    private liveRecoverySuppressions?: Map<string, number>;
    private pendingRemoteEditorTransactions?: Map<string, PendingRemoteEditorTransaction>;
    private pendingCleanEditorRefreshes?: Map<string, PendingCleanEditorRefresh>;
    private pendingHistoryRemoteEditorTransactions?: Map<string, PendingHistoryRemoteEditorTransaction>;
    private pendingHistoryCleanEditorRefreshes?: Map<string, PendingHistoryCleanEditorRefresh>;
    private commentThreads?: HistoryJsonValue;
    private commentThreadsLoading?: Promise<HistoryJsonValue | undefined>;
    private commentThreadsEpoch = 0;
    private appliedHistoryOtThreadEventCount = 0;
    private changesUsers?: ChangesUserSchema[];
    private changesUsersLoading?: Promise<ChangesUserSchema[] | undefined>;
    private changesUsersEpoch = 0;
    private historyOtThreadEvents: HistoryOtRawThreadEventLog = {events: []};
    private rejectedHistoryOtThreadEvents: Array<{
        event: HistoryOtThreadEventName,
        args: HistoryJsonValue,
        reason: string,
    }> = [];
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
    private synctexOutputIdentityGeneration = 0;
    private pdfDownloadDomain?: string;
    private notify: (events:vscode.FileChangeEvent[])=>void;
    private clientManagerItem?: {manager: ClientManager, triggers: vscode.Disposable[]};
    private scmCollectionItem?: {collection: SCMCollectionProvider, triggers: vscode.Disposable[]};

    public readonly origin: vscode.Uri;
    public readonly projectName: string;
    public readonly serverName: string;
    public readonly serverUrl: string;
    public readonly projectId: string;

    get outputIdentityGeneration(): number {
        return this.synctexOutputIdentityGeneration;
    }

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
            const disposeError = new SocketRequestError(
                'disconnected',
                'The Overleaf project was closed while waiting for a document revision',
                true,
            );
            [...this.documentVersionWaiters.keys()].forEach(docId => {
                this.rejectDocumentVersionWaiters(docId, disposeError);
            });
            this.liveEditorSubmissions.forEach(state => {
                state.requested = false;
                if (state.timer) { clearTimeout(state.timer); }
            });
            this.liveEditorSubmissions.clear();
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
        this.assertAuthenticatedAccount();
        this.connectionRequested = true;
        if (this.root) {
            return Promise.resolve(this.root);
        }
        const root = await this.startInitialization(false);
        this.assertAuthenticatedAccount();
        return root;
    }

    private assertAuthenticatedAccount(uri?: vscode.Uri): void {
        const currentUserId = GlobalStateManager.getAuthenticatedUserId(
            this.context,
            this.serverName,
        );
        const uriUserId = uri === undefined ? this.userId : parseUri(uri).userId;
        if (uriUserId !== this.userId || currentUserId !== this.userId) {
            throw vscode.FileSystemError.NoPermissions(
                'The authenticated Overleaf account changed; reopen the project before editing',
            );
        }
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

    private cleanEditorRefreshMap(): Map<string, PendingCleanEditorRefresh> {
        return this.pendingCleanEditorRefreshes ??= new Map();
    }

    private historyRemoteEditorTransactionMap(): Map<string, PendingHistoryRemoteEditorTransaction> {
        return this.pendingHistoryRemoteEditorTransactions ??= new Map();
    }

    private historyCleanEditorRefreshMap(): Map<string, PendingHistoryCleanEditorRefresh> {
        return this.pendingHistoryCleanEditorRefreshes ??= new Map();
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
        prepared: PreparedShareJsDocumentJoin,
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

    private cancelLiveEditorSubmissions(docId?: string): void {
        for (const [bufferId, state] of this.liveEditorSubmissions) {
            const buffer = this.editorBuffers.get(bufferId);
            if (docId !== undefined && buffer !== undefined && buffer.docId !== docId) { continue; }
            state.requested = false;
            if (state.timer) { clearTimeout(state.timer); }
            this.liveEditorSubmissions.delete(bufferId);
        }
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

    private createHistoryEditorCausality(
        document: vscode.TextDocument,
        doc: DocumentEntity,
    ): HistoryRealtimeEditorBridgeState | undefined {
        const sender = this.currentSenderWitness();
        if (doc.otType !== 'history-ot'
            || !sender
            || !isNonnegativeSafeInteger(doc.version)
            || doc.historyOtSnapshot === undefined
            || !doc.historyOtEpoch
            || document.getText() !== doc.remoteCache) {
            return undefined;
        }
        try {
            return createHistoryRealtimeEditorBridgeState({
                socketGeneration: sender.generation,
                remoteEpoch: doc.historyOtEpoch,
                remoteVersion: doc.version,
                remoteSnapshot: doc.historyOtSnapshot,
                documentVersion: document.version,
                editorContent: document.getText(),
            });
        } catch {
            return undefined;
        }
    }

    private invalidateEditorBase(active: EditorDocumentBase): void {
        active.causality = {...active.causality, valid: false};
        if (active.historyCausality) {
            active.historyCausality = {...active.historyCausality, valid: false};
        }
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
        const resolved = this._resolveById(docId);
        const otType = resolved?.fileType === 'doc'
            ? (resolved.fileEntity as DocumentEntity).otType
            : undefined;
        if (GlobalStateManager.getAuthenticatedUserId(this.context, this.serverName) !== this.userId
            || !this.currentSenderWitness()
            || (otType !== 'sharejs-text-ot' && otType !== 'history-ot')) {
            return undefined;
        }
        return {
            canonicalServerUrl: this.serverUrl,
            userId: this.userId,
            projectId: this.projectId,
            docId,
            canonicalEditorUri: buffer.canonicalEditorUri,
            otType,
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
            this.providerReadWitnesses.delete(resourceKey);
            return;
        }
        const ledger = this.remoteDocumentCausality.get(doc._id);
        const hasOpenDocument = vscode.workspace.textDocuments.some(document =>
            !document.isClosed && this.resourceKey(document.uri) === resourceKey
        );
        if (doc.otType === 'sharejs-text-ot'
            && !hasOpenDocument
            && ledger?.valid
            && ledger.socketGeneration === sender.generation
            && ledger.headVersion === doc.version
            && ledger.headContent === content) {
            const currentEpoch = (this.providerReadWitnesses.get(resourceKey) ?? []).filter(
                witness => witness.docId === doc._id
                    && witness.publicId === sender.publicId
                    && witness.socketGeneration === sender.generation
                    && witness.remoteEpoch === ledger.epoch,
            );
            if (!currentEpoch.some(witness =>
                witness.version === doc.version && witness.content === content)) {
                currentEpoch.push({
                    token: randomUUID(),
                    resourceKey,
                    docId: doc._id,
                    canonicalEditorUri: this.canonicalEditorUri(doc._id),
                    version: doc.version,
                    content,
                    publicId: sender.publicId,
                    socketGeneration: sender.generation,
                    remoteEpoch: ledger.epoch,
                });
            }
            this.providerReadWitnesses.set(resourceKey, currentEpoch);
        } else {
            this.providerReadWitnesses.delete(resourceKey);
        }
        const alreadyObservedDocuments = vscode.workspace.textDocuments.filter(document =>
            !document.isClosed
            && this.resourceKey(document.uri) === resourceKey
            && this.wasDocumentOpenBeforeProviderRead(document)
        );
        const provenCleanRefresh = alreadyObservedDocuments.length === 1
            && this.matchesPendingCleanRefresh(alreadyObservedDocuments[0], doc, content);
        this.pendingReadTickets.set(resourceKey, {
            token: randomUUID(),
            resourceKey,
            docId: doc._id,
            canonicalEditorUri: this.canonicalEditorUri(doc._id),
            version: doc.version,
            content,
            publicId: sender.publicId,
            socketGeneration: sender.generation,
            requiresExplicitConfirmation: alreadyObservedDocuments.length > 0
                && !provenCleanRefresh,
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

    private matchesPendingCleanRefresh(
        document: vscode.TextDocument,
        doc: DocumentEntity,
        content: string,
    ): boolean {
        const bufferId = this.editorBufferIds.get(document);
        const pending = bufferId ? this.cleanEditorRefreshMap().get(bufferId) : undefined;
        const historyPending = bufferId
            ? this.historyCleanEditorRefreshMap().get(bufferId) : undefined;
        const buffer = bufferId ? this.editorBuffers.get(bufferId) : undefined;
        const sender = this.currentSenderWitness();
        const legacyMatches = Boolean(
            bufferId
            && pending
            && buffer
            && pending.document === document
            && pending.active === this.activeEditorBases.get(bufferId)
            && buffer.docId === doc._id
            && this.bufferMatchesIncarnation(buffer)
            && !document.isDirty
            && document.version >= pending.transaction.beforeDocumentVersion
            && pending.candidateContents.has(document.getText())
            && pending.nextRemoteVersion === doc.version
            && pending.nextRemoteContent === content
            && sender?.generation === pending.transaction.socketGeneration,
        );
        const active = bufferId ? this.activeEditorBases.get(bufferId) : undefined;
        const history = active?.historyCausality;
        const historyMatches = Boolean(
            bufferId
            && historyPending
            && buffer
            && active
            && history
            && historyPending.bufferId === bufferId
            && historyPending.docId === doc._id
            && historyPending.document === document
            && historyPending.active === active
            && buffer.docId === doc._id
            && this.bufferMatchesIncarnation(buffer)
            && !document.isDirty
            && document.version >= historyPending.transaction.beforeDocumentVersion
            && historyPending.candidateContents.has(document.getText())
            && historyPending.nextRemoteVersion === doc.version
            && historyPending.nextRemoteContent === content
            && doc.otType === 'history-ot'
            && doc.remoteCache === content
            && doc.historyOtSnapshot !== undefined
            && historyOtJsonEqual(doc.historyOtSnapshot, historyPending.nextRemoteSnapshot)
            && history.valid
            && history.authority === 'ready'
            && history.socketGeneration === historyPending.transaction.socketGeneration
            && history.remoteEpoch === historyPending.transaction.remoteEpoch
            && history.remoteVersion === historyPending.transaction.baseRemoteVersion
            && history.documentVersion === historyPending.transaction.beforeDocumentVersion
            && history.editorContent === historyPending.transaction.beforeEditorContent
            && history.inflightWire === undefined
            && history.inflightView === undefined
            && history.inflightToken === undefined
            && history.pending === undefined
            && sender?.publicId === historyPending.publicId
            && sender.generation === historyPending.transaction.socketGeneration,
        );
        const matched = legacyMatches ? pending : historyMatches ? historyPending : undefined;
        if (matched) {
            const recent = [...matched.candidateContents].at(-1);
            matched.candidateContents.clear();
            [
                matched.transaction.beforeEditorContent,
                document.getText(),
                recent,
                content,
            ].forEach(candidate => {
                if (candidate !== undefined) { matched.candidateContents.add(candidate); }
            });
        }
        return legacyMatches || historyMatches;
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
        // Once a host editor owns this resource, an anonymous FileSystemProvider
        // caller must not reuse the read which constructed that editor.
        this.providerReadWitnesses.delete(resourceKey);
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
        if (!buffer) { return; }
        this.providerReadWitnesses.delete(buffer.resourceKey);
        if (document.isClosed || document.isDirty) { return; }
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
            if (!this.bindFreshProviderReadCandidate(candidate)) {
                void vscode.window.showErrorMessage(vscode.l10n.t(
                    'The fresh Overleaf editor could not prove its remote base and remains read-only for saving.',
                ));
            }
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

    /**
     * A provider read which created this editor already came from the exact
     * joined snapshot and causal ledger. Bind that witness synchronously so a
     * first keystroke cannot race a redundant second joinDoc request.
     */
    private bindFreshProviderReadCandidate(candidate: BoundProviderReadCandidate): boolean {
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
        let authoritative: DocumentEntity | undefined;
        try {
            authoritative = this.currentDocument(ticket.docId);
        } catch {
            authoritative = undefined;
        }
        const identity = buffer
            ? this.documentProvenanceIdentity(ticket.docId, buffer) : undefined;
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
            || hasOtherDirtyAlias
            || !authoritative
            || authoritative.version !== ticket.version
            || authoritative.remoteCache !== ticket.content
            || !this.documentMatchesAuthority(
                authoritative,
                ticket.version,
                ticket.content,
            )
            || !identity) {
            discardCandidate();
            return false;
        }
        const causality = this.createLocalEditorCausality(
            document,
            ticket.docId,
            ticket.version,
            ticket.content,
        );
        const historyCausality = this.createHistoryEditorCausality(document, authoritative);
        if ((authoritative.otType === 'sharejs-text-ot' && !causality.valid)
            || (authoritative.otType === 'history-ot'
                && (!historyCausality || !historyCausality.valid))) {
            discardCandidate();
            return false;
        }
        this.activeEditorBases.set(bufferId, {
            identity,
            bufferId,
            version: ticket.version,
            content: ticket.content,
            providerStat: this.snapshotDocumentProviderStat(authoritative),
            causality,
            historyCausality,
        });
        this.cleanEditorRefreshMap().delete(bufferId);
        authoritative.localCache = ticket.content;
        discardCandidate();
        return true;
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
            providerStat: this.snapshotDocumentProviderStat(authoritative.doc),
            causality: this.createLocalEditorCausality(
                document,
                ticket.docId,
                ticket.version,
                ticket.content,
            ),
            historyCausality: this.createHistoryEditorCausality(document, authoritative.doc),
        });
        this.cleanEditorRefreshMap().delete(bufferId);
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
            const history = active.historyCausality;
            const pendingHistoryRemote = buffer
                ? this.historyRemoteEditorTransactionMap().get(buffer.bufferId) : undefined;
            const pendingHistoryClean = buffer
                ? this.historyCleanEditorRefreshMap().get(buffer.bufferId) : undefined;
            if (history) {
                if (pendingHistoryRemote) {
                    let next = commitHistoryRemoteEditorTransaction(
                        history,
                        pendingHistoryRemote.transaction,
                        document.version,
                        changes,
                        document.getText(),
                    );
                    if (pendingHistoryRemote.document !== document
                        || pendingHistoryRemote.active !== active
                        || sender?.generation !== next.socketGeneration) {
                        next = {...next, valid: false};
                    }
                    active.historyCausality = next;
                    pendingHistoryRemote.consumed = next.valid;
                    this.historyRemoteEditorTransactionMap().delete(buffer!.bufferId);
                    if (next.valid && next.inflightWire === undefined) {
                        active.version = next.remoteVersion;
                        active.content = getVisibleHistoryOtText(next.remoteSnapshot);
                        active.recordName = undefined;
                        active.persistence = undefined;
                    }
                    if (buffer && next.valid && next.pending !== undefined) {
                        this.scheduleLiveEditorSubmission(buffer, active);
                    }
                } else if (pendingHistoryClean) {
                    const transaction = pendingHistoryClean.transaction;
                    let current: DocumentEntity | undefined;
                    try {
                        current = this.currentDocument(active.identity.docId);
                    } catch {
                        current = undefined;
                    }
                    const cleanRefreshStillBound = history.valid
                        && history.authority === 'ready'
                        && pendingHistoryClean.bufferId === buffer!.bufferId
                        && pendingHistoryClean.docId === active.identity.docId
                        && pendingHistoryClean.document === document
                        && pendingHistoryClean.active === active
                        && transaction.socketGeneration === history.socketGeneration
                        && transaction.remoteEpoch === history.remoteEpoch
                        && transaction.baseRemoteVersion === history.remoteVersion
                        && transaction.beforeDocumentVersion === history.documentVersion
                        && transaction.beforeEditorContent === history.editorContent
                        && !document.isDirty
                        && Number.isSafeInteger(document.version)
                        && document.version >= history.documentVersion
                        && pendingHistoryClean.candidateContents.has(document.getText())
                        && history.inflightWire === undefined
                        && history.inflightView === undefined
                        && history.inflightToken === undefined
                        && history.pending === undefined
                        && sender?.publicId === pendingHistoryClean.publicId
                        && sender.generation === history.socketGeneration
                        && current !== undefined
                        && current._id === pendingHistoryClean.docId
                        && current.otType === 'history-ot'
                        && current.version === pendingHistoryClean.nextRemoteVersion
                        && current.remoteCache === pendingHistoryClean.nextRemoteContent
                        && current.historyOtSnapshot !== undefined
                        && historyOtJsonEqual(
                            current.historyOtSnapshot,
                            pendingHistoryClean.nextRemoteSnapshot,
                        );
                    const cleanRefreshComplete = cleanRefreshStillBound
                        && document.version > history.documentVersion
                        && document.getText() === pendingHistoryClean.nextRemoteContent;
                    let next = cleanRefreshComplete
                        ? commitHistoryCleanRemoteEditorTransaction(
                            history,
                            transaction,
                            document.version,
                            document.getText(),
                        )
                        : {...history, valid: cleanRefreshStillBound};
                    if (!cleanRefreshStillBound
                        || pendingHistoryClean.document !== document
                        || pendingHistoryClean.active !== active
                        || document.isDirty
                        || !current
                        || sender?.publicId !== pendingHistoryClean.publicId
                        || sender.generation !== next.socketGeneration) {
                        next = {...next, valid: false};
                    }
                    active.historyCausality = next;
                    if (!next.valid || cleanRefreshComplete) {
                        this.historyCleanEditorRefreshMap().delete(buffer!.bufferId);
                        this.pendingReadTickets.delete(buffer!.resourceKey);
                        this.boundReadCandidates.delete(buffer!.bufferId);
                    }
                    if (next.valid && cleanRefreshComplete && current) {
                        active.version = next.remoteVersion;
                        active.content = getVisibleHistoryOtText(next.remoteSnapshot);
                        active.recordName = undefined;
                        active.persistence = undefined;
                        active.providerStat = this.snapshotDocumentProviderStat(current);
                        this.stageEditorBase(document.uri, current, document.getText());
                    }
                } else if (changes.length === 0) {
                    active.historyCausality = {
                        ...history,
                        valid: history.valid
                            && sender?.generation === history.socketGeneration
                            && document.version >= history.documentVersion
                            && document.getText() === history.editorContent,
                        documentVersion: document.version,
                    };
                } else {
                    const tracked = this.permissionsLevel === 'review'
                        || vscode.workspace.getConfiguration(ROOT_NAME, document.uri)
                            .get<boolean>('trackChanges.enabled', false);
                    const currentDescriptor = history.pendingWriteDescriptor
                        ?? history.inflightWriteDescriptor;
                    const descriptor: HistoryEditorWriteDescriptor = currentDescriptor?.kind
                        === (tracked ? 'tracked-write' : 'plain-write')
                        ? currentDescriptor
                        : tracked ? {
                            kind: 'tracked-write',
                            tracking: {userId: this.userId, ts: new Date().toISOString()},
                        } : {kind: 'plain-write'};
                    active.historyCausality = sender?.generation === history.socketGeneration
                        ? recordHistoryLocalEditorChange(
                            history,
                            document.version,
                            changes,
                            document.getText(),
                            descriptor,
                        ) : {...history, valid: false};
                    if (buffer && active.historyCausality.valid
                        && active.historyCausality.pending !== undefined) {
                        this.scheduleLiveEditorSubmission(buffer, active);
                    }
                }
            } else {
            const pendingRemote = buffer ?
                this.remoteEditorTransactionMap().get(buffer.bufferId) : undefined;
            const pendingCleanRefresh = buffer ?
                this.cleanEditorRefreshMap().get(buffer.bufferId) : undefined;
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
                if (buffer && next.valid && next.pendingOperations.length > 0) {
                    this.scheduleLiveEditorSubmission(buffer, active);
                }
            } else if (pendingCleanRefresh) {
                const state = active.causality;
                const transaction = pendingCleanRefresh.transaction;
                const cleanRefreshStillBound = state.valid
                    && pendingCleanRefresh.document === document
                    && pendingCleanRefresh.active === active
                    && transaction.socketGeneration === state.socketGeneration
                    && transaction.remoteEpoch === state.remoteEpoch
                    && transaction.baseRemoteVersion === state.remoteVersion
                    && transaction.beforeDocumentVersion === state.documentVersion
                    && transaction.beforeEditorContent === state.editorContent
                    && !document.isDirty
                    && document.version >= state.documentVersion
                    && pendingCleanRefresh.candidateContents.has(document.getText())
                    && state.inflightWire === undefined
                    && state.inflightToken === undefined
                    && state.inflightView === undefined
                    && state.pendingOperations.length === 0
                    && state.localOperations.length === 0;
                const cleanRefreshComplete = cleanRefreshStillBound
                    && document.version > state.documentVersion
                    && document.getText() === pendingCleanRefresh.nextRemoteContent;
                let next: RealtimeEditorBridgeState = cleanRefreshComplete ? {
                    ...state,
                    remoteVersion: pendingCleanRefresh.nextRemoteVersion,
                    remoteContent: pendingCleanRefresh.nextRemoteContent,
                    documentVersion: document.version,
                    editorContent: pendingCleanRefresh.nextRemoteContent,
                } : {
                    ...state,
                    valid: cleanRefreshStillBound,
                };
                let current: DocumentEntity | undefined;
                try {
                    current = this.currentDocument(active.identity.docId);
                } catch {
                    current = undefined;
                }
                if (!cleanRefreshStillBound
                    || pendingCleanRefresh.document !== document
                    || pendingCleanRefresh.active !== active
                    || document.isDirty
                    || sender?.generation !== next.socketGeneration
                    || !current
                    || !this.documentMatchesAuthority(
                        current,
                        pendingCleanRefresh.nextRemoteVersion,
                        pendingCleanRefresh.nextRemoteContent,
                    )) {
                    next = {...next, valid: false};
                }
                if (!next.valid || cleanRefreshComplete) {
                    active.causality = next;
                    this.cleanEditorRefreshMap().delete(buffer!.bufferId);
                    this.pendingReadTickets.delete(buffer!.resourceKey);
                    this.boundReadCandidates.delete(buffer!.bufferId);
                }
                if (next.valid && cleanRefreshComplete && current) {
                    active.version = next.remoteVersion;
                    active.content = next.remoteContent;
                    active.recordName = undefined;
                    active.persistence = undefined;
                    active.providerStat = this.snapshotDocumentProviderStat(current);
                    this.stageEditorBase(document.uri, current, next.remoteContent);
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
                if (buffer && active.causality.valid) {
                    this.scheduleLiveEditorSubmission(buffer, active);
                }
            }
            }
        }
        this.observeTextDocument(document);
    }

    private scheduleLiveEditorSubmission(
        buffer: EditorBufferState,
        active: EditorDocumentBase,
    ): void {
        if (this.disposed
            || !this.bufferMatchesIncarnation(buffer)
            || this.activeEditorBases.get(buffer.bufferId) !== active
            || !this.hasPendingLiveEditorSubmission(active)) {
            return;
        }
        let state = this.liveEditorSubmissions.get(buffer.bufferId);
        if (!state || state.document !== buffer.document) {
            if (state?.timer) { clearTimeout(state.timer); }
            state = {
                bufferId: buffer.bufferId,
                document: buffer.document,
                requested: false,
            };
            this.liveEditorSubmissions.set(buffer.bufferId, state);
        }
        state.requested = true;
        if (state.running) { return; }
        // Keep the first timer for this batch. Resetting it on every keystroke
        // makes continuous typing postpone collaboration indefinitely.
        if (state.timer) { return; }
        state.timer = setTimeout(() => {
            if (this.liveEditorSubmissions.get(state!.bufferId) !== state) { return; }
            state!.timer = undefined;
            void this.startLiveEditorSubmission(state!).catch(error => {
                console.warn('Unable to submit live Overleaf editor changes', error);
            });
        }, LIVE_EDITOR_SUBMIT_DEBOUNCE_MS);
    }

    private startLiveEditorSubmission(state: LiveEditorSubmissionState): Promise<void> {
        if (state.running) { return state.running; }
        if (state.timer) {
            clearTimeout(state.timer);
            state.timer = undefined;
        }
        let running!: Promise<void>;
        running = this.drainLiveEditorSubmission(state).finally(() => {
            if (state.running === running) {
                state.running = undefined;
            }
            if (this.liveEditorSubmissions.get(state.bufferId) !== state) { return; }
            if (state.requested) {
                state.timer = setTimeout(() => {
                    if (this.liveEditorSubmissions.get(state.bufferId) !== state) { return; }
                    state.timer = undefined;
                    void this.startLiveEditorSubmission(state).catch(error => {
                        console.warn('Unable to submit live Overleaf editor changes', error);
                    });
                }, LIVE_EDITOR_SUBMIT_DEBOUNCE_MS);
            } else {
                this.liveEditorSubmissions.delete(state.bufferId);
            }
        });
        state.running = running;
        return running;
    }

    private async drainLiveEditorSubmission(state: LiveEditorSubmissionState): Promise<void> {
        while (state.requested) {
            state.requested = false;
            const buffer = this.editorBuffers.get(state.bufferId);
            const active = this.activeEditorBases.get(state.bufferId);
            if (this.disposed
                || buffer?.document !== state.document
                || !this.bufferMatchesIncarnation(buffer)
                || !active
                || !this.hasPendingLiveEditorSubmission(active)
                || (active.historyCausality !== undefined
                    && active.historyCausality.authority !== 'ready')) {
                return;
            }
            const content = state.document.getText();
            const snapshot: LiveEditorWriteSnapshot = {
                bufferId: state.bufferId,
                document: state.document,
                documentVersion: state.document.version,
                content,
            };
            try {
                await this.writeFile(
                    state.document.uri,
                    new TextEncoder().encode(content),
                    false,
                    true,
                    state.bufferId,
                    snapshot,
                );
                const current = this.editorBuffers.get(state.bufferId);
                if (this.disposed
                    || this.liveEditorSubmissions.get(state.bufferId) !== state
                    || current?.document !== state.document
                    || !this.bufferMatchesIncarnation(current)) {
                    state.requested = false;
                    return;
                }
            } catch (error) {
                if (error instanceof StaleLiveEditorSnapshotError) {
                    const currentBuffer = this.editorBuffers.get(state.bufferId);
                    const currentActive = this.activeEditorBases.get(state.bufferId);
                    if (!this.disposed
                        && this.liveEditorSubmissions.get(state.bufferId) === state
                        && currentBuffer?.document === state.document
                        && this.bufferMatchesIncarnation(currentBuffer)
                        && currentActive !== undefined
                        && this.hasPendingLiveEditorSubmission(currentActive)) {
                        state.requested = true;
                        continue;
                    }
                }
                // A deterministic rejection leaves the recorded operation
                // available for an explicit save. Outcome-unknown errors
                // invalidate the causal session in writeFileNow.
                state.requested = false;
                if (this.disposed) {
                    return;
                }
                throw error;
            }
        }
    }

    private liveEditorSnapshotWasProvenAdvanced(
        doc: DocumentEntity,
        snapshot: LiveEditorWriteSnapshot,
    ): boolean {
        const buffer = this.editorBuffers.get(snapshot.bufferId);
        const active = this.activeEditorBases.get(snapshot.bufferId);
        if (buffer?.document !== snapshot.document
            || !this.bufferMatchesIncarnation(buffer)
            || buffer.docId !== doc._id
            || active === undefined
            || active.identity.docId !== doc._id
            || snapshot.document.version <= snapshot.documentVersion
            || snapshot.document.getText() === snapshot.content
            || this.pendingDocumentUpdates.has(snapshot.bufferId)
            || active.causality.inflightToken !== undefined
            || active.historyCausality?.inflightToken !== undefined
            || !this.hasPendingLiveEditorSubmission(active)) {
            return false;
        }
        if (active.identity.otType === 'history-ot') {
            const history = active.historyCausality;
            return history?.valid === true
                && history.authority === 'ready'
                && history.documentVersion === snapshot.document.version
                && history.editorContent === snapshot.document.getText()
                && this.documentMatchesAuthority(
                    doc,
                    history.remoteVersion,
                    getVisibleHistoryOtText(history.remoteSnapshot),
                );
        }
        return active.identity.otType === 'sharejs-text-ot'
            && active.causality.valid
            && active.causality.documentVersion === snapshot.document.version
            && active.causality.editorContent === snapshot.document.getText()
            && this.documentMatchesAuthority(
                doc,
                active.causality.remoteVersion,
                active.causality.remoteContent,
            );
    }

    private hasPendingLiveEditorSubmission(active: EditorDocumentBase): boolean {
        if (active.identity.otType === 'history-ot') {
            return active.historyCausality?.valid === true
                && active.historyCausality.pending !== undefined;
        }
        return active.identity.otType === 'sharejs-text-ot'
            && active.causality.valid
            && active.causality.pendingOperations.length > 0;
    }

    private flushLiveEditorSubmission(bufferId: string): Promise<void> | undefined {
        const state = this.liveEditorSubmissions.get(bufferId);
        if (!state) { return undefined; }
        state.requested = true;
        return this.startLiveEditorSubmission(state);
    }

    private async flushLiveEditorSubmissionForUri(uri: vscode.Uri): Promise<void> {
        const resourceKey = this.resourceKey(uri);
        const matching = [...this.liveEditorSubmissions.values()].filter(state => {
            const buffer = this.editorBuffers.get(state.bufferId);
            return buffer?.document === state.document
                && buffer.resourceKey === resourceKey
                && this.bufferMatchesIncarnation(buffer);
        });
        if (matching.length === 1) {
            await this.startLiveEditorSubmission(matching[0]);
        } else if (matching.length > 1) {
            throw vscode.FileSystemError.Unavailable(vscode.l10n.t(
                'Overleaf save blocked: multiple live editor buffers match this document',
            ));
        }
    }

    /** A backspace caret can precede its text update only if the prefix before
     * it is identical in every outstanding snapshot. Overleaf keeps remote
     * carets at absolute offsets during remote edits; leaving the old caret at
     * the end of a shrinking line would briefly draw it on the following line. */
    canPublishPendingDeletionCursor(document: vscode.TextDocument, offset: number): boolean {
        const bufferId = this.editorBufferIds.get(document);
        const buffer = bufferId ? this.editorBuffers.get(bufferId) : undefined;
        const active = bufferId ? this.activeEditorBases.get(bufferId) : undefined;
        if (!buffer || !active || !this.bufferMatchesIncarnation(buffer)
            || active.identity.otType !== 'sharejs-text-ot') { return false; }
        const state = active.causality;
        const content = document.getText();
        const sender = this.currentSenderWitness();
        return state.valid
            && state.socketGeneration === sender?.generation
            && state.documentVersion === document.version
            && state.editorContent === content
            && Number.isSafeInteger(offset) && offset >= 0 && offset <= content.length
            && state.localOperations.length > 0
            && state.localOperations.every(op => op.d !== undefined && op.p >= offset)
            && state.remoteContent.slice(0, offset) === content.slice(0, offset)
            && this.documentMatchesAuthority(
                this.currentDocument(buffer.docId), state.remoteVersion, state.remoteContent,
            );
    }

    /** Presence coordinates have no revision on the wire. Except for an
     * unchanged deletion prefix, wait for the exact authoritative head. */
    async flushEditorChangesForPresence(document: vscode.TextDocument): Promise<boolean> {
        await this.flushLiveEditorSubmissionForUri(document.uri);
        const bufferId = this.editorBufferIds.get(document);
        const buffer = bufferId ? this.editorBuffers.get(bufferId) : undefined;
        const active = bufferId ? this.activeEditorBases.get(bufferId) : undefined;
        if (!buffer || !active || !this.bufferMatchesIncarnation(buffer)) { return false; }
        const doc = this.currentDocument(buffer.docId);
        const content = document.getText();
        if (active.historyCausality) {
            const state = active.historyCausality;
            return state.valid && state.authority === 'ready'
                && state.documentVersion === document.version
                && state.editorContent === content
                && state.pending === undefined && state.inflightToken === undefined
                && this.documentMatchesAuthority(doc, state.remoteVersion, content);
        }
        const state = active.causality;
        return state.valid && state.documentVersion === document.version
            && state.editorContent === content
            && state.pendingOperations.length === 0 && state.inflightToken === undefined
            && this.documentMatchesAuthority(doc, state.remoteVersion, content);
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
                    providerStat: this.snapshotDocumentProviderStat(
                        this.currentDocument(receipt.identity.docId),
                    ),
                    causality: this.createLocalEditorCausality(
                        document,
                        receipt.identity.docId,
                        receipt.version,
                        receipt.content,
                    ),
                    historyCausality: this.createHistoryEditorCausality(
                        document,
                        this.currentDocument(receipt.identity.docId),
                    ),
                });
                this.cleanEditorRefreshMap().delete(buffer.bufferId);
                this.editorSaveReceipts.delete(buffer.bufferId);
            }
            return;
        }

        const active = this.activeEditorBases.get(buffer.bufferId);
        if (!active) { return; }
        const pending = this.pendingDocumentUpdates.get(buffer.bufferId);
        if (pending) {
            const dirtyText = document.getText();
            let persistence: Promise<DocumentProvenanceRecord>;
            if (pending.otType === 'history-ot') {
                const beforePersistence = pending.durablePendingWriteTransition
                    ?? Promise.resolve();
                persistence = beforePersistence.then(() => {
                    if (pending.durablePendingWriteCleared) {
                        const base = pending.durableReconciledBase;
                        if (!base) {
                            throw new Error(
                                'Confirmed History recovery lost its reconciled durability base',
                            );
                        }
                        return this.provenanceStore.createOrUpdateCurrent({
                            identity: base.identity,
                            bufferIncarnationId: pending.bufferId,
                            baseVersion: base.baseVersion,
                            baseText: base.baseText,
                            dirtyText,
                        });
                    }
                    return this.provenanceStore.updatePendingDirtyText(
                        pending.provenanceRecordName,
                        pending.durablePendingWrite ?? this.pendingWritePayload(pending),
                        dirtyText,
                    );
                });
                const transition = persistence.then(() => undefined);
                // Keep the rejected promise available to the fail-closed History
                // reconciliation path without exposing an unhandled rejection
                // while an outcome-unknown write awaits a later fresh join.
                void transition.catch(() => {});
                pending.durablePendingWriteTransition = transition;
            } else {
                persistence = this.provenanceStore.updatePendingDirtyText(
                    pending.provenanceRecordName,
                    this.pendingWritePayload(pending),
                    dirtyText,
                );
            }
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

    observeWillSaveTextDocument(document: vscode.TextDocument): void {
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

    private matchesUnboundEditorSave(uri: vscode.Uri, desiredContent: string): boolean {
        const resourceKey = this.resourceKey(uri);
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
        const buffer = this.editorBuffers.get(bufferId);
        const acceptance = buffer
            ? this.conditionalRemoteAcceptances.get(buffer.docId) : undefined;
        if (acceptance?.document === document && acceptance.bufferId === bufferId) {
            this.conditionalRemoteAcceptances.delete(buffer!.docId);
        }
        const live = this.liveEditorSubmissions.get(bufferId);
        if (live) {
            live.requested = false;
            if (live.timer) { clearTimeout(live.timer); }
            this.liveEditorSubmissions.delete(bufferId);
        }
        this.editorBuffers.delete(bufferId);
        this.activeEditorBases.delete(bufferId);
        this.editorSaveIntents.delete(bufferId);
        this.editorSaveReceipts.delete(bufferId);
        this.boundReadCandidates.delete(bufferId);
        this.remoteEditorTransactionMap().delete(bufferId);
        this.cleanEditorRefreshMap().delete(bufferId);
        this.historyRemoteEditorTransactionMap().delete(bufferId);
        this.historyCleanEditorRefreshMap().delete(bufferId);
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
            providerStat: this.snapshotDocumentProviderStat(current),
            causality: this.createLocalEditorCausality(
                document,
                staged.docId,
                staged.version,
                staged.content,
            ),
            historyCausality: this.createHistoryEditorCausality(document, current),
        });
        this.pendingReadTickets.delete(buffer.resourceKey);
        this.boundReadCandidates.delete(buffer.bufferId);
        this.cleanEditorRefreshMap().delete(buffer.bufferId);
        current.localCache = staged.content;
        return true;
    }

    private resolveWritingBuffer(
        uri: vscode.Uri,
        docId: string,
        desiredContent: string,
        consumeSaveIntent = true,
    ): {kind: 'valid', witness: EditorBufferWitness}
        | {kind: 'superseded'}
        | {kind: 'blocked', reason: string} {
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
            if (consumeSaveIntent && !exactIntents.includes(intent)) {
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
            if (consumeSaveIntent) {
                this.editorSaveIntents.delete(witness.bufferId);
            }
        } else {
            const superseded = consumeSaveIntent ? matchingIntents.filter(intent => {
                const buffer = this.editorBuffers.get(intent.bufferId);
                const active = this.activeEditorBases.get(intent.bufferId);
                let current: DocumentEntity | undefined;
                try {
                    current = this.currentDocument(docId);
                } catch {
                    current = undefined;
                }
                return intent.docId === docId
                    && intent.content === desiredContent
                    && buffer?.document === intent.document
                    && this.bufferMatchesIncarnation(buffer)
                    && active !== undefined
                    && active.causality.valid
                    && active.causality.inflightWire === undefined
                    && active.causality.inflightView === undefined
                    && active.causality.inflightToken === undefined
                    && active.causality.pendingOperations.length === 0
                    && active.causality.localOperations.length === 0
                    && active.causality.documentVersion === buffer.document.version
                    && active.causality.editorContent === buffer.document.getText()
                    && current !== undefined
                    && this.documentMatchesAuthority(
                        current,
                        active.causality.remoteVersion,
                        active.causality.remoteContent,
                    )
                    && buffer.document.getText() === active.causality.remoteContent;
            }) : [];
            if (superseded.length === 1) {
                this.editorSaveIntents.delete(superseded[0].bufferId);
                return {kind: 'superseded'};
            }
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

    private claimProviderReadWitness(
        uri: vscode.Uri,
        docId: string,
    ): {kind: 'valid', witness: ProviderDocumentReadWitness}
        | {kind: 'blocked', reason: string} {
        vscode.workspace.textDocuments.forEach(document => {
            this.observeEditorBuffer(document);
        });
        const canonicalEditorUri = this.canonicalEditorUri(docId);
        const hasOpenEditor = [...this.editorBuffers.values()].some(buffer =>
            buffer.canonicalEditorUri === canonicalEditorUri
            && vscode.workspace.textDocuments.includes(buffer.document)
            && !buffer.document.isClosed
        );
        const resourceKey = this.resourceKey(uri);
        const witnesses = this.providerReadWitnesses.get(resourceKey) ?? [];
        const sender = this.currentSenderWitness();
        const ledger = this.remoteDocumentCausality.get(docId);
        if (hasOpenEditor) {
            this.providerReadWitnesses.delete(resourceKey);
            return {kind: 'blocked', reason: 'an editor buffer owns this remote document'};
        }
        const current = witnesses.filter(witness =>
            witness.resourceKey === resourceKey
            && witness.docId === docId
            && witness.canonicalEditorUri === canonicalEditorUri
            && witness.publicId === sender?.publicId
            && witness.socketGeneration === sender?.generation
            && witness.remoteEpoch === ledger?.epoch
            && witness.version === ledger?.headVersion
            && witness.content === ledger?.headContent
        );
        if (current.length !== 1) {
            this.providerReadWitnesses.delete(resourceKey);
            return {
                kind: 'blocked',
                reason: current.length === 0
                    ? 'no exact current-head provider read witness is available'
                    : 'multiple current-head provider reads are ambiguous; read the document again',
            };
        }
        const witness = current[0];
        // Claim before any asynchronous work. The standard VS Code file-system
        // API carries no caller-owned token, so safe use is necessarily
        // single-shot and resource-local.
        this.providerReadWitnesses.delete(resourceKey);
        if (witness.resourceKey !== resourceKey
            || witness.docId !== docId
            || witness.canonicalEditorUri !== canonicalEditorUri
            || sender?.publicId !== witness.publicId
            || sender.generation !== witness.socketGeneration
            || !ledger?.valid
            || ledger.socketGeneration !== witness.socketGeneration
            || ledger.epoch !== witness.remoteEpoch
            || ledger.headVersion !== witness.version
            || ledger.headContent !== witness.content) {
            return {kind: 'blocked', reason: 'the provider read witness is stale or incomplete'};
        }
        return {kind: 'valid', witness};
    }

    private providerReadWitnessMatchesAuthority(
        witness: ProviderDocumentReadWitness,
        doc: DocumentEntity,
        version: number,
        content: string,
    ): boolean {
        const sender = this.currentSenderWitness();
        const ledger = this.remoteDocumentCausality.get(doc._id);
        return witness.docId === doc._id
            && witness.version === version
            && witness.content === content
            && sender?.publicId === witness.publicId
            && sender.generation === witness.socketGeneration
            && this.documentMatchesAuthority(doc, version, content)
            && ledger?.valid === true
            && ledger.socketGeneration === witness.socketGeneration
            && ledger.epoch === witness.remoteEpoch
            && ledger.headVersion === version
            && ledger.headContent === content;
    }

    private causalEvidenceForProviderWrite(
        witness: ProviderDocumentReadWitness,
        remoteVersion: number,
        remoteContent: string,
        desiredContent: string,
    ): CausalDocumentEvidence | undefined {
        const sender = this.currentSenderWitness();
        const remote = this.remoteDocumentCausality.get(witness.docId);
        const localOperations = operationsFromContentSnapshots(witness.content, desiredContent);
        if (!sender
            || sender.publicId !== witness.publicId
            || sender.generation !== witness.socketGeneration
            || !isNonnegativeSafeInteger(witness.version)
            || !isNonnegativeSafeInteger(remoteVersion)
            || !localOperations
            || !remote?.valid
            || remote.socketGeneration !== witness.socketGeneration
            || remote.epoch !== witness.remoteEpoch
            || remote.anchorVersion > witness.version
            || remote.headVersion !== remoteVersion
            || remote.headContent !== remoteContent) {
            return undefined;
        }
        const remoteUpdates = [];
        for (let version = witness.version; version < remoteVersion; version += 1) {
            const operations = remote.updates.get(version);
            if (!operations) { return undefined; }
            remoteUpdates.push({
                version,
                operations: operations.map(operation => ({...operation})),
            });
        }
        return {
            localOperations: localOperations.map(operation => ({...operation})),
            remoteUpdates,
        };
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
        const previousProviderStat = this.activeEditorBases.get(witness.bufferId)?.providerStat;
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
            providerStat: previousProviderStat ?? this.snapshotDocumentProviderStat(doc),
            causality: this.createLocalEditorCausality(
                witness.document,
                doc._id,
                expectedVersion,
                authoritativeContent,
            ),
            historyCausality: this.createHistoryEditorCausality(witness.document, doc),
        });
        this.cleanEditorRefreshMap().delete(witness.bufferId);
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

    private liveRecoverySuppressionKey(uri: vscode.Uri): string {
        return this.resourceKey(uri);
    }

    private beginLiveRecoverySuppression(uri: vscode.Uri): string {
        const key = this.liveRecoverySuppressionKey(uri);
        const suppressions = this.liveRecoverySuppressions ??= new Map<string, number>();
        suppressions.set(key, (suppressions.get(key) ?? 0) + 1);
        return key;
    }

    private endLiveRecoverySuppression(key: string): void {
        const suppressions = this.liveRecoverySuppressions;
        const count = suppressions?.get(key);
        if (count === undefined) { return; }
        if (count <= 1) {
            suppressions!.delete(key);
        } else {
            suppressions!.set(key, count - 1);
        }
    }

    private isLiveRecoverySuppressed(uri: vscode.Uri): boolean {
        return (this.liveRecoverySuppressions?.get(
            this.liveRecoverySuppressionKey(uri),
        ) ?? 0) > 0;
    }

    private showDocumentRecovery(uri: vscode.Uri, _content: Uint8Array, reason: string) {
        if (this.isLiveRecoverySuppressed(uri)) { return; }
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
                const exactBufferBeforeSave = stillOriginalBuffer();
                const ledgerBeforeSave = this.remoteDocumentCausality.get(buffer.docId);
                if (exactBufferBeforeSave?.docId !== buffer.docId
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
                const pendingConditional = this.pendingConditionalDocumentUpdates.get(buffer.docId);
                const acceptance = pendingConditional
                    && pendingConditional.resourceKey === key
                    && pendingConditional.docId === buffer.docId
                    && pendingConditional.identity.canonicalEditorUri
                        === exactBufferBeforeSave.canonicalEditorUri
                    && senderBeforeSave.generation !== pendingConditional.socketGeneration
                    && ledgerBeforeSave?.valid === true
                    && ledgerBeforeSave.socketGeneration === senderBeforeSave.generation
                    && ledgerBeforeSave.headVersion === authoritativeVersion
                    && ledgerBeforeSave.headContent === authoritativeText
                    ? {
                        pendingToken: pendingConditional.token,
                        provenanceRecordName: pendingConditional.provenanceRecordName,
                        resourceKey: key,
                        docId: buffer.docId,
                        document,
                        bufferId: exactBufferBeforeSave.bufferId,
                        publicId: senderBeforeSave.publicId,
                        socketGeneration: senderBeforeSave.generation,
                        remoteEpoch: ledgerBeforeSave.epoch,
                        version: authoritativeVersion,
                        content: authoritativeText,
                    } : undefined;
                if (acceptance) {
                    this.conditionalRemoteAcceptances.set(buffer.docId, acceptance);
                }
                let saved: boolean;
                try {
                    saved = await document.save();
                } finally {
                    if (acceptance
                        && this.conditionalRemoteAcceptances.get(buffer.docId) === acceptance) {
                        this.conditionalRemoteAcceptances.delete(buffer.docId);
                    }
                }
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
        if (!this.isLiveRecoverySuppressed(uri)) {
            this.showDocumentRecovery(uri, content, reason);
        }
        throw vscode.FileSystemError.Unavailable(
            vscode.l10n.t('Overleaf save blocked: {reason}', {reason}),
        );
    }

    private historyPendingForDocument(docId: string): PendingDocumentUpdate | undefined {
        const matches = [...this.pendingDocumentUpdates.values()].filter(pending =>
            pending.otType === 'history-ot'
            && pending.docId === docId
            && (pending.historySession?.getState().hasPendingOperation === true
                || pending.confirmationVersion !== undefined)
        );
        return matches.length === 1 ? matches[0] : undefined;
    }

    /** Capture exact same-generation collaborator evidence after a sender ACK. */
    private recordConfirmedHistoryCollaboratorUpdate(
        update: unknown,
        eventSender?: ProjectSenderWitness,
    ): boolean {
        let parsed;
        try {
            parsed = parseHistoryOtRealtimeEnvelope(update);
        } catch {
            return false;
        }
        const docId = parsed.doc;
        if (!docId) { return false; }
        const matches = [...this.pendingDocumentUpdates.values()].filter(pending =>
            pending.otType === 'history-ot'
            && pending.docId === docId
            && pending.confirmationVersion !== undefined
        );
        if (matches.length === 0) { return false; }
        if (matches.length !== 1) {
            matches.forEach(pending => {
                if (pending.historyConfirmedAdvance) {
                    pending.historyConfirmedAdvance.invalidReason =
                        'multiple confirmed History writes share one document';
                }
            });
            return true;
        }
        const pending = matches[0];
        const advance = pending.historyConfirmedAdvance;
        const current = this.currentSenderWitness();
        const reject = (reason: string) => {
            if (advance) { advance.invalidReason ??= reason; }
            return true;
        };
        if (!advance) { return reject('confirmed History advance has no ACK ledger'); }
        if (advance.reconcilingVersion !== undefined) {
            // Reconciliation has frozen the pre-join evidence set. Preserve all
            // later wire events losslessly; they are validated and installed
            // behind one durable non-resendable marker before that marker is
            // cleared.
            advance.deferredUpdates ??= [];
            advance.deferredUpdates.push({
                update: deepCloneJson(parsed.raw),
                sender: eventSender ? {...eventSender} : undefined,
            });
            return true;
        }
        if (advance.handoffInstalled) { return false; }
        if (!parsed.safe
            || parsed.classification !== 'collaborator-update'
            || parsed.version === undefined
            || parsed.operation === undefined) {
            return reject(`unsafe confirmed History collaborator update: ${parsed.unsafeReasons.join('; ')}`);
        }
        if (!current
            || eventSender?.publicId !== advance.publicId
            || eventSender.generation !== advance.socketGeneration
            || current.publicId !== advance.publicId
            || current.generation !== advance.socketGeneration) {
            return reject('confirmed History collaborator update changed sender generation');
        }
        if (parsed.version < advance.committedVersion
            || typeof parsed.source !== 'string'
            || pending.submittedPublicIds.includes(parsed.source)
            || parsed.duplicate) {
            return reject('confirmed History collaborator update has unproven ancestry');
        }
        const raw = deepCloneJson(parsed.raw) as HistoryJsonValue;
        const operation = serializeHistoryOtWireOperation(parsed.operation);
        const previous = advance.updates.get(parsed.version);
        if (previous) {
            if (!historyOtJsonEqual(previous.raw, raw)) {
                advance.invalidReason ??= 'conflicting confirmed History collaborator revision';
            }
            return true;
        }
        advance.updates.set(parsed.version, {raw, operation});
        return true;
    }

    private invalidateDocumentSessions(project?: ProjectEntity) {
        this.cancelLiveEditorSubmissions();
        this.conditionalRemoteAcceptances.clear();
        this.pendingReadTickets.clear();
        this.boundReadCandidates.clear();
        this.remoteEditorTransactionMap().clear();
        this.cleanEditorRefreshMap().clear();
        this.historyRemoteEditorTransactionMap().clear();
        this.historyCleanEditorRefreshMap().clear();
        const documentIds = new Set(this.documentMap(project).keys());
        this.activeEditorBases.forEach(active => {
            if (documentIds.has(active.identity.docId)) {
                active.causality = {...active.causality, valid: false};
                const pending = this.historyPendingForDocument(active.identity.docId);
                const preserveHistoryRecovery = pending?.bufferId === active.bufferId
                    && pending.historySession
                        === this.documentMap(project).get(active.identity.docId)?.historyOtSession
                    && active.historyCausality?.inflightWire !== undefined
                    && (active.historyCausality.inflightToken === pending.submissionToken
                        || pending.historySession?.getState().phase === 'recovery-ready');
                if (active.historyCausality && !preserveHistoryRecovery) {
                    active.historyCausality = {...active.historyCausality, valid: false};
                }
            }
        });
        this.documentMap(project).forEach((doc) => {
            this.invalidateRemoteCausality(doc._id);
            doc.version = undefined;
            doc.remoteCache = undefined;
            doc.lastVersion = undefined;
            doc.historyOtSnapshot = undefined;
            doc.historyOtPresentation = undefined;
            doc.historyOtEpoch = undefined;
            this.rejectDocumentVersionWaiters(doc._id, new Error('Document session disconnected'));
        });
    }

    private invalidateDocumentSession(docId: string, error: Error) {
        this.cancelLiveEditorSubmissions(docId);
        this.conditionalRemoteAcceptances.delete(docId);
        this.invalidateRemoteCausality(docId);
        this.activeEditorBases.forEach((active, bufferId) => {
            if (active.identity.docId === docId) {
                this.invalidateEditorBase(active);
                this.remoteEditorTransactionMap().delete(bufferId);
                this.cleanEditorRefreshMap().delete(bufferId);
                this.historyRemoteEditorTransactionMap().delete(bufferId);
                this.historyCleanEditorRefreshMap().delete(bufferId);
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
            doc.historyOtSnapshot = undefined;
            doc.historyOtPresentation = undefined;
            doc.historyOtEpoch = undefined;
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

    private snapshotDocumentProviderStat(doc: DocumentEntity): ProviderDocumentStat | undefined {
        return Number.isSafeInteger(doc.providerMtime)
            && (doc.providerMtime as number) >= 0
            && Number.isSafeInteger(doc.providerSize)
            && (doc.providerSize as number) >= 0 ? {
                mtime: doc.providerMtime as number,
                size: doc.providerSize as number,
            } : undefined;
    }

    /**
     * VS Code keeps the stat returned when a text model is opened or saved and
     * rejects a later save before calling writeFile when that stat changes.
     * Realtime OT can advance the remote document while the same dirty editor
     * already contains the exact transformed text, so expose the editor's last
     * accepted stat until an explicit save advances it.
     */
    private dirtyEditorProviderStat(
        uri: vscode.Uri,
        doc: DocumentEntity,
    ): ProviderDocumentStat | undefined {
        const resourceKey = this.resourceKey(uri);
        const dirtyBuffers = [...this.editorBuffers.values()].filter(buffer =>
            buffer.docId === doc._id
            && buffer.resourceKey === resourceKey
            && vscode.workspace.textDocuments.includes(buffer.document)
            && !buffer.document.isClosed
            && buffer.document.isDirty
        );
        if (dirtyBuffers.length !== 1) { return undefined; }
        const buffer = dirtyBuffers[0];
        const active = this.activeEditorBases.get(buffer.bufferId);
        if (!active?.providerStat
            || active.bufferId !== buffer.bufferId
            || active.identity.docId !== doc._id) {
            return undefined;
        }
        if (active.identity.otType === 'history-ot') {
            const history = active.historyCausality;
            return history?.valid === true
                && history.documentVersion === buffer.document.version
                && history.editorContent === buffer.document.getText()
                ? active.providerStat : undefined;
        }
        return active.identity.otType === 'sharejs-text-ot'
            && active.causality.valid
            && active.causality.documentVersion === buffer.document.version
            && active.causality.editorContent === buffer.document.getText()
            ? active.providerStat : undefined;
    }

    private advanceEditorProviderStatAfterSave(
        uri: vscode.Uri,
        docId: string,
        content: string,
    ): void {
        const resourceKey = this.resourceKey(uri);
        const matches = [...this.editorBuffers.values()].filter(buffer =>
            buffer.docId === docId
            && buffer.resourceKey === resourceKey
            && vscode.workspace.textDocuments.includes(buffer.document)
            && !buffer.document.isClosed
            && buffer.document.getText() === content
        );
        if (matches.length !== 1) { return; }
        const active = this.activeEditorBases.get(matches[0].bufferId);
        if (!active || active.identity.docId !== docId) { return; }
        let current: DocumentEntity;
        try {
            current = this.currentDocument(docId);
        } catch {
            return;
        }
        const stat = this.snapshotDocumentProviderStat(current);
        if (stat) { active.providerStat = stat; }
    }

    private touchDocumentProviderStat(doc: DocumentEntity, content: string) {
        const previous = doc.providerMtime ?? 0;
        doc.providerMtime = Math.max(Date.now(), previous + 1);
        doc.providerSize = Buffer.byteLength(content, 'utf8');
    }

    private realtimeUnavailableMessage() {
        return (this.terminalRealtimeError ?? this.socket.fatalError)?.message;
    }

    private async assertProjectWritable(action: string, allowReviewDocumentMutation = false) {
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
        if (this.permissionsLevel === 'readOnly'
            || (this.permissionsLevel === 'review' && !allowReviewDocumentMutation)) {
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
        // Durable pending markers remain owned until they are reconciled or
        // explicitly cleared. Terminal transport state already blocks every
        // mutation, so dropping the in-memory owners here would only orphan
        // recovery records without making the project safer.
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

    private handlePermissionsInvalidated() {
        if (this.disposed || this.terminalRealtimeError) { return; }
        const rejection = new SocketRequestError(
            'stale_connection',
            'Overleaf project permissions changed; a fresh project join is required',
            true,
        );
        this.permissionsLevel = undefined;
        this.resetCommentThreadProjection();
        this.resetChangesUsers();
        for (const project of [this.root, this.joiningProject, this.previousRoot]) {
            this.documentMap(project).forEach(doc => {
                try {
                    doc.historyOtSession?.updatePermission(this.socket.generation, {
                        level: undefined,
                        userId: undefined,
                    });
                } catch {
                    // The session is invalidated below even if its generation is stale.
                }
            });
        }
        if (this.root) { this.previousRoot = this.root; }
        this.invalidateDocumentSessions(this.previousRoot);
        this.root = undefined;
        this.joiningProject = undefined;
        this.forceFreshConnection();
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
            doc.providerMtime = oldDoc.providerMtime;
            doc.providerSize = oldDoc.providerSize;
            // Preserve only the last proven protocol discriminant so durable
            // pending provenance can be located before the next document join.
            // The fresh join must prove the same protocol again before emit.
            doc.otType = oldDoc.otType;
            const pendingHistory = this.historyPendingForDocument(id);
            if (pendingHistory?.historySession === oldDoc.historyOtSession) {
                doc.historyOtSession = oldDoc.historyOtSession;
            }
        });
    }

    private waitForDocumentVersion(docId: string, expectedVersion: number, timeoutMs = 15000) {
        if (this.disposed) {
            throw new SocketRequestError(
                'disconnected',
                'Cannot wait for a document revision after the Overleaf project was closed',
                true,
            );
        }
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

    private historyOtMembers(): HistoryOtMemberDirectory {
        const project = this.root ?? this.joiningProject;
        return mergeHistoryOtMemberDirectory(
            this.changesUsers,
            [project?.owner, ...(project?.members ?? [])],
        );
    }

    private historyOtCommentThreads() {
        return isPlainObject(this.commentThreads)
            ? this.commentThreads as Record<string, HistoryJsonValue | undefined>
            : undefined;
    }

    private resetCommentThreadProjection() {
        this.commentThreadsEpoch += 1;
        this.commentThreads = undefined;
        this.commentThreadsLoading = undefined;
        // A later REST snapshot includes all events observed before this reset.
        // Only newer events may be replayed onto that authoritative base.
        this.appliedHistoryOtThreadEventCount = this.historyOtThreadEvents.events.length;
    }

    private resetChangesUsers() {
        this.changesUsersEpoch += 1;
        this.changesUsers = undefined;
        this.changesUsersLoading = undefined;
    }

    private refreshHistoryOtPresentationsForThreadEvent() {
        const changes: vscode.FileChangeEvent[] = [];
        for (const {entity, path} of this.walk(item => item._type === 'doc')) {
            const doc = entity as DocumentEntity;
            if (doc.otType !== 'history-ot' || !doc.historyOtSession?.getState().snapshot) {
                continue;
            }
            try {
                this.refreshHistoryOtRuntime(doc);
                changes.push({type: vscode.FileChangeType.Changed, uri: this.pathToUri(path)});
            } catch (error) {
                console.warn('Unable to refresh History OT comment presentation', error);
            }
        }
        if (changes.length > 0) { this.notify(changes); }
    }

    private refreshHistoryOtRuntime(doc: DocumentEntity): string {
        const state = doc.historyOtSession?.getState();
        if (!state?.snapshot || state.version === undefined) {
            throw new Error('History OT session has no authoritative snapshot');
        }
        const snapshot = parseHistoryOtSnapshot(state.snapshot);
        if (!snapshot.safe) {
            throw new Error(`Unsafe History OT session snapshot: ${snapshot.unsafeReasons.join('; ')}`);
        }
        const raw = serializeHistoryOtSnapshot(snapshot);
        const presentation = buildRealtimeHistoryOtPresentation(raw, {
            members: this.historyOtMembers(),
            commentThreads: this.historyOtCommentThreads(),
            compatibilityRanges: state.ranges,
        });
        const content = getVisibleHistoryOtText(snapshot);
        if (presentation.visibleText !== content) {
            throw new Error('History OT presentation does not match the authoritative visible snapshot');
        }
        doc.otType = 'history-ot';
        doc.version = state.version;
        doc.historyOtSnapshot = raw;
        doc.historyOtPresentation = presentation;
        doc.remoteCache = content;
        this.touchDocumentProviderStat(doc, content);
        return content;
    }

    private async ensureChangesUsers(): Promise<ChangesUserSchema[] | undefined> {
        if (this.changesUsers !== undefined) { return this.changesUsers; }
        if (this.changesUsersLoading) { return this.changesUsersLoading; }
        const epoch = this.changesUsersEpoch;
        let loading!: Promise<ChangesUserSchema[] | undefined>;
        loading = (async () => {
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            const response = await this.api.getChangesUsers(identity, this.projectId);
            if (epoch !== this.changesUsersEpoch) { return undefined; }
            if (response.type !== 'success' || response.changesUsers === undefined) {
                return undefined;
            }
            this.changesUsers = response.changesUsers;
            return this.changesUsers;
        })().finally(() => {
            if (this.changesUsersLoading === loading) {
                this.changesUsersLoading = undefined;
            }
        });
        this.changesUsersLoading = loading;
        return loading;
    }

    private async ensureCommentThreads(): Promise<HistoryJsonValue | undefined> {
        if (this.commentThreads !== undefined) { return this.commentThreads; }
        if (this.commentThreadsLoading) { return this.commentThreadsLoading; }
        const epoch = this.commentThreadsEpoch;
        let loading!: Promise<HistoryJsonValue | undefined>;
        loading = (async () => {
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            const response = await this.api.getCommentThreads(identity, this.projectId);
            if (response.type !== 'success' || response.commentThreads === undefined) {
                return undefined;
            }
            const raw = deepCloneJson(response.commentThreads);
            if (epoch !== this.commentThreadsEpoch) { return undefined; }
            const pendingEvents = this.historyOtThreadEvents.events.slice(
                this.appliedHistoryOtThreadEventCount,
            );
            const projected = reduceHistoryOtThreadEvents(raw, pendingEvents);
            this.commentThreads = projected;
            this.appliedHistoryOtThreadEventCount = this.historyOtThreadEvents.events.length;
            return projected;
        })().finally(() => {
            if (this.commentThreadsLoading === loading) {
                this.commentThreadsLoading = undefined;
            }
        });
        this.commentThreadsLoading = loading;
        return loading;
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
                    // Realtime ops are JSON Unicode strings, unlike the
                    // packed UTF-8 lines returned by the legacy joinDoc API.
                    d: operation.d,
                };
            }
            throw new Error('Malformed realtime text operation');
        });
    }

    private snapshotReceivedDocumentUpdate(
        update: unknown,
        sender?: ProjectSenderWitness,
    ): ReceivedDocumentUpdate {
        return {
            update: deepCloneJson(update),
            sender: sender ? {...sender} : undefined,
        };
    }

    private assertReceivedDocumentUpdateAuthority(
        docId: string,
        updates: readonly ReceivedDocumentUpdate[],
        expected: ProjectSenderWitness,
    ): void {
        updates.forEach((received, index) => {
            if (received.sender?.publicId !== expected.publicId
                || received.sender.generation !== expected.generation) {
                throw new Error(`Document join update ${index} belongs to an unproven realtime generation`);
            }
            if (!isPlainObject(received.update) || received.update.doc !== docId) {
                throw new Error(`Document join update ${index} has an invalid document identity`);
            }
        });
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
    ): PreparedShareJsDocumentJoin {
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
        const pendingCleanRefresh = this.cleanEditorRefreshMap().get(bufferId);
        if (pendingCleanRefresh) {
            let nextRemoteContent: string | undefined;
            try {
                nextRemoteContent = applyUtf16TextOperations(remoteContent, operations);
            } catch {
                nextRemoteContent = undefined;
            }
            const state = active.causality;
            const transaction = pendingCleanRefresh.transaction;
            if (pendingCleanRefresh.document !== buffer.document
                || pendingCleanRefresh.active !== active
                || pendingSubmission !== undefined
                || this.remoteEditorTransactionMap().has(bufferId)
                || !this.bufferMatchesIncarnation(buffer)
                || buffer.document.isDirty
                || buffer.document.version < transaction.beforeDocumentVersion
                || !pendingCleanRefresh.candidateContents.has(buffer.document.getText())
                || !state.valid
                || state.socketGeneration !== sender?.generation
                || transaction.socketGeneration !== state.socketGeneration
                || transaction.remoteEpoch !== state.remoteEpoch
                || transaction.baseRemoteVersion !== state.remoteVersion
                || transaction.beforeDocumentVersion !== state.documentVersion
                || transaction.beforeEditorContent !== state.editorContent
                || state.inflightWire !== undefined
                || state.inflightToken !== undefined
                || state.inflightView !== undefined
                || state.pendingOperations.length !== 0
                || state.localOperations.length !== 0
                || pendingCleanRefresh.nextRemoteVersion !== remoteVersion
                || pendingCleanRefresh.nextRemoteContent !== remoteContent
                || !isNonnegativeSafeInteger(remoteVersion + 1)
                || nextRemoteContent === undefined) {
                this.cleanEditorRefreshMap().delete(bufferId);
                active.causality.valid = false;
                return undefined;
            }
            pendingCleanRefresh.nextRemoteVersion = remoteVersion + 1;
            pendingCleanRefresh.nextRemoteContent = nextRemoteContent;
            return {
                bufferId,
                document: buffer.document,
                active,
                transaction,
                delivery: 'provider-refresh',
                cleanRefresh: pendingCleanRefresh,
            };
        }
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
            const delivery: PreparedLiveRemoteEditorUpdate['delivery'] = !buffer.document.isDirty
                && active.causality.inflightWire === undefined
                && active.causality.inflightToken === undefined
                && active.causality.inflightView === undefined
                && active.causality.pendingOperations.length === 0
                && active.causality.localOperations.length === 0
                && transaction.nextEditorContent === transaction.nextRemoteContent
                ? 'provider-refresh' : 'workspace-edit';
            const cleanRefresh = delivery === 'provider-refresh' ? {
                document: buffer.document,
                active,
                transaction,
                nextRemoteVersion: remoteVersion + 1,
                nextRemoteContent: transaction.nextRemoteContent,
                candidateContents: new Set([transaction.beforeEditorContent]),
            } : undefined;
            return {
                bufferId,
                document: buffer.document,
                active,
                transaction,
                delivery,
                cleanRefresh,
            };
        } catch {
            active.causality.valid = false;
            return undefined;
        }
    }

    private stageCleanRemoteEditorRefresh(prepared: PreparedLiveRemoteEditorUpdate): boolean {
        const {active, bufferId, cleanRefresh, document, transaction} = prepared;
        const buffer = this.editorBuffers.get(bufferId);
        const sender = this.currentSenderWitness();
        if (prepared.delivery !== 'provider-refresh'
            || !cleanRefresh
            || transaction.expectedChange === undefined
            || buffer?.document !== document
            || !this.bufferMatchesIncarnation(buffer)
            || this.activeEditorBases.get(bufferId) !== active
            || document.isDirty
            || document.version < transaction.beforeDocumentVersion
            || !cleanRefresh.candidateContents.has(document.getText())
            || sender?.generation !== transaction.socketGeneration
            || (this.cleanEditorRefreshMap().has(bufferId)
                && this.cleanEditorRefreshMap().get(bufferId) !== cleanRefresh)) {
            active.causality.valid = false;
            return false;
        }
        this.cleanEditorRefreshMap().set(bufferId, cleanRefresh);
        return true;
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
        let confirmedConditional: PendingConditionalDocumentUpdate | undefined;
        if (senderConfirmation) {
            const sender = this.currentSenderWitness();
            const matchingPending = [...this.pendingDocumentUpdates.values()].filter(pending =>
                pending.docId === update.doc
                && update.v >= pending.update.v
                && pending.socketGeneration === sender?.generation
                && pending.submittedPublicIds.includes(sender?.publicId ?? '')
            );
            const conditional = this.pendingConditionalDocumentUpdates.get(update.doc);
            const matchingConditional = conditional
                && conditional.token.length > 0
                && conditional.docId === update.doc
                && update.v >= conditional.update.v
                && conditional.confirmationVersion === undefined
                && conditional.publicId === sender?.publicId
                && conditional.socketGeneration === sender?.generation
                ? conditional : undefined;
            if (!sender
                || eventSender?.publicId !== sender.publicId
                || eventSender.generation !== sender.generation
                || matchingPending.length + (matchingConditional ? 1 : 0) !== 1) {
                this.invalidateDocumentSession(
                    update.doc,
                    new Error('Unproven sender confirmation for a document update'),
                );
                return;
            }
            confirmedPending = matchingPending[0];
            confirmedConditional = matchingConditional;
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
                if (confirmedConditional) {
                    confirmedConditional.confirmationVersion = update.v;
                }
                if (confirmedPending) {
                    confirmedPending.confirmationVersion = update.v;
                }
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
            if (confirmedConditional) {
                const pending = confirmedConditional;
                const sender = this.currentSenderWitness();
                const ledger = this.remoteDocumentCausality.get(doc._id);
                let nextContent: string | undefined;
                try {
                    if (beforeContent !== undefined
                        && sender?.publicId === pending.publicId
                        && sender.generation === pending.socketGeneration
                        && this.pendingConditionalDocumentUpdates.get(doc._id) === pending
                        && pending.update.v <= beforeVersion
                        && pending.confirmationVersion === undefined
                        && applyTextOperations(beforeContent, pending.inflightView)
                            === pending.mergedContent) {
                        nextContent = pending.mergedContent;
                    }
                } catch {
                    nextContent = undefined;
                }
                if (nextContent === undefined
                    || !ledger?.valid
                    || ledger.socketGeneration !== pending.socketGeneration
                    || ledger.headVersion !== beforeVersion
                    || ledger.headContent !== beforeContent
                    || ledger.updates.has(beforeVersion)) {
                    this.invalidateDocumentSession(
                        doc._id,
                        new Error('Conditional sender confirmation lost its exact causal state'),
                    );
                    return;
                }
                vscode.workspace.textDocuments.forEach(document => {
                    this.observeEditorBuffer(document);
                });
                const editorAppeared = [...this.editorBuffers.values()].some(buffer =>
                    buffer.docId === doc._id
                    && vscode.workspace.textDocuments.includes(buffer.document)
                    && !buffer.document.isClosed
                );
                if (editorAppeared) {
                    // The provider write was authorized only while no editor
                    // owned this document. Its confirmed operation must be
                    // rejoined and published through the provider refresh path;
                    // advancing only the cache would strand the newly opened
                    // editor on the pre-write text.
                    pending.confirmationVersion = update.v;
                    this.resolveDocumentVersionWaiters(doc._id, update.v);
                    this.invalidateDocumentSession(
                        doc._id,
                        new Error('An editor opened while a conditional provider write was in flight'),
                    );
                    this.markSourceDirty();
                    this.notify([{
                        type: vscode.FileChangeType.Changed,
                        uri: this.pathToUri(res.path),
                    }]);
                    return;
                }
                ledger.updates.set(
                    beforeVersion,
                    pending.inflightView.map(operation => ({...operation})),
                );
                ledger.headVersion = beforeVersion + 1;
                ledger.headContent = nextContent;
                doc.version = beforeVersion + 1;
                doc.remoteCache = nextContent;
                this.touchDocumentProviderStat(doc, nextContent);
                pending.confirmationVersion = update.v;
                this.markSourceDirty();
                this.resolveDocumentVersionWaiters(doc._id, update.v);
                return;
            }
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
                    this.touchDocumentProviderStat(doc, next.remoteContent);
                    if (next.localOperations.length === 0
                        && buffer!.document.getText() === next.remoteContent) {
                        doc.localCache = next.remoteContent;
                    }
                    this.markSourceDirty();
                    pending.confirmationVersion = update.v;
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
            pending.confirmationVersion = update.v;
            this.resolveDocumentVersionWaiters(doc._id, update.v);
            return;
        }
        doc.version += 1;
        if (update.op && beforeContent !== undefined) {
            let operations: TextOperation[];
            let content: string;
            let preparedLiveUpdate: PreparedLiveRemoteEditorUpdate | undefined;
            let conditionalAdvance: {
                pending: PendingConditionalDocumentUpdate,
                inflightView: TextOperation[],
                mergedContent: string,
            } | undefined;
            try {
                operations = this.normalizeRealtimeTextOperations(update);
                content = applyTextOperations(beforeContent, operations);
                const conditional = this.pendingConditionalDocumentUpdates.get(doc._id);
                if (conditional
                    && conditional.confirmationVersion === undefined
                    && conditional.socketGeneration === currentSender.generation
                    && conditional.update.v <= beforeVersion) {
                    if (applyTextOperations(beforeContent, conditional.inflightView)
                        !== conditional.mergedContent) {
                        throw new Error('Conditional write lost its exact in-flight view');
                    }
                    const [remoteAfterLocal, localAfterRemote] = transformOperationPair(
                        operations,
                        conditional.inflightView,
                    );
                    const remoteFirst = applyTextOperations(content, localAfterRemote);
                    const localFirst = applyTextOperations(
                        conditional.mergedContent,
                        remoteAfterLocal,
                    );
                    if (remoteFirst !== localFirst) {
                        throw new Error('Conditional write collaborator rebase did not converge');
                    }
                    conditionalAdvance = {
                        pending: conditional,
                        inflightView: localAfterRemote,
                        mergedContent: remoteFirst,
                    };
                }
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
            if (conditionalAdvance
                && this.pendingConditionalDocumentUpdates.get(doc._id)
                    === conditionalAdvance.pending) {
                conditionalAdvance.pending.inflightView =
                    conditionalAdvance.inflightView.map(operation => ({...operation}));
                conditionalAdvance.pending.mergedContent = conditionalAdvance.mergedContent;
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
            this.touchDocumentProviderStat(doc, content);
            const stagedCleanRefresh = preparedLiveUpdate?.delivery === 'provider-refresh'
                && preparedLiveUpdate.transaction.expectedChange !== undefined
                ? this.stageCleanRemoteEditorRefresh(preparedLiveUpdate) : false;
            const appliedToLiveEditor = preparedLiveUpdate && !stagedCleanRefresh ?
                await this.applyPreparedRemoteEditorUpdate(preparedLiveUpdate) : false;
            if (appliedToLiveEditor
                && preparedLiveUpdate?.active.causality.localOperations.length === 0) {
                doc.localCache = content;
            } else if (stagedCleanRefresh) {
                // This cache is now the provider authority which VS Code will
                // adopt through the ordinary file-change refresh path.
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

    private prepareHistoryLiveRemoteEditorUpdate(
        doc: DocumentEntity,
        remoteVersion: number,
        remoteOperations: HistoryJsonValue,
        forceWorkspaceEdit = false,
    ): PreparedHistoryRemoteEditorUpdate | undefined {
        const candidates = [...this.activeEditorBases.entries()].filter(([bufferId, active]) => {
            const buffer = this.editorBuffers.get(bufferId);
            return active.identity.docId === doc._id
                && active.historyCausality !== undefined
                && buffer !== undefined
                && this.bufferMatchesIncarnation(buffer);
        });
        if (candidates.length === 0) { return undefined; }
        if (candidates.length !== 1) {
            candidates.forEach(([, active]) => this.invalidateEditorBase(active));
            return undefined;
        }
        const [bufferId, active] = candidates[0];
        const buffer = this.editorBuffers.get(bufferId)!;
        const history = active.historyCausality!;
        const sender = this.currentSenderWitness();
        if (!sender
            || !doc.historyOtEpoch
            || doc.historyOtSnapshot === undefined
            || this.historyRemoteEditorTransactionMap().has(bufferId)
            || this.historyCleanEditorRefreshMap().has(bufferId)
            || !history.valid
            || history.authority !== 'ready'
            || history.socketGeneration !== sender.generation
            || history.remoteEpoch !== doc.historyOtEpoch
            || history.remoteVersion !== remoteVersion
            || !historyOtJsonEqual(history.remoteSnapshot.raw, doc.historyOtSnapshot)
            || history.documentVersion !== buffer.document.version
            || history.editorContent !== buffer.document.getText()) {
            this.invalidateEditorBase(active);
            return undefined;
        }
        try {
            const transaction = prepareHistoryRemoteEditorTransaction(
                history,
                randomUUID(),
                remoteVersion,
                remoteOperations,
            );
            const clean = !forceWorkspaceEdit
                && !buffer.document.isDirty
                && history.inflightWire === undefined
                && history.inflightView === undefined
                && history.pending === undefined;
            const delivery: PreparedHistoryRemoteEditorUpdate['delivery'] = clean
                ? 'provider-refresh' : 'workspace-edit';
            const nextRemoteSnapshot = serializeHistoryOtSnapshot(
                transaction.transformed.serverSnapshot,
            );
            const cleanRefresh = clean ? {
                bufferId,
                docId: doc._id,
                publicId: sender.publicId,
                document: buffer.document,
                active,
                transaction,
                nextRemoteVersion: remoteVersion + 1,
                nextRemoteSnapshot,
                nextRemoteContent: getVisibleHistoryOtText(transaction.transformed.serverSnapshot),
                candidateContents: new Set([
                    transaction.beforeEditorContent,
                    getVisibleHistoryOtText(transaction.transformed.serverSnapshot),
                ]),
            } : undefined;
            return {bufferId, document: buffer.document, active, transaction, delivery, cleanRefresh};
        } catch {
            this.invalidateEditorBase(active);
            return undefined;
        }
    }

    private stageHistoryCleanRemoteEditorRefresh(
        prepared: PreparedHistoryRemoteEditorUpdate,
    ): boolean {
        const {active, bufferId, cleanRefresh, document, transaction} = prepared;
        const buffer = this.editorBuffers.get(bufferId);
        const sender = this.currentSenderWitness();
        if (prepared.delivery !== 'provider-refresh'
            || !cleanRefresh
            || cleanRefresh.bufferId !== bufferId
            || cleanRefresh.docId !== active.identity.docId
            || transaction.expectedChange === undefined
            || buffer?.document !== document
            || !this.bufferMatchesIncarnation(buffer)
            || this.activeEditorBases.get(bufferId) !== active
            || document.isDirty
            || document.version !== transaction.beforeDocumentVersion
            || document.getText() !== transaction.beforeEditorContent
            || sender?.generation !== transaction.socketGeneration
            || sender.publicId !== cleanRefresh.publicId
            || this.historyCleanEditorRefreshMap().has(bufferId)) {
            this.invalidateEditorBase(active);
            return false;
        }
        this.historyCleanEditorRefreshMap().set(bufferId, cleanRefresh);
        return true;
    }

    private async applyPreparedHistoryRemoteEditorUpdate(
        prepared: PreparedHistoryRemoteEditorUpdate,
        persistBase = true,
    ): Promise<boolean> {
        const {active, bufferId, document, transaction} = prepared;
        const history = active.historyCausality;
        const buffer = this.editorBuffers.get(bufferId);
        const sender = this.currentSenderWitness();
        if (!history
            || buffer?.document !== document
            || !this.bufferMatchesIncarnation(buffer)
            || this.activeEditorBases.get(bufferId) !== active
            || document.version !== transaction.beforeDocumentVersion
            || document.getText() !== transaction.beforeEditorContent
            || sender?.generation !== transaction.socketGeneration) {
            this.invalidateEditorBase(active);
            return false;
        }
        if (!transaction.expectedChange) {
            const next = commitHistoryRemoteEditorTransaction(
                history,
                transaction,
                document.version,
                [],
                document.getText(),
            );
            active.historyCausality = next;
            if (!next.valid) { return false; }
            if (next.inflightWire === undefined) {
                active.version = next.remoteVersion;
                active.content = getVisibleHistoryOtText(next.remoteSnapshot);
            }
            return true;
        }
        const pending: PendingHistoryRemoteEditorTransaction = {
            document,
            active,
            transaction,
            consumed: false,
        };
        this.historyRemoteEditorTransactionMap().set(bufferId, pending);
        const change = transaction.expectedChange;
        const edit = new vscode.WorkspaceEdit();
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
            console.warn('Unable to apply a witnessed History OT collaborator edit', error);
        }
        if (this.historyRemoteEditorTransactionMap().get(bufferId) === pending) {
            this.historyRemoteEditorTransactionMap().delete(bufferId);
        }
        const committed = active.historyCausality;
        const exact = applied
            && pending.consumed
            && committed?.valid === true
            && committed.remoteVersion === transaction.nextRemoteVersion
            && committed.editorContent === document.getText();
        if (!exact) {
            this.invalidateEditorBase(active);
            return false;
        }
        if (committed.inflightWire === undefined) {
            active.version = committed.remoteVersion;
            active.content = getVisibleHistoryOtText(committed.remoteSnapshot);
            if (!persistBase) { return true; }
            const record = await this.provenanceStore.createOrUpdateCurrent({
                identity: active.identity,
                bufferIncarnationId: bufferId,
                baseVersion: active.version,
                baseText: active.content,
                dirtyText: document.getText(),
            });
            active.recordName = record.recordName;
            active.persistence = Promise.resolve(record);
        }
        return true;
    }

    private async applyHistoryOtDocumentUpdate(
        update: unknown,
        eventSender?: ProjectSenderWitness,
        persistBase = true,
        forceWorkspaceEdit = false,
    ): Promise<void> {
        const parsed = parseHistoryOtRealtimeEnvelope(update);
        const docId = parsed.doc;
        const sender = this.currentSenderWitness();
        if (!parsed.safe || !docId || parsed.version === undefined) {
            if (docId) {
                this.invalidateDocumentSession(
                    docId,
                    new Error(`Unsafe History OT realtime update: ${parsed.unsafeReasons.join('; ')}`),
                );
            }
            return;
        }
        if (!sender
            || eventSender?.publicId !== sender.publicId
            || eventSender.generation !== sender.generation) {
            this.invalidateDocumentSession(
                docId,
                new Error('History OT update belongs to an unproven realtime generation'),
            );
            return;
        }
        if (parsed.classification === 'collaborator-update'
            && this.recordConfirmedHistoryCollaboratorUpdate(update, eventSender)) {
            return;
        }
        const resolved = this._resolveById(docId);
        if (!resolved || resolved.fileType !== 'doc') { return; }
        const doc = resolved.fileEntity as DocumentEntity;
        const session = doc.historyOtSession;
        if (doc.otType !== 'history-ot' || !session) {
            this.invalidateDocumentSession(
                docId,
                new Error('History OT update arrived without an authoritative History OT session'),
            );
            return;
        }

        if (parsed.classification === 'sender-ack') {
            const matching = [...this.pendingDocumentUpdates.values()].filter(pending => {
                const active = this.activeEditorBases.get(pending.bufferId);
                return pending.otType === 'history-ot'
                    && pending.docId === docId
                    && pending.historySession === session
                    && pending.socketGeneration === sender.generation
                    && pending.submittedPublicIds.includes(sender.publicId)
                    && (active === undefined
                        || active.historyCausality?.inflightToken === pending.submissionToken);
            });
            if (matching.length !== 1) {
                this.invalidateDocumentSession(docId, new Error('Unproven History OT sender ACK'));
                return;
            }
            const pending = matching[0];
            const result = session.receiveApplied(sender.generation, update);
            if (result.kind === 'late-ack-ignored') { return; }
            if (result.kind !== 'sender-commit') {
                this.invalidateDocumentSession(
                    docId,
                    new Error(result.reason ?? 'History OT sender ACK was not accepted'),
                );
                return;
            }
            const active = this.activeEditorBases.get(pending.bufferId);
            if (active?.historyCausality) {
                active.historyCausality = acknowledgeHistorySubmission(
                    active.historyCausality,
                    pending.submissionToken,
                    parsed.version,
                );
            }
            pending.confirmationVersion = parsed.version;
            pending.historyConfirmedAdvance = {
                publicId: sender.publicId,
                socketGeneration: sender.generation,
                committedVersion: parsed.version + 1,
                updates: new Map(),
            };
            await this.provenanceStore.markPendingWrite(
                pending.provenanceRecordName,
                this.pendingWritePayload(pending),
            );
            const senderAfterPersistence = this.currentSenderWitness();
            if (this.pendingDocumentUpdates.get(pending.bufferId) !== pending
                || senderAfterPersistence?.publicId !== sender.publicId
                || senderAfterPersistence.generation !== sender.generation) {
                pending.historyConfirmedAdvance.invalidReason =
                    'History sender authority changed while persisting the commit witness';
                throw new Error('History sender authority changed while persisting the commit witness');
            }
            doc.version = undefined;
            doc.remoteCache = undefined;
            doc.historyOtSnapshot = undefined;
            doc.historyOtPresentation = undefined;
            doc.historyOtEpoch = undefined;
            this.resolveDocumentVersionWaiters(docId, parsed.version);
            this.markSourceDirty();
            return;
        }

        if (parsed.classification !== 'collaborator-update' || parsed.operation === undefined) {
            this.invalidateDocumentSession(docId, new Error('Unsupported History OT realtime event'));
            return;
        }
        const beforeVersion = doc.version;
        const beforeContent = doc.remoteCache;
        if (!isNonnegativeSafeInteger(beforeVersion)
            || beforeContent === undefined
            || doc.historyOtSnapshot === undefined) {
            this.invalidateDocumentSession(docId, new Error('History OT update has no exact document base'));
            return;
        }
        const remoteOperations = serializeHistoryOtWireOperation(parsed.operation);
        const prepared = this.prepareHistoryLiveRemoteEditorUpdate(
            doc,
            beforeVersion,
            remoteOperations,
            forceWorkspaceEdit,
        );
        const result = session.receiveApplied(sender.generation, update);
        if (!result.applied || result.requiresRejoin) {
            this.invalidateDocumentSession(
                docId,
                new Error(result.reason ?? 'History OT update requires an authoritative rejoin'),
            );
            return;
        }
        const sessionState = session.getState();
        if (prepared && (sessionState.snapshot === undefined
            || !historyOtJsonEqual(
                sessionState.snapshot,
                prepared.transaction.transformed.serverSnapshot.raw,
            ))) {
            this.invalidateEditorBase(prepared.active);
        }
        const content = this.refreshHistoryOtRuntime(doc);
        let liveApplied = false;
        let stagedClean = false;
        if (prepared?.active.historyCausality?.valid) {
            stagedClean = prepared.delivery === 'provider-refresh'
                && prepared.transaction.expectedChange !== undefined
                ? this.stageHistoryCleanRemoteEditorRefresh(prepared) : false;
            liveApplied = !stagedClean
                ? await this.applyPreparedHistoryRemoteEditorUpdate(prepared, persistBase) : false;
        }
        const uri = this.pathToUri(resolved.path);
        if (stagedClean) {
            doc.localCache = content;
        } else if (liveApplied && prepared?.document.isDirty) {
            doc.localCache = undefined;
        } else if (!prepared) {
            const editor = vscode.workspace.textDocuments.find(
                item => item.uri.toString() === uri.toString(),
            );
            if (editor && !editor.isDirty) { doc.localCache = content; }
        }
        this.markSourceDirty();
        if (!liveApplied || stagedClean || prepared?.transaction.expectedChange === undefined) {
            this.notify([{type: vscode.FileChangeType.Changed, uri}]);
        }
    }

    private queueHistoryOtDocumentUpdate(
        update: unknown,
        sender?: ProjectSenderWitness,
        persistBase = true,
        forceWorkspaceEdit = false,
    ): Promise<void> {
        const docId = realtimeUpdateDocId(update);
        if (!docId) {
            this.invalidateDocumentSessions(this.root);
            return Promise.resolve();
        }
        const queues = this.remoteUpdateQueueMap();
        const previous = queues.get(docId);
        const applyIfCurrent = () => {
            const current = this.currentSenderWitness();
            if (!sender
                || current?.publicId !== sender.publicId
                || current.generation !== sender.generation) {
                return Promise.resolve();
            }
            return this.applyHistoryOtDocumentUpdate(
                update,
                sender,
                persistBase,
                forceWorkspaceEdit,
            );
        };
        const operation = previous ? previous.catch(() => undefined).then(applyIfCurrent) : applyIfCurrent();
        let queued!: Promise<void>;
        queued = operation.catch(error => {
            this.invalidateDocumentSession(
                docId,
                error instanceof Error ? error : new Error(String(error)),
            );
        }).finally(() => {
            if (queues.get(docId) === queued) { queues.delete(docId); }
        });
        queues.set(docId, queued);
        return queued;
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
                this.resetCommentThreadProjection();
                this.resetChangesUsers();
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
            onPermissionsInvalidated: () => {
                this.handlePermissionsInvalidated();
            },
            onHistoryOtThreadEvent: (event: HistoryOtThreadEventName, args: unknown[]) => {
                try {
                    const candidate = appendHistoryOtThreadEvent(
                        this.historyOtThreadEvents,
                        event,
                        args,
                    );
                    const accepted = candidate.events[candidate.events.length - 1];
                    // Validate every event even before its REST base is available.
                    const projected = reduceHistoryOtThreadEvent(
                        this.commentThreads ?? {},
                        accepted,
                    );
                    this.historyOtThreadEvents = candidate;
                    if (this.commentThreads !== undefined) {
                        this.commentThreads = projected;
                        this.appliedHistoryOtThreadEventCount = candidate.events.length;
                        this.refreshHistoryOtPresentationsForThreadEvent();
                    }
                } catch (error) {
                    try {
                        this.rejectedHistoryOtThreadEvents.push({
                            event,
                            args: deepCloneJson(args),
                            reason: error instanceof Error ? error.message : String(error),
                        });
                    } catch {
                        // Non-JSON socket data cannot enter the JSON event log.
                    }
                    console.warn('Ignoring unsafe History OT comment event', error);
                }
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
            onFileChanged: (update:unknown, sender?: ProjectSenderWitness) => {
                const docId = realtimeUpdateDocId(update);
                if (!docId) {
                    const error = new Error('Realtime document update has no valid document identity');
                    this.joiningDocuments.forEach(joining => {
                        joining.invalid = error;
                    });
                    this.invalidateDocumentSessions(this.root);
                    return;
                }
                const confirmedHistoryUpdate =
                    this.recordConfirmedHistoryCollaboratorUpdate(update, sender);
                const joining = this.joiningDocuments.get(docId);
                if (joining && joining.generation === this.socket.generation) {
                    try {
                        joining.updates.push(this.snapshotReceivedDocumentUpdate(update, sender));
                    } catch (error) {
                        joining.invalid = error instanceof Error ? error : new Error(String(error));
                    }
                    return;
                }
                if (confirmedHistoryUpdate) { return; }
                const resolved = this._resolveById(docId);
                const doc = resolved?.fileType === 'doc'
                    ? resolved.fileEntity as DocumentEntity
                    : undefined;
                if (doc?.otType === 'history-ot') {
                    this.queueHistoryOtDocumentUpdate(update, sender);
                    return;
                }
                if (!isRealtimeUpdateSchema(update)) {
                    this.invalidateDocumentSession(
                        docId,
                        new Error('ShareJS realtime update is malformed or has the wrong OT type'),
                    );
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
        const reviewDocument = this.permissionsLevel === 'review' && fileType === 'doc';
        const readonly = fileEntity?.readonly
            || this.permissionsLevel === 'readOnly'
            || (this.permissionsLevel === 'review' && !reviewDocument) ?
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
            default: {
                const file = new File(fileName, vscode.FileType.File, undefined, readonly);
                const document = fileEntity as DocumentEntity;
                const stat = this.dirtyEditorProviderStat(uri, document)
                    ?? this.snapshotDocumentProviderStat(document);
                if (stat) {
                    file.mtime = stat.mtime;
                    file.size = stat.size;
                }
                return file;
            }
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
                        return res.content ?? new Uint8Array(0);
                    }
                    throw vscode.FileSystemError.Unavailable(uri);
                });
            });
        } else {
            const fileId = fileEntity._id;
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            const res = await this.api.getFile(identity, this.projectId, fileId);
            if (res.type==='success') {
                EventBus.fire('fileWillOpenEvent', {uri});
                return res.content ?? new Uint8Array(0);
            }
            throw vscode.FileSystemError.Unavailable(uri);
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

    private async performDocumentJoinAttempt(
        docId: string,
        connectionGeneration: number,
        joining: {
            generation: number,
            updates: ReceivedDocumentUpdate[],
            invalid?: Error,
        },
        refreshAttempt: 0 | 1,
    ): Promise<{doc: DocumentEntity, content: string}> {
        const joiningSender = this.currentSenderWitness();
        if (!joiningSender || joiningSender.generation !== connectionGeneration) {
            throw new Error('Document join started without a current sender witness');
        }
        const response: DocumentJoin = await this.socket.joinDoc(docId);
        assertCurrentConnection(
            connectionGeneration,
            this.socket.generation,
            this.socket.isConnected,
        );
        if (refreshAttempt === 1 && response.otType !== 'history-ot') {
            throw new Error('History OT commit refresh changed the document protocol');
        }

        const doc = this.currentDocument(docId);
        const receivedUpdates = joining.updates.slice();
        const queuedUpdateCount = receivedUpdates.length;
        if (joining.invalid) { throw joining.invalid; }
        this.assertReceivedDocumentUpdateAuthority(docId, receivedUpdates, joiningSender);
        receivedUpdates.forEach(received => {
            this.recordConfirmedHistoryCollaboratorUpdate(received.update, received.sender);
        });

        let content: string;
        let changedDuringJoin = false;
        let historySession: HistoryOtSession | undefined;
        if (response.otType === 'sharejs-text-ot') {
            const prepared = this.prepareDocumentJoin(docId, response, receivedUpdates);
            const ledger = this.startPreparedRemoteCausality(
                docId,
                prepared,
                connectionGeneration,
            );
            doc.otType = 'sharejs-text-ot';
            doc.historyOtSession = undefined;
            doc.historyOtSnapshot = undefined;
            doc.historyOtPresentation = undefined;
            doc.historyOtEpoch = undefined;
            doc.version = prepared.headVersion;
            doc.remoteCache = prepared.headContent;
            this.touchDocumentProviderStat(doc, prepared.headContent);
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
            content = prepared.headContent;
            changedDuringJoin = prepared.headVersion !== prepared.anchorVersion;
        } else {
            this.invalidateRemoteCausality(docId);
            let session = doc.historyOtSession;
            if (session) {
                const state = session.getState();
                if (connectionGeneration > state.generation) {
                    session.reconnect(connectionGeneration);
                } else if (connectionGeneration < state.generation) {
                    throw new Error('History OT session generation is newer than the active socket');
                }
                const permission = session.updatePermission(connectionGeneration, {
                    level: this.permissionsLevel,
                    userId: this.userId,
                });
                if (permission.requiresRejoin && !permission.state.hasPendingOperation) {
                    session = undefined;
                }
            }
            session ??= new HistoryOtSession(docId, connectionGeneration, {
                level: this.permissionsLevel,
                userId: this.userId,
            });
            const joined = session.acceptJoin(connectionGeneration, {
                snapshot: response.snapshot,
                version: response.version,
                operations: response.updates,
                ranges: response.ranges,
                otType: response.otType,
            });
            if (joined.requiresRejoin) {
                const blocked = joined.state.pendingRecoveryBlockedReason;
                if (blocked) {
                    throw new SocketRequestError(
                        'stale_connection',
                        `Pending History OT outcome is unresolved: ${blocked}`,
                        true,
                        {docId, reason: blocked},
                    );
                }
                throw new Error(joined.reason ?? 'Unsafe History OT join state');
            }
            doc.otType = 'history-ot';
            doc.historyOtSession = session;
            doc.historyOtEpoch = randomUUID();
            historySession = session;
            doc.lastVersion = undefined;
            content = this.refreshHistoryOtRuntime(doc);

            const orderedUpdates = receivedUpdates.map(received => ({
                received,
                parsed: parseHistoryOtRealtimeEnvelope(received.update),
            })).sort((left, right) => (left.parsed.version ?? -1) - (right.parsed.version ?? -1));
            for (const {received, parsed} of orderedUpdates) {
                if (!parsed.safe || parsed.doc !== docId || parsed.version === undefined) {
                    throw new Error(`Unsafe History OT update buffered during join: ${parsed.unsafeReasons.join('; ')}`);
                }
                const result: HistoryOtSessionResult = session.receiveApplied(
                    connectionGeneration,
                    received.update,
                );
                if (result.kind === 'sender-commit') {
                    throw new HistoryOtCommitDuringJoinError(docId);
                }
                if (result.requiresRejoin) {
                    throw new Error(result.reason ?? 'History OT join replay requires another authoritative join');
                }
                if (result.applied) {
                    changedDuringJoin = true;
                    content = this.refreshHistoryOtRuntime(doc);
                }
            }
        }

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
            || sender.generation !== joiningSender.generation
            || doc.version === undefined
            || doc.remoteCache !== content) {
            throw new Error('Document join authority changed before the causal state could be committed');
        }
        if (changedDuringJoin) {
            this.markSourceDirty();
            const resolved = this._resolveById(docId);
            if (resolved) {
                this.notify([{
                    type: vscode.FileChangeType.Changed,
                    uri: this.pathToUri(resolved.path),
                }]);
            }
        }
        if (doc.otType === 'history-ot') {
            void Promise.all([this.ensureCommentThreads(), this.ensureChangesUsers()]).then(() => {
                const current = this.currentSenderWitness();
                if (current?.generation !== connectionGeneration
                    || this.currentDocument(docId) !== doc
                    || doc.historyOtSession !== historySession) {
                    return;
                }
                this.refreshHistoryOtRuntime(doc);
                const resolved = this._resolveById(docId);
                if (resolved) {
                    this.notify([{
                        type: vscode.FileChangeType.Changed,
                        uri: this.pathToUri(resolved.path),
                    }]);
                }
            }).catch(error => {
                console.warn('Unable to load History OT presentation metadata', error);
            });
        }
        return {doc, content};
    }

    private async performDocumentJoin(docId: string): Promise<{doc: DocumentEntity, content: string}> {
        // Each attempt installs its raw realtime buffer synchronously before
        // joinDoc can yield. One sender-commit race is retried from a fresh join.
        await this.init();
        const connectionGeneration = await this.socket.waitUntilConnected();
        try {
            const joined = await runHistoryOtJoinWithCommitRefresh(
                () => {
                    assertCurrentConnection(
                        connectionGeneration,
                        this.socket.generation,
                        this.socket.isConnected,
                    );
                    const joining = {
                        generation: connectionGeneration,
                        updates: [] as ReceivedDocumentUpdate[],
                    };
                    this.joiningDocuments.set(docId, joining);
                    return joining;
                },
                (joining, attempt) => this.performDocumentJoinAttempt(
                    docId,
                    connectionGeneration,
                    joining,
                    attempt,
                ),
                joining => {
                    if (this.joiningDocuments.get(docId) === joining) {
                        this.joiningDocuments.delete(docId);
                    }
                },
            );
            return joined.value;
        } catch (error) {
            const failure = error instanceof Error ? error : new Error(String(error));
            this.invalidateDocumentSession(docId, failure);
            throw failure;
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

    async writeFile(
        uri: vscode.Uri,
        content: Uint8Array,
        create: boolean,
        overwrite: boolean,
        liveBufferId?: string,
        liveSnapshot?: LiveEditorWriteSnapshot,
    ) {
        let desiredContent: string;
        try {
            desiredContent = new TextDecoder('utf-8', {
                fatal: true,
                ignoreBOM: true,
            }).decode(content);
        } catch {
            this.blockDocumentWrite(uri, content, 'document bytes are not valid UTF-8');
        }
        if (liveBufferId === undefined) {
            try {
                await this.flushLiveEditorSubmissionForUri(uri);
            } catch (error) {
                // Background live submission must stay silent, but an explicit
                // save waiting on that submission still owns the recovery UI.
                this.showDocumentRecovery(
                    uri,
                    content,
                    `the pending live update could not be flushed before saving: ${String(error)}`,
                );
                throw error;
            }
        }
        if (this.matchesUnboundEditorSave(uri, desiredContent)) {
            this.blockDocumentWrite(
                uri,
                content,
                'this dirty editor was never bound to a remote document identity',
            );
        }
        this.assertAuthenticatedAccount(uri);
        const resolved = await this._resolveUri(uri);
        const resolvedDocId = resolved.fileType === 'doc' && resolved.fileEntity
            ? resolved.fileEntity._id : undefined;
        const reviewHistoryMutation = !create
            && resolved.fileType === 'doc'
            && (resolved.fileEntity as DocumentEntity | undefined)?.otType === 'history-ot';
        await this.assertProjectWritable('Unable to write file', reviewHistoryMutation);
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
        const operation = Promise.all(previous.map(value => value.catch(() => {}))).then(async () => {
            const suppressionKey = liveBufferId === undefined
                ? undefined : this.beginLiveRecoverySuppression(uri);
            try {
                await this.writeFileNow(
                    uri,
                    content,
                    create,
                    overwrite,
                    liveBufferId,
                    liveSnapshot,
                );
            } finally {
                if (suppressionKey !== undefined) {
                    this.endLiveRecoverySuppression(suppressionKey);
                }
            }
        }).catch((error) => {
            if (error instanceof SocketRequestError && error.outcomeUnknown) {
                this.forceFreshConnection();
            }
            throw error;
        });
        keys.forEach(key => this.documentWrites.set(key, operation));
        try {
            await operation;
            if (liveBufferId === undefined && resolvedDocId !== undefined) {
                this.advanceEditorProviderStatAfterSave(uri, resolvedDocId, desiredContent);
            }
        } finally {
            keys.forEach(key => {
                if (this.documentWrites.get(key) === operation) {
                    this.documentWrites.delete(key);
                }
            });
        }
    }

    private forceFreshConnection() {
        if (this.disposed || this.freshConnectionRequested || this.socket.fatalError) { return; }
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
        extra: {[key: string]: ProvenanceJsonValue} = {},
    ): ProvenanceJsonValue {
        return JSON.parse(JSON.stringify({
            state,
            otType: pending.otType ?? 'sharejs-text-ot',
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
            historyIntent: pending.historyIntent,
            historyConfirmationVersion: pending.otType === 'history-ot'
                ? pending.confirmationVersion : undefined,
            ...extra,
        })) as ProvenanceJsonValue;
    }

    private conditionalPendingWritePayload(
        pending: PendingConditionalDocumentUpdate,
    ): ProvenanceJsonValue {
        return JSON.parse(JSON.stringify({
            state: 'provider-submitted',
            otType: 'sharejs-text-ot',
            docId: pending.docId,
            token: pending.token,
            update: pending.update,
            desiredContent: pending.desiredContent,
            mergedContent: pending.mergedContent,
            baseVersion: pending.baseVersion,
            baseContent: pending.baseContent,
            publicId: pending.publicId,
            socketGeneration: pending.socketGeneration,
        })) as ProvenanceJsonValue;
    }

    private pendingRecordMatches(
        record: DocumentProvenanceRecord,
        pending: PendingDocumentUpdate,
    ): boolean {
        return record.pendingWrite !== undefined
            && JSON.stringify(record.pendingWrite) === JSON.stringify(
                pending.durablePendingWrite ?? this.pendingWritePayload(pending),
            );
    }

    private async awaitHistoryPendingDurability(pending: PendingDocumentUpdate): Promise<void> {
        for (let attempt = 0; attempt < 32; attempt += 1) {
            const transition = pending.durablePendingWriteTransition;
            if (!transition) { return; }
            await transition;
            if (pending.durablePendingWriteTransition === transition) { return; }
        }
        throw new Error('History pending recovery text did not reach a stable durability point');
    }

    /**
     * A confirmed History owner may be dropped only after its durable marker
     * was atomically replaced by a proven base. Otherwise keep the owner for a
     * later zero-wire fresh-join reconciliation and discard only the failed
     * promise chain so that the durability operation itself can be retried.
     */
    private settleConfirmedHistoryPendingOwnerAfterFailure(
        pending: PendingDocumentUpdate,
    ): boolean {
        if (this.pendingDocumentUpdates.get(pending.bufferId) !== pending) {
            return false;
        }
        if (pending.durablePendingWriteCleared) {
            this.pendingDocumentUpdates.delete(pending.bufferId);
        } else {
            pending.durablePendingWriteTransition = undefined;
        }
        return true;
    }

    private finalizeConfirmedHistoryPendingMarker(
        pending: PendingDocumentUpdate,
        expectedMarker: ProvenanceJsonValue,
        input: {
            identity: DocumentProvenanceIdentity,
            bufferIncarnationId: string,
            baseVersion: number,
            baseText: string,
            dirtyText: string,
        },
    ): Promise<DocumentProvenanceRecord> {
        pending.durableReconciledBase = {
            identity: input.identity,
            baseVersion: input.baseVersion,
            baseText: input.baseText,
        };
        pending.durablePendingWriteCleared = false;
        const finalization = (pending.durablePendingWriteTransition ?? Promise.resolve())
            .then(() => this.provenanceStore.reconcilePendingWrite(
                pending.provenanceRecordName,
                expectedMarker,
                input,
            )).then(record => {
                pending.durablePendingWrite = undefined;
                pending.durablePendingWriteCleared = true;
                return record;
            });
        const transition = finalization.then(() => undefined);
        void transition.catch(() => {});
        pending.durablePendingWriteTransition = transition;
        return finalization;
    }

    private freezeConfirmedHistoryAdvance(
        pending: PendingDocumentUpdate,
        targetVersion: number,
        sender: ProjectSenderWitness,
    ): void {
        const advance = pending.historyConfirmedAdvance;
        if (!advance) { return; }
        const sameHandoffAuthority = advance.reconcilingPublicId === sender.publicId
            && advance.reconcilingSocketGeneration === sender.generation;
        if (advance.reconcilingVersion !== undefined) {
            if (sameHandoffAuthority && advance.reconcilingVersion !== targetVersion) {
                advance.invalidReason ??= 'confirmed History reconciliation changed its fresh-join cutoff';
                return;
            }
            if (!sameHandoffAuthority) {
                // A later fresh join supersedes every deferred event captured
                // under the retired socket. Only events witnessed under the
                // new join authority may cross its durability barrier.
                advance.deferredUpdates = [];
            }
        }
        advance.reconcilingVersion = targetVersion;
        advance.reconcilingPublicId = sender.publicId;
        advance.reconcilingSocketGeneration = sender.generation;
        advance.deferredUpdates ??= [];
        advance.handoffInstalled = false;
        if (advance.publicId === sender.publicId
            && advance.socketGeneration === sender.generation) {
            for (const [revision, recorded] of advance.updates) {
                if (revision < targetVersion) { continue; }
                advance.deferredUpdates.push({
                    update: deepCloneJson(recorded.raw),
                    sender: {...sender},
                });
                advance.updates.delete(revision);
            }
        } else {
            // The fresh join is authoritative through targetVersion. Old
            // generation evidence cannot be relabelled as a new-generation
            // realtime event.
            advance.updates.clear();
        }
    }

    private takeConfirmedHistoryDeferredBatch(
        pending: PendingDocumentUpdate,
        targetVersion: number,
    ): {updates: ReceivedDocumentUpdate[], invalidReason?: string} {
        const advance = pending.historyConfirmedAdvance;
        if (!advance || advance.reconcilingVersion !== targetVersion) {
            return {updates: [], invalidReason: 'confirmed History reconciliation lost its event cutoff'};
        }
        const deferred = advance.deferredUpdates?.splice(0) ?? [];
        const reconcilingPublicId = advance.reconcilingPublicId;
        const reconcilingSocketGeneration = advance.reconcilingSocketGeneration;
        advance.reconcilingVersion = undefined;
        advance.handoffInstalled = true;
        const accepted: ReceivedDocumentUpdate[] = [];
        const acceptedRaw = new Map<number, HistoryJsonValue>();
        let expectedRevision = targetVersion;
        // The ACK-era reconciliation reason still decides whether the owner
        // must be retired, but it must not poison a later fresh-generation
        // handoff. This batch is rejected only by errors in its own frozen
        // cutoff/event sequence.
        let invalidReason: string | undefined;
        for (const received of deferred) {
            let parsed;
            try {
                parsed = parseHistoryOtRealtimeEnvelope(received.update);
            } catch (error) {
                invalidReason ??= `deferred History update is malformed: ${String(error)}`;
                continue;
            }
            if (!parsed.safe
                || parsed.classification !== 'collaborator-update'
                || parsed.version === undefined
                || parsed.operation === undefined
                || typeof parsed.source !== 'string'
                || pending.submittedPublicIds.includes(parsed.source)
                || parsed.duplicate
                || received.sender?.publicId !== reconcilingPublicId
                || received.sender?.generation !== reconcilingSocketGeneration) {
                invalidReason ??= 'deferred History update has unproven collaborator authority';
                continue;
            }
            if (parsed.version < targetVersion) {
                const recorded = advance.updates.get(parsed.version);
                if (!recorded || !historyOtJsonEqual(recorded.raw, parsed.raw)) {
                    invalidReason ??= 'deferred History update conflicts with pre-join evidence';
                }
                continue;
            }
            if (parsed.version < expectedRevision) {
                const recorded = acceptedRaw.get(parsed.version);
                if (!recorded || !historyOtJsonEqual(recorded, parsed.raw)) {
                    invalidReason ??= 'deferred History update conflicts with an earlier revision';
                }
                continue;
            }
            if (parsed.version !== expectedRevision) {
                invalidReason ??= `deferred History updates are missing revision ${expectedRevision}`;
                continue;
            }
            if (!isNonnegativeSafeInteger(expectedRevision + 1)) {
                invalidReason ??= 'deferred History updates exceed the safe revision range';
                continue;
            }
            acceptedRaw.set(parsed.version, deepCloneJson(parsed.raw) as HistoryJsonValue);
            accepted.push(this.snapshotReceivedDocumentUpdate(parsed.raw, received.sender));
            expectedRevision += 1;
        }
        return invalidReason ? {updates: [], invalidReason} : {updates: accepted};
    }

    private installHistoryUpdateBarrier(docId: string): {
        beforeBarrier: Promise<void>,
        release: () => void,
    } {
        const queues = this.remoteUpdateQueueMap();
        const beforeBarrier = (queues.get(docId) ?? Promise.resolve()).catch(() => undefined);
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        let barrier!: Promise<void>;
        barrier = beforeBarrier.then(() => gate).finally(() => {
            if (queues.get(docId) === barrier) { queues.delete(docId); }
        });
        queues.set(docId, barrier);
        return {beforeBarrier, release};
    }

    private enqueueConfirmedHistoryDeferredBatch(
        pending: PendingDocumentUpdate,
        targetVersion: number,
    ): {
        invalidReason?: string,
        beforeBarrier: Promise<void>,
        release: () => void,
    } {
        const batch = this.takeConfirmedHistoryDeferredBatch(pending, targetVersion);
        if (!batch.invalidReason) {
            batch.updates.forEach(received => {
                this.queueHistoryOtDocumentUpdate(
                    received.update,
                    received.sender,
                    false,
                    true,
                );
            });
        }
        return {...this.installHistoryUpdateBarrier(pending.docId), invalidReason: batch.invalidReason};
    }

    private async reconcileConfirmedPending(
        pending: PendingDocumentUpdate,
        authoritative: {doc: DocumentEntity, content: string},
        submissionWitness: EditorBufferWitness,
    ): Promise<{
        submissionWitnessStillMatches: boolean,
        currentMatchesAuthoritative: boolean,
    }> {
        if (pending.otType === 'history-ot') {
            throw new Error('History OT must use its dedicated confirmed-state reconciliation');
        }
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
        const reconciliationDirtyText = sameBufferIncarnation
            ? live!.document.getText() : authoritative.content;
        const previousActive = this.activeEditorBases.get(pending.bufferId);
        // The sender ACK plus this fresh join establishes the next durable
        // remote base. Local input may continue while that base is being
        // persisted, so the editor bridge must be sampled again afterwards.
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
                dirtyText: reconciliationDirtyText,
            },
        );

        // The server outcome is now represented durably without pendingWrite.
        // Never retain an in-memory retry intent after this durability point.
        if (this.pendingDocumentUpdates.get(pending.bufferId) === pending) {
            this.pendingDocumentUpdates.delete(pending.bufferId);
        }

        const currentLive = this.editorBuffers.get(pending.bufferId);
        if (this.activeEditorBases.get(pending.bufferId) !== previousActive) {
            this.editorSaveReceipts.delete(pending.bufferId);
            throw new Error(
                'The editor base changed during confirmed-state reconciliation',
            );
        }
        if (sameBufferIncarnation
            && currentLive?.document === live!.document
            && this.bufferMatchesIncarnation(currentLive)) {
            const ledger = this.remoteDocumentCausality.get(pending.docId);
            const currentText = currentLive.document.getText();
            const currentDocumentVersion = currentLive.document.version;
            const currentIdentity = this.documentProvenanceIdentity(pending.docId, currentLive);
            const currentSender = this.currentSenderWitness();
            const pendingOperations = previousActive?.causality.pendingOperations.map(
                operation => ({...operation}),
            ) ?? [];
            let preservesPendingCausality = Boolean(
                previousActive
                && this.activeEditorBases.get(pending.bufferId) === previousActive
                && previousActive.bufferId === pending.bufferId
                && previousActive.identity.docId === pending.docId
                && previousActive.causality.valid
                && previousActive.causality.documentVersion === currentDocumentVersion
                && previousActive.causality.editorContent === currentText
                && previousActive.causality.inflightWire === undefined
                && previousActive.causality.inflightView === undefined
                && previousActive.causality.inflightToken === undefined
                && currentIdentity
                && this.sameDocumentProvenanceIdentity(identity, currentIdentity)
                && currentSender?.generation === previousActive.causality.socketGeneration
                && ledger?.valid
                && ledger.socketGeneration === currentSender?.generation
                && ledger.headVersion === authoritativeVersion
                && ledger.headContent === authoritative.content,
            );
            if (preservesPendingCausality) {
                try {
                    preservesPendingCausality = applyUtf16TextOperations(
                        authoritative.content,
                        pendingOperations,
                    ) === currentText;
                } catch {
                    preservesPendingCausality = false;
                }
            }
            const cleanAtAuthoritativeHead = pendingOperations.length === 0
                && currentText === authoritative.content
                && currentIdentity !== undefined
                && this.sameDocumentProvenanceIdentity(identity, currentIdentity)
                && ledger?.valid === true
                && ledger.socketGeneration === currentSender?.generation
                && ledger.headVersion === authoritativeVersion
                && ledger.headContent === authoritative.content;
            let causality: RealtimeEditorBridgeState = {
                socketGeneration: ledger?.socketGeneration ?? -1,
                remoteEpoch: ledger?.epoch ?? '',
                remoteVersion: authoritativeVersion,
                remoteContent: authoritative.content,
                documentVersion: currentDocumentVersion,
                editorContent: currentText,
                pendingOperations: [],
                localOperations: [],
                valid: false,
            };
            if ((preservesPendingCausality || cleanAtAuthoritativeHead) && ledger) {
                const cleanBase = createRealtimeEditorBridgeState({
                    socketGeneration: ledger.socketGeneration,
                    remoteEpoch: ledger.epoch,
                    remoteVersion: authoritativeVersion,
                    remoteContent: authoritative.content,
                    documentVersion: currentDocumentVersion,
                    editorContent: authoritative.content,
                });
                causality = pendingOperations.length === 0
                    ? cleanBase
                    : rebindLocalEditorPendingOperations(
                        cleanBase,
                        currentDocumentVersion,
                        currentText,
                        pendingOperations,
                    );
            }
            const overlappingCleanRefresh = this.cleanEditorRefreshMap().get(pending.bufferId);
            if (overlappingCleanRefresh) {
                // A clean provider refresh and a dirty editor submission are
                // mutually exclusive in the production state machine. If that
                // invariant is ever broken, do not let a later provider-origin
                // change be mistaken for local input on the reconstructed base.
                causality = {...causality, valid: false};
            }
            const active: EditorDocumentBase = {
                identity,
                bufferId: pending.bufferId,
                version: baseVersion,
                content: baseContent,
                recordName: reconciled.recordName,
                persistence: Promise.resolve(reconciled),
                providerStat: previousActive?.providerStat
                    ?? this.snapshotDocumentProviderStat(authoritative.doc),
                causality,
            };
            this.activeEditorBases.set(pending.bufferId, active);
            this.cleanEditorRefreshMap().delete(pending.bufferId);
            if (overlappingCleanRefresh) {
                this.pendingReadTickets.delete(currentLive.resourceKey);
                this.boundReadCandidates.delete(pending.bufferId);
            }

            if (reconciled.dirtyText !== currentText) {
                const persistence = this.provenanceStore.createOrUpdateCurrent({
                    identity,
                    bufferIncarnationId: pending.bufferId,
                    baseVersion,
                    baseText: baseContent,
                    dirtyText: currentText,
                });
                active.persistence = persistence;
                const latestRecord = await persistence;
                if (this.activeEditorBases.get(pending.bufferId) === active
                    && active.persistence === persistence) {
                    active.recordName = latestRecord.recordName;
                    active.persistence = Promise.resolve(latestRecord);
                }
            }

            const latestLive = this.editorBuffers.get(pending.bufferId);
            if (latestLive?.document === currentLive.document
                && this.bufferMatchesIncarnation(latestLive)) {
                const latestCausality = active.causality;
                if (latestLive.document.getText() === authoritative.content
                    && latestCausality.valid
                    && latestCausality.documentVersion === latestLive.document.version
                    && latestCausality.editorContent === authoritative.content
                    && latestCausality.inflightWire === undefined
                    && latestCausality.inflightView === undefined
                    && latestCausality.inflightToken === undefined
                    && latestCausality.pendingOperations.length === 0
                    && latestCausality.localOperations.length === 0
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

    private async retireConfirmedHistoryPending(
        pending: PendingDocumentUpdate,
        authoritative: {doc: DocumentEntity, content: string},
        witness: EditorBufferWitness,
        reason: string,
    ): Promise<never> {
        const version = authoritative.doc.version;
        const identity = pending.identity;
        const sender = this.currentSenderWitness();
        if (!isNonnegativeSafeInteger(version)
            || !identity
            || !sender
            || identity.canonicalServerUrl !== this.serverUrl
            || identity.userId !== this.userId
            || identity.projectId !== this.projectId
            || identity.docId !== pending.docId
            || identity.canonicalEditorUri !== this.canonicalEditorUri(pending.docId)
            || identity.otType !== 'history-ot'
            || identity.protocolVersion !== SUPPORTED_WRITE_PROTOCOL_VERSION
            || !this.documentMatchesAuthority(
                authoritative.doc,
                version,
                authoritative.content,
            )) {
            throw new Error(`Confirmed History recovery could not be retired durably: ${reason}`);
        }
        this.freezeConfirmedHistoryAdvance(pending, version, sender);
        const resolved = await this.provenanceStore.resolveCurrentRecord(
            pending.provenanceRecordName,
            {
                identity,
                bufferIncarnationId: pending.bufferId,
            },
        );
        if (resolved.kind !== 'valid' || !this.pendingRecordMatches(resolved.record, pending)) {
            throw new Error(`Confirmed History recovery record is no longer exact: ${reason}`);
        }
        const expectedMarker = pending.durablePendingWrite
            ?? this.pendingWritePayload(pending);
        const retiringMarker = this.pendingWritePayload(
            pending,
            'confirmed-retiring',
            {historyReconciliationVersion: version},
        );
        const retiringTransition = (pending.durablePendingWriteTransition ?? Promise.resolve())
            .then(() => this.provenanceStore.replacePendingWrite(
                pending.provenanceRecordName,
                expectedMarker,
                retiringMarker,
            )).then(() => {
                pending.durablePendingWrite = retiringMarker;
        });
        pending.durablePendingWriteTransition = retiringTransition;
        try {
            await retiringTransition;
            await this.awaitHistoryPendingDurability(pending);
        } catch (error) {
            const ownsPending = this.settleConfirmedHistoryPendingOwnerAfterFailure(pending);
            const active = this.activeEditorBases.get(pending.bufferId);
            if (ownsPending) {
                if (active) { this.invalidateEditorBase(active); }
                this.showDocumentRecovery(
                    witness.document.uri,
                    new TextEncoder().encode(witness.document.getText()),
                    `the confirmed History outcome remains non-resendable: ${String(error)}`,
                );
            }
            throw error;
        }
        const active = this.activeEditorBases.get(pending.bufferId);
        if (active) { this.invalidateEditorBase(active); }
        const handoff = this.enqueueConfirmedHistoryDeferredBatch(pending, version);
        try {
            await handoff.beforeBarrier;
            await this.awaitHistoryPendingDurability(pending);
            let currentDoc: DocumentEntity | undefined;
            try {
                currentDoc = this.currentDocument(pending.docId);
            } catch {
                currentDoc = undefined;
            }
            const baseVersion = currentDoc?.version;
            const baseContent = currentDoc?.remoteCache;
            const live = this.editorBuffers.get(pending.bufferId);
            const dirtyText = live && this.bufferMatchesIncarnation(live)
                ? live.document.getText() : resolved.record.dirtyText;
            if (!isNonnegativeSafeInteger(baseVersion)
                || baseContent === undefined
                || currentDoc?.otType !== 'history-ot'
                || currentDoc.historyOtSnapshot === undefined
                || currentDoc.historyOtSession !== pending.historySession
                || !this.documentMatchesAuthority(currentDoc, baseVersion, baseContent)) {
                throw new Error(`Confirmed History recovery lost its authoritative base: ${reason}`);
            }
            const record = await this.finalizeConfirmedHistoryPendingMarker(
                pending,
                retiringMarker,
                {
                    identity,
                    bufferIncarnationId: pending.bufferId,
                    baseVersion,
                    baseText: baseContent,
                    dirtyText,
                },
            );
            await this.awaitHistoryPendingDurability(pending);
            const latestLive = this.editorBuffers.get(pending.bufferId);
            const latestDirtyText = latestLive && this.bufferMatchesIncarnation(latestLive)
                ? latestLive.document.getText() : dirtyText;
            if (active) {
                active.version = baseVersion;
                active.content = baseContent;
                active.recordName = record.recordName;
                active.persistence = Promise.resolve(record);
            }
            if (this.pendingDocumentUpdates.get(pending.bufferId) === pending) {
                this.pendingDocumentUpdates.delete(pending.bufferId);
            }
            this.editorSaveReceipts.delete(pending.bufferId);
            this.historyRemoteEditorTransactionMap().delete(pending.bufferId);
            this.historyCleanEditorRefreshMap().delete(pending.bufferId);
            this.stageEditorBase(witness.document.uri, currentDoc, baseContent);
            const finalReason = handoff.invalidReason
                ? `${reason}; ${handoff.invalidReason}` : reason;
            this.showDocumentRecovery(
                witness.document.uri,
                new TextEncoder().encode(latestDirtyText),
                finalReason,
            );
            throw new Error(finalReason);
        } catch (error) {
            if (this.settleConfirmedHistoryPendingOwnerAfterFailure(pending)) {
                if (active) { this.invalidateEditorBase(active); }
                this.showDocumentRecovery(
                    witness.document.uri,
                    new TextEncoder().encode(witness.document.getText()),
                    `the confirmed History outcome remains non-resendable: ${String(error)}`,
                );
            }
            throw error;
        } finally {
            handoff.release();
        }
    }

    private async reconcileConfirmedHistoryPending(
        pending: PendingDocumentUpdate,
        authoritative: {doc: DocumentEntity, content: string},
        witness: EditorBufferWitness,
    ): Promise<{
        submissionWitnessStillMatches: boolean,
        currentMatchesAuthoritative: boolean,
    }> {
        const version = authoritative.doc.version;
        const snapshot = authoritative.doc.historyOtSnapshot;
        const epoch = authoritative.doc.historyOtEpoch;
        const sender = this.currentSenderWitness();
        const active = this.activeEditorBases.get(pending.bufferId);
        const live = this.editorBuffers.get(pending.bufferId);
        if (pending.otType !== 'history-ot'
            || pending.confirmationVersion === undefined
            || !isNonnegativeSafeInteger(version)
            || authoritative.doc.otType !== 'history-ot'
            || snapshot === undefined
            || !epoch
            || !sender
            || !this.documentMatchesAuthority(
                authoritative.doc,
                version,
                authoritative.content,
            )
            || authoritative.doc.historyOtSession !== pending.historySession
            || this.pendingDocumentUpdates.get(pending.bufferId) !== pending) {
            throw new Error('The confirmed History OT write has no exact authoritative reconciliation state');
        }
        const committedVersion = pending.confirmationVersion + 1;
        const advance = pending.historyConfirmedAdvance;
        if (advance) {
            this.freezeConfirmedHistoryAdvance(pending, version, sender);
        }
        if (!active?.historyCausality
            || !live
            || !this.bufferMatchesIncarnation(live)
            || active.bufferId !== pending.bufferId
            || active.identity.docId !== pending.docId) {
            return this.retireConfirmedHistoryPending(
                pending,
                authoritative,
                witness,
                'the confirmed History OT write lost its original editor incarnation',
            );
        }
        const originalHistory = active.historyCausality;
        const commitWitness = originalHistory.senderCommitWitness;
        if (!originalHistory.valid
            || originalHistory.authority !== 'rejoin-required'
            || !commitWitness
            || commitWitness.submissionToken !== pending.submissionToken
            || commitWitness.committedVersion !== committedVersion
            || !advance
            || advance.publicId !== sender.publicId
            || advance.socketGeneration !== sender.generation
            || advance.committedVersion !== committedVersion
            || advance.invalidReason !== undefined
            || [...advance.updates.keys()].some(revision =>
                revision < committedVersion
            )) {
            return this.retireConfirmedHistoryPending(
                pending,
                authoritative,
                witness,
                advance?.invalidReason
                    ?? 'the confirmed History OT write has incomplete collaborator ancestry',
            );
        }

        let history = reconcileHistoryEditorAfterJoin(originalHistory, {
            socketGeneration: sender.generation,
            remoteEpoch: epoch,
            remoteVersion: version,
            remoteSnapshot: snapshot,
            documentVersion: live.document.version,
            editorContent: live.document.getText(),
        });
        if (!history.valid || history.authority !== 'ready') {
            if (version <= committedVersion) {
                return this.retireConfirmedHistoryPending(
                    pending,
                    authoritative,
                    witness,
                    'the fresh History OT snapshot does not exactly witness the committed operation',
                );
            }
            let composed: ReturnType<typeof parseHistoryOtOperations> | undefined;
            let replayed = parseHistoryOtSnapshot(commitWitness.predictedRemoteSnapshot.raw);
            for (let revision = committedVersion; revision < version; revision += 1) {
                const recorded = advance.updates.get(revision);
                if (!recorded) {
                    return this.retireConfirmedHistoryPending(
                        pending,
                        authoritative,
                        witness,
                        `the confirmed History OT collaborator chain is missing revision ${revision}`,
                    );
                }
                const operations = parseHistoryOtOperations(recorded.operation);
                composed = composed === undefined ? operations
                    : composeHistoryOtOperationsWithSnapshot(
                        commitWitness.predictedRemoteSnapshot,
                        composed,
                        operations,
                    );
                replayed = applyHistoryOtOperations(replayed, operations);
            }
            if (!composed || !historyOtJsonEqual(replayed.raw, snapshot)) {
                return this.retireConfirmedHistoryPending(
                    pending,
                    authoritative,
                    witness,
                    'the confirmed History OT collaborator chain does not match the fresh snapshot',
                );
            }
            const anchored = reconcileHistoryEditorAfterJoin(originalHistory, {
                socketGeneration: sender.generation,
                remoteEpoch: epoch,
                remoteVersion: committedVersion,
                remoteSnapshot: commitWitness.predictedRemoteSnapshot,
                documentVersion: live.document.version,
                editorContent: live.document.getText(),
            });
            if (!anchored.valid || anchored.authority !== 'ready') {
                return this.retireConfirmedHistoryPending(
                    pending,
                    authoritative,
                    witness,
                    'the confirmed History OT sender snapshot cannot anchor collaborator replay',
                );
            }
            let transaction: HistoryRemoteEditorTransaction;
            try {
                transaction = prepareHistoryRemoteEditorCatchupTransaction(
                    anchored,
                    randomUUID(),
                    version,
                    composed,
                    snapshot,
                );
            } catch (error) {
                return this.retireConfirmedHistoryPending(
                    pending,
                    authoritative,
                    witness,
                    `the confirmed History OT collaborator replay diverged: ${String(error)}`,
                );
            }
            active.historyCausality = anchored;
            const applied = await this.applyPreparedHistoryRemoteEditorUpdate({
                bufferId: pending.bufferId,
                document: live.document,
                active,
                transaction,
                delivery: 'workspace-edit',
            }, false);
            history = active.historyCausality;
            if (!applied
                || !history?.valid
                || history.authority !== 'ready'
                || history.remoteVersion !== version
                || !historyOtJsonEqual(history.remoteSnapshot.raw, snapshot)
                || this.pendingDocumentUpdates.get(pending.bufferId) !== pending
                || this.activeEditorBases.get(pending.bufferId) !== active
                || !this.bufferMatchesIncarnation(live)
                || !this.documentMatchesAuthority(
                    authoritative.doc,
                    version,
                    authoritative.content,
                )) {
                return this.retireConfirmedHistoryPending(
                    pending,
                    authoritative,
                    witness,
                    'the confirmed History OT collaborator replay was not applied exactly to the editor',
                );
            }
        }
        active.historyCausality = history;

        const identity = this.documentProvenanceIdentity(pending.docId, live);
        if (!identity
            || identity.otType !== 'history-ot'
            || !pending.identity
            || !this.sameDocumentProvenanceIdentity(identity, pending.identity)) {
            return this.retireConfirmedHistoryPending(
                pending,
                authoritative,
                witness,
                'the History OT sender identity changed before durable reconciliation',
            );
        }
        const expectedMarker = pending.durablePendingWrite
            ?? this.pendingWritePayload(pending);
        const reconcilingMarker = this.pendingWritePayload(
            pending,
            'confirmed-reconciling',
            {historyReconciliationVersion: version},
        );
        const reconcilingTransition = (pending.durablePendingWriteTransition ?? Promise.resolve())
            .then(() => this.provenanceStore.replacePendingWrite(
                pending.provenanceRecordName,
                expectedMarker,
                reconcilingMarker,
            )).then(() => {
                pending.durablePendingWrite = reconcilingMarker;
        });
        pending.durablePendingWriteTransition = reconcilingTransition;
        try {
            await reconcilingTransition;
            await this.awaitHistoryPendingDurability(pending);
        } catch (error) {
            if (this.settleConfirmedHistoryPendingOwnerAfterFailure(pending)) {
                this.invalidateEditorBase(active);
                this.showDocumentRecovery(
                    live.document.uri,
                    new TextEncoder().encode(live.document.getText()),
                    `the confirmed History outcome remains non-resendable: ${String(error)}`,
                );
            }
            throw error;
        }
        const handoff = this.enqueueConfirmedHistoryDeferredBatch(pending, version);
        try {
            await handoff.beforeBarrier;
            await this.awaitHistoryPendingDurability(pending);
            let finalDoc: DocumentEntity | undefined;
            try {
                finalDoc = this.currentDocument(pending.docId);
            } catch {
                finalDoc = undefined;
            }
            const finalVersion = finalDoc?.version;
            const finalContent = finalDoc?.remoteCache;
            const finalSnapshot = finalDoc?.historyOtSnapshot;
            const finalHistory = active.historyCausality;
            const finalSender = this.currentSenderWitness();
            const finalIdentity = this.documentProvenanceIdentity(pending.docId, live);
            const bridgeFailures = finalHistory ? [
                finalHistory.valid ? undefined : 'invalid',
                finalHistory.authority === 'ready' ? undefined : 'authority',
                finalHistory.socketGeneration === finalSender?.generation ? undefined : 'generation',
                finalHistory.remoteEpoch === finalDoc?.historyOtEpoch ? undefined : 'epoch',
                finalHistory.remoteVersion === finalVersion ? undefined : 'remote-version',
                finalSnapshot !== undefined
                    && historyOtJsonEqual(finalHistory.remoteSnapshot.raw, finalSnapshot)
                    ? undefined : 'snapshot',
                finalHistory.documentVersion === live.document.version ? undefined : 'document-version',
                finalHistory.editorContent === live.document.getText() ? undefined : 'editor-content',
            ].filter((item): item is string => item !== undefined) : ['missing'];
            const finalStateFailure = !finalDoc
                || !isNonnegativeSafeInteger(finalVersion)
                || finalContent === undefined
                || finalSnapshot === undefined
                || finalDoc.otType !== 'history-ot'
                || finalDoc.historyOtSession !== pending.historySession
                || !this.documentMatchesAuthority(finalDoc, finalVersion!, finalContent)
                ? 'the deferred History handoff lost its document authority'
                : this.activeEditorBases.get(pending.bufferId) !== active
                    || this.pendingDocumentUpdates.get(pending.bufferId) !== pending
                    || !this.bufferMatchesIncarnation(live)
                    || !finalIdentity
                    || !this.sameDocumentProvenanceIdentity(finalIdentity, identity)
                    || finalSender?.publicId !== advance.publicId
                    || finalSender.generation !== advance.socketGeneration
                    ? 'the deferred History handoff lost its editor incarnation'
                    : bridgeFailures.length > 0
                        ? `the deferred History handoff lost its exact editor bridge (${bridgeFailures.join(', ')})`
                        : undefined;
            const failureReason = handoff.invalidReason
                ?? finalStateFailure;
            if (failureReason || !finalDoc || !isNonnegativeSafeInteger(finalVersion)
                || finalContent === undefined) {
                if (finalDoc && isNonnegativeSafeInteger(finalVersion)
                    && finalContent !== undefined
                    && finalDoc.historyOtSnapshot !== undefined
                    && finalDoc.historyOtSession === pending.historySession) {
                    const retired = await this.finalizeConfirmedHistoryPendingMarker(
                        pending,
                        reconcilingMarker,
                        {
                            identity,
                            bufferIncarnationId: pending.bufferId,
                            baseVersion: finalVersion,
                            baseText: finalContent,
                            dirtyText: live.document.getText(),
                        },
                    );
                    await this.awaitHistoryPendingDurability(pending);
                    active.recordName = retired.recordName;
                    active.persistence = Promise.resolve(retired);
                    active.version = finalVersion;
                    active.content = finalContent;
                }
                if (pending.durablePendingWriteCleared
                    && this.pendingDocumentUpdates.get(pending.bufferId) === pending) {
                    this.pendingDocumentUpdates.delete(pending.bufferId);
                }
                this.invalidateEditorBase(active);
                this.editorSaveReceipts.delete(pending.bufferId);
                const reason = failureReason
                    ?? 'the confirmed History OT event handoff lost its authoritative state';
                if (pending.durablePendingWriteCleared) {
                    this.showDocumentRecovery(
                        live.document.uri,
                        new TextEncoder().encode(live.document.getText()),
                        reason,
                    );
                }
                throw new Error(reason);
            }

            const record = await this.finalizeConfirmedHistoryPendingMarker(
                pending,
                reconcilingMarker,
                {
                    identity,
                    bufferIncarnationId: pending.bufferId,
                    baseVersion: finalVersion,
                    baseText: finalContent,
                    dirtyText: live.document.getText(),
                },
            );
            await this.awaitHistoryPendingDurability(pending);
            const latestHistory = active.historyCausality;
            const latestSender = this.currentSenderWitness();
            const latestIdentity = this.documentProvenanceIdentity(pending.docId, live);
            if (this.activeEditorBases.get(pending.bufferId) !== active
                || this.pendingDocumentUpdates.get(pending.bufferId) !== pending
                || !this.bufferMatchesIncarnation(live)
                || !latestIdentity
                || !this.sameDocumentProvenanceIdentity(latestIdentity, identity)
                || latestSender?.publicId !== advance.publicId
                || latestSender.generation !== advance.socketGeneration
                || !latestHistory?.valid
                || latestHistory.authority !== 'ready'
                || latestHistory.remoteVersion !== finalVersion
                || !historyOtJsonEqual(latestHistory.remoteSnapshot.raw, finalSnapshot!)
                || latestHistory.documentVersion !== live.document.version
                || latestHistory.editorContent !== live.document.getText()
                || !this.documentMatchesAuthority(finalDoc, finalVersion, finalContent)) {
                this.invalidateEditorBase(active);
                this.showDocumentRecovery(
                    live.document.uri,
                    new TextEncoder().encode(live.document.getText()),
                    'the History OT editor changed during durable reconciliation',
                );
                throw new Error('The History OT editor changed during durable reconciliation');
            }
            if (this.pendingDocumentUpdates.get(pending.bufferId) === pending) {
                this.pendingDocumentUpdates.delete(pending.bufferId);
            }
            active.identity = identity;
            active.version = finalVersion;
            active.content = finalContent;
            active.recordName = record.recordName;
            active.persistence = Promise.resolve(record);
            active.causality = this.createLocalEditorCausality(
                live.document,
                pending.docId,
                finalVersion,
                finalContent,
            );
            active.historyCausality = latestHistory;
            this.stageEditorBase(live.document.uri, finalDoc, finalContent);
            const currentMatchesAuthoritative = live.document.getText() === finalContent
                && this.documentMatchesAuthority(finalDoc, finalVersion, finalContent);
            if (currentMatchesAuthoritative) {
                finalDoc.localCache = finalContent;
                this.editorSaveReceipts.set(pending.bufferId, {
                    document: live.document,
                    identity,
                    bufferId: pending.bufferId,
                    version: finalVersion,
                    content: finalContent,
                });
            } else {
                this.editorSaveReceipts.delete(pending.bufferId);
            }
            return {
                submissionWitnessStillMatches: this.bufferMatchesWitness(witness),
                currentMatchesAuthoritative,
            };
        } catch (error) {
            if (this.settleConfirmedHistoryPendingOwnerAfterFailure(pending)) {
                this.invalidateEditorBase(active);
                this.showDocumentRecovery(
                    live.document.uri,
                    new TextEncoder().encode(live.document.getText()),
                    `the confirmed History outcome remains non-resendable: ${String(error)}`,
                );
            }
            throw error;
        } finally {
            handoff.release();
        }
    }

    private async writeHistoryOtDocument(
        uri: vscode.Uri,
        content: Uint8Array,
        desiredContent: string,
        doc: DocumentEntity,
        remoteContent: string,
        sessionVersion: number,
        witness: EditorBufferWitness,
        provenance: Extract<EditorProvenanceResolution, {kind: 'valid'}>['value'],
        liveSnapshot?: LiveEditorWriteSnapshot,
    ): Promise<void> {
        const active = this.activeEditorBases.get(witness.bufferId);
        const history = active?.historyCausality;
        let pendingChangesSnapshot = false;
        if (history?.pending !== undefined) {
            try {
                pendingChangesSnapshot = !historyOtJsonEqual(
                    applyHistoryOtOperations(history.remoteSnapshot, history.pending).raw,
                    history.remoteSnapshot.raw,
                );
            } catch {
                pendingChangesSnapshot = true;
            }
        }
        if (desiredContent === remoteContent && !pendingChangesSnapshot) {
            await this.acceptEditorBase(
                witness,
                doc,
                sessionVersion,
                remoteContent,
                provenance.recordsToClear,
            );
            return;
        }
        this.assertAuthenticatedAccount(uri);
        const sender = this.currentSenderWitness();
        const historySession = doc.historyOtSession;
        const state = historySession?.getState();
        const descriptor = history?.pendingWriteDescriptor;
        const intent: HistoryOtWriteIntent | undefined = descriptor?.kind === 'tracked-write'
            ? {kind: 'tracked-write'}
            : descriptor?.kind === 'plain-write' ? {kind: 'plain-write'} : undefined;
        if (!sender
            || !active
            || !history?.valid
            || history.authority !== 'ready'
            || !historySession
            || !intent
            || state?.phase !== 'ready'
            || state.version !== sessionVersion
            || history.socketGeneration !== sender.generation
            || history.remoteVersion !== sessionVersion
            || doc.historyOtSnapshot === undefined
            || !historyOtJsonEqual(history.remoteSnapshot.raw, doc.historyOtSnapshot)
            || history.editorContent !== desiredContent
            || history.documentVersion !== witness.documentVersion
            || history.inflightWire !== undefined
            || history.inflightView !== undefined
            || history.inflightToken !== undefined
            || history.pending === undefined
            || active.version !== provenance.record.baseVersion
            || active.content !== provenance.record.baseText
            || provenance.record.pendingWrite !== undefined) {
            this.blockDocumentWrite(
                uri,
                content,
                'the History OT save does not match one exact captured local operation',
            );
        }
        const operation = serializeHistoryOtOperations(history.pending);
        if (!Array.isArray(operation) || operation.length !== 1) {
            this.blockDocumentWrite(
                uri,
                content,
                'the History OT operation cannot be represented as one frozen wire operation',
            );
        }
        let staged: HistoryOtSessionResult;
        try {
            staged = historySession.stage(sender.generation, {
                operation,
                meta: intent.kind === 'tracked-write' ? {tc: randomUUID()} : undefined,
                intent,
                publicId: sender.publicId,
            });
        } catch (error) {
            throw error;
        }
        if (!staged.envelope || !staged.submissionToken) {
            throw new Error('History OT staging did not produce an exact authorized submission');
        }
        try {
            active.historyCausality = beginHistorySubmission(
                history,
                staged.submissionToken,
                operation,
                descriptor,
            );
        } catch (error) {
            historySession.cancelStagedSubmission(sender.generation, staged.submissionToken);
            throw error;
        }
        const pending: PendingDocumentUpdate = {
            otType: 'history-ot',
            docId: doc._id,
            bufferId: witness.bufferId,
            provenanceRecordName: provenance.record.recordName,
            update: staged.envelope as unknown as UpdateSchema,
            desiredContent,
            mergedContent: desiredContent,
            baseVersion: provenance.record.baseVersion,
            baseContent: provenance.record.baseText,
            submittedPublicIds: [sender.publicId],
            socketGeneration: sender.generation,
            submissionToken: staged.submissionToken,
            historyIntent: intent,
            identity: active.identity,
            historySession,
        };
        let pendingRecord: DocumentProvenanceRecord;
        try {
            pendingRecord = await this.provenanceStore.markPendingWrite(
                pending.provenanceRecordName,
                this.pendingWritePayload(pending),
            );
        } catch (error) {
            historySession.cancelStagedSubmission(sender.generation, staged.submissionToken);
            active.historyCausality = rejectHistorySubmission(
                active.historyCausality,
                staged.submissionToken,
            );
            throw error;
        }
        let preEmitError: unknown;
        try {
            this.assertAuthenticatedAccount(uri);
            const senderBeforeSend = this.currentSenderWitness();
            if (!this.documentMatchesAuthority(doc, sessionVersion, remoteContent)
                || !this.bufferMatchesWitness(witness)
                || senderBeforeSend?.publicId !== sender.publicId
                || senderBeforeSend.generation !== sender.generation
                || this.activeEditorBases.get(witness.bufferId) !== active
                || active.historyCausality?.inflightToken !== staged.submissionToken
                || doc.historyOtSession !== historySession) {
                throw new Error('History OT authority changed before transport submission');
            }
        } catch (error) {
            preEmitError = error;
        }
        if (preEmitError !== undefined) {
            historySession.cancelStagedSubmission(sender.generation, staged.submissionToken);
            active.historyCausality = rejectHistorySubmission(
                active.historyCausality!,
                staged.submissionToken,
            );
            await this.provenanceStore.clearPendingWrite(pendingRecord.recordName);
            if (liveSnapshot && this.liveEditorSnapshotWasProvenAdvanced(doc, liveSnapshot)) {
                throw new StaleLiveEditorSnapshotError();
            }
            throw preEmitError;
        }
        this.pendingDocumentUpdates.set(witness.bufferId, pending);
        this.markSourceDirty();
        const waiter = this.waitForDocumentVersion(doc._id, sessionVersion);
        try {
            await awaitHistoryOtSubmissionCommit(
                this.socket.applyHistoryOtUpdate(
                    doc._id,
                    staged.envelope,
                    intent,
                    staged.submissionToken,
                    historySession,
                    sender,
                ),
                waiter.promise.then(version => {
                    pending.confirmationVersion = version;
                }),
                () => {
                    historySession.markQueueAccepted(sender.generation, staged.submissionToken!);
                },
                error => error instanceof SocketRequestError && error.outcomeUnknown,
            );
        } catch (error) {
            waiter.cancel();
            const sessionAfterFailure = historySession.getState();
            const outcomeUnknown = error instanceof SocketRequestError
                ? error.outcomeUnknown
                : sessionAfterFailure.pendingWireAttempted;
            if (!outcomeUnknown) {
                historySession.rejectStagedSubmission(sender.generation, staged.submissionToken);
                const current = this.activeEditorBases.get(witness.bufferId);
                if (current?.historyCausality) {
                    current.historyCausality = rejectHistorySubmission(
                        current.historyCausality,
                        staged.submissionToken,
                    );
                }
                await this.provenanceStore.clearPendingWrite(pending.provenanceRecordName);
                if (this.pendingDocumentUpdates.get(witness.bufferId) === pending) {
                    this.pendingDocumentUpdates.delete(witness.bufferId);
                }
                throw error;
            }
            throw new SocketRequestError(
                'stale_connection',
                `The History OT write outcome is unknown: ${String(error)}`,
                true,
                error,
            );
        }

        const authoritative = await this.joinFreshDocumentSession(doc._id);
        const reconciled = await this.reconcileConfirmedHistoryPending(
            pending,
            authoritative,
            witness,
        );
        setTimeout(() => this.notify([{type: vscode.FileChangeType.Changed, uri}]), 10);
        if (reconciled.submissionWitnessStillMatches
            && !reconciled.currentMatchesAuthoritative) {
            this.blockDocumentWrite(
                uri,
                content,
                'the History OT save committed with collaborator text absent from this editor',
            );
        }
    }

    /**
     * Retry an outcome-unknown write only inside the same extension-host
     * session, from its exact durable intent, and under a fresh socket public
     * id. dupIfSource makes either possible server outcome idempotent: an
     * unapplied write is committed once, while an already-applied write is only
     * confirmed to the new sender and is not broadcast again.
     */
    private async recoverPendingHistoryDocumentUpdate(
        uri: vscode.Uri,
        content: Uint8Array,
        docId: string,
        witness: EditorBufferWitness,
        pending: PendingDocumentUpdate,
    ): Promise<boolean> {
        if (pending.confirmationVersion !== undefined) {
            const authoritative = await this.joinFreshDocumentSession(docId);
            const reconciled = await this.reconcileConfirmedHistoryPending(
                pending,
                authoritative,
                witness,
            );
            return reconciled.currentMatchesAuthoritative;
        }
        this.assertAuthenticatedAccount(uri);
        const joined = await this.ensureDocumentSession(docId);
        const historySession = joined.doc.historyOtSession;
        const historySnapshot = joined.doc.historyOtSnapshot;
        const historyEpoch = joined.doc.historyOtEpoch;
        const sender = this.currentSenderWitness();
        const active = this.activeEditorBases.get(witness.bufferId);
        const history = active?.historyCausality;
        if (joined.doc.otType !== 'history-ot'
            || !historySession
            || historySession !== pending.historySession
            || historySession.getState().phase !== 'recovery-ready'
            || historySnapshot === undefined
            || !historyEpoch
            || !isNonnegativeSafeInteger(joined.doc.version)
            || !sender
            || pending.submittedPublicIds.includes(sender.publicId)
            || !pending.historyIntent
            || !active
            || !history?.valid
            || history.inflightWire === undefined) {
            this.blockDocumentWrite(
                uri,
                content,
                'the pending History OT write has no exact fresh recovery session',
            );
        }
        const staged = historySession.prepareRecovery(sender.generation, sender.publicId);
        if (!staged.envelope || !staged.submissionToken) {
            throw new Error('History OT recovery did not produce an exact authorized submission');
        }
        active.historyCausality = rebindHistorySubmissionForRecovery(history, {
            socketGeneration: sender.generation,
            remoteEpoch: historyEpoch,
            submissionToken: staged.submissionToken,
            joinVersion: joined.doc.version,
            joinSnapshot: historySnapshot,
            documentVersion: witness.documentVersion,
            editorContent: witness.content,
        });
        if (!active.historyCausality.valid) {
            historySession.cancelStagedSubmission(sender.generation, staged.submissionToken);
            this.blockDocumentWrite(
                uri,
                content,
                'the fresh History OT join contains collaborator ancestry that cannot be recovered exactly',
            );
        }
        const retryPending: PendingDocumentUpdate = {
            ...pending,
            update: staged.envelope as unknown as UpdateSchema,
            submittedPublicIds: [...pending.submittedPublicIds, sender.publicId],
            socketGeneration: sender.generation,
            submissionToken: staged.submissionToken,
            historySession,
        };
        await this.provenanceStore.markPendingWrite(
            retryPending.provenanceRecordName,
            this.pendingWritePayload(retryPending),
        );
        let authorizationError: unknown;
        try {
            this.assertAuthenticatedAccount(uri);
            const currentSender = this.currentSenderWitness();
            if (currentSender?.publicId !== sender.publicId
                || currentSender.generation !== sender.generation
                || this.pendingDocumentUpdates.get(witness.bufferId) !== pending
                || this.activeEditorBases.get(witness.bufferId) !== active
                || active.historyCausality.inflightToken !== staged.submissionToken
                || !this.bufferMatchesWitness(witness)
                || joined.doc.historyOtSession !== historySession) {
                throw new Error('History OT recovery authority changed before transport submission');
            }
        } catch (error) {
            authorizationError = error;
        }
        if (authorizationError !== undefined) {
            historySession.cancelStagedSubmission(sender.generation, staged.submissionToken);
            active.historyCausality = {...active.historyCausality, valid: false};
            await this.provenanceStore.markPendingWrite(
                pending.provenanceRecordName,
                this.pendingWritePayload(pending),
            );
            throw authorizationError;
        }
        this.pendingDocumentUpdates.set(witness.bufferId, retryPending);
        const waiter = this.waitForDocumentVersion(docId, retryPending.update.v);
        try {
            await awaitHistoryOtSubmissionCommit(
                this.socket.applyHistoryOtUpdate(
                    docId,
                    staged.envelope,
                    pending.historyIntent,
                    staged.submissionToken,
                    historySession,
                    sender,
                ),
                waiter.promise.then(version => {
                    retryPending.confirmationVersion = version;
                }),
                () => historySession.markQueueAccepted(
                    sender.generation,
                    staged.submissionToken!,
                ),
                error => error instanceof SocketRequestError && error.outcomeUnknown,
            );
        } catch (error) {
            waiter.cancel();
            const outcomeUnknown = error instanceof SocketRequestError
                ? error.outcomeUnknown
                : historySession.getState().pendingWireAttempted;
            if (!outcomeUnknown) {
                historySession.rejectStagedSubmission(sender.generation, staged.submissionToken);
                await this.provenanceStore.markPendingWrite(
                    pending.provenanceRecordName,
                    this.pendingWritePayload(pending),
                );
                this.pendingDocumentUpdates.set(witness.bufferId, pending);
                this.forceFreshConnection();
                throw error;
            }
            throw new SocketRequestError(
                'stale_connection',
                `The History OT recovery outcome is unknown: ${String(error)}`,
                true,
                error,
            );
        }
        const authoritative = await this.joinFreshDocumentSession(docId);
        const reconciled = await this.reconcileConfirmedHistoryPending(
            retryPending,
            authoritative,
            witness,
        );
        setTimeout(() => this.notify([{type: vscode.FileChangeType.Changed, uri}]), 10);
        if (reconciled.submissionWitnessStillMatches
            && !reconciled.currentMatchesAuthoritative) {
            this.blockDocumentWrite(
                uri,
                content,
                'the recovered History OT save committed with remote text absent from this editor',
            );
        }
        return true;
    }

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
                dirtyText: desiredContent,
            },
        );
        if (resolved.kind !== 'valid' || !this.pendingRecordMatches(resolved.record, pending)) {
            this.blockDocumentWrite(
                uri,
                content,
                'the durable pending-write record no longer matches the exact submitted operation',
            );
        }

        if (pending.otType === 'history-ot') {
            return this.recoverPendingHistoryDocumentUpdate(
                uri,
                content,
                docId,
                witness,
                pending,
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
        if (retrySession.doc.otType !== 'sharejs-text-ot'
            || !isNonnegativeSafeInteger(retrySessionVersion)
            || !isNonnegativeSafeInteger(retrySessionVersion + 1)) {
            this.blockDocumentWrite(
                uri,
                content,
                'the current document revision cannot accept a safe deduplicated retry',
            );
        }
        if (desiredContent !== pending.desiredContent) {
            const ledger = this.remoteDocumentCausality.get(docId);
            const active = this.activeEditorBases.get(witness.bufferId);
            const local = active?.causality;
            const laterOperations = local?.pendingOperations.map(operation => ({...operation}));
            const exactAppliedOutcome = pending.update.v === pending.baseVersion
                && retrySessionVersion === pending.baseVersion + 1
                && pending.desiredContent === pending.mergedContent
                && retrySession.content === pending.mergedContent
                && retrySession.doc.remoteCache === retrySession.content
                && ledger?.valid === true
                && ledger.socketGeneration === this.socket.generation
                && ledger.headVersion === retrySessionVersion
                && ledger.headContent === retrySession.content;
            let exactObservedTail = false;
            try {
                exactObservedTail = Boolean(
                    active
                    && local
                    && active.bufferId === witness.bufferId
                    && active.identity.docId === docId
                    && local.socketGeneration === pending.socketGeneration
                    && local.remoteVersion === pending.baseVersion
                    && local.remoteContent === pending.baseContent
                    && local.documentVersion === witness.documentVersion
                    && local.editorContent === desiredContent
                    && local.inflightToken === pending.submissionToken
                    && local.inflightWire !== undefined
                    && local.inflightView !== undefined
                    && this.sameTextOperations(
                        local.inflightWire,
                        pending.update.op ?? [],
                    )
                    && this.sameTextOperations(
                        local.localOperations,
                        [...local.inflightView, ...(laterOperations ?? [])],
                    )
                    && applyUtf16TextOperations(
                        pending.baseContent,
                        local.inflightView,
                    ) === pending.desiredContent
                    && laterOperations !== undefined
                    && laterOperations.length > 0
                    && applyUtf16TextOperations(
                        pending.desiredContent,
                        laterOperations,
                    ) === desiredContent,
                );
            } catch {
                exactObservedTail = false;
            }
            if (!exactAppliedOutcome
                || !exactObservedTail
                || !laterOperations
                || !active
                || !this.bufferMatchesWitness(witness)) {
                this.blockDocumentWrite(
                    uri,
                    content,
                    'later local input cannot be replayed because it lacks exact editor-event '
                        + 'causality or the outcome-unknown write has no exact applied remote witness',
                );
            }
            const reboundBase = createRealtimeEditorBridgeState({
                socketGeneration: ledger.socketGeneration,
                remoteEpoch: ledger.epoch,
                remoteVersion: retrySessionVersion,
                remoteContent: retrySession.content,
                documentVersion: witness.documentVersion,
                editorContent: retrySession.content,
            });
            const rebound = rebindLocalEditorPendingOperations(
                reboundBase,
                witness.documentVersion,
                desiredContent,
                laterOperations,
            );
            if (!rebound.valid) {
                this.blockDocumentWrite(
                    uri,
                    content,
                    'later local input cannot be rebound to the exact applied remote witness',
                );
            }
            active.causality = rebound;
            pending.confirmationVersion = pending.update.v;
            const reconciled = await this.reconcileConfirmedPending(
                pending,
                retrySession,
                witness,
            );
            retrySession.doc.lastVersion = pending.update.v;
            setTimeout(() => {
                this.notify([{type: vscode.FileChangeType.Changed, uri}]);
            }, 10);
            if (!reconciled.submissionWitnessStillMatches) {
                this.blockDocumentWrite(
                    uri,
                    content,
                    'the editor changed while later local input was being rebound after reconnecting',
                );
            }
            return false;
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
            const observedConfirmation = isNonnegativeSafeInteger(
                retryPending.confirmationVersion,
            );
            const outcomeUnknown = observedConfirmation
                || !(error instanceof SocketRequestError)
                || error.outcomeUnknown;
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
                observedConfirmation
                    ? 'the deduplicated retry was confirmed before its acknowledgement reported failure'
                    : outcomeUnknown
                        ? 'the deduplicated retry also has an unknown outcome'
                        : `the realtime server rejected the deduplicated retry: ${String(error)}`,
            );
            if (observedConfirmation
                && error instanceof SocketRequestError
                && !error.outcomeUnknown) {
                throw new SocketRequestError(
                    'stale_connection',
                    `The deduplicated retry was confirmed before a contradictory acknowledgement failure: ${String(error)}`,
                    true,
                    error,
                );
            }
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

    private async writeConditionalProviderDocument(
        uri: vscode.Uri,
        content: Uint8Array,
        desiredContent: string,
        doc: DocumentEntity,
        witness: ProviderDocumentReadWitness,
    ): Promise<void> {
        const session = await this.ensureDocumentSession(doc._id);
        const remoteContent = session.content;
        const sessionVersion = session.doc.version;
        if (session.doc !== doc
            || doc.otType !== 'sharejs-text-ot'
            || !isNonnegativeSafeInteger(sessionVersion)
            || !isNonnegativeSafeInteger(sessionVersion + 1)) {
            this.blockDocumentWrite(uri, content, 'the provider read no longer has a plain-text realtime session');
        }
        if (!this.providerReadWitnessMatchesAuthority(
            witness,
            doc,
            sessionVersion,
            remoteContent,
        )) {
            this.blockDocumentWrite(
                uri,
                content,
                'the provider read no longer matches the current authoritative document head',
            );
        }
        const requestedOperations = operationsFromContentSnapshots(remoteContent, desiredContent);
        if (!requestedOperations || requestedOperations.some(operation =>
            typeof operation.i !== 'string' || operation.d !== undefined
        )) {
            this.blockDocumentWrite(
                uri,
                content,
                'a provider write without an editor may only insert into the current authoritative text',
            );
        }
        const evidence = this.causalEvidenceForProviderWrite(
            witness,
            sessionVersion,
            remoteContent,
            desiredContent,
        );
        const authorization = prepareProvenDocumentUpdate({
            version: witness.version,
            content: witness.content,
            pendingWrite: false,
        }, sessionVersion, remoteContent, desiredContent, evidence);
        if (authorization.status === 'blocked') {
            const reasons = {
                'missing-base': 'the provider read base is unavailable',
                'pending-write': 'a previous provider write has an unknown outcome',
                'version-regression': 'the remote revision moved behind the provider read',
                'content-version-mismatch': 'the remote text changed without a revision advance',
                'missing-local-causality': 'the requested bytes cannot be derived from the exact provider read',
                'missing-remote-causality': 'the remote operation ancestry since the provider read is incomplete',
                'invalid-causal-operations': 'the provider or remote operation chain is invalid',
                'causal-conflict': 'the requested write overlaps a collaborator edit; read the document again',
                'unsupported-text': 'Overleaf cannot store NUL or non-BMP characters (such as emoji); the changes were not sent',
            } as const;
            this.blockDocumentWrite(uri, content, reasons[authorization.reason]);
        }
        if (authorization.status === 'noop') {
            doc.localCache = authorization.prepared.mergedContent;
            return;
        }
        if (!authorization.prepared.mergeApplied
            || authorization.prepared.operations.length === 0) {
            this.blockDocumentWrite(uri, content, 'the conditional write has no exact text operation');
        }
        const sender = this.currentSenderWitness();
        if (sender?.publicId !== witness.publicId
            || sender.generation !== witness.socketGeneration
            || this.pendingConditionalDocumentUpdates.has(doc._id)) {
            this.blockDocumentWrite(uri, content, 'the conditional write lost its unique realtime sender');
        }
        vscode.workspace.textDocuments.forEach(document => {
            this.observeEditorBuffer(document);
        });
        if ([...this.editorBuffers.values()].some(buffer =>
            buffer.docId === doc._id
            && vscode.workspace.textDocuments.includes(buffer.document)
            && !buffer.document.isClosed)) {
            this.blockDocumentWrite(uri, content, 'an editor opened this document during the conditional write');
        }
        if (!this.documentMatchesAuthority(doc, sessionVersion, remoteContent)) {
            this.blockDocumentWrite(uri, content, 'the remote document moved before the conditional write');
        }
        const mergedContent = authorization.prepared.mergedContent;
        const update: UpdateSchema = {
            doc: doc._id,
            lastV: doc.lastVersion,
            v: sessionVersion,
            hash: (() => {
                if (!doc.mtime || Date.now() - doc.mtime > 5000) {
                    doc.mtime = Date.now();
                    return require('crypto').createHash('sha1').update(
                        // ShareJS hashes the JavaScript string length (UTF-16
                        // code units), not its UTF-8 byte length. Keep this
                        // exactly aligned with the ordinary editor path and
                        // the server protocol.
                        "blob " + mergedContent.length + "\x00" + mergedContent
                    ).digest('hex');
                }
            })(),
            op: authorization.prepared.operations,
        };
        const identity = this.documentProvenanceIdentity(doc._id, {
            bufferId: witness.token,
            canonicalEditorUri: witness.canonicalEditorUri,
        });
        if (!identity || identity.otType !== 'sharejs-text-ot') {
            this.blockDocumentWrite(
                uri,
                content,
                'the conditional write has no exact persistent document identity',
            );
        }
        const existingRecovery = await this.provenanceStore.recoverCold(
            identity,
            desiredContent,
        );
        if (existingRecovery.kind !== 'missing') {
            this.blockDocumentWrite(
                uri,
                content,
                existingRecovery.kind === 'valid' && existingRecovery.record.pendingWrite !== undefined
                    ? 'a previous conditional write has an unknown or unreconciled outcome'
                    : 'the conditional write has ambiguous or unresolved local recovery state',
            );
        }
        const bufferIncarnationId = `provider-${witness.token}`;
        let recoveryRecord: DocumentProvenanceRecord;
        try {
            recoveryRecord = await this.provenanceStore.createOrUpdateCurrent({
                identity,
                bufferIncarnationId,
                baseVersion: witness.version,
                baseText: witness.content,
                dirtyText: desiredContent,
            });
        } catch (error) {
            this.showDocumentRecovery(
                uri,
                content,
                `the conditional write recovery record could not be created: ${String(error)}`,
            );
            throw error;
        }
        const pending: PendingConditionalDocumentUpdate = {
            token: randomUUID(),
            resourceKey: witness.resourceKey,
            docId: doc._id,
            update,
            desiredContent,
            mergedContent,
            baseVersion: witness.version,
            baseContent: witness.content,
            publicId: sender.publicId,
            socketGeneration: sender.generation,
            inflightView: authorization.prepared.operations.map(operation => ({...operation})),
            identity,
            bufferIncarnationId,
            provenanceRecordName: recoveryRecord.recordName,
            durablePendingWrite: null,
        };
        pending.durablePendingWrite = this.conditionalPendingWritePayload(pending);
        try {
            await this.provenanceStore.markPendingWrite(
                pending.provenanceRecordName,
                pending.durablePendingWrite,
            );
        } catch (error) {
            this.showDocumentRecovery(
                uri,
                content,
                `the conditional write-ahead recovery record could not be persisted: ${String(error)}`,
            );
            throw error;
        }
        this.pendingReadTickets.delete(witness.resourceKey);
        vscode.workspace.textDocuments.forEach(document => {
            this.observeEditorBuffer(document);
        });
        const senderBeforeSend = this.currentSenderWitness();
        const editorAppeared = [...this.editorBuffers.values()].some(buffer =>
            buffer.docId === doc._id
            && vscode.workspace.textDocuments.includes(buffer.document)
            && !buffer.document.isClosed
        );
        if (editorAppeared
            || senderBeforeSend?.publicId !== sender.publicId
            || senderBeforeSend.generation !== sender.generation
            || !this.providerReadWitnessMatchesAuthority(
                witness,
                doc,
                sessionVersion,
                remoteContent,
            )) {
            try {
                await this.provenanceStore.clearRecord(pending.provenanceRecordName);
            } catch (error) {
                this.showDocumentRecovery(
                    uri,
                    content,
                    `the unsent conditional recovery record could not be cleared: ${String(error)}`,
                );
                throw error;
            }
            this.blockDocumentWrite(
                uri,
                content,
                editorAppeared
                    ? 'an editor opened this document before the conditional write could be sent'
                    : 'the conditional write authority changed before transport submission',
            );
        }
        this.pendingConditionalDocumentUpdates.set(doc._id, pending);
        this.markSourceDirty();
        let waiter: {promise: Promise<number>, cancel: () => void};
        try {
            waiter = this.waitForDocumentVersion(doc._id, sessionVersion);
        } catch (error) {
            if (this.pendingConditionalDocumentUpdates.get(doc._id) === pending) {
                this.pendingConditionalDocumentUpdates.delete(doc._id);
            }
            try {
                await this.provenanceStore.clearRecord(pending.provenanceRecordName);
            } catch (persistenceError) {
                this.showDocumentRecovery(
                    uri,
                    content,
                    `the unsent conditional recovery record could not be cleared: ${String(persistenceError)}`,
                );
                throw persistenceError;
            }
            throw error;
        }
        try {
            const [, confirmationVersion] = await Promise.all([
                this.socket.applyOtUpdate(doc._id, update, sender),
                waiter.promise,
            ]);
            pending.confirmationVersion = confirmationVersion;
        } catch (error) {
            waiter.cancel();
            const observedConfirmation = isNonnegativeSafeInteger(pending.confirmationVersion);
            const outcomeUnknown = observedConfirmation
                || !(error instanceof SocketRequestError)
                || error.outcomeUnknown;
            if (outcomeUnknown) {
                this.invalidateDocumentSession(
                    doc._id,
                    error instanceof Error ? error : new Error(String(error)),
                );
            } else {
                if (this.pendingConditionalDocumentUpdates.get(doc._id) === pending) {
                    this.pendingConditionalDocumentUpdates.delete(doc._id);
                }
                try {
                    await this.provenanceStore.clearRecord(pending.provenanceRecordName);
                } catch (persistenceError) {
                    this.showDocumentRecovery(
                        uri,
                        content,
                        `the rejected conditional write recovery record could not be cleared: ${String(persistenceError)}`,
                    );
                    throw persistenceError;
                }
            }
            this.showDocumentRecovery(
                uri,
                content,
                observedConfirmation
                    ? 'the conditional write was confirmed before its acknowledgement reported failure'
                    : outcomeUnknown
                        ? 'the conditional write outcome is unknown; read the document again after reconnecting'
                        : `the realtime server rejected the conditional write: ${String(error)}`,
            );
            if (observedConfirmation
                && error instanceof SocketRequestError
                && !error.outcomeUnknown) {
                throw new SocketRequestError(
                    'stale_connection',
                    `The conditional write was confirmed before a contradictory acknowledgement failure: ${String(error)}`,
                    true,
                    error,
                );
            }
            if (outcomeUnknown && !(error instanceof SocketRequestError)) {
                throw new SocketRequestError(
                    'stale_connection',
                    `The conditional document write outcome is unknown: ${String(error)}`,
                    true,
                    error,
                );
            }
            throw error;
        }
        const finalVersion = pending.confirmationVersion;
        if (this.pendingConditionalDocumentUpdates.get(doc._id) !== pending
            || !isNonnegativeSafeInteger(finalVersion)) {
            this.blockDocumentWrite(
                uri,
                content,
                'the conditional write was acknowledged without an exact sender confirmation',
            );
        }
        let authoritative: {doc: DocumentEntity, content: string};
        try {
            authoritative = await this.joinFreshDocumentSession(doc._id);
        } catch (error) {
            this.showDocumentRecovery(
                uri,
                content,
                'the confirmed conditional write could not be reconciled with a fresh remote snapshot',
            );
            throw error;
        }
        const authoritativeVersion = authoritative.doc.version;
        const authoritativeContent = authoritative.content;
        const ledger = this.remoteDocumentCausality.get(doc._id);
        if (!isNonnegativeSafeInteger(authoritativeVersion)
            || authoritativeVersion < finalVersion + 1
            || authoritative.doc.remoteCache !== authoritativeContent
            || !ledger?.valid
            || ledger.socketGeneration !== pending.socketGeneration
            || ledger.headVersion !== authoritativeVersion
            || ledger.headContent !== authoritativeContent) {
            this.blockDocumentWrite(
                uri,
                content,
                'the confirmed conditional write has no continuous authoritative reconciliation',
            );
        }
        try {
            await this.provenanceStore.reconcilePendingWrite(
                pending.provenanceRecordName,
                pending.durablePendingWrite,
                {
                    identity: pending.identity,
                    bufferIncarnationId: pending.bufferIncarnationId,
                    baseVersion: authoritativeVersion,
                    baseText: authoritativeContent,
                    dirtyText: authoritativeContent,
                },
            );
        } catch (error) {
            this.showDocumentRecovery(
                uri,
                content,
                `the confirmed conditional write could not clear its recovery marker: ${String(error)}`,
            );
            throw error;
        }
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const queued = this.remoteUpdateQueueMap().get(doc._id);
            if (!queued) { break; }
            await queued;
            if (this.remoteUpdateQueueMap().get(doc._id) === queued) { break; }
        }
        const finalLedger = this.remoteDocumentCausality.get(doc._id);
        const finalRemoteVersion = authoritative.doc.version;
        const finalRemoteContent = authoritative.doc.remoteCache;
        if (!isNonnegativeSafeInteger(finalRemoteVersion)
            || finalRemoteContent === undefined
            || !finalLedger?.valid
            || finalLedger.socketGeneration !== pending.socketGeneration
            || finalLedger.headVersion !== finalRemoteVersion
            || finalLedger.headContent !== finalRemoteContent) {
            await this.provenanceStore.markPendingWrite(
                pending.provenanceRecordName,
                pending.durablePendingWrite,
            );
            this.blockDocumentWrite(
                uri,
                content,
                'the confirmed conditional write lost its continuous realtime ledger',
            );
        }
        try {
            await this.provenanceStore.clearRecord(pending.provenanceRecordName);
        } catch (error) {
            this.showDocumentRecovery(
                uri,
                content,
                `the reconciled conditional recovery record could not be retired: ${String(error)}`,
            );
            throw error;
        }
        if (this.pendingConditionalDocumentUpdates.get(doc._id) === pending) {
            this.pendingConditionalDocumentUpdates.delete(doc._id);
        }
        authoritative.doc.localCache = finalRemoteContent;
        authoritative.doc.lastVersion = update.v;
        this.notify([{type: vscode.FileChangeType.Changed, uri}]);
    }

    private async restoreConditionalPendingRecovery(
        pending: PendingConditionalDocumentUpdate,
    ): Promise<void> {
        const restored = await this.provenanceStore.createOrUpdateCurrent({
            identity: pending.identity,
            bufferIncarnationId: pending.bufferIncarnationId,
            baseVersion: pending.baseVersion,
            baseText: pending.baseContent,
            dirtyText: pending.desiredContent,
        });
        if (restored.recordName !== pending.provenanceRecordName) {
            throw new Error('The conditional recovery record identity changed while restoring it');
        }
        await this.provenanceStore.markPendingWrite(
            pending.provenanceRecordName,
            pending.durablePendingWrite,
        );
    }

    private conditionalRemoteAcceptanceMatches(
        acceptance: ConditionalRemoteAcceptanceWitness | undefined,
        pending: PendingConditionalDocumentUpdate,
        uri: vscode.Uri,
        desiredContent: string,
        doc: DocumentEntity,
        version: number,
        authoritativeContent: string,
    ): acceptance is ConditionalRemoteAcceptanceWitness {
        if (!acceptance) { return false; }
        const sender = this.currentSenderWitness();
        const ledger = this.remoteDocumentCausality.get(doc._id);
        const buffer = this.editorBuffers.get(acceptance.bufferId);
        const intent = this.editorSaveIntents.get(acceptance.bufferId);
        const staged = this.stagedEditorBases.get(acceptance.resourceKey);
        return this.conditionalRemoteAcceptances.get(doc._id) === acceptance
            && acceptance.pendingToken === pending.token
            && acceptance.provenanceRecordName === pending.provenanceRecordName
            && acceptance.resourceKey === this.resourceKey(uri)
            && acceptance.resourceKey === pending.resourceKey
            && acceptance.docId === doc._id
            && acceptance.document === this.exactOpenDocument(uri)
            && acceptance.document.isDirty
            && acceptance.document.getText() === desiredContent
            && buffer?.document === acceptance.document
            && buffer.docId === doc._id
            && buffer.resourceKey === acceptance.resourceKey
            && buffer.bufferId === acceptance.bufferId
            && this.bufferMatchesIncarnation(buffer)
            && intent?.document === acceptance.document
            && intent.bufferId === acceptance.bufferId
            && intent.docId === doc._id
            && intent.documentVersion === acceptance.document.version
            && intent.content === desiredContent
            && this.bufferMatchesWitness(intent)
            && staged?.docId === doc._id
            && staged.canonicalEditorUri === buffer.canonicalEditorUri
            && staged.version === acceptance.version
            && staged.content === acceptance.content
            && desiredContent === acceptance.content
            && acceptance.version === version
            && acceptance.content === authoritativeContent
            && sender?.publicId === acceptance.publicId
            && sender.generation === acceptance.socketGeneration
            && sender.generation !== pending.socketGeneration
            && ledger?.valid === true
            && ledger.socketGeneration === acceptance.socketGeneration
            && ledger.epoch === acceptance.remoteEpoch
            && ledger.headVersion === version
            && ledger.headContent === authoritativeContent
            && this.documentMatchesAuthority(doc, version, authoritativeContent);
    }

    private async reconcileConditionalProviderOutcome(
        uri: vscode.Uri,
        content: Uint8Array,
        desiredContent: string,
        doc: DocumentEntity,
    ): Promise<boolean> {
        const pending = this.pendingConditionalDocumentUpdates.get(doc._id);
        if (!pending) { return false; }
        const authoritative = await this.ensureDocumentSession(doc._id);
        const version = authoritative.doc.version;
        if (!isNonnegativeSafeInteger(version)) {
            this.blockDocumentWrite(
                uri,
                content,
                'the outcome-unknown provider write has no authoritative revision',
            );
        }
        const ledger = this.remoteDocumentCausality.get(doc._id);
        const sender = this.currentSenderWitness();
        const acceptance = this.conditionalRemoteAcceptances.get(doc._id);
        const exactAppliedOutcome = authoritative.doc === doc
            && isNonnegativeSafeInteger(version)
            && version >= pending.update.v + 1
            && authoritative.content === pending.mergedContent
            && sender !== undefined
            && sender.generation !== pending.socketGeneration
            && ledger?.valid === true
            && ledger.socketGeneration === sender.generation
            && ledger.headVersion === version
            && ledger.headContent === authoritative.content
            && this.documentMatchesAuthority(doc, version, authoritative.content);
        const explicitRemoteAcceptance = this.conditionalRemoteAcceptanceMatches(
            acceptance,
            pending,
            uri,
            desiredContent,
            doc,
            version,
            authoritative.content,
        );
        if (!exactAppliedOutcome && !explicitRemoteAcceptance) {
            this.blockDocumentWrite(
                uri,
                content,
                'the outcome-unknown provider write is not exactly present in the authoritative text',
            );
        }
        const recovered = await this.provenanceStore.resolveCurrentRecord(
            pending.provenanceRecordName,
            {
                identity: pending.identity,
                bufferIncarnationId: pending.bufferIncarnationId,
                baseVersion: pending.baseVersion,
                baseText: pending.baseContent,
                dirtyText: pending.desiredContent,
            },
        );
        if (recovered.kind !== 'valid'
            || JSON.stringify(recovered.record.pendingWrite)
                !== JSON.stringify(pending.durablePendingWrite)) {
            this.blockDocumentWrite(
                uri,
                content,
                'the outcome-unknown provider recovery record is missing or changed',
            );
        }
        await this.provenanceStore.reconcilePendingWrite(
            pending.provenanceRecordName,
            pending.durablePendingWrite,
            {
                identity: pending.identity,
                bufferIncarnationId: pending.bufferIncarnationId,
                baseVersion: version,
                baseText: authoritative.content,
                dirtyText: authoritative.content,
            },
        );
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const queued = this.remoteUpdateQueueMap().get(doc._id);
            if (!queued) { break; }
            await queued;
            if (this.remoteUpdateQueueMap().get(doc._id) === queued) { break; }
        }
        const finalVersion = doc.version;
        const finalContent = doc.remoteCache;
        const finalLedger = this.remoteDocumentCausality.get(doc._id);
        const finalSender = this.currentSenderWitness();
        const exactAppliedStillCurrent = exactAppliedOutcome
            && this.pendingConditionalDocumentUpdates.get(doc._id) === pending
            && isNonnegativeSafeInteger(finalVersion)
            && finalVersion >= pending.update.v + 1
            && finalContent === pending.mergedContent
            && finalSender !== undefined
            && finalSender.generation !== pending.socketGeneration
            && finalLedger?.valid === true
            && finalLedger.socketGeneration === finalSender.generation
            && finalLedger.headVersion === finalVersion
            && finalLedger.headContent === finalContent
            && this.documentMatchesAuthority(doc, finalVersion, finalContent);
        const acceptanceStillCurrent = explicitRemoteAcceptance
            && finalVersion === version
            && finalContent === authoritative.content
            && this.conditionalRemoteAcceptanceMatches(
                acceptance,
                pending,
                uri,
                desiredContent,
                doc,
                version,
                authoritative.content,
            );
        if (!exactAppliedStillCurrent && !acceptanceStillCurrent) {
            try {
                await this.restoreConditionalPendingRecovery(pending);
            } catch (error) {
                this.showDocumentRecovery(
                    uri,
                    content,
                    `the conditional recovery record could not be restored: ${String(error)}`,
                );
                throw error;
            }
            this.blockDocumentWrite(
                uri,
                content,
                'the remote document changed while its outcome was being reconciled',
            );
        }
        await this.provenanceStore.clearRecord(pending.provenanceRecordName);
        const postClearVersion = doc.version;
        const postClearContent = doc.remoteCache;
        const postClearLedger = this.remoteDocumentCausality.get(doc._id);
        const postClearSender = this.currentSenderWitness();
        const exactAppliedAfterClear = exactAppliedStillCurrent
            && this.pendingConditionalDocumentUpdates.get(doc._id) === pending
            && postClearVersion === finalVersion
            && postClearContent === finalContent
            && postClearSender?.publicId === finalSender?.publicId
            && postClearSender?.generation === finalSender?.generation
            && postClearLedger?.valid === true
            && postClearLedger.socketGeneration === postClearSender?.generation
            && postClearLedger.headVersion === postClearVersion
            && postClearLedger.headContent === postClearContent
            && isNonnegativeSafeInteger(postClearVersion)
            && this.documentMatchesAuthority(doc, postClearVersion, postClearContent);
        const acceptanceAfterClear = acceptanceStillCurrent
            && postClearVersion === version
            && postClearContent === authoritative.content
            && this.conditionalRemoteAcceptanceMatches(
                acceptance,
                pending,
                uri,
                desiredContent,
                doc,
                version,
                authoritative.content,
            );
        if (!exactAppliedAfterClear && !acceptanceAfterClear) {
            try {
                await this.restoreConditionalPendingRecovery(pending);
            } catch (error) {
                this.showDocumentRecovery(
                    uri,
                    content,
                    `the conditional recovery record could not be restored after retirement raced the remote head: ${String(error)}`,
                );
                throw error;
            }
            this.blockDocumentWrite(
                uri,
                content,
                'the remote document changed while its recovery record was being retired',
            );
        }
        if (this.pendingConditionalDocumentUpdates.get(doc._id) === pending) {
            this.pendingConditionalDocumentUpdates.delete(doc._id);
        }
        doc.localCache = postClearContent;
        if (acceptanceAfterClear) {
            this.conditionalRemoteAcceptances.delete(doc._id);
            this.editorSaveIntents.delete(acceptance.bufferId);
            this.unboundEditorSaveIntents.delete(acceptance.document);
            this.editorSaveReceipts.set(acceptance.bufferId, {
                document: acceptance.document,
                identity: pending.identity,
                bufferId: acceptance.bufferId,
                version,
                content: authoritative.content,
            });
            return true;
        }
        return desiredContent === postClearContent;
    }

    private async writeFileNow(
        uri: vscode.Uri,
        content: Uint8Array,
        create: boolean,
        _overwrite: boolean,
        liveBufferId?: string,
        liveSnapshot?: LiveEditorWriteSnapshot,
    ) {
        let desiredContent: string;
        try {
            desiredContent = new TextDecoder('utf-8', {
                fatal: true,
                ignoreBOM: true,
            }).decode(content);
        } catch {
            this.blockDocumentWrite(uri, content, 'document bytes are not valid UTF-8');
        }
        if (this.matchesUnboundEditorSave(uri, desiredContent)) {
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
            const _content = desiredContent;
            await this.remoteUpdateQueueMap().get(docId);
            if (liveBufferId !== undefined
                && liveSnapshot?.bufferId === liveBufferId
                && this.liveEditorSnapshotWasProvenAdvanced(
                    fileEntity as DocumentEntity,
                    liveSnapshot,
                )) {
                throw new StaleLiveEditorSnapshotError();
            }
            if (this.isInvisibleMode) {
                this.blockDocumentWrite(
                    uri,
                    content,
                    'Invisible Mode cannot prove a revision-bound document write',
                );
            }
            if (await this.reconcileConditionalProviderOutcome(
                uri,
                content,
                _content,
                fileEntity as DocumentEntity,
            )) {
                return;
            }
            const bufferResolution = this.resolveWritingBuffer(
                uri,
                docId,
                _content,
                liveBufferId === undefined,
            );
            if (bufferResolution.kind === 'superseded') {
                return;
            }
            if (bufferResolution.kind === 'blocked') {
                const conditional = this.claimProviderReadWitness(uri, docId);
                if (conditional.kind === 'valid') {
                    return this.writeConditionalProviderDocument(
                        uri,
                        content,
                        _content,
                        fileEntity as DocumentEntity,
                        conditional.witness,
                    );
                }
                this.blockDocumentWrite(
                    uri,
                    content,
                    `${bufferResolution.reason}; ${conditional.reason}`,
                );
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
            if (liveBufferId !== undefined && liveSnapshot?.bufferId === liveBufferId
                && this.liveEditorSnapshotWasProvenAdvanced(doc, liveSnapshot)) {
                throw new StaleLiveEditorSnapshotError();
            }
            if (!this.documentMatchesAuthority(doc, sessionVersion, remoteContent)
                || !this.bufferMatchesWitness(witness)) {
                this.blockDocumentWrite(
                    uri,
                    content,
                    'the remote document changed while its provenance was being checked',
                );
            }
            if (doc.otType === 'history-ot') {
                if (provenance.kind === 'blocked') {
                    this.blockDocumentWrite(uri, content, provenance.reason);
                }
                return this.writeHistoryOtDocument(
                    uri,
                    content,
                    _content,
                    doc,
                    remoteContent,
                    sessionVersion,
                    witness,
                    provenance.value,
                    liveSnapshot,
                );
            }
            if (doc.otType !== 'sharejs-text-ot') {
                this.blockDocumentWrite(
                    uri,
                    content,
                    'the joined document did not prove a supported realtime protocol',
                );
            }
            if (this.permissionsLevel === 'review') {
                this.blockDocumentWrite(
                    uri,
                    content,
                    'review permission requires a History OT tracked write',
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
                    'unsupported-text': 'Overleaf cannot store NUL or non-BMP characters (such as emoji); the changes were not sent',
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
                if (liveBufferId !== undefined && liveSnapshot?.bufferId === liveBufferId
                    && this.liveEditorSnapshotWasProvenAdvanced(doc, liveSnapshot)) {
                    throw new StaleLiveEditorSnapshotError();
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
                const observedConfirmation = isNonnegativeSafeInteger(pending.confirmationVersion);
                const outcomeUnknown = observedConfirmation
                    || !(error instanceof SocketRequestError)
                    || error.outcomeUnknown;
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
                    if (this.pendingDocumentUpdates.get(witness.bufferId) === pending) {
                        this.pendingDocumentUpdates.delete(witness.bufferId);
                    }
                }
                this.showDocumentRecovery(
                    uri,
                    content,
                    observedConfirmation
                        ? 'the write was confirmed before its acknowledgement reported failure'
                        : outcomeUnknown
                            ? 'the server may have applied the write; retry requires a fresh deduplicated sender identity'
                            : `the realtime server rejected the write: ${String(error)}`,
                );
                if (observedConfirmation
                    && error instanceof SocketRequestError
                    && !error.outcomeUnknown) {
                    throw new SocketRequestError(
                        'stale_connection',
                        `The document write was confirmed before a contradictory acknowledgement failure: ${String(error)}`,
                        true,
                        error,
                    );
                }
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
                // Commit the causal witness before publishing the new identity.
                // A later output-tree failure must still prevent the manager
                // from re-enabling a PDF from the preceding build.
                this.synctexOutputIdentityGeneration += 1;
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

    async syncCode(filePath: string, line:number, column:number, reportErrors = true) {
        if (!this.outputBuildId || !this.outputEditorId) {
            if (reportErrors) {
                vscode.window.showErrorMessage(vscode.l10n.t('SyncTeX is unavailable until the PDF has been compiled successfully.'));
            }
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
            if (reportErrors && res.message!==undefined) {
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

    async getTrackChangesPresentation(
        uri: vscode.Uri,
    ): Promise<RealtimeHistoryOtPresentationModel | undefined> {
        const {fileType, fileEntity} = await this._resolveUri(uri);
        if (fileType !== 'doc' || !fileEntity) { return undefined; }
        const joined = await this.ensureDocumentSession(fileEntity._id);
        if (joined.doc.otType !== 'history-ot') { return undefined; }
        await Promise.all([this.ensureCommentThreads(), this.ensureChangesUsers()]);
        this.refreshHistoryOtRuntime(joined.doc);
        return joined.doc.historyOtPresentation;
    }

    async getTrackChangesContext(uri: vscode.Uri) {
        const presentation = await this.getTrackChangesPresentation(uri);
        if (!presentation) { return undefined; }
        const {fileType, fileEntity} = await this._resolveUri(uri);
        const version = fileType === 'doc' && fileEntity
            ? (fileEntity as DocumentEntity).version : undefined;
        if (!isNonnegativeSafeInteger(version)) {
            throw new Error('Track Changes context has no authoritative document version');
        }
        return {presentation, permissionsLevel: this.permissionsLevel, userId: this.userId, version};
    }

    getHistoryOtThreadEventLog(): HistoryOtRawThreadEventLog {
        return deepCloneJson(this.historyOtThreadEvents) as unknown as HistoryOtRawThreadEventLog;
    }

    async applyTrackChangesDecision(
        _uri: vscode.Uri,
        _decision: 'accept' | 'reject',
        _request: unknown,
    ): Promise<void> {
        throw vscode.FileSystemError.Unavailable(
            'Tracked-change decisions require a separately witnessed History OT selection bridge',
        );
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

    getTrackChangesPresentation(uri: vscode.Uri) {
        return this.getVFS(uri).then(vfs => vfs.getTrackChangesPresentation(uri));
    }

    getTrackChangesContext(uri: vscode.Uri) {
        return this.getVFS(uri).then(vfs => vfs.getTrackChangesContext(uri));
    }

    applyTrackChangesDecision(
        uri: vscode.Uri,
        decision: 'accept' | 'reject',
        request: unknown,
    ) {
        return this.getVFS(uri).then(vfs =>
            vfs.applyTrackChangesDecision(uri, decision, request));
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
                // Save participants have a short host deadline. Record the
                // exact intent synchronously here; the provider write itself
                // owns the causal OT flush and acknowledgement wait.
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
