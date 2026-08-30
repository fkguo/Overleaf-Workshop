/* eslint-disable @typescript-eslint/naming-convention */
import * as vscode from 'vscode';
import { BaseAPI, MemberEntity, ProjectSettingsSchema } from '../api/base';
import { SocketIOAPI, UpdateSchema } from '../api/socketio';
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

export interface OutputFileEntity extends FileEntity {
    path: string, //output file name
    url: string, // `project/${projectId}/user/${userId}/output/${build}/output/${path}`
    type: string, //output file type (postfix)
    build: string, //build id
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
    const query:any = uri.query.split('&').reduce((acc, v) => {
        const [key,value] = v.split('=');
        return {...acc, [key]:value};
    }, {});
    const [userId, projectId] = [query.user, query.project];
    const _pathParts = uri.path.split('/');
    const serverName = uri.authority;
    const projectName = decodeURIComponent(_pathParts[1]);
    const pathParts = _pathParts.splice(2);
    const identifier = `${userId}/${projectId}/${projectName}`;
    return {userId, projectId, serverName, projectName, identifier, pathParts};
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
    private documentWrites = new Map<string, Promise<void>>();
    private documentJoinTasks = new Map<string, Promise<{doc: DocumentEntity, content: string}>>();
    private joiningDocuments = new Map<string, {generation: number, updates: UpdateSchema[]}>();
    private documentVersionWaiters = new Map<string, Set<DocumentVersionWaiter>>();
    private pendingDocumentUpdates = new Map<string, PendingDocumentUpdate>();
    private freshConnectionRequested = false;
    private outputBuildId?: string;
    private compileGroup?: string;
    private clsiServerId?: string;
    private pdfDownloadDomain?: string;
    private notify: (events:vscode.FileChangeEvent[])=>void;
    private clientManagerItem?: {manager: ClientManager, triggers: vscode.Disposable[]};
    private scmCollectionItem?: {collection: SCMCollectionProvider, triggers: vscode.Disposable[]};

    public readonly origin: vscode.Uri;
    public readonly projectName: string;
    public readonly serverName: string;
    public readonly projectId: string;

    constructor(context: vscode.ExtensionContext, uri: vscode.Uri, notify: (events:vscode.FileChangeEvent[])=>void) {
        // define the dispose behavior
        super(() => {
            // dispose all triggers of clientManager
            this.clientManagerItem?.triggers.forEach((trigger) => trigger.dispose());
            this.clientManagerItem = undefined;
            // dispose all triggers of scmCollection
            this.scmCollectionItem?.triggers.forEach((trigger) => trigger.dispose());
            this.scmCollectionItem = undefined;
            // disconnect socketio
            // this.socket.disconnect();
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
        return this.root !== undefined && this.socket.isConnected;
    }

    async init() : Promise<ProjectEntity> {
        if (this.root) {
            return Promise.resolve(this.root);
        }

        return this.startInitialization(false);
    }

    private startInitialization(showProgress: boolean): Promise<ProjectEntity> {
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
            const delayMs = attempt > 0 ? Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), 16000) : 0;
            if (delayMs > 0) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
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
                    vscode.commands.executeCommand(`${ROOT_NAME}.compileManager.compile`);
                }
                return project;
            } catch (error) {
                lastError = error;
                this.root = undefined;
                this.joiningProject = undefined;
                // Let socket.io exhaust its automatic reconnect first. If the
                // connection waiter itself times out while still offline, the
                // physical socket is no longer making progress and must be
                // replaced for the next outer attempt.
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
            this.isDirty = true;
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
                if (this.root) {
                    this.previousRoot = this.root;
                }
                this.invalidateDocumentSessions(this.previousRoot);
                this.root = undefined;
                this.joiningProject = undefined;
                this.publicId = undefined;
                // Gate filesystem operations immediately. The shared initialization
                // task waits for transport reconnect and then joins the project.
                void this.startInitialization(true).catch(() => {});
            },
            onConnectionAccepted: (publicId:string) => {
                // connectionAccepted is transport-level only. Project readiness is
                // established exclusively by connectWithRetry after joinProject.
                this.publicId = publicId;
                this.clientManagerItem?.manager.updatePublicId(publicId);
            },
            onFileCreated: (parentFolderId:string, type:FileType, entity:FileEntity) => {
                const res = this._resolveById(parentFolderId);
                if (res) {
                    const {fileEntity,path} = res;
                    const entityPath = path + entity.name;
                    this.insertEntity(fileEntity as FolderEntity, type, entity);
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
                    fileEntity.name = newName;
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
                    this.insertEntity(newParentFolder, oldPath.fileType, oldPath.fileEntity);
                    this.removeEntity(oldPath.parentFolder, oldPath.fileType, oldPath.fileEntity);
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
        const readonly = fileEntity?.readonly ? vscode.FilePermission.Readonly : undefined;
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
            const {compileGroup, clsiServerId, pdfDownloadDomain} = this;
            return GlobalStateManager.authenticate(this.context, this.serverName)
            .then((identity) => {
                return this.api.getFileFromClsi(identity, (fileEntity as OutputFileEntity).url, compileGroup || 'standard', clsiServerId, pdfDownloadDomain)
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
        const {parentFolder, fileName, fileEntity} = await this._resolveUri(uri);
        if (fileEntity && !overwrite) {
            throw vscode.FileSystemError.FileExists(uri);
        }

        let res = undefined;
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);

        if (content.length===0) {
            const _res = await this.api.addDoc(identity, this.projectId, parentFolder._id, fileName);
            if (_res.type==='success') {
                res = _res.entity;
            }
        } else {
            const parentFolderId = parentFolder._id;
            const _res = await this.api.uploadFile(identity, this.projectId, parentFolderId, fileName, content);
            if (_res.type==='success' && _res.entity!==undefined) {
                res = _res.entity;
            } else {
                if (_res.message!==undefined) {
                    vscode.window.showErrorMessage(_res.message);
                }
            }
        }
        if (res && res._type) {
            this.insertEntity(parentFolder, res._type, res);
            this.notify([
                {type: vscode.FileChangeType.Created, uri: uri},
            ]);
        }
    }

    async refreshLinkedFile(uri: vscode.Uri) {
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
        if (this.freshConnectionRequested) { return; }
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
            await this.socket.applyOtUpdate(docId, recoveryUpdate);
            await versionWaiter?.promise;
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
                this.isDirty = false;
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
            this.isDirty = (update.op && update.op.length) ? true : false;
            if (!this.isDirty) {
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
                await this.socket.applyOtUpdate(doc._id, update);
                await versionWaiter?.promise;
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
        const {parentFolder, fileName} = await this._resolveUri(uri);
        const [folderName, parentFolderId] = [fileName, parentFolder._id];
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.addFolder(identity, this.projectId, folderName, parentFolderId);

        if (res.type==='success' && res.entity!==undefined) {
            this.insertEntity(parentFolder, 'folder', res.entity as FolderEntity);
            this.notify([
                {type: vscode.FileChangeType.Created, uri: uri},
            ]);
        } else {
            if (res.message!==undefined) {
                vscode.window.showErrorMessage(res.message);
            }
        }
    }

    async remove(uri: vscode.Uri, recursive: boolean) {
        const {parentFolder, fileType, fileEntity} = await this._resolveUri(uri);
        if (fileType && fileEntity) {
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            const res = await this.api.deleteEntity(identity, this.projectId, fileType, fileEntity._id);
            if (res.type==='success') {
                this.removeEntityById(parentFolder, fileType, fileEntity._id, recursive);
                this.notify([
                    {type: vscode.FileChangeType.Deleted, uri: uri},
                ]);
            } else {
                if (res.message!==undefined) {
                    vscode.window.showErrorMessage(res.message);
                }
            }
        }
    }

    async rename(oldUri: vscode.Uri, newUri: vscode.Uri, force: boolean) {
        const oldPath = await this._resolveUri(oldUri);
        const newPath = await this._resolveUri(newUri);

        if (oldPath.fileType && oldPath.fileEntity && oldPath.fileEntity) {
            // delete existence firstly
            if (newPath.fileType && newPath.fileEntity) {
                if (!force) { return; }
                await this.remove(newUri, true);
                this.removeEntity(newPath.parentFolder, newPath.fileType, newPath.fileEntity);
            }
            // rename or move
            let res = undefined;
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            if (oldPath.parentFolder===newPath.parentFolder) {
                const [entityType, entityId, newName] = [oldPath.fileType, oldPath.fileEntity._id, newPath.fileName];
                res = await this.api.renameEntity(identity, this.projectId, entityType, entityId, newName);
            } else {
                const [entityType, entityId, newParentFolderId] = [oldPath.fileType, oldPath.fileEntity._id, newPath.parentFolder._id];
                res = await this.api.moveEntity(identity, this.projectId, entityType, entityId, newParentFolderId);
            }
            // update local cache
            if (res?.type==='success') {
                const newEntity = Object.assign(oldPath.fileEntity);
                newEntity.name = newPath.fileName;
                this.removeEntity(oldPath.parentFolder, oldPath.fileType, oldPath.fileEntity);
                this.insertEntity(newPath.parentFolder, oldPath.fileType, newEntity);
                this.notify([
                    {type: vscode.FileChangeType.Deleted, uri: oldUri},
                    {type: vscode.FileChangeType.Created, uri: newUri},
                ]);
            } else {
                if (res?.message!==undefined) {
                    vscode.window.showErrorMessage(res.message);
                }
            }
        }
    }

    async compile(force:boolean=false, draft:boolean=false, stopOnFirstError:boolean=false, rootDocId?:string) {
        if (force || (this.root && this.isDirty)) {
            this.isDirty = false;
            let needCacheClearFirst = false;
            try{
                await this.resolve(this.pathToUri(OUTPUT_FOLDER_NAME, "output.log"));
            }
            catch (e) {
                needCacheClearFirst = true;
            }
            const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
            // clear cache if needed
            if (needCacheClearFirst) {
                await this.api.deleteAuxFiles(identity, this.projectId);
            }
            // compile project
            const resolvedRootDocId = rootDocId ?? this.root?.rootDoc_id ?? null;
            let rootResourcePath: string | null = null;
            if (resolvedRootDocId) {
                const rootEntry = this._resolveById(resolvedRootDocId);
                if (rootEntry?.path) {
                    rootResourcePath = rootEntry.path.replace(/^\//, '');
                } else {
                    console.warn(`Unable to resolve root document id '${resolvedRootDocId}' to a path; compiling without explicit rootResourcePath.`);
                }
            }
            const res = await this.api.compile(identity, this.projectId, rootResourcePath, draft, stopOnFirstError);
            if (res.type==='success' && res.compile?.status==='success') {
                // Store CDN download info from the response for subsequent output file requests
                this.compileGroup = res.compile.compileGroup;
                this.clsiServerId = res.compile.clsiServerId;
                this.pdfDownloadDomain = res.compile.pdfDownloadDomain;
                this.updateOutputs(res.compile.outputFiles);
                return true;
            } else {
                if (res.message!==undefined) {
                    console.error('Compile failure.', res.message);
                }
                return false;
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

    async updateOutputs(outputs: Array<OutputFileEntity>) {
        if (this.root) {
            // update output buildId
            // '/project/65dbfff719ad65b54b9eaed4/user/65094b5fa537faaba0bec01f/build/19620231e54-5372f67292889500/output/output.aux' --> 19620231e54-5372f67292889500'
            this.outputBuildId = outputs[0].url.match(/\/build\/([^\/]+)/)?.[1];

            const rootFolder = this.root.rootFolder[0];
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
                outputs: outputs.map((file) => {
                    file._id = __OUTPUTS_ID;
                    file.name=file.path;
                    file.readonly=true;
                    return file;
                })
            } as FolderEntity);
            this.notify([
                {type:vscode.FileChangeType.Created, uri:this.pathToUri(OUTPUT_FOLDER_NAME)},
                ...(outputs.map((file) => {
                    return {type:vscode.FileChangeType.Changed, uri:this.pathToUri(OUTPUT_FOLDER_NAME, file.path)};
                }))
            ]);
        }
    }

    async syncCode(filePath: string, line:number, column:number) {
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.proxySyncCode(identity, this.projectId, filePath, line, column, this.outputBuildId ?? '');
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
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.proxySyncPdf(identity, this.projectId, page, h, v, this.outputBuildId ?? '');
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
        const identity = await GlobalStateManager.authenticate(this.context, this.serverName);
        const res = await this.api.createLabel(identity, this.projectId, comment, version);
        if (res.type==='success') {
            return res.labels?.at(0);
        } else {
            return undefined;
        }
    }

    async deleteLabel(labelId: string) {
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

export class RemoteFileSystemProvider implements vscode.FileSystemProvider {
    private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this._emitter.event;

    private vfss: {[key:string]:VirtualFileSystem};

    constructor(private context: vscode.ExtensionContext) {
        this.context = context;
        this.vfss = {};
    }

    private getVFS(uri: vscode.Uri): Promise<VirtualFileSystem> {
        const vfs = this.vfss[ uri.query ];
        if (vfs) {
            return Promise.resolve(vfs);
        } else {
            const vfs = new VirtualFileSystem(this.context, uri, this.notify.bind(this));
            this.vfss[ uri.query ] = vfs;
            return Promise.resolve(vfs);
        }
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
        if (oldUri.authority !== newUri.authority) {
            vscode.window.showErrorMessage( vscode.l10n.t('Cannot rename across servers') );
            return;
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
        ];
    }
}
