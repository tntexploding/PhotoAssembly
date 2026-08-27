import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['--test', 'test/external-skills.live.test.js'], {
  stdio: 'inherit',
  env: { ...process.env, RUN_EXTERNAL_SKILL_TESTS: '1' }
});

if (result.error) {
  console.error(result.error.message);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
