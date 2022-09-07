import { NextFunction, Request, Response, RequestHandler } from 'express';
import { Registry, Summary } from 'prom-client';
import UrlValueParser from 'url-value-parser';

export const metrics = (registry: Registry): RequestHandler => {
  const duration = new Summary({
    name: 'superblocks_controller_http_request_duration_milliseconds',
    help: 'Duration of an HTTP request.',
    percentiles: [0.5, 0.9, 0.95, 0.99, 1],
    labelNames: ['org_id', 'path', 'method', 'status'],
    registers: [registry]
  });

  const parser = new UrlValueParser();

  return async (req: Request, res: Response, next: NextFunction) => {
    const start: number = Date.now();

    res.on('finish', function () {
      duration.observe(
        {
          method: req.method,
          path: parser.replacePathValues(`${req.baseUrl}${req.path}`, '#val'),
          org_id: res.locals.org_id,
          status: res.statusCode.toString()
        },
        Date.now() - start
      );
    });
    next();
  };
};
