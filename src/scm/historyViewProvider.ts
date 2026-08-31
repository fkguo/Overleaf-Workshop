/* eslint-disable @typescript-eslint/naming-convention */
import * as vscode from 'vscode';
import { EventBus } from '../utils/eventBus';
import { VirtualFileSystem, parseUri } from '../core/remoteFileSystemProvider';
import { OUTPUT_FOLDER_NAME, ROOT_NAME } from '../consts';
import {
    ProjectFileDiffResponseSchema,
    ProjectHistoryResponseSchema,
    ProjectLabelResponseSchema,
    ProjectUpdateMeta,
    ProjectUpdateResponseSchema,
} from '../api/base';

type HistoryProjectOperation = ProjectHistoryResponseSchema['project_ops'][number];

export interface HistoryRecord {
    before?: number,
    currentVersion?: number,
    keyVersions: number[], //array of all `toV` values
    revisions: {
        [toV:number]: {
            fromV: number,
            timestamp: number,
            users: ProjectUpdateMeta['users'],
            origin?: ProjectUpdateMeta['origin'],
            structuralChanges: HistoryProjectOperation[],
        }
    },
    labels: {[version:number]: ProjectLabelResponseSchema[]},
    diff: {
        [path:string] : number[] //array of version numbers
    }
}

export interface HistoryAttributionSpan {
    start: number,
    end: number,
    kind: 'added' | 'removed',
    meta: ProjectUpdateMeta,
}

export interface HistoricalDocument {
    text: string,
    attributions: HistoryAttributionSpan[],
}

type HistoricalDocumentSide = 'before' | 'after';

interface HistoricalDocumentQuery {
    version: number,
    from: number,
    to: number,
    side: HistoricalDocumentSide,
}

function addUniqueVersion(versions: number[], version: number): void {
    if (!versions.includes(version)) {
        versions.push(version);
    }
}

function recordPathVersion(history: HistoryRecord, pathname: string, version: number): void {
    const versions = history.diff[pathname] ?? (history.diff[pathname] = []);
    addUniqueVersion(versions, version);
}

/** Merge one history page without replacing the newest version with an older page. */
export function mergeHistoryPage(history: HistoryRecord, page?: ProjectUpdateResponseSchema): HistoryRecord {
    if (!page) { return history; }
    history.before = page.nextBeforeTimestamp;
    const updates = page.updates ?? [];
    if (history.currentVersion === undefined && updates.length > 0) {
        history.currentVersion = updates[0].toV;
    }

    for (const update of updates) {
        const version = update.toV;
        addUniqueVersion(history.keyVersions, version);
        history.revisions[version] = {
            fromV: update.fromV,
            timestamp: update.meta.end_ts,
            users: update.meta.users,
            origin: update.meta.origin,
            structuralChanges: update.project_ops ?? [],
        };
        history.labels[version] = update.labels ?? [];

        for (const pathname of update.pathnames ?? []) {
            recordPathVersion(history, pathname, version);
        }
        for (const operation of update.project_ops ?? []) {
            if (operation.add) {
                recordPathVersion(history, operation.add.pathname, operation.atV);
            } else if (operation.remove) {
                recordPathVersion(history, operation.remove.pathname, operation.atV);
            } else if (operation.rename) {
                recordPathVersion(history, operation.rename.pathname, operation.atV);
                recordPathVersion(history, operation.rename.newPathname, operation.atV);
            }
        }
    }
    return history;
}

export function resolveRevisionVersion(history: HistoryRecord, version: number): number | undefined {
    if (history.revisions[version]) { return version; }
    return Object.keys(history.revisions)
        .map(Number)
        .filter(candidate => candidate >= version)
        .sort((a, b) => a-b)[0];
}

export function resolveUniqueRevisionVersions(history: HistoryRecord, versions: number[]): number[] {
    const resolved = new Set<number>();
    for (const version of versions) {
        const revisionVersion = resolveRevisionVersion(history, version);
        if (revisionVersion !== undefined) { resolved.add(revisionVersion); }
    }
    return [...resolved];
}

function escapeMarkdown(value: string): string {
    return value.replace(/[\\`*_{}[\]()<>#+\-.!|]/g, '\\$&');
}

export function describeHistoryOrigin(origin: unknown): string | undefined {
    const record = typeof origin === 'object' && origin !== null
        ? origin as Record<string, unknown>
        : undefined;
    const kind = typeof origin === 'string'
        ? origin
        : typeof record?.kind === 'string' ? record.kind : undefined;
    if (!kind) { return undefined; }

    switch (kind) {
        case 'dropbox': return 'Dropbox sync';
        case 'upload': return 'File upload';
        case 'git-bridge': return 'Git bridge';
        case 'github': return 'GitHub sync';
        case 'history-resync': return 'History resync';
        case 'history-migration': return 'History migration';
        case 'file-restore': {
            const pathname = typeof record?.path === 'string' ? ` ${record.path}` : '';
            const version = typeof record?.version === 'number' ? ` from v${record.version}` : '';
            return `File restore${pathname}${version}`;
        }
        case 'project-restore': {
            const version = typeof record?.version === 'number' ? ` from v${record.version}` : '';
            return `Project restore${version}`;
        }
        default:
            return kind.split('-').map(word => word.charAt(0).toUpperCase()+word.slice(1)).join(' ');
    }
}

export function describeProjectOperation(operation: HistoryProjectOperation): string | undefined {
    if (operation.add) {
        return `Added ${operation.add.pathname}`;
    }
    if (operation.remove) {
        return `Removed ${operation.remove.pathname}`;
    }
    if (operation.rename) {
        return `Renamed ${operation.rename.pathname} → ${operation.rename.newPathname}`;
    }
    return undefined;
}

export function formatHistoryParticipants(users: ProjectUpdateMeta['users']): string[] {
    const participants: string[] = [];
    let unknownCount = 0;
    for (const user of users ?? []) {
        if (!user) {
            unknownCount++;
            continue;
        }
        const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
        const email = user.email?.trim();
        participants.push(name && email ? `${name} (${email})` : name || email || 'Unknown participant');
    }
    if (unknownCount > 0) {
        participants.push(unknownCount === 1
            ? 'Unknown or deleted participant'
            : `${unknownCount} unknown or deleted participants`);
    }
    return participants;
}

export function buildHistoryTooltipMarkdown(
    revision: HistoryRecord['revisions'][number],
    labels: ProjectLabelResponseSchema[],
): string {
    const lines = [
        `$(history) ${new Date(revision.timestamp).toLocaleString()}`,
        '',
        '**Participants in this summarized update**',
        '',
    ];
    const participants = formatHistoryParticipants(revision.users);
    if (participants.length === 0) {
        lines.push('- Participant information unavailable');
    } else {
        lines.push(...participants.map(participant => `- $(account) ${escapeMarkdown(participant)}`));
    }

    const origin = describeHistoryOrigin(revision.origin);
    if (origin) {
        lines.push('', '**Origin**', '', escapeMarkdown(origin));
    }
    const changes = revision.structuralChanges
        .map(describeProjectOperation)
        .filter((change): change is string => change !== undefined);
    if (changes.length > 0) {
        lines.push('', '**Structure changes**', '', ...changes.map(change => `- ${escapeMarkdown(change)}`));
    }
    if (labels.length > 0) {
        lines.push('', '**Version labels**', '', ...labels.map(label => `- $(tag) ${escapeMarkdown(label.comment)}`));
    }
    return lines.join('\n');
}

export function buildHistoryAttributionTooltipMarkdown(attribution: HistoryAttributionSpan): string {
    const participants = formatHistoryParticipants(attribution.meta.users);
    const lines = [
        attribution.kind === 'added' ? '**Added block**' : '**Removed block**',
        '',
        '**Participants for this changed block**',
        '',
        ...(participants.length > 0
            ? participants.map(participant => `- $(account) ${escapeMarkdown(participant)}`)
            : ['- Participant information unavailable']),
    ];
    const origin = describeHistoryOrigin(attribution.meta.origin);
    if (origin) {
        lines.push('', '**Origin**', '', escapeMarkdown(origin));
    }
    lines.push('', '**Change interval**', '',
        `${new Date(attribution.meta.start_ts).toLocaleString()} – ${new Date(attribution.meta.end_ts).toLocaleString()}`);
    return lines.join('\n');
}

export function buildHistoricalDocument(
    response: ProjectFileDiffResponseSchema | undefined,
    side: HistoricalDocumentSide,
): HistoricalDocument {
    if (!response) {
        throw new Error('Unable to load this Overleaf history diff');
    }
    if (!Array.isArray(response.diff)) {
        throw new Error('This Overleaf history diff is binary or unavailable');
    }
    let text = '';
    const attributions: HistoryAttributionSpan[] = [];
    for (const chunk of response.diff) {
        if (chunk.u !== undefined) {
            text += chunk.u;
        }
        const changedText = side === 'before' ? chunk.d : chunk.i;
        if (changedText === undefined) { continue; }
        const start = text.length;
        text += changedText;
        if (chunk.meta && changedText.length > 0) {
            attributions.push({
                start,
                end: text.length,
                kind: side === 'before' ? 'removed' : 'added',
                meta: chunk.meta,
            });
        }
    }
    return {text, attributions};
}

export function encodeHistoricalDocumentQuery(query: HistoricalDocumentQuery): string {
    return new URLSearchParams({
        version: String(query.version),
        from: String(query.from),
        to: String(query.to),
        side: query.side,
    }).toString();
}

export function parseHistoricalDocumentQuery(query: string): HistoricalDocumentQuery | undefined {
    if (/^\d+$/.test(query)) {
        const version = Number(query);
        return {version, from: version, to: version, side: 'after'};
    }
    const params = new URLSearchParams(query);
    if (!params.has('version') || !params.has('from') || !params.has('to') || !params.has('side')) {
        return undefined;
    }
    const version = Number(params.get('version'));
    const from = Number(params.get('from'));
    const to = Number(params.get('to'));
    const side = params.get('side');
    if (!Number.isSafeInteger(version) || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) ||
        version < 0 || from < 0 || to < 0 ||
        from > to || (side !== 'before' && side !== 'after') ||
        (side === 'before' && version !== from) || (side === 'after' && version !== to)) {
        return undefined;
    }
    return {version, from, to, side};
}

export function createHistoricalDocumentUri(
    pathname: string,
    query: HistoricalDocumentQuery,
): vscode.Uri {
    return vscode.Uri.from({
        scheme: `${ROOT_NAME}-diff`,
        path: pathname,
        query: encodeHistoricalDocumentQuery(query),
    });
}

function formatTime(timestamp:number) {
    const msPerMinute = 60 * 1000;
    const msPerHour = msPerMinute * 60;
    const msPerDay = msPerHour * 24;
    const msPerMonth = msPerDay * 30;
    const msPerYear = msPerDay * 365;

    const elapsed = Date.now() - timestamp;

    if (elapsed < msPerMinute) {
        const elapsedSeconds = Math.round(elapsed/1000);
        return elapsedSeconds===0 ? 'now' : elapsedSeconds + 's';
    } else if (elapsed < msPerHour) {
        const elapsedMinutes = Math.round(elapsed/msPerMinute);
        return elapsedMinutes===1 ? '1 min' : elapsedMinutes + ' mins';
    } else if (elapsed < msPerDay ) {
        const elapsedHours = Math.round(elapsed/msPerHour );
        return elapsedHours===1 ? '1 hour' : elapsedHours + ' hours';
    } else if (elapsed < msPerMonth) {
        const elapsedDays = Math.round(elapsed/msPerDay);
        return elapsedDays===1 ? '1 day' : elapsedDays + ' days';
    } else if (elapsed < msPerYear) {
        const elapsedMonths = Math.round(elapsed/msPerMonth);
        return elapsedMonths===1 ? '1 month' : elapsedMonths + ' months';
    } else {
        const elapsedYears = Math.round(elapsed/msPerYear );
        return elapsedYears===1 ? '1 year' : elapsedYears + ' years';
    }
}

class HistoryItem extends vscode.TreeItem {
    constructor(
        label: string,
        readonly version: number,
        readonly prevVersion: number,
        readonly tags?: ProjectLabelResponseSchema[]
    ) {
        const _tag = tags?.map(t=>t.comment).join(' | ');
        const _label = _tag? `${label} (${_tag})` : label;
        super(_label, vscode.TreeItemCollapsibleState.None);
        this.iconPath = _tag?.length? new vscode.ThemeIcon('tag') : new vscode.ThemeIcon('history');
        this.contextValue = _tag ? 'historyItemLabelled' : 'historyItem';
    }
}

class HistoryDataProvider implements vscode.TreeDataProvider<HistoryItem>, vscode.TextDocumentContentProvider, vscode.HoverProvider, vscode.Disposable {
    private _path?: string;
    private _history?: HistoryRecord;
    private readonly refreshTask: NodeJS.Timeout;
    private readonly documentAttributions = new Map<string, HistoryAttributionSpan[]>();
    private disposed = false;

    constructor(private readonly vfs: VirtualFileSystem) {
        this.refreshTask = setInterval(() => this.refresh(), 30*1000);
    }

    private _onDidChangeTreeData: vscode.EventEmitter<HistoryItem | undefined | void> = new vscode.EventEmitter<HistoryItem | undefined | void>();

    readonly onDidChangeTreeData: vscode.Event<HistoryItem | undefined | void> = this._onDidChangeTreeData.event;

    refresh(): void {
        if (this.disposed) { return; }
        this._onDidChangeTreeData.fire();
    }

    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;
        clearInterval(this.refreshTask);
        this.documentAttributions.clear();
        this._onDidChangeTreeData.dispose();
    }

    async refreshData(path?:string, force:boolean=false) {
        if (this.disposed) { return; }
        this._path = path;
        if (force) {
            this._history = undefined;
        }
        await this.getHistory();
        if (this.disposed) { return; }
        this.refresh();
    }

    async openDiffEditor(originVersion:number, targetVersion:number) {
        if (!Number.isSafeInteger(originVersion) || !Number.isSafeInteger(targetVersion) ||
            originVersion < 0 || targetVersion < 0) {
            return;
        }
        const fromVersion = Math.min(originVersion, targetVersion);
        const toVersion = Math.max(originVersion, targetVersion);
        if (this._path===undefined) {
            const args: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] = [];
            const treeDiff = await this.vfs.getFileTreeDiff(fromVersion, toVersion);
            if (!treeDiff) { return; }
            const {diff} = treeDiff;
            for (const change of diff) {
                if (change.operation===undefined) { continue; }
                const newPathname = change.newPathname || change.pathname;
                let originUri: vscode.Uri | undefined = createHistoricalDocumentUri(change.pathname, {
                    version: fromVersion, from: fromVersion, to: toVersion, side: 'before',
                });
                let targetUri: vscode.Uri | undefined = createHistoricalDocumentUri(newPathname, {
                    version: toVersion, from: fromVersion, to: toVersion, side: 'after',
                });
                let labelUri = targetUri;
                // handle removed/added files
                switch (change.operation) {
                    case 'added':
                        labelUri = targetUri;
                        originUri = undefined;
                        break;
                    case 'removed':
                        labelUri = originUri;
                        targetUri = undefined;
                        break;
                    case 'edited':
                    case 'renamed':
                    default:
                        break;
                }
                args.push([labelUri, originUri, targetUri]);
            }
            vscode.commands.executeCommand('vscode.changes', `v${fromVersion} vs v${toVersion}`, args);
        } else {
            vscode.commands.executeCommand('vscode.diff',
                createHistoricalDocumentUri(this._path, {
                    version: fromVersion, from: fromVersion, to: toVersion, side: 'before',
                }),
                createHistoricalDocumentUri(this._path, {
                    version: toVersion, from: fromVersion, to: toVersion, side: 'after',
                }),
                `${this._path} (v${fromVersion} vs v${toVersion})`,
            );
        }
    }

    getTreeItem(element: HistoryItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: HistoryItem): Thenable<HistoryItem[]> {
        if (element !== undefined) { return Promise.resolve([]); }
        if (!this._history) { return Promise.resolve([]); }

        const _history = this._history;
        const versions = this._path? this._history.diff[this._path] : this._history.keyVersions;
        const historyItems = resolveUniqueRevisionVersions(_history, versions ?? []).map(_version => {
            const revision = _history.revisions[_version];

            const item = new HistoryItem(
                `Version ${_version}`,
                _version,
                //prevVersion
                revision.fromV ?? _version,
                _history.labels[_version] ?? [],
            );
            const origin = describeHistoryOrigin(revision.origin);
            item.description = '\t'+formatTime(revision.timestamp)+(origin ? ` · ${origin}` : '');
            item.tooltip = new vscode.MarkdownString(buildHistoryTooltipMarkdown(
                revision,
                _history.labels[_version] ?? [],
            ));
            item.tooltip.supportThemeIcons = true;
            item.command = {
                command: `projectHistory.comparePrevious`,
                title: vscode.l10n.t('Compare with Previous Version'),
                arguments: [item],
            };
            return item;
        });

        if (this._history.before !== undefined) {
            const item = new HistoryItem(vscode.l10n.t('Load More ...'), NaN,NaN);
            item.iconPath = undefined;
            item.command = {
                command: `${ROOT_NAME}.projectHistory.loadMore`,
                title: vscode.l10n.t('Load More ...'),
                arguments: [this],
            };
            historyItems.push(item);
        }
        return Promise.resolve(historyItems);
    }

    async provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
        const query = parseHistoricalDocumentQuery(uri.query);
        if (!query) {
            throw new Error('Invalid Overleaf history document query');
        }
        const _uri = vscode.workspace.workspaceFolders?.[0].uri;
        if (!_uri) { throw new Error('No Overleaf workspace is open'); }
        if (token.isCancellationRequested) { return ''; }

        this.documentAttributions.delete(uri.toString());
        const response = await this.vfs.getFileDiff(uri.path, query.from, query.to);
        if (token.isCancellationRequested) { return ''; }
        const document = buildHistoricalDocument(response, query.side);
        this.documentAttributions.set(uri.toString(), document.attributions);
        return document.text;
    }

    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
    ): vscode.ProviderResult<vscode.Hover> {
        if (token.isCancellationRequested) { return undefined; }
        const offset = document.offsetAt(position);
        const attribution = this.documentAttributions.get(document.uri.toString())
            ?.find(span => span.start <= offset && offset < span.end);
        if (!attribution) { return undefined; }

        const contents = new vscode.MarkdownString(buildHistoryAttributionTooltipMarkdown(attribution));
        contents.supportThemeIcons = true;
        return new vscode.Hover(
            contents,
            new vscode.Range(document.positionAt(attribution.start), document.positionAt(attribution.end)),
        );
    }

    get triggers(): vscode.Disposable[] {
        return [
            this,
            vscode.workspace.registerTextDocumentContentProvider(`${ROOT_NAME}-diff`, this),
            vscode.languages.registerHoverProvider({scheme: `${ROOT_NAME}-diff`}, this),
            vscode.workspace.onDidCloseTextDocument(document => {
                if (document.uri.scheme === `${ROOT_NAME}-diff`) {
                    this.documentAttributions.delete(document.uri.toString());
                }
            }),
            // register commands
            vscode.commands.registerCommand(`${ROOT_NAME}.projectHistory.refresh`, async () => {
                await this.refreshData(this._path, true);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectHistory.loadMore`, async (provider: HistoryDataProvider) => {
                await provider.getHistory(provider._history?.before);
                provider.refresh();
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectHistory.createLabel`, async (item: HistoryItem) => {
                const label = await vscode.window.showInputBox({
                    prompt: vscode.l10n.t('Create a new label'),
                    placeHolder: vscode.l10n.t('Enter a label name'),
                });
                if (!label) { return; }

                const uri = vscode.workspace.workspaceFolders?.[0].uri;
                if (!uri) { return; }

                const res = await this.vfs.createLabel(label, item.version);
                if (res) {
                    const labels = this._history?.labels[item.version];
                    if (labels) {
                        labels.push(res);
                    }
                    this.refresh();
                }
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectHistory.deleteLabel`, async (item: HistoryItem) => {
                const label = await vscode.window.showQuickPick(
                    item.tags?.map(t=>t.comment) || [],
                    { placeHolder: vscode.l10n.t('Select a label to delete') }
                );
                if (!label) { return; }

                const uri = vscode.workspace.workspaceFolders?.[0].uri;
                if (!uri) { return; }

                const version = item.version;
                const labelId = item.tags?.find(t=>t.comment===label)?.id;
                const res = labelId && await this.vfs.deleteLabel(labelId);
                if (res) {
                    const labels = this._history?.labels[version];
                    const index = labels?.findIndex(t=>t.id===labelId) ?? -1;
                    if (labels && index >= 0) {
                        labels.splice(index, 1);
                    }
                    this.refresh();
                }
            }),
            vscode.commands.registerCommand('projectHistory.comparePrevious', async (item: HistoryItem) => {
                vscode.commands.executeCommand(`${ROOT_NAME}.projectHistory.comparePrevious`, item);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectHistory.comparePrevious`, async (item: HistoryItem) => {
                this.openDiffEditor(item.prevVersion, item.version);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectHistory.compareCurrent`, async (item: HistoryItem) => {
                this.openDiffEditor(item.version, this._history?.currentVersion ?? NaN);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectHistory.compareOthers`, async (item: HistoryItem) => {
                const otherVersions = this._history?.keyVersions.filter(v=>v!==item.version);
                if (!otherVersions) { return; }

                vscode.window.showQuickPick(otherVersions.map(v => {
                    return {
                        label: `version ${v}`,
                        description: formatTime(this._history?.revisions[v].timestamp || 0),
                        version: v,
                    };
                }), {
                    placeHolder: vscode.l10n.t('Select a version to compare'),
                }).then(async (select) => {
                    if (!select) { return; }
                    this.openDiffEditor(item.version, select.version);
                });
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectHistory.downloadProject`, async (item:HistoryItem) => {
                const uri = vscode.workspace.workspaceFolders?.[0].uri;
                if (!uri) { return; }
                const version = item.version;
                const content = await this.vfs.downloadProjectArchive(version);
                const filename = `${this.vfs.projectName}-v${version}.zip`;

                const savePath = await vscode.window.showSaveDialog({
                    defaultUri: vscode.Uri.file(filename),
                    filters: { 'Zip Archive': ['zip'] },
                });
                if (!savePath) { return; }
                await vscode.workspace.fs.writeFile(savePath, content);
                vscode.window.showInformationMessage( vscode.l10n.t('Project v{version} saved to {path}',  {version, path:savePath.fsPath}) );
            }),
        ];
    }

    private async getHistory(before?:number): Promise<HistoryRecord> {
        const uri = vscode.workspace.workspaceFolders?.[0].uri;
        if (!uri) { return Promise.reject(); }

        if (this._history===undefined) { // first time load
            this._history = {
                before: undefined,
                keyVersions: [], revisions: {},
                labels: {}, diff: {},
            };
        } else if (before===undefined) { // don't have to load
            return Promise.resolve(this._history);
        }

        const updates = await this.vfs.getUpdates(before);
        mergeHistoryPage(this._history, updates);

        return Promise.resolve(this._history);
    }
}

export class HistoryViewProvider implements vscode.Disposable {
    private treeDataProvider: HistoryDataProvider;
    private historyView: vscode.TreeView<HistoryItem>;
    private pendingFileOpenTasks = new Set<NodeJS.Timeout>();
    private disposed = false;

    constructor(vfs: VirtualFileSystem) {
        const treeDataProvider = new HistoryDataProvider(vfs);
        this.historyView = vscode.window.createTreeView(`${ROOT_NAME}.projectHistory`, {treeDataProvider});
        this.treeDataProvider = treeDataProvider;
        this.updateView();
    }

    updateView(pathParts?: string[]) {
        if (this.disposed) { return; }
        this.historyView.description = pathParts?.at(-1);
        this.treeDataProvider.refreshData( pathParts?.join('/') );
    }

    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;
        this.pendingFileOpenTasks.forEach(task => clearTimeout(task));
        this.pendingFileOpenTasks.clear();
    }

    get triggers(): vscode.Disposable[] {
        return [
            this,
            // register tree view
            this.historyView,
            ...this.treeDataProvider.triggers,
            // register commands
            vscode.commands.registerCommand(`${ROOT_NAME}.projectHistory.clearSelection`, async() => {
                this.updateView(undefined);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.projectHistory.revealHistoryView`, async() => {
                vscode.commands.executeCommand(`${ROOT_NAME}.projectHistory.focus`);
            }),
            // on vfs file open
            EventBus.on('fileWillOpenEvent', async ({uri}) => {
                if (this.disposed) { return; }
                const task = setTimeout(() => {
                    this.pendingFileOpenTasks.delete(task);
                    if (this.disposed) { return; }
                    // filter noise read events
                    const activeTextUri = vscode.window.activeTextEditor?.document.uri;
                    if (activeTextUri && activeTextUri.path!==uri.path) { return; }
                    if (!activeTextUri && vscode.workspace.textDocuments.map(d=>d.uri.path).includes(uri.path)) { return; }

                    // filter output folder
                    const {pathParts} = parseUri(uri);
                    if (pathParts[0]===OUTPUT_FOLDER_NAME) { return; }

                    this.updateView( pathParts );
                }, 100);
                this.pendingFileOpenTasks.add(task);
            }),
            //FIXME: on "file://" uri open
        ];
    }
}
