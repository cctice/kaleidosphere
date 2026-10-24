#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SCHEMA_VERSION = 1;
const PACKAGE_VERSION = require('../package.json').version;
const LOCAL_GIT_COMMIT_IDENTITY = {
  name: 'KaleidoSphere Local',
  email: 'local@kaleidosphere.invalid'
};
const PROJECT_LIFECYCLES = new Set(['active', 'paused', 'archived']);

function resolveKsHome(args) {
  const homeIndex = args.indexOf('--home');
  if (homeIndex !== -1) {
    const configuredHome = args[homeIndex + 1];
    if (!configuredHome || configuredHome.startsWith('--')) {
      throw new Error('--home requires a directory path');
    }
    return path.resolve(configuredHome);
  }

  return path.resolve(process.env.KS_HOME || path.join(os.homedir(), '.ks'));
}

function writeJsonIfMissing(filePath, value) {
  if (fs.existsSync(filePath)) {
    return false;
  }

  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporaryPath, filePath);
    return true;
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    if (error.code === 'EEXIST' && fs.existsSync(filePath)) {
      return false;
    }
    throw error;
  }
}

function writeJson(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function withRegistryLock(home, callback) {
  const lockPath = path.join(home, 'state', 'registry.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let descriptor;
  try {
    descriptor = fs.openSync(lockPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error('registry is busy; retry after the active KS operation finishes');
    }
    throw error;
  }
  try {
    return callback();
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(lockPath, { force: true });
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function option(args, name, required = false) {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (required && (!value || value.startsWith('--'))) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function options(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    values.push(value);
  }
  return values;
}

function initialize(home) {
  const registryPath = path.join(home, 'registry');
  fs.mkdirSync(registryPath, { recursive: true });
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.mkdirSync(path.join(home, 'backups'), { recursive: true });

  const initializedAt = new Date().toISOString();
  const created = [
    writeJsonIfMissing(path.join(home, 'config.json'), {
      schemaVersion: SCHEMA_VERSION,
      product: 'KaleidoSphere',
      initializedAt
    }),
    writeJsonIfMissing(path.join(registryPath, 'workspaces.json'), {
      schemaVersion: SCHEMA_VERSION,
      workspaces: []
    }),
    writeJsonIfMissing(path.join(registryPath, 'projects.json'), {
      schemaVersion: SCHEMA_VERSION,
      projects: []
    }),
    writeJsonIfMissing(path.join(registryPath, 'sparks.json'), {
      schemaVersion: SCHEMA_VERSION,
      sparks: []
    })
  ];

  return created.some(Boolean);
}

function printResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (Object.hasOwn(result, 'initialized')) {
    const action = result.initialized ? 'initialized' : 'already initialized';
    process.stdout.write(`KaleidoSphere registry ${action}: ${result.home}\n`);
    return;
  }

  if (result.workspace) {
    process.stdout.write(`Workspace registered: ${result.workspace.id} -> ${result.workspace.path}\n`);
  }
}

function addWorkspace(home, args) {
  const registryFile = path.join(home, 'registry', 'workspaces.json');
  if (!fs.existsSync(registryFile)) {
    throw new Error('registry is not initialized; run ks init first');
  }

  const id = option(args, '--id', true);
  const workspacePath = path.resolve(option(args, '--path', true));
  const mode = option(args, '--mode') || 'managed';
  if (mode !== 'managed') {
    throw new Error(`unsupported workspace mode: ${mode}`);
  }

  const registry = readJson(registryFile);
  if (registry.workspaces.some((workspace) => workspace.id === id)) {
    throw new Error(`workspace id already exists: ${id}`);
  }

  fs.mkdirSync(workspacePath, { recursive: true });
  const workspace = { id, path: workspacePath, mode };
  registry.workspaces.push(workspace);
  writeJson(registryFile, registry);
  return workspace;
}

function listWorkspaces(home) {
  const registryFile = path.join(home, 'registry', 'workspaces.json');
  if (!fs.existsSync(registryFile)) {
    throw new Error('registry is not initialized; run ks init first');
  }
  return readJson(registryFile).workspaces;
}

function readSparks(home) {
  const registryFile = path.join(home, 'registry', 'sparks.json');
  if (!fs.existsSync(registryFile)) {
    throw new Error('registry is not initialized; run ks init first');
  }
  return { file: registryFile, registry: readJson(registryFile) };
}

function sparkDirectory(home) {
  const { registry } = readSparks(home);
  if (registry.directory) return path.resolve(registry.directory);

  const parents = [...new Set(listWorkspaces(home).map((workspace) => path.dirname(workspace.path)))];
  if (parents.length === 1) return path.join(parents[0], 'sparks');
  throw new Error('spark directory is not configured; run ks spark configure --path <directory>');
}

function configureSparkDirectory(home, args) {
  const directory = path.resolve(option(args, '--path', true));
  const { file, registry } = readSparks(home);
  fs.mkdirSync(directory, { recursive: true });
  registry.directory = directory;
  writeJson(file, registry);
  return { directory, configured: true };
}

function sparkId(filePath) {
  return `spk_${createHash('sha256').update(path.resolve(filePath)).digest('hex').slice(0, 16)}`;
}

function sparkFrontMatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  const read = (key) => match[1].match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim() || null;
  return { title: read('title'), date: read('date'), scope: read('scope') };
}

function listSparks(home) {
  const directory = sparkDirectory(home);
  if (!fs.existsSync(directory)) return { directory, sparks: [] };
  const sparks = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => {
      const filePath = path.join(directory, entry.name);
      const content = fs.readFileSync(filePath, 'utf8');
      const metadata = sparkFrontMatter(content);
      const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || null;
      const stat = fs.statSync(filePath);
      return {
        id: sparkId(filePath),
        title: metadata.title || heading || path.basename(entry.name, '.md'),
        path: filePath,
        date: metadata.date,
        scope: metadata.scope || 'global',
        updatedAt: stat.mtime.toISOString()
      };
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return { directory, sparks };
}

function requireSpark(home, id) {
  const result = listSparks(home);
  const spark = result.sparks.find((item) => item.id === id);
  if (!spark) throw new Error(`spark does not exist: ${id}`);
  return { ...result, spark };
}

function findSparks(home, args) {
  const query = option(args, '--query', true).toLocaleLowerCase();
  const result = listSparks(home);
  return {
    ...result,
    sparks: result.sparks.filter((spark) => {
      const content = fs.readFileSync(spark.path, 'utf8').toLocaleLowerCase();
      return `${spark.title}\n${spark.path}\n${content}`.toLocaleLowerCase().includes(query);
    })
  };
}

function inspectSpark(home, args) {
  const { directory, spark } = requireSpark(home, option(args, '--id', true));
  return { directory, spark, content: fs.readFileSync(spark.path, 'utf8') };
}

function sparkSlug(title) {
  const slug = title.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || `spark-${createHash('sha256').update(title).digest('hex').slice(0, 12)}`;
}

function createSpark(home, args) {
  const title = option(args, '--title', true).trim();
  if (!title) throw new Error('--title must not be empty');
  const directory = sparkDirectory(home);
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, `${sparkSlug(title)}.md`);
  if (fs.existsSync(filePath)) throw new Error(`spark already exists: ${filePath}`);
  const date = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(filePath, `---\ntitle: ${title}\ndate: ${date}\nscope: global\n---\n\n# ${title}\n`);
  return { directory, spark: requireSpark(home, sparkId(filePath)).spark };
}

function markdownHeadingFrom(content) {
  const firstNonEmptyLine = content.split(/\r?\n/).find((line) => line.trim());
  const match = firstNonEmptyLine && firstNonEmptyLine.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
  return match ? match[1].trim() : null;
}

function appendSparkSection(home, args) {
  const heading = option(args, '--heading', true).trim().replace(/^#+\s*/, '');
  if (!heading || heading.includes('\n')) throw new Error('--heading must be a single non-empty line');
  const contentFile = path.resolve(option(args, '--content-file', true));
  if (!fs.existsSync(contentFile)) throw new Error(`content file does not exist: ${contentFile}`);
  const content = fs.readFileSync(contentFile, 'utf8').trim();
  if (!content) throw new Error('content file must not be empty');
  if (markdownHeadingFrom(content) === heading) {
    throw new Error('--content-file already starts with the same Markdown heading as --heading; pass the section body only');
  }
  const { directory, spark } = requireSpark(home, option(args, '--id', true));
  const insertedHeading = `## ${heading}`;
  fs.appendFileSync(spark.path, `\n\n${insertedHeading}\n\n${content}\n`);
  return { directory, spark: requireSpark(home, spark.id).spark, insertedHeading };
}

function checkSpark(home, args) {
  const { directory, spark } = requireSpark(home, option(args, '--id', true));
  const content = fs.readFileSync(spark.path, 'utf8');
  const metadata = sparkFrontMatter(content);
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || null;
  const checks = [
    { id: 'path.in-spark-directory', passed: path.dirname(spark.path) === directory, message: '火花文件位于受管 sparks 目录。' },
    { id: 'format.markdown', passed: spark.path.endsWith('.md'), message: '火花文件为 Markdown。' },
    { id: 'metadata.title', passed: Boolean(metadata.title), message: '火花文件包含 title 元信息。' },
    { id: 'content.heading', passed: Boolean(heading), message: '火花文件包含一级标题。' }
  ];
  return { directory, spark, compliant: checks.every((check) => check.passed), checks };
}

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

function tryGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function readGitIdentity(args) {
  const name = option(args, '--git-name');
  const email = option(args, '--git-email');
  if (Boolean(name) !== Boolean(email)) {
    throw new Error('--git-name and --git-email must be provided together');
  }
  return name ? { name, email } : null;
}

function configureGitIdentity(cwd, identity) {
  const commitIdentity = identity || LOCAL_GIT_COMMIT_IDENTITY;
  runGit(cwd, ['config', 'user.name', commitIdentity.name]);
  runGit(cwd, ['config', 'user.email', commitIdentity.email]);
}

function isPathInside(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function readProjects(home) {
  const projectsFile = path.join(home, 'registry', 'projects.json');
  if (!fs.existsSync(projectsFile)) {
    throw new Error('registry is not initialized; run ks init first');
  }
  return { file: projectsFile, registry: readJson(projectsFile) };
}

function validateProjectTag(tag) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tag)) {
    throw new Error('project tags must use lowercase kebab-case');
  }
  return tag;
}

function validateProjectAlias(alias) {
  const value = alias.trim();
  if (!value || value.includes('\n')) throw new Error('project aliases must be single non-empty lines');
  return value;
}

function validateProjectSummary(summary) {
  const value = summary.trim();
  if (!value || value.includes('\n')) throw new Error('project summary must be a single non-empty line');
  return value;
}

function validateProjectLifecycle(lifecycle) {
  if (!PROJECT_LIFECYCLES.has(lifecycle)) {
    throw new Error('project lifecycle must be active, paused, or archived');
  }
  return lifecycle;
}

function normalizeProject(project) {
  return {
    ...project,
    tags: Array.isArray(project.tags) ? [...new Set(project.tags.map(validateProjectTag))] : [],
    aliases: Array.isArray(project.aliases) ? [...new Set(project.aliases.map(validateProjectAlias))] : [],
    summary: project.summary === undefined || project.summary === null ? null : validateProjectSummary(project.summary),
    lifecycle: project.lifecycle === undefined || project.lifecycle === null ? 'active' : validateProjectLifecycle(project.lifecycle)
  };
}

function normalizeProjectInPlace(project) {
  Object.assign(project, normalizeProject(project));
  return project;
}

function projectMetadataFromArgs(args) {
  const summary = option(args, '--summary');
  const lifecycle = option(args, '--lifecycle');
  return {
    tags: [...new Set(options(args, '--tag').map(validateProjectTag))],
    aliases: [...new Set(options(args, '--alias').map(validateProjectAlias))],
    summary: summary === undefined ? null : validateProjectSummary(summary),
    lifecycle: lifecycle === undefined ? 'active' : validateProjectLifecycle(lifecycle)
  };
}

function updateRegisteredProject(home, projectId, updater) {
  return withRegistryLock(home, () => {
    const { file, registry } = readProjects(home);
    const project = registry.projects.find((item) => item.id === projectId);
    if (!project) throw new Error(`project does not exist: ${projectId}`);
    normalizeProjectInPlace(project);
    updater(project);
    project.updatedAt = new Date().toISOString();
    writeJson(file, registry);
    return normalizeProject(project);
  });
}

function requireProject(home, projectId) {
  const projects = readProjects(home);
  const registeredProject = projects.registry.projects.find((item) => item.id === projectId);
  const project = registeredProject && normalizeProject(registeredProject);
  if (!project) {
    throw new Error(`project does not exist: ${projectId}`);
  }
  const workspace = listWorkspaces(home).find((item) => item.id === project.workspace);
  if (!workspace) {
    throw new Error(`registered workspace does not exist: ${project.workspace}`);
  }
  if (!isPathInside(workspace.path, project.path)) {
    throw new Error('registered project path is outside its workspace');
  }
  return { ...projects, project, workspace };
}

function gitStatus(cwd) {
  return runGit(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
}

function trackedFiles(cwd, directory) {
  const output = runGit(cwd, ['ls-files', '--', directory]);
  return output ? output.split('\n') : [];
}

function writeProjectDescriptor(contextPath, project, gitIdentity = null) {
  const descriptorPath = path.join(contextPath, 'project.json');
  if (fs.existsSync(descriptorPath)) {
    const descriptor = readJson(descriptorPath);
    if (descriptor.id !== project.id || descriptor.name !== project.name || descriptor.workspace !== project.workspace) {
      throw new Error('ks-context/project.json does not match the registered project identity');
    }
    return;
  }
  writeJson(descriptorPath, {
    schemaVersion: SCHEMA_VERSION,
    id: project.id,
    name: project.name,
    workspace: project.workspace,
    createdAt: project.createdAt,
    gitIdentity
  });
}

function projectWorksitePath(workspacePath, projectName) {
  return path.join(workspacePath, `${projectName}-proj`);
}

function projectRepositoryDirectory(project) {
  return project.name;
}

function projectRepositoryPath(project) {
  return project.layout === 'worksite' ? path.join(project.path, projectRepositoryDirectory(project)) : project.path;
}

function ensureRepositoryIgnored(project) {
  const projectPath = project.path;
  const repositoryDirectory = projectRepositoryDirectory(project);
  const gitignorePath = path.join(projectPath, '.gitignore');
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  const lines = existing.split(/\r?\n/).filter(Boolean);
  if (!lines.includes(`${repositoryDirectory}/`)) {
    lines.push(`${repositoryDirectory}/`);
    fs.writeFileSync(gitignorePath, `${lines.join('\n')}\n`);
  }
}

function createProject(home, args) {
  const workspacesFile = path.join(home, 'registry', 'workspaces.json');
  const projectsFile = path.join(home, 'registry', 'projects.json');
  if (!fs.existsSync(workspacesFile) || !fs.existsSync(projectsFile)) {
    throw new Error('registry is not initialized; run ks init first');
  }

  const workspaceId = option(args, '--workspace', true);
  const name = option(args, '--name', true);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error('--name must use lowercase kebab-case');
  }

  const workspaces = readJson(workspacesFile).workspaces;
  const workspace = workspaces.find((item) => item.id === workspaceId);
  if (!workspace) {
    throw new Error(`workspace does not exist: ${workspaceId}`);
  }

  const projects = readJson(projectsFile);
  if (projects.projects.some((project) => project.name === name && project.workspace === workspaceId)) {
    throw new Error(`project already exists in workspace: ${name}`);
  }

  const projectPath = projectWorksitePath(workspace.path, name);
  if (fs.existsSync(projectPath)) {
    throw new Error(`project path already exists: ${projectPath}`);
  }

  const gitIdentity = readGitIdentity(args);
  const metadata = projectMetadataFromArgs(args);
  const createdAt = new Date().toISOString();
  const project = {
    id: `prj_${randomUUID()}`,
    name,
    workspace: workspaceId,
    path: projectPath,
    layout: 'worksite',
    createdAt,
    updatedAt: createdAt,
    ...metadata
  };
  const repoPath = path.join(projectPath, name);
  const contextPath = path.join(projectPath, 'ks-context');

  fs.mkdirSync(repoPath, { recursive: true });
  fs.mkdirSync(contextPath, { recursive: true });
  fs.writeFileSync(path.join(repoPath, 'README.md'), `# ${name}\n`);
  fs.writeFileSync(path.join(projectPath, '.gitignore'), `${name}/\n`);
  fs.writeFileSync(path.join(projectPath, 'README.md'), `# ${name}\n\nLocal development workspace managed by KaleidoSphere.\n`);
  writeProjectDescriptor(contextPath, project, gitIdentity);

  runGit(repoPath, ['init']);
  configureGitIdentity(repoPath, gitIdentity);
  runGit(repoPath, ['add', 'README.md']);
  runGit(repoPath, ['commit', '-m', `chore: initialize ${name} project repository`]);
  runGit(projectPath, ['init']);
  configureGitIdentity(projectPath, gitIdentity);
  runGit(projectPath, ['add', '.gitignore', 'README.md', 'ks-context']);
  runGit(projectPath, ['commit', '-m', `chore: initialize ${name} development workspace`]);

  projects.projects.push(project);
  writeJson(projectsFile, projects);
  return project;
}

function registerProject(home, args) {
  const workspaceId = option(args, '--workspace', true);
  const name = option(args, '--name', true);
  const projectPath = path.resolve(option(args, '--path', true));
  const layout = option(args, '--layout') || 'direct';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error('--name must use lowercase kebab-case');
  }
  if (layout !== 'direct') {
    throw new Error('project register only records an existing direct repository; use project create for a new development worksite');
  }
  const workspaces = listWorkspaces(home);
  const workspace = workspaces.find((item) => item.id === workspaceId);
  if (!workspace) throw new Error(`workspace does not exist: ${workspaceId}`);
  if (!isPathInside(workspace.path, projectPath)) {
    throw new Error('project path must be inside the registered workspace');
  }
  if (!fs.existsSync(path.join(projectPath, '.git'))) {
    throw new Error('project register requires an existing Git repository');
  }
  const { file: projectsFile, registry: projects } = readProjects(home);
  if (projects.projects.some((project) => project.path === projectPath || (project.name === name && project.workspace === workspaceId))) {
    throw new Error(`project is already registered: ${projectPath}`);
  }
  const now = new Date().toISOString();
  const project = {
    id: `prj_${randomUUID()}`,
    name,
    workspace: workspaceId,
    path: projectPath,
    layout,
    createdAt: now,
    updatedAt: now,
    ...projectMetadataFromArgs(args)
  };
  projects.projects.push(project);
  writeJson(projectsFile, projects);
  return project;
}

function listProjects(home, args = []) {
  const registryFile = path.join(home, 'registry', 'projects.json');
  if (!fs.existsSync(registryFile)) {
    throw new Error('registry is not initialized; run ks init first');
  }
  const tags = options(args, '--tag').map(validateProjectTag);
  const lifecycle = option(args, '--lifecycle');
  if (lifecycle !== undefined) validateProjectLifecycle(lifecycle);
  return readJson(registryFile).projects
    .map(normalizeProject)
    .filter((project) => tags.every((tag) => project.tags.includes(tag)))
    .filter((project) => lifecycle === undefined || project.lifecycle === lifecycle);
}

function projectTag(home, args, action) {
  const tag = validateProjectTag(option(args, '--tag', true));
  const project = updateRegisteredProject(home, option(args, '--id', true), (current) => {
    if (action === 'add') {
      if (!current.tags.includes(tag)) current.tags.push(tag);
      return;
    }
    current.tags = current.tags.filter((item) => item !== tag);
  });
  return { project, tag, action };
}

function projectTags(home, args) {
  const { project } = requireProject(home, option(args, '--id', true));
  return { projectId: project.id, tags: project.tags };
}

function projectAlias(home, args, action) {
  const alias = validateProjectAlias(option(args, '--alias', true));
  const project = updateRegisteredProject(home, option(args, '--id', true), (current) => {
    if (action === 'add') {
      if (!current.aliases.includes(alias)) current.aliases.push(alias);
      return;
    }
    current.aliases = current.aliases.filter((item) => item !== alias);
  });
  return { project, alias, action };
}

function projectAliases(home, args) {
  const { project } = requireProject(home, option(args, '--id', true));
  return { projectId: project.id, aliases: project.aliases };
}

function describeProject(home, args) {
  const clear = args.includes('--clear');
  const suppliedSummary = option(args, '--summary');
  if (clear === (suppliedSummary !== undefined)) {
    throw new Error('project describe requires exactly one of --summary or --clear');
  }
  const project = updateRegisteredProject(home, option(args, '--id', true), (current) => {
    current.summary = clear ? null : validateProjectSummary(suppliedSummary);
  });
  return { project };
}

function setProjectLifecycle(home, args) {
  const lifecycle = validateProjectLifecycle(option(args, '--state', true));
  const project = updateRegisteredProject(home, option(args, '--id', true), (current) => {
    current.lifecycle = lifecycle;
  });
  return { project };
}

function searchProjects(home, args) {
  const query = option(args, '--query', true).trim().toLocaleLowerCase();
  if (!query) throw new Error('--query must not be empty');
  const projects = listProjects(home, args).filter((project) => {
    const haystack = [project.name, project.path, project.summary || '', project.lifecycle, ...project.tags, ...project.aliases]
      .join('\n')
      .toLocaleLowerCase();
    return haystack.includes(query);
  });
  return { query, projects };
}

function coordinationStatePath(home) {
  return path.join(home, 'state', 'coordination.json');
}

function readCoordinationState(home) {
  const file = coordinationStatePath(home);
  if (!fs.existsSync(file)) {
    return { file, state: { schemaVersion: SCHEMA_VERSION, sequence: 0, coordinations: [] } };
  }
  const state = readJson(file);
  if (!Array.isArray(state.coordinations) || !Number.isInteger(state.sequence)) {
    throw new Error('coordination state is invalid');
  }
  return { file, state };
}

function saveCoordinationState(file, state) {
  writeJson(file, state);
}

function coordinationProjectId(args) {
  const projectId = option(args, '--project-id') || option(args, '--project');
  if (!projectId) throw new Error('--project-id requires a value');
  const alternate = option(args, '--project-id') && option(args, '--project');
  if (alternate && option(args, '--project-id') !== option(args, '--project')) {
    throw new Error('--project-id and --project must identify the same project');
  }
  return projectId;
}

function requireCoordinationProject(home, args) {
  const projectId = coordinationProjectId(args);
  const result = requireProject(home, projectId);
  const expectedWorksitePath = projectWorksitePath(result.workspace.path, result.project.name);
  if (result.project.layout !== 'worksite' || result.project.path !== expectedWorksitePath) {
    throw new Error('coordination requires a managed development worksite at the standard <project>-proj path; migrate the project before using coordination');
  }
  return { ...result, projectId };
}

function taskAnchor(args) {
  const source = option(args, '--anchor-source', true);
  const id = option(args, '--anchor-id', true);
  const scopeKey = option(args, '--scope-key', true);
  if ([source, id, scopeKey].some((value) => value.includes('\n'))) {
    throw new Error('task anchor values must be single-line');
  }
  return { source, id, scopeKey, key: JSON.stringify([source, id, scopeKey]) };
}

function sameTaskAnchor(left, right) {
  return left.key === right.key;
}

function coordinationProjectionPath(project) {
  if (project.layout !== 'worksite') {
    throw new Error('coordination projection requires a managed development worksite');
  }
  return path.join(project.path, 'ks-coordination', 'README.md');
}

function appendCoordinationProjection(project, event) {
  const file = coordinationProjectionPath(project);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const marker = `<!-- ks:coordination-event:${event.sequence} -->`;
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (existing.includes(marker)) return file;
  const prefix = existing ? '' : '# KS Coordination\n';
  fs.appendFileSync(file, `${prefix}\n${marker}\n- ${event.at} [${event.type}] ${JSON.stringify(event.payload)}\n`);
  return file;
}

function nextCoordinationEvent(state, type, payload) {
  state.sequence += 1;
  return { sequence: state.sequence, type, at: new Date().toISOString(), payload, delivered: false };
}

function queueCoordinationEvent(state, coordination, type, payload) {
  const event = nextCoordinationEvent(state, type, payload);
  coordination.outbox.push(event);
  return event;
}

function deliverCoordinationOutbox(project, state, file) {
  for (const coordination of state.coordinations) {
    if (coordination.projectId !== project.id) continue;
    for (const event of coordination.outbox || []) {
      if (event.delivered) continue;
      appendCoordinationProjection(project, event);
      event.delivered = true;
      event.deliveredAt = new Date().toISOString();
      saveCoordinationState(file, state);
    }
  }
}

function activeUnitForAnchor(state, projectId, anchor) {
  const matches = state.coordinations.flatMap((coordination) => coordination.projectId === projectId
    ? coordination.units
      .filter((unit) => unit.status === 'active' && sameTaskAnchor(unit.taskAnchor, anchor))
      .map((unit) => ({ coordination, unit }))
    : []);
  if (matches.length > 1) {
    throw new Error('multiple active execution units exist for this task anchor; user resolution is required');
  }
  return matches[0] || null;
}

function openCoordination(home, args) {
  const { project, projectId } = requireCoordinationProject(home, args);
  const anchor = taskAnchor(args);
  return withRegistryLock(home, () => {
    const { file, state } = readCoordinationState(home);
    deliverCoordinationOutbox(project, state, file);
    const existing = activeUnitForAnchor(state, project.id, anchor);
    if (existing) {
      return { resumed: true, coordination: existing.coordination, unit: existing.unit, projection: coordinationProjectionPath(project) };
    }
    const now = new Date().toISOString();
    const coordination = {
      id: `cor_${randomUUID()}`,
      projectId: project.id,
      status: 'active',
      revision: 1,
      createdAt: now,
      units: [{ id: `unit_${randomUUID()}`, taskAnchor: anchor, status: 'active', revision: 1, createdAt: now }],
      rooms: []
    };
    state.coordinations.push(coordination);
    coordination.outbox = [];
    queueCoordinationEvent(state, coordination, 'coordination.opened', { projectId: project.id, coordinationId: coordination.id, unitId: coordination.units[0].id, taskAnchor: anchor });
    saveCoordinationState(file, state);
    deliverCoordinationOutbox(project, state, file);
    return { resumed: false, coordination, unit: coordination.units[0], projection: coordinationProjectionPath(project) };
  });
}

function findCoordination(home, args) {
  const { project, projectId } = requireCoordinationProject(home, args);
  const anchor = taskAnchor(args);
  return withRegistryLock(home, () => {
    const { file, state } = readCoordinationState(home);
    deliverCoordinationOutbox(project, state, file);
    const match = activeUnitForAnchor(state, projectId, anchor);
    return { found: Boolean(match), coordination: match?.coordination || null, unit: match?.unit || null };
  });
}

function archiveCoordination(home, args) {
  const { project, projectId } = requireCoordinationProject(home, args);
  const coordinationId = option(args, '--coordination-id', true);
  const revision = requiredRevision(args);
  const confirmation = confirmedRevision(args);
  return withRegistryLock(home, () => {
    const { file, state } = readCoordinationState(home);
    deliverCoordinationOutbox(project, state, file);
    const coordination = requireCoordination(state, project.id, coordinationId);
    if (coordination.revision !== revision || confirmation !== revision) {
      throw new Error(`archive confirmation must match current revision ${coordination.revision}`);
    }
    if (coordination.status === 'archived') return { archived: false, coordination };
    coordination.status = 'archived';
    coordination.revision += 1;
    for (const unit of coordination.units) {
      if (unit.status === 'active') unit.status = 'archived';
    }
    for (const room of coordination.rooms) {
      if (room.status === 'active') {
        room.status = 'archived';
        room.revision += 1;
      }
    }
    queueCoordinationEvent(state, coordination, 'coordination.archived', { projectId: project.id, coordinationId, revision: coordination.revision });
    saveCoordinationState(file, state);
    deliverCoordinationOutbox(project, state, file);
    return { archived: true, coordination, projection: coordinationProjectionPath(project) };
  });
}

function requireCoordination(state, projectId, coordinationId) {
  const coordination = state.coordinations.find((item) => item.id === coordinationId && item.projectId === projectId);
  if (!coordination) throw new Error(`coordination does not exist for project: ${coordinationId}`);
  return coordination;
}

function requireUnit(coordination, unitId) {
  const unit = coordination.units.find((item) => item.id === unitId);
  if (!unit) throw new Error(`execution unit does not exist: ${unitId}`);
  return unit;
}

function openChatRoom(home, args) {
  const { project, projectId } = requireCoordinationProject(home, args);
  const coordinationId = option(args, '--coordination-id', true);
  const unitId = option(args, '--unit-id', true);
  return withRegistryLock(home, () => {
    const { file, state } = readCoordinationState(home);
    deliverCoordinationOutbox(project, state, file);
    const coordination = requireCoordination(state, project.id, coordinationId);
    const unit = requireUnit(coordination, unitId);
    if (coordination.status !== 'active' || unit.status !== 'active') throw new Error('cannot open a room for an inactive execution unit');
    let room = coordination.rooms.find((item) => item.unitId === unit.id);
    if (room) return { opened: false, room };
    const now = new Date().toISOString();
    room = { id: `room_${randomUUID()}`, projectId: project.id, coordinationId: coordination.id, unitId: unit.id, status: 'active', revision: 1, createdAt: now, messages: [], operations: [] };
    coordination.rooms.push(room);
    queueCoordinationEvent(state, coordination, 'room.opened', { projectId: project.id, coordinationId: coordination.id, unitId: unit.id, roomId: room.id });
    saveCoordinationState(file, state);
    deliverCoordinationOutbox(project, state, file);
    return { opened: true, room, projection: coordinationProjectionPath(project) };
  });
}

function requireRoom(coordination, unitId) {
  const room = coordination.rooms.find((item) => item.unitId === unitId);
  if (!room) throw new Error(`room does not exist for execution unit: ${unitId}`);
  return room;
}

function requiredRevision(args) {
  const raw = option(args, '--revision', true);
  if (!/^\d+$/.test(raw)) throw new Error('--revision must be a non-negative integer');
  return Number(raw);
}

function confirmedRevision(args) {
  const raw = option(args, '--confirm-revision', true);
  if (!/^\d+$/.test(raw)) throw new Error('--confirm-revision must be a non-negative integer');
  return Number(raw);
}

function appendChatRoom(home, args) {
  const { project, projectId } = requireCoordinationProject(home, args);
  const coordinationId = option(args, '--coordination-id', true);
  const unitId = option(args, '--unit-id', true);
  const operationId = option(args, '--operation-id', true);
  const message = option(args, '--message', true);
  const role = option(args, '--role') || 'member';
  const revision = requiredRevision(args);
  return withRegistryLock(home, () => {
    const { file, state } = readCoordinationState(home);
    deliverCoordinationOutbox(project, state, file);
    const coordination = requireCoordination(state, project.id, coordinationId);
    const room = requireRoom(coordination, unitId);
    const previous = room.operations.find((item) => item.id === operationId);
    if (previous) {
      const existingMessage = room.messages.find((item) => item.operationId === operationId) || null;
      const original = previous.request || { message: existingMessage?.message, role: existingMessage?.role, revision: previous.revision };
      if (original.message !== message || original.role !== role || original.revision !== revision) {
        throw new Error(`operation_id request summary conflicts with the original request: ${operationId}`);
      }
      return { appended: false, idempotent: true, room, message: existingMessage };
    }
    if (room.status !== 'active') throw new Error('cannot append to an archived room');
    if (room.revision !== revision) throw new Error(`revision conflict: expected ${room.revision}, received ${revision}`);
    const entry = { sequence: state.sequence + 1, operationId, role, message, at: new Date().toISOString() };
    room.messages.push(entry);
    room.operations.push({ id: operationId, type: 'append', revision, request: { message, role, revision } });
    room.revision += 1;
    queueCoordinationEvent(state, coordination, 'room.appended', { projectId: project.id, coordinationId, unitId, roomId: room.id, operationId, revision: room.revision, role, message });
    saveCoordinationState(file, state);
    deliverCoordinationOutbox(project, state, file);
    return { appended: true, idempotent: false, room, message: entry, projection: coordinationProjectionPath(project) };
  });
}

function archiveChatRoom(home, args) {
  const { project, projectId } = requireCoordinationProject(home, args);
  const coordinationId = option(args, '--coordination-id', true);
  const unitId = option(args, '--unit-id', true);
  const revision = requiredRevision(args);
  const confirmation = confirmedRevision(args);
  return withRegistryLock(home, () => {
    const { file, state } = readCoordinationState(home);
    deliverCoordinationOutbox(project, state, file);
    const coordination = requireCoordination(state, project.id, coordinationId);
    const room = requireRoom(coordination, unitId);
    if (room.revision !== revision || confirmation !== revision) throw new Error(`archive confirmation must match current revision ${room.revision}`);
    if (room.status === 'archived') return { archived: false, room };
    room.status = 'archived';
    room.revision += 1;
    queueCoordinationEvent(state, coordination, 'room.archived', { projectId: project.id, coordinationId, unitId, roomId: room.id, revision: room.revision });
    saveCoordinationState(file, state);
    deliverCoordinationOutbox(project, state, file);
    return { archived: true, room, projection: coordinationProjectionPath(project) };
  });
}

function splitChatRoom(home, args) {
  const { project, projectId } = requireCoordinationProject(home, args);
  const coordinationId = option(args, '--coordination-id', true);
  const unitId = option(args, '--unit-id', true);
  const replacementId = option(args, '--replacement-unit-id') || `unit_${randomUUID()}`;
  const revision = requiredRevision(args);
  const confirmation = confirmedRevision(args);
  return withRegistryLock(home, () => {
    const { file, state } = readCoordinationState(home);
    deliverCoordinationOutbox(project, state, file);
    const coordination = requireCoordination(state, project.id, coordinationId);
    const unit = requireUnit(coordination, unitId);
    const room = requireRoom(coordination, unitId);
    if (room.revision !== revision || confirmation !== revision) throw new Error(`split confirmation must match current revision ${room.revision}`);
    if (unit.status !== 'active' || room.status !== 'active') throw new Error('can only split an active execution unit and room');
    if (coordination.units.some((item) => item.id === replacementId)) throw new Error(`execution unit already exists: ${replacementId}`);
    unit.status = 'superseded';
    room.status = 'archived';
    room.revision += 1;
    const replacement = { id: replacementId, taskAnchor: unit.taskAnchor, status: 'active', revision: 1, createdAt: new Date().toISOString(), replaces: unit.id };
    coordination.units.push(replacement);
    queueCoordinationEvent(state, coordination, 'room.split', { projectId: project.id, coordinationId, unitId, replacementUnitId: replacement.id, roomId: room.id, revision: room.revision });
    saveCoordinationState(file, state);
    deliverCoordinationOutbox(project, state, file);
    return { split: true, archivedRoom: room, replacementUnit: replacement, projection: coordinationProjectionPath(project) };
  });
}

function updateProject(home, args) {
  const projectId = option(args, '--id', true);
  const name = option(args, '--name');
  const workspaceId = option(args, '--workspace');
  const requestedPath = option(args, '--path');
  const requestedLayout = option(args, '--layout');
  if (!name && !workspaceId && !requestedPath && !requestedLayout) {
    throw new Error('project update requires at least one of --name, --workspace, --path, or --layout');
  }
  if (name && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error('--name must use lowercase kebab-case');
  }

  const projectsFile = path.join(home, 'registry', 'projects.json');
  if (!fs.existsSync(projectsFile)) {
    throw new Error('registry is not initialized; run ks init first');
  }
  const projects = readJson(projectsFile);
  const project = projects.projects.find((item) => item.id === projectId);
  if (!project) {
    throw new Error(`project does not exist: ${projectId}`);
  }
  normalizeProjectInPlace(project);

  const targetWorkspaceId = workspaceId || project.workspace;
  const workspaces = listWorkspaces(home);
  const workspace = workspaces.find((item) => item.id === targetWorkspaceId);
  if (!workspace) {
    throw new Error(`workspace does not exist: ${targetWorkspaceId}`);
  }

  const targetPath = requestedPath ? path.resolve(requestedPath) : project.path;
  if (!isPathInside(workspace.path, targetPath)) {
    throw new Error('project path must be inside the registered workspace');
  }
  const targetLayout = requestedLayout || project.layout;
  if (!['direct', 'worksite'].includes(targetLayout)) {
    throw new Error('--layout must be direct or worksite');
  }
  const targetName = name || project.name;
  const repositoryPath = targetLayout === 'worksite' ? path.join(targetPath, targetName) : targetPath;
  if (!fs.existsSync(path.join(repositoryPath, '.git'))) {
    throw new Error('project update requires an existing Git repository at the selected layout');
  }
  if (targetLayout === 'worksite' && !fs.existsSync(path.join(targetPath, 'ks-context', 'project.json'))) {
    throw new Error('project update requires ks-context/project.json for layout worksite');
  }

  if (projects.projects.some((item) => item.id !== projectId && (item.path === targetPath || (item.name === targetName && item.workspace === targetWorkspaceId)))) {
    throw new Error(`project registration conflicts with an existing project: ${targetPath}`);
  }

  project.name = targetName;
  project.workspace = targetWorkspaceId;
  project.path = targetPath;
  project.layout = targetLayout;
  project.updatedAt = new Date().toISOString();
  writeJson(projectsFile, projects);
  return normalizeProject(project);
}

function inspectProject(home, args) {
  const { project, workspace } = requireProject(home, option(args, '--id', true));
  const repoPath = projectRepositoryPath(project);
  return {
    project,
    workspace,
    repoPath,
    registeredPathExists: fs.existsSync(project.path),
    repositoryExists: fs.existsSync(path.join(repoPath, '.git'))
  };
}

function resolveProject(home, args) {
  const targetPath = path.resolve(option(args, '--path', true));
  const projects = listProjects(home);
  const project = projects.find((item) => {
    const repoPath = projectRepositoryPath(item);
    return targetPath === item.path || targetPath === repoPath || isPathInside(item.path, targetPath);
  });
  if (!project) {
    throw new Error(`no registered project contains path: ${targetPath}`);
  }
  return inspectProject(home, ['--id', project.id]);
}

function checkProject(home, args) {
  const { project, workspace } = requireProject(home, option(args, '--id', true));
  const checks = [];
  const add = (id, passed, message, remediation) => checks.push({ id, passed, message, remediation: passed ? null : remediation });
  const projectPath = project.path;
  const repoPath = projectRepositoryPath(project);
  const repositoryDirectory = projectRepositoryDirectory(project);
  const contextPath = path.join(projectPath, 'ks-context');
  const outerGitPath = path.join(projectPath, '.git');

  add('layout.worksite', project.layout === 'worksite', project.layout === 'worksite' ? '登记布局为标准开发现场。' : `登记布局为 ${project.layout}，尚未迁入标准开发现场。`, '在用户明确确认后，先生成迁入计划，再按计划执行迁入。');
  const expectedWorksitePath = projectWorksitePath(workspace.path, project.name);
  add(
    'path.worksite-name',
    project.layout !== 'worksite' || projectPath === expectedWorksitePath,
    project.layout !== 'worksite'
      ? '当前 direct 布局不适用开发现场命名规则。'
      : projectPath === expectedWorksitePath
        ? '开发现场外层路径符合 <project-name>-proj 命名规则。'
        : `开发现场外层路径应为 ${expectedWorksitePath}，当前为 ${projectPath}。`,
    `在用户明确确认后迁入 ${expectedWorksitePath}；不要只修改 registry 路径。`
  );
  add('path.exists', fs.existsSync(projectPath), fs.existsSync(projectPath) ? '登记项目路径存在。' : '登记项目路径不存在。', '确认项目是否被移动、删除或需要修正登记路径。');
  const hasOuterGit = project.layout === 'worksite' && fs.existsSync(outerGitPath);
  add('outer.git', hasOuterGit, hasOuterGit ? '开发现场外层 Git 存在。' : project.layout === 'direct' ? '当前 direct 根的 .git 属于项目本体，不是开发现场外层 Git。' : '开发现场外层 Git 不存在。', `通过受控修复流程初始化外层 Git；不要把 ${repositoryDirectory}/.git 当作外层 Git。`);
  add('repository.git', fs.existsSync(path.join(repoPath, '.git')), fs.existsSync(path.join(repoPath, '.git')) ? `${repositoryDirectory}/ 中的项目本体 Git 存在。` : `${repositoryDirectory}/ 中没有项目本体 Git。`, `确认项目本体是否仍在 ${repositoryDirectory}/，或在用户确认后执行迁入/登记修复。`);
  add('context.exists', fs.existsSync(contextPath), fs.existsSync(contextPath) ? 'ks-context/ 存在。' : 'ks-context/ 不存在。', `通过受控修复流程创建 ks-context/；不要向 ${repositoryDirectory}/ 写入 KS 专用上下文。`);

  const descriptorPath = path.join(contextPath, 'project.json');
  let descriptor = null;
  let descriptorError = null;
  if (fs.existsSync(descriptorPath)) {
    try {
      descriptor = readJson(descriptorPath);
    } catch (error) {
      descriptorError = error.message;
    }
  }
  const descriptorMatches = descriptor && descriptor.id === project.id && descriptor.name === project.name && descriptor.workspace === project.workspace;
  add('context.identity', Boolean(descriptorMatches), descriptorMatches ? 'ks-context/project.json 与登记项目身份一致。' : descriptorError ? `ks-context/project.json 无法解析：${descriptorError}` : fs.existsSync(descriptorPath) ? 'ks-context/project.json 与登记项目身份不一致。' : 'ks-context/project.json 不存在。', '通过受控修复流程恢复与 registry 一致的 project.json，禁止直接改写 ~/.ks。');

  const ignoredRepository = project.layout === 'worksite' && fs.existsSync(path.join(projectPath, '.gitignore')) && fs.readFileSync(path.join(projectPath, '.gitignore'), 'utf8').split(/\r?\n/).includes(`${repositoryDirectory}/`);
  add('outer.ignore-repository', ignoredRepository, ignoredRepository ? `外层 .gitignore 已忽略 ${repositoryDirectory}/。` : project.layout === 'direct' ? 'direct 项目尚无外层 .gitignore 的项目本体隔离规则。' : `外层 .gitignore 没有忽略 ${repositoryDirectory}/。`, `在外层 .gitignore 增加 ${repositoryDirectory}/，避免项目本体进入开发现场 Git。`);

  const outerTracked = hasOuterGit ? tryGit(projectPath, ['ls-files', '--', repositoryDirectory]) : null;
  const trackedRepositoryFiles = outerTracked ? outerTracked.split('\n').filter(Boolean) : [];
  add('outer.untracked-repository', hasOuterGit && trackedRepositoryFiles.length === 0, hasOuterGit && trackedRepositoryFiles.length === 0 ? `外层 Git 未追踪 ${repositoryDirectory}/。` : project.layout === 'direct' ? 'direct 项目尚无可验证的外层 Git 隔离。' : `外层 Git 错误追踪了 ${repositoryDirectory}/ 中的 ${trackedRepositoryFiles.length} 个文件。`, `停止向外层 Git 暂存 ${repositoryDirectory}/，并在用户确认后通过 Git 正常移除错误追踪。`);

  return {
    project,
    workspace,
    compliant: checks.every((check) => check.passed),
    checks,
    diagnostics: {
      outerGitStatus: hasOuterGit ? tryGit(projectPath, ['status', '--porcelain=v1', '--untracked-files=all']) : null,
      repoGitStatus: fs.existsSync(path.join(repoPath, '.git')) ? tryGit(repoPath, ['status', '--porcelain=v1', '--untracked-files=all']) : null,
      repositoryPath: repoPath
    }
  };
}

function migrationPlan(home, args) {
  const { project, workspace } = requireProject(home, option(args, '--id', true));
  const targetLayout = option(args, '--to-layout', true);
  if (targetLayout !== 'worksite') {
    throw new Error('project migration currently supports only --to-layout worksite');
  }
  if (project.layout !== 'direct') {
    throw new Error(`project migration requires layout direct; current layout is ${project.layout}`);
  }
  const projectPath = project.path;
  const targetWorksitePath = projectWorksitePath(workspace.path, project.name);
  const repoPath = path.join(targetWorksitePath, project.name);
  if (!isPathInside(workspace.path, projectPath) || !fs.existsSync(projectPath)) {
    throw new Error('registered direct project path is unavailable inside its workspace');
  }
  if (!fs.statSync(path.join(projectPath, '.git')).isDirectory()) {
    throw new Error('project migration requires a direct Git working tree with a .git directory');
  }
  if (targetWorksitePath !== projectPath && fs.existsSync(targetWorksitePath)) {
    throw new Error(`project migration target already exists: ${targetWorksitePath}`);
  }
  if (targetWorksitePath === projectPath && fs.existsSync(repoPath)) {
    throw new Error(`project migration target already exists: ${repoPath}`);
  }

  const contextPath = path.join(projectPath, 'ks-context');
  const hasContext = fs.existsSync(contextPath);
  const extractContext = args.includes('--extract-context');
  const preserveWorktree = args.includes('--preserve-worktree');
  const status = gitStatus(projectPath);
  const trackedContext = hasContext ? trackedFiles(projectPath, 'ks-context') : [];
  const statusLines = status ? status.split('\n') : [];
  const nonContextChanges = statusLines.filter((line) => !line.slice(3).startsWith('ks-context/'));
  if (nonContextChanges.length > 0 && !preserveWorktree) {
    throw new Error(`source worktree has changes outside ks-context; rerun with --preserve-worktree to include them in an explicit migration plan: ${nonContextChanges.join(', ')}`);
  }
  if ((hasContext || trackedContext.length > 0) && !extractContext) {
    throw new Error('project migration found ks-context; rerun with --extract-context to move it outside the repository');
  }
  const descriptorPath = path.join(contextPath, 'project.json');
  if (fs.existsSync(descriptorPath)) {
    writeProjectDescriptor(contextPath, project);
  }
  const head = runGit(projectPath, ['rev-parse', 'HEAD']);
  const branch = runGit(projectPath, ['branch', '--show-current']);
  const remote = tryGit(projectPath, ['remote', 'get-url', 'origin']);
  const planId = createHash('sha256').update(JSON.stringify({ id: project.id, path: projectPath, targetWorksitePath, head, branch, remote, status, extractContext, preserveWorktree })).digest('hex').slice(0, 16);
  return {
    planId,
    projectId: project.id,
    source: projectPath,
    target: { worksite: targetWorksitePath, repository: repoPath, context: path.join(targetWorksitePath, 'ks-context') },
    extraction: { required: hasContext || trackedContext.length > 0, trackedFiles: trackedContext, sourceStatus: statusLines },
    preserveWorktree,
    repository: { head, branch, remote: remote || null },
    nextLayout: 'worksite'
  };
}

function migrateProject(home, args) {
  const plan = migrationPlan(home, args);
  if (!args.includes('--apply')) return { applied: false, plan };
  const suppliedPlanId = option(args, '--plan', true);
  if (suppliedPlanId !== plan.planId) {
    throw new Error('migration plan has changed; rerun without --apply to review the current plan');
  }

  const { project } = requireProject(home, plan.projectId);
  const sourcePath = project.path;
  const projectPath = plan.target.worksite;
  const parentPath = path.dirname(sourcePath);
  const temporaryPath = path.join(parentPath, `.${path.basename(sourcePath)}.ks-migrate-${randomUUID()}`);
  const contextPath = plan.target.context;
  const repoPath = plan.target.repository;
  let movedRoot = false;
  try {
    fs.renameSync(sourcePath, temporaryPath);
    movedRoot = true;
    fs.mkdirSync(projectPath);
    if (fs.existsSync(path.join(temporaryPath, 'ks-context'))) {
      fs.renameSync(path.join(temporaryPath, 'ks-context'), contextPath);
    } else {
      fs.mkdirSync(contextPath, { recursive: true });
    }
    fs.mkdirSync(repoPath);
    for (const entry of fs.readdirSync(temporaryPath)) {
      fs.renameSync(path.join(temporaryPath, entry), path.join(repoPath, entry));
    }
    fs.rmdirSync(temporaryPath);
    ensureRepositoryIgnored({ ...project, path: projectPath });
    writeProjectDescriptor(contextPath, { ...project, path: projectPath });
    runGit(projectPath, ['init']);
    configureGitIdentity(projectPath, null);
    runGit(projectPath, ['add', '.gitignore', 'ks-context']);
    runGit(projectPath, ['commit', '-m', `chore: initialize ${project.name} development workspace`]);
    const migratedProject = withRegistryLock(home, () => {
      const { registry, file: projectsFile } = readProjects(home);
      const current = registry.projects.find((item) => item.id === project.id);
      if (!current || current.layout !== 'direct' || current.path !== sourcePath) {
        throw new Error('project registration changed during migration; registry was not updated');
      }
      current.layout = 'worksite';
      current.path = projectPath;
      current.updatedAt = new Date().toISOString();
      writeJson(projectsFile, registry);
      return current;
    });
    return { applied: true, plan, project: migratedProject };
  } catch (error) {
    if (movedRoot) {
      try {
        fs.rmSync(projectPath, { recursive: true, force: true });
        fs.renameSync(temporaryPath, sourcePath);
      } catch (rollbackError) {
        throw new Error(`${error.message}; automatic rollback failed: ${rollbackError.message}`);
      }
    }
    throw error;
  }
}

function projectRepositorySnapshot(repositoryPath) {
  const topLevel = fs.realpathSync(runGit(repositoryPath, ['rev-parse', '--show-toplevel']));
  const sourceRoot = fs.realpathSync(repositoryPath);
  if (topLevel !== sourceRoot) {
    throw new Error('project adopt requires --source to be the Git repository root');
  }
  return {
    head: tryGit(repositoryPath, ['rev-parse', 'HEAD']),
    branch: tryGit(repositoryPath, ['branch', '--show-current']) || null,
    remote: tryGit(repositoryPath, ['remote', 'get-url', 'origin']),
    status: gitStatus(repositoryPath)
  };
}

function projectAdoptPlan(home, args) {
  const sourcePath = path.resolve(option(args, '--source', true));
  const workspaceId = option(args, '--workspace', true);
  const name = option(args, '--name', true);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error('--name must use lowercase kebab-case');
  }
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) {
    throw new Error(`project adopt source does not exist: ${sourcePath}`);
  }
  const workspace = listWorkspaces(home).find((item) => item.id === workspaceId);
  if (!workspace) throw new Error(`workspace does not exist: ${workspaceId}`);
  const registered = listProjects(home);
  if (registered.some((project) => project.path === sourcePath || projectRepositoryPath(project) === sourcePath)) {
    throw new Error('project adopt source is already registered; use project migrate or project update instead');
  }
  if (registered.some((project) => project.name === name && project.workspace === workspaceId)) {
    throw new Error(`project already exists in workspace: ${name}`);
  }
  const targetWorksitePath = projectWorksitePath(workspace.path, name);
  if (fs.existsSync(targetWorksitePath)) {
    throw new Error(`project adopt target already exists: ${targetWorksitePath}`);
  }
  if (fs.statSync(sourcePath).dev !== fs.statSync(workspace.path).dev) {
    throw new Error('project adopt source and target workspace are on different filesystems; move the repository to the target filesystem before adopting it');
  }
  const repository = projectRepositorySnapshot(sourcePath);
  const preserveWorktree = args.includes('--preserve-worktree');
  const statusLines = repository.status ? repository.status.split('\n') : [];
  if (statusLines.length > 0 && !preserveWorktree) {
    throw new Error(`source worktree has changes; rerun with --preserve-worktree to include them in an explicit adoption plan: ${statusLines.join(', ')}`);
  }
  const now = new Date().toISOString();
  const project = {
    id: `prj_${randomUUID()}`,
    name,
    workspace: workspaceId,
    path: targetWorksitePath,
    layout: 'worksite',
    createdAt: now,
    updatedAt: now,
    ...projectMetadataFromArgs(args)
  };
  return {
    source: { path: sourcePath, status: statusLines },
    target: {
      workspace: workspace.path,
      worksite: targetWorksitePath,
      repository: path.join(targetWorksitePath, name),
      context: path.join(targetWorksitePath, 'ks-context')
    },
    project,
    gitIdentity: readGitIdentity(args),
    preserveWorktree,
    repository: {
      head: repository.head,
      branch: repository.branch,
      remote: repository.remote || null
    }
  };
}

function validateProjectAdoptPlan(home, plan) {
  const workspace = listWorkspaces(home).find((item) => item.id === plan.project.workspace);
  if (!workspace || workspace.path !== plan.target.workspace) {
    throw new Error('adoption workspace changed; create a new adoption plan');
  }
  if (fs.existsSync(plan.target.worksite)) {
    throw new Error('adoption target now exists; create a new adoption plan');
  }
  if (!fs.existsSync(plan.source.path)) {
    throw new Error('adoption source no longer exists; create a new adoption plan');
  }
  const registered = listProjects(home);
  if (registered.some((project) => project.path === plan.source.path || projectRepositoryPath(project) === plan.source.path)) {
    throw new Error('adoption source is now registered; create a new adoption plan');
  }
  if (registered.some((project) => project.name === plan.project.name && project.workspace === plan.project.workspace)) {
    throw new Error('adoption project identity is now registered; create a new adoption plan');
  }
  if (fs.statSync(plan.source.path).dev !== fs.statSync(workspace.path).dev) {
    throw new Error('adoption source and target workspace are on different filesystems; create a new plan after moving the repository');
  }
  const snapshot = projectRepositorySnapshot(plan.source.path);
  if (snapshot.head !== plan.repository.head || snapshot.branch !== plan.repository.branch || (snapshot.remote || null) !== plan.repository.remote || snapshot.status !== plan.source.status.join('\n')) {
    throw new Error('adoption source changed since planning; create a new adoption plan');
  }
  return workspace;
}

function applyProjectAdoptPlan(home, planId) {
  const { plan, path: planPath } = loadPendingPlan(home, planId, 'project-adopt');
  validateProjectAdoptPlan(home, plan);
  const sourcePath = plan.source.path;
  const worksitePath = plan.target.worksite;
  const repositoryPath = plan.target.repository;
  const temporaryPath = path.join(path.dirname(sourcePath), `.${path.basename(sourcePath)}.ks-adopt-${randomUUID()}`);
  let sourceMoved = false;
  try {
    fs.renameSync(sourcePath, temporaryPath);
    sourceMoved = true;
    fs.mkdirSync(worksitePath);
    fs.renameSync(temporaryPath, repositoryPath);
    fs.mkdirSync(plan.target.context, { recursive: true });
    ensureRepositoryIgnored(plan.project);
    writeProjectDescriptor(plan.target.context, plan.project, plan.gitIdentity);
    runGit(worksitePath, ['init']);
    configureGitIdentity(worksitePath, plan.gitIdentity);
    runGit(worksitePath, ['add', '.gitignore', 'ks-context']);
    runGit(worksitePath, ['commit', '-m', `chore: initialize ${plan.project.name} development workspace`]);
    const project = withRegistryLock(home, () => {
      const { file, registry } = readProjects(home);
      if (registry.projects.some((item) => item.id === plan.project.id || item.path === plan.project.path || (item.name === plan.project.name && item.workspace === plan.project.workspace))) {
        throw new Error('project registration changed during adoption; registry was not updated');
      }
      registry.projects.push(plan.project);
      writeJson(file, registry);
      return normalizeProject(plan.project);
    });
    completePlan(planPath, plan);
    return { applied: true, plan, project };
  } catch (error) {
    if (sourceMoved) {
      try {
        if (fs.existsSync(repositoryPath)) fs.renameSync(repositoryPath, temporaryPath);
        fs.rmSync(worksitePath, { recursive: true, force: true });
        if (fs.existsSync(temporaryPath)) fs.renameSync(temporaryPath, sourcePath);
      } catch (rollbackError) {
        throw new Error(`${error.message}; automatic rollback failed: ${rollbackError.message}`);
      }
    }
    throw error;
  }
}

function adoptProject(home, args) {
  if (args.includes('--apply')) {
    return applyProjectAdoptPlan(home, option(args, '--plan', true));
  }
  if (option(args, '--plan') !== undefined) {
    throw new Error('project adopt --plan is only valid together with --apply');
  }
  return { applied: false, plan: savePlan(home, 'project-adopt', projectAdoptPlan(home, args)) };
}

function requireWorksiteProject(home, args) {
  const result = requireProject(home, option(args, '--id', true));
  if (result.project.layout !== 'worksite') {
    throw new Error('this operation requires a project using the worksite layout');
  }
  return { ...result, repoPath: projectRepositoryPath(result.project), contextPath: path.join(result.project.path, 'ks-context') };
}

function planDirectory(home) {
  const directory = path.join(home, 'state', 'plans');
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function savePlan(home, type, payload) {
  const plan = {
    id: `plan_${randomUUID()}`,
    type,
    createdAt: new Date().toISOString(),
    status: 'pending',
    ...payload
  };
  writeJson(path.join(planDirectory(home), `${plan.id}.json`), plan);
  return plan;
}

function loadPendingPlan(home, planId, expectedType) {
  const planPath = path.join(planDirectory(home), `${planId}.json`);
  if (!fs.existsSync(planPath)) throw new Error(`plan does not exist: ${planId}`);
  const plan = readJson(planPath);
  if (plan.type !== expectedType) throw new Error(`plan ${planId} is not a ${expectedType} plan`);
  if (plan.status !== 'pending') throw new Error(`plan is not pending: ${planId}`);
  return { plan, path: planPath };
}

function loadPendingPlanAny(home, planId) {
  const planPath = path.join(planDirectory(home), `${planId}.json`);
  if (!fs.existsSync(planPath)) throw new Error(`plan does not exist: ${planId}`);
  const plan = readJson(planPath);
  if (plan.status !== 'pending') throw new Error(`plan is not pending: ${planId}`);
  return { plan, path: planPath };
}

function completePlan(planPath, plan) {
  plan.status = 'applied';
  plan.appliedAt = new Date().toISOString();
  writeJson(planPath, plan);
}

function versioningPath(project) {
  return path.join(project.path, 'ks-context', 'versioning.yaml');
}

function projectRulesPath(project) {
  return path.join(project.path, 'ks-context', 'project-rules.md');
}

function agentRuleFiles(repoPath) {
  return ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']
    .map((name) => path.join(repoPath, name))
    .filter((filePath) => fs.existsSync(filePath));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function upsertAtomicBlock(filePath, name, content) {
  const start = `<!-- ks:${name}:start -->`;
  const end = `<!-- ks:${name}:end -->`;
  const block = `${start}\n${content}\n${end}`;
  const existing = fs.readFileSync(filePath, 'utf8');
  const expression = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`, 'm');
  fs.writeFileSync(filePath, expression.test(existing) ? existing.replace(expression, block) : `${existing.replace(/\s*$/, '')}\n\n${block}\n`);
}

function removeAtomicBlock(filePath, name) {
  const start = `<!-- ks:${name}:start -->`;
  const end = `<!-- ks:${name}:end -->`;
  const existing = fs.readFileSync(filePath, 'utf8');
  const expression = new RegExp(`\\n?${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, 'm');
  if (expression.test(existing)) fs.writeFileSync(filePath, existing.replace(expression, '\n'));
}

function readVersioning(project) {
  const filePath = versioningPath(project);
  if (!fs.existsSync(filePath)) return null;
  try {
    return { filePath, config: readJson(filePath) };
  } catch (error) {
    return { filePath, error: error.message };
  }
}

function versionStatus(home, args) {
  const { project, repoPath } = requireWorksiteProject(home, args);
  const versioning = readVersioning(project);
  const agentFiles = agentRuleFiles(repoPath);
  const enabled = project.versioning?.enabled;
  let state = 'needs_user_decision';
  if (versioning?.config?.enabled === true) state = 'managed';
  if (!versioning && enabled === false) state = 'unmanaged';
  if (versioning?.error) state = 'invalid';
  return {
    project,
    state,
    versioningFile: versioningPath(project),
    config: versioning?.config || null,
    error: versioning?.error || null,
    agentRuleFiles: agentFiles,
    message: state === 'needs_user_decision'
      ? '项目尚未声明 KS 版本管理策略；请询问用户，优先推荐统一版本。'
      : state === 'unmanaged'
        ? '项目已声明不由 KS 管理版本。'
        : state === 'managed'
          ? '项目由 KS 管理版本。'
          : '版本规则文件无效。'
  };
}

function parseComponents(args, mode, requiredVersion) {
  const entries = args.filter((value, index) => args[index - 1] === '--component');
  if (mode === 'unified') return [{ id: 'project', version: requiredVersion, targets: [] }];
  if (entries.length === 0) throw new Error('--mode independent requires one or more --component <name=version> values');
  return entries.map((entry) => {
    const [id, version] = entry.split('=');
    if (!id || !version) throw new Error('--component must use name=version');
    return { id, version, targets: [] };
  });
}

function versionInitPlan(home, args) {
  const { project, repoPath } = requireWorksiteProject(home, args);
  if (fs.existsSync(versioningPath(project))) throw new Error('versioning is already configured; use ks version plan to change an existing configuration');
  const mode = option(args, '--mode') || 'unified';
  if (!['unified', 'independent'].includes(mode)) throw new Error('--mode must be unified or independent');
  const version = option(args, '--version', true);
  const config = {
    schemaVersion: 1,
    enabled: true,
    mode,
    components: parseComponents(args, mode, version),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  return savePlan(home, 'version-init', {
    projectId: project.id,
    config,
    versioningFile: versioningPath(project),
    agentRuleFiles: agentRuleFiles(repoPath)
  });
}

function versionChangePlan(home, args) {
  const { project, repoPath } = requireWorksiteProject(home, args);
  if (args.includes('--disable')) {
    return savePlan(home, 'version-disable', {
      projectId: project.id,
      versioningFile: versioningPath(project),
      agentRuleFiles: agentRuleFiles(repoPath)
    });
  }
  const existing = readVersioning(project);
  if (!existing?.config) throw new Error('versioning is not configured; use ks version init first');
  const componentId = option(args, '--component', true);
  const nextVersion = option(args, '--set', true);
  const components = existing.config.components.map((component) => component.id === componentId ? { ...component, version: nextVersion } : component);
  if (!existing.config.components.some((component) => component.id === componentId)) throw new Error(`version component does not exist: ${componentId}`);
  return savePlan(home, 'version-change', {
    projectId: project.id,
    config: { ...existing.config, components, updatedAt: new Date().toISOString() },
    versioningFile: versioningPath(project),
    agentRuleFiles: agentRuleFiles(repoPath)
  });
}

function applyVersionPlan(home, args) {
  const planId = option(args, '--plan', true);
  const { plan, path: planPath } = loadPendingPlanAny(home, planId);
  if (!['version-init', 'version-change', 'version-disable'].includes(plan.type)) throw new Error(`plan ${planId} is not a version plan`);
  if (!args.includes('--apply')) return { applied: false, plan };
  const { project, repoPath } = requireWorksiteProject(home, ['--id', plan.projectId]);
  if (plan.versioningFile !== versioningPath(project)) throw new Error('project path changed; create a new version plan');
  if (plan.type === 'version-disable') {
    fs.rmSync(plan.versioningFile, { force: true });
    for (const agentFile of agentRuleFiles(repoPath)) removeAtomicBlock(agentFile, 'versioning');
  } else {
    fs.mkdirSync(path.dirname(plan.versioningFile), { recursive: true });
    writeJson(plan.versioningFile, plan.config);
    for (const agentFile of agentRuleFiles(repoPath)) {
      upsertAtomicBlock(agentFile, 'versioning', 'This project uses KS version management. Read `../ks-context/versioning.yaml` before changing versions or release metadata.');
    }
  }
  withRegistryLock(home, () => {
    const { file, registry } = readProjects(home);
    const current = registry.projects.find((item) => item.id === project.id);
    current.versioning = plan.type === 'version-disable'
      ? { enabled: false, updatedAt: new Date().toISOString() }
      : { enabled: true, file: 'ks-context/versioning.yaml', updatedAt: new Date().toISOString() };
    current.updatedAt = new Date().toISOString();
    writeJson(file, registry);
  });
  completePlan(planPath, plan);
  return { applied: true, plan, status: versionStatus(home, ['--id', project.id]) };
}

function versionCheck(home, args) {
  const status = versionStatus(home, args);
  const checks = [];
  const add = (id, passed, message) => checks.push({ id, passed, message });
  add('state.declared', ['managed', 'unmanaged'].includes(status.state), status.message);
  if (status.state === 'managed') {
    add('config.components', Array.isArray(status.config.components) && status.config.components.length > 0, '版本规则至少需要一个构件。');
    add('config.mode', ['unified', 'independent'].includes(status.config.mode), '版本规则模式必须是 unified 或 independent。');
    const agentReferences = status.agentRuleFiles.map((filePath) => fs.readFileSync(filePath, 'utf8').includes('<!-- ks:versioning:start -->'));
    add('agent.references', agentReferences.every(Boolean), status.agentRuleFiles.length === 0 ? '没有可注入的现有 Agent 规则文件。' : '现有 Agent 规则文件必须包含版本规则入口。');
  }
  return { ...status, compliant: checks.every((check) => check.passed), checks };
}

function projectRulesStatus(home, args) {
  const { project, repoPath } = requireWorksiteProject(home, args);
  const filePath = projectRulesPath(project);
  const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
  const ruleIds = content ? [...content.matchAll(/^## Rule: (.+)$/gm)].map((match) => match[1]) : [];
  return { project, rulesFile: filePath, exists: Boolean(content), ruleIds, agentRuleFiles: agentRuleFiles(repoPath) };
}

function projectRulesPropose(home, args, action = 'add') {
  const { project, repoPath } = requireWorksiteProject(home, args);
  const ruleId = option(args, '--rule', true);
  const title = option(args, '--title') || ruleId;
  const text = action === 'add' ? option(args, '--text', true) : null;
  const current = projectRulesStatus(home, ['--id', project.id]);
  if (action === 'add' && current.ruleIds.includes(ruleId)) throw new Error(`project rule already exists: ${ruleId}`);
  if (action === 'remove' && !current.ruleIds.includes(ruleId)) throw new Error(`project rule does not exist: ${ruleId}`);
  return savePlan(home, `project-rules-${action}`, {
    projectId: project.id,
    rule: { id: ruleId, title, text },
    rulesFile: projectRulesPath(project),
    agentRuleFiles: agentRuleFiles(repoPath)
  });
}

function applyProjectRulesPlan(home, args) {
  const planId = option(args, '--plan', true);
  const planInfo = loadPendingPlanAny(home, planId);
  const { plan, path: planPath } = planInfo;
  if (!['project-rules-add', 'project-rules-remove'].includes(plan.type)) throw new Error(`plan ${planId} is not a project rules plan`);
  if (!args.includes('--apply')) return { applied: false, plan };
  const { project, repoPath } = requireWorksiteProject(home, ['--id', plan.projectId]);
  const rulesPath = projectRulesPath(project);
  let content = fs.existsSync(rulesPath) ? fs.readFileSync(rulesPath, 'utf8') : '# Project Development Rules\n';
  const expression = new RegExp(`\\n?## Rule: ${escapeRegExp(plan.rule.id)}\\n[\\s\\S]*?(?=\\n## Rule: |$)`, 'm');
  if (plan.type === 'project-rules-add') content = `${content.replace(/\s*$/, '')}\n\n## Rule: ${plan.rule.id}\n\n${plan.rule.text}\n`;
  else content = content.replace(expression, '\n').replace(/\n{3,}/g, '\n\n');
  fs.mkdirSync(path.dirname(rulesPath), { recursive: true });
  fs.writeFileSync(rulesPath, content);
  const agentFiles = agentRuleFiles(repoPath);
  if (plan.type === 'project-rules-add' || projectRulesStatus(home, ['--id', project.id]).ruleIds.length > 0) {
    for (const agentFile of agentFiles) upsertAtomicBlock(agentFile, 'project-rules', 'This project has persistent development rules. Read `../ks-context/project-rules.md` before making project changes.');
  } else {
    for (const agentFile of agentFiles) removeAtomicBlock(agentFile, 'project-rules');
  }
  completePlan(planPath, plan);
  return { applied: true, plan, status: projectRulesStatus(home, ['--id', project.id]) };
}

function projectRulesCheck(home, args) {
  const status = projectRulesStatus(home, args);
  const checks = [];
  const add = (id, passed, message) => checks.push({ id, passed, message });
  add('rules.file', status.exists, status.exists ? '项目元规则文件存在。' : '项目尚未沉淀元规则。');
  if (status.exists) {
    const agentReferences = status.agentRuleFiles.map((filePath) => fs.readFileSync(filePath, 'utf8').includes('<!-- ks:project-rules:start -->'));
    add('agent.references', agentReferences.every(Boolean), status.agentRuleFiles.length === 0 ? '没有可注入的现有 Agent 规则文件。' : '现有 Agent 规则文件必须包含元规则入口。');
  }
  return { ...status, compliant: checks.every((check) => check.passed), checks };
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }
  const json = args.includes('--json');

  const home = resolveKsHome(args);
  if (command === 'init') {
    printResult({ ok: true, initialized: initialize(home), home }, json);
    return;
  }

  if (command === 'workspace' && args[1] === 'add') {
    printResult({ ok: true, workspace: addWorkspace(home, args) }, json);
    return;
  }

  if (command === 'workspace' && args[1] === 'list') {
    printResult({ ok: true, workspaces: listWorkspaces(home) }, true);
    return;
  }

  if (command === 'spark' && args[1] === 'configure') {
    printResult({ ok: true, ...configureSparkDirectory(home, args) }, true);
    return;
  }

  if (command === 'spark' && args[1] === 'list') {
    printResult({ ok: true, ...listSparks(home) }, true);
    return;
  }

  if (command === 'spark' && args[1] === 'find') {
    printResult({ ok: true, ...findSparks(home, args) }, true);
    return;
  }

  if (command === 'spark' && args[1] === 'inspect') {
    printResult({ ok: true, ...inspectSpark(home, args) }, true);
    return;
  }

  if (command === 'spark' && args[1] === 'create') {
    printResult({ ok: true, ...createSpark(home, args) }, true);
    return;
  }

  if (command === 'spark' && args[1] === 'append-section') {
    printResult({ ok: true, ...appendSparkSection(home, args) }, true);
    return;
  }

  if (command === 'spark' && args[1] === 'check') {
    printResult({ ok: true, ...checkSpark(home, args) }, true);
    return;
  }

  if (command === 'project' && args[1] === 'create') {
    printResult({ ok: true, project: createProject(home, args) }, json);
    return;
  }

  if (command === 'project' && args[1] === 'register') {
    printResult({ ok: true, project: registerProject(home, args) }, json);
    return;
  }

  if (command === 'project' && args[1] === 'update') {
    printResult({ ok: true, project: updateProject(home, args) }, json);
    return;
  }

  if (command === 'project' && args[1] === 'list') {
    printResult({ ok: true, projects: listProjects(home, args) }, true);
    return;
  }

  if (command === 'project' && args[1] === 'search') {
    printResult({ ok: true, ...searchProjects(home, args) }, true);
    return;
  }

  if (command === 'project' && args[1] === 'tag' && args[2] === 'add') {
    printResult({ ok: true, ...projectTag(home, args, 'add') }, true);
    return;
  }

  if (command === 'project' && args[1] === 'tag' && args[2] === 'remove') {
    printResult({ ok: true, ...projectTag(home, args, 'remove') }, true);
    return;
  }

  if (command === 'project' && args[1] === 'tag' && args[2] === 'list') {
    printResult({ ok: true, ...projectTags(home, args) }, true);
    return;
  }

  if (command === 'project' && args[1] === 'alias' && args[2] === 'add') {
    printResult({ ok: true, ...projectAlias(home, args, 'add') }, true);
    return;
  }

  if (command === 'project' && args[1] === 'alias' && args[2] === 'remove') {
    printResult({ ok: true, ...projectAlias(home, args, 'remove') }, true);
    return;
  }

  if (command === 'project' && args[1] === 'alias' && args[2] === 'list') {
    printResult({ ok: true, ...projectAliases(home, args) }, true);
    return;
  }

  if (command === 'project' && args[1] === 'describe') {
    printResult({ ok: true, ...describeProject(home, args) }, true);
    return;
  }

  if (command === 'project' && args[1] === 'lifecycle' && args[2] === 'set') {
    printResult({ ok: true, ...setProjectLifecycle(home, args) }, true);
    return;
  }

  if (command === 'project' && args[1] === 'inspect') {
    printResult({ ok: true, ...inspectProject(home, args) }, true);
    return;
  }

  if (command === 'project' && args[1] === 'resolve') {
    printResult({ ok: true, ...resolveProject(home, args) }, true);
    return;
  }

  if (command === 'project' && args[1] === 'check') {
    printResult({ ok: true, ...checkProject(home, args) }, true);
    return;
  }

  if (command === 'project' && args[1] === 'migrate') {
    printResult({ ok: true, ...migrateProject(home, args) }, true);
    return;
  }

  if (command === 'project' && args[1] === 'adopt') {
    printResult({ ok: true, ...adoptProject(home, args) }, true);
    return;
  }

  if (command === 'coordination' && args[1] === 'open') {
    printResult({ ok: true, ...openCoordination(home, args) }, true);
    return;
  }

  if (command === 'coordination' && (args[1] === 'find' || args[1] === 'resume')) {
    printResult({ ok: true, ...findCoordination(home, args) }, true);
    return;
  }

  if (command === 'coordination' && args[1] === 'archive') {
    printResult({ ok: true, ...archiveCoordination(home, args) }, true);
    return;
  }

  if (command === 'chat-room' && args[1] === 'open') {
    printResult({ ok: true, ...openChatRoom(home, args) }, true);
    return;
  }

  if (command === 'chat-room' && args[1] === 'append') {
    printResult({ ok: true, ...appendChatRoom(home, args) }, true);
    return;
  }

  if (command === 'chat-room' && args[1] === 'archive') {
    printResult({ ok: true, ...archiveChatRoom(home, args) }, true);
    return;
  }

  if (command === 'chat-room' && args[1] === 'split') {
    printResult({ ok: true, ...splitChatRoom(home, args) }, true);
    return;
  }

  if (command === 'version' && args[1] === 'status') {
    printResult({ ok: true, ...versionStatus(home, args) }, true);
    return;
  }

  if (command === 'version' && args[1] === 'check') {
    printResult({ ok: true, ...versionCheck(home, args) }, true);
    return;
  }

  if (command === 'version' && args[1] === 'init') {
    if (args.includes('--apply')) throw new Error('version init creates a plan only; run ks version apply --plan <plan-id> --apply after review');
    printResult({ ok: true, applied: false, plan: versionInitPlan(home, args) }, true);
    return;
  }

  if (command === 'version' && args[1] === 'plan') {
    printResult({ ok: true, applied: false, plan: versionChangePlan(home, args) }, true);
    return;
  }

  if (command === 'version' && args[1] === 'apply') {
    printResult({ ok: true, ...applyVersionPlan(home, args) }, true);
    return;
  }

  if (command === 'project' && args[1] === 'rules' && args[2] === 'status') {
    printResult({ ok: true, ...projectRulesStatus(home, args) }, true);
    return;
  }

  if (command === 'project' && args[1] === 'rules' && args[2] === 'check') {
    printResult({ ok: true, ...projectRulesCheck(home, args) }, true);
    return;
  }

  if (command === 'project' && args[1] === 'rules' && args[2] === 'propose') {
    printResult({ ok: true, applied: false, plan: projectRulesPropose(home, args) }, true);
    return;
  }

  if (command === 'project' && args[1] === 'rules' && args[2] === 'remove') {
    printResult({ ok: true, applied: false, plan: projectRulesPropose(home, args, 'remove') }, true);
    return;
  }

  if (command === 'project' && args[1] === 'rules' && args[2] === 'apply') {
    printResult({ ok: true, ...applyProjectRulesPlan(home, args) }, true);
    return;
  }

  throw new Error('Usage: ks init | ks workspace <add|list> | ks project <create|register|update|list|search|tag|alias|describe|lifecycle|inspect|resolve|check|migrate|adopt|rules> | ks coordination <open|find|resume|archive> | ks chat-room <open|append|archive|split> | ks version <status|init|check|plan|apply> [--home <path>] [--json]');
}

try {
  main();
} catch (error) {
  process.stderr.write(`ks: ${error.message}\n`);
  process.exitCode = 1;
}
