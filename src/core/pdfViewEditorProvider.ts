import * as vscode from 'vscode';
import { ROOT_NAME } from '../consts';
import { EventBus } from '../utils/eventBus';
import { GlobalStateManager } from '../utils/globalStateManager';

export class PdfDocument implements vscode.CustomDocument {
    cache: Uint8Array = new Uint8Array(0);
    private _generation = 0;
    private refreshRequestGeneration = 0;

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

    async refresh(): Promise<Uint8Array> {
        const requestGeneration = ++this.refreshRequestGeneration;
        try {
            const content = new Uint8Array(await vscode.workspace.fs.readFile(this.uri));
            if (requestGeneration !== this.refreshRequestGeneration) {
                return new Uint8Array();
            }
            if (content.byteLength === 0) {
                return content;
            }
            this.cache = content;
            this._generation += 1;
            this._onDidChange.fire({content, generation: this._generation});
            return content;
        } catch {
            // Keep the last successfully loaded PDF visible. Callers use the
            // empty result to suppress SyncTeX for this failed refresh.
            return new Uint8Array();
        }
    }
}

export class PdfViewEditorProvider implements vscode.CustomEditorProvider<PdfDocument> {
    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<PdfDocument>>();
    readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    constructor(private readonly context:vscode.ExtensionContext) {
        this.context = context;
    }

    public saveCustomDocument(document: PdfDocument, cancellation: vscode.CancellationToken): Thenable<void> {
        return Promise.resolve();
    }
    public saveCustomDocumentAs(document: PdfDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken): Thenable<void> {
        return Promise.resolve();
    }
    public revertCustomDocument(document: PdfDocument, cancellation: vscode.CancellationToken): Thenable<void> {
        return Promise.resolve();
    }
    public backupCustomDocument(document: PdfDocument, context: vscode.CustomDocumentBackupContext, cancellation: vscode.CancellationToken): Thenable<vscode.CustomDocumentBackup> {
        return Promise.resolve({id: '', delete: () => {}});
    }

    public async openCustomDocument(uri: vscode.Uri): Promise<PdfDocument> {
        const doc = new PdfDocument(uri);
        await doc.refresh();
        return doc;
    }

    public async resolveCustomEditor(doc: PdfDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
        EventBus.fire('pdfWillOpenEvent', {uri: doc.uri, doc, webviewPanel});

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
            EventBus.fire('pdfViewDisposedEvent', {uri: doc.uri, webviewPanel});
        });

        webviewPanel.webview.options = {enableScripts:true};
        webviewPanel.webview.html = await this.getHtmlForWebview(webviewPanel.webview);

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
                case 'saveState':
                    GlobalStateManager.updatePdfViewPersist(this.context, doc.uri.toString(), e.content);
                    break;
                case 'pdfLifecycleFatal':
                    void vscode.window.showErrorMessage(
                        'PDF preview could not be safely reloaded. Close and reopen the PDF preview.',
                    );
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
                    EventBus.fire('pdfViewerReadyEvent', {uri: doc.uri, webviewPanel});
                    break;
                default:
                    break;
            }
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

    private patchViewerHtml(webview: vscode.Webview, html: string): string {
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

        return html;
    }

    private async getHtmlForWebview(webview: vscode.Webview): Promise<string> {
        const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'views/pdf-viewer/vendor/web/viewer.html');
        let html = (await vscode.workspace.fs.readFile(htmlPath)).toString();
        return this.patchViewerHtml(webview, html);
    }

}
