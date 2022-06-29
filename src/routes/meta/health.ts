import express from 'express';
import { getHealth } from '../../utils/health';

const router = express.Router();

router.get('/', getHealth);
router.get('/agent', getHealth);
router.get('/health', getHealth);
router.get('/agent/health', getHealth);

export default router;
