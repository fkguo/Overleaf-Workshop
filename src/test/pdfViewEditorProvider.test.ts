/* eslint-disable @typescript-eslint/naming-convention */
import { strict as assert } from 'assert';

interface ModuleLoader {
    _load(request: string, parent: NodeModule | null, isMain: boolean): unknown,
}

class EventEmitterStub<T> {
    private readonly listeners = new Set<(event: T) => void>();
    readonly event = (listener: (event: T) => void) => {
        this.listeners.add(listener);
        return {dispose: () => this.listeners.delete(listener)};
    };

    fire(event: T) {
        for (const listener of this.listeners) {
            listener(event);
        }
    }
}

let readFile = async (_uri: unknown): Promise<Uint8Array> => new Uint8Array();
const vscodeStub = {
    EventEmitter: EventEmitterStub,
    Uri: {
        joinPath: (_base: unknown, ...parts: string[]) => ({parts}),
    },
    workspace: {
        getConfiguration: () => ({get: (_key: string, fallback: unknown) => fallback}),
        fs: {
            readFile: (uri: unknown) => readFile(uri),
        },
    },
};

const moduleLoader = require('module') as ModuleLoader;
const originalLoad = moduleLoader._load;
const originalCacheKeys = new Set(Object.keys(require.cache));
let PdfDocument: typeof import('../core/pdfViewEditorProvider')['PdfDocument'];
let PdfViewEditorProvider: typeof import('../core/pdfViewEditorProvider')['PdfViewEditorProvider'];
moduleLoader._load = function(request, parent, isMain): unknown {
    if (request === 'vscode') { return vscodeStub; }
    if (request === '../utils/eventBus') { return {EventBus: {fire() {}}}; }
    if (request === '../utils/globalStateManager') { return {GlobalStateManager: {}}; }
    return originalLoad.call(this, request, parent, isMain);
};
try {
    const pdfProviderModule = require('../core/pdfViewEditorProvider') as
        typeof import('../core/pdfViewEditorProvider');
    PdfDocument = pdfProviderModule.PdfDocument;
    PdfViewEditorProvider = pdfProviderModule.PdfViewEditorProvider;
} finally {
    moduleLoader._load = originalLoad;
    for (const cacheKey of Object.keys(require.cache)) {
        if (!originalCacheKeys.has(cacheKey)) {
            delete require.cache[cacheKey];
        }
    }
}

describe('PdfDocument refresh generations', () => {
    it('advances and publishes a generation only for a non-empty PDF', async () => {
        readFile = async () => new Uint8Array([1, 2, 3]);
        const doc = new PdfDocument({scheme: 'overleaf-workshop'} as any);
        const events: Array<{content: Uint8Array, generation: number}> = [];
        doc.onDidChange(event => events.push(event));

        const content = await doc.refresh();

        assert.deepEqual([...content], [1, 2, 3]);
        assert.deepEqual([...doc.cache], [1, 2, 3]);
        assert.equal(doc.generation, 1);
        assert.equal(events.length, 1);
        assert.equal(events[0].generation, 1);
        assert.deepEqual([...events[0].content], [1, 2, 3]);
    });

    it('keeps the last PDF and generation when the replacement download fails', async () => {
        readFile = async () => new Uint8Array([4, 5]);
        const doc = new PdfDocument({scheme: 'overleaf-workshop'} as any);
        let changes = 0;
        doc.onDidChange(() => { changes += 1; });
        await doc.refresh();

        readFile = async () => { throw new Error('download failed'); };
        const failed = await doc.refresh();

        assert.equal(failed.byteLength, 0);
        assert.deepEqual([...doc.cache], [4, 5]);
        assert.equal(doc.generation, 1);
        assert.equal(changes, 1);
    });

    it('does not publish an empty replacement as a new PDF generation', async () => {
        readFile = async () => new Uint8Array();
        const doc = new PdfDocument({scheme: 'overleaf-workshop'} as any);
        let changes = 0;
        doc.onDidChange(() => { changes += 1; });

        const empty = await doc.refresh();

        assert.equal(empty.byteLength, 0);
        assert.equal(doc.cache.byteLength, 0);
        assert.equal(doc.generation, 0);
        assert.equal(changes, 0);
    });

    it('loads the generation gate before the PDF viewer controller', () => {
        const provider = new PdfViewEditorProvider({extensionUri: {}} as any);
        const webview = {
            asWebviewUri: (uri: {parts: string[]}) => ({
                toString: () => uri.parts.join('/'),
            }),
        };

        const html = (provider as any).patchViewerHtml(webview, '</head>') as string;

        const gateIndex = html.indexOf('syncGeneration.js');
        const controllerIndex = html.indexOf('index.js');
        assert.ok(gateIndex >= 0);
        assert.ok(controllerIndex > gateIndex);
    });
});
