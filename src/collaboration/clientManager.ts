/* eslint-disable @typescript-eslint/naming-convention */
import * as vscode from 'vscode';
import { ELEGANT_NAME, ROOT_NAME } from '../consts';
import { OnlineUserSchema, ProjectSessionSchema, SocketIOAPI, UpdateUserSchema } from '../api/socketio';
import { VirtualFileSystem } from '../core/remoteFileSystemProvider';
import { ChatViewProvider } from './chatViewProvider';
import { LocalReplicaSCMProvider } from '../scm/localReplicaSCM';

interface ExtendedUpdateUserSchema extends UpdateUserSchema {
    selection?: {
        color: UserColors,
        hoverMessage: vscode.MarkdownString,
        decoration: vscode.TextEditorDecorationType,
        ranges: vscode.DecorationOptions[],
    },
}

enum UserColors {
    ORANGE = '#ff8000',
    PURPLE = '#8000ff',
    PINK = '#ff00ff',
    BROWN = '#804000',
    GRAY = '#808080',
    LIGHT_BLUE = '#0080ff',
    LIGHT_GREEN = '#00ff80',
    LIGHT_PURPLE = '#ff80ff',
    LIGHT_PINK = '#ff80c0',
    LIGHT_YELLOW = '#ffff80',
    LIGHT_ORANGE = '#ffc080',
    LIGHT_RED = '#ff8080',
    LIGHT_GRAY = '#c0c0c0',
    LIGHT_BROWN = '#c08040',
    DARK_BLUE = '#000080',
    DARK_GREEN = '#008040',
    DARK_PURPLE = '#800080',
    DARK_PINK = '#ff0080',
    DARK_YELLOW = '#808000',
    DARK_ORANGE = '#804000',
    DARK_RED = '#800000',
    DARK_GRAY = '#808080',
    DARK_BROWN = '#804000',
}

function formatTime(timestamp:number) {
    timestamp = Math.floor(timestamp / 1000);
    const hours = Math.floor(timestamp / 3600);
    const minutes = Math.floor(timestamp / 60) % 60;
    const ten_seconds = Math.floor(timestamp % 60 / 10);
    const hoursStr = hours > 0 ? `${hours}h ` : '';
    const minutesStr = minutes > 0 ? `${minutes}m` : '';
    const secondsStr = minutesStr==='' && ten_seconds > 0 ? `${ten_seconds*10}s` : '';
    return `${hoursStr}${minutesStr}${secondsStr}`;
}

export class ClientManager implements vscode.Disposable {
    private activeExists?: string;
    private inactivateTask?: NodeJS.Timeout;
    private statusUpdateTask?: NodeJS.Timeout;
    private disposed = false;
    private readonly status: vscode.StatusBarItem;
    private readonly onlineUsers: {[K:string]:ExtendedUpdateUserSchema} = {};
    private connectedFlag: boolean = true;
    private readonly chatViewer: ChatViewProvider;
    /** Public ids previously owned by this window's socket across reconnects. */
    private readonly localPublicIds = new Set<string>();
    private connectedUsersRefresh = 0;
    private presenceRevision = 0;
    private localCursorRevision = 0;
    private readonly clientPresenceRevisions = new Map<string, number>();
    /** Timestamp when connection was lost; used for grace period before clearing user list */
    private disconnectedAt: number = 0;
    /** Grace period in ms before clearing online user list on disconnect */
    private static readonly DISCONNECT_GRACE_PERIOD_MS = 15000; // 15 seconds

    constructor(
        private readonly vfs: VirtualFileSystem,
        private readonly context: vscode.ExtensionContext,
        private publicId: string,
        private readonly socket: SocketIOAPI,
    ) {
        if (publicId) { this.localPublicIds.add(publicId); }
        this.socket.updateEventHandlers({
            onClientUpdated: (user:UpdateUserSchema) => {
                if (this.disposed) { return; }
                this.presenceRevision += 1;
                this.clientPresenceRevisions.set(user.id, this.presenceRevision);
                if (!this.localPublicIds.has(user.id)) { this.setStatusActive(user.id); }
                void this.updatePosition(
                    user.id,
                    user.doc_id,
                    user.row,
                    user.column,
                    user,
                ).catch(error => {
                    console.warn('Unable to update an Overleaf collaborator cursor', error);
                });
            },
            onClientDisconnected: (id:string) => {
                if (this.disposed) { return; }
                this.presenceRevision += 1;
                this.clientPresenceRevisions.set(id, this.presenceRevision);
                this.removePosition(id);
            },
            onDisconnected: () => {
                if (this.disposed) { return; }
                this.connectedFlag = false;
                this.disconnectedAt = Date.now();
            },
            onConnectionAccepted: (publicId:string) => {
                if (this.disposed) { return; }
                // Transport acceptance is not sufficient: the project/doc session
                // may still be recovering. updateStatus reads vfs.isReady.
                this.updatePublicId(publicId);
            },
            onProjectJoined: (session:ProjectSessionSchema) => {
                if (this.disposed) { return; }
                this.updatePublicId(session.publicId);
                void this.refreshConnectedUsers();
            },
            onFatalError: () => {
                if (this.disposed) { return; }
                this.connectedFlag = false;
                this.disconnectedAt = Date.now() - ClientManager.DISCONNECT_GRACE_PERIOD_MS;
            },
        });

        this.chatViewer = new ChatViewProvider(this.vfs, this.publicId, this.context.extensionUri, this.socket);
        this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
        // ClientManager is created after the initial joinProject call, so it may
        // have missed that generation's onProjectJoined event.
        void this.refreshConnectedUsers();
        this.updateStatus();
    }

    updatePublicId(publicId: string) {
        if (this.disposed) { return; }
        if (this.publicId) { this.localPublicIds.add(this.publicId); }
        this.publicId = publicId;
        if (publicId) { this.localPublicIds.add(publicId); }
        this.localPublicIds.forEach(id => {
            if (this.onlineUsers[id]) { void this.removePosition(id); }
        });
        this.chatViewer?.updatePublicId(publicId);
    }

    private toUpdateUser(user: OnlineUserSchema): UpdateUserSchema {
        return {
            id: user.client_id,
            user_id: user.user_id,
            name: [user.first_name, user.last_name].filter(Boolean).join(' '),
            email: user.email,
            doc_id: user.cursorData?.doc_id,
            row: user.cursorData?.row,
            column: user.cursorData?.column,
            last_updated_at: Number(user.last_updated_at),
        };
    }

    private async refreshConnectedUsers() {
        const refresh = ++this.connectedUsersRefresh;
        const revision = this.presenceRevision;
        try {
            const users = await this.socket.getConnectedUsers();
            if (this.disposed || refresh !== this.connectedUsersRefresh) { return; }

            const seen = new Set<string>();
            const updates: Promise<void>[] = [];
            users.forEach(user => {
                if (!user.connected || this.localPublicIds.has(user.client_id)) { return; }
                const onlineUser = this.toUpdateUser(user);
                seen.add(user.client_id);
                // A live update/disconnect received after the request started is
                // newer than this snapshot for that client and wins independently.
                if ((this.clientPresenceRevisions.get(user.client_id) ?? 0) > revision) { return; }
                updates.push(this.updatePosition(
                    user.client_id,
                    onlineUser.doc_id,
                    onlineUser.row,
                    onlineUser.column,
                    onlineUser,
                ));
            });
            Object.keys(this.onlineUsers).forEach(clientId => {
                if (
                    !seen.has(clientId) &&
                    (this.clientPresenceRevisions.get(clientId) ?? 0) <= revision
                ) {
                    updates.push(this.removePosition(clientId));
                }
            });
            await Promise.all(updates);
        } catch {
            // A failed snapshot must not erase the last known-good presence map.
        }
    }

    private async jumpToUser(id?: string) {
        if (id === undefined) {
            const onlineUsers = Object.values(this.onlineUsers);
            if (onlineUsers.length === 0) {
                vscode.window.showErrorMessage( vscode.l10n.t('No online Collaborators.') );
                return;
            }
            // select a user
            const selectedUser = await vscode.window.showQuickPick(
                Object.keys(this.onlineUsers).map(clientId => {
                    const user = this.onlineUsers[clientId];
                    const docPath = user.doc_id ? this.vfs._resolveById(user.doc_id)?.path.slice(1) : undefined;
                    const cursorInfo = user.row !== undefined && docPath ?
                        vscode.l10n.t('At {docPath}, Line {row}', {docPath, row:user.row+1}) : undefined;

                    return {
                        label: user.name,
                        description: cursorInfo,
                        clientId: clientId,
                        lastActive: user.last_updated_at!,
                    };
                }).filter(x => x).sort((a,b) => a.lastActive-b.lastActive),
            {
                placeHolder: vscode.l10n.t('Select a collaborator below to jump to.'),
            });
            if (selectedUser === undefined) { return; }
            id = selectedUser.clientId;
        }

        const user = this.onlineUsers[id];
        const row = user.row;
        const column = user.column;
        if (!user.doc_id
            || typeof row !== 'number'
            || typeof column !== 'number'
            || !Number.isSafeInteger(row)
            || !Number.isSafeInteger(column)
            || row < 0
            || column < 0) { return; }
        const docPath = this.vfs._resolveById(user.doc_id)?.path;
        if (docPath === undefined) { return; }

        const uri = (vscode.workspace.workspaceFolders?.[0].uri.scheme===ROOT_NAME) ?
                    this.vfs.pathToUri(docPath) : await LocalReplicaSCMProvider.pathToUri(docPath);
        uri && vscode.window.showTextDocument(uri, {
            selection: new vscode.Selection(row, column, row, column),
            preview: false,
        });
    }

    private async tetherToUser(id?: string) {}

    private refreshDecorations(visibleTextEditors: readonly vscode.TextEditor[]) {
        Object.values(this.onlineUsers).forEach(async user => {
            if (this.disposed) { return; }
            if (!user.doc_id) { return; }
            const docPath = this.vfs._resolveById(user.doc_id)?.path;
            if (docPath === undefined) { return; }

            const uri = (vscode.workspace.workspaceFolders?.[0].uri.scheme===ROOT_NAME) ?
                        this.vfs.pathToUri(docPath) : await LocalReplicaSCMProvider.pathToUri(docPath);
            if (this.disposed) { return; }
            const editor = uri && vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString());
            const selection = user.selection;
            selection && editor?.setDecorations(selection.decoration, selection.ranges);
        });
    }

    private async updatePosition(
        clientId: string,
        docId: string | undefined,
        row: number | undefined,
        column: number | undefined,
        details?: UpdateUserSchema,
    ) {
        if (this.disposed || this.localPublicIds.has(clientId)) { return; }

        // update record
        const previousDocId = this.onlineUsers[clientId]?.doc_id;
        if (this.onlineUsers[clientId]===undefined) {
            if (details === undefined) { return; }
            this.onlineUsers[clientId] = {
                last_updated_at: Date.now(),
                ...details
            };
        } else {
            this.onlineUsers[clientId].doc_id = docId;
            this.onlineUsers[clientId].row = row;
            this.onlineUsers[clientId].column = column;
            this.onlineUsers[clientId].last_updated_at = Date.now();
        }

        const selection = this.onlineUsers[clientId].selection;
        const hasCursor = typeof docId === 'string'
            && docId.length > 0
            && Number.isSafeInteger(row)
            && Number.isSafeInteger(column)
            && row! >= 0
            && column! >= 0;
        if (!hasCursor) {
            if (selection) {
                selection.ranges = [];
                vscode.window.visibleTextEditors.forEach(editor => {
                    editor.setDecorations(selection.decoration, []);
                });
            }
            return;
        }
        // remove decoration
        const oldDoc = previousDocId && this.vfs._resolveById(previousDocId);
        if (oldDoc && oldDoc.fileEntity._id !== docId && selection) {
            const oldUri = (vscode.workspace.workspaceFolders?.[0].uri.scheme===ROOT_NAME) ?
                        this.vfs.pathToUri(oldDoc.path) : await LocalReplicaSCMProvider.pathToUri(oldDoc.path);
            if (this.disposed) { return; }

            const oldEditor = oldUri && vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === oldUri.toString());
            oldEditor && oldEditor.setDecorations(selection.decoration, []);
        }

        // update decoration
        const newDoc = this.vfs._resolveById(docId!);
        if (newDoc === undefined) { return; }
        const newUri = (vscode.workspace.workspaceFolders?.[0].uri.scheme===ROOT_NAME) ?
                    this.vfs.pathToUri(newDoc.path) : await LocalReplicaSCMProvider.pathToUri(newDoc.path);
        if (this.disposed) { return; }
        const newEditor = newUri && vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === newUri.toString());
        if (selection===undefined) {
            const length = Object.keys(this.onlineUsers).length;
            const color = Object.values(UserColors)[length % Object.keys(UserColors).length];
            const decoration = vscode.window.createTextEditorDecorationType({
                outline: `1px solid ${color}`,
                overviewRulerColor: color,
                rangeBehavior: vscode.DecorationRangeBehavior.OpenClosed,
            });
            const hoverMessage = new vscode.MarkdownString(`<span style="color:${color};"><b>${this.onlineUsers[clientId].name}</b></span>`);
            hoverMessage.supportHtml = true;
            const _selection = {
                color,
                decoration,
                hoverMessage,
                ranges: [{
                    range: new vscode.Range(row!, column!, row!, column!),
                    hoverMessage: hoverMessage,
                }],
            };
            this.onlineUsers[clientId].selection = _selection;
            newEditor?.setDecorations(_selection.decoration, _selection.ranges);
        } else {
            selection.ranges = [{
                range: new vscode.Range(row!, column!, row!, column!),
                hoverMessage: selection.hoverMessage,
            }];
            newEditor?.setDecorations(selection.decoration, selection.ranges);
        }
    }

    private async removePosition(clientId:string) {
        const user = this.onlineUsers[clientId];
        if (user === undefined) { return; }
        delete this.onlineUsers[clientId];
        if (this.activeExists === clientId) {
            this.activeExists = undefined;
            if (this.inactivateTask) {
                clearTimeout(this.inactivateTask);
                this.inactivateTask = undefined;
            }
        }
        const doc = user.doc_id ? this.vfs._resolveById(user.doc_id) : undefined;
        // const uri = this.vfs.pathToUri(doc.path);
        const uri = doc && (vscode.workspace.workspaceFolders?.[0].uri.scheme===ROOT_NAME ?
                    this.vfs.pathToUri(doc.path) : await LocalReplicaSCMProvider.pathToUri(doc.path));

        const editor = uri && vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString());
        // delete decoration
        const selection = user.selection;
        selection && editor?.setDecorations(selection.decoration, []);
        selection?.decoration.dispose();
    }

    private updateStatus() {
        if (this.disposed) { return; }
        this.connectedFlag = this.vfs.isReady;
        const count = Object.keys(this.onlineUsers).length;
        if (!this.connectedFlag) {
            const disconnectedDuration = Date.now() - this.disconnectedAt;
            // Show reconnecting state during grace period
            if (disconnectedDuration < ClientManager.DISCONNECT_GRACE_PERIOD_MS) {
                this.status.color = new vscode.ThemeColor('statusBarItem.warningBackground');
                this.status.backgroundColor = undefined;
                this.status.text = '$(sync~spin) ' + vscode.l10n.t('Reconnecting...');
                this.status.tooltip = `${ELEGANT_NAME}: ${vscode.l10n.t('Connection interrupted, attempting to reconnect...')}`;
                this.status.command = `${ROOT_NAME}.collaboration.settings`;
                // Keep online user decorations during brief disconnections
            } else {
                // Grace period expired: show disconnected state
                this.status.color = 'red';
                this.status.backgroundColor = undefined;
                this.status.text = '$(sync-ignored)';
                this.status.tooltip = `${ELEGANT_NAME}: ${vscode.l10n.t('Not connected')}`;
                this.status.command = `${ROOT_NAME}.collaboration.settings`;
                // Clear online user decorations after grace period
                Object.keys(this.onlineUsers).forEach(clientId => {
                    this.removePosition(clientId);
                });
            }
        } else {
            // Connected state: clear any stale disconnect timestamp
            this.disconnectedAt = 0;

            let prefixText = '';
            // notify unread messages
            if (this.chatViewer.hasUnread) {
                prefixText = prefixText.concat(`$(bell-dot) ${this.chatViewer.hasUnread} `);
            }
            this.status.command = this.chatViewer.hasUnread? `${ROOT_NAME}.collaboration.revealChatView` : `${ROOT_NAME}.collaboration.settings`;
            this.status.backgroundColor = this.chatViewer.hasUnread? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
            // notify unSynced changes
            const unSynced = this.socket.unSyncFileChanges;
            if (unSynced) {
                prefixText = prefixText.concat(`$(arrow-up) ${unSynced} `);
            }

            const isInvisible = this.socket.isUsingAlternativeConnectionScheme;
            const onlineIcon = isInvisible ? '$(person)' : '$(organization)';
            switch (count) {
                case 0:
                    this.status.color = undefined;
                    this.status.text = prefixText + `${onlineIcon} 0`;
                    this.status.tooltip = `${ELEGANT_NAME}: ${vscode.l10n.t('Online')}`;
                    break;
                default:
                    const activeUser = this.activeExists ? this.onlineUsers[this.activeExists] : undefined;
                    this.status.color = activeUser?.selection?.color;
                    this.status.text = prefixText + `${onlineIcon} ${count}`;
                    const tooltip = new vscode.MarkdownString();
                    tooltip.appendMarkdown(`${ELEGANT_NAME}: ${activeUser ? vscode.l10n.t('Active'): vscode.l10n.t('Idle') }\n\n`);

                    Object.values(this.onlineUsers).forEach(user => {
                        const userArgs = JSON.stringify([`@[[${user.name}#${user.user_id}]] `]);
                        const userCommandUri = vscode.Uri.parse(`command:${ROOT_NAME}.collaboration.insertText?${encodeURIComponent(userArgs)}`);
                        const userInfo = `<a href=${userCommandUri}>@<span style="color:${user.selection?.color};"><b>${user.name}</b></span></a>`;

                        const jumpArgs = JSON.stringify([user.id]);
                        const jumpCommandUri = vscode.Uri.parse(`command:${ROOT_NAME}.collaboration.jumpToUser?${encodeURIComponent(jumpArgs)}`);
                        const docPath = user.doc_id ? this.vfs._resolveById(user.doc_id)?.path.slice(1) : undefined;
                        const cursorInfo = user.row ? ` at <a href="${jumpCommandUri}">${docPath}#L${user.row+1}</a>` : '';
            
                        const since_last_update = user.last_updated_at ? formatTime(Date.now() - user.last_updated_at) : '';
                        const timeInfo = since_last_update==='' ? vscode.l10n.t('Just now') : vscode.l10n.t('{since_last_update} ago', {since_last_update});
                        tooltip.appendMarkdown(`${userInfo} ${cursorInfo} ${timeInfo}\n\n`);
                    });
                    tooltip.isTrusted = true;
                    tooltip.supportHtml = true;
                    this.status.tooltip = tooltip;
                    break;
            }
        }
        
        this.status.show();
        this.statusUpdateTask = setTimeout(() => this.updateStatus(), 500);
    }

    setStatusActive(clientId:string, timeout:number=10) {
        if (this.disposed) { return; }
        this.inactivateTask && clearTimeout(this.inactivateTask);
        this.inactivateTask = setTimeout(() => {
            this.activeExists = undefined;
        }, timeout*1000);
        this.activeExists = clientId;
    }

    dispose() {
        if (this.disposed) { return; }
        this.disposed = true;
        if (this.statusUpdateTask) {
            clearTimeout(this.statusUpdateTask);
            this.statusUpdateTask = undefined;
        }
        if (this.inactivateTask) {
            clearTimeout(this.inactivateTask);
            this.inactivateTask = undefined;
        }
        Object.values(this.onlineUsers).forEach(user => user.selection?.decoration.dispose());
        Object.keys(this.onlineUsers).forEach(clientId => delete this.onlineUsers[clientId]);
        this.clientPresenceRevisions.clear();
    }

    collaborationSettings() {
        const isInvisible = this.socket.isUsingAlternativeConnectionScheme;
        const useAction = isInvisible ? 'Exit' : 'Enter';
        const quickPickItems = [
            {id:'jump', label:vscode.l10n.t('Jump to Collaborator ...'), detail:''},
            // {id:'tether', label:'Tether to Collaborator ...',detail:''},
            {label:'',kind:vscode.QuickPickItemKind.Separator},
        ];
        if (isInvisible && this.socket.unSyncFileChanges) {
            quickPickItems.push({id:'sync',label:vscode.l10n.t('Upload Unsaved {number} Change(s)', {number:this.socket.unSyncFileChanges}),detail:''});
        } else {
            const detail = !isInvisible ? vscode.l10n.t('Invisible Mode removes your presence from others\' view.') : vscode.l10n.t('Back to normal mode.');
            quickPickItems.push({id:'toggle',label:`${useAction} Invisible Mode`,detail});
        }
        // show quick pick
        vscode.window.showQuickPick(quickPickItems, {
            canPickMany: false,
        }).then(async item => {
            if (item === undefined) { return; }
            switch (item.id) {
                case 'jump':
                    this.jumpToUser();
                    break;
                case 'tether':
                    this.tetherToUser();
                    break;
                case 'toggle':
                    if (useAction==='Enter') {
                        vscode.window.showWarningMessage( vscode.l10n.t('(Experimental Feature) By entering Invisible Mode, the current connection to the server will be lost. Continue?'), 'Yes', 'No').then(async selection => {
                            if (selection === 'Yes') {
                                this.vfs.toggleInvisibleMode();
                            }
                        });
                    } else {
                        this.vfs.toggleInvisibleMode();
                    }
                    break;
                case 'sync':
                    await this.socket.syncFileChanges();
                    vscode.commands.executeCommand(`${ROOT_NAME}.compileManager.compile`);
                    break;
            }
        });
    }

    get triggers(): vscode.Disposable[] {
        return [
            this,
            this.status,
            // register commands
            vscode.commands.registerCommand(`${ROOT_NAME}.collaboration.insertText`, (text) => {
                this.chatViewer.insertText(text);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.collaboration.jumpToUser`, (uid) => {
                this.jumpToUser(uid);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.collaboration.revealChatView`, () => {
                this.chatViewer.insertText();
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.collaboration.settings`, () => {
                this.collaborationSettings();
            }),
            // register chat view provider
            ...this.chatViewer.triggers,
            // update this client's position
            vscode.window.onDidChangeTextEditorSelection(async e => {
                // Typing and Vim/IME edits can move the selection without a
                // reported kind. Those positions still belong to the editor
                // snapshot and must supersede older queued cursor updates.
                if (e.selections.length === 0) { return; }
                const revision = ++this.localCursorRevision;
                const documentVersion = e.textEditor.document.version;
                let uri = e.textEditor.document.uri;
                // deal with local replica
                if (uri.scheme==='file') {
                    const path = await LocalReplicaSCMProvider.uriToPath(uri);
                    if (path) {
                        uri = this.vfs.pathToUri(path);
                    } else {
                        return;
                    }
                }

                const doc = uri && await this.vfs._resolveUri(uri);
                const docId = doc?.fileEntity?._id;
                if (docId) {
                    const stillCurrent = () => !this.disposed
                        && revision === this.localCursorRevision
                        && e.textEditor.document.version === documentVersion;
                    if (!stillCurrent()) { return; }
                    try {
                        if (e.textEditor.document.uri.scheme === ROOT_NAME) {
                            const position = e.selections[0].active;
                            if (this.vfs.canPublishPendingDeletionCursor(
                                e.textEditor.document,
                                e.textEditor.document.offsetAt(position),
                            )) {
                                await this.socket.updatePosition(docId, position.line, position.character);
                                if (!stillCurrent()) { return; }
                            }
                            if (!await this.vfs.flushEditorChangesForPresence(e.textEditor.document)) {
                                return;
                            }
                        }
                    } catch {
                        // Unconfirmed text must not publish coordinates from
                        // a different snapshot. The write path retains recovery.
                        return;
                    }
                    if (!stillCurrent()) { return; }
                    void this.socket.updatePosition(docId, e.selections[0].active.line, e.selections[0].active.character).catch(() => {});
                }
            }),
            // refresh decorations when editor is switched
            vscode.window.onDidChangeVisibleTextEditors(e => {
                this.refreshDecorations(e);
            }),
        ];
    }
}
