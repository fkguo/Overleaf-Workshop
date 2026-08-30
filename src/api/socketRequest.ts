export interface AckSocket {
    connected?: boolean;
    ackPackets?: number;
    acks?: Record<number, (...args: any[]) => void>;
    emit(event: string, ...args: any[]): void;
    on?(event: string, listener: (...args: any[]) => void): void;
    removeListener?(event: string, listener: (...args: any[]) => void): void;
}

export type SocketRequestErrorCode =
    | 'not_connected'
    | 'disconnected'
    | 'stale_connection'
    | 'timeout'
    | 'server_error';

export class SocketRequestError extends Error {
    constructor(
        public readonly code: SocketRequestErrorCode,
        message: string,
        public readonly outcomeUnknown: boolean,
        public readonly cause?: unknown,
    ) {
        super(message);
        this.name = 'SocketRequestError';
    }
}

export function assertCurrentConnection(
    expectedGeneration: number,
    currentGeneration: number,
    connected: boolean,
) {
    if (!connected || expectedGeneration !== currentGeneration) {
        throw new SocketRequestError(
            'stale_connection',
            'Socket connection changed before the operation became ready',
            false,
        );
    }
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === 'string') {
        return error;
    }
    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
}

/**
 * Send one Socket.IO request which expects an acknowledgement callback.
 *
 * The socket and connection generation are captured at send time. A request is
 * rejected when that generation disconnects, and a late acknowledgement from an
 * older generation can never make the request appear successful.
 */
export function requestWithAck<T extends any[]>(
    socket: AckSocket,
    event: string,
    args: any[],
    timeoutMs: number,
    generation: number,
    isCurrentGeneration: (generation: number) => boolean,
    abort?: {
        event: string,
        toError: (...args: any[]) => SocketRequestError,
    },
): Promise<T> {
    if (socket.connected === false || !isCurrentGeneration(generation)) {
        return Promise.reject(new SocketRequestError(
            'not_connected',
            `Socket is not connected for ${event}`,
            false,
        ));
    }

    return new Promise<T>((resolve, reject) => {
        let settled = false;
        let ackId: number | undefined;
        let acknowledgement: ((error: unknown, ...data: any[]) => void) | undefined;

        const cleanup = () => {
            clearTimeout(timer);
            socket.removeListener?.('disconnect', onDisconnect);
            if (abort) {
                socket.removeListener?.(abort.event, onAbort);
            }
            if (ackId !== undefined && acknowledgement && socket.acks?.[ackId] === acknowledgement) {
                delete socket.acks[ackId];
            }
        };
        const fail = (error: SocketRequestError) => {
            if (settled) { return; }
            settled = true;
            cleanup();
            reject(error);
        };
        const onDisconnect = () => {
            fail(new SocketRequestError(
                'disconnected',
                `Socket disconnected while waiting for ${event}`,
                true,
            ));
        };
        const onAbort = (...args: any[]) => {
            if (abort) { fail(abort.toError(...args)); }
        };
        const timer = setTimeout(() => {
            fail(new SocketRequestError(
                'timeout',
                `Timed out waiting for ${event} acknowledgement`,
                true,
            ));
        }, timeoutMs);

        socket.on?.('disconnect', onDisconnect);
        if (abort) {
            socket.on?.(abort.event, onAbort);
        }
        try {
            const previousAckId = socket.ackPackets;
            // socket.io 0.9 allocates the next ack id during emit. Record the
            // expected id first so a synchronous acknowledgement can clean it.
            ackId = previousAckId === undefined ? undefined : previousAckId + 1;
            acknowledgement = (error: unknown, ...data: any[]) => {
                if (settled) { return; }
                if (!isCurrentGeneration(generation)) {
                    fail(new SocketRequestError(
                        'stale_connection',
                        `Ignored stale ${event} acknowledgement`,
                        true,
                    ));
                    return;
                }
                if (error) {
                    fail(new SocketRequestError(
                        'server_error',
                        `${event} failed: ${errorMessage(error)}`,
                        false,
                        error,
                    ));
                    return;
                }
                settled = true;
                cleanup();
                resolve(data as T);
            };
            socket.emit(event, ...args, acknowledgement);
            if (socket.ackPackets !== undefined && socket.ackPackets !== previousAckId) {
                ackId = socket.ackPackets;
            }
            if (settled && ackId !== undefined && socket.acks?.[ackId] === acknowledgement) {
                delete socket.acks[ackId];
            }
        } catch (error) {
            fail(new SocketRequestError(
                'server_error',
                `Failed to send ${event}: ${errorMessage(error)}`,
                false,
                error,
            ));
        }
    });
}

export function withTimeout<T>(promise: Promise<T>, event: string, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new SocketRequestError(
                'timeout',
                `Timed out waiting for ${event}`,
                false,
            ));
        }, timeoutMs);

        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}
