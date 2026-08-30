import { strict as assert } from 'assert';
import { SocketIOAPI } from '../api/socketio';
import { SocketRequestError } from '../api/socketRequest';

type Listener = (...args: any[]) => void;

class FakeRealtimeSocket {
    connected = false;
    ackPackets = 0;
    acks: Record<number, Listener> = {};
    managerConnectCalls = 0;
    socket: any = {
        options: {reconnect: true, transports: ['websocket', 'xhr-polling']},
        connect: () => { this.managerConnectCalls += 1; },
    };
    emitted: Array<{event: string, args: any[]}> = [];
    private listeners = new Map<string, Set<Listener>>();
    private acknowledgements = new Map<string, Listener>();

    on(event: string, listener: Listener) {
        const listeners = this.listeners.get(event) ?? new Set<Listener>();
        listeners.add(listener);
        this.listeners.set(event, listeners);
    }

    removeListener(event: string, listener: Listener) {
        this.listeners.get(event)?.delete(listener);
    }

    removeAllListeners() {
        this.listeners.clear();
    }

    emit(event: string, ...args: any[]) {
        this.emitted.push({event, args});
        const acknowledgement = args.at(-1);
        if (typeof acknowledgement === 'function') {
            this.ackPackets += 1;
            this.acks[this.ackPackets] = acknowledgement;
            this.acknowledgements.set(event, acknowledgement);
        }
    }

    serverEmit(event: string, ...args: any[]) {
        if (event === 'connect') { this.connected = true; }
        if (event === 'disconnect') { this.connected = false; }
        for (const listener of [...(this.listeners.get(event) ?? [])]) {
            listener(...args);
        }
    }

    acknowledge(event: string, error?: unknown, ...args: any[]) {
        this.acknowledgements.get(event)?.(error, ...args);
    }

    disconnect() {
        this.serverEmit('disconnect');
    }
}

class FakeBaseAPI {
    readonly sockets: FakeRealtimeSocket[] = [];
    readonly queries: Array<string | undefined> = [];

    _initSocketV0(_identity: unknown, query?: string) {
        const socket = new FakeRealtimeSocket();
        socket.socket.options.query = (query ?? '').replace(/^\?/, '');
        this.sockets.push(socket);
        this.queries.push(query);
        return socket;
    }
}

const identity = {csrfToken: 'csrf', cookies: 'session=cookie'};
const project = {_id: 'project-id', rootFolder: []};

function createAPI(url = 'https://www.overleaf.com') {
    const base = new FakeBaseAPI();
    const socket = new SocketIOAPI(
        url,
        base as any,
        identity,
        'project-id',
    );
    return {base, socket};
}

async function nextMicrotask() {
    await Promise.resolve();
    await Promise.resolve();
}

async function waitForEmission(socket: FakeRealtimeSocket, event: string, count = 1) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (socket.emitted.filter(item => item.event === event).length >= count) { return; }
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.fail(`Timed out waiting for ${event} emission`);
}

describe('SocketIOAPI project protocol', () => {
    it('starts with the project-query auto-join protocol', async () => {
        const {base, socket} = createAPI();
        assert.equal(base.queries[0], 'projectId=project-id');

        const transport = base.sockets[0];
        assert.equal(transport.managerConnectCalls, 1);
        transport.serverEmit('connect');
        const joined = socket.joinProject('project-id');
        transport.serverEmit('joinProjectResponse', {
            publicId: 'P.modern',
            project,
            permissionsLevel: 'owner',
            protocolVersion: 2,
        });

        assert.strictEqual(await joined, project);
        assert.equal(socket.needsReinit, false);
    });

    it('retires and replaces a transport after a transient disconnect', async () => {
        const {base, socket} = createAPI();
        const transport = base.sockets[0];
        transport.serverEmit('connect');

        const interrupted = socket.joinProject('project-id');
        await nextMicrotask();
        transport.serverEmit('disconnect');
        await assert.rejects(
            interrupted,
            (error: unknown) => error instanceof SocketRequestError && error.code === 'disconnected',
        );
        assert.equal(base.sockets.length, 1);
        assert.equal(socket.needsReinit, true);

        socket.init();
        const replacement = base.sockets[1];
        replacement.serverEmit('connect');
        const recovered = socket.joinProject('project-id');
        replacement.serverEmit('joinProjectResponse', {publicId: 'P.new', project});
        assert.strictEqual(await recovered, project);
        assert.equal(base.sockets.length, 2);
    });

    it('retires a transport after all connection transports fail', () => {
        const {base, socket} = createAPI();
        const failed = base.sockets[0];

        failed.serverEmit('connect_failed');

        assert.equal(socket.needsReinit, true);
        const failedGeneration = socket.generation;
        failed.serverEmit('connect');
        failed.serverEmit('joinProjectResponse', {publicId: 'P.late', project});
        assert.equal(socket.isConnected, false);
        assert.equal(socket.generation, failedGeneration);

        socket.init();
        assert.equal(base.sockets.length, 2);
        assert.equal(base.queries[1], 'projectId=project-id');
    });

    it('retires an invalid v2 handshake instead of reusing its session id', () => {
        const {base, socket} = createAPI();
        const failed = base.sockets[0];
        failed.serverEmit('connect');

        failed.serverEmit('error', 'client not handshaken');

        assert.equal(socket.needsReinit, true);
        assert.equal(socket.isConnected, false);
        const failedGeneration = socket.generation;
        failed.serverEmit('connect');
        failed.serverEmit('joinProjectResponse', {publicId: 'P.late', project});
        assert.equal(socket.generation, failedGeneration);

        socket.init();
        assert.equal(base.queries[1], 'projectId=project-id');
    });

    it('retires a terminal HTTP handshake error with no active fallback', () => {
        const {base, socket} = createAPI();
        const failed = base.sockets[0];
        failed.socket.connecting = false;

        failed.serverEmit('error', 'Bad Gateway');

        assert.equal(socket.needsReinit, true);
        socket.init();
        assert.deepEqual(
            base.sockets[1].socket.options.transports,
            ['websocket', 'xhr-polling'],
        );
    });

    it('uses polling for the replacement after a WebSocket proxy failure', () => {
        const {base, socket} = createAPI();
        const failed = base.sockets[0];

        failed.serverEmit('error', new Error('unexpected server response (502)'));

        assert.equal(socket.needsReinit, true);
        socket.init();
        const replacement = base.sockets[1];
        assert.deepEqual(replacement.socket.options.transports, ['xhr-polling']);
        assert.equal(base.queries[1], 'projectId=project-id');

        replacement.serverEmit('connect_failed');
        socket.init();
        assert.deepEqual(
            base.sockets[2].socket.options.transports,
            ['websocket', 'xhr-polling'],
        );
    });

    it('does not mistake an early v2 connectionAccepted event for a legacy server', async () => {
        const {base, socket} = createAPI();
        const transport = base.sockets[0];
        transport.serverEmit('connect');
        const joined = socket.joinProject('project-id');
        let settled = false;
        void joined.finally(() => { settled = true; });

        transport.serverEmit('connectionAccepted', undefined, 'P.modern');
        await nextMicrotask();

        assert.equal(settled, false);
        assert.equal(base.sockets.length, 1);
        assert.equal(socket.needsReinit, false);

        transport.serverEmit('joinProjectResponse', {publicId: 'P.modern', project});
        assert.strictEqual(await joined, project);
        assert.equal(base.sockets.length, 1);
    });

    it('falls back once when an accepted v2 socket never receives a project response', async () => {
        const {base, socket} = createAPI('https://self-hosted.example');
        const modernAttempt = base.sockets[0];
        modernAttempt.serverEmit('connect');
        const negotiation = socket.joinProject('project-id', 5);
        modernAttempt.serverEmit('connectionAccepted', undefined, 'P.legacy');
        await assert.rejects(
            negotiation,
            (error: unknown) => error instanceof SocketRequestError && error.code === 'stale_connection',
        );
        assert.equal(socket.needsReinit, true);

        modernAttempt.serverEmit('connectionRejected', {
            message: 'missing/bad ?projectId=... query flag on handshake',
        });
        modernAttempt.serverEmit('error', 'client not handshaken');

        socket.init();
        assert.equal(base.queries[1], undefined);
        const legacyAttempt = base.sockets[1];
        legacyAttempt.serverEmit('connect');
        legacyAttempt.serverEmit('connectionAccepted', undefined, 'P.legacy');
        const joined = socket.joinProject('project-id');
        await waitForEmission(legacyAttempt, 'joinProject');
        legacyAttempt.acknowledge('joinProject', undefined, project, 'owner', 1);

        assert.strictEqual(await joined, project);
        assert.equal(base.sockets.length, 2);
    });

    it('never returns to v1 after the server explicitly rejects its missing project id', async () => {
        const {base, socket} = createAPI('https://self-hosted.example');
        const firstAttempt = base.sockets[0];
        firstAttempt.serverEmit('connect');
        const legacyDetection = socket.joinProject('project-id', 5);
        firstAttempt.serverEmit('connectionAccepted', undefined, 'P.legacy');
        await assert.rejects(legacyDetection);

        socket.init();
        const rejectedV1 = base.sockets[1];
        rejectedV1.serverEmit('connect');
        rejectedV1.serverEmit('connectionAccepted', undefined, 'P.legacy');
        const rejectedJoin = socket.joinProject('project-id');
        await waitForEmission(rejectedV1, 'joinProject');
        rejectedV1.serverEmit('connectionRejected', {
            message: 'missing/bad ?projectId=... query flag on handshake',
        });
        await assert.rejects(
            rejectedJoin,
            (error: unknown) => error instanceof SocketRequestError && error.code === 'server_error',
        );

        socket.init();
        assert.equal(base.queries[2], 'projectId=project-id');
        const finalAttempt = base.sockets[2];
        finalAttempt.serverEmit('connect');
        finalAttempt.serverEmit('connectionAccepted', undefined, 'P.compat');
        const joined = socket.joinProject('project-id');
        let settled = false;
        void joined.finally(() => { settled = true; });
        await nextMicrotask();
        assert.equal(settled, false);

        finalAttempt.serverEmit('joinProjectResponse', {publicId: 'P.modern', project});
        assert.strictEqual(await joined, project);
        assert.equal(socket.needsReinit, false);
    });

    it('never probes the queryless legacy protocol on hosted Overleaf', async () => {
        const {base, socket} = createAPI();
        const accepted: string[] = [];
        socket.updateEventHandlers({
            onConnectionAccepted: publicId => accepted.push(publicId),
        });
        const transport = base.sockets[0];
        transport.serverEmit('connect');
        const negotiation = socket.joinProject('project-id', 5);
        transport.serverEmit('connectionAccepted', undefined, 'P.slow');

        await assert.rejects(
            negotiation,
            (error: unknown) => error instanceof SocketRequestError && error.code === 'timeout',
        );

        transport.serverEmit('joinProjectResponse', {publicId: 'P.late', project});
        assert.deepEqual(accepted, ['P.slow']);

        socket.init();
        assert.equal(base.queries[1], 'projectId=project-id');
    });

    it('returns to v2 when a legacy probe reports client not handshaken', async () => {
        const {base, socket} = createAPI('https://self-hosted.example');
        const v2Attempt = base.sockets[0];
        v2Attempt.serverEmit('connect');
        const legacyDetection = socket.joinProject('project-id', 5);
        v2Attempt.serverEmit('connectionAccepted', undefined, 'P.legacy');
        await assert.rejects(legacyDetection);

        socket.init();
        const v1Attempt = base.sockets[1];
        v1Attempt.serverEmit('connect');
        v1Attempt.serverEmit('connectionAccepted', undefined, 'P.legacy');
        const rejectedJoin = socket.joinProject('project-id');
        await waitForEmission(v1Attempt, 'joinProject');
        v1Attempt.serverEmit('error', 'client not handshaken');
        await assert.rejects(rejectedJoin);

        socket.init();
        assert.equal(base.queries[2], 'projectId=project-id');
    });

    it('never revives a retired socket from late project events', async () => {
        const {base, socket} = createAPI();
        const transport = base.sockets[0];
        const accepted: string[] = [];
        socket.updateEventHandlers({
            onConnectionAccepted: publicId => accepted.push(publicId),
        });
        transport.serverEmit('connect');

        socket.invalidateCurrentTransport();
        const retiredGeneration = socket.generation;
        transport.serverEmit('connect');
        transport.serverEmit('connectionAccepted', undefined, 'P.late');
        transport.serverEmit('joinProjectResponse', {publicId: 'P.late', project});

        assert.equal(socket.isConnected, false);
        assert.equal(socket.generation, retiredGeneration);
        assert.deepEqual(accepted, []);

        socket.init();
        const replacement = base.sockets[1];
        replacement.serverEmit('connect');
        const joined = socket.joinProject('project-id');
        replacement.serverEmit('joinProjectResponse', {publicId: 'P.current', project});
        assert.strictEqual(await joined, project);
    });

    it('retires an already disconnected socket before it can reconnect late', () => {
        const {base, socket} = createAPI();
        const transport = base.sockets[0];
        transport.serverEmit('connect');
        transport.serverEmit('disconnect');
        const reconnectTimer = setTimeout(() => {}, 10_000);
        transport.socket.reconnecting = true;
        transport.socket.reconnectionTimer = reconnectTimer;

        socket.invalidateCurrentTransport();
        assert.equal(transport.socket.options.reconnect, false);
        assert.equal(transport.socket.reconnecting, false);
        assert.equal(transport.socket.reconnectionTimer, undefined);
        const retiredGeneration = socket.generation;
        transport.serverEmit('connect');
        transport.serverEmit('connectionAccepted', undefined, 'P.late');

        assert.equal(socket.isConnected, false);
        assert.equal(socket.generation, retiredGeneration);
    });

    it('returns to v2 after a one-shot legacy join times out', async () => {
        const {base, socket} = createAPI('https://self-hosted.example');
        const v2Attempt = base.sockets[0];
        v2Attempt.serverEmit('connect');
        const legacyDetection = socket.joinProject('project-id', 5);
        v2Attempt.serverEmit('connectionAccepted', undefined, 'P.legacy');
        await assert.rejects(legacyDetection);

        socket.init();
        const v1Attempt = base.sockets[1];
        v1Attempt.serverEmit('connect');
        v1Attempt.serverEmit('connectionAccepted', undefined, 'P.legacy');
        await assert.rejects(
            socket.joinProject('project-id', 5),
            (error: unknown) => error instanceof SocketRequestError && error.code === 'timeout',
        );

        socket.init();
        assert.equal(base.queries[2], 'projectId=project-id');
    });

    it('retires a disconnected unconfirmed legacy probe before returning to v2', async () => {
        const {base, socket} = createAPI('https://self-hosted.example');
        const v2Attempt = base.sockets[0];
        v2Attempt.serverEmit('connect');
        const legacyDetection = socket.joinProject('project-id', 5);
        v2Attempt.serverEmit('connectionAccepted', undefined, 'P.legacy');
        await assert.rejects(legacyDetection);

        socket.init();
        const v1Attempt = base.sockets[1];
        v1Attempt.serverEmit('connect');
        v1Attempt.serverEmit('connectionAccepted', undefined, 'P.legacy');
        const interruptedProbe = socket.joinProject('project-id', 50);
        await waitForEmission(v1Attempt, 'joinProject');
        v1Attempt.serverEmit('disconnect');
        await assert.rejects(
            interruptedProbe,
            (error: unknown) => error instanceof SocketRequestError && error.code === 'disconnected',
        );

        const retiredGeneration = socket.generation;
        v1Attempt.serverEmit('connect');
        v1Attempt.serverEmit('connectionAccepted', undefined, 'P.late');
        assert.equal(socket.isConnected, false);
        assert.equal(socket.generation, retiredGeneration);

        socket.init();
        assert.equal(base.queries[2], 'projectId=project-id');
    });

    it('restores a confirmed legacy protocol after leaving alternative mode', async () => {
        const {base, socket} = createAPI('https://self-hosted.example');
        const v2Attempt = base.sockets[0];
        v2Attempt.serverEmit('connect');
        const legacyDetection = socket.joinProject('project-id', 5);
        v2Attempt.serverEmit('connectionAccepted', undefined, 'P.legacy');
        await assert.rejects(legacyDetection);

        socket.init();
        const v1Attempt = base.sockets[1];
        v1Attempt.serverEmit('connect');
        v1Attempt.serverEmit('connectionAccepted', undefined, 'P.legacy');
        const joined = socket.joinProject('project-id');
        await waitForEmission(v1Attempt, 'joinProject');
        v1Attempt.acknowledge('joinProject', undefined, project, 'owner', 1);
        assert.strictEqual(await joined, project);

        socket.toggleAlternativeConnectionScheme('https://self-hosted.example', project as any);
        socket.toggleAlternativeConnectionScheme('https://self-hosted.example');
        socket.init();

        assert.equal(base.queries[2], undefined);
    });

    it('recreates a confirmed legacy transport after a recoverable interruption', async () => {
        const {socket, base} = createAPI('https://self-hosted.example');
        const v2Attempt = base.sockets[0];
        v2Attempt.serverEmit('connect');

        const legacyDetection = socket.joinProject('project-id', 5);
        v2Attempt.serverEmit('connectionAccepted', undefined, 'P.legacy');
        await assert.rejects(legacyDetection);

        socket.init();
        const v1Attempt = base.sockets[1];
        v1Attempt.serverEmit('connect');
        v1Attempt.serverEmit('connectionAccepted', undefined, 'P.legacy');
        const firstJoin = socket.joinProject('project-id', 50);
        await waitForEmission(v1Attempt, 'joinProject');
        v1Attempt.acknowledge('joinProject', undefined, project, 'owner', 1);
        assert.equal(await firstJoin, project);

        const interruptedJoin = socket.joinProject('project-id', 50);
        await waitForEmission(v1Attempt, 'joinProject', 2);
        v1Attempt.serverEmit('disconnect');
        await assert.rejects(
            interruptedJoin,
            (error: unknown) => error instanceof SocketRequestError && error.code === 'disconnected',
        );

        assert.equal(socket.needsReinit, true);
        socket.init();
        const replacementV1 = base.sockets[2];
        replacementV1.serverEmit('connect');
        replacementV1.serverEmit('connectionAccepted', undefined, 'P.legacy-again');
        const secondJoin = socket.joinProject('project-id', 50);
        await waitForEmission(replacementV1, 'joinProject');
        replacementV1.acknowledge('joinProject', undefined, project, 'owner', 2);
        assert.equal(await secondJoin, project);
        assert.equal(base.sockets.length, 3);
        assert.equal(base.queries[2], undefined);
    });

    it('keeps v2 public ids isolated between socket sessions', async () => {
        const first = createAPI();
        const second = createAPI();
        const accepted: string[] = [];
        first.socket.updateEventHandlers({
            onConnectionAccepted: publicId => accepted.push(`first:${publicId}`),
        });
        second.socket.updateEventHandlers({
            onConnectionAccepted: publicId => accepted.push(`second:${publicId}`),
        });

        first.base.sockets[0].serverEmit('connect');
        const joined = first.socket.joinProject('project-id');
        first.base.sockets[0].serverEmit('joinProjectResponse', {publicId: 'P.first', project});

        assert.strictEqual(await joined, project);
        assert.deepEqual(accepted, ['first:P.first']);
    });

    it('removes physical handlers when the socket session is disposed', () => {
        const {base, socket} = createAPI();
        const transport = base.sockets[0];
        let acceptedEvents = 0;
        let clientEvents = 0;
        socket.updateEventHandlers({
            onConnectionAccepted: () => { acceptedEvents += 1; },
            onClientUpdated: () => { clientEvents += 1; },
        });

        socket.dispose();
        transport.serverEmit('connectionAccepted', undefined, 'P.late');
        transport.serverEmit('clientTracking.clientUpdated', {});

        assert.equal(acceptedEvents, 0);
        assert.equal(clientEvents, 0);
        assert.equal(socket.handlers.length, 0);
        assert.throws(
            () => socket.init(),
            (error: unknown) => error instanceof SocketRequestError && error.code === 'stale_connection',
        );
    });
});
