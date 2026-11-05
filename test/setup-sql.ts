// The tests' databases read SQL from smaltql (smaltdb ADR 0015: SQL is its own package). smaltdb's engine entry may
// still register the SQL it carries: register smaltql's after each test file's imports, so smaltql's is the one used.
import { beforeAll } from 'vitest';
import { registerLanguage } from 'smaltdb/language';
import { sqlLanguage } from 'smaltql';

beforeAll(() => registerLanguage(sqlLanguage));
