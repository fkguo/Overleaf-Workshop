import * as vscode from 'vscode';
import { ROOT_NAME } from '../consts';
import { RemoteFileSystemProvider } from '../core/remoteFileSystemProvider';

import { IntellisenseProvider } from '.';
import { TexDocumentSymbolProvider } from './texDocumentSymbolProvider';
import { TexDocumentFormatProvider } from './texDocumentFormatProvider';
import { MisspellingCheckProvider } from './langMisspellingCheckProvider';
import { CommandCompletionProvider, ConstantCompletionProvider, FilePathCompletionProvider, ReferenceCompletionProvider } from './langCompletionProvider';

export class LangIntellisenseProvider implements vscode.Disposable {
    private status: vscode.StatusBarItem;
    private providers: IntellisenseProvider[];
    private activationTask?: NodeJS.Timeout;
    private disposed = false;

    constructor(context: vscode.ExtensionContext, private readonly vfsm: RemoteFileSystemProvider) {
        const texSymbolProvider = new TexDocumentSymbolProvider(vfsm);
        this.providers = [
            // document symbol provider
            texSymbolProvider,
            // document format provider
            new TexDocumentFormatProvider(vfsm),
            // completion provider
            new CommandCompletionProvider(vfsm, context.extensionUri),
            new ConstantCompletionProvider(vfsm, context.extensionUri),
            new FilePathCompletionProvider(vfsm),
            new ReferenceCompletionProvider(vfsm, texSymbolProvider),
            // misspelling check provider
            new MisspellingCheckProvider(vfsm),
        ];
        this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -2);
        // Enable CSpell
        const config = vscode.workspace.getConfiguration("cSpell");
        const enabledSchemes = config.get<Record<string, boolean>>("enabledSchemes") || {}; 
        enabledSchemes[ROOT_NAME] = true; 
        config.update("enabledSchemes", enabledSchemes, vscode.ConfigurationTarget.Global);
        
        this.activate();
    }

    async activate() {
        if (this.disposed) { return; }
        const uri = vscode.workspace.workspaceFolders?.[0].uri;
        if (uri?.scheme!==ROOT_NAME) { return; }

        const vfs = uri && await this.vfsm.prefetch(uri);
        if (this.disposed) { return; }
        const languageItem = vfs?.getSpellCheckLanguage();
        if (languageItem) {
            const {name, code} = languageItem;
            this.status.text = code===''? '$(eye-closed)' : '$(eye) ' + code.toLocaleUpperCase();
            this.status.tooltip = new vscode.MarkdownString(`${vscode.l10n.t('Spell Check')}: **${name}**`);
            this.status.tooltip.appendMarkdown(`\n\n*${vscode.l10n.t('Click to manage spell check.')}*`);
        } else {
            this.status.text = '';
            this.status.tooltip = '';
        }
        this.status.command = 'langIntellisense.settings';
        this.status.show();
        this.activationTask = setTimeout(() => this.activate(), 200);
    }

    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;
        if (this.activationTask) {
            clearTimeout(this.activationTask);
            this.activationTask = undefined;
        }
    }

    get triggers(): vscode.Disposable[] {
        return [
            this,
            this.status,
            // register provider triggers
            ...this.providers.map(x => x.triggers).flat(),
        ];
    }
}
