import { strict as assert } from 'assert';
import { BaseAPI } from '../api/base';

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
});
