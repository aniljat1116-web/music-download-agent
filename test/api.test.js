const assert = require('assert');
const app = require('../server/index');

async function testApi() {
  console.log('Testing Express API endpoints...');
  const server = app.listen(5099);

  try {
    // Test 1: /api/validate
    const validRes = await fetch('http://localhost:5099/api/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })
    });
    const validJson = await validRes.json();
    assert.strictEqual(validJson.valid, true, 'Validation endpoint should return valid: true');
    console.log('✅ POST /api/validate [Valid URL] passed');

    const invalidRes = await fetch('http://localhost:5099/api/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://not-youtube.com' })
    });
    const invalidJson = await invalidRes.json();
    assert.strictEqual(invalidJson.valid, false, 'Validation endpoint should return valid: false');
    console.log('✅ POST /api/validate [Invalid URL] passed');

    // Test 2: /api/downloads
    const dlRes = await fetch('http://localhost:5099/api/downloads');
    const dlJson = await dlRes.json();
    assert(Array.isArray(dlJson.downloads), 'Downloads must be an array');
    console.log(`✅ GET /api/downloads passed (${dlJson.count} files currently in downloads folder)`);

    // Test 3: Static React frontend serving
    const frontRes = await fetch('http://localhost:5099/');
    const frontText = await frontRes.text();
    assert(frontText.includes('<div id="root"></div>'), 'Frontend index.html should be served');
    console.log('✅ GET / (Static React Frontend) passed');

    console.log('\n🎉 ALL API TESTS PASSED!\n');
  } finally {
    server.close();
  }
}

testApi().catch(err => {
  console.error('API Test Error:', err);
  process.exit(1);
});
