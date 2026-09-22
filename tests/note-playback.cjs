// Run after: npx tsc && npx rollup build/synth/synth.js --file build/synth-regression.cjs --format cjs --context exports --plugin @rollup/plugin-node-resolve
const assert = require('node:assert/strict');
global.localStorage = { getItem: () => null, setItem: () => {} };
global.window = global;
global.document = { title: '' };
if (!global.navigator) global.navigator = { userAgent: '', platform: '' };
const { Song, Synth, Note, Config } = require('../build/synth-regression.cjs');

function setup(notes) {
    const song = new Song();
    const pattern = song.channels[0].patterns[0];
    pattern.notes = notes;
    song.channels[0].bars[0] = 1;
    const synth = new Synth(song);
    synth.syncSongState();
    synth.computeTone = () => {};
    synth.bar = 0;
    synth.beat = synth.part = synth.tick = 0;
    const instrument = song.channels[0].instruments[0];
    instrument.voiceMode = 0;
    instrument.getChord = () => Config.chords.dictionary['simultaneous'];
    const tones = synth.channels[0].instruments[0].activeTones;
    const run = (part) => {
        synth.beat = Math.floor(part / Config.partsPerBeat);
        synth.part = part % Config.partsPerBeat;
        synth.determineCurrentActiveTones(song, 0, synth.getSamplesPerTick(), true);
    };
    return { song, synth, instrument, tones, run };
}

// Pattern order can change while a voice is sustained (editing or importing).
{
    const sustained = new Note(48, 0, 24, 3);
    const inserted = new Note(36, 0, 24, 3);
    const state = setup([sustained, inserted]);
    state.run(0);
    const oldTone = state.tones.get(0);
    const replacement = new Note(60, 0, 24, 3);
    state.song.channels[0].patterns[0].notes = [replacement, sustained];
    state.run(1);
    assert.equal(state.tones.get(1), oldTone, 'adding a voice must preserve the other sustained oscillator');
}

// Reusing the same pattern in adjacent bars reuses the Note object too.
{
    const end = Config.partsPerBeat * 8;
    const held = new Note(48, 0, end, 3);
    held.noteType = 2; // portamento
    const state = setup([held, new Note(60, 0, end, 3)]);
    state.song.beatsPerBar = 8;
    state.synth.prevBar = 0;
    state.run(0);
    assert.equal(state.tones.get(0).prevNote, held, 'loop must find the previous occurrence of the same Note');
    state.synth.prevBar = null;
    state.run(0);
    assert.equal(state.tones.get(0).prevNote, null, 'starting playback must not invent a previous bar');
}

// Instrument portamento also applies to independent voices.
{
    const source = new Note(48, 0, 12, 3);
    const target = new Note(50, 12, 24, 3);
    const state = setup([source, new Note(72, 0, 24, 3), target]);
    state.instrument.portamento = true;
    state.run(12);
    const targetTone = Array.from({length: state.tones.count()}, (_, i) => state.tones.get(i)).find(t => t.note === target);
    assert.equal(targetTone.prevNote, source, 'independent voices must honor instrument portamento');
}

// Mono must suppress overlapping voices, while legato must reuse a voice
// across touching notes instead of restarting its attack.
{
    const first = new Note(48, 0, 24, 3);
    const second = new Note(60, 12, 36, 3);
    const state = setup([first, second]);
    state.run(12);
    assert.equal(state.tones.count(), 2, 'Poly should play both overlapping notes');
    state.instrument.voiceMode = 1;
    state.run(12);
    assert.equal(state.tones.count(), 1, 'Mono should keep only one active note');
    assert.equal(state.tones.get(0).note, second, 'Mono should prioritize the newest note');
}
{
    const first = new Note(48, 0, 12, 3);
    const second = new Note(60, 12, 24, 3);
    const state = setup([first, second]);
    state.instrument.voiceMode = 2;
    state.run(0);
    const originalTone = state.tones.get(0);
    state.run(12);
    assert.equal(state.tones.get(0), originalTone, 'Legato should reuse the running tone');
    assert.equal(state.tones.get(0).prevNote, first, 'Legato should connect touching notes');
}
// Render through a loop with overlap, slide controllers, and portamento.
// This covers the real envelope/oscillator path in addition to scheduling.
{
    const end = Config.partsPerBeat * 4;
    const held = new Note(48, 0, end, 3);
    const slide = new Note(55, 6, 12, 3);
    slide.noteType = 1;
    const porta = new Note(60, 12, end, 3);
    porta.noteType = 2;
    const state = setup([held, slide, porta]);
    state.synth.computeTone = Synth.prototype.computeTone;
    state.song.beatsPerBar = 4;
    state.song.loopStart = 0;
    state.song.loopLength = 1;
    state.song.tempo = 300;
    state.instrument.portamento = true;
    state.instrument.portamentoTicks = 6;
    state.synth.warmUpSynthesizer(state.song);
    let energy = 0;
    const left = new Float32Array(2048);
    const right = new Float32Array(2048);
    for (let block = 0; block < 50; block++) {
        state.synth.synthesize(left, right, left.length, true);
        for (let i = 0; i < left.length; i++) {
            assert.ok(Number.isFinite(left[i]) && Number.isFinite(right[i]), 'rendered audio must stay finite');
            energy += left[i] * left[i] + right[i] * right[i];
        }
    }
    assert.ok(energy > 0, 'regression song must produce audio');
}
console.log('Passed note scheduling regressions and 102400-sample loop playback check.');
