// Ask the Agentic OS GPU guard whether a game is running. The guard only kills
// inference servers, so a benchmark has to check for itself.
const { execFileSync } = require('child_process');
const path = require('path');

const UV = path.join(process.env.LOCALAPPDATA || '', 'hermes', 'bin', 'uv.exe');
const PROJECT = 'C:/Users/Aayan/Documents/Agenitc OS';

module.exports = function gameRunning() {
  try {
    const out = execFileSync(UV,
      ['--directory', PROJECT, 'run', 'python', '-m', 'core.gpuguard', '--status'],
      { encoding: 'utf8', timeout: 30000 });
    const line = out.split('\n').find(l => l.startsWith('games:')) || '';
    return /none/.test(line) ? null : line.replace('games:', '').trim();
  } catch (e) {
    return null;      // guard unavailable: do not block the run on it
  }
};
