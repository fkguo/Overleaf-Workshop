/* eslint-disable @typescript-eslint/naming-convention */
"use strict";

// Reference: https://github.com/tomoki1207/vscode-pdfviewer/blob/main/lib/main.js
(function(){
    const CursorTool = { SELECT:0, HAND:1, ZOOM:2 };
    const SpreadMode = { UNKNOWN:-1, NONE:0, ODD:1, EVEN:2 };
    const ScrollMode = { UNKNOWN:-1, VERTICAL:0, HORIZONTAL:1, WRAPPED:2, PAGE:3 };
    const SidebarView = { UNKNOWN:-1, NONE:0, THUMBS:1, OUTLINE:2, ATTACHMENTS:3, LAYERS:4 };
    const ScrollModeMap = {
        vertical: ScrollMode.VERTICAL,
        horizontal: ScrollMode.HORIZONTAL,
        wrapped: ScrollMode.WRAPPED,
        page: ScrollMode.PAGE,
    };
    const SpreadModeMap = {
        none: SpreadMode.NONE,
        odd: SpreadMode.ODD,
        even: SpreadMode.EVEN,
    };
    let ColorThemes = {
        'default': {fontColor:'black', bgColor:'white'},
        'light': {fontColor:'black', bgColor:'#F5F5DC'},
        'dark': {fontColor:'#FBF0D9', bgColor:'#4B4B4B'}
    };

    // @ts-ignore
    const vscode = acquireVsCodeApi();
    let globalPdfViewerState = {
        colorTheme: 'default',
        containerScrollLeft: 0,
        containerScrollTop:  0,
        currentScaleValue: 'auto',
        pdfCursorTools: CursorTool.SELECT,
        pdfViewerScrollMode: ScrollMode.VERTICAL,
        pdfViewerSpreadMode: SpreadMode.NONE,
        pdfSidebarView: SidebarView.NONE,
    };
    const syncGenerationGate = OverleafPdfSyncGeneration.createGate();
    let pdfLoadGeneration = 0;
    let loadingPdfGeneration = 0;
    let readyPdfGeneration = 0;
    let loadingPdfDocument;
    const pdfLifecycle = OverleafPdfLifecycle.createController(PDFViewerApplication, {
        onError: (error, phase, generation) => {
            console.error(`PDF ${phase} failed for generation ${generation}`, error);
        },
        onFatal: () => {
            vscode.postMessage({type: 'pdfLifecycleFatal'});
        },
        onOpened: session => {
            const pagesPromise = PDFViewerApplication.pdfViewer.pagesPromise;
            pdfLifecycle.whenReady(session, PDFViewerApplication.pdfViewer).then(ready => {
                if (!ready || session.pdfGeneration !== pdfLoadGeneration) { return; }
                loadingPdfGeneration = session.pdfGeneration;
                loadingPdfDocument = session.pdfDocument;
                readyPdfGeneration = session.pdfGeneration;
                updatePdfViewerState();
                window.requestAnimationFrame(flushPendingSyncCode);
                pagesPromise?.then(() => {
                    if (
                        pdfLifecycle.currentGenerationFor(session.pdfDocument) === session.pdfGeneration &&
                        readyPdfGeneration === session.pdfGeneration
                    ) {
                        flushPendingSyncCode();
                    }
                }).catch(() => {});
            });
        },
    });

    function updatePdfViewerState() {
        const pdfViewerState = vscode.getState() || globalPdfViewerState;

        if (ColorThemes[pdfViewerState.colorTheme] === undefined) {
            pdfViewerState.colorTheme = Object.keys(ColorThemes)[0];
        }
        pdfjsLib.ViewerFontColor = ColorThemes[pdfViewerState.colorTheme].fontColor;
        pdfjsLib.ViewerBgColor = ColorThemes[pdfViewerState.colorTheme].bgColor;

        PDFViewerApplication.pdfViewer.currentScaleValue = pdfViewerState.currentScaleValue;
        PDFViewerApplication.pdfCursorTools.switchTool( pdfViewerState.pdfCursorTools );
        PDFViewerApplication.pdfViewer.scrollMode = pdfViewerState.pdfViewerScrollMode;
        PDFViewerApplication.pdfViewer.spreadMode = pdfViewerState.pdfViewerSpreadMode;
        PDFViewerApplication.pdfSidebar.setInitialView( pdfViewerState.pdfSidebarView );
        PDFViewerApplication.pdfSidebar.switchView( pdfViewerState.pdfSidebarView );
        document.getElementById('viewerContainer').scrollLeft = pdfViewerState.containerScrollLeft;
        document.getElementById('viewerContainer').scrollTop = pdfViewerState.containerScrollTop;
        PDFViewerApplication.pdfViewer.refresh();
    }

    function backupPdfViewerState() {
        if (PDFViewerApplication.pdfViewer.currentScaleValue !== null) {
            console.log( PDFViewerApplication.pdfViewer.currentScaleValue );
            globalPdfViewerState.currentScaleValue = PDFViewerApplication.pdfViewer.currentScaleValue;
        }
        globalPdfViewerState.pdfViewerScrollMode = PDFViewerApplication.pdfViewer.scrollMode;
        globalPdfViewerState.pdfViewerSpreadMode = PDFViewerApplication.pdfViewer.spreadMode;
        globalPdfViewerState.pdfSidebarView = PDFViewerApplication.pdfSidebar.visibleView;
        globalPdfViewerState.containerScrollLeft = document.getElementById('viewerContainer').scrollLeft || 0;
        globalPdfViewerState.containerScrollTop = document.getElementById('viewerContainer').scrollTop || 0;
        vscode.setState(globalPdfViewerState);
        vscode.postMessage({
            type: 'saveState',
            content: globalPdfViewerState,
        });
    }

    function updateColorThemes(themes) {
        ColorThemes = themes;
        // set global css
        const style = document.createElement('style');
        for (const theme in ColorThemes) {
            // sanitize theme name
            if (theme.match(/^[a-zA-Z0-9-_]+$/) === null) {
                continue;
            }
            // sanitize color value
            if (ColorThemes[theme].fontColor.match(/^#[0-9a-fA-F]{6}$/) === null) {
                continue;
            }
            if (ColorThemes[theme].bgColor.match(/^#[0-9a-fA-F]{6}$/) === null) {
                continue;
            }
            // update css
            style.innerHTML += `
                #theme-${theme}::before {
                    background-color: ${ColorThemes[theme].bgColor};
                }
            `;
        }
        document.head.appendChild(style);
    }

    function updatePdfViewerDefaults(defaults) {
        if (defaults === undefined || defaults === null) {
            return;
        }
        if (typeof defaults.scrollMode === 'string') {
            const scrollMode = ScrollModeMap[defaults.scrollMode.toLowerCase()];
            if (scrollMode !== undefined) {
                globalPdfViewerState.pdfViewerScrollMode = scrollMode;
            }
        }
        if (typeof defaults.spreadMode === 'string') {
            const spreadMode = SpreadModeMap[defaults.spreadMode.toLowerCase()];
            if (spreadMode !== undefined) {
                globalPdfViewerState.pdfViewerSpreadMode = spreadMode;
            }
        }
    }

    function enableThemeToggleButton(initIndex = 0){
        // create toggle theme button
        const button = document.createElement('button');
        button.setAttribute('class', 'toolbarButton hiddenMediumView');
        button.setAttribute('theme-index', initIndex);
        button.setAttribute('tabindex', '30');
        // set button theme attribute
        const setAttribute = (index) => {
            const theme = Object.keys(ColorThemes)[index];
            globalPdfViewerState.colorTheme = theme;
            button.innerHTML = `<span>${theme}</span>`;
            button.setAttribute('title', `Theme: ${theme}`);
            button.setAttribute('id', `theme-${theme}`);
        };
        button.addEventListener('click', () => {
            const index = Number(button.getAttribute('theme-index'));
            const next = (index + 1) % Object.keys(ColorThemes).length;
            button.setAttribute('theme-index', next);
            setAttribute(next);
            backupPdfViewerState();
            updatePdfViewerState();
        });
        setAttribute(initIndex);
        //
        const container = document.getElementById('toolbarViewerRight');
        const firstChild = document.getElementById('openFile');
        container.insertBefore(button, firstChild);
    }

    function updatePdf(pdf, generation) {
        if (!syncGenerationGate.beginPdfLoad(generation)) {
            return;
        }
        if (
            readyPdfGeneration !== 0 &&
            PDFViewerApplication.pdfDocument === loadingPdfDocument
        ) {
            backupPdfViewerState();
        }
        pdfLoadGeneration = generation;
        readyPdfGeneration = 0;
        loadingPdfGeneration = 0;
        loadingPdfDocument = undefined;
        PDFViewerApplication.isViewerEmbedded = true;
        pdfLifecycle.replace(generation, {
            data: pdf,
            cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.10.111/cmaps/',
            cMapPacked: true
        });
    }

    function revealSyncCode(pdf) {
        if (
            readyPdfGeneration !== pdfLoadGeneration ||
            PDFViewerApplication.pdfDocument !== loadingPdfDocument
        ) {
            return false;
        }
        if (!Array.isArray(pdf) || pdf.length === 0) {
            return true;
        }
        const target = pdf.find(item => Number.isInteger(item.page) && item.page > 0);
        if (!target) {
            return true;
        }
        const pageView = PDFViewerApplication.pdfViewer.getPageView(target.page - 1);
        if (!pageView?.viewport) {
            return false;
        }

        const {viewport} = pageView;
        const viewBoxHeight = viewport.viewBox[3] + 10;
        const width = Number(target.width) || 0;
        const height = Number(target.height) || 0;
        const x = Number(target.h) + width / 2;
        const y = viewBoxHeight - (Number(target.v) + height / 2);
        if (!Number.isFinite(x) || !Number.isFinite(y)) { return true; }

        // Let PDF.js reveal the page and transform the PDF point. This also
        // switches the mounted page in ScrollMode.PAGE, where off-page divs are
        // intentionally detached and have unusable DOM offsets.
        PDFViewerApplication.pdfViewer.scrollPageIntoView({
            pageNumber: target.page,
            destArray: [null, {name: 'XYZ'}, x, y, null],
            ignoreDestinationZoom: true,
        });
        backupPdfViewerState();
        return true;
    }

    function flushPendingSyncCode() {
        const pendingSyncCode = syncGenerationGate.readyContent(readyPdfGeneration);
        if (pendingSyncCode !== undefined && revealSyncCode(pendingSyncCode)) {
            syncGenerationGate.consume(readyPdfGeneration);
        }
    }

    function syncCode(pdf, pdfGeneration) {
        if (syncGenerationGate.queueSync(pdfGeneration, pdf)) {
            window.requestAnimationFrame(flushPendingSyncCode);
        }
    }

    //Reference: https://github.com/overleaf/overleaf/blob/main/services/web/frontend/js/features/pdf-preview/util/pdf-js-wrapper.js#L163
    function syncPdf(pageElem, pageNum, clientX, clientY, innerText) {
        if (!OverleafPdfSyncGeneration.isReadyPdfGeneration(
            readyPdfGeneration,
            pdfLoadGeneration,
            PDFViewerApplication.pdfDocument,
            loadingPdfDocument
        )) {
            return;
        }
        const pdfGeneration = readyPdfGeneration;
        const pageCanvas = pageElem.querySelector('canvas');
        const pageRect = pageCanvas.getBoundingClientRect();
        const {viewport} = PDFViewerApplication.pdfViewer.getPageView(pageNum - 1);
        const dx = clientX - pageRect.left;
        const dy = clientY - pageRect.top;
        let [left, top] = viewport.convertToPdfPoint(dx, dy);
        top = viewport.viewBox[3] - top;
        vscode.postMessage({
            type: 'syncPdf',
            content: {
                page: Number(pageNum),
                h: left,
                v: top,
                identifier: innerText,
                pdfGeneration,
            },
        });
        backupPdfViewerState();
    }

    window.addEventListener('load', async () => {
        // init pdf.js configuration
        PDFViewerApplication.initializedPromise
        .then(() => {
            const {eventBus, _boundEvents} = PDFViewerApplication;
            eventBus._off("beforeprint", _boundEvents.beforePrint);
            eventBus._on('pagesloaded', flushPendingSyncCode);
            eventBus._on('pagerendered', flushPendingSyncCode);
            // backup scale
            eventBus._on('scalechanged', backupPdfViewerState);
            eventBus._on("zoomin", backupPdfViewerState);
            eventBus._on("zoomout", backupPdfViewerState);
            eventBus._on("zoomreset", backupPdfViewerState);
            // backup scroll/spread mode
            eventBus._on("switchscrollmode", backupPdfViewerState);
            eventBus._on("scrollmodechanged", backupPdfViewerState);
            eventBus._on("switchspreadmode", backupPdfViewerState);
            vscode.postMessage({type: 'ready'});
        });

        // add message listener
        window.addEventListener('message', async (e) => {
            const message = e.data;
            switch (message.type) {
                case 'update':
                    updatePdf(message.content, message.pdfGeneration);
                    break;
                case 'syncCode':
                    syncCode(message.content, message.pdfGeneration);
                    break;
                case 'initState':
                    updatePdfViewerDefaults(message.defaults);
                    if (message.content!==undefined) {
                        Object.assign(globalPdfViewerState, message.content);
                    }
                    if (message.colorThemes!==undefined) {
                        updateColorThemes(message.colorThemes);
                    }
                    updatePdfViewerState();
                    enableThemeToggleButton( Object.keys(ColorThemes).indexOf(globalPdfViewerState.colorTheme) );
                    break;
                default:
                    break;
            }
        });

        // add mouse double click listener
        window.addEventListener('dblclick', (e) => {
            const pageElem = e.target.parentElement.parentElement;
            const pageNum = pageElem.getAttribute('data-page-number');
            if (pageNum === null || pageNum === undefined) {
                return;
            }
            syncPdf(pageElem, pageNum, e.clientX, e.clientY, e.target.innerText);
        });

        window.addEventListener('pagehide', () => {
            pdfLifecycle.dispose();
        }, {once: true});

        // Display Error Message
        window.onerror = () => {
            const msg = document.createElement('body');
            msg.innerText = 'An error occurred while loading the file. Please open it again.';
            document.body = msg;
        };
    }, { once : true });

}());
