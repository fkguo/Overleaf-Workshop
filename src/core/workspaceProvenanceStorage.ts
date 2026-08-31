import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { ProvenanceStorage } from './documentProvenance';

const PROVENANCE_FOLDER = 'document-provenance-v1';

function isFileNotFound(error: unknown): boolean {
    return error instanceof vscode.FileSystemError && error.code === 'FileNotFound';
}

/**
 * Workspace-private, per-record storage. Each extension host writes a distinct
 * record name, so two windows never race through a shared map value. Replacing a
 * record uses a same-directory temporary file and rename.
 */
export class WorkspaceProvenanceStorage implements ProvenanceStorage {
    private readonly root?: vscode.Uri;

    constructor(storageUri: vscode.Uri | undefined) {
        this.root = storageUri && vscode.Uri.joinPath(storageUri, PROVENANCE_FOLDER);
    }

    private assertAvailable(): vscode.Uri {
        if (!this.root) {
            throw new Error('Workspace storage is unavailable for document provenance');
        }
        return this.root;
    }

    private recordUri(name: string): vscode.Uri {
        if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
            throw new Error('Invalid document provenance record name');
        }
        return vscode.Uri.joinPath(this.assertAvailable(), name);
    }

    async list(): Promise<string[]> {
        const root = this.assertAvailable();
        try {
            return (await vscode.workspace.fs.readDirectory(root))
                .filter(([, type]) => (type & vscode.FileType.File) !== 0)
                .map(([name]) => name);
        } catch (error) {
            if (isFileNotFound(error)) { return []; }
            throw error;
        }
    }

    async read(name: string): Promise<Uint8Array | undefined> {
        try {
            return await vscode.workspace.fs.readFile(this.recordUri(name));
        } catch (error) {
            if (isFileNotFound(error)) { return undefined; }
            throw error;
        }
    }

    async write(name: string, data: Uint8Array): Promise<void> {
        const root = this.assertAvailable();
        const target = this.recordUri(name);
        const temporary = vscode.Uri.joinPath(root, `.${name}.${randomUUID()}.tmp`);
        await vscode.workspace.fs.createDirectory(root);
        try {
            await vscode.workspace.fs.writeFile(temporary, data);
            await vscode.workspace.fs.rename(temporary, target, {overwrite: true});
        } catch (error) {
            try {
                await vscode.workspace.fs.delete(temporary);
            } catch {
                // Best-effort cleanup. The uncommitted temporary name is ignored.
            }
            throw error;
        }
    }

    async delete(name: string): Promise<void> {
        try {
            await vscode.workspace.fs.delete(this.recordUri(name));
        } catch (error) {
            if (!isFileNotFound(error)) { throw error; }
        }
    }
}
