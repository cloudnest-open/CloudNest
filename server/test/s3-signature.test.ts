import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  amzDate,
  scopeDate,
  uriEncode,
  canonicalQuery,
  buildCanonicalRequest,
  buildStringToSign,
  deriveSigningKey,
  signS3Request,
} from '../src/providers/s3-signature.js';

/**
 * SigV4 correctness is proven against the official AWS SigV4 test suite
 * (github.com/aws/aws-sig-v4-test-suite, mirrored on raw.githubusercontent):
 * get-vanilla and get-vanilla-query-order-key. The key below is the suite's
 * published example key — a public test vector, never a real credential.
 */

const SUITE_DATE = new Date('2015-08-30T12:36:00Z');
const SUITE_KEY = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1' };
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function signatureOfSts(sts: string, service = 'service'): string {
  const key = deriveSigningKey(SUITE_KEY.secretAccessKey, scopeDate(SUITE_DATE), SUITE_KEY.region, service);
  return crypto.createHmac('sha256', key).update(sts, 'utf8').digest('hex');
}

test('amz-date and scope date follow the SigV4 formats', () => {
  assert.equal(amzDate(SUITE_DATE), '20150830T123600Z');
  assert.equal(scopeDate(SUITE_DATE), '20150830');
});

test('uriEncode escapes per the SigV4 rules', () => {
  assert.equal(uriEncode('a-b._~'), 'a-b._~');
  assert.equal(uriEncode('space here'), 'space%20here');
  assert.equal(uriEncode('test$file'), 'test%24file');
  assert.equal(uriEncode('a/b/c'), 'a%2Fb%2Fc');
  assert.equal(uriEncode('a/b/c', false), 'a/b/c');
  assert.equal(uriEncode('héllo'), 'h%C3%A9llo');
});

test('canonical query is encoded and sorted by name, then value', () => {
  assert.equal(canonicalQuery({ 'list-type': '2', prefix: 'cloudnest/', 'max-keys': '1000' }),
    'list-type=2&max-keys=1000&prefix=cloudnest%2F');
});

test('suite get-vanilla: canonical request matches byte for byte', () => {
  const { canonicalRequest, signedHeaders } = buildCanonicalRequest({
    method: 'GET',
    pathname: '/',
    query: {},
    headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
    payloadHash: EMPTY_SHA256,
  });
  assert.equal(signedHeaders, 'host;x-amz-date');
  assert.equal(
    canonicalRequest,
    ['GET', '/', '', 'host:example.amazonaws.com\nx-amz-date:20150830T123600Z\n', 'host;x-amz-date', EMPTY_SHA256].join('\n'),
  );
});

test('suite get-vanilla: string to sign and final signature match', () => {
  const { canonicalRequest } = buildCanonicalRequest({
    method: 'GET',
    pathname: '/',
    query: {},
    headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
    payloadHash: EMPTY_SHA256,
  });
  const sts = buildStringToSign(canonicalRequest, SUITE_DATE, SUITE_KEY.region, 'service');
  assert.equal(
    sts,
    ['AWS4-HMAC-SHA256', '20150830T123600Z', '20150830/us-east-1/service/aws4_request', 'bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63'].join('\n'),
  );
  assert.equal(signatureOfSts(sts), '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
});

test('suite get-vanilla-query-order-key: duplicate names order by value', () => {
  const { canonicalRequest } = buildCanonicalRequest({
    method: 'GET',
    pathname: '/',
    query: new URLSearchParams([['Param1', 'value2'], ['Param1', 'Value1']]),
    headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
    payloadHash: EMPTY_SHA256,
  });
  assert.ok(canonicalRequest.startsWith('GET\n/\nParam1=Value1&Param1=value2\n'), canonicalRequest);
  const sts = buildStringToSign(canonicalRequest, SUITE_DATE, SUITE_KEY.region, 'service');
  assert.equal(signatureOfSts(sts), 'eedbc4e291e521cf13422ffca22be7d2eb8146eecf653089df300a15b2382bd1');
});

test('signS3Request output is internally consistent: the authorization header can be recomputed', () => {
  const headers = signS3Request({
    method: 'PUT',
    url: new URL('https://acc123.r2.cloudflarestorage.com/my-bucket/cloudnest/chunk-00007'),
    headers: { 'content-type': 'application/octet-stream' },
    payloadHash: 'UNSIGNED-PAYLOAD',
    credentials: { accessKeyId: 'test-key', secretAccessKey: 'test-secret', region: 'auto' },
    now: SUITE_DATE,
  });
  const auth = headers.authorization!;
  const credMatch = /Credential=([^,]+),/.exec(auth);
  const signedMatch = /SignedHeaders=([^,]+),/.exec(auth);
  const sigMatch = /Signature=([0-9a-f]{64})$/.exec(auth);
  assert.ok(credMatch && signedMatch && sigMatch);
  assert.equal(credMatch[1], 'test-key/20150830/auto/s3/aws4_request');

  // recompute the signature from the header set the signer actually produced
  const { canonicalRequest } = buildCanonicalRequest({
    method: 'PUT',
    pathname: '/my-bucket/cloudnest/chunk-00007',
    query: {},
    headers,
    payloadHash: 'UNSIGNED-PAYLOAD',
  });
  assert.equal(signedMatch[1]!.split(';').every((h) => h in headers), true);
  const sts = buildStringToSign(canonicalRequest, SUITE_DATE, 'auto');
  const key = deriveSigningKey('test-secret', '20150830', 'auto');
  const recomputed = crypto.createHmac('sha256', key).update(sts, 'utf8').digest('hex');
  assert.equal(recomputed, sigMatch[1]!);
});
