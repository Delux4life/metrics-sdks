import type { OutgoingLogBody } from './metrics-log';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'tls';

import os from 'os';
import { URL } from 'url';

import { v4 as uuidv4 } from 'uuid';

import { version } from '../../package.json';

import processRequest from './process-request';
import processResponse from './process-response';

/**
 * Extracts the protocol string from the incoming request
 *
 * @param req
 * @returns
 */
export function getProto(req: IncomingMessage): 'https' | 'http' {
  return (req.socket as TLSSocket).encrypted ? 'https' : 'http';
}

export interface LogOptions {
  /**
   * An array of values to redact from the incoming and outgoing headers, parameters and body
   */
  denylist?: string[];

  /**
   * @deprecated use denylist instead
   */
  blacklist?: string[];

  /**
   * An array of values to include in the incoming and outgoing headers, parameters and body.
   *  Everything else will be redacted.
   *
   * If set, the denylist will be ignored.
   */
  allowlist?: string[];

  /**
   * @deprecated use allowList instead
   */
  whitelist?: string[];

  /**
   * If true, the logs will be marked as development logs
   */
  development?: boolean;

  /**
   * If true, this will return the log details without waiting for a response from the metrics servers
   */
  fireAndForget?: boolean;
}

export interface PayloadData {
  /**
   * API Key used to make the request. Note that this is different from the `readmeAPIKey` described above and should be a value from your API that is unique to each of your users.
   */
  apiKey: string;
  /**
   * This will be the user's display name in the API Metrics Dashboard, since it's much easier to remember a name than an API key.
   */
  label?: string;
  /**
   * Email of the user that is making the call
   */
  email?: string;
  /**
   * A JavaScript `Date` object representing the time the server received the incoming request. This should be logged before retrieving and parsing the incoming request body.
   */
  startedDateTime: Date;
  /**
   * A JavaScript `Date` object representing the time the server finished sending the outgoing response.
   */
  responseEndDateTime: Date;
  /**
   * A UUIDv4 identifier. If not provided this will be automatically generated for you. You can use this ID in conjunction with your `base_url` to create the URL that points to this log. i.e. `{base_url}/logs/{logId}`.
   */
  logId?: string;
  /**
   * If provided this path will be used instead of the request path. This is useful for grouping common routes together as `/users/{user_id}` instead of each page being unique as `/users/1`, `/users/2`, etc.
   */
  routePath?: string;
  /**
   * Object or string | The incoming request body. You should provide this function a parsed object, but a string is acceptable if necessary.
   */
  requestBody?: Record<string, unknown> | string;
  /**
   * The outgoing request body as a string.
   */
  responseBody?: string;
}

export function constructPayload(
  req: IncomingMessage,
  res: ServerResponse,
  payloadData: PayloadData,
  logOptions: LogOptions
): OutgoingLogBody {
  const serverTime = payloadData.responseEndDateTime.getTime() - payloadData.startedDateTime.getTime();

  return {
    _id: payloadData.logId || uuidv4(),
    group: {
      id: payloadData.apiKey,
      label: payloadData.label,
      email: payloadData.email,
    },
    clientIPAddress: req.socket.remoteAddress,
    development: !!logOptions?.development,
    request: {
      log: {
        version: '1.2',
        creator: {
          name: 'readme-metrics (node)',
          version,
          // x64-darwin21.3.0/14.19.3
          comment: `${os.arch()}-${os.platform()}${os.release()}/${process.versions.node}`,
        },
        entries: [
          {
            pageref: payloadData.routePath
              ? payloadData.routePath
              : new URL(req.url, `${getProto(req)}://${req.headers.host}`).toString(),
            startedDateTime: payloadData.startedDateTime.toISOString(),
            time: serverTime,
            request: processRequest(req, payloadData.requestBody, logOptions),
            response: processResponse(res, payloadData.responseBody, logOptions),
            cache: {},
            timings: {
              // This requires us to know the time the request was sent to the server, so we're skipping it for now
              wait: 0,
              receive: serverTime,
            },
          },
        ],
      },
    },
  };
}
