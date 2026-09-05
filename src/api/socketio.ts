/* eslint-disable @typescript-eslint/naming-convention */
import { Identity, BaseAPI, ProjectMessageResponseSchema } from './base';
import { FileEntity, DocumentEntity, FileRefEntity, FileType, FolderEntity, ProjectEntity } from '../core/remoteFileSystemProvider';
import {
    isRecoverableTransportInterruption,
    requestWithAck,
    SocketRequestError,
    withTimeout,
} from './socketRequest';
import {
    JsonValue,
    parseHistoryOtSnapshot,
    serializeHistoryOtSnapshot,
} from '../core/historyOt';
import {deepCloneJson, isJsonObject} from '../core/historyOt/protocol';
import type {
    HistoryOtSession,
    HistoryOtThreadEventName,
    HistoryOtWriteIntent,
} from '../core/historyOtSession';
import {parseHistoryOtRealtimeEnvelope} from '../core/historyOtSession';
import {hasUnsupportedOverleafTextInsertion} from '../core/documentUpdate';

function decodePackedUtf8(text: string): string {
    return Buffer.from(text, 'latin1').toString('utf-8');
}

export interface UpdateUserSchema {
    id: string,
    user_id: string,
    name: string,
    email: string,
    doc_id?: string,
    row?: number,
    column?: number,
    last_updated_at?: number, //unix timestamp
}

export interface OnlineUserSchema {
    client_age: number,
    client_id: string,
    connected: boolean,
    cursorData?: {
        column?: number,
        doc_id?: string,
        row?: number,
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

export interface ShareJsDocumentJoin {
    readonly otType: 'sharejs-text-ot',
    readonly docLines: string[],
    readonly version: number,
    readonly updates: unknown[],
    readonly ranges: unknown,
}

export interface HistoryOtDocumentJoin {
    readonly otType: 'history-ot',
    readonly snapshot: JsonValue,
    readonly version: number,
    readonly updates: JsonValue[],
    readonly ranges: JsonValue,
}

export type DocumentJoin = ShareJsDocumentJoin | HistoryOtDocumentJoin;

export type PermissionsLevel = 'owner' | 'readAndWrite' | 'review' | 'readOnly';

export interface ProjectSessionSchema {
    publicId: string,
    permissionsLevel?: PermissionsLevel,
    protocolVersion?: number,
    generation: number,
}

export type ProjectSenderWitness = Pick<ProjectSessionSchema, 'publicId' | 'generation'>;

export interface OtUpdateErrorSchema {
    message: string,
    projectId?: string,
    docId?: string,
    details?: unknown,
}

export type RealtimeFatalErrorCode =
    | 'access_revoked'
    | 'force_disconnect'
    | 'protocol_changed'
    | 'project_unavailable'
    | 'sender_changed'
    | 'unsupported_history_ot';

export class RealtimeFatalError extends Error {
    readonly retryable = false;

    constructor(
        public readonly code: RealtimeFatalErrorCode,
        message: string,
        public readonly details?: unknown,
    ) {
        super(message);
        this.name = 'RealtimeFatalError';
    }
}

export interface EventsHandler {
    onFileCreated?: (parentFolderId:string, type:FileType, entity:FileEntity) => void,
    onFileRenamed?: (entityId:string, newName:string) => void,
    onFileRemoved?: (entityId:string) => void,
    onFileMoved?: (entityId:string, newParentFolderId:string) => void,
    // Kept intentionally untyped at this transport boundary: ShareJS and
    // History OT have distinct wire shapes and consumers must select/parser-gate
    // the active document kind before interpreting the raw payload.
    onFileChanged?: (update:unknown, sender?: ProjectSenderWitness) => void,
    //
    onDisconnected?: () => void,
    onConnectionAccepted?: (publicId:string) => void,
    onProjectJoined?: (session:ProjectSessionSchema) => void,
    onOtUpdateError?: (error:OtUpdateErrorSchema) => void,
    onFatalError?: (error:RealtimeFatalError) => void,
    onPermissionsInvalidated?: () => void,
    onHistoryOtThreadEvent?: (event:HistoryOtThreadEventName, args:unknown[]) => void,
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

type ProjectJoinResponse = {
    project: ProjectEntity,
    publicId?: string,
    permissionsLevel?: PermissionsLevel,
    protocolVersion?: number,
};

type ProjectJoinResponseWitness = {
    projectId?: string,
    publicId?: string,
    protocolVersion?: number,
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
const SUPPORTED_PLAIN_OT_PROTOCOL_VERSION = 2;

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
    private retiredSocket?: any;
    private transportConnectedSignal = deferred<number>();
    private connectionAcceptedSignal = deferred<{generation: number, publicId: string}>();
    private connectionAcceptedGeneration?: number;
    private v2ProjectResponse?: Deferred<ProjectJoinResponse> & {
        generation: number,
        witness?: ProjectJoinResponseWitness,
    };
    private documentMembershipQueue: Promise<void> = Promise.resolve();
    private legacyV1Rejected = false;
    private legacyProbeAttempted = false;
    private legacyV1Confirmed = false;
    private readonly legacyFallbackAllowed: boolean;
    private realtimeSchemeBeforeAlternative: Exclude<ConnectionScheme, 'Alt'> = 'v2';
    private pollingFallbackAttempts = 0;
    private disposed = false;
    private currentPublicId?: string;
    private currentPermissionsLevel?: PermissionsLevel;
    private lastKnownPermissionsLevel?: PermissionsLevel;
    private currentProtocolVersion?: number;
    private lastKnownProtocolVersion?: number;
    private joinedGeneration?: number;
    private terminalFailure?: RealtimeFatalError;
    private readonly disconnectedNotifications = new WeakSet<object>();

    constructor(private url:string,
                private readonly api:BaseAPI,
                private readonly identity:Identity,
                private readonly projectId:string)
    {
        const hostname = new URL(url).hostname.toLowerCase();
        // Hosted Overleaf requires projectId on the handshake. Never probe it
        // with the queryless legacy protocol, even after a slow v2 response.
        this.legacyFallbackAllowed =
            hostname !== 'overleaf.com' && !hostname.endsWith('.overleaf.com');
        this.init();
    }

    init() {
        if (this.disposed) {
            throw new SocketRequestError('stale_connection', 'Socket session is disposed', false);
        }
        if (this.terminalFailure) {
            throw this.terminalFailure;
        }
        this.resetTransportState();

        // CRITICAL: Properly disconnect old socket before creating a new one.
        // Without this, the old TCP connection is abandoned but still alive. When the
        // server later sends data on it (out-of-order/late packets), the OS TCP stack
        // responds with RST, which can cause the server to drop ALL connections from
        // this client — explaining the "connection lost" loop reported in issue #309.
        if (this.socket) {
            try {
                this.retiredSocket = this.socket;
                this.stopSocketReconnect(this.socket);
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
                // The 0.9 client adds a fresh cache-busting timestamp itself.
                const query = new URLSearchParams({
                    projectId: this.projectId,
                    esh: '1',
                    ssp: '1',
                }).toString();
                this.socket = this.api._initSocketV0(this.identity, query);
                break;
        }
        const socketAtInit = this.socket;
        const managerAtInit = socketAtInit?.socket ?? socketAtInit?.io;
        const websocketDisabledForAttempt =
            this.scheme !== 'Alt' && this.pollingFallbackAttempts > 0;
        if (websocketDisabledForAttempt && managerAtInit?.options) {
            // A proxy-level WebSocket failure can leave the 0.9 session id
            // unusable before its slow transport fallback runs. Retry this one
            // connection with the polling transport, as Overleaf's client does.
            managerAtInit.options.transports = ['xhr-polling'];
            // The downgrade is one-shot. A polling failure must not permanently
            // lock out a self-hosted deployment which only allows WebSockets.
            this.pollingFallbackAttempts -= 1;
        }
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
        console.log('SocketIOAPI: initialized realtime transport', {
            scheme: this._socketInitScheme,
            generation: this.socketGeneration,
            projectQueryMatches: this.projectQueryMatches(socketAtInit),
            websocketDisabledForAttempt,
        });
        // Match Overleaf's connection order: configure the manager and attach
        // every listener before starting the asynchronous transport handshake.
        if (
            this.scheme !== 'Alt' &&
            managerAtInit &&
            !managerAtInit.connected &&
            !managerAtInit.connecting &&
            typeof managerAtInit.connect === 'function'
        ) {
            managerAtInit.connect();
        }
    }

    /** Returns true if the socket needs re-initialization (scheme changed, or socket was never init'd) */
    get needsReinit(): boolean {
        return !this.terminalFailure && (this._socketInitScheme !== this.scheme || !this.socket);
    }

    get isConnected(): boolean {
        return this.transportConnected;
    }

    get generation(): number {
        return this.socketGeneration;
    }

    get fatalError(): RealtimeFatalError | undefined {
        return this.terminalFailure;
    }

    get projectSession(): ProjectSessionSchema | undefined {
        if (this.joinedGeneration === undefined || this.currentPublicId === undefined) { return undefined; }
        return {
            publicId: this.currentPublicId,
            permissionsLevel: this.currentPermissionsLevel,
            protocolVersion: this.currentProtocolVersion,
            generation: this.joinedGeneration,
        };
    }

    private stopSocketReconnect(socket: any) {
        const manager = socket?.socket ?? socket?.io;
        if (!manager) { return; }
        if (manager.options) {
            manager.options.reconnect = false;
        }
        if (typeof manager.reconnection === 'function') {
            manager.reconnection(false);
        }
        for (const timerName of ['reconnectionTimer', 'reconnectTimer']) {
            if (manager[timerName]) {
                clearTimeout(manager[timerName]);
                delete manager[timerName];
            }
        }
        manager.reconnecting = false;
        manager._reconnecting = false;
    }

    private projectQueryMatches(socket: any): boolean {
        if ((this._socketInitScheme ?? this.scheme) !== 'v2') { return true; }
        const manager = socket?.socket ?? socket?.io;
        const rawQuery = manager?.options?.query;
        if (typeof rawQuery !== 'string') { return false; }
        return new URLSearchParams(rawQuery).get('projectId') === this.projectId;
    }

    private projectQueryDiagnostics(socket: any) {
        const manager = socket?.socket ?? socket?.io;
        const rawQuery = manager?.options?.query;
        const configuredProjectId = typeof rawQuery === 'string' ?
            new URLSearchParams(rawQuery).get('projectId') : null;
        const objectIdPattern = /^[0-9a-f]{24}$/i;
        return {
            projectQueryMatches: configuredProjectId === this.projectId,
            expectedProjectIdValid: objectIdPattern.test(this.projectId),
            configuredProjectIdPresent: configuredProjectId !== null,
            configuredProjectIdValid: configuredProjectId !== null && objectIdPattern.test(configuredProjectId),
        };
    }

    invalidateCurrentTransport() {
        // Fatal failures own their user-facing terminal path. Do not additionally
        // publish an ordinary disconnect, which would make the VFS retry forever.
        this.retireCurrentTransport(!this.terminalFailure);
    }

    private notifyDisconnected(socket: any) {
        if (typeof socket !== 'object' || socket === null) { return; }
        if (this.disconnectedNotifications.has(socket)) { return; }
        this.disconnectedNotifications.add(socket);
        this._handlers.forEach(handler => handler.onDisconnected?.());
    }

    private retireCurrentTransport(notifyDisconnected: boolean, disconnectDelayMs: number = 0) {
        this._socketInitScheme = undefined;
        this.connectionAcceptedGeneration = undefined;
        this.joinedGeneration = undefined;
        this.currentProtocolVersion = undefined;
        this.currentPermissionsLevel = this.scheme === 'Alt' ? this.lastKnownPermissionsLevel : undefined;

        const socket = this.socket;
        if (!socket) { return; }
        this.retiredSocket = socket;
        // Defensively cancel any reconnect loop which the legacy client may
        // already have scheduled; changing its option afterwards is insufficient.
        this.stopSocketReconnect(socket);
        // Invalidate the generation synchronously so late project/identity events
        // cannot become authoritative while the outer retry is backing off.
        if (this.lastDisconnectedSocket !== socket) {
            this.markTransportDisconnected(socket);
        }
        if (notifyDisconnected) {
            this.notifyDisconnected(socket);
        }
        setTimeout(() => socket.disconnect?.(), disconnectDelayMs);
    }

    private terminateRealtime(
        code: RealtimeFatalErrorCode,
        message: string,
        details?: unknown,
        disconnectDelayMs: number = 0,
    ): RealtimeFatalError {
        if (this.terminalFailure) { return this.terminalFailure; }
        const failure = new RealtimeFatalError(code, message, details);
        this.terminalFailure = failure;
        this.retireCurrentTransport(false, disconnectDelayMs);
        this._handlers.forEach(handler => handler.onFatalError?.(failure));
        return failure;
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
        this.connectionAcceptedGeneration = undefined;
        this.currentPublicId = undefined;
        this.currentProtocolVersion = undefined;
        this.currentPermissionsLevel = this.scheme === 'Alt' ? this.lastKnownPermissionsLevel : undefined;
        this.joinedGeneration = undefined;
        this.rejectV2ProjectResponse(new SocketRequestError(
            'stale_connection',
            'Socket transport was replaced',
            true,
        ));
    }

    private markTransportConnected(socket: any): boolean {
        if (socket !== this.socket || socket === this.retiredSocket || this.transportConnected) { return false; }
        this.lastDisconnectedSocket = undefined;
        this.transportConnected = true;
        this.transportConnectedSignal.resolve(this.socketGeneration);
        if (this.scheme === 'v2') {
            this.ensureV2ProjectResponse();
        }
        return true;
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
        this.connectionAcceptedGeneration = undefined;
        this.currentPublicId = undefined;
        this.currentProtocolVersion = undefined;
        this.currentPermissionsLevel = undefined;
        this.joinedGeneration = undefined;
        this.rejectV2ProjectResponse(new SocketRequestError(
            'disconnected',
            'Socket disconnected before the project session was ready',
            true,
        ));
    }

    private ensureV2ProjectResponse() {
        if (!this.v2ProjectResponse || this.v2ProjectResponse.generation !== this.socketGeneration) {
            this.v2ProjectResponse = {
                ...deferred<ProjectJoinResponse>(),
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
        if (this.terminalFailure) {
            throw this.terminalFailure;
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

    private senderWitnessMatches(expected: ProjectSenderWitness): boolean {
        const session = this.projectSession;
        return Boolean(
            session
            && session.publicId === expected.publicId
            && session.generation === expected.generation
            && this.socketGeneration === expected.generation
            && this.transportConnected
        );
    }

    private async request<T extends any[]>(
        event: string,
        args: any[],
        timeoutMs: number = ACK_TIMEOUT_MS,
        expectedSender?: ProjectSenderWitness,
        authorizeImmediatelyBeforeEmit?: () => void,
    ): Promise<T> {
        if (expectedSender && !this.senderWitnessMatches(expectedSender)) {
            throw new SocketRequestError(
                'stale_connection',
                'Realtime sender identity changed before the request could be sent',
                false,
            );
        }
        const generation = await this.waitUntilConnected();
        const socketAtEmit = this.socket;
        if (expectedSender && !this.senderWitnessMatches(expectedSender)) {
            throw new SocketRequestError(
                'stale_connection',
                'Realtime sender identity changed while preparing the request',
                false,
            );
        }
        // No await may occur between this authorization hook and
        // requestWithAck's synchronous emit. History OT uses it to close the
        // permission/session invalidation window opened by waitUntilConnected.
        authorizeImmediatelyBeforeEmit?.();
        return requestWithAck<T>(
            socketAtEmit,
            event,
            args,
            timeoutMs,
            generation,
            (candidate) => candidate === this.socketGeneration
                && socketAtEmit === this.socket
                && (!expectedSender || this.senderWitnessMatches(expectedSender)),
        );
    }

    private queueDocumentMembership<T>(operation: () => Promise<T>): Promise<T> {
        const queued = this.documentMembershipQueue.catch(() => {}).then(operation);
        this.documentMembershipQueue = queued.then(() => {}, () => {});
        return queued;
    }

    private acceptPublicId(socket: any, publicId: unknown): boolean {
        if (
            socket !== this.socket ||
            socket === this.retiredSocket ||
            !this.transportConnected
        ) { return false; }
        const normalizedPublicId = String(publicId ?? '');
        const activeScheme = this._socketInitScheme ?? this.scheme;
        // The HTTP-backed Invisible Mode has no realtime public id, but its
        // synthetic transport still needs an accepted project-session barrier.
        if (!normalizedPublicId && activeScheme !== 'Alt') { return false; }
        if (
            this.connectionAcceptedGeneration === this.socketGeneration &&
            this.currentPublicId !== normalizedPublicId
        ) {
            this.terminateRealtime(
                'sender_changed',
                `Realtime sender changed from ${String(this.currentPublicId)} to ${normalizedPublicId} within one socket generation`,
                {
                    generation: this.socketGeneration,
                    expectedPublicId: this.currentPublicId,
                    receivedPublicId: normalizedPublicId,
                },
            );
            return false;
        }
        const alreadyAccepted =
            this.connectionAcceptedGeneration === this.socketGeneration &&
            this.currentPublicId === normalizedPublicId;
        this.connectionAcceptedGeneration = this.socketGeneration;
        this.currentPublicId = normalizedPublicId;
        this.connectionAcceptedSignal.resolve({
            generation: this.socketGeneration,
            publicId: normalizedPublicId,
        });
        const projectResponse = this.v2ProjectResponse;
        if (
            projectResponse?.generation === this.socketGeneration &&
            projectResponse.witness !== undefined &&
            projectResponse.witness.publicId === undefined
        ) {
            projectResponse.witness.publicId = normalizedPublicId;
        }
        if (!alreadyAccepted) {
            this._handlers.forEach(handler => handler.onConnectionAccepted?.(normalizedPublicId));
        }
        return true;
    }

    private finalizeProjectJoin(
        response: ProjectJoinResponse,
        generation: number,
        expectedProjectId: string,
        fallbackPublicId?: string,
    ): ProjectEntity {
        if (this.terminalFailure) {
            throw this.terminalFailure;
        }
        const receivedProjectId = response.project?._id;
        if (receivedProjectId !== expectedProjectId) {
            throw this.terminateRealtime(
                'project_unavailable',
                `Project join returned ${String(receivedProjectId)} instead of ${expectedProjectId}`,
                {expectedProjectId, receivedProjectId},
            );
        }
        const publicId = response.publicId ?? fallbackPublicId ?? this.currentPublicId;
        const activeScheme = this._socketInitScheme ?? this.scheme;
        if (
            publicId === undefined ||
            (!publicId && activeScheme !== 'Alt') ||
            generation !== this.socketGeneration ||
            !this.transportConnected
        ) {
            throw new SocketRequestError(
                'stale_connection',
                'Project session changed before join completion',
                false,
            );
        }
        if (
            this.connectionAcceptedGeneration !== generation ||
            this.currentPublicId !== publicId
        ) {
            throw this.terminateRealtime(
                'sender_changed',
                'Realtime sender identity changed before project join completion',
                {
                    generation,
                    expectedPublicId: publicId,
                    receivedPublicId: this.currentPublicId,
                },
            );
        }
        if (
            this.lastKnownProtocolVersion !== undefined &&
            response.protocolVersion !== undefined &&
            this.lastKnownProtocolVersion !== response.protocolVersion
        ) {
            throw this.terminateRealtime(
                'protocol_changed',
                `Realtime protocol changed from ${this.lastKnownProtocolVersion} to ${response.protocolVersion}`,
                response,
            );
        }
        this.currentProtocolVersion = response.protocolVersion;
        if (response.protocolVersion !== undefined) {
            this.lastKnownProtocolVersion = response.protocolVersion;
        }
        const permissionsLevel = response.permissionsLevel ??
            (activeScheme === 'Alt' ? this.currentPermissionsLevel ?? this.lastKnownPermissionsLevel : undefined);
        this.currentPermissionsLevel = permissionsLevel;
        if (permissionsLevel !== undefined) {
            this.lastKnownPermissionsLevel = permissionsLevel;
        }
        this.joinedGeneration = generation;
        const session: ProjectSessionSchema = {
            publicId,
            permissionsLevel,
            protocolVersion: this.currentProtocolVersion,
            generation,
        };
        this._handlers.forEach(handler => handler.onProjectJoined?.(session));
        return response.project;
    }

    private normalizeOtUpdateError(error: unknown, details?: any): OtUpdateErrorSchema {
        const message = String(details?.error ?? (error instanceof Error ? error.message : error) ?? 'Unknown OT update error');
        return {
            message,
            projectId: typeof details?.project_id === 'string' ? details.project_id : undefined,
            docId: typeof details?.doc_id === 'string' ? details.doc_id : undefined,
            details,
        };
    }

    private initInternalHandlers(socketAtInit: any) {
        socketAtInit.on('connect', () => {
            if (this.markTransportConnected(socketAtInit)) {
                this.pollingFallbackAttempts = 0;
                console.log('SocketIOAPI: connected');
            }
        });
        socketAtInit.on('disconnect', () => {
            const wasCurrent =
                !this.disposed &&
                !this.terminalFailure &&
                socketAtInit === this.socket &&
                socketAtInit !== this.retiredSocket;
            if (wasCurrent) {
                this.markTransportDisconnected(socketAtInit);
                // Do not enter socket.io 0.9's automatic reconnect loop. Retire
                // the failed transport; the VFS single-flight retry creates a
                // clean replacement after this disconnect event is delivered.
                this.retiredSocket = socketAtInit;
                this._socketInitScheme = undefined;
                this.stopSocketReconnect(socketAtInit);
                this.notifyDisconnected(socketAtInit);
            }
        });
        socketAtInit.on('connectionAccepted', (_:any, publicId:any) => {
            this.acceptPublicId(socketAtInit, publicId);
        });
        socketAtInit.on('connect_failed', () => {
            console.log('SocketIOAPI: connect_failed');
            if (
                !this.disposed &&
                socketAtInit === this.socket &&
                socketAtInit !== this.retiredSocket
            ) {
                this.invalidateCurrentTransport();
            }
        });
        socketAtInit.on('serverPing', (...ping: any[]) => {
            if (socketAtInit !== this.socket || socketAtInit === this.retiredSocket) { return; }
            const manager = socketAtInit?.socket ?? socketAtInit?.io;
            socketAtInit.emit(
                'clientPong',
                ping[0],
                ping[1],
                ping[2],
                ping[3],
                manager?.transport?.name,
                manager?.sessionid,
            );
        });
        socketAtInit.on('reconnectGracefully', () => {
            if (
                this.disposed ||
                this.terminalFailure ||
                socketAtInit !== this.socket ||
                socketAtInit === this.retiredSocket
            ) { return; }
            console.log('SocketIOAPI: server requested a graceful reconnect');
            // The server already drains clients in bounded batches. Retiring this
            // generation once lets the VFS recover pending OT through its normal
            // deduplicated path without enabling socket.io's own reconnect loop.
            this.retireCurrentTransport(true);
        });
        socketAtInit.on('forceDisconnect', (message:string, delay=10) => {
            console.log('SocketIOAPI: forceDisconnect', message);
            if (socketAtInit !== this.socket || socketAtInit === this.retiredSocket) { return; }
            const delaySeconds = Number.isFinite(Number(delay)) ? Math.max(0, Number(delay)) : 10;
            this.terminateRealtime(
                'force_disconnect',
                String(message || 'The realtime server forced this session to disconnect'),
                {message, delaySeconds},
                delaySeconds * 1000,
            );
        });
        socketAtInit.on('project:access:revoked', () => {
            if (socketAtInit !== this.socket || socketAtInit === this.retiredSocket) { return; }
            this.terminateRealtime(
                'access_revoked',
                'Access to this Overleaf project was revoked',
            );
        });
        const invalidatePermissions = () => {
            if (socketAtInit !== this.socket || socketAtInit === this.retiredSocket) { return; }
            this.currentPermissionsLevel = undefined;
            this.lastKnownPermissionsLevel = undefined;
            this._handlers.forEach(handler => handler.onPermissionsInvalidated?.());
        };
        socketAtInit.on('project:membership:changed', invalidatePermissions);
        socketAtInit.on('project:collaboratorAccessLevel:changed', invalidatePermissions);
        socketAtInit.on('project:publicAccessLevel:changed', invalidatePermissions);
        socketAtInit.on('otUpdateError', (error:any, details:any) => {
            if (socketAtInit !== this.socket || socketAtInit === this.retiredSocket) { return; }
            const updateError = this.normalizeOtUpdateError(error, details);
            this._handlers.forEach(handler => handler.onOtUpdateError?.(updateError));
            // Official Overleaf disconnects immediately after this event. Retire
            // synchronously so no further save can be sent in the gap, and notify
            // the ordinary recovery path exactly once.
            this.retireCurrentTransport(true);
        });
        socketAtInit.on('connectionRejected', (err:any) => {
            if (socketAtInit !== this.socket || socketAtInit === this.retiredSocket) { return; }
            const message = String(err?.message || err);
            console.log('SocketIOAPI: connectionRejected.', message, {
                scheme: this._socketInitScheme ?? this.scheme,
                generation: this.socketGeneration,
                ...this.projectQueryDiagnostics(socketAtInit),
            });
            const rejection = new SocketRequestError(
                'server_error',
                `Project connection rejected: ${message}`,
                false,
                err,
            );
            this.rejectV2ProjectResponse(rejection);
            const activeScheme = this._socketInitScheme ?? this.scheme;
            // A rejected legacy probe is not useful to repeat with the same
            // parameters. Return monotonically to the project-query protocol.
            if (activeScheme === 'v1') {
                this.legacyV1Rejected = true;
                this.scheme = 'v2';
            }
            if (/^(?:not authorized|invalid session|project not found)$/i.test(message)) {
                this.terminateRealtime(
                    'project_unavailable',
                    `Project connection rejected: ${message}`,
                    err,
                );
            } else {
                this.invalidateCurrentTransport();
            }
        });
        socketAtInit.on('error', (err:any) => {
            if (socketAtInit !== this.socket || socketAtInit === this.retiredSocket) { return; }
            const message = String(err?.message || err);
            console.error('SocketIOAPI: socket error', message, {
                scheme: this._socketInitScheme ?? this.scheme,
                generation: this.socketGeneration,
                ...this.projectQueryDiagnostics(socketAtInit),
            });
            const activeScheme = this._socketInitScheme ?? this.scheme;
            const invalidHandshake = /client not handshaken/i.test(message);
            const websocketProxyFailure = /unexpected server response \(5\d\d\)/i.test(message);
            const manager = socketAtInit?.socket ?? socketAtInit?.io;
            // An HTTP handshake error in socket.io 0.9 clears `connecting`
            // before emitting a plain response body such as "Bad Gateway".
            // A WebSocket transport error keeps `connecting` true while its
            // built-in transport fallback is still viable.
            const terminalBeforeTransport =
                !this.transportConnected &&
                manager?.connected !== true &&
                manager?.connecting !== true;
            if (invalidHandshake || websocketProxyFailure || terminalBeforeTransport) {
                if (invalidHandshake && activeScheme === 'v1') {
                    this.legacyV1Rejected = true;
                    this.scheme = 'v2';
                }
                if (websocketProxyFailure) {
                    this.pollingFallbackAttempts = 1;
                }
                this.invalidateCurrentTransport();
            }
        });

        if (this.scheme==='v2') {
            socketAtInit.on('joinProjectResponse', (res:any) => {
                if (
                    socketAtInit !== this.socket ||
                    socketAtInit === this.retiredSocket ||
                    !this.transportConnected
                ) { return; }
                const response: ProjectJoinResponse = {
                    publicId: typeof res?.publicId === 'string' ? res.publicId : undefined,
                    project: res?.project as ProjectEntity,
                    permissionsLevel: res?.permissionsLevel,
                    protocolVersion: typeof res?.protocolVersion === 'number' ? res.protocolVersion : undefined,
                };
                const pendingResponse = this.ensureV2ProjectResponse();
                const witness: ProjectJoinResponseWitness = {
                    projectId: response.project?._id,
                    publicId: response.publicId ?? this.currentPublicId,
                    protocolVersion: response.protocolVersion,
                };
                const priorWitness = pendingResponse.witness;
                if (priorWitness) {
                    if (priorWitness.projectId !== witness.projectId) {
                        this.terminateRealtime(
                            'project_unavailable',
                            'Realtime project identity changed within one socket generation',
                            {
                                generation: this.socketGeneration,
                                expectedProjectId: priorWitness.projectId,
                                receivedProjectId: witness.projectId,
                            },
                        );
                        return;
                    }
                    if (priorWitness.publicId !== witness.publicId) {
                        this.terminateRealtime(
                            'sender_changed',
                            'Realtime sender identity changed within one socket generation',
                            {
                                generation: this.socketGeneration,
                                expectedPublicId: priorWitness.publicId,
                                receivedPublicId: witness.publicId,
                            },
                        );
                        return;
                    }
                    if (priorWitness.protocolVersion !== witness.protocolVersion) {
                        this.terminateRealtime(
                            'protocol_changed',
                            'Realtime protocol changed within one socket generation',
                            {
                                generation: this.socketGeneration,
                                expectedProtocolVersion: priorWitness.protocolVersion,
                                receivedProtocolVersion: witness.protocolVersion,
                            },
                        );
                        return;
                    }
                } else {
                    pendingResponse.witness = witness;
                }
                if (response.publicId !== undefined && !this.acceptPublicId(socketAtInit, response.publicId)) {
                    return;
                }
                pendingResponse.resolve(response);
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
        this.retiredSocket = socket;
        this.stopSocketReconnect(socket);
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
        this.connectionAcceptedGeneration = undefined;
        this.rejectV2ProjectResponse(error);
        this.transportConnected = false;
        this.lastDisconnectedSocket = undefined;
        this.currentPublicId = undefined;
        this.currentPermissionsLevel = undefined;
        this.joinedGeneration = undefined;
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
        if (this.scheme === 'Alt') {
            this.scheme = this.realtimeSchemeBeforeAlternative;
        } else {
            this.realtimeSchemeBeforeAlternative = this.scheme;
            this.scheme = 'Alt';
        }
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
        const socketAtRegistration = this.socket;
        const generationAtRegistration = this.socketGeneration;
        if (!socketAtRegistration) { return; }
        const active = <Args extends unknown[]>(callback: (...args: Args) => void) =>
            (...args: Args) => {
                if (
                    this.disposed ||
                    socketAtRegistration !== this.socket ||
                    socketAtRegistration === this.retiredSocket ||
                    generationAtRegistration !== this.socketGeneration
                ) { return; }
                callback(...args);
            };
        Object.values(handlers).forEach((handler) => {
            switch (handler) {
                case handlers.onFileCreated:
                    socketAtRegistration.on('reciveNewDoc', active((parentFolderId:string, doc:DocumentEntity) => {
                        handler(parentFolderId, 'doc', doc);
                    }));
                    socketAtRegistration.on('reciveNewFile', active((parentFolderId:string, file:FileRefEntity) => {
                        handler(parentFolderId, 'file', file);
                    }));
                    socketAtRegistration.on('reciveNewFolder', active((parentFolderId:string, folder:FolderEntity) => {
                        handler(parentFolderId, 'folder', folder);
                    }));
                    break;
                case handlers.onFileRenamed:
                    socketAtRegistration.on('reciveEntityRename', active((entityId:string, newName:string) => {
                        handler(entityId, newName);
                    }));
                    break;
                case handlers.onFileRemoved:
                    socketAtRegistration.on('removeEntity', active((entityId:string) => {
                        handler(entityId);
                    }));
                    break;
                case handlers.onFileMoved:
                    socketAtRegistration.on('reciveEntityMove', active((entityId:string, folderId:string) => {
                        handler(entityId, folderId);
                    }));
                    break;
                case handlers.onFileChanged: {
                    socketAtRegistration.on('otUpdateApplied', active((update: unknown) => {
                        const session = this.projectSession;
                        const sender = session?.generation === this.socketGeneration ? {
                                publicId: session.publicId,
                                generation: session.generation,
                            } : undefined;
                        handler(update, sender);
                    }));
                    break;
                }
                case handlers.onDisconnected:
                case handlers.onConnectionAccepted:
                case handlers.onProjectJoined:
                case handlers.onOtUpdateError:
                case handlers.onFatalError:
                case handlers.onPermissionsInvalidated:
                    // Internal handlers dispatch these lifecycle events after
                    // validating the active socket generation.
                    break;
                case handlers.onHistoryOtThreadEvent:
                    for (const event of [
                        'new-comment',
                        'edit-message',
                        'delete-message',
                        'resolve-thread',
                        'reopen-thread',
                        'delete-thread',
                        'new-comment-threads',
                    ] as const) {
                        socketAtRegistration.on(event, active((...args: unknown[]) => handler(event, args)));
                    }
                    break;
                case handlers.onClientUpdated:
                    socketAtRegistration.on('clientTracking.clientUpdated', active((user:UpdateUserSchema) => {
                        handler(user);
                    }));
                    break;
                case handlers.onClientDisconnected:
                    socketAtRegistration.on('clientTracking.clientDisconnected', active((id:string) => {
                        handler(id);
                    }));
                    break;
                case handlers.onReceivedMessage:
                    socketAtRegistration.on('new-chat-message', active((message:ProjectMessageResponseSchema) => {
                        handler(message);
                    }));
                    break;
                case handlers.onSpellCheckLanguageUpdated:
                    socketAtRegistration.on('spellCheckLanguageUpdated', active((language:string) => {
                        handler(language);
                    }));
                    break;
                case handlers.onCompilerUpdated:
                    socketAtRegistration.on('compilerUpdated', active((compiler:string) => {
                        handler(compiler);
                    }));
                    break;
                case handlers.onRootDocUpdated:
                    socketAtRegistration.on('rootDocUpdated', active((rootDocId:string) => {
                        handler(rootDocId);
                    }));
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
    async joinProject(project_id:string, timeoutMs: number = ACK_TIMEOUT_MS): Promise<ProjectEntity> {
        const generation = await this.waitUntilConnected();
        if (this.terminalFailure) {
            throw this.terminalFailure;
        }
        const activeScheme = this._socketInitScheme ?? this.scheme;
        switch(activeScheme) {
            case 'Alt':
            case 'v1': {
                try {
                    const publicId = await this.waitUntilConnectionAccepted(generation);
                    const socketAtJoin = this.socket;
                    const response = await requestWithAck<[ProjectEntity, string, number]>(
                        socketAtJoin,
                        'joinProject',
                        [{project_id}],
                        timeoutMs,
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
                    if (activeScheme === 'v1') {
                        this.legacyV1Confirmed = true;
                    }
                    const project = this.finalizeProjectJoin({
                        project: response[0],
                        publicId,
                        permissionsLevel: response[1] as PermissionsLevel | undefined,
                        protocolVersion: response[2],
                    }, generation, project_id, publicId);
                    this.record = Promise.resolve(project);
                    return project;
                } catch (error) {
                    const failedUnconfirmedLegacyProbe =
                        activeScheme === 'v1' &&
                        this.legacyProbeAttempted &&
                        !this.legacyV1Confirmed;
                    if (failedUnconfirmedLegacyProbe) {
                        // A legacy compatibility probe is strictly one-shot. Any
                        // unsuccessful v1 join returns to the project-query protocol.
                        this.legacyV1Rejected = true;
                        this.scheme = 'v2';
                    }
                    if (
                        failedUnconfirmedLegacyProbe ||
                        !isRecoverableTransportInterruption(error)
                    ) {
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
                    // Modern v2 servers can emit connectionAccepted before
                    // joinProjectResponse. Event order therefore cannot identify a
                    // legacy server: doing so would replace a valid project-query
                    // socket with a v1 socket that omits projectId.
                    const joinResponse = await withTimeout(response.promise, 'project handshake', timeoutMs);
                    const project = this.finalizeProjectJoin(joinResponse, generation, project_id);
                    this.record = Promise.resolve(project);
                    return project;
                } catch (error) {
                    const acceptedButNoProject =
                        error instanceof SocketRequestError &&
                        error.code === 'timeout' &&
                        this.legacyFallbackAllowed &&
                        !this.legacyV1Rejected &&
                        !this.legacyProbeAttempted &&
                        this.connectionAcceptedGeneration === generation &&
                        generation === this.socketGeneration &&
                        this.transportConnected;
                    if (acceptedButNoProject) {
                        // Older self-hosted servers accept the transport but require
                        // an explicit joinProject request on a v1 socket. Only make
                        // this compatibility fallback after the full v2 deadline.
                        this.legacyProbeAttempted = true;
                        this.scheme = 'v1';
                        this.invalidateCurrentTransport();
                        throw new SocketRequestError(
                            'stale_connection',
                            'Server selected the legacy project join protocol',
                            false,
                        );
                    }
                    // A connected transport which times out or is explicitly
                    // rejected is not reusable. Disconnects are also retired by
                    // the transport handler and replaced by the VFS retry loop.
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
    async joinDoc(docId:string): Promise<DocumentJoin> {
        try {
            const activeScheme = this._socketInitScheme ?? this.scheme;
            const supportsHistoryOt = activeScheme !== 'Alt';
            return await this.queueDocumentMembership(() =>
                this.request<[unknown, number, unknown[], unknown, string?]>(
                    'joinDoc',
                    [docId, {
                        encodeRanges: true,
                        ...(supportsHistoryOt ? {supportsHistoryOT: true} : {}),
                    }],
                )
            )
            .then((returns): DocumentJoin => {
                const [rawDocument, version, rawUpdates, ranges, type = 'sharejs-text-ot'] = returns;
                if (!Number.isSafeInteger(version) || version < 0 || !Array.isArray(rawUpdates)) {
                    throw this.terminateRealtime(
                        'unsupported_history_ot',
                        `Document ${docId} returned an unsafe join response`,
                        {docId, version, type},
                    );
                }
                if (type === 'history-ot') {
                    if (!supportsHistoryOt) {
                        throw this.terminateRealtime(
                            'unsupported_history_ot',
                            `Document ${docId} requires History OT on an unsupported connection mode`,
                            {docId, type, activeScheme},
                        );
                    }
                    try {
                        const snapshot = parseHistoryOtSnapshot(rawDocument);
                        const preservedRanges = deepCloneJson(ranges);
                        const updates = rawUpdates.map(update => deepCloneJson(update));
                        if (!snapshot.safe || !isJsonObject(preservedRanges)) {
                            throw new Error([
                                ...snapshot.unsafeReasons,
                                ...(!isJsonObject(preservedRanges) ? ['ranges must be a JSON object'] : []),
                            ].join('; '));
                        }
                        return {
                            otType: 'history-ot',
                            snapshot: serializeHistoryOtSnapshot(snapshot),
                            version,
                            updates,
                            ranges: preservedRanges,
                        };
                    } catch (error) {
                        throw this.terminateRealtime(
                            'unsupported_history_ot',
                            `Document ${docId} returned an unsafe History OT join response`,
                            {docId, reason: error instanceof Error ? error.message : String(error)},
                        );
                    }
                }
                if (type !== 'sharejs-text-ot'
                    || !Array.isArray(rawDocument)
                    || !rawDocument.every(line => typeof line === 'string')) {
                    throw this.terminateRealtime(
                        'unsupported_history_ot',
                        `Document ${docId} uses unsupported or malformed OT type ${type}`,
                        {docId, type},
                    );
                }
                const docLines = rawDocument.map((line) => decodePackedUtf8(line));
                return {otType: 'sharejs-text-ot', docLines, version, updates: rawUpdates, ranges};
            });
        } catch (error) {
            if (
                error instanceof SocketRequestError &&
                /history-ot|does not support history/i.test(error.message)
            ) {
                throw this.terminateRealtime(
                    'unsupported_history_ot',
                    `Document ${docId} requires History OT / Track Changes support`,
                    error,
                );
            }
            throw error;
        }
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
    async applyOtUpdate(
        docId:string,
        update:UpdateSchema,
        expectedSender: ProjectSenderWitness,
    ) {
        if (hasUnsupportedOverleafTextInsertion(update.op ?? [])) {
            throw new SocketRequestError(
                'server_error',
                'Overleaf cannot store NUL or non-BMP characters in text updates',
                false,
            );
        }
        const activeScheme = this._socketInitScheme ?? this.scheme;
        if (this.projectSession?.protocolVersion !== SUPPORTED_PLAIN_OT_PROTOCOL_VERSION) {
            throw new SocketRequestError(
                'server_error',
                'Plain OT writes require an explicit current-generation protocol version',
                false,
            );
        }
        if (this.currentPermissionsLevel === 'readOnly' || this.currentPermissionsLevel === 'review') {
            throw new SocketRequestError(
                'server_error',
                this.currentPermissionsLevel === 'review' ?
                    'Plain OT writes are disabled for review-only sessions because Track Changes is not supported' :
                    'This realtime project session does not have write permission',
                false,
                {permissionsLevel: this.currentPermissionsLevel, docId},
            );
        }
        if (
            activeScheme !== 'Alt' &&
            this.currentPermissionsLevel !== 'owner' &&
            this.currentPermissionsLevel !== 'readAndWrite'
        ) {
            throw new SocketRequestError(
                'server_error',
                'This realtime project session does not have write permission',
                false,
                {permissionsLevel: this.currentPermissionsLevel, docId},
            );
        }
        return this.request<any[]>('applyOtUpdate', [docId, update], ACK_TIMEOUT_MS, expectedSender)
            .then(() => {
                return;
            });
    }

    async applyHistoryOtUpdate(
        docId: string,
        update: JsonValue,
        intent: HistoryOtWriteIntent,
        submissionToken: string,
        session: HistoryOtSession,
        expectedSender: ProjectSenderWitness,
    ): Promise<void> {
        const activeScheme = this._socketInitScheme ?? this.scheme;
        if (activeScheme === 'Alt') {
            throw new SocketRequestError(
                'server_error',
                'History OT is unavailable in the alternative connection mode',
                false,
                {docId, activeScheme},
            );
        }
        if (this.projectSession?.protocolVersion !== SUPPORTED_PLAIN_OT_PROTOCOL_VERSION) {
            throw new SocketRequestError(
                'server_error',
                'History OT writes require an explicit current-generation protocol version',
                false,
                {docId},
            );
        }
        if (!this.senderWitnessMatches(expectedSender)) {
            throw new SocketRequestError(
                'stale_connection',
                'Realtime sender identity changed before the History OT request could be authorized',
                false,
                {docId},
            );
        }
        const permissionAllowsIntent = () => intent.kind !== 'comment-write' && (
            this.currentPermissionsLevel === 'owner'
            || this.currentPermissionsLevel === 'readAndWrite'
            || (this.currentPermissionsLevel === 'review'
                && (intent.kind === 'tracked-write'
                    || (intent.kind === 'tracked-decision' && intent.decision === 'reject')))
        );
        const permissionError = () => new SocketRequestError(
            'server_error',
            'This realtime project session does not permit the History OT write intent',
            false,
            {permissionsLevel: this.currentPermissionsLevel, docId, intent: intent.kind},
        );
        if (!permissionAllowsIntent()) {
            throw permissionError();
        }
        if (session.docId !== docId) {
            throw new SocketRequestError(
                'server_error',
                'History OT session does not match the submitted document',
                false,
                {docId, sessionDocId: session.docId},
            );
        }
        let authorizedUpdate: JsonValue;
        try {
            authorizedUpdate = session.assertPendingSubmission(
                expectedSender.generation,
                submissionToken,
                update,
                intent,
            );
        } catch (error) {
            throw new SocketRequestError(
                'server_error',
                error instanceof Error ? error.message : 'History OT submission was not authorized',
                false,
                {docId},
            );
        }
        const parsed = parseHistoryOtRealtimeEnvelope(authorizedUpdate);
        if (!parsed.safe
            || parsed.classification !== 'collaborator-update'
            || parsed.doc !== docId
            || parsed.source !== expectedSender.publicId) {
            throw new SocketRequestError(
                'server_error',
                'Unsafe History OT update envelope',
                false,
                {docId, reasons: parsed.unsafeReasons},
            );
        }
        await this.request<any[]>(
            'applyOtUpdate',
            [docId, authorizedUpdate],
            ACK_TIMEOUT_MS,
            expectedSender,
            () => {
                if (!permissionAllowsIntent()) {
                    throw permissionError();
                }
                try {
                    session.assertPendingSubmission(
                        expectedSender.generation,
                        submissionToken,
                        authorizedUpdate,
                        intent,
                    );
                    session.markWireAttempted(
                        expectedSender.generation,
                        submissionToken,
                    );
                } catch (error) {
                    throw new SocketRequestError(
                        'server_error',
                        error instanceof Error
                            ? error.message
                            : 'History OT submission authorization changed before emit',
                        false,
                        {docId},
                    );
                }
            },
        );
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
