// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

const sfxDatabaseName: string = "abyssbox-sfx-cache-v1";
const sfxStoreName: string = "samples";
const maxSfxFileBytes: number = 64 * 1_024 * 1_024;

interface CachedSfxRecord {
    id: string;
    name: string;
    buffer: ArrayBuffer;
}

function openSfxDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request: IDBOpenDBRequest = indexedDB.open(sfxDatabaseName, 1);

        request.addEventListener("upgradeneeded", () => {
            const database: IDBDatabase = request.result;
            if (!database.objectStoreNames.contains(sfxStoreName)) {
                database.createObjectStore(sfxStoreName, { keyPath: "id" });
            }
        });

        request.addEventListener("success", () => resolve(request.result));
        request.addEventListener("error", () => reject(request.error || new Error("Could not open the SFX cache.")));
    });
}

async function cacheSfx(id: string, name: string, buffer: ArrayBuffer): Promise<void> {
    if (typeof indexedDB == "undefined") return;

    try {
        const database: IDBDatabase = await openSfxDatabase();

        await new Promise<void>((resolve, reject) => {
            const transaction: IDBTransaction = database.transaction(sfxStoreName, "readwrite");
            const store: IDBObjectStore = transaction.objectStore(sfxStoreName);
            store.put({
                id,
                name,
                buffer: buffer.slice(0),
            } as CachedSfxRecord);

            transaction.addEventListener("complete", () => resolve());
            transaction.addEventListener("error", () => reject(transaction.error || new Error("Could not save the SFX sample.")));
            transaction.addEventListener("abort", () => reject(transaction.error || new Error("Could not save the SFX sample.")));
        });

        database.close();
    } catch (error) {
        console.warn("Could not persist SFX sample:", error);
    }
}

async function getCachedSfx(id: string): Promise<CachedSfxRecord | null> {
    if (typeof indexedDB == "undefined") return null;

    try {
        const database: IDBDatabase = await openSfxDatabase();

        const record: CachedSfxRecord | null = await new Promise((resolve, reject) => {
            const transaction: IDBTransaction = database.transaction(sfxStoreName, "readonly");
            const store: IDBObjectStore = transaction.objectStore(sfxStoreName);
            const request: IDBRequest = store.get(id);

            request.addEventListener("success", () => resolve(request.result || null));
            request.addEventListener("error", () => reject(request.error || new Error("Could not read the SFX sample.")));
        });

        database.close();
        return record;
    } catch (error) {
        console.warn("Could not restore SFX sample:", error);
        return null;
    }
}

function makeLocalSfxId(file: File): string {
    return "sfx-local:" + encodeURIComponent(file.name) + ":" + file.size + ":" + file.lastModified;
}

export function sfxNameFromPath(path: string): string {
    const normalized: string = path.replace(/\\/g, "/");
    const pieces: string[] = normalized.split("/");
    return pieces[pieces.length - 1] || path || "Audio";
}

async function decodeSfxBuffer(id: string, name: string, buffer: ArrayBuffer): Promise<SfxData> {
    const AudioContextClass: any = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (AudioContextClass == undefined) throw new Error("This browser does not support audio decoding.");

    const context: AudioContext = new AudioContextClass();

    try {
        const audioBuffer: AudioBuffer = await context.decodeAudioData(buffer.slice(0));
        const length: number = audioBuffer.length;
        const channelCount: number = Math.max(1, audioBuffer.numberOfChannels);
        const samples: Float32Array = new Float32Array(length);

        for (let channel: number = 0; channel < channelCount; channel++) {
            const source: Float32Array = audioBuffer.getChannelData(channel);
            const gain: number = 1.0 / channelCount;

            for (let i: number = 0; i < length; i++) {
                samples[i] += source[i] * gain;
            }
        }

        return new SfxData(id, name, audioBuffer.sampleRate, samples);
    } catch {
        throw new Error("Could not decode this audio file. Try WAV, MP3, OGG, OPUS, or another format supported by your browser.");
    } finally {
        try {
            await context.close();
        } catch {
        }
    }
}

export class SfxData {
    public readonly durationSeconds: number;

    constructor(
        public readonly id: string,
        public readonly name: string,
        public readonly sampleRate: number,
        public readonly samples: Float32Array,
    ) {
        this.durationSeconds = sampleRate > 0 ? samples.length / sampleRate : 0;
    }
}

export class SfxLibrary {
    private static readonly _samples: Map<string, SfxData> = new Map();
    private static readonly _loading: Map<string, Promise<SfxData>> = new Map();

    public static get(id: string): SfxData | null {
        if (id == "") return null;
        return this._samples.get(id) || null;
    }

    public static isLoading(id: string): boolean {
        return id != "" && this._loading.has(id);
    }

    public static async loadFromFile(file: File): Promise<SfxData> {
        if (file.size <= 0) throw new Error("This audio file is empty.");
        if (file.size > maxSfxFileBytes) throw new Error("SFX files are limited to 64 MB.");

        const id: string = makeLocalSfxId(file);
        const existing: SfxData | undefined = this._samples.get(id);
        if (existing != undefined) return existing;

        const current: Promise<SfxData> | undefined = this._loading.get(id);
        if (current != undefined) return current;

        const promise: Promise<SfxData> = (async () => {
            const buffer: ArrayBuffer = await file.arrayBuffer();
            const sample: SfxData = await decodeSfxBuffer(id, file.name, buffer);
            this._samples.set(id, sample);
            await cacheSfx(id, file.name, buffer);
            return sample;
        })();

        this._loading.set(id, promise);

        try {
            return await promise;
        } finally {
            this._loading.delete(id);
        }
    }

    public static async loadById(id: string, name: string = ""): Promise<SfxData> {
        if (id == "") throw new Error("No SFX sample is selected.");

        const existing: SfxData | undefined = this._samples.get(id);
        if (existing != undefined) return existing;

        const current: Promise<SfxData> | undefined = this._loading.get(id);
        if (current != undefined) return current;

        const promise: Promise<SfxData> = (async () => {
            const cached: CachedSfxRecord | null = await getCachedSfx(id);

            if (cached == null) {
                throw new Error("This SFX sample is not saved in this browser. Relink the audio file.");
            }

            const sample: SfxData = await decodeSfxBuffer(id, cached.name || name || "Audio", cached.buffer);
            this._samples.set(id, sample);
            return sample;
        })();

        this._loading.set(id, promise);

        try {
            return await promise;
        } finally {
            this._loading.delete(id);
        }
    }
}
