/* eslint-disable @typescript-eslint/naming-convention */
import { strict as assert } from 'assert';
import { CompileOutcome } from '../compile/compileResult';

interface ModuleLoader {
    _load(request: string, parent: NodeModule | null, isMain: boolean): unknown,
}

class DisposableStub {
    dispose() {}
}

class MarkdownStringStub {
    appendMarkdown() { return this; }
}

const statusItems: any[] = [];
let executeCommand = async (_command: string): Promise<unknown> => undefined;
const vscodeStub = {
    DiagnosticSeverity: {Error: 0, Warning: 1, Information: 2},
    StatusBarAlignment: {Left: 1},
    MarkdownString: MarkdownStringStub,
    ThemeColor: class ThemeColor { constructor(readonly id: string) {} },
    l10n: {
        t: (message: string, values?: Record<string, unknown>) => message.replace(
            /\{([^}]+)\}/g,
            (_match, key: string) => String(values?.[key] ?? `{${key}}`),
        ),
    },
    languages: {
        createDiagnosticCollection: () => ({clear() {}, set() {}, dispose() {}}),
    },
    window: {
        activeTextEditor: undefined,
        createStatusBarItem: () => {
            const item = {
                text: '',
                tooltip: undefined,
                backgroundColor: undefined,
                command: undefined,
                show() {},
                hide() {},
                dispose() {},
            };
            statusItems.push(item);
            return item;
        },
    },
    workspace: {
        workspaceFolders: undefined,
        textDocuments: [],
        saveAll: async () => true,
        getConfiguration: () => ({get: (_key: string, fallback: unknown) => fallback}),
    },
    commands: {
        executeCommand: (command: string) => executeCommand(command),
        registerCommand: () => new DisposableStub(),
    },
};

const eventBusStub = {
    EventBus: {
        on: () => new DisposableStub(),
    },
};

const moduleLoader = require('module') as ModuleLoader;
const originalLoad = moduleLoader._load;
const originalCacheKeys = new Set(Object.keys(require.cache));
let CompileManager: typeof import('../compile/compileManager')['CompileManager'];
moduleLoader._load = function(request, parent, isMain): unknown {
    if (request === 'vscode') { return vscodeStub; }
    if (request === '../core/remoteFileSystemProvider') {
        return {
            parseUri: () => ({identifier: 'project', pathParts: []}),
        };
    }
    if (request === '../core/pdfViewEditorProvider') { return {}; }
    if (request === '../utils/eventBus') { return eventBusStub; }
    if (request === '../scm/localReplicaSCM') {
        return {LocalReplicaSCMProvider: {readSettings: async () => undefined}};
    }
    if (request === './compileTarget') {
        return {resolveCompileRootDocId: async () => undefined};
    }
    return originalLoad.call(this, request, parent, isMain);
};
try {
    CompileManager = (require('../compile/compileManager') as typeof import('../compile/compileManager')).CompileManager;
} finally {
    moduleLoader._load = originalLoad;
    for (const cacheKey of Object.keys(require.cache)) {
        if (!originalCacheKeys.has(cacheKey)) {
            delete require.cache[cacheKey];
        }
    }
}

describe('CompileManager cached startup', () => {
    beforeEach(() => {
        statusItems.length = 0;
        executeCommand = async () => undefined;
    });

    it('falls back to a real compile when a cached output cannot be downloaded', async () => {
        const uri = {
            scheme: 'overleaf-workshop',
            authority: 'www.overleaf.com',
            path: '/main.tex',
            query: 'user=user&project=project',
        };
        const cachedOutcome: CompileOutcome = {
            status: 'success',
            successful: true,
            outputsUpdated: true,
            hasLog: true,
        };
        let liveCompiles = 0;
        let diagnosticChecks = 0;
        executeCommand = async command => {
            if (command === 'overleaf-workshop.compileManager.compileErrorCheck') {
                diagnosticChecks += 1;
                throw new Error('Download failed with HTTP 404');
            }
            return undefined;
        };
        const vfs = {
            getRootDocName: () => '/main.tex',
            getCompiler: () => ({name: 'pdfLaTex'}),
            adoptCachedCompile: async () => cachedOutcome,
            compile: async () => {
                liveCompiles += 1;
                return undefined;
            },
        };
        const manager = new CompileManager({prefetch: async () => vfs} as any);

        await manager.compile(true, 'initial-project', uri as any);

        assert.equal(diagnosticChecks, 1);
        assert.equal(liveCompiles, 1);
        assert.equal(statusItems.at(-1)?.text, 'pdfLaTex');
    });
});
