const utils = require('./utils.js');

//global configs
const KEY_FILE_LOCATION = 'server.key'; // location of certificate key file in repository
const DEFAULT_LOGIN_URL = 'https://login.salesforce.com'; // deafult salesforce login url

//load all dependencies
utils.setup();

//get arguments from command line
const args = require('minimist')(process.argv.slice(2));

const BUILD_NUMBER = args['buildNumber'];       // required
const BRANCH = args['branch'];                  // required

const SNAPSHOT_BRANCH = args['snapshotBranch']; // optional
const CHECK_DEPLOY = args['checkDeploy'];       // optional
const TEST_LEVEL = args['testLevel'];           // optional

const CONSUMER_KEY = args['consumerKey'];       // conditionally required
const USERNAME = args['username'];              // conditionally required
const AUTH_URL = args['authUrl'];               // conditionally required
let LOGIN_URL = args['loginURL'];               // conditionally required

//validate inputs
let BUILD_ID = '';
if (!BRANCH) {
    utils.errorMsgAndExit('The current branch is required for deployment.');
} else if (!BUILD_NUMBER) {
    utils.errorMsgAndExit('The build Id is required for deployment.');
} else {
    let datetime = new Date().toISOString().split('.')[0];
    BUILD_ID = `${BRANCH}_build#${BUILD_NUMBER}_${datetime}`;
}

if (!AUTH_URL && (USERNAME || CONSUMER_KEY)) {
    if (!USERNAME) utils.errorMsgAndExit('USERNAME is required for JWT authentication.');
    if (!CONSUMER_KEY) utils.errorMsgAndExit('CONSUMER_KEY is required for JWT authentication.');
} else if (!AUTH_URL) {
    utils.errorMsgAndExit('AUTH_URL or USERNAME/CONSUMER_KEY are required for org authentication.');
}

// set login URL or use default
if(!LOGIN_URL) {LOGIN_URL = DEFAULT_LOGIN_URL};

// start authentication
if (AUTH_URL) {
    console.log('start auth url authentication');
    utils.authenticateOrg(AUTH_URL);
} else {
    console.log('start jwt authentication');
    utils.authenticateOrgJWT(KEY_FILE_LOCATION, CONSUMER_KEY, USERNAME, LOGIN_URL);
}
console.log('authenticated');

//get current version of the org
let previousCommit = utils.getLatestDeploymentLog(BRANCH);
let currentCommit = utils.getMostRecentCommitFromRepo();
console.log('previousCommit: ',previousCommit,' - currentCommit:',currentCommit);

if(previousCommit) {

    //get any files changed to be deployed
    let changedFiles = utils.getChangedFiles(previousCommit, currentCommit);
    
    if(changedFiles.length > 0) {
        
        //create deployment folder with changed files
        utils.createDeploymentFolder(changedFiles);

        // create snapshot on snapshot branch
        if (SNAPSHOT_BRANCH) utils.createOrgSnapshot(BUILD_ID, BRANCH, SNAPSHOT_BRANCH);

        // deploy the new folder to the org
        utils.deployFiles(CHECK_DEPLOY, TEST_LEVEL);

        // commit the snapshot branch
        if (SNAPSHOT_BRANCH) utils.saveOrgSnapshot(BUILD_ID, BRANCH, SNAPSHOT_BRANCH);
        
        //update commit version
        utils.updateCommitVersion(currentCommit, BRANCH);
    } else {

        console.log('=== No files to deploy');
        utils.updateCommitVersion(currentCommit, BRANCH);
        console.log(`No changed files were identified from the previous deployment. Commit ${currentCommit} added to Release_Log__c.`);
    }
} else {
    // update commit version on Release Log and exit
    utils.updateCommitVersion(currentCommit, BRANCH);
    utils.errorMsgAndExit(`Org has no records in Release_Log__c for branch ${BRANCH}. Version ${currentCommit} added to Release_Log__c as starting point. You may modify the commit on this record to set your starting point for deployment. Commit metadata changes and re-run pipline to upgrade.`);
}

utils.successMsg('Deployment => ' + currentCommit);