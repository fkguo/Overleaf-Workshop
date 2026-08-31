import { strict as assert } from 'assert';
import { BaseAPI } from '../api/base';

type Connect = (url: string, options: any) => any;

describe('BaseAPI realtime transport configuration', () => {
    const socketIOClient = require('socket.io-client') as {
        connect: Connect;
        util: {request: () => any};
    };
    const originalConnect = socketIOClient.connect;
    const originalRequest = socketIOClient.util.request;
    const identity = {csrfToken: 'csrf', cookies: 'session=cookie'};

    afterEach(() => {
        socketIOClient.connect = originalConnect;
        socketIOClient.util.request = originalRequest;
    });

    it('passes the v2 project query through socket options', () => {
        let capturedUrl: string | undefined;
        let capturedOptions: any;
        const transport = {connected: false};
        socketIOClient.connect = (url, options) => {
            capturedUrl = url;
            capturedOptions = options;
            return transport;
        };

        const api = new BaseAPI('https://www.overleaf.com/');
        const result = api._initSocketV0(identity, '?projectId=project-id&t=123');

        assert.strictEqual(result, transport);
        assert.equal(capturedUrl, 'https://www.overleaf.com');
        assert.equal(capturedOptions.query, 'projectId=project-id&t=123');
        assert.equal(capturedOptions.extraHeaders.Origin, 'https://www.overleaf.com');
        assert.equal(capturedOptions.extraHeaders.Cookie, identity.cookies);
        assert.equal(capturedOptions.reconnect, false);
        assert.equal(capturedOptions['auto connect'], false);
    });

    it('keeps the legacy self-host fallback queryless', () => {
        let capturedOptions: any;
        socketIOClient.connect = (_url, options) => {
            capturedOptions = options;
            return {connected: false};
        };

        const api = new BaseAPI('https://latex.example.test/');
        assert.doesNotThrow(() => api._initSocketV0(identity));
        assert.equal(capturedOptions.query, '');
    });

    it('puts projectId on the real 0.9 handshake and exposes a 502 as an error', async () => {
        let handshakeUrl = '';
        class FakeXHR {
            readyState = 0;
            status = 0;
            responseText = '';
            onreadystatechange?: () => void;

            open(_method: string, url: string) {
                handshakeUrl = url;
            }

            setDisableHeaderCheck() {}
            setRequestHeader(_key: string, _value: string) {}
            getAllResponseHeaders() { return ''; }

            send() {
                this.readyState = 4;
                this.status = 502;
                this.responseText = 'Bad Gateway';
                setImmediate(() => this.onreadystatechange?.());
            }
        }
        socketIOClient.util.request = () => new FakeXHR();

        const api = new BaseAPI('https://www.overleaf.com/');
        const socket = api._initSocketV0(identity, 'projectId=0123456789abcdef01234567');
        const error = new Promise<unknown>(resolve => socket.on('error', resolve));

        assert.equal(handshakeUrl, '');
        socket.socket.connect();
        assert.equal(await error, 'Bad Gateway');

        const parsed = new URL(handshakeUrl);
        assert.equal(parsed.searchParams.get('projectId'), '0123456789abcdef01234567');
        assert.ok(parsed.searchParams.has('t'));
        assert.equal(socket.socket.options.reconnect, false);
    });
});
