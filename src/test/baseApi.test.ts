import { strict as assert } from 'assert';
import { BaseAPI, parseChangesUsersResponse } from '../api/base';

class CapturingAPI extends BaseAPI {
    route = '';
    requestOptions?: {timeoutMs?: number, maxRetries?: number};

    protected async request(
        _type: any,
        route: string,
        _body?: any,
        _callback?: (res?: string) => object | undefined,
        _extraHeaders?: object,
        requestOptions?: {timeoutMs?: number, maxRetries?: number},
    ): Promise<any> {
        this.route = route;
        this.requestOptions = requestOptions;
        return {type: 'success'};
    }
}

class DocumentResponseAPI extends BaseAPI {
    constructor(private readonly response: string) {
        super('https://www.overleaf.com/');
    }

    protected async request(
        _type: any,
        _route: string,
        _body?: any,
        callback?: (res?: string) => object | undefined,
    ): Promise<any> {
        return {type: 'success', ...callback?.(this.response)};
    }
}

describe('BaseAPI route construction', () => {
    const identity = {csrfToken: 'csrf', cookies: 'session=cookie'};

    it('does not classify a manual compile as an automatic compile', async () => {
        const api = new CapturingAPI('https://www.overleaf.com/');
        await api.compile(identity, 'project', 'main.tex', false, false, 'editor', false);

        assert.equal(api.route, 'project/project/compile');
    });

    it('marks a save-triggered compile as automatic', async () => {
        const api = new CapturingAPI('https://www.overleaf.com/');
        await api.compile(identity, 'project', 'main.tex', false, false, 'editor', true);

        assert.equal(api.route, 'project/project/compile?auto_compile=true');
    });

    it('encodes special history pathnames without changing their value', async () => {
        const api = new CapturingAPI('https://www.overleaf.com/');
        const pathname = 'sections/a b#c&d+e%中文.tex';
        await api.proxyToHistoryApiAndGetFileDiff(identity, 'project', pathname, 2, 7);

        const url = new URL(api.route, 'https://www.overleaf.com/');
        assert.equal(url.searchParams.get('pathname'), pathname);
        assert.equal(url.searchParams.get('from'), '2');
        assert.equal(url.searchParams.get('to'), '7');
    });

    it('preserves a zero history cursor', async () => {
        const api = new CapturingAPI('https://www.overleaf.com/');
        await api.proxyToHistoryApiAndGetUpdates(identity, 'project', 0);

        const url = new URL(api.route, 'https://www.overleaf.com/');
        assert.equal(url.searchParams.get('before'), '0');
    });

    it('bounds the optional cached-compile probe without retrying it', async () => {
        const api = new CapturingAPI('https://www.overleaf.com/');
        await api.getCachedCompile(identity, 'project');

        assert.equal(api.route, 'project/project/output/cached/output.overleaf.json');
        assert.deepEqual(api.requestOptions, {timeoutMs: 5000, maxRetries: 0});
    });

    it('preserves the document identity and name returned by the server', async () => {
        const api = new DocumentResponseAPI(JSON.stringify({
            _id: 'server-document-id',
            name: 'server-normalized-name.tex',
        }));

        const response = await api.addDoc(identity, 'project', 'folder', 'requested-name.tex');

        assert.deepEqual(response.entity, {
            _type: 'doc',
            _id: 'server-document-id',
            name: 'server-normalized-name.tex',
        });
    });

    for (const invalid of [
        {},
        {_id: '', name: 'document.tex'},
        {_id: 'document-id', name: ''},
        {_id: 7, name: 'document.tex'},
        {_id: 'document-id', name: 7},
    ]) {
        it(`rejects an invalid document identity response ${JSON.stringify(invalid)}`, async () => {
            const api = new DocumentResponseAPI(JSON.stringify(invalid));

            await assert.rejects(
                api.addDoc(identity, 'project', 'folder', 'requested-name.tex'),
                /invalid document identity/i,
            );
        });
    }

    it('uses the official project comment-thread endpoint', async () => {
        const api = new CapturingAPI('https://www.overleaf.com/');
        await api.getCommentThreads(identity, 'project');

        assert.equal(api.route, 'project/project/threads');
    });

    it('uses the official Track Changes author-directory endpoint', async () => {
        const api = new CapturingAPI('https://www.overleaf.com/');
        await api.getChangesUsers(identity, 'project');

        assert.equal(api.route, 'project/project/changes/users');
    });

    it('validates Track Changes users without dropping future fields', () => {
        const raw = [{
            id: 'former-member',
            email: 'former@example.test',
            ['first_name']: 'Former',
            future: {role: 'opaque'},
        }];
        assert.strictEqual(parseChangesUsersResponse(raw), raw);
        assert.throws(() => parseChangesUsersResponse({}), /must be an array/);
        assert.throws(
            () => parseChangesUsersResponse([{id: 'user', email: 4}]),
            /email must be a string/,
        );
    });
});
