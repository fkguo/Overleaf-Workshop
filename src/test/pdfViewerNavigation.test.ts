import {strict as assert} from 'assert';
import {createPdfViewerHarness, pdfPage, PdfElement} from './helpers/pdfViewerHarness';

describe('PDF edge navigation dragging', () => {
    it('preserves a normal arrow click and small pointer movement', async () => {
        const viewer = await createPdfViewerHarness();
        await viewer.load();
        viewer.messages.length = 0;
        viewer.pointer('pointerdown', 300);
        viewer.pointer('pointermove', 303);
        assert.equal(viewer.navigation.hasPointerCapture(1), true);
        viewer.pointer('pointerup', 303);
        viewer.clickSyncToPdf();
        assert.equal(viewer.navigation.style.top, '50%');
        assert.deepEqual(viewer.messages.map(message => message.type), ['syncCodeFromPdf']);
    });

    it('moves only vertically, persists once on release, and suppresses the drag click', async () => {
        const viewer = await createPdfViewerHarness();
        await viewer.load();
        viewer.messages.length = 0;
        viewer.pointer('pointerdown', 300);
        viewer.pointer('pointermove', 420);
        assert.equal(viewer.navigation.hasPointerCapture(1), true);
        assert.equal(viewer.navigation.style.top, '70%');
        assert.equal(viewer.navigation.getBoundingClientRect().left, 0);
        assert.equal(viewer.messages.length, 0);
        viewer.pointer('pointerup', 420);
        viewer.clickSyncToPdf();
        viewer.clickSyncToSource();
        assert.deepEqual(viewer.messages.map(message => message.type), ['saveState']);
        assert.equal(viewer.savedState().syncNavigationTop, 70);
        assert.equal(viewer.navigation.hasPointerCapture(1), false);
        assert.equal(viewer.navigation.dataset.dragging, undefined);

        // Keyboard activation does not inherit suppression from a pointer drag.
        viewer.clickSyncToPdf(0);
        assert.equal(viewer.messages.at(-1).type, 'syncCodeFromPdf');
        viewer.pointer('pointerdown', 420);
        viewer.pointer('pointerup', 420);
        viewer.clickSyncToPdf();
        assert.equal(viewer.messages.filter(message => message.type === 'syncCodeFromPdf').length, 2);
    });

    it('restores the saved position after loading a PDF and after a webview restart', async () => {
        const viewer = await createPdfViewerHarness();
        await viewer.load();
        viewer.pointer('pointerdown', 300);
        viewer.pointer('pointermove', 180);
        viewer.pointer('pointerup', 180);
        await viewer.load(2);
        assert.equal(viewer.navigation.style.top, '30%');
        const restored = await createPdfViewerHarness(viewer.savedState());
        await restored.load();
        assert.equal(restored.navigation.style.top, '30%');
        restored.resize(1000);
        assert.equal(restored.navigation.style.top, '30%');
    });

    it('clamps above the toolbar and below the bottom edge, including tiny viewports', async () => {
        const viewer = await createPdfViewerHarness();
        viewer.pointer('pointerdown', 300);
        viewer.pointer('pointermove', -1000);
        assert.equal(viewer.navigation.getBoundingClientRect().top, 36);
        viewer.pointer('pointermove', 2000);
        assert.equal(viewer.navigation.getBoundingClientRect().top + 38, 596);
        viewer.pointer('pointerup', 2000);
        viewer.resize(100);
        assert.equal(viewer.navigation.getBoundingClientRect().top + 38, 96);
        viewer.resize(38);
        assert.equal(viewer.navigation.getBoundingClientRect().top, 0);
    });

    for (const type of ['pointercancel', 'lostpointercapture']) {
        it(`cleans up ${type} without jumping and allows the next gesture`, async () => {
            const viewer = await createPdfViewerHarness();
            await viewer.load();
            viewer.messages.length = 0;
            viewer.pointer('pointerdown', 300);
            viewer.pointer('pointermove', 420);
            viewer.pointer(type, 420);
            viewer.pointer('pointermove', 480);
            viewer.clickSyncToPdf();
            assert.equal(viewer.navigation.style.top, '70%');
            assert.equal(viewer.navigation.hasPointerCapture(1), false);
            assert.deepEqual(viewer.messages.map(message => message.type), ['saveState']);
            viewer.pointer('pointerdown', 420);
            viewer.pointer('pointerup', 420);
            viewer.clickSyncToPdf();
            assert.equal(viewer.messages.at(-1).type, 'syncCodeFromPdf');
        });
    }

    it('ignores unrelated pointers and non-primary buttons', async () => {
        const viewer = await createPdfViewerHarness();
        viewer.pointer('pointerdown', 300, {button: 2});
        viewer.pointer('pointermove', 420);
        assert.equal(viewer.navigation.style.top, '50%');
        viewer.pointer('pointerdown', 300, {isPrimary: false});
        viewer.pointer('pointermove', 420);
        assert.equal(viewer.navigation.style.top, '50%');
        viewer.pointer('pointerdown', 300);
        viewer.pointer('pointermove', 420, {pointerId: 2});
        viewer.pointer('pointerup', 420, {pointerId: 2});
        assert.equal(viewer.navigation.style.top, '50%');
        viewer.pointer('pointermove', 420);
        viewer.pointer('pointerup', 420);
        assert.equal(viewer.navigation.style.top, '70%');
    });

    it('defaults old or invalid persisted positions to the middle', async () => {
        for (const position of [undefined, NaN, 'bad']) {
            const viewer = await createPdfViewerHarness({syncNavigationTop: position});
            assert.equal(viewer.navigation.style.top, '50%');
        }
    });

    it('preserves saved zoom and theme when dragging before the PDF has loaded', async () => {
        const viewer = await createPdfViewerHarness({colorTheme: 'dark', currentScaleValue: '140%', syncNavigationTop: 50});
        viewer.pointer('pointerdown', 300);
        viewer.pointer('pointermove', 420);
        viewer.pointer('pointerup', 420);
        assert.equal(viewer.savedState().currentScaleValue, '140%');
        assert.equal(viewer.savedState().colorTheme, 'dark');
        assert.equal(viewer.savedState().syncNavigationTop, 70);
    });
});

describe('PDF webview double-click navigation', () => {
    it('sends a generation-bound forward request without saving, refreshing or compiling', async () => {
        const viewer = await createPdfViewerHarness();
        await viewer.load(3);
        viewer.messages.length = 0;
        viewer.clickSyncToPdf();
        assert.deepEqual(JSON.parse(JSON.stringify(viewer.messages)), [
            {type: 'syncCodeFromPdf', pdfGeneration: 3},
        ]);
    });

    it('positions from the centre of the most visible PDF area, not the arrow coordinates', async () => {
        const viewer = await createPdfViewerHarness();
        const {page, canvas} = pdfPage();
        canvas.rect = {left: -100, top: -200, right: 500, bottom: 600};
        const offscreen = new PdfElement('page', '2');
        offscreen.append(new PdfElement('canvas')).rect = {left: 0, top: -900, right: 600, bottom: -100};
        viewer.pages.push(offscreen, page);
        await viewer.load(2);
        viewer.clickSyncToSource();
        const request = viewer.messages.find(message => message.type === 'syncPdf');
        assert.deepEqual(JSON.parse(JSON.stringify(request.content)), {
            page: 4, h: 175, v: 250, identifier: '', pdfGeneration: 2, fromButton: true,
        });
    });

    it('handles page gaps and spread layouts using visible canvas intersections', async () => {
        const viewer = await createPdfViewerHarness();
        const first = new PdfElement('page', '1');
        first.append(new PdfElement('canvas')).rect = {left: 0, top: 0, right: 300, bottom: 200};
        const second = new PdfElement('page', '2');
        second.append(new PdfElement('canvas')).rect = {left: 420, top: 0, right: 720, bottom: 550};
        viewer.pages.push(first, second);
        await viewer.load();
        viewer.clickSyncToSource();
        assert.equal(viewer.messages.find(message => message.type === 'syncPdf').content.page, 2);
    });

    it('explains unavailable button navigation during load and resumes after replacement', async () => {
        const viewer = await createPdfViewerHarness();
        viewer.pages.push(pdfPage().page);
        viewer.clickSyncToPdf();
        viewer.clickSyncToSource();
        assert.equal(viewer.messages.filter(message => message.type === 'syncUnavailable').length, 2);
        await viewer.load(1);
        viewer.send({type: 'update', content: new Uint8Array([2]), pdfGeneration: 2});
        viewer.clickSyncToSource();
        assert.equal(viewer.messages.filter(message => message.type === 'syncPdf').length, 0);
        await viewer.settle();
        viewer.clickSyncToSource();
        assert.equal(viewer.messages.find(message => message.type === 'syncPdf').content.pdfGeneration, 2);
        viewer.pages.length = 0;
        viewer.clickSyncToSource();
        assert.equal(viewer.messages.at(-1).type, 'syncUnavailable');
        assert.deepEqual(viewer.errors, []);
    });

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
