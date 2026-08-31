import {strict as assert} from 'assert';
import {
    applyTextOperations,
    createVirtualProject,
    DeterministicRealtimeServer,
    HarnessStorage,
    openAuthoritativeText,
    resetHarnessDocuments,
    resetHarnessRuntime,
    settleAsyncWork,
    SimulatedDirtyEditor,
    TextOperation,
    VirtualProjectHarness,
} from './fixtures/staleBufferRealtimeHarness';

const PROJECT_A = 'project-a';
const PROJECT_B = 'project-b';
const OWN_CONFIRMED = 'OWN_CONFIRMED';
const COLLABORATOR = 'COLLABORATOR';

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

    it('fails closed when hot exit saves a stale dirty buffer with no trusted base', async () => {
        const advanced = `base\n${OWN_CONFIRMED}\n${COLLABORATOR}\n`;
        const restored = 'base\nLOCAL_DRAFT\n';
        const server = new DeterministicRealtimeServer();
        addProject(server, advanced, PROJECT_A, 'Hot Exit', 12);
        const harness = createHarness(server);
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

        assert.equal(await openAuthoritativeText(harness), advanced);
        const editor = new SimulatedDirtyEditor(harness.uri, restored);
        editor.attach();
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
        assert.equal((await confirmedEditor.save(originalSession.vfs)).saved, true);
        assert.equal(server.logicalApplyCount, 1);
        const confirmedSource = server.capturedUpdates[0].publicId;
        resetHarnessDocuments();
        originalSession.vfs.dispose();

        server.collaboratorUpdate(PROJECT_A, [{p: confirmed.length, i: `${COLLABORATOR}\n`}]);
        const advanced = `${confirmed}${COLLABORATOR}\n`;
        const versionBeforeRestore = server.version(PROJECT_A);
        const packetsBeforeRestore = server.capturedUpdates.length;
        const restarted = createHarness(server, storage, 'owner-window');
        assert.notEqual(restarted.socket.publicId, confirmedSource);
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
        const editor = new SimulatedDirtyEditor(harness.uri, content);
        editor.attach();

        const result = await editor.save(harness.vfs);

        assert.equal(result.saved, true);
        assert.equal(editor.dirty, false);
        assert.equal(server.capturedUpdates.length, 0);
        assert.equal(server.text(PROJECT_A), content);
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

        const result = await editor.save(harness.vfs);

        assert.equal(result.saved, true);
        assert.equal(server.capturedUpdates.length, 1);
        const sent = server.capturedUpdates[0].update;
        assert.equal(sent.v, 4);
        assert.equal(applyTextOperations(base, sent.op), desired);
        assert.equal(server.text(PROJECT_A), desired);
        assert.equal(server.logicalApplyCount, 1);
    });

    it('merges non-overlapping collaborator and local edits from a trusted base', async () => {
        const base = 'LEFT middle RIGHT';
        const local = 'LOCAL middle RIGHT';
        const expected = 'LOCAL middle REMOTE';
        const server = new DeterministicRealtimeServer();
        addProject(server, base, PROJECT_A, 'Nonoverlap', 2);
        const harness = createHarness(server);
        assert.equal(await openAuthoritativeText(harness), base);
        const editor = new SimulatedDirtyEditor(harness.uri, local);
        editor.attach();

        server.collaboratorUpdate(PROJECT_A, replaceAt(base, 'RIGHT', 'REMOTE'));
        const remoteBeforeSave = server.text(PROJECT_A);
        const result = await editor.save(harness.vfs);

        assert.equal(result.saved, true);
        assert.equal(server.capturedUpdates.length, 1);
        assert.equal(
            applyTextOperations(remoteBeforeSave, server.capturedUpdates[0].update.op),
            expected,
        );
        assert.equal(server.text(PROJECT_A), expected);
        assert.match(server.text(PROJECT_A), /LOCAL/);
        assert.match(server.text(PROJECT_A), /REMOTE/);
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

        const firstPublicId = harness.socket.publicId;
        harness.socket.disconnect();
        server.collaboratorUpdate(PROJECT_A, replaceAt(base, 'omega', 'OMEGA'));
        await harness.vfs.init();
        await settleAsyncWork();
        const result = await editor.save(harness.vfs);

        assert.equal(result.saved, true);
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

        const observerEditor = new SimulatedDirtyEditor(observer.uri, `Y${base}`);
        observerEditor.attach();
        assert.equal((await observerEditor.save(observer.vfs)).saved, true);
        assert.equal(server.text(PROJECT_A), `Y${desired}`);

        await harness.vfs.init();
        await settleAsyncWork();
        const recovered = await editor.save(harness.vfs);

        assert.equal(recovered.saved, true);
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
        assert.equal(server.text(PROJECT_A), `Y${desired}`);
        assert.match(server.text(PROJECT_A), new RegExp(OWN_CONFIRMED));
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

        assert.equal((await leftEditor.save(leftWindow.vfs)).saved, true);
        assert.equal((await rightEditor.save(rightWindow.vfs)).saved, true);

        const projectB = createHarness(server, storage, 'window-left', PROJECT_B);
        assert.equal(projectB.uri.path, leftWindow.uri.path);
        assert.notEqual(projectB.uri.query, leftWindow.uri.query);
        assert.equal(await openAuthoritativeText(projectB), 'project b');
        const projectBEditor = new SimulatedDirtyEditor(projectB.uri, 'PROJECT B');
        projectBEditor.attach();
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

    it('does not let another window borrow a trusted base for restored text', async () => {
        const storage = new HarnessStorage();
        const server = new DeterministicRealtimeServer();
        const sharedBase = 'center\n';
        addProject(server, sharedBase, PROJECT_A, 'Shared Path', 1);

        const trustedWindow = createHarness(server, storage, 'window-a', PROJECT_A);
        assert.equal(await openAuthoritativeText(trustedWindow), sharedBase);
        server.collaboratorUpdate(PROJECT_A, [{p: sharedBase.length, i: 'A REMOTE\n'}]);

        const otherWindow = createHarness(server, storage, 'window-b', PROJECT_A);
        const otherWindowEditor = new SimulatedDirtyEditor(otherWindow.uri, `A LOCAL DRAFT\n${sharedBase}`);
        otherWindowEditor.attach();
        const result = await otherWindowEditor.save(otherWindow.vfs);

        assert.equal(result.saved, false);
        assert.equal(otherWindowEditor.dirty, true);
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
        const otherProjectEditor = new SimulatedDirtyEditor(otherProject.uri, `B LOCAL DRAFT\n${sharedBase}`);
        otherProjectEditor.attach();
        const result = await otherProjectEditor.save(otherProject.vfs);

        assert.equal(result.saved, false);
        assert.equal(otherProjectEditor.dirty, true);
        assert.deepEqual(server.capturedUpdates, []);
        assert.equal(server.text(PROJECT_A), sharedBase);
        assert.equal(server.text(PROJECT_B), `${sharedBase}B REMOTE\n`);
    });
});
