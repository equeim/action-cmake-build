import * as path from 'path';
import * as process from 'process';
import { spawn } from 'child_process';

import * as core from '@actions/core';

const cmakeArguments = core.getInput('cmake-arguments', { required: false });
console.info('Inputs: cmake-arguments is', cmakeArguments);
const outputDirectoriesSuffix = core.getInput('output-directories-suffix', { required: false });
console.info('Inputs: output-directories-suffix is', outputDirectoriesSuffix);
const runInstallStep = (core.getInput('install', { required: false }) === 'true');
console.info('Inputs: install is', runInstallStep);

const sourceDirectory = '.' as const;
const buildConfigs = ['Debug', 'Release'] as const;

type BuildConfig = typeof buildConfigs[number];
type BuildConfigDirectories = Record<BuildConfig, string>;

const buildDirectories: Readonly<BuildConfigDirectories> = buildConfigs.reduce((dirs, config) => {
    dirs[config] = `build-${config}${outputDirectoriesSuffix ?? ''}`;
    return dirs;
}, {} as BuildConfigDirectories);

const installDirectories: Readonly<BuildConfigDirectories> = buildConfigs.reduce((dirs, config) => {
    dirs[config] = `install-${config}${outputDirectoriesSuffix ?? ''}`;
    return dirs;
}, {} as BuildConfigDirectories);

async function execCommand(command: string, args: string[], cwd?: string) {
    console.info('Executing command', command, 'with arguments', args, 'in working directory', cwd ?? process.cwd());
    try {
        const child = spawn(command, args, { stdio: 'inherit', cwd: cwd ?? process.cwd() });
        const exitCode = await new Promise((resolve, reject) => {
            child.on('close', resolve);
            child.on('error', reject);
        });
        if (exitCode != 0) {
            throw new Error(`Command exited with exit code ${exitCode}`);
        }
    } catch (error) {
        console.error(error);
        throw new AbortActionError(`Command '${command}' failed with error '${errorAsString(error)}'`);
    }
}

async function configure(config: BuildConfig) {
    core.startGroup(`Configure ${config}`);
    console.info('Configuring', config);
    const args = [
        '-G', 'Ninja',
        '-S', sourceDirectory,
        '-B', buildDirectories[config],
        '-D', `CMAKE_BUILD_TYPE=${config}`
    ].concat(cmakeArguments.split(/\s+/).filter(Boolean));
    await execCommand('cmake', args);
    core.endGroup();
}

async function build(config: BuildConfig) {
    core.startGroup(`Build ${config}`);
    console.info('Building', config);
    await execCommand('cmake', ['--build', buildDirectories[config]]);
    core.endGroup();
}

async function test(config: BuildConfig) {
    core.startGroup(`Test ${config}`);
    console.info('Testing', config);
    await execCommand('ctest', [], path.join(process.cwd(), buildDirectories[config]));
    core.endGroup();
}

async function install(config: BuildConfig) {
    core.startGroup(`Install ${config}`);
    console.info('Installing', config);
    await execCommand('cmake', ['--install', buildDirectories[config], '--prefix', installDirectories[config]]);
    core.endGroup();
}

class AbortActionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AbortActionError';
    }
}

function errorAsString(error: unknown): string {
    if (error instanceof Error && error.message) {
        return `${error.name}: ${error.message}`;
    }
    return String(error);
}

async function main() {
    try {
        for (const config of buildConfigs) {
            await configure(config);
            await build(config);
            await test(config);
            if (runInstallStep) {
                await install(config);
            }
        }
    } catch (error) {
        let message = '';
        if (error instanceof AbortActionError) {
            console.error(error.message);
            message = error.message;
        } else {
            console.error('!!! Unhandled exception:');
            console.error(error);
            message = `!!! Unhandled exception ${error}`;
        }
        core.setFailed(message);
    }
}

main();
