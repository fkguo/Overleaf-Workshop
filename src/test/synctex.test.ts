import { strict as assert } from 'assert';
import {
    LatestRequestGate,
    normalizeSynctexResultPath,
    resolveSynctexOutputIdentity,
    toSynctexSourceLocation,
} from '../compile/synctex';

describe('toSynctexSourceLocation', () => {
    it('converts the zero-based editor line to the one-based SyncTeX line', () => {
        assert.deepEqual(
            toSynctexSourceLocation('/chapters/intro.tex', {line: 19, character: 7}),
            {file: 'chapters/intro.tex', line: 20, column: 7},
        );
    });

    it('matches Overleaf root-document-relative paths in a subdirectory', () => {
        assert.deepEqual(
            toSynctexSourceLocation(
                'paper/sections/result.tex',
                {line: 0, character: 0},
                '/paper/main.tex',
            ),
            {file: 'paper/./sections/result.tex', line: 1, column: 0},
        );
    });
});

describe('LatestRequestGate', () => {
    it('rejects an older response after a newer request starts', () => {
        const gate = new LatestRequestGate();
        const older = gate.begin('output.pdf');
        const newer = gate.begin('output.pdf');
        assert.equal(gate.isCurrent('output.pdf', older), false);
        assert.equal(gate.isCurrent('output.pdf', newer), true);
    });

    it('rejects an in-flight response after its PDF view is disposed', () => {
        const gate = new LatestRequestGate();
        const request = gate.begin('output.pdf');
        gate.invalidate('output.pdf');
        assert.equal(gate.isCurrent('output.pdf', request), false);
    });
});

describe('resolveSynctexOutputIdentity', () => {
    it('prefers explicit PDF build and editor metadata', () => {
        assert.deepEqual(resolveSynctexOutputIdentity([
            {path: 'output.log', url: '/build/unrelated/output/output.log', build: 'other'},
            {
                path: 'output.pdf',
                url: '/build/editor-build/output/output.pdf',
                build: 'build',
                editorId: 'editor',
            },
        ], 'session'), {buildId: 'build', editorId: 'editor'});
    });

    it('separates an editor-prefixed cached URL when old metadata omits build', () => {
        assert.deepEqual(resolveSynctexOutputIdentity([
            {
                path: 'output.pdf',
                url: '/build/editor-build/output/output.pdf',
                editorId: 'editor',
            },
        ], 'session'), {buildId: 'build', editorId: 'editor'});
    });
});

describe('normalizeSynctexResultPath', () => {
    it('removes SyncTeX dot segments used for a nested root document', () => {
        assert.equal(normalizeSynctexResultPath('paper/./sections/result.tex'), 'paper/sections/result.tex');
    });

    it('rejects absolute and parent-traversal paths', () => {
        assert.equal(normalizeSynctexResultPath('/outside.tex'), undefined);
        assert.equal(normalizeSynctexResultPath('paper/../outside.tex'), undefined);
    });
});
