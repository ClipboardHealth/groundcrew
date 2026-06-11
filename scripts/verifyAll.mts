import { DEFAULT_VERIFY_CHECKS, runVerify, runVerifyCheck } from "./verifyRunner.ts";

async function main(): Promise<void> {
  const result = await runVerify({
    checks: DEFAULT_VERIFY_CHECKS,
    now: () => performance.now(),
    print,
    runCheck: runVerifyCheck,
  });

  if (!result.ok) {
    process.exitCode = 1;
  }
}

function print(message: string): void {
  process.stdout.write(`${message}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
