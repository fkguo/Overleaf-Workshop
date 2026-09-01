/* eslint-disable @typescript-eslint/naming-convention */
import * as vscode from 'vscode';
import { BaseAPI, CompileOutputFileSchema, MemberEntity, ProjectSettingsSchema } from '../api/base';
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
    buildRecoveryUpdate,
    desiredChangesArePresent,
    isSenderConfirmation,
    prepareProvenDocumentUpdate,
} from './documentUpdate';
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
    resolve: () => void,
    reject: (error: Error) => void,
    timer: NodeJS.Timeout,
};

type ReceivedDocumentUpdate = {
    update: UpdateSchema,
    sender?: ProjectSenderWitness,
};

type PendingDocumentUpdate = {
    docId: string,
    bufferId: string,
    provenanceRecordName: string,
    provenanceRecordsToClear: string[],
    update: UpdateSchema,
    desiredContent: string,
    mergedContent: string,
    baseVersion: number,
    baseContent: string,
    submittedPublicIds: string[],
    socketGeneration: number,
};

type StagedEditorBase = {
    docId: string,
    canonicalEditorUri: string,
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
    private documentJoinTasks = new Map<string, Promise<{doc: DocumentEntity, content: string}>>();
    private joiningDocuments = new Map<string, {generation: number, updates: ReceivedDocumentUpdate[]}>();
    private documentVersionWaiters = new Map<string, Set<DocumentVersionWaiter>>();
    private pendingDocumentUpdates = new Map<string, PendingDocumentUpdate>();
    private stagedEditorBases = new Map<string, StagedEditorBase>();
    private activeEditorBases = new Map<string, EditorDocumentBase>();
    private documentIdsByPath = new Map<string, string>();
    private editorBufferIds = new WeakMap<vscode.TextDocument, string>();
    private editorBuffers = new Map<string, EditorBufferState>();
    private editorSaveIntents = new Map<string, EditorBufferWitness>();
    private unboundEditorSaveIntents = new WeakMap<vscode.TextDocument, UnboundEditorSaveIntent>();
    private editorSaveReceipts = new Map<string, EditorSaveReceipt>();
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
        this.documentIdsByPath.set(resourceKey, doc._id);
        if (doc.version === undefined) {
            this.stagedEditorBases.delete(resourceKey);
            return;
        }
        this.stagedEditorBases.set(resourceKey, {
            docId: doc._id,
            canonicalEditorUri: this.canonicalEditorUri(doc._id),
            version: doc.version,
            content,
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
        const docId = staged?.docId
            ?? this.documentIdsByPath.get(resourceKey)
            ?? this.cachedDocumentIdForUri(document.uri);
        if (!docId) { return undefined; }
        this.documentIdsByPath.set(resourceKey, docId);
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

    /** A clean open remains quarantined until an explicit confirmed reload or save. */
    observeTextDocument(document: vscode.TextDocument) {
        const buffer = this.observeEditorBuffer(document);
        if (!buffer) { return; }
        if (!document.isDirty) {
            const receipt = this.editorSaveReceipts.get(buffer.bufferId);
            if (receipt
                && receipt.document === document
                && receipt.content === document.getText()
                && receipt.identity.canonicalEditorUri === buffer.canonicalEditorUri) {
                this.activeEditorBases.set(buffer.bufferId, {
                    identity: receipt.identity,
                    bufferId: buffer.bufferId,
                    version: receipt.version,
                    content: receipt.content,
                });
                this.editorSaveReceipts.delete(buffer.bufferId);
            }
            return;
        }

        const active = this.activeEditorBases.get(buffer.bufferId);
        if (!active) { return; }
        if (this.pendingDocumentUpdates.has(buffer.bufferId)) {
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
            if (this.activeEditorBases.get(buffer.bufferId) === active) {
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

    forgetTextDocument(document: vscode.TextDocument) {
        const bufferId = this.editorBufferIds.get(document);
        if (!bufferId) { return; }
        this.editorBuffers.delete(bufferId);
        this.activeEditorBases.delete(bufferId);
        this.editorSaveIntents.delete(bufferId);
        this.unboundEditorSaveIntents.delete(document);
        this.editorSaveReceipts.delete(bufferId);
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
        });
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
        const exact = [...this.editorSaveIntents.values()].filter(intent =>
            intent.canonicalEditorUri === canonicalEditorUri
            && intent.resourceKey === resourceKey
            && openDocuments.has(intent.document)
        );
        if (exact.length !== 1) {
            return {
                kind: 'blocked',
                reason: exact.length === 0 ?
                    'no unique observed dirty editor buffer matches this save' :
                    'the editor URI resolves to multiple dirty buffer incarnations',
            };
        }
        const witness = exact[0];
        this.editorSaveIntents.delete(witness.bufferId);
        if (witness.docId !== docId
            || witness.content !== desiredContent
            || !this.bufferMatchesWitness(witness)) {
            return {kind: 'blocked', reason: 'the editor buffer changed before save authorization'};
        }
        return {kind: 'valid', witness};
    }

    private bufferMatchesWitness(witness: EditorBufferWitness): boolean {
        return this.editorBufferIds.get(witness.document) === witness.bufferId
            && vscode.workspace.textDocuments.includes(witness.document)
            && !witness.document.isClosed
            && witness.document.uri.toString() === witness.resourceKey
            && witness.document.version === witness.documentVersion
            && witness.document.getText() === witness.content;
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

    private async clearProvenanceRecords(recordNames: string[]) {
        for (const recordName of [...new Set(recordNames)]) {
            await this.provenanceStore.clearRecord(recordName);
        }
    }

    private documentMatchesAuthority(
        doc: DocumentEntity,
        expectedVersion: number,
        expectedContent: string,
    ): boolean {
        try {
            return this.currentDocument(doc._id) === doc
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
            || !this.bufferMatchesWitness(witness)) {
            throw new Error('The remote document moved before its editor base could be committed');
        }
        const identity = authoritativeContent === witness.content ?
            this.documentProvenanceIdentity(doc._id, witness) : undefined;
        if (authoritativeContent === witness.content && !identity) {
            throw new Error('The confirmed sender identity changed before accepting the editor base');
        }

        // Commit the already-authoritative snapshot before storage I/O yields.
        // A later realtime revision does not invalidate this snapshot as a
        // common ancestor, and must not make us discard the exact recovery
        // evidence after it has already been cleared.
        doc.localCache = authoritativeContent;
        this.stageEditorBase(witness.document.uri, doc, authoritativeContent);
        if (identity) {
            this.activeEditorBases.set(witness.bufferId, {
                identity,
                bufferId: witness.bufferId,
                version: expectedVersion,
                content: authoritativeContent,
            });
            this.editorSaveReceipts.set(witness.bufferId, {
                document: witness.document,
                identity,
                bufferId: witness.bufferId,
                version: expectedVersion,
                content: authoritativeContent,
            });
        } else {
            this.activeEditorBases.delete(witness.bufferId);
            this.editorSaveReceipts.delete(witness.bufferId);
        }
        await this.clearProvenanceRecords(recordsToClear);
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
                const blockedVersion = document.version;
                const blockedText = document.getText();
                const editor = await vscode.window.showTextDocument(document, {preserveFocus: false});
                const authoritativeText = new TextDecoder().decode(await this.openFile(uri));
                const editTarget = stillOriginalDocument();
                if (!editTarget
                    || editTarget !== document
                    || editor.document !== document
                    || document.version !== blockedVersion
                    || document.getText() !== blockedText) {
                    void vscode.window.showErrorMessage(
                        vscode.l10n.t('The blocked editor changed before reload; no text was replaced.'),
                    );
                    return;
                }
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
        this.documentMap(project).forEach((doc) => {
            doc.version = undefined;
            doc.remoteCache = undefined;
            doc.lastVersion = undefined;
            this.rejectDocumentVersionWaiters(doc._id, new Error('Document session disconnected'));
        });
    }

    private invalidateDocumentSession(docId: string, error: Error) {
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
        const rejection = new SocketRequestError(
            'server_error',
            `Overleaf rejected a document update: ${error.message}`,
            false,
            error.details,
        );
        if (error.docId) {
            for (const [bufferId, pending] of this.pendingDocumentUpdates) {
                if (pending.docId === error.docId) {
                    this.pendingDocumentUpdates.delete(bufferId);
                }
            }
            this.invalidateDocumentSession(error.docId, rejection);
            return;
        }
        this.pendingDocumentUpdates.clear();
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
        let waiter!: DocumentVersionWaiter;
        const promise = new Promise<void>((resolve, reject) => {
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
                waiter.resolve();
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

    private applyDocumentUpdate(update: UpdateSchema, eventSender?: ProjectSenderWitness) {
        const res = this._resolveById(update.doc);
        if (res===undefined) { return; }

        const doc = res.fileEntity as DocumentEntity;
        const senderConfirmation = isSenderConfirmation(update);
        if (senderConfirmation) {
            const sender = this.currentSenderWitness();
            const matchingPending = [...this.pendingDocumentUpdates.values()].filter(pending =>
                pending.docId === update.doc
                && pending.update.v === update.v
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
            }
            return;
        }
        if (update.v > doc.version) {
            doc.remoteCache = undefined;
            doc.version = undefined;
            doc.lastVersion = undefined;
            this.rejectDocumentVersionWaiters(doc._id, new Error('Document version changed unexpectedly'));
            return;
        }

        doc.version += 1;
        if (update.op && doc.remoteCache!==undefined) {
            let content = doc.remoteCache;
            update.op.forEach((op) => {
                if (op.i) {
                    content = content.slice(0, op.p) + op.i + content.slice(op.p);
                } else if (op.d) {
                    const deleteUtf8 = Buffer.from(op.d, 'ascii').toString('utf-8');
                    content = content.slice(0, op.p) + content.slice(op.p+deleteUtf8.length);
                }
            });
            const _uri = this.pathToUri(res.path).toString();
            const _doc = vscode.workspace.textDocuments.find((doc) => doc.uri.toString()===_uri);
            // if doc dirty, local cache should diverge from remote cache
            if (_doc && !_doc.isDirty) {doc.localCache = content;}
            doc.remoteCache = content;
            this.markSourceDirty();
            this.notify([
                {type: vscode.FileChangeType.Changed, uri: this.pathToUri(res.path)}
            ]);
        }
        if (senderConfirmation) {
            this.resolveDocumentVersionWaiters(doc._id, update.v);
        }
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
                const joining = this.joiningDocuments.get(update.doc);
                if (joining && joining.generation === this.socket.generation) {
                    joining.updates.push({update, sender});
                    return;
                }
                this.applyDocumentUpdate(update, sender);
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
                this.stageEditorBase(uri, doc, content);
                EventBus.fire('fileWillOpenEvent', {uri});
                return new TextEncoder().encode(content);
            } else {
                const {doc: joinedDoc, content} = await this.ensureDocumentSession(doc._id);
                this.stageEditorBase(uri, joinedDoc, content);
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

    async createFile(uri: vscode.Uri, content:Uint8Array, overwrite?:boolean) {
        await this.assertProjectWritable('Unable to create file');
        const {parentFolder, fileName, fileEntity} = await this._resolveUri(uri);
        if (fileEntity) {
            if (!overwrite) {
                throw vscode.FileSystemError.FileExists(uri);
            }
            throw this.mutationError(
                `Unable to overwrite ${fileName}`,
                'Safe overwrite is not supported for remote file uploads',
            );
        }

        const parentFolderId = parentFolder._id;
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        if (content.length===0) {
            const response = await this.api.addDoc(identity, this.projectId, parentFolderId, fileName);
            if (response.type !== 'success') {
                if (await this.cachedFileMatches(uri, parentFolderId, fileName, ['doc'], content)) { return; }
                throw this.mutationError(`Unable to create ${fileName}`, response.message);
            }
            if (!this.isCreatedEntity(response.entity, ['doc'])) {
                throw this.mutationError(`Unable to create ${fileName}`, 'The server returned no document');
            }
            const liveParent = await this.currentFolder(parentFolderId, `Unable to create ${fileName}`);
            const alreadyCached = Boolean(this.resolveCachedEntity(response.entity._id));
            this.insertEntity(liveParent, response.entity._type, response.entity);
            if (alreadyCached) { return; }
        } else {
            const response = await this.api.uploadFile(
                identity,
                this.projectId,
                parentFolderId,
                fileName,
                content,
            );
            if (response.type !== 'success') {
                if (await this.cachedFileMatches(
                    uri,
                    parentFolderId,
                    fileName,
                    ['doc', 'file'],
                    content,
                )) { return; }
                throw this.mutationError(`Unable to upload ${fileName}`, response.message);
            }
            if (!this.isCreatedEntity(response.entity, ['doc', 'file'])) {
                throw this.mutationError(`Unable to upload ${fileName}`, 'The server returned no file');
            }
            const liveParent = await this.currentFolder(parentFolderId, `Unable to upload ${fileName}`);
            const alreadyCached = Boolean(this.resolveCachedEntity(response.entity._id));
            this.insertEntity(liveParent, response.entity._type, response.entity);
            if (alreadyCached) { return; }
        }
        this.notify([
            {type: vscode.FileChangeType.Created, uri: uri},
        ]);
        this.markSourceDirty();
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
        // session for the current socket generation and supplies its authoritative
        // version/content.
        await this.init();
        const connectionGeneration = await this.socket.waitUntilConnected();
        const joining = {generation: connectionGeneration, updates: [] as ReceivedDocumentUpdate[]};
        this.joiningDocuments.set(docId, joining);
        try {
            const res = await this.socket.joinDoc(docId);
            assertCurrentConnection(
                connectionGeneration,
                this.socket.generation,
                this.socket.isConnected,
            );
            // The project tree may have been replaced while the async join was in
            // progress. Commit session state only to the current entity generation.
            const doc = this.currentDocument(docId);
            const remoteContent = res.docLines.join('\n');
            doc.version = res.version;
            doc.remoteCache = remoteContent;
            doc.lastVersion = undefined;

            const responseUpdates = res.updates.filter((update: any) =>
                update && typeof update.v === 'number' && (update.op === undefined || Array.isArray(update.op)),
            ).map((update: UpdateSchema): ReceivedDocumentUpdate => ({
                update: {...update, doc: update.doc || docId},
            }));
            [...responseUpdates, ...joining.updates]
                .sort((left, right) => left.update.v - right.update.v)
                .forEach(received => this.applyDocumentUpdate(received.update, received.sender));

            const current = this.currentDocument(docId);
            if (current.version === undefined || current.remoteCache === undefined) {
                throw new Error('Document updates could not be reconciled with the join snapshot');
            }
            return {doc: current, content: current.remoteCache};
        } finally {
            if (this.joiningDocuments.get(docId) === joining) {
                this.joiningDocuments.delete(docId);
            }
        }
    }

    private async ensureDocumentSession(docId: string): Promise<{doc: DocumentEntity, content: string}> {
        await this.init();
        const doc = this.currentDocument(docId);
        if (doc.version !== undefined && doc.remoteCache !== undefined) {
            return {doc, content: doc.remoteCache};
        }
        return this.joinFreshDocumentSession(docId);
    }

    async writeFile(uri: vscode.Uri, content:Uint8Array, create:boolean, overwrite:boolean) {
        await this.assertProjectWritable('Unable to write file');
        const resolved = await this._resolveUri(uri);
        const key = resolved.fileType === 'doc' && resolved.fileEntity ?
            `doc:${resolved.fileEntity._id}` :
            `path:${this.projectId}:${parseUri(uri).pathParts.join('/')}`;
        const previous = this.documentWrites.get(key) ?? Promise.resolve();
        const operation = previous.catch(() => {}).then(
            () => this.writeFileNow(uri, content, create, overwrite),
        ).catch((error) => {
            if (error instanceof SocketRequestError && error.outcomeUnknown) {
                this.forceFreshConnection();
            }
            throw error;
        });
        this.documentWrites.set(key, operation);
        try {
            await operation;
        } finally {
            if (this.documentWrites.get(key) === operation) {
                this.documentWrites.delete(key);
            }
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
            || pending.bufferId !== witness.bufferId
            || pending.desiredContent !== desiredContent) {
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

        await this.ensureDocumentSession(docId);
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
        if (this.publicId !== retryPublicId
            || this.socket.generation !== retryGeneration
            || !this.socket.isConnected
            || this.pendingDocumentUpdates.get(witness.bufferId) !== pending
            || !this.bufferMatchesWitness(witness)) {
            await this.provenanceStore.markPendingWrite(
                pending.provenanceRecordName,
                this.pendingWritePayload(pending),
            );
            this.blockDocumentWrite(
                uri,
                content,
                'the realtime identity changed before the pending operation could be retried',
            );
        }
        this.pendingDocumentUpdates.set(witness.bufferId, retryPending);

        const versionWaiter = this.waitForDocumentVersion(docId, pending.update.v);
        try {
            await Promise.all([
                this.socket.applyOtUpdate(docId, retryUpdate, {
                    publicId: retryPublicId,
                    generation: retryGeneration,
                }),
                versionWaiter.promise,
            ]);
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
        if (!desiredChangesArePresent(
            pending.baseContent,
            authoritative.content,
            pending.desiredContent,
        )) {
            await this.provenanceStore.markPendingWrite(
                retryPending.provenanceRecordName,
                this.pendingWritePayload(retryPending, 'acknowledged-remote-diverged', {
                    authoritativeVersion: authoritative.doc.version ?? -1,
                }),
            );
            this.pendingDocumentUpdates.delete(witness.bufferId);
            this.blockDocumentWrite(
                uri,
                content,
                'the confirmed retry is no longer present in the authoritative document',
            );
        }
        const authoritativeVersion = authoritative.doc.version;
        if (authoritativeVersion === undefined) {
            this.blockDocumentWrite(
                uri,
                content,
                'the confirmed retry returned without an authoritative revision',
            );
        }
        await this.acceptEditorBase(
            witness,
            authoritative.doc,
            authoritativeVersion,
            authoritative.content,
            retryPending.provenanceRecordsToClear,
        );
        this.pendingDocumentUpdates.delete(witness.bufferId);
        setTimeout(() => {
            this.notify([{type: vscode.FileChangeType.Changed, uri}]);
        }, 10);
        authoritative.doc.lastVersion = pending.update.v;
        return true;
    }

    private async writeFileNow(uri: vscode.Uri, content:Uint8Array, create:boolean, overwrite:boolean) {
        const {fileType, fileEntity} = await this._resolveUri(uri);

        // if non-exists --> create it
        if (!fileType && create) {
            this.blockDocumentWrite(
                uri,
                content,
                'the remote path is missing and an editor save cannot be distinguished from a stale deleted or renamed document',
            );
        }

        // if exists but not doc --> create new
        if (fileType && fileType!=='doc' && create) {
            return this.createFile(uri, content, overwrite);
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
            if (sessionVersion === undefined) {
                this.blockDocumentWrite(uri, content, 'the joined document revision is unknown');
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
            );

            if (authorization.status === 'noop') {
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
                    'merge-conflict': 'remote and local edits overlap relative to the exact editor base',
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
                provenanceRecordsToClear: provenance.value.recordsToClear,
                update,
                desiredContent: _content,
                mergedContent: mergeRes,
                baseVersion: provenance.value.record.baseVersion,
                baseContent: provenance.value.record.baseText,
                submittedPublicIds: [sender.publicId],
                socketGeneration: sender.generation,
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
            this.pendingDocumentUpdates.set(witness.bufferId, pending);
            this.markSourceDirty();

            const sentVersion = sessionVersion;
            const versionWaiter = this.waitForDocumentVersion(doc._id, sentVersion);
            try {
                await Promise.all([
                    this.socket.applyOtUpdate(doc._id, update, sender),
                    versionWaiter.promise,
                ]);
            } catch (error) {
                versionWaiter.cancel();
                const outcomeUnknown = !(error instanceof SocketRequestError) || error.outcomeUnknown;
                this.invalidateDocumentSession(
                    doc._id,
                    error instanceof Error ? error : new Error(String(error)),
                );
                if (!outcomeUnknown) {
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
            if (!desiredChangesArePresent(
                pending.baseContent,
                authoritative.content,
                pending.desiredContent,
            )) {
                await this.provenanceStore.markPendingWrite(
                    pending.provenanceRecordName,
                    this.pendingWritePayload(pending, 'acknowledged-remote-diverged', {
                        authoritativeVersion: authoritative.doc.version ?? -1,
                    }),
                );
                this.pendingDocumentUpdates.delete(witness.bufferId);
                this.blockDocumentWrite(
                    uri,
                    content,
                    'the acknowledged write was followed by remote changes; reload before another write',
                );
            }
            const authoritativeVersion = authoritative.doc.version;
            if (authoritativeVersion === undefined) {
                this.pendingDocumentUpdates.delete(witness.bufferId);
                this.blockDocumentWrite(
                    uri,
                    content,
                    'the acknowledged write returned without an authoritative revision',
                );
            }
            try {
                await this.acceptEditorBase(
                    witness,
                    authoritative.doc,
                    authoritativeVersion,
                    authoritative.content,
                    pending.provenanceRecordsToClear,
                );
            } catch (error) {
                this.pendingDocumentUpdates.delete(witness.bufferId);
                this.showDocumentRecovery(
                    uri,
                    content,
                    `the acknowledged write could not clear its recovery record: ${String(error)}`,
                );
                throw error;
            }
            this.pendingDocumentUpdates.delete(witness.bufferId);
            setTimeout(() => {
                this.notify([
                    {type: vscode.FileChangeType.Changed, uri: uri}
                ]);
            }, 10);
            authoritative.doc.lastVersion = sentVersion;
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

    constructor(private context: vscode.ExtensionContext) {
        this.context = context;
        this.vfss = {};
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
                this.observeTextDocument(document);
            }),
            vscode.workspace.onDidChangeTextDocument(event => {
                this.observeTextDocument(event.document);
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
