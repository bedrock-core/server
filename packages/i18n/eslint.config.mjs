import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'eslint/config';
import baseConfig from '../../eslint.config.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig([
	...baseConfig,
	{
		// Test bodies reach past the public API — casts onto the package's internal
		// shapes to assert on them — which the type-aware rules, no-unsafe-type-assertion
		// above all, read as errors.
		ignores: ['**/__tests__/**'],
	},
	{
		files: ['**/*.ts', '**/*.tsx'],
		languageOptions: {
			parserOptions: {
				tsconfigRootDir: __dirname,
			},
		},
	},
]);
