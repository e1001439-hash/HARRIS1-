import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadConfig } from './config.js';
import { PgDatabase, migrate } from './db.js';
import { HttpLineClient } from './clients/line.js';
import { OpenAiClient } from './clients/ai.js';
import { loadFacts, type SalonFacts } from './knowledge.js';
import { startRuntime } from './runtime.js';
import { startupDiagnostic, type StartupDiagnostic, type StartupStage } from './diagnostics.js';
import type { AiClient, Config, Database, LineClient } from './types.js';

interface RuntimeHandle { close(): Promise<void> }
export interface StartupDependencies {
  loadEnvironment(): Promise<void>;
  config(): Config;
  readKnowledge(path: string): Promise<string>;
  readFacts(path: string): Promise<SalonFacts>;
  database(url: string): Database;
  migrate(db: Database): Promise<void>;
  clients(config: Config): { ai: AiClient; line: LineClient };
  runtime(options: Parameters<typeof startRuntime>[0]): Promise<RuntimeHandle>;
}
const defaults: StartupDependencies = {
  async loadEnvironment() { await import('./env.js'); }, config: loadConfig,
  readKnowledge: path => readFile(path, 'utf8'), readFacts: loadFacts,
  database: url => new PgDatabase(url), migrate,
  clients: config => ({
    ai: config.responseMode === 'ai' ? new OpenAiClient(config.aiKey!, config.aiModel!) : { async generate(): Promise<never> { throw new Error('AI mode disabled'); } },
    line: new HttpLineClient(config.lineToken),
  }),
  runtime: startRuntime,
};
type StartupResult = { ok: true; config: Config; runtime: RuntimeHandle } | { ok: false; diagnostic: StartupDiagnostic };

/** Initialization order is unchanged; only allowlisted failure metadata escapes. */
export async function initializeService(dependencies: Partial<StartupDependencies> = {}): Promise<StartupResult> {
  const deps = { ...defaults, ...dependencies };
  let stage: StartupStage = 'environment';
  let db: Database | undefined;
  try {
    await deps.loadEnvironment();
    stage = 'configuration'; const config = deps.config();
    stage = 'knowledge'; const knowledge = await deps.readKnowledge(config.knowledgePath);
    stage = 'facts'; const facts = await deps.readFacts(join(dirname(config.knowledgePath), 'facts.json'));
    stage = 'database_configuration'; db = deps.database(config.databaseUrl);
    stage = 'database_migration'; await deps.migrate(db);
    stage = 'clients'; const clients = deps.clients(config);
    stage = 'runtime'; const runtime = await deps.runtime({ db, config, ...clients, knowledge, facts });
    return { ok: true, config, runtime };
  } catch (error) {
    const diagnostic = startupDiagnostic(stage, error);
    try { await db?.close(); } catch { /* Cleanup must not replace the original stage or expose its error. */ }
    return { ok: false, diagnostic };
  }
}
