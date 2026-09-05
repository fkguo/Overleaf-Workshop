import {strict as assert} from 'assert';
import {createHash} from 'crypto';
import {SocketRequestError} from '../api/socketRequest';
import {requireSavedCompileInputs} from '../compile/compileRun';
import {
    applyTextOperations,
    createAliasProviderProject,
    createEventWiredProviderProject,
    createVirtualProject,
    DeterministicRealtimeServer,
    HarnessStorage,
    LooseJoinDocResponse,
    openAuthoritativeText,
    productionWorkspaceEvents,
    resetHarnessDocuments,
    resetHarnessRuntime,
    settleAsyncWork,
    SimulatedDirtyEditor,
    SimulatedEditorHost,
    TextOperation,
    VirtualProjectHarness,
} from './fixtures/staleBufferRealtimeHarness';

const PROJECT_A = 'project-a';
const PROJECT_B = 'project-b';
const OWN_CONFIRMED = 'OWN_CONFIRMED';
const COLLABORATOR = 'COLLABORATOR';
const ENABLE_CLEAN_EDITOR = 'Reload Remote and Enable Editing';
const CREATE_NEW_DOCUMENT = 'Create New Remote Document';

function addProject(
    server: DeterministicRealtimeServer,
    content: string,
    projectId = PROJECT_A,
    projectName = projectId,
    version = 1,
): void {
    server.addProject({
        projectId,
        projectName,
        docId: 'same-doc-id',
        fileName: 'main.tex',
        content,
        version,
    });
}

function createHarness(
    server: DeterministicRealtimeServer,
    storage = new HarnessStorage(),
    windowId = 'window-a',
    projectId = PROJECT_A,
): VirtualProjectHarness {
    return createVirtualProject({server, storage, windowId, projectId});
}

function replaceAt(content: string, from: string, to: string): TextOperation[] {
    const position = content.indexOf(from);
    assert.notEqual(position, -1, `Unable to find ${from} in deterministic fixture text`);
    return [
        {p: position, d: from},
        {p: position, i: to},
    ];
}

async function waitUntil(
    predicate: () => boolean,
    message: string,
    timeoutMs = 1000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(predicate(), true, message);
}

function rejectNextAcknowledgementAfterSenderConfirmation(
    harness: {socket: {applyOtUpdate: (...args: any[]) => Promise<void>}},
): void {
    const originalApply = harness.socket.applyOtUpdate.bind(harness.socket);
    harness.socket.applyOtUpdate = async (...args: any[]) => {
        harness.socket.applyOtUpdate = originalApply;
        await originalApply(...args);
        await settleAsyncWork();
        throw new SocketRequestError(
            'server_error',
            'contradictory acknowledgement failure after sender confirmation',
            false,
        );
    };
}

async function assertJoinCatchUpFailsClosed(
    label: string,
    response: LooseJoinDocResponse,
    liveUpdates: unknown[] = [],
    expectedReadError?: RegExp,
): Promise<void> {
    const authoritative = 'aXbc';
    const local = 'LOCAL';
    const server = new DeterministicRealtimeServer();
    addProject(server, authoritative, PROJECT_A, label, 10);
    const harness = await createEventWiredProviderProject({
        server,
        storage: new HarnessStorage(),
        windowId: label,
        projectId: PROJECT_A,
    });
    server.injectNextJoinDocResponse(PROJECT_A, 'same-doc-id', response);
    server.injectNextJoinLiveUpdates(PROJECT_A, 'same-doc-id', liveUpdates);

    try {
        let staleRead: string | undefined;
        let readError: unknown;
        try {
            staleRead = new TextDecoder().decode(await harness.provider.readFile(harness.uri));
        } catch (error) {
            staleRead = undefined;
            readError = error;
        }
        const editor = new SimulatedDirtyEditor(harness.uri, staleRead ?? local);
        if (staleRead === undefined) {
            editor.attach();
        } else {
            // On a vulnerable implementation the contradictory join can bind
            // abc@9 before this edit. Continue through the public lifecycle so
            // the regression observes any stale wire attempt before asserting
            // that the initial read must have been rejected.
            editor.openClean(harness.events);
            await settleAsyncWork();
            await settleAsyncWork();
            editor.editThroughEvents(local, harness.events);
        }
        const result = await editor.saveThroughProvider(harness.provider, harness.events);

        assert.equal(staleRead, undefined);
        if (expectedReadError) {
            assert.match(String(readError), expectedReadError);
        }
        assert.equal(result.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), local);
        assert.equal(server.joinDocCallCount, 1);
        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.text(PROJECT_A), authoritative);
        assert.equal(server.version(PROJECT_A), 10);
    } finally {
        harness.dispose();
    }
}

describe('stale-buffer rollback safety', () => {
    beforeEach(() => resetHarnessDocuments());
    after(() => resetHarnessRuntime());

    it('rejects a string-version join-time live update before a dirty public save can emit OT', async () => {
        await assertJoinCatchUpFailsClosed('malformed-join-version', {
            docLines: ['abc'],
            version: 9,
            updates: [],
            ranges: {},
        }, [{doc: 'same-doc-id', v: '9', op: [{p: 1, i: 'X'}]}]);
    });

    it('rejects a malformed outer join-time live update before a dirty public save can emit OT', async () => {
        await assertJoinCatchUpFailsClosed('malformed-join-outer', {
            docLines: ['abc'],
            version: 9,
            updates: [],
            ranges: {},
        }, [null]);
    });

    it('rejects a revision gap in join-time live catch-up before a dirty public save can emit OT', async () => {
        await assertJoinCatchUpFailsClosed('gapped-join-catch-up', {
            docLines: ['abc'],
            version: 9,
            updates: [],
            ranges: {},
        }, [{doc: 'same-doc-id', v: 10, op: [{p: 1, i: 'X'}]}]);
    });

    it('rejects conflicting duplicate join-time live revisions before a dirty public save can emit OT', async () => {
        await assertJoinCatchUpFailsClosed('duplicate-join-catch-up', {
            docLines: ['abc'],
            version: 9,
            updates: [],
            ranges: {},
        }, [
            {doc: 'same-doc-id', v: 9, op: [{p: 1, i: 'X'}]},
            {doc: 'same-doc-id', v: 9, op: [{p: 1, i: 'Y'}]},
        ]);
    });

    it('rejects malformed join-time live operation components before a dirty public save can emit OT', async () => {
        await assertJoinCatchUpFailsClosed('malformed-join-component', {
            docLines: ['abc'],
            version: 9,
            updates: [],
            ranges: {},
        }, [{doc: 'same-doc-id', v: 9, op: [{p: '1', i: 'X'}]}]);
    });

    it('rejects join-time live catch-up that cannot replay against its snapshot', async () => {
        await assertJoinCatchUpFailsClosed('unreplayable-join-catch-up', {
            docLines: ['abc'],
            version: 9,
            updates: [],
            ranges: {},
        }, [{doc: 'same-doc-id', v: 9, op: [{p: 0, d: 'zzz'}]}]);
    });

    it('rejects a join-time live operation revision that predates the join snapshot', async () => {
        await assertJoinCatchUpFailsClosed('pre-anchor-join-operation', {
            docLines: ['abc'],
            version: 9,
            updates: [],
            ranges: {},
        }, [{doc: 'same-doc-id', v: 8, op: [{p: 0, d: 'zzz'}]}]);
    });

    it('rejects a join-time op-less revision that predates the join snapshot', async () => {
        await assertJoinCatchUpFailsClosed('pre-anchor-join-confirmation', {
            docLines: ['abc'],
            version: 9,
            updates: [],
            ranges: {},
        }, [{doc: 'same-doc-id', v: 8}]);
    });

    it('rejects nonempty response updates as a join protocol contradiction', async () => {
        await assertJoinCatchUpFailsClosed('nonempty-response-updates', {
            docLines: ['abc'],
            version: 9,
            updates: [{v: 9, op: [{p: 1, i: 'X'}]}],
            ranges: {},
        }, [], /unexpected catch-up operations/);
    });

    it('rejects a snapshot revision above Number.MAX_SAFE_INTEGER', async () => {
        await assertJoinCatchUpFailsClosed('unsafe-snapshot-version', {
            docLines: ['abc'],
            version: Number.MAX_SAFE_INTEGER + 1,
            updates: [],
            ranges: {},
        }, [], /invalid snapshot/);
    });

    it('does not stage or publish a document with an empty remote id', () => {
        const server = new DeterministicRealtimeServer();
        addProject(server, 'abc', PROJECT_A, 'Empty Remote Id', 9);
        const harness = createHarness(server);

        harness.vfs.documentIdsByPath.set(harness.uri.toString(), 'stale-doc-id');
        harness.vfs.stagedEditorBases.set(harness.uri.toString(), {
            docId: 'stale-doc-id',
            version: 8,
            content: 'stale',
        });
        harness.vfs.stageEditorBase(harness.uri, {_id: '', version: 9}, 'abc');

        assert.equal(harness.vfs.documentIdsByPath.has(harness.uri.toString()), false);
        assert.equal(harness.vfs.stagedEditorBases.has(harness.uri.toString()), false);
        harness.vfs.dispose();
    });

    it('rejects a join-time live revision above Number.MAX_SAFE_INTEGER', async () => {
        await assertJoinCatchUpFailsClosed('unsafe-live-version', {
            docLines: ['abc'],
            version: 9,
            updates: [],
            ranges: {},
        }, [{
            doc: 'same-doc-id',
            v: Number.MAX_SAFE_INTEGER + 1,
            op: [{p: 1, i: 'X'}],
        }], /invalid revision/);
    });

    it('replays exact duplicate join-time live updates once as the public editor authority', async () => {
        const authoritative = 'aXbc';
        const desired = 'aXbc!';
        const response: LooseJoinDocResponse = {
            docLines: ['abc'],
            version: 9,
            updates: [],
            ranges: {},
        };
        const server = new DeterministicRealtimeServer();
        addProject(server, authoritative, PROJECT_A, 'Valid Join Catch-Up', 10);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'valid-join-catch-up',
            projectId: PROJECT_A,
        });
        server.injectNextJoinDocResponse(PROJECT_A, 'same-doc-id', response);
        server.injectNextJoinLiveUpdates(PROJECT_A, 'same-doc-id', [
            {
                doc: 'same-doc-id',
                v: 9,
                op: [{p: 1, i: 'X'}],
            },
            {
                doc: 'same-doc-id',
                v: 9,
                op: [{p: 1, i: 'X'}],
            },
        ]);

        try {
            assert.equal(
                new TextDecoder().decode(await harness.provider.readFile(harness.uri)),
                authoritative,
            );
            const editor = new SimulatedDirtyEditor(harness.uri, authoritative);
            editor.openClean(harness.events);
            await settleAsyncWork();
            await settleAsyncWork();
            assert.equal(harness.events.warningMessages.length, 0);

            editor.editThroughEvents(desired, harness.events);
            const result = await editor.saveThroughProvider(harness.provider, harness.events);

            assert.equal(result.saved, true);
            assert.equal(editor.dirty, false);
            assert.equal(server.capturedUpdates.length, 1);
            assert.equal(server.capturedUpdates[0].update.v, 10);
            assert.deepEqual(server.capturedUpdates[0].update.op, [{p: 4, i: '!'}]);
            assert.equal(server.text(PROJECT_A), desired);
            assert.equal(server.version(PROJECT_A), 11);
        } finally {
            harness.dispose();
        }
    });

    it('keeps direct VFS document creation unavailable without remote mutation', async () => {
        const server = new DeterministicRealtimeServer();
        addProject(server, 'authoritative', PROJECT_A, 'Direct Creation Disabled', 7);
        const harness = createHarness(server);

        for (const [name, content] of [
            ['empty.tex', new Uint8Array(0)],
            ['nonempty.tex', new TextEncoder().encode('local text')],
        ] as const) {
            const uri = harness.uri.with({path: `/Direct Creation Disabled/${name}`});
            await assert.rejects(
                harness.vfs.createFile(uri, content, true),
                (error: any) => error?.code === 'Unavailable',
            );
        }

        assert.equal(server.addDocCallCount, 0);
        assert.equal(server.uploadFileCallCount, 0);
        assert.equal(server.documentCreationCount, 0);
        assert.equal(server.projectEntitiesReadCount, 0);
        assert.equal(server.joinDocCallCount, 0);
        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.text(PROJECT_A), 'authoritative');
        assert.equal(server.version(PROJECT_A), 7);
    });

    it('opens a successful empty non-document file and publishes its open event', async () => {
        const server = new DeterministicRealtimeServer();
        addProject(server, 'authoritative', PROJECT_A, 'Empty Binary Read', 7);
        const harness = createHarness(server);
        const fileEntity = {_id: 'empty-file', name: 'empty.dat', _type: 'file'};
        harness.vfs._resolveUri = async () => ({fileType: 'file', fileEntity});
        harness.vfs.api.getFile = async () => ({type: 'success', content: undefined});
        const {EventBus} = require('../utils/eventBus') as typeof import('../utils/eventBus');
        const opened: unknown[] = [];
        const listener = EventBus.on('fileWillOpenEvent', event => opened.push(event.uri));

        try {
            const content = await harness.vfs.openFile(harness.uri);
            assert.equal(content.byteLength, 0);
            assert.deepEqual(opened, [harness.uri]);
        } finally {
            listener.dispose();
        }
    });

    it('opens a successful empty compile output and publishes its open event', async () => {
        const server = new DeterministicRealtimeServer();
        addProject(server, 'authoritative', PROJECT_A, 'Empty Output Read', 7);
        const harness = createHarness(server);
        const outputEntity = {
            _id: '__outputs',
            name: 'output.pdf',
            _type: 'outputs',
            path: 'output.pdf',
            url: '/build/editor-build/output/output.pdf',
        };
        harness.vfs._resolveUri = async () => ({fileType: 'outputs', fileEntity: outputEntity});
        harness.vfs.api.getFileFromClsi = async () => ({type: 'success', content: undefined});
        const {EventBus: eventBus} = require('../utils/eventBus') as typeof import('../utils/eventBus');
        const opened: unknown[] = [];
        const listener = eventBus.on('fileWillOpenEvent', event => opened.push(event.uri));

        try {
            const content = await harness.vfs.openFile(harness.uri);
            assert.equal(content.byteLength, 0);
            assert.deepEqual(opened, [harness.uri]);
            harness.vfs.api.getFileFromClsi = async () => ({type: 'error'});
            await assert.rejects(
                harness.vfs.openFile(harness.uri),
                (error: any) => error?.code === 'Unavailable',
            );
            assert.deepEqual(opened, [harness.uri]);
        } finally {
            listener.dispose();
        }
    });

    it('supports a standard provider read-write-read without an open editor', async () => {
        const base = '@article{old}\n';
        const desired = `${base}@article{new}\n`;
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Provider Bib Write', 4);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'provider-bib-write',
            projectId: PROJECT_A,
        });

        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), base);
        await harness.provider.writeFile(
            harness.uri,
            new TextEncoder().encode(desired),
            {create: false, overwrite: true},
        );
        assert.equal(
            new TextDecoder().decode(await harness.provider.readFile(harness.uri)),
            desired,
        );
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.logicalApplyCount, 1);
        assert.equal(server.text(PROJECT_A), desired);
        harness.dispose();
    });

    it('preserves a UTF-8 BOM across a provider append', async () => {
        const base = '\uFEFF@article{old}\n';
        const desired = `${base}@article{new}\n`;
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Provider BOM Write', 4);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'provider-bom-write',
            projectId: PROJECT_A,
        });

        assert.deepEqual(
            await harness.provider.readFile(harness.uri),
            new TextEncoder().encode(base),
        );
        await harness.provider.writeFile(
            harness.uri,
            new TextEncoder().encode(desired),
            {create: false, overwrite: true},
        );
        assert.deepEqual(
            await harness.provider.readFile(harness.uri),
            new TextEncoder().encode(desired),
        );
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.text(PROJECT_A), desired);
        assert.equal(
            server.capturedUpdates[0].update.hash,
            createHash('sha1').update(
                `blob ${desired.length}\x00${desired}`,
            ).digest('hex'),
        );
        harness.dispose();
    });

    it('uses the ShareJS UTF-16 string length for a non-ASCII provider append hash', async () => {
        const base = 'α';
        const desired = `${base}中文`;
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Provider Unicode Hash', 4);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'provider-unicode-hash',
            projectId: PROJECT_A,
        });

        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), base);
        await harness.provider.writeFile(
            harness.uri,
            new TextEncoder().encode(desired),
            {create: false, overwrite: true},
        );

        assert.equal(server.text(PROJECT_A), desired);
        assert.equal(
            server.capturedUpdates[0].update.hash,
            createHash('sha1').update(
                `blob ${desired.length}\x00${desired}`,
            ).digest('hex'),
        );
        assert.notEqual(desired.length, Buffer.byteLength(desired, 'utf8'));
        harness.dispose();
    });

    it('rejects malformed UTF-8 before a provider write can emit OT', async () => {
        const base = '@article{old}\n';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Provider Malformed UTF-8', 4);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'provider-malformed-utf8',
            projectId: PROJECT_A,
        });

        await harness.provider.readFile(harness.uri);
        await assert.rejects(harness.provider.writeFile(
            harness.uri,
            new Uint8Array([0xC3, 0x28]),
            {create: false, overwrite: true},
        ), /not valid UTF-8/i);

        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.text(PROJECT_A), base);
        harness.dispose();
    });

    it('does not let an old caller borrow a later provider read witness', async () => {
        const base = 'A';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Provider Caller Isolation', 6);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'provider-caller-isolation',
            projectId: PROJECT_A,
        });

        const callerOneBase = new TextDecoder().decode(
            await harness.provider.readFile(harness.uri),
        );
        const callerTwoBase = new TextDecoder().decode(
            await harness.provider.readFile(harness.uri),
        );
        assert.equal(callerOneBase, base);
        assert.equal(callerTwoBase, base);

        await harness.provider.writeFile(
            harness.uri,
            new TextEncoder().encode(`${callerOneBase}B`),
            {create: false, overwrite: true},
        );
        assert.equal(
            new TextDecoder().decode(await harness.provider.readFile(harness.uri)),
            'AB',
        );

        await assert.rejects(harness.provider.writeFile(
            harness.uri,
            new TextEncoder().encode(`${callerTwoBase}C`),
            {create: false, overwrite: true},
        ), /may only insert/i);

        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.logicalApplyCount, 1);
        assert.equal(server.text(PROJECT_A), 'AB');
        harness.dispose();
    });

    it('uses the latest current-head witness after an older verification read', async () => {
        const server = new DeterministicRealtimeServer();
        addProject(server, 'AB', PROJECT_A, 'Provider Current Witness', 6);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'provider-current-witness',
            projectId: PROJECT_A,
        });

        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), 'AB');
        await harness.provider.writeFile(
            harness.uri,
            new TextEncoder().encode('ABC'),
            {create: false, overwrite: true},
        );
        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), 'ABC');
        server.collaboratorUpdate(PROJECT_A, [{p: 0, i: 'Y'}]);
        await settleAsyncWork();
        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), 'YABC');

        await harness.provider.writeFile(
            harness.uri,
            new TextEncoder().encode('YABCD'),
            {create: false, overwrite: true},
        );

        assert.equal(server.capturedUpdates.length, 2);
        assert.equal(server.text(PROJECT_A), 'YABCD');
        harness.dispose();
    });

    it('blocks a provider write after the authoritative head advances', async () => {
        const base = 'LEFT middle RIGHT';
        const desired = 'LOCAL middle RIGHT';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Provider Fresh Head', 6);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'provider-fresh-head',
            projectId: PROJECT_A,
        });

        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), base);
        server.collaboratorUpdate(PROJECT_A, replaceAt(base, 'RIGHT', 'REMOTE'));
        await settleAsyncWork();
        await assert.rejects(harness.provider.writeFile(
            harness.uri,
            new TextEncoder().encode(desired),
            {create: false, overwrite: true},
        ), /stale|authoritative document head|current-head provider read witness/i);

        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.text(PROJECT_A), 'LEFT middle REMOTE');
        harness.dispose();
    });

    it('allows provider insertions but blocks deletion and replacement', async () => {
        for (const [label, desired, allowed] of [
            ['append', 'ABC', true],
            ['middle-insert', 'ACB', true],
            ['delete', 'A', false],
            ['replace', 'AC', false],
        ] as const) {
            const server = new DeterministicRealtimeServer();
            addProject(server, 'AB', PROJECT_A, `Provider ${label}`, 6);
            const harness = await createEventWiredProviderProject({
                server,
                storage: new HarnessStorage(),
                windowId: `provider-${label}`,
                projectId: PROJECT_A,
            });

            assert.equal(
                new TextDecoder().decode(await harness.provider.readFile(harness.uri)),
                'AB',
            );
            if (allowed) {
                await harness.provider.writeFile(
                    harness.uri,
                    new TextEncoder().encode(desired),
                    {create: false, overwrite: true},
                );
                assert.equal(server.capturedUpdates.length, 1, label);
                assert.equal(server.text(PROJECT_A), desired, label);
            } else {
                await assert.rejects(harness.provider.writeFile(
                    harness.uri,
                    new TextEncoder().encode(desired),
                    {create: false, overwrite: true},
                ), /may only insert/i);
                assert.equal(server.capturedUpdates.length, 0, label);
                assert.equal(server.text(PROJECT_A), 'AB', label);
            }
            harness.dispose();
        }
    });

    it('rechecks the provider head and epoch after persisting its write intent', async () => {
        const base = 'AB';
        const desired = 'ABC';
        const storage = new HarnessStorage();
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Provider Pre-send Authority', 6);
        const harness = await createEventWiredProviderProject({
            server,
            storage,
            windowId: 'provider-pre-send-authority',
            projectId: PROJECT_A,
        });
        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), base);

        const provenanceStore: ReturnType<HarnessStorage['provenanceStore']> =
            harness.provider.provenanceStore;
        const markPendingWrite = provenanceStore.markPendingWrite.bind(provenanceStore);
        provenanceStore.markPendingWrite = async (recordName, pendingWrite) => {
            const record = await markPendingWrite(recordName, pendingWrite);
            provenanceStore.markPendingWrite = markPendingWrite;
            server.collaboratorUpdate(PROJECT_A, [{p: 0, i: 'Y'}]);
            await settleAsyncWork();
            return record;
        };

        await assert.rejects(harness.provider.writeFile(
            harness.uri,
            new TextEncoder().encode(desired),
            {create: false, overwrite: true},
        ), /authority changed/i);

        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.text(PROJECT_A), `Y${base}`);
        harness.dispose();
    });

    it('rejects document revision waiters immediately when the project is disposed', async () => {
        const server = new DeterministicRealtimeServer();
        addProject(server, 'AB', PROJECT_A, 'Disposed Revision Waiter', 6);
        const harness = createHarness(server);
        const waiter = harness.vfs.waitForDocumentVersion('same-doc-id', 6).promise;
        const rejected = assert.rejects(waiter, /project was closed/i);
        const clientsBeforeDispose = server.clientCreationCount;

        harness.vfs.dispose();
        await rejected;
        assert.equal(harness.vfs.documentVersionWaiters.size, 0);
        harness.vfs.forceFreshConnection();
        await settleAsyncWork();
        assert.equal(server.clientCreationCount, clientsBeforeDispose);
    });

    it('clears an unsent conditional provider intent when disposal precedes waiter creation', async () => {
        const base = 'AB';
        const desired = 'ABC';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Disposed Conditional Waiter', 6);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'disposed-conditional-waiter',
            projectId: PROJECT_A,
        });
        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), base);

        const provenanceStore = harness.vfs.provenanceStore;
        const markPendingWrite = provenanceStore.markPendingWrite.bind(provenanceStore);
        let clearedRecords = 0;
        const clearRecord = provenanceStore.clearRecord.bind(provenanceStore);
        provenanceStore.markPendingWrite = async (recordName: string, pendingWrite: unknown) => {
            const record = await markPendingWrite(recordName, pendingWrite);
            harness.vfs.disposed = true;
            return record;
        };
        provenanceStore.clearRecord = async (recordName: string) => {
            clearedRecords += 1;
            await clearRecord(recordName);
        };

        await assert.rejects(harness.provider.writeFile(
            harness.uri,
            new TextEncoder().encode(desired),
            {create: false, overwrite: true},
        ), /project was closed/i);

        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.text(PROJECT_A), base);
        assert.equal(clearedRecords, 1);
        assert.equal(harness.vfs.pendingConditionalDocumentUpdates.size, 0);
        harness.dispose();
    });

    it('blocks an overlapping provider write and emits no wire update', async () => {
        const base = 'same line';
        const desired = 'local line';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Provider Conflict', 6);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'provider-conflict',
            projectId: PROJECT_A,
        });

        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), base);
        server.collaboratorUpdate(PROJECT_A, replaceAt(base, 'same', 'remote'));
        await settleAsyncWork();
        await assert.rejects(harness.provider.writeFile(
            harness.uri,
            new TextEncoder().encode(desired),
            {create: false, overwrite: true},
        ), /stale|authoritative document head|current-head provider read witness/i);

        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.text(PROJECT_A), 'remote line');
        harness.dispose();
    });

    it('rebases an in-flight provider write when collaborator OT precedes its ACK', async () => {
        const base = 'abc';
        const desired = 'abXc';
        const merged = 'YabXc';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Provider Inflight Rebase', 9);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'provider-inflight-rebase',
            projectId: PROJECT_A,
        });
        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), base);
        server.holdNextApplicationAfterAck();

        const writing = harness.provider.writeFile(
            harness.uri,
            new TextEncoder().encode(desired),
            {create: false, overwrite: true},
        );
        await settleAsyncWork();
        server.collaboratorUpdate(PROJECT_A, [{p: 0, i: 'Y'}]);
        server.releaseHeldApplicationWithTransform();
        await writing;

        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.text(PROJECT_A), merged);
        assert.equal(harness.vfs.remoteDocumentCausality.get('same-doc-id')?.valid, true);
        harness.dispose();
    });

    it('invalidates and publishes a refresh when an editor opens during an in-flight provider write', async () => {
        const base = 'abc';
        const desired = 'abXc';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Provider Inflight Editor Open', 9);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'provider-inflight-editor-open',
            projectId: PROJECT_A,
        });
        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), base);
        server.holdNextApplicationAfterAck();

        const originalNotify = harness.vfs.notify.bind(harness.vfs);
        let refreshNotifications = 0;
        harness.vfs.notify = (events: Array<{type: number}>) => {
            refreshNotifications += events.filter(event => event.type === 1).length;
            originalNotify(events);
        };
        const writing = harness.provider.writeFile(
            harness.uri,
            new TextEncoder().encode(desired),
            {create: false, overwrite: true},
        );
        await settleAsyncWork();
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.openClean(harness.events);
        server.releaseHeldApplication();
        await writing;

        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.text(PROJECT_A), desired);
        assert.ok(refreshNotifications >= 1, 'the newly opened editor must receive a provider refresh');
        assert.equal(harness.vfs.pendingConditionalDocumentUpdates.size, 0);
        assert.equal(
            new TextDecoder().decode(await harness.provider.readFile(harness.uri)),
            desired,
        );
        harness.dispose();
    });

    it('clears a known rejected provider intent but retains unknown recovery without resending', async () => {
        const base = 'abc';
        const desired = 'abXc';
        const server = new DeterministicRealtimeServer();
        const storage = new HarnessStorage();
        addProject(server, base, PROJECT_A, 'Provider Outcomes', 9);
        const harness = await createEventWiredProviderProject({
            server,
            storage,
            windowId: 'provider-outcomes',
            projectId: PROJECT_A,
        });
        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), base);
        const originalApply = harness.socket.applyOtUpdate.bind(harness.socket);
        harness.socket.applyOtUpdate = async () => {
            throw new SocketRequestError(
                'server_error',
                'known rejection',
                false,
            );
        };
        await assert.rejects(harness.provider.writeFile(
            harness.uri,
            new TextEncoder().encode(desired),
            {create: false, overwrite: true},
        ), /known rejection/i);
        harness.socket.applyOtUpdate = originalApply;
        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), base);
        await harness.provider.writeFile(
            harness.uri,
            new TextEncoder().encode(desired),
            {create: false, overwrite: true},
        );
        assert.equal(server.capturedUpdates.length, 1);

        const next = `${desired}!`;
        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), desired);
        server.loseNextAckBeforeCommit();
        await assert.rejects(harness.provider.writeFile(
            harness.uri,
            new TextEncoder().encode(next),
            {create: false, overwrite: true},
        ), (error: unknown) => String(error).includes('acknowledgement was lost'));
        const packetsAfterUnknown = server.capturedUpdates.length;
        await harness.vfs.init();
        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), desired);
        await assert.rejects(harness.provider.writeFile(
            harness.uri,
            new TextEncoder().encode(next),
            {create: false, overwrite: true},
        ), /unknown|unreconciled|unique realtime sender/i);
        assert.equal(server.capturedUpdates.length, packetsAfterUnknown);
        const pending = harness.vfs.pendingConditionalDocumentUpdates.get('same-doc-id');
        assert.ok(pending);
        const recovered = await harness.provider.provenanceStore.resolveCurrentRecord(
            pending.provenanceRecordName,
            {
                identity: pending.identity,
                bufferIncarnationId: pending.bufferIncarnationId,
                dirtyText: next,
            },
        );
        assert.equal(recovered.kind, 'valid', JSON.stringify(recovered));
        if (recovered.kind === 'valid') {
            assert.notEqual(recovered.record.pendingWrite, undefined);
        }
        harness.dispose();
    });

    it('retires an outcome-unknown provider append only after an exact fresh read', async () => {
        const base = '@article{old}\n';
        const desired = `${base}@article{new}\n`;
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Provider Applied Outcome', 9);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'provider-applied-outcome',
            projectId: PROJECT_A,
        });
        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), base);
        server.loseNextAckAfterCommit();

        await assert.rejects(harness.provider.writeFile(
            harness.uri,
            new TextEncoder().encode(desired),
            {create: false, overwrite: true},
        ), /acknowledgement was lost/i);
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.text(PROJECT_A), desired);
        assert.ok(harness.vfs.pendingConditionalDocumentUpdates.get('same-doc-id'));

        assert.equal(
            new TextDecoder().decode(await harness.provider.readFile(harness.uri)),
            desired,
        );
        await harness.provider.writeFile(
            harness.uri,
            new TextEncoder().encode(desired),
            {create: false, overwrite: true},
        );

        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.text(PROJECT_A), desired);
        assert.equal(harness.vfs.pendingConditionalDocumentUpdates.has('same-doc-id'), false);
        harness.dispose();
    });

    it('wires a clean provider read through open, edit, and public writeFile', async () => {
        const base = 'alpha omega';
        const desired = 'alpha LOCAL omega';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Public Clean Open', 4);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'public-clean-open',
            projectId: PROJECT_A,
        });

        assert.equal(
            new TextDecoder().decode(await harness.provider.readFile(harness.uri)),
            base,
        );
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.openClean(harness.events);
        await settleAsyncWork();
        await settleAsyncWork();
        assert.equal(harness.events.warningMessages.length, 0);

        editor.editThroughEvents(desired, harness.events);
        const result = await editor.saveThroughProvider(harness.provider, harness.events);

        assert.equal(result.saved, true, String(result.error));
        assert.equal(editor.dirty, false);
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.text(PROJECT_A), desired);
        harness.dispose();
    });

    it('binds the first provider snapshot before an immediate first keystroke', async () => {
        const base = 'alpha omega';
        const desired = 'alpha QUICK omega';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Immediate First Edit', 4);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'immediate-first-edit',
            projectId: PROJECT_A,
        });

        assert.equal(
            new TextDecoder().decode(await harness.provider.readFile(harness.uri)),
            base,
        );
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.openClean(harness.events);
        editor.editThroughEvents(desired, harness.events);
        const result = await editor.saveThroughProvider(harness.provider, harness.events);

        assert.equal(result.saved, true, String(result.error));
        assert.equal(editor.dirty, false);
        assert.equal(server.joinDocCallCount, 2, 'one initial join plus post-commit reconciliation');
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.text(PROJECT_A), desired);
        harness.dispose();
    });

    it('debounces rapid local input into one realtime OT submission without saving', async () => {
        const base = 'alpha omega';
        const first = 'alpha L omega';
        const final = 'alpha LIVE omega';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Live Debounce', 4);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'live-debounce',
            projectId: PROJECT_A,
        });

        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), base);
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.openClean(harness.events);
        editor.editThroughEvents(first, harness.events);
        const bufferId = harness.vfs.editorBufferIds.get(editor.document);
        const scheduled = harness.vfs.liveEditorSubmissions.get(bufferId);
        const firstTimer = scheduled?.timer;
        assert.ok(firstTimer);
        editor.editThroughEvents(final, harness.events);
        assert.strictEqual(
            scheduled?.timer,
            firstTimer,
            'later keystrokes must not postpone the first bounded live batch',
        );

        await new Promise(resolve => setTimeout(resolve, 150));
        await settleAsyncWork();
        await settleAsyncWork();

        assert.equal(editor.dirty, true, 'live OT must not call document.save()');
        assert.equal(editor.document.getText(), final);
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.text(PROJECT_A), final);
        harness.dispose();
    });

    it('accepts rapid insert-then-delete input without emitting a false remote write', async () => {
        const base = 'alpha omega';
        const inserted = 'alpha TEMP omega';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Live Net Zero', 4);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'live-net-zero',
            projectId: PROJECT_A,
        });

        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), base);
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.openClean(harness.events);
        editor.editThroughEvents(inserted, harness.events);
        editor.editThroughEvents(base, harness.events);

        await new Promise(resolve => setTimeout(resolve, 150));
        await settleAsyncWork();
        const result = await editor.saveThroughProvider(harness.provider, harness.events);

        assert.equal(result.saved, true, String(result.error));
        assert.equal(editor.dirty, false);
        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.text(PROJECT_A), base);
        harness.dispose();
    });

    it('submits a deletion made after an earlier live insertion was confirmed', async () => {
        const base = 'alpha omega';
        const inserted = 'alpha TEMP omega';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Live Delete After Ack', 4);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'live-delete-after-ack',
            projectId: PROJECT_A,
        });

        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), base);
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.openClean(harness.events);
        editor.editThroughEvents(inserted, harness.events);
        await new Promise(resolve => setTimeout(resolve, 150));
        await settleAsyncWork();
        assert.equal(server.text(PROJECT_A), inserted);

        editor.editThroughEvents(base, harness.events);
        await new Promise(resolve => setTimeout(resolve, 150));
        await settleAsyncWork();
        const result = await editor.saveThroughProvider(harness.provider, harness.events);

        assert.equal(result.saved, true, String(result.error));
        assert.equal(editor.dirty, false);
        assert.equal(server.capturedUpdates.length, 2);
        assert.equal(server.text(PROJECT_A), base);
        harness.dispose();
    });

    it('flushes pending live OT before an immediate Cmd+S provider write', async () => {
        const base = 'alpha omega';
        const desired = 'alpha FLUSH omega';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Live Save Flush', 4);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'live-save-flush',
            projectId: PROJECT_A,
        });

        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), base);
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.openClean(harness.events);
        editor.editThroughEvents(desired, harness.events);
        const result = await editor.saveThroughProvider(harness.provider, harness.events);

        assert.equal(result.saved, true, String(result.error));
        assert.equal(editor.dirty, false);
        assert.equal(server.capturedUpdates.length, 1, 'Cmd+S must not duplicate the live wire update');
        assert.equal(server.text(PROJECT_A), desired);
        harness.dispose();
    });

    it('retries a stale live snapshot after collaborator rebase without blocking Cmd+S', async () => {
        const base = 'abc';
        const local = 'abcL';
        const merged = 'YabcL';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Live Queued Rebase', 5);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'live-queued-rebase',
            projectId: PROJECT_A,
        });
        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), base);
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.openClean(harness.events);
        editor.editThroughEvents(local, harness.events);
        const bufferId = harness.vfs.editorBufferIds.get(editor.document);
        assert.ok(bufferId);

        const originalWrite = harness.vfs.writeFile.bind(harness.vfs);
        let injectedCollaboratorUpdate = false;
        harness.vfs.writeFile = async (...args: unknown[]) => {
            if (!injectedCollaboratorUpdate && args[4] === bufferId) {
                injectedCollaboratorUpdate = true;
                server.collaboratorUpdate(PROJECT_A, [{p: 0, i: 'Y'}]);
            }
            return originalWrite(...args);
        };
        const originalRecovery = harness.vfs.showDocumentRecovery.bind(harness.vfs);
        let recoveryPrompts = 0;
        harness.vfs.showDocumentRecovery = (...args: unknown[]) => {
            recoveryPrompts += 1;
            return originalRecovery(...args);
        };

        const result = await editor.saveThroughProvider(harness.provider, harness.events);

        assert.equal(result.saved, true, String(result.error));
        assert.equal(editor.dirty, false);
        assert.equal(editor.text, merged);
        assert.equal(recoveryPrompts, 0, 'the abandoned background snapshot must remain silent');
        assert.equal(harness.vfs.recoveryNotifications.size, 0);
        assert.equal(server.capturedUpdates.length, 1, 'the refreshed live state must emit exactly once');
        assert.equal(server.text(PROJECT_A), merged);
        harness.dispose();
    });

    it('keeps a failed background live write silent but lets Cmd+S own recovery UI', async () => {
        const base = 'abc';
        const local = 'abcL';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Live Explicit Recovery', 5);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'live-explicit-recovery',
            projectId: PROJECT_A,
        });
        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), base);
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.openClean(harness.events);
        editor.editThroughEvents(local, harness.events);

        harness.socket.applyOtUpdate = async () => {
            throw new SocketRequestError('server_error', 'known live rejection', false);
        };
        const originalRecovery = harness.vfs.showDocumentRecovery.bind(harness.vfs);
        let effectiveRecoveryPrompts = 0;
        harness.vfs.showDocumentRecovery = (...args: unknown[]) => {
            const before = harness.vfs.recoveryNotifications.size;
            const result = originalRecovery(...args);
            if (harness.vfs.recoveryNotifications.size > before) {
                effectiveRecoveryPrompts += 1;
            }
            return result;
        };

        const result = await editor.saveThroughProvider(harness.provider, harness.events);

        assert.equal(result.saved, false);
        assert.match(String(result.error), /known live rejection/i);
        assert.equal(editor.dirty, true);
        assert.equal(editor.text, local);
        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.text(PROJECT_A), base);
        assert.equal(effectiveRecoveryPrompts, 1, 'only the explicit save may expose recovery UI');
        harness.dispose();
    });

    it('replays only post-commit input after an outcome-unknown live update is found applied', async () => {
        const base = 'aaaa';
        const first = 'aaaab';
        const final = 'aaaaab';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Live Unknown Applied', 5);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'live-unknown-applied',
            projectId: PROJECT_A,
        });
        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), base);
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.openClean(harness.events);

        const originalApply = harness.socket.applyOtUpdate.bind(harness.socket);
        let releaseFailure!: () => void;
        let failureReached!: () => void;
        const failureGate = new Promise<void>(resolve => { releaseFailure = resolve; });
        const failureStarted = new Promise<void>(resolve => { failureReached = resolve; });
        harness.socket.applyOtUpdate = async (...args: Parameters<typeof originalApply>) => {
            try {
                return await originalApply(...args);
            } catch (error) {
                failureReached();
                await failureGate;
                throw error;
            }
        };
        server.loseNextAckAfterCommit();
        editor.editThroughEvents(first, harness.events);
        await failureStarted;
        assert.equal(server.text(PROJECT_A), first);
        // Repeated text makes a snapshot-only diff ambiguous: the exact user
        // event inserted at offset 0, while a prefix/suffix heuristic would
        // choose offset 4. Recovery must retain the observed event position.
        editor.replaceRangeThroughEvents(0, 0, 'a', harness.events);
        assert.equal(editor.text, final);
        releaseFailure();
        await waitUntil(
            () => harness.socket.isConnected && server.capturedUpdates.length === 1,
            'the outcome-unknown live update did not reach reconnect recovery',
        );
        await harness.vfs.init();
        await settleAsyncWork();

        const recovered = await editor.saveThroughProvider(harness.provider, harness.events);

        assert.equal(recovered.saved, true, String(recovered.error));
        assert.equal(editor.dirty, false);
        assert.equal(server.capturedUpdates.length, 2, 'the original update must not be resent');
        assert.equal(
            applyTextOperations(base, server.capturedUpdates[0].update.op),
            first,
        );
        assert.equal(
            applyTextOperations(first, server.capturedUpdates[1].update.op),
            final,
        );
        assert.deepEqual(server.capturedUpdates[1].update.op, [{p: 0, i: 'a'}]);
        assert.equal(server.text(PROJECT_A), final);
        harness.dispose();
    });

    it('keeps later input dirty when an outcome-unknown live update has no exact applied witness', async () => {
        const base = 'abc';
        const first = 'abcL';
        const final = 'abcL!';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Live Unknown Diverged', 5);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'live-unknown-diverged',
            projectId: PROJECT_A,
        });
        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), base);
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.openClean(harness.events);

        const originalApply = harness.socket.applyOtUpdate.bind(harness.socket);
        let releaseFailure!: () => void;
        let failureReached!: () => void;
        const failureGate = new Promise<void>(resolve => { releaseFailure = resolve; });
        const failureStarted = new Promise<void>(resolve => { failureReached = resolve; });
        harness.socket.applyOtUpdate = async (...args: Parameters<typeof originalApply>) => {
            try {
                return await originalApply(...args);
            } catch (error) {
                failureReached();
                await failureGate;
                throw error;
            }
        };
        server.loseNextAckAfterCommit();
        editor.editThroughEvents(first, harness.events);
        await failureStarted;
        editor.editThroughEvents(final, harness.events);
        server.collaboratorUpdate(PROJECT_A, [{p: 0, i: 'R'}]);
        releaseFailure();
        await waitUntil(
            () => harness.socket.isConnected && server.capturedUpdates.length === 1,
            'the divergent outcome-unknown live update did not reconnect',
        );
        await harness.vfs.init();
        await settleAsyncWork();

        const recovered = await editor.saveThroughProvider(harness.provider, harness.events);

        assert.equal(recovered.saved, false);
        assert.match(String(recovered.error), /exact applied remote witness/i);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), final);
        assert.equal(server.capturedUpdates.length, 1, 'no uncertain update may be resent');
        assert.equal(server.text(PROJECT_A), `R${first}`);
        harness.dispose();
    });

    it('saves a confirmed dirty editor when the host omits onWillSaveTextDocument', async () => {
        const base = 'alpha omega';
        const desired = 'alpha LOCAL omega';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Public Save Without Will Event', 4);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'public-save-without-will-event',
            projectId: PROJECT_A,
        });

        assert.equal(
            new TextDecoder().decode(await harness.provider.readFile(harness.uri)),
            base,
        );
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.openClean(harness.events);
        await settleAsyncWork();
        await settleAsyncWork();
        assert.equal(harness.events.warningMessages.length, 0);
        editor.editThroughEvents(desired, harness.events);

        let saveError: unknown;
        try {
            await harness.provider.writeFile(
                harness.uri,
                new TextEncoder().encode(desired),
                {create: false, overwrite: true},
            );
        } catch (error) {
            saveError = error;
        }

        assert.equal(saveError, undefined);
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.text(PROJECT_A), desired);
        harness.dispose();
    });

    it('uses the live confirmed buffer after a format-on-save edit', async () => {
        const base = 'alpha omega';
        const beforeFormat = 'alpha local omega';
        const afterFormat = 'alpha LOCAL omega';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Public Format On Save', 4);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'public-format-on-save',
            projectId: PROJECT_A,
        });

        assert.equal(
            new TextDecoder().decode(await harness.provider.readFile(harness.uri)),
            base,
        );
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.openClean(harness.events);
        await settleAsyncWork();
        await settleAsyncWork();
        assert.equal(harness.events.warningMessages.length, 0);
        editor.editThroughEvents(beforeFormat, harness.events);

        const result = await editor.saveThroughProvider(
            harness.provider,
            harness.events,
            {create: false, overwrite: true},
            () => editor.editThroughEvents(afterFormat, harness.events),
        );

        assert.equal(result.saved, true, String(result.error));
        assert.equal(editor.dirty, false);
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.text(PROJECT_A), afterFormat);
        harness.dispose();
    });

    it('does not authorize an unconfirmed dirty editor when onWillSaveTextDocument is omitted', async () => {
        const remote = `base\n${COLLABORATOR}\n`;
        const restored = 'base\nLOCAL_DRAFT\n';
        const server = new DeterministicRealtimeServer();
        addProject(server, remote, PROJECT_A, 'Unconfirmed Save Without Will Event', 9);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'unconfirmed-save-without-will-event',
            projectId: PROJECT_A,
        });

        assert.equal(
            new TextDecoder().decode(await harness.provider.readFile(harness.uri)),
            remote,
        );
        const editor = new SimulatedDirtyEditor(harness.uri, restored);
        editor.attach();

        await assert.rejects(
            harness.provider.writeFile(
                harness.uri,
                new TextEncoder().encode(restored),
                {create: false, overwrite: true},
            ),
            (error: any) => error?.code === 'Unavailable',
        );

        assert.equal(editor.dirty, true);
        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.text(PROJECT_A), remote);
        harness.dispose();
    });

    it('accepts an explicit unchanged save from the confirmed clean editor', async () => {
        const base = 'alpha omega';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Confirmed Clean Save', 4);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'confirmed-clean-save',
            projectId: PROJECT_A,
        });

        assert.equal(
            new TextDecoder().decode(await harness.provider.readFile(harness.uri)),
            base,
        );
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.openClean(harness.events);
        await settleAsyncWork();
        await settleAsyncWork();
        assert.equal(harness.events.warningMessages.length, 0);
        assert.equal(editor.dirty, false);

        await harness.provider.writeFile(
            harness.uri,
            new TextEncoder().encode(base),
            {create: false, overwrite: true},
        );

        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.text(PROJECT_A), base);
        harness.dispose();
    });

    it('keeps a clean editor clean while the provider publishes a collaborator refresh', async () => {
        const base = 'alpha omega';
        const remote = 'REMOTE alpha omega';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Stale Confirmed Clean Save', 4);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'stale-confirmed-clean-save',
            projectId: PROJECT_A,
        });

        assert.equal(
            new TextDecoder().decode(await harness.provider.readFile(harness.uri)),
            base,
        );
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.openClean(harness.events);
        await settleAsyncWork();
        await settleAsyncWork();
        assert.equal(harness.events.warningMessages.length, 0);
        server.collaboratorUpdate(PROJECT_A, [{p: 0, i: 'REMOTE '}]);
        await settleAsyncWork();

        assert.equal(editor.dirty, false);
        assert.equal(editor.document.getText(), base);
        assert.equal(
            new TextDecoder().decode(await harness.provider.readFile(harness.uri)),
            remote,
        );

        await assert.rejects(
            harness.provider.writeFile(
                harness.uri,
                new TextEncoder().encode(base),
                {create: false, overwrite: true},
            ),
            (error: any) => error?.code === 'Unavailable',
        );

        assert.equal(editor.dirty, false);
        assert.equal(editor.document.getText(), base);
        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.text(PROJECT_A), remote);
        harness.dispose();
    });

    it('witnesses a whole-document provider refresh before the next clean edit and save', async () => {
        const base = 'alpha omega';
        const remote = 'REMOTE alpha omega';
        const desired = 'REMOTE alpha LOCAL omega';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Witnessed Clean Refresh', 4);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'witnessed-clean-refresh',
            projectId: PROJECT_A,
        });

        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), base);
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.openClean(harness.events);
        await settleAsyncWork();
        await settleAsyncWork();
        assert.equal(harness.events.warningMessages.length, 0);

        server.collaboratorUpdate(PROJECT_A, [{p: 0, i: 'REMOTE '}]);
        await settleAsyncWork();
        assert.equal(editor.dirty, false);
        assert.equal(editor.document.getText(), base);
        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), remote);

        // FileSystemProvider refreshes are allowed to report a whole-document
        // replacement instead of the bridge's minimal replacement shape.
        editor.refreshThroughEvents(remote, harness.events, true);
        await settleAsyncWork();
        assert.equal(editor.dirty, false);
        assert.equal(editor.document.getText(), remote);
        assert.equal(harness.events.warningMessages.length, 0);

        editor.editThroughEvents(desired, harness.events);
        const result = await editor.saveThroughProvider(harness.provider, harness.events);
        assert.equal(result.saved, true);
        assert.equal(editor.dirty, false);
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.capturedUpdates[0].update.v, 5);
        assert.equal(server.text(PROJECT_A), desired);
        assert.equal(server.version(PROJECT_A), 6);
        harness.dispose();
    });

    it('changes the provider etag and tolerates clean intermediate events for an equal-size refresh', async () => {
        const base = 'alpha omega';
        const remote = 'ALPHA omega';
        const desired = 'ALPHA LOCAL omega';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Equal Size Clean Refresh', 4);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'equal-size-clean-refresh',
            projectId: PROJECT_A,
        });

        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), base);
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.openClean(harness.events);
        await settleAsyncWork();
        await settleAsyncWork();
        const beforeStat = await harness.provider.stat(harness.uri);

        server.collaboratorUpdate(PROJECT_A, replaceAt(base, 'alpha', 'ALPHA'));
        await settleAsyncWork();
        const afterStat = await harness.provider.stat(harness.uri);
        assert.equal(beforeStat.size, Buffer.byteLength(base, 'utf8'));
        assert.equal(afterStat.size, beforeStat.size);
        assert.ok(afterStat.mtime > beforeStat.mtime);
        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), remote);

        // VS Code may report clean, empty/non-content model events before the
        // FileSystemProvider reload reaches its final text.
        editor.version += 1;
        harness.events.fireDidChange(editor.document, []);
        await settleAsyncWork();
        assert.equal(editor.dirty, false);
        assert.equal(editor.document.getText(), base);

        editor.refreshThroughEvents(remote, harness.events, true);
        await settleAsyncWork();
        assert.equal(editor.dirty, false);
        assert.equal(harness.events.warningMessages.length, 0);

        editor.editThroughEvents(desired, harness.events);
        const result = await editor.saveThroughProvider(harness.provider, harness.events);
        assert.equal(result.saved, true);
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.capturedUpdates[0].update.v, 5);
        assert.equal(server.text(PROJECT_A), desired);
        harness.dispose();
    });

    it('coalesces consecutive clean collaborator revisions into one witnessed provider refresh', async () => {
        const base = 'alpha omega';
        const firstRemote = 'REMOTE alpha omega';
        const remote = 'REMOTE alpha OMEGA';
        const desired = `${remote}!`;
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Coalesced Clean Refresh', 4);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'coalesced-clean-refresh',
            projectId: PROJECT_A,
        });

        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), base);
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.openClean(harness.events);
        await settleAsyncWork();
        await settleAsyncWork();

        server.collaboratorUpdate(PROJECT_A, [{p: 0, i: 'REMOTE '}]);
        await settleAsyncWork();
        assert.equal(
            new TextDecoder().decode(await harness.provider.readFile(harness.uri)),
            firstRemote,
        );
        server.collaboratorUpdate(PROJECT_A, replaceAt(firstRemote, 'omega', 'OMEGA'));
        await settleAsyncWork();
        await settleAsyncWork();
        assert.equal(editor.dirty, false);
        assert.equal(editor.document.getText(), base);

        // A running host reload may finish on the earlier target after a newer
        // provider notification has already been queued. It remains a clean,
        // known intermediate state rather than a commit witness for the latest.
        editor.refreshThroughEvents(firstRemote, harness.events, true);
        await settleAsyncWork();
        assert.equal(editor.dirty, false);
        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), remote);

        editor.refreshThroughEvents(remote, harness.events, true);
        await settleAsyncWork();
        assert.equal(editor.dirty, false);
        assert.equal(harness.events.warningMessages.length, 0);

        editor.editThroughEvents(desired, harness.events);
        const result = await editor.saveThroughProvider(harness.provider, harness.events);
        assert.equal(result.saved, true);
        assert.equal(editor.dirty, false);
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.capturedUpdates[0].update.v, 6);
        assert.equal(server.text(PROJECT_A), desired);
        assert.equal(server.version(PROJECT_A), 7);
        harness.dispose();
    });

    it('reanchors coalesced clean revisions whose final provider text is unchanged', async () => {
        const base = 'alpha omega';
        const desired = 'alpha LOCAL omega';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Collapsed Clean Refresh', 4);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'collapsed-clean-refresh',
            projectId: PROJECT_A,
        });

        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), base);
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.openClean(harness.events);
        await settleAsyncWork();
        await settleAsyncWork();

        server.collaboratorUpdate(PROJECT_A, [{p: 0, i: 'REMOTE '}]);
        server.collaboratorUpdate(PROJECT_A, [{p: 0, d: 'REMOTE '}]);
        await settleAsyncWork();
        await settleAsyncWork();
        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), base);
        await settleAsyncWork();
        await settleAsyncWork();
        assert.equal(editor.dirty, false);
        assert.equal(editor.document.getText(), base);
        assert.equal(harness.events.warningMessages.length, 0);

        editor.editThroughEvents(desired, harness.events);
        const result = await editor.saveThroughProvider(harness.provider, harness.events);
        assert.equal(result.saved, true);
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.capturedUpdates[0].update.v, 6);
        assert.equal(server.text(PROJECT_A), desired);
        harness.dispose();
    });

    it('fails closed when a user edits the old clean base before provider refresh adoption', async () => {
        const base = 'alpha omega';
        const remote = 'REMOTE alpha omega';
        const local = 'alpha LOCAL omega';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Raced Clean Refresh', 4);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'raced-clean-refresh',
            projectId: PROJECT_A,
        });

        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), base);
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.openClean(harness.events);
        await settleAsyncWork();
        await settleAsyncWork();

        server.collaboratorUpdate(PROJECT_A, [{p: 0, i: 'REMOTE '}]);
        await settleAsyncWork();
        editor.editThroughEvents(local, harness.events);
        const result = await editor.saveThroughProvider(harness.provider, harness.events);

        assert.equal(result.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), local);
        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.text(PROJECT_A), remote);
        assert.equal(server.version(PROJECT_A), 5);
        harness.dispose();
    });

    it('advances an empty causal revision without dirtying the editor or losing the next edit', async () => {
        const base = 'alpha omega';
        const desired = 'alpha LOCAL omega';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Empty Causal Revision', 4);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'empty-causal-revision',
            projectId: PROJECT_A,
        });
        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), base);
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.openClean(harness.events);
        await settleAsyncWork();
        await settleAsyncWork();

        server.collaboratorUpdate(PROJECT_A, []);
        await settleAsyncWork();
        assert.equal(server.version(PROJECT_A), 5);
        assert.equal(editor.dirty, false);
        assert.equal(editor.document.getText(), base);

        editor.editThroughEvents(desired, harness.events);
        const result = await editor.saveThroughProvider(harness.provider, harness.events);
        assert.equal(result.saved, true);
        assert.equal(editor.dirty, false);
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.capturedUpdates[0].update.v, 5);
        assert.equal(server.text(PROJECT_A), desired);
        harness.dispose();
    });

    it('ignores a non-content document change before a later proven edit', async () => {
        const base = 'alpha omega';
        const desired = 'alpha LOCAL omega';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Non-content Change', 4);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'non-content-change',
            projectId: PROJECT_A,
        });

        assert.equal(
            new TextDecoder().decode(await harness.provider.readFile(harness.uri)),
            base,
        );
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.openClean(harness.events);
        await settleAsyncWork();
        await settleAsyncWork();
        assert.equal(harness.events.warningMessages.length, 0);

        harness.events.fireDidChange(editor.document, []);
        editor.editThroughEvents(desired, harness.events);
        const result = await editor.saveThroughProvider(harness.provider, harness.events);

        assert.equal(result.saved, true);
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.text(PROJECT_A), desired);
        harness.dispose();
    });

    it('reanchors an unchanged non-content event that increments the document version', async () => {
        const base = 'alpha omega';
        const desired = 'alpha LOCAL omega';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Versioned Non-content Change', 4);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'versioned-non-content-change',
            projectId: PROJECT_A,
        });

        assert.equal(
            new TextDecoder().decode(await harness.provider.readFile(harness.uri)),
            base,
        );
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.openClean(harness.events);
        await settleAsyncWork();
        await settleAsyncWork();
        assert.equal(harness.events.warningMessages.length, 0);

        editor.version += 1;
        harness.events.fireDidChange(editor.document, []);
        editor.editThroughEvents(desired, harness.events);
        const result = await editor.saveThroughProvider(harness.provider, harness.events);

        assert.equal(result.saved, true);
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.text(PROJECT_A), desired);
        harness.dispose();
    });

    it('keeps a clean confirmation pending across a versioned non-content event', async () => {
        const base = 'alpha omega';
        const desired = 'alpha LOCAL omega';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Pending Versioned Non-content Change', 4);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'pending-versioned-non-content-change',
            projectId: PROJECT_A,
        });

        const confirmation = harness.events.deferWarningResponse();
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.openClean(harness.events);
        assert.equal(
            new TextDecoder().decode(await harness.provider.readFile(harness.uri)),
            base,
        );
        assert.equal(harness.events.warningMessages.length, 1);

        editor.version += 1;
        harness.events.fireDidChange(editor.document, []);
        confirmation.resolve(ENABLE_CLEAN_EDITOR);
        await settleAsyncWork();
        await settleAsyncWork();

        editor.editThroughEvents(desired, harness.events);
        const result = await editor.saveThroughProvider(harness.provider, harness.events);

        assert.equal(result.saved, true);
        assert.equal(editor.dirty, false);
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.text(PROJECT_A), desired);
        harness.dispose();
    });

    it('invalidates a pending clean confirmation when the text changes', async () => {
        const base = 'alpha omega';
        const desired = 'alpha LOCAL omega';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Pending Content Change', 4);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'pending-content-change',
            projectId: PROJECT_A,
        });

        const confirmation = harness.events.deferWarningResponse();
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.openClean(harness.events);
        assert.equal(
            new TextDecoder().decode(await harness.provider.readFile(harness.uri)),
            base,
        );
        assert.equal(harness.events.warningMessages.length, 1);

        editor.editThroughEvents(desired, harness.events);
        confirmation.resolve(ENABLE_CLEAN_EDITOR);
        await settleAsyncWork();
        await settleAsyncWork();
        const result = await editor.saveThroughProvider(harness.provider, harness.events);

        assert.equal(result.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), desired);
        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.text(PROJECT_A), base);
        harness.dispose();
    });

    it('binds an exact clean editor that opened before its provider read', async () => {
        const base = 'alpha omega';
        const desired = 'alpha LOCAL omega';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Public Early Clean Open', 4);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'public-early-clean-open',
            projectId: PROJECT_A,
        });
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        harness.events.queueWarningResponse(ENABLE_CLEAN_EDITOR);
        editor.openClean(harness.events);

        assert.equal(
            new TextDecoder().decode(await harness.provider.readFile(harness.uri)),
            base,
        );
        await settleAsyncWork();
        await settleAsyncWork();
        assert.equal(harness.events.warningMessages.length, 1);

        editor.editThroughEvents(desired, harness.events);
        const result = await editor.saveThroughProvider(harness.provider, harness.events);

        assert.equal(result.saved, true);
        assert.equal(editor.dirty, false);
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.text(PROJECT_A), desired);
        harness.dispose();
    });

    it('does not bind a dirty hot-exit editor that opened before its provider read', async () => {
        const advanced = `base\n${OWN_CONFIRMED}\n${COLLABORATOR}\n`;
        const restored = 'base\nLOCAL_DRAFT\n';
        const server = new DeterministicRealtimeServer();
        addProject(server, advanced, PROJECT_A, 'Public Early Hot Exit', 12);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'public-early-hot-exit',
            projectId: PROJECT_A,
        });
        const editor = new SimulatedDirtyEditor(harness.uri, restored);
        editor.attach();
        harness.events.fireDidOpen(editor.document);

        assert.equal(
            new TextDecoder().decode(await harness.provider.readFile(harness.uri)),
            advanced,
        );
        await settleAsyncWork();
        assert.equal(harness.events.warningMessages.length, 0);

        const result = await editor.saveThroughProvider(harness.provider, harness.events);

        assert.equal(result.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), restored);
        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.text(PROJECT_A), advanced);
        assert.match(server.text(PROJECT_A), new RegExp(OWN_CONFIRMED));
        assert.match(server.text(PROJECT_A), new RegExp(COLLABORATOR));
        harness.dispose();
    });

    it('binds a clean document published before its open callback when the read proves exact bytes', async () => {
        const advanced = `base\n${OWN_CONFIRMED}\n${COLLABORATOR}\n`;
        const restored = 'base\nLOCAL_DRAFT\n';
        const server = new DeterministicRealtimeServer();
        addProject(server, advanced, PROJECT_A, 'Public Missed Open Overlay', 12);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'public-missed-open-overlay',
            projectId: PROJECT_A,
        });
        const editor = new SimulatedDirtyEditor(harness.uri, advanced);
        editor.dirty = false;
        editor.attach();

        assert.equal(
            new TextDecoder().decode(await harness.provider.readFile(harness.uri)),
            advanced,
        );
        editor.editThroughEvents(restored, harness.events);
        await settleAsyncWork();
        await settleAsyncWork();

        const result = await editor.saveThroughProvider(harness.provider, harness.events);

        assert.equal(result.saved, true);
        assert.equal(editor.dirty, false);
        assert.equal(editor.document.getText(), restored);
        assert.equal(harness.events.warningMessages.length, 0);
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.text(PROJECT_A), restored);
        harness.dispose();
    });

    it('does not let an obsolete read confirmation delete a refreshed candidate', async () => {
        const base = 'alpha omega';
        const refreshed = 'alpha REMOTE omega';
        const desired = 'alpha REMOTE LOCAL omega';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Public Confirmation Refresh', 4);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'public-confirmation-refresh',
            projectId: PROJECT_A,
        });
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.openClean(harness.events);
        const firstConfirmation = harness.events.deferWarningResponse();
        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), base);

        server.collaboratorUpdate(PROJECT_A, [{p: 6, i: 'REMOTE '}]);
        editor.refreshThroughEvents(refreshed, harness.events);
        const secondConfirmation = harness.events.deferWarningResponse();
        assert.equal(
            new TextDecoder().decode(await harness.provider.readFile(harness.uri)),
            refreshed,
        );
        assert.equal(harness.events.warningMessages.length, 2);

        firstConfirmation.resolve(ENABLE_CLEAN_EDITOR);
        await settleAsyncWork();
        secondConfirmation.resolve(ENABLE_CLEAN_EDITOR);
        await settleAsyncWork();
        await settleAsyncWork();

        editor.editThroughEvents(desired, harness.events);
        const result = await editor.saveThroughProvider(harness.provider, harness.events);

        assert.equal(result.saved, true);
        assert.equal(editor.dirty, false);
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.text(PROJECT_A), desired);
        harness.dispose();
    });

    it('does not let a pre-reconnect confirmation delete the new-session candidate', async () => {
        const base = 'alpha omega';
        const desired = 'alpha LOCAL omega';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Public Confirmation Reconnect', 4);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'public-confirmation-reconnect',
            projectId: PROJECT_A,
        });
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.openClean(harness.events);
        const firstConfirmation = harness.events.deferWarningResponse();
        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), base);

        harness.socket.disconnect();
        await harness.vfs.init();
        const secondConfirmation = harness.events.deferWarningResponse();
        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), base);
        assert.equal(harness.events.warningMessages.length, 2);

        firstConfirmation.resolve(ENABLE_CLEAN_EDITOR);
        await settleAsyncWork();
        secondConfirmation.resolve(ENABLE_CLEAN_EDITOR);
        await settleAsyncWork();
        await settleAsyncWork();

        editor.editThroughEvents(desired, harness.events);
        const result = await editor.saveThroughProvider(harness.provider, harness.events);

        assert.equal(result.saved, true);
        assert.equal(editor.dirty, false);
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.text(PROJECT_A), desired);
        harness.dispose();
    });

    it('keeps a clean provider read quarantined when enable-editing is cancelled', async () => {
        const base = 'remote base';
        const desired = 'untrusted local edit';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Public Clean Open Cancel', 4);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'public-clean-open-cancel',
            projectId: PROJECT_A,
        });

        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.openClean(harness.events);
        assert.equal(
            new TextDecoder().decode(await harness.provider.readFile(harness.uri)),
            base,
        );
        await settleAsyncWork();
        await settleAsyncWork();
        assert.equal(harness.events.warningMessages.length, 1);
        assert.equal(harness.events.warningMessages[0].items.includes(ENABLE_CLEAN_EDITOR), true);

        editor.editThroughEvents(desired, harness.events);
        const result = await editor.saveThroughProvider(harness.provider, harness.events);

        assert.equal(result.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), desired);
        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.text(PROJECT_A), base);
        harness.dispose();
    });

    it('applies a collaborator edit to the live dirty buffer before saving it', async () => {
        const base = 'LEFT middle RIGHT';
        const local = 'LOCAL middle RIGHT';
        const merged = 'LOCAL middle REMOTE';
        const followUp = `${merged} NEXT`;
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Public Merge Lifecycle', 4);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'public-merge-lifecycle',
            projectId: PROJECT_A,
        });
        assert.equal(new TextDecoder().decode(await harness.provider.readFile(harness.uri)), base);
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.openClean(harness.events);
        await settleAsyncWork();
        await settleAsyncWork();
        assert.equal(harness.events.warningMessages.length, 0);

        editor.editThroughEvents(local, harness.events);
        server.collaboratorUpdate(PROJECT_A, replaceAt(base, 'RIGHT', 'REMOTE'));
        await settleAsyncWork();
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), merged);

        const mergedSave = await editor.saveThroughProvider(harness.provider, harness.events);
        assert.equal(mergedSave.saved, true);
        assert.equal(editor.dirty, false);
        assert.equal(editor.document.getText(), merged);
        assert.equal(server.text(PROJECT_A), merged);
        assert.equal(server.capturedUpdates.length, 1);

        editor.editThroughEvents(followUp, harness.events);
        const secondSave = await editor.saveThroughProvider(harness.provider, harness.events);
        assert.equal(secondSave.saved, true);
        assert.equal(editor.dirty, false);
        assert.equal(server.capturedUpdates.length, 2);
        assert.equal(server.text(PROJECT_A), followUp);
        harness.dispose();
    });

    it('rejects a stale hot-exit overlay that arrives before clean-open confirmation', async () => {
        const advanced = `base\n${OWN_CONFIRMED}\n${COLLABORATOR}\n`;
        const restored = 'base\nLOCAL_DRAFT\n';
        const server = new DeterministicRealtimeServer();
        addProject(server, advanced, PROJECT_A, 'Public Hot Exit', 12);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'public-hot-exit',
            projectId: PROJECT_A,
        });

        const confirmation = harness.events.deferWarningResponse();
        const editor = new SimulatedDirtyEditor(harness.uri, advanced);
        editor.openClean(harness.events);
        assert.equal(
            new TextDecoder().decode(await harness.provider.readFile(harness.uri)),
            advanced,
        );
        editor.editThroughEvents(restored, harness.events);
        confirmation.resolve(ENABLE_CLEAN_EDITOR);
        await settleAsyncWork();
        await settleAsyncWork();

        const result = await editor.saveThroughProvider(harness.provider, harness.events);

        assert.equal(result.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), restored);
        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.text(PROJECT_A), advanced);
        assert.match(server.text(PROJECT_A), new RegExp(OWN_CONFIRMED));
        assert.match(server.text(PROJECT_A), new RegExp(COLLABORATOR));
        harness.dispose();
    });

    it('routes manual, autosave, and saveAll through the same public provenance gate', async () => {
        for (const trigger of ['manual', 'auto', 'save-all'] as const) {
            const base = `base-${trigger}`;
            const desired = `${base}-LOCAL`;
            const server = new DeterministicRealtimeServer();
            addProject(server, base, PROJECT_A, `Public ${trigger}`, 8);
            const harness = await createEventWiredProviderProject({
                server,
                storage: new HarnessStorage(),
                windowId: `public-${trigger}`,
                projectId: PROJECT_A,
            });
            assert.equal(
                new TextDecoder().decode(await harness.provider.readFile(harness.uri)),
                base,
                trigger,
            );
            const editor = new SimulatedDirtyEditor(harness.uri, base);
            editor.openClean(harness.events);
            await settleAsyncWork();
            await settleAsyncWork();
            assert.equal(harness.events.warningMessages.length, 0, trigger);
            editor.editThroughEvents(desired, harness.events);

            const host = new SimulatedEditorHost();
            let saved: boolean;
            if (trigger === 'manual') {
                saved = (await host.manualSaveThroughProvider(
                    editor,
                    harness.provider,
                    harness.events,
                )).saved;
                assert.equal(host.manualSaveCalls, 1);
            } else if (trigger === 'auto') {
                saved = (await host.autoSaveThroughProvider(
                    editor,
                    harness.provider,
                    harness.events,
                )).saved;
                assert.equal(host.autoSaveCalls, 1);
            } else {
                saved = await host.saveAllThroughProvider([{
                    editor,
                    provider: harness.provider,
                    events: harness.events,
                }]);
                assert.equal(host.saveAllCalls, 1);
            }

            assert.equal(saved, true, trigger);
            assert.equal(editor.dirty, false, trigger);
            assert.equal(server.capturedUpdates.length, 1, trigger);
            assert.equal(server.text(PROJECT_A), desired, trigger);
            editor.closeThroughEvents(harness.events);
            harness.dispose();
        }
    });

    it('rejects a stale alias after a confirmed alias save and collaborator advance', async () => {
        const base = 'LEFT middle RIGHT';
        const aliasAContent = 'LOCAL middle RIGHT';
        const aliasBContent = 'LEFT middle STALE-B';
        const expectedRemote = 'LOCAL middle REMOTE';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Public Alias History', 3);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'public-alias-history',
            projectId: PROJECT_A,
        });

        assert.equal(
            new TextDecoder().decode(await harness.provider.readFile(harness.encodedUri)),
            base,
        );
        const aliasA = new SimulatedDirtyEditor(harness.encodedUri, base);
        aliasA.openClean(harness.events);
        await settleAsyncWork();
        await settleAsyncWork();
        assert.equal(harness.events.warningMessages.length, 0);

        const aliasBConfirmation = harness.events.deferWarningResponse();
        const aliasB = new SimulatedDirtyEditor(harness.reorderedUri, base);
        aliasB.openClean(harness.events);
        assert.equal(
            new TextDecoder().decode(await harness.provider.readFile(harness.reorderedUri)),
            base,
        );
        assert.equal(harness.events.warningMessages.length, 1);

        aliasA.editThroughEvents(aliasAContent, harness.events);
        const aliasASave = await aliasA.saveThroughProvider(harness.provider, harness.events);
        assert.equal(aliasASave.saved, true);
        assert.equal(server.text(PROJECT_A), aliasAContent);
        aliasA.closeThroughEvents(harness.events);

        server.collaboratorUpdate(
            PROJECT_A,
            replaceAt(aliasAContent, 'RIGHT', 'REMOTE'),
        );
        await settleAsyncWork();
        assert.equal(server.text(PROJECT_A), expectedRemote);

        aliasBConfirmation.resolve(ENABLE_CLEAN_EDITOR);
        await settleAsyncWork();
        await settleAsyncWork();
        const aliasBBufferId = harness.vfs.editorBufferIds.get(aliasB.document);
        assert.equal(
            harness.vfs.activeEditorBases.has(aliasBBufferId),
            false,
            'the stale alias read must not become a trusted base after remote advancement',
        );

        aliasB.editThroughEvents(aliasBContent, harness.events);
        const packetsBeforeAliasBSave = server.capturedUpdates.length;
        const aliasBSave = await aliasB.saveThroughProvider(harness.provider, harness.events);

        assert.equal(aliasBSave.saved, false);
        assert.equal(aliasB.dirty, true);
        assert.equal(aliasB.document.getText(), aliasBContent);
        assert.equal(server.capturedUpdates.length, packetsBeforeAliasBSave);
        assert.equal(server.text(PROJECT_A), expectedRemote);
        assert.match(server.text(PROJECT_A), /LOCAL/);
        assert.match(server.text(PROJECT_A), /REMOTE/);
        harness.dispose();
    });

    it('blocks genuine new text before any remote side effect', async () => {
        const server = new DeterministicRealtimeServer();
        addProject(server, 'existing', PROJECT_A, 'Public New Document', 3);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'public-new-document',
            projectId: PROJECT_A,
        });
        await harness.vfs.init();
        const newUri = harness.uri.with({path: '/Public New Document/new.tex'});
        const editor = new SimulatedDirtyEditor(newUri, 'new text');
        editor.attach();
        harness.events.queueWarningResponse(CREATE_NEW_DOCUMENT);

        const result = await editor.saveThroughProvider(
            harness.provider,
            harness.events,
            {create: true, overwrite: false},
        );

        assert.equal(result.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), 'new text');
        assert.equal(server.projectEntitiesReadCount, 0);
        assert.equal(server.addDocCallCount, 0);
        assert.equal(server.uploadFileCallCount, 0);
        assert.equal(server.documentCreationCount, 0);
        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.documentByName(PROJECT_A, 'new.tex'), undefined);
        harness.dispose();
    });

    it('cannot write a collaborator document hidden behind a stale missing-path cache', async () => {
        const server = new DeterministicRealtimeServer();
        addProject(server, 'existing', PROJECT_A, 'Public New Identity Race', 3);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'public-new-identity-race',
            projectId: PROJECT_A,
        });
        await harness.vfs.init();
        const newUri = harness.uri.with({path: '/Public New Identity Race/new.tex'});
        const editor = new SimulatedDirtyEditor(newUri, 'local initial text');
        editor.attach();
        const competing = server.createDocument(
            PROJECT_A,
            `${PROJECT_A}-root`,
            'new.tex',
            'collaborator text',
        );
        assert.equal(competing.type, 'success');

        const result = await editor.saveThroughProvider(
            harness.provider,
            harness.events,
            {create: true, overwrite: false},
        );

        assert.equal(result.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), 'local initial text');
        assert.equal(server.projectEntitiesReadCount, 0);
        assert.equal(server.addDocCallCount, 0);
        assert.equal(server.uploadFileCallCount, 0);
        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.documentByName(PROJECT_A, 'new.tex')?.content, 'collaborator text');
        harness.dispose();
    });

    it('does not bind a collaborator document created after will-save at a new path', async () => {
        const server = new DeterministicRealtimeServer();
        addProject(server, 'existing', PROJECT_A, 'New Identity TOCTOU', 3);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'new-identity-toctou',
            projectId: PROJECT_A,
        });
        await harness.vfs.init();
        const newUri = harness.uri.with({path: '/New Identity TOCTOU/new.tex'});
        const editor = new SimulatedDirtyEditor(newUri, 'same bytes');
        editor.attach();

        const first = await editor.saveThroughProvider(
            harness.provider,
            harness.events,
            {create: true, overwrite: false},
            () => {
                const competing = server.createDocument(
                    PROJECT_A,
                    `${PROJECT_A}-root`,
                    'new.tex',
                    'same bytes',
                );
                assert.equal(competing.type, 'success');
                harness.socket.handlers.onFileCreated?.(
                    `${PROJECT_A}-root`,
                    'doc',
                    competing.entity,
                );
            },
        );
        const second = await editor.saveThroughProvider(
            harness.provider,
            harness.events,
            {create: true, overwrite: true},
        );

        assert.equal(first.saved, false);
        assert.equal(second.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), 'same bytes');
        assert.deepEqual([...harness.socket.joinedDocuments], []);
        assert.equal(server.projectEntitiesReadCount, 0);
        assert.equal(server.addDocCallCount, 0);
        assert.equal(server.uploadFileCallCount, 0);
        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(harness.vfs.editorBufferIds.get(editor.document), undefined);
        assert.equal(harness.vfs.documentIdsByPath.has(newUri.toString()), false);
        assert.equal(server.documentByName(PROJECT_A, 'new.tex')?.content, 'same bytes');
        harness.dispose();
    });

    it('serializes repeated new-path saves as zero-side-effect failures', async () => {
        const server = new DeterministicRealtimeServer();
        addProject(server, 'existing', PROJECT_A, 'Public New Document Queued', 3);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'public-new-document-queued',
            projectId: PROJECT_A,
        });
        await harness.vfs.init();
        const newUri = harness.uri.with({path: '/Public New Document Queued/new.tex'});
        const editor = new SimulatedDirtyEditor(newUri, 'first text');
        editor.attach();

        const first = editor.saveThroughProvider(
            harness.provider,
            harness.events,
            {create: true, overwrite: false},
        );
        editor.editThroughEvents('second text', harness.events);
        const second = editor.saveThroughProvider(
            harness.provider,
            harness.events,
            {create: true, overwrite: true},
        );
        const [firstResult, secondResult] = await Promise.all([first, second]);

        assert.equal(firstResult.saved, false);
        assert.equal(secondResult.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), 'second text');
        assert.equal(server.projectEntitiesReadCount, 0);
        assert.equal(server.addDocCallCount, 0);
        assert.equal(server.uploadFileCallCount, 0);
        assert.equal(server.documentCreationCount, 0);
        assert.equal(server.capturedUpdates.length, 0);
        harness.dispose();
    });

    it('never reaches outcome-unknown OT recovery for an uncreated document', async () => {
        const server = new DeterministicRealtimeServer();
        addProject(server, 'existing', PROJECT_A, 'Public New Document Retry', 3);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'public-new-document-retry',
            projectId: PROJECT_A,
        });
        await harness.vfs.init();
        const newUri = harness.uri.with({path: '/Public New Document Retry/new.tex'});
        const editor = new SimulatedDirtyEditor(newUri, 'new text');
        editor.attach();
        server.loseNextAckAfterCommit();

        const result = await editor.saveThroughProvider(
            harness.provider,
            harness.events,
            {create: true, overwrite: false},
        );

        assert.equal(result.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), 'new text');
        assert.equal(server.projectEntitiesReadCount, 0);
        assert.equal(server.addDocCallCount, 0);
        assert.equal(server.uploadFileCallCount, 0);
        assert.equal(server.logicalApplyCount, 0);
        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.documentByName(PROJECT_A, 'new.tex'), undefined);
        harness.dispose();
    });


    it('keeps a genuinely new text document dirty when creation is not confirmed', async () => {
        const server = new DeterministicRealtimeServer();
        addProject(server, 'existing', PROJECT_A, 'Public New Document Cancel', 3);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'public-new-document-cancel',
            projectId: PROJECT_A,
        });
        await harness.vfs.init();
        const newUri = harness.uri.with({path: '/Public New Document Cancel/new.tex'});
        const editor = new SimulatedDirtyEditor(newUri, 'unconfirmed text');
        editor.attach();

        const result = await editor.saveThroughProvider(
            harness.provider,
            harness.events,
            {create: true, overwrite: false},
        );

        assert.equal(result.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), 'unconfirmed text');
        assert.equal(server.documentCreationCount, 0);
        assert.equal(server.documentByName(PROJECT_A, 'new.tex'), undefined);
        assert.equal(server.capturedUpdates.length, 0);
        harness.dispose();
    });

    it('rejects new-document creation when the buffer changes during confirmation', async () => {
        const server = new DeterministicRealtimeServer();
        addProject(server, 'existing', PROJECT_A, 'Public New Document Changed', 3);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'public-new-document-changed',
            projectId: PROJECT_A,
        });
        await harness.vfs.init();
        const newUri = harness.uri.with({path: '/Public New Document Changed/new.tex'});
        const editor = new SimulatedDirtyEditor(newUri, 'initial text');
        editor.attach();
        const confirmation = harness.events.deferWarningResponse();

        const saving = editor.saveThroughProvider(
            harness.provider,
            harness.events,
            {create: true, overwrite: false},
        );
        await settleAsyncWork();
        editor.editThroughEvents('changed while confirming', harness.events);
        confirmation.resolve(CREATE_NEW_DOCUMENT);
        const result = await saving;

        assert.equal(result.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), 'changed while confirming');
        assert.equal(server.documentCreationCount, 0);
        assert.equal(server.documentByName(PROJECT_A, 'new.tex'), undefined);
        assert.equal(server.capturedUpdates.length, 0);
        harness.dispose();
    });

    it('rejects ambiguous dirty buffers for one genuinely new path', async () => {
        const server = new DeterministicRealtimeServer();
        addProject(server, 'existing', PROJECT_A, 'Public New Document Ambiguous', 3);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'public-new-document-ambiguous',
            projectId: PROJECT_A,
        });
        await harness.vfs.init();
        const newUri = harness.uri.with({path: '/Public New Document Ambiguous/new.tex'});
        const first = new SimulatedDirtyEditor(newUri, 'same text');
        const second = new SimulatedDirtyEditor(newUri, 'same text');
        first.attach();
        second.attach();

        const result = await first.saveThroughProvider(
            harness.provider,
            harness.events,
            {create: true, overwrite: false},
        );

        assert.equal(result.saved, false);
        assert.equal(first.dirty, true);
        assert.equal(second.dirty, true);
        assert.equal(first.document.getText(), 'same text');
        assert.equal(second.document.getText(), 'same text');
        assert.equal(server.documentCreationCount, 0);
        assert.equal(server.documentByName(PROJECT_A, 'new.tex'), undefined);
        assert.equal(server.capturedUpdates.length, 0);
        harness.dispose();
    });

    it('fails closed for nested creation without a fresh parent-id/path contract', async () => {
        const server = new DeterministicRealtimeServer();
        addProject(server, 'existing', PROJECT_A, 'Public Nested New Document', 3);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'public-nested-new-document',
            projectId: PROJECT_A,
        });
        await harness.vfs.init();
        harness.vfs.root.rootFolder[0].folders.push({
            _id: `${PROJECT_A}-subfolder`,
            name: 'sub',
            docs: [],
            fileRefs: [],
            folders: [],
        });
        const newUri = harness.uri.with({path: '/Public Nested New Document/sub/new.tex'});
        const editor = new SimulatedDirtyEditor(newUri, 'nested local text');
        editor.attach();
        harness.events.queueWarningResponse(CREATE_NEW_DOCUMENT);

        const result = await editor.saveThroughProvider(
            harness.provider,
            harness.events,
            {create: true, overwrite: false},
        );

        assert.equal(result.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), 'nested local text');
        assert.equal(server.projectEntitiesReadCount, 0);
        assert.equal(server.addDocCallCount, 0);
        assert.equal(server.uploadFileCallCount, 0);
        assert.equal(server.documentCreationCount, 0);
        harness.dispose();
    });

    it('fails closed for new text on a server without a verified atomic contract', async () => {
        const server = new DeterministicRealtimeServer();
        addProject(server, 'existing', PROJECT_A, 'Unverified New Document', 3);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'unverified-new-document',
            projectId: PROJECT_A,
        });
        await harness.vfs.init();
        harness.vfs.serverUrl = 'https://www.overleaf.com:8443/';
        const newUri = harness.uri.with({path: '/Unverified New Document/new.tex'});
        const editor = new SimulatedDirtyEditor(newUri, 'unverified local text');
        editor.attach();
        harness.events.queueWarningResponse(CREATE_NEW_DOCUMENT);

        const result = await editor.saveThroughProvider(
            harness.provider,
            harness.events,
            {create: true, overwrite: false},
        );

        assert.equal(result.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), 'unverified local text');
        assert.equal(server.projectEntitiesReadCount, 0);
        assert.equal(server.addDocCallCount, 0);
        assert.equal(server.uploadFileCallCount, 0);
        assert.equal(server.documentCreationCount, 0);
        harness.dispose();
    });

    it('does not consult a path-only snapshot to authorize new initial text', async () => {
        const server = new DeterministicRealtimeServer();
        addProject(server, 'existing', PROJECT_A, 'Public New Document Race', 3);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'public-new-document-race',
            projectId: PROJECT_A,
        });
        await harness.vfs.init();
        const newUri = harness.uri.with({path: '/Public New Document Race/race.tex'});
        const editor = new SimulatedDirtyEditor(newUri, 'local race text');
        editor.attach();

        const result = await editor.saveThroughProvider(
            harness.provider,
            harness.events,
            {create: true, overwrite: false},
        );

        assert.equal(result.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), 'local race text');
        assert.equal(server.projectEntitiesReadCount, 0);
        assert.equal(server.addDocCallCount, 0);
        assert.equal(server.uploadFileCallCount, 0);
        assert.equal(server.documentCreationCount, 0);
        assert.equal(server.capturedUpdates.length, 0);
        harness.dispose();
    });


    it('never recreates a missing path that was bound to an older remote document', async () => {
        const server = new DeterministicRealtimeServer();
        addProject(server, 'existing', PROJECT_A, 'Public Missing Old Path', 3);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'public-old-missing',
            projectId: PROJECT_A,
        });
        await harness.vfs.init();
        const missingUri = harness.uri.with({path: '/Public Missing Old Path/deleted.tex'});
        const editor = new SimulatedDirtyEditor(missingUri, 'stale restored text');
        editor.attach();
        harness.vfs.documentIdsByPath.set(missingUri.toString(), 'deleted-document-id');
        harness.events.queueWarningResponse(CREATE_NEW_DOCUMENT);

        const result = await editor.saveThroughProvider(
            harness.provider,
            harness.events,
            {create: true, overwrite: false},
        );

        assert.equal(result.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), 'stale restored text');
        assert.equal(server.documentCreationCount, 0);
        assert.equal(server.documentByName(PROJECT_A, 'deleted.tex'), undefined);
        assert.equal(server.capturedUpdates.length, 0);
        harness.dispose();
    });

    it('fails closed when hot exit saves a stale dirty buffer with no trusted base', async () => {
        const advanced = `base\n${OWN_CONFIRMED}\n${COLLABORATOR}\n`;
        const restored = 'base\nLOCAL_DRAFT\n';
        const server = new DeterministicRealtimeServer();
        addProject(server, advanced, PROJECT_A, 'Hot Exit', 12);
        const harness = createHarness(server);
        await openAuthoritativeText(harness, false);
        const editor = new SimulatedDirtyEditor(harness.uri, restored);
        editor.attach();

        const result = await editor.save(harness.vfs);

        assert.equal(server.capturedUpdates.length, 0, 'untrusted restored text must emit no OT');
        assert.equal(server.text(PROJECT_A), advanced);
        assert.equal(server.version(PROJECT_A), 12);
        assert.equal(result.saved, false, 'the host must keep the unresolved restored buffer dirty');
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), restored);
        assert.match(server.text(PROJECT_A), new RegExp(OWN_CONFIRMED));
        assert.match(server.text(PROJECT_A), new RegExp(COLLABORATOR));
    });

    it('does not relabel a startup read of advanced remote text as restored-buffer ancestry', async () => {
        const advanced = `base\n${OWN_CONFIRMED}\n${COLLABORATOR}\n`;
        const restored = 'base\nLOCAL_DRAFT\n';
        const server = new DeterministicRealtimeServer();
        addProject(server, advanced, PROJECT_A, 'Read Before Restore', 7);
        const harness = createHarness(server);

        assert.equal(await openAuthoritativeText(harness, false), advanced);
        const editor = new SimulatedDirtyEditor(harness.uri, restored);
        editor.attach();
        editor.observeCleanThenOverlay(harness.vfs, advanced, restored);
        const result = await editor.save(harness.vfs);

        assert.equal(server.capturedUpdates.length, 0, 'startup read must not authorize rollback OT');
        assert.equal(server.text(PROJECT_A), advanced);
        assert.equal(result.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), restored);
    });

    it('does not erase an earlier confirmed user save after extension restart', async () => {
        const base = 'base\n';
        const confirmed = `base\n${OWN_CONFIRMED}\n`;
        const restored = 'base\nLOCAL_DRAFT\n';
        const storage = new HarnessStorage();
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Confirmed User Save', 1);

        const originalSession = createHarness(server, storage, 'owner-window');
        assert.equal(await openAuthoritativeText(originalSession), base);
        const confirmedEditor = new SimulatedDirtyEditor(originalSession.uri, confirmed);
        confirmedEditor.attach();
        await confirmedEditor.confirmStagedBase(originalSession.vfs, base);
        assert.equal((await confirmedEditor.save(originalSession.vfs)).saved, true);
        assert.equal(server.logicalApplyCount, 1);
        const confirmedSource = server.capturedUpdates[0].publicId;
        resetHarnessDocuments();
        originalSession.vfs.dispose();
        storage.restartWindow('owner-window');

        server.collaboratorUpdate(PROJECT_A, [{p: confirmed.length, i: `${COLLABORATOR}\n`}]);
        const advanced = `${confirmed}${COLLABORATOR}\n`;
        const versionBeforeRestore = server.version(PROJECT_A);
        const packetsBeforeRestore = server.capturedUpdates.length;
        const restarted = createHarness(server, storage, 'owner-window');
        assert.notEqual(restarted.socket.publicId, confirmedSource);
        await openAuthoritativeText(restarted, false);
        const restoredEditor = new SimulatedDirtyEditor(restarted.uri, restored);
        restoredEditor.attach();

        const result = await restoredEditor.save(restarted.vfs);

        assert.equal(result.saved, false);
        assert.equal(restoredEditor.dirty, true);
        assert.equal(restoredEditor.document.getText(), restored);
        assert.equal(server.capturedUpdates.length, packetsBeforeRestore);
        assert.equal(server.version(PROJECT_A), versionBeforeRestore);
        assert.equal(server.text(PROJECT_A), advanced);
        assert.match(server.text(PROJECT_A), new RegExp(OWN_CONFIRMED));
        assert.match(server.text(PROJECT_A), new RegExp(COLLABORATOR));
    });

    it('accepts an untrusted save as a no-op when it exactly matches authoritative text', async () => {
        const content = 'already authoritative\n';
        const server = new DeterministicRealtimeServer();
        addProject(server, content);
        const harness = createHarness(server);
        await openAuthoritativeText(harness, false);
        const editor = new SimulatedDirtyEditor(harness.uri, content);
        editor.attach();

        const result = await editor.save(harness.vfs);

        assert.equal(result.saved, true);
        assert.equal(editor.dirty, false);
        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.text(PROJECT_A), content);
    });

    it('rejects a remote-superset no-op while the host buffer lacks collaborator text', async () => {
        const base = 'LEFT middle RIGHT';
        const local = 'LOCAL middle RIGHT';
        const remote = 'LOCAL middle REMOTE';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Remote Superset Noop', 6);
        const harness = createHarness(server);
        assert.equal(await openAuthoritativeText(harness), base);
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.attach();
        await editor.confirmStagedBase(harness.vfs, base);
        editor.editThroughEvents(local, productionWorkspaceEvents);
        // Deliberately model a buffer outside this window: this regression is
        // about rejecting a stale no-op, not the live-editor transform path.
        editor.hideFromCurrentWindow();
        server.collaboratorUpdate(PROJECT_A, [
            ...replaceAt(base, 'RIGHT', 'REMOTE'),
        ]);
        server.collaboratorUpdate(
            PROJECT_A,
            replaceAt('LEFT middle REMOTE', 'LEFT', 'LOCAL'),
        );
        await settleAsyncWork();
        editor.attach();

        const result = await editor.save(harness.vfs);

        assert.equal(result.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), local);
        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.text(PROJECT_A), remote);
    });

    it('rejects a recovery save when remote advances before the save linearizes', async () => {
        const base = 'authoritative';
        const remote = 'authoritative + collaborator';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Reload Noop Race', 4);
        const harness = createHarness(server);
        assert.equal(await openAuthoritativeText(harness), base);
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.attach();
        await editor.confirmStagedBase(harness.vfs, base);
        editor.edit(base);
        server.collaboratorUpdate(PROJECT_A, [{p: base.length, i: ' + collaborator'}]);

        const result = await editor.save(harness.vfs);

        assert.equal(result.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), base);
        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.text(PROJECT_A), remote);
    });

    it('rebinds a recovery-save editor after the clean host adopts a later remote refresh', async () => {
        const base = 'LEFT middle RIGHT';
        const remote = 'LEFT middle REMOTE';
        const expected = 'LOCAL middle REMOTE';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Post-linearization Recovery', 4);
        const harness = createHarness(server);
        assert.equal(await openAuthoritativeText(harness), base);

        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.attach();
        const recoverySave = await editor.save(harness.vfs);

        assert.equal(recoverySave.saved, true);
        assert.equal(editor.dirty, false);
        assert.equal(editor.document.getText(), base);
        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.version(PROJECT_A), 4);
        const bufferId = harness.vfs.editorBufferIds.get(editor.document);
        const linearizedBase = harness.vfs.activeEditorBases.get(bufferId);
        assert.equal(linearizedBase?.version, 4);
        assert.equal(linearizedBase?.content, base);

        server.collaboratorUpdate(PROJECT_A, replaceAt(base, 'RIGHT', 'REMOTE'));
        await settleAsyncWork();
        assert.equal(server.text(PROJECT_A), remote);
        assert.equal(server.version(PROJECT_A), 5);
        assert.equal(editor.dirty, false);
        assert.equal(editor.document.getText(), base);
        assert.equal(await openAuthoritativeText(harness), remote);
        await editor.reloadAuthoritative(harness.vfs, remote);
        const advancedBase = harness.vfs.activeEditorBases.get(bufferId);
        assert.equal(advancedBase?.version, 5);
        assert.equal(advancedBase?.content, remote);

        editor.editThroughEvents(expected, productionWorkspaceEvents);
        const laterSave = await editor.save(harness.vfs);

        assert.equal(laterSave.saved, true);
        assert.equal(editor.dirty, false);
        assert.equal(editor.document.getText(), expected);
        assert.equal(server.capturedUpdates.length, 1);
        const sent = server.capturedUpdates[0].update;
        assert.equal(sent.v, 5);
        assert.equal(applyTextOperations(remote, sent.op), expected);
        assert.equal(server.text(PROJECT_A), expected);
        assert.match(server.text(PROJECT_A), /LOCAL/);
        assert.match(server.text(PROJECT_A), /REMOTE/);
    });

    it('sends an ordinary edit made from the exact joined base', async () => {
        const base = 'alpha omega';
        const desired = 'alpha LOCAL omega';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Exact Base', 4);
        const harness = createHarness(server);
        assert.equal(await openAuthoritativeText(harness), base);
        const editor = new SimulatedDirtyEditor(harness.uri, desired);
        editor.attach();
        await editor.confirmStagedBase(harness.vfs, base);

        const result = await editor.save(harness.vfs);

        assert.equal(result.saved, true);
        assert.equal(server.capturedUpdates.length, 1);
        const sent = server.capturedUpdates[0].update;
        assert.equal(sent.v, 4);
        assert.equal(applyTextOperations(base, sent.op), desired);
        assert.equal(server.text(PROJECT_A), desired);
        assert.equal(server.logicalApplyCount, 1);
    });

    it('merges non-overlapping edits into the live host and supports a second save', async () => {
        const base = 'LEFT middle RIGHT';
        const local = 'LOCAL middle RIGHT';
        const expected = 'LOCAL middle REMOTE';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Nonoverlap', 2);
        const harness = createHarness(server);
        assert.equal(await openAuthoritativeText(harness), base);
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.attach();
        await editor.confirmStagedBase(harness.vfs, base);
        editor.editThroughEvents(local, productionWorkspaceEvents);

        server.collaboratorUpdate(PROJECT_A, replaceAt(base, 'RIGHT', 'REMOTE'));
        await settleAsyncWork();
        const remoteBeforeSave = server.text(PROJECT_A);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), expected);
        const result = await editor.save(harness.vfs);

        assert.equal(result.saved, true);
        assert.equal(editor.dirty, false);
        assert.equal(editor.document.getText(), expected);
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(
            applyTextOperations(remoteBeforeSave, server.capturedUpdates[0].update.op),
            expected,
        );
        assert.equal(server.text(PROJECT_A), expected);
        assert.match(server.text(PROJECT_A), /LOCAL/);
        assert.match(server.text(PROJECT_A), /REMOTE/);

        const followUp = `${expected} NEXT`;
        editor.editThroughEvents(followUp, productionWorkspaceEvents);
        assert.equal((await editor.save(harness.vfs)).saved, true);
        assert.equal(server.capturedUpdates.length, 2);
        assert.equal(server.text(PROJECT_A), followUp);
    });

    it('presents post-base remote edits before manual, autosave, and compile saveAll writes', async () => {
        for (const trigger of ['manual', 'auto', 'compile-save-all'] as const) {
            const base = `HEAD-${trigger} middle TAIL-${trigger}`;
            const local = `LOCAL-${trigger} middle TAIL-${trigger}`;
            const expected = `LOCAL-${trigger} middle REMOTE-${trigger}`;
            const server = new DeterministicRealtimeServer();
            addProject(server, base, PROJECT_A, `Save ${trigger}`, 20);
            const harness = createHarness(server, new HarnessStorage(), `window-${trigger}`);
            assert.equal(await openAuthoritativeText(harness), base);
            const editor = new SimulatedDirtyEditor(harness.uri, base);
            editor.attach();
            await editor.confirmStagedBase(harness.vfs, base);
            editor.editThroughEvents(local, productionWorkspaceEvents);

            server.collaboratorUpdate(
                PROJECT_A,
                replaceAt(base, `TAIL-${trigger}`, `REMOTE-${trigger}`),
            );
            await settleAsyncWork();
            assert.equal(editor.dirty, true, trigger);
            assert.equal(editor.document.getText(), expected, trigger);
            const host = new SimulatedEditorHost();
            let result: {saved: boolean};
            let compileCalls = 0;
            if (trigger === 'manual') {
                result = await host.manualSave(editor, harness.vfs);
                assert.equal(host.manualSaveCalls, 1);
            } else if (trigger === 'auto') {
                result = await host.autoSave(editor, harness.vfs);
                assert.equal(host.autoSaveCalls, 1);
            } else {
                const saved = await host.saveAll([{editor, vfs: harness.vfs}]);
                assert.doesNotThrow(() => requireSavedCompileInputs(saved));
                if (saved) { compileCalls += 1; }
                result = {saved};
                assert.equal(host.saveAllCalls, 1);
                assert.equal(compileCalls, 1, 'compile may start only after the merged text saves');
            }

            assert.equal(result.saved, true, trigger);
            assert.equal(editor.dirty, false, trigger);
            assert.equal(editor.document.getText(), expected, trigger);
            assert.equal(server.capturedUpdates.length, 1, trigger);
            assert.equal(server.text(PROJECT_A), expected, trigger);
            assert.match(server.text(PROJECT_A), new RegExp(`LOCAL-${trigger}`));
            assert.match(server.text(PROJECT_A), new RegExp(`REMOTE-${trigger}`));
            editor.detach(harness.vfs);
            harness.vfs.dispose();
        }
    });

    it('initial compile saveAll stops on a stale overlay and preserves both buffers', async () => {
        const advanced = `base\n${OWN_CONFIRMED}\n${COLLABORATOR}\n`;
        const restored = 'base\nLOCAL_DRAFT\n';
        const server = new DeterministicRealtimeServer();
        addProject(server, advanced, PROJECT_A, 'Initial Compile SaveAll', 31);
        const harness = createHarness(server);
        assert.equal(await openAuthoritativeText(harness, false), advanced);
        const editor = new SimulatedDirtyEditor(harness.uri, restored);
        editor.attach();
        editor.observeCleanThenOverlay(harness.vfs, advanced, restored);
        const host = new SimulatedEditorHost();
        let compileCalls = 0;

        const saved = await host.saveAll([{editor, vfs: harness.vfs}]);
        assert.throws(() => requireSavedCompileInputs(saved), /could not be saved safely/);
        if (saved) { compileCalls += 1; }

        assert.equal(host.saveAllCalls, 1);
        assert.equal(compileCalls, 0);
        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.text(PROJECT_A), advanced);
        assert.equal(editor.document.getText(), restored);
        assert.equal(editor.dirty, true);
    });

    it('preserves both overlapping collaborator and local replacements through OT', async () => {
        const base = 'same line\n';
        const local = 'local line\n';
        const remote = 'remote line\n';
        const merged = 'remotelocal line\n';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Overlap', 3);
        const harness = createHarness(server);
        assert.equal(await openAuthoritativeText(harness), base);
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.attach();
        await editor.confirmStagedBase(harness.vfs, base);
        editor.editThroughEvents(local, productionWorkspaceEvents);

        server.collaboratorUpdate(PROJECT_A, replaceAt(base, 'same', 'remote'));
        await settleAsyncWork();
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), merged);
        const result = await editor.save(harness.vfs);

        assert.equal(result.saved, true);
        assert.equal(editor.dirty, false);
        assert.equal(editor.document.getText(), merged);
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(applyTextOperations(remote, server.capturedUpdates[0].update.op), merged);
        assert.equal(server.text(PROJECT_A), merged);
    });

    it('blocks the actual whole-buffer replacement when a remote deletion overlaps its base range', async () => {
        const server = new DeterministicRealtimeServer();
        addProject(server, 'ab', PROJECT_A, 'Causal Delete Counterexample', 10);
        const harness = createHarness(server);
        assert.equal(await openAuthoritativeText(harness), 'ab');
        const editor = new SimulatedDirtyEditor(harness.uri, 'ab');
        editor.attach();
        await editor.confirmStagedBase(harness.vfs, 'ab');
        editor.edit('ba');
        server.collaboratorUpdate(PROJECT_A, [{p: 0, d: 'a'}]);

        const result = await editor.save(harness.vfs);

        assert.equal(result.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), 'ba');
        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.text(PROJECT_A), 'b');
    });

    it('transforms an actual repeated-text insertion through the recorded remote operation', async () => {
        const server = new DeterministicRealtimeServer();
        addProject(server, 'bb', PROJECT_A, 'Causal Repeated Text', 10);
        const harness = createHarness(server);
        assert.equal(await openAuthoritativeText(harness), 'bb');
        const editor = new SimulatedDirtyEditor(harness.uri, 'bb');
        editor.attach();
        await editor.confirmStagedBase(harness.vfs, 'bb');
        editor.editThroughEvents('bRb', productionWorkspaceEvents);
        server.collaboratorUpdate(PROJECT_A, [{p: 0, i: 'b'}]);
        await settleAsyncWork();
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), 'bbRb');

        const result = await editor.save(harness.vfs);

        assert.equal(result.saved, true);
        assert.equal(editor.dirty, false);
        assert.equal(editor.document.getText(), 'bbRb');
        assert.equal(server.capturedUpdates.length, 1);
        assert.deepEqual(server.capturedUpdates[0].update.op, [{p: 2, i: 'R'}]);
        assert.equal(server.text(PROJECT_A), 'bbRb');
    });

    it('invalidates a causal epoch when one revision carries conflicting operations', async () => {
        const server = new DeterministicRealtimeServer();
        addProject(server, 'ab', PROJECT_A, 'Conflicting Duplicate Revision', 10);
        const harness = createHarness(server);
        assert.equal(await openAuthoritativeText(harness), 'ab');
        const editor = new SimulatedDirtyEditor(harness.uri, 'ab');
        editor.attach();
        await editor.confirmStagedBase(harness.vfs, 'ab');
        editor.edit('aRb');
        const docId = server.document(PROJECT_A).id;

        server.broadcastUncommittedDocumentUpdate(
            PROJECT_A,
            docId,
            10,
            [{p: 2, i: 'X'}],
        );
        server.collaboratorUpdate(PROJECT_A, [{p: 0, i: 'Y'}], docId);
        await settleAsyncWork();

        const cached = harness.vfs._resolveById(docId)?.fileEntity;
        assert.equal(cached?.version, undefined);
        assert.equal(cached?.remoteCache, undefined);
        const result = await editor.save(harness.vfs);

        assert.equal(result.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), 'aRb');
        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.text(PROJECT_A), 'Yab');
    });

    it('invalidates a causal epoch for missing, non-numeric, or unsafe remote revisions', async () => {
        for (const malformedVersion of [undefined, '10', Number.MAX_SAFE_INTEGER + 1]) {
            const server = new DeterministicRealtimeServer();
            addProject(server, 'ab', PROJECT_A, `Malformed Revision ${String(malformedVersion)}`, 10);
            const harness = createHarness(server);
            assert.equal(await openAuthoritativeText(harness), 'ab');
            const editor = new SimulatedDirtyEditor(harness.uri, 'ab');
            editor.attach();
            await editor.confirmStagedBase(harness.vfs, 'ab');
            const docId = server.document(PROJECT_A).id;

            harness.socket.handlers.onFileChanged?.({
                doc: docId,
                v: malformedVersion as unknown as number,
                op: [{p: 0, i: 'Y'}],
            }, {
                publicId: harness.socket.publicId,
                generation: harness.socket.generation,
            });

            const cached = harness.vfs._resolveById(docId)?.fileEntity;
            assert.equal(cached?.version, undefined);
            assert.equal(cached?.remoteCache, undefined);
            editor.edit('aRb');
            const result = await editor.save(harness.vfs);

            assert.equal(result.saved, false);
            assert.equal(editor.dirty, true);
            assert.equal(editor.document.getText(), 'aRb');
            assert.equal(server.capturedUpdates.length, 0);
            assert.equal(server.text(PROJECT_A), 'ab');
            editor.detach(harness.vfs);
            harness.vfs.dispose();
        }
    });

    it('invalidates causal ancestry across disconnect and emits zero OT after rejoin', async () => {
        const base = 'alpha middle omega';
        const local = 'ALPHA middle omega';
        const remote = 'alpha middle OMEGA';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Reconnect', 5);
        const harness = createHarness(server);
        assert.equal(await openAuthoritativeText(harness), base);
        const editor = new SimulatedDirtyEditor(harness.uri, local);
        editor.attach();
        await editor.confirmStagedBase(harness.vfs, base);

        const firstPublicId = harness.socket.publicId;
        harness.socket.disconnect();
        server.collaboratorUpdate(PROJECT_A, replaceAt(base, 'omega', 'OMEGA'));
        await harness.vfs.init();
        await settleAsyncWork();
        const result = await editor.save(harness.vfs);

        assert.equal(result.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), local);
        assert.notEqual(harness.socket.publicId, firstPublicId);
        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.text(PROJECT_A), remote);
    });

    it('retries once when the queue acknowledgement is lost before application', async () => {
        const base = 'abc';
        const desired = 'abXc';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Pre-commit Ack Loss', 9);
        const storage = new HarnessStorage();
        const harness = createHarness(server, storage, 'writer');
        const observer = createHarness(server, storage, 'observer');
        assert.equal(await openAuthoritativeText(harness), base);
        assert.equal(await openAuthoritativeText(observer), base);
        const editor = new SimulatedDirtyEditor(harness.uri, desired);
        editor.attach();
        await editor.confirmStagedBase(harness.vfs, base);
        server.loseNextAckBeforeCommit();

        const interrupted = await editor.save(harness.vfs);
        assert.equal(interrupted.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(server.text(PROJECT_A), base);
        assert.equal(server.logicalApplyCount, 0);
        assert.equal(server.senderConfirmationCount, 0);
        assert.equal(server.collaboratorBroadcastCount, 0);
        assert.equal(server.capturedUpdates.length, 1);
        const first = server.capturedUpdates[0];

        await harness.vfs.init();
        await settleAsyncWork();
        const recovered = await editor.save(harness.vfs);

        assert.equal(recovered.saved, true);
        assert.equal(server.capturedUpdates.length, 2);
        const retry = server.capturedUpdates[1];
        assert.notEqual(retry.publicId, first.publicId);
        assert.equal(retry.update.v, first.update.v);
        assert.deepEqual(retry.update.op, first.update.op);
        assert.deepEqual(retry.update.dupIfSource, [first.publicId]);
        assert.equal(server.queueAcknowledgementCount, 1);
        assert.equal(server.logicalApplyCount, 1);
        assert.equal(server.senderConfirmationCount, 1);
        assert.equal(server.collaboratorBroadcastCount, 1);
        assert.equal(server.text(PROJECT_A), desired);
    });

    it('emits zero retry OT when the fresh authoritative revision cannot advance safely', async () => {
        const base = 'abc';
        const desired = 'abXc';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Unsafe Retry Revision', 9);
        const harness = createHarness(server, new HarnessStorage(), 'writer');
        assert.equal(await openAuthoritativeText(harness), base);
        const editor = new SimulatedDirtyEditor(harness.uri, desired);
        editor.attach();
        await editor.confirmStagedBase(harness.vfs, base);
        server.loseNextAckBeforeCommit();

        const interrupted = await editor.save(harness.vfs);
        assert.equal(interrupted.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.logicalApplyCount, 0);

        server.document(PROJECT_A).version = Number.MAX_SAFE_INTEGER;
        await harness.vfs.init();
        await settleAsyncWork();
        const recovered = await editor.save(harness.vfs);

        assert.equal(recovered.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), desired);
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.logicalApplyCount, 0);
        assert.equal(server.text(PROJECT_A), base);
        assert.equal(server.version(PROJECT_A), Number.MAX_SAFE_INTEGER);
    });

    it('rechecks the authoritative revision after persisting a retry intent', async () => {
        const base = 'abc';
        const desired = 'abXc';
        const storage = new HarnessStorage();
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Retry Authority Race', 9);
        const harness = createHarness(server, storage, 'writer');
        assert.equal(await openAuthoritativeText(harness), base);
        const editor = new SimulatedDirtyEditor(harness.uri, desired);
        editor.attach();
        await editor.confirmStagedBase(harness.vfs, base);
        server.loseNextAckBeforeCommit();

        const interrupted = await editor.save(harness.vfs);
        assert.equal(interrupted.saved, false);
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.logicalApplyCount, 0);

        server.document(PROJECT_A).version = Number.MAX_SAFE_INTEGER - 1;
        await harness.vfs.init();
        await settleAsyncWork();
        const provenanceStore = storage.provenanceStore('writer');
        const markPendingWrite = provenanceStore.markPendingWrite.bind(provenanceStore);
        provenanceStore.markPendingWrite = async (recordName, pendingWrite) => {
            const record = await markPendingWrite(recordName, pendingWrite);
            provenanceStore.markPendingWrite = markPendingWrite;
            server.collaboratorUpdate(PROJECT_A, [{p: 0, i: 'Y'}]);
            return record;
        };

        const recovered = await editor.save(harness.vfs);

        assert.equal(recovered.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), desired);
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.logicalApplyCount, 0);
        assert.equal(server.text(PROJECT_A), `Y${base}`);
        assert.equal(server.version(PROJECT_A), Number.MAX_SAFE_INTEGER);
    });

    it('retains a confirmed initial editor write when its later ACK reports rejection', async () => {
        const base = 'abc';
        const desired = 'abXc';
        const server = new DeterministicRealtimeServer();
        const storage = new HarnessStorage();
        addProject(server, base, PROJECT_A, 'Confirmed Then Rejected Editor', 9);
        const harness = createHarness(server, storage, 'writer');
        assert.equal(await openAuthoritativeText(harness), base);
        const editor = new SimulatedDirtyEditor(harness.uri, desired);
        editor.attach();
        await editor.confirmStagedBase(harness.vfs, base);
        const bufferId = harness.vfs.editorBufferIds.get(editor.document);
        const scheduled = harness.vfs.liveEditorSubmissions.get(bufferId);
        if (scheduled?.timer) { clearTimeout(scheduled.timer); }
        harness.vfs.liveEditorSubmissions.delete(bufferId);
        rejectNextAcknowledgementAfterSenderConfirmation(harness);

        const interrupted = await editor.save(harness.vfs);

        assert.equal(interrupted.saved, false);
        assert.equal((interrupted.error as SocketRequestError)?.outcomeUnknown, true);
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.logicalApplyCount, 1);
        assert.equal(server.text(PROJECT_A), desired);
        const pending = harness.vfs.pendingDocumentUpdates.get(bufferId);
        assert.ok(pending);
        assert.equal(pending.confirmationVersion, 9);
        const active = harness.vfs.activeEditorBases.get(bufferId);
        assert.ok(active);
        const durable = await storage.provenanceStore('writer').resolveCurrentRecord(
            pending.provenanceRecordName,
            {
                identity: active.identity,
                bufferIncarnationId: bufferId,
                baseVersion: 9,
                baseText: base,
                dirtyText: desired,
            },
        );
        assert.equal(durable.kind, 'valid', JSON.stringify(durable));
        if (durable.kind === 'valid') { assert.notEqual(durable.record.pendingWrite, undefined); }

        await settleAsyncWork();
        harness.socket.disconnect();
        harness.vfs.forceFreshConnection();
        await harness.vfs.init();
        await settleAsyncWork();
        const recovered = await editor.save(harness.vfs);
        assert.equal(recovered.saved, true, String(recovered.error));
        assert.equal(server.capturedUpdates.length, 1, 'confirmed content must not be resent');
        assert.equal(server.logicalApplyCount, 1);
        assert.equal(server.text(PROJECT_A), desired);
    });

    it('retains a confirmed editorless conditional write when its later ACK reports rejection', async () => {
        const base = '@article{old}\n';
        const desired = `${base}@article{new}\n`;
        const server = new DeterministicRealtimeServer();
        const storage = new HarnessStorage();
        addProject(server, base, PROJECT_A, 'Confirmed Then Rejected Conditional', 9);
        const harness = createHarness(server, storage, 'writer');
        assert.equal(await openAuthoritativeText(harness), base);
        rejectNextAcknowledgementAfterSenderConfirmation(harness);

        await assert.rejects(
            harness.vfs.writeFile(
                harness.uri,
                new TextEncoder().encode(desired),
                false,
                true,
            ),
            (error: any) => error?.outcomeUnknown === true,
        );

        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.logicalApplyCount, 1);
        assert.equal(server.text(PROJECT_A), desired);
        const pending = harness.vfs.pendingConditionalDocumentUpdates.get('same-doc-id');
        assert.ok(pending);
        assert.equal(pending.confirmationVersion, 9);
        const durable = await storage.provenanceStore('writer').resolveCurrentRecord(
            pending.provenanceRecordName,
            {
                identity: pending.identity,
                bufferIncarnationId: pending.bufferIncarnationId,
                baseVersion: 9,
                baseText: base,
                dirtyText: desired,
            },
        );
        assert.equal(durable.kind, 'valid', JSON.stringify(durable));
        if (durable.kind === 'valid') { assert.notEqual(durable.record.pendingWrite, undefined); }

        await settleAsyncWork();
        harness.socket.disconnect();
        harness.vfs.forceFreshConnection();
        await harness.vfs.init();
        await settleAsyncWork();
        await harness.vfs.writeFile(
            harness.uri,
            new TextEncoder().encode(desired),
            false,
            true,
        );
        assert.equal(server.capturedUpdates.length, 1, 'confirmed conditional content must not be resent');
        assert.equal(server.logicalApplyCount, 1);
        assert.equal(server.text(PROJECT_A), desired);
    });

    it('retains a confirmed deduplicated retry when its later ACK reports rejection', async () => {
        const base = 'abc';
        const desired = 'abXc';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Confirmed Then Rejected Retry', 9);
        const harness = createHarness(server, new HarnessStorage(), 'writer');
        assert.equal(await openAuthoritativeText(harness), base);
        const editor = new SimulatedDirtyEditor(harness.uri, desired);
        editor.attach();
        await editor.confirmStagedBase(harness.vfs, base);
        const bufferId = harness.vfs.editorBufferIds.get(editor.document);
        const scheduled = harness.vfs.liveEditorSubmissions.get(bufferId);
        if (scheduled?.timer) { clearTimeout(scheduled.timer); }
        harness.vfs.liveEditorSubmissions.delete(bufferId);
        server.loseNextAckBeforeCommit();

        const first = await editor.save(harness.vfs);
        assert.equal(first.saved, false);
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.logicalApplyCount, 0);
        await harness.vfs.init();
        await settleAsyncWork();
        rejectNextAcknowledgementAfterSenderConfirmation(harness);

        const retry = await editor.save(harness.vfs);

        assert.equal(retry.saved, false);
        assert.equal((retry.error as SocketRequestError)?.outcomeUnknown, true);
        assert.equal(server.capturedUpdates.length, 2);
        assert.equal(server.logicalApplyCount, 1);
        assert.equal(server.text(PROJECT_A), desired);
        const pending = harness.vfs.pendingDocumentUpdates.get(bufferId);
        assert.ok(pending);
        assert.equal(pending.confirmationVersion, 9);
        assert.equal(pending.submittedPublicIds.length, 2);

        await harness.vfs.init();
        await settleAsyncWork();
        const recovered = await editor.save(harness.vfs);
        assert.equal(recovered.saved, true, String(recovered.error));
        assert.equal(server.capturedUpdates.length, 2, 'the confirmed retry must not be sent again');
        assert.equal(server.logicalApplyCount, 1);
        assert.equal(server.text(PROJECT_A), desired);
    });

    it('retains durable dedupe evidence when payload enqueue succeeds but notification enqueue disconnects', async () => {
        const base = 'abc';
        const desired = 'abXc';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Partial Queue Enqueue', 9);
        const storage = new HarnessStorage();
        const harness = createHarness(server, storage, 'writer');
        assert.equal(await openAuthoritativeText(harness), base);
        const editor = new SimulatedDirtyEditor(harness.uri, desired);
        editor.attach();
        await editor.confirmStagedBase(harness.vfs, base);
        server.failNextNotificationEnqueue();

        const interrupted = await editor.save(harness.vfs);

        assert.equal(interrupted.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(server.text(PROJECT_A), base);
        assert.equal(server.logicalApplyCount, 0);
        assert.equal(server.queueAcknowledgementCount, 0);
        assert.equal(server.capturedUpdates.length, 1);
        const first = server.capturedUpdates[0];
        const bufferId = harness.vfs.editorBufferIds.get(editor.document);
        const pending = harness.vfs.pendingDocumentUpdates.get(bufferId);
        assert.ok(pending);
        assert.deepEqual(pending.submittedPublicIds, [first.publicId]);
        const durable = await storage.provenanceStore('writer').resolveCurrentRecord(
            pending.provenanceRecordName,
            {
                identity: harness.vfs.activeEditorBases.get(bufferId).identity,
                bufferIncarnationId: bufferId,
                baseVersion: 9,
                baseText: base,
                dirtyText: desired,
            },
        );
        assert.equal(durable.kind, 'valid', JSON.stringify(durable));
        if (durable.kind === 'valid') { assert.notEqual(durable.record.pendingWrite, undefined); }

        await harness.vfs.init();
        await settleAsyncWork();
        const recovered = await editor.save(harness.vfs);

        assert.equal(recovered.saved, true);
        assert.equal(server.capturedUpdates.length, 2);
        const retry = server.capturedUpdates[1];
        assert.deepEqual(retry.update.dupIfSource, [first.publicId]);
        assert.equal(server.logicalApplyCount, 1);
        assert.equal(server.senderConfirmationCount, 1);
        assert.equal(server.text(PROJECT_A), desired);
    });

    it('extends the stable source chain across two consecutive partial enqueues', async () => {
        const base = 'abc';
        const desired = 'abXc';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Repeated Partial Queue Enqueue', 9);
        const harness = createHarness(server, new HarnessStorage(), 'writer');
        assert.equal(await openAuthoritativeText(harness), base);
        const editor = new SimulatedDirtyEditor(harness.uri, desired);
        editor.attach();
        await editor.confirmStagedBase(harness.vfs, base);

        server.failNextNotificationEnqueue();
        assert.equal((await editor.save(harness.vfs)).saved, false);
        await harness.vfs.init();
        await settleAsyncWork();
        server.failNextNotificationEnqueue();
        assert.equal((await editor.save(harness.vfs)).saved, false);
        assert.equal(server.capturedUpdates.length, 2);
        const [first, second] = server.capturedUpdates;
        assert.deepEqual(second.update.dupIfSource, [first.publicId]);
        const bufferId = harness.vfs.editorBufferIds.get(editor.document);
        assert.deepEqual(
            harness.vfs.pendingDocumentUpdates.get(bufferId).submittedPublicIds,
            [first.publicId, second.publicId],
        );

        await harness.vfs.init();
        await settleAsyncWork();
        const recovered = await editor.save(harness.vfs);

        assert.equal(recovered.saved, true);
        assert.equal(server.capturedUpdates.length, 3);
        const third = server.capturedUpdates[2];
        assert.deepEqual(third.update.dupIfSource, [first.publicId, second.publicId]);
        assert.equal(server.logicalApplyCount, 1);
        assert.equal(server.senderConfirmationCount, 1);
        assert.equal(server.text(PROJECT_A), desired);
    });

    it('treats a collaborator document-wide OT error as an unknown local outcome', async () => {
        const base = 'abc';
        const desired = 'abXc';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Collaborator OT Error', 9);
        const storage = new HarnessStorage();
        const writer = createHarness(server, storage, 'writer');
        const collaborator = createHarness(server, storage, 'collaborator');
        assert.equal(await openAuthoritativeText(writer), base);
        assert.equal(await openAuthoritativeText(collaborator), base);
        const editor = new SimulatedDirtyEditor(writer.uri, desired);
        editor.attach();
        await editor.confirmStagedBase(writer.vfs, base);
        server.holdNextApplicationAfterAck();

        const saving = editor.save(writer.vfs);
        await settleAsyncWork();
        assert.equal(server.capturedUpdates.length, 1);
        const first = server.capturedUpdates[0];
        const bufferId = writer.vfs.editorBufferIds.get(editor.document);
        assert.ok(writer.vfs.pendingDocumentUpdates.has(bufferId));

        server.broadcastDocumentUpdateError(
            PROJECT_A,
            'same-doc-id',
            'collaborator operation rejected',
        );
        const interrupted = await saving;

        assert.equal(interrupted.saved, false);
        assert.equal(editor.dirty, true);
        assert.ok(writer.vfs.pendingDocumentUpdates.has(bufferId));
        assert.deepEqual(
            writer.vfs.pendingDocumentUpdates.get(bufferId).submittedPublicIds,
            [first.publicId],
        );
        server.releaseHeldApplication();
        assert.equal(server.logicalApplyCount, 1);
        assert.equal(server.text(PROJECT_A), desired);

        await writer.vfs.init();
        await settleAsyncWork();
        const recovered = await editor.save(writer.vfs);

        assert.equal(recovered.saved, true);
        assert.equal(server.capturedUpdates.length, 2);
        assert.deepEqual(server.capturedUpdates[1].update.dupIfSource, [first.publicId]);
        assert.equal(server.logicalApplyCount, 1, 'the retained local operation must not apply twice');
        assert.equal(server.text(PROJECT_A), desired);
    });

    it('observes queue acknowledgement before later application and sender confirmation', async () => {
        const base = 'abc';
        const desired = 'abXc';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Held Application', 9);
        const harness = createHarness(server);
        assert.equal(await openAuthoritativeText(harness), base);
        const editor = new SimulatedDirtyEditor(harness.uri, desired);
        editor.attach();
        await editor.confirmStagedBase(harness.vfs, base);
        server.holdNextApplicationAfterAck();

        let saveSettled = false;
        const saving = editor.save(harness.vfs).then(result => {
            saveSettled = true;
            return result;
        });
        await settleAsyncWork();

        assert.equal(server.queueAcknowledgementCount, 1);
        assert.equal(server.logicalApplyCount, 0);
        assert.equal(server.senderConfirmationCount, 0);
        assert.equal(server.text(PROJECT_A), base);
        assert.equal(saveSettled, false, 'queue acknowledgement alone must not complete the save');

        server.releaseHeldApplication();
        const result = await saving;

        assert.equal(result.saved, true);
        assert.equal(editor.dirty, false);
        assert.equal(server.logicalApplyCount, 1);
        assert.equal(server.senderConfirmationCount, 1);
        assert.equal(server.text(PROJECT_A), desired);
    });

    it('accepts a transformed sender confirmation after an intervening collaborator operation', async () => {
        const base = 'abc';
        const desired = 'abXc';
        const expected = 'YabXc';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Transformed Confirmation', 9);
        const storage = new HarnessStorage();
        const harness = createHarness(server, storage);
        assert.equal(await openAuthoritativeText(harness), base);
        const editor = new SimulatedDirtyEditor(harness.uri, desired);
        editor.attach();
        await editor.confirmStagedBase(harness.vfs, base);
        server.holdNextApplicationAfterAck();

        const saving = editor.save(harness.vfs);
        await settleAsyncWork();
        server.collaboratorUpdate(PROJECT_A, [{p: 0, i: 'Y'}]);
        server.releaseHeldApplicationWithTransform();
        const result = await saving;

        assert.equal(result.saved, true, String(result.error));
        assert.equal(editor.dirty, false);
        assert.equal(editor.document.getText(), expected);
        assert.equal(server.logicalApplyCount, 1);
        assert.equal(server.senderConfirmationCount, 1);
        assert.equal(server.text(PROJECT_A), expected);
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.capturedUpdates[0].update.v, 9);
        const bufferId = harness.vfs.editorBufferIds.get(editor.document);
        assert.equal(harness.vfs.pendingDocumentUpdates.has(bufferId), false);
        const active = harness.vfs.activeEditorBases.get(bufferId);
        const persisted = await storage.provenanceStore('window-a').resolveCurrentRecord(
            active.recordName,
            {
                identity: active.identity,
                bufferIncarnationId: bufferId,
                baseVersion: 11,
                baseText: expected,
                dirtyText: expected,
            },
        );
        assert.equal(persisted.kind, 'valid', JSON.stringify(persisted));
        if (persisted.kind === 'valid') {
            assert.equal(persisted.record.pendingWrite, undefined);
        }
    });

    it('does not accept an op-less confirmation without a socket sender witness', async () => {
        const base = 'abc';
        const desired = 'abXc';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Anonymous Confirmation', 9);
        const harness = createHarness(server);
        assert.equal(await openAuthoritativeText(harness), base);
        const editor = new SimulatedDirtyEditor(harness.uri, desired);
        editor.attach();
        await editor.confirmStagedBase(harness.vfs, base);
        server.holdNextApplicationAfterAck();

        let saveSettled = false;
        const saving = editor.save(harness.vfs).then(result => {
            saveSettled = true;
            return result;
        });
        await settleAsyncWork();
        assert.equal(server.logicalApplyCount, 0);
        harness.socket.emitAnonymousSenderConfirmation('same-doc-id', 9);
        await settleAsyncWork();

        assert.equal(saveSettled, false, 'an anonymous confirmation must not complete the save');
        assert.equal(editor.dirty, true);
        assert.equal(server.logicalApplyCount, 0);
        assert.equal(server.text(PROJECT_A), base);
        server.releaseHeldApplication();
        const result = await saving;
        assert.equal(result.saved, true);
        assert.equal(editor.dirty, false);
        assert.equal(server.text(PROJECT_A), desired);
    });

    it('deduplicates an applied update when its acknowledgement and confirmation are lost', async () => {
        const base = `${OWN_CONFIRMED}:abc`;
        const desired = `${OWN_CONFIRMED}:abXc`;
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Ack Loss', 9);
        const storage = new HarnessStorage();
        const harness = createHarness(server, storage, 'writer');
        const observer = createHarness(server, storage, 'observer');
        assert.equal(await openAuthoritativeText(harness), base);
        assert.equal(await openAuthoritativeText(observer), base);
        const editor = new SimulatedDirtyEditor(harness.uri, desired);
        editor.attach();
        await editor.confirmStagedBase(harness.vfs, base);
        server.loseNextAckAfterCommit();

        const interrupted = await editor.save(harness.vfs);
        assert.equal(interrupted.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(server.text(PROJECT_A), desired);
        assert.equal(server.logicalApplyCount, 1);
        assert.equal(server.queueAcknowledgementCount, 0);
        assert.equal(server.senderConfirmationCount, 0);
        assert.equal(server.collaboratorBroadcastCount, 1);
        assert.equal(server.capturedUpdates.length, 1);
        const first = server.capturedUpdates[0];
        editor.hideFromCurrentWindow();
        assert.equal(await openAuthoritativeText(observer), desired);
        const observerEditor = new SimulatedDirtyEditor(observer.uri, desired);
        observerEditor.attach();
        await observerEditor.confirmStagedBase(observer.vfs, desired);
        assert.equal(observerEditor.document.getText(), desired);

        observerEditor.editThroughEvents(
            `${COLLABORATOR}:Y${desired}`,
            productionWorkspaceEvents,
        );
        assert.equal((await observerEditor.save(observer.vfs)).saved, true);
        assert.equal(observerEditor.dirty, false);
        assert.equal(server.text(PROJECT_A), `${COLLABORATOR}:Y${desired}`);

        observerEditor.hideFromCurrentWindow();
        editor.attach();
        await harness.vfs.init();
        await settleAsyncWork();
        const recovered = await editor.save(harness.vfs);

        assert.equal(recovered.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(server.capturedUpdates.length, 3, 'one intervening save and one deduplicated retry are expected');
        const retry = server.capturedUpdates[2];
        assert.notEqual(retry.publicId, first.publicId);
        assert.equal(retry.update.v, first.update.v);
        assert.deepEqual(retry.update.op, first.update.op);
        assert.deepEqual(retry.update.dupIfSource, [first.publicId]);
        assert.equal(server.queueAcknowledgementCount, 2);
        assert.equal(server.logicalApplyCount, 2, 'only the writer and intervening collaborator edits may apply');
        assert.equal(server.senderConfirmationCount, 2);
        assert.equal(
            server.collaboratorBroadcastCount,
            1,
            'the retry must not rebroadcast the operation to collaborators',
        );
        assert.equal(server.text(PROJECT_A), `${COLLABORATOR}:Y${desired}`);
        assert.match(server.text(PROJECT_A), new RegExp(OWN_CONFIRMED));
        assert.match(server.text(PROJECT_A), new RegExp(COLLABORATOR));
    });

    it('keeps effectful saves isolated across two windows and two projects', async () => {
        const storage = new HarnessStorage();
        const server = new DeterministicRealtimeServer();
        const sharedBase = 'left middle right';
        addProject(server, sharedBase, PROJECT_A, 'Shared Path', 1);
        addProject(server, 'project b', PROJECT_B, 'Shared Path', 4);

        const leftWindow = createHarness(server, storage, 'window-left', PROJECT_A);
        const rightWindow = createHarness(server, storage, 'window-right', PROJECT_A);
        assert.equal(await openAuthoritativeText(leftWindow), sharedBase);
        assert.equal(await openAuthoritativeText(rightWindow), sharedBase);
        const leftEditor = new SimulatedDirtyEditor(leftWindow.uri, 'LEFT middle right');
        const rightEditor = new SimulatedDirtyEditor(rightWindow.uri, 'left middle RIGHT');
        leftEditor.attach();
        rightEditor.attach();
        await leftEditor.confirmStagedBase(leftWindow.vfs, sharedBase);
        await rightEditor.confirmStagedBase(rightWindow.vfs, sharedBase);

        rightEditor.hideFromCurrentWindow();
        assert.equal((await leftEditor.save(leftWindow.vfs)).saved, true);
        leftEditor.hideFromCurrentWindow();
        rightEditor.attach();
        assert.equal((await rightEditor.save(rightWindow.vfs)).saved, false);
        assert.equal(rightEditor.dirty, true);
        assert.equal(rightEditor.document.getText(), 'left middle RIGHT');
        rightEditor.hideFromCurrentWindow();

        const projectB = createHarness(server, storage, 'window-left', PROJECT_B);
        assert.equal(projectB.uri.path, leftWindow.uri.path);
        assert.notEqual(projectB.uri.query, leftWindow.uri.query);
        assert.equal(await openAuthoritativeText(projectB), 'project b');
        const projectBEditor = new SimulatedDirtyEditor(projectB.uri, 'PROJECT B');
        projectBEditor.attach();
        await projectBEditor.confirmStagedBase(projectB.vfs, 'project b');
        assert.equal((await projectBEditor.save(projectB.vfs)).saved, true);

        assert.equal(server.text(PROJECT_A), 'LEFT middle right');
        assert.equal(server.text(PROJECT_B), 'PROJECT B');
        assert.deepEqual(
            server.capturedUpdates.map(update => update.projectId),
            [PROJECT_A, PROJECT_B],
        );
        assert.notEqual(
            server.capturedUpdates[0].publicId,
            server.capturedUpdates[1].publicId,
        );
    });

    it('uses one VFS for encoded/decoded/reordered aliases and blocks two dirty incarnations', async () => {
        const storage = new HarnessStorage();
        const server = new DeterministicRealtimeServer();
        const base = 'shared authoritative text';
        addProject(server, base, PROJECT_A, 'Alias Project', 3);
        const aliases = await createAliasProviderProject({
            server,
            storage,
            windowId: 'alias-window',
            projectId: PROJECT_A,
        });
        assert.equal(server.clientCreationCount, 1, 'all aliases must share one realtime socket/VFS');
        assert.equal(new TextDecoder().decode(await aliases.provider.readFile(aliases.decodedUri)), base);
        assert.equal(new TextDecoder().decode(await aliases.provider.readFile(aliases.encodedUri)), base);
        assert.equal(new TextDecoder().decode(await aliases.provider.readFile(aliases.reorderedUri)), base);

        const encodedEditor = new SimulatedDirtyEditor(aliases.encodedUri, 'encoded dirty text');
        const reorderedEditor = new SimulatedDirtyEditor(aliases.reorderedUri, 'reordered dirty text');
        encodedEditor.attach();
        reorderedEditor.attach();

        const encodedSave = await encodedEditor.save(aliases.vfs);
        const reorderedSave = await reorderedEditor.save(aliases.vfs);

        assert.equal(encodedSave.saved, false);
        assert.equal(reorderedSave.saved, false);
        assert.equal(encodedEditor.dirty, true);
        assert.equal(reorderedEditor.dirty, true);
        assert.equal(encodedEditor.document.getText(), 'encoded dirty text');
        assert.equal(reorderedEditor.document.getText(), 'reordered dirty text');
        assert.equal(server.capturedUpdates.length, 0, 'ambiguous alias ownership must emit zero OT');
        assert.equal(server.text(PROJECT_A), base);
        aliases.provider.dispose();
    });

    it('fails an explicit save closed when two live states match the same resource', async () => {
        const base = 'shared authoritative text';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Ambiguous Live State', 3);
        const harness = createHarness(server);
        assert.equal(await openAuthoritativeText(harness), base);
        const first = new SimulatedDirtyEditor(harness.uri, base);
        const second = new SimulatedDirtyEditor(harness.uri, base);
        first.dirty = false;
        second.dirty = false;
        first.attach();
        second.attach();
        const firstBuffer = harness.vfs.observeEditorBuffer(first.document);
        const secondBuffer = harness.vfs.observeEditorBuffer(second.document);
        assert.ok(firstBuffer);
        assert.ok(secondBuffer);
        first.edit('first local text');
        second.edit('second local text');
        harness.vfs.liveEditorSubmissions.set(firstBuffer.bufferId, {
            bufferId: firstBuffer.bufferId,
            document: first.document,
            requested: false,
        });
        harness.vfs.liveEditorSubmissions.set(secondBuffer.bufferId, {
            bufferId: secondBuffer.bufferId,
            document: second.document,
            requested: false,
        });

        await assert.rejects(
            harness.vfs.writeFile(
                harness.uri,
                new TextEncoder().encode(first.document.getText()),
                false,
                true,
            ),
            /multiple live editor buffers/i,
        );

        assert.equal(first.document.getText(), 'first local text');
        assert.equal(second.document.getText(), 'second local text');
        assert.equal(harness.vfs.recoveryNotifications.size, 1);
        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.text(PROJECT_A), base);
    });

    it('rejects create false for a missing path without losing either buffer', async () => {
        const authoritative = `${OWN_CONFIRMED}\n${COLLABORATOR}\n`;
        const local = 'UNSAVED_LOCAL\n';
        const server = new DeterministicRealtimeServer();
        addProject(server, authoritative, PROJECT_A, 'Missing Path', 6);
        const harness = createHarness(server);
        await harness.vfs.init();
        const missingUri = harness.uri.with({path: '/Missing Path/missing.tex'});
        let createCalls = 0;
        harness.vfs.createFile = async () => { createCalls += 1; };
        const editor = new SimulatedDirtyEditor(missingUri, local);
        editor.attach();

        const result = await editor.save(harness.vfs);

        assert.equal(result.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), local);
        assert.equal(createCalls, 0);
        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.text(PROJECT_A), authoritative);
        assert.match(server.text(PROJECT_A), new RegExp(OWN_CONFIRMED));
        assert.match(server.text(PROJECT_A), new RegExp(COLLABORATOR));
    });

    it('does not let another window borrow a trusted base for restored text', async () => {
        const storage = new HarnessStorage();
        const server = new DeterministicRealtimeServer();
        const sharedBase = 'center\n';
        addProject(server, sharedBase, PROJECT_A, 'Shared Path', 1);

        const trustedWindow = createHarness(server, storage, 'window-a', PROJECT_A);
        assert.equal(await openAuthoritativeText(trustedWindow), sharedBase);
        server.collaboratorUpdate(PROJECT_A, [{p: sharedBase.length, i: 'A REMOTE\n'}]);

        const otherWindow = createHarness(server, storage, 'window-b', PROJECT_A);
        await openAuthoritativeText(otherWindow, false);
        const otherWindowEditor = new SimulatedDirtyEditor(otherWindow.uri, `A LOCAL DRAFT\n${sharedBase}`);
        otherWindowEditor.attach();
        const result = await otherWindowEditor.save(otherWindow.vfs);

        assert.equal(result.saved, false);
        assert.equal(otherWindowEditor.dirty, true);
        assert.equal(otherWindowEditor.document.getText(), `A LOCAL DRAFT\n${sharedBase}`);
        assert.deepEqual(server.capturedUpdates, []);
        assert.equal(server.text(PROJECT_A), `${sharedBase}A REMOTE\n`);
    });

    it('does not borrow wrong-project provenance for the same pathname and document id', async () => {
        const storage = new HarnessStorage();
        const server = new DeterministicRealtimeServer();
        const sharedBase = 'center\n';
        addProject(server, sharedBase, PROJECT_A, 'Shared Path', 1);
        addProject(server, `${sharedBase}B REMOTE\n`, PROJECT_B, 'Shared Path', 8);

        const trustedProject = createHarness(server, storage, 'window-a', PROJECT_A);
        assert.equal(await openAuthoritativeText(trustedProject), sharedBase);

        const otherProject = createHarness(server, storage, 'window-a', PROJECT_B);
        assert.equal(otherProject.uri.path, trustedProject.uri.path);
        assert.notEqual(otherProject.uri.query, trustedProject.uri.query);
        await openAuthoritativeText(otherProject, false);
        const otherProjectEditor = new SimulatedDirtyEditor(otherProject.uri, `B LOCAL DRAFT\n${sharedBase}`);
        otherProjectEditor.attach();
        const result = await otherProjectEditor.save(otherProject.vfs);

        assert.equal(result.saved, false);
        assert.equal(otherProjectEditor.dirty, true);
        assert.equal(otherProjectEditor.document.getText(), `B LOCAL DRAFT\n${sharedBase}`);
        assert.deepEqual(server.capturedUpdates, []);
        assert.equal(server.text(PROJECT_A), sharedBase);
        assert.equal(server.text(PROJECT_B), `${sharedBase}B REMOTE\n`);
    });
});
