const fs = require('fs/promises');
const path = require('path');
const process = require('process');
const spawn = require('child_process').spawn;

const core = require('@actions/core');

const sourceDirectory = '.';
const buildConfigs = ['Debug', 'Release'];
const shell = process.platform === 'win32' ? 'pwsh' : 'bash';

class AbortActionError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AbortActionError';
    }
}

function buildDirectory(config) {
    return `build-${config}`
}

function installDirectory(config) {
    return `install-${config}`
}

async function execCommand(command, cwd) {
    console.info('Executing command', command);
    try {
        const child = spawn(command, { stdio: 'inherit', shell: shell, cwd: cwd ? cwd : process.cwd() });
        const exitCode = await new Promise((resolve, reject) => {
            child.on('close', resolve);
            child.on('error', reject);
        });
        if (exitCode != 0) {
            throw new Error(`Command exited with exit code ${exitCode}`);
        }
    } catch (error) {
        console.error(error);
        throw new AbortActionError(`Command '${command}' failed with error message '${error.message}'`);
    }
}

async function configure(config, cmakeArguments) {
    core.startGroup(`Configure ${config}`);
    console.info('Configuring', config);
    let command = `cmake -S ${sourceDirectory} -B ${buildDirectory(config)} -G Ninja -D CMAKE_BUILD_TYPE=${config}`
    if (cmakeArguments) {
        command += ' ' + cmakeArguments;
    }
    await execCommand(command);
    core.endGroup();
}

async function build(config) {
    core.startGroup(`Build ${config}`);
    console.info('Building', config);
    await execCommand(`cmake --build ${buildDirectory(config)}`)
    core.endGroup();
}

async function test(config) {
    core.startGroup(`Test ${config}`);
    console.info('Testing', config);
    await execCommand('ctest', path.join(process.cwd(), buildDirectory(config)))
    core.endGroup();
}

async function install(config) {
    core.startGroup(`Install ${config}`);
    console.info('Installing', config);
    await execCommand(`cmake --install ${buildDirectory(config)} --prefix ${installDirectory(config)}`)
    core.endGroup();
}

async function removeDirectory(path) {
    console.info('Removing directory', path);
    try {
        await fs.rm(path, { force: true, recursive: true });
    } catch (error) {
        console.error(error);
        throw new AbortActionError(`Removing directory '${path}' failed with error message '${error.message}'`);
    }
}

async function cleanup(config, removeInstallDirectory) {
    core.startGroup(`Cleanup ${config}`);
    let promises = [removeDirectory(buildDirectory(config))];
    if (removeInstallDirectory) {
        promises.push(removeDirectory(installDirectory(config)));
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
