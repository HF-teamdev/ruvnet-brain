import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { discoverNativeCodex, installNativeLaunchers, launcherInvocation, updateLauncherSettings } from '../../scripts/model-routing-launchers.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const roots = [];
function fixture() {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'native-launchers-')); roots.push(home);
  const extensionsRoot = path.join(home, 'extensions'); const extension = path.join(extensionsRoot, 'openai.chatgpt-active');
  const platform = process.platform === 'darwin' ? 'macos' : process.platform; const arch = process.arch === 'arm64' ? 'aarch64' : process.arch;
  const binary = path.join(extension, 'bin', `${platform}-${arch}`, 'codex');
  fs.mkdirSync(path.dirname(binary), { recursive: true }); fs.writeFileSync(binary, '#!/bin/sh\nprintf "native-codex-probe\\n"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(extensionsRoot, 'extensions.json'), JSON.stringify([{ identifier: { id: 'openai.chatgpt' }, location: { path: extension } }]));
  const claude = path.join(extensionsRoot, 'anthropic.claude-code-active/resources/native-binary/claude');
  fs.mkdirSync(path.dirname(claude), { recursive: true }); fs.writeFileSync(claude, '#!/bin/sh\nprintf "native-claude-probe\\n"\n', { mode: 0o755 });
  return { home, extensionsRoot, binary, claude };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('routes native arguments exactly, shifts Claude wrapper binary, and rejects recursion/foreign executable', () => {
  const fx = fixture(); const launcher = path.join(fx.home, 'launcher'); fs.writeFileSync(launcher, 'launcher');
  const config = { extensionsRoot: fx.extensionsRoot, nodeBinary: process.execPath, gatewayPath: path.join(sourceRoot, 'scripts/model-routing-gateway.mjs') };
  expect(discoverNativeCodex(fx.extensionsRoot)).toBe(fx.binary);
  expect(launcherInvocation({ harness: 'codex', args: ['app-server', '--stdio'], config, launcherPath: launcher })).toEqual({
    command: process.execPath, args: [config.gatewayPath, '--harness', 'codex', '--real-binary', fx.binary, '--', 'app-server', '--stdio'], routed: true });
  const args = [fx.claude, '--input-format', 'stream-json', '--output-format', 'stream-json'];
  const invocation = launcherInvocation({ harness: 'claude-code', args, config, launcherPath: launcher });
  expect(invocation.args).toEqual([config.gatewayPath, '--harness', 'claude-code', '--real-binary', fx.claude, '--', ...args.slice(1)]);
  expect(args[0]).toBe(fx.claude);
  expect(() => launcherInvocation({ harness: 'codex', args: ['app-server'], config, launcherPath: fx.binary })).toThrow(/recursion/);
  expect(() => launcherInvocation({ harness: 'claude-code', args: [process.execPath], config, launcherPath: launcher })).toThrow(/extension native/);
});

it('dry runs without writes, installs an independent runtime snapshot, and executes both actual launcher probe paths without inference', () => {
  const fx = fixture(); const options = { sourceRoot, home: fx.home, extensionsRoot: fx.extensionsRoot };
  const plan = installNativeLaunchers(options);
  expect(fs.existsSync(plan.launchers.codex)).toBe(false);
  const installed = installNativeLaunchers({ ...options, apply: true });
  expect(installed.config.gatewayPath).not.toContain(sourceRoot);
  expect(installed.runtimeFiles.map(([file]) => file)).toContain('scripts/model-router-engine.mjs');
  expect(installed.runtimeFiles.map(([file]) => file)).toContain('config/model-router/policy.default.mjs');
  for (const [harness, args, expected] of [['codex', ['--version'], 'native-codex-probe'], ['claude-code', [fx.claude, '--version'], 'native-claude-probe']]) {
    const result = spawnSync(installed.launchers[harness], args, { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout.trim()).toBe(expected);
  }
  const bridge = launcherInvocation({ harness: 'codex', args: ['stdio-to-uds', '/tmp/socket'], config: installed.config, launcherPath: installed.launchers.codex });
  expect(bridge).toEqual({ command: fx.binary, args: ['stdio-to-uds', '/tmp/socket'], routed: false });
  fs.writeFileSync(installed.launchers.codex, '# unmanaged user command');
  expect(() => installNativeLaunchers({ ...options, apply: true })).toThrow(/Preserving unmanaged launcher/);
});

it('follows only the extension registration rather than guessing versions, and refuses ambiguous/outside registration', () => {
  const fx = fixture(); const manifest = path.join(fx.extensionsRoot, 'extensions.json'); const active = JSON.parse(fs.readFileSync(manifest));
  fs.mkdirSync(path.join(fx.extensionsRoot, 'openai.chatgpt-999999'), { recursive: true });
  expect(discoverNativeCodex(fx.extensionsRoot)).toBe(fx.binary);
  fs.writeFileSync(manifest, JSON.stringify([...active, ...active])); expect(() => discoverNativeCodex(fx.extensionsRoot)).toThrow(/Exactly one/);
  fs.writeFileSync(manifest, JSON.stringify([{ identifier: { id: 'openai.chatgpt' }, location: { path: fx.home } }]));
  expect(() => discoverNativeCodex(fx.extensionsRoot)).toThrow(/escaped/);
});

it('preserves unrelated settings and explicit user overrides, backs up changes, and refuses JSONC rewrites', () => {
  const fx = fixture(); const file = path.join(fx.home, 'settings.json');
  const original = '{"private.preference":true,"claudeCode.claudeProcessWrapper":"/private/wrapper"}\n'; fs.writeFileSync(file, original, { mode: 0o640 });
  const requested = { 'chatgpt.cliExecutable': '/managed/codex', 'claudeCode.claudeProcessWrapper': '/managed/claude' };
  expect(updateLauncherSettings(file, requested).changed).toBe(true); expect(fs.readFileSync(file, 'utf8')).toBe(original);
  const receipt = updateLauncherSettings(file, requested, { apply: true });
  expect(receipt.preservedOverrides).toEqual({ 'claudeCode.claudeProcessWrapper': '/private/wrapper' });
  expect(fs.readFileSync(receipt.backup, 'utf8')).toBe(original);
  expect(JSON.parse(fs.readFileSync(file))).toEqual({ 'private.preference': true, 'chatgpt.cliExecutable': '/managed/codex', 'claudeCode.claudeProcessWrapper': '/private/wrapper' });
  expect(fs.statSync(file).mode & 0o777).toBe(0o640);
  expect(updateLauncherSettings(file, requested, { apply: true }).changed).toBe(false);
  fs.writeFileSync(file, '// comment\n{}'); expect(() => updateLauncherSettings(file, requested, { apply: true })).toThrow(/JSONC/);
});
