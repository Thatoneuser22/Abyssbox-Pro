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
    synth.computeTone = (_song, _channelIndex, _samplesPerTick, tone) => { tone.freshlyAllocated = false; };
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

{
    const end = Config.partsPerBeat * 8;
    const held = new Note(48, 0, end, 3);
    held.noteType = 2;
    const state = setup([held, new Note(60, 0, end, 3)]);
    state.song.beatsPerBar = 8;
    state.synth.prevBar = 0;
    state.run(0);
    assert.equal(state.tones.get(0).prevNote, held, 'loop must find the previous occurrence of the same Note');
    state.synth.prevBar = null;
    state.run(0);
    assert.equal(state.tones.get(0).prevNote, null, 'starting playback must not invent a previous bar');
}

{
    const source = new Note(48, 0, 12, 3);
    const target = new Note(50, 12, 24, 3);
    const state = setup([source, new Note(72, 0, 24, 3), target]);
    state.instrument.portamento = true;
    state.run(12);
    const targetTone = Array.from({length: state.tones.count()}, (_, i) => state.tones.get(i)).find(t => t.note === target);
    assert.equal(targetTone.prevNote, source, 'independent voices must honor instrument portamento');
}
{
    const ended = new Note(48, 0, 12, 3);
    const sustained = new Note(55, 0, 24, 3);
    const target = new Note(53, 12, 24, 3);
    const state = setup([ended, sustained, target]);
    state.instrument.portamento = true;
    state.run(12);
    const targetTone = Array.from({length: state.tones.count()}, (_, i) => state.tones.get(i)).find(t => t.note === target);
    assert.equal(targetTone.prevNote, ended, 'portamento must not steal an unrelated sustained voice');
}

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
    const notes = [new Note(48, 0, 24, 3), new Note(52, 0, 24, 3), new Note(55, 0, 24, 3)];
    const state = setup(notes);
    state.instrument.getChord = () => Config.chords.dictionary['strum'];
    state.instrument.strumParts = 2;
    state.run(0);
    assert.equal(state.tones.count(), 1);
    const firstTone = state.tones.get(0);
    state.run(1);
    assert.equal(state.tones.count(), 1);
    state.run(2);
    assert.equal(state.tones.count(), 2);
    assert.equal(state.tones.get(0), firstTone);
    state.run(4);
    assert.equal(state.tones.count(), 3);
    assert.deepEqual([0, 1, 2].map(i => state.tones.get(i).noteStartPart), [0, 2, 4]);
}
{
    const notes = [new Note(48, 0, 48, 3), new Note(52, 12, 48, 3), new Note(55, 24, 48, 3)];
    const state = setup(notes);
    state.instrument.getChord = () => Config.chords.dictionary['strum'];
    state.run(0);
    const firstTone = state.tones.get(0);
    state.run(12);
    assert.equal(state.tones.count(), 2);
    assert.equal(state.tones.get(0), firstTone);
    assert.equal(state.tones.get(1).noteStartPart, 12);
    state.run(24);
    assert.equal(state.tones.count(), 3);
    assert.equal(state.tones.get(0), firstTone);
    assert.equal(state.tones.get(2).noteStartPart, 24);
}
{
    const state = setup([new Note(48, 0, 24, 3), new Note(52, 0, 1, 3)]);
    state.instrument.getChord = () => Config.chords.dictionary['strum'];
    state.instrument.strumParts = 2;
    state.run(0);
    state.run(1);
    assert.equal(state.tones.count(), 1, 'short strummed note must not create a late hanging voice');
}
{
    const c = new Note(48, 0, 24, 6);
    const e = new Note(52, 12, 36, 2);
    const state = setup([c, e]);
    state.instrument.getChord = () => Config.chords.dictionary['arpeggio'];
    state.run(0);
    const arpTone = state.tones.get(0);
    state.synth.channels[0].instruments[0].arpTime = Config.ticksPerArpeggio * 2;
    state.run(12);
    assert.equal(state.tones.count(), 1);
    assert.equal(state.tones.get(0), arpTone);
    assert.deepEqual(arpTone.pitches.slice(0, arpTone.pitchCount), [48, 52]);
    assert.equal(arpTone.note, e, 'selected arpeggio pitch uses its owning note');
    assert.equal(arpTone.note.pins[0].size, 2);
    assert.equal(arpTone.atNoteStart, false, 'new arp pitch must not restart the voice');
    state.run(24);
    assert.equal(state.tones.get(0), arpTone);
    assert.deepEqual(arpTone.pitches.slice(0, arpTone.pitchCount), [52]);
    assert.equal(arpTone.note, e);
    assert.equal(state.synth.channels[0].instruments[0].arpTime, Config.ticksPerArpeggio * 2);
}
{
    const end = Config.partsPerBeat * 4;
    const state = setup([new Note(48, 0, end, 3), new Note(55, 0, end, 3)]);
    state.song.beatsPerBar = 4;
    state.instrument.getChord = () => Config.chords.dictionary['arpeggio'];
    state.run(0);
    const arpTone = state.tones.get(0);
    const nextPattern = state.song.channels[0].patterns[1];
    nextPattern.notes = [new Note(48, 0, end, 3), new Note(55, 0, end, 3)];
    nextPattern.notes[0].continuesLastPattern = true;
    nextPattern.notes[1].continuesLastPattern = true;
    state.song.channels[0].bars[1] = 2;
    state.synth.prevBar = 0;
    state.synth.bar = 1;
    state.run(0);
    assert.equal(state.tones.get(0), arpTone);
    assert.equal(arpTone.forceContinueAtStart, true);
    assert.equal(arpTone.atNoteStart, false);
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
{
    const inspect = (withSlides) => {
        const notes = [new Note(48, 0, 24, 3), new Note(55, 0, 24, 3)];
        if (withSlides) {
            const lowSlide = new Note(50, 6, 18, 3);
            const highSlide = new Note(58, 6, 18, 3);
            lowSlide.noteType = highSlide.noteType = 1;
            notes.push(lowSlide, highSlide);
        }
        const state = setup(notes);
        state.synth.computeTone = Synth.prototype.computeTone;
        state.synth.warmUpSynthesizer(state.song);
        state.run(12);
        assert.equal(state.tones.count(), 2, 'slide controllers must not create oscillator voices');
        return [state.tones.get(0).phaseDeltas[0], state.tones.get(1).phaseDeltas[0]];
    };
    const plain = inspect(false);
    const bent = inspect(true);
    assert.ok(bent[0] > plain[0], 'low slide bends the low voice');
    assert.ok(bent[1] > plain[1], 'high slide bends the high voice');
}
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
{
    const song = new Song();
    const c = new Note(48, 0, 24, 6);
    const e = new Note(52, 12, 36, 2);
    e.noteType = 2;
    const slide = new Note(55, 18, 24, 3);
    slide.noteType = 1;
    song.channels[0].patterns[0].notes = [c, e, slide];
    song.channels[0].bars[0] = 1;
    const check = (restored) => {
        const notes = restored.channels[0].patterns[0].notes;
        assert.equal(notes.length, 3);
        assert.deepEqual(notes.map(n => [n.pitches[0], n.start, n.end, n.noteType]),
            [[48, 0, 24, 0], [52, 12, 36, 2], [55, 18, 24, 1]]);
    };
    const url = song.toBase64String();
    const fromUrl = new Song();
    fromUrl.fromBase64String(url);
    check(fromUrl);
    const fromJson = new Song();
    fromJson.fromJsonObject(song.toJsonObject());
    check(fromJson);

    const corruptUrl = url.replace('%5B48%5D', '%5B-1%5D');
    assert.notEqual(corruptUrl, url, 'test must corrupt the independent-note block');
    const fromCorruptUrl = new Song();
    assert.doesNotThrow(() => fromCorruptUrl.fromBase64String(corruptUrl));
    assert.deepEqual(fromCorruptUrl.channels[0].patterns[0].notes.map(n => n.pitches[0]), [52, 55]);

    const corruptJson = song.toJsonObject();
    corruptJson.channels[0].patterns[0].notes[0].points[0].tick = Number.NaN;
    const fromCorruptJson = new Song();
    assert.doesNotThrow(() => fromCorruptJson.fromJsonObject(corruptJson));
    assert.deepEqual(fromCorruptJson.channels[0].patterns[0].notes.map(n => n.pitches[0]), [52, 55]);
}
console.log('Passed note scheduling regressions and 102400-sample loop playback check.');
