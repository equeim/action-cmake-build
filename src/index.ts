import * as fs from 'fs/promises';
import * as path from 'path';
import * as process from 'process';
import { spawn } from 'child_process';

import * as core from '@actions/core';

const sourceDirectory = '.' as const;
const buildConfigs = ['Debug', 'Release'] as const;

type BuildConfig = typeof buildConfigs[number];
type BuildConfigDirectories = Record<BuildConfig, string>;

const buildDirectories: Readonly<BuildConfigDirectories> = buildConfigs.reduce((dirs, config) => {
    dirs[config] = `build-${config}`;
    return dirs;
}, {} as BuildConfigDirectories);

const installDirectories: Readonly<BuildConfigDirectories> = buildConfigs.reduce((dirs, config) => {
    dirs[config] = `install-${config}`;
    return dirs;
}, {} as BuildConfigDirectories);

const shell = process.platform == 'win32' ? 'pwsh' : 'bash' as const;

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

async function execCommand(command: string, cwd?: string) {
    console.info('Executing command', command);
    try {
        const child = spawn(command, { stdio: 'inherit', shell: shell, cwd: cwd ?? process.cwd() });
        const exitCode = await new Promise((resolve, reject) => {
            child.on('close', resolve);
            child.on('error', reject);
        });
        if (exitCode != 0) {
            throw new Error(`Command exited with exit code ${exitCode}`);
        }
    } catch (error) {
        console.error(error);
        throw new AbortActionError(`Command '${command}' failed with error message '${errorAsString(error)}'`);
    }
}

async function configure(config: BuildConfig, cmakeArguments?: string) {
    core.startGroup(`Configure ${config}`);
    console.info('Configuring', config);
    let command = `cmake -S ${sourceDirectory} -B ${buildDirectories[config]} -G Ninja -D CMAKE_BUILD_TYPE=${config}`;
    if (cmakeArguments) {
        command += ' ' + cmakeArguments;
    }
    await execCommand(command);
    core.endGroup();
}

async function build(config: BuildConfig) {
    core.startGroup(`Build ${config}`);
    console.info('Building', config);
    await execCommand(`cmake --build ${buildDirectories[config]}`);
    core.endGroup();
}

async function test(config: BuildConfig) {
    core.startGroup(`Test ${config}`);
    console.info('Testing', config);
    await execCommand('ctest', path.join(process.cwd(), buildDirectories[config]));
    core.endGroup();
}

async function install(config: BuildConfig) {
    core.startGroup(`Install ${config}`);
    console.info('Installing', config);
    await execCommand(`cmake --install ${buildDirectories[config]} --prefix ${installDirectories[config]}`);
    core.endGroup();
}

async function removeDirectory(path: string) {
    console.info('Removing directory', path);
    try {
        await fs.rm(path, { force: true, recursive: true });
    } catch (error) {
        console.error(error);
        throw new AbortActionError(`Removing directory '${path}' failed with error '${errorAsString(error)}'`);
    }
}

async function cleanup(config: BuildConfig, removeInstallDirectory: boolean) {
    core.startGroup(`Cleanup ${config}`);
    let promises = [removeDirectory(buildDirectories[config])];
    if (removeInstallDirectory) {
        promises.push(removeDirectory(installDirectories[config]));
    }
    await Promise.all(promises);
    core.endGroup();
}

async function main() {
    try {
        const cmakeArguments = core.getInput('cmake-arguments', { required: false });
        console.info('Inputs: cmake-arguments is', cmakeArguments);
        const runInstallStep = (core.getInput('install', { required: false }) === 'true');
        console.info('Inputs: install is', runInstallStep);
        const performCleanup = (core.getInput('perform-cleanup', { required: false }) === 'true');
        console.info('Inputs: perform-cleanup is', performCleanup);

        for (const config of buildConfigs) {
            await configure(config, cmakeArguments);
            await build(config);
            await test(config);
            if (runInstallStep) {
                await install(config);
            }
            if (performCleanup) {
                await cleanup(config, runInstallStep);
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
