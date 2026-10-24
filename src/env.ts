import { existsSync } from 'node:fs';
// Existing platform variables take precedence; .env is local and ignored by Git.
if (existsSync('.env')) process.loadEnvFile('.env');
