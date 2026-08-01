import { defineConfig } from 'rolldown';

export default defineConfig({
  input: {
    'core.test': './test/core.test.ts',
    'discovery.test': './test/discovery.test.ts',
    'storage.test': './test/storage.test.ts'
  },
  external: [/^node:/],
  output: {
    dir: 'dist/test',
    format: 'cjs',
    entryFileNames: '[name].js'
  }
});
