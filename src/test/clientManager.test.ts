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
let selectionHandler: (event: any) => Promise<void>;
const vscodeMock = {
    StatusBarAlignment: {Left: 1},
    DecorationRangeBehavior: {OpenClosed: 1},
    ThemeColor: class ThemeColor { constructor(readonly id: string) {} },
    MarkdownString: class MarkdownString {
        isTrusted = false;
        supportHtml = false;
        appendMarkdown() {}
    },
    Range: class Range {
        constructor(...args: any[]) {
            if (args.length === 4 && args.some(value =>
                !Number.isSafeInteger(value) || value < 0
            )) {
                throw new Error('Invalid arguments');
            }
        }
    },
    Selection: class Selection { constructor(..._args: any[]) {} },
    Uri: {parse: (value: string) => ({toString: () => value})},
    l10n: {t: (value: string) => value},
    workspace: {
        workspaceFolders: undefined,
        visibleTextEditors: [],
        getConfiguration: () => ({get: (_key: string, fallback: unknown) => fallback}),
    },
    window: {
        onDidChangeTextEditorSelection: (handler: typeof selectionHandler) => {
            selectionHandler = handler;
            return {dispose() {}};
        },
        onDidChangeVisibleTextEditors: () => ({dispose() {}}),
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

    function createManager(socket: FakeSocket, publicId = 'P.local', resolveDocument = false) {
        const vfs = {
            isReady: true,
            canPublishPendingDeletionCursor: () => false,
            _resolveById: (docId: string) => resolveDocument && docId === 'doc-id' ? {
                path: '/main.tex',
                fileEntity: {_id: 'doc-id'},
            } : undefined,
            pathToUri: () => ({toString: () => ''}),
        };
        const context = {extensionUri: {}};
        return new ClientManager(vfs, context, publicId, socket);
    }

    for (const kind of [1, undefined]) {
    it(`sends only the latest cursor after its text is acknowledged (kind=${kind})`, async () => {
        const socket = new FakeSocket() as any;
        const manager = createManager(socket);
        const sync = deferred<boolean>();
        const sent: number[] = [];
        manager.vfs._resolveUri = async () => ({fileEntity: {_id: 'doc-id'}});
        manager.vfs.flushEditorChangesForPresence = () => sync.promise;
        socket.updatePosition = async (_id: string, _row: number, column: number) => { sent.push(column); };
        void manager.triggers;
        const document = {uri: {scheme: 'overleaf-workshop'}, version: 1, offsetAt: () => 0};
        const event = (column: number) => ({kind, textEditor: {document}, selections: [{active: {line: 0, character: column}}]});
        try {
            const first = selectionHandler(event(8));
            document.version = 2;
            const last = selectionHandler(event(3));
            await flushAsyncWork();
            assert.deepEqual(sent, []);
            sync.resolve(true);
            await Promise.all([first, last]);
            assert.deepEqual(sent, [3]);
        } finally { manager.dispose(); }
    });
    }

    it('does not publish cursor coordinates for unconfirmed or changed text', async () => {
        const socket = new FakeSocket() as any;
        const manager = createManager(socket);
        let sent = 0;
        manager.vfs._resolveUri = async () => ({fileEntity: {_id: 'doc-id'}});
        socket.updatePosition = async () => { sent++; };
        void manager.triggers;
        const document = {uri: {scheme: 'overleaf-workshop'}, version: 1, offsetAt: () => 0};
        const event = {kind: 1, textEditor: {document}, selections: [{active: {line: 0, character: 3}}]};
        try {
            manager.vfs.flushEditorChangesForPresence = async () => false;
            await selectionHandler(event);
            manager.vfs.flushEditorChangesForPresence = async () => { document.version++; return true; };
            await selectionHandler(event);
            manager.vfs.flushEditorChangesForPresence = async () => { throw new Error('unconfirmed'); };
            await selectionHandler(event);
            assert.equal(sent, 0);
        } finally { manager.dispose(); }
    });

    it('publishes a proven deletion prefix before flushing text, then confirms the final caret', async () => {
        const socket = new FakeSocket() as any;
        const manager = createManager(socket);
        const sync = deferred<boolean>();
        const order: string[] = [];
        manager.vfs._resolveUri = async () => ({fileEntity: {_id: 'doc-id'}});
        manager.vfs.canPublishPendingDeletionCursor = (_document: unknown, offset: number) => offset === 3;
        manager.vfs.flushEditorChangesForPresence = () => { order.push('flush'); return sync.promise; };
        socket.updatePosition = async (_id: string, row: number, column: number) => {
            order.push(`cursor:${row}:${column}`);
        };
        void manager.triggers;
        const document = {uri: {scheme: 'overleaf-workshop'}, version: 2, offsetAt: () => 3};
        try {
            const pending = selectionHandler({textEditor: {document}, selections: [{active: {line: 0, character: 3}}]});
            await flushAsyncWork();
            assert.deepEqual(order, ['cursor:0:3', 'flush']);
            sync.resolve(true);
            await pending;
            assert.deepEqual(order, ['cursor:0:3', 'flush', 'cursor:0:3']);
        } finally { manager.dispose(); }
    });

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

    it('keeps a collaborator online when cursor coordinates are absent and accepts a later position', async () => {
        const socket = new FakeSocket();
        const initial = deferred<OnlineUserSchema[]>();
        socket.snapshots.push(initial);
        const manager = createManager(socket, 'P.local', true);
        initial.resolve([]);
        await flushAsyncWork();

        await (manager as any).updatePosition(
            'P.remote',
            'doc-id',
            undefined,
            undefined,
            {
                id: 'P.remote',
                user_id: 'remote',
                name: 'Remote User',
                email: 'remote@example.test',
                doc_id: 'doc-id',
            } satisfies UpdateUserSchema,
        );
        assert.equal((manager as any).onlineUsers['P.remote'].selection, undefined);

        await (manager as any).updatePosition('P.remote', 'doc-id', 4, 5);
        const remote = (manager as any).onlineUsers['P.remote'];
        assert.equal(remote.row, 4);
        assert.equal(remote.column, 5);
        assert.equal(remote.selection.ranges.length, 1);
        manager.dispose();
    });
});
