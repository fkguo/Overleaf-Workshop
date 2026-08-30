import * as vscode from 'vscode';
import { RemoteFileSystemProvider, VirtualFileSystem, parseUri } from '../core/remoteFileSystemProvider';
import { ROOT_NAME, ELEGANT_NAME, OUTPUT_FOLDER_NAME } from '../consts';
import { PdfDocument } from '../core/pdfViewEditorProvider';
import { LatexParser, ErrorSchema } from './compileLogParser';
import { EventBus } from '../utils/eventBus';
import { LocalReplicaSCMProvider } from '../scm/localReplicaSCM';
import { SyncCodeResponseSchema } from '../api/base';
import {
    LatestRequestGate,
    normalizeSynctexResultPath,
    SynctexSourceLocation,
    toSynctexSourceLocation,
} from './synctex';
import { resolveCompileRootDocId } from './compileTarget';
import { CompileRunGate, SingleFlightGate } from './compileRun';

// map string level to severity
const severityMap: Record<string, vscode.DiagnosticSeverity> = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    information: vscode.DiagnosticSeverity.Information,
};

const pdfViewRecord: {
    [key: string]: {
        [key: string]: {
            doc: PdfDocument,
            webviewPanel: vscode.WebviewPanel,
            ready: boolean,
        }
    }
} = {};

const pendingPdfSync: {[key: string]: SyncCodeResponseSchema} = {};
const sourceSyncRequests = new LatestRequestGate();

function pdfRecordKey(identifier: string, filePath: string): string {
    return `${identifier}\n${filePath}`;
}

type PendingSourceSync = SynctexSourceLocation & {
    projectUri: vscode.Uri,
    identifier: string,
};

class CompileDiagnosticProvider {
    private diagnosticCollection = vscode.languages.createDiagnosticCollection(`${ROOT_NAME}.compile`);
    constructor(private readonly vfsm: RemoteFileSystemProvider) {};

    private async getRange(log: ErrorSchema, path: string, vfs: any) {
        let textDoc: vscode.TextDocument;
        try {
            textDoc = (await vscode.workspace.openTextDocument(vfs.pathToUri(path)));
        }
        catch (error) {
            return null;
        }
        if (log.line !== null) {
            const _range = new vscode.Range(
                new vscode.Position(log.line - 1, 0),
                new vscode.Position(log.line, 0),
            );
            const lineContent = textDoc.getText(_range);
            const lineMatch = lineContent.match(/^\s*(.*?)\s*$/)?.[1] || '';
            const lineStart = lineContent.indexOf(lineMatch);
            const lineEnd = lineStart + lineMatch.length;
            return new vscode.Range(
                new vscode.Position(log.line - 1, lineStart),
                new vscode.Position(log.line - 1, lineEnd),
            );
        }
        else {
            return new vscode.Range(
                new vscode.Position(0, 0),
                new vscode.Position(1, 0),
            );
        }
    }
    private validatePath(path: string) {
        const outputRegex = new RegExp(/\.\/(output.(aux|bbl|toc|lof|lot|bbl|bst|ttt|fff))\b/);
        const match = outputRegex.exec(path);
        if (match) {
            return path.replace(match[0], `${OUTPUT_FOLDER_NAME}/${match[1]}`);
        }
        return path;
    }

    private async updateDiagnostics(uri: vscode.Uri, isCurrent: () => boolean = () => true) {
        const vfs = await this.vfsm.prefetch(uri);
        if (!isCurrent()) { return false; }
        const logPath = `${OUTPUT_FOLDER_NAME}/output.log`;
        const _uri = vfs.pathToUri(logPath);
        let content ='';
        content = new TextDecoder().decode(await vfs.openFile(_uri));
        if (!isCurrent()) { return false; }
        const logs = new LatexParser(content).parse();
        if (logs === undefined) {
            if (isCurrent()) {
                this.diagnosticCollection.clear();
            }
            return content === ''? true :false;
        }
        let hasError = false;
        const diagnosticsRecorder: { [key: string]: vscode.Diagnostic[] } = {};
        for (const log of logs.all) {
            if (!log.file.startsWith('./')) { continue; }
            const path = this.validatePath(log.file);
            const range = await this.getRange(log, path, vfs);
            if (!isCurrent()) { return false; }
            if (range === null) {
                continue;
            }
            if (!diagnosticsRecorder[path]) {
                diagnosticsRecorder[path] = [];
            }
            const diagnostic = new vscode.Diagnostic(range, log.message, severityMap[log.level]);
            diagnostic.source = vscode.l10n.t('Compile Checker');
            diagnosticsRecorder[path].push(diagnostic);

            if (log.level === 'error') {
                hasError = true;
            }
        }
        if (!isCurrent()) { return false; }
        this.diagnosticCollection.clear();
        for (const file in diagnosticsRecorder) {
            const diagnostics = diagnosticsRecorder[file];
            const _uri = vfs.pathToUri(file);
            this.diagnosticCollection.set(_uri, diagnostics);
        }
        return hasError;
    }

    get triggers() {
        return [
            this.diagnosticCollection,
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.compileErrorCheck`, async (uri, isCurrent?) => {
                return await this.updateDiagnostics(uri, isCurrent);
            }),
        ];
    }
}

export class CompileManager {
    readonly status: vscode.StatusBarItem;
    private readonly compileRunGate = new CompileRunGate();
    private diagnosticProvider: CompileDiagnosticProvider;
    private readonly pdfWillOpenTrigger: vscode.Disposable;
    private readonly pdfViewerReadyTrigger: vscode.Disposable;
    private readonly pdfViewDisposedTrigger: vscode.Disposable;
    private compileAsDraft: boolean = false;
    private compileStopOnFirstError: boolean = false;
    private activeCompileUri?: vscode.Uri;
    private activeCompileVfs?: VirtualFileSystem;
    private activeServerCompile = false;
    private stoppingCompile = false;
    private readonly stopGate = new SingleFlightGate();
    private pendingCompileForce?: boolean;

    constructor(
        private vfsm: RemoteFileSystemProvider,
    ) {
        this.vfsm = vfsm;
        this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1);
        this.status.command = `${ROOT_NAME}.compilerManager.settings`;
        this.diagnosticProvider = new CompileDiagnosticProvider(vfsm);
        // listen pdf open event
        this.pdfWillOpenTrigger = EventBus.on('pdfWillOpenEvent', ({uri, doc, webviewPanel}) => {
            const {identifier,pathParts} = parseUri(uri);
            const filePath = pathParts.join('/');
            if (pdfViewRecord[identifier]) {
                pdfViewRecord[identifier][filePath] = {doc, webviewPanel, ready: false};
            } else {
                pdfViewRecord[identifier] = {[filePath]:{doc, webviewPanel, ready: false}};
            }
        });
        this.pdfViewerReadyTrigger = EventBus.on('pdfViewerReadyEvent', ({uri, webviewPanel}) => {
            const {identifier, pathParts} = parseUri(uri);
            const filePath = pathParts.join('/');
            const record = pdfViewRecord[identifier]?.[filePath];
            if (!record || record.webviewPanel !== webviewPanel) { return; }
            record.ready = true;
            const pendingKey = pdfRecordKey(identifier, filePath);
            const pending = pendingPdfSync[pendingKey];
            if (pending) {
                delete pendingPdfSync[pendingKey];
                void record.webviewPanel.webview.postMessage({type: 'syncCode', content: pending});
            }
        });
        this.pdfViewDisposedTrigger = EventBus.on('pdfViewDisposedEvent', ({uri, webviewPanel}) => {
            const {identifier, pathParts} = parseUri(uri);
            const filePath = pathParts.join('/');
            const record = pdfViewRecord[identifier]?.[filePath];
            if (!record || record.webviewPanel !== webviewPanel) { return; }
            delete pdfViewRecord[identifier][filePath];
            const recordKey = pdfRecordKey(identifier, filePath);
            delete pendingPdfSync[recordKey];
            sourceSyncRequests.invalidate(recordKey);
            if (Object.keys(pdfViewRecord[identifier]).length === 0) {
                delete pdfViewRecord[identifier];
            }
        });
    }

    public get inCompiling() {
        return this.compileRunGate.active;
    }

    static async check(uri?: vscode.Uri) {
        // check if supported vfs
        uri = uri || vscode.window.activeTextEditor?.document.uri;
        uri = uri || vscode.workspace.workspaceFolders?.[0].uri;
        if (uri?.scheme === ROOT_NAME) {
            return uri;
        }
        // check if supported local replica
        const localSetting = await LocalReplicaSCMProvider.readSettings();
        if (localSetting?.uri && localSetting?.enableCompileNPreview===true) {
            return vscode.Uri.parse(localSetting.uri);
        }
        // otherwise return undefined
        return undefined;
    }

    async update(
        status: 'success'|'compiling'|'failed'|'alert',
        projectUri?: vscode.Uri,
        isCurrent: () => boolean = () => true,
    ) {
        const uri = projectUri ?? await CompileManager.check();
        if (uri) {
            const vfs = await this.vfsm.prefetch(uri);
            if (!isCurrent()) { return uri; }
            const rootDocName = vfs.getRootDocName().slice(1);
            const compilerName = vfs.getCompiler()?.name || '';
            this.status.tooltip = new vscode.MarkdownString();
            switch (status) {
                case 'success':
                    this.status.text = `${compilerName}`;
                    this.status.tooltip.appendMarkdown(`\`${rootDocName}\` **${vscode.l10n.t('Compile Success')}**`);
                    this.status.backgroundColor = undefined;
                    break;
                case 'compiling':
                    this.status.text = `${compilerName} $(sync~spin)`;
                    this.status.tooltip.appendMarkdown(`\`${rootDocName}\` **${vscode.l10n.t('Compiling')}**`);
                    this.status.backgroundColor = undefined;
                    break;
                case 'failed':
                    this.status.text = `${compilerName} $(x)`;
                    this.status.tooltip.appendMarkdown(`\`${rootDocName}\` **${vscode.l10n.t('Compile Failed')}**`);
                    this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                    break;
                case 'alert':
                    this.status.text = `$(alert)`;
                    this.status.tooltip.appendMarkdown(`\`${rootDocName}\` **${vscode.l10n.t('Not Connected')}**`);
                    this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                    break;
            }
            this.status.tooltip.appendMarkdown(`\n\n*${vscode.l10n.t('Click to manage compile settings.')}*`);
            this.status.show();
        } else {
            this.status.hide();
        }
        return uri;
    }

    async compile(force:boolean=false) {
        if (this.compileRunGate.active || this.stoppingCompile) {
            if (this.compileRunGate.cancelled || this.stoppingCompile) {
                this.pendingCompileForce = this.pendingCompileForce === true || force;
            }
            return;
        }

        await this.compileRunGate.run(async (isCurrent) => {
            let uri: vscode.Uri | undefined;
            try {
                uri = await CompileManager.check();
                if (!isCurrent()) { return; }
                this.activeCompileUri = uri;
                if (!uri) {
                    this.status.hide();
                    return;
                }
                await vscode.workspace.saveAll(); // save all dirty files
                if (!isCurrent()) { return; }
                const compileUri = uri;

                await this.update('compiling', compileUri, isCurrent);
                if (!isCurrent()) { return; }
                const vfs = await this.vfsm.prefetch(compileUri);
                if (!isCurrent()) { return; }
                this.activeCompileVfs = vfs;
                const rootDocId = await resolveCompileRootDocId(
                    compileUri.path,
                    () => vfs._resolveUri(compileUri),
                    () => vfs.openFile(compileUri),
                    error => console.warn(
                        `Unable to inspect compile target '${compileUri.toString()}'; compiling the configured main document.`,
                        error,
                    ),
                );
                if (!isCurrent()) { return; }
                const result = await vfs.compile(
                    force,
                    this.compileAsDraft,
                    this.compileStopOnFirstError,
                    rootDocId,
                    isCurrent,
                    () => {
                        if (isCurrent()) {
                            this.activeServerCompile = true;
                        }
                    },
                );
                this.activeServerCompile = false;
                if (!isCurrent()) { return; }
                if (result === undefined) {
                    await this.update('success', compileUri, isCurrent);
                    return;
                }
                if (result === false) {
                    await this.update('failed', compileUri, isCurrent);
                    return;
                }

                const hasError = await vscode.commands.executeCommand<boolean>(
                    `${ROOT_NAME}.compileManager.compileErrorCheck`,
                    compileUri,
                    isCurrent,
                );
                if (!isCurrent()) { return; }
                await this.update(hasError ? 'failed' : 'success', compileUri, isCurrent);
                if (!isCurrent()) { return; }

                // refresh pdf
                const { identifier } = parseUri(compileUri);
                pdfViewRecord[identifier] && Object.values(pdfViewRecord[identifier]).forEach(
                    (record) => record.doc.refresh()
                );
            } catch (error) {
                if (!isCurrent()) { return; }
                console.error('Compile failed unexpectedly.', error);
                if (uri) {
                    try {
                        await this.update('failed', uri, isCurrent);
                    } catch (statusError) {
                        console.error('Unable to update compile failure status.', statusError);
                    }
                }
            } finally {
                if (this.activeCompileUri === uri) {
                    this.activeCompileUri = undefined;
                    this.activeCompileVfs = undefined;
                    this.activeServerCompile = false;
                }
            }
        });

        await this.runPendingCompile();
    }

    private async runPendingCompile() {
        if (this.compileRunGate.active || this.stoppingCompile) { return; }
        const pendingForce = this.pendingCompileForce;
        this.pendingCompileForce = undefined;
        if (pendingForce !== undefined) {
            await this.compile(pendingForce);
        }
    }

    async stopCompile(): Promise<void> {
        if (!this.inCompiling && !this.stopGate.active) { return; }
        return this.stopGate.run(() => this.stopActiveCompile());
    }

    private async stopActiveCompile() {
        this.stoppingCompile = true;
        this.compileRunGate.cancel();
        const uri = this.activeCompileUri;
        const vfs = this.activeCompileVfs;
        const shouldStopServerCompile = this.activeServerCompile;
        try {
            if (vfs && shouldStopServerCompile) {
                await vfs.stopCompile();
            }
        } finally {
            try {
                if (uri) {
                    await this.update('failed', uri);
                }
            } finally {
                this.stoppingCompile = false;
                void this.runPendingCompile().catch(error => {
                    console.error('Unable to start the queued compile.', error);
                });
            }
        }
    }

    private async captureSourceSync(): Promise<PendingSourceSync | undefined> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return undefined; }
        // Snapshot everything which can change before the first asynchronous
        // settings/VFS lookup.
        const sourceUri = editor.document.uri;
        const position = {
            line: editor.selection.active.line,
            character: editor.selection.active.character,
        };
        const projectUri = await CompileManager.check(sourceUri);
        if (!projectUri) { return undefined; }

        const project = parseUri(projectUri);
        let filePath: string | undefined;
        if (sourceUri.scheme === ROOT_NAME) {
            const source = parseUri(sourceUri);
            if (source.identifier !== project.identifier) { return undefined; }
            filePath = source.pathParts.join('/');
        } else {
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(sourceUri);
            if (sourceUri.scheme !== 'file' || !workspaceFolder) { return undefined; }
            filePath = await LocalReplicaSCMProvider.uriToPath(sourceUri);
        }
        if (!filePath) { return undefined; }

        const vfs = await this.vfsm.prefetch(projectUri);
        return {
            projectUri,
            identifier: project.identifier,
            ...toSynctexSourceLocation(filePath, position, vfs.getRootDocName()),
        };
    }

    private deliverSourceSync(identifier: string, result: SyncCodeResponseSchema) {
        const pdfPath = `${OUTPUT_FOLDER_NAME}/output.pdf`;
        const record = pdfViewRecord[identifier]?.[pdfPath];
        if (!record?.ready) {
            pendingPdfSync[pdfRecordKey(identifier, pdfPath)] = result;
            return;
        }
        void record.webviewPanel.webview.postMessage({type: 'syncCode', content: result});
    }

    private async requestSourceSync(source: PendingSourceSync) {
        const pdfPath = `${OUTPUT_FOLDER_NAME}/output.pdf`;
        const recordKey = pdfRecordKey(source.identifier, pdfPath);
        const requestGeneration = sourceSyncRequests.begin(recordKey);
        // A newly requested cursor location supersedes any older result which
        // was waiting for the PDF viewer to become ready.
        delete pendingPdfSync[recordKey];
        const vfs = await this.vfsm.prefetch(source.projectUri);
        const result = await vfs.syncCode(source.file, source.line, source.column);
        if (result?.length && sourceSyncRequests.isCurrent(recordKey, requestGeneration)) {
            this.deliverSourceSync(source.identifier, result);
        }
    }

    async openPdf() {
        // Opening the custom editor changes activeTextEditor. Capture the TeX
        // source and cursor first so View Compiled PDF can forward-sync reliably.
        const source = await this.captureSourceSync();
        const uri = source?.projectUri ?? await CompileManager.check();
        if (uri) {
            const rootPath = uri.path.split('/', 2)[1];
            const pdfUri = uri.with({
                path: `/${rootPath}/${OUTPUT_FOLDER_NAME}/output.pdf`,
            });
            await vscode.commands.executeCommand('vscode.openWith', pdfUri,
                `${ROOT_NAME}.pdfViewer`,
                { preview: false, viewColumn: vscode.ViewColumn.Beside }
            );
            if (source) {
                await this.requestSourceSync(source);
            }
        }
    }

    async syncCode() {
        const source = await this.captureSourceSync();
        if (!source) { return; }
        const pdfPath = `${OUTPUT_FOLDER_NAME}/output.pdf`;
        if (!pdfViewRecord[source.identifier]?.[pdfPath]) {
            await this.openPdf();
            return;
        }
        await this.requestSourceSync(source);
    }

    private _revealSelectionInEditor(editor: vscode.TextEditor, targetLine: number, identifier: string) {
        const _identifier = identifier.replace(/\s+/g, '\\s+');
        // targetLine is 1-based from the syncTeX result
        const lineIndex = targetLine - 1;

        if (lineIndex < 0 || lineIndex >= editor.document.lineCount) {
            console.warn(`${ELEGANT_NAME}: Invalid line number ${targetLine} for revealing in editor. Document has ${editor.document.lineCount} lines.`);
            // Optionally, just focus the editor if the line is invalid
            vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
            return;
        }

        const lineText = editor.document.lineAt(lineIndex).text;
        const match = lineText.match(_identifier);
        const matchIndex = match?.index ?? 0;

        let newSelections: vscode.Selection[];
        const newSelection = new vscode.Selection(lineIndex, matchIndex, lineIndex, matchIndex);
        if (editor.selections.length > 0) {
            newSelections = editor.selections.map((sel, index) =>
                index === 0 ? newSelection : sel
            );
        } else {
            newSelections = [newSelection];
        }
        editor.selections = newSelections;

        editor.revealRange(new vscode.Range(lineIndex, matchIndex, lineIndex, matchIndex), vscode.TextEditorRevealType.InCenter);
    }

    async syncPdf(r: {
        page: number,
        h: number,
        v: number,
        identifier: string,
        uri?: vscode.Uri,
    }) {
        const uri = r.uri?.scheme === ROOT_NAME ? r.uri : await CompileManager.check();
        if (uri) {
            this.vfsm.prefetch(uri)
                .then((vfs) => vfs.syncPdf(r.page, r.h, r.v))
                .then((res) => {
                    if (res) {
                        const { projectName } = parseUri(uri);
                        const { file, line, column } = res;
                        const normalizedFile = normalizeSynctexResultPath(file);
                        if (!normalizedFile) {
                            console.warn(`${ELEGANT_NAME}: Ignored unsafe SyncTeX path: ${file}`);
                            return;
                        }
                        const _file = normalizedFile.match(/output\.[^\.]+$/) ? `${OUTPUT_FOLDER_NAME}/${normalizedFile}` : normalizedFile;
                        const fileUri = uri.with({ path: `/${projectName}/${_file}` });

                        let viewColumnToUse: vscode.ViewColumn | undefined;
                        const existingEditor = vscode.window.visibleTextEditors.find(
                            e => e.document.uri.toString() === fileUri.toString()
                        );

                        if (existingEditor) {
                            viewColumnToUse = existingEditor.viewColumn;
                        } else {
                            viewColumnToUse = vscode.window.visibleTextEditors.at(-1)?.viewColumn || vscode.ViewColumn.Beside;
                        }

                        vscode.window.showTextDocument(fileUri, { viewColumn: viewColumnToUse, preserveFocus: false })
                            .then(
                                (openedEditor) => {
                                    if (openedEditor) {
                                        this._revealSelectionInEditor(openedEditor, line, r.identifier);
                                    }
                                },
                                (error) => {
                                    console.error(`${ELEGANT_NAME}: Failed to open document ${fileUri.fsPath} for syncPdf:`, error);
                                }
                            );
                    }
                })
                .catch(error => {
                    console.error(`${ELEGANT_NAME}: Error in syncPdf promise chain:`, error);
                });
        }
    }

    async setCompiler() {
        const uri = await CompileManager.check();
        const vfs = uri && await this.vfsm.prefetch(uri);
        const currentCompiler = vfs?.getCompiler();
        const compilers = vfs?.getAllCompilers();
        compilers && vscode.window.showQuickPick(compilers.map((item) => {
            return {
                label: item.name,
                description: item.code,
                picked: item.code === currentCompiler?.code,
            };
        }), {
            canPickMany: false,
            placeHolder: vscode.l10n.t('Select Compiler'),
        }).then(async (option) => {
            option && await vfs?.updateSettings({ compiler: option.description }) && this.compile(true);
        });
    }

    async setRootDoc() {
        const uri = await CompileManager.check();
        const vfs = uri && await this.vfsm.prefetch(uri);
        const currentRootDoc = vfs?.getRootDocName();
        const rootDocs = vfs?.getValidMainDocs();
        rootDocs && vscode.window.showQuickPick(rootDocs.map((item) => {
            return {
                id: item.entity._id,
                label: item.path,
                picked: item.path === currentRootDoc,
            };
        }), {
            canPickMany: false,
            placeHolder: vscode.l10n.t('Select Main Document'),
        }).then(async (option) => {
            option && await vfs?.updateSettings({ rootDocId: option.id }) && this.compile(true);
        });
    }

    async compileSettings() {
        const uri = await CompileManager.check();
        const vfs = uri && await this.vfsm.prefetch(uri);
        const currentCompiler = vfs?.getCompiler();
        const currentRootDoc = vfs?.getRootDocName();

        const currentDraftMode = this.compileAsDraft ? vscode.l10n.t('Draft Mode') : vscode.l10n.t('Normal Mode');
        const currentStopOnError = this.compileStopOnFirstError ? vscode.l10n.t('Stop on first error') : vscode.l10n.t('Try to compile despite errors');
        const settingItems = [
            {label: vscode.l10n.t('Compile Mode'), description: currentDraftMode},
            {label: vscode.l10n.t('Compile Error Handling'), description: currentStopOnError},
            {label: '', kind: vscode.QuickPickItemKind.Separator},
            {label: vscode.l10n.t('Setting: Compiler'), description: currentCompiler?.name, },
            {label: vscode.l10n.t('Setting: Main Document'), description: currentRootDoc, },
        ];
        if (this.inCompiling) {
            settingItems.unshift({label: vscode.l10n.t('Stop compilation'), description: undefined});
        }

        const setting = await vscode.window.showQuickPick(settingItems);
        switch (setting?.label) {
            case vscode.l10n.t('Setting: Compiler'):
                this.setCompiler();
                break;
            case vscode.l10n.t('Setting: Main Document'):
                this.setRootDoc();
                break;
            case vscode.l10n.t('Stop compilation'):
                this.stopCompile();
                break;
            case vscode.l10n.t('Compile Mode'):
                this.compileAsDraft = !this.compileAsDraft;
                this.compileSettings();
                break;
            case vscode.l10n.t('Compile Error Handling'):
                this.compileStopOnFirstError = !this.compileStopOnFirstError;
                this.compileSettings();
                break;
            default:
                break;
        }
    }

    get triggers() {
        return [
            // register status bar
            this.status,
            this.pdfWillOpenTrigger,
            this.pdfViewerReadyTrigger,
            this.pdfViewDisposedTrigger,
            // register compile commands
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.compile`, () => this.compile(true)),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.viewPdf`, () =>  this.openPdf()),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.syncCode`, () => this.syncCode()),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.syncPdf`, (r) => this.syncPdf(r)),
            vscode.commands.registerCommand(`${ROOT_NAME}.compilerManager.settings`, ()=> this.compileSettings()),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.setCompiler`, () => this.setCompiler()),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.setRootDoc`, () => this.setRootDoc()),
            // register compile conditions
            vscode.workspace.onDidSaveTextDocument(async (e) => {
                const uri = await CompileManager.check.bind(this)(e.uri);
                const vfs = uri && await this.vfsm.prefetch(uri);
                const compileCondition = vscode.workspace.getConfiguration(`${ROOT_NAME}.compileOnSave`).get('enabled', true);
                const postfixCondition = e.fileName.match(/\.tex$|\.sty$|\.cls$|\.bib$/i);
                if (compileCondition && postfixCondition && vfs?.isInvisibleMode===false) {
                    this.compile();
                }
            }),
            EventBus.on('compilerUpdateEvent', () => {
                this.compile(true);
            }),
            EventBus.on('rootDocUpdateEvent', () => {
                this.compile(true);
            }),
            // register diagnostics triggers
            ...this.diagnosticProvider.triggers,
        ];
    }
}
