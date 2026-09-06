import * as vscode from 'vscode';

let comparisonSequence = 0;

/** Immutable, read-only snapshots. Neither side is a writable Overleaf URI. */
export async function showRecoveryComparison(
    source: vscode.Uri,
    localText: string,
    remoteText: string,
): Promise<void> {
    const scheme = `overleaf-workshop-recovery-${++comparisonSequence}`;
    const name = source.path.split('/').pop() || 'document.tex';
    const remote = vscode.Uri.from({scheme, path: `/remote/${name}`});
    const local = vscode.Uri.from({scheme, path: `/draft/${name}`});
    const contents = new Map([[remote.toString(), remoteText], [local.toString(), localText]]);
    const registration = vscode.workspace.registerTextDocumentContentProvider(scheme, {
        provideTextDocumentContent: uri => contents.get(uri.toString()),
    });
    const closed = vscode.workspace.onDidCloseTextDocument(document => {
        contents.delete(document.uri.toString());
        if (contents.size === 0) {
            registration.dispose();
            closed.dispose();
        }
    });
    try {
        await vscode.commands.executeCommand('vscode.diff', remote, local,
            vscode.l10n.t('{name}: remote snapshot ↔ local recovery draft', {name}),
            {preview: false});
    } catch (error) {
        contents.clear();
        registration.dispose();
        closed.dispose();
        throw error;
    }
}
