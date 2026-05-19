#!/usr/bin/env bun
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const PKG_PATH = path.join(__dirname, 'package.json');
const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf-8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

function bumpVersion(bump) {
  const updated = { ...pkg };
  if (bump === 'patch') updated.version = `${major}.${minor}.${patch + 1}`;
  else if (bump === 'minor') updated.version = `${major}.${minor + 1}.0`;
  else if (bump === 'major') updated.version = `${major + 1}.0.0`;
  fs.writeFileSync(PKG_PATH, JSON.stringify(updated, null, 2) + '\n');
  return updated.version;
}

async function main() {
  console.log(`\nCurrent version: ${pkg.version}\n`);
  console.log('  1) patch  -> ' + `${major}.${minor}.${patch + 1}`);
  console.log('  2) minor  -> ' + `${major}.${minor + 1}.0`);
  console.log('  3) major  -> ' + `${major + 1}.0.0`);
  console.log('');

  const choice = await ask('Bump version (1/2/3): ');

  let bump;
  switch (choice.trim()) {
    case '1': bump = 'patch'; break;
    case '2': bump = 'minor'; break;
    case '3': bump = 'major'; break;
    default:
      console.log('Invalid choice. Exiting.');
      rl.close();
      process.exit(1);
  }

  const newVersion = bumpVersion(bump);
  console.log(`\nVersion bumped to ${newVersion}`);

  const confirm = await ask(`Publish ${pkg.name}@${newVersion} to npm? (y/n): `);
  if (confirm.trim().toLowerCase() !== 'y') {
    console.log('Aborted.');
    rl.close();
    process.exit(0);
  }

  // Build and publish
  console.log('\nBuilding...');
  execSync('bun run build', { stdio: 'inherit' });

  console.log('\nPublishing...');
  execSync('bun publish --access public', { stdio: 'inherit' });

  console.log(`\nPublished ${pkg.name}@${newVersion}`);
  rl.close();
}

main().catch((err) => {
  console.error(err);
  rl.close();
  process.exit(1);
});
