import { Config, InstrumentType } from "../synth/SynthConfig";
import { Channel, Instrument, Note, Pattern } from "../synth/synth";

const patternBase: number = 20_480;
const maxFlpFileBytes: number = 20 * 1_024 * 1_024;
const maxFlpEvents: number = 140_000;
const maxPatternNotes: number = 10_000;
const maxPlaylistClips: number = 4_000;
const maxTotalPatternNotes: number = 20_000;
const maxExpandedNotes: number = 28_000;
const maxImportedRackChannels: number = 48;

class ByteReader {
    private readonly _view: DataView;
    private _index: number = 0;
    private readonly _end: number;

    constructor(buffer: ArrayBuffer, byteOffset: number = 0, byteLength?: number) {
        const length: number = byteLength == undefined ? buffer.byteLength - byteOffset : byteLength;
        this._view = new DataView(buffer, byteOffset, length);
        this._end = length;
    }

    public get index(): number {
        return this._index;
    }

    public get remaining(): number {
        return this._end - this._index;
    }

    public get hasMore(): boolean {
        return this._index < this._end;
    }

    public readUint8(): number {
        this.require(1);
        return this._view.getUint8(this._index++);
    }

    public readUint16(): number {
        this.require(2);
        const value: number = this._view.getUint16(this._index, true);
        this._index += 2;
        return value;
    }

    public readUint32(): number {
        this.require(4);
        const value: number = this._view.getUint32(this._index, true);
        this._index += 4;
        return value;
    }

    public readFloat32(): number {
        this.require(4);
        const value: number = this._view.getFloat32(this._index, true);
        this._index += 4;
        return value;
    }

    public readAscii(length: number): string {
        this.require(length);
        let result: string = "";
        for (let i: number = 0; i < length; i++) {
            result += String.fromCharCode(this._view.getUint8(this._index++));
        }
        return result;
    }

    public readBytes(length: number): Uint8Array {
        this.require(length);
        const result: Uint8Array = new Uint8Array(
            this._view.buffer,
            this._view.byteOffset + this._index,
            length,
        ).slice();
        this._index += length;
        return result;
    }

    public readVarInt(): number {
        let value: number = 0;
        let shift: number = 0;

        for (let i: number = 0; i < 5; i++) {
            const byte: number = this.readUint8();
            value |= (byte & 0x7f) << shift;
            if ((byte & 0x80) == 0) return value >>> 0;
            shift += 7;
        }

        throw new Error("Invalid FL Studio variable-length event size.");
    }

    public skip(length: number): void {
        this.require(length);
        this._index += length;
    }

    private require(length: number): void {
        if (this._index + length > this._end) {
            throw new Error("Unexpected end of FL Studio project.");
        }
    }
}

interface FlChannelInfo {
    index: number;
    name: string;
    type: number;
    mono: boolean;
    portamento: boolean;
    portamentoTicks: number;
}

interface FlNote {
    position: number;
    flags: number;
    rackChannel: number;
    length: number;
    key: number;
    velocity: number;
}

interface FlPattern {
    id: number;
    name: string;
    length: number;
    notes: FlNote[];
}

interface PlaylistClip {
    position: number;
    patternId: number;
    length: number;
    trackReverseIndex: number;
}

interface PlacedNote extends FlNote {
    start: number;
    end: number;
}

export interface FlpImportResult {
    title: string;
    tempo: number;
    beatsPerBar: number;
    pitchChannels: Channel[];
    noiseChannels: Channel[];
    modChannels: Channel[];
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function readUint16(bytes: Uint8Array, offset: number): number {
    return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32(bytes: Uint8Array, offset: number): number {
    return (
        bytes[offset]
        | (bytes[offset + 1] << 8)
        | (bytes[offset + 2] << 16)
        | (bytes[offset + 3] << 24)
    ) >>> 0;
}

function decodeText(bytes: Uint8Array): string {
    if (bytes.length == 0) return "";

    let looksUtf16: boolean = bytes.length >= 2;
    if (looksUtf16) {
        let zeroHighBytes: number = 0;
        let checkedPairs: number = 0;

        for (let i: number = 1; i < bytes.length; i += 2) {
            checkedPairs++;
            if (bytes[i] == 0) zeroHighBytes++;
        }

        looksUtf16 = checkedPairs > 0 && zeroHighBytes / checkedPairs > 0.45;
    }

    if (looksUtf16) {
        let result: string = "";
        for (let i: number = 0; i + 1 < bytes.length; i += 2) {
            const code: number = bytes[i] | (bytes[i + 1] << 8);
            if (code == 0) break;
            result += String.fromCharCode(code);
        }
        return result;
    }

    let end: number = bytes.indexOf(0);
    if (end < 0) end = bytes.length;

    try {
        return new TextDecoder("utf-8").decode(bytes.subarray(0, end));
    } catch {
        let result: string = "";
        for (let i: number = 0; i < end; i++) result += String.fromCharCode(bytes[i]);
        return result;
    }
}

function parseNotes(bytes: Uint8Array): FlNote[] {
    const notes: FlNote[] = [];
    const noteSize: number = 24;
    const noteCount: number = Math.floor(bytes.length / noteSize);

    if (noteCount > maxPatternNotes) {
        throw new Error(
            "One FL Studio pattern contains too many piano-roll notes to import safely. "
            + "Split the project into smaller patterns or export MIDI.",
        );
    }

    for (let noteIndex: number = 0; noteIndex < noteCount; noteIndex++) {
        const offset: number = noteIndex * noteSize;
        const position: number = readUint32(bytes, offset);
        const flags: number = readUint16(bytes, offset + 4);
        const rackChannel: number = readUint16(bytes, offset + 6);
        const length: number = readUint32(bytes, offset + 8);
        const key: number = readUint16(bytes, offset + 12);
        const velocity: number = bytes[offset + 21];

        notes.push({
            position,
            flags,
            rackChannel,
            length: Math.max(1, length),
            key,
            velocity: Math.max(1, velocity),
        });
    }

    return notes;
}

function scorePlaylistSize(bytes: Uint8Array, itemSize: number): number {
    if (itemSize <= 0 || bytes.length < itemSize || bytes.length % itemSize != 0) return -1;

    let score: number = 0;

    let clipCount: number = 0;

    for (let offset: number = 0; offset + itemSize <= bytes.length; offset += itemSize) {
        if (clipCount >= maxPlaylistClips) break;
        const itemIndex: number = readUint16(bytes, offset + 6);
        const length: number = readUint32(bytes, offset + 8);

        if (itemIndex >= patternBase && itemIndex < patternBase + 10_000) score += 3;
        if (length < 10_000_000) score++;
    }

    return score;
}

function parsePlaylist(bytes: Uint8Array): PlaylistClip[] {
    const clips: PlaylistClip[] = [];
    const size32Score: number = scorePlaylistSize(bytes, 32);
    const size60Score: number = scorePlaylistSize(bytes, 60);

    let itemSize: number = 32;
    if (size60Score > size32Score) itemSize = 60;

    if (bytes.length < itemSize) return clips;

    let clipCount: number = 0;

    for (let offset: number = 0; offset + itemSize <= bytes.length; offset += itemSize) {
        if (clipCount >= maxPlaylistClips) break;
        const position: number = readUint32(bytes, offset);
        const itemIndex: number = readUint16(bytes, offset + 6);
        const length: number = readUint32(bytes, offset + 8);
        const trackReverseIndex: number = readUint16(bytes, offset + 12);

        if (itemIndex < patternBase) continue;

        const patternId: number = itemIndex - patternBase;
        if (patternId <= 0) continue;

        clips.push({
            position,
            patternId,
            length,
            trackReverseIndex,
        });
        clipCount++;
    }

    return clips;
}

function getOrCreateChannel(channels: Map<number, FlChannelInfo>, index: number): FlChannelInfo {
    let channel: FlChannelInfo | undefined = channels.get(index);

    if (channel == undefined) {
        channel = {
            index,
            name: `Channel ${index + 1}`,
            type: 0,
            mono: false,
            portamento: false,
            portamentoTicks: 6,
        };
        channels.set(index, channel);
    }

    return channel;
}

function looksLikeAbyssDrumChannel(name: string): boolean {
    return /^Drum\s+\d+/i.test(name.trim());
}

function compactChannels(channels: Channel[], maxLength: number): void {
    while (channels.length > maxLength) {
        let bestChannelIndexA: number = channels.length - 2;
        let bestChannelIndexB: number = channels.length - 1;
        let fewestConflicts: number = Number.MAX_VALUE;
        let fewestGaps: number = Number.MAX_VALUE;

        for (let channelIndexA: number = 0; channelIndexA < channels.length - 1; channelIndexA++) {
            for (let channelIndexB: number = channelIndexA + 1; channelIndexB < channels.length; channelIndexB++) {
                const channelA: Channel = channels[channelIndexA];
                const channelB: Channel = channels[channelIndexB];

                let conflicts: number = 0;
                let gaps: number = 0;

                for (
                    let barIndex: number = 0;
                    barIndex < channelA.bars.length && barIndex < channelB.bars.length;
                    barIndex++
                ) {
                    if (channelA.bars[barIndex] != 0 && channelB.bars[barIndex] != 0) conflicts++;
                    if (channelA.bars[barIndex] == 0 && channelB.bars[barIndex] == 0) gaps++;
                }

                if (
                    conflicts < fewestConflicts
                    || (conflicts == fewestConflicts && gaps < fewestGaps)
                ) {
                    bestChannelIndexA = channelIndexA;
                    bestChannelIndexB = channelIndexB;
                    fewestConflicts = conflicts;
                    fewestGaps = gaps;
                }
            }
        }

        const channelA: Channel = channels[bestChannelIndexA];
        const channelB: Channel = channels[bestChannelIndexB];
        const channelAInstrumentCount: number = channelA.instruments.length;
        const channelAPatternCount: number = channelA.patterns.length;

        for (const instrument of channelB.instruments) {
            channelA.instruments.push(instrument);
        }

        for (const pattern of channelB.patterns) {
            pattern.instruments[0] += channelAInstrumentCount;
            channelA.patterns.push(pattern);
        }

        for (
            let barIndex: number = 0;
            barIndex < channelA.bars.length && barIndex < channelB.bars.length;
            barIndex++
        ) {
            if (channelA.bars[barIndex] == 0 && channelB.bars[barIndex] != 0) {
                channelA.bars[barIndex] = channelB.bars[barIndex] + channelAPatternCount;
            }
        }

        channels.splice(bestChannelIndexB, 1);
    }
}

export function importFlStudioProject(buffer: ArrayBuffer): FlpImportResult {
    if (buffer.byteLength <= 0 || buffer.byteLength > maxFlpFileBytes) {
        throw new Error("FL Studio project is empty or too large to import safely.");
    }

    const file: ByteReader = new ByteReader(buffer);

    if (file.remaining < 14 || file.readAscii(4) != "FLhd") {
        throw new Error("This is not an FL Studio project.");
    }

    const headerSize: number = file.readUint32();
    if (headerSize < 6) throw new Error("Invalid FL Studio header.");

    /*const format: number =*/ file.readUint16();
    /*const declaredChannelCount: number =*/ file.readUint16();
    const ppq: number = file.readUint16();

    if (headerSize > 6) file.skip(headerSize - 6);
    if (ppq < 24 || ppq > 9_600) throw new Error("Invalid FL Studio PPQ value.");

    let dataBytes: Uint8Array | null = null;

    while (file.hasMore) {
        if (file.remaining < 8) break;

        const chunkName: string = file.readAscii(4);
        const chunkLength: number = file.readUint32();

        if (chunkLength > file.remaining) {
            throw new Error("Invalid FL Studio chunk length.");
        }

        if (chunkName == "FLdt") {
            dataBytes = file.readBytes(chunkLength);
            break;
        }

        file.skip(chunkLength);
    }

    if (dataBytes == null) {
        throw new Error("No FL Studio event data was found.");
    }

    const channels: Map<number, FlChannelInfo> = new Map();
    const patterns: Map<number, FlPattern> = new Map();
    const arrangements: Map<number, Uint8Array[]> = new Map();

    let currentChannel: number = -1;
    let currentPattern: number = -1;
    let currentArrangement: number = 0;
    let selectedArrangement: number = 0;

    let title: string = "Imported FL Studio Project";
    let tempo: number = 120;
    let numerator: number = 4;
    let denominator: number = 4;

    const data: ByteReader = new ByteReader(dataBytes.buffer, dataBytes.byteOffset, dataBytes.byteLength);

    let eventCount: number = 0;

    while (data.hasMore) {
        eventCount++;
        if (eventCount > maxFlpEvents) {
            throw new Error("FL Studio project has too many events to import safely.");
        }

        const eventId: number = data.readUint8();

        let numberValue: number | null = null;
        let bytesValue: Uint8Array | null = null;

        if (eventId < 64) {
            numberValue = data.readUint8();
        } else if (eventId < 128) {
            numberValue = data.readUint16();
        } else if (eventId < 192) {
            numberValue = data.readUint32();
        } else {
            const length: number = data.readVarInt();
            if (length > data.remaining) {
                throw new Error("Invalid FL Studio event length.");
            }
            bytesValue = data.readBytes(length);
        }

        switch (eventId) {
            case 17:
                numerator = Math.max(1, numberValue! | 0);
                break;

            case 18:
                denominator = Math.max(1, numberValue! | 0);
                break;

            case 21:
                if (currentChannel >= 0) {
                    getOrCreateChannel(channels, currentChannel).type = numberValue! | 0;
                }
                break;

            case 64:
                currentChannel = numberValue! | 0;
                getOrCreateChannel(channels, currentChannel);
                break;

            case 65:
                currentPattern = numberValue! | 0;
                if (!patterns.has(currentPattern)) {
                    patterns.set(currentPattern, {
                        id: currentPattern,
                        name: `Pattern ${currentPattern}`,
                        length: 0,
                        notes: [],
                    });
                }
                break;

            case 99:
                currentArrangement = numberValue! | 0;
                if (!arrangements.has(currentArrangement)) arrangements.set(currentArrangement, []);
                break;

            case 100:
                selectedArrangement = numberValue! | 0;
                break;

            case 156:
                tempo = clamp(Math.round(numberValue! / 1000), Config.tempoMin, Config.tempoMax);
                break;

            case 164:
                if (currentPattern >= 0) {
                    const pattern: FlPattern | undefined = patterns.get(currentPattern);
                    if (pattern != undefined) pattern.length = numberValue! >>> 0;
                }
                break;

            case 192:
                if (currentChannel >= 0 && bytesValue != null) {
                    getOrCreateChannel(channels, currentChannel).name = decodeText(bytesValue);
                }
                break;

            case 193:
                if (currentPattern >= 0 && bytesValue != null) {
                    const pattern: FlPattern | undefined = patterns.get(currentPattern);
                    if (pattern != undefined) pattern.name = decodeText(bytesValue);
                }
                break;

            case 194:
                if (bytesValue != null) {
                    const decoded: string = decodeText(bytesValue).trim();
                    if (decoded.length > 0) title = decoded;
                }
                break;

            case 221:
                if (currentChannel >= 0 && bytesValue != null && bytesValue.length >= 9) {
                    const channel: FlChannelInfo = getOrCreateChannel(channels, currentChannel);
                    const slide: number = readUint32(bytesValue, 4);
                    const flags: number = bytesValue[8];

                    channel.mono = (flags & 1) != 0;
                    channel.portamento = (flags & 2) != 0;
                    channel.portamentoTicks = clamp(Math.round(slide / 1660 * 48), 1, 48);
                }
                break;

            case 224:
                if (currentPattern >= 0 && bytesValue != null) {
                    const pattern: FlPattern | undefined = patterns.get(currentPattern);

                    if (pattern != undefined) {
                        pattern.notes = parseNotes(bytesValue);

                        let totalPatternNotes: number = 0;
                        for (const current of patterns.values()) {
                            totalPatternNotes += current.notes.length;
                            if (totalPatternNotes > maxTotalPatternNotes) {
                                throw new Error(
                                    "This FL Studio project contains too many piano-roll notes to import safely.",
                                );
                            }
                        }
                    }
                }
                break;

            case 233:
                if (bytesValue != null) {
                    if (!arrangements.has(currentArrangement)) arrangements.set(currentArrangement, []);
                    arrangements.get(currentArrangement)!.push(bytesValue);
                }
                break;
        }
    }

    const beatScale: number = 4 / denominator;
    const beatsPerBar: number = clamp(
        Math.round(numerator * beatScale),
        Config.beatsPerBarMin,
        Config.beatsPerBarMax,
    );

    const ticksPerPart: number = ppq / Config.partsPerBeat;
    const partsPerBar: number = Config.partsPerBeat * beatsPerBar;
    const ticksPerBar: number = ppq * beatsPerBar;

    let playlistEvents: Uint8Array[] | undefined = arrangements.get(selectedArrangement);

    if (playlistEvents == undefined || playlistEvents.length == 0) {
        for (const events of arrangements.values()) {
            if (events.length > 0) {
                playlistEvents = events;
                break;
            }
        }
    }

    const clips: PlaylistClip[] = [];
    if (playlistEvents != undefined) {
        for (const playlist of playlistEvents) {
            clips.push(...parsePlaylist(playlist));
        }
    }

    if (clips.length == 0 && patterns.size > 0) {
        let position: number = 0;
        const sortedPatterns: FlPattern[] = Array.from(patterns.values()).sort((a, b) => a.id - b.id);

        for (const pattern of sortedPatterns) {
            if (pattern.notes.length == 0) continue;

            let patternLength: number = pattern.length;
            if (patternLength <= 0) {
                for (const note of pattern.notes) {
                    patternLength = Math.max(patternLength, note.position + note.length);
                }
            }

            patternLength = Math.max(ticksPerBar, patternLength);

            clips.push({
                position,
                patternId: pattern.id,
                length: patternLength,
                trackReverseIndex: 0,
            });

            position += patternLength;
        }
    }

    const placedByRack: Map<number, PlacedNote[]> = new Map();
    let totalTicks: number = ticksPerBar;
    let expandedNoteCount: number = 0;

    for (const clip of clips) {
        const pattern: FlPattern | undefined = patterns.get(clip.patternId);
        if (pattern == undefined) continue;

        const clipLength: number = clip.length > 0
            ? clip.length
            : Math.max(pattern.length, ticksPerBar);

        const clipEnd: number = clip.position + clipLength;
        totalTicks = Math.max(totalTicks, clipEnd);

        for (const note of pattern.notes) {
            const start: number = clip.position + note.position;
            if (start >= clipEnd) continue;

            const end: number = Math.min(start + note.length, clipEnd);
            if (end <= start) continue;

            if (!placedByRack.has(note.rackChannel)) {
                if (placedByRack.size >= maxImportedRackChannels) continue;
                placedByRack.set(note.rackChannel, []);
            }

            expandedNoteCount++;
            if (expandedNoteCount > maxExpandedNotes) {
                throw new Error(
                    "This FL Studio arrangement expands to too many notes to import safely. "
                    + "Try a smaller arrangement or MIDI export.",
                );
            }

            placedByRack.get(note.rackChannel)!.push({
                ...note,
                start,
                end,
            });

            getOrCreateChannel(channels, note.rackChannel);
        }
    }

    if (placedByRack.size == 0) {
        throw new Error("No piano-roll notes were found in this FL Studio project.");
    }

    const totalParts: number = Math.max(1, Math.ceil(totalTicks / ticksPerPart));
    const totalBars: number = Math.max(
        1,
        Math.min(Config.barCountMax, Math.ceil(totalParts / partsPerBar)),
    );

    const pitchChannels: Channel[] = [];
    const noiseChannels: Channel[] = [];
    const modChannels: Channel[] = [];
    const cBasePitch: number = Config.keys[0].basePitch;

    const rackIndices: number[] = Array.from(placedByRack.keys()).sort((a, b) => a - b);

    for (const rackIndex of rackIndices) {
        const info: FlChannelInfo = getOrCreateChannel(channels, rackIndex);
        const sourceNotes: PlacedNote[] = placedByRack.get(rackIndex)!;
        const isNoise: boolean = looksLikeAbyssDrumChannel(info.name);

        const channel: Channel = new Channel();
        const instrument: Instrument = new Instrument(isNoise, false);
        instrument.setTypeAndReset(
            isNoise ? InstrumentType.noise : InstrumentType.chip,
            isNoise,
            false,
        );
        instrument.chord = 0;

        const customInstrument: any = instrument as any;
        customInstrument.voiceMode = info.mono ? 1 : 0;
        customInstrument.portamento = info.portamento;
        customInstrument.portamentoTicks = info.portamentoTicks;
        customInstrument.portamentoMode = 0;

        channel.instruments.push(instrument);
        (channel as any).name = info.name;

        for (let bar: number = 0; bar < totalBars; bar++) {
            channel.bars.push(0);
        }

        const patternByBar: Map<number, Pattern> = new Map();
        let pitchSum: number = 0;
        let pitchCount: number = 0;

        const getPattern = (bar: number): Pattern => {
            let pattern: Pattern | undefined = patternByBar.get(bar);

            if (pattern == undefined) {
                pattern = new Pattern();
                pattern.instruments[0] = 0;
                pattern.instruments.length = 1;
                channel.patterns.push(pattern);
                channel.bars[bar] = channel.patterns.length;
                patternByBar.set(bar, pattern);
            }

            return pattern;
        };

        sourceNotes.sort((a, b) => a.start - b.start || a.key - b.key);

        for (const sourceNote of sourceNotes) {
            let startPart: number = Math.max(0, Math.round(sourceNote.start / ticksPerPart));
            let endPart: number = Math.max(startPart + 1, Math.round(sourceNote.end / ticksPerPart));

            const firstBar: number = Math.floor(startPart / partsPerBar);
            if (firstBar >= totalBars) continue;

            const lastBar: number = Math.min(
                totalBars - 1,
                Math.floor((endPart - 1) / partsPerBar),
            );

            const pitch: number = isNoise
                ? clamp(sourceNote.key - 36, 0, Config.drumCount - 1)
                : clamp(sourceNote.key - cBasePitch, 0, Config.maxPitch);

            const size: number = clamp(
                Math.round(sourceNote.velocity / 100 * Config.noteSizeMax),
                1,
                Config.noteSizeMax,
            );

            if (!isNoise) {
                pitchSum += pitch;
                pitchCount++;
            }

            for (let bar: number = firstBar; bar <= lastBar; bar++) {
                const barStartPart: number = bar * partsPerBar;
                const localStart: number = Math.max(0, startPart - barStartPart);
                const localEnd: number = Math.min(partsPerBar, endPart - barStartPart);

                if (localEnd <= localStart) continue;

                const pattern: Pattern = getPattern(bar);
                const note: Note = new Note(pitch, localStart, localEnd, size, isNoise);

                note.continuesLastPattern = bar > firstBar;

                const customNote: any = note as any;
                customNote.noteType = (sourceNote.flags & (1 << 3)) != 0 ? 1 : 0;

                pattern.notes.push(note);
            }
        }

        for (const pattern of channel.patterns) {
            pattern.notes.sort((a: Note, b: Note) => {
                if (a.start != b.start) return a.start - b.start;
                const aPitch: number = a.pitches.length > 0 ? a.pitches[0] : 0;
                const bPitch: number = b.pitches.length > 0 ? b.pitches[0] : 0;
                return aPitch - bPitch;
            });
        }

        channel.octave = isNoise || pitchCount == 0
            ? 0
            : clamp(
                Math.floor((pitchSum / pitchCount) / 12),
                0,
                Config.pitchOctaves - 1,
            );

        if (isNoise) {
            noiseChannels.push(channel);
        } else {
            pitchChannels.push(channel);
        }
    }

    compactChannels(pitchChannels, Config.pitchChannelCountMax);
    compactChannels(noiseChannels, Config.noiseChannelCountMax);

    return {
        title,
        tempo,
        beatsPerBar,
        pitchChannels,
        noiseChannels,
        modChannels,
    };
}
