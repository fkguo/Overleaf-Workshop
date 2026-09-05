import * as vscode from 'vscode';
import {link, open, unlink} from 'fs/promises';
import {dirname, join} from 'path';
import { minimatch } from 'minimatch';
import { BaseSCM, CommitItem, SettingItem } from ".";
import { VirtualFileSystem, parseUri } from '../core/remoteFileSystemProvider';
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
} from './localReplicaSafety';

const IGNORE_SETTING_KEY = 'ignore-patterns';
const LOCAL_REPLICA_ECHO_WINDOW_MS = 2_000;

class ReplicaPathTypeConflictError extends Error {}

type FileCache = {date:number, content:Uint8Array|undefined};

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    if (left.length !== right.length) { return false; }
    return left.every((value, index) => value === right[index]);
}

function optionalBytesEqual(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
    if (left === undefined || right === undefined) { return left === right; }
    return bytesEqual(left, right);
}

function cloneContent(content?: Uint8Array): Uint8Array | undefined {
    return content === undefined ? undefined : new Uint8Array(content);
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
    private readonly pathOperations = new ReplicaPathOperationQueue();
    private readonly conflictMessages = new Map<string, string>();
    private vfsWatcher?: vscode.FileSystemWatcher;
    private localWatcher?: vscode.FileSystemWatcher;
    private ignorePatterns: string[] = [
        '**/.*',
        '**/.*/**',
        '**/.overleaf/**',
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
        const cachedContent = cloneContent(content);
        const cache = this.bypassCache.get(relPath) || [undefined,undefined];
        // update the push/pull cache
        if (action==='push') {
            cache[0] = {date, content:cachedContent};
            cache[1] = cache[1] ?? {date, content:cloneContent(content)};
        } else if (action==='pull') {
            cache[1] = {date, content:cachedContent};
            cache[0] = cache[0] ?? {date, content:cloneContent(content)};
        } else {
            cache[0] = {date, content:cachedContent};
            cache[1] = {date, content:cloneContent(content)};
        }
        // write back to the cache
        this.bypassCache.set(relPath, cache as [FileCache,FileCache]);
    }

    private shouldPropagate(action: 'push'|'pull', relPath: string, content?: Uint8Array): boolean {
        const now = Date.now();
        const cache = this.bypassCache.get(relPath);
        if (cache) {
            if (action==='push' && optionalBytesEqual(cache[0].content, content)) { return false; }
            if (action==='pull' && optionalBytesEqual(cache[1].content, content)) { return false; }
            if (!optionalBytesEqual(cache[0].content, cache[1].content)) {
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

    private blockedConflictError(relPath: string): Error | undefined {
        const conflictPath = [...this.blockedConflictPaths].find(blockedPath =>
            relPath === blockedPath || relPath.startsWith(blockedPath + '/')
        );
        if (conflictPath === undefined) { return undefined; }
        return new Error(
            this.conflictMessages.get(conflictPath)
            ?? `Local replica path remains blocked and was not synchronized: ${conflictPath}`,
        );
    }

    /** Suppress ignored paths and known remote-to-local echoes. */
    private shouldBypassPush(
        relPath: string,
        content: Uint8Array | undefined,
        allowPullEcho: boolean,
    ): boolean {
        if (this.matchIgnorePatterns(relPath)) {
            return true;
        }
        const blockedError = this.blockedConflictError(relPath);
        if (blockedError !== undefined) { throw blockedError; }
        if (!allowPullEcho) { return false; }
        const pullCache = this.bypassCache.get(relPath)?.[1];
        const pullCacheAge = pullCache === undefined ? Number.POSITIVE_INFINITY : Date.now() - pullCache.date;
        if (pullCache === undefined ||
            pullCacheAge < 0 ||
            pullCacheAge > LOCAL_REPLICA_ECHO_WINDOW_MS ||
            !optionalBytesEqual(pullCache.content, content)) {
            return false;
        }
        // A filesystem echo token is short-lived and single-use. It must not
        // suppress a later external tool save which happens to restore the
        // same bytes.
        this.bypassCache.delete(relPath);
        return true;
    }

    private async writeLocalFileExclusive(uri: vscode.Uri, content: Uint8Array): Promise<boolean> {
        if (uri.scheme !== 'file') {
            throw new Error(`Local replica exclusive create requires a file URI: ${uri.toString()}`);
        }
        const targetPath = uri.fsPath;
        const timestamp = Date.now();
        for (let attempt = 0; attempt < 100; attempt++) {
            const temporaryPath = join(
                dirname(targetPath),
                replicaTempFileName(timestamp, process.pid, attempt),
            );
            let handle: Awaited<ReturnType<typeof open>> | undefined;
            try {
                handle = await open(temporaryPath, 'wx');
            } catch (error: any) {
                if (error?.code === 'EEXIST') { continue; }
                throw error;
            }
            return publishPreparedReplicaFile(content, {
                prepare: async preparedContent => {
                    await handle!.writeFile(preparedContent);
                    await handle!.sync();
                    await handle!.close();
                    handle = undefined;
                },
                publish: async () => {
                    try {
                        await link(temporaryPath, targetPath);
                        return true;
                    } catch (error: any) {
                        if (error?.code === 'EEXIST') { return false; }
                        throw error;
                    }
                },
                cleanup: async () => {
                    if (handle !== undefined) {
                        await handle.close();
                        handle = undefined;
                    }
                    try {
                        await unlink(temporaryPath);
                    } catch (error: any) {
                        if (error?.code !== 'ENOENT') { throw error; }
                    }
                },
            });
        }
        throw new Error(`Cannot allocate a temporary replica file for ${uri.fsPath}`);
    }

    private localExclusiveCreate(relPath: string) {
        const uri = vscode.Uri.joinPath(this.baseUri, relPath);
        return {create: (content: Uint8Array) => this.writeLocalFileExclusive(uri, content)};
    }

    private async preserveIncomingRemote(relPath: string, content: Uint8Array): Promise<vscode.Uri> {
        if (this.baseUri.scheme !== 'file') {
            throw new Error(`Cannot persist an unapplied remote copy outside a file workspace: ${this.baseUri.toString()}`);
        }
        const incomingDir = vscode.Uri.joinPath(this.baseUri, '.overleaf', 'incoming');
        await vscode.workspace.fs.createDirectory(incomingDir);
        const timestamp = Date.now();
        for (let attempt = 0; attempt < 100; attempt++) {
            const candidate = vscode.Uri.joinPath(
                incomingDir,
                incomingReplicaFileName(relPath, timestamp, attempt),
            );
            if (await this.writeLocalFileExclusive(candidate, content)) {
                return candidate;
            }
        }
        throw new Error(`Cannot allocate an incoming recovery file for ${relPath}`);
    }

    private async blockUnappliedRemote(
        relPath: string,
        remoteContent: Uint8Array | undefined,
        reason: string,
    ): Promise<Error> {
        this.blockedConflictPaths.add(relPath);
        let error: Error;
        if (remoteContent === undefined) {
            error = new Error(`${reason}. The local replica was left untouched; there is no remote file payload to archive.`);
        } else {
            try {
                const recovery = await this.preserveIncomingRemote(relPath, remoteContent);
                error = new Error(
                    `${reason}. The local replica was left untouched; the unapplied remote copy is at ${recovery.fsPath}`,
                );
            } catch (preserveError: any) {
                error = new Error(
                    `${reason}. The local replica was left untouched, but the remote recovery copy could not be persisted: ${preserveError?.message ?? preserveError}`,
                );
            }
        }
        this.conflictMessages.set(relPath, error.message);
        return error;
    }

    /** Convert an unexpected initial-sync failure into an isolated path conflict. */
    private async blockInitialPathFailure(relPath: string, failure: unknown): Promise<void> {
        if (this.blockedConflictError(relPath) !== undefined) { return; }

        // Retry the remote read because the original failure may have happened
        // only on the local side, after a remote write was acknowledged. When
        // readable, that authoritative copy must remain recoverable.
        let remoteContent: Uint8Array | undefined;
        try {
            remoteContent = await this.readCurrentFile(this.vfs.pathToUri(relPath));
        } catch {
            remoteContent = undefined;
        }
        const detail = failure instanceof Error ? failure.message : String(failure);
        await this.blockUnappliedRemote(
            relPath,
            remoteContent,
            `Local replica initial synchronization failed for ${relPath}: ${detail}`,
        );
    }

    private async collectEntries(source: 'remote' | 'local', root: string='/') {
        const entries = new Map<string, vscode.FileType>();
        const failures = new Map<string, unknown>();
        const queue: string[] = [root];
        while (queue.length > 0) {
            const nextRoot = queue.shift()!;
            const uri = source === 'remote' ?
                this.vfs.pathToUri(nextRoot) : vscode.Uri.joinPath(this.baseUri, nextRoot);
            let children: [string, vscode.FileType][];
            try {
                children = await vscode.workspace.fs.readDirectory(uri);
            } catch (error) {
                // If the root itself is unavailable, there is no usable replica
                // to activate. A nested path can instead be isolated while its
                // siblings continue initial synchronization.
                if (nextRoot === root) { throw error; }
                failures.set(nextRoot.replace(/\/$/, ''), error);
                continue;
            }
            for (const [name, type] of children) {
                const relPath = nextRoot + name;
                if (this.matchIgnorePatterns(relPath)) { continue; }
                entries.set(relPath, type);
                if (type === vscode.FileType.Directory) {
                    queue.push(relPath + '/');
                }
            }
        }
        return {entries, failures};
    }

    private async readCurrentFile(uri: vscode.Uri): Promise<Uint8Array | undefined> {
        let stat: vscode.FileStat;
        try {
            stat = await vscode.workspace.fs.stat(uri);
        } catch (error: any) {
            if (error?.code === 'FileNotFound') { return undefined; }
            throw error;
        }
        if (stat.type !== vscode.FileType.File) {
            throw new ReplicaPathTypeConflictError(
                `Replica path changed type while synchronizing: ${uri.toString()}`,
            );
        }
        try {
            return await vscode.workspace.fs.readFile(uri);
        } catch (readError) {
            try {
                const currentStat = await vscode.workspace.fs.stat(uri);
                if (currentStat.type !== vscode.FileType.File) {
                    throw new ReplicaPathTypeConflictError(
                        `Replica path changed type while synchronizing: ${uri.toString()}`,
                    );
                }
            } catch (statError: any) {
                if (statError instanceof ReplicaPathTypeConflictError) { throw statError; }
                if (statError?.code === 'FileNotFound') { return undefined; }
            }
            throw readError;
        }
    }

    private async reconcileInitialFile(relPath: string, allowRemoteHydration: boolean): Promise<boolean> {
        if (this.blockedConflictError(relPath) !== undefined) { return false; }
        const vfsUri = this.vfs.pathToUri(relPath);
        const baseContent = this.baseCache[relPath];
        // Re-read both sides instead of trusting the directory snapshots.
        // A file may have appeared after enumeration; read errors other than
        // confirmed FileNotFound abort rather than imply deletion.
        let localContent: Uint8Array | undefined;
        let remoteContent: Uint8Array | undefined;
        try {
            localContent = await this.readCurrentFile(vscode.Uri.joinPath(this.baseUri, relPath));
            remoteContent = await this.readCurrentFile(vfsUri);
        } catch (error) {
            if (!(error instanceof ReplicaPathTypeConflictError)) { throw error; }
            try {
                remoteContent = await this.readCurrentFile(vfsUri);
            } catch (remoteError) {
                if (!(remoteError instanceof ReplicaPathTypeConflictError)) { throw remoteError; }
                remoteContent = undefined;
            }
            await this.blockUnappliedRemote(
                relPath,
                remoteContent,
                `Local replica path-type race blocked for ${relPath}`,
            );
            return false;
        }
        const reconciliation = reconcileReplicaContents(
            baseContent,
            localContent,
            remoteContent,
            {allowRemoteHydration},
        );
        if (reconciliation.kind === 'conflict' || reconciliation.kind === 'delete-remote') {
            await this.blockUnappliedRemote(
                relPath,
                remoteContent,
                `Local replica initial synchronization blocked for ${relPath}`,
            );
            return false;
        }

        let synchronizedContent: Uint8Array | undefined;
        let localConfirmed = true;
        switch (reconciliation.kind) {
            case 'write-local': {
                localConfirmed = await applyReplicaMutationWithoutOverwrite(
                    localContent,
                    reconciliation.content,
                    this.localExclusiveCreate(relPath),
                );
                synchronizedContent = reconciliation.content;
                break;
            }
            case 'write-remote':
            case 'write-both': {
                const authoritative = await writeWitnessedReplicaText(
                    remoteContent,
                    reconciliation.content,
                    {
                        write: content => vscode.workspace.fs.writeFile(vfsUri, content),
                        readBack: () => vscode.workspace.fs.readFile(vfsUri),
                    },
                );
                localConfirmed = await applyReplicaMutationWithoutOverwrite(
                    localContent,
                    authoritative,
                    this.localExclusiveCreate(relPath),
                );
                synchronizedContent = authoritative;
                break;
            }
            case 'delete-local': {
                localConfirmed = await applyReplicaMutationWithoutOverwrite(
                    localContent,
                    undefined,
                    this.localExclusiveCreate(relPath),
                );
                break;
            }
            case 'absent':
                break;
            case 'unchanged':
                synchronizedContent = reconciliation.content;
                break;
        }
        this.blockedConflictPaths.delete(relPath);
        if (!localConfirmed) {
            await this.blockUnappliedRemote(
                relPath,
                synchronizedContent,
                `Local replica initial synchronization refused to overwrite ${relPath}`,
            );
            return false;
        }
        if (synchronizedContent !== undefined) {
            this.baseCache[relPath] = synchronizedContent;
        } else {
            delete this.baseCache[relPath];
        }
        this.setBypassCache(relPath, synchronizedContent);
        return true;
    }

    private async overwrite(root: string='/', allowRemoteHydration: boolean=false): Promise<boolean|undefined> {
        return await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t('Sync Files'),
            cancellable: true,
        }, async (progress, token) => {
            const [remoteSnapshot, localSnapshot] = await Promise.all([
                this.collectEntries('remote', root),
                this.collectEntries('local', root),
            ]);
            if (token.isCancellationRequested) { return undefined; }

            const remoteEntries = remoteSnapshot.entries;
            const localEntries = localSnapshot.entries;
            const conflicts: string[] = [];
            for (const [relPath, error] of [
                ...remoteSnapshot.failures,
                ...localSnapshot.failures,
            ]) {
                await this.blockInitialPathFailure(relPath, error);
                if (!conflicts.includes(relPath)) { conflicts.push(relPath); }
            }
            const allPaths = new Set([...remoteEntries.keys(), ...localEntries.keys()]);
            const directories = [...allPaths]
                .filter(path => remoteEntries.get(path) === vscode.FileType.Directory ||
                    localEntries.get(path) === vscode.FileType.Directory)
                .sort((left, right) => left.split('/').length - right.split('/').length);
            for (const relPath of directories) {
                if (token.isCancellationRequested) { return false; }
                if (this.blockedConflictError(relPath) !== undefined) {
                    if (!conflicts.includes(relPath)) { conflicts.push(relPath); }
                    continue;
                }
                const remoteType = remoteEntries.get(relPath);
                const localType = localEntries.get(relPath);
                try {
                if (remoteType !== undefined && localType !== undefined && remoteType !== localType) {
                    const remoteContent = remoteType === vscode.FileType.File
                        ? await this.readCurrentFile(this.vfs.pathToUri(relPath))
                        : undefined;
                    await this.blockUnappliedRemote(
                        relPath,
                        remoteContent,
                        `Local replica path-type conflict blocked for ${relPath}`,
                    );
                    conflicts.push(relPath);
                    continue;
                }
                const reconciliation = reconcileReplicaDirectory(
                    localType === vscode.FileType.Directory,
                    remoteType === vscode.FileType.Directory,
                    {allowRemoteHydration},
                );
                if (reconciliation.kind === 'conflict') {
                    await this.blockUnappliedRemote(
                        relPath,
                        undefined,
                        `Local replica directory synchronization blocked for ${relPath}`,
                    );
                    conflicts.push(relPath);
                    continue;
                }
                if (reconciliation.kind === 'create-local') {
                    const remoteUri = this.vfs.pathToUri(relPath);
                    try {
                        const currentRemote = await vscode.workspace.fs.stat(remoteUri);
                        if (currentRemote.type !== vscode.FileType.Directory) {
                            const remoteContent = currentRemote.type === vscode.FileType.File
                                ? await this.readCurrentFile(remoteUri)
                                : undefined;
                            await this.blockUnappliedRemote(
                                relPath,
                                remoteContent,
                                `Local replica remote path changed type during initialization: ${relPath}`,
                            );
                            conflicts.push(relPath);
                            continue;
                        }
                    } catch (error: any) {
                        if (error?.code !== 'FileNotFound') { throw error; }
                        await this.blockUnappliedRemote(
                            relPath,
                            undefined,
                            `Local replica remote directory disappeared during initialization: ${relPath}`,
                        );
                        conflicts.push(relPath);
                        continue;
                    }
                    const localUri = vscode.Uri.joinPath(this.baseUri, relPath);
                    try {
                        await vscode.workspace.fs.createDirectory(localUri);
                    } catch (error) {
                        let currentLocal: vscode.FileStat;
                        try {
                            currentLocal = await vscode.workspace.fs.stat(localUri);
                        } catch {
                            throw error;
                        }
                        if (currentLocal.type !== vscode.FileType.Directory) {
                            await this.blockUnappliedRemote(
                                relPath,
                                undefined,
                                `Local replica local path changed type during initialization: ${relPath}`,
                            );
                            conflicts.push(relPath);
                            continue;
                        }
                    }
                    this.setBypassCache(relPath, new Uint8Array());
                }
                } catch (error) {
                    await this.blockInitialPathFailure(relPath, error);
                    conflicts.push(relPath);
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
                if (token.isCancellationRequested) { return false; }
                progress.report({increment: 100/total, message: relPath});
                let synchronized = false;
                try {
                    synchronized = await this.pathOperations.run(
                        relPath,
                        () => this.reconcileInitialFile(relPath, allowRemoteHydration),
                    );
                } catch (error) {
                    await this.blockInitialPathFailure(relPath, error);
                }
                if (!synchronized) {
                    conflicts.push(relPath);
                }
            }

            if (conflicts.length > 0) {
                const shownPaths = conflicts.slice(0, 5).map(path => {
                    return this.conflictMessages.get(path) ?? path;
                }).join(', ');
                const remaining = conflicts.length - Math.min(conflicts.length, 5);
                const suffix = remaining > 0 ? ` (+${remaining})` : '';
                void vscode.window.showErrorMessage(vscode.l10n.t(
                    'Local replica conflicts were not synchronized: {paths}{suffix}. Make the local and remote copies identical, then reload the window.',
                    {paths: shownPaths, suffix},
                ));
            }

            // Conflicts are isolated to their recorded paths. Keep the watchers
            // active so unrelated files continue to synchronize; only
            // cancellation or an infrastructure exception aborts activation.
            return true;
        });
    }

    private bypassSync(action:'push'|'pull', type:'update'|'delete', relPath: string, content?: Uint8Array): boolean {
        // bypass ignore files
        if (this.matchIgnorePatterns(relPath)) {
            return true;
        }
        // An initial conflict has no trustworthy ancestor. Block both directions
        // until the user reconciles the copies and reloads the provider. Never
        // silently report a later local save as synchronized.
        const blockedError = this.blockedConflictError(relPath);
        if (blockedError !== undefined) { throw blockedError; }
        // synchronization propagation check
        if (!this.shouldPropagate(action, relPath, content)) {
            return true;
        }
        // otherwise, log the synchronization
        console.log(`${new Date().toLocaleString()} [${action}] ${type} "${relPath}"`);
        return false;
    }

    private async applyPullSync(
        type: 'update'|'delete',
        relPath: string,
        fromUri: vscode.Uri,
        toUri: vscode.Uri,
    ): Promise<void> {
        const blockedError = this.blockedConflictError(relPath);
        if (blockedError !== undefined) { throw blockedError; }
        const capturedLocal = await this.readCurrentFile(toUri);
        const remoteContent = type === 'delete' ? undefined : await this.readCurrentFile(fromUri);
        if (type === 'update' && remoteContent === undefined) {
            // The update raced a remote deletion. Let the delete event (or a
            // later reconciliation) decide it rather than infer a mutation.
            return;
        }
        if (this.bypassSync('pull', type, relPath, remoteContent)) { return; }

        const reconciliation = reconcileReplicaContents(
            this.baseCache[relPath],
            capturedLocal,
            remoteContent,
        );
        if (reconciliation.kind === 'conflict') {
            const error = await this.blockUnappliedRemote(
                relPath,
                remoteContent,
                `Local replica conflict blocked for ${relPath} (${reconciliation.reason})`,
            );
            throw error;
        }
        if (reconciliation.kind === 'delete-remote') {
            const error = await this.blockUnappliedRemote(
                relPath,
                remoteContent,
                `Local replica remote delete blocked without a conditional mutation capability: ${relPath}`,
            );
            throw error;
        }

        let authoritative: Uint8Array | undefined;
        let localConfirmed = true;
        switch (reconciliation.kind) {
            case 'write-local': {
                localConfirmed = await applyReplicaMutationWithoutOverwrite(
                    capturedLocal,
                    reconciliation.content,
                    this.localExclusiveCreate(relPath),
                );
                authoritative = reconciliation.content;
                break;
            }
            case 'write-remote':
            case 'write-both': {
                authoritative = await writeWitnessedReplicaText(
                    remoteContent,
                    reconciliation.content,
                    {
                        write: content => vscode.workspace.fs.writeFile(fromUri, content),
                        readBack: () => vscode.workspace.fs.readFile(fromUri),
                    },
                );
                localConfirmed = await applyReplicaMutationWithoutOverwrite(
                    capturedLocal,
                    authoritative,
                    this.localExclusiveCreate(relPath),
                );
                break;
            }
            case 'delete-local': {
                localConfirmed = await applyReplicaMutationWithoutOverwrite(
                    capturedLocal,
                    undefined,
                    this.localExclusiveCreate(relPath),
                );
                break;
            }
            case 'unchanged':
                authoritative = reconciliation.content;
                break;
            case 'absent':
                break;
        }

        this.blockedConflictPaths.delete(relPath);
        if (!localConfirmed) {
            const error = await this.blockUnappliedRemote(
                relPath,
                authoritative,
                `Local replica synchronization refused to overwrite ${relPath}`,
            );
            throw error;
        }
        if (authoritative === undefined) {
            delete this.baseCache[relPath];
        } else {
            this.baseCache[relPath] = authoritative;
        }
        this.setBypassCache(relPath, authoritative);
    }

    private async applySync(
        action:'push'|'pull',
        type: 'update'|'delete',
        relPath:string,
        fromUri: vscode.Uri,
        toUri: vscode.Uri,
        allowPullEcho: boolean=false,
    ) {
        this.status = {status: action, message: `${type}: ${relPath}`};

        try {
            if (action === 'pull') {
                const blockedError = this.blockedConflictError(relPath);
                if (blockedError !== undefined) { throw blockedError; }
                if (type === 'update') {
                    const remoteStat = await vscode.workspace.fs.stat(fromUri);
                    if (remoteStat.type === vscode.FileType.Directory) {
                        const marker = new Uint8Array();
                        if (this.bypassSync('pull', type, relPath, marker)) { return; }
                        try {
                            const localStat = await vscode.workspace.fs.stat(toUri);
                            if (localStat.type !== vscode.FileType.Directory) {
                                this.blockedConflictPaths.add(relPath);
                                throw new Error(`Local replica path-type conflict blocked: ${relPath}`);
                            }
                        } catch (error: any) {
                            if (error?.code !== 'FileNotFound') { throw error; }
                            await vscode.workspace.fs.createDirectory(toUri);
                        }
                        this.setBypassCache(relPath, marker);
                        return;
                    }
                } else {
                    try {
                        const localStat = await vscode.workspace.fs.stat(toUri);
                        if (localStat.type === vscode.FileType.Directory) {
                            this.blockedConflictPaths.add(relPath);
                            throw new Error(`Local replica remote directory deletion blocked: ${relPath}`);
                        }
                    } catch (error: any) {
                        if (error?.code !== 'FileNotFound') { throw error; }
                    }
                }
                await this.applyPullSync(type, relPath, fromUri, toUri);
                return;
            }
            if (type==='delete') {
                const newContent = undefined;
                if (this.shouldBypassPush(relPath, newContent, allowPullEcho)) { return; }
                throw new Error(`Local replica remote delete blocked without a conditional mutation capability: ${relPath}`);
            } else {
                const stat = await vscode.workspace.fs.stat(fromUri);
                if (stat.type===vscode.FileType.Directory) {
                    const newContent = new Uint8Array();
                    if (this.shouldBypassPush(relPath, newContent, allowPullEcho)) { return; }
                    try {
                        const remoteStat = await vscode.workspace.fs.stat(toUri);
                        if (remoteStat.type === vscode.FileType.Directory) { return; }
                        throw new Error(`Local replica path-type conflict blocked: ${relPath}`);
                    } catch (error: any) {
                        if (error?.code !== 'FileNotFound') { throw error; }
                    }
                    throw new Error(`Local replica remote directory creation blocked without a conditional mutation capability: ${relPath}`);
                }
                else if (stat.type===vscode.FileType.File) {
                    const newContent = await vscode.workspace.fs.readFile(fromUri);
                    if (this.shouldBypassPush(relPath, newContent, allowPullEcho)) { return; }
                    const remoteContent = await this.readCurrentFile(toUri);
                    if (remoteContent === undefined) {
                        throw new Error(`Local replica remote file creation blocked without a conditional mutation capability: ${relPath}`);
                    }
                    const reconciliation = reconcileReplicaContents(
                        this.baseCache[relPath],
                        newContent,
                        remoteContent,
                    );
                    if (reconciliation.kind === 'conflict') {
                        const error = await this.blockUnappliedRemote(
                            relPath,
                            remoteContent,
                            `Local replica conflict blocked for ${relPath} (${reconciliation.reason})`,
                        );
                        throw error;
                    }
                    if (reconciliation.kind === 'delete-local' ||
                        reconciliation.kind === 'delete-remote' ||
                        reconciliation.kind === 'absent') {
                        const error = await this.blockUnappliedRemote(
                            relPath,
                            remoteContent,
                            `Local replica remote mutation blocked without a conditional delete/create capability: ${relPath}`,
                        );
                        throw error;
                    }

                    let authoritative: Uint8Array;
                    if (reconciliation.kind === 'write-remote' ||
                        reconciliation.kind === 'write-both') {
                        authoritative = await writeWitnessedReplicaText(
                            remoteContent,
                            reconciliation.content,
                            {
                                write: content => vscode.workspace.fs.writeFile(toUri, content),
                                readBack: () => vscode.workspace.fs.readFile(toUri),
                            },
                        );
                    } else {
                        authoritative = reconciliation.content;
                    }
                    const localConfirmed = await applyReplicaMutationWithoutOverwrite(
                        newContent,
                        authoritative,
                        this.localExclusiveCreate(relPath),
                    );
                    if (!localConfirmed) {
                        const error = await this.blockUnappliedRemote(
                            relPath,
                            authoritative,
                            `Local replica synchronization refused to overwrite ${relPath}`,
                        );
                        throw error;
                    }
                    this.blockedConflictPaths.delete(relPath);
                    this.baseCache[relPath] = authoritative;
                    this.setBypassCache(relPath, authoritative);
                    return;
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
        return this.pathOperations.run(
            relPath,
            () => this.applySync('pull', type, relPath, vfsUri, localUri),
        );
    }

    private async syncToVFS(
        localUri: vscode.Uri,
        type: 'update'|'delete',
        allowPullEcho: boolean=false,
    ) {
        // get relative path to baseUri
        const basePath = this.baseUri.path;
        const relPath = localUri.path.slice(basePath.length);
        const vfsUri = this.vfs.pathToUri(relPath);
        return this.pathOperations.run(
            relPath,
            () => this.applySync('push', type, relPath, localUri, vfsUri, allowPullEcho),
        );
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
        await this.syncToVFS(docUri, 'update', false);
    }

    private async initWatch() {
        // write ".overleaf/settings.json" if not exist
        const settingUri = vscode.Uri.joinPath(this.baseUri, '.overleaf/settings.json');
        let allowRemoteHydration = false;
        let writeSettingsAfterInitialSync = false;
        try {
            await vscode.workspace.fs.stat(settingUri);
        } catch (error: any) {
            if (error?.code !== 'FileNotFound') { throw error; }
            allowRemoteHydration = true;
            writeSettingsAfterInitialSync = true;
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.baseUri, '.overleaf'));
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
        const dispatch = (operation: () => Promise<void>, direction: 'push'|'pull') => {
            const reportedOperation = async () => {
                try {
                    await operation();
                } catch (error) {
                    console.error('Local replica synchronization failed', error);
                    const detail = error instanceof Error ? error.message : String(error);
                    const message = direction === 'push'
                        ? vscode.l10n.t(
                            'The local file was saved, but it was not synchronized to Overleaf: {detail}',
                            {detail},
                        )
                        : vscode.l10n.t(
                            'A remote Overleaf change was not applied to the local replica: {detail}',
                            {detail},
                        );
                    void vscode.window.showErrorMessage(message);
                }
            };
            if (initialSync) {
                queuedEvents.push(reportedOperation);
            } else {
                void reportedOperation();
            }
        };

        // By default, only explicit editor saves push file modifications. Users who
        // rely on external tools can opt into file-system change events instead.
        // Keep these listeners mutually exclusive so an editor save is not pushed twice.
        const localChangeListener = syncOnFileChange
            ? this.localWatcher.onDidChange(uri => dispatch(
                () => this.syncToVFS(uri, 'update', true),
                'push',
            ))
            : vscode.workspace.onDidSaveTextDocument(doc => dispatch(
                () => this.onDocumentSaved(doc),
                'push',
            ));

        const watches = [
            // sync from vfs to local
            this.vfsWatcher.onDidChange(uri => dispatch(
                () => this.syncFromVFS(uri, 'update'),
                'pull',
            )),
            this.vfsWatcher.onDidCreate(uri => dispatch(
                () => this.syncFromVFS(uri, 'update'),
                'pull',
            )),
            this.vfsWatcher.onDidDelete(uri => dispatch(
                () => this.syncFromVFS(uri, 'delete'),
                'pull',
            )),
            // sync from local to vfs: file updates use the configured listener above;
            // file creation and deletion still always use the file-system watcher
            localChangeListener,
            this.localWatcher.onDidCreate(uri => dispatch(
                () => this.syncToVFS(uri, 'update', true),
                'push',
            )),
            this.localWatcher.onDidDelete(uri => dispatch(
                () => this.syncToVFS(uri, 'delete', true),
                'push',
            )),
        ];
        const disposeWatches = () => {
            watches.forEach(watch => watch.dispose());
            this.vfsWatcher?.dispose();
            this.localWatcher?.dispose();
            this.vfsWatcher = undefined;
            this.localWatcher = undefined;
        };
        await completeInitialReplicaSync(
            () => this.overwrite('/', allowRemoteHydration),
            disposeWatches,
            () => finishInitialReplicaActivation(
                async () => {
                    // The settings file is also the persistent witness that first
                    // hydration completed. Keep events queued during this await,
                    // then drain them before the synchronous activation below.
                    if (writeSettingsAfterInitialSync) {
                        const created = await this.writeLocalFileExclusive(settingUri, Buffer.from(
                            JSON.stringify({
                                'uri': this.vfs.origin.toString(),
                                'serverName': this.vfs.serverName,
                                'enableCompileNPreview': false,
                                'projectName': this.vfs.projectName,
                            }, null, 4)
                        ));
                        if (!created) {
                            throw new Error(
                                'Local replica settings appeared during initialization and were left untouched',
                            );
                        }
                    }
                },
                queuedEvents,
                () => { initialSync = false; },
            ),
        );
        return watches;
    }

    writeFile(relPath: string, _content: Uint8Array): Thenable<void> {
        return Promise.reject(new Error(
            `Direct Local Replica writes are blocked because they cannot prove a no-overwrite condition: ${relPath}`,
        ));
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
