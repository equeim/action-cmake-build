import * as path from 'path';
import * as process from 'process';
import { ChildProcess, spawn } from 'child_process';
import * as os from 'os';

import * as core from '@actions/core';
import { inspect } from 'util';

class CMakeVersion {
    major: number;
    minor: number;
    patch: number;

    constructor(major: number, minor: number, patch: number) {
        this.major = major;
        this.minor = minor;
        this.patch = patch;
    }

    public isNewerOrEqualThan(other: CMakeVersion): boolean {
        if (this.major != other.major) {
            return this.major >= other.major;
        }
        if (this.minor != other.minor) {
            return this.minor >= other.minor;
        }
        return this.patch >= other.patch;
    }

    public isOlderThan(other: CMakeVersion): boolean {
        return !this.isNewerOrEqualThan(other);
    }

    public toString(): string {
        return inspect(this);
    }

    public static parse(version: string): CMakeVersion {
        const groups = version.match(/.*(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+).*/)?.groups;
        if (groups == null) {
            throw new Error(`Failed to parse CMake version ${version}`);
        }
        const major = parseInt(groups['major'] ?? '');
        const minor = parseInt(groups['minor'] ?? '');
        const patch = parseInt(groups['patch'] ?? '');
        if (isNaN(major) || isNaN(minor) || isNaN(patch)) {
            throw new Error(`Failed to parse CMake version ${version}`);
        }
        return new CMakeVersion(major, minor, patch);
    }
};


const minimumCMakeVersion = new CMakeVersion(3, 17, 0);
const cmakeVersionWhereCtestHasTestDirArgument = new CMakeVersion(3, 20, 0);

type Inputs = {
    cmakeArguments: string[];
    runTests: boolean;
    buildPackage: boolean;
};

function parseInputs(): Inputs {
    const cmakeArgumentsInput = core.getInput('cmake-arguments', { required: false });
    console.info('Inputs: cmake-arguments is', cmakeArgumentsInput);
    const runTestsInput = core.getInput('test', { required: false });
    console.info('Inputs: test is', runTestsInput);
    const buildPackageInput = core.getInput('package', { required: false });
    console.info('Inputs: package is', buildPackageInput);
    return {
        cmakeArguments: cmakeArgumentsInput.split(/\s+/).filter(Boolean),
        runTests: runTestsInput === 'true',
        buildPackage: buildPackageInput === 'true'
    };
}

const buildConfigs = ['Debug', 'Release'] as const;
type BuildConfig = typeof buildConfigs[number];
const buildDirectory = 'build' as const;

class NonZeroExitCodeError extends Error {
    constructor(exitCode: number) {
        super(`Process exited with exit code ${exitCode}`);
        this.name = 'NonZeroExitCodeError';
    }
}

async function execProcess(process: ChildProcess) {
    const exitCode: number = await new Promise((resolve, reject) => {
        process.on('close', resolve);
        process.on('error', reject);
    });
    if (exitCode != 0) {
        throw new NonZeroExitCodeError(exitCode);
    }
}

async function execCommand(command: string, args: string[], cwd?: string) {
    console.info('Executing command', command, 'with arguments', args, 'in working directory', cwd ?? process.cwd());
    try {
        const child = spawn(command, args, { stdio: 'inherit', cwd: cwd ?? process.cwd() });
        await execProcess(child);
    } catch (error) {
        console.error(error);
        throw new AbortActionError(`Failed to execute command '${command}'`, error);
    }
}

type CMakeCapabilities = {
    ctestHasTestDirArgument: boolean;
};

async function determineCMakeCapabilities(): Promise<CMakeCapabilities> {
    try {
        const child = spawn('cmake', ['--version'], { stdio: ['ignore', 'pipe', 'inherit'] });
        let data = "";
        child.stdout.setEncoding('utf-8');
        child.stdout.on('data', (chunk: string) => {
            data += chunk;
        });
        await execProcess(child);
        const lines = data.split('\n').filter(Boolean);
        if (lines.length == 0) {
            throw new Error('Failed to determine CMake version');
        }
        const version = CMakeVersion.parse(data.split('\n').filter(Boolean)[0] ?? '');
        console.info('CMake version is', version);
        if (version.isOlderThan(minimumCMakeVersion)) {
            throw new Error(`CMake version is too old, minimum supported version is ${minimumCMakeVersion}`);
        }
        return { ctestHasTestDirArgument: version.isNewerOrEqualThan(cmakeVersionWhereCtestHasTestDirArgument) };
    } catch (error) {
        console.error(error);
        throw new AbortActionError(`Failed to determine CMake capabilities`, error);
    }
}

async function configure(inputs: Inputs) {
    core.startGroup(`Configure`);
    const args = [
        '-G', 'Ninja Multi-Config',
        '-S', '.',
        '-B', buildDirectory,
        '-D', `BUILD_TESTING=${inputs.runTests ? 'ON' : 'OFF'}`
    ].concat(inputs.cmakeArguments);
    await execCommand('cmake', args);
    core.endGroup();
}

async function build(config: BuildConfig) {
    core.startGroup(`Build ${config}`);
    await execCommand('cmake', ['--build', buildDirectory, '--config', config]);
    core.endGroup();
}

async function test(config: BuildConfig, cmakeCapabilities: CMakeCapabilities) {
    core.startGroup(`Test ${config}`);
    if (cmakeCapabilities.ctestHasTestDirArgument) {
        await execCommand('ctest', ['--output-on-failure', '--test-dir', buildDirectory, '--build-config', config]);
    } else {
        await execCommand('ctest', ['--output-on-failure', '--build-config', config], path.join(process.cwd(), buildDirectory));
    }
    core.endGroup();
}

async function buildPackage(config: BuildConfig) {
    core.startGroup(`Package ${config}`);
    const args = ['--build', buildDirectory, '--config', config, '--target', 'package'];
    try {
        await execCommand('cmake', args);
    } catch (error) {
        if (os.platform() == 'darwin' && error instanceof AbortActionError && error.cause instanceof NonZeroExitCodeError) {
            console.error('Retrying package command');
            await execCommand('cmake', args);
        } else {
            throw error;
        }
    }
    core.endGroup();
}

class AbortActionError extends Error {
    readonly cause: unknown;

    constructor(message: string, cause: unknown) {
        super(`${message} with error ${errorAsString(cause)}`);
        this.name = 'AbortActionError';
        this.cause = cause;
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
        const inputs = parseInputs();
        core.setOutput('build-directory', buildDirectory);

        const cmakeCapabilities = await determineCMakeCapabilities();
        console.info('CMake capabilities are', cmakeCapabilities);

        await configure(inputs);
        for (const config of buildConfigs) {
            await build(config);
            if (inputs.runTests) {
                await test(config, cmakeCapabilities);
            }
            if (inputs.buildPackage) {
                await buildPackage(config);
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
            message = `!!! Unhandled exception ${errorAsString(error)}`;
        }
        core.setFailed(message);
    }
}

main();
