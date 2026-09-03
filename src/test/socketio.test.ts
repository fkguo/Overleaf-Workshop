/* eslint-disable @typescript-eslint/naming-convention */
import { strict as assert } from 'assert';
import { RealtimeFatalError, SocketIOAPI } from '../api/socketio';
import { SocketRequestError } from '../api/socketRequest';
import {HistoryOtSession} from '../core/historyOtSession';

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
const v2ProjectQuery = 'projectId=project-id&esh=1&ssp=1';

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
        assert.equal(base.queries[0], v2ProjectQuery);

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

    it('fails terminally when a v2 sender rotates after response resolution but before join finalization', async () => {
        const {base, socket} = createAPI();
        const transport = base.sockets[0];
        const fatalErrors: RealtimeFatalError[] = [];
        socket.updateEventHandlers({onFatalError: error => fatalErrors.push(error)});
        transport.serverEmit('connect');

        const joined = socket.joinProject('project-id');
        transport.serverEmit('joinProjectResponse', {
            publicId: 'P.original',
            project,
            permissionsLevel: 'owner',
            protocolVersion: 2,
        });
        transport.serverEmit('connectionAccepted', undefined, 'P.rotated');

        await assert.rejects(
            joined,
            (error: unknown) => error instanceof RealtimeFatalError && error.code === 'sender_changed',
        );
        assert.equal(fatalErrors.length, 1);
        assert.strictEqual(socket.fatalError, fatalErrors[0]);
        assert.equal(socket.projectSession, undefined);
        assert.equal(socket.needsReinit, false);
    });

    it('rejects every conflicting ready-state project response without changing the sender witness', async () => {
        const cases = [
            {
                name: 'sender',
                response: {
                    publicId: 'P.rotated', project, permissionsLevel: 'owner', protocolVersion: 2,
                },
                code: 'sender_changed',
            },
            {
                name: 'project',
                response: {
                    publicId: 'P.fixed',
                    project: {_id: 'different-project-id', rootFolder: []},
                    permissionsLevel: 'owner',
                    protocolVersion: 2,
                },
                code: 'project_unavailable',
            },
            {
                name: 'protocol',
                response: {
                    publicId: 'P.fixed', project, permissionsLevel: 'owner', protocolVersion: 3,
                },
                code: 'protocol_changed',
            },
        ] as const;

        for (const scenario of cases) {
            const {base, socket} = createAPI();
            const transport = base.sockets[0];
            const fatalErrors: RealtimeFatalError[] = [];
            socket.updateEventHandlers({onFatalError: error => fatalErrors.push(error)});
            transport.serverEmit('connect');
            const joined = socket.joinProject('project-id');
            transport.serverEmit('joinProjectResponse', {
                publicId: 'P.fixed', project, permissionsLevel: 'owner', protocolVersion: 2,
            });
            await joined;
            const originalWitness = socket.projectSession;

            transport.serverEmit('joinProjectResponse', scenario.response);

            assert.equal(fatalErrors.length, 1, `${scenario.name} conflict must be terminal`);
            assert.equal(fatalErrors[0].code, scenario.code);
            assert.equal(socket.projectSession, undefined);
            assert.equal(socket.needsReinit, false);
            assert.deepEqual(originalWitness, {
                publicId: 'P.fixed',
                permissionsLevel: 'owner',
                protocolVersion: 2,
                generation: originalWitness?.generation,
            });
        }
    });

    it('keeps an accepted sender stable across duplicate signals and on the dedupe source chain', async () => {
        const {base, socket} = createAPI();
        const transport = base.sockets[0];
        const accepted: string[] = [];
        socket.updateEventHandlers({onConnectionAccepted: publicId => accepted.push(publicId)});
        transport.serverEmit('connect');
        const joined = socket.joinProject('project-id');
        const response = {
            publicId: 'P.fixed', project, permissionsLevel: 'owner' as const, protocolVersion: 2,
        };
        transport.serverEmit('joinProjectResponse', response);
        await joined;
        const witness = socket.projectSession!;

        transport.serverEmit('connectionAccepted', undefined, 'P.fixed');
        transport.serverEmit('joinProjectResponse', response);
        assert.deepEqual(socket.projectSession, witness);
        assert.deepEqual(accepted, ['P.fixed']);

        const saving = socket.applyOtUpdate(
            'doc-id',
            {
                doc: 'doc-id',
                v: 4,
                op: [{p: 0, i: 'x'}],
                dupIfSource: [witness.publicId],
            },
            witness,
        );
        await waitForEmission(transport, 'applyOtUpdate');
        const wireUpdate = transport.emitted.find(item => item.event === 'applyOtUpdate')?.args[1];
        assert.deepEqual(wireUpdate.dupIfSource, ['P.fixed']);
        transport.acknowledge('applyOtUpdate', undefined);
        await saving;
    });

    it('terminates a session whose joined project identity differs from the request', async () => {
        const {base, socket} = createAPI();
        const transport = base.sockets[0];
        const joinedSessions: unknown[] = [];
        const fatalErrors: RealtimeFatalError[] = [];
        socket.updateEventHandlers({
            onProjectJoined: session => joinedSessions.push(session),
            onFatalError: error => fatalErrors.push(error),
        });
        transport.serverEmit('connect');

        const joined = socket.joinProject('project-id');
        transport.serverEmit('joinProjectResponse', {
            publicId: 'P.wrong-project',
            project: {_id: 'different-project-id', rootFolder: []},
            permissionsLevel: 'owner',
            protocolVersion: 2,
        });

        await assert.rejects(
            joined,
            (error: unknown) => error instanceof RealtimeFatalError
                && error.code === 'project_unavailable'
                && error.details !== null
                && typeof error.details === 'object'
                && (error.details as {expectedProjectId?: string}).expectedProjectId === 'project-id'
                && (error.details as {receivedProjectId?: string}).receivedProjectId === 'different-project-id',
        );
        assert.equal(joinedSessions.length, 0, 'a mismatched tree must never become a project session');
        assert.equal(fatalErrors.length, 1);
        assert.strictEqual(socket.fatalError, fatalErrors[0]);
        assert.equal(socket.projectSession, undefined);
        assert.equal(socket.isConnected, false);
        assert.equal(socket.needsReinit, false, 'an identity mismatch is terminal, not retryable');

        await assert.rejects(
            socket.joinDoc('doc-id'),
            (error: unknown) => error === fatalErrors[0],
        );
        assert.equal(
            transport.emitted.filter(item => item.event === 'joinDoc').length,
            0,
            'no document join may follow a mismatched project response',
        );
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
        assert.equal(base.queries[1], v2ProjectQuery);
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
        assert.equal(base.queries[1], v2ProjectQuery);
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
        assert.equal(base.queries[1], v2ProjectQuery);

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

    it('fails terminally when a legacy join sender rotates while its ACK is pending', async () => {
        const {base, socket} = createAPI('https://self-hosted.example');
        socket.invalidateCurrentTransport();
        (socket as any).scheme = 'v1';
        socket.init();
        const transport = base.sockets[1];
        const fatalErrors: RealtimeFatalError[] = [];
        socket.updateEventHandlers({onFatalError: error => fatalErrors.push(error)});
        transport.serverEmit('connect');
        transport.serverEmit('connectionAccepted', undefined, 'P.original');

        const joined = socket.joinProject('project-id');
        await waitForEmission(transport, 'joinProject');
        transport.serverEmit('connectionAccepted', undefined, 'P.rotated');
        transport.acknowledge('joinProject', undefined, project, 'owner', 2);

        await assert.rejects(
            joined,
            (error: unknown) => error instanceof SocketRequestError && error.code === 'stale_connection',
        );
        assert.equal(fatalErrors.length, 1);
        assert.equal(fatalErrors[0].code, 'sender_changed');
        assert.strictEqual(socket.fatalError, fatalErrors[0]);
        assert.equal(socket.projectSession, undefined);
        assert.equal(socket.needsReinit, false);
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
        assert.equal(base.queries[2], v2ProjectQuery);
        const finalAttempt = base.sockets[2];
        finalAttempt.serverEmit('connect');
        finalAttempt.serverEmit('connectionAccepted', undefined, 'P.compat');
        const joined = socket.joinProject('project-id');
        let settled = false;
        void joined.finally(() => { settled = true; });
        await nextMicrotask();
        assert.equal(settled, false);

        finalAttempt.serverEmit('joinProjectResponse', {publicId: 'P.compat', project});
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
        assert.equal(base.queries[1], v2ProjectQuery);
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
        assert.equal(base.queries[2], v2ProjectQuery);
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

    it('drops full OT operations and thread events emitted by a retired socket generation', async () => {
        const {base, socket} = createAPI();
        const retired = base.sockets[0];
        const updates: unknown[] = [];
        const threadEvents: unknown[] = [];
        socket.updateEventHandlers({
            onFileChanged: (update, sender) => updates.push({update, sender}),
            onHistoryOtThreadEvent: (event, args) => threadEvents.push({event, args}),
        });
        retired.serverEmit('connect');
        const firstJoin = socket.joinProject('project-id');
        retired.serverEmit('joinProjectResponse', {publicId: 'P.retired', project});
        await firstJoin;

        socket.invalidateCurrentTransport();
        retired.serverEmit('otUpdateApplied', {
            doc: 'doc-id',
            v: 4,
            op: [{p: 0, i: 'stale-before-replacement'}],
        });
        retired.serverEmit('delete-thread', 'thread-stale-before-replacement');
        assert.deepEqual(
            updates,
            [],
            'a retired transport must be inert even before replacement removes its listeners',
        );

        socket.init();
        const current = base.sockets[1];
        current.serverEmit('connect');
        const secondJoin = socket.joinProject('project-id');
        current.serverEmit('joinProjectResponse', {publicId: 'P.current', project});
        await secondJoin;

        retired.serverEmit('otUpdateApplied', {
            doc: 'doc-id',
            v: 4,
            op: [{p: 0, i: 'stale'}],
        });
        retired.serverEmit('delete-thread', 'thread-stale');
        assert.deepEqual(updates, [], 'a retired transport must have no observable OT effect');

        current.serverEmit('otUpdateApplied', {
            doc: 'doc-id',
            v: 4,
            op: [{textOperation: [1, 'current']}],
            meta: {origin: {kind: 'remote', opaque: true}},
        });
        current.serverEmit('new-comment', 'thread-current', {opaque: {preserved: true}});
        assert.deepEqual(updates, [{
            update: {
                doc: 'doc-id',
                v: 4,
                op: [{textOperation: [1, 'current']}],
                meta: {origin: {kind: 'remote', opaque: true}},
            },
            sender: {publicId: 'P.current', generation: socket.generation},
        }]);
        assert.deepEqual(threadEvents, [{
            event: 'new-comment',
            args: ['thread-current', {opaque: {preserved: true}}],
        }]);
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
        assert.equal(base.queries[2], v2ProjectQuery);
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
        assert.equal(base.queries[2], v2ProjectQuery);
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

    it('accepts the empty public id used by the HTTP-backed alternative mode', async () => {
        const {base, socket} = createAPI();
        const transport = base.sockets[0];
        // Exercise the alternative-mode join contract with the lightweight fake
        // transport; SocketIOAlt emits the same empty connectionAccepted id.
        (socket as any).scheme = 'Alt';
        (socket as any)._socketInitScheme = 'Alt';
        transport.serverEmit('connect');
        transport.serverEmit('connectionAccepted', undefined, '');

        const joined = socket.joinProject('project-id');
        await waitForEmission(transport, 'joinProject');
        transport.acknowledge('joinProject', undefined, project, undefined, undefined);

        assert.strictEqual(await joined, project);
        assert.equal(socket.projectSession?.publicId, '');
    });

    it('preserves known non-writing permissions through an alternative-mode join', async () => {
        for (const permissionsLevel of ['readOnly', 'review'] as const) {
            const {base, socket} = createAPI();
            const transport = base.sockets[0];
            transport.serverEmit('connect');
            const joined = socket.joinProject('project-id');
            transport.serverEmit('joinProjectResponse', {
                publicId: `P.${permissionsLevel}`, project, permissionsLevel, protocolVersion: 2,
            });
            await joined;

            (socket as any).scheme = 'Alt';
            (socket as any)._socketInitScheme = 'Alt';
            (socket as any).resetTransportState();
            transport.serverEmit('connect');
            transport.serverEmit('connectionAccepted', undefined, '');
            const alternativeJoin = socket.joinProject('project-id');
            await waitForEmission(transport, 'joinProject', 1);
            transport.acknowledge('joinProject', undefined, project, undefined, undefined);
            await alternativeJoin;

            assert.equal(socket.projectSession?.permissionsLevel, permissionsLevel);
            const sentBeforeWrite = transport.emitted.length;
            await assert.rejects(
                socket.applyOtUpdate(
                    'doc-id',
                    {doc: 'doc-id', v: 1, op: [{p: 0, i: 'x'}]},
                    socket.projectSession!,
                ),
                (error: unknown) => error instanceof SocketRequestError && error.code === 'server_error',
            );
            assert.equal(transport.emitted.length, sentBeforeWrite);
        }
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
        replacementV1.acknowledge('joinProject', undefined, project, 'owner', 1);
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

    it('echoes the complete server heartbeat with client transport identity', () => {
        const {base} = createAPI();
        const transport = base.sockets[0];
        transport.socket.transport = {name: 'websocket'};
        transport.socket.sessionid = 'client-session';

        transport.serverEmit('serverPing', 7, 1234, 'xhr-polling', 'server-session');

        const pong = transport.emitted.find(item => item.event === 'clientPong');
        assert.deepEqual(pong?.args, [
            7,
            1234,
            'xhr-polling',
            'server-session',
            'websocket',
            'client-session',
        ]);
    });

    it('retires once for reconnectGracefully and uses the ordinary recovery channel', () => {
        const {base, socket} = createAPI();
        const transport = base.sockets[0];
        let disconnects = 0;
        let fatals = 0;
        socket.updateEventHandlers({
            onDisconnected: () => { disconnects += 1; },
            onFatalError: () => { fatals += 1; },
        });
        transport.serverEmit('connect');

        transport.serverEmit('reconnectGracefully');
        transport.serverEmit('reconnectGracefully');

        assert.equal(disconnects, 1);
        assert.equal(fatals, 0);
        assert.equal(socket.needsReinit, true);
        assert.equal(transport.socket.options.reconnect, false);
    });

    it('treats access revocation as terminal without entering the disconnect retry path', () => {
        const {base, socket} = createAPI();
        const transport = base.sockets[0];
        const fatalErrors: RealtimeFatalError[] = [];
        let disconnects = 0;
        socket.updateEventHandlers({
            onDisconnected: () => { disconnects += 1; },
            onFatalError: error => fatalErrors.push(error),
        });
        transport.serverEmit('connect');

        transport.serverEmit('project:access:revoked');

        assert.equal(disconnects, 0);
        assert.equal(fatalErrors.length, 1);
        assert.equal(fatalErrors[0].code, 'access_revoked');
        assert.equal(socket.needsReinit, false);
        assert.throws(() => socket.init(), RealtimeFatalError);
    });

    it('treats forceDisconnect as terminal and honors an immediate server delay', async () => {
        const {base, socket} = createAPI();
        const transport = base.sockets[0];
        const fatalErrors: RealtimeFatalError[] = [];
        socket.updateEventHandlers({onFatalError: error => fatalErrors.push(error)});
        transport.serverEmit('connect');

        transport.serverEmit('forceDisconnect', 'maintenance', 0);
        await new Promise<void>(resolve => setTimeout(resolve, 5));

        assert.equal(fatalErrors[0]?.code, 'force_disconnect');
        assert.equal(socket.isConnected, false);
        assert.equal(transport.connected, false);
        assert.equal(socket.needsReinit, false);
    });

    it('publishes every successful project session with permission and protocol metadata', async () => {
        const {base, socket} = createAPI();
        const transport = base.sockets[0];
        const sessions: any[] = [];
        socket.updateEventHandlers({onProjectJoined: session => sessions.push(session)});
        transport.serverEmit('connect');

        const firstJoin = socket.joinProject('project-id');
        transport.serverEmit('joinProjectResponse', {
            publicId: 'P.metadata',
            project,
            permissionsLevel: 'readAndWrite',
            protocolVersion: 2,
        });
        await firstJoin;
        await socket.joinProject('project-id');

        assert.deepEqual(sessions, [
            {
                publicId: 'P.metadata',
                permissionsLevel: 'readAndWrite',
                protocolVersion: 2,
                generation: socket.generation,
            },
            {
                publicId: 'P.metadata',
                permissionsLevel: 'readAndWrite',
                protocolVersion: 2,
                generation: socket.generation,
            },
        ]);
        assert.deepEqual(socket.projectSession, sessions[1]);
    });

    it('fails closed for read-only and review-only plain OT writes', async () => {
        for (const permissionsLevel of ['readOnly', 'review'] as const) {
            const {base, socket} = createAPI();
            const transport = base.sockets[0];
            transport.serverEmit('connect');
            const joined = socket.joinProject('project-id');
            transport.serverEmit('joinProjectResponse', {
                publicId: `P.${permissionsLevel}`,
                project,
                permissionsLevel,
                protocolVersion: 2,
            });
            await joined;

            await assert.rejects(
                socket.applyOtUpdate(
                    'doc-id',
                    {doc: 'doc-id', v: 1, op: [{p: 0, i: 'x'}]},
                    socket.projectSession!,
                ),
                (error: unknown) => error instanceof SocketRequestError && error.code === 'server_error',
            );
            assert.equal(transport.emitted.some(item => item.event === 'applyOtUpdate'), false);
        }
    });

    it('consumes otUpdateError and retires the generation before a late ACK', async () => {
        const {base, socket} = createAPI();
        const transport = base.sockets[0];
        const updateErrors: any[] = [];
        let disconnects = 0;
        socket.updateEventHandlers({
            onOtUpdateError: error => updateErrors.push(error),
            onDisconnected: () => { disconnects += 1; },
        });
        transport.serverEmit('connect');
        const joined = socket.joinProject('project-id');
        transport.serverEmit('joinProjectResponse', {
            publicId: 'P.writer',
            project,
            permissionsLevel: 'owner',
            protocolVersion: 2,
        });
        await joined;
        const saving = socket.applyOtUpdate(
            'doc-id',
            {doc: 'doc-id', v: 4, op: [{p: 0, i: 'x'}]},
            socket.projectSession!,
        );
        await waitForEmission(transport, 'applyOtUpdate');

        transport.serverEmit('otUpdateError', 'update is too large', {
            project_id: 'project-id',
            doc_id: 'doc-id',
            error: 'update is too large',
        });
        transport.acknowledge('applyOtUpdate', undefined);

        await assert.rejects(
            saving,
            (error: unknown) => error instanceof SocketRequestError && error.code === 'stale_connection',
        );
        assert.deepEqual(updateErrors[0], {
            message: 'update is too large',
            projectId: 'project-id',
            docId: 'doc-id',
            details: {
                project_id: 'project-id',
                doc_id: 'doc-id',
                error: 'update is too large',
            },
        });
        assert.equal(disconnects, 1);
        assert.equal(socket.needsReinit, true);
    });

    it('emits no OT when the accepted sender changes during request preparation', async () => {
        const {base, socket} = createAPI();
        const transport = base.sockets[0];
        transport.serverEmit('connect');
        const joined = socket.joinProject('project-id');
        transport.serverEmit('joinProjectResponse', {
            publicId: 'P.original',
            project,
            permissionsLevel: 'owner',
            protocolVersion: 2,
        });
        await joined;
        const witness = socket.projectSession!;

        const saving = socket.applyOtUpdate(
            'doc-id',
            {doc: 'doc-id', v: 4, op: [{p: 0, i: 'x'}]},
            witness,
        );
        transport.serverEmit('connectionAccepted', undefined, 'P.rotated');

        await assert.rejects(
            saving,
            (error: unknown) => error instanceof SocketRequestError
                && error.code === 'stale_connection'
                && error.outcomeUnknown === false,
        );
        assert.equal(
            transport.emitted.some(item => item.event === 'applyOtUpdate'),
            false,
            'sender rotation before emit must produce zero wire operations',
        );
    });

    it('stops reconnecting when the protocol changes across project joins', async () => {
        const {base, socket} = createAPI();
        const first = base.sockets[0];
        let disconnects = 0;
        socket.updateEventHandlers({onDisconnected: () => { disconnects += 1; }});
        first.serverEmit('connect');
        const firstJoin = socket.joinProject('project-id');
        first.serverEmit('joinProjectResponse', {
            publicId: 'P.v2', project, permissionsLevel: 'owner', protocolVersion: 2,
        });
        await firstJoin;
        first.serverEmit('disconnect');

        socket.init();
        const second = base.sockets[1];
        const fatalErrors: RealtimeFatalError[] = [];
        socket.updateEventHandlers({onFatalError: error => fatalErrors.push(error)});
        second.serverEmit('connect');
        const changedJoin = socket.joinProject('project-id');
        second.serverEmit('joinProjectResponse', {
            publicId: 'P.v3', project, permissionsLevel: 'owner', protocolVersion: 3,
        });

        await assert.rejects(
            changedJoin,
            (error: unknown) => error instanceof RealtimeFatalError && error.code === 'protocol_changed',
        );
        assert.equal(fatalErrors[0]?.code, 'protocol_changed');
        assert.equal(disconnects, 1);
        assert.equal(socket.needsReinit, false);
    });

    it('does not inherit a prior protocol witness when the new join omits it', async () => {
        const {base, socket} = createAPI();
        const first = base.sockets[0];
        first.serverEmit('connect');
        const firstJoin = socket.joinProject('project-id');
        first.serverEmit('joinProjectResponse', {
            publicId: 'P.explicit-v2', project, permissionsLevel: 'owner', protocolVersion: 2,
        });
        await firstJoin;
        assert.equal(socket.projectSession?.protocolVersion, 2);
        first.serverEmit('disconnect');

        socket.init();
        const second = base.sockets[1];
        second.serverEmit('connect');
        const secondJoin = socket.joinProject('project-id');
        second.serverEmit('joinProjectResponse', {
            publicId: 'P.missing-protocol', project, permissionsLevel: 'owner',
        });
        await secondJoin;

        const witness = socket.projectSession!;
        assert.equal(witness.protocolVersion, undefined);
        const emittedBeforeWrite = second.emitted.length;
        await assert.rejects(
            socket.applyOtUpdate(
                'doc-id',
                {doc: 'doc-id', v: 1, op: [{p: 0, i: 'unsafe'}]},
                witness,
            ),
            (error: unknown) => error instanceof SocketRequestError
                && error.code === 'server_error'
                && error.outcomeUnknown === false,
        );
        assert.equal(second.emitted.length, emittedBeforeWrite, 'missing protocol must emit zero OT');
    });

    it('advertises History OT on realtime joins and preserves its JSON payload losslessly', async () => {
        const {base, socket} = createAPI();
        const transport = base.sockets[0];
        transport.serverEmit('connect');
        const joined = socket.joinProject('project-id');
        transport.serverEmit('joinProjectResponse', {
            publicId: 'P.history', project, permissionsLevel: 'owner', protocolVersion: 2,
        });
        await joined;

        const joiningDoc = socket.joinDoc('history-doc');
        await waitForEmission(transport, 'joinDoc');
        const joinEmission = transport.emitted.find(item => item.event === 'joinDoc');
        assert.deepEqual(joinEmission?.args[1], {
            encodeRanges: true,
            supportsHistoryOT: true,
        });
        const snapshot = {
            content: 'tracked',
            trackedChanges: [{
                range: {pos: 0, length: 7},
                tracking: {
                    type: 'insert',
                    userId: 'user-a',
                    ts: '2026-08-31T00:00:00.000Z',
                },
            }],
        };
        const updates = [{
            doc: 'history-doc',
            v: 1,
            op: [{textOperation: [7, 'x']}],
            opaque: {mustSurvive: [true, null, 3]},
        }];
        const ranges = {thread: {nested: ['raw', {value: 4}]}};
        transport.acknowledge(
            'joinDoc',
            undefined,
            snapshot,
            1,
            updates,
            ranges,
            'history-ot',
        );

        const joinedDoc = await joiningDoc;
        assert.deepEqual(joinedDoc, {
            otType: 'history-ot',
            snapshot,
            version: 1,
            updates,
            ranges,
        });
        updates[0].opaque.mustSurvive[0] = false;
        ranges.thread.nested[0] = 'mutated';
        assert.deepEqual(joinedDoc.updates[0], {
            doc: 'history-doc',
            v: 1,
            op: [{textOperation: [7, 'x']}],
            opaque: {mustSurvive: [true, null, 3]},
        });
        assert.deepEqual(joinedDoc.ranges, {thread: {nested: ['raw', {value: 4}]}});
    });

    it('never advertises or accepts History OT on the HTTP-backed alternative transport', async () => {
        const {base, socket} = createAPI();
        const transport = base.sockets[0];
        (socket as any).scheme = 'Alt';
        (socket as any)._socketInitScheme = 'Alt';
        transport.serverEmit('connect');
        transport.serverEmit('connectionAccepted', undefined, '');
        const joined = socket.joinProject('project-id');
        await waitForEmission(transport, 'joinProject');
        transport.acknowledge('joinProject', undefined, project, undefined, undefined);
        await joined;

        const joiningDoc = socket.joinDoc('history-doc');
        await waitForEmission(transport, 'joinDoc');
        const joinEmission = transport.emitted.find(item => item.event === 'joinDoc');
        assert.deepEqual(joinEmission?.args[1], {encodeRanges: true});
        transport.acknowledge('joinDoc', undefined, {content: 'tracked'}, 1, [], {}, 'history-ot');
        await assert.rejects(
            joiningDoc,
            (error: unknown) => error instanceof RealtimeFatalError
                && error.code === 'unsupported_history_ot',
        );
    });

    it('binds History OT writes to exact intent, sender, generation, session, and queue-only ACK', async () => {
        const {base, socket} = createAPI();
        const transport = base.sockets[0];
        transport.serverEmit('connect');
        const joined = socket.joinProject('project-id');
        transport.serverEmit('joinProjectResponse', {
            publicId: 'P.review', project, permissionsLevel: 'review', protocolVersion: 2,
        });
        await joined;
        const witness = socket.projectSession!;
        const intent = {kind: 'tracked-write'} as const;
        const session = new HistoryOtSession('doc-id', witness.generation, {
            level: 'review',
            userId: 'user-a',
        });
        session.acceptJoin(witness.generation, {
            snapshot: {content: 'a'},
            version: 4,
            operations: [],
            ranges: {},
            otType: 'history-ot',
        });
        const staged = session.stage(witness.generation, {
            operation: [{textOperation: [1, {
                i: 'x',
                tracking: {
                    type: 'insert',
                    userId: 'user-a',
                    ts: '2026-08-31T00:00:00.000Z',
                },
            }]}],
            meta: {tc: 'opaque-seed'},
            intent,
            publicId: witness.publicId,
        });
        const envelope = staged.envelope;
        assert.ok(envelope);
        const submissionToken = staged.submissionToken;
        assert.ok(submissionToken);

        const expectedEnvelope = JSON.parse(JSON.stringify(envelope));
        const saving = socket.applyHistoryOtUpdate(
            'doc-id', envelope, intent, submissionToken, session, witness,
        );
        (envelope as any).v = 99;
        (envelope as any).meta.source = 'P.mutated-after-authorization';
        await waitForEmission(transport, 'applyOtUpdate');
        const writes = () => transport.emitted.filter(item => item.event === 'applyOtUpdate');
        assert.deepEqual(
            writes()[0].args[1],
            expectedEnvelope,
            'the exact authorized snapshot must reach the wire despite caller mutation',
        );
        assert.notStrictEqual(writes()[0].args[1], envelope);
        assert.equal(session.getState().pendingWireAttempted, true);
        assert.equal(session.getState().pendingQueued, false);
        transport.acknowledge('applyOtUpdate', undefined);
        await saving;
        assert.equal(
            session.getState().pendingQueued,
            false,
            'socket ACK only witnesses queue acceptance; the coordinator owns session mutation',
        );

        const acceptedWriteCount = writes().length;
        const rejected: Array<Promise<void>> = [
            socket.applyHistoryOtUpdate(
                'doc-id', expectedEnvelope,
                {kind: 'tracked-decision', decision: 'accept', selectedRanges: []},
                submissionToken, session, witness,
            ),
            socket.applyHistoryOtUpdate(
                'doc-id', expectedEnvelope, {kind: 'comment-write'},
                submissionToken, session, witness,
            ),
            socket.applyHistoryOtUpdate(
                'doc-id',
                {...expectedEnvelope as object, meta: {source: 'P.other', tc: 'opaque-seed'}},
                intent,
                submissionToken, session,
                witness,
            ),
            socket.applyHistoryOtUpdate(
                'doc-id', expectedEnvelope, intent, submissionToken, session,
                {...witness, generation: witness.generation + 1},
            ),
            socket.applyHistoryOtUpdate(
                'doc-id', expectedEnvelope, intent, submissionToken,
                new HistoryOtSession('doc-id', witness.generation, {
                    level: 'review', userId: 'user-a',
                }),
                witness,
            ),
            socket.applyHistoryOtUpdate(
                'doc-id', expectedEnvelope, intent,
                `${submissionToken}-retired`, session, witness,
            ),
        ];
        for (const rejection of rejected) {
            await assert.rejects(rejection, (error: unknown) => error instanceof SocketRequestError);
        }
        assert.equal(writes().length, acceptedWriteCount, 'every rejected History write must emit zero wire calls');

        const parallelSession = new HistoryOtSession('doc-id', witness.generation, {
            level: 'review',
            userId: 'user-a',
        });
        parallelSession.acceptJoin(witness.generation, {
            snapshot: {content: 'a'},
            version: 4,
            operations: [],
            ranges: {},
            otType: 'history-ot',
        });
        const parallelStage = parallelSession.stage(witness.generation, {
            operation: [{textOperation: [1, {
                i: 'p',
                tracking: {
                    type: 'insert',
                    userId: 'user-a',
                    ts: '2026-08-31T00:00:00.000Z',
                },
            }]}],
            meta: {tc: 'parallel-seed'},
            intent,
            publicId: witness.publicId,
        });
        assert.ok(parallelStage.submissionToken);
        const beforeParallel = writes().length;
        const firstParallel = socket.applyHistoryOtUpdate(
            'doc-id', parallelStage.envelope!, intent,
            parallelStage.submissionToken, parallelSession, witness,
        );
        const secondParallel = socket.applyHistoryOtUpdate(
            'doc-id', parallelStage.envelope!, intent,
            parallelStage.submissionToken, parallelSession, witness,
        );
        const secondParallelRejected = assert.rejects(
            secondParallel,
            (error: unknown) => error instanceof SocketRequestError,
        );
        await waitForEmission(transport, 'applyOtUpdate', beforeParallel + 1);
        await secondParallelRejected;
        assert.equal(
            writes().length,
            beforeParallel + 1,
            'one submission token must cross the wire boundary at most once',
        );
        transport.acknowledge('applyOtUpdate', undefined);
        await firstParallel;

        const raceSession = new HistoryOtSession('doc-id', witness.generation, {
            level: 'review',
            userId: 'user-a',
        });
        raceSession.acceptJoin(witness.generation, {
            snapshot: {content: 'a'},
            version: 4,
            operations: [],
            ranges: {},
            otType: 'history-ot',
        });
        const raceStaged = raceSession.stage(witness.generation, {
            operation: [{textOperation: [1, {
                i: 'z',
                tracking: {
                    type: 'insert',
                    userId: 'user-a',
                    ts: '2026-08-31T00:00:00.000Z',
                },
            }]}],
            meta: {tc: 'race-seed'},
            intent,
            publicId: witness.publicId,
        });
        const emittedBeforeInvalidation = writes().length;
        const racingWrite = socket.applyHistoryOtUpdate(
            'doc-id',
            raceStaged.envelope!,
            intent,
            raceStaged.submissionToken!,
            raceSession,
            witness,
        );
        transport.serverEmit('project:membership:changed', {members: true});
        await assert.rejects(
            racingWrite,
            (error: unknown) => error instanceof SocketRequestError,
        );
        assert.equal(
            writes().length,
            emittedBeforeInvalidation,
            'permission invalidation before emit must produce zero wire calls',
        );
        assert.equal(raceSession.getState().pendingWireAttempted, false);
    });

    it('forwards raw thread events and clears current and remembered authority on invalidation', async () => {
        const {base, socket} = createAPI();
        const transport = base.sockets[0];
        const events: unknown[] = [];
        let invalidations = 0;
        socket.updateEventHandlers({
            onHistoryOtThreadEvent: (event, args) => events.push({event, args}),
            onPermissionsInvalidated: () => { invalidations += 1; },
        });
        transport.serverEmit('connect');
        const joined = socket.joinProject('project-id');
        transport.serverEmit('joinProjectResponse', {
            publicId: 'P.owner', project, permissionsLevel: 'owner', protocolVersion: 2,
        });
        await joined;

        const rawThread = {id: 'comment-a', opaque: {preserved: [1, true, null]}};
        transport.serverEmit('new-comment', 'thread-a', rawThread);
        assert.deepEqual(events, [{event: 'new-comment', args: ['thread-a', rawThread]}]);

        transport.serverEmit('project:membership:changed', {members: true});
        assert.equal(invalidations, 1);
        assert.equal(socket.projectSession?.permissionsLevel, undefined);
        assert.equal((socket as any).lastKnownPermissionsLevel, undefined);
        const emittedBeforeWrite = transport.emitted.length;
        await assert.rejects(
            socket.applyOtUpdate(
                'doc-id',
                {doc: 'doc-id', v: 1, op: [{p: 0, i: 'x'}]},
                socket.projectSession!,
            ),
            (error: unknown) => error instanceof SocketRequestError && error.code === 'server_error',
        );
        assert.equal(transport.emitted.length, emittedBeforeWrite);
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
