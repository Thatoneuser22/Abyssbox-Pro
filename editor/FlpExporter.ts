import { Config } from "../synth/SynthConfig";

const flStudioPpq: number = 96;
const patternBase: number = 20_480;
const firstTrackReverseIndex: number = 499;

class ByteWriter {
    private readonly _bytes: number[] = [];

    public get length(): number {
        return this._bytes.length;
    }

    public writeUint8(value: number): void {
        this._bytes.push(value & 0xff);
    }

    public writeUint16(value: number): void {
        this.writeUint8(value);
        this.writeUint8(value >>> 8);
    }

    public writeUint32(value: number): void {
        this.writeUint8(value);
        this.writeUint8(value >>> 8);
        this.writeUint8(value >>> 16);
        this.writeUint8(value >>> 24);
    }

    public writeInt32(value: number): void {
        this.writeUint32(value >>> 0);
    }

    public writeFloat32(value: number): void {
        const buffer = new ArrayBuffer(4);
        new DataView(buffer).setFloat32(0, value, true);
        this.writeBytes(new Uint8Array(buffer));
    }

    public writeAscii(value: string): void {
        for (let i: number = 0; i < value.length; i++) {
            this.writeUint8(value.charCodeAt(i) & 0xff);
        }
    }

    public writeUtf16(value: string): void {
        for (let i: number = 0; i < value.length; i++) {
            this.writeUint16(value.charCodeAt(i));
        }
    }

    public writeBytes(bytes: Uint8Array | number[]): void {
        for (const byte of bytes) {
            this.writeUint8(byte);
        }
    }

    public writeVarInt(value: number): void {
        value = Math.max(0, Math.floor(value));

        do {
            let byte: number = value & 0x7f;
            value = Math.floor(value / 128);

            if (value > 0) byte |= 0x80;
            this.writeUint8(byte);
        } while (value > 0);
    }

    public toUint8Array(): Uint8Array {
        return Uint8Array.from(this._bytes);
    }

    public toArrayBuffer(): ArrayBuffer {
        return this.toUint8Array().buffer;
    }
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function writeByteEvent(writer: ByteWriter, id: number, value: number): void {
    writer.writeUint8(id);
    writer.writeUint8(value);
}

function writeWordEvent(writer: ByteWriter, id: number, value: number): void {
    writer.writeUint8(id);
    writer.writeUint16(value);
}

function writeDwordEvent(writer: ByteWriter, id: number, value: number): void {
    writer.writeUint8(id);
    writer.writeUint32(value);
}

function writeDataEvent(writer: ByteWriter, id: number, data: Uint8Array): void {
    writer.writeUint8(id);
    writer.writeVarInt(data.length);
    writer.writeBytes(data);
}

function writeUnicodeEvent(writer: ByteWriter, id: number, value: string): void {
    const data = new ByteWriter();
    data.writeUtf16(value);
    data.writeUint16(0);
    writeDataEvent(writer, id, data.toUint8Array());
}

function writeAsciiEvent(writer: ByteWriter, id: number, value: string): void {
    const data = new ByteWriter();
    data.writeAscii(value);
    data.writeUint8(0);
    writeDataEvent(writer, id, data.toUint8Array());
}

function getUnrolledBars(song: any, includeIntro: boolean, loopCount: number, includeOutro: boolean): number[] {
    const bars: number[] = [];

    if (includeIntro) {
        for (let bar: number = 0; bar < song.loopStart; bar++) {
            bars.push(bar);
        }
    }

    for (let loop: number = 0; loop < loopCount; loop++) {
        for (let bar: number = song.loopStart; bar < song.loopStart + song.loopLength; bar++) {
            bars.push(bar);
        }
    }

    if (includeOutro) {
        for (let bar: number = song.loopStart + song.loopLength; bar < song.barCount; bar++) {
            bars.push(bar);
        }
    }

    return bars;
}

interface RackChannel {
    sourceChannel: number;
    instrumentIndex: number;
    rackIndex: number;
    name: string;
    instrument: any;
}

function collectRackChannels(song: any): RackChannel[] {
    const result: RackChannel[] = [];

    for (let channelIndex: number = 0; channelIndex < song.pitchChannelCount + song.noiseChannelCount; channelIndex++) {
        const channel: any = song.channels[channelIndex];

        for (let instrumentIndex: number = 0; instrumentIndex < channel.instruments.length; instrumentIndex++) {
            const isNoise: boolean = song.getChannelIsNoise(channelIndex);
            const kind: string = isNoise ? "Drum" : "Channel";

            result.push({
                sourceChannel: channelIndex,
                instrumentIndex,
                rackIndex: result.length,
                name: `${kind} ${channelIndex + 1} - Instrument ${instrumentIndex + 1}`,
                instrument: channel.instruments[instrumentIndex],
            });
        }
    }

    return result;
}

function findRackIndex(rackChannels: RackChannel[], sourceChannel: number, instrumentIndex: number): number {
    for (const rack of rackChannels) {
        if (rack.sourceChannel == sourceChannel && rack.instrumentIndex == instrumentIndex) {
            return rack.rackIndex;
        }
    }

    for (const rack of rackChannels) {
        if (rack.sourceChannel == sourceChannel) return rack.rackIndex;
    }

    return 0;
}

function getFlPolyphonyData(instrument: any): Uint8Array | null {
    const voiceMode: number = instrument.voiceMode | 0;
    const portamento: boolean = instrument.portamento == true;

    if (voiceMode == 0 && !portamento) return null;

    const writer = new ByteWriter();
    const maxVoices: number = voiceMode == 0 ? 64 : 1;
    const slideTicks: number = clamp(instrument.portamentoTicks == undefined ? 6 : instrument.portamentoTicks, 1, 48);
    const flSlide: number = Math.round(slideTicks / 48 * 1660);

    let flags: number = 0;
    if (voiceMode != 0) flags |= 1;
    if (portamento) flags |= 2;

    writer.writeUint32(maxVoices);
    writer.writeUint32(flSlide);
    writer.writeUint8(flags);

    return writer.toUint8Array();
}

function writeChannelEvents(writer: ByteWriter, rack: RackChannel): void {
    // Channel.New
    writeWordEvent(writer, 64, rack.rackIndex);

    // Channel.IsEnabled
    writeByteEvent(writer, 0, 1);

    // Channel.Type = Sampler. This keeps the exported FLP fully stock/openable
    // without requiring AbyssBox's own synth engine inside FL Studio.
    writeByteEvent(writer, 21, 0);

    // Channel.GroupNum = 0
    writeDwordEvent(writer, 145, 0);

    // Channel name.
    writeUnicodeEvent(writer, 192, rack.name);

    const polyphony: Uint8Array | null = getFlPolyphonyData(rack.instrument);
    if (polyphony != null) {
        // Channel.Polyphony
        writeDataEvent(writer, 221, polyphony);
    }
}

function createFlNote(
    song: any,
    sourceChannel: number,
    rackChannel: number,
    note: any,
    pitch: number,
): Uint8Array {
    const writer = new ByteWriter();
    const isNoise: boolean = song.getChannelIsNoise(sourceChannel);
    const ticksPerPart: number = flStudioPpq / Config.partsPerBeat;

    const position: number = Math.max(0, Math.round(note.start * ticksPerPart));
    const length: number = Math.max(1, Math.round((note.end - note.start) * ticksPerPart));
    const mainInterval: number = typeof note.pickMainInterval == "function" ? note.pickMainInterval() : 0;

    let key: number;
    if (isNoise) {
        key = 36 + pitch;
    } else {
        key = Config.keys[song.key].basePitch + pitch + mainInterval;
    }

    key = clamp(Math.round(key), 0, 131);

    // AbyssBox Pro NoteType:
    // 0 normal, 1 slide, 2 portamento.
    // FL's native note structure has an actual Slide flag, so those map directly.
    const noteType: number = note.noteType == undefined ? 0 : note.noteType | 0;
    const flags: number = noteType == 1 ? 1 << 3 : 0;

    const size: number = note.pins != null && note.pins.length > 0 ? note.pins[0].size : Config.noteSizeMax;
    const velocity: number = clamp(Math.round(100 * size / Config.noteSizeMax), 1, 128);

    writer.writeUint32(position);
    writer.writeUint16(flags);
    writer.writeUint16(rackChannel);
    writer.writeUint32(length);
    writer.writeUint16(key);
    writer.writeUint16(0);   // group
    writer.writeUint8(120);  // fine pitch center
    writer.writeUint8(0);    // unknown
    writer.writeUint8(64);   // release
    writer.writeUint8(0);    // MIDI color/channel
    writer.writeUint8(64);   // pan center
    writer.writeUint8(velocity);
    writer.writeUint8(128);  // mod X
    writer.writeUint8(128);  // mod Y

    return writer.toUint8Array();
}

function createPatternNoteData(
    song: any,
    sourceChannel: number,
    bar: number,
    rackChannels: RackChannel[],
): Uint8Array {
    const writer = new ByteWriter();
    const pattern: any = song.getPattern(sourceChannel, bar);

    if (pattern == null) return writer.toUint8Array();

    const instrumentIndex: number = pattern.instruments != null && pattern.instruments.length > 0
        ? pattern.instruments[0]
        : 0;

    const rackChannel: number = findRackIndex(rackChannels, sourceChannel, instrumentIndex);

    for (const note of pattern.notes) {
        for (const pitch of note.pitches) {
            writer.writeBytes(createFlNote(song, sourceChannel, rackChannel, note, pitch));
        }
    }

    return writer.toUint8Array();
}

function createPlaylistItem(patternId: number, position: number, length: number, sourceChannel: number): Uint8Array {
    const writer = new ByteWriter();

    writer.writeUint32(position);
    writer.writeUint16(patternBase);
    writer.writeUint16(patternBase + patternId);
    writer.writeUint32(length);
    writer.writeUint16(Math.max(0, firstTrackReverseIndex - sourceChannel));
    writer.writeUint16(0);
    writer.writeUint8(120);
    writer.writeUint8(0);
    writer.writeUint16(64);
    writer.writeUint8(64);
    writer.writeUint8(100);
    writer.writeUint8(128);
    writer.writeUint8(128);
    writer.writeFloat32(0);
    writer.writeFloat32(0);

    return writer.toUint8Array();
}

function createTrackData(trackIndex: number): Uint8Array {
    const writer = new ByteWriter();

    writer.writeUint32(trackIndex + 1); // iid
    writer.writeUint32(0);          // color
    writer.writeUint32(0);          // icon
    writer.writeUint8(1);           // enabled
    writer.writeFloat32(1);         // height
    writer.writeInt32(0);           // locked height
    writer.writeUint8(0);           // content locked
    writer.writeUint32(0);          // motion
    writer.writeUint32(0);          // press
    writer.writeUint32(5);          // trigger sync: four beats
    writer.writeUint32(0);          // queued
    writer.writeUint32(1);          // tolerant
    writer.writeUint32(0);          // position sync
    writer.writeUint8(0);           // grouped
    writer.writeUint8(0);           // locked

    return writer.toUint8Array();
}

export interface FlpExportOptions {
    includeIntro: boolean;
    loopCount: number;
    includeOutro: boolean;
    title?: string;
}

export function exportFlStudioProject(song: any, options: FlpExportOptions): ArrayBuffer {
    const data = new ByteWriter();
    const rackChannels: RackChannel[] = collectRackChannels(song);
    const unrolledBars: number[] = getUnrolledBars(
        song,
        options.includeIntro,
        Math.max(1, options.loopCount | 0),
        options.includeOutro,
    );

    const barLength: number = flStudioPpq * song.beatsPerBar;

    // Project info.
    writeAsciiEvent(data, 199, "21.2.3.4004");
    writeUnicodeEvent(data, 194, options.title || song.title || "AbyssBox Pro Export");
    writeDwordEvent(data, 156, Math.round(song.getBeatsPerMinute() * 1000));

    // Time signature.
    writeByteEvent(data, 17, clamp(song.beatsPerBar | 0, 1, 16));
    writeByteEvent(data, 18, 4);

    // One display group is enough for the exported rack channels.
    writeUnicodeEvent(data, 231, "AbyssBox Pro");

    for (const rack of rackChannels) {
        writeChannelEvents(data, rack);
    }

    const playlistData = new ByteWriter();
    let patternId: number = 1;
    const sourceChannelCount: number = song.pitchChannelCount + song.noiseChannelCount;

    for (let sourceChannel: number = 0; sourceChannel < sourceChannelCount; sourceChannel++) {
        const isNoise: boolean = song.getChannelIsNoise(sourceChannel);
        const channelLabel: string = isNoise ? "Drum" : "Channel";

        for (let exportBar: number = 0; exportBar < unrolledBars.length; exportBar++) {
            const sourceBar: number = unrolledBars[exportBar];
            const notes: Uint8Array = createPatternNoteData(song, sourceChannel, sourceBar, rackChannels);

            if (notes.length == 0) continue;

            // Keep each AbyssBox source channel in its own FL pattern.
            // That prevents the notes from showing up as gray ghost notes
            // just because the pattern also contains notes for other rack channels.
            writeWordEvent(data, 65, patternId);
            writeDataEvent(data, 224, notes);
            writeWordEvent(data, 65, patternId);
            writeUnicodeEvent(data, 193, `${channelLabel} ${sourceChannel + 1} - Bar ${exportBar + 1}`);
            writeDwordEvent(data, 164, barLength);

            playlistData.writeBytes(
                createPlaylistItem(patternId, exportBar * barLength, barLength, sourceChannel),
            );

            patternId++;
        }
    }

    // Selected pattern.
    if (patternId > 1) {
        writeWordEvent(data, 67, 1);
    }

    // Arrangement 1.
    writeWordEvent(data, 99, 1);
    writeUnicodeEvent(data, 241, "Arrangement");

    for (let sourceChannel: number = 0; sourceChannel < sourceChannelCount; sourceChannel++) {
        const isNoise: boolean = song.getChannelIsNoise(sourceChannel);
        const channelLabel: string = isNoise ? "Drum" : "Channel";

        writeDataEvent(data, 238, createTrackData(sourceChannel));
        writeUnicodeEvent(data, 239, `${channelLabel} ${sourceChannel + 1}`);
    }

    if (playlistData.length > 0) {
        writeDataEvent(data, 233, playlistData.toUint8Array());
    }

    writeWordEvent(data, 100, 1);

    const body: Uint8Array = data.toUint8Array();
    const file = new ByteWriter();

    file.writeAscii("FLhd");
    file.writeUint32(6);
    file.writeUint16(0);
    file.writeUint16(rackChannels.length);
    file.writeUint16(flStudioPpq);

    file.writeAscii("FLdt");
    file.writeUint32(body.length);
    file.writeBytes(body);

    return file.toArrayBuffer();
}
