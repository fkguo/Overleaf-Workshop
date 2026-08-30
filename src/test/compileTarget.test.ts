import { strict as assert } from 'assert';
import { resolveCompileRootDocId } from '../compile/compileTarget';

const encode = (content: string) => new TextEncoder().encode(content);

describe('resolveCompileRootDocId', () => {
    it('uses the configured main document when startup only has the workspace folder', async () => {
        let resolved = false;
        let read = false;

        const rootDocId = await resolveCompileRootDocId(
            '/',
            async () => {
                resolved = true;
                return {fileType: 'folder', fileId: 'folder-id'};
            },
            async () => {
                read = true;
                return encode('');
            },
        );

        assert.equal(rootDocId, undefined);
        assert.equal(resolved, false);
        assert.equal(read, false);
    });

    it('overrides the configured main document for an active standalone TeX document', async () => {
        const rootDocId = await resolveCompileRootDocId(
            '/alternate.tex',
            async () => ({fileType: 'doc', fileId: 'alternate-id'}),
            async () => encode('\\documentclass[11pt]{article}\n'),
        );

        assert.equal(rootDocId, 'alternate-id');
    });

    it('supports the other configured LaTeX source extensions', async () => {
        const rootDocId = await resolveCompileRootDocId(
            '/alternate.ctx',
            async () => ({fileType: 'doc', fileId: 'ctx-id'}),
            async () => encode('\\documentclass{context}\n'),
        );

        assert.equal(rootDocId, 'ctx-id');
    });

    it('keeps the configured main document for an included TeX fragment', async () => {
        const rootDocId = await resolveCompileRootDocId(
            '/sections/results.tex',
            async () => ({fileType: 'doc', fileId: 'fragment-id'}),
            async () => encode('\\section{Results}\n'),
        );

        assert.equal(rootDocId, undefined);
    });

    it('falls back to the configured main document when a restored resource is stale', async () => {
        const failure = new Error('HTTP 404');
        let fallbackError: unknown;
        const rootDocId = await resolveCompileRootDocId(
            '/stale.tex',
            async () => ({fileType: 'file', fileId: 'stale-id'}),
            async () => { throw failure; },
            error => { fallbackError = error; },
        );

        assert.equal(rootDocId, undefined);
        assert.equal(fallbackError, failure);
    });
});
