/* eslint-disable @typescript-eslint/naming-convention */
import { strict as assert } from 'assert';
import { CompileOutcome } from '../compile/compileResult';
import {createPdfViewerHarness, pdfPage} from './helpers/pdfViewerHarness';
import {resolveCompileRootDocId} from '../compile/compileTarget';

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
const shownTextDocuments: any[][] = [];
const documentChangeListeners = new Set<(event: any) => void>();
const documentCloseListeners = new Set<(document: any) => void>();
const activeEditorListeners = new Set<(editor: any) => void>();
const navigationWarnings: string[] = [];
const registeredCommands = new Map<string, (...args: any[]) => any>();
const saveListeners = new Set<(document: any) => any>();
let inspectCompileRoot: typeof resolveCompileRootDocId = async () => undefined;
let executeCommand = async (_command: string, ..._args: unknown[]): Promise<unknown> => undefined;
let showTextDocument = async (..._args: any[]): Promise<any> => undefined;
let diagnosticClears = 0;
const vscodeStub = {
    Range: class {
        constructor(readonly startLine: number, readonly startCharacter: number,
            readonly endLine: number, readonly endCharacter: number) {}
    },
    Selection: class {
        readonly active: {line: number, character: number};
        constructor(anchorLine: number, anchorCharacter: number, line: number, character: number) {
            this.active = {line, character};
        }
    },
    TextEditorRevealType: {InCenter: 1},
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
        createDiagnosticCollection: () => ({
            clear() { diagnosticClears += 1; },
            set() {},
            dispose() {},
        }),
    },
    window: {
        activeTextEditor: undefined as any,
        visibleTextEditors: [] as any[],
        onDidChangeActiveTextEditor: (listener: (editor: any) => void) => {
            activeEditorListeners.add(listener);
            return {dispose: () => activeEditorListeners.delete(listener)};
        },
        showWarningMessage: async (message: string) => { navigationWarnings.push(message); },
        showTextDocument: async (...args: any[]) => {
            shownTextDocuments.push(args);
            return showTextDocument(...args);
        },
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
        onDidChangeTextDocument: (listener: (event: any) => void) => {
            documentChangeListeners.add(listener);
            return {dispose: () => documentChangeListeners.delete(listener)};
        },
        onDidCloseTextDocument: (listener: (document: any) => void) => {
            documentCloseListeners.add(listener);
            return {dispose: () => documentCloseListeners.delete(listener)};
        },
        onDidSaveTextDocument: (listener: (document: any) => any) => {
            saveListeners.add(listener);
            return {dispose: () => saveListeners.delete(listener)};
        },
    },
    commands: {
        executeCommand: (command: string, ...args: unknown[]) => {
            executedCommands.push(command);
            return executeCommand(command, ...args);
        },
        registerCommand: (name: string, callback: (...args: any[]) => any) => {
            registeredCommands.set(name, callback);
            return {dispose: () => registeredCommands.delete(name)};
        },
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

function fireDocumentChange(document: any) {
    for (const listener of documentChangeListeners) {
        listener({document});
    }
}

function fireDocumentClose(document: any) {
    for (const listener of documentCloseListeners) {
        listener(document);
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
            parseUri: (uri: any) => ({
                identifier: uri.identifier, pathParts: uri.pathParts,
                projectName: JSON.parse(uri.identifier)[3],
            }),
        };
    }
    if (request === '../core/pdfViewEditorProvider') { return {}; }
    if (request === '../utils/eventBus') { return eventBusStub; }
    if (request === '../scm/localReplicaSCM') {
        return {LocalReplicaSCMProvider: {readSettings: async () => undefined}};
    }
    if (request === './compileTarget') {
        return {resolveCompileRootDocId: (...args: Parameters<typeof resolveCompileRootDocId>) => inspectCompileRoot(...args)};
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
    const [authority, userId, projectId, projectName] = JSON.parse(identifier) as string[];
    const path = `/${projectName}/${pathParts.join('/')}`;
    const query = `user=${encodeURIComponent(userId)}&project=${encodeURIComponent(projectId)}`;
    const uri = {
        scheme: 'overleaf-workshop',
        authority,
        identifier,
        pathParts,
        path,
        query,
        toString: () => `overleaf-workshop://${authority}${path}?${query}`,
        with: (changes: {path?: string}) => {
            const changedPath = changes.path ?? path;
            const changedParts = changedPath.split('/').slice(2);
            return makeUri(identifier, changedParts);
        },
    };
    return uri;
}

function projectFixture(authority = 'www.overleaf.com', identity?: {
    userId: string,
    projectId: string,
    projectName: string,
}) {
    nextProject += 1;
    const userId = identity?.userId ?? 'user';
    const projectId = identity?.projectId ?? `project-${nextProject}`;
    const projectName = identity?.projectName ?? `Project-${nextProject}`;
    const identifier = JSON.stringify([authority, userId, projectId, projectName]);
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
        visibleRanges: [] as Array<{start: {line: number, character: number}, end: {line: number, character: number}}>,
    };
    vscodeStub.window.activeTextEditor = editor;
    vscodeStub.window.visibleTextEditors = [editor];
    vscodeStub.workspace.textDocuments = [document];
    return editor;
}

function createManager(vfs: any) {
    const manager = new CompileManager({prefetch: async () => vfs} as any);
    managers.push(manager);
    return manager;
}

function reverseEditor(uri: any, lines: string[]) {
    const revealed: any[] = [];
    const editor = {
        document: {uri, lineCount: lines.length, lineAt: (line: number) => ({text: lines[line]})},
        viewColumn: 1,
        selections: [] as any[],
        revealRange: (...args: any[]) => revealed.push(args),
    };
    vscodeStub.window.visibleTextEditors = [editor];
    showTextDocument = async (openedUri, options) => {
        assert.equal(openedUri.toString(), uri.toString());
        assert.deepEqual(options, {viewColumn: 1, preserveFocus: false});
        return editor;
    };
    return {editor, revealed};
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
        uri: fixture.pdfUri,
        generation: options.initialGeneration ?? 1,
        reportLoadFailure: () => { actions.push('load-error'); },
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

function reverseSyncRequest(
    fixture: ReturnType<typeof projectFixture>,
    viewer: ReturnType<typeof registerPdfViewer>,
    pdfGeneration = viewer.doc.generation,
): any {
    return {
        page: 2,
        h: 3,
        v: 4,
        identifier: 'source token',
        pdfGeneration,
        uri: fixture.pdfUri,
        webviewPanel: viewer.webviewPanel,
    };
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
        outputIdentityGeneration: 0,
        getRootDocName: () => '/main.tex',
        getCompiler: () => ({name: 'pdfLaTex'}),
        adoptCachedCompile: async () => undefined,
        compile: async () => outcome,
        stopCompile: async () => true,
        syncCode: async (...args: any[]) => {
            actions.push('sync-request');
            return syncCode(...args);
        },
        syncPdf: async () => undefined,
    };
}

async function flushAsync() {
    await new Promise<void>(resolve => setImmediate(resolve));
    await Promise.resolve();
}

describe('CompileManager cached startup', () => {
    beforeEach(() => {
        navigationWarnings.length = 0;
        statusItems.length = 0;
        executedCommands.length = 0;
        shownTextDocuments.length = 0;
        diagnosticClears = 0;
        executeCommand = async () => undefined;
        showTextDocument = async () => undefined;
        vscodeStub.window.activeTextEditor = undefined;
        vscodeStub.window.visibleTextEditors = [];
        vscodeStub.workspace.textDocuments = [];
    });

    afterEach(() => {
        for (const manager of managers.splice(0)) {
            manager.pdfWillOpenTrigger.dispose();
            manager.pdfViewerReadyTrigger.dispose();
            manager.pdfViewDisposedTrigger.dispose();
            manager.sourceDocumentChangedTrigger.dispose();
            manager.sourceDocumentClosedTrigger.dispose();
            manager.sourceEditorChangedTrigger.dispose();
        }
    });

    it('keeps cached startup read-only when compile diagnostics are unavailable', async () => {
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
            outputIdentityGeneration: 0,
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
        assert.equal(diagnosticClears, 1);
        assert.equal(liveCompiles, 0);
        assert.equal(statusItems.at(-1)?.text, 'pdfLaTex');
    });

    it('starts one server compile when no cached startup output exists and permits an unchanged manual recompile', async () => {
        const uri = projectFixture().compileUri;
        let liveCompiles = 0;
        const vfs = {
            outputIdentityGeneration: 0,
            getRootDocName: () => '/main.tex',
            getCompiler: () => ({name: 'pdfLaTex'}),
            adoptCachedCompile: async () => undefined,
            compile: async () => {
                liveCompiles += 1;
                return undefined;
            },
        };
        const manager = createManager(vfs);

        await manager.compile(true, 'initial-project', uri as any);
        assert.equal(liveCompiles, 1);
        assert.equal(statusItems.at(-1)?.text, 'pdfLaTex');
        assert.equal(statusItems.at(-1)?.text.includes('sync'), false);

        await manager.compile(true, 'command', uri as any);
        assert.equal(liveCompiles, 2);
    });

    it('clears old diagnostics when a successful output set has no log', async () => {
        const uri = projectFixture().compileUri;
        const vfs = {
            outputIdentityGeneration: 0,
            getRootDocName: () => '/main.tex',
            getCompiler: () => ({name: 'pdfLaTex'}),
            adoptCachedCompile: async () => successfulOutcome(),
            compile: async () => undefined,
        };
        const manager = createManager(vfs);

        await manager.compile(true, 'initial-project', uri as any);

        assert.equal(diagnosticClears, 1);
        assert.equal(statusItems.at(-1)?.text, 'pdfLaTex');
    });

    it('contains a non-diagnostic cached-output failure without starting a live compile', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        setActiveEditor(fixture.sourceUri);
        let liveCompiles = 0;
        let reverseCalls = 0;
        const vfs = createVfs(successfulOutcome(), actions);
        (vfs as any).adoptCachedCompile = async () => successfulOutcome();
        (vfs as any).compile = async () => {
            liveCompiles += 1;
            return undefined;
        };
        vfs.syncPdf = async () => { reverseCalls += 1; return undefined; };
        const manager = createManager(vfs);
        const viewer = registerPdfViewer(fixture, actions);
        (manager as any).scheduleCompiledPdfRefresh = () => {
            throw new Error('cached PDF publication failed');
        };
        const errors: unknown[][] = [];
        const originalConsoleError = console.error;
        console.error = (...args: unknown[]) => { errors.push(args); };

        try {
            await manager.compile(true, 'initial-project', fixture.compileUri);
            await manager.syncCode();
            await manager.syncPdf(reverseSyncRequest(fixture, viewer));
        } finally {
            console.error = originalConsoleError;
        }

        assert.equal(liveCompiles, 0);
        assert.equal(manager.inCompiling, false);
        assert.match(statusItems.at(-1)?.text ?? '', /\$\(x\)/);
        assert.equal(
            errors.some(args => String(args[0]).includes('Cached compile adoption failed')),
            true,
        );
        assert.deepEqual(actions, []);
        assert.equal(reverseCalls, 0);
        assert.deepEqual(viewer.messages, []);
    });
});

describe('CompileManager automatic forward SyncTeX after compile', () => {
    beforeEach(() => {
        navigationWarnings.length = 0;
        statusItems.length = 0;
        executedCommands.length = 0;
        shownTextDocuments.length = 0;
        diagnosticClears = 0;
        executeCommand = async () => undefined;
        showTextDocument = async () => undefined;
        vscodeStub.window.activeTextEditor = undefined;
        vscodeStub.window.visibleTextEditors = [];
        vscodeStub.workspace.textDocuments = [];
    });

    afterEach(() => {
        for (const manager of managers.splice(0)) {
            manager.pdfWillOpenTrigger.dispose();
            manager.pdfViewerReadyTrigger.dispose();
            manager.pdfViewDisposedTrigger.dispose();
            manager.sourceDocumentChangedTrigger.dispose();
            manager.sourceDocumentClosedTrigger.dispose();
            manager.sourceEditorChangedTrigger.dispose();
        }
    });

    it('restores a PDF and its reverse mapping without saving a dirty recovered draft or compiling', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        const source = setActiveEditor(fixture.sourceUri);
        source.document.isDirty = true;
        const vfs = createVfs(successfulOutcome(), actions);
        let probes = 0;
        (vfs as any).adoptCachedCompile = async (...args: any[]) => {
            assert.equal(args[4], false, 'Preview restoration cannot clear source dirt');
            probes += 1;
            vfs.outputIdentityGeneration += 1;
            return successfulOutcome();
        };
        vfs.compile = async () => { throw new Error('Must not compile'); };
        (vfs as any).syncPdf = async () => ({file: 'main.tex', line: 2});
        const manager = createManager(vfs);
        const viewer = registerPdfViewer(fixture, actions);
        const saveAll = vscodeStub.workspace.saveAll;
        vscodeStub.workspace.saveAll = async () => { throw new Error('Must not save'); };
        try {
            await manager.refreshPdf(viewer.doc as any);
        } finally { vscodeStub.workspace.saveAll = saveAll; }
        assert.equal(probes, 1);
        assert.equal(source.document.isDirty, true);
        assert.equal(viewer.doc.generation, 2);
        assert.deepEqual(actions, ['refresh']);
        const {editor, revealed} = reverseEditor(fixture.sourceUri, ['old', 'source token']);
        await manager.syncPdf(reverseSyncRequest(fixture, viewer));
        assert.deepEqual(editor.selections[0].active, {line: 1, character: 0});
        assert.equal(revealed.length, 1);
    });

    it('retries a failed startup PDF read in the same tab when restoration requests it', async () => {
        const fixture = projectFixture();
        let downloads = 0;
        let probes = 0;
        const vfs = createVfs(successfulOutcome(), []);
        (vfs as any).adoptCachedCompile = async () => { probes += 1; return successfulOutcome(); };
        const manager = createManager(vfs);
        const viewer = registerPdfViewer(fixture, [], {ready: false,
            refresh: async () => ++downloads === 1 ? new Uint8Array() : new Uint8Array([2]),
        });
        await manager.compile(true, 'initial-project', fixture.compileUri);
        await flushAsync();
        assert.equal(viewer.doc.generation, 1);
        fireEvent('pdfViewerReadyEvent', {uri: fixture.pdfUri, webviewPanel: viewer.webviewPanel});
        await manager.refreshPdf(viewer.doc as any);
        assert.equal(downloads, 2);
        assert.equal(probes, 1);
        assert.equal(viewer.doc.generation, 2);
    });

    it('defers PDF restoration until startup completes and coalesces it with that build refresh', async () => {
        const fixture = projectFixture();
        let finishCache!: (outcome: CompileOutcome) => void;
        let probes = 0;
        const actions: string[] = [];
        const vfs = createVfs(successfulOutcome(), actions);
        (vfs as any).adoptCachedCompile = () => {
            probes += 1;
            return new Promise(resolve => { finishCache = resolve; });
        };
        const manager = createManager(vfs);
        const viewer = registerPdfViewer(fixture, actions);
        const starting = manager.compile(true, 'initial-project', fixture.compileUri);
        await flushAsync();
        await manager.refreshPdf(viewer.doc as any);
        assert.deepEqual(actions, []);
        finishCache(successfulOutcome());
        await starting;
        await flushAsync();
        assert.equal(probes, 1);
        assert.deepEqual(actions, ['refresh']);
    });

    it('loads a remote preview during dirty startup without clearing the recovered draft', async () => {
        const fixture = projectFixture();
        setActiveEditor(fixture.sourceUri).document.isDirty = true;
        const vfs = createVfs(successfulOutcome(), []);
        let probes = 0;
        (vfs as any).adoptCachedCompile = async (...args: any[]) => {
            probes += 1;
            assert.equal(args[4], false);
            return successfulOutcome();
        };
        const manager = createManager(vfs);
        const viewer = registerPdfViewer(fixture, [], {initialGeneration: 0});
        const starting = manager.compile(true, 'initial-project', fixture.compileUri);
        await manager.refreshPdf(viewer.doc as any);
        await starting;
        assert.equal(probes, 1);
        assert.equal(viewer.doc.generation, 1);
    });

    it('coalesces repeated reloads while the current PDF download is pending', async () => {
        const fixture = projectFixture();
        const vfs = createVfs(successfulOutcome(), []);
        (vfs as any).adoptCachedCompile = async () => successfulOutcome();
        const manager = createManager(vfs);
        let finishRead!: (bytes: Uint8Array) => void;
        let downloads = 0;
        const viewer = registerPdfViewer(fixture, [], {refresh: async () => {
            downloads += 1;
            return new Promise(resolve => { finishRead = resolve; });
        }});
        const first = manager.refreshPdf(viewer.doc as any);
        await flushAsync();
        const second = manager.refreshPdf(viewer.doc as any);
        finishRead(new Uint8Array([3]));
        await Promise.all([first, second]);
        assert.equal(downloads, 1);
        assert.equal(viewer.doc.generation, 2);
    });

    it('retries startup download failure even when readiness arrived before the failure', async () => {
        const fixture = projectFixture();
        const vfs = createVfs(successfulOutcome(), []);
        (vfs as any).adoptCachedCompile = async () => successfulOutcome();
        const manager = createManager(vfs);
        let finishFirst!: (bytes: Uint8Array) => void;
        let downloads = 0;
        const viewer = registerPdfViewer(fixture, [], {refresh: async () => {
            downloads += 1;
            return downloads === 1 ? new Promise(resolve => { finishFirst = resolve; }) : new Uint8Array([3]);
        }});
        await manager.compile(true, 'initial-project', fixture.compileUri);
        await flushAsync();
        const restoring = manager.refreshPdf(viewer.doc as any);
        finishFirst(new Uint8Array());
        await restoring;
        assert.equal(downloads, 2);
        assert.equal(viewer.doc.generation, 2);
    });

    it('does not publish a restored PDF after its tab has been replaced', async () => {
        const fixture = projectFixture();
        let finishCache!: (outcome: CompileOutcome) => void;
        const actions: string[] = [];
        const vfs = createVfs(successfulOutcome(), actions);
        (vfs as any).adoptCachedCompile = () => new Promise(resolve => { finishCache = resolve; });
        const manager = createManager(vfs);
        const oldViewer = registerPdfViewer(fixture, actions);
        const restoring = manager.refreshPdf(oldViewer.doc as any);
        await flushAsync();
        registerPdfViewer(fixture, actions);
        finishCache(successfulOutcome());
        await restoring;
        assert.deepEqual(actions, []);
        assert.equal(oldViewer.doc.generation, 1);
    });

    it('keeps a stale preview unsyncable after a failed read-only restore', async () => {
        const fixture = projectFixture();
        const vfs = createVfs(successfulOutcome(), []);
        vfs.adoptCachedCompile = async () => { throw new Error('Cache request failed: 401'); };
        let reverseCalls = 0;
        vfs.syncPdf = async () => { reverseCalls += 1; return undefined; };
        const manager = createManager(vfs);
        const viewer = registerPdfViewer(fixture, []);
        await manager.refreshPdf(viewer.doc as any);
        await manager.syncPdf(reverseSyncRequest(fixture, viewer));
        assert.equal(reverseCalls, 0);
    });

    it('does not turn an initial-project notification during preview restore into a queued save/build', async () => {
        const fixture = projectFixture();
        const vfs = createVfs(successfulOutcome(), []);
        const manager = createManager(vfs);
        let liveCompiles = 0;
        vfs.compile = async () => { liveCompiles += 1; return successfulOutcome(); };
        (vfs as any).adoptCachedCompile = async () => {
            await manager.compile(true, 'initial-project', fixture.compileUri);
            return successfulOutcome();
        };
        const viewer = registerPdfViewer(fixture, []);
        await manager.refreshPdf(viewer.doc as any);
        assert.equal(liveCompiles, 0);
        assert.equal(viewer.doc.generation, 2);
    });

    it('rereads a verified current build without replacing it with a potentially older cached build', async () => {
        const fixture = projectFixture();
        const vfs = createVfs(successfulOutcome(), []);
        vfs.outputIdentityGeneration = 3;
        (vfs as any).adoptCachedCompile = async () => { throw new Error('Cache may lag the current build'); };
        const manager = createManager(vfs);
        const viewer = registerPdfViewer(fixture, []);
        await manager.refreshPdf(viewer.doc as any);
        assert.equal(viewer.doc.generation, 2);
        assert.equal(vfs.outputIdentityGeneration, 3);
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

        await manager.compile(true, 'command');
        await flushAsync();

        assert.deepEqual(syncCalls, [['main.tex', 7, 9, false]]);
        assert.deepEqual(actions, ['refresh', 'sync-request', 'syncCode']);
        assert.deepEqual(viewer.messages, [{
            type: 'syncCode',
            content: [{page: 4, h: 5, v: 6}],
            pdfGeneration: 2,
        }]);
        assert.equal(vscodeStub.window.activeTextEditor, editor);
        assert.equal(executedCommands.includes('vscode.openWith'), false);
    });

    it('runs each completed manual compile and captures the cursor from each click', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        const compileCalls: any[][] = [];
        const syncCalls: any[][] = [];
        const editor = setActiveEditor(fixture.sourceUri, 1, 3, 1);
        const vfs = createVfs(successfulOutcome(), actions, async (...args) => {
            syncCalls.push(args);
            return [{page: 1, h: 2, v: 3}];
        });
        vfs.compile = async (...args: any[]) => {
            compileCalls.push(args);
            return successfulOutcome();
        };
        const manager = createManager(vfs);
        registerPdfViewer(fixture, actions);

        await manager.compile(true, 'command');
        await flushAsync();
        editor.selection.active = {line: 8, character: 6};
        await manager.compile(true, 'command');
        await flushAsync();

        assert.equal(compileCalls.length, 2);
        assert.deepEqual(compileCalls.map(call => [call[0], call[4]]), [
            [true, 'manual'],
            [true, 'manual'],
        ]);
        assert.deepEqual(syncCalls, [
            ['main.tex', 2, 3, false],
            ['main.tex', 9, 6, false],
        ]);
    });

    it('keeps at most one pending manual compile and uses its latest click cursor', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        const compileCalls: any[][] = [];
        const syncCalls: any[][] = [];
        const editor = setActiveEditor(fixture.sourceUri, 1, 1, 1);
        let finishFirstCompile!: (outcome: CompileOutcome) => void;
        const firstCompile = new Promise<CompileOutcome>(resolve => {
            finishFirstCompile = resolve;
        });
        const vfs = createVfs(successfulOutcome(), actions, async (...args) => {
            syncCalls.push(args);
            return [{page: 1, h: 2, v: 3}];
        });
        vfs.compile = async (...args: any[]) => {
            compileCalls.push(args);
            return compileCalls.length === 1 ? firstCompile : successfulOutcome();
        };
        const manager = createManager(vfs);
        registerPdfViewer(fixture, actions);

        const compiling = manager.compile(true, 'command');
        await flushAsync();
        editor.selection.active = {line: 4, character: 2};
        await manager.compile(true, 'command');
        editor.selection.active = {line: 11, character: 7};
        await manager.compile(true, 'command');
        finishFirstCompile(successfulOutcome());
        await compiling;
        await flushAsync();

        assert.equal(compileCalls.length, 2);
        assert.deepEqual(compileCalls.map(call => [call[0], call[4]]), [
            [true, 'manual'],
            [true, 'manual'],
        ]);
        assert.deepEqual(syncCalls, [['main.tex', 12, 7, false]]);
    });

    it('keeps compile and PDF viewer state isolated across Overleaf authorities', async () => {
        const identity = {
            userId: 'same-user',
            projectId: 'same-project',
            projectName: 'Same-Project',
        };
        const primary = projectFixture('www.overleaf.com', identity);
        const community = projectFixture('overleaf.example.edu', identity);
        const primaryActions: string[] = [];
        const communityActions: string[] = [];
        setActiveEditor(primary.sourceUri);
        const manager = createManager(createVfs(successfulOutcome(), primaryActions));
        registerPdfViewer(primary, primaryActions);
        registerPdfViewer(community, communityActions);

        await manager.compile(true, 'command', primary.compileUri);
        await flushAsync();

        assert.deepEqual(primaryActions, ['refresh', 'sync-request', 'syncCode']);
        assert.deepEqual(communityActions, []);
    });

    it('keeps reverse SyncTeX state isolated across Overleaf authorities', async () => {
        const identity = {
            userId: 'same-user',
            projectId: 'same-project',
            projectName: 'Same-Project',
        };
        const primary = projectFixture('www.overleaf.com', identity);
        const community = projectFixture('overleaf.example.edu', identity);
        const reverseCalls: any[][] = [];
        const vfs = createVfs(successfulOutcome(), []);
        vfs.syncPdf = async (...args: any[]) => {
            reverseCalls.push(args);
            return undefined;
        };
        const manager = createManager(vfs);
        const primaryViewer = registerPdfViewer(primary, []);
        const communityViewer = registerPdfViewer(community, []);

        await manager.syncPdf(reverseSyncRequest(primary, primaryViewer));
        await manager.syncPdf(reverseSyncRequest(community, communityViewer));

        assert.deepEqual(reverseCalls, [[2, 3, 4], [2, 3, 4]]);
    });

    it('delivers one manual sync requested during an in-flight PDF refresh', async () => {
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

        assert.deepEqual(actions, ['refresh', 'sync-request', 'syncCode']);
        assert.equal(actions.filter(action => action === 'sync-request').length, 1);
        assert.equal(viewer.messages.length, 1);
        assert.equal((viewer.messages as any[]).at(-1)?.pdfGeneration, 2);
    });

    it('drops a refresh-time manual sync when the source version changes', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        let finishRefresh!: (content: Uint8Array) => void;
        const refreshResult = new Promise<Uint8Array>(resolve => {
            finishRefresh = resolve;
        });
        const editor = setActiveEditor(fixture.sourceUri);
        const manager = createManager(createVfs(successfulOutcome(), actions));
        const viewer = registerPdfViewer(fixture, actions, {
            refresh: async () => {
                actions.push('refresh');
                return refreshResult;
            },
        });

        await manager.compile(true, 'command', fixture.compileUri);
        await manager.syncCode();
        editor.document.version += 1;
        fireDocumentChange(editor.document);
        finishRefresh(new Uint8Array([1]));
        await flushAsync();

        assert.deepEqual(actions, ['refresh']);
        assert.deepEqual(viewer.messages, []);
    });

    it('drops a refresh-time manual sync when the source document closes', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        let finishRefresh!: (content: Uint8Array) => void;
        const refreshResult = new Promise<Uint8Array>(resolve => {
            finishRefresh = resolve;
        });
        const editor = setActiveEditor(fixture.sourceUri);
        const manager = createManager(createVfs(successfulOutcome(), actions));
        const viewer = registerPdfViewer(fixture, actions, {
            refresh: async () => {
                actions.push('refresh');
                return refreshResult;
            },
        });

        await manager.compile(true, 'command', fixture.compileUri);
        await manager.syncCode();
        vscodeStub.workspace.textDocuments = [];
        fireDocumentClose(editor.document);
        finishRefresh(new Uint8Array([1]));
        await flushAsync();

        assert.deepEqual(actions, ['refresh']);
        assert.deepEqual(viewer.messages, []);
    });

    it('does not carry a refresh-time manual cursor across failure and viewer reopen', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        let finishRefresh!: (content: Uint8Array) => void;
        const refreshResult = new Promise<Uint8Array>(resolve => {
            finishRefresh = resolve;
        });
        setActiveEditor(fixture.sourceUri);
        const manager = createManager(createVfs(successfulOutcome(), actions));
        registerPdfViewer(fixture, actions, {
            refresh: async () => {
                actions.push('refresh-failed');
                return refreshResult;
            },
        });

        await manager.compile(true, 'command', fixture.compileUri);
        await manager.syncCode();
        finishRefresh(new Uint8Array());
        await flushAsync();

        const replacement = registerPdfViewer(fixture, actions);
        await flushAsync();

        assert.deepEqual(actions, ['refresh-failed', 'refresh']);
        assert.deepEqual(replacement.messages, []);
    });

    it('does not refresh or auto-sync after a failed compile but preserves manual sync', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        const syncCalls: any[][] = [];
        setActiveEditor(fixture.sourceUri);
        const manager = createManager(createVfs(failedOutcome(), actions, async (...args) => {
            syncCalls.push(args);
            return [{page: 1, h: 2, v: 3}];
        }));
        registerPdfViewer(fixture, actions);

        await manager.compile(true, 'command', fixture.compileUri);
        await flushAsync();

        assert.deepEqual(actions, []);
        await manager.syncCode();
        assert.deepEqual(actions, ['sync-request', 'syncCode']);
        assert.deepEqual(syncCalls, [['main.tex', 5, 2, true]]);
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

    it('uses the current cursor when the editor moves during compilation', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        const editor = setActiveEditor(fixture.sourceUri, 2, 3, 1);
        let finishCompile!: (outcome: CompileOutcome) => void;
        const compileResult = new Promise<CompileOutcome>(resolve => {
            finishCompile = resolve;
        });
        const syncCalls: any[][] = [];
        const vfs = createVfs(successfulOutcome(), actions, async (...args) => {
            syncCalls.push(args);
            return [{page: 1, h: 2, v: 3}];
        });
        vfs.compile = async () => compileResult;
        const manager = createManager(vfs);
        registerPdfViewer(fixture, actions);

        const compiling = manager.compile(true, 'command', fixture.compileUri);
        await flushAsync();
        editor.selection.active = {line: 8, character: 1};
        finishCompile(successfulOutcome());
        await compiling;
        await flushAsync();

        assert.deepEqual(actions, ['refresh', 'sync-request', 'syncCode']);
        assert.deepEqual(syncCalls, [['main.tex', 9, 1, false]]);
    });

    for (const focus of ['source', 'PDF before compile', 'PDF during compile']) {
        it(`uses the visible viewport with focus on ${focus}`, async () => {
            const fixture = projectFixture();
            const actions: string[] = [];
            const calls: any[][] = [];
            const editor = setActiveEditor(fixture.sourceUri, 2, 3);
            const range = (start: number, end: number) => ({start: {line: start, character: 0}, end: {line: end, character: 0}});
            editor.visibleRanges = [range(40, 60)];
            if (focus === 'PDF before compile') { vscodeStub.window.activeTextEditor = undefined; }
            const vfs = createVfs(successfulOutcome(), actions, async (...args) => {
                calls.push(args);
                return [{page: 2, h: 2, v: 3}];
            });
            vfs.compile = async () => {
                editor.visibleRanges = [range(80, 100)];
                if (focus === 'PDF during compile') { vscodeStub.window.activeTextEditor = undefined; }
                return successfulOutcome();
            };
            const manager = createManager(vfs);
            registerPdfViewer(fixture, actions);
            await manager.compile(true, 'command', fixture.compileUri);
            await flushAsync();
            assert.deepEqual(calls, [['main.tex', 90, 0, false]]);
            assert.deepEqual(actions, ['refresh', 'sync-request', 'syncCode']);
            assert.equal(shownTextDocuments.length, 0, 'forward sync never steals source focus');
        });
    }

    it('prefers the exact cursor when it remains in a visible source range', async () => {
        const fixture = projectFixture();
        const calls: any[][] = [];
        const editor = setActiveEditor(fixture.sourceUri, 42, 7);
        editor.visibleRanges = [{start: {line: 40, character: 0}, end: {line: 60, character: 0}}];
        const manager = createManager(createVfs(successfulOutcome(), [], async (...args) => {
            calls.push(args);
            return [{page: 1, h: 2, v: 3}];
        }));
        registerPdfViewer(fixture, []);
        await manager.compile(true, 'command');
        await flushAsync();
        assert.deepEqual(calls, [['main.tex', 43, 7, false]]);
    });

    it('selects the viewport after a delayed PDF download, not when the compile ended', async () => {
        const fixture = projectFixture();
        const calls: any[][] = [];
        const editor = setActiveEditor(fixture.sourceUri, 2, 3);
        const manager = createManager(createVfs(successfulOutcome(), [], async (...args) => {
            calls.push(args);
            return [{page: 1, h: 2, v: 3}];
        }));
        let finishRefresh!: (bytes: Uint8Array) => void;
        registerPdfViewer(fixture, [], {refresh: () => new Promise(resolve => { finishRefresh = resolve; })});
        await manager.compile(true, 'command');
        assert.equal(calls.length, 0);
        editor.visibleRanges = [{start: {line: 80, character: 0}, end: {line: 100, character: 0}}];
        finishRefresh(new Uint8Array([1]));
        await flushAsync();
        assert.deepEqual(calls, [['main.tex', 90, 0, false]]);
    });

    it('can navigate to another already-open source from the same compiled project', async () => {
        const fixture = projectFixture();
        const calls: any[][] = [];
        const first = setActiveEditor(fixture.sourceUri);
        const other = setActiveEditor(makeUri(fixture.identifier, ['chapter.tex']), 8, 4);
        vscodeStub.workspace.textDocuments = [first.document, other.document];
        vscodeStub.window.visibleTextEditors = [first, other];
        vscodeStub.window.activeTextEditor = first;
        const vfs = createVfs(successfulOutcome(), [], async (...args) => {
            calls.push(args);
            return [{page: 1, h: 2, v: 3}];
        });
        vfs.compile = async () => { vscodeStub.window.activeTextEditor = other; return successfulOutcome(); };
        const manager = createManager(vfs);
        registerPdfViewer(fixture, []);
        await manager.compile(true, 'command');
        await flushAsync();
        assert.deepEqual(calls, [['chapter.tex', 9, 4, false]]);
    });

    it('does not navigate a background project when the active source belongs to another project', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        const editor = setActiveEditor(fixture.sourceUri);
        const vfs = createVfs(successfulOutcome(), actions);
        vfs.compile = async () => {
            const other = setActiveEditor(projectFixture().sourceUri);
            vscodeStub.workspace.textDocuments = [editor.document, other.document];
            vscodeStub.window.visibleTextEditors = [editor, other];
            return successfulOutcome();
        };
        const manager = createManager(vfs);
        registerPdfViewer(fixture, actions);
        await manager.compile(true, 'command', fixture.compileUri);
        await flushAsync();
        assert.deepEqual(actions, ['refresh']);
    });

    for (const change of ['clean version change', 'dirty edit', 'closed source']) {
        it(`does not treat ${change} during compilation as mere cursor movement`, async () => {
            const fixture = projectFixture();
            const actions: string[] = [];
            const editor = setActiveEditor(fixture.sourceUri);
            const vfs = createVfs(successfulOutcome(), actions);
            vfs.compile = async () => {
                if (change === 'clean version change') { editor.document.version += 1; }
                if (change === 'dirty edit') { editor.document.isDirty = true; }
                if (change === 'closed source') { (editor.document as any).isClosed = true; }
                return successfulOutcome();
            };
            const manager = createManager(vfs);
            registerPdfViewer(fixture, actions);
            await manager.compile(true, 'command');
            await flushAsync();
            assert.deepEqual(actions, ['refresh']);
        });
    }

    it('pins the source after save participants have formatted it, before requesting the compile', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        const editor = setActiveEditor(fixture.sourceUri);
        const saveAll = vscodeStub.workspace.saveAll;
        try {
            vscodeStub.workspace.saveAll = async () => { editor.document.version += 1; return true; };
            const manager = createManager(createVfs(successfulOutcome(), actions));
            registerPdfViewer(fixture, actions);
            await manager.compile(true, 'command');
            await flushAsync();
            assert.deepEqual(actions, ['refresh', 'sync-request', 'syncCode']);
        } finally { vscodeStub.workspace.saveAll = saveAll; }
    });

    it('retries a changed viewport once and does not deliver the old SyncTeX response', async () => {
        const fixture = projectFixture();
        const calls: any[][] = [];
        const editor = setActiveEditor(fixture.sourceUri, 2, 3);
        let finishSync!: (value: any[]) => void;
        const manager = createManager(createVfs(successfulOutcome(), [], async (...args) => {
            calls.push(args);
            return calls.length === 1 ? new Promise(resolve => { finishSync = resolve; }) : [{page: 8, h: 2, v: 3}];
        }));
        const viewer = registerPdfViewer(fixture, []);
        await manager.compile(true, 'command');
        await flushAsync();
        editor.selection.active = {line: 18, character: 4};
        finishSync([{page: 1, h: 2, v: 3}]);
        await flushAsync();
        assert.deepEqual(calls, [['main.tex', 3, 3, false], ['main.tex', 19, 4, false]]);
        assert.deepEqual(viewer.messages.map(message => message.content[0].page), [8]);
    });

    it('does not retry automatic positioning over a newer manual Jump to PDF', async () => {
        const fixture = projectFixture();
        const calls: any[][] = [];
        const editor = setActiveEditor(fixture.sourceUri, 2, 3);
        let finishAutomatic!: (value: any[]) => void;
        const manager = createManager(createVfs(successfulOutcome(), [], async (...args) => {
            calls.push(args);
            return args[3] === false ? new Promise(resolve => { finishAutomatic = resolve; }) : [{page: 9, h: 2, v: 3}];
        }));
        const viewer = registerPdfViewer(fixture, []);
        await manager.compile(true, 'command');
        await flushAsync();
        editor.selection.active = {line: 30, character: 1};
        await manager.syncCode();
        finishAutomatic([{page: 1, h: 2, v: 3}]);
        await flushAsync();
        assert.deepEqual(calls, [['main.tex', 3, 3, false], ['main.tex', 31, 1, true]]);
        assert.deepEqual(viewer.messages.map(message => message.content[0].page), [9]);
    });

    it('skips auto-sync when a different source object has the same URI, version, and cursor', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        const capturedEditor = setActiveEditor(fixture.sourceUri, 2, 3, 1);
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
        const replacementEditor = setActiveEditor(fixture.sourceUri, 2, 3, 1);
        vscodeStub.workspace.textDocuments = [
            capturedEditor.document,
            replacementEditor.document,
        ];
        finishCompile(successfulOutcome());
        await compiling;
        await flushAsync();

        assert.deepEqual(actions, ['refresh']);
    });

    it('skips auto-sync when the captured source object leaves the workspace document set', async () => {
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
        vscodeStub.workspace.textDocuments = [];
        assert.equal(vscodeStub.window.activeTextEditor, editor);
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

    it('keeps the old PDF unsyncable after stop even when output identity has not changed yet', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        setActiveEditor(fixture.sourceUri);
        let reverseCalls = 0;
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
        vfs.syncPdf = async () => { reverseCalls += 1; return undefined; };
        const manager = createManager(vfs);
        const viewer = registerPdfViewer(fixture, actions);

        const compiling = manager.compile(true, 'command', fixture.compileUri);
        await flushAsync();
        await manager.stopCompile();
        await manager.syncCode();
        await manager.syncPdf(reverseSyncRequest(fixture, viewer));
        finishCompile(successfulOutcome());
        await compiling;
        await flushAsync();

        assert.deepEqual(actions, []);
        assert.equal(reverseCalls, 0);
        assert.deepEqual(viewer.messages, []);
    });

    it('keeps the old PDF unsyncable when output identity changes before stop', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        setActiveEditor(fixture.sourceUri);
        let finishCompile!: (outcome: CompileOutcome) => void;
        const compileResult = new Promise<CompileOutcome>(resolve => {
            finishCompile = resolve;
        });
        let reverseCalls = 0;
        const vfs = createVfs(successfulOutcome(), actions);
        vfs.compile = async (...args: any[]) => {
            args[6]?.();
            return compileResult;
        };
        vfs.stopCompile = async () => true;
        vfs.syncPdf = async () => { reverseCalls += 1; return undefined; };
        const manager = createManager(vfs);
        const viewer = registerPdfViewer(fixture, actions, {
            refresh: async () => {
                actions.push('recovery-refresh-failed');
                return new Uint8Array();
            },
        });

        const compiling = manager.compile(true, 'command', fixture.compileUri);
        await flushAsync();
        vfs.outputIdentityGeneration += 1;
        await manager.stopCompile();
        await flushAsync();
        await manager.syncCode();
        await manager.syncPdf(reverseSyncRequest(fixture, viewer));
        finishCompile(successfulOutcome());
        await compiling;
        await flushAsync();

        assert.deepEqual(actions, []);
        assert.equal(reverseCalls, 0);
        assert.deepEqual(viewer.messages, []);
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

    it('starts a newer compile while an older PDF download is pending and reloads the current build', async () => {
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

        assert.deepEqual(actions, ['old-refresh', 'old-refresh', 'sync-request', 'syncCode']);
        assert.equal(viewer.doc.generation, 2);
    });

    for (const [label, laterOutcome] of [
        ['failed', failedOutcome()],
        ['no-op', undefined],
    ] as const) {
        it(`reloads an unresolved build after a later ${label} compile`, async () => {
            const fixture = projectFixture();
            const actions: string[] = [];
            let compileCount = 0;
            let reverseCalls = 0;
            const vfs = createVfs(successfulOutcome(), actions);
            (vfs as any).compile = async () => {
                compileCount += 1;
                return compileCount === 1 ? successfulOutcome() : laterOutcome;
            };
            vfs.syncPdf = async () => { reverseCalls += 1; return undefined; };
            const manager = createManager(vfs);

            // PDF A began opening without a record. Build B commits, then C
            // fails or does nothing before A finishes registering.
            await manager.compile(true, 'command', fixture.compileUri);
            await manager.compile(true, 'command', fixture.compileUri);
            const viewer = registerPdfViewer(fixture, actions, {initialGeneration: 1});
            await flushAsync();
            setActiveEditor(fixture.sourceUri);
            await manager.syncCode();
            await manager.syncPdf(reverseSyncRequest(fixture, viewer, 2));

            assert.deepEqual(actions, ['refresh', 'sync-request', 'syncCode']);
            assert.equal(viewer.doc.generation, 2);
            assert.equal(reverseCalls, 1);
        });
    }

    it('reloads the current build when the old PDF registers before a later compile fails', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        let finishLaterCompile!: (outcome: CompileOutcome) => void;
        const laterCompile = new Promise<CompileOutcome>(resolve => {
            finishLaterCompile = resolve;
        });
        let compileCount = 0;
        const vfs = createVfs(successfulOutcome(), actions);
        vfs.compile = async () => {
            compileCount += 1;
            return compileCount === 1 ? successfulOutcome() : laterCompile;
        };
        const manager = createManager(vfs);

        // PDF A has no record when build B commits. It finishes registering
        // while compile C is active, before C reports failure.
        await manager.compile(true, 'command', fixture.compileUri);
        const compiling = manager.compile(true, 'command', fixture.compileUri);
        await flushAsync();
        const viewer = registerPdfViewer(fixture, actions, {initialGeneration: 1});
        setActiveEditor(fixture.sourceUri);
        await manager.syncCode();
        assert.deepEqual(actions, []);

        finishLaterCompile(failedOutcome());
        await compiling;
        await flushAsync();
        await manager.syncCode();

        assert.deepEqual(actions, ['refresh', 'sync-request', 'syncCode']);
        assert.equal(viewer.doc.generation, 2);
    });

    it('does not restore an old PDF when a server compile changes output identity before throwing', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        let reverseCalls = 0;
        const vfs = createVfs(successfulOutcome(), actions);
        vfs.compile = async () => {
            vfs.outputIdentityGeneration += 1;
            throw new Error('output publication failed');
        };
        vfs.syncPdf = async () => { reverseCalls += 1; return undefined; };
        const manager = createManager(vfs);
        const viewer = registerPdfViewer(fixture, actions, {
            refresh: async () => {
                actions.push('recovery-refresh-failed');
                return new Uint8Array();
            },
        });

        await manager.compile(true, 'command', fixture.compileUri);
        await flushAsync();
        setActiveEditor(fixture.sourceUri);
        await manager.syncCode();
        await manager.syncPdf(reverseSyncRequest(fixture, viewer, 1));

        assert.deepEqual(actions, ['recovery-refresh-failed']);
        assert.equal(reverseCalls, 0);
        assert.deepEqual(viewer.messages, []);
    });

    it('does not restore an old PDF after cached adoption mutates output identity then falls back', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        let reverseCalls = 0;
        const vfs = createVfs(successfulOutcome(), actions);
        vfs.adoptCachedCompile = async () => {
            try {
                vfs.outputIdentityGeneration += 1;
                throw new Error('cached output publication failed');
            } catch {
                return undefined;
            }
        };
        (vfs as any).compile = async () => undefined;
        vfs.syncPdf = async () => { reverseCalls += 1; return undefined; };
        const manager = createManager(vfs);
        const viewer = registerPdfViewer(fixture, actions, {
            refresh: async () => {
                actions.push('recovery-refresh-failed');
                return new Uint8Array();
            },
        });

        await manager.compile(true, 'initial-project', fixture.compileUri);
        await flushAsync();
        setActiveEditor(fixture.sourceUri);
        await manager.syncCode();
        await manager.syncPdf(reverseSyncRequest(fixture, viewer, 1));

        assert.deepEqual(actions, ['recovery-refresh-failed']);
        assert.equal(reverseCalls, 0);
        assert.deepEqual(viewer.messages, []);
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

    it('navigates from the PDF button after source focus is lost without saving or compiling', async () => {
        const fixture = projectFixture();
        const source = setActiveEditor(fixture.sourceUri, 12, 8);
        const actions: string[] = [];
        const calls: any[][] = [];
        const manager = createManager(createVfs(successfulOutcome(), actions, async (...args) => {
            calls.push(args); return [{page: 2, h: 3, v: 4}];
        }));
        const viewer = registerPdfViewer(fixture, actions);
        vscodeStub.window.activeTextEditor = undefined;
        await manager.syncCodeFromPdf(reverseSyncRequest(fixture, viewer));
        assert.deepEqual(calls, [['main.tex', 13, 8, true]]);
        assert.deepEqual(actions, ['sync-request', 'syncCode']);
        assert.deepEqual(source.selection.active, {line: 12, character: 8});
        assert.deepEqual(executedCommands, []);
        assert.deepEqual(shownTextDocuments, []);
    });

    it('uses only the clicked PDF project even if another project source was last active', async () => {
        const fixture = projectFixture();
        const other = projectFixture();
        const source = setActiveEditor(fixture.sourceUri, 10, 4);
        const otherSource = setActiveEditor(other.sourceUri, 1, 0);
        vscodeStub.window.visibleTextEditors = [otherSource, source];
        vscodeStub.workspace.textDocuments.push(source.document);
        const actions: string[] = [];
        const manager = createManager(createVfs(successfulOutcome(), actions));
        const viewer = registerPdfViewer(fixture, actions);
        const otherViewer = registerPdfViewer(other, actions);
        vscodeStub.window.activeTextEditor = undefined;
        await manager.syncCodeFromPdf(reverseSyncRequest(fixture, viewer));
        assert.equal(viewer.messages.length, 1);
        assert.deepEqual(otherViewer.messages, []);
        vscodeStub.window.visibleTextEditors = [otherSource];
        actions.length = 0;
        await manager.syncCodeFromPdf(reverseSyncRequest(fixture, viewer));
        assert.deepEqual(actions, []);
        assert.equal(navigationWarnings.length, 1);
    });

    it('remembers the last selected source among multiple visible TeX files', async () => {
        const fixture = projectFixture();
        const first = setActiveEditor(fixture.sourceUri, 2, 0);
        const manager = createManager(createVfs(successfulOutcome(), []));
        const second = setActiveEditor(makeUri(fixture.identifier, ['chapter.tex']), 5, 3);
        vscodeStub.window.visibleTextEditors.push(first);
        vscodeStub.workspace.textDocuments.push(first.document);
        const calls: any[][] = [];
        (manager as any).vfsm.prefetch = async () => ({getRootDocName: () => '/main.tex',
            syncCode: async (...args: any[]) => { calls.push(args); return [{page: 1}]; }});
        for (const listener of activeEditorListeners) { listener(second); listener(undefined); }
        vscodeStub.window.activeTextEditor = undefined;
        const viewer = registerPdfViewer(fixture, []);
        await manager.syncCodeFromPdf(reverseSyncRequest(fixture, viewer));
        assert.deepEqual(calls, [['chapter.tex', 6, 3, true]]);
    });

    it('does not guess among source editors after a restart with no selected source', async () => {
        const fixture = projectFixture();
        const first = setActiveEditor(fixture.sourceUri);
        const second = setActiveEditor(makeUri(fixture.identifier, ['chapter.tex']));
        vscodeStub.window.visibleTextEditors.push(first);
        vscodeStub.workspace.textDocuments.push(first.document);
        vscodeStub.window.activeTextEditor = undefined;
        const actions: string[] = [];
        const manager = createManager(createVfs(successfulOutcome(), actions));
        const viewer = registerPdfViewer(fixture, actions);
        await manager.syncCodeFromPdf(reverseSyncRequest(fixture, viewer));
        assert.deepEqual(actions, []);
        assert.equal(navigationWarnings.length, 1);
        assert.notEqual(first, second);
    });

    for (const change of ['cursor', 'document', 'hidden', 'generation', 'replacement'] as const) {
        it(`drops a delayed PDF button forward response after ${change} changes`, async () => {
            const fixture = projectFixture();
            const source = setActiveEditor(fixture.sourceUri);
            let finish!: (value: any) => void;
            const actions: string[] = [];
            const manager = createManager(createVfs(successfulOutcome(), actions,
                () => new Promise(resolve => { finish = resolve; })));
            const viewer = registerPdfViewer(fixture, actions);
            vscodeStub.window.activeTextEditor = undefined;
            const request = manager.syncCodeFromPdf(reverseSyncRequest(fixture, viewer));
            await flushAsync();
            if (change === 'cursor') { source.selection.active.line += 1; }
            if (change === 'document') { source.document.version += 1; }
            if (change === 'hidden') { vscodeStub.window.visibleTextEditors = []; }
            if (change === 'generation') { viewer.doc.generation += 1; }
            if (change === 'replacement') { registerPdfViewer(fixture, actions); }
            finish([{page: 1, h: 2, v: 3}]);
            await request;
            assert.deepEqual(viewer.messages, []);
        });
    }

    it('rejects stale generations and replaced viewer button requests with a useful warning', async () => {
        const fixture = projectFixture();
        setActiveEditor(fixture.sourceUri);
        const actions: string[] = [];
        const manager = createManager(createVfs(successfulOutcome(), actions));
        const viewer = registerPdfViewer(fixture, actions);
        await manager.syncCodeFromPdf(reverseSyncRequest(fixture, viewer, 999));
        await manager.syncPdf({...reverseSyncRequest(fixture, viewer, 999), fromButton: true});
        registerPdfViewer(fixture, actions);
        await manager.syncCodeFromPdf(reverseSyncRequest(fixture, viewer));
        assert.deepEqual(actions, []);
        assert.equal(navigationWarnings.length, 3);
    });

    it('reverse-syncs only from the exact ready PDF generation', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        const reverseCalls: any[][] = [];
        const vfs = createVfs(successfulOutcome(), actions);
        (vfs as any).syncPdf = async (...args: any[]) => {
            reverseCalls.push(args);
            return {file: 'main.tex', line: 1, column: 0};
        };
        const manager = createManager(vfs);
        const viewer = registerPdfViewer(fixture, actions);

        const {editor, revealed} = reverseEditor(fixture.sourceUri, ['the source token']);
        await manager.syncPdf(reverseSyncRequest(fixture, viewer));

        assert.deepEqual(reverseCalls, [[2, 3, 4]]);
        assert.equal(shownTextDocuments.length, 1);
        assert.deepEqual(editor.selections[0].active, {line: 0, character: 4});
        assert.equal(revealed[0][0].startLine, 0);
        assert.equal(revealed[0][0].startCharacter, 4);
    });

    for (const hint of ['(', '[', 'a+b', 'x.*', '\\alpha', 'a\nb', '', undefined]) {
        it(`reveals the SyncTeX line using a literal PDF hint ${JSON.stringify(hint)}`, async () => {
            const fixture = projectFixture();
            const vfs = createVfs(successfulOutcome(), []);
            (vfs as any).syncPdf = async () => ({file: './main.tex', line: 2});
            const manager = createManager(vfs);
            const viewer = registerPdfViewer(fixture, []);
            const {editor, revealed} = reverseEditor(fixture.sourceUri,
                ['first line', `prefix ${hint === 'a\nb' ? 'a   b' : hint ?? ''} suffix`]);
            const secondary = {active: {line: 0, character: 2}};
            editor.selections = [{active: {line: 0, character: 0}}, secondary];
            await manager.syncPdf({...reverseSyncRequest(fixture, viewer), identifier: hint});
            assert.deepEqual(editor.selections[0].active, {line: 1, character: hint ? 7 : 0});
            assert.equal(editor.selections[1], secondary);
            assert.equal(revealed.length, 1);
        });
    }

    it('reveals the new source line after compilation and forward positioning', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        setActiveEditor(fixture.sourceUri);
        const vfs = createVfs(successfulOutcome(), actions);
        (vfs as any).syncPdf = async () => ({file: 'main.tex', line: 2});
        const manager = createManager(vfs);
        const viewer = registerPdfViewer(fixture, actions);
        await manager.compile(true, 'command', fixture.compileUri);
        await flushAsync();
        assert.deepEqual(actions, ['refresh', 'sync-request', 'syncCode']);
        assert.equal(viewer.doc.generation, 2);
        const webview = await createPdfViewerHarness();
        await webview.load(viewer.doc.generation);
        for (const message of viewer.messages) { webview.send(message); }
        await webview.settle();
        assert.equal(webview.destinations.length, 1);
        webview.doubleClick(pdfPage().span);
        const click = webview.messages.find(message => message.type === 'syncPdf');
        assert.ok(click, 'The production double-click handler must emit the reverse request');
        const {editor, revealed} = reverseEditor(fixture.sourceUri, ['old position', 'new source token']);
        await manager.syncPdf({...click.content, uri: fixture.pdfUri, webviewPanel: viewer.webviewPanel});
        assert.deepEqual(editor.selections[0].active, {line: 1, character: 4});
        assert.equal(revealed.length, 1);
    });

    it('lets double-click navigation supersede a delayed automatic forward response', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        setActiveEditor(fixture.sourceUri);
        let finishForward!: (result: any[]) => void;
        const vfs = createVfs(successfulOutcome(), actions,
            () => new Promise(resolve => { finishForward = resolve; }));
        (vfs as any).syncPdf = async () => ({file: 'main.tex', line: 2});
        const manager = createManager(vfs);
        const viewer = registerPdfViewer(fixture, actions);
        await manager.compile(true, 'command', fixture.compileUri);
        await flushAsync();
        const {revealed} = reverseEditor(fixture.sourceUri, ['old', 'source token']);
        await manager.syncPdf(reverseSyncRequest(fixture, viewer));
        finishForward([{page: 1, h: 2, v: 3}]);
        await flushAsync();
        assert.equal(revealed.length, 1);
        assert.deepEqual(viewer.messages, []);
        assert.deepEqual(actions, ['refresh', 'sync-request']);
    });

    it('ignores an older double-click response after a newer double-click has revealed its line', async () => {
        const fixture = projectFixture();
        let finishFirst!: (result: any) => void;
        let calls = 0;
        const vfs = createVfs(successfulOutcome(), []);
        (vfs as any).syncPdf = async () => ++calls === 1
            ? new Promise(resolve => { finishFirst = resolve; }) : {file: 'main.tex', line: 2};
        const manager = createManager(vfs);
        const viewer = registerPdfViewer(fixture, []);
        const {editor, revealed} = reverseEditor(fixture.sourceUri, ['old', 'source token']);
        const first = manager.syncPdf(reverseSyncRequest(fixture, viewer));
        await flushAsync();
        await manager.syncPdf(reverseSyncRequest(fixture, viewer));
        finishFirst({file: 'main.tex', line: 1});
        await first;
        assert.deepEqual(editor.selections[0].active, {line: 1, character: 0});
        assert.equal(revealed.length, 1);
        assert.equal(shownTextDocuments.length, 1);
    });

    it('ignores a delayed reverse response after a newer manual Jump to PDF', async () => {
        const fixture = projectFixture();
        setActiveEditor(fixture.sourceUri);
        let finishReverse!: (result: any) => void;
        const vfs = createVfs(successfulOutcome(), []);
        (vfs as any).syncPdf = () => new Promise(resolve => { finishReverse = resolve; });
        const manager = createManager(vfs);
        const viewer = registerPdfViewer(fixture, []);
        const reverse = manager.syncPdf(reverseSyncRequest(fixture, viewer));
        await flushAsync();
        await manager.syncCode();
        finishReverse({file: 'main.tex', line: 1});
        await reverse;
        assert.equal(viewer.messages.length, 1);
        assert.deepEqual(shownTextDocuments, []);
    });

    it('blocks reverse SyncTeX while the current-build PDF refresh is in flight', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        let finishRefresh!: (content: Uint8Array) => void;
        const refreshResult = new Promise<Uint8Array>(resolve => {
            finishRefresh = resolve;
        });
        let reverseCalls = 0;
        const vfs = createVfs(successfulOutcome(), actions);
        vfs.syncPdf = async () => { reverseCalls += 1; return undefined; };
        const manager = createManager(vfs);
        const viewer = registerPdfViewer(fixture, actions, {
            refresh: async () => {
                actions.push('refresh');
                return refreshResult;
            },
        });

        await manager.compile(true, 'command', fixture.compileUri);
        await manager.syncPdf(reverseSyncRequest(fixture, viewer, 1));

        assert.equal(reverseCalls, 0);
        finishRefresh(new Uint8Array([1]));
        await flushAsync();
    });

    it('blocks reverse SyncTeX after a failed PDF refresh', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        let reverseCalls = 0;
        const vfs = createVfs(successfulOutcome(), actions);
        vfs.syncPdf = async () => { reverseCalls += 1; return undefined; };
        const manager = createManager(vfs);
        const viewer = registerPdfViewer(fixture, actions, {
            refresh: async () => new Uint8Array(),
        });

        await manager.compile(true, 'command', fixture.compileUri);
        await flushAsync();
        await manager.syncPdf(reverseSyncRequest(fixture, viewer, 1));

        assert.equal(reverseCalls, 0);
    });

    it('rejects an old PDF generation after a newer PDF is loaded', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        let reverseCalls = 0;
        const vfs = createVfs(successfulOutcome(), actions);
        vfs.syncPdf = async () => { reverseCalls += 1; return undefined; };
        const manager = createManager(vfs);
        const viewer = registerPdfViewer(fixture, actions);

        await manager.compile(true, 'command', fixture.compileUri);
        await flushAsync();
        await manager.syncPdf(reverseSyncRequest(fixture, viewer, 1));

        assert.equal(viewer.doc.generation, 2);
        assert.equal(reverseCalls, 0);
    });

    it('rejects reverse SyncTeX from a replaced or disposed viewer', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        let reverseCalls = 0;
        const vfs = createVfs(successfulOutcome(), actions);
        vfs.syncPdf = async () => { reverseCalls += 1; return undefined; };
        const manager = createManager(vfs);
        const oldViewer = registerPdfViewer(fixture, actions);
        const replacement = registerPdfViewer(fixture, actions);

        await manager.syncPdf(reverseSyncRequest(fixture, oldViewer));
        fireEvent('pdfViewDisposedEvent', {
            uri: fixture.pdfUri,
            webviewPanel: replacement.webviewPanel,
        });
        await manager.syncPdf(reverseSyncRequest(fixture, replacement));

        assert.equal(reverseCalls, 0);
    });

    it('rechecks the PDF generation after the reverse SyncTeX response', async () => {
        const fixture = projectFixture();
        const actions: string[] = [];
        let finishReverse!: (result: any) => void;
        const reverseResult = new Promise<any>(resolve => {
            finishReverse = resolve;
        });
        const vfs = createVfs(successfulOutcome(), actions);
        vfs.syncPdf = async () => reverseResult;
        const manager = createManager(vfs);
        const viewer = registerPdfViewer(fixture, actions);

        const syncing = manager.syncPdf(reverseSyncRequest(fixture, viewer));
        await flushAsync();
        registerPdfViewer(fixture, actions);
        finishReverse({file: 'main.tex', line: 1, column: 0});
        await syncing;

        assert.deepEqual(shownTextDocuments, []);
    });
});

describe('CompileManager command arguments and main-document preview selection', () => {
    let disposables: {dispose(): void}[] = [];
    let saves = 0;
    const saveAll = vscodeStub.workspace.saveAll;

    beforeEach(() => {
        inspectCompileRoot = resolveCompileRootDocId;
        registeredCommands.clear();
        saveListeners.clear();
        navigationWarnings.length = 0;
        executedCommands.length = 0;
        saves = 0;
        vscodeStub.workspace.saveAll = async () => { saves += 1; return true; };
        vscodeStub.window.activeTextEditor = undefined;
        vscodeStub.window.visibleTextEditors = [];
        vscodeStub.workspace.textDocuments = [];
        executeCommand = async () => undefined;
    });

    afterEach(() => {
        for (const disposable of disposables) { disposable.dispose(); }
        disposables = [];
        for (const manager of managers.splice(0)) {
            manager.pdfWillOpenTrigger.dispose();
            manager.pdfViewerReadyTrigger.dispose();
            manager.pdfViewDisposedTrigger.dispose();
            manager.sourceDocumentChangedTrigger.dispose();
            manager.sourceDocumentClosedTrigger.dispose();
            manager.sourceEditorChangedTrigger.dispose();
        }
        inspectCompileRoot = async () => undefined;
        vscodeStub.workspace.saveAll = saveAll;
    });

    function setup() {
        const fixture = projectFixture();
        const reply = makeUri(fixture.identifier, ['reply2.tex']);
        const chapter = makeUri(fixture.identifier, ['chapter.tex']);
        const files: Record<string, string> = {
            'main.tex': '\\documentclass{article}\n\\begin{document}Main\\end{document}',
            'reply2.tex': '\\documentclass{article}\n\\begin{document}Reply\\end{document}',
            'chapter.tex': '% \\documentclass{article}\n\\section{Chapter}',
        };
        const calls: any[][] = [];
        let publishedRoot: string | undefined;
        const vfs: any = {
            ...createVfs(successfulOutcome(), []),
            _resolveUri: async (uri: any) => ({fileType: 'doc', fileId: uri.pathParts.join('/')}),
            openFile: async (uri: any) => new TextEncoder().encode(files[uri.pathParts.join('/')] ?? ''),
            compile: async (...args: any[]) => {
                calls.push(args);
                if (args[5]()) {
                    publishedRoot = args[3];
                    vfs.outputIdentityGeneration += 1;
                }
                return successfulOutcome();
            },
        };
        const manager = createManager(vfs);
        disposables.push(...manager.triggers);
        const command = registeredCommands.get('overleaf-workshop.compileManager.compile')!;
        const select = async (uri: any) => {
            const editor = setActiveEditor(uri);
            for (const listener of activeEditorListeners) { listener(editor); }
            await flushAsync();
            return editor;
        };
        return {fixture, reply, chapter, files, calls, vfs, manager, command, select,
            publishedRoot: () => publishedRoot};
    }

    it('executes the actual editor-title callback with (resourceUri, editorContext), twice without edits', async () => {
        const s = setup();
        setActiveEditor(s.fixture.sourceUri);
        await s.command(s.reply, {groupId: 1});
        await s.command(s.reply, {groupId: 1});
        assert.deepEqual(s.calls.map(args => [args[0], args[3], args[4]]),
            [[true, 'reply2.tex', 'manual'], [true, 'reply2.tex', 'manual']]);
        assert.equal(saves, 2);
    });

    it('supports the palette, malformed non-resource context, and internal startup callback contracts', async () => {
        const s = setup();
        setActiveEditor(s.fixture.sourceUri);
        await s.command();
        await s.command({groupId: 1}, {groupId: 2});
        await s.command('initial-project', makeUri(s.fixture.identifier, []));
        assert.deepEqual(s.calls.map(args => [args[3], args[4]]),
            [['main.tex', 'manual'], ['main.tex', 'manual'], ['main.tex', 'automatic']]);
        assert.equal(saves, 2);
    });

    it('keeps save-triggered compilation registered and automatic', async () => {
        const s = setup();
        s.vfs.isInvisibleMode = false;
        const editor = setActiveEditor(s.fixture.sourceUri);
        Object.assign(editor.document, {fileName: editor.document.uri.path});
        for (const listener of saveListeners) { await listener(editor.document); }
        await flushAsync();
        assert.equal(s.calls.length, 1);
        assert.equal(s.calls[0][4], 'automatic');
    });

    it('adopts only the active main target on first restored PDF open', async () => {
        const s = setup();
        setActiveEditor(s.reply);
        const roots: string[] = [];
        s.vfs.adoptCachedCompile = async (...args: any[]) => {
            roots.push(args[2]);
            assert.equal(args[4], false);
            return successfulOutcome();
        };
        const viewer = registerPdfViewer(s.fixture, [], {initialGeneration: 0});
        await s.manager.refreshPdf(viewer.doc as any);
        assert.deepEqual(roots, ['reply2.tex']);
        assert.equal(viewer.doc.generation, 1);
        assert.equal(s.calls.length, 0);
        assert.equal(saves, 0);
    });

    it('compiles a missing initial PDF once and retains the same side panel', async () => {
        const s = setup();
        setActiveEditor(s.reply);
        const viewer = registerPdfViewer(s.fixture, [], {initialGeneration: 0});
        await s.manager.refreshPdf(viewer.doc as any);
        await s.manager.refreshPdf(viewer.doc as any);
        assert.equal(s.calls.length, 1);
        assert.equal(s.calls[0][3], 'reply2.tex');
        assert.equal(s.calls[0][4], 'automatic');
        assert.equal(saves, 0);
        assert.equal(executedCommands.includes('vscode.openWith'), false);
        assert.ok(viewer.doc.generation > 0);
    });

    for (const trigger of ['initial-project', 'active-root', 'preview'] as const) {
        it(`does not save or compile dirty recovered/unbound project drafts during ${trigger}`, async () => {
            const s = setup();
            const editor = setActiveEditor(s.reply);
            editor.document.isDirty = true;
            await s.manager.compile(true, trigger, s.reply);
            assert.equal(saves, 0);
            assert.equal(s.calls.length, 0);
            assert.equal(editor.document.isDirty, true);
            assert.ok(navigationWarnings.some(message => message.includes('unsaved')));
        });
    }

    it('does not retry failed automatic builds on viewer readiness; an explicit retry is bounded to one build', async () => {
        const s = setup();
        setActiveEditor(s.fixture.sourceUri);
        let builds = 0;
        s.vfs.compile = async () => { builds += 1; return failedOutcome(); };
        const viewer = registerPdfViewer(s.fixture, [], {initialGeneration: 0});
        await s.command('initial-project', s.fixture.compileUri);
        await s.manager.refreshPdf(viewer.doc as any);
        await s.manager.refreshPdf(viewer.doc as any);
        assert.equal(builds, 1);
        await s.manager.refreshPdf(viewer.doc as any, true);
        assert.equal(builds, 2);
        assert.equal(saves, 0);
    });

    for (const message of ['401: Unauthorized', '403: Forbidden', 'Network offline', '503: Unavailable']) {
        it(`does not turn a cache query failure into compilation: ${message}`, async () => {
            const s = setup();
            setActiveEditor(s.reply);
            s.vfs.adoptCachedCompile = async () => { throw new Error(message); };
            const viewer = registerPdfViewer(s.fixture, []);
            await s.command('initial-project', s.reply);
            await s.manager.refreshPdf(viewer.doc as any);
            assert.equal(s.calls.length, 0);
            assert.equal(saves, 0);
            assert.equal(viewer.doc.generation, 1);
            assert.ok(navigationWarnings.length > 0);
        });
    }

    it('keeps a cached PDF download failure as a download retry, never a fresh compile', async () => {
        const s = setup();
        setActiveEditor(s.reply);
        s.vfs.adoptCachedCompile = async () => successfulOutcome();
        const viewer = registerPdfViewer(s.fixture, [], {refresh: async () => new Uint8Array()});
        await s.command('initial-project', s.reply);
        await flushAsync();
        await s.manager.refreshPdf(viewer.doc as any, true);
        assert.equal(s.calls.length, 0);
        assert.equal(viewer.doc.generation, 1);
    });

    it('follows standalone roots but keeps the selected root for chapter tabs and chapter saves', async () => {
        const s = setup();
        registerPdfViewer(s.fixture, []);
        await s.select(s.fixture.sourceUri);
        await s.select(s.reply);
        await s.select(s.chapter);
        assert.deepEqual(s.calls.map(args => args[3]), ['main.tex', 'reply2.tex']);
        assert.equal(saves, 0);
        await s.manager.compile(false, 'save', s.chapter);
        assert.equal(s.calls.at(-1)![3], 'reply2.tex');
        assert.equal(saves, 1);
    });

    it('reselects the current main after closing the preview and switching TeX tabs', async () => {
        const s = setup();
        const old = registerPdfViewer(s.fixture, []);
        await s.select(s.fixture.sourceUri);
        fireEvent('pdfViewDisposedEvent', {uri: s.fixture.pdfUri, webviewPanel: old.webviewPanel});
        await s.select(s.reply);
        const viewer = registerPdfViewer(s.fixture, [], {initialGeneration: 0});
        await s.manager.refreshPdf(viewer.doc as any);
        assert.equal(s.calls.at(-1)![3], 'reply2.tex');
        assert.equal(viewer.doc.generation, 1);
        assert.equal(saves, 0);
    });

    it('uses View Compiled PDF to retry an already-open failed preview without saving', async () => {
        const s = setup();
        setActiveEditor(s.reply);
        let builds = 0;
        s.vfs.compile = async () => ++builds === 1 ? failedOutcome() : successfulOutcome();
        const viewer = registerPdfViewer(s.fixture, [], {initialGeneration: 0});
        await s.manager.refreshPdf(viewer.doc as any);
        assert.equal(builds, 1);
        await registeredCommands.get('overleaf-workshop.compileManager.viewPdf')!();
        assert.equal(builds, 2);
        assert.equal(viewer.doc.generation, 1);
        assert.equal(saves, 0);
        assert.equal(executedCommands.filter(command => command === 'vscode.openWith').length, 1);
    });

    it('abandons a root inspection if the side preview was closed during the read', async () => {
        const s = setup();
        let release!: () => void;
        const read = s.vfs.openFile;
        s.vfs.openFile = async (uri: any) => {
            await new Promise<void>(resolve => { release = resolve; });
            return read(uri);
        };
        const viewer = registerPdfViewer(s.fixture, []);
        await s.select(s.reply);
        fireEvent('pdfViewDisposedEvent', {uri: s.fixture.pdfUri, webviewPanel: viewer.webviewPanel});
        release();
        await flushAsync();
        assert.equal(s.calls.length, 0);
        assert.equal(saves, 0);
    });

    it('does not publish an obsolete root-inspection error over the current preview', async () => {
        const s = setup();
        let reject!: (error: Error) => void;
        const read = s.vfs.openFile;
        s.vfs.openFile = async (uri: any) => {
            if (uri.pathParts[0] === 'reply2.tex') {
                return new Promise((_resolve, rejectRead) => { reject = rejectRead; });
            }
            return read(uri);
        };
        registerPdfViewer(s.fixture, []);
        await s.select(s.reply);
        await s.select(s.fixture.sourceUri);
        reject(new Error('Old lookup lost its connection'));
        await flushAsync();
        assert.equal(navigationWarnings.length, 0);
        assert.deepEqual(s.calls.map(args => args[3]), ['main.tex']);
    });

    it('fences a slow A build and preserves preview intent for the latest A-B-A selection', async () => {
        const s = setup();
        const publications: string[] = [];
        let release!: () => void;
        s.vfs.compile = async (...args: any[]) => {
            s.calls.push(args);
            if (s.calls.length === 1) { await new Promise<void>(resolve => { release = resolve; }); }
            if (args[5]()) {
                publications.push(args[3]);
                s.vfs.outputIdentityGeneration += 1;
            }
            return successfulOutcome();
        };
        const viewer = registerPdfViewer(s.fixture, [], {initialGeneration: 0});
        await s.select(s.fixture.sourceUri);
        await s.select(s.reply);
        await s.select(s.fixture.sourceUri);
        assert.equal(s.calls[0][5](), false, 'Old VFS response must lose publication authority');
        release();
        await flushAsync();
        await flushAsync();
        assert.deepEqual(publications, ['main.tex']);
        assert.equal(s.calls.length, 2);
        assert.equal(s.calls[1][4], 'automatic');
        assert.equal(saves, 0);
        assert.equal(viewer.doc.generation, 1);
    });

    it('does not let a late root inspection supersede a newer tab', async () => {
        const s = setup();
        let release!: () => void;
        const read = s.vfs.openFile;
        s.vfs.openFile = async (uri: any) => {
            if (uri.pathParts[0] === 'reply2.tex') { await new Promise<void>(resolve => { release = resolve; }); }
            return read(uri);
        };
        registerPdfViewer(s.fixture, []);
        await s.select(s.reply);
        await s.select(s.fixture.sourceUri);
        release();
        await flushAsync();
        assert.deepEqual(s.calls.map(args => args[3]), ['main.tex']);
    });

    it('invalidates a delayed old-root PDF download and delivers SyncTeX only for the replacement build', async () => {
        const s = setup();
        const syncRoots: string[] = [];
        s.vfs.syncCode = async () => {
            syncRoots.push(s.publishedRoot()!);
            return [{page: 1, h: 2, v: 3}];
        };
        let release!: (bytes: Uint8Array) => void;
        let reads = 0;
        const viewer = registerPdfViewer(s.fixture, [], {initialGeneration: 0, refresh: async () => {
            reads += 1;
            return reads === 1 ? new Promise<Uint8Array>(resolve => { release = resolve; }) : new Uint8Array([2]);
        }});
        await s.select(s.fixture.sourceUri);
        await s.select(s.reply);
        release(new Uint8Array([1]));
        await flushAsync();
        assert.equal(viewer.doc.generation, 1);
        assert.equal(s.publishedRoot(), 'reply2.tex');
        assert.deepEqual(syncRoots, ['reply2.tex']);
        assert.equal(viewer.messages.filter(message => message.type === 'syncCode').length, 1);
        assert.equal(saves, 0);
    });
});
