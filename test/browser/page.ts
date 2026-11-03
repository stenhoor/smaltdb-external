// Runs on the page: request signing on this browser's WebCrypto (moved here from smaltdb's browser test).
// Reports { ok, checks } on window.__result.
import { signV4 } from '../../src/sign.js';

type Check = { name: string; ok: boolean; detail?: string };

async function run(): Promise<Check[]> {
  const checks: Check[] = [];
  // AWS's published SigV4 test vector (GET Object with a Range header).
  const v4 = await signV4({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: { Range: 'bytes=0-9' } }, { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' }, 'us-east-1', 's3', new Date('2013-05-24T00:00:00Z'));
  checks.push({ name: 'S3 request signing (SigV4 test vector) with WebCrypto', ok: v4.authorization.endsWith('Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'), detail: v4.authorization });
  return checks;
}

run().then(
  (checks) => ((window as unknown as { __result: unknown }).__result = { ok: true, checks }),
  (e: Error) => ((window as unknown as { __result: unknown }).__result = { ok: false, error: e.stack ?? e.message }),
);
