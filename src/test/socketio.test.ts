import { strict as assert } from 'assert';
import { SocketIOAPI } from '../api/socketio';
import { SocketRequestError } from '../api/socketRequest';

type Listener = (...args: any[]) => void;

class FakeRealtimeSocket {
    connected = false;
    ackPackets = 0;
    acks: Record<number, Listener> = {};
    socket = {options: {reconnect: true}};
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
        this.sockets.push(socket);
        this.queries.push(query);
        return socket;
    }
}

const identity = {csrfToken: 'csrf', cookies: 'session=cookie'};
const project = {_id: 'project-id', rootFolder: []};

function createAPI() {
    const base = new FakeBaseAPI();
    const socket = new SocketIOAPI(
        'https://www.overleaf.com',
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

async function waitForEmission(socket: FakeRealtimeSocket, event: string) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (socket.emitted.some(item => item.event === event)) { return; }
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.fail(`Timed out waiting for ${event} emission`);
}

describe('SocketIOAPI project protocol', () => {
    it('starts with the project-query auto-join protocol', async () => {
        const {base, socket} = createAPI();
        assert.match(base.queries[0] ?? '', /^\?projectId=project-id&/);

        const transport = base.sockets[0];
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

    it('uses the same physical socket after a transient disconnect', async () => {
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
        assert.equal(socket.needsReinit, false);

        transport.serverEmit('connect');
        const recovered = socket.joinProject('project-id');
        transport.serverEmit('joinProjectResponse', {publicId: 'P.new', project});
        assert.strictEqual(await recovered, project);
        assert.equal(base.sockets.length, 1);
    });

    it('falls back once when a legacy server accepts before explicit joinProject', async () => {
        const {base, socket} = createAPI();
        const modernAttempt = base.sockets[0];
        modernAttempt.serverEmit('connect');
        const negotiation = socket.joinProject('project-id');
        modernAttempt.serverEmit('connectionAccepted', undefined, 'P.legacy');
        await assert.rejects(
            negotiation,
            (error: unknown) => error instanceof SocketRequestError && error.code === 'stale_connection',
        );
        assert.equal(socket.needsReinit, true);

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
        const {base, socket} = createAPI();
        const firstAttempt = base.sockets[0];
        firstAttempt.serverEmit('connect');
        const legacyDetection = socket.joinProject('project-id');
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
        assert.match(base.queries[2] ?? '', /^\?projectId=project-id&/);
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
