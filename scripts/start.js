const path = require('path');
const { spawn } = require('child_process');
const { getElectronPath, assertElectronBinaryCompatible } = require('./electronBinary');

function main() {
  let electronPath;
  try {
    electronPath = getElectronPath();
    assertElectronBinaryCompatible(electronPath);
  } catch (err) {
    console.error(String(err && err.message ? err.message : err));
    process.exit(1);
  }

  const args = process.argv.slice(2);
  if (args.length === 0) {
    args.push(path.join(__dirname, '..', 'main.js'));
  }

  const child = spawn(electronPath, args, { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code == null ? 0 : code));
  child.on('error', (err) => {
    console.error(err);
    process.exit(1);
  });
}

main();

