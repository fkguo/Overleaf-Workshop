/* eslint-disable @typescript-eslint/naming-convention */
import * as vscode from 'vscode';
import { BaseAPI, CompileOutputFileSchema, MemberEntity, ProjectSettingsSchema } from '../api/base';
import {
    OtUpdateErrorSchema,
    PermissionsLevel,
    ProjectSessionSchema,
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
    prepareDocumentUpdate,
    requiresVersionConfirmation,
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

const __OUTPUTS_ID = `${ROOT_NAME}-outputs`;

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

type PendingDocumentUpdate = {
    update: UpdateSchema,
    desiredContent: string,
    mergedContent: string,
    submittedPublicIds: string[],
    alternativeConnection: boolean,
    localBase: string,
};

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
    private joiningDocuments = new Map<string, {generation: number, updates: UpdateSchema[]}>();
    private documentVersionWaiters = new Map<string, Set<DocumentVersionWaiter>>();
    private pendingDocumentUpdates = new Map<string, PendingDocumentUpdate>();
    private freshConnectionRequested = false;
    private sourceRevision = 0;
    private permissionsLevel?: PermissionsLevel;
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
    public readonly projectId: string;

    constructor(
        context: vscode.ExtensionContext,
        uri: vscode.Uri,
        notify: (events:vscode.FileChangeEvent[])=>void,
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

        const {userId,projectId,serverName,projectName} = parseUri(uri);
        this.serverName = serverName;
        this.projectName = projectName;
        this.origin = uri.with({path: '/'+projectName});
        this.userId = userId;
        this.projectId = projectId;
        this.context = context;
        this.notify = notify;

        const res = GlobalStateManager.initSocketIOAPI(this.context, this.serverName, projectId);
        if (res) {
            this.api = res.api;
            this.socket = res.socket;
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
            this.pendingDocumentUpdates.delete(error.docId);
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
            doc.localCache = oldDoc.localCache ?? oldDoc.remoteCache;
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

    private applyDocumentUpdate(update: UpdateSchema) {
        const res = this._resolveById(update.doc);
        if (res===undefined) { return; }

        const doc = res.fileEntity as DocumentEntity;
        const senderConfirmation = isSenderConfirmation(update);
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
            onFileChanged: (update:UpdateSchema) => {
                const joining = this.joiningDocuments.get(update.doc);
                if (joining && joining.generation === this.socket.generation) {
                    joining.updates.push(update);
                    return;
                }
                this.applyDocumentUpdate(update);
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
                EventBus.fire('fileWillOpenEvent', {uri});
                return new TextEncoder().encode(content);
            } else {
                const {content} = await this.ensureDocumentSession(doc._id);
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
        const joining = {generation: connectionGeneration, updates: [] as UpdateSchema[]};
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
            doc.localCache ??= remoteContent;
            doc.lastVersion = undefined;

            const responseUpdates = res.updates.filter((update: any) =>
                update && typeof update.v === 'number' && (update.op === undefined || Array.isArray(update.op)),
            ).map((update: UpdateSchema) => ({...update, doc: update.doc || docId}));
            [...responseUpdates, ...joining.updates]
                .sort((left, right) => left.v - right.v)
                .forEach(update => this.applyDocumentUpdate(update));

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
        const key = uri.toString();
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

    private async recoverPendingDocumentUpdate(docId: string): Promise<void> {
        const pending = this.pendingDocumentUpdates.get(docId);
        if (!pending) { return; }

        if (pending.alternativeConnection) {
            // Alternative mode stages content locally and never queues realtime
            // OT. Its interrupted saves are recomputed from the fresh HTTP state;
            // a pending realtime OT must be recovered on a realtime transport.
            this.pendingDocumentUpdates.delete(docId);
            return;
        }
        if (this.isInvisibleMode) {
            throw new Error('A pending realtime document update cannot be recovered in Invisible Mode');
        }

        await this.ensureDocumentSession(docId);
        const currentPublicId = this.publicId;
        const recoveryUpdate = buildRecoveryUpdate(pending.update, pending.submittedPublicIds);
        const versionWaiter = requiresVersionConfirmation(this.isInvisibleMode) ?
            this.waitForDocumentVersion(docId, pending.update.v) : undefined;
        if (currentPublicId && !pending.submittedPublicIds.includes(currentPublicId)) {
            pending.submittedPublicIds.push(currentPublicId);
        }
        try {
            if (versionWaiter) {
                await Promise.all([
                    this.socket.applyOtUpdate(docId, recoveryUpdate),
                    versionWaiter.promise,
                ]);
            } else {
                await this.socket.applyOtUpdate(docId, recoveryUpdate);
            }
        } catch (error) {
            versionWaiter?.cancel();
            if (!(error instanceof SocketRequestError && error.outcomeUnknown)) {
                this.pendingDocumentUpdates.delete(docId);
                throw error;
            }
            // Some older deployments acknowledge queueing but do not broadcast
            // the sender-only version event. After the timeout, accept only an
            // authoritative snapshot which proves the desired edits are present.
            try {
                const authoritative = await this.joinFreshDocumentSession(docId);
                if (desiredChangesArePresent(
                    pending.localBase,
                    authoritative.content,
                    pending.desiredContent,
                )) {
                    authoritative.doc.localCache = pending.desiredContent;
                    this.pendingDocumentUpdates.delete(docId);
                    return;
                }
            } catch {
                // Keep the exact pending operation for another deduplicated retry.
            }
            throw error;
        }

        if (this.isInvisibleMode) {
            const doc = this.currentDocument(docId);
            doc.localCache = pending.desiredContent;
            doc.remoteCache = pending.mergedContent;
        } else {
            // The sender-only version event above is Overleaf's commit
            // confirmation. Concurrent OT may transform the resulting text, so
            // this fresh snapshot is for reconciliation, not a second proof that
            // can revoke an already-confirmed save.
            const authoritative = await this.joinFreshDocumentSession(docId);
            authoritative.doc.localCache = pending.desiredContent;
        }
        this.pendingDocumentUpdates.delete(docId);
    }

    private async writeFileNow(uri: vscode.Uri, content:Uint8Array, create:boolean, overwrite:boolean) {
        const {fileType, fileEntity} = await this._resolveUri(uri);

        // if non-exists --> create it
        if (!fileType && create) {
            return this.createFile(uri, content, true);
        }

        // if exists but not doc --> create new
        if (fileType && fileType!=='doc' && create) {
            return this.createFile(uri, content, overwrite);
        }

        // if exists and is doc --> update
        if (fileType && fileType==='doc' && fileEntity) {
            const docId = fileEntity._id;
            const _content = new TextDecoder().decode(content);
            await this.recoverPendingDocumentUpdate(docId);
            const session = await this.ensureDocumentSession(docId);
            const doc = session.doc;
            const remoteContent = session.content;
            if (remoteContent === _content) {
                doc.localCache = remoteContent;
                doc.remoteCache = remoteContent;
                return;
            }
            const localBase = doc.localCache ?? remoteContent;
            const sessionVersion = doc.version;
            if (sessionVersion === undefined) {
                throw new Error('Document session has no version after joinDoc');
            }
            const prepared = prepareDocumentUpdate(localBase, remoteContent, _content);
            const mergeRes = prepared.mergedContent;
            if (!prepared.mergeApplied) {
                doc.version = undefined;
                doc.remoteCache = undefined;
                throw new Error('Unable to merge remote document changes safely; the document was not written');
            }
            const update = {
                doc: doc._id,
                lastV: doc.lastVersion,
                v: sessionVersion,
                // Reference: services/web/frontend/js/vendor/libs/sharejs.js#L1288
                hash: (()=>{
                    if (!doc.mtime || Date.now()-doc.mtime>5000) {
                        doc.mtime = Date.now();
                        return require('crypto').createHash('sha1').update(
                            "blob " + mergeRes.length + "\x00" + mergeRes
                        ).digest('hex');
                    }
                })() as string,
                op: prepared.operations,
            };
            const hasOperations = Boolean(update.op?.length);
            if (hasOperations) { this.markSourceDirty(); }
            if (!hasOperations) {
                doc.localCache = _content;
                doc.remoteCache = mergeRes;
                if (_content !== mergeRes) {
                    setTimeout(() => {
                        this.notify([
                            {type: vscode.FileChangeType.Changed, uri: uri}
                        ]);
                    }, 10);
                }
                return;
            }

            if (!this.isInvisibleMode && !this.publicId) {
                throw new SocketRequestError(
                    'not_connected',
                    'Realtime session has no accepted public id',
                    false,
                );
            }

            const sentVersion = sessionVersion;
            const versionWaiter = requiresVersionConfirmation(this.isInvisibleMode) ?
                this.waitForDocumentVersion(doc._id, sentVersion) : undefined;
            const pending: PendingDocumentUpdate = {
                update,
                desiredContent: _content,
                mergedContent: mergeRes,
                submittedPublicIds: this.publicId ? [this.publicId] : [],
                alternativeConnection: this.isInvisibleMode,
                localBase,
            };
            this.pendingDocumentUpdates.set(doc._id, pending);
            try {
                if (versionWaiter) {
                    await Promise.all([
                        this.socket.applyOtUpdate(doc._id, update),
                        versionWaiter.promise,
                    ]);
                } else {
                    await this.socket.applyOtUpdate(doc._id, update);
                }
            } catch (error) {
                versionWaiter?.cancel();
                // The server may have applied an update whose acknowledgement was
                // lost. Preserve the local base, invalidate the remote session, and
                // let the next save rejoin/recompute instead of replaying stale OT.
                doc.version = undefined;
                doc.remoteCache = undefined;
                doc.lastVersion = undefined;
                if (this.isInvisibleMode || !(error instanceof SocketRequestError && error.outcomeUnknown)) {
                    this.pendingDocumentUpdates.delete(doc._id);
                }
                throw error;
            }
            if (this.isInvisibleMode) {
                doc.localCache = _content;
                doc.remoteCache = mergeRes;
            } else {
                // The sender-only version event above is the commit boundary.
                // Rejoin to reconcile transformed concurrent edits without
                // comparing them byte-for-byte with the pre-transform intent.
                const authoritative = await this.joinFreshDocumentSession(doc._id);
                authoritative.doc.localCache = _content;
            }
            this.pendingDocumentUpdates.delete(doc._id);
            setTimeout(() => {
                this.notify([
                    {type: vscode.FileChangeType.Changed, uri: uri}
                ]);
            }, 10);
            doc.lastVersion = sentVersion;
        }
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

    constructor(private context: vscode.ExtensionContext) {
        this.context = context;
        this.vfss = {};
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
            const vfs = new VirtualFileSystem(this.context, uri, this.notify.bind(this), () => {
                if (this.vfss[key] === vfs) {
                    delete this.vfss[key];
                }
            });
            this.vfss[key] = vfs;
            return Promise.resolve(vfs);
        }
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
            new vscode.Disposable(() => this.dispose()),
        ];
    }
}
