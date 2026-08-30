/* eslint-disable @typescript-eslint/naming-convention */
import { Identity, BaseAPI, ProjectMessageResponseSchema } from './base';
import { FileEntity, DocumentEntity, FileRefEntity, FileType, FolderEntity, ProjectEntity } from '../core/remoteFileSystemProvider';
import {
    isRecoverableTransportInterruption,
    requestWithAck,
    SocketRequestError,
    withTimeout,
} from './socketRequest';

function decodePackedUtf8(text: string): string {
    return Buffer.from(text, 'latin1').toString('utf-8');
}

export interface UpdateUserSchema {
    id: string,
    user_id: string,
    name: string,
    email: string,
    doc_id: string,
    row: number,
    column: number,
    last_updated_at?: number, //unix timestamp
}

export interface OnlineUserSchema {
    client_age: number,
    client_id: string,
    connected: boolean,
    cursorData?: {
        column: number,
        doc_id: string,
        row: number,
    },
    email: string,
    first_name: string,
    last_name?: string,
    last_updated_at: string, //unix timestamp
    user_id: string,
}

export interface UpdateSchema {
    doc: string, //doc id
    op?: {
        p: number, //position
        i?: string, //insert
        d?: string, //delete
        u?: boolean, //isUndo
    }[],
    v: number, //doc version number
    lastV?: number, //last version number
    hash?: string, //(not needed if lastV is provided)
    dupIfSource?: string[], //deduplicate an in-flight op after reconnect
    meta?: {
        source: string, //socketio client id
        ts: number, //unix timestamp
        user_id: string,
    }
}

export interface EventsHandler {
    onFileCreated?: (parentFolderId:string, type:FileType, entity:FileEntity) => void,
    onFileRenamed?: (entityId:string, newName:string) => void,
    onFileRemoved?: (entityId:string) => void,
    onFileMoved?: (entityId:string, newParentFolderId:string) => void,
    onFileChanged?: (update:UpdateSchema) => void,
    //
    onDisconnected?: () => void,
    onConnectionAccepted?: (publicId:string) => void,
    onClientUpdated?: (user:UpdateUserSchema) => void,
    onClientDisconnected?: (id:string) => void,
    //
    onReceivedMessage?: (message:ProjectMessageResponseSchema) => void,
    //
    onSpellCheckLanguageUpdated?: (language:string) => void,
    onCompilerUpdated?: (compiler:string) => void,
    onRootDocUpdated?: (rootDocId:string) => void,
}

type ConnectionScheme = 'Alt' | 'v1' | 'v2';

type Deferred<T> = {
    promise: Promise<T>,
    resolve: (value: T) => void,
    reject: (reason?: unknown) => void,
};

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    // A v2 project response can be superseded before joinProject starts awaiting it.
    // Mark the promise handled while retaining the original rejection for consumers.
    promise.catch(() => {});
    return {promise, resolve, reject};
}

const CONNECT_TIMEOUT_MS = 15000;
const ACK_TIMEOUT_MS = 15000;

export class SocketIOAPI {
    // Current Overleaf real-time servers require projectId on the socket
    // handshake and auto-join the project via joinProjectResponse. Keep the v1
    // path as a compatibility fallback for older self-hosted deployments.
    private scheme: ConnectionScheme = 'v2';
    private record?: Promise<ProjectEntity>;
    private _handlers: Array<EventsHandler> = [];

    private socket?: any;
    /** Track the scheme used when the socket was last initialized */
    private _socketInitScheme?: ConnectionScheme;
    private socketGeneration = 0;
    private transportConnected = false;
    private lastDisconnectedSocket?: any;
    private transportConnectedSignal = deferred<number>();
    private connectionAcceptedSignal = deferred<{generation: number, publicId: string}>();
    private v2ProjectResponse?: Deferred<ProjectEntity> & {generation: number};
    private documentMembershipQueue: Promise<void> = Promise.resolve();
    private legacyV1Rejected = false;
    private disposed = false;

    constructor(private url:string,
                private readonly api:BaseAPI,
                private readonly identity:Identity,
                private readonly projectId:string)
    {
        this.init();
    }

    init() {
        if (this.disposed) {
            throw new SocketRequestError('stale_connection', 'Socket session is disposed', false);
        }
        this.resetTransportState();

        // CRITICAL: Properly disconnect old socket before creating a new one.
        // Without this, the old TCP connection is abandoned but still alive. When the
        // server later sends data on it (out-of-order/late packets), the OS TCP stack
        // responds with RST, which can cause the server to drop ALL connections from
        // this client — explaining the "connection lost" loop reported in issue #309.
        if (this.socket) {
            try {
                // Notify all in-flight requests before removing handlers, then
                // gracefully close the connection (sends FIN, not RST).
                if (typeof this.socket.disconnect === 'function') {
                    this.socket.disconnect();
                }
                if (typeof this.socket.removeAllListeners === 'function') {
                    this.socket.removeAllListeners();
                }
            } catch {
                // Best-effort cleanup; socket may already be in a bad state
            }
        }

        // connect
        switch(this.scheme) {
            case 'Alt':
                // Keep the VS Code-dependent HTTP fallback out of the normal
                // realtime module graph. This also lets the socket state machine
                // run in isolation in unit tests.
                const {SocketIOAlt} = require('./socketioAlt') as typeof import('./socketioAlt');
                this.socket = new SocketIOAlt(this.url, this.api, this.identity, this.projectId, this.record!);
                break;
            case 'v1':
                this.record = undefined;
                this.socket = this.api._initSocketV0(this.identity);
                break;
            case 'v2':
                this.record = undefined;
                const query = `?projectId=${this.projectId}&t=${Date.now()}`;
                this.socket = this.api._initSocketV0(this.identity, query);
                break;
        }
        const socketAtInit = this.socket;
        // resume handlers
        this.initInternalHandlers(socketAtInit);
        // Re-register existing event handlers on the new socket
        this.resumeEventHandlers(this._handlers);
        // Track which scheme this socket was created with
        this._socketInitScheme = this.scheme;
        // socket.io can connect synchronously in tests or alternative transports.
        if (socketAtInit.connected === true) {
            this.markTransportConnected(socketAtInit);
        }
    }

    /** Returns true if the socket needs re-initialization (scheme changed, or socket was never init'd) */
    get needsReinit(): boolean {
        return this._socketInitScheme !== this.scheme || !this.socket;
    }

    get isConnected(): boolean {
        return this.transportConnected;
    }

    get generation(): number {
        return this.socketGeneration;
    }

    invalidateCurrentTransport() {
        this._socketInitScheme = undefined;
    }

    private resetTransportState() {
        this.transportConnectedSignal.reject(new SocketRequestError(
            'stale_connection',
            'Socket transport was replaced',
            true,
        ));
        this.socketGeneration += 1;
        this.transportConnected = false;
        this.transportConnectedSignal = deferred<number>();
        this.connectionAcceptedSignal.reject(new SocketRequestError(
            'stale_connection',
            'Socket transport was replaced before session acceptance',
            true,
        ));
        this.connectionAcceptedSignal = deferred<{generation: number, publicId: string}>();
        this.rejectV2ProjectResponse(new SocketRequestError(
            'stale_connection',
            'Socket transport was replaced',
            true,
        ));
    }

    private markTransportConnected(socket: any) {
        if (socket !== this.socket || this.transportConnected) { return; }
        this.lastDisconnectedSocket = undefined;
        this.transportConnected = true;
        this.transportConnectedSignal.resolve(this.socketGeneration);
        if (this.scheme === 'v2') {
            this.ensureV2ProjectResponse();
        }
    }

    private markTransportDisconnected(socket: any) {
        if (socket !== this.socket || this.lastDisconnectedSocket === socket) { return; }
        this.lastDisconnectedSocket = socket;
        this.transportConnectedSignal.reject(new SocketRequestError(
            'disconnected',
            'Socket disconnected before the transport became ready',
            true,
        ));
        this.socketGeneration += 1;
        this.transportConnected = false;
        this.transportConnectedSignal = deferred<number>();
        this.connectionAcceptedSignal.reject(new SocketRequestError(
            'disconnected',
            'Socket disconnected before session acceptance',
            true,
        ));
        this.connectionAcceptedSignal = deferred<{generation: number, publicId: string}>();
        this.rejectV2ProjectResponse(new SocketRequestError(
            'disconnected',
            'Socket disconnected before the project session was ready',
            true,
        ));
    }

    private ensureV2ProjectResponse() {
        if (!this.v2ProjectResponse || this.v2ProjectResponse.generation !== this.socketGeneration) {
            this.v2ProjectResponse = {
                ...deferred<ProjectEntity>(),
                generation: this.socketGeneration,
            };
        }
        return this.v2ProjectResponse;
    }

    private rejectV2ProjectResponse(error: unknown) {
        this.v2ProjectResponse?.reject(error);
        this.v2ProjectResponse = undefined;
    }

    async waitUntilConnected(timeoutMs: number = CONNECT_TIMEOUT_MS): Promise<number> {
        if (this.disposed) {
            throw new SocketRequestError('stale_connection', 'Socket session is disposed', false);
        }
        if (this.transportConnected) {
            return this.socketGeneration;
        }
        const signal = this.transportConnectedSignal;
        const generation = await withTimeout(signal.promise, 'socket connection', timeoutMs);
        if (!this.transportConnected || generation !== this.socketGeneration) {
            throw new SocketRequestError(
                'stale_connection',
                'Socket connection changed while waiting for transport readiness',
                false,
            );
        }
        return generation;
    }

    private async waitUntilConnectionAccepted(generation: number): Promise<string> {
        const accepted = await withTimeout(
            this.connectionAcceptedSignal.promise,
            'connection acceptance',
            CONNECT_TIMEOUT_MS,
        );
        if (
            accepted.generation !== generation ||
            generation !== this.socketGeneration ||
            !this.transportConnected
        ) {
            throw new SocketRequestError(
                'stale_connection',
                'Socket connection changed before session acceptance',
                false,
            );
        }
        return accepted.publicId;
    }

    private async request<T extends any[]>(event: string, args: any[], timeoutMs: number = ACK_TIMEOUT_MS): Promise<T> {
        const generation = await this.waitUntilConnected();
        const socketAtEmit = this.socket;
        return requestWithAck<T>(
            socketAtEmit,
            event,
            args,
            timeoutMs,
            generation,
            (candidate) => candidate === this.socketGeneration && socketAtEmit === this.socket,
        );
    }

    private queueDocumentMembership<T>(operation: () => Promise<T>): Promise<T> {
        const queued = this.documentMembershipQueue.catch(() => {}).then(operation);
        this.documentMembershipQueue = queued.then(() => {}, () => {});
        return queued;
    }

    private initInternalHandlers(socketAtInit: any) {
        socketAtInit.on('connect', () => {
            this.markTransportConnected(socketAtInit);
            console.log('SocketIOAPI: connected');
        });
        socketAtInit.on('disconnect', () => {
            this.markTransportDisconnected(socketAtInit);
        });
        socketAtInit.on('connectionAccepted', (_:any, publicId:any) => {
            if (socketAtInit !== this.socket) { return; }
            this.connectionAcceptedSignal.resolve({
                generation: this.socketGeneration,
                publicId: String(publicId ?? ''),
            });
        });
        socketAtInit.on('connect_failed', () => {
            console.log('SocketIOAPI: connect_failed');
        });
        socketAtInit.on('forceDisconnect', (message:string, delay=10) => {
            console.log('SocketIOAPI: forceDisconnect', message);
        });
        socketAtInit.on('connectionRejected', (err:any) => {
            const message = String(err?.message || err);
            console.log('SocketIOAPI: connectionRejected.', message);
            const rejection = new SocketRequestError(
                'server_error',
                `Project connection rejected: ${message}`,
                false,
                err,
            );
            this.rejectV2ProjectResponse(rejection);
            const activeScheme = this._socketInitScheme ?? this.scheme;
            // Modern servers explicitly reject legacy handshakes which omit the
            // project id. Once observed, never bounce back to that known-bad
            // protocol because a later v2 attempt has a transient failure.
            if (activeScheme === 'v1' && /missing\/bad.*projectId/i.test(message)) {
                this.legacyV1Rejected = true;
                this.scheme = 'v2';
            }
            this.invalidateCurrentTransport();
            // Disable auto-reconnect on this socket: the server explicitly rejected
            // our connection parameters. Reconnecting would just get rejected again,
            // creating unnecessary TCP connection churn (and RST packets).
            if (socketAtInit.socket?.options) {
                socketAtInit.socket.options.reconnect = false;
            } else if (socketAtInit.io && typeof socketAtInit.io.reconnect === 'function') {
                socketAtInit.io.reconnect(false);
            }
            setTimeout(() => socketAtInit.disconnect?.(), 0);
        });
        socketAtInit.on('error', (err:any) => {
            // Log error instead of throwing to avoid crashing the extension
            console.error('SocketIOAPI: socket error', err?.message || err);
        });

        if (this.scheme==='v2') {
            socketAtInit.on('joinProjectResponse', (res:any) => {
                if (socketAtInit !== this.socket) { return; }
                const publicId = res.publicId as string;
                const project = res.project as ProjectEntity;
                this.ensureV2ProjectResponse().resolve(project);
                this._handlers.forEach(handler => handler.onConnectionAccepted?.(publicId));
            });
        }
    }

    disconnect() {
        this.socket?.disconnect();
    }

    dispose() {
        if (this.disposed) { return; }
        this.disposed = true;
        this._handlers = [];

        const socket = this.socket;
        try {
            socket?.disconnect?.();
        } finally {
            socket?.removeAllListeners?.();
        }

        const error = new SocketRequestError(
            'stale_connection',
            'Socket session is disposed',
            false,
        );
        this.transportConnectedSignal.reject(error);
        this.connectionAcceptedSignal.reject(error);
        this.rejectV2ProjectResponse(error);
        this.transportConnected = false;
        this.lastDisconnectedSocket = undefined;
        this._socketInitScheme = undefined;
        this.socket = undefined;
    }

    get handlers() {
        return this._handlers;
    }

    get isUsingAlternativeConnectionScheme() {
        return this.scheme==='Alt';
    }

    toggleAlternativeConnectionScheme(url: string, updatedRecord?: ProjectEntity) {
        this.scheme = this.scheme==='Alt' ? 'v2' : 'Alt';
        if (updatedRecord) {
            this.url = url;
            this.record = Promise.resolve(updatedRecord);
        }
    }

    resumeEventHandlers(handlers: Array<EventsHandler>) {
        this._handlers = [];
        handlers.forEach((handler) => {
            this.updateEventHandlers(handler);
        });
    }

    updateEventHandlers(handlers: EventsHandler) {
        if (this.disposed) { return; }
        this._handlers.push(handlers);
        Object.values(handlers).forEach((handler) => {
            switch (handler) {
                case handlers.onFileCreated:
                    this.socket.on('reciveNewDoc', (parentFolderId:string, doc:DocumentEntity) => {
                        handler(parentFolderId, 'doc', doc);
                    });
                    this.socket.on('reciveNewFile', (parentFolderId:string, file:FileRefEntity) => {
                        handler(parentFolderId, 'file', file);
                    });
                    this.socket.on('reciveNewFolder', (parentFolderId:string, folder:FolderEntity) => {
                        handler(parentFolderId, 'folder', folder);
                    });
                    break;
                case handlers.onFileRenamed:
                    this.socket.on('reciveEntityRename', (entityId:string, newName:string) => {
                        handler(entityId, newName);
                    });
                    break;
                case handlers.onFileRemoved:
                    this.socket.on('removeEntity', (entityId:string) => {
                        handler(entityId);
                    });
                    break;
                case handlers.onFileMoved:
                    this.socket.on('reciveEntityMove', (entityId:string, folderId:string) => {
                        handler(entityId, folderId);
                    });
                    break;
                case handlers.onFileChanged:
                    this.socket.on('otUpdateApplied', (update: UpdateSchema) => {
                        handler(update);
                    });
                    break;
                case handlers.onDisconnected:
                    this.socket.on('disconnect', () => {
                        handler();
                    });
                    break;
                case handlers.onConnectionAccepted:
                    this.socket.on('connectionAccepted', (_:any, publicId:any) => {
                        handler(publicId);
                    });
                    break;
                case handlers.onClientUpdated:
                    this.socket.on('clientTracking.clientUpdated', (user:UpdateUserSchema) => {
                        handler(user);
                    });
                    break;
                case handlers.onClientDisconnected:
                    this.socket.on('clientTracking.clientDisconnected', (id:string) => {
                        handler(id);
                    });
                    break;
                case handlers.onReceivedMessage:
                    this.socket.on('new-chat-message', (message:ProjectMessageResponseSchema) => {
                        handler(message);
                    });
                    break;
                case handlers.onSpellCheckLanguageUpdated:
                    this.socket.on('spellCheckLanguageUpdated', (language:string) => {
                        handler(language);
                    });
                    break;
                case handlers.onCompilerUpdated:
                    this.socket.on('compilerUpdated', (compiler:string) => {
                        handler(compiler);
                    });
                    break;
                case handlers.onRootDocUpdated:
                    this.socket.on('rootDocUpdated', (rootDocId:string) => {
                        handler(rootDocId);
                    });
                    break;
                default:
                    break;
            }
        });
    }

    get unSyncFileChanges(): number {
        if (this._socketInitScheme === 'Alt') {
            return this.socket.unSyncedChanges;
        }
        return 0;
    }

    async syncFileChanges() {
        if (this._socketInitScheme === 'Alt') {
            return await this.socket.uploadToVFS();
        }
    }

    /**
     * Reference: services/web/frontend/js/ide/connection/ConnectionManager.js#L427
     * @param {string} projectId - The project id.
     * @returns {Promise}
     */
    async joinProject(project_id:string): Promise<ProjectEntity> {
        const generation = await this.waitUntilConnected();
        const activeScheme = this._socketInitScheme ?? this.scheme;
        switch(activeScheme) {
            case 'Alt':
            case 'v1': {
                try {
                    await this.waitUntilConnectionAccepted(generation);
                    const socketAtJoin = this.socket;
                    const response = await requestWithAck<[ProjectEntity, string, number]>(
                        socketAtJoin,
                        'joinProject',
                        [{project_id}],
                        ACK_TIMEOUT_MS,
                        generation,
                        (candidate) => candidate === this.socketGeneration && socketAtJoin === this.socket,
                        {
                            event: 'connectionRejected',
                            toError: (err:any) => new SocketRequestError(
                                'server_error',
                                `Project connection rejected: ${err?.message || err}`,
                                false,
                                err,
                            ),
                        },
                    );
                    this.record = Promise.resolve(response[0]);
                    return response[0];
                } catch (error) {
                    if (!isRecoverableTransportInterruption(error)) {
                        this.invalidateCurrentTransport();
                    }
                    throw error;
                }
            }
            case 'v2': {
                const response = this.ensureV2ProjectResponse();
                if (response.generation !== generation) {
                    throw new SocketRequestError(
                        'stale_connection',
                        'Project response belongs to an older socket connection',
                        false,
                    );
                }
                try {
                    const projectResponse = response.promise.then(
                        project => ({kind: 'project' as const, project}),
                    );
                    const handshake = this.legacyV1Rejected ? projectResponse : Promise.race([
                        projectResponse,
                        this.waitUntilConnectionAccepted(generation).then(() => ({kind: 'legacy' as const})),
                    ]);
                    const result = await withTimeout(handshake, 'project handshake', ACK_TIMEOUT_MS);
                    if (result.kind === 'legacy') {
                        // Older self-hosted servers accept the transport first and
                        // require an explicit joinProject request on a v1 socket.
                        this.scheme = 'v1';
                        this.invalidateCurrentTransport();
                        throw new SocketRequestError(
                            'stale_connection',
                            'Server selected the legacy project join protocol',
                            false,
                        );
                    }
                    this.record = Promise.resolve(result.project);
                    return result.project;
                } catch (error) {
                    // A connected transport which times out or is explicitly
                    // rejected is not reusable. A normal disconnect is left to
                    // socket.io's automatic reconnect on the same socket.
                    if (!isRecoverableTransportInterruption(error)) {
                        this.invalidateCurrentTransport();
                    }
                    throw error;
                }
            }
        }
    }

    /**
     * Reference: services/web/frontend/js/ide/editor/Document.js#L500
     * @param {string} docId - The document id.
     * @returns {Promise}
     */
    async joinDoc(docId:string) {
        return this.queueDocumentMembership(() =>
            this.request<[Array<string>, number, Array<any>, any]>('joinDoc', [docId, { encodeRanges: true }])
        )
            .then((returns: [Array<string>, number, Array<any>, any]) => {
                const [docLinesAscii, version, updates, ranges] = returns;
                const docLines = docLinesAscii.map((line) => decodePackedUtf8(line));
                return {docLines, version, updates, ranges};
            });
    }

    /**
     * Reference: services/web/frontend/js/ide/editor/Document.js#L591
     * @param {string} docId - The document id.
     * @returns {Promise}
     */
    async leaveDoc(docId:string) {
        return this.queueDocumentMembership(() => this.request<any[]>('leaveDoc', [docId]))
            .then(() => {
                return;
            });
    }

    /**
     * Reference: services/web/frontend/js/ide/editor/ShareJsDocs.js#L78
     * @param {string} docId - The document id.
     * @param {any} update - The changes.
     * @returns {Promise}
     */
    async applyOtUpdate(docId:string, update:UpdateSchema) {
        return this.request<any[]>('applyOtUpdate', [docId, update])
            .then(() => {
                return;
            });
    }

    /**
     * Reference: services/web/frontend/js/ide/online-users/OnlineUserManager.js#L42
     * @returns {Promise}
     */
    async getConnectedUsers(): Promise<OnlineUserSchema[]> {
        return this.request<[OnlineUserSchema[]]>('clientTracking.getConnectedUsers', [])
            .then((returns:[OnlineUserSchema[]]) => {
                const [connectedUsers] = returns;
                return connectedUsers;
            });
    }

    /**
     * Reference: services/web/frontend/js/ide/online-users/OnlineUserManager.js#L150
     * @param {string} docId - The document id.
     * @returns {Promise}
     */
    async updatePosition(doc_id:string, row:number, column:number) {
        if (this._socketInitScheme === 'Alt') {
            await this.request<any[]>('clientTracking.updatePosition', [{row, column, doc_id}]);
            return;
        }
        const generation = await this.waitUntilConnected();
        if (generation !== this.socketGeneration) {
            throw new SocketRequestError(
                'stale_connection',
                'Socket connection changed before updating the cursor position',
                false,
            );
        }
        // Overleaf does not acknowledge this fire-and-forget presence update.
        this.socket.emit('clientTracking.updatePosition', {row, column, doc_id});
    }
}
