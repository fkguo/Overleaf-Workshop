import { strict as assert } from 'assert';

type Deferred<T> = {
    promise: Promise<T>,
    resolve: (value: T) => void,
    reject: (error: Error) => void,
};

type FakeDocument = {
    name: string,
    destroyed: boolean,
    download: Deferred<void>,
    getDownloadInfo: () => Promise<void>,
};

type FakeTask = {
    name: string,
    deferred: Deferred<FakeDocument | undefined>,
    firstPage: Deferred<void>,
    destroyed: boolean,
};

type FakeSession = {
    pdfGeneration: number,
    pdfDocument: FakeDocument,
    pdfLoadingTask: FakeTask,
};

const {createController} = require('../../views/pdf-viewer/pdfLifecycle.js') as {
    createController: (
        application: FakeApplication,
        options?: {
            onError?: (error: unknown, phase: string, generation: number) => void,
            onOpened?: (session: FakeSession) => void,
        },
    ) => {
        replace: (generation: number, args: {name: string}) => boolean,
        currentGenerationFor: (document: FakeDocument) => number,
        whenReady: (session: FakeSession, viewer: FakeApplication['pdfViewer']) => Promise<boolean>,
        whenIdle: () => Promise<void>,
        dispose: () => Promise<void>,
    },
};

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return {promise, resolve, reject};
}

class FakeApplication {
    pdfDocument: FakeDocument | undefined;
    pdfLoadingTask: FakeTask | undefined;
    readonly pdfViewer: {
        pdfDocument: FakeDocument | undefined,
        firstPagePromise: Promise<void> | undefined,
        pagesPromise: Promise<void> | undefined,
    } = {
        pdfDocument: undefined,
        firstPagePromise: undefined,
        pagesPromise: undefined,
    };
    readonly openCalls: FakeTask[] = [];
    readonly destroyedDocuments: FakeDocument[] = [];
    closeCalls = 0;
    activeOperations = 0;
    maxActiveOperations = 0;
    private task: FakeTask | undefined;
    private closeBarrier: Deferred<void> | undefined;
    private closeError: Error | undefined;

    blockNextClose(): () => void {
        const barrier = deferred<void>();
        this.closeBarrier = barrier;
        return () => barrier.resolve();
    }

    rejectNextClose(error: Error): void {
        this.closeError = error;
    }

    async open(args: {name: string}): Promise<void> {
        this.activeOperations += 1;
        this.maxActiveOperations = Math.max(this.maxActiveOperations, this.activeOperations);
        const task: FakeTask = {
            name: args.name,
            deferred: deferred<FakeDocument | undefined>(),
            firstPage: deferred<void>(),
            destroyed: false,
        };
        this.task = task;
        this.pdfLoadingTask = task;
        this.openCalls.push(task);
        let document: FakeDocument | undefined;
        try {
            document = await task.deferred.promise;
        } finally {
            this.activeOperations -= 1;
        }
        if (task.destroyed || !document) {
            return;
        }
        this.pdfDocument = document;
        this.pdfViewer.pdfDocument = document;
        this.pdfViewer.firstPagePromise = task.firstPage.promise;
        this.pdfViewer.pagesPromise = task.firstPage.promise;
    }

    async close(): Promise<void> {
        this.activeOperations += 1;
        this.maxActiveOperations = Math.max(this.maxActiveOperations, this.activeOperations);
        this.closeCalls += 1;
        const closeError = this.closeError;
        this.closeError = undefined;
        if (closeError) {
            this.activeOperations -= 1;
            throw closeError;
        }
        const task = this.task;
        const document = this.pdfDocument;
        this.task = undefined;
        this.pdfLoadingTask = undefined;
        this.pdfDocument = undefined;
        this.pdfViewer.pdfDocument = undefined;
        this.pdfViewer.firstPagePromise = undefined;
        this.pdfViewer.pagesPromise = undefined;
        if (task) {
            task.destroyed = true;
            task.deferred.resolve(undefined);
        }
        if (document) {
            document.destroyed = true;
            this.destroyedDocuments.push(document);
        }
        const barrier = this.closeBarrier;
        this.closeBarrier = undefined;
        try {
            await barrier?.promise;
        } finally {
            this.activeOperations -= 1;
        }
    }
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let count = 0; count < 50; count += 1) {
        if (predicate()) {
            return;
        }
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail('condition was not reached');
}

function resolveTask(task: FakeTask, ready = true): FakeDocument {
    const download = deferred<void>();
    const document = {
        name: task.name,
        destroyed: false,
        download,
        getDownloadInfo: () => download.promise,
    };
    task.deferred.resolve(document);
    if (ready) {
        download.resolve();
        task.firstPage.resolve();
    }
    return document;
}

describe('PDF viewer application lifecycle', () => {
    it('closes an in-flight document before opening only the newest replacement', async () => {
        const application = new FakeApplication();
        const controller = createController(application);

        assert.equal(controller.replace(1, {name: 'A'}), true);
        await waitFor(() => application.openCalls.length === 1);
        const documentA = resolveTask(application.openCalls[0]);
        await controller.whenIdle();
        assert.equal(controller.currentGenerationFor(documentA), 1);

        const releaseClose = application.blockNextClose();
        assert.equal(controller.replace(2, {name: 'B'}), true);
        assert.equal(controller.replace(3, {name: 'C'}), true);
        await waitFor(() => documentA.destroyed);
        assert.equal(application.openCalls.length, 1);

        // A late callback can finish while close is in flight, but C cannot be
        // mounted until that public close/destroy transition has completed.
        releaseClose();
        await waitFor(() => application.openCalls.length === 2);
        assert.equal(application.openCalls[1].name, 'C');
        const documentC = resolveTask(application.openCalls[1]);
        await controller.whenIdle();

        assert.equal(application.openCalls.some(task => task.name === 'B'), false);
        assert.equal(controller.currentGenerationFor(documentA), 0);
        assert.equal(controller.currentGenerationFor(documentC), 3);
        assert.deepEqual(application.destroyedDocuments, [documentA]);
        assert.equal(application.maxActiveOperations, 1);
    });

    it('waits for an in-flight open before closing it for a newer generation', async () => {
        const application = new FakeApplication();
        const controller = createController(application);

        controller.replace(1, {name: 'A'});
        await waitFor(() => application.openCalls.length === 1);
        const taskA = application.openCalls[0];
        controller.replace(2, {name: 'B'});
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(taskA.destroyed, false);
        assert.equal(application.openCalls.length, 1);

        resolveTask(taskA);
        await waitFor(() => taskA.destroyed && application.openCalls.length === 2);

        const documentB = resolveTask(application.openCalls[1]);
        await controller.whenIdle();
        assert.equal(controller.currentGenerationFor(documentB), 2);
        assert.equal(application.maxActiveOperations, 1);
    });

    it('accepts events only for the exact current document and generation', async () => {
        const application = new FakeApplication();
        const controller = createController(application);

        controller.replace(4, {name: 'A'});
        await waitFor(() => application.openCalls.length === 1);
        const documentA = resolveTask(application.openCalls[0]);
        await controller.whenIdle();
        assert.equal(controller.currentGenerationFor(documentA), 4);
        const otherDownload = deferred<void>();
        assert.equal(controller.currentGenerationFor({
            name: 'other',
            destroyed: false,
            download: otherDownload,
            getDownloadInfo: () => otherDownload.promise,
        }), 0);

        controller.replace(5, {name: 'B'});
        assert.equal(controller.currentGenerationFor(documentA), 0);
        await waitFor(() => application.openCalls.length === 2);
        const documentB = resolveTask(application.openCalls[1]);
        await controller.whenIdle();
        assert.equal(controller.currentGenerationFor(documentA), 0);
        assert.equal(controller.currentGenerationFor(documentB), 5);
    });

    it('cleans up a failed load and does not make it current', async () => {
        const application = new FakeApplication();
        const errors: Array<{phase: string, generation: number}> = [];
        const controller = createController(application, {
            onError: (_error, phase, generation) => {
                errors.push({phase, generation});
            },
        });

        controller.replace(1, {name: 'broken'});
        await waitFor(() => application.openCalls.length === 1);
        application.openCalls[0].deferred.reject(new Error('invalid PDF'));
        await controller.whenIdle();

        assert.equal(application.openCalls[0].destroyed, true);
        assert.equal(application.pdfDocument, undefined);
        assert.deepEqual(errors, [{phase: 'open', generation: 1}]);
    });

    it('fails closed after destroy rejects and recovers on a later generation', async () => {
        const application = new FakeApplication();
        const errors: Array<{phase: string, generation: number}> = [];
        const controller = createController(application, {
            onError: (_error, phase, generation) => {
                errors.push({phase, generation});
            },
        });

        controller.replace(1, {name: 'A'});
        await waitFor(() => application.openCalls.length === 1);
        const documentA = resolveTask(application.openCalls[0]);
        await controller.whenIdle();

        application.rejectNextClose(new Error('destroy failed'));
        controller.replace(2, {name: 'B'});
        await controller.whenIdle();
        assert.equal(application.openCalls.length, 1);
        assert.equal(controller.currentGenerationFor(documentA), 0);
        assert.deepEqual(errors, [{phase: 'close', generation: 2}]);

        controller.replace(3, {name: 'C'});
        await waitFor(() => application.openCalls.length === 2);
        const documentC = resolveTask(application.openCalls[1]);
        await controller.whenIdle();
        assert.equal(documentA.destroyed, true);
        assert.equal(controller.currentGenerationFor(documentC), 3);
        assert.equal(application.maxActiveOperations, 1);
    });

    it('destroys the mounted document on dispose and rejects later updates', async () => {
        const application = new FakeApplication();
        const controller = createController(application);

        controller.replace(1, {name: 'A'});
        await waitFor(() => application.openCalls.length === 1);
        const documentA = resolveTask(application.openCalls[0]);
        await controller.whenIdle();

        await controller.dispose();
        assert.equal(documentA.destroyed, true);
        assert.equal(controller.currentGenerationFor(documentA), 0);
        assert.equal(controller.replace(2, {name: 'B'}), false);
        assert.equal(application.openCalls.length, 1);
    });

    it('makes ready only the exact document, task and viewer promises', async () => {
        const application = new FakeApplication();
        const sessions: FakeSession[] = [];
        const controller = createController(application, {
            onOpened: session => sessions.push(session),
        });

        controller.replace(1, {name: 'A'});
        await waitFor(() => application.openCalls.length === 1);
        const taskA = application.openCalls[0];
        const documentA = resolveTask(taskA, false);
        await controller.whenIdle();
        const readyA = controller.whenReady(sessions[0], application.pdfViewer);

        controller.replace(2, {name: 'B'});
        documentA.download.resolve();
        taskA.firstPage.resolve();
        assert.equal(await readyA, false);

        await waitFor(() => application.openCalls.length === 2);
        const taskB = application.openCalls[1];
        const documentB = resolveTask(taskB, false);
        await controller.whenIdle();
        const readyB = controller.whenReady(sessions[1], application.pdfViewer);
        documentB.download.resolve();
        taskB.firstPage.resolve();
        assert.equal(await readyB, true);
    });
});
