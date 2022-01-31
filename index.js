const core = require('@actions/core');
const path = require('path');
const process = require('process');
const spawn = require('child_process').spawn;

const sourceDirectory = '.';
const buildConfigs = ['Debug', 'Release'];
const shell = process.platform === 'win32' ? 'pwsh' : 'bash';

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
        return true;
    } catch (error) {
        const message = `Command '${command}' failed with error message '${error.message}'`;
        console.error(message);
        core.setFailed(message);
        return false;
    }
}

async function configure(config, cmakeArguments) {
    core.startGroup(`Configure ${config}`);
    console.info('Configuring', config);
    let command = `cmake -S ${sourceDirectory} -B ${buildDirectory(config)} -G Ninja -D CMAKE_BUILD_TYPE=${config}`
    if (cmakeArguments) {
        command += ' ' + cmakeArguments;
    }
    const ret = await execCommand(command);
    core.endGroup();
    return ret;
}

async function build(config) {
    core.startGroup(`Build ${config}`);
    console.info('Building', config);
    const ret = await execCommand(`cmake --build ${buildDirectory(config)}`)
    core.endGroup();
    return ret;
}

async function test(config) {
    core.startGroup(`Test ${config}`);
    console.info('Testing', config);
    const ret = await execCommand('ctest', path.join(process.cwd(), buildDirectory(config)))
    core.endGroup();
    return ret;
}

async function install(config) {
    core.startGroup(`Install ${config}`);
    console.info('Installing', config);
    const ret = await execCommand(`cmake --install ${buildDirectory(config)} --prefix ${installDirectory(config)}`)
    core.endGroup();
    return ret;
}

async function main() {
    const cmakeArguments = core.getInput('cmake-arguments', { required: false });
    console.info('Inputs: cmake-arguments is', cmakeArguments);
    const runInstallStep = (core.getInput('install', { required: false }) === 'true');
    console.info('Inputs: install is', runInstallStep);

    for (const config of buildConfigs) {
        let ret = await configure(config, cmakeArguments);
        if (!ret) {
            return;
        }
        ret = await build(config);
        if (!ret) {
            return;
        }
        ret = await test(config);
        if (!ret) {
            return;
        }
        if (runInstallStep) {
            ret = await install(config);
            if (!ret) {
                return;
            }
        }
    }
}

main()
