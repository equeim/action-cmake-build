import * as path from 'path';
import * as process from 'process';
import { ChildProcess, spawn } from 'child_process';

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
    buildPackage: boolean;
};

function parseInputs(): Inputs {
    const cmakeArgumentsInput = core.getInput('cmake-arguments', { required: false });
    console.info('Inputs: cmake-arguments is', cmakeArgumentsInput);
    const buildPackageInput = core.getInput('package', { required: false });
    console.info('Inputs: package is', buildPackageInput);
    return {
        cmakeArguments: cmakeArgumentsInput.split(/\s+/).filter(Boolean),
        buildPackage: buildPackageInput === 'true'
    };
}

const buildConfigs = ['Debug', 'Release'] as const;
type BuildConfig = typeof buildConfigs[number];
const buildDirectory = 'build' as const;

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
        throw new AbortActionError(`Failed to determine CMake capabilities with error '${errorAsString(error)}'`);
    }
}

async function configure(inputs: Inputs) {
    core.startGroup(`Configure`);
    console.info('Configuring');
    const args = [
        '-G', 'Ninja Multi-Config',
        '-S', '.',
        '-B', buildDirectory
    ].concat(inputs.cmakeArguments);
    await execCommand('cmake', args);
    core.endGroup();
}

async function build(config: BuildConfig) {
    core.startGroup(`Build ${config}`);
    console.info('Building', config);
    await execCommand('cmake', ['--build', buildDirectory, '--config', config]);
    core.endGroup();
}

async function test(config: BuildConfig, cmakeCapabilities: CMakeCapabilities) {
    core.startGroup(`Test ${config}`);
    console.info('Testing', config);
    if (cmakeCapabilities.ctestHasTestDirArgument) {
        await execCommand('ctest', ['--output-on-failure', '--test-dir', buildDirectory, '--build-config', config]);
    } else {
        await execCommand('ctest', ['--output-on-failure', '--build-config', config], path.join(process.cwd(), buildDirectory));
    }
    core.endGroup();
}

async function buildPackage(config: BuildConfig) {
    core.startGroup(`Package ${config}`);
    console.info('Packaging', config);
    await execCommand('cmake', ['--build', buildDirectory, '--config', config, '--target', 'package']);
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
        const inputs = parseInputs();
        core.setOutput('build-directory', buildDirectory);

        const cmakeCapabilities = await determineCMakeCapabilities();
        console.info('CMake capabilities are', cmakeCapabilities);

        await configure(inputs);
        for (const config of buildConfigs) {
            await build(config);
            await test(config, cmakeCapabilities);
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
            message = `!!! Unhandled exception ${error}`;
        }
        core.setFailed(message);
    }
}

main();
