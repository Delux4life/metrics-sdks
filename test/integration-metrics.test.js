/* eslint-disable no-restricted-syntax */
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { Readable } from 'node:stream';

import chai, { expect } from 'chai';
import { FormDataEncoder } from 'form-data-encoder';
import { File, FormData } from 'formdata-node';
import 'isomorphic-fetch';

import chaiPlugins from './helpers/chai-plugins.js';

chai.use(chaiPlugins);

const PORT = 8000; // SDK HTTP server
const randomAPIKey = 'rdme_abcdefghijklmnopqrstuvwxyz'; // This must match what's in `docker-compose.yml`.

function supportsMultipart() {
  return 'SUPPORTS_MULTIPART' in process.env && process.env.SUPPORTS_MULTIPART === 'true';
}

function isListening(port, attempt = 0) {
  return new Promise((resolve, reject) => {
    if (attempt > 5) throw new Error(`Cannot connect on port: ${port}`);
    const socket = net.connect(port, '0.0.0.0');
    socket.once('error', err => {
      if (err.code !== 'ECONNREFUSED') {
        throw err;
      }
      return setTimeout(() => {
        return isListening(port, attempt + 1).then(resolve, reject);
      }, 300 * attempt);
    });

    socket.once('connect', () => {
      socket.destroy();
      // Sometimes the TCP connection is resolving before
      // the HTTP server is ready to receive connections
      // So just sleeping for 500ms to be sure.
      return setTimeout(() => resolve(), 500);
    });
  });
}

describe('Metrics SDK Integration Tests', function () {
  // this.retries(2);

  const sockets = new Set();

  let server;
  let sdkCall = {
    req: {},
    body: {},
  };

  async function getBody(response) {
    let responseBody = '';
    for await (const chunk of response) {
      responseBody += chunk;
    }

    expect(responseBody).not.to.equal('');
    return JSON.parse(responseBody);
  }

  async function getRequest() {
    if (process.env.HAS_HTTP_QUIRKS) {
      return [sdkCall.req, sdkCall.body];
    }

    const [req] = await once(server, 'request');
    const body = await getBody(req);
    return [req, body];
  }

  beforeEach(function () {
    sdkCall = {
      req: {},
      body: {},
    };
  });

  before(async function () {
    await isListening(PORT);

    server = http
      .createServer((req, res) => {
        // Frameworks are funny. If we run this test suite with PHP we can access our Metrics
        // request payload via a `request` event immediately on the HTTP server however if we run
        // this same suite with Python, the `request` event sometimes gets emitted **after** we've
        // already returned a response and closed the connection, resulting in our request payload
        // being empty and the SDK in question crapping out with a connection read error.
        //
        // This quirk doesn't make sense and this logic here is extremely yikes but hey this test
        // suite works now across all of our SDKs and is no longer flaky.
        if (process.env.HAS_HTTP_QUIRKS) {
          sdkCall.req = req;

          let body = '';
          req.on('data', chunk => {
            body += chunk;
          });

          req.on('end', () => {
            sdkCall.body = JSON.parse(body);
            res.writeHead(200);
            res.end();
          });
        }
      })
      .listen(8001, '0.0.0.0');

    server.on('connection', socket => {
      sockets.add(socket);
    });

    return once(server, 'listening');
  });

  after(function () {
    // The mock server will sometimes hang after we're done when we're trying to close it down,
    // this will forcefull kill everything and prevent our tests from crashing out from Mocha "you
    // didn't call done()" errors.
    for (const socket of sockets) {
      socket.destroy();
      sockets.delete(socket);
    }

    return new Promise((resolve, reject) => {
      server.close(err => {
        if (err) return reject(err);
        return resolve();
      });
    });
  });

  it('should make a request to a Metrics backend with a HAR file', async function () {
    await fetch(`http://localhost:${PORT}`, { method: 'get' });

    const [req, body] = await getRequest();
    const [payload] = body;

    expect(req.url).to.equal('/v1/request');
    expect(req.headers.authorization).to.equal(`Basic ${Buffer.from(`${randomAPIKey}:`).toString('base64')}`);

    // https://uibakery.io/regex-library/uuid
    expect(payload._id).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

    expect(payload.group).to.deep.equal({
      id: 'owlbert-api-key',
      label: 'Owlbert',
      email: 'owlbert@example.com',
    });

    expect(payload.clientIPAddress).to.match(/\d{1,3}.\d{1,3}.\d{1,3}.\d{1,3}/);
    expect(payload.development).to.be.false;

    const har = payload.request;
    await expect(har).to.have.a.har.request;
    await expect(har).to.have.a.har.response;

    const { creator } = har.log;
    expect(creator.name).to.match(/readme-metrics \((dotnet|node|php|python|ruby)\)/);
    expect(creator.version).not.to.be.empty;
    expect(creator.comment).not.to.be.empty;

    const { request, response, startedDateTime } = har.log.entries[0];

    /**
     * `startedDateTime` should look like the following, with optional microseconds component:
     *
     *  JavaScript: `new Date().toISOString()`
     *    - 2022-06-30T10:21:55.394Z
     *  PHP: `date('Y-m-d\TH:i:sp')`
     *    - 2022-08-17T19:23:31Z
     *  Python: `datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")`
     *    - 2022-06-30T10:31:43Z
     */
    expect(startedDateTime).to.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:.\d{3})?Z/);

    // Some frameworks remove the trailing slash from the URL we get.
    expect(request.url).to.match(new RegExp(`http://localhost:${PORT}(/)?`));
    expect(request.method).to.equal('GET');
    expect(request.httpVersion).to.equal('HTTP/1.1');

    expect(request.headers).to.have.header('connection', [
      'close',
      'keep-alive', // Running this suite with Node 18 the `connection` header is different.
    ]);
    expect(request.headers).to.have.header('host', [
      `localhost:${PORT}`,
      'localhost', // rails does not include the port
    ]);

    expect(response.status).to.equal(200);
    expect(response.statusText).to.match(/OK|200/); // Django returns with "200"
    expect(response.headers).to.have.header('content-type', /application\/json(;\s?charset=utf-8)?/);

    // Flask prints a \n character after the JSON response
    // https://github.com/pallets/flask/issues/4635
    expect(response.content.text.replace('\n', '')).to.equal(JSON.stringify({ message: 'hello world' }));
    expect(response.content.size).to.equal(response.content.text.length);
    expect(response.content.mimeType).to.match(/application\/json(;\s?charset=utf-8)?/);
  });

  it('should capture query strings in a GET request', async function () {
    await fetch(`http://localhost:${PORT}?arr%5B1%5D=3&val=1`, { method: 'get' });

    const [, body] = await getRequest();
    const [payload] = body;

    const har = payload.request;
    await expect(har).to.have.a.har.request;
    await expect(har).to.have.a.har.response;

    const { request } = har.log.entries[0];

    // Some frameworks remove the trailing slash from the URL we get.
    expect(request.url).to.match(new RegExp(`http://localhost:${PORT}(/)?\\?arr%5B1%5D=3&val=1`));

    // Some frameworks handle query string arrays slightly differently.
    expect(JSON.stringify(request.queryString)).to.be.oneOf([
      JSON.stringify([
        { name: 'arr[1]', value: '3' },
        { name: 'val', value: '1' },
      ]),
      JSON.stringify([
        { name: 'arr', value: '{"1":"3"}' },
        { name: 'val', value: '1' },
      ]),
      JSON.stringify([
        { name: 'arr', value: { 1: '3' } },
        { name: 'val', value: '1' },
      ]), // Rails
    ]);

    expect(request.postData).to.be.undefined;
  });

  it('should capture query strings that may be supplied in a POST request', async function () {
    const content = JSON.stringify({ user: { email: 'dom@readme.io' } });
    await fetch(`http://localhost:${PORT}/?arr%5B1%5D=3&val=1`, {
      method: 'post',
      headers: {
        'content-type': 'application/json',
      },
      body: content,
    });

    const [, body] = await getRequest();
    const [payload] = body;

    const har = payload.request;
    await expect(har).to.be.have.a.har.request;
    await expect(har).to.have.a.har.response;

    const { request, response } = har.log.entries[0];

    expect(request.method).to.equal('POST');

    // Some frameworks remove the trailing slash from the URL we get.
    expect(request.url).to.match(new RegExp(`http://localhost:${PORT}(/)?\\?arr%5B1%5D=3&val=1`));

    expect(request.headers).to.have.header('content-type', 'application/json');

    // Some frameworks handle query string arrays slightly differently.
    expect(JSON.stringify(request.queryString)).to.be.oneOf([
      JSON.stringify([
        { name: 'arr[1]', value: '3' },
        { name: 'val', value: '1' },
      ]),
      JSON.stringify([
        { name: 'arr', value: '{"1":"3"}' },
        { name: 'val', value: '1' },
      ]),
      JSON.stringify([
        { name: 'arr', value: { 1: '3' } },
        { name: 'val', value: '1' },
      ]), // Rails
    ]);

    expect(request.postData).to.deep.equal({
      mimeType: 'application/json',
      text: content,
    });

    expect(response.status).to.equal(200);
  });

  it('should process a POST payload with no explicit `Content-Type` header', async function () {
    const content = JSON.stringify({ user: { email: 'dom@readme.io' } });
    await fetch(`http://localhost:${PORT}/`, {
      method: 'post',
      body: content,
    });

    const [, body] = await getRequest();
    const [payload] = body;

    const har = payload.request;
    await expect(har).to.have.a.har.request;
    await expect(har).to.have.a.har.response;

    const { request } = har.log.entries[0];

    expect(request.method).to.equal('POST');
    expect(request.headers).to.have.header('content-type', 'text/plain;charset=UTF-8');

    expect(request.postData.mimeType).to.match(/text\/plain(;charset=UTF-8)?/);
    expect(request.postData.params).to.be.undefined;
    expect(request.postData.text).to.equal(content);
  });

  it('should process an `application/json` POST payload', async function () {
    const content = JSON.stringify({ user: { email: 'dom@readme.io' } });
    await fetch(`http://localhost:${PORT}/`, {
      method: 'post',
      headers: {
        'content-type': 'application/json',
      },
      body: content,
    });

    const [, body] = await getRequest();
    const [payload] = body;

    const har = payload.request;
    await expect(har).to.have.a.har.request;
    await expect(har).to.have.a.har.response;

    const { request, response } = har.log.entries[0];

    expect(request.method).to.equal('POST');
    expect(request.headers).to.have.header('content-type', 'application/json');
    expect(request.postData).to.deep.equal({
      mimeType: 'application/json',
      text: content,
    });

    expect(response.status).to.equal(200);
  });

  /**
   * We should eventually support returning the raw POST payload to Metrics in this case but Express
   * has a fun quirk where if you declare the `express.json()` middleware on a route to identify
   * that that route accepts a JSON payload, if that JSON payload is corrupted then it completely
   * wipes out `req.body` and replaces it with an empty JSON object -- eliminating all access for
   * us to the what the original payload was.
   */
  // eslint-disable-next-line mocha/no-pending-tests, mocha/no-skipped-tests
  it.skip('should process an `application/JSON POST payload containing unparseable JSON');

  it('should process a vendored `+json` POST payload', async function () {
    const content = JSON.stringify({ user: { email: 'dom@readme.io' } });
    await fetch(`http://localhost:${PORT}/`, {
      method: 'post',
      headers: {
        'content-type': 'application/vnd.api+json',
      },
      body: content,
    });

    const [, body] = await getRequest();
    const [payload] = body;

    const har = payload.request;
    await expect(har).to.have.a.har.request;
    await expect(har).to.have.a.har.response;

    const { request, response } = har.log.entries[0];

    expect(request.method).to.equal('POST');
    expect(request.headers).to.have.header('content-type', 'application/vnd.api+json');
    expect(request.postData).to.deep.equal({
      mimeType: 'application/vnd.api+json',
      text: content,
    });

    expect(response.status).to.be.oneOf([
      200,
      // Fastify doesn't support vendored JSON content types out of the box and will return a
      // `FST_ERR_CTP_INVALID_MEDIA_TYPE` error but thankfully we're still able to capture and
      // process the payload into Metrics.
      415,
    ]);
  });

  it('should process an `application/x-www-url-formencoded` POST payload', async function () {
    const params = new URLSearchParams();
    params.append('email', 'dom@readme.io');

    await fetch(`http://localhost:${PORT}/`, {
      method: 'post',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });

    const [, body] = await getRequest();
    const [payload] = body;

    const har = payload.request;
    await expect(har).to.have.a.har.request;
    await expect(har).to.have.a.har.response;

    const { request, response } = har.log.entries[0];

    expect(request.method).to.equal('POST');
    expect(request.headers).to.have.header('content-type', 'application/x-www-form-urlencoded');
    expect(request.postData).to.deep.equal({
      mimeType: 'application/x-www-form-urlencoded',
      params: [{ name: 'email', value: 'dom@readme.io' }],
    });

    expect(response.status).to.be.oneOf([
      200,
      // Fastify, without the `@fastify/formbody` package out of the box doesn't support
      // `x-www-form-urlencoded` and will return a `FST_ERR_CTP_INVALID_MEDIA_TYPE` error.
      // Thankfully our middleware is still able to capture the payload from the request and send
      // that to Metrics regardless if Fastify supports it or not.
      415,
    ]);
  });

  it('should process a `multipart/form-data` POST payload', async function () {
    if (!supportsMultipart()) {
      this.skip();
    }

    const formData = new FormData();
    formData.append('password', 123456);
    formData.append('apiKey', 'abcdef');
    formData.append('another', 'Hello world');
    formData.append('buster', [1234, 5678]);

    const encoder = new FormDataEncoder(formData);

    await fetch(`http://localhost:${PORT}/`, {
      method: 'post',
      headers: encoder.headers,
      body: Readable.from(encoder),
    });

    const [, body] = await getRequest();
    const [payload] = body;

    const har = payload.request;
    await expect(har).to.have.a.har.request;
    await expect(har).to.have.a.har.response;

    const { request } = har.log.entries[0];

    expect(request.method).to.equal('POST');
    expect(request.headers).to.have.header('content-type', /multipart\/form-data; boundary=(.*)/);
    expect(request.postData.mimeType).to.match(/multipart\/form-data; boundary=(.*)/);
    expect(request.postData.params).to.deep.equal([
      { name: 'password', value: '123456' },
      { name: 'apiKey', value: 'abcdef' },
      { name: 'another', value: 'Hello world' },
      { name: 'buster', value: '1234,5678' },
    ]);

    expect(request.postData.text).to.be.undefined;
  });

  it('should process a `multipart/form-data` POST payload containing files', async function () {
    if (!supportsMultipart()) {
      this.skip();
    }
    const owlbert = await fs.readFile('./test/__datasets__/owlbert.png');

    const formData = new FormData();
    formData.append('password', 123456);
    formData.append('apiKey', 'abcdef');
    formData.append('another', 'Hello world');
    formData.append('buster', [1234, 5678]);
    formData.append('owlbert.png', new File([owlbert], 'owlbert.png', { type: 'image/png' }), 'owlbert.png');

    const encoder = new FormDataEncoder(formData);

    await fetch(`http://localhost:${PORT}/`, {
      method: 'post',
      headers: encoder.headers,
      body: Readable.from(encoder),
    });

    const [, body] = await getRequest();
    const [payload] = body;

    const har = payload.request;
    await expect(har).to.have.a.har.request;
    await expect(har).to.have.a.har.response;

    const { request } = har.log.entries[0];

    expect(request.method).to.equal('POST');
    expect(request.headers).to.have.header('content-type', /multipart\/form-data; boundary=(.*)/);
    expect(request.headers).to.have.header('content-length', 982);
    expect(request.postData.mimeType).to.match(/multipart\/form-data; boundary=(.*)/);

    const owlbertDataURL = await fs.readFile('./test/__datasets__/owlbert.dataurl.json').then(JSON.parse);
    expect(request.postData.params).to.deep.equal([
      { name: 'password', value: '123456' },
      { name: 'apiKey', value: 'abcdef' },
      { name: 'another', value: 'Hello world' },
      { name: 'buster', value: '1234,5678' },
      {
        name: 'owlbert_png',
        value: owlbertDataURL,
        fileName: 'owlbert.png',
        contentType: 'image/png',
      },
    ]);

    expect(request.postData.text).to.be.undefined;
  });

  it('should process a `text/plain` payload', async function () {
    await fetch(`http://localhost:${PORT}/`, {
      method: 'post',
      headers: {
        'content-type': 'text/plain',
      },
      body: 'Hello world',
    });

    const [, body] = await getRequest();
    const [payload] = body;

    const har = payload.request;
    await expect(har).to.have.a.har.request;
    await expect(har).to.have.a.har.response;

    const { request, response } = har.log.entries[0];

    expect(request.method).to.equal('POST');
    expect(request.headers).to.have.header('content-type', 'text/plain');
    expect(request.postData).to.deep.equal({
      mimeType: 'text/plain',
      text: 'Hello world',
    });

    expect(response.status).to.equal(200);
  });
});
