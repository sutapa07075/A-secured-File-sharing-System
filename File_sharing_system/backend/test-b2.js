// Standalone test — bypasses the whole app, just checks if we can reach and
// authenticate against your Backblaze B2 bucket via the S3-compatible API.
// Run with: node test-b2.js  (from inside the backend folder, after npm install)
require('dotenv').config();
const AWS = require('aws-sdk');

console.log('Testing with:');
console.log('  B2_ENDPOINT =', process.env.B2_ENDPOINT);
console.log('  B2_REGION   =', process.env.B2_REGION);
console.log('  B2_BUCKET   =', process.env.B2_BUCKET);
console.log('  B2_KEY_ID   =', process.env.B2_KEY_ID);
console.log('  key length  =', process.env.B2_APPLICATION_KEY?.length);
console.log('');

const s3 = new AWS.S3({
  endpoint: process.env.B2_ENDPOINT,
  region: process.env.B2_REGION,
  accessKeyId: process.env.B2_KEY_ID,
  secretAccessKey: process.env.B2_APPLICATION_KEY,
  signatureVersion: 'v4'
});

async function main() {
  console.log('Step 1: listing buckets (tests connectivity + auth)...');
  try {
    const buckets = await s3.listBuckets().promise();
    console.log('  OK — reachable and authenticated. Buckets visible to this key:');
    buckets.Buckets.forEach((b) => console.log('   -', b.Name));
  } catch (err) {
    if (err.code === 'AccessDenied') {
      console.log('  Skipped: this key is scoped to one bucket only, so it cannot list all');
      console.log('  buckets on the account. That is expected and fine — moving on to the');
      console.log('  real test, which is whether it can write to its own bucket.');
    } else {
      console.error('  FAILED at listBuckets:', err.code, '-', err.message);
      console.error('  This means the problem is network/auth, not our upload code.');
      return;
    }
  }

  console.log('\nStep 2: uploading a tiny test object...');
  try {
    const result = await s3.putObject({
      Bucket: process.env.B2_BUCKET,
      Key: 'connectivity-test.txt',
      Body: Buffer.from('hello from the test script'),
      ContentType: 'text/plain'
    }).promise();
    console.log('  OK — upload succeeded. ETag:', result.ETag);
  } catch (err) {
    console.error('  FAILED at putObject:', err.code, '-', err.message);
  }
}

main();
