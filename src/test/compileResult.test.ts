import { strict as assert } from 'assert';
import {
    compileRequestKindForTrigger,
    hasDirtyCompileSource,
    hasUsableCachedPdfIdentity,
    isCachedCompileCompatible,
    mergeCompileOutputs,
    mergeCompileRequestKinds,
    normalizeCompileStatus,
    resolveCompileOutputRouting,
} from '../compile/compileResult';

describe('compile output commit policy', () => {
    it('updates failed-build logs while retaining the last successful PDF', () => {
        const oldPdf = {path: 'output.pdf', build: 'successful'};
        const outputs = mergeCompileOutputs(
            [oldPdf, {path: 'output.log', build: 'old'}],
            [
                {path: 'output.log', build: 'failed'},
                {path: 'output.stderr', build: 'failed'},
                {path: 'output.pdf', build: 'failed'},
            ],
            false,
        );

        assert.deepEqual(outputs, [
            {path: 'output.log', build: 'failed'},
            {path: 'output.stderr', build: 'failed'},
            oldPdf,
        ]);
    });

    it('does not expose a PDF produced by a non-success response', () => {
        assert.deepEqual(
            mergeCompileOutputs([], [
                {path: 'output.log', build: 'failed'},
                {path: 'output.pdf', build: 'failed'},
            ], false),
            [{path: 'output.log', build: 'failed'}],
        );
    });

    it('replaces all prior artifacts after a successful build', () => {
        assert.deepEqual(
            mergeCompileOutputs(
                [{path: 'output.pdf', build: 'old'}],
                [
                    {path: 'output.log', build: 'new'},
                    {path: 'output.pdf', build: 'new'},
                ],
                true,
            ),
            [
                {path: 'output.log', build: 'new'},
                {path: 'output.pdf', build: 'new'},
            ],
        );
    });

    it('does not route a failed log through the retained PDF build', () => {
        const fallback = {
            compileGroup: 'priority',
            clsiServerId: 'successful-node',
            pdfDownloadDomain: 'https://pdf.example',
        };
        assert.deepEqual(resolveCompileOutputRouting({}, fallback), {});
        assert.deepEqual(resolveCompileOutputRouting(undefined, fallback), fallback);
    });
});

describe('compile status normalization', () => {
    it('preserves structured Overleaf statuses', () => {
        assert.equal(normalizeCompileStatus('stopped-on-first-error'), 'stopped-on-first-error');
        assert.equal(normalizeCompileStatus('validation-problems'), 'validation-problems');
        assert.equal(normalizeCompileStatus('autocompile-backoff'), 'autocompile-backoff');
        assert.equal(normalizeCompileStatus('autocompile-disabled'), 'autocompile-disabled');
        assert.equal(normalizeCompileStatus('clsi-unavailable'), 'clsi-unavailable');
    });

    it('classifies HTTP-level rate limiting and availability failures', () => {
        assert.equal(normalizeCompileStatus(undefined, '429: Too Many Requests'), 'rate-limited');
        assert.equal(normalizeCompileStatus(undefined, '503: Service Unavailable'), 'unavailable');
        assert.equal(normalizeCompileStatus(undefined, '504: Gateway Timeout'), 'timedout');
    });
});

describe('compile request intent', () => {
    it('keeps commands manual and background triggers automatic', () => {
        assert.equal(compileRequestKindForTrigger('command'), 'manual');
        assert.equal(compileRequestKindForTrigger('initial-project'), 'automatic');
        assert.equal(compileRequestKindForTrigger('save'), 'automatic');
        assert.equal(compileRequestKindForTrigger('project-setting-event'), 'automatic');
    });

    it('does not let an automatic queued request demote a manual one', () => {
        assert.equal(mergeCompileRequestKinds(undefined, 'automatic'), 'automatic');
        assert.equal(mergeCompileRequestKinds('automatic', 'manual'), 'manual');
        assert.equal(mergeCompileRequestKinds('manual', 'automatic'), 'manual');
    });
});

describe('cached compile adoption', () => {
    const requested = {
        rootResourcePath: 'paper/main.tex',
        draft: false,
        stopOnFirstError: false,
    };

    it('adopts only a successful cached PDF with compatible settings', () => {
        assert.equal(isCachedCompileCompatible(
            'success',
            [{path: 'output.log'}, {path: 'output.pdf'}],
            requested,
            requested,
        ), true);
        assert.equal(isCachedCompileCompatible(
            'failure',
            [{path: 'output.pdf'}],
            requested,
            requested,
        ), false);
        assert.equal(isCachedCompileCompatible(
            'success',
            [{path: 'output.log'}],
            requested,
            requested,
        ), false);
    });

    it('rejects a different root document or draft mode', () => {
        assert.equal(isCachedCompileCompatible(
            'success',
            [{path: 'output.pdf'}],
            {...requested, rootResourcePath: 'other.tex'},
            requested,
        ), false);
        assert.equal(isCachedCompileCompatible(
            'success',
            [{path: 'output.pdf'}],
            {...requested, draft: true},
            requested,
        ), false);
    });

    it('allows a stricter cached stop-on-error run but not the inverse', () => {
        assert.equal(isCachedCompileCompatible(
            'success',
            [{path: 'output.pdf'}],
            {...requested, stopOnFirstError: true},
            requested,
        ), true);
        assert.equal(isCachedCompileCompatible(
            'success',
            [{path: 'output.pdf'}],
            requested,
            {...requested, stopOnFirstError: true},
        ), false);
    });

    it('fails closed when cached compile options are absent', () => {
        assert.equal(isCachedCompileCompatible(
            'success',
            [{path: 'output.pdf'}],
            undefined,
            requested,
        ), false);
    });

    it('requires the cached PDF producer identity for SyncTeX', () => {
        assert.equal(hasUsableCachedPdfIdentity([
            {path: 'output.pdf', build: 'build', editorId: 'editor'},
        ]), true);
        assert.equal(hasUsableCachedPdfIdentity([
            {path: 'output.pdf', build: 'build'},
        ]), false);
        assert.equal(hasUsableCachedPdfIdentity([
            {path: 'output.log', build: 'build', editorId: 'editor'},
        ]), false);
    });

    it('bypasses the cache only for dirty editors from the same project connection', () => {
        assert.equal(hasDirtyCompileSource('server-a\0user\0project', [
            {projectKey: 'server-b\0user\0project', isDirty: true},
            {projectKey: 'server-a\0user\0project', isDirty: false},
        ]), false);
        assert.equal(hasDirtyCompileSource('server-a\0user\0project', [
            {projectKey: 'server-a\0user\0project', isDirty: true},
        ]), true);
    });
});
