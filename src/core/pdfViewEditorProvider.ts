import * as vscode from 'vscode';
import { ROOT_NAME, OUTPUT_FOLDER_NAME } from '../consts';
import { EventBus } from '../utils/eventBus';
import { GlobalStateManager } from '../utils/globalStateManager';

export class PdfDocument implements vscode.CustomDocument {
    cache: Uint8Array = new Uint8Array(0);
    private _generation = 0;
    private refreshRequestGeneration = 0;
    loadFailed = false;
    private readonly _onDidChangeLoadState = new vscode.EventEmitter<void>();
    readonly onDidChangeLoadState = this._onDidChangeLoadState.event;

    private readonly _onDidChange = new vscode.EventEmitter<{content: Uint8Array, generation: number}>();
    readonly onDidChange = this._onDidChange.event;

    constructor(readonly uri: vscode.Uri) {
        if (uri.scheme !== ROOT_NAME) {
            throw new Error(`Invalid uri scheme: ${uri}`);
        }
        this.uri = uri;
    }

    dispose() {
        this.invalidateRefresh();
    }

    get generation() {
        return this._generation;
    }

    invalidateRefresh() {
        this.refreshRequestGeneration += 1;
    }

    reportLoadFailure() {
        this.loadFailed = true;
        this._onDidChangeLoadState.fire();
    }

    async refresh(): Promise<Uint8Array> {
        const requestGeneration = ++this.refreshRequestGeneration;
        try {
            const content = new Uint8Array(await vscode.workspace.fs.readFile(this.uri));
            if (requestGeneration !== this.refreshRequestGeneration) {
                return new Uint8Array();
            }
            if (content.byteLength === 0) {
                this.loadFailed = true;
                this._onDidChangeLoadState.fire();
                return content;
            }
            this.loadFailed = false;
            this._onDidChangeLoadState.fire();
            this.cache = content;
            this._generation += 1;
            this._onDidChange.fire({content, generation: this._generation});
            return content;
        } catch (error) {
            if (requestGeneration !== this.refreshRequestGeneration) { return new Uint8Array(); }
            this.loadFailed = true;
            this._onDidChangeLoadState.fire();
            console.warn('Overleaf PDF download failed.', error);
            // Keep the last successfully loaded PDF visible. Callers use the
            // empty result to suppress SyncTeX for this failed refresh.
            return new Uint8Array();
        }
    }
}

export class PdfViewEditorProvider implements vscode.CustomEditorProvider<PdfDocument> {
    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<PdfDocument>>();
    readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;
    private readonly openedDocuments = new Set<string>();

    constructor(private readonly context:vscode.ExtensionContext) {
        this.context = context;
    }

    public saveCustomDocument(document: PdfDocument, cancellation: vscode.CancellationToken): Thenable<void> {
        return Promise.resolve();
    }
    public saveCustomDocumentAs(document: PdfDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken): Thenable<void> {
        return Promise.resolve();
    }
    public async revertCustomDocument(document: PdfDocument, cancellation: vscode.CancellationToken): Promise<void> {
        if (cancellation.isCancellationRequested) { return; }
        await vscode.commands.executeCommand(`${ROOT_NAME}.compileManager.refreshPdf`, document);
    }
    public backupCustomDocument(document: PdfDocument, context: vscode.CustomDocumentBackupContext, cancellation: vscode.CancellationToken): Thenable<vscode.CustomDocumentBackup> {
        return Promise.resolve({id: '', delete: () => {}});
    }

    public async openCustomDocument(uri: vscode.Uri): Promise<PdfDocument> {
        // Record ownership before the download: a slow/offline open is not an
        // orphaned editor and must not be closed by host-restart recovery.
        this.openedDocuments.add(uri.toString());
        const doc = new PdfDocument(uri);
        await doc.refresh();
        return doc;
    }

    public async resolveCustomEditor(doc: PdfDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
        EventBus.fire('pdfWillOpenEvent', {uri: doc.uri, doc, webviewPanel});

        const updateLoadState = () => webviewPanel.webview.postMessage({type: 'pdfLoadError', failed: doc.loadFailed});
        const loadStateListener = doc.onDidChangeLoadState(updateLoadState);

        const updateWebview = () => {
            if (doc.cache.byteLength !== 0) {
                webviewPanel.webview.postMessage({
                    type: 'update',
                    content: doc.cache.buffer,
                    pdfGeneration: doc.generation,
                });
            }
        };

        const docOnDidChangeListener = doc.onDidChange(() => {
            updateWebview();
        });

        webviewPanel.onDidDispose(() => {
            docOnDidChangeListener.dispose();
            loadStateListener.dispose();
            EventBus.fire('pdfViewDisposedEvent', {uri: doc.uri, webviewPanel});
        });

        // register event listeners
        webviewPanel.onDidChangeViewState((e) => {
            if (e.webviewPanel.active) {
                EventBus.fire('fileWillOpenEvent', {uri: doc.uri});
            }
        });
        webviewPanel.webview.onDidReceiveMessage((e) => {
            switch (e.type) {
                case 'syncPdf':
                    vscode.commands.executeCommand(`${ROOT_NAME}.compileManager.syncPdf`, {
                        ...e.content,
                        uri: doc.uri,
                        webviewPanel,
                    });
                    break;
                case 'syncCodeFromPdf':
                    void vscode.commands.executeCommand(`${ROOT_NAME}.compileManager.syncCodeFromPdf`, {
                        pdfGeneration: e.pdfGeneration,
                        uri: doc.uri,
                        webviewPanel,
                    });
                    break;
                case 'syncUnavailable':
                    void vscode.window.showWarningMessage(vscode.l10n.t(
                        'PDF navigation is unavailable. Wait for the preview to load, or compile the project to obtain matching SyncTeX data.',
                    ));
                    break;
                case 'saveState':
                    GlobalStateManager.updatePdfViewPersist(this.context, doc.uri.toString(), e.content);
                    break;
                case 'pdfLifecycleFatal':
                    void vscode.window.showErrorMessage(
                        'PDF preview could not be safely reloaded. Close and reopen the PDF preview.',
                    );
                    break;
                case 'retryPdfDownload':
                    const retry = doc.uri.path?.endsWith(`/${OUTPUT_FOLDER_NAME}/output.pdf`)
                        ? vscode.commands.executeCommand(`${ROOT_NAME}.compileManager.refreshPdf`, doc, true)
                        : doc.refresh();
                    void retry
                        .then(updateLoadState, error => console.warn('Unable to retry the Overleaf PDF download.', error));
                    break;
                case 'ready':
                    const state = GlobalStateManager.getPdfViewPersist(this.context, doc.uri.toString());
                    const config = vscode.workspace.getConfiguration('overleaf-workshop.pdfViewer');
                    const colorThemes = config.get('themes', undefined);
                    const defaults = {
                        scrollMode: config.get('defaultScrollMode', 'vertical'),
                        spreadMode: config.get('defaultSpreadMode', 'none'),
                    };
                    webviewPanel.webview.postMessage({type:'initState', content:state, colorThemes, defaults});
                    updateWebview();
                    updateLoadState();
                    EventBus.fire('pdfViewerReadyEvent', {uri: doc.uri, webviewPanel});
                    // A restored tab must revalidate both the bytes and their
                    // SyncTeX build, even if it can still display its old cache.
                    void vscode.commands.executeCommand(`${ROOT_NAME}.compileManager.refreshPdf`, doc)
                        .then(undefined, error => console.warn('Unable to restore the Overleaf PDF preview.', error));
                    break;
                default:
                    break;
            }
        });

        webviewPanel.webview.options = {enableScripts:true};
        webviewPanel.webview.html = await this.getHtmlForWebview(webviewPanel.webview,
            doc.uri.path?.endsWith(`/${OUTPUT_FOLDER_NAME}/output.pdf`));
    }

    /** Reattach custom PDF tabs left behind by Restart Extension Host. */
    public restoreOpenEditors(): vscode.Disposable {
        const viewType = `${ROOT_NAME}.pdfViewer`;
        const pending = new Set<vscode.Tab>();
        let disposed = false;
        let queue = Promise.resolve();
        const isCandidate = (tab: vscode.Tab): boolean =>
            !disposed && tab.input instanceof vscode.TabInputCustom &&
            tab.input.viewType === viewType && tab.input.uri.scheme === ROOT_NAME &&
            !tab.isDirty && tab.isActive &&
            vscode.window.tabGroups.all.some(group => group.tabs.includes(tab)) &&
            !this.openedDocuments.has(tab.input.uri.toString());

        const restore = async (tab: vscode.Tab) => {
            if (!isCandidate(tab)) { return; }
            const uri = (tab.input as vscode.TabInputCustom).uri;
            const options = {
                viewColumn: tab.group.viewColumn,
                preserveFocus: true,
                preview: tab.isPreview,
            };
            // Normal window restoration will resolve the editor here. After a
            // host-only restart, VS Code merely reveals its disconnected tab.
            await vscode.commands.executeCommand('vscode.openWith', uri, viewType, options);
            if (!isCandidate(tab) || tab.group.viewColumn !== options.viewColumn ||
                (tab.input as vscode.TabInputCustom).uri.toString() !== uri.toString()) { return; }

            // Only an unowned, clean PDF tab is replaced; never close a source
            // editor or save/compile anything as part of restoring the preview.
            if (await vscode.window.tabGroups.close(tab, true) && !disposed) {
                const activeGroup = vscode.window.tabGroups.activeTabGroup;
                const besideSource = uri.path?.endsWith(`/${OUTPUT_FOLDER_NAME}/output.pdf`) &&
                    activeGroup && (activeGroup.viewColumn === options.viewColumn ||
                        activeGroup.viewColumn + 1 === options.viewColumn) &&
                    activeGroup.tabs.some(source => source.isActive && source.input instanceof vscode.TabInputText &&
                        source.input.uri.scheme === uri.scheme && source.input.uri.authority === uri.authority &&
                        source.input.uri.query === uri.query && /\.(tex|ltx)$/i.test(source.input.uri.path));
                // Closing the last PDF tab may destroy its group. In Cursor,
                // reopening by that numeric column can then move the PDF into
                // the source group. Use View Compiled PDF's side-open path when
                // the matching TeX source is active; leave other layouts alone.
                await vscode.commands.executeCommand('vscode.openWith', uri, viewType, besideSource
                    ? {...options, viewColumn: vscode.ViewColumn.Beside, preserveFocus: false}
                    : options);
            }
        };
        const schedule = (tabs: readonly vscode.Tab[]) => {
            for (const tab of tabs) {
                if (!isCandidate(tab) || pending.has(tab)) { continue; }
                pending.add(tab);
                queue = queue.then(() => restore(tab)).catch(error => {
                    console.warn('Unable to reattach the Overleaf PDF preview.', error);
                }).finally(() => pending.delete(tab));
            }
        };
        const listener = vscode.window.tabGroups.onDidChangeTabs(event => {
            // Hidden PDFs are recovered when selected, without replacing the
            // visible editor in their group during activation.
            schedule([...event.opened, ...event.changed]);
        });
        schedule(vscode.window.tabGroups.all.flatMap(group => group.tabs));
        return new vscode.Disposable(() => {
            disposed = true;
            listener.dispose();
        });
    }

    public get triggers(): vscode.Disposable[] {
        return [
            vscode.window.registerCustomEditorProvider(`${ROOT_NAME}.pdfViewer`, this, {
                webviewOptions: {
                    retainContextWhenHidden: true,
                },
                supportsMultipleEditorsPerDocument: false,
            }),
        ];
    }

    private patchViewerHtml(webview: vscode.Webview, html: string, enableSyncNavigation = false): string {
        const patchPath = (...path:string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'views/pdf-viewer', ...path)).toString();

        // adjust original path
        html = html.replace('../build/pdf.js', patchPath('vendor','build','pdf.js'));
        html = html.replace('viewer.css', patchPath('vendor','web','viewer.css'));
        html = html.replace('viewer.js',  patchPath('vendor','web','viewer.js'));

        // patch custom files
        const workerScript = `<script src="${patchPath('vendor','build','pdf.worker.js')}"></script>`;
        const syncGenerationScript = `<script src="${patchPath('syncGeneration.js')}"></script>`;
        const pdfLifecycleScript = `<script src="${patchPath('pdfLifecycle.js')}"></script>`;
        const customScript = `<script src="${patchPath('index.js')}"></script>`;
        const customStyle = `<link rel="stylesheet" href="${patchPath('index.css')}" />`;
        html = html.replace(
            /\<\/head\>/,
            `${workerScript}\n${syncGenerationScript}\n${pdfLifecycleScript}\n${customScript}\n${customStyle}\n</head>`,
        );

        html = html.replace(/<body([^>]*)>/, `<body$1>
<div id="overleaf-sync-navigation" role="group" aria-label="Source and PDF navigation" title="Drag up or down to move the navigation arrows"${enableSyncNavigation ? '' : ' hidden'}>
    <button id="overleaf-sync-to-pdf" type="button" title="Jump to PDF from the TeX cursor" aria-label="Jump to PDF from the TeX cursor">&#8594;</button>
    <button id="overleaf-sync-to-source" type="button" title="Jump to TeX from the visible PDF area" aria-label="Jump to TeX from the visible PDF area">&#8592;</button>
</div>
<div id="overleaf-pdf-load-error" role="status" hidden>
    The PDF could not be downloaded. The last loaded preview, if any, is unchanged.
    <button id="overleaf-pdf-retry" type="button">Retry PDF download</button>
</div>`);

        return html;
    }

    private async getHtmlForWebview(webview: vscode.Webview, enableSyncNavigation = false): Promise<string> {
        const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'views/pdf-viewer/vendor/web/viewer.html');
        let html = (await vscode.workspace.fs.readFile(htmlPath)).toString();
        return this.patchViewerHtml(webview, html, enableSyncNavigation);
    }

}
