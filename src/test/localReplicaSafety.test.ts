/* eslint-disable @typescript-eslint/naming-convention */
import { strict as assert } from 'assert';
import {
    applyReplicaMutationWithoutOverwrite,
    completeInitialReplicaSync,
    finishInitialReplicaActivation,
    incomingReplicaFileName,
    publishPreparedReplicaFile,
    ReplicaPathOperationQueue,
    replicaTempFileName,
    reconcileReplicaContents,
    reconcileReplicaDirectory,
    writeWitnessedReplicaText,
} from '../scm/localReplicaSafety';

const encode = (content: string) => new TextEncoder().encode(content);
const decode = (content: Uint8Array) => new TextDecoder().decode(content);

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>(resolver => { resolve = resolver; });
    return {promise, resolve};
}

describe('reconcileReplicaContents', () => {
    it('does not overwrite an existing local file without a trusted base', () => {
        const result = reconcileReplicaContents(undefined, encode('offline local'), encode('remote'));
        assert.deepEqual(result, {kind: 'conflict', reason: 'missing-base'});
    });

    it('fails closed for a stale local file after a remote deletion and restart', () => {
        assert.deepEqual(
            reconcileReplicaContents(undefined, encode('stale local'), undefined),
            {kind: 'conflict', reason: 'missing-base'},
        );
    });

    it('fails closed for a stale remote file after a local deletion and restart', () => {
        assert.deepEqual(
            reconcileReplicaContents(undefined, undefined, encode('stale remote')),
            {kind: 'conflict', reason: 'missing-base'},
        );
    });

    it('hydrates only remote files during an explicitly proven first bootstrap', () => {
        assert.equal(
            reconcileReplicaContents(
                undefined,
                undefined,
                encode('remote'),
                {allowRemoteHydration: true},
            ).kind,
            'write-local',
        );
        assert.deepEqual(
            reconcileReplicaContents(
                undefined,
                encode('local'),
                undefined,
                {allowRemoteHydration: true},
            ),
            {kind: 'conflict', reason: 'missing-base'},
        );
    });

    it('establishes a base when both existing copies are identical', () => {
        const result = reconcileReplicaContents(undefined, encode('same'), encode('same'));
        assert.equal(result.kind, 'unchanged');
        if (result.kind === 'unchanged') {
            assert.equal(decode(result.content), 'same');
        }
    });

    it('propagates a change made on only one side', () => {
        const base = encode('base');
        assert.equal(reconcileReplicaContents(base, base, encode('remote')).kind, 'write-local');
        assert.equal(reconcileReplicaContents(base, encode('local'), base).kind, 'write-remote');
    });

    it('merges changes that modify disjoint base ranges', () => {
        const result = reconcileReplicaContents(
            encode('alpha middle omega'),
            encode('ALPHA middle omega'),
            encode('alpha middle OMEGA'),
        );
        assert.equal(result.kind, 'write-both');
        if (result.kind === 'write-both') {
            assert.equal(decode(result.content), 'ALPHA middle OMEGA');
        }
    });

    it('rejects overlapping edits instead of applying a fuzzy patch', () => {
        const result = reconcileReplicaContents(
            encode('same line\n'),
            encode('local line\n'),
            encode('remote line\n'),
        );
        assert.deepEqual(result, {kind: 'conflict', reason: 'overlapping-change'});
    });

    it('rejects concurrent binary changes', () => {
        const result = reconcileReplicaContents(
            new Uint8Array([0xff, 0]),
            new Uint8Array([0xff, 1]),
            new Uint8Array([0xff, 2]),
        );
        assert.deepEqual(result, {kind: 'conflict', reason: 'binary-change'});
    });

    it('propagates a deletion only when the surviving copy still matches the base', () => {
        const base = encode('base');
        assert.deepEqual(reconcileReplicaContents(base, undefined, base), {kind: 'delete-remote'});
        assert.deepEqual(reconcileReplicaContents(base, base, undefined), {kind: 'delete-local'});
        assert.deepEqual(
            reconcileReplicaContents(base, undefined, encode('remote edit')),
            {kind: 'conflict', reason: 'delete-vs-edit'},
        );
        assert.deepEqual(
            reconcileReplicaContents(base, encode('local edit'), undefined),
            {kind: 'conflict', reason: 'delete-vs-edit'},
        );
    });
});

describe('reconcileReplicaDirectory', () => {
    it('fails closed for one-sided directories after restart', () => {
        assert.deepEqual(
            reconcileReplicaDirectory(true, false),
            {kind: 'conflict', reason: 'missing-base'},
        );
        assert.deepEqual(
            reconcileReplicaDirectory(false, true),
            {kind: 'conflict', reason: 'missing-base'},
        );
    });

    it('hydrates only a remote directory during first bootstrap', () => {
        assert.deepEqual(
            reconcileReplicaDirectory(false, true, {allowRemoteHydration: true}),
            {kind: 'create-local'},
        );
        assert.deepEqual(
            reconcileReplicaDirectory(true, false, {allowRemoteHydration: true}),
            {kind: 'conflict', reason: 'missing-base'},
        );
        assert.deepEqual(reconcileReplicaDirectory(true, true), {kind: 'unchanged'});
    });
});

describe('completeInitialReplicaSync', () => {
    it('disposes provisional watchers and skips replay when synchronization is cancelled', async () => {
        let disposed = false;
        let replayed = false;
        await assert.rejects(() => completeInitialReplicaSync(
            async () => undefined,
            () => { disposed = true; },
            async () => { replayed = true; },
        ), /did not complete/);
        assert.equal(disposed, true);
        assert.equal(replayed, false);
    });

    it('disposes provisional watchers and skips replay when synchronization reports conflicts', async () => {
        let disposed = false;
        let replayed = false;
        await assert.rejects(() => completeInitialReplicaSync(
            async () => false,
            () => { disposed = true; },
            async () => { replayed = true; },
        ), /did not complete/);
        assert.equal(disposed, true);
        assert.equal(replayed, false);
    });

    it('disposes provisional watchers and skips replay when synchronization throws', async () => {
        const failure = new Error('read failed');
        let disposed = false;
        let replayed = false;
        await assert.rejects(() => completeInitialReplicaSync(
            async () => { throw failure; },
            () => { disposed = true; },
            async () => { replayed = true; },
        ), error => error === failure);
        assert.equal(disposed, true);
        assert.equal(replayed, false);
    });

    it('disposes provisional watchers when queued-event reconciliation fails', async () => {
        const failure = new Error('queued event failed');
        let disposed = false;
        await assert.rejects(() => completeInitialReplicaSync(
            async () => true,
            () => { disposed = true; },
            async () => { throw failure; },
        ), error => error === failure);
        assert.equal(disposed, true);
    });

    it('replays queued events only after synchronization completes', async () => {
        let disposed = false;
        let replayed = false;
        await completeInitialReplicaSync(
            async () => true,
            () => { disposed = true; },
            async () => { replayed = true; },
        );
        assert.equal(disposed, false);
        assert.equal(replayed, true);
    });
});

describe('finishInitialReplicaActivation', () => {
    it('does not lose watcher events delivered during settings persistence', async () => {
        const settingsWrite = deferred<void>();
        const queuedEvents: Array<() => Promise<void>> = [];
        const applied: string[] = [];
        let active = false;
        const activation = finishInitialReplicaActivation(
            async () => { await settingsWrite.promise; },
            queuedEvents,
            () => { active = true; },
        );

        queuedEvents.push(async () => {
            applied.push('during-settings');
            queuedEvents.push(async () => { applied.push('during-replay'); });
        });
        settingsWrite.resolve();
        await activation;

        assert.equal(active, true);
        assert.deepEqual(applied, ['during-settings', 'during-replay']);
        assert.equal(queuedEvents.length, 0);
    });
});

describe('writeWitnessedReplicaText', () => {
    it('pushes an unchanged remote base through one provider write and reads it back', async () => {
        const events: string[] = [];
        let remote = encode('base');
        const result = await writeWitnessedReplicaText(remote, encode('local'), {
            write: async content => {
                events.push('write');
                remote = new Uint8Array(content);
            },
            readBack: async () => {
                events.push('read-back');
                return remote;
            },
        });
        assert.deepEqual(events, ['write', 'read-back']);
        assert.equal(decode(result), 'local');
    });

    it('returns a provider-rebased disjoint collaborator update', async () => {
        let remote = encode('alpha middle omega');
        const result = await writeWitnessedReplicaText(remote, encode('ALPHA middle omega'), {
            write: async () => {
                // Model the provider transforming the local prefix edit over a
                // collaborator suffix edit which arrived after the witness.
                remote = encode('ALPHA middle OMEGA');
            },
            readBack: async () => remote,
        });
        assert.equal(decode(result), 'ALPHA middle OMEGA');
    });

    it('propagates an overlapping provider conflict without a read-back', async () => {
        let readBack = false;
        await assert.rejects(() => writeWitnessedReplicaText(
            encode('same line\n'),
            encode('local line\n'),
            {
                write: async () => { throw new Error('causal-conflict'); },
                readBack: async () => {
                    readBack = true;
                    return encode('remote line\n');
                },
            },
        ), /causal-conflict/);
        assert.equal(readBack, false);
    });

    it('does not call the provider without an exact remote read witness', async () => {
        let writes = 0;
        await assert.rejects(() => writeWitnessedReplicaText(
            undefined,
            encode('local'),
            {
                write: async () => { writes += 1; },
                readBack: async () => encode('remote'),
            },
        ), /exact read witness/);
        assert.equal(writes, 0);
    });

    it('does not reinterpret binary content as a conditionally writable text document', async () => {
        let writes = 0;
        await assert.rejects(() => writeWitnessedReplicaText(
            new Uint8Array([0xff]),
            new Uint8Array([0xfe]),
            {
                write: async () => { writes += 1; },
                readBack: async () => new Uint8Array([0xfd]),
            },
        ), /non-UTF-8/);
        assert.equal(writes, 0);
    });
});

describe('local replica write-back races', () => {
    it('preserves a B-to-C local save while a remote push and read-back are pending', async () => {
        let local: Uint8Array | undefined = encode('B');
        let remote = encode('A');
        const remoteWrite = deferred<void>();
        const remoteReadBack = deferred<void>();

        const push = writeWitnessedReplicaText(remote, encode('B'), {
            write: async content => {
                await remoteWrite.promise;
                remote = encode(`${decode(content)}+collaborator`);
            },
            readBack: async () => {
                await remoteReadBack.promise;
                return remote;
            },
        });
        local = encode('C');
        remoteWrite.resolve();
        remoteReadBack.resolve();
        const authoritative = await push;

        let createCalls = 0;
        const applied = await applyReplicaMutationWithoutOverwrite(encode('B'), authoritative, {
            create: async () => { createCalls += 1; return false; },
        });
        assert.equal(applied, false);
        assert.equal(createCalls, 0);
        assert.equal(decode(local!), 'C');
        assert.equal(decode(authoritative), 'B+collaborator');
    });

    it('preserves a local save that lands while a remote pull is being read', async () => {
        let local: Uint8Array | undefined = encode('B');
        const capturedLocal = new Uint8Array(local);
        const remoteRead = deferred<Uint8Array>();

        const pull = (async () => {
            const remote = await remoteRead.promise;
            return applyReplicaMutationWithoutOverwrite(capturedLocal, remote, {
                create: async () => { throw new Error('must not overwrite an existing file'); },
            });
        })();
        local = encode('C');
        remoteRead.resolve(encode('remote'));

        assert.equal(await pull, false);
        assert.equal(decode(local!), 'C');
    });

    it('has no read-to-write gap which can overwrite an external save', async () => {
        let local = encode('A');
        let overwriteCalls = 0;
        const result = applyReplicaMutationWithoutOverwrite(encode('A'), encode('REMOTE'), {
            create: async content => {
                overwriteCalls += 1;
                local = new Uint8Array(content);
                return true;
            },
        });
        await Promise.resolve();
        local = encode('C');

        assert.equal(await result, false);
        assert.equal(overwriteCalls, 0);
        assert.equal(decode(local), 'C');
    });

    it('loses an initial-hydration race to an exclusive external create', async () => {
        let local: Uint8Array | undefined;
        const enterCreate = deferred<void>();
        const releaseCreate = deferred<void>();
        const hydration = applyReplicaMutationWithoutOverwrite(undefined, encode('REMOTE'), {
            create: async content => {
                enterCreate.resolve();
                await releaseCreate.promise;
                if (local !== undefined) { return false; }
                local = new Uint8Array(content);
                return true;
            },
        });
        await enterCreate.promise;
        local = encode('EXTERNAL');
        releaseCreate.resolve();

        assert.equal(await hydration, false);
        assert.equal(decode(local), 'EXTERNAL');
    });

    it('advances an equal common base without writing and never deletes a local file', async () => {
        let createCalls = 0;
        const local = encode('same');
        const exclusive = {create: async () => { createCalls += 1; return true; }};
        assert.equal(await applyReplicaMutationWithoutOverwrite(local, encode('same'), exclusive), true);
        assert.equal(await applyReplicaMutationWithoutOverwrite(local, undefined, exclusive), false);
        assert.equal(createCalls, 0);
    });
});

describe('incomingReplicaFileName', () => {
    it('is short, deterministic, and safe for Windows filenames', () => {
        const path = '/nested/CON:<bad>|name?*' + 'x'.repeat(300) + '.tex';
        const name = incomingReplicaFileName(path, 1_800_000_000_000, 0);
        assert.match(name, /^[A-Za-z0-9._-]+$/);
        assert.ok(name.length <= 64);
        assert.equal(name, incomingReplicaFileName(path, 1_800_000_000_000, 0));
        assert.notEqual(name, incomingReplicaFileName(path, 1_800_000_000_000, 1));
    });

    it('keeps temporary publication names short and cross-platform safe', () => {
        const name = replicaTempFileName(1_800_000_000_000, 999_999_999, 99);
        assert.match(name, /^\.owtmp-[A-Za-z0-9-]+$/);
        assert.ok(name.length <= 32);
    });
});

describe('publishPreparedReplicaFile', () => {
    it('exposes the target only after all prepared bytes are complete', async () => {
        let temporary = new Uint8Array();
        let target: Uint8Array | undefined;
        const releasePreparation = deferred<void>();
        const publication = publishPreparedReplicaFile(encode('complete'), {
            prepare: async content => {
                temporary = content.slice(0, 3);
                assert.equal(target, undefined);
                await releasePreparation.promise;
                temporary = new Uint8Array(content);
            },
            publish: async () => {
                assert.equal(decode(temporary), 'complete');
                target = new Uint8Array(temporary);
                return true;
            },
            cleanup: async () => { temporary = new Uint8Array(); },
        });
        await Promise.resolve();
        assert.equal(target, undefined);
        releasePreparation.resolve();
        assert.equal(await publication, true);
        assert.equal(decode(target!), 'complete');
    });

    it('preserves a target created externally immediately before exclusive publish', async () => {
        let temporary: Uint8Array | undefined;
        let target: Uint8Array | undefined;
        const publication = await publishPreparedReplicaFile(encode('REMOTE'), {
            prepare: async content => {
                temporary = new Uint8Array(content);
                target = encode('EXTERNAL');
            },
            publish: async () => {
                if (target !== undefined) { return false; }
                target = new Uint8Array(temporary!);
                return true;
            },
            cleanup: async () => { temporary = undefined; },
        });
        assert.equal(publication, false);
        assert.equal(decode(target!), 'EXTERNAL');
        assert.equal(temporary, undefined);
    });
});

describe('ReplicaPathOperationQueue', () => {
    it('serializes the same path while allowing another path to proceed', async () => {
        const queue = new ReplicaPathOperationQueue();
        const releaseFirst = deferred<void>();
        const events: string[] = [];

        const first = queue.run('/main.tex', async () => {
            events.push('first-start');
            await releaseFirst.promise;
            events.push('first-end');
        });
        const second = queue.run('/main.tex', async () => {
            events.push('second');
        });
        const other = queue.run('/refs.bib', async () => {
            events.push('other');
        });
        await other;
        assert.deepEqual(events, ['first-start', 'other']);

        releaseFirst.resolve();
        await Promise.all([first, second]);
        assert.deepEqual(events, ['first-start', 'other', 'first-end', 'second']);
    });
});

describe('LocalReplicaSCMProvider fail-closed integration', () => {
    interface ModuleLoader {
        _load(request: string, parent: NodeModule | null, isMain: boolean): unknown;
    }

    function loadProvider() {
        const moduleLoader = require('module') as ModuleLoader;
        const originalLoad = moduleLoader._load;
        const originalCacheKeys = new Set(Object.keys(require.cache));
        const shownErrors: string[] = [];
        const vscodeStub = {
            FileType: {File: 1, Directory: 2},
            ProgressLocation: {Notification: 1},
            ThemeIcon: class ThemeIcon { constructor(readonly id: string) {} },
            Uri: {
                joinPath: (base: any, path: string) => ({
                    scheme: base.scheme,
                    fsPath: `${base.fsPath}${path}`,
                    path: `${base.path}${path}`,
                    kind: base.kind === 'remote' ? 'remote' : 'local',
                    toString: () => `${base.scheme}:${base.path}${path}`,
                }),
            },
            l10n: {
                t: (message: string, values?: Record<string, unknown>) => message.replace(
                    /\{([^}]+)\}/g,
                    (_match, key: string) => String(values?.[key] ?? `{${key}}`),
                ),
            },
            window: {
                showErrorMessage: (message: string) => { shownErrors.push(message); },
                withProgress: async (_options: unknown, task: (progress: any, token: any) => Promise<unknown>) =>
                    task({report() {}}, {isCancellationRequested: false}),
            },
            workspace: {
                fs: {
                    stat: async (_uri: any) => ({type: 1}),
                    readFile: async (_uri: any) => encode('REMOTE'),
                    createDirectory: async (_uri: any) => undefined,
                },
            },
        };
        class BaseSCMStub {
            status: unknown;
            constructor(readonly vfs: unknown, readonly baseUri: unknown) {}
            getSetting<T>(_key: string): T | undefined { return undefined; }
        }
        moduleLoader._load = function(request, parent, isMain): unknown {
            if (request === 'vscode') { return vscodeStub; }
            if (request === '.' && parent?.filename.includes('/scm/localReplicaSCM')) {
                return {BaseSCM: BaseSCMStub};
            }
            if (request === '../core/remoteFileSystemProvider' && parent?.filename.includes('/scm/localReplicaSCM')) {
                return {parseUri: () => ({pathParts: []})};
            }
            if (request === '../utils/eventBus' && parent?.filename.includes('/scm/index')) {
                return {EventBus: {fire() {}}};
            }
            return originalLoad.call(this, request, parent, isMain);
        };
        try {
            const loaded = require('../scm/localReplicaSCM') as typeof import('../scm/localReplicaSCM');
            return {Provider: loaded.LocalReplicaSCMProvider, vscodeStub, shownErrors};
        } finally {
            moduleLoader._load = originalLoad;
            for (const cacheKey of Object.keys(require.cache)) {
                if (!originalCacheKeys.has(cacheKey)) { delete require.cache[cacheKey]; }
            }
        }
    }

    it('never treats an explicit editor save as a cached pull echo', () => {
        const {Provider} = loadProvider();
        const provider: any = Object.create(Provider.prototype);
        provider.matchIgnorePatterns = () => false;
        provider.blockedConflictPaths = new Set();
        provider.conflictMessages = new Map();
        provider.bypassCache = new Map([[
            '/main.tex',
            [{date: Date.now(), content: encode('old')}, {date: Date.now(), content: encode('old')}],
        ]]);

        assert.equal(provider.shouldBypassPush('/main.tex', encode('old'), false), false);
        assert.equal(provider.shouldBypassPush('/main.tex', encode('old'), true), true);
        assert.equal(provider.shouldBypassPush('/main.tex', encode('old'), true), false);

        provider.bypassCache = new Map([[
            '/main.tex',
            [{date: 1, content: encode('old')}, {date: 1, content: encode('old')}],
        ]]);
        assert.equal(provider.shouldBypassPush('/main.tex', encode('old'), true), false);
    });

    it('blocks the public direct-write escape hatch', async () => {
        const {Provider} = loadProvider();
        const provider: any = Object.create(Provider.prototype);
        await assert.rejects(
            provider.writeFile('/main.tex', encode('newer')),
            /cannot prove a no-overwrite condition/,
        );
    });

    it('turns an initial file-to-directory race into a path conflict', async () => {
        const {Provider, vscodeStub} = loadProvider();
        const provider: any = Object.create(Provider.prototype);
        provider.baseUri = {scheme: 'file', fsPath: '/replica/', path: '/replica/', kind: 'local'};
        provider.vfs = {
            pathToUri: () => ({scheme: 'overleaf', path: '/main.tex', kind: 'remote'}),
        };
        provider.baseCache = {};
        provider.blockedConflictPaths = new Set();
        provider.conflictMessages = new Map();
        let blocked = false;
        provider.blockUnappliedRemote = async () => {
            blocked = true;
            return new Error('blocked');
        };
        vscodeStub.workspace.fs.stat = async (uri: any) => ({
            type: uri.kind === 'local' ? vscodeStub.FileType.Directory : vscodeStub.FileType.File,
        });

        assert.equal(await provider.reconcileInitialFile('/main.tex', true), false);
        assert.equal(blocked, true);
    });

    it('reclassifies a stat-to-read file-to-directory race as a path conflict', async () => {
        const {Provider, vscodeStub} = loadProvider();
        const provider: any = Object.create(Provider.prototype);
        provider.baseUri = {scheme: 'file', fsPath: '/replica/', path: '/replica/', kind: 'local'};
        provider.vfs = {
            pathToUri: () => ({scheme: 'overleaf', path: '/main.tex', kind: 'remote'}),
        };
        provider.baseCache = {};
        provider.blockedConflictPaths = new Set();
        provider.conflictMessages = new Map();
        let localStats = 0;
        let blocked = false;
        provider.blockUnappliedRemote = async () => {
            blocked = true;
            return new Error('blocked');
        };
        vscodeStub.workspace.fs.stat = async (uri: any) => {
            if (uri.kind === 'remote') { return {type: vscodeStub.FileType.File}; }
            localStats += 1;
            return {type: localStats === 1 ? vscodeStub.FileType.File : vscodeStub.FileType.Directory};
        };
        vscodeStub.workspace.fs.readFile = async (uri: any) => {
            if (uri.kind === 'local') { throw Object.assign(new Error('is a directory'), {code: 'EISDIR'}); }
            return encode('REMOTE');
        };

        assert.equal(await provider.reconcileInitialFile('/main.tex', true), false);
        assert.equal(localStats, 2);
        assert.equal(blocked, true);
    });

    it('keeps initial watchers viable when a local file wins a directory-create race', async () => {
        const {Provider, vscodeStub} = loadProvider();
        const provider: any = Object.create(Provider.prototype);
        provider.baseUri = {scheme: 'file', fsPath: '/replica/', path: '/replica/', kind: 'local'};
        provider.vfs = {
            pathToUri: () => ({scheme: 'overleaf', path: '/folder', kind: 'remote'}),
        };
        provider.collectEntries = async (source: 'remote'|'local') => ({
            entries: source === 'remote'
                ? new Map([['/folder', vscodeStub.FileType.Directory]])
                : new Map(),
            failures: new Map(),
        });
        provider.matchIgnorePatterns = () => false;
        provider.blockedConflictPaths = new Set();
        provider.conflictMessages = new Map();
        provider.pathOperations = new ReplicaPathOperationQueue();
        provider.blockUnappliedRemote = async (relPath: string) => {
            provider.blockedConflictPaths.add(relPath);
            provider.conflictMessages.set(relPath, 'blocked path race');
            return new Error('blocked path race');
        };
        vscodeStub.workspace.fs.stat = async (uri: any) => ({
            type: uri.kind === 'remote' ? vscodeStub.FileType.Directory : vscodeStub.FileType.File,
        });
        vscodeStub.workspace.fs.createDirectory = async () => {
            throw Object.assign(new Error('already a file'), {code: 'EEXIST'});
        };

        assert.equal(await provider.overwrite('/', true), true);
        assert.equal(provider.blockedConflictPaths.has('/folder'), true);
        assert.equal(provider.conflictMessages.get('/folder'), 'blocked path race');
    });

    it('isolates a nested enumeration failure without disposing sibling watchers', async () => {
        const {Provider, vscodeStub} = loadProvider();
        const provider: any = Object.create(Provider.prototype);
        provider.baseUri = {scheme: 'file', fsPath: '/replica/', path: '/replica/', kind: 'local'};
        provider.vfs = {
            pathToUri: (relPath: string) => ({scheme: 'overleaf', path: relPath, kind: 'remote'}),
        };
        provider.matchIgnorePatterns = () => false;
        provider.baseCache = {};
        provider.bypassCache = new Map();
        provider.blockedConflictPaths = new Set();
        provider.conflictMessages = new Map();
        provider.pathOperations = new ReplicaPathOperationQueue();
        provider.readCurrentFile = async () => undefined;
        (vscodeStub.workspace.fs as any).readDirectory = async (uri: any) => {
            if (uri.kind === 'local') { return []; }
            if (uri.path === '/') {
                return [
                    ['folder', vscodeStub.FileType.Directory],
                    ['good.tex', vscodeStub.FileType.File],
                ];
            }
            throw Object.assign(new Error('parent disappeared'), {code: 'ENOENT'});
        };
        const reconciled: string[] = [];
        provider.reconcileInitialFile = async (relPath: string) => {
            reconciled.push(relPath);
            return true;
        };

        let disposed = false;
        await completeInitialReplicaSync(
            () => provider.overwrite('/', true),
            () => { disposed = true; },
            async () => undefined,
        );

        assert.equal(disposed, false);
        assert.deepEqual(reconciled, ['/good.tex']);
        assert.equal(provider.blockedConflictPaths.has('/folder'), true);
        assert.match(provider.conflictMessages.get('/folder'), /parent disappeared/);
    });

    it('isolates an unexpected initial path failure and preserves its remote bytes', async () => {
        const {Provider, vscodeStub} = loadProvider();
        const provider: any = Object.create(Provider.prototype);
        provider.baseUri = {scheme: 'file', fsPath: '/replica/', path: '/replica/', kind: 'local'};
        provider.vfs = {
            pathToUri: (relPath: string) => ({scheme: 'overleaf', path: relPath, kind: 'remote'}),
        };
        provider.collectEntries = async (source: 'remote'|'local') => ({
            entries: source === 'remote'
                ? new Map([
                    ['/bad.tex', vscodeStub.FileType.File],
                    ['/good.tex', vscodeStub.FileType.File],
                ])
                : new Map(),
            failures: new Map(),
        });
        provider.matchIgnorePatterns = () => false;
        provider.baseCache = {};
        provider.bypassCache = new Map();
        provider.blockedConflictPaths = new Set();
        provider.conflictMessages = new Map();
        provider.pathOperations = new ReplicaPathOperationQueue();
        provider.readCurrentFile = async (uri: any) => uri.kind === 'remote' ? encode('REMOTE') : undefined;

        const reconciled: string[] = [];
        provider.reconcileInitialFile = async (relPath: string) => {
            reconciled.push(relPath);
            if (relPath === '/bad.tex') {
                throw Object.assign(new Error('hard-link unavailable'), {code: 'EPERM'});
            }
            return true;
        };
        let archives = 0;
        provider.preserveIncomingRemote = async (_relPath: string, content: Uint8Array) => {
            archives += 1;
            assert.equal(decode(content), 'REMOTE');
            return {fsPath: '/replica/.overleaf/incoming/bad.bin'};
        };

        let disposed = false;
        let replayed = false;
        await completeInitialReplicaSync(
            () => provider.overwrite('/', true),
            () => { disposed = true; },
            async () => { replayed = true; },
        );

        assert.deepEqual(reconciled.sort(), ['/bad.tex', '/good.tex']);
        assert.equal(disposed, false);
        assert.equal(replayed, true);
        assert.equal(archives, 1);
        assert.equal(provider.blockedConflictPaths.has('/bad.tex'), true);
        assert.equal(provider.blockedConflictPaths.has('/good.tex'), false);

        await provider.blockInitialPathFailure('/bad.tex', new Error('later event'));
        assert.equal(archives, 1);
    });

    it('does not promote a remote-only result to the common base after local no-overwrite fails', async () => {
        const {Provider, vscodeStub} = loadProvider();
        const provider: any = Object.create(Provider.prototype);
        const relPath = '/main.tex';
        const base = encode('alpha middle omega');
        const local = encode('ALPHA middle omega');
        let remote = encode('alpha middle OMEGA');
        provider.baseUri = {scheme: 'file', fsPath: '/replica/', path: '/replica/', kind: 'local'};
        provider.vfs = {
            pathToUri: () => ({scheme: 'overleaf', path: relPath, kind: 'remote'}),
        };
        provider.baseCache = {[relPath]: base};
        provider.bypassCache = new Map();
        provider.blockedConflictPaths = new Set();
        provider.conflictMessages = new Map();
        provider.readCurrentFile = async (uri: any) => uri.kind === 'local' ? local : remote;

        let remoteWrites = 0;
        (vscodeStub.workspace.fs as any).writeFile = async (_uri: any, content: Uint8Array) => {
            remoteWrites += 1;
            remote = encode(`SERVER ${decode(content)}`);
        };
        vscodeStub.workspace.fs.readFile = async () => remote;
        let archives = 0;
        provider.preserveIncomingRemote = async (_path: string, content: Uint8Array) => {
            archives += 1;
            assert.equal(decode(content), 'SERVER ALPHA middle OMEGA');
            return {fsPath: '/replica/.overleaf/incoming/main.bin'};
        };

        assert.equal(await provider.reconcileInitialFile(relPath, false), false);
        assert.equal(remoteWrites, 1);
        assert.equal(archives, 1);
        assert.equal(decode(provider.baseCache[relPath]), 'alpha middle omega');
        assert.equal(provider.blockedConflictPaths.has(relPath), true);

        // The stored block is checked before either replica is touched again.
        assert.equal(await provider.reconcileInitialFile(relPath, false), false);
        assert.equal(remoteWrites, 1);
        assert.equal(archives, 1);
    });

    it('archives the first pull conflict once and keeps later blocked events side-effect free', async () => {
        const {Provider, vscodeStub} = loadProvider();
        const provider: any = Object.create(Provider.prototype);
        const relPath = '/main.tex';
        const localUri = {scheme: 'file', path: '/replica/main.tex', kind: 'local'};
        const remoteUri = {scheme: 'overleaf', path: '/main.tex', kind: 'remote'};
        provider.baseCache = {[relPath]: encode('same line\n')};
        provider.bypassCache = new Map();
        provider.blockedConflictPaths = new Set();
        provider.conflictMessages = new Map();
        provider.matchIgnorePatterns = () => false;
        let reads = 0;
        provider.readCurrentFile = async (uri: any) => {
            reads += 1;
            return uri.kind === 'local' ? encode('local line\n') : encode('remote line\n');
        };
        let archives = 0;
        provider.preserveIncomingRemote = async () => {
            archives += 1;
            return {fsPath: '/replica/.overleaf/incoming/main-1.tex'};
        };

        const queue = new ReplicaPathOperationQueue();
        let firstMessage = '';
        await assert.rejects(
            queue.run(relPath, () => provider.applyPullSync('update', relPath, remoteUri, localUri)),
            (error: Error) => {
                firstMessage = error.message;
                return error.message.includes('/replica/.overleaf/incoming/main-1.tex');
            },
        );
        assert.equal(archives, 1);
        assert.equal(reads, 2);

        vscodeStub.workspace.fs.stat = async () => {
            throw new Error('a blocked pull must not touch either replica');
        };
        for (let event = 0; event < 2; event++) {
            await assert.rejects(
                queue.run(relPath, () => provider.applySync(
                    'pull',
                    'update',
                    relPath,
                    remoteUri,
                    localUri,
                )),
                (error: Error) => error.message === firstMessage,
            );
        }
        assert.equal(archives, 1);
        assert.equal(reads, 2);

        let unrelatedWatcherEventRan = false;
        await queue.run('/unrelated.tex', async () => { unrelatedWatcherEventRan = true; });
        assert.equal(unrelatedWatcherEventRan, true);
    });

    it('treats a replayed local directory create as idempotent when remote is already a directory', async () => {
        const {Provider, vscodeStub} = loadProvider();
        const provider: any = Object.create(Provider.prototype);
        const relPath = '/folder';
        const localUri = {scheme: 'file', path: '/replica/folder', kind: 'local'};
        const remoteUri = {scheme: 'overleaf', path: '/folder', kind: 'remote'};
        provider.bypassCache = new Map([[
            relPath,
            [
                {date: 1, content: new Uint8Array()},
                {date: 1, content: new Uint8Array()},
            ],
        ]]);
        provider.blockedConflictPaths = new Set();
        provider.conflictMessages = new Map();
        provider.matchIgnorePatterns = () => false;
        const statKinds: string[] = [];
        vscodeStub.workspace.fs.stat = async (uri: any) => {
            statKinds.push(uri.kind);
            return {type: vscodeStub.FileType.Directory};
        };
        let createDirectoryCalls = 0;
        vscodeStub.workspace.fs.createDirectory = async () => { createDirectoryCalls += 1; };

        await provider.applySync('push', 'update', relPath, localUri, remoteUri, true);

        assert.deepEqual(statKinds, ['local', 'remote']);
        assert.equal(createDirectoryCalls, 0);
    });
});
