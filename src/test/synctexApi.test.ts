import { strict as assert } from 'assert';
import { BaseAPI } from '../api/base';

class CapturingAPI extends BaseAPI {
    route = '';
    body: any;

    protected async request(
        _type: any,
        route: string,
        _body?: any,
        _callback?: (res?: string) => object | undefined,
        _extraHeaders?: object,
    ): Promise<any> {
        this.route = route;
        this.body = _body;
        return {type: 'success'};
    }
}

describe('SyncTeX API parameters', () => {
    const identity = {csrfToken: 'csrf', cookies: 'session=cookie'};

    it('sends the stable editor session id with the compile request', async () => {
        const api = new CapturingAPI('https://www.overleaf.com/');
        await api.compile(identity, 'project', 'main.tex', false, false, 'editor');

        assert.equal(api.body.editorId, 'editor');
    });

    it('round-trips special source paths and includes compile routing metadata', async () => {
        const api = new CapturingAPI('https://www.overleaf.com/');
        const file = 'sections/a b#c&d%中文.tex';
        await api.proxySyncCode(identity, 'project', file, 12, 4, 'editor', 'build', 'clsi');

        const url = new URL(api.route, 'https://www.overleaf.com/');
        assert.equal(url.searchParams.get('file'), file);
        assert.equal(url.searchParams.get('line'), '12');
        assert.equal(url.searchParams.get('column'), '4');
        assert.equal(url.searchParams.get('editorId'), 'editor');
        assert.equal(url.searchParams.get('buildId'), 'build');
        assert.equal(url.searchParams.get('clsiserverid'), 'clsi');
    });

    it('uses the compile editor and build ids while omitting optional CLSI routing', async () => {
        const api = new CapturingAPI('https://www.overleaf.com/');
        await api.proxySyncPdf(identity, 'project', 2, 1.25, 3.5, 'editor', 'build');

        const url = new URL(api.route, 'https://www.overleaf.com/');
        assert.equal(url.searchParams.get('editorId'), 'editor');
        assert.equal(url.searchParams.get('buildId'), 'build');
        assert.equal(url.searchParams.has('clsiserverid'), false);
    });
});
