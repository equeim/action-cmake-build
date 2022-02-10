import * as path from 'path';
import * as process from 'process';
import { ChildProcess, spawn } from 'child_process';

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

async function execProcess(process: ChildProcess) {
    const exitCode: number = await new Promise((resolve, reject) => {
        process.on('close', resolve);
        process.on('error', reject);
    });
    if (exitCode != 0) {
        throw new Error(`Command exited with exit code ${exitCode}`);
    }
}

async function execCommand(command: string, args: string[], cwd?: string) {
    console.info('Executing command', command, 'with arguments', args, 'in working directory', cwd ?? process.cwd());
    try {
        const child = spawn(command, args, { stdio: 'inherit', cwd: cwd ?? process.cwd() });
        await execProcess(child);
    } catch (error) {
        console.error(error);
        throw new AbortActionError(`Command '${command}' failed with error '${errorAsString(error)}'`);
    }
}

type CMakeCapabilities = {
    canInvokeCMakeInstall: boolean,
    ctestHasTestDirArgument: boolean;
};

async function determineCMakeCapabilities(): Promise<CMakeCapabilities> {
    const child = spawn('cmake', ['--version']);
    try {
        let data = "";
        child.stdout.on('data', (chunk: Buffer | string | any) => {
            if (chunk instanceof Buffer) {
                data += chunk.toString();
            } else if (typeof (chunk) == 'string') {
                data += chunk;
            } else {
                console.error('determineCMakeCapabilities: invalid data chunk', chunk);
            }
        });
        await execProcess(child);
        const lines = data.split('\n').filter(Boolean);
        if (lines.length == 0) {
            throw new Error('Failed to determine CMake version');
        }
        const groups = lines[0]?.match(/.*(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+).*/)?.groups;
        if (groups == null) {
            throw new Error('Failed to determine CMake version');
        }
        console.info('Determined CMake version as', groups);
        const major = parseInt(groups['major'] ?? '');
        const minor = parseInt(groups['minor'] ?? '');
        if (isNaN(major) || isNaN(minor)) {
            throw new Error('Failed to determine CMake version');
        }
        if (major > 3 || minor >= 20) return { canInvokeCMakeInstall: true, ctestHasTestDirArgument: true };
        if (minor >= 15) return { canInvokeCMakeInstall: true, ctestHasTestDirArgument: false };
        return { canInvokeCMakeInstall: false, ctestHasTestDirArgument: false };
    } catch (error) {
        console.error(error);
        throw new AbortActionError(`Failed to determine CMake capabilities with error '${errorAsString(error)}'`);
    }
}

async function configure(config: BuildConfig) {
    core.startGroup(`Configure ${config}`);
    console.info('Configuring', config);
    const args = [
        '-G', 'Ninja',
        '-S', sourceDirectory,
        '-B', buildDirectories[config],
        '-D', `CMAKE_BUILD_TYPE=${config}`,
        '-D', `CMAKE_INSTALL_PREFIX=${installDirectories[config]}`
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

async function test(config: BuildConfig, cmakeCapabilities: CMakeCapabilities) {
    core.startGroup(`Test ${config}`);
    console.info('Testing', config);
    if (cmakeCapabilities.ctestHasTestDirArgument) {
        await execCommand('ctest', ['--test-dir', buildDirectories[config]]);
    } else {
        await execCommand('ctest', [], path.join(process.cwd(), buildDirectories[config]));
    }
    core.endGroup();
}

async function install(config: BuildConfig, cmakeCapabilities: CMakeCapabilities) {
    core.startGroup(`Install ${config}`);
    console.info('Installing', config);
    if (cmakeCapabilities.canInvokeCMakeInstall) {
        await execCommand('cmake', ['--install', buildDirectories[config]]);
    } else {
        await execCommand('cmake', ['--build', buildDirectories[config], '--target', 'install']);
    }
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
        const cmakeCapabilities = await determineCMakeCapabilities();
        console.info('CMake capabilities are', cmakeCapabilities);

        for (const config of buildConfigs) {
            await configure(config);
            await build(config);
            await test(config, cmakeCapabilities);
            if (runInstallStep) {
                await install(config, cmakeCapabilities);
            }
        }
        if (runInstallStep) {
            core.setOutput('install-directory-debug', installDirectories.Debug);
            core.setOutput('install-directory-release', installDirectories.Release);
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
