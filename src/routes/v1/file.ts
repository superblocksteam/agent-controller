import express, { NextFunction, Request, Response } from 'express';
import logger from '../../utils/logger';

const router = express.Router();

router.get('/', (req: Request, res: Response, next: NextFunction) => {
  const location: string = req.query.location.toString();
  logger.info({ location }, 'request for file received');

  res.download(
    location,
    null,
    {
      dotfiles: 'allow'
    },
    (err) => {
      return next(err);
    }
  );
});

export default router;
