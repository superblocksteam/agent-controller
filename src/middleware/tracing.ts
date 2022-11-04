import { SpanKind, Span } from '@opentelemetry/api';
import {
  OBS_TAG_HTTP_URL,
  OBS_TAG_NET_PEER_IP,
  OBS_TAG_ORG_ID,
  OBS_TAG_ORG_NAME,
  OBS_TAG_HTTP_METHOD,
  OBS_TAG_HTTP_ROUTE,
  OBS_TAG_HTTP_STATUS_CODE,
  OBS_TAG_HTTP_REQUEST_CONTENT_LENGTH,
  OBS_TAG_HTTP_USER_AGENT,
  OBS_TAG_HTTP_SCHEME,
  OBS_TAG_HTTP_FLAVOR
} from '@superblocksteam/shared';
import { NextFunction, Request, Response, RequestHandler } from 'express';
import UrlValueParser from 'url-value-parser';
import { getTracer } from '../utils/tracer';

export const tracing = (): RequestHandler => {
  const parser = new UrlValueParser();

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    return getTracer().startActiveSpan(
      `${req.method} ${parser.replacePathValues(`${req.path}`, '#val')}`,
      {
        attributes: {
          [OBS_TAG_HTTP_SCHEME]: req.protocol,
          [OBS_TAG_HTTP_USER_AGENT]: req.headers['user-agent'],
          [OBS_TAG_HTTP_REQUEST_CONTENT_LENGTH]: req.headers['content-length'],
          [OBS_TAG_HTTP_METHOD]: req.method,
          [OBS_TAG_HTTP_FLAVOR]: req.httpVersion,
          [OBS_TAG_HTTP_URL]: req.originalUrl,
          [OBS_TAG_NET_PEER_IP]: req.socket.remoteAddress
          // TODO(frank): add more stuff; the more the better
          //              https://bit.ly/3KQMxqa
        },
        kind: SpanKind.SERVER
      },
      (span: Span): void => {
        next();

        res.on('close', function () {
          span.setAttributes({
            [OBS_TAG_HTTP_STATUS_CODE]: res.statusCode,
            [OBS_TAG_ORG_ID]: res.locals?.org_id,
            [OBS_TAG_ORG_NAME]: res.locals?.org_name
          });

          if (req.route?.path) {
            span.setAttribute(OBS_TAG_HTTP_ROUTE, `${req.baseUrl}${req.route.path}`);
            span.updateName(`${req.method} ${req.baseUrl}${req.route.path}`);
          }

          span.end();
        });
      }
    );
  };
};
