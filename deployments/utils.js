//require libraries
const shell = require('shelljs');
const path = require('path');

//console colours
const CONSOLE_RED = '"\x1b[31m"';
const CONSOLE_GREEN = "\x1b[32m";

//list any cmd dependencies that need to be initially run
const DEPENDENCIES = ['npm i minimist'];

//temp folder to be used to hold the deployment files
const DEPLOY_FOLDER = 'deploy';
const TEMP_FOLDER = 'snapshots';

// org alias
const ORG_ALIAS = 'targetOrg';

//initialise any prerequisite
module.exports.setup = function () { 
    DEPENDENCIES.forEach((dependency) => {
        this.executeCmd(dependency, true);
    })
}

// Authenticate with AUTH_URL
module.exports.authenticateOrg = function (authUrl) { 
    let createLoginFile = `echo ${authUrl} > org_login.txt`;
    this.executeCmd(createLoginFile, true);
    
    let authenticate = `sfdx auth:sfdxurl:store -f org_login.txt -s -a ${ORG_ALIAS}`;
    this.executeCmd(authenticate, true);
}

// Authenticate with JWT flow
module.exports.authenticateOrgJWT = function (keyFile, consumerKey, username, loginURL) { 
    let authenticate = `sfdx force:auth:jwt:grant -f ${keyFile} -i ${consumerKey} -u ${username} -d -s -r ${loginURL} -a ${ORG_ALIAS}`;

    this.executeCmd(authenticate, true);
}

//workout latest commit version number from current branch
module.exports.getMostRecentCommitFromRepo = function () { 
    //get latest commit to deploy from current branch
    let getMostRecentCommit = `git rev-parse --short HEAD`;
    let outputMostRecentCommit = this.executeCmd(getMostRecentCommit, true);

    outputMostRecentCommit = outputMostRecentCommit.trim();

    return outputMostRecentCommit;
};

module.exports.getLatestDeploymentLog = function (branchName) {
    var lastCommitVersion = '';

    //query the Release_Log__c for last deployed commit version
    let getReleaseLog = `sf data query -q "Select Last_Commit__c from Release_Log__c WHERE Branch_Name__c = '${branchName}' Order By Deployment_Date__c DESC limit 1" --target-org ${ORG_ALIAS} --json`;
    let outputReleaseLog = this.executeCmd(getReleaseLog, true);
    let objJSON = JSON.parse(outputReleaseLog);

    if(objJSON.status !== 0) {
        this.errorMsgAndExit('Release_Log__c SOQL failed - ' + objJSON.message)
    } else if(objJSON.result.records.length > 0) {
        //extract the commit version from the result
        lastCommitVersion = objJSON.result.records[0].Last_Commit__c;
    } else {
        lastCommitVersion = '';
    }

    return lastCommitVersion;
}

// //update commit version to Org
module.exports.updateCommitVersion = function (commitVersion, branchName) {
    let deploymentDate = new Date().toISOString();
    let updateCommitVersion = `sf data create record -s Release_Log__c -v "Last_Commit__c='${commitVersion}' Branch_Name__c='${branchName}' Deployment_Date__c='${deploymentDate}'" --target-org ${ORG_ALIAS}`;
    this.executeCmd(updateCommitVersion, true);
};

//get list of files to deploy between 2 commit versions
module.exports.getChangedFiles = function (param1, param2) { 
    
    //get diff command
    let getFileChanges = '';
    if (param2) {
        getFileChanges = `git diff --name-only ${param1} ${param2}`;
    } else {
        getFileChanges = `git diff --name-only ${param1}`;
    }

    //get all changed files
    let outputChangedFiles = this.executeCmd(getFileChanges, true);

    //each file is on a new line, create array of the different files
    let changedFiles = outputChangedFiles.split("\n");

    //clean out any non deployable files
    var changedFilesCleaned = changedFiles.filter(fileName => {
        return fileName.includes('force-app/main/default');
    });
    console.log('changedFiles:',changedFilesCleaned,'files changed:',changedFilesCleaned.length);

    return changedFilesCleaned;
};

//copy required files into a new deployment folder
module.exports.createDeploymentFolder = function (filesToDeploy) {
    console.log('===START create deployment folder===');
    //loop through each file and copy to a new deployment folder
    filesToDeploy.forEach((file) => {

        let fileDeployLocation = DEPLOY_FOLDER + '/' + file;
        console.log('copying file:',file,' to location: ',fileDeployLocation);
        
        //create folder for file
        shell.mkdir('-p', path.dirname(fileDeployLocation));

        //copy file over
        shell.cp('-rn', file, fileDeployLocation);

        //if LWC or Aura, need whole folder
        if(file.includes('force-app/main/default/lwc/') || file.includes('force-app/main/default/aura/')) {
                
            // get the path for the directory of the current file
            let folderDirectory = path.dirname(file);

            // loop each file in the folder and copy it if it has not been created yet
            shell.ls(path.dirname(file)).forEach((copyFile) => {
                let originalFilePath = folderDirectory + '/' + copyFile;
                let copyFilePath = DEPLOY_FOLDER + '/' + originalFilePath;

                if (!shell.test('-f', copyFilePath)) {
                    console.log('---copy associated lwc/aura file: ',copyFile);
                    shell.cp('-rn', originalFilePath, copyFilePath);
                }
            });
        } else if (!file.includes('-meta.xml')) { //check for associated -meta.xml file to add

            // only copy file if it exists, and is not already being processed
            if (shell.test('-f', file + '-meta.xml') && !filesToDeploy.includes(file + '-meta.xml')) { 
                console.log('-copying meta file to --> ' + fileDeployLocation + '-meta.xml');
                shell.cp('-rn', file + '-meta.xml', fileDeployLocation + '-meta.xml');
            }

        } else if (file.includes('-meta.xml')) { // check for associated non-meta.xml file to add

            let primaryFileName = file.split('-meta.xml')[0];

            // only copy file if it exists, and is not already being processed
            if (shell.test('-f', primaryFileName) && !filesToDeploy.includes(primaryFileName)) {
                console.log('-copying non-meta file to --> ' + DEPLOY_FOLDER + '/' + primaryFileName);
                shell.cp('-rn', primaryFileName, DEPLOY_FOLDER + '/' + primaryFileName);
            }
        }
    });
};

module.exports.createSnapshotFolder = function (filesToSnapshot, snapshotDirectory) {
    console.log('===START create snapshot folder===');
    filesToSnapshot.forEach((file) => {
        
        let fileSnapshotLocation = snapshotDirectory + '/' + file;
        console.log('SNAPSHOT copying file:',file,' to location: ',fileSnapshotLocation);
        
        //create folder for file
        shell.mkdir('-p', path.dirname(fileSnapshotLocation));

        //copy file over
        shell.cp('-rn', file, fileSnapshotLocation);

        // snapshots will only record changed files, not associated files (ie -meta.xml)
    });
}

module.exports.createOrgSnapshot = function (buildId, branchName, snapshotBranch) {
    
    console.log('===START create org snapshot===');

    // copy the "deploy" or "force-app" folder to a temp directory
    this.executeCmd(`cp -a ${DEPLOY_FOLDER}/. ${TEMP_FOLDER}/`, false);

    // stage temp folder to detect changes
    this.executeCmd(`git add ${TEMP_FOLDER}/`,true);

    // retrieve the org version of each file in the temp directory
    shell.exec(`sfdx force:source:retrieve -p ${TEMP_FOLDER}/`, {});

    // identify all files that changed on retrieve
    let changedFiles = this.getChangedFiles(`${TEMP_FOLDER}/`, undefined);
    console.log('snapshot changedFiles: ',changedFiles,'files changed: ',changedFiles.length);

    // unstage files
    this.executeCmd(`git reset ${TEMP_FOLDER}`, true);

    if (changedFiles.length > 0) {
        // copy all changed files in TEMP_FOLDER to snapshot_directory
        this.createSnapshotFolder(changedFiles, `${branchName}/${buildId}`);
    } else {
        // Create folder for current build if not already created
        this.executeCmd(`mkdir -p ${branchName}/${buildId}`, false);
        console.log('=== No changes to snapshot');
    }
}

module.exports.saveOrgSnapshot = function (buildId, branchName, snapshotBranch) {
    // switch to snapshot branch
    this.executeCmd(`git switch --orphan ${snapshotBranch}`, false);
    this.executeCmd(`git pull origin ${snapshotBranch} || true`, false);

    // save snapshot to snapshotBranch
    this.executeCmd(`git add ${branchName}/`, false);
    this.executeCmd(`git commit -m "${buildId}"`, false);
    this.executeCmd('git push', false);

    console.log(`===Snanpshot Saved to branch ${branchName}`);

    // return to previous branch
    this.executeCmd(`git checkout ${branchName}`, false);
}

//deploy to Org
module.exports.deployFiles = function (checkOnly, testLevel) {
    let cmdCheckDeploy = '';

    //run a check only deploy, allowing a quick deploy
    //this will run all test code
    if(checkOnly == 'yes') {
        cmdCheckDeploy = '--checkonly';
    }

    // if checkOnly is not specified, conditionally set testlevel
    if (cmdCheckDeploy === '') {
        if (testLevel == 'RunLocalTests') {
            cmdCheckDeploy = '-l RunLocalTests';
        } else if (testLevel == 'RunAllTestsInOrg') {
            cmdCheckDeploy = '-l RunAllTestsInOrg';
        }
        if (cmdCheckDeploy) console.log('=== Test Coverage is configured to run during the deployment. Remove TEST_LEVEL parameter if deployment should not fail due to insufficient coverage.');
    }

    let deployFiles = `sfdx force:source:deploy -p ${DEPLOY_FOLDER} --verbose ${cmdCheckDeploy}`;
    console.log('=== Deploying');

    this.executeCmd(deployFiles, false, 'Deployment unsuccessful. Review Deployment Status in Salesforce setup to resolve errors.');
};

//execute a CLI command
module.exports.executeCmd = function (cmd, silent, errorMsg='') {
    console.log('executing command: ',cmd);
    
    var params = {};
    if(silent) { params.silent = true; }

    const { stdout, stderr, code } = shell.exec(cmd, params);

    if(code === 0) {
        return stdout;
    } else {
        this.errorMsgAndExit(errorMsg ? errorMsg : stderr);
    }
};

//update commit version to Org
module.exports.errorMsgAndExit = function (message) {
    console.log(CONSOLE_RED, '=== ERROR: ' + message);
    process.exit(1);
};

//update commit version to Org
module.exports.successMsg = function (message) {
    console.log(CONSOLE_GREEN, '=== SUCCESS: ' + message);
};