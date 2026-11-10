import path from 'node:path';
import { defineConfig } from 'vitest/config';
import {createViewerConfig} from './vite.config';

export default defineConfig({
  root: path.resolve(__dirname, '..'),
  resolve: createViewerConfig().resolve,
  test: {
    environment: 'node',
    include: ['viewer/tests/**/*.test.ts']
  }
});
