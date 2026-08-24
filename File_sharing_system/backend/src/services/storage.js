const AWS = require('aws-sdk');
const CircuitBreaker = require('opossum');
const pRetryModule = require('p-retry');
// p-retry v5+ ships as an ESM default export; when CommonJS `require`s it, the
// function lives on `.default` instead of being the module itself. Handle both
// shapes so this works whether p-retry resolves to v4-style CJS or v5+ ESM interop.
const retry = typeof pRetryModule === 'function' ? pRetryModule : pRetryModule.default;

const s3 = new AWS.S3({
  endpoint: process.env.B2_ENDPOINT,
  region: process.env.B2_REGION,
  accessKeyId: process.env.B2_KEY_ID,
  secretAccessKey: process.env.B2_APPLICATION_KEY,
  signatureVersion: 'v4'
});

const BUCKET = process.env.B2_BUCKET;

const breakerOptions = {
  timeout: 60000,          // fail fast after 60s (was 15s — too tight for multi-MB managed uploads)
  errorThresholdPercentage: 50,
  resetTimeout: 10000
};

/** Upload an already-encrypted buffer/stream. Only ciphertext should ever reach here.
 *  Uses the S3 managed upload (not putObject) because putObject requires a
 *  known Content-Length upfront, which a live encryption stream doesn't have —
 *  managed upload buffers/multiparts automatically for streams of unknown size. */
async function uploadObject(key, body, contentType = 'application/octet-stream') {
  const breaker = new CircuitBreaker(
    () => retry(() => new AWS.S3.ManagedUpload({
      service: s3,
      params: { Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }
    }).promise(), { retries: 3, factor: 2, minTimeout: 500 }),
    breakerOptions
  );
  return breaker.fire();
}

/** Multipart upload for large/chunked files. Returns { uploadId }. */
async function createMultipartUpload(key, contentType = 'application/octet-stream') {
  const res = await s3.createMultipartUpload({ Bucket: BUCKET, Key: key, ContentType: contentType }).promise();
  return res.UploadId;
}

async function uploadPart(key, uploadId, partNumber, body) {
  const breaker = new CircuitBreaker(
    () => retry(() => s3.uploadPart({
      Bucket: BUCKET, Key: key, UploadId: uploadId, PartNumber: partNumber, Body: body
    }).promise(), { retries: 3, factor: 2, minTimeout: 500 }),
    breakerOptions
  );
  const res = await breaker.fire();
  return { ETag: res.ETag, PartNumber: partNumber };
}

async function completeMultipartUpload(key, uploadId, parts) {
  return s3.completeMultipartUpload({
    Bucket: BUCKET, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts }
  }).promise();
}

async function abortMultipartUpload(key, uploadId) {
  return s3.abortMultipartUpload({ Bucket: BUCKET, Key: key, UploadId: uploadId }).promise();
}

/** Streamed download of ciphertext — pipe this into createDecryptStream. */
function getObjectStream(key) {
  return s3.getObject({ Bucket: BUCKET, Key: key }).createReadStream();
}

/** Short-lived presigned URL, cached in Redis by the caller to avoid re-signing every request. */
function getPresignedDownloadUrl(key, expiresSeconds = 300) {
  return s3.getSignedUrlPromise('getObject', { Bucket: BUCKET, Key: key, Expires: expiresSeconds });
}

async function deleteObject(key) {
  return s3.deleteObject({ Bucket: BUCKET, Key: key }).promise();
}

module.exports = {
  uploadObject,
  createMultipartUpload,
  uploadPart,
  completeMultipartUpload,
  abortMultipartUpload,
  getObjectStream,
  getPresignedDownloadUrl,
  deleteObject
};