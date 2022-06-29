import cookieParser from 'cookie-parser';
import express from 'express';
import { verifyAuth, verifyFile } from '../../middleware/auth';
import apiRouter from './api';
import authRouter from './auth';
import datasourceRouter from './datasource';
import fileRouter from './file';
import workflowRouter from './workflow';

const router = express.Router();
router.use(cookieParser());

router.use('/apis', apiRouter);
router.use('/auth', authRouter);
router.use('/datasources', verifyAuth(), datasourceRouter);
router.use('/workflows', verifyAuth(true), workflowRouter);
router.use('/files', verifyFile(), fileRouter);

export default router;
