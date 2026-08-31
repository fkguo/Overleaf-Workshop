import { strict as assert } from 'assert';
import { openProjectFolder } from '../core/projectNavigation';

describe('openProjectFolder', () => {
    it('opens a project in a new window without prefetching it in the source window', async () => {
        const calls: Array<{command: string, args: any[]}> = [];
        const uri = {scheme: 'overleaf-workshop', path: '/project'};

        await openProjectFolder(async (command, ...args) => {
            calls.push({command, args});
        }, uri, true);

        assert.deepEqual(calls, [{
            command: 'vscode.openFolder',
            args: [uri, true],
        }]);
    });

    it('replaces the current window without starting a short-lived source session', async () => {
        const calls: Array<{command: string, args: any[]}> = [];
        const uri = {scheme: 'overleaf-workshop', path: '/project'};

        await openProjectFolder(async (command, ...args) => {
            calls.push({command, args});
        }, uri, false);

        assert.deepEqual(calls, [{
            command: 'vscode.openFolder',
            args: [uri, false],
        }]);
    });

    it('propagates an open failure without issuing another resource command', async () => {
        const calls: string[] = [];
        const failure = new Error('open failed');

        await assert.rejects(
            openProjectFolder(async (command) => {
                calls.push(command);
                throw failure;
            }, 'overleaf-workshop://project', true),
            failure,
        );

        assert.deepEqual(calls, ['vscode.openFolder']);
    });
});
