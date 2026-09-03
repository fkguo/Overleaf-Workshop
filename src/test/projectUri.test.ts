import { strict as assert } from 'assert';
import {
    parseProjectUri,
    projectConnectionKey,
    resolveAuthenticatedProjectUserId,
} from '../core/projectUri';

describe('Overleaf project URI normalization', () => {
    const userId = '5b0bdb5c20985d217909e663';
    const projectId = '6a267924a8d52f9e32de2934';
    const decodedQuery = `user=${userId}&project=${projectId}`;

    it('parses the normal decoded VS Code query representation', () => {
        const parsed = parseProjectUri('www.overleaf.com', '/Xb/sections/a.tex', decodedQuery);
        assert.equal(parsed.userId, userId);
        assert.equal(parsed.projectId, projectId);
        assert.equal(parsed.projectName, 'Xb');
        assert.equal(
            parsed.identifier,
            JSON.stringify(['www.overleaf.com', userId, projectId, 'Xb']),
        );
        assert.deepEqual(parsed.pathParts, ['sections', 'a.tex']);
    });

    it('parses an encoded whole query restored from workspace history', () => {
        const parsed = parseProjectUri(
            'www.overleaf.com',
            '/Xb',
            encodeURIComponent(decodedQuery),
        );
        assert.equal(parsed.userId, userId);
        assert.equal(parsed.projectId, projectId);
    });

    it('maps encoded, decoded, and reordered queries to one VFS key', () => {
        const expected = projectConnectionKey('www.overleaf.com', decodedQuery);
        assert.equal(
            projectConnectionKey('www.overleaf.com', encodeURIComponent(decodedQuery)),
            expected,
        );
        assert.equal(
            projectConnectionKey('www.overleaf.com', `project=${projectId}&user=${userId}`),
            expected,
        );
    });

    it('maps encoded and reordered aliases to one opaque project identifier', () => {
        const expected = parseProjectUri('www.overleaf.com', '/Xb', decodedQuery).identifier;
        assert.equal(
            parseProjectUri(
                'www.overleaf.com',
                '/Xb',
                encodeURIComponent(decodedQuery),
            ).identifier,
            expected,
        );
        assert.equal(
            parseProjectUri(
                'www.overleaf.com',
                '/Xb',
                `project=${projectId}&user=${userId}`,
            ).identifier,
            expected,
        );
    });

    it('keeps the same account/project tuple distinct across authorities', () => {
        const primary = parseProjectUri('www.overleaf.com', '/Xb', decodedQuery);
        const community = parseProjectUri('overleaf.example.edu', '/Xb', decodedQuery);
        assert.notEqual(primary.identifier, community.identifier);
    });

    it('rejects a history URI without an actionable project identity', () => {
        assert.throws(
            () => parseProjectUri('www.overleaf.com', '/Xb', 'user=only-user'),
            /missing user or project/,
        );
    });

    it('accepts only the current authenticated user for a restored workspace URI', () => {
        assert.equal(resolveAuthenticatedProjectUserId(userId, userId), userId);
        assert.throws(
            () => resolveAuthenticatedProjectUserId(userId, 'different-user'),
            /does not match the current authenticated account/,
        );
        assert.throws(
            () => resolveAuthenticatedProjectUserId(userId, undefined),
            /does not match the current authenticated account/,
        );
    });
});
