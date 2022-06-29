import { User } from '@superblocksteam/shared';
export {};

declare global {
  namespace Express {
    interface Request {
      user?: User;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      oidc: any;
    }

    interface Response {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      oidc: any;
    }
  }
}
