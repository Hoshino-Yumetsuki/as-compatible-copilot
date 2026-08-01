import { defineConfig } from 'rolldown';

export default defineConfig({
  input: './src/extension.ts',
  external: ['vscode', /^node:/],
  output: {
    file: 'dist/extension.cjs',
    format: 'cjs',
    codeSplitting: false
  }
});
