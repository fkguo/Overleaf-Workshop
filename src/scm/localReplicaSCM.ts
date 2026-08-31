import * as vscode from 'vscode';
import { minimatch } from 'minimatch';
import { BaseSCM, CommitItem, SettingItem } from ".";
import { VirtualFileSystem, parseUri } from '../core/remoteFileSystemProvider';
import { reconcileReplicaContents } from './localReplicaSafety';

const IGNORE_SETTING_KEY = 'ignore-patterns';

type FileCache = {date:number, hash:number};

/**
 * Returns a hash code from a string
 * @param  {String} str The string to hash.
 * @return {Number}    A 32bit integer
 * @see http://werxltd.com/wp/2010/05/13/javascript-implementation-of-javas-string-hashcode-method/
 */
function hashCode(content?: Uint8Array): number {
    if (content===undefined) { return -1; }
    const str = new TextDecoder().decode(content);

    let hash = 0;
    for (let i = 0, len = str.length; i < len; i++) {
        const chr = str.charCodeAt(i);
        hash = (hash << 5) - hash + chr;
        hash |= 0; // Convert to 32bit integer
    }
    return hash;
}

/**
 * A SCM which tracks exact the changes from the vfs.
 * It keeps no history versions.
 */
export class LocalReplicaSCMProvider extends BaseSCM {
    public static readonly label = vscode.l10n.t('Local Replica');

    public readonly iconPath: vscode.ThemeIcon = new vscode.ThemeIcon('folder-library');

    private bypassCache: Map<string, [FileCache,FileCache]> = new Map();
    private baseCache: {[key:string]: Uint8Array} = {};
    private blockedConflictPaths = new Set<string>();
    private vfsWatcher?: vscode.FileSystemWatcher;
    private localWatcher?: vscode.FileSystemWatcher;
    private ignorePatterns: string[] = [
        '**/.*',
        '**/.*/**',
        '**/*.aux',
        '**/__latexindent*',
        '**/*.bbl',
        '**/*.bcf',
        '**/*.blg',
        '**/*.fdb_latexmk',
        '**/*.fls',
        '**/*.git',
        '**/*.lof',
        '**/*.log',
        '**/*.lot',
        '**/*.out',
        '**/*.run.xml',
        '**/*.synctex(busy)',
        '**/*.synctex.gz',
        '**/*.toc',
        '**/*.xdv',
        '**/main.pdf',
        '**/output.pdf',
    ];

    constructor(
        protected readonly vfs: VirtualFileSystem,
        public readonly baseUri: vscode.Uri,
    ) {
        super(vfs, baseUri);
    }

    private static sanitizeProjectFolderName(projectName: string): string {
        let sanitized = projectName;
        if (process.platform==='win32') {
            sanitized = projectName
                .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
                .replace(/[. ]+$/g, '');
            if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(sanitized)) {
                sanitized = `${sanitized}_`;
            }
        } else {
            sanitized = projectName.replace(/[\/\x00]/g, '_');
        }
        if (sanitized==='' || sanitized==='.' || sanitized==='..') {
            sanitized = 'untitled-project';
        }
        return sanitized;
    }

    public static async validateBaseUri(uri: string, projectName?: string): Promise<vscode.Uri> {
        try {
            let baseUri = vscode.Uri.file(uri);
            const folderName = projectName===undefined ? undefined : LocalReplicaSCMProvider.sanitizeProjectFolderName(projectName);
            // check if the path exists
            try {
                const stat = await vscode.workspace.fs.stat(baseUri);
                if (stat.type!==vscode.FileType.Directory) {
                    throw new Error('Not a folder');
                }
                // check if the project name is included in the path
                if (folderName!==undefined && !baseUri.path.endsWith(`/${folderName}`)) {
                    baseUri = vscode.Uri.joinPath(baseUri, folderName);
                }
            } catch {
                // keep the baseUri as is
            }
            // try to create the folder with `mkdirp` semantics
            await vscode.workspace.fs.createDirectory(baseUri);
            await vscode.workspace.fs.stat(baseUri);
            return baseUri;
        } catch (error) {
            vscode.window.showErrorMessage( vscode.l10n.t('Invalid Path. Please make sure the absolute path to a folder with read/write permissions is used.') );
            return Promise.reject(error);
        }
    }

    public static async pathToUri(path: string): Promise<vscode.Uri | undefined> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (workspaceRoot===undefined || workspaceRoot?.scheme!=='file') { return undefined; }

        const settingUri = vscode.Uri.joinPath(workspaceRoot, '.overleaf/settings.json');
        try {
            await vscode.workspace.fs.stat(settingUri);
            return vscode.Uri.joinPath(workspaceRoot, path);
        } catch (error) {
            return undefined;
        }
    }

    public static async uriToPath(uri: vscode.Uri): Promise<string | undefined> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (workspaceRoot===undefined || workspaceRoot?.scheme!=='file') { return undefined; }

        const settingUri = vscode.Uri.joinPath(workspaceRoot, '.overleaf/settings.json');
        try {
            await vscode.workspace.fs.stat(settingUri);
            return uri.path.slice(workspaceRoot.path.length);
        } catch (error) {
            return undefined;
        }
    }

    public static async readSettings(): Promise<any | undefined> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (vscode.workspace.workspaceFolders?.length!==1 || workspaceRoot?.scheme!=='file') { return undefined; }

        const settingUri = vscode.Uri.joinPath(workspaceRoot, '.overleaf/settings.json');
        try {
            await vscode.workspace.fs.stat(settingUri);
            const content = await vscode.workspace.fs.readFile(settingUri);
            return JSON.parse( new TextDecoder().decode(content) );
        } catch (error) {
            return undefined;
        }
    }

    private matchIgnorePatterns(path: string): boolean {
        const ignorePatterns = this.getSetting<string[]>(IGNORE_SETTING_KEY) || this.ignorePatterns;
        for (const pattern of ignorePatterns) {
            if (minimatch(path, pattern, {dot:true})) {
                return true;
            }
        }
        return false;
    }

    private setBypassCache(relPath: string, content?: Uint8Array, action?: 'push'|'pull') {
        const date = Date.now();
        const hash = hashCode(content);
        const cache = this.bypassCache.get(relPath) || [undefined,undefined];
        // update the push/pull cache
        if (action==='push') {
            cache[0] = {date, hash};
            cache[1] = cache[1] ?? {date, hash};
        } else if (action==='pull') {
            cache[1] = {date, hash};
            cache[0] = cache[0] ?? {date, hash};
        } else {
            cache[0] = {date, hash};
            cache[1] = {date, hash};
        }
        // write back to the cache
        this.bypassCache.set(relPath, cache as [FileCache,FileCache]);
    }

    private shouldPropagate(action: 'push'|'pull', relPath: string, content?: Uint8Array): boolean {
        const now = Date.now();
        const cache = this.bypassCache.get(relPath);
        if (cache) {
            const thisHash = hashCode(content);
            // console.log(action, relPath, `[${cache[0].hash}, ${cache[1].hash}]`, thisHash);
            if (action==='push' && cache[0].hash===thisHash) { return false; }
            if (action==='pull' && cache[1].hash===thisHash) { return false; }
            if (cache[0].hash!==cache[1].hash) {
                if (action==='push' && now-cache[0].date<500 || action==='pull' && now-cache[1].date<500) {
                    this.setBypassCache(relPath, content, action);
                    return true;
                }
                this.setBypassCache(relPath, content, action);
                return false;
            }
        }
        this.setBypassCache(relPath, content, action);
        return true;
    }

    private async collectEntries(source: 'remote' | 'local', root: string='/') {
        const entries = new Map<string, vscode.FileType>();
        const queue: string[] = [root];
        while (queue.length > 0) {
            const nextRoot = queue.shift()!;
            const uri = source === 'remote' ?
                this.vfs.pathToUri(nextRoot) : vscode.Uri.joinPath(this.baseUri, nextRoot);
            for (const [name, type] of await vscode.workspace.fs.readDirectory(uri)) {
                const relPath = nextRoot + name;
                if (this.matchIgnorePatterns(relPath)) { continue; }
                entries.set(relPath, type);
                if (type === vscode.FileType.Directory) {
                    queue.push(relPath + '/');
                }
            }
        }
        return entries;
    }

    private async readCurrentFile(uri: vscode.Uri): Promise<Uint8Array | undefined> {
        try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.type !== vscode.FileType.File) {
                throw new Error(`Replica path changed type while synchronizing: ${uri.toString()}`);
            }
            return await vscode.workspace.fs.readFile(uri);
        } catch (error: any) {
            if (error?.code === 'FileNotFound') { return undefined; }
            throw error;
        }
    }

    private async overwrite(root: string='/'): Promise<boolean|undefined> {
        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t('Sync Files'),
            cancellable: true,
        }, async (progress, token) => {
            const [remoteEntries, localEntries] = await Promise.all([
                this.collectEntries('remote', root),
                this.collectEntries('local', root),
            ]);
            if (token.isCancellationRequested) { return undefined; }

            const conflicts: string[] = [];
            const allPaths = new Set([...remoteEntries.keys(), ...localEntries.keys()]);
            const directories = [...allPaths]
                .filter(path => remoteEntries.get(path) === vscode.FileType.Directory ||
                    localEntries.get(path) === vscode.FileType.Directory)
                .sort((left, right) => left.split('/').length - right.split('/').length);
            for (const relPath of directories) {
                const remoteType = remoteEntries.get(relPath);
                const localType = localEntries.get(relPath);
                if (remoteType !== undefined && localType !== undefined && remoteType !== localType) {
                    this.blockedConflictPaths.add(relPath);
                    conflicts.push(relPath);
                    continue;
                }
                if (remoteType === undefined) {
                    await vscode.workspace.fs.createDirectory(this.vfs.pathToUri(relPath));
                    this.setBypassCache(relPath, new Uint8Array());
                } else if (localType === undefined) {
                    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.baseUri, relPath));
                    this.setBypassCache(relPath, new Uint8Array());
                }
            }

            const hasBlockedAncestor = (path: string) => conflicts.some(conflict =>
                path === conflict || path.startsWith(conflict + '/')
            );
            const files = [...allPaths].filter(path =>
                !hasBlockedAncestor(path) &&
                (remoteEntries.get(path) !== vscode.FileType.Directory) &&
                (localEntries.get(path) !== vscode.FileType.Directory)
            );
            const total = files.length;
            for (let i=0; i<total; i++) {
                const relPath = files[i];
                const vfsUri = this.vfs.pathToUri(relPath);
                if (token.isCancellationRequested) { return false; }
                progress.report({increment: 100/total, message: relPath});
                //
                const baseContent = this.baseCache[relPath];
                // Re-read both sides instead of trusting the directory snapshots.
                // A file may have appeared after enumeration; read errors other
                // than confirmed FileNotFound abort rather than imply deletion.
                const localContent = await this.readCurrentFile(
                    vscode.Uri.joinPath(this.baseUri, relPath),
                );
                const remoteContent = await this.readCurrentFile(vfsUri);
                const reconciliation = reconcileReplicaContents(baseContent, localContent, remoteContent);
                if (reconciliation.kind === 'conflict') {
                    this.blockedConflictPaths.add(relPath);
                    conflicts.push(relPath);
                    continue;
                }

                switch (reconciliation.kind) {
                    case 'write-local':
                        await this.writeFile(relPath, reconciliation.content);
                        break;
                    case 'write-remote':
                        await vscode.workspace.fs.writeFile(vfsUri, reconciliation.content);
                        break;
                    case 'write-both':
                        await this.writeFile(relPath, reconciliation.content);
                        await vscode.workspace.fs.writeFile(vfsUri, reconciliation.content);
                        break;
                    case 'delete-local':
                        await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.baseUri, relPath));
                        break;
                    case 'delete-remote':
                        await vscode.workspace.fs.delete(vfsUri);
                        break;
                    case 'absent':
                    case 'unchanged':
                        break;
                }
                this.blockedConflictPaths.delete(relPath);
                if ('content' in reconciliation) {
                    this.baseCache[relPath] = reconciliation.content;
                    this.setBypassCache(relPath, reconciliation.content);
                } else {
                    delete this.baseCache[relPath];
                    this.setBypassCache(relPath, undefined);
                }
            }

            if (conflicts.length > 0) {
                const shownPaths = conflicts.slice(0, 5).join(', ');
                const remaining = conflicts.length - Math.min(conflicts.length, 5);
                const suffix = remaining > 0 ? ` (+${remaining})` : '';
                void vscode.window.showErrorMessage(vscode.l10n.t(
                    'Local replica conflicts were not synchronized: {paths}{suffix}. Make the local and remote copies identical, then reload the window.',
                    {paths: shownPaths, suffix},
                ));
            }

            return conflicts.length === 0;
        });
    }

    private bypassSync(action:'push'|'pull', type:'update'|'delete', relPath: string, content?: Uint8Array): boolean {
        // bypass ignore files
        if (this.matchIgnorePatterns(relPath)) {
            return true;
        }
        // An initial conflict has no trustworthy ancestor. Block both directions
        // until the user reconciles the copies and reloads the provider.
        if ([...this.blockedConflictPaths].some(conflictPath =>
            relPath === conflictPath || relPath.startsWith(conflictPath + '/')
        )) {
            return true;
        }
        // synchronization propagation check
        if (!this.shouldPropagate(action, relPath, content)) {
            return true;
        }
        // otherwise, log the synchronization
        console.log(`${new Date().toLocaleString()} [${action}] ${type} "${relPath}"`);
        return false;
    }

    private async applySync(action:'push'|'pull', type: 'update'|'delete', relPath:string, fromUri: vscode.Uri, toUri: vscode.Uri) {
        this.status = {status: action, message: `${type}: ${relPath}`};

        try {
            if (type==='delete') {
                const newContent = undefined;
                if (this.bypassSync(action, type, relPath, newContent)) { return; }
                delete this.baseCache[relPath];
                await vscode.workspace.fs.delete(toUri, {recursive:true});
            } else {
                const stat = await vscode.workspace.fs.stat(fromUri);
                if (stat.type===vscode.FileType.Directory) {
                    const newContent = new Uint8Array();
                    if (this.bypassSync(action, type, relPath, newContent)) { return; }
                    await vscode.workspace.fs.createDirectory(toUri);
                }
                else if (stat.type===vscode.FileType.File) {
                    const newContent = await vscode.workspace.fs.readFile(fromUri);
                    if (this.bypassSync(action, type, relPath, newContent)) { return; }
                    await vscode.workspace.fs.writeFile(toUri, newContent);
                    this.baseCache[relPath] = newContent;
                    if (action==='push') { await vscode.workspace.fs.readFile(toUri); } // update remote cache
                }
                else {
                    console.error(`Unknown file type: ${stat.type}`);
                }
            }
        } finally {
            this.status = {status: 'idle', message: ''};
        }
    }

    private async syncFromVFS(vfsUri: vscode.Uri, type: 'update'|'delete') {
        const {pathParts} = parseUri(vfsUri);
        pathParts.at(-1)==='' && pathParts.pop(); // remove the last empty string
        const relPath = ('/' + pathParts.join('/'));
        const localUri = vscode.Uri.joinPath(this.baseUri, relPath);
        return this.applySync('pull', type, relPath, vfsUri, localUri);
    }

    private async syncToVFS(localUri: vscode.Uri, type: 'update'|'delete') {
        // get relative path to baseUri
        const basePath = this.baseUri.path;
        const relPath = localUri.path.slice(basePath.length);
        const vfsUri = this.vfs.pathToUri(relPath);
        return this.applySync('push', type, relPath, localUri, vfsUri);
    }

    /**
     * Push a saved document to the VFS.
     * Only fires for explicit user saves in the editor, not for external
     * file modifications (git, compilation tools, etc.).
     * This is the general fix for issues #299 and #323.
     */
    private async onDocumentSaved(doc: vscode.TextDocument) {
        const docUri = doc.uri;
        // Only sync files within our baseUri (ensure path separator boundary)
        const basePath = this.baseUri.path.endsWith('/') ? this.baseUri.path : this.baseUri.path + '/';
        if (!docUri.path.startsWith(basePath)) { return; }
        await this.syncToVFS(docUri, 'update');
    }

    private async initWatch() {
        // write ".overleaf/settings.json" if not exist
        const settingUri = vscode.Uri.joinPath(this.baseUri, '.overleaf/settings.json');
        try {
            await vscode.workspace.fs.stat(settingUri);
        } catch (error) {
            await vscode.workspace.fs.writeFile(settingUri, Buffer.from(
                JSON.stringify({
                    'uri': this.vfs.origin.toString(),
                    'serverName': this.vfs.serverName,
                    'enableCompileNPreview': false,
                    'projectName': this.vfs.projectName,
                }, null, 4)
            ));
        }

        this.vfsWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern( this.vfs.origin, '**/*' )
        );
        this.localWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern( this.baseUri.path, '**/*' )
        );

        const syncOnFileChange = vscode.workspace
            .getConfiguration('overleaf-workshop.localReplica.syncOnFileChange')
            .get<boolean>('enabled', false);

        const queuedEvents: Array<() => Promise<void>> = [];
        let initialSync = true;
        const dispatch = (operation: () => Promise<void>) => {
            if (initialSync) {
                queuedEvents.push(operation);
            } else {
                void operation().catch(error => console.error('Local replica synchronization failed', error));
            }
        };

        // By default, only explicit editor saves push file modifications. Users who
        // rely on external tools can opt into file-system change events instead.
        // Keep these listeners mutually exclusive so an editor save is not pushed twice.
        const localChangeListener = syncOnFileChange
            ? this.localWatcher.onDidChange(uri => dispatch(() => this.syncToVFS(uri, 'update')))
            : vscode.workspace.onDidSaveTextDocument(doc => dispatch(() => this.onDocumentSaved(doc)));

        const watches = [
            // sync from vfs to local
            this.vfsWatcher.onDidChange(uri => dispatch(() => this.syncFromVFS(uri, 'update'))),
            this.vfsWatcher.onDidCreate(uri => dispatch(() => this.syncFromVFS(uri, 'update'))),
            this.vfsWatcher.onDidDelete(uri => dispatch(() => this.syncFromVFS(uri, 'delete'))),
            // sync from local to vfs: file updates use the configured listener above;
            // file creation and deletion still always use the file-system watcher
            localChangeListener,
            this.localWatcher.onDidCreate(uri => dispatch(() => this.syncToVFS(uri, 'update'))),
            this.localWatcher.onDidDelete(uri => dispatch(() => this.syncToVFS(uri, 'delete'))),
        ];
        try {
            await this.overwrite();
        } catch (error) {
            watches.forEach(watch => watch.dispose());
            this.vfsWatcher.dispose();
            this.localWatcher.dispose();
            throw error;
        } finally {
            initialSync = false;
        }
        for (const operation of queuedEvents) {
            await operation().catch(error => console.error('Queued local replica synchronization failed', error));
        }
        return watches;
    }

    writeFile(relPath: string, content: Uint8Array): Thenable<void> {
        const uri = vscode.Uri.joinPath(this.baseUri, relPath);
        return vscode.workspace.fs.writeFile(uri, content);
    }

    readFile(relPath: string): Thenable<Uint8Array|undefined> {
        const uri = vscode.Uri.joinPath(this.baseUri, relPath);
        return new Promise(async (resolve, reject) => {
            try {
                const content = await vscode.workspace.fs.readFile(uri);
                resolve(content);
            } catch (error) {
                resolve(undefined);
            }
        });
    }

    get triggers(): Promise<vscode.Disposable[]> {
        return this.initWatch().then((watches) => {
            if (this.vfsWatcher!==undefined && this.localWatcher!==undefined) {
                return [
                    this.vfsWatcher,
                    this.localWatcher,
                    ...watches,
                ];
            } else {
                return [];
            }
        });
    }

    public static get baseUriInputBox(): vscode.QuickPick<vscode.QuickPickItem> {
        const sep = require('path').sep;
        const inputBox = vscode.window.createQuickPick();
        inputBox.placeholder = vscode.l10n.t('e.g., /home/user/empty/local/folder');
        inputBox.value = require('os').homedir()+sep;
        // enable auto-complete
        inputBox.onDidChangeValue(async value => {
            try {
                // remove the last part of the path
                inputBox.busy = true;
                const path = value.split(sep).slice(0, -1).join(sep);
                const items = await vscode.workspace.fs.readDirectory( vscode.Uri.file(path) );
                const subDirs = items.filter( ([name, type]) => type===vscode.FileType.Directory )
                                    .filter( ([name, type]) => `${path}${sep}${name}`.startsWith(value) );
                inputBox.busy = false;
                // update the sub-directories
                if (subDirs.length!==0) {
                    const candidates = subDirs.map(([name, type]) => ({label:name, alwaysShow:true, picked:false}));
                    if (path!=='') {
                        candidates.unshift({label:'..', alwaysShow:true, picked:false});
                    }
                    inputBox.items = candidates;
                }
            }
            finally {
                inputBox.activeItems = [];
            }
        });
        inputBox.onDidAccept(() => {
            if (inputBox.activeItems.length!==0) {
                const selected = inputBox.selectedItems[0];
                const path = inputBox.value.split(sep).slice(0, -1).join(sep);
                inputBox.value = selected.label==='..'? path : `${path}${sep}${selected.label}${sep}`;
            }
        });
        return inputBox;
    }

    get settingItems(): SettingItem[] {
        return [
            // configure ignore patterns
            {
                label: vscode.l10n.t('Configure sync ignore patterns ...'),
                callback: async () => {
                    const ignorePatterns = (this.getSetting<string[]>(IGNORE_SETTING_KEY) || this.ignorePatterns).sort();
                    const quickPick = vscode.window.createQuickPick();
                    quickPick.ignoreFocusOut = true;
                    quickPick.title = vscode.l10n.t('Press Enter to add a new pattern, or click the trash icon to remove a pattern.');
                    quickPick.items = ignorePatterns.map(pattern => ({
                        label: pattern,
                        buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                    }));
                    // remove pattern when click the trash icon
                    quickPick.onDidTriggerItemButton(async ({item}) => {
                        const index = ignorePatterns.indexOf(item.label);
                        ignorePatterns.splice(index, 1);
                        await this.setSetting(IGNORE_SETTING_KEY, ignorePatterns);
                        quickPick.items = ignorePatterns.map(pattern => ({
                            label: pattern,
                            buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                        }));
                    });
                    // add new pattern when not exist
                    quickPick.onDidAccept(async () => {
                        if (quickPick.selectedItems.length===0) {
                            const pattern = quickPick.value;
                            if (pattern!=='') {
                                ignorePatterns.push(pattern);
                                await this.setSetting(IGNORE_SETTING_KEY, ignorePatterns);
                                quickPick.items = ignorePatterns.map(pattern => ({
                                    label: pattern,
                                    buttons: [{iconPath: new vscode.ThemeIcon('trash')}],
                                }));
                                quickPick.value = '';
                            }
                        }
                    });
                    // show the quick pick
                    quickPick.show();
                },
            },
        ];
    }

    list(): Iterable<CommitItem> { return []; }
    async apply(commitItem: CommitItem): Promise<void> { return Promise.resolve(); }
    syncFromSCM(commits: Iterable<CommitItem>): Promise<void> { return Promise.resolve(); }
}
