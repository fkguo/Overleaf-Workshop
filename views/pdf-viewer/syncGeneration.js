"use strict";

(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.OverleafPdfSyncGeneration = api;
    }
}(typeof globalThis === 'undefined' ? this : globalThis, function() {
    function isGeneration(value) {
        return Number.isSafeInteger(value) && value > 0;
    }

    function createGate() {
        let currentPdfGeneration = 0;
        let pendingSync;

        return {
            beginPdfLoad(pdfGeneration) {
                if (!isGeneration(pdfGeneration) || pdfGeneration <= currentPdfGeneration) {
                    return false;
                }
                currentPdfGeneration = pdfGeneration;
                if (pendingSync?.pdfGeneration !== pdfGeneration) {
                    pendingSync = undefined;
                }
                return true;
            },

            queueSync(pdfGeneration, content) {
                if (
                    !isGeneration(pdfGeneration) ||
                    pdfGeneration < currentPdfGeneration ||
                    (pendingSync && pdfGeneration < pendingSync.pdfGeneration)
                ) {
                    return false;
                }
                pendingSync = {pdfGeneration, content};
                return true;
            },

            readyContent(pdfGeneration) {
                if (
                    pdfGeneration !== currentPdfGeneration ||
                    pendingSync?.pdfGeneration !== pdfGeneration
                ) {
                    return undefined;
                }
                return pendingSync.content;
            },

            consume(pdfGeneration) {
                if (pendingSync?.pdfGeneration === pdfGeneration) {
                    pendingSync = undefined;
                }
            },
        };
    }

    return {createGate};
}));
