/* eslint-disable @typescript-eslint/naming-convention */
import { strict as assert } from 'assert';

interface ModuleLoader {
    _load(request: string, parent: NodeModule | null, isMain: boolean): unknown,
}

class EventEmitterStub<T> {
    private readonly listeners = new Set<(event: T) => void>();
    readonly event = (listener: (event: T) => void) => {
        this.listeners.add(listener);
        return {dispose: () => this.listeners.delete(listener)};
    };

    fire(event: T) {
        for (const listener of this.listeners) {
            listener(event);
        }
    }
}

let readFile = async (_uri: unknown): Promise<Uint8Array> => new Uint8Array();
const shownErrors: string[] = [];
let executeCommand = async (..._args: any[]): Promise<any> => undefined;
const events: string[] = [];
class TabInputCustomStub {
    constructor(readonly uri: any, readonly viewType: string) {}
}
class TabInputTextStub { constructor(readonly uri: any) {} }
const tabChanges = new EventEmitterStub<any>();
let tabGroups: any[] = [];
let closeTab = async (_tab: any, _preserveFocus?: boolean): Promise<boolean> => true;
const vscodeStub = {
    EventEmitter: EventEmitterStub,
    TabInputCustom: TabInputCustomStub,
    TabInputText: TabInputTextStub,
    ViewColumn: {Two: 2, Beside: -2},
    Disposable: class { constructor(readonly dispose: () => void) {} },
    Uri: {
        joinPath: (_base: unknown, ...parts: string[]) => ({parts}),
    },
    workspace: {
        getConfiguration: () => ({get: (_key: string, fallback: unknown) => fallback}),
        fs: {
            readFile: (uri: unknown) => readFile(uri),
        },
    },
    commands: {executeCommand: (...args: any[]) => executeCommand(...args)},
    window: {
        showWarningMessage: async (message: string) => { shownErrors.push(message); },
        tabGroups: {
            get all() { return tabGroups; },
            get activeTabGroup() { return tabGroups.find(group => group.isActive) ?? tabGroups[0]; },
            onDidChangeTabs: tabChanges.event,
            close: (tab: any, preserveFocus?: boolean) => closeTab(tab, preserveFocus),
        },
        showErrorMessage: (message: string) => {
            shownErrors.push(message);
            return Promise.resolve(undefined);
        },
    },
};

const moduleLoader = require('module') as ModuleLoader;
const originalLoad = moduleLoader._load;
const originalCacheKeys = new Set(Object.keys(require.cache));
let PdfDocument: typeof import('../core/pdfViewEditorProvider')['PdfDocument'];
let PdfViewEditorProvider: typeof import('../core/pdfViewEditorProvider')['PdfViewEditorProvider'];
moduleLoader._load = function(request, parent, isMain): unknown {
    if (request === 'vscode') { return vscodeStub; }
    if (request === '../utils/eventBus') { return {EventBus: {fire: (name: string) => events.push(name)}}; }
    if (request === '../utils/globalStateManager') {
        return {GlobalStateManager: {getPdfViewPersist() {}, updatePdfViewPersist() {}}};
    }
    return originalLoad.call(this, request, parent, isMain);
};
try {
    const pdfProviderModule = require('../core/pdfViewEditorProvider') as
        typeof import('../core/pdfViewEditorProvider');
    PdfDocument = pdfProviderModule.PdfDocument;
    PdfViewEditorProvider = pdfProviderModule.PdfViewEditorProvider;
} finally {
    moduleLoader._load = originalLoad;
    for (const cacheKey of Object.keys(require.cache)) {
        if (!originalCacheKeys.has(cacheKey)) {
            delete require.cache[cacheKey];
        }
    }
}

describe('PdfDocument refresh generations', () => {
    beforeEach(() => {
        executeCommand = async () => undefined;
        events.length = 0;
        tabGroups = [];
    });

    it('delegates PDF revert to the build-aware refresh and awaits its completion', async () => {
        const provider = new PdfViewEditorProvider({} as any);
        const doc = new PdfDocument({scheme: 'overleaf-workshop'} as any);
        let finish!: () => void;
        executeCommand = async (command, document) => {
            assert.equal(command, 'overleaf-workshop.compileManager.refreshPdf');
            assert.equal(document, doc);
            await new Promise<void>(resolve => { finish = resolve; });
        };
        let completed = false;
        const reloading = provider.revertCustomDocument(doc, {isCancellationRequested: false} as any)
            .then(() => { completed = true; });
        await Promise.resolve();
        assert.equal(completed, false);
        finish();
        await reloading;
        assert.equal(completed, true);
    });

    it('does not reload a cancelled PDF revert', async () => {
        const provider = new PdfViewEditorProvider({} as any);
        executeCommand = async () => { throw new Error('Must not reload'); };
        await provider.revertCustomDocument({} as any, {isCancellationRequested: true} as any);
    });
    it('advances and publishes a generation only for a non-empty PDF', async () => {
        readFile = async () => new Uint8Array([1, 2, 3]);
        const doc = new PdfDocument({scheme: 'overleaf-workshop'} as any);
        const events: Array<{content: Uint8Array, generation: number}> = [];
        doc.onDidChange(event => events.push(event));

        const content = await doc.refresh();

        assert.deepEqual([...content], [1, 2, 3]);
        assert.deepEqual([...doc.cache], [1, 2, 3]);
        assert.equal(doc.generation, 1);
        assert.equal(events.length, 1);
        assert.equal(events[0].generation, 1);
        assert.deepEqual([...events[0].content], [1, 2, 3]);
    });

    it('keeps the last PDF and generation when the replacement download fails', async () => {
        readFile = async () => new Uint8Array([4, 5]);
        const doc = new PdfDocument({scheme: 'overleaf-workshop'} as any);
        let changes = 0;
        doc.onDidChange(() => { changes += 1; });
        await doc.refresh();

        readFile = async () => { throw new Error('download failed'); };
        const failed = await doc.refresh();

        assert.equal(failed.byteLength, 0);
        assert.deepEqual([...doc.cache], [4, 5]);
        assert.equal(doc.generation, 1);
        assert.equal(changes, 1);
        assert.equal(doc.loadFailed, true);
        readFile = async () => new Uint8Array([6, 7]);
        await doc.refresh();
        assert.equal(doc.loadFailed, false);
        assert.equal(doc.generation, 2);
    });

    it('does not publish an empty replacement as a new PDF generation', async () => {
        readFile = async () => new Uint8Array();
        const doc = new PdfDocument({scheme: 'overleaf-workshop'} as any);
        let changes = 0;
        doc.onDidChange(() => { changes += 1; });

        const empty = await doc.refresh();

        assert.equal(empty.byteLength, 0);
        assert.equal(doc.cache.byteLength, 0);
        assert.equal(doc.generation, 0);
        assert.equal(changes, 0);
    });

    it('does not publish a refresh invalidated while its download is pending', async () => {
        let finishRead!: (content: Uint8Array) => void;
        readFile = async () => new Promise<Uint8Array>(resolve => {
            finishRead = resolve;
        });
        const doc = new PdfDocument({scheme: 'overleaf-workshop'} as any);
        let changes = 0;
        doc.onDidChange(() => { changes += 1; });

        const refreshing = doc.refresh();
        doc.invalidateRefresh();
        finishRead(new Uint8Array([7, 8, 9]));
        const stale = await refreshing;

        assert.equal(stale.byteLength, 0);
        assert.equal(doc.cache.byteLength, 0);
        assert.equal(doc.generation, 0);
        assert.equal(changes, 0);
    });

    it('loads the generation gate before the PDF viewer controller', () => {
        const provider = new PdfViewEditorProvider({extensionUri: {}} as any);
        const webview = {
            asWebviewUri: (uri: {parts: string[]}) => ({
                toString: () => uri.parts.join('/'),
            }),
        };

        const html = (provider as any).patchViewerHtml(webview, '</head>') as string;

        const gateIndex = html.indexOf('syncGeneration.js');
        const lifecycleIndex = html.indexOf('pdfLifecycle.js');
        const controllerIndex = html.indexOf('index.js');
        assert.ok(gateIndex >= 0);
        assert.ok(lifecycleIndex > gateIndex);
        assert.ok(controllerIndex > lifecycleIndex);
    });

    it('tells the user to reopen a terminally failed PDF preview', async () => {
        readFile = async () => Buffer.from('</head>');
        shownErrors.length = 0;
        const provider = new PdfViewEditorProvider({extensionUri: {}} as any);
        const doc = new PdfDocument({scheme: 'overleaf-workshop', path: '/project/.output/output.pdf'} as any);
        let receiveMessage!: (message: {type: string}) => void;
        const webview = {
            options: {},
            set html(_value: string) {
                assert.equal(typeof receiveMessage, 'function', 'Listen before the restored webview can send ready');
            },
            asWebviewUri: (uri: {parts: string[]}) => ({
                toString: () => uri.parts.join('/'),
            }),
            postMessage: () => Promise.resolve(true),
            onDidReceiveMessage: (listener: (message: {type: string}) => void) => {
                receiveMessage = listener;
                return {dispose() {}};
            },
        };
        const panel = {
            webview,
            onDidDispose: () => ({dispose() {}}),
            onDidChangeViewState: () => ({dispose() {}}),
        };

        await provider.resolveCustomEditor(doc, panel as any);
        let refreshes = 0;
        executeCommand = async (command, document) => {
            assert.equal(command, 'overleaf-workshop.compileManager.refreshPdf');
            assert.equal(document, doc);
            assert.equal(events.at(-1), 'pdfViewerReadyEvent');
            refreshes += 1;
        };
        receiveMessage({type: 'ready'});
        assert.equal(refreshes, 1, 'Restoring an existing webview must request a fresh PDF/build binding');
        receiveMessage({type: 'retryPdfDownload'});
        assert.equal(refreshes, 2, 'Retry only requests a read-only PDF refresh');
        receiveMessage({type: 'pdfLifecycleFatal'});

        assert.deepEqual(shownErrors, [
            'PDF preview could not be safely reloaded. Close and reopen the PDF preview.',
        ]);
    });
});

describe('PDF provider respects the caller opening layout', () => {
    it('renders accessible navigation buttons only for the compiled preview', () => {
        const provider = new PdfViewEditorProvider({extensionUri: {}} as any);
        const webview = {asWebviewUri: (uri: {parts: string[]}) => ({toString: () => uri.parts.join('/')})};
        for (const enabled of [true, false]) {
            const html = (provider as any).patchViewerHtml(webview, '<head></head><body></body>', enabled);
            assert.match(html, /id="overleaf-sync-to-pdf" type="button" title="Jump to PDF from the TeX cursor"/);
            assert.match(html, /id="overleaf-sync-to-source" type="button"/);
            assert.equal(/id="overleaf-sync-navigation"[^>]* hidden/.test(html), !enabled);
            assert.match(html, /title="Drag up or down to move the navigation arrows"/);
        }
    });

    it('binds button requests to its own document and panel, ignoring message-supplied identities', async () => {
        const provider = new PdfViewEditorProvider({} as any);
        (provider as any).getHtmlForWebview = async () => '';
        const doc = new PdfDocument({scheme: 'overleaf-workshop', path: '/p/.output/output.pdf'} as any);
        let receive!: (message: any) => void;
        const panel: any = {
            webview: {postMessage() {}, onDidReceiveMessage: (listener: any) => { receive = listener; }},
            onDidDispose() {}, onDidChangeViewState() {},
        };
        const calls: any[][] = [];
        executeCommand = async (...args: any[]) => { calls.push(args); };
        await provider.resolveCustomEditor(doc, panel);
        receive({type: 'syncCodeFromPdf', pdfGeneration: 7, uri: 'wrong', webviewPanel: 'wrong'});
        assert.deepEqual(calls, [['overleaf-workshop.compileManager.syncCodeFromPdf', {
            pdfGeneration: 7, uri: doc.uri, webviewPanel: panel,
        }]]);
    });

    afterEach(() => { tabGroups = []; });
    for (const scenario of ['shared source group', 'already split', 'different project', 'ordinary PDF'] as const) {
        it(`handles ${scenario} without changing source tabs`, async () => {
            const uri: any = {scheme: 'overleaf-workshop', authority: 'example.test', query: 'user=u&project=p',
                path: scenario === 'ordinary PDF' ? '/p/paper.pdf' : '/p/.output/output.pdf'};
            const source = new TabInputTextStub({...uri, path: '/p/main.tex',
                query: scenario === 'different project' ? 'user=u&project=other' : uri.query});
            const sourceTab = {input: source, isDirty: true};
            tabGroups = [{viewColumn: 1, tabs: [sourceTab]}];
            if (scenario === 'already split') { tabGroups.push({viewColumn: 2, tabs: []}); }
            const provider = new PdfViewEditorProvider({} as any);
            (provider as any).getHtmlForWebview = async () => '';
            const reveals: any[] = [];
            await provider.resolveCustomEditor(new PdfDocument(uri), {
                reveal: (...args: any[]) => reveals.push(args),
                webview: {postMessage() {}, onDidReceiveMessage: () => ({dispose() {}})},
                onDidDispose: () => ({dispose() {}}), onDidChangeViewState: () => ({dispose() {}}),
            } as any);
            assert.deepEqual(reveals, [], 'Do not move a panel while the host is still resolving its editor');
            assert.equal(tabGroups[0].tabs[0], sourceTab);
            assert.equal(sourceTab.isDirty, true);
        });
    }
});

describe('PDF tab recovery after extension host restart', () => {
    const viewType = 'overleaf-workshop.pdfViewer';
    const uri = {scheme: 'overleaf-workshop', toString: () => 'overleaf-workshop://test/output.pdf'};
    let provider: InstanceType<typeof PdfViewEditorProvider>;
    let recovery: {dispose(): void} | undefined;
    let calls: any[][];
    const settle = async () => { for (let i = 0; i < 30; i++) { await Promise.resolve(); } };
    const addTab = (input: any = new TabInputCustomStub(uri, viewType), active = true) => {
        const group: any = {viewColumn: tabGroups.length + 1, tabs: []};
        const tab = {input, group, isActive: active, isDirty: false, isPreview: false};
        group.tabs.push(tab);
        tabGroups.push(group);
        return tab;
    };
    beforeEach(() => {
        provider = new PdfViewEditorProvider({} as any);
        tabGroups = [];
        calls = [];
        readFile = async () => new Uint8Array([1]);
        executeCommand = async (...args: any[]) => { calls.push(args); };
        closeTab = async (tab, preserveFocus) => {
            calls.push(['close', tab, preserveFocus]);
            tab.group.tabs = tab.group.tabs.filter((item: any) => item !== tab);
            return true;
        };
    });
    afterEach(() => { recovery?.dispose(); recovery = undefined; });

    it('recreates only the disconnected PDF and preserves its column and preview option', async () => {
        addTab({uri}); // A source tab, not a custom PDF.
        const pdf = addTab();
        pdf.isPreview = true;
        recovery = provider.restoreOpenEditors();
        await settle();
        assert.equal(calls.length, 3);
        const open = ['vscode.openWith', uri, viewType, {viewColumn: 2, preserveFocus: true, preview: true}];
        assert.deepEqual(calls[0], open);
        assert.deepEqual(calls[1], ['close', pdf, true]);
        assert.deepEqual(calls[2], open);
        assert.equal(tabGroups[0].tabs.length, 1, 'Source tab must remain untouched');
    });

    it('does not replace an editor resolved normally by openWith', async () => {
        addTab();
        executeCommand = async (...args) => {
            calls.push(args);
            await provider.openCustomDocument(uri as any);
        };
        recovery = provider.restoreOpenEditors();
        await settle();
        assert.equal(calls.length, 1);
        assert.equal(calls[0][0], 'vscode.openWith');
    });

    for (const scenario of ['removed group', 'empty group', 'shared group', 'different project',
        'ordinary PDF', 'nonadjacent layout', 'inactive source'] as const) {
        it(`uses the side-open path only beside the matching active TeX source: ${scenario}`, async () => {
            const pdfUri: any = {scheme: 'overleaf-workshop', authority: 'example.test', query: 'user=u&project=p',
                path: scenario === 'ordinary PDF' ? '/p/paper.pdf' : '/p/.output/output.pdf', toString: () => 'pdf'};
            const source = addTab(new TabInputTextStub({...pdfUri, path: '/p/main.tex',
                query: scenario === 'different project' ? 'user=u&project=other' : pdfUri.query}));
            source.isDirty = true;
            if (scenario === 'nonadjacent layout') { addTab({}); }
            const pdf = addTab(new TabInputCustomStub(pdfUri, viewType));
            if (scenario === 'shared group') {
                tabGroups.pop();
                pdf.group = source.group;
                source.group.tabs.push(pdf);
                source.isActive = false;
            }
            const originalColumn = pdf.group.viewColumn;
            closeTab = async (tab, preserveFocus) => {
                calls.push(['close', tab, preserveFocus]);
                tab.group.tabs = tab.group.tabs.filter((item: any) => item !== tab);
                if (scenario !== 'empty group' && scenario !== 'shared group') {
                    tabGroups = tabGroups.filter(group => group !== tab.group);
                }
                source.group.isActive = true;
                source.isActive = scenario !== 'inactive source';
                return true;
            };
            recovery = provider.restoreOpenEditors();
            await settle();
            const shouldOpenBeside = ['removed group', 'empty group', 'shared group'].includes(scenario);
            assert.equal(calls.length, 3);
            assert.deepEqual(calls[0], ['vscode.openWith', pdfUri, viewType,
                {viewColumn: originalColumn, preserveFocus: true, preview: false}]);
            assert.deepEqual(calls[2], ['vscode.openWith', pdfUri, viewType,
                {viewColumn: shouldOpenBeside ? -2 : originalColumn, preserveFocus: !shouldOpenBeside, preview: false}]);
            assert.equal(source.isDirty, true);
            assert.equal(source.group.tabs[0], source, 'Do not close, reopen or edit the source draft');
        });
    }

    it('does not mistake a pending download for an orphan', async () => {
        addTab();
        let finish!: (data: Uint8Array) => void;
        readFile = () => new Promise(resolve => { finish = resolve; });
        const opening = provider.openCustomDocument(uri as any);
        recovery = provider.restoreOpenEditors();
        await settle();
        assert.deepEqual(calls, []);
        finish(new Uint8Array([1]));
        await opening;
    });

    it('does not touch dirty tabs, another provider, or non-Overleaf resources', async () => {
        addTab().isDirty = true;
        addTab(new TabInputCustomStub(uri, 'another.pdfViewer'));
        addTab(new TabInputCustomStub({scheme: 'file'}, viewType));
        recovery = provider.restoreOpenEditors();
        await settle();
        assert.deepEqual(calls, []);
    });

    it('recovers an inactive PDF only when selected and coalesces repeated tab events', async () => {
        const tab = addTab(undefined, false);
        recovery = provider.restoreOpenEditors();
        await settle();
        assert.deepEqual(calls, []);
        tab.isActive = true;
        tabChanges.fire({opened: [], changed: [tab]});
        tabChanges.fire({opened: [], changed: [tab]});
        await settle();
        assert.equal(calls.length, 3);
    });

    it('abandons recovery when the user switches tabs during the probe', async () => {
        const tab = addTab();
        executeCommand = async (...args) => { calls.push(args); tab.isActive = false; };
        recovery = provider.restoreOpenEditors();
        await settle();
        assert.equal(calls.length, 1);
    });

    it('does not reopen a tab the user closed during the probe', async () => {
        const tab = addTab();
        executeCommand = async (...args) => { calls.push(args); tab.group.tabs = []; };
        recovery = provider.restoreOpenEditors();
        await settle();
        assert.equal(calls.length, 1);
    });

    it('does not close a tab that becomes dirty during the probe', async () => {
        const tab = addTab();
        executeCommand = async (...args) => { calls.push(args); tab.isDirty = true; };
        recovery = provider.restoreOpenEditors();
        await settle();
        assert.equal(calls.length, 1);
    });

    it('does not close a preview tab replaced with a different PDF during the probe', async () => {
        const tab = addTab();
        executeCommand = async (...args) => {
            calls.push(args);
            tab.input = new TabInputCustomStub({scheme: 'overleaf-workshop', toString: () => 'other.pdf'}, viewType);
        };
        recovery = provider.restoreOpenEditors();
        await settle();
        assert.equal(calls.length, 1);
    });

    it('does not move a tab back if the user moved it during the probe', async () => {
        const tab = addTab();
        executeCommand = async (...args) => { calls.push(args); tab.group.viewColumn = 3; };
        recovery = provider.restoreOpenEditors();
        await settle();
        assert.equal(calls.length, 1);
    });

    it('does not reopen if closing was cancelled', async () => {
        addTab();
        closeTab = async () => false;
        recovery = provider.restoreOpenEditors();
        await settle();
        assert.equal(calls.length, 1);
    });

    it('cancels queued recovery when disposed', async () => {
        addTab();
        recovery = provider.restoreOpenEditors();
        recovery.dispose();
        await settle();
        assert.deepEqual(calls, []);
    });
});
