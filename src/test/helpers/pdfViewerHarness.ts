/* eslint-disable @typescript-eslint/naming-convention */
import {readFileSync} from 'fs';
import {join} from 'path';
import {runInNewContext} from 'vm';

// Run the actual webview entrypoint and lifecycle/generation controllers. Only
// the browser DOM and PDF.js rendering surface are synthetic (no network).
export class PdfElement {
    parentElement?: PdfElement;
    children: PdfElement[] = [];
    innerText = '';
    constructor(readonly kind: string, readonly pageNumber?: string) {}
    append(child: PdfElement) { child.parentElement = this; this.children.push(child); return child; }
    closest(selector: string): PdfElement | undefined {
        if (selector !== '.page[data-page-number]') { throw new Error(`Unexpected selector: ${selector}`); }
        return this.kind === 'page' && this.pageNumber !== undefined ? this : this.parentElement?.closest(selector);
    }
    getAttribute(name: string) { return name === 'data-page-number' ? this.pageNumber ?? null : null; }
    querySelector(selector: string): PdfElement | undefined {
        return this.children.find(child => child.kind === selector)
            ?? this.children.map(child => child.querySelector(selector)).find(Boolean);
    }
    getBoundingClientRect() { return {left: 20, top: 30}; }
}

export async function createPdfViewerHarness() {
    const root = join(__dirname, '../../../views/pdf-viewer');
    const listeners = new Map<string, (event?: any) => unknown>();
    const messages: any[] = [];
    const destinations: any[] = [];
    const errors: unknown[][] = [];
    const animationFrames: Array<() => void> = [];
    const container = {scrollLeft: 0, scrollTop: 0};
    const errorBanner = {hidden: true};
    let retryDownload: (() => void) | undefined;
    const viewport = {
        viewBox: [0, 0, 600, 800],
        convertToPdfPoint: (x: number, y: number) => [x / 2, 800 - y / 2],
    };
    const application: any = {
        initializedPromise: Promise.resolve(),
        eventBus: {_off() {}, _on() {}},
        _boundEvents: {},
        pdfViewer: {
            getPageView: () => ({viewport}), refresh() {},
            scrollPageIntoView: (destination: any) => destinations.push(destination),
        },
        pdfCursorTools: {switchTool() {}},
        pdfSidebar: {setInitialView() {}, switchView() {}},
        close: async () => { application.pdfDocument = undefined; application.pdfLoadingTask = undefined; },
        open: async () => {
            application.pdfDocument = {getDownloadInfo: async () => ({})};
            application.pdfLoadingTask = {};
            application.pdfViewer.pdfDocument = application.pdfDocument;
            application.pdfViewer.firstPagePromise = Promise.resolve();
            application.pdfViewer.pagesPromise = Promise.resolve();
        },
    };
    const window = {
        addEventListener: (name: string, listener: (event?: any) => unknown) => listeners.set(name, listener),
        requestAnimationFrame: (callback: () => void) => animationFrames.push(callback),
    };
    runInNewContext(readFileSync(join(root, 'index.js'), 'utf8'), {
        window, Element: PdfElement, document: {getElementById: (id: string) =>
            id === 'overleaf-pdf-load-error' ? errorBanner : id === 'overleaf-pdf-retry' ?
                {addEventListener: (_name: string, listener: () => void) => { retryDownload = listener; }} : container},
        console: {log() {}, error: (...args: unknown[]) => errors.push(args)},
        acquireVsCodeApi: () => ({postMessage: (message: any) => messages.push(message), getState() {}, setState() {}}),
        PDFViewerApplication: application, pdfjsLib: {},
        OverleafPdfLifecycle: require(join(root, 'pdfLifecycle.js')),
        OverleafPdfSyncGeneration: require(join(root, 'syncGeneration.js')),
    });
    await listeners.get('load')?.();
    const settle = async () => {
        await new Promise<void>(resolve => setImmediate(resolve));
        for (const callback of animationFrames.splice(0)) { callback(); }
    };
    const send = (data: any) => listeners.get('message')?.({data});
    return {
        messages, destinations, errors, application, viewport, settle, send,
        errorBanner, retryDownload: () => retryDownload?.(),
        load: async (generation = 1) => { send({type: 'update', content: new Uint8Array([1]), pdfGeneration: generation}); await settle(); },
        doubleClick: (target: any) => listeners.get('dblclick')?.({target, clientX: 220, clientY: 330}),
    };
}

export function pdfPage() {
    const page = new PdfElement('page', '4');
    const canvas = page.append(new PdfElement('canvas'));
    const layer = page.append(new PdfElement('textLayer'));
    const span = layer.append(new PdfElement('span'));
    span.innerText = 'source token';
    const wrapper = layer.append(new PdfElement('markedContent'));
    const nested = wrapper.append(new PdfElement('span'));
    nested.innerText = '(';
    return {page, canvas, layer, span, nested};
}
