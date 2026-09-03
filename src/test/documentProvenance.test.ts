import { strict as assert } from 'assert';
import {
    DOCUMENT_PROVENANCE_SCHEMA_VERSION,
    DocumentProvenanceIdentity,
    DocumentProvenanceStorage,
    DocumentProvenanceStore,
    JsonValue,
    sha256Text,
} from '../core/documentProvenance';

class MemoryStorage implements DocumentProvenanceStorage {
    readonly records = new Map<string, Uint8Array>();
    writeCount = 0;

    async list(): Promise<string[]> {
        return [...this.records.keys()];
    }

    async read(recordName: string): Promise<Uint8Array | undefined> {
        const content = this.records.get(recordName);
        return content ? content.slice() : undefined;
    }

    async write(recordName: string, content: Uint8Array): Promise<void> {
        this.records.set(recordName, content.slice());
        this.writeCount += 1;
    }

    async delete(recordName: string): Promise<void> {
        this.records.delete(recordName);
    }

    readJson(recordName: string): {[key: string]: unknown} {
        const content = this.records.get(recordName);
        assert.ok(content);
        return JSON.parse(new TextDecoder().decode(content)) as {[key: string]: unknown};
    }

    writeJson(recordName: string, value: {[key: string]: unknown}): void {
        this.records.set(recordName, new TextEncoder().encode(JSON.stringify(value)));
    }
}

class BlockingMemoryStorage extends MemoryStorage {
    private nextWrite?: {
        started: () => void,
        release: Promise<void>,
    };

    blockNextWrite(): {started: Promise<void>, release: () => void} {
        let markStarted!: () => void;
        let release!: () => void;
        const started = new Promise<void>(resolve => { markStarted = resolve; });
        const released = new Promise<void>(resolve => { release = resolve; });
        this.nextWrite = {started: markStarted, release: released};
        return {started, release};
    }

    async write(recordName: string, content: Uint8Array): Promise<void> {
        const blocked = this.nextWrite;
        this.nextWrite = undefined;
        if (blocked) {
            blocked.started();
            await blocked.release;
        }
        await super.write(recordName, content);
    }
}

class FailingMemoryStorage extends MemoryStorage {
    failNextWrite = false;

    async write(recordName: string, content: Uint8Array): Promise<void> {
        if (this.failNextWrite) {
            this.failNextWrite = false;
            throw new Error('injected atomic write failure');
        }
        await super.write(recordName, content);
    }
}

const baseIdentity: DocumentProvenanceIdentity = {
    canonicalServerUrl: 'https://www.overleaf.com',
    userId: 'verified-user',
    projectId: 'project-a',
    docId: 'main-doc',
    canonicalEditorUri: 'overleaf-workshop://verified-user/project-a/main-doc',
    otType: 'sharejs-text-ot',
    protocolVersion: 2,
};

const defaultBufferIncarnationId = 'buffer-a';

function createStore(storage: MemoryStorage, sessionId: string): DocumentProvenanceStore {
    let now = 1_000;
    return new DocumentProvenanceStore(storage, {
        sessionId,
        now: () => now++,
    });
}

describe('DocumentProvenanceStore', () => {
    it('recovers exactly one Unicode dirty buffer with its exact acknowledged base', async () => {
        const storage = new MemoryStorage();
        const live = createStore(storage, 'live-window');
        const baseText = 'α collaborator\n旧行';
        const dirtyText = 'α collaborator\n本地未保存 ✍️';
        const created = await live.createOrUpdateCurrent({
            identity: {...baseIdentity, canonicalServerUrl: 'https://WWW.OVERLEAF.COM/'},
            bufferIncarnationId: defaultBufferIncarnationId,
            baseVersion: 41,
            baseText,
            dirtyText,
        });

        assert.equal(created.identity.canonicalServerUrl, 'https://www.overleaf.com');
        assert.equal(created.schemaVersion, DOCUMENT_PROVENANCE_SCHEMA_VERSION);
        assert.equal(created.baseHash, sha256Text(baseText));
        assert.equal(created.dirtyHash, sha256Text(dirtyText));

        const current = await live.resolveCurrentRecord(created.recordName, {
            identity: baseIdentity,
            bufferIncarnationId: defaultBufferIncarnationId,
            baseVersion: 41,
            baseText,
            dirtyText,
        });
        assert.equal(current.kind, 'valid');

        const cold = createStore(storage, 'cold-window');
        const recovered = await cold.recoverCold(baseIdentity, dirtyText);
        assert.equal(recovered.kind, 'valid');
        if (recovered.kind === 'valid') {
            assert.equal(recovered.record.recordName, created.recordName);
            assert.equal(recovered.record.baseVersion, 41);
            assert.equal(recovered.record.baseText, baseText);
            assert.equal(recovered.record.dirtyText, dirtyText);
        }
        assert.deepEqual(await cold.recoverCold(baseIdentity, `${dirtyText}!`), {kind: 'missing'});
    });

    it('treats missing, wrong identity, and wrong protocol version as missing', async () => {
        const storage = new MemoryStorage();
        const store = createStore(storage, 'window-a');
        assert.deepEqual(await store.recoverCold(baseIdentity, 'dirty'), {kind: 'missing'});

        await store.createOrUpdateCurrent({
            identity: baseIdentity,
            bufferIncarnationId: defaultBufferIncarnationId,
            baseVersion: 1,
            baseText: 'base',
            dirtyText: 'dirty',
        });
        assert.deepEqual(await store.recoverCold(
            {...baseIdentity, userId: 'different-verified-user'},
            'dirty',
        ), {kind: 'missing'});
        assert.deepEqual(await store.recoverCold(
            {...baseIdentity, protocolVersion: 3},
            'dirty',
        ), {kind: 'missing'});
    });

    it('fails closed on unknown schemas and corrupt integrity hashes', async () => {
        const storage = new MemoryStorage();
        const store = createStore(storage, 'window-a');
        const schemaRecord = await store.createOrUpdateCurrent({
            identity: baseIdentity,
            bufferIncarnationId: defaultBufferIncarnationId,
            baseVersion: 1,
            baseText: 'base',
            dirtyText: 'dirty',
        });
        const unknownSchema = storage.readJson(schemaRecord.recordName);
        unknownSchema.schemaVersion = 99;
        storage.writeJson(schemaRecord.recordName, unknownSchema);
        assert.deepEqual(await store.recoverCold(baseIdentity, 'dirty'), {
            kind: 'invalid',
            recordName: schemaRecord.recordName,
            reason: 'unknown-schema',
        });

        const hashStorage = new MemoryStorage();
        const hashStore = createStore(hashStorage, 'window-a');
        const hashRecord = await hashStore.createOrUpdateCurrent({
            identity: baseIdentity,
            bufferIncarnationId: defaultBufferIncarnationId,
            baseVersion: 1,
            baseText: 'base',
            dirtyText: 'dirty',
        });
        const tamperedBase = hashStorage.readJson(hashRecord.recordName);
        tamperedBase.baseText = 'tampered';
        hashStorage.writeJson(hashRecord.recordName, tamperedBase);
        const invalidBase = await hashStore.resolveCurrentRecord(hashRecord.recordName, {
            identity: baseIdentity,
            bufferIncarnationId: defaultBufferIncarnationId,
        });
        assert.deepEqual(invalidBase, {
            kind: 'invalid',
            recordName: hashRecord.recordName,
            reason: 'base-hash-mismatch',
        });

        const dirtyStorage = new MemoryStorage();
        const dirtyStore = createStore(dirtyStorage, 'window-a');
        const dirtyRecord = await dirtyStore.createOrUpdateCurrent({
            identity: baseIdentity,
            bufferIncarnationId: defaultBufferIncarnationId,
            baseVersion: 1,
            baseText: 'base',
            dirtyText: 'dirty',
        });
        const tamperedDirty = dirtyStorage.readJson(dirtyRecord.recordName);
        tamperedDirty.dirtyHash = '0'.repeat(64);
        dirtyStorage.writeJson(dirtyRecord.recordName, tamperedDirty);
        const invalidDirty = await dirtyStore.recoverCold(baseIdentity, 'dirty');
        assert.deepEqual(invalidDirty, {
            kind: 'invalid',
            recordName: dirtyRecord.recordName,
            reason: 'dirty-hash-mismatch',
        });

        const jsonStorage = new MemoryStorage();
        const jsonStore = createStore(jsonStorage, 'window-a');
        const jsonRecord = await jsonStore.createOrUpdateCurrent({
            identity: baseIdentity,
            bufferIncarnationId: defaultBufferIncarnationId,
            baseVersion: 1,
            baseText: 'base',
            dirtyText: 'dirty',
        });
        jsonStorage.records.set(jsonRecord.recordName, new TextEncoder().encode('{'));
        assert.deepEqual(await jsonStore.recoverCold(baseIdentity, 'dirty'), {
            kind: 'invalid',
            recordName: jsonRecord.recordName,
            reason: 'corrupt-json',
        });
    });

    it('rejects two exact candidates restored from separate editor windows', async () => {
        const storage = new MemoryStorage();
        const first = createStore(storage, 'window-a');
        const second = createStore(storage, 'window-b');
        const dirty = 'same restored dirty text';
        const firstRecord = await first.createOrUpdateCurrent({
            identity: baseIdentity,
            bufferIncarnationId: 'window-a-buffer',
            baseVersion: 7,
            baseText: 'base',
            dirtyText: dirty,
        });
        const secondRecord = await second.createOrUpdateCurrent({
            identity: baseIdentity,
            bufferIncarnationId: 'window-b-buffer',
            baseVersion: 7,
            baseText: 'base',
            dirtyText: dirty,
        });

        const recovered = await createStore(storage, 'window-c').recoverCold(baseIdentity, dirty);
        assert.equal(recovered.kind, 'ambiguous');
        if (recovered.kind === 'ambiguous') {
            assert.deepEqual(
                new Set(recovered.recordNames),
                new Set([firstRecord.recordName, secondRecord.recordName]),
            );
        }
    });

    it('isolates two buffer incarnations in one session and cold recovery rejects ambiguity', async () => {
        const storage = new MemoryStorage();
        const live = createStore(storage, 'shared-window');
        const dirtyText = 'same text in two aliased buffers';
        const first = await live.createOrUpdateCurrent({
            identity: baseIdentity,
            bufferIncarnationId: 'buffer-one',
            baseVersion: 4,
            baseText: 'base',
            dirtyText,
        });
        const second = await live.createOrUpdateCurrent({
            identity: baseIdentity,
            bufferIncarnationId: 'buffer-two',
            baseVersion: 4,
            baseText: 'base',
            dirtyText,
        });

        assert.notEqual(first.recordName, second.recordName);
        assert.equal(first.identityHash, second.identityHash);
        assert.equal(storage.records.size, 2);
        assert.equal((await live.resolveCurrentRecord(first.recordName, {
            identity: baseIdentity,
            bufferIncarnationId: 'buffer-one',
            dirtyText,
        })).kind, 'valid');
        assert.deepEqual(await live.resolveCurrentRecord(first.recordName, {
            identity: baseIdentity,
            bufferIncarnationId: 'buffer-two',
            dirtyText,
        }), {
            kind: 'invalid',
            recordName: first.recordName,
            reason: 'not-current-session',
        });

        const recovered = await createStore(storage, 'cold-window')
            .recoverCold(baseIdentity, dirtyText);
        assert.equal(recovered.kind, 'ambiguous');
        if (recovered.kind === 'ambiguous') {
            assert.deepEqual(
                new Set(recovered.recordNames),
                new Set([first.recordName, second.recordName]),
            );
        }
    });

    it('isolates identical document ids belonging to different projects', async () => {
        const storage = new MemoryStorage();
        const store = createStore(storage, 'window-a');
        const first = await store.createOrUpdateCurrent({
            identity: baseIdentity,
            bufferIncarnationId: defaultBufferIncarnationId,
            baseVersion: 1,
            baseText: 'project A base',
            dirtyText: 'project A dirty',
        });
        const secondIdentity = {
            ...baseIdentity,
            projectId: 'project-b',
            canonicalEditorUri: 'overleaf-workshop://verified-user/project-b/main-doc',
        };
        const second = await store.createOrUpdateCurrent({
            identity: secondIdentity,
            bufferIncarnationId: 'buffer-project-b',
            baseVersion: 9,
            baseText: 'project B base',
            dirtyText: 'project B dirty',
        });

        assert.notEqual(first.recordName, second.recordName);
        const recovered = await createStore(storage, 'window-b')
            .recoverCold(secondIdentity, 'project B dirty');
        assert.equal(recovered.kind, 'valid');
        if (recovered.kind === 'valid') {
            assert.equal(recovered.record.identity.projectId, 'project-b');
            assert.equal(recovered.record.baseVersion, 9);
        }
        assert.deepEqual(
            await createStore(storage, 'window-c').recoverCold(
                secondIdentity,
                'project A dirty',
            ),
            {kind: 'missing'},
        );
    });

    it('durably round-trips pending OT payloads including unknown metadata', async () => {
        const storage = new MemoryStorage();
        const store = createStore(storage, 'window-a');
        const created = await store.createOrUpdateCurrent({
            identity: baseIdentity,
            bufferIncarnationId: defaultBufferIncarnationId,
            baseVersion: 12,
            baseText: 'abc',
            dirtyText: 'abXc',
        });
        const pending: JsonValue = {
            doc: 'main-doc',
            v: 12,
            op: [{p: 2, i: 'X', unknownOperationField: ['值', null, true]}],
            unknownTopLevel: {
                trackChanges: {author: 'verified-user', metadata: {opaque: 17}},
            },
        };
        const writesBeforeMark = storage.writeCount;
        await store.markPendingWrite(created.recordName, pending);
        assert.equal(storage.writeCount, writesBeforeMark + 1);

        const exactRetry = await store.createOrUpdateCurrent({
            identity: baseIdentity,
            bufferIncarnationId: defaultBufferIncarnationId,
            baseVersion: 12,
            baseText: 'abc',
            dirtyText: 'abXc',
        });
        assert.deepEqual(exactRetry.pendingWrite, pending);
        assert.equal(storage.writeCount, writesBeforeMark + 1);
        await assert.rejects(
            () => store.createOrUpdateCurrent({
                identity: baseIdentity,
                bufferIncarnationId: defaultBufferIncarnationId,
                baseVersion: 12,
                baseText: 'abc',
                dirtyText: 'abXYc',
            }),
            /pending-write is immutable/,
        );

        const resolved = await store.resolveCurrentRecord(created.recordName, {
            identity: baseIdentity,
            bufferIncarnationId: defaultBufferIncarnationId,
            baseVersion: 12,
            baseText: 'abc',
            dirtyText: 'abXc',
        });
        assert.equal(resolved.kind, 'valid');
        if (resolved.kind === 'valid') {
            assert.deepEqual(resolved.record.pendingWrite, pending);
        }

        const cold = await createStore(storage, 'window-b').recoverCold(baseIdentity, 'abXc');
        assert.equal(cold.kind, 'valid');
        if (cold.kind === 'valid') {
            assert.deepEqual(cold.record.pendingWrite, pending);
        }
    });

    it('updates and clears only explicitly named current-session records', async () => {
        const storage = new MemoryStorage();
        const firstStore = createStore(storage, 'window-a');
        const secondStore = createStore(storage, 'window-b');
        const first = await firstStore.createOrUpdateCurrent({
            identity: baseIdentity,
            bufferIncarnationId: defaultBufferIncarnationId,
            baseVersion: 1,
            baseText: 'base one',
            dirtyText: 'dirty one',
        });
        const second = await secondStore.createOrUpdateCurrent({
            identity: {
                ...baseIdentity,
                projectId: 'project-b',
                canonicalEditorUri: 'overleaf-workshop://verified-user/project-b/main-doc',
            },
            bufferIncarnationId: 'buffer-project-b',
            baseVersion: 2,
            baseText: 'base two',
            dirtyText: 'dirty two',
        });

        const updated = await firstStore.createOrUpdateCurrent({
            identity: baseIdentity,
            bufferIncarnationId: defaultBufferIncarnationId,
            baseVersion: 1,
            baseText: 'base one',
            dirtyText: 'dirty one updated',
        });
        assert.equal(updated.recordName, first.recordName);
        assert.ok(storage.records.has(second.recordName));
        await firstStore.flush();

        await firstStore.clearRecord(first.recordName);
        assert.equal(storage.records.has(first.recordName), false);
        assert.equal(storage.records.has(second.recordName), true);
        await assert.rejects(
            () => firstStore.markPendingWrite(second.recordName, {op: []}),
            /not-current-session/,
        );
        await assert.rejects(() => firstStore.clearRecord(''), /explicit provenance record name/);
    });

    it('atomically reconciles one exact pending intent and leaves it retryable on write failure', async () => {
        const storage = new FailingMemoryStorage();
        const store = createStore(storage, 'window-a');
        const created = await store.createOrUpdateCurrent({
            identity: baseIdentity,
            bufferIncarnationId: defaultBufferIncarnationId,
            baseVersion: 12,
            baseText: 'abc',
            dirtyText: 'abXc',
        });
        const pending: JsonValue = {state: 'submitted', doc: 'main-doc', v: 12};
        await store.markPendingWrite(created.recordName, pending);

        storage.failNextWrite = true;
        await assert.rejects(
            () => store.reconcilePendingWrite(created.recordName, pending, {
                identity: baseIdentity,
                bufferIncarnationId: defaultBufferIncarnationId,
                baseVersion: 13,
                baseText: 'abXc',
                dirtyText: 'abXYc',
            }),
            /injected atomic write failure/,
        );
        const retained = await store.resolveCurrentRecord(created.recordName, {
            identity: baseIdentity,
            bufferIncarnationId: defaultBufferIncarnationId,
            baseVersion: 12,
            baseText: 'abc',
            dirtyText: 'abXc',
        });
        assert.equal(retained.kind, 'valid');
        if (retained.kind === 'valid') {
            assert.deepEqual(retained.record.pendingWrite, pending);
        }

        await assert.rejects(
            () => store.reconcilePendingWrite(created.recordName, {state: 'wrong'}, {
                identity: baseIdentity,
                bufferIncarnationId: defaultBufferIncarnationId,
                baseVersion: 13,
                baseText: 'abXc',
                dirtyText: 'abXYc',
            }),
            /pending-write mismatch/,
        );
        const reconciled = await store.reconcilePendingWrite(created.recordName, pending, {
            identity: baseIdentity,
            bufferIncarnationId: defaultBufferIncarnationId,
            baseVersion: 13,
            baseText: 'abXc',
            dirtyText: 'abXYc',
        });
        assert.equal(reconciled.pendingWrite, undefined);
        assert.equal(reconciled.baseVersion, 13);
        assert.equal(reconciled.baseText, 'abXc');
        assert.equal(reconciled.dirtyText, 'abXYc');
    });

    it('updates post-submit dirty recovery text without mutating the pending wire intent', async () => {
        const storage = new MemoryStorage();
        const store = createStore(storage, 'window-a');
        const created = await store.createOrUpdateCurrent({
            identity: baseIdentity,
            bufferIncarnationId: defaultBufferIncarnationId,
            baseVersion: 12,
            baseText: 'abc',
            dirtyText: 'abXc',
        });
        const pending: JsonValue = {
            state: 'submitted',
            update: {v: 12, op: [{p: 2, i: 'X'}]},
        };
        await store.markPendingWrite(created.recordName, pending);

        const updated = await store.updatePendingDirtyText(
            created.recordName,
            pending,
            'abXYc',
        );
        assert.deepEqual(updated.pendingWrite, pending);
        assert.equal(updated.baseVersion, 12);
        assert.equal(updated.baseText, 'abc');
        assert.equal(updated.dirtyText, 'abXYc');
        await assert.rejects(
            () => store.updatePendingDirtyText(
                created.recordName,
                {state: 'different'},
                'should-not-commit',
            ),
            /pending-write mismatch/,
        );
        const retained = await store.resolveCurrentRecord(created.recordName, {
            identity: baseIdentity,
            bufferIncarnationId: defaultBufferIncarnationId,
            baseVersion: 12,
            baseText: 'abc',
            dirtyText: 'abXYc',
        });
        assert.equal(retained.kind, 'valid');
        if (retained.kind === 'valid') {
            assert.deepEqual(retained.record.pendingWrite, pending);
        }
    });

    it('flush waits for already queued atomic storage operations', async () => {
        const storage = new BlockingMemoryStorage();
        const store = createStore(storage, 'window-a');
        const block = storage.blockNextWrite();
        const update = store.createOrUpdateCurrent({
            identity: baseIdentity,
            bufferIncarnationId: defaultBufferIncarnationId,
            baseVersion: 1,
            baseText: 'base',
            dirtyText: 'dirty',
        });
        await block.started;

        let flushed = false;
        const flush = store.flush().then(() => { flushed = true; });
        await Promise.resolve();
        assert.equal(flushed, false);
        block.release();
        await Promise.all([update, flush]);
        assert.equal(flushed, true);
    });
});
