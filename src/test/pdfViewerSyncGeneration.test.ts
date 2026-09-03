import { strict as assert } from 'assert';

const {createGate, isReadyPdfGeneration} = require('../../views/pdf-viewer/syncGeneration.js') as {
    createGate: () => {
        beginPdfLoad: (pdfGeneration: number) => boolean,
        queueSync: (pdfGeneration: number, content: unknown) => boolean,
        readyContent: (pdfGeneration: number) => unknown,
        consume: (pdfGeneration: number) => void,
    },
    isReadyPdfGeneration: (
        readyPdfGeneration: number,
        loadingPdfGeneration: number,
        mountedPdfDocument: unknown,
        loadingPdfDocument: unknown,
    ) => boolean,
};

describe('PDF viewer SyncTeX generation gate', () => {
    it('cannot consume an old pending sync after a newer PDF update', () => {
        const gate = createGate();
        const oldSync = [{page: 1}];

        assert.equal(gate.beginPdfLoad(1), true);
        assert.equal(gate.queueSync(1, oldSync), true);
        assert.deepEqual(gate.readyContent(1), oldSync);

        assert.equal(gate.beginPdfLoad(2), true);
        assert.equal(gate.readyContent(2), undefined);
        assert.equal(gate.queueSync(1, oldSync), false);
        assert.equal(gate.readyContent(2), undefined);
    });

    it('retains only a sync bound to the PDF generation which becomes ready', () => {
        const gate = createGate();
        const newSync = [{page: 3}];

        // A sync message may be queued immediately after the extension posted
        // the PDF update but before the webview processes that update.
        assert.equal(gate.queueSync(3, newSync), true);
        assert.equal(gate.queueSync(2, [{page: 2}]), false);
        assert.equal(gate.beginPdfLoad(3), true);
        assert.equal(gate.readyContent(2), undefined);
        assert.deepEqual(gate.readyContent(3), newSync);

        gate.consume(3);
        assert.equal(gate.readyContent(3), undefined);
    });

    it('rejects duplicate, regressive and invalid PDF generations', () => {
        const gate = createGate();

        assert.equal(gate.beginPdfLoad(4), true);
        assert.equal(gate.beginPdfLoad(4), false);
        assert.equal(gate.beginPdfLoad(3), false);
        assert.equal(gate.beginPdfLoad(Number.NaN), false);
        assert.equal(gate.queueSync(0, []), false);
    });

    it('permits reverse sync only from the exact mounted ready generation', () => {
        const oldPdf = {};
        const newPdf = {};

        assert.equal(isReadyPdfGeneration(2, 2, newPdf, newPdf), true);
        assert.equal(isReadyPdfGeneration(1, 2, oldPdf, newPdf), false);
        assert.equal(isReadyPdfGeneration(0, 2, oldPdf, oldPdf), false);
        assert.equal(isReadyPdfGeneration(2, 2, oldPdf, newPdf), false);
    });
});
