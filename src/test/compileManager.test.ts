/* eslint-disable @typescript-eslint/naming-convention */
import { strict as assert } from 'assert';
import { CompileOutcome } from '../compile/compileResult';

interface ModuleLoader {
    _load(request: string, parent: NodeModule | null, isMain: boolean): unknown,
}

class DisposableStub {
    dispose() {}
}

class MarkdownStringStub {
    appendMarkdown() { return this; }
}

const statusItems: any[] = [];
const executedCommands: string[] = [];
let executeCommand = async (_command: string, ..._args: unknown[]): Promise<unknown> => undefined;
const vscodeStub = {
    DiagnosticSeverity: {Error: 0, Warning: 1, Information: 2},
    StatusBarAlignment: {Left: 1},
    ViewColumn: {Beside: 2},
    MarkdownString: MarkdownStringStub,
    ThemeColor: class ThemeColor { constructor(readonly id: string) {} },
    l10n: {
        t: (message: string, values?: Record<string, unknown>) => message.replace(
            /\{([^}]+)\}/g,
            (_match, key: string) => String(values?.[key] ?? `{${key}}`),
        ),
    },
    languages: {
        createDiagnosticCollection: () => ({clear() {}, set() {}, dispose() {}}),
    },
    window: {
        activeTextEditor: undefined as any,
        visibleTextEditors: [] as any[],
        createStatusBarItem: () => {
            const item = {
                text: '',
                tooltip: undefined,
                backgroundColor: undefined,
                command: undefined,
                show() {},
                hide() {},
                dispose() {},
            };
            statusItems.push(item);
            return item;
        },
    },
    workspace: {
        workspaceFolders: undefined,
        textDocuments: [] as any[],
        saveAll: async () => true,
        getConfiguration: () => ({get: (_key: string, fallback: unknown) => fallback}),
        getWorkspaceFolder: () => undefined,
    },
    commands: {
        executeCommand: (command: string, ...args: unknown[]) => {
            executedCommands.push(command);
            return executeCommand(command, ...args);
        },
        registerCommand: () => new DisposableStub(),
    },
};

const eventListeners = new Map<string, Set<(arg: any) => void>>();
const eventBusStub = {
    EventBus: {
        on: (eventName: string, listener: (arg: any) => void) => {
            const listeners = eventListeners.get(eventName) ?? new Set();
            listeners.add(listener);
            eventListeners.set(eventName, listeners);
            return {
                dispose: () => listeners.delete(listener),
            };
        },
    },
};

function fireEvent(eventName: string, arg: any) {
    for (const listener of eventListeners.get(eventName) ?? []) {
        listener(arg);
    }
}

const moduleLoader = require('module') as ModuleLoader;
const originalLoad = moduleLoader._load;
const originalCacheKeys = new Set(Object.keys(require.cache));
let CompileManager: typeof import('../compile/compileManager')['CompileManager'];
moduleLoader._load = function(request, parent, isMain): unknown {
    if (request === 'vscode') { return vscodeStub; }
    if (request === '../core/remoteFileSystemProvider') {
        return {
            parseUri: (uri: any) => ({identifier: uri.identifier, pathParts: uri.pathParts}),
        };
    }
    if (request === '../core/pdfViewEditorProvider') { return {}; }
    if (request === '../utils/eventBus') { return eventBusStub; }
    if (request === '../scm/localReplicaSCM') {
        return {LocalReplicaSCMProvider: {readSettings: async () => undefined}};
    }
    if (request === './compileTarget') {
        return {resolveCompileRootDocId: async () => undefined};
    }
    return originalLoad.call(this, request, parent, isMain);
};
try {
    CompileManager = (require('../compile/compileManager') as typeof import('../compile/compileManager')).CompileManager;
} finally {
    moduleLoader._load = originalLoad;
    for (const cacheKey of Object.keys(require.cache)) {
        if (!originalCacheKeys.has(cacheKey)) {
            delete require.cache[cacheKey];
        }
    }
}

let nextProject = 0;
const managers: any[] = [];

function makeUri(identifier: string, pathParts: string[]): any {
    const [userId, projectId, projectName] = identifier.split('/');
    const path = `/${projectName}/${pathParts.join('/')}`;
    const query = `user=${encodeURIComponent(userId)}&project=${encodeURIComponent(projectId)}`;
    const uri = {
        scheme: 'overleaf-workshop',
        authority: 'www.overleaf.com',
        identifier,
        pathParts,
        path,
        query,
        toString: () => `overleaf-workshop://www.overleaf.com${path}?${query}`,
        with: (changes: {path?: string}) => {
            const changedPath = changes.path ?? path;
            const changedParts = changedPath.split('/').slice(2);
            return makeUri(identifier, changedParts);
        },
    };
    return uri;
}

function projectFixture() {
    nextProject += 1;
    const identifier = `user/project-${nextProject}/Project-${nextProject}`;
    return {
        identifier,
        sourceUri: makeUri(identifier, ['main.tex']),
        compileUri: makeUri(identifier, ['main.tex']),
        pdfUri: makeUri(identifier, ['.output', 'output.pdf']),
    };
}

function setActiveEditor(uri: any, line = 4, character = 2, version = 1) {
    const document = {uri, version, isDirty: false};
    const editor = {
        document,
        selection: {active: {line, character}},
    };
    vscodeStub.window.activeTextEditor = editor;
    vscodeStub.workspace.textDocuments = [document];
    return editor;
}

function createManager(vfs: any) {
    const manager = new CompileManager({prefetch: async () => vfs} as any);
    managers.push(manager);
    return manager;
}

function registerPdfViewer(
    fixture: ReturnType<typeof projectFixture>,
    actions: string[],
    options: {
        ready?: boolean,
        initialGeneration?: number,
        refresh?: () => Promise<Uint8Array>,
    } = {},
) {
    const messages: any[] = [];
    const refresh = options.refresh ?? (async () => {
        actions.push('refresh');
        return new Uint8Array([1]);
    });
    let refreshRequestGeneration = 0;
    const doc = {
        generation: options.initialGeneration ?? 1,
        invalidateRefresh: () => {
            refreshRequestGeneration += 1;
        },
        refresh: async () => {
            const requestGeneration = ++refreshRequestGeneration;
            const content = await refresh();
            if (requestGeneration !== refreshRequestGeneration) {
                return new Uint8Array();
            }
            if (content.byteLength > 0) {
                doc.generation += 1;
            }
            return content;
        },
    };
    const webviewPanel = {
        webview: {
            postMessage: async (message: any) => {
                actions.push(message.type);
                messages.push(message);
                return true;
            },
        },
    };
    fireEvent('pdfWillOpenEvent', {uri: fixture.pdfUri, doc, webviewPanel});
    if (options.ready !== false) {
        fireEvent('pdfViewerReadyEvent', {uri: fixture.pdfUri, webviewPanel});
    }
    return {doc, webviewPanel, messages};
}

function successfulOutcome(): CompileOutcome {
    return {
        status: 'success',
        successful: true,
        outputsUpdated: true,
        hasLog: false,
    };
}

function failedOutcome(): CompileOutcome {
    return {
        status: 'failure',
        successful: false,
        outputsUpdated: true,
        hasLog: false,
    };
}

function createVfs(
    outcome: CompileOutcome,
    actions: string[],
    syncCode: (...args: any[]) => Promise<any> = async () => [{page: 1, h: 2, v: 3}],
) {
    return {
        getRootDocName: () => '/main.tex',
        getCompiler: () => ({name: 'pdfLaTex'}),
        adoptCachedCompile: async () => undefined,
        compile: async () => outcome,
        stopCompile: async () => true,
        syncCode: async (...args: any[]) => {
            actions.push('sync-request');
            return syncCode(...args);
        },
    };
}

async function flushAsync() {
    await new Promise<void>(resolve => setImmediate(resolve));
    await Promise.resolve();
}

describe('CompileManager cached startup', () => {
    beforeEach(() => {
        statusItems.length = 0;
        executedCommands.length = 0;
        executeCommand = async () => undefined;
        vscodeStub.window.activeTextEditor = undefined;
        vscodeStub.workspace.textDocuments = [];
    });

    afterEach(() => {
        for (const manager of managers.splice(0)) {
            manager.pdfWillOpenTrigger.dispose();
            manager.pdfViewerReadyTrigger.dispose();
            manager.pdfViewDisposedTrigger.dispose();
        }
    });

    it('falls back to a real compile when a cached output cannot be downloaded', async () => {
        const uri = projectFixture().compileUri;
        const cachedOutcome: CompileOutcome = {
            status: 'success',
            successful: true,
            outputsUpdated: true,
            hasLog: true,
        };
        let liveCompiles = 0;
        let diagnosticChecks = 0;
        executeCommand = async command => {
            if (command === 'overleaf-workshop.compileManager.compileErrorCheck') {
                diagnosticChecks += 1;
                throw new Error('Download failed with HTTP 404');
            }
            return undefined;
        };
        const vfs = {
            getRootDocName: () => '/main.tex',
            getCompiler: () => ({name: 'pdfLaTex'}),
            adoptCachedCompile: async () => cachedOutcome,
            compile: async () => {
                liveCompiles += 1;
                return undefined;
            },
        };
        const manager = createManager(vfs);

        await manager.compile(true, 'initial-project', uri as any);

        assert.equal(diagnosticChecks, 1);
        assert.equal(liveCompiles, 1);
        assert.equal(statusItems.at(-1)?.text, 'pdfLaTex');
    });
});

describe('CompileManager automatic forward SyncTeX after compile', () => {
    beforeEach(() => {
        statusItems.length = 0;
        executedCommands.length = 0;
        executeCommand = async () => undefined;
        vscodeStub.window.activeTextEditor = undefined;
        vscodeStub.workspace.textDocuments = [];
    });

    afterEach(() => {
        for (const manager of managers.splice(0)) {
            manager.pdfWillOpenTrigger.dispose();
            manager.pdfViewerReadyTrigger.dispose();
            manager.pdfViewDisposedTrigger.dispose();
        }
    });

    it('refreshes an already-open output PDF before syncing to the captured TeX cursor', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        const syncCalls: any[][] = [];
        const editor = setActiveEditor(fixture.sourceUri, 6, 9, 3);
        const vfs = createVfs(successfulOutcome(), actions, async (...args) => {
            syncCalls.push(args);
            return [{page: 4, h: 5, v: 6}];
        });
        const manager = createManager(vfs);
        const viewer = registerPdfViewer(fixture, actions);

        await manager.compile(true, 'command', fixture.compileUri);
        await flushAsync();

        assert.deepEqual(syncCalls, [['main.tex', 7, 9]]);
        assert.deepEqual(actions, ['refresh', 'sync-request', 'syncCode']);
        assert.deepEqual(viewer.messages, [{
            type: 'syncCode',
            content: [{page: 4, h: 5, v: 6}],
            pdfGeneration: 2,
        }]);
        assert.equal(vscodeStub.window.activeTextEditor, editor);
        assert.equal(executedCommands.includes('vscode.openWith'), false);
    });

    it('does not let an in-flight PDF refresh block compile or enable manual sync early', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        let finishRefresh!: (content: Uint8Array) => void;
        const refreshResult = new Promise<Uint8Array>(resolve => {
            finishRefresh = resolve;
        });
        setActiveEditor(fixture.sourceUri);
        const manager = createManager(createVfs(successfulOutcome(), actions));
        const viewer = registerPdfViewer(fixture, actions, {
            refresh: async () => {
                actions.push('refresh');
                return refreshResult;
            },
        });

        // This must resolve while the PDF download is still pending; otherwise
        // the refresh occupies CompileRunGate and blocks compile/stop requests.
        await manager.compile(true, 'command', fixture.compileUri);
        assert.equal(manager.inCompiling, false);
        assert.deepEqual(actions, ['refresh']);

        await manager.syncCode();
        assert.deepEqual(actions, ['refresh']);
        assert.deepEqual(viewer.messages, []);

        finishRefresh(new Uint8Array([1]));
        await flushAsync();
        assert.deepEqual(actions, ['refresh']);

        await manager.syncCode();

        assert.deepEqual(actions, ['refresh', 'sync-request', 'syncCode']);
        assert.equal((viewer.messages as any[]).at(-1)?.pdfGeneration, 2);
    });

    it('does not refresh or auto-sync after a failed compile but preserves manual sync', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        setActiveEditor(fixture.sourceUri);
        const manager = createManager(createVfs(failedOutcome(), actions));
        registerPdfViewer(fixture, actions);

        await manager.compile(true, 'command', fixture.compileUri);
        await flushAsync();

        assert.deepEqual(actions, []);
        await manager.syncCode();
        assert.deepEqual(actions, ['sync-request', 'syncCode']);
    });

    it('does not open a viewer when the output PDF is not already open', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        setActiveEditor(fixture.sourceUri);
        const manager = createManager(createVfs(successfulOutcome(), actions));

        await manager.compile(true, 'command', fixture.compileUri);
        await flushAsync();

        assert.deepEqual(actions, []);
        assert.equal(executedCommands.includes('vscode.openWith'), false);
    });

    it('preserves the first manual forward-sync when openWith resolves before viewer registration', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        setActiveEditor(fixture.sourceUri, 3, 7, 1);
        const manager = createManager(createVfs(successfulOutcome(), actions));

        await manager.openPdf();
        await flushAsync();
        assert.equal(executedCommands.includes('vscode.openWith'), true);
        assert.deepEqual(actions, []);

        const viewer = registerPdfViewer(fixture, actions);
        await flushAsync();

        assert.deepEqual(actions, ['sync-request', 'syncCode']);
        assert.deepEqual(viewer.messages, [{
            type: 'syncCode',
            content: [{page: 1, h: 2, v: 3}],
            pdfGeneration: 1,
        }]);
    });

    it('delivers a manual sync only when the same PDF generation becomes ready', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        setActiveEditor(fixture.sourceUri);
        const manager = createManager(createVfs(successfulOutcome(), actions));
        const viewer = registerPdfViewer(fixture, actions, {ready: false});

        await manager.syncCode();
        assert.deepEqual(actions, ['sync-request']);
        assert.deepEqual(viewer.messages, []);

        fireEvent('pdfViewerReadyEvent', {uri: fixture.pdfUri, webviewPanel: viewer.webviewPanel});
        await flushAsync();

        assert.deepEqual(actions, ['sync-request', 'syncCode']);
        assert.deepEqual(viewer.messages, [{
            type: 'syncCode',
            content: [{page: 1, h: 2, v: 3}],
            pdfGeneration: 1,
        }]);
    });

    it('drops a ready-queue result when the PDF generation changes first', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        setActiveEditor(fixture.sourceUri);
        const manager = createManager(createVfs(successfulOutcome(), actions));
        const viewer = registerPdfViewer(fixture, actions, {ready: false});

        await manager.syncCode();
        viewer.doc.generation += 1;
        fireEvent('pdfViewerReadyEvent', {uri: fixture.pdfUri, webviewPanel: viewer.webviewPanel});
        await flushAsync();

        assert.deepEqual(actions, ['sync-request']);
        assert.deepEqual(viewer.messages, []);
    });

    it('does not sync when the replacement PDF could not be loaded', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        setActiveEditor(fixture.sourceUri);
        const manager = createManager(createVfs(successfulOutcome(), actions));
        const viewer = registerPdfViewer(fixture, actions, {
            refresh: async () => {
                actions.push('refresh-failed');
                return new Uint8Array();
            },
        });

        await manager.compile(true, 'command', fixture.compileUri);
        await flushAsync();
        await manager.syncCode();

        assert.deepEqual(actions, ['refresh-failed']);
        assert.deepEqual(viewer.messages, []);
    });

    it('refreshes a viewer which registers after the successful build before enabling sync', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        let finishOpen!: () => void;
        const openResult = new Promise<void>(resolve => {
            finishOpen = resolve;
        });
        let finishCurrentBuildRefresh!: (content: Uint8Array) => void;
        const currentBuildRefresh = new Promise<Uint8Array>(resolve => {
            finishCurrentBuildRefresh = resolve;
        });
        const manager = createManager(createVfs(successfulOutcome(), actions));
        setActiveEditor(fixture.sourceUri);
        executeCommand = async command => command === 'vscode.openWith' ? openResult : undefined;

        // Model openCustomDocument having started to load PDF A but not yet
        // firing pdfWillOpenEvent when compile B commits with no record.
        const opening = manager.openPdf();
        await flushAsync();
        await manager.compile(true, 'command', fixture.compileUri);
        finishOpen();
        await opening;
        const viewer = registerPdfViewer(fixture, actions, {
            initialGeneration: 1,
            refresh: async () => {
                actions.push('refresh-current-build');
                return currentBuildRefresh;
            },
        });

        assert.deepEqual(actions, ['refresh-current-build']);
        assert.deepEqual(viewer.messages, []);

        finishCurrentBuildRefresh(new Uint8Array([2]));
        await flushAsync();

        assert.deepEqual(actions, ['refresh-current-build', 'sync-request', 'syncCode']);
        assert.equal((viewer.messages as any[]).at(-1)?.pdfGeneration, 2);
    });

    it('does not carry a pending first-open cursor across a failed refresh and viewer reopen', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        const manager = createManager(createVfs(successfulOutcome(), actions));

        await manager.compile(true, 'command', fixture.compileUri);
        setActiveEditor(fixture.sourceUri, 9, 4);
        await manager.openPdf();
        registerPdfViewer(fixture, actions, {
            refresh: async () => {
                actions.push('refresh-failed');
                return new Uint8Array();
            },
        });
        await flushAsync();

        const replacement = registerPdfViewer(fixture, actions);
        await flushAsync();

        assert.deepEqual(actions, ['refresh-failed', 'refresh']);
        assert.deepEqual(replacement.messages, []);
    });

    it('refreshes the PDF but skips sync for a TeX editor from another project', async () => {
        const fixture = projectFixture();
        const other = projectFixture();
        const actions: string[] = [];
        setActiveEditor(other.sourceUri);
        const manager = createManager(createVfs(successfulOutcome(), actions));
        registerPdfViewer(fixture, actions);

        await manager.compile(true, 'command', fixture.compileUri);
        await flushAsync();

        assert.deepEqual(actions, ['refresh']);
    });

    it('refreshes the PDF but skips sync when the active source is not TeX', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        setActiveEditor(makeUri(fixture.identifier, ['refs.bib']));
        const manager = createManager(createVfs(successfulOutcome(), actions));
        registerPdfViewer(fixture, actions);

        await manager.compile(true, 'command', fixture.compileUri);
        await flushAsync();

        assert.deepEqual(actions, ['refresh']);
    });

    it('skips a stale captured cursor when the editor moves during compilation', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        const editor = setActiveEditor(fixture.sourceUri, 2, 3, 1);
        let finishCompile!: (outcome: CompileOutcome) => void;
        const compileResult = new Promise<CompileOutcome>(resolve => {
            finishCompile = resolve;
        });
        const vfs = createVfs(successfulOutcome(), actions);
        vfs.compile = async () => compileResult;
        const manager = createManager(vfs);
        registerPdfViewer(fixture, actions);

        const compiling = manager.compile(true, 'command', fixture.compileUri);
        await flushAsync();
        editor.selection.active = {line: 8, character: 1};
        finishCompile(successfulOutcome());
        await compiling;
        await flushAsync();

        assert.deepEqual(actions, ['refresh']);
    });

    it('drops auto-sync when the viewer is disposed during PDF refresh', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        setActiveEditor(fixture.sourceUri);
        let finishRefresh!: () => void;
        const refreshResult = new Promise<void>(resolve => {
            finishRefresh = resolve;
        });
        const manager = createManager(createVfs(successfulOutcome(), actions));
        const viewer = registerPdfViewer(fixture, actions, {
            refresh: async () => {
                actions.push('refresh');
                await refreshResult;
                return new Uint8Array([1]);
            },
        });

        const compiling = manager.compile(true, 'command', fixture.compileUri);
        await flushAsync();
        fireEvent('pdfViewDisposedEvent', {uri: fixture.pdfUri, webviewPanel: viewer.webviewPanel});
        finishRefresh();
        await compiling;
        await flushAsync();

        assert.deepEqual(actions, ['refresh']);
    });

    it('drops auto-sync when the viewer is replaced during PDF refresh', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        setActiveEditor(fixture.sourceUri);
        let finishRefresh!: () => void;
        const refreshResult = new Promise<void>(resolve => {
            finishRefresh = resolve;
        });
        const manager = createManager(createVfs(successfulOutcome(), actions));
        registerPdfViewer(fixture, actions, {
            refresh: async () => {
                actions.push('refresh');
                await refreshResult;
                return new Uint8Array([1]);
            },
        });

        const compiling = manager.compile(true, 'command', fixture.compileUri);
        await flushAsync();
        registerPdfViewer(fixture, actions);
        finishRefresh();
        await compiling;
        await flushAsync();

        // The replacement performs its own current-build refresh, but the
        // cursor captured for the disposed viewer is never delivered to it.
        assert.deepEqual(actions, ['refresh', 'refresh']);
    });

    it('does not commit refresh or sync from a cancelled compile run', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        setActiveEditor(fixture.sourceUri);
        let finishCompile!: (outcome: CompileOutcome) => void;
        const compileResult = new Promise<CompileOutcome>(resolve => {
            finishCompile = resolve;
        });
        const vfs = createVfs(successfulOutcome(), actions);
        vfs.compile = async (...args: any[]) => {
            args[6]?.();
            return compileResult;
        };
        vfs.stopCompile = async () => true;
        const manager = createManager(vfs);
        registerPdfViewer(fixture, actions);

        const compiling = manager.compile(true, 'command', fixture.compileUri);
        await flushAsync();
        await manager.stopCompile();
        finishCompile(successfulOutcome());
        await compiling;
        await flushAsync();

        assert.deepEqual(actions, []);
    });

    it('invalidates an old pending SyncTeX response as soon as a newer compile starts', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        setActiveEditor(fixture.sourceUri);
        let finishOldSync!: (result: any) => void;
        const oldSyncResult = new Promise<any>(resolve => {
            finishOldSync = resolve;
        });
        let finishSecondCompile!: (outcome: CompileOutcome) => void;
        const secondCompileResult = new Promise<CompileOutcome>(resolve => {
            finishSecondCompile = resolve;
        });
        let compileCount = 0;
        const vfs = createVfs(successfulOutcome(), actions, async () => oldSyncResult);
        vfs.compile = async () => {
            compileCount += 1;
            return compileCount === 1 ? successfulOutcome() : secondCompileResult;
        };
        const manager = createManager(vfs);
        const viewer = registerPdfViewer(fixture, actions);

        await manager.compile(true, 'command', fixture.compileUri);
        await flushAsync();
        assert.deepEqual(actions, ['refresh', 'sync-request']);

        const newerCompile = manager.compile(true, 'command', fixture.compileUri);
        await flushAsync();
        assert.equal(compileCount, 2);
        finishOldSync([{page: 1, h: 2, v: 3}]);
        await flushAsync();
        assert.deepEqual(viewer.messages, []);

        finishSecondCompile(failedOutcome());
        await newerCompile;
        await flushAsync();
        assert.deepEqual(actions, ['refresh', 'sync-request']);
    });

    it('starts a newer compile while an older PDF download is pending and keeps the old PDF blocked', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        let finishOldRefresh!: (content: Uint8Array) => void;
        const oldRefresh = new Promise<Uint8Array>(resolve => {
            finishOldRefresh = resolve;
        });
        let compileCount = 0;
        const vfs = createVfs(successfulOutcome(), actions);
        vfs.compile = async () => {
            compileCount += 1;
            return compileCount === 1 ? successfulOutcome() : failedOutcome();
        };
        const manager = createManager(vfs);
        const viewer = registerPdfViewer(fixture, actions, {
            refresh: async () => {
                actions.push('old-refresh');
                return oldRefresh;
            },
        });

        await manager.compile(true, 'command', fixture.compileUri);
        assert.equal(manager.inCompiling, false);
        await manager.compile(true, 'command', fixture.compileUri);
        assert.equal(compileCount, 2);

        finishOldRefresh(new Uint8Array([1]));
        await flushAsync();
        setActiveEditor(fixture.sourceUri);
        await manager.syncCode();

        assert.deepEqual(actions, ['old-refresh']);
        assert.deepEqual(viewer.messages, []);
        assert.equal(viewer.doc.generation, 1);
    });

    it('keeps a successful compile successful when SyncTeX is unavailable', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        setActiveEditor(fixture.sourceUri);
        const manager = createManager(createVfs(successfulOutcome(), actions, async () => undefined));
        const viewer = registerPdfViewer(fixture, actions);

        await manager.compile(true, 'command', fixture.compileUri);
        await flushAsync();

        assert.deepEqual(actions, ['refresh', 'sync-request']);
        assert.deepEqual(viewer.messages, []);
        assert.equal(statusItems.at(-1)?.text, 'pdfLaTex');
    });
});
