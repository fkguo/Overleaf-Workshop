/* eslint-disable @typescript-eslint/naming-convention */
import { strict as assert } from 'assert';
import { OnlineUserSchema, ProjectSessionSchema, UpdateUserSchema } from '../api/socketio';

type Deferred<T> = {
    promise: Promise<T>,
    resolve: (value: T) => void,
};

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(res => { resolve = res; });
    return {promise, resolve};
}

const statusItems: any[] = [];
const vscodeMock = {
    StatusBarAlignment: {Left: 1},
    DecorationRangeBehavior: {OpenClosed: 1},
    ThemeColor: class ThemeColor { constructor(readonly id: string) {} },
    MarkdownString: class MarkdownString {
        isTrusted = false;
        supportHtml = false;
        appendMarkdown() {}
    },
    Range: class Range { constructor(..._args: any[]) {} },
    Selection: class Selection { constructor(..._args: any[]) {} },
    Uri: {parse: (value: string) => ({toString: () => value})},
    l10n: {t: (value: string) => value},
    workspace: {
        workspaceFolders: undefined,
        visibleTextEditors: [],
        getConfiguration: () => ({get: (_key: string, fallback: unknown) => fallback}),
    },
    window: {
        visibleTextEditors: [],
        createStatusBarItem: () => {
            const status = {show() {}, dispose() {}};
            statusItems.push(status);
            return status;
        },
        createTextEditorDecorationType: () => ({dispose() {}}),
        showErrorMessage: () => Promise.resolve(),
        showQuickPick: () => Promise.resolve(undefined),
        showTextDocument: () => Promise.resolve(undefined),
    },
    commands: {
        registerCommand: () => ({dispose() {}}),
        executeCommand: () => Promise.resolve(),
    },
};

class FakeChatViewProvider {
    hasUnread = 0;
    readonly triggers: any[] = [];
    updatePublicId(_publicId: string) {}
    insertText() {}
}

class FakeSocket {
    handlers: any = {};
    snapshots: Array<Deferred<OnlineUserSchema[]>> = [];
    isUsingAlternativeConnectionScheme = false;
    unSyncFileChanges = 0;

    updateEventHandlers(handlers: any) {
        this.handlers = {...this.handlers, ...handlers};
    }

    getConnectedUsers() {
        const snapshot = this.snapshots.shift();
        if (!snapshot) { return Promise.reject(new Error('No queued snapshot')); }
        return snapshot.promise;
    }
}

function onlineUser(clientId: string, userId: string = clientId): OnlineUserSchema {
    return {
        client_age: 1,
        client_id: clientId,
        connected: true,
        cursorData: {doc_id: 'doc-id', row: 2, column: 3},
        email: `${userId}@example.test`,
        first_name: userId,
        last_updated_at: '1',
        user_id: userId,
    };
}

async function flushAsyncWork() {
    await Promise.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
}

describe('ClientManager presence snapshots', () => {
    let ClientManager: any;

    before(() => {
        const nodeModule = require('module') as any;
        const originalLoad = nodeModule._load;
        nodeModule._load = function(request: string, parent: unknown, isMain: boolean) {
            if (request === 'vscode') { return vscodeMock; }
            if (request === './chatViewProvider') { return {ChatViewProvider: FakeChatViewProvider}; }
            if (request === '../scm/localReplicaSCM') {
                return {LocalReplicaSCMProvider: {pathToUri: async () => undefined}};
            }
            return originalLoad.call(this, request, parent, isMain);
        };
        try {
            const modulePath = require.resolve('../collaboration/clientManager');
            delete require.cache[modulePath];
            ClientManager = require('../collaboration/clientManager').ClientManager;
        } finally {
            nodeModule._load = originalLoad;
        }
    });

    function createManager(socket: FakeSocket, publicId = 'P.local') {
        const vfs = {
            isReady: true,
            _resolveById: () => undefined,
            pathToUri: () => ({toString: () => ''}),
        };
        const context = {extensionUri: {}};
        return new ClientManager(vfs, context, publicId, socket);
    }

    it('clears stale sessions without overwriting live events received during the snapshot', async () => {
        const socket = new FakeSocket();
        const initial = deferred<OnlineUserSchema[]>();
        socket.snapshots.push(initial);
        const manager = createManager(socket);
        initial.resolve([onlineUser('P.stale'), onlineUser('P.steady')]);
        await flushAsyncWork();
        assert.deepEqual(Object.keys((manager as any).onlineUsers).sort(), ['P.stale', 'P.steady']);

        const reconnectSnapshot = deferred<OnlineUserSchema[]>();
        socket.snapshots.push(reconnectSnapshot);
        socket.handlers.onProjectJoined({
            publicId: 'P.local-new',
            permissionsLevel: 'owner',
            protocolVersion: 2,
            generation: 2,
        } satisfies ProjectSessionSchema);
        socket.handlers.onClientDisconnected('P.stale');
        socket.handlers.onClientUpdated({
            id: 'P.live',
            user_id: 'live',
            name: 'live',
            email: 'live@example.test',
            doc_id: 'doc-id',
            row: 4,
            column: 5,
        } satisfies UpdateUserSchema);
        reconnectSnapshot.resolve([onlineUser('P.stale'), onlineUser('P.steady')]);
        await flushAsyncWork();

        assert.deepEqual(Object.keys((manager as any).onlineUsers).sort(), ['P.live', 'P.steady']);
        manager.dispose();
    });

    it('filters only this window previous public ids and preserves another window for the same user', async () => {
        const socket = new FakeSocket();
        const initial = deferred<OnlineUserSchema[]>();
        socket.snapshots.push(initial);
        const manager = createManager(socket, 'P.local-old');
        socket.handlers.onConnectionAccepted('P.local-new');
        initial.resolve([
            onlineUser('P.local-old', 'same-user'),
            onlineUser('P.local-new', 'same-user'),
            onlineUser('P.other-window', 'same-user'),
        ]);
        await flushAsyncWork();

        assert.deepEqual(Object.keys((manager as any).onlineUsers), ['P.other-window']);
        manager.dispose();
    });
});
