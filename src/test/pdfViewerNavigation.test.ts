import {strict as assert} from 'assert';
import {createPdfViewerHarness, pdfPage, PdfElement} from './helpers/pdfViewerHarness';

describe('PDF webview double-click navigation', () => {
    it('shows a download failure without discarding the loaded PDF, and retries without compiling', async () => {
        const viewer = await createPdfViewerHarness();
        await viewer.load();
        const previous = viewer.application.pdfDocument;
        viewer.send({type: 'pdfLoadError', failed: true});
        assert.equal(viewer.errorBanner.hidden, false);
        assert.equal(viewer.application.pdfDocument, previous);
        viewer.retryDownload();
        assert.equal(viewer.messages.at(-1).type, 'retryPdfDownload');
        await viewer.load(2);
        assert.equal(viewer.errorBanner.hidden, true);
        assert.deepEqual(viewer.errors, []);
    });
    for (const target of ['span', 'nested', 'layer', 'canvas', 'page'] as const) {
        it(`dispatches a reverse SyncTeX request from ${target}`, async () => {
            const viewer = await createPdfViewerHarness();
            await viewer.load();
            viewer.doubleClick(pdfPage()[target]);
            const requests = viewer.messages.filter(message => message.type === 'syncPdf');
            assert.equal(requests.length, 1);
            assert.deepEqual(JSON.parse(JSON.stringify(requests[0].content)), {
                page: 4, h: 100, v: 150,
                identifier: target === 'span' ? 'source token' : target === 'nested' ? '(' : '',
                pdfGeneration: 1,
            });
            assert.deepEqual(viewer.errors, []);
        });
    }

    it('ignores the toolbar, invalid page numbers, and a page without a rendered canvas', async () => {
        const viewer = await createPdfViewerHarness();
        await viewer.load();
        for (const target of [undefined, new PdfElement('toolbar'), new PdfElement('page', 'NaN'),
            new PdfElement('page', '0'), new PdfElement('page', '4')]) {
            assert.doesNotThrow(() => viewer.doubleClick(target));
        }
        assert.equal(viewer.messages.filter(message => message.type === 'syncPdf').length, 0);
        assert.deepEqual(viewer.errors, []);
    });

    it('does not use missing page viewports or non-finite coordinates', async () => {
        const viewer = await createPdfViewerHarness();
        await viewer.load();
        viewer.viewport.convertToPdfPoint = () => [NaN, Infinity];
        viewer.doubleClick(pdfPage().span);
        viewer.application.pdfViewer.getPageView = () => undefined;
        viewer.doubleClick(pdfPage().span);
        assert.equal(viewer.messages.filter(message => message.type === 'syncPdf').length, 0);
    });

    it('reverse-syncs after forward positioning and a PDF refresh, never while loading', async () => {
        const viewer = await createPdfViewerHarness();
        const target = pdfPage().nested;
        viewer.doubleClick(target);
        await viewer.load(1);
        viewer.send({type: 'syncCode', content: [{page: 4, h: 50, v: 60}], pdfGeneration: 1});
        await viewer.settle();
        assert.equal(viewer.destinations[0].pageNumber, 4);
        viewer.doubleClick(target);

        viewer.send({type: 'update', content: new Uint8Array([2]), pdfGeneration: 2});
        viewer.doubleClick(target);
        await viewer.settle();
        viewer.doubleClick(target);
        const requests = viewer.messages.filter(message => message.type === 'syncPdf');
        assert.deepEqual(requests.map(message => message.content.pdfGeneration), [1, 2]);
        assert.deepEqual(viewer.errors, []);
    });
});
