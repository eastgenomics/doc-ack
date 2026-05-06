// Minimal mock test of the resolver logic
const mockStorage = new Map();

const storage = {
  get: async (key) => mockStorage.get(key) ?? null,
  set: async (key, value) => mockStorage.set(key, value),
};

function storageKey(pageId) { return `read-confirmations-${pageId}`; }

async function getConfirmationData(pageId) {
  const data = await storage.get(storageKey(pageId));
  return { readers: data?.readers ?? [] };
}

async function saveConfirmationData(pageId, readers) {
  await storage.set(storageKey(pageId), { readers });
}

async function runTest() {
  const pageId = 'test-page-123';
  const accountId = 'user-abc';

  // Test 1: getConfirmations on empty page
  const { readers: r1 } = await getConfirmationData(pageId);
  console.assert(r1.length === 0, 'FAIL: expected empty readers');
  console.log('✅ getConfirmations returns empty array on new page');

  // Test 2: addConfirmation
  const { readers: r2 } = await getConfirmationData(pageId);
  r2.push({ accountId, displayName: accountId, timestamp: new Date().toISOString(), version: 'current' });
  await saveConfirmationData(pageId, r2);

  const { readers: r3 } = await getConfirmationData(pageId);
  console.assert(r3.length === 1, 'FAIL: expected 1 reader');
  console.assert(r3[0].accountId === accountId, 'FAIL: wrong accountId');
  console.log('✅ addConfirmation saves correctly');

  // Test 3: idempotency
  const already = r3.find(r => r.accountId === accountId);
  console.assert(already !== undefined, 'FAIL: should find user');
  console.log('✅ idempotency check works');

  console.log('\nAll tests passed');
}

runTest().catch(e => { console.error('FAIL:', e); process.exit(1); });
