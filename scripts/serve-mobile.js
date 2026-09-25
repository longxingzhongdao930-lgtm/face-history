#!/usr/bin/env node
// 組み立てたスマホ版を手元で確認する（npm run mobile）
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 3001);
const app = express();
app.use(express.static(path.join(ROOT, 'dist', 'mobile')));
app.listen(PORT, '127.0.0.1', () => console.log(`スマホ版: http://127.0.0.1:${PORT}/`));
