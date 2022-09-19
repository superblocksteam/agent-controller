import { OBS_TAG_ORG_ID, OBS_TAG_HTTP_METHOD, OBS_TAG_HTTP_ROUTE, OBS_TAG_HTTP_STATUS_CODE, toMetricLabels } from '@superblocksteam/shared';
import { NextFunction, Request, Response, RequestHandler } from 'express';
import { Registry, Summary } from 'prom-client';
import UrlValueParser from 'url-value-parser';

export const metrics = (registry: Registry): RequestHandler => {
  const duration = new Summary({
    name: 'superblocks_controller_http_request_duration_milliseconds',
    help: 'Duration of an HTTP request.',
    percentiles: [0.5, 0.9, 0.95, 0.99, 1],
    labelNames: toMetricLabels([
      OBS_TAG_ORG_ID,
      OBS_TAG_HTTP_METHOD,
      OBS_TAG_HTTP_ROUTE,
      OBS_TAG_HTTP_STATUS_CODE,

      // TODO(frank): deprecate after dashboards are updated with the above
      'org_id',
      'path',
      'method',
      'status'
    ]) as string[],
    registers: [registry]
  });

  const parser = new UrlValueParser();

  return async (req: Request, res: Response, next: NextFunction) => {
    const start: number = Date.now();

    res.on('close', function () {
      duration.observe(
        toMetricLabels({
          [OBS_TAG_ORG_ID]: res.locals.org_id,
          [OBS_TAG_HTTP_METHOD]: req.method,
          [OBS_TAG_HTTP_ROUTE]: req.route?.path ? `${req.baseUrl}${req.route.path}` : parser.replacePathValues(req.originalUrl, '#val'),
          [OBS_TAG_HTTP_STATUS_CODE]: res.statusCode.toString(),

          // TODO(frank): deprecate after dashboards are updated with the above
          method: req.method,
          path: req.route?.path ? `${req.baseUrl}${req.route.path}` : parser.replacePathValues(req.originalUrl, '#val'),
          status: res.statusCode.toString(),
          org_id: res.locals.org_id
        }) as Record<string, string | number>,
        Date.now() - start
      );
    });
    next();
  };
};
