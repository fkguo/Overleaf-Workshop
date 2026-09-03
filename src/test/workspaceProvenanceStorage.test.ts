/* eslint-disable @typescript-eslint/naming-convention */
import { strict as assert } from 'assert';

type StorageModule = typeof import('../core/workspaceProvenanceStorage');

interface ModuleLoader {
    _load(request: string, parent: NodeModule | null, isMain: boolean): unknown,
}

class TestUri {
    constructor(readonly path: string) {}
}

class FileSystemErrorStub extends Error {
    constructor(message: string, readonly code: string) {
        super(message);
    }
}

const files = new Map<string, Uint8Array>();
const writePaths: string[] = [];
const vscodeStub = {
    FileType: {File: 1},
    FileSystemError: FileSystemErrorStub,
    Uri: {
        joinPath: (base: TestUri, ...parts: string[]) =>
            new TestUri(`${base.path.replace(/\/$/, '')}/${parts.join('/')}`),
    },
    workspace: {
        fs: {
            createDirectory: async () => {},
            readDirectory: async () => [] as [string, number][],
            readFile: async (uri: TestUri) => {
                const content = files.get(uri.path);
                if (!content) { throw new FileSystemErrorStub('missing', 'FileNotFound'); }
                return content.slice();
            },
            writeFile: async (uri: TestUri, content: Uint8Array) => {
                const basename = uri.path.slice(uri.path.lastIndexOf('/') + 1);
                if (Buffer.byteLength(basename, 'utf8') > 255) {
                    throw new Error(`ENAMETOOLONG: ${basename}`);
                }
                writePaths.push(uri.path);
                files.set(uri.path, content.slice());
            },
            rename: async (source: TestUri, target: TestUri) => {
                const content = files.get(source.path);
                if (!content) { throw new FileSystemErrorStub('missing', 'FileNotFound'); }
                files.set(target.path, content);
                files.delete(source.path);
            },
            delete: async (uri: TestUri) => {
                files.delete(uri.path);
            },
        },
    },
};

const moduleLoader = require('module') as ModuleLoader;
const originalLoad = moduleLoader._load;
const originalCacheKeys = new Set(Object.keys(require.cache));
let WorkspaceProvenanceStorage: StorageModule['WorkspaceProvenanceStorage'];
moduleLoader._load = function(request, parent, isMain): unknown {
    if (request === 'vscode') { return vscodeStub; }
    return originalLoad.call(this, request, parent, isMain);
};
try {
    WorkspaceProvenanceStorage = (
        require('../core/workspaceProvenanceStorage') as StorageModule
    ).WorkspaceProvenanceStorage;
} finally {
    moduleLoader._load = originalLoad;
    for (const cacheKey of Object.keys(require.cache)) {
        if (!originalCacheKeys.has(cacheKey)) {
            delete require.cache[cacheKey];
        }
    }
}

describe('WorkspaceProvenanceStorage', () => {
    beforeEach(() => {
        files.clear();
        writePaths.length = 0;
    });

    it('atomically replaces a legacy-length record without extending its temporary basename', async () => {
        const storage = new WorkspaceProvenanceStorage(new TestUri('/workspace') as any);
        const recordName = `document-provenance.${'a'.repeat(64)}.${'b'.repeat(64)}.${'c'.repeat(64)}.json`;
        assert.equal(Buffer.byteLength(recordName, 'utf8'), 219);

        await storage.write(recordName, new TextEncoder().encode('durable'));

        assert.equal(new TextDecoder().decode(files.get(
            `/workspace/document-provenance-v2/${recordName}`,
        )), 'durable');
        assert.equal(writePaths.length, 1);
        const temporaryBasename = writePaths[0].slice(writePaths[0].lastIndexOf('/') + 1);
        assert.ok(Buffer.byteLength(temporaryBasename, 'utf8') <= 64);
        assert.equal(temporaryBasename.includes(recordName), false);
    });
});
