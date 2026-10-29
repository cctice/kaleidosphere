#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const zlib = require('node:zlib');
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
  return { title: read('title'), date: read('date'), scope: read('scope'), source: read('source') };
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
        source: metadata.source || null,
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

// ── 插件契约（维护包四轮：双形态收敛为单一规范）────────────────────────────
// 规范（canonical contract）：plugin.json 的 skills 字段必须是目录引用字符串 './skills/'。
// 历史双形态（skills 数组逐项列目录）不再作为并列契约——装载侧统一经
// normalizePluginContract 归一化并打 normalized 标记，新插件一律按规范书写，
// 每接一个插件不再各付一次桥适配税。
const CANONICAL_SKILLS_FORM = './skills/';

function bundledPluginsDirectory() {
  return path.join(__dirname, '..', 'plugins');
}

function installedPluginsDirectory(home) {
  return path.join(home, 'plugins');
}

function discoverPlugins(home) {
  const roots = [
    { source: 'bundled', dir: bundledPluginsDirectory() },
    { source: 'installed', dir: installedPluginsDirectory(home) }
  ];
  const found = [];
  for (const { source, dir } of roots) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(dir, entry.name, 'plugin.json');
      if (!fs.existsSync(manifestPath)) continue;
      found.push({ source, name: entry.name, dir: path.join(dir, entry.name), manifestPath });
    }
  }
  return found;
}

/** 契约校验+归一化：字段完整性 → skills 双形态归一 → skills 目录与 SKILL.md 实存 */
function inspectPluginContract(manifestPath, pluginDir) {
  const issues = [];
  let manifest = null;
  try {
    manifest = readJson(manifestPath);
  } catch (error) {
    return { name: path.basename(pluginDir), passed: false, normalized: false, skills: null, issues: [`plugin.json 无法解析：${error.message}`] };
  }
  if (!manifest.name || typeof manifest.name !== 'string') issues.push('plugin.json 缺少合法 name 字段');
  if (!manifest.version || typeof manifest.version !== 'string') issues.push('plugin.json 缺少合法 version 字段');

  let skills = manifest.skills;
  let normalized = false;
  if (skills === CANONICAL_SKILLS_FORM) {
    // 规范形态，直接通过
  } else if (Array.isArray(skills) && skills.length > 0 && skills.every((item) => typeof item === 'string' && item.startsWith('./skills/'))) {
    skills = CANONICAL_SKILLS_FORM;
    normalized = true;
  } else {
    issues.push(`skills 字段必须是目录引用 '${CANONICAL_SKILLS_FORM}'（历史数组形态会被装载侧归一化；缺失/空数组/其他取值即违约）`);
  }
  const skillsDir = path.join(pluginDir, 'skills');
  if (Array.isArray(manifest.skills) || manifest.skills === CANONICAL_SKILLS_FORM) {
    if (!fs.existsSync(skillsDir)) issues.push(`声明的 skills 目录不存在：${skillsDir}`);
  }
  return { name: manifest.name || path.basename(pluginDir), version: manifest.version || null, passed: issues.length === 0, normalized, skills, source: null, issues };
}

function listPlugins(home) {
  return discoverPlugins(home).map(({ source, dir, manifestPath }) => ({
    ...inspectPluginContract(manifestPath, dir),
    source,
    dir
  }));
}

function checkPlugins(home) {
  const plugins = listPlugins(home).map(({ source, dir, ...report }) => ({ ...report, source, dir, remediation: report.passed ? null : '按 canonical 契约修正 plugin.json（skills: "./skills/"），并保证 skills/ 下至少一个含 SKILL.md 的技能目录' }));
  return { compliant: plugins.every((plugin) => plugin.passed), count: plugins.length, plugins };
}

// ── workflow 桥（维护包四轮：P1 深集成——ks 数据注入 bundled afk 引擎）─────
// 一次性 handoff：不自动开流（blueprint 约束），只产出指向 plugins/afk 的
// 转交提示，并把 registry 里的项目元数据（名称/路径/摘要/标签/生命周期）随行注入，
// afk 不再停留在与 ks 数据隔离的 bundled 内置形态。
function workflowRun(home, args) {
  const task = option(args, '--task', true).trim();
  if (!task) throw new Error('--task must not be empty');
  const { project } = requireProject(home, coordinationProjectId(args));
  const engine = { name: 'afk', skill: 'afk-flow', dir: path.join(bundledPluginsDirectory(), 'afk') };
  const skillEntry = path.join(engine.dir, 'skills', 'afk-flow', 'SKILL.md');
  if (!fs.existsSync(skillEntry)) {
    throw new Error(`bundled afk engine skill is missing: ${skillEntry}`);
  }
  const context = {
    project: { id: project.id, name: project.name, path: project.path, summary: project.summary, tags: project.tags, lifecycle: project.lifecycle },
    task
  };
  const prompt = [
    `Use the afk-flow skill (${skillEntry}) to route this task through requirement, design, implementation, verification and delivery.`,
    `Project: ${project.name} (${project.id}) at ${project.path}`,
    project.summary ? `Summary: ${project.summary}` : null,
    project.tags.length > 0 ? `Tags: ${project.tags.join(', ')}` : null,
    `Lifecycle: ${project.lifecycle}`,
    `Task: ${task}`
  ].filter(Boolean).join('\n');
  return { engine, skillEntry, context, prompt, handoff: 'one-shot', autoStart: false };
}

// ── 四大能力支柱状态面板（维护包四轮）────────────────────────────────────
// blueprint 四支柱：项目管理 / 版本管理 / 规则沉淀 / 执行协调。
// 统一面板 + 新用户引导动线：缺什么就给下一条 ks 命令，不藏着掖着。
function pillarStates(home) {
  const initialized = fs.existsSync(path.join(home, 'registry', 'projects.json'));
  const workspaces = initialized ? listWorkspaces(home) : [];
  const projects = initialized ? listProjects(home) : [];
  const byLifecycle = { active: 0, paused: 0, archived: 0 };
  for (const project of projects) byLifecycle[project.lifecycle] += 1;
  const versioningManaged = projects.filter((project) => project.versioning?.enabled === true).length;
  const rulesManaged = projects.filter((project) => project.layout === 'worksite' && fs.existsSync(projectRulesPath(project))).length;
  let coordination = { active: 0, units: 0, rooms: 0 };
  if (initialized && fs.existsSync(coordinationStatePath(home))) {
    const { state } = readCoordinationState(home);
    const active = state.coordinations.filter((item) => item.status === 'active');
    coordination = {
      active: active.length,
      units: active.reduce((sum, item) => sum + item.units.filter((unit) => unit.status === 'active').length, 0),
      rooms: active.reduce((sum, item) => sum + item.rooms.filter((room) => room.status === 'active').length, 0)
    };
  }
  const sparksConfigured = initialized && fs.existsSync(path.join(home, 'registry', 'sparks.json')) && Boolean(readJson(path.join(home, 'registry', 'sparks.json')).directory);
  return {
    pillars: [
      { id: 'project', summary: `${workspaces.length} workspaces / ${projects.length} projects（active ${byLifecycle.active} · paused ${byLifecycle.paused} · archived ${byLifecycle.archived}）`, state: projects.length > 0 ? 'ready' : workspaces.length > 0 ? 'partial' : 'empty' },
      { id: 'versioning', summary: `${versioningManaged}/${projects.length} projects 由 KS 管理版本`, state: versioningManaged > 0 ? 'ready' : 'empty' },
      { id: 'rules', summary: `${rulesManaged}/${projects.length} projects 沉淀了元规则`, state: rulesManaged > 0 ? 'ready' : 'empty' },
      { id: 'coordination', summary: `active ${coordination.active} / units ${coordination.units} / rooms ${coordination.rooms}`, state: coordination.active > 0 ? 'ready' : 'empty' }
    ],
    sparksConfigured,
    initialized
  };
}

function ksStatus(home) {
  const view = pillarStates(home);
  const nextSteps = [];
  if (!view.initialized) {
    nextSteps.push({ step: 1, command: 'ks init', why: '初始化用户级注册表（KS 状态的唯一读写边界）' });
  } else {
    const projects = listProjects(home);
    if (listWorkspaces(home).length === 0) nextSteps.push({ step: nextSteps.length + 1, command: 'ks workspace add --id <id> --path <dir>', why: '登记第一个工作空间' });
    if (projects.length === 0) nextSteps.push({ step: nextSteps.length + 1, command: 'ks project create --workspace <id> --name <kebab-name>', why: '在登记的工作空间里创建第一个项目' });
    if (!view.sparksConfigured) nextSteps.push({ step: nextSteps.length + 1, command: 'ks spark configure --path <dir>', why: '配置火花目录，启用灵感捕获' });
    if (!projects.some((project) => project.versioning?.enabled === true)) nextSteps.push({ step: nextSteps.length + 1, command: 'ks version init --id <project-id> --version <semver>', why: '为首个项目声明版本管理策略' });
    if (view.pillars.find((pillar) => pillar.id === 'coordination').state === 'empty') nextSteps.push({ step: nextSteps.length + 1, command: 'ks coordination open --project-id <id> --anchor-source <src> --anchor-id <id> --scope-key <key>', why: '复杂任务先立执行协调单元' });
  }
  // 转动提醒闭环（维护包八轮）：route 依赖手动调用，"该转下一块玻璃时没人喊"。
  // status 从 rotation.json 真源读数：多活跃项目 + 停转超过阈值（KS_ROUTE_REMIND_DAYS，
  // 默认 3 天，0 关闭）即在 reminders 面点名 ks route——提醒挂在状态面，不混入 onboarding。
  let rotation = null;
  const reminders = [];
  if (view.initialized) {
    const projects = listProjects(home);
    const active = projects.filter((project) => project.lifecycle === 'active');
    const history = readRotationState(home).state.history || [];
    const lastRoutedAt = history.length ? history[history.length - 1].routedAt : null;
    const idleDays = lastRoutedAt ? Math.floor((Date.now() - Date.parse(lastRoutedAt)) / 86_400_000) : null;
    const remindAfterDays = Number(process.env.KS_ROUTE_REMIND_DAYS ?? 3);
    const due = active.length > 1 && remindAfterDays > 0 && (idleDays === null || idleDays >= remindAfterDays);
    rotation = { activeProjects: active.length, lastRoutedAt, idleDays, remindAfterDays, due };
    if (due) {
      reminders.push({ command: 'ks route', why: `${active.length} 个活跃项目停转 ${idleDays === null ? '从未转动' : `${idleDays} 天`}（阈值 ${remindAfterDays} 天）——该换下一块玻璃了` });
    }
  }
  return { pillars: view.pillars, sparksConfigured: view.sparksConfigured, rotation, reminders, onboarding: { complete: nextSteps.length === 0, nextSteps } };
}

// ── 插件市场接线（维护包四轮：P4 支柱对接 workflow-party 清单）──────────────
// 读 workflow-party 形态的 marketplace.json（本地路径或 https URL），
// 逐条校验条目契约（name/version/source），本地 source 顺带过插件契约检查。
// 发现缓存（维护包六轮）：本地源按指纹（mtimeNs+size）即时失效、远端源按 TTL，
// --refresh 强制穿透——发布新版插件不再等 TTL 自然过期，文件一变立即重读。
const MARKET_CACHE_TTL_MS = 5 * 60 * 1000;

function marketCacheFile(home, source) {
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 24);
  return path.join(home, 'state', 'market-cache', `${digest}.json`);
}

function localManifestFingerprint(file) {
  const stats = fs.statSync(file);
  // mtimeMs 亚毫秒浮点（mtimeNs 在部分 Node 构建缺失），配 size 双信号
  return { mtimeMs: String(stats.mtimeMs), size: stats.size };
}

function readMarketCache(cacheFile) {
  if (!fs.existsSync(cacheFile)) return null;
  try {
    const cached = readJson(cacheFile);
    return cached && cached.source !== undefined ? cached : null; // 坏记录当 miss，不许倒
  } catch {
    return null;
  }
}

function fingerprintMatches(left, right) {
  return Boolean(left && right && left.mtimeMs === right.mtimeMs && left.size === right.size);
}

/** 清单装载（list/install/upgrade 共用）：来源解析+缓存，返回原始 manifest 与基目录 */
async function loadMarketManifest(home, source, { refresh = false } = {}) {
  const cacheFile = marketCacheFile(home, source);
  const cached = refresh ? null : readMarketCache(cacheFile);
  let manifest;
  let manifestOrigin;
  let manifestFingerprint = null;
  let resolvedBaseDir = null;
  let cacheHit = false;
  if (/^https:\/\//.test(source)) {
    manifestOrigin = 'https';
    const fresh = cached && cached.origin === 'https' && Date.now() - Date.parse(cached.fetchedAt) < MARKET_CACHE_TTL_MS;
    if (fresh) {
      manifest = cached.manifest;
      cacheHit = true;
    } else {
      let response;
      try {
        response = await fetch(source);
      } catch (error) {
        throw new Error(`marketplace fetch failed: ${error.message} (${source})`);
      }
      if (!response.ok) throw new Error(`marketplace fetch failed: ${response.status} ${source}`);
      manifest = await response.json();
    }
  } else {
    manifestOrigin = 'local';
    let manifestPath = path.resolve(source);
    resolvedBaseDir = path.dirname(manifestPath);
    if (fs.existsSync(manifestPath) && fs.statSync(manifestPath).isDirectory()) {
      resolvedBaseDir = manifestPath;
      manifestPath = [path.join(manifestPath, '.claude-plugin', 'marketplace.json'), path.join(manifestPath, 'marketplace.json')].find((candidate) => fs.existsSync(candidate));
      if (!manifestPath) throw new Error(`marketplace manifest not found under: ${source}`);
    }
    if (!fs.existsSync(manifestPath)) throw new Error(`marketplace manifest does not exist: ${manifestPath}`);
    manifestFingerprint = localManifestFingerprint(manifestPath);
    if (cached && cached.origin === 'local' && fingerprintMatches(cached.fingerprint, manifestFingerprint)) {
      manifest = cached.manifest;
      cacheHit = true;
    } else {
      manifest = readJson(manifestPath);
    }
  }
  if (!Array.isArray(manifest.plugins)) throw new Error('marketplace manifest missing plugins array');
  if (!cacheHit || refresh) {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    writeJson(cacheFile, { schemaVersion: SCHEMA_VERSION, source, origin: manifestOrigin, fetchedAt: new Date().toISOString(), fingerprint: manifestFingerprint, manifest });
  }
  return { manifest, origin: manifestOrigin, resolvedBaseDir, cacheHit, refreshed: refresh };
}

async function marketList(home, args) {
  const source = option(args, '--source', true);
  const refresh = args.includes('--refresh');
  const { manifest, resolvedBaseDir, cacheHit } = await loadMarketManifest(home, source, { refresh });
  const entries = manifest.plugins.map((entry) => {
    const issues = [];
    if (!entry.name || typeof entry.name !== 'string') issues.push('entry missing name');
    if (!entry.version || typeof entry.version !== 'string') issues.push(`entry ${entry.name || '<unnamed>'} missing version`);
    if (!entry.source || typeof entry.source !== 'string') issues.push(`entry ${entry.name || '<unnamed>'} missing source`);
    let local = null;
    if (resolvedBaseDir && entry.source && !/^https?:\/\//.test(entry.source)) {
      const pluginDir = path.resolve(resolvedBaseDir, entry.source);
      const manifestPath = path.join(pluginDir, 'plugin.json');
      if (fs.existsSync(manifestPath)) local = { ...inspectPluginContract(manifestPath, pluginDir), dir: pluginDir };
      else issues.push(`local source has no plugin.json: ${pluginDir}`);
    }
    return { name: entry.name || null, version: entry.version || null, category: entry.category || null, source: entry.source || null, integrity: entry.integrity || null, local, issues };
  });
  // 已装标记（八轮）：list 与 install/upgrade 生命周期同源读 state/installed.json
  const installedState = readInstalledState(home);
  for (const entry of entries) {
    const installed = installedState[entry.name];
    entry.installed = installed ? (installed.version === entry.version ? 'current' : `stale(${installed.version})`) : false;
  }
  return { market: manifest.name || null, owner: manifest.owner?.name || null, source, count: entries.length, plugins: entries, allValid: entries.every((entry) => entry.issues.length === 0), cache: { hit: cacheHit, refreshed: refresh } };
}

// ── 市场安装/升级生命周期（维护包八轮）─────────────────────────────────────
// market list 只读了三轮：发现之后仍要人装。本轮补 install/upgrade：
//   - 安装=验指纹（市场 integrity ↔ 产物实文件 sha256，wfp 台账的消费侧闭合）
//     → 解包过 canonical 插件契约 → 落 home/plugins/<name>/ → state/installed.json
//     记档（版本/来源/指纹/时刻），plugin list 立即可见（discoverPlugins 同目录）；
//   - 升级=读 installed.json 对照市场版本：同版如实 upToDate、低版如实拒绝、
//     高版走同一验证链替换；
//   - 诚实边界：https 市场与远端 source 的产物拉取通道不在本轮（本地市场先通），
//     不装半截。
function sha256File(file) {
  return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function installedStateFile(home) {
  return path.join(home, 'state', 'installed.json');
}

function readInstalledState(home) {
  try {
    const state = readJson(installedStateFile(home));
    return state && typeof state === 'object' ? state : {};
  } catch {
    return {};
  }
}

function writeInstalledState(home, state) {
  return withStateLock(home, 'installed', () => writeJson(installedStateFile(home), state));
}

/** 解 tar.gz（package/ 根形态）到 destDir；路径逃逸与缺 plugin.json 直接抛 */
function extractPluginTarball(tgzPath, destDir) {
  const buf = zlib.gunzipSync(fs.readFileSync(tgzPath));
  fs.mkdirSync(destDir, { recursive: true });
  let offset = 0;
  let sawPluginManifest = false;
  const written = [];
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    const typeFlag = String.fromCharCode(header[156]);
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim() || '0', 8);
    offset += 512;
    const data = buf.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (typeFlag !== '0' && typeFlag !== '\0' && typeFlag !== '5') continue; // 只认文件与目录
    const name = prefix ? `${prefix}/${rawName}` : rawName;
    const rel = name.replace(/^[^/]+\//, ''); // 剥 package/ 根
    if (!rel || rel === '.') continue;
    const dest = path.join(destDir, rel);
    if (!path.resolve(dest).startsWith(path.resolve(destDir) + path.sep)) {
      throw new Error(`tar entry escapes destination: ${name}`);
    }
    if (typeFlag === '5') {
      fs.mkdirSync(dest, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    written.push(rel);
    if (rel === 'plugin.json') sawPluginManifest = true;
  }
  if (!sawPluginManifest) throw new Error('tarball has no package/plugin.json — not a plugin-form artifact');
  return written;
}

/** semver 数值比较：1.10.0 > 1.9.0（按段，缺段补 0） */
function compareVersions(left, right) {
  const parse = (v) => String(v || '').split('.').map((part) => parseInt(part, 10) || 0);
  const [a, b] = [parse(left), parse(right)];
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

/** 验证+解包+落位共用链：install 与 upgrade 同一条验证路径，不各说各话 */
async function installMarketPlugin(home, source, name, { refresh = false, force = false } = {}) {
  const { manifest, origin, resolvedBaseDir } = await loadMarketManifest(home, source, { refresh });
  const entry = (manifest.plugins || []).find((plugin) => plugin.name === name);
  if (!entry) {
    throw new Error(`market has no plugin '${name}' (available: ${(manifest.plugins || []).map((plugin) => plugin.name).join(', ') || 'none'})`);
  }
  if (origin === 'https' || /^https?:\/\//.test(entry.source)) {
    throw new Error(`install requires a local marketplace source (https artifact fetch is not wired yet); refusing half-install of ${name}`);
  }
  const artifact = path.resolve(resolvedBaseDir, entry.source, 'resources', `${name}-${entry.version}.tgz`);
  if (!fs.existsSync(artifact)) {
    throw new Error(`artifact not found: ${artifact}（市场源先重建产物：npm run rebuild:artifacts）`);
  }
  // 完整性闸门：市场 integrity ↔ 产物实指纹（wfp provenance 链的消费侧闭合）
  const actual = sha256File(artifact);
  const integrityVerified = Boolean(entry.integrity);
  if (entry.integrity && actual !== entry.integrity) {
    throw new Error(`integrity mismatch for ${name}@${entry.version}: manifest ${entry.integrity} != artifact ${actual} — refusing to install`);
  }
  // 解包到临时区过契约，坏了不落 home
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-install-'));
  try {
    extractPluginTarball(artifact, stage);
    const contract = inspectPluginContract(path.join(stage, 'plugin.json'), stage);
    if (!contract.passed) {
      throw new Error(`artifact fails canonical plugin contract: ${contract.issues.join('; ')}`);
    }
    const dest = path.join(installedPluginsDirectory(home), name);
    const state = readInstalledState(home);
    const prior = state[name];
    if (prior && prior.version === entry.version && !force) {
      throw new Error(`${name}@${entry.version} already installed (use --force to reinstall, or 'ks market upgrade ${name}')`);
    }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(stage, dest, { recursive: true });
    state[name] = {
      version: entry.version,
      marketSource: source,
      artifact: path.relative(resolvedBaseDir, artifact),
      integrity: entry.integrity || null,
      contentSha256: actual,
      integrityVerified,
      installedAt: new Date().toISOString(),
      dir: dest
    };
    writeInstalledState(home, state);
    return {
      ok: true,
      name,
      version: entry.version,
      installedVersion: prior ? prior.version : null,
      dir: dest,
      integrityVerified,
      contentSha256: actual,
      skills: contract.skills
    };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

async function marketInstall(home, args) {
  const name = args[2];
  if (!name) throw new Error('usage: ks market install <name> --source <path> [--refresh] [--force]');
  return installMarketPlugin(home, option(args, '--source', true), name, {
    refresh: args.includes('--refresh'),
    force: args.includes('--force')
  });
}

async function marketUpgrade(home, args) {
  const name = args[2];
  if (!name) throw new Error('usage: ks market upgrade <name> --source <path> [--refresh]');
  const prior = readInstalledState(home)[name];
  if (!prior) throw new Error(`${name} is not installed (start with: ks market install ${name} --source <path>)`);
  const { manifest, resolvedBaseDir } = await loadMarketManifest(home, option(args, '--source', true), {
    refresh: args.includes('--refresh')
  });
  const entry = (manifest.plugins || []).find((plugin) => plugin.name === name);
  if (!entry) throw new Error(`market has no plugin '${name}' anymore (was installed from ${prior.marketSource})`);
  const comparison = compareVersions(entry.version, prior.version);
  if (comparison === 0) {
    return { ok: true, upToDate: true, name, version: prior.version, note: '市场与已装同版，无事可做' };
  }
  if (comparison < 0) {
    throw new Error(`market version ${entry.version} is older than installed ${prior.version}（市场源指向旧市场？升级拒绝降级）`);
  }
  const result = await installMarketPlugin(home, option(args, '--source', true), name, { force: true });
  return { ...result, upgraded: true, from: prior.version, to: entry.version, marketDir: resolvedBaseDir };
}

// ── 转动路由（维护包四轮：多项目轮转的最短路径）───────────────────────────
// least-recently-routed 选择 + 状态记档：反复 ks route 即在活跃项目间转动，
// 单字符短命令形态为快捷键/别名与移动端壳复用同一入口。
// 并发写保护（维护包六轮）：rotation.json 读-改-写与 registry 同样吃多会话并发，
// 独占锁 + 有限重试 + 陈锁接管（KS_STATE_LOCK_TIMEOUT_MS 可调，崩溃残留不卡死）。
const STATE_LOCK_STALE_MS = 30 * 1000;

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function withStateLock(home, name, callback) {
  const lockPath = path.join(home, 'state', `${name}.lock`);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const timeoutMs = Number(process.env.KS_STATE_LOCK_TIMEOUT_MS || 2000);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let descriptor;
    try {
      descriptor = fs.openSync(lockPath, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const lockAgeMs = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (lockAgeMs > STATE_LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue; // 陈锁接管：进程崩溃残留不卡死后续操作
        }
      } catch (statError) {
        if (statError.code === 'ENOENT') continue; // 持锁者刚释放，立即重试
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error(`state ${name} is busy (lock held); retry after the active KS operation finishes`);
      sleepSync(50);
      continue;
    }
    try {
      return callback();
    } finally {
      fs.closeSync(descriptor);
      fs.rmSync(lockPath, { force: true });
    }
  }
}

function rotationStatePath(home) {
  return path.join(home, 'state', 'rotation.json');
}

function readRotationState(home) {
  const file = rotationStatePath(home);
  if (!fs.existsSync(file)) return { file, state: { schemaVersion: SCHEMA_VERSION, history: [] } };
  return { file, state: readJson(file) };
}

function ksRoute(home, args) {
  const tags = options(args, '--tag').map(validateProjectTag);
  const lifecycle = option(args, '--lifecycle') || 'active';
  validateProjectLifecycle(lifecycle);
  const candidates = listProjects(home, args).filter((project) => project.lifecycle === lifecycle);
  if (candidates.length === 0) {
    throw new Error(`no ${lifecycle} projects to route to${tags.length ? ` with tags: ${tags.join(',')}` : ''}; register projects or relax the filter`);
  }
  const outcome = withStateLock(home, 'rotation', () => {
    const { file, state } = readRotationState(home);
    const lastRoutedAt = new Map();
    for (const record of state.history || []) lastRoutedAt.set(record.projectId, record.routedAt);
    const ranked = [...candidates].sort((left, right) => {
      const leftAt = lastRoutedAt.get(left.id) || '';
      const rightAt = lastRoutedAt.get(right.id) || '';
      return leftAt.localeCompare(rightAt) || left.createdAt.localeCompare(right.createdAt);
    });
    const selected = ranked[0];
    state.history = [...(state.history || []).filter((record) => record.projectId !== selected.id), { projectId: selected.id, routedAt: new Date().toISOString() }].slice(-50);
    writeJson(file, state);
    const upcoming = ranked.slice(1, 3).map((project) => project.name);
    return { selected, upcoming, historySize: state.history.length };
  });
  return { project: outcome.selected, rotated: candidates.length > 1, upcoming: outcome.upcoming, historySize: outcome.historySize };
}

// ── 灵感捕获外部源通道（维护包四轮）──────────────────────────────────────
// 火花不再只来自手写文件：im/mail 文本通道 + 剪贴板（darwin pbpaste），
// source 元信息落 frontmatter，采集→入库一步完成。
const SPARK_CAPTURE_SOURCES = new Set(['im', 'mail', 'clipboard']);

function readClipboard(command) {
  const result = spawnSync(command, { encoding: 'utf8', shell: process.platform !== 'win32' });
  if (result.error) throw new Error(`clipboard command failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`clipboard command exited ${result.status}: ${(result.stderr || '').trim()}`);
  return result.stdout;
}

function captureSpark(home, args) {
  const source = option(args, '--source', true);
  if (!SPARK_CAPTURE_SOURCES.has(source)) {
    throw new Error(`--source must be one of: ${[...SPARK_CAPTURE_SOURCES].join(', ')}`);
  }
  const title = option(args, '--title', true).trim();
  if (!title) throw new Error('--title must not be empty');
  const contentFile = option(args, '--content-file');
  const text = option(args, '--text');
  let body = null;
  if (source === 'clipboard') {
    if (text !== undefined || contentFile !== undefined) throw new Error('clipboard capture reads the system clipboard; do not pass --text/--content-file');
    const command = option(args, '--clipboard-command') || (process.platform === 'darwin' ? 'pbpaste' : 'wl-paste');
    body = readClipboard(command).trim();
  } else {
    if (Boolean(text) === Boolean(contentFile)) throw new Error(`${source} capture requires exactly one of --text or --content-file`);
    body = contentFile ? fs.readFileSync(path.resolve(contentFile), 'utf8') : text;
    body = body.trim();
  }
  if (!body) throw new Error(`captured content from ${source} is empty`);
  const directory = sparkDirectory(home);
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, `${sparkSlug(title)}.md`);
  if (fs.existsSync(filePath)) throw new Error(`spark already exists: ${filePath}`);
  const date = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(filePath, `---\ntitle: ${title}\ndate: ${date}\nscope: global\nsource: ${source}\n---\n\n# ${title}\n\n${body}\n`);
  return { directory, source, spark: requireSpark(home, sparkId(filePath)).spark };
}

// ── registry 共享形态（维护心跳包·九轮）：单机 json → 多工作区/团队共享 ──
// export 吐自包含 bundle（workspaces+projects），import 按 id 合流：新 id 入册、
// 同 id 同容跳过、同 id 漂移点名不静默覆盖（--force 才让来客赢）——共享不等于互踩。
function registryExport(home) {
  const projectsFile = path.join(home, 'registry', 'projects.json');
  const workspacesFile = path.join(home, 'registry', 'workspaces.json');
  if (!fs.existsSync(projectsFile) || !fs.existsSync(workspacesFile)) {
    throw new Error('registry is not initialized; run ks init first');
  }
  return {
    schema: 1,
    exportedAt: new Date().toISOString(),
    workspaces: readJson(workspacesFile).workspaces,
    projects: readJson(projectsFile).projects.map(normalizeProject)
  };
}

function mergeById(current, incoming, isEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b)) {
  const byId = new Map(current.map((entry) => [entry.id, entry]));
  const added = [];
  const skipped = [];
  const conflicted = [];
  for (const entry of incoming) {
    const existing = byId.get(entry.id);
    if (!existing) {
      byId.set(entry.id, entry);
      added.push(entry.id);
    } else if (isEqual(existing, entry)) {
      skipped.push(entry.id);
    } else {
      conflicted.push(entry.id);
    }
  }
  return { merged: [...byId.values()], added, skipped, conflicted };
}

// workspace 的 path 是机器本地字段（各自 checkout 位置）：同 id 不同 path 是共享常态，
// 比较时剥离 path——只有 id 之外的字段漂移才算冲突；本地 path 永不被来客覆盖。
const sameWorkspaceIdentity = (a, b) => {
  const strip = ({ path, ...rest }) => rest;
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
};

function registryImport(home, args) {
  const file = option(args, '--file', true);
  const force = args.includes('--force');
  const bundlePath = path.resolve(file);
  if (!fs.existsSync(bundlePath)) throw new Error(`bundle file not found: ${bundlePath}`);
  let bundle;
  try {
    bundle = readJson(bundlePath);
  } catch (error) {
    throw new Error(`bundle is not valid JSON: ${error.message}`);
  }
  if (bundle.schema !== 1) throw new Error(`unsupported bundle schema: ${String(bundle.schema)}`);
  if (!Array.isArray(bundle.projects) || !Array.isArray(bundle.workspaces)) {
    throw new Error('bundle must carry projects[] and workspaces[] (ks registry export output)');
  }
  return withStateLock(home, 'registry', () => {
    const projectsFile = path.join(home, 'registry', 'projects.json');
    const workspacesFile = path.join(home, 'registry', 'workspaces.json');
    if (!fs.existsSync(projectsFile)) throw new Error('registry is not initialized; run ks init first');
    const projectsDoc = readJson(projectsFile);
    const workspacesDoc = readJson(workspacesFile);
    const incomingProjects = bundle.projects.map(normalizeProject);
    const p = mergeById(projectsDoc.projects, incomingProjects);
    const w = mergeById(workspacesDoc.workspaces, bundle.workspaces, sameWorkspaceIdentity);
    const hasConflict = p.conflicted.length > 0 || w.conflicted.length > 0;
    if (hasConflict && !force) {
      throw new Error(
        `conflicting ids without --force: ${[...p.conflicted, ...w.conflicted].join(', ')} (local versions kept; re-run with --force to let the bundle win)`
      );
    }
    const byIdForce = (current, incoming) => [...new Map([...current, ...incoming].map((entry) => [entry.id, entry])).values()];
    const finalProjects = hasConflict ? byIdForce(projectsDoc.projects, incomingProjects) : p.merged;
    const forceWorkspaces = byIdForce(
      workspacesDoc.workspaces,
      bundle.workspaces.map((entry) => {
        const local = workspacesDoc.workspaces.find((ws) => ws.id === entry.id);
        return local ? { ...entry, path: local.path } : entry; // --force 也不夺本地 path
      })
    );
    const finalWorkspaces = hasConflict ? forceWorkspaces : w.merged;
    const changed = p.added.length > 0 || w.added.length > 0 || hasConflict;
    if (changed) {
      projectsDoc.projects = finalProjects;
      workspacesDoc.workspaces = finalWorkspaces;
      writeJson(projectsFile, projectsDoc);
      writeJson(workspacesFile, workspacesDoc);
    }
    return {
      force,
      changed,
      projects: { added: p.added, skipped: p.skipped, overwritten: hasConflict ? p.conflicted : [] },
      workspaces: { added: w.added, skipped: w.skipped, overwritten: hasConflict ? w.conflicted : [] }
    };
  });
}

const USAGE = 'Usage: ks --help | ks init | ks workspace <add|list> | ks spark <configure|list|find|inspect|create|capture|append-section|check> | ks project <create|register|update|list|search|tag|alias|describe|lifecycle|inspect|resolve|check|migrate|adopt|rules> | ks coordination <open|find|resume|archive> | ks chat-room <open|append|archive|split> | ks version <status|init|check|plan|apply> | ks plugin <list|check> | ks workflow <run> | ks market <list|install|upgrade> <name> --source <path|url> [--refresh] [--force] | ks registry <export|import> --file <path> [--force] | ks route | ks status [--home <path>] [--json]';

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(`${USAGE}\n`);
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

  if (command === 'plugin' && args[1] === 'list') {
    printResult({ ok: true, count: 0, plugins: listPlugins(home) }, true);
    return;
  }

  if (command === 'plugin' && args[1] === 'check') {
    printResult({ ok: true, ...checkPlugins(home) }, true);
    return;
  }

  if (command === 'workflow' && args[1] === 'run') {
    printResult({ ok: true, ...workflowRun(home, args) }, true);
    return;
  }

  if (command === 'status') {
    printResult({ ok: true, ...ksStatus(home) }, true);
    return;
  }

  if (command === 'market' && (args[1] === 'list' || args[1] === 'install' || args[1] === 'upgrade')) {
    const handler = args[1] === 'list' ? marketList : args[1] === 'install' ? marketInstall : marketUpgrade;
    handler(home, args).then(
      (result) => printResult({ ok: true, ...result }, true),
      (error) => {
        process.stderr.write(`ks: ${error.message}\n`);
        process.exitCode = 1;
      }
    );
    return;
  }

  if (command === 'registry' && args[1] === 'export') {
    printResult({ ok: true, ...registryExport(home) }, true);
    return;
  }

  if (command === 'registry' && args[1] === 'import') {
    printResult({ ok: true, ...registryImport(home, args) }, true);
    return;
  }

  if (command === 'route') {
    printResult({ ok: true, ...ksRoute(home, args) }, true);
    return;
  }

  if (command === 'spark' && args[1] === 'capture') {
    printResult({ ok: true, ...captureSpark(home, args) }, true);
    return;
  }

  throw new Error(USAGE);
}

try {
  main();
} catch (error) {
  process.stderr.write(`ks: ${error.message}\n`);
  process.exitCode = 1;
}
