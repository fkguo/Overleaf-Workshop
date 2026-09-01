import {strict as assert} from 'assert';
import {requireSavedCompileInputs} from '../compile/compileRun';
import {
    applyTextOperations,
    createAliasProviderProject,
    createEventWiredProviderProject,
    createVirtualProject,
    DeterministicRealtimeServer,
    HarnessStorage,
    openAuthoritativeText,
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

describe('stale-buffer rollback safety', () => {
    beforeEach(() => resetHarnessDocuments());
    after(() => resetHarnessRuntime());

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
        harness.events.queueWarningResponse(ENABLE_CLEAN_EDITOR);
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.openClean(harness.events);
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

        assert.equal(
            new TextDecoder().decode(await harness.provider.readFile(harness.uri)),
            base,
        );
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.openClean(harness.events);
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

    it('keeps a public merged save dirty until host refresh, then saves a later edit', async () => {
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
        harness.events.queueWarningResponse(ENABLE_CLEAN_EDITOR);
        const editor = new SimulatedDirtyEditor(harness.uri, base);
        editor.openClean(harness.events);
        await settleAsyncWork();
        await settleAsyncWork();

        editor.editThroughEvents(local, harness.events);
        server.collaboratorUpdate(PROJECT_A, replaceAt(base, 'RIGHT', 'REMOTE'));
        const mergedSave = await editor.saveThroughProvider(harness.provider, harness.events);
        assert.equal(mergedSave.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), local);
        assert.equal(server.text(PROJECT_A), merged);
        assert.equal(server.capturedUpdates.length, 1);

        await editor.reloadAuthoritative(harness.vfs, merged);
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

        assert.equal(
            new TextDecoder().decode(await harness.provider.readFile(harness.uri)),
            advanced,
        );
        const confirmation = harness.events.deferWarningResponse();
        const editor = new SimulatedDirtyEditor(harness.uri, advanced);
        editor.openClean(harness.events);
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
            harness.events.queueWarningResponse(ENABLE_CLEAN_EDITOR);
            const editor = new SimulatedDirtyEditor(harness.uri, base);
            editor.openClean(harness.events);
            await settleAsyncWork();
            await settleAsyncWork();
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
        harness.events.queueWarningResponse(ENABLE_CLEAN_EDITOR);
        const aliasA = new SimulatedDirtyEditor(harness.encodedUri, base);
        aliasA.openClean(harness.events);
        await settleAsyncWork();
        await settleAsyncWork();

        assert.equal(
            new TextDecoder().decode(await harness.provider.readFile(harness.reorderedUri)),
            base,
        );
        const aliasBConfirmation = harness.events.deferWarningResponse();
        const aliasB = new SimulatedDirtyEditor(harness.reorderedUri, base);
        aliasB.openClean(harness.events);

        aliasA.editThroughEvents(aliasAContent, harness.events);
        const aliasASave = await aliasA.saveThroughProvider(harness.provider, harness.events);
        assert.equal(aliasASave.saved, true);
        assert.equal(server.text(PROJECT_A), aliasAContent);
        aliasA.closeThroughEvents(harness.events);

        server.collaboratorUpdate(
            PROJECT_A,
            replaceAt(aliasAContent, 'RIGHT', 'REMOTE'),
        );
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

    it('creates a genuinely new text document from an exact public save intent', async () => {
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

        const created = await editor.saveThroughProvider(
            harness.provider,
            harness.events,
            {create: true, overwrite: false},
        );

        assert.equal(created.saved, true);
        assert.equal(editor.dirty, false);
        assert.equal(server.documentCreationCount, 1);
        assert.equal(server.addDocCallCount, 1);
        assert.equal(server.uploadFileCallCount, 0, 'safe text creation must never use upload upsert');
        assert.equal(server.projectEntitiesReadCount, 2, 'creation requires fresh pre/post path checks');
        assert.equal(server.documentByName(PROJECT_A, 'new.tex')?.content, 'new text');
        assert.equal(server.capturedUpdates.length, 1, 'initial bytes must be revision-bound OT');

        editor.editThroughEvents('new text + later edit', harness.events);
        const updated = await editor.saveThroughProvider(harness.provider, harness.events);
        assert.equal(updated.saved, true);
        assert.equal(server.capturedUpdates.length, 2);
        assert.equal(
            server.documentByName(PROJECT_A, 'new.tex')?.content,
            'new text + later edit',
        );
        harness.dispose();
    });

    it('keeps collaborator bytes when the new empty base advances before initial OT', async () => {
        const server = new DeterministicRealtimeServer();
        addProject(server, 'existing', PROJECT_A, 'Public New Document Advanced', 3);
        const harness = await createEventWiredProviderProject({
            server,
            storage: new HarnessStorage(),
            windowId: 'public-new-document-advanced',
            projectId: PROJECT_A,
        });
        await harness.vfs.init();
        const newUri = harness.uri.with({path: '/Public New Document Advanced/new.tex'});
        const editor = new SimulatedDirtyEditor(newUri, 'local initial text');
        editor.attach();
        harness.events.queueWarningResponse(CREATE_NEW_DOCUMENT);
        const verifyCreated = harness.vfs.verifyFreshCreatedDocumentPath.bind(harness.vfs);
        harness.vfs.verifyFreshCreatedDocumentPath = async (...args: unknown[]) => {
            await verifyCreated(...args);
            const created = server.documentByName(PROJECT_A, 'new.tex');
            assert.ok(created);
            server.collaboratorUpdate(
                PROJECT_A,
                [{p: 0, i: 'collaborator text'}],
                created.id,
            );
        };

        const result = await editor.saveThroughProvider(
            harness.provider,
            harness.events,
            {create: true, overwrite: false},
        );

        assert.equal(result.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), 'local initial text');
        assert.equal(server.documentCreationCount, 1);
        assert.equal(server.addDocCallCount, 1);
        assert.equal(server.uploadFileCallCount, 0);
        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.documentByName(PROJECT_A, 'new.tex')?.content, 'collaborator text');
        harness.dispose();
    });

    it('serializes a second onWillSave through the real create and initial-OT flow', async () => {
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
        harness.events.queueWarningResponse(CREATE_NEW_DOCUMENT);
        server.holdNextApplicationAfterAck();

        harness.events.fireWillSave(editor.document);
        const first = harness.provider.writeFile(
            newUri,
            new TextEncoder().encode('first text'),
            {create: true, overwrite: false},
        );
        for (let attempt = 0; attempt < 20 && server.capturedUpdates.length === 0; attempt += 1) {
            await settleAsyncWork();
        }
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.documentByName(PROJECT_A, 'new.tex')?.content, '');

        editor.editThroughEvents('second text', harness.events);
        harness.events.fireWillSave(editor.document);
        const second = harness.provider.writeFile(
            newUri,
            new TextEncoder().encode('second text'),
            {create: true, overwrite: true},
        );
        await settleAsyncWork();
        assert.equal(
            server.capturedUpdates.length,
            1,
            'the doc-key follow-up must remain behind the path-key creation',
        );

        server.releaseHeldApplication();
        await first;
        await second;
        editor.dirty = false;
        harness.events.fireDidSave(editor.document);

        assert.equal(server.documentCreationCount, 1);
        assert.equal(server.addDocCallCount, 1);
        assert.equal(server.uploadFileCallCount, 0);
        assert.equal(server.capturedUpdates.length, 2);
        assert.equal(server.logicalApplyCount, 2);
        assert.equal(server.documentByName(PROJECT_A, 'new.tex')?.content, 'second text');
        const bufferId = harness.vfs.editorBufferIds.get(editor.document);
        assert.equal(harness.vfs.activeEditorBases.get(bufferId)?.content, 'second text');
        harness.dispose();
    });

    it('deduplicates an outcome-unknown initial OT after atomic text creation', async () => {
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
        harness.events.queueWarningResponse(CREATE_NEW_DOCUMENT);
        server.loseNextAckAfterCommit();

        const uncertain = await editor.saveThroughProvider(
            harness.provider,
            harness.events,
            {create: true, overwrite: false},
        );

        assert.equal(uncertain.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), 'new text');
        assert.equal(server.documentCreationCount, 1);
        assert.equal(server.addDocCallCount, 1);
        assert.equal(server.uploadFileCallCount, 0);
        assert.equal(server.logicalApplyCount, 1);
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.documentByName(PROJECT_A, 'new.tex')?.content, 'new text');

        await settleAsyncWork();
        await settleAsyncWork();
        const recovered = await editor.saveThroughProvider(
            harness.provider,
            harness.events,
            {create: true, overwrite: true},
        );

        assert.equal(recovered.saved, true);
        assert.equal(editor.dirty, false);
        assert.equal(server.documentCreationCount, 1, 'retry must not create a second document');
        assert.equal(server.addDocCallCount, 1);
        assert.equal(server.logicalApplyCount, 1, 'deduplicated retry must not apply twice');
        assert.equal(server.capturedUpdates.length, 2);
        assert.equal(server.senderConfirmationCount, 1);
        const [initial, retry] = server.capturedUpdates;
        assert.equal(retry.update.v, initial.update.v);
        assert.deepEqual(retry.update.op, initial.update.op);
        assert.deepEqual(retry.update.dupIfSource, [initial.publicId]);
        assert.equal(server.documentByName(PROJECT_A, 'new.tex')?.content, 'new text');
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

    it('does not create over a path that appears after fresh preflight but before atomic addDoc', async () => {
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
        harness.events.queueWarningResponse(CREATE_NEW_DOCUMENT);
        const verifyMissing = harness.vfs.verifyFreshMissingPath.bind(harness.vfs);
        let absenceChecks = 0;
        harness.vfs.verifyFreshMissingPath = async (...args: unknown[]) => {
            absenceChecks += 1;
            await verifyMissing(...args);
            if (absenceChecks === 1) {
                const competing = server.createDocument(
                    PROJECT_A,
                    `${PROJECT_A}-root`,
                    'race.tex',
                    'collaborator bytes',
                );
                assert.equal(competing.type, 'success');
            }
        };

        const result = await editor.saveThroughProvider(
            harness.provider,
            harness.events,
            {create: true, overwrite: false},
        );

        assert.equal(result.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), 'local race text');
        assert.equal(absenceChecks, 1, 'the HTTP preflight is diagnostic; addDoc closes the race');
        assert.equal(server.projectEntitiesReadCount, 1);
        assert.equal(server.addDocCallCount, 1, 'the competing name must be rejected at addDoc');
        assert.equal(server.uploadFileCallCount, 0);
        assert.equal(server.documentCreationCount, 1, 'only the competing creator may run');
        assert.equal(server.documentByName(PROJECT_A, 'race.tex')?.content, 'collaborator bytes');
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
        const editor = new SimulatedDirtyEditor(harness.uri, local);
        editor.attach();
        await editor.confirmStagedBase(harness.vfs, base);
        server.collaboratorUpdate(PROJECT_A, [
            ...replaceAt(base, 'RIGHT', 'REMOTE'),
        ]);
        server.collaboratorUpdate(
            PROJECT_A,
            replaceAt('LEFT middle REMOTE', 'LEFT', 'LOCAL'),
        );

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

    it('retains the recovery-save causal base when remote advances strictly afterward', async () => {
        const base = 'LEFT middle RIGHT';
        const local = 'LOCAL middle RIGHT';
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
        assert.equal(server.text(PROJECT_A), remote);
        assert.equal(server.version(PROJECT_A), 5);
        assert.equal(editor.dirty, false);
        assert.equal(editor.document.getText(), base);
        assert.equal(await harness.vfs.confirmEditorBase(editor.document), false);
        assert.strictEqual(harness.vfs.activeEditorBases.get(bufferId), linearizedBase);

        editor.edit(local);
        const laterSave = await editor.save(harness.vfs);

        assert.equal(laterSave.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), local);
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

    it('merges non-overlapping edits, keeps the stale host dirty, and supports a refreshed second save', async () => {
        const base = 'LEFT middle RIGHT';
        const local = 'LOCAL middle RIGHT';
        const expected = 'LOCAL middle REMOTE';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Nonoverlap', 2);
        const harness = createHarness(server);
        assert.equal(await openAuthoritativeText(harness), base);
        const editor = new SimulatedDirtyEditor(harness.uri, local);
        editor.attach();
        await editor.confirmStagedBase(harness.vfs, base);

        server.collaboratorUpdate(PROJECT_A, replaceAt(base, 'RIGHT', 'REMOTE'));
        const remoteBeforeSave = server.text(PROJECT_A);
        const result = await editor.save(harness.vfs);

        assert.equal(result.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), local);
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(
            applyTextOperations(remoteBeforeSave, server.capturedUpdates[0].update.op),
            expected,
        );
        assert.equal(server.text(PROJECT_A), expected);
        assert.match(server.text(PROJECT_A), /LOCAL/);
        assert.match(server.text(PROJECT_A), /REMOTE/);

        await editor.reloadAuthoritative(harness.vfs, expected);
        const followUp = `${expected} NEXT`;
        editor.edit(followUp);
        assert.equal((await editor.save(harness.vfs)).saved, true);
        assert.equal(server.capturedUpdates.length, 2);
        assert.equal(server.text(PROJECT_A), followUp);
    });

    it('preserves post-base remote edits for manual, autosave, and compile saveAll writes', async () => {
        for (const trigger of ['manual', 'auto', 'compile-save-all'] as const) {
            const base = `HEAD-${trigger} middle TAIL-${trigger}`;
            const local = `LOCAL-${trigger} middle TAIL-${trigger}`;
            const expected = `LOCAL-${trigger} middle REMOTE-${trigger}`;
            const server = new DeterministicRealtimeServer();
            addProject(server, base, PROJECT_A, `Save ${trigger}`, 20);
            const harness = createHarness(server, new HarnessStorage(), `window-${trigger}`);
            assert.equal(await openAuthoritativeText(harness), base);
            const editor = new SimulatedDirtyEditor(harness.uri, local);
            editor.attach();
            await editor.confirmStagedBase(harness.vfs, base);

            server.collaboratorUpdate(
                PROJECT_A,
                replaceAt(base, `TAIL-${trigger}`, `REMOTE-${trigger}`),
            );
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
                assert.throws(() => requireSavedCompileInputs(saved), /could not be saved safely/);
                if (saved) { compileCalls += 1; }
                result = {saved};
                assert.equal(host.saveAllCalls, 1);
                assert.equal(compileCalls, 0, 'compile must not start while the host lacks merged text');
            }

            assert.equal(result.saved, false, trigger);
            assert.equal(editor.dirty, true, trigger);
            assert.equal(editor.document.getText(), local, trigger);
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

    it('rejects overlapping collaborator and local edits without emitting OT', async () => {
        const base = 'same line\n';
        const local = 'local line\n';
        const remote = 'remote line\n';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Overlap', 3);
        const harness = createHarness(server);
        assert.equal(await openAuthoritativeText(harness), base);
        const editor = new SimulatedDirtyEditor(harness.uri, local);
        editor.attach();
        await editor.confirmStagedBase(harness.vfs, base);

        server.collaboratorUpdate(PROJECT_A, replaceAt(base, 'same', 'remote'));
        const result = await editor.save(harness.vfs);

        assert.equal(result.saved, false);
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), local);
        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.text(PROJECT_A), remote);
    });

    it('retains a trusted base across disconnect and merges after rejoin', async () => {
        const base = 'alpha middle omega';
        const local = 'ALPHA middle omega';
        const expected = 'ALPHA middle OMEGA';
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
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(server.text(PROJECT_A), expected);
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

        assert.equal(result.saved, false, 'the host lacks the collaborator prefix and must remain dirty');
        assert.match(
            String(result.error),
            /remote save was confirmed with collaborator text absent from this editor/i,
        );
        assert.equal(editor.dirty, true);
        assert.equal(editor.document.getText(), desired);
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
                baseVersion: 9,
                baseText: base,
                dirtyText: desired,
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

        const saving = editor.save(harness.vfs);
        await settleAsyncWork();
        assert.equal(server.logicalApplyCount, 0);
        harness.socket.emitAnonymousSenderConfirmation('same-doc-id', 9);
        const result = await saving;

        assert.equal(result.saved, false, 'an anonymous confirmation must not complete the save');
        assert.equal(editor.dirty, true);
        assert.equal(server.logicalApplyCount, 0);
        assert.equal(server.text(PROJECT_A), base);
        server.releaseHeldApplication();
        await settleAsyncWork();
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
        const observerEditor = new SimulatedDirtyEditor(observer.uri, base);
        observerEditor.attach();
        await observerEditor.confirmStagedBase(observer.vfs, base);
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
        observerEditor.edit(`${COLLABORATOR}:Y${base}`);
        assert.equal((await observerEditor.save(observer.vfs)).saved, false);
        assert.equal(observerEditor.dirty, true);
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
        rightEditor.hideFromCurrentWindow();

        const projectB = createHarness(server, storage, 'window-left', PROJECT_B);
        assert.equal(projectB.uri.path, leftWindow.uri.path);
        assert.notEqual(projectB.uri.query, leftWindow.uri.query);
        assert.equal(await openAuthoritativeText(projectB), 'project b');
        const projectBEditor = new SimulatedDirtyEditor(projectB.uri, 'PROJECT B');
        projectBEditor.attach();
        await projectBEditor.confirmStagedBase(projectB.vfs, 'project b');
        assert.equal((await projectBEditor.save(projectB.vfs)).saved, true);

        assert.equal(server.text(PROJECT_A), 'LEFT middle RIGHT');
        assert.equal(server.text(PROJECT_B), 'PROJECT B');
        assert.deepEqual(
            server.capturedUpdates.map(update => update.projectId),
            [PROJECT_A, PROJECT_A, PROJECT_B],
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
