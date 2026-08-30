import { strict as assert } from 'assert';
import { AckSocket, assertCurrentConnection, requestWithAck, SocketRequestError, withTimeout } from '../api/socketRequest';

/* eslint-disable @typescript-eslint/naming-convention */

class FakeSocket implements AckSocket {
    connected = true;
    ackPackets = 0;
    acks: Record<number, (...args: any[]) => void> = {};
    emitted: Array<{event: string, args: any[]}> = [];
    private listeners = new Map<string, Set<(...args: any[]) => void>>();
    private acknowledgements = new Map<string, (...args: any[]) => void>();

    emit(event: string, ...args: any[]): void {
        this.emitted.push({event, args});
        const acknowledgement = args.at(-1);
        if (typeof acknowledgement === 'function') {
            this.acknowledgements.set(event, acknowledgement);
            this.ackPackets += 1;
            this.acks[this.ackPackets] = acknowledgement;
        }
    }

    on(event: string, listener: (...args: any[]) => void): void {
        const listeners = this.listeners.get(event) ?? new Set();
        listeners.add(listener);
        this.listeners.set(event, listeners);
    }

    removeListener(event: string, listener: (...args: any[]) => void): void {
        this.listeners.get(event)?.delete(listener);
    }

    acknowledge(event: string, error?: unknown, ...data: any[]) {
        const acknowledgement = this.acknowledgements.get(event);
        acknowledgement?.(error, ...data);
        const ackId = Object.entries(this.acks).find(([, callback]) => callback === acknowledgement)?.[0];
        if (ackId) { delete this.acks[Number(ackId)]; }
    }

    disconnect() {
        this.connected = false;
        this.listeners.get('disconnect')?.forEach(listener => listener());
    }

    trigger(event: string, ...args: any[]) {
        this.listeners.get(event)?.forEach(listener => listener(...args));
    }

    listenerCount(event: string) {
        return this.listeners.get(event)?.size ?? 0;
    }
}

class SynchronousAckSocket extends FakeSocket {
    emit(event: string, ...args: any[]): void {
        this.emitted.push({event, args});
        const acknowledgement = args.at(-1);
        if (typeof acknowledgement === 'function') {
            this.ackPackets += 1;
            this.acks[this.ackPackets] = acknowledgement;
            acknowledgement(undefined, 'sync');
        }
    }
}

describe('requestWithAck', () => {
    it('does not buffer a request while disconnected', async () => {
        const socket = new FakeSocket();
        socket.connected = false;

        await assert.rejects(
            requestWithAck(socket, 'applyOtUpdate', [], 20, 1, generation => generation === 1),
            (error: unknown) => error instanceof SocketRequestError &&
                error.code === 'not_connected' && !error.outcomeUnknown,
        );
        assert.equal(socket.emitted.length, 0);
    });

    it('resolves an acknowledgement and removes its disconnect listener', async () => {
        const socket = new FakeSocket();
        const request = requestWithAck<[string]>(
            socket,
            'joinDoc',
            ['doc-id'],
            50,
            2,
            generation => generation === 2,
        );

        assert.equal(socket.listenerCount('disconnect'), 1);
        socket.acknowledge('joinDoc', undefined, 'ok');
        assert.deepEqual(await request, ['ok']);
        assert.equal(socket.listenerCount('disconnect'), 0);
        assert.equal(Object.keys(socket.acks).length, 0);
    });

    it('cleans the socket ack table when acknowledgement is synchronous', async () => {
        const socket = new SynchronousAckSocket();
        const result = await requestWithAck<[string]>(
            socket,
            'joinDoc',
            ['doc-id'],
            50,
            2,
            generation => generation === 2,
        );
        assert.deepEqual(result, ['sync']);
        assert.equal(Object.keys(socket.acks).length, 0);
        assert.equal(socket.listenerCount('disconnect'), 0);
    });

    it('marks an interrupted in-flight write as outcome unknown', async () => {
        const socket = new FakeSocket();
        const request = requestWithAck(
            socket,
            'applyOtUpdate',
            ['doc-id', {v: 1, op: [{p: 0, i: 'x'}]}],
            50,
            3,
            generation => generation === 3,
        );

        socket.disconnect();
        socket.acknowledge('applyOtUpdate', undefined);
        await assert.rejects(
            request,
            (error: unknown) => error instanceof SocketRequestError &&
                error.code === 'disconnected' && error.outcomeUnknown,
        );
    });

    it('ignores a late acknowledgement from an older generation', async () => {
        const socket = new FakeSocket();
        let currentGeneration = 4;
        const request = requestWithAck(
            socket,
            'joinProject',
            [{project_id: 'project-id'}],
            50,
            currentGeneration,
            generation => generation === currentGeneration,
        );

        currentGeneration = 5;
        socket.acknowledge('joinProject', undefined, {name: 'stale'});
        await assert.rejects(
            request,
            (error: unknown) => error instanceof SocketRequestError &&
                error.code === 'stale_connection' && error.outcomeUnknown,
        );
    });

    it('cancels a join request immediately when the server rejects the connection', async () => {
        const socket = new FakeSocket();
        const request = requestWithAck(
            socket,
            'joinProject',
            [{project_id: 'project-id'}],
            50,
            5,
            generation => generation === 5,
            {
                event: 'connectionRejected',
                toError: (error: {message: string}) => new SocketRequestError(
                    'server_error',
                    error.message,
                    false,
                ),
            },
        );

        socket.trigger('connectionRejected', {message: 'unsupported scheme'});
        await assert.rejects(
            request,
            (error: unknown) => error instanceof SocketRequestError &&
                error.code === 'server_error' && !error.outcomeUnknown,
        );
        assert.equal(socket.listenerCount('connectionRejected'), 0);
        assert.equal(socket.listenerCount('disconnect'), 0);
        assert.equal(Object.keys(socket.acks).length, 0);
    });

    it('reports an acknowledgement timeout as outcome unknown', async () => {
        const socket = new FakeSocket();
        await assert.rejects(
            requestWithAck(socket, 'applyOtUpdate', [], 5, 6, generation => generation === 6),
            (error: unknown) => error instanceof SocketRequestError &&
                error.code === 'timeout' && error.outcomeUnknown,
        );
        assert.equal(socket.listenerCount('disconnect'), 0);
        assert.equal(Object.keys(socket.acks).length, 0);
    });
});

describe('withTimeout', () => {
    it('returns a value that arrives before the deadline', async () => {
        assert.equal(await withTimeout(Promise.resolve('ready'), 'ready', 20), 'ready');
    });

    it('rejects a missing signal with a structured timeout', async () => {
        await assert.rejects(
            withTimeout(new Promise<void>(() => {}), 'joinProjectResponse', 5),
            (error: unknown) => error instanceof SocketRequestError && error.code === 'timeout',
        );
    });
});

describe('assertCurrentConnection', () => {
    it('accepts the same connected generation', () => {
        assert.doesNotThrow(() => assertCurrentConnection(7, 7, true));
    });

    it('rejects a project result completed by an older generation', () => {
        assert.throws(
            () => assertCurrentConnection(7, 8, true),
            (error: unknown) => error instanceof SocketRequestError && error.code === 'stale_connection',
        );
    });

    it('rejects a result when its transport disconnected before commit', () => {
        assert.throws(
            () => assertCurrentConnection(7, 7, false),
            (error: unknown) => error instanceof SocketRequestError && error.code === 'stale_connection',
        );
    });
});
