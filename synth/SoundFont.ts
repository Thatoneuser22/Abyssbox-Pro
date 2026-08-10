export interface SoundFontPresetInfo {
    name: string;
    bank: number;
    preset: number;
}

interface SoundFontGenerator {
    oper: number;
    amount: number;
    signedAmount: number;
}

interface SoundFontBag {
    genIndex: number;
}

interface SoundFontPresetHeader {
    name: string;
    preset: number;
    bank: number;
    bagIndex: number;
}

interface SoundFontInstrumentHeader {
    name: string;
    bagIndex: number;
}

interface SoundFontSampleHeader {
    name: string;
    start: number;
    end: number;
    startLoop: number;
    endLoop: number;
    sampleRate: number;
    originalPitch: number;
    pitchCorrection: number;
    sampleLink: number;
    sampleType: number;
}

interface GeneratorState {
    startOffset: number;
    endOffset: number;
    startLoopOffset: number;
    endLoopOffset: number;
    keyLow: number;
    keyHigh: number;
    velLow: number;
    velHigh: number;
    instrument: number;
    sampleId: number;
    sampleModes: number;
    coarseTune: number;
    fineTune: number;
    rootKey: number;
    attenuation: number;
}

function newGeneratorState(): GeneratorState {
    return {
        startOffset: 0,
        endOffset: 0,
        startLoopOffset: 0,
        endLoopOffset: 0,
        keyLow: 0,
        keyHigh: 127,
        velLow: 0,
        velHigh: 127,
        instrument: -1,
        sampleId: -1,
        sampleModes: 0,
        coarseTune: 0,
        fineTune: 0,
        rootKey: -1,
        attenuation: 0,
    };
}

function readString(view: DataView, offset: number, length: number): string {
    let result = "";
    for (let i = 0; i < length; i++) {
        const value = view.getUint8(offset + i);
        if (value == 0) break;
        result += String.fromCharCode(value);
    }
    return result.trim();
}

function readFourCC(view: DataView, offset: number): string {
    return String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3),
    );
}

interface ChunkLocation {
    offset: number;
    size: number;
}

function findList(view: DataView, listType: string): ChunkLocation | null {
    let offset = 12;
    while (offset + 8 <= view.byteLength) {
        const id = readFourCC(view, offset);
        const size = view.getUint32(offset + 4, true);
        const dataOffset = offset + 8;
        if (id == "LIST" && size >= 4 && readFourCC(view, dataOffset) == listType) {
            return { offset: dataOffset + 4, size: size - 4 };
        }
        offset = dataOffset + size + (size & 1);
    }
    return null;
}

function findChunk(view: DataView, list: ChunkLocation, id: string): ChunkLocation | null {
    let offset = list.offset;
    const end = list.offset + list.size;
    while (offset + 8 <= end) {
        const chunkId = readFourCC(view, offset);
        const size = view.getUint32(offset + 4, true);
        const dataOffset = offset + 8;
        if (chunkId == id) return { offset: dataOffset, size };
        offset = dataOffset + size + (size & 1);
    }
    return null;
}

function generatorsForBag(bagIndex: number, bags: SoundFontBag[], generators: SoundFontGenerator[]): SoundFontGenerator[] {
    const bag = bags[bagIndex];
    const nextBag = bags[bagIndex + 1];
    if (bag == undefined || nextBag == undefined) return [];
    return generators.slice(bag.genIndex, nextBag.genIndex);
}

function applyGenerators(state: GeneratorState, generators: SoundFontGenerator[]): void {
    for (const generator of generators) {
        switch (generator.oper) {
            case 0: state.startOffset += generator.signedAmount; break;
            case 1: state.endOffset += generator.signedAmount; break;
            case 2: state.startLoopOffset += generator.signedAmount; break;
            case 3: state.endLoopOffset += generator.signedAmount; break;
            case 4: state.startOffset += generator.signedAmount * 32768; break;
            case 12: state.endOffset += generator.signedAmount * 32768; break;
            case 41: state.instrument = generator.amount; break;
            case 43: {
                const low = generator.amount & 0xff;
                const high = (generator.amount >>> 8) & 0xff;
                state.keyLow = Math.max(state.keyLow, low);
                state.keyHigh = Math.min(state.keyHigh, high);
                break;
            }
            case 44: {
                const low = generator.amount & 0xff;
                const high = (generator.amount >>> 8) & 0xff;
                state.velLow = Math.max(state.velLow, low);
                state.velHigh = Math.min(state.velHigh, high);
                break;
            }
            case 45: state.startLoopOffset += generator.signedAmount * 32768; break;
            case 48: state.attenuation += generator.signedAmount; break;
            case 50: state.endLoopOffset += generator.signedAmount * 32768; break;
            case 51: state.coarseTune += generator.signedAmount; break;
            case 52: state.fineTune += generator.signedAmount; break;
            case 53: state.sampleId = generator.amount; break;
            case 54: state.sampleModes = generator.amount; break;
            case 58: state.rootKey = generator.amount <= 127 ? generator.amount : -1; break;
        }
    }
}

export class SoundFontZone {
    public readonly keyLow: number;
    public readonly keyHigh: number;
    public readonly velLow: number;
    public readonly velHigh: number;
    public readonly sampleName: string;
    public readonly sampleRate: number;
    public readonly rootKey: number;
    public readonly tuningCents: number;
    public readonly loopStart: number;
    public readonly loopEnd: number;
    public readonly loopMode: number;
    public readonly gain: number;
    public readonly sampleStart: number;
    public readonly sampleEnd: number;
    private _wave: Float32Array | null = null;

    constructor(
        private readonly _font: SoundFontData,
        state: GeneratorState,
        sample: SoundFontSampleHeader,
    ) {
        this.keyLow = state.keyLow;
        this.keyHigh = state.keyHigh;
        this.velLow = state.velLow;
        this.velHigh = state.velHigh;
        this.sampleName = sample.name;
        this.sampleRate = Math.max(1, sample.sampleRate);

        const start = Math.max(0, sample.start + state.startOffset);
        const end = Math.max(start + 1, sample.end + state.endOffset);
        this.sampleStart = Math.min(start, this._font.samplePointCount - 1);
        this.sampleEnd = Math.min(Math.max(this.sampleStart + 1, end), this._font.samplePointCount);

        const loopStartAbsolute = sample.startLoop + state.startLoopOffset;
        const loopEndAbsolute = sample.endLoop + state.endLoopOffset;
        this.loopStart = Math.max(0, Math.min(this.sampleEnd - this.sampleStart - 1, loopStartAbsolute - this.sampleStart));
        this.loopEnd = Math.max(this.loopStart + 1, Math.min(this.sampleEnd - this.sampleStart, loopEndAbsolute - this.sampleStart));
        this.loopMode = state.sampleModes & 3;

        const headerRoot = sample.originalPitch <= 127 ? sample.originalPitch : 60;
        this.rootKey = state.rootKey >= 0 ? state.rootKey : headerRoot;
        this.tuningCents = state.coarseTune * 100 + state.fineTune + sample.pitchCorrection;
        this.gain = Math.pow(10, -Math.max(0, state.attenuation) / 200.0);
    }

    public getWave(): Float32Array {
        if (this._wave != null) return this._wave;
        this._wave = this._font.getWave(this.sampleStart, this.sampleEnd);
        return this._wave;
    }
}

export class SoundFontPreset {
    public readonly zones: SoundFontZone[] = [];

    constructor(
        public readonly name: string,
        public readonly bank: number,
        public readonly preset: number,
    ) {}
}

export class SoundFontData {
    public readonly presets: SoundFontPreset[] = [];
    public readonly samplePointCount: number;
    private readonly _waveCache: Map<string, Float32Array> = new Map();

    constructor(
        public readonly id: string,
        public readonly name: string,
        private readonly _view: DataView,
        private readonly _sampleDataOffset: number,
        sampleDataSize: number,
    ) {
        this.samplePointCount = Math.floor(sampleDataSize / 2);
    }

    public getPresetInfos(): SoundFontPresetInfo[] {
        return this.presets.map(preset => ({ name: preset.name, bank: preset.bank, preset: preset.preset }));
    }

    public getPreset(bank: number, preset: number): SoundFontPreset | null {
        return this.presets.find(item => item.bank == bank && item.preset == preset) || null;
    }

    public getZone(bank: number, preset: number, key: number, velocity: number = 127): SoundFontZone | null {
        const selectedPreset = this.getPreset(bank, preset) || this.presets[0];
        if (selectedPreset == undefined) return null;

        let fallback: SoundFontZone | null = null;
        let fallbackDistance = Number.POSITIVE_INFINITY;
        for (const zone of selectedPreset.zones) {
            if (velocity < zone.velLow || velocity > zone.velHigh) continue;
            if (key >= zone.keyLow && key <= zone.keyHigh) return zone;

            const distance = key < zone.keyLow ? zone.keyLow - key : key - zone.keyHigh;
            if (distance < fallbackDistance) {
                fallbackDistance = distance;
                fallback = zone;
            }
        }
        return fallback;
    }

    public getWave(start: number, end: number): Float32Array {
        const key = start + ":" + end;
        const cached = this._waveCache.get(key);
        if (cached != undefined) return cached;

        const length = Math.max(1, end - start);
        const wave = new Float32Array(length);
        for (let i = 0; i < length; i++) {
            const sampleIndex = start + i;
            const byteOffset = this._sampleDataOffset + sampleIndex * 2;
            if (byteOffset + 1 >= this._view.byteLength) break;
            wave[i] = this._view.getInt16(byteOffset, true) / 32768.0;
        }
        this._waveCache.set(key, wave);
        return wave;
    }
}

export class SoundFontLibrary {
    private static readonly _fonts: Map<string, SoundFontData> = new Map();
    private static readonly _loading: Map<string, Promise<SoundFontData>> = new Map();

    public static get(id: string): SoundFontData | null {
        return this._fonts.get(id) || null;
    }

    public static async loadFromUrl(url: string): Promise<SoundFontData> {
        const existing = this._fonts.get(url);
        if (existing != undefined) return existing;

        const loading = this._loading.get(url);
        if (loading != undefined) return loading;

        const promise = (async () => {
            const response = await fetch(url);
            if (!response.ok) throw new Error("Could not load SoundFont (HTTP " + response.status + ").");
            const buffer = await response.arrayBuffer();
            const cleanUrl = url.split("?")[0];
            const encodedName = cleanUrl.substring(cleanUrl.lastIndexOf("/") + 1);
            const name = encodedName.length > 0 ? decodeURIComponent(encodedName) : "SoundFont";
            return this.loadFromArrayBuffer(url, name, buffer);
        })();

        this._loading.set(url, promise);
        try {
            return await promise;
        } finally {
            this._loading.delete(url);
        }
    }

    public static loadFromArrayBuffer(id: string, name: string, buffer: ArrayBuffer): SoundFontData {
        const font = parseSoundFont(id, name, buffer);
        this._fonts.set(id, font);
        return font;
    }
}

function parsePresetHeaders(view: DataView, chunk: ChunkLocation): SoundFontPresetHeader[] {
    const result: SoundFontPresetHeader[] = [];
    const count = Math.floor(chunk.size / 38);
    for (let i = 0; i < count; i++) {
        const offset = chunk.offset + i * 38;
        result.push({
            name: readString(view, offset, 20),
            preset: view.getUint16(offset + 20, true),
            bank: view.getUint16(offset + 22, true),
            bagIndex: view.getUint16(offset + 24, true),
        });
    }
    return result;
}

function parseInstrumentHeaders(view: DataView, chunk: ChunkLocation): SoundFontInstrumentHeader[] {
    const result: SoundFontInstrumentHeader[] = [];
    const count = Math.floor(chunk.size / 22);
    for (let i = 0; i < count; i++) {
        const offset = chunk.offset + i * 22;
        result.push({ name: readString(view, offset, 20), bagIndex: view.getUint16(offset + 20, true) });
    }
    return result;
}

function parseBags(view: DataView, chunk: ChunkLocation): SoundFontBag[] {
    const result: SoundFontBag[] = [];
    const count = Math.floor(chunk.size / 4);
    for (let i = 0; i < count; i++) {
        result.push({ genIndex: view.getUint16(chunk.offset + i * 4, true) });
    }
    return result;
}

function parseGenerators(view: DataView, chunk: ChunkLocation): SoundFontGenerator[] {
    const result: SoundFontGenerator[] = [];
    const count = Math.floor(chunk.size / 4);
    for (let i = 0; i < count; i++) {
        const offset = chunk.offset + i * 4;
        result.push({
            oper: view.getUint16(offset, true),
            amount: view.getUint16(offset + 2, true),
            signedAmount: view.getInt16(offset + 2, true),
        });
    }
    return result;
}

function parseSampleHeaders(view: DataView, chunk: ChunkLocation): SoundFontSampleHeader[] {
    const result: SoundFontSampleHeader[] = [];
    const count = Math.floor(chunk.size / 46);
    for (let i = 0; i < count; i++) {
        const offset = chunk.offset + i * 46;
        result.push({
            name: readString(view, offset, 20),
            start: view.getUint32(offset + 20, true),
            end: view.getUint32(offset + 24, true),
            startLoop: view.getUint32(offset + 28, true),
            endLoop: view.getUint32(offset + 32, true),
            sampleRate: view.getUint32(offset + 36, true),
            originalPitch: view.getUint8(offset + 40),
            pitchCorrection: view.getInt8(offset + 41),
            sampleLink: view.getUint16(offset + 42, true),
            sampleType: view.getUint16(offset + 44, true),
        });
    }
    return result;
}

function parseSoundFont(id: string, name: string, buffer: ArrayBuffer): SoundFontData {
    const view = new DataView(buffer);
    if (view.byteLength < 12 || readFourCC(view, 0) != "RIFF" || readFourCC(view, 8) != "sfbk") {
        throw new Error("This file is not a valid SF2 SoundFont.");
    }

    const sdta = findList(view, "sdta");
    const pdta = findList(view, "pdta");
    if (sdta == null || pdta == null) throw new Error("The SF2 is missing required sdta/pdta data.");

    const smpl = findChunk(view, sdta, "smpl");
    const phdrChunk = findChunk(view, pdta, "phdr");
    const pbagChunk = findChunk(view, pdta, "pbag");
    const pgenChunk = findChunk(view, pdta, "pgen");
    const instChunk = findChunk(view, pdta, "inst");
    const ibagChunk = findChunk(view, pdta, "ibag");
    const igenChunk = findChunk(view, pdta, "igen");
    const shdrChunk = findChunk(view, pdta, "shdr");

    if (smpl == null || phdrChunk == null || pbagChunk == null || pgenChunk == null || instChunk == null || ibagChunk == null || igenChunk == null || shdrChunk == null) {
        throw new Error("The SF2 is missing required preset, instrument, or sample data.");
    }

    const font = new SoundFontData(id, name, view, smpl.offset, smpl.size);
    const presetHeaders = parsePresetHeaders(view, phdrChunk);
    const presetBags = parseBags(view, pbagChunk);
    const presetGenerators = parseGenerators(view, pgenChunk);
    const instrumentHeaders = parseInstrumentHeaders(view, instChunk);
    const instrumentBags = parseBags(view, ibagChunk);
    const instrumentGenerators = parseGenerators(view, igenChunk);
    const sampleHeaders = parseSampleHeaders(view, shdrChunk);

    for (let presetIndex = 0; presetIndex < presetHeaders.length - 1; presetIndex++) {
        const header = presetHeaders[presetIndex];
        const nextHeader = presetHeaders[presetIndex + 1];
        const preset = new SoundFontPreset(header.name || ("Preset " + header.preset), header.bank, header.preset);
        let presetGlobal: SoundFontGenerator[] = [];

        for (let bagIndex = header.bagIndex; bagIndex < nextHeader.bagIndex; bagIndex++) {
            const localPresetGenerators = generatorsForBag(bagIndex, presetBags, presetGenerators);
            const instrumentGenerator = localPresetGenerators.find(generator => generator.oper == 41);
            if (instrumentGenerator == undefined) {
                presetGlobal = localPresetGenerators;
                continue;
            }

            const instrumentIndex = instrumentGenerator.amount;
            const instrumentHeader = instrumentHeaders[instrumentIndex];
            const nextInstrumentHeader = instrumentHeaders[instrumentIndex + 1];
            if (instrumentHeader == undefined || nextInstrumentHeader == undefined) continue;

            let instrumentGlobal: SoundFontGenerator[] = [];
            for (let instrumentBagIndex = instrumentHeader.bagIndex; instrumentBagIndex < nextInstrumentHeader.bagIndex; instrumentBagIndex++) {
                const localInstrumentGenerators = generatorsForBag(instrumentBagIndex, instrumentBags, instrumentGenerators);
                const sampleGenerator = localInstrumentGenerators.find(generator => generator.oper == 53);
                if (sampleGenerator == undefined) {
                    instrumentGlobal = localInstrumentGenerators;
                    continue;
                }

                const sample = sampleHeaders[sampleGenerator.amount];
                if (sample == undefined) continue;

                const state = newGeneratorState();
                applyGenerators(state, presetGlobal);
                applyGenerators(state, localPresetGenerators);
                applyGenerators(state, instrumentGlobal);
                applyGenerators(state, localInstrumentGenerators);
                if (state.keyLow > state.keyHigh || state.velLow > state.velHigh) continue;

                preset.zones.push(new SoundFontZone(font, state, sample));
            }
        }

        if (preset.zones.length > 0) font.presets.push(preset);
    }

    font.presets.sort((a, b) => a.bank - b.bank || a.preset - b.preset || a.name.localeCompare(b.name));
    if (font.presets.length == 0) throw new Error("No playable presets were found in this SF2.");
    return font;
}
