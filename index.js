const util = require('util');
const spawn = require('child_process').spawn;
const core = require('@actions/core');

const sourceDirectory = '.';
const buildDirectory = './build';
const buildConfigs = ['Debug', 'Release'];

async function execCommand(command) {
    console.info('Executing command', command);
    try {
        const process = spawn(command, { stdio: 'inherit', shell: true });
        const exitCode = await new Promise((resolve, reject) => {
            process.on('close', resolve);
            process.on('error', reject);
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

async function configure(cmakeArguments) {
    core.startGroup('Configure');
    console.info('Configuring CMake');
    let command = `cmake -S ${sourceDirectory} -B ${buildDirectory}`
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
    const ret = await execCommand(`cmake --build ${buildDirectory} --config ${config}`)
    core.endGroup();
    return ret;
}

async function test(config) {
    core.startGroup(`Test ${config}`);
    console.info('Testing', config);
    const ret = await execCommand(`ctest --test-dir ${buildDirectory} --build-config ${config}`)
    core.endGroup();
    return ret;
}

async function install(config) {
    core.startGroup(`Install ${config}`);
    console.info('Installing', config);
    const ret = await execCommand(`cmake --install ${buildDirectory} --config ${config} --prefix ./install-${config}`)
    core.endGroup();
    return ret;
}

async function main() {
    const cmakeArguments = core.getInput('cmake-arguments', { required: false });
    console.info('Inputs: cmake-arguments is', cmakeArguments);
    const runInstallStep = core.getInput('install', { required: false });
    console.info('Inputs: install is', runInstallStep);

    let ret = await configure(cmakeArguments);
    if (!ret) {
        return;
    }
    for (const config of buildConfigs) {
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
