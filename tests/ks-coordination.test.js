const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const cliPath = join(__dirname, '..', 'cli', 'ks.js');

function runKs(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

function projectFixture() {
  const home = mkdtempSync(join(tmpdir(), 'ks-coordination-home-'));
  const workspace = join(home, 'workspace');
  assert.equal(runKs(['init', '--home', home, '--json']).status, 0);
  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'work', '--path', workspace, '--json']).status, 0);
  const created = runKs(['project', 'create', '--home', home, '--workspace', 'work', '--name', 'alpha', '--json']);
  assert.equal(created.status, 0, created.stderr);
  const project = JSON.parse(created.stdout).project;
  return { home, projectPath: project.path, projectId: project.id };
}

function anchorArgs(projectId) {
  return ['--project-id', projectId, '--anchor-source', 'issue', '--anchor-id', 'KS-42', '--scope-key', 'cli'];
}

test('ks coordination resumes the unique active unit for the same registered project and task anchor', () => {
  const { home, projectId } = projectFixture();
  const first = runKs(['coordination', 'open', '--home', home, ...anchorArgs(projectId), '--json']);
  assert.equal(first.status, 0, first.stderr);
  const created = JSON.parse(first.stdout);
  assert.equal(created.resumed, false);

  const resumed = runKs(['coordination', 'resume', '--home', home, ...anchorArgs(projectId), '--json']);
  assert.equal(resumed.status, 0, resumed.stderr);
  const result = JSON.parse(resumed.stdout);
  assert.equal(result.found, true);
  assert.equal(result.coordination.id, created.coordination.id);
  assert.equal(result.unit.id, created.unit.id);

  const repeated = JSON.parse(runKs(['coordination', 'open', '--home', home, ...anchorArgs(projectId), '--json']).stdout);
  assert.equal(repeated.resumed, true);
  assert.equal(repeated.unit.id, created.unit.id);
});

test('ks chat-room open is role-independent and append uses operation idempotency with revision CAS', () => {
  const { home, projectId, projectPath } = projectFixture();
  const coordination = JSON.parse(runKs(['coordination', 'open', '--home', home, ...anchorArgs(projectId), '--json']).stdout);
  const roomArgs = ['--project-id', projectId, '--coordination-id', coordination.coordination.id, '--unit-id', coordination.unit.id];
  const opened = runKs(['chat-room', 'open', '--home', home, ...roomArgs, '--role', 'implementer', '--json']);
  assert.equal(opened.status, 0, opened.stderr);
  const room = JSON.parse(opened.stdout).room;
  const reopened = JSON.parse(runKs(['chat-room', 'open', '--home', home, ...roomArgs, '--role', 'verifier', '--json']).stdout);
  assert.equal(reopened.opened, false);
  assert.equal(reopened.room.id, room.id);

  const appended = runKs(['chat-room', 'append', '--home', home, ...roomArgs, '--operation-id', 'append-1', '--revision', '1', '--role', 'implementer', '--message', 'self-test complete', '--json']);
  assert.equal(appended.status, 0, appended.stderr);
  assert.equal(JSON.parse(appended.stdout).room.revision, 2);

  const replay = JSON.parse(runKs(['chat-room', 'append', '--home', home, ...roomArgs, '--operation-id', 'append-1', '--revision', '1', '--role', 'implementer', '--message', 'self-test complete', '--json']).stdout);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.room.messages.length, 1);
  assert.equal(replay.message.role, 'implementer');

  for (const changedRequest of [
    ['--role', 'verifier', '--message', 'self-test complete', '--revision', '1'],
    ['--role', 'implementer', '--message', 'changed summary', '--revision', '1'],
    ['--role', 'implementer', '--message', 'self-test complete', '--revision', '2']
  ]) {
    const conflicting = runKs(['chat-room', 'append', '--home', home, ...roomArgs, '--operation-id', 'append-1', ...changedRequest, '--json']);
    assert.equal(conflicting.status, 1);
    assert.match(conflicting.stderr, /operation_id request summary conflicts with the original request/);
  }

  const stale = runKs(['chat-room', 'append', '--home', home, ...roomArgs, '--operation-id', 'append-2', '--revision', '1', '--message', 'stale', '--json']);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /revision conflict: expected 2, received 1/);
  const projection = join(projectPath, 'ks-coordination', 'README.md');
  assert.equal(existsSync(projection), true);
  assert.match(readFileSync(projection, 'utf8'), /room\.appended/);
  assert.match(readFileSync(projection, 'utf8'), /"message":"self-test complete"/);
});

test('ks coordination rejects a direct project before writing a repository projection', () => {
  const home = mkdtempSync(join(tmpdir(), 'ks-coordination-direct-home-'));
  const workspace = join(home, 'workspace');
  const projectPath = join(workspace, 'alpha');
  mkdirSync(projectPath, { recursive: true });
  assert.equal(spawnSync('git', ['init'], { cwd: projectPath, encoding: 'utf8' }).status, 0);
  assert.equal(runKs(['init', '--home', home, '--json']).status, 0);
  assert.equal(runKs(['workspace', 'add', '--home', home, '--id', 'work', '--path', workspace, '--json']).status, 0);
  const registered = JSON.parse(runKs(['project', 'register', '--home', home, '--workspace', 'work', '--name', 'alpha', '--path', projectPath, '--json']).stdout);

  const rejected = runKs(['coordination', 'open', '--home', home, ...anchorArgs(registered.project.id), '--json']);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /coordination requires a managed development worksite.*migrate the project before using coordination/);
  assert.equal(existsSync(join(projectPath, 'ks-coordination')), false);
});

test('ks coordination retries a persisted undelivered projection exactly once on the next project operation', () => {
  const { home, projectId, projectPath } = projectFixture();
  const projectionDirectory = join(projectPath, 'ks-coordination');
  writeFileSync(projectionDirectory, 'projection blocked');

  const failed = runKs(['coordination', 'open', '--home', home, ...anchorArgs(projectId), '--json']);
  assert.equal(failed.status, 1);
  const statePath = join(home, 'state', 'coordination.json');
  let state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(state.coordinations.length, 1);
  assert.equal(state.coordinations[0].outbox[0].delivered, false);

  rmSync(projectionDirectory);
  const recovered = runKs(['coordination', 'resume', '--home', home, ...anchorArgs(projectId), '--json']);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).found, true);
  const projection = join(projectionDirectory, 'README.md');
  assert.equal((readFileSync(projection, 'utf8').match(/coordination\.opened/g) || []).length, 1);
  state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(state.coordinations[0].outbox[0].delivered, true);

  const repeated = runKs(['coordination', 'open', '--home', home, ...anchorArgs(projectId), '--json']);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal((readFileSync(projection, 'utf8').match(/coordination\.opened/g) || []).length, 1);
});

test('ks coordination does not reappend a marked projection when delivery state was not saved', () => {
  const { home, projectId, projectPath } = projectFixture();
  const opened = JSON.parse(runKs(['coordination', 'open', '--home', home, ...anchorArgs(projectId), '--json']).stdout);
  const statePath = join(home, 'state', 'coordination.json');
  const projection = join(projectPath, 'ks-coordination', 'README.md');
  let state = JSON.parse(readFileSync(statePath, 'utf8'));
  const event = state.coordinations[0].outbox[0];
  assert.match(readFileSync(projection, 'utf8'), new RegExp(`ks:coordination-event:${event.sequence}`));

  event.delivered = false;
  delete event.deliveredAt;
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const recovered = runKs(['coordination', 'resume', '--home', home, ...anchorArgs(projectId), '--json']);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal((readFileSync(projection, 'utf8').match(/coordination\.opened/g) || []).length, 1);
  state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(state.coordinations[0].outbox[0].delivered, true);
  assert.equal(JSON.parse(recovered.stdout).coordination.id, opened.coordination.id);
});

test('ks chat-room split and archive require confirmation bound to the current revision', () => {
  const { home, projectId } = projectFixture();
  const coordination = JSON.parse(runKs(['coordination', 'open', '--home', home, ...anchorArgs(projectId), '--json']).stdout);
  const roomArgs = ['--project-id', projectId, '--coordination-id', coordination.coordination.id, '--unit-id', coordination.unit.id];
  assert.equal(runKs(['chat-room', 'open', '--home', home, ...roomArgs, '--json']).status, 0);

  const unconfirmed = runKs(['chat-room', 'split', '--home', home, ...roomArgs, '--revision', '1', '--json']);
  assert.equal(unconfirmed.status, 1);
  assert.match(unconfirmed.stderr, /--confirm-revision requires a value/);

  const split = runKs(['chat-room', 'split', '--home', home, ...roomArgs, '--revision', '1', '--confirm-revision', '1', '--replacement-unit-id', 'unit_replacement', '--json']);
  assert.equal(split.status, 0, split.stderr);
  const result = JSON.parse(split.stdout);
  assert.equal(result.split, true);
  assert.equal(result.archivedRoom.status, 'archived');
  assert.equal(result.replacementUnit.status, 'active');

  const active = JSON.parse(runKs(['coordination', 'find', '--home', home, ...anchorArgs(projectId), '--json']).stdout);
  assert.equal(active.unit.id, 'unit_replacement');
  const replacementRoomArgs = ['--project-id', projectId, '--coordination-id', coordination.coordination.id, '--unit-id', 'unit_replacement'];
  assert.equal(runKs(['chat-room', 'open', '--home', home, ...replacementRoomArgs, '--json']).status, 0);
  const archive = runKs(['chat-room', 'archive', '--home', home, ...replacementRoomArgs, '--revision', '1', '--confirm-revision', '0', '--json']);
  assert.equal(archive.status, 1);
  assert.match(archive.stderr, /archive confirmation must match current revision 1/);

  const coordinationArchive = runKs(['coordination', 'archive', '--home', home, '--project-id', projectId, '--coordination-id', coordination.coordination.id, '--revision', '1', '--confirm-revision', '1', '--json']);
  assert.equal(coordinationArchive.status, 0, coordinationArchive.stderr);
  assert.equal(JSON.parse(coordinationArchive.stdout).coordination.status, 'archived');
  assert.equal(JSON.parse(runKs(['coordination', 'find', '--home', home, ...anchorArgs(projectId), '--json']).stdout).found, false);
});
