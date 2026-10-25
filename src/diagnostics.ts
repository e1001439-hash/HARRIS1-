import { ZodError } from 'zod';

const stages = ['environment', 'configuration', 'knowledge', 'facts', 'database_configuration', 'database_migration', 'clients', 'runtime', 'unknown'] as const;
export type StartupStage = typeof stages[number];
export const configFields = ['PORT', 'DATABASE_URL', 'LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN', 'OWNER_LINE_USER_ID', 'TEST_LINE_USER_IDS', 'BOT_MODE', 'RESPONSE_MODE', 'SALON_AI_API_KEY', 'AI_MODEL', 'KNOWLEDGE_PATH', 'BOOKING_URL', 'PUBLIC_SITE_URL'] as const;
export type ConfigField = typeof configFields[number];
const databaseCodes = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION', '28P01', '28000', '3D000', '42501', '42P01', '42703', '42601', '23505', '53300', '57P01', '57P03'] as const;
const fileCodes = ['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR'] as const;
const codes = ['UNKNOWN', 'CONFIG_MISSING', 'CONFIG_INVALID', 'DB_URL_INVALID', 'DB_TLS_POLICY_INVALID', 'FACTS_JSON_INVALID', 'FACTS_SCHEMA_INVALID', 'EADDRINUSE', ...databaseCodes, ...fileCodes] as const;
type DiagnosticCode = typeof codes[number];
interface SafeDetails { code: DiagnosticCode; fields: ConfigField[] }
const details = new WeakMap<object, SafeDetails>();
const allowedCode = (value: unknown): DiagnosticCode => typeof value === 'string' && (codes as readonly string[]).includes(value) ? value as DiagnosticCode : 'UNKNOWN';
const allowedFields = (values: readonly unknown[]): ConfigField[] => [...new Set(values.filter((value): value is ConfigField => typeof value === 'string' && (configFields as readonly string[]).includes(value)))];

/** Carries only freshly constructed allowlisted metadata, never the source error. */
export class SafeDiagnosticError extends Error {
  constructor(code: DiagnosticCode, fields: readonly ConfigField[] = []) {
    const safe = { code: allowedCode(code), fields: allowedFields(fields) };
    super(`安全啟動診斷 ${safe.code}${safe.fields.length ? `: ${safe.fields.join(', ')}` : ''}`);
    details.set(this, safe);
  }
}

function ownCode(error: unknown): unknown {
  if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return undefined;
  try {
    // Do not evaluate getters, traverse causes, or invoke provider serialization.
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch { return undefined; }
}
function safeDetails(error: unknown): SafeDetails | undefined {
  return typeof error === 'object' && error !== null ? details.get(error) : undefined;
}

/** Called before pg wrappers discard driver errors; the raw error is not retained. */
export function safeDatabaseFailure(error: unknown): SafeDiagnosticError {
  const prior = safeDetails(error);
  if (prior) return new SafeDiagnosticError(allowedCode(prior.code), allowedFields(prior.fields));
  const code = ownCode(error);
  return new SafeDiagnosticError(typeof code === 'string' && (databaseCodes as readonly string[]).includes(code) ? code as DiagnosticCode : 'UNKNOWN');
}

export interface StartupDiagnostic { event: 'startup_failed'; stage: StartupStage; code: DiagnosticCode; fields?: ConfigField[] }
export function startupDiagnostic(stage: StartupStage, error: unknown): StartupDiagnostic {
  const safeStage: StartupStage = (stages as readonly string[]).includes(stage) ? stage : 'unknown';
  const prior = safeDetails(error);
  let code: DiagnosticCode = prior ? allowedCode(prior.code) : 'UNKNOWN';
  const fields = prior ? allowedFields(prior.fields) : [];
  if (!prior) {
    const rawCode = ownCode(error);
    if (['environment', 'knowledge', 'facts'].includes(safeStage) && typeof rawCode === 'string' && (fileCodes as readonly string[]).includes(rawCode)) code = rawCode as DiagnosticCode;
    if (safeStage === 'runtime' && (rawCode === 'EADDRINUSE' || rawCode === 'EACCES')) code = rawCode;
    if (safeStage === 'facts') {
      try {
        if (error instanceof SyntaxError) code = 'FACTS_JSON_INVALID';
        else if (error instanceof ZodError) code = 'FACTS_SCHEMA_INVALID';
      } catch { code = 'UNKNOWN'; }
    }
  }
  return { event: 'startup_failed', stage: safeStage, code, ...(fields.length ? { fields } : {}) };
}
