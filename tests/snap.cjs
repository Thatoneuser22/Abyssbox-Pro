const assert = require('node:assert/strict');

(async () => {
    const { getPianoRollSnapDivision: snap } = await import('../build/editor/PianoRollSnap.js');
    assert.equal(snap('step12', 24, 3, 8), 4, '÷3 rhythm: half step is 1/6 beat');
    assert.equal(snap('step12', 24, 6, 8), 2, '÷6 rhythm: half step is 1/12 beat');
    assert.equal(snap('step', 24, 3, 8), 8);
    assert.equal(snap('step', 24, 6, 8), 4);
    assert.equal(snap('beat12', 24, 6, 8), 12, 'Beat snap does not follow rhythm');
    assert.equal(snap('step14', 24, 4, 8), null, 'unrepresentable 1.5-part grid is disabled');
    assert.equal(snap('step16', 24, 6, 8), null, 'sub-part grid is disabled');
    console.log('Passed rhythm-relative and unsupported-resolution snap checks.');
})().catch(error => { console.error(error); process.exitCode = 1; });
