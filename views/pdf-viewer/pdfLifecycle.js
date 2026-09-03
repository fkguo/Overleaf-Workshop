"use strict";

(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.OverleafPdfLifecycle = api;
    }
}(typeof globalThis === 'undefined' ? this : globalThis, function() {
    function isGeneration(value) {
        return Number.isSafeInteger(value) && value > 0;
    }

    /**
     * Serializes PDFViewerApplication.close/open transitions while retaining
     * only the newest requested PDF generation.
     */
    function createController(application, options = {}) {
        const onError = options.onError || (() => {});
        const onOpened = options.onOpened || (() => {});
        let requestedGeneration = 0;
        let pendingRequest;
        let applicationGeneration = 0;
        let currentSession;
        let runner;
        let disposed = false;

        function report(error, phase, pdfGeneration) {
            try {
                onError(error, phase, pdfGeneration);
            } catch {}
        }

        async function close(pdfGeneration) {
            try {
                await application.close();
                return true;
            } catch (error) {
                report(error, 'close', pdfGeneration);
                return false;
            }
        }

        async function drain() {
            while (true) {
                if (disposed) {
                    await close(0);
                    return;
                }
                if (!pendingRequest) {
                    return;
                }
                const request = pendingRequest;
                const closed = await close(request.pdfGeneration);
                if (!closed) {
                    applicationGeneration = 0;
                    currentSession = undefined;
                    // A failed destroy has unknown residual state. Do not
                    // retry or open on top of it; a later generation may make
                    // one fresh close attempt.
                    pendingRequest = undefined;
                    return;
                }
                if (disposed || pendingRequest !== request) {
                    continue;
                }

                // close() and open() are owned by this single runner. A newer
                // request invalidates identity immediately, but waits for the
                // current open() to settle before the runner closes its task.
                applicationGeneration = request.pdfGeneration;
                let opened = false;
                try {
                    await application.open(request.args);
                    opened = application.pdfDocument !== null &&
                        application.pdfDocument !== undefined &&
                        application.pdfLoadingTask !== null &&
                        application.pdfLoadingTask !== undefined;
                } catch (error) {
                    if (!disposed && pendingRequest === request) {
                        report(error, 'open', request.pdfGeneration);
                    }
                }

                if (disposed || pendingRequest !== request) {
                    applicationGeneration = 0;
                    continue;
                }
                if (!opened) {
                    applicationGeneration = 0;
                    currentSession = undefined;
                    // PDF.js retains a failed pdfLoadingTask. Close it before
                    // accepting another document or considering the queue idle.
                    await close(request.pdfGeneration);
                } else {
                    currentSession = {
                        pdfGeneration: request.pdfGeneration,
                        pdfDocument: application.pdfDocument,
                        pdfLoadingTask: application.pdfLoadingTask,
                    };
                    try {
                        onOpened(currentSession);
                    } catch (error) {
                        report(error, 'ready', request.pdfGeneration);
                    }
                }
                if (pendingRequest === request) {
                    pendingRequest = undefined;
                }
            }
        }

        function ensureRunner() {
            if (runner) {
                return;
            }
            runner = drain().finally(() => {
                runner = undefined;
                if (!disposed && pendingRequest) {
                    ensureRunner();
                }
            });
        }

        return {
            replace(pdfGeneration, args) {
                if (
                    disposed ||
                    !isGeneration(pdfGeneration) ||
                    pdfGeneration <= requestedGeneration
                ) {
                    return false;
                }
                requestedGeneration = pdfGeneration;
                pendingRequest = {pdfGeneration, args};
                // Reject all events from the currently mounted/loading PDF as
                // soon as a replacement is requested.
                applicationGeneration = 0;
                currentSession = undefined;
                ensureRunner();
                return true;
            },

            currentGenerationFor(pdfDocument) {
                if (
                    disposed ||
                    !pdfDocument ||
                    applicationGeneration !== requestedGeneration ||
                    currentSession?.pdfGeneration !== applicationGeneration ||
                    currentSession.pdfDocument !== pdfDocument ||
                    application.pdfDocument !== pdfDocument ||
                    application.pdfLoadingTask !== currentSession.pdfLoadingTask
                ) {
                    return 0;
                }
                return applicationGeneration;
            },

            async whenReady(session, pdfViewer) {
                const firstPagePromise = pdfViewer?.firstPagePromise;
                if (!session || !firstPagePromise) {
                    return false;
                }
                try {
                    await Promise.all([
                        session.pdfDocument.getDownloadInfo(),
                        firstPagePromise,
                    ]);
                } catch {
                    return false;
                }
                return !disposed &&
                    currentSession === session &&
                    applicationGeneration === requestedGeneration &&
                    applicationGeneration === session.pdfGeneration &&
                    application.pdfLoadingTask === session.pdfLoadingTask &&
                    application.pdfDocument === session.pdfDocument &&
                    pdfViewer.pdfDocument === session.pdfDocument &&
                    pdfViewer.firstPagePromise === firstPagePromise;
            },

            async whenIdle() {
                while (runner) {
                    await runner;
                }
            },

            async dispose() {
                if (!disposed) {
                    disposed = true;
                    pendingRequest = undefined;
                    requestedGeneration = 0;
                    applicationGeneration = 0;
                    currentSession = undefined;
                    ensureRunner();
                }
                if (runner) {
                    await runner;
                }
            },
        };
    }

    return {createController};
}));
