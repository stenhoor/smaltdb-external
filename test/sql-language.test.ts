// The tests run SQL from smaltql (test/setup-sql.ts), not SQL smaltdb may still carry.
import { describe, expect, it, vi } from 'vitest';
import { Database } from 'smaltdb/engine';
import { sqlLanguage } from 'smaltql';

describe('SQL', () => {
  it('comes from smaltql', () => {
    const parse = vi.spyOn(sqlLanguage, 'parseOne');
    expect(Database.openMemory().query('SELECT 1 + 1').rows).toEqual([[2]]);
    expect(parse).toHaveBeenCalledWith('SELECT 1 + 1');
  });
});
