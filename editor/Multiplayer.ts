// Copyright (c) 2012-2022 John Nesky and contributing authors, distributed under the MIT license, see accompanying the LICENSE.md file.

import { SongDocument } from "./SongDocument";
import { ChangeSong } from "./changes";
import { InstrumentType } from "../synth/SynthConfig";
import { SoundFontLibrary } from "../synth/SoundFont";
import { Song } from "../synth/synth";

const multiplayerWorkerUrl: string = "https://abyssbox-pro-multiplayer.ahmaririley64.workers.dev";
const roomAlphabet: string = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const roomCodeLength: number = 6;
const syncDelayMs: number = 90;
const maxSharedSoundFontBytes: number = 64 * 1024 * 1024;
const soundFontDatabaseName: string = "AbyssBoxSoundFonts";
const soundFontStoreName: string = "fonts";


interface CachedSoundFont {
    id: string;
    name: string;
    buffer: ArrayBuffer;
    updatedAt?: number;
}

function multiplayerHttpUrl(path: string): string {
    return multiplayerWorkerUrl.replace(/\/+$/, "") + path;
}

function bytesToHex(bytes: Uint8Array): string {
    let result: string = "";

    for (const value of bytes) {
        result += value.toString(16).padStart(2, "0");
    }

    return result;
}

async function hashBuffer(buffer: ArrayBuffer): Promise<string> {
    const digest: ArrayBuffer = await crypto.subtle.digest("SHA-256", buffer);
    return bytesToHex(new Uint8Array(digest));
}

function openSoundFontDatabase(): Promise<IDBDatabase | null> {
    if (typeof indexedDB == "undefined") return Promise.resolve(null);

    return new Promise(resolve => {
        const request: IDBOpenDBRequest = indexedDB.open(soundFontDatabaseName, 1);

        request.onupgradeneeded = () => {
            const database: IDBDatabase = request.result;

            if (!database.objectStoreNames.contains(soundFontStoreName)) {
                database.createObjectStore(soundFontStoreName, { keyPath: "id" });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
    });
}

async function readCachedSoundFont(id: string): Promise<CachedSoundFont | null> {
    const database: IDBDatabase | null = await openSoundFontDatabase();
    if (database == null) return null;

    return new Promise(resolve => {
        const transaction: IDBTransaction = database.transaction(soundFontStoreName, "readonly");
        const request: IDBRequest = transaction.objectStore(soundFontStoreName).get(id);

        request.onsuccess = () => resolve(request.result as CachedSoundFont || null);
        request.onerror = () => resolve(null);

        transaction.oncomplete = () => database.close();
        transaction.onerror = () => database.close();
        transaction.onabort = () => database.close();
    });
}

function isSharedSoundFontUrl(value: string): boolean {
    if (!value.startsWith(multiplayerWorkerUrl)) return false;

    try {
        const url: URL = new URL(value);
        return /^\/assets\/soundfont\/[a-f0-9]{64}\.sf2$/i.test(url.pathname);
    } catch {
        return false;
    }
}

interface MultiplayerUser {
    id: string;
    name: string;
}

interface WelcomeMessage {
    type: "welcome";
    room: string;
    song: string;
    revision: number;
    users: MultiplayerUser[];
}

interface StateMessage {
    type: "state";
    song: string;
    revision: number;
    clientId: string;
}

interface PresenceMessage {
    type: "presence";
    users: MultiplayerUser[];
}

interface CursorMessage {
    type: "cursor";
    clientId: string;
    name: string;
    x: number;
    y: number;
    visible: boolean;
    channel: number;
    bar: number;
}

interface ErrorMessage {
    type: "error";
    message: string;
}

type ServerMessage = WelcomeMessage | StateMessage | PresenceMessage | CursorMessage | ErrorMessage;

function makeClientId(): string {
    const existing: string | null = localStorage.getItem("abyssbox-pro-multiplayer-id");
    if (existing != null && existing != "") return existing;

    const id: string =
        typeof crypto.randomUUID == "function"
            ? crypto.randomUUID()
            : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);

    localStorage.setItem("abyssbox-pro-multiplayer-id", id);
    return id;
}

function makeGuestName(): string {
    const existing: string | null = localStorage.getItem("abyssbox-pro-multiplayer-name");
    if (existing != null && existing.trim() != "") return existing.trim();

    const name: string = "Guest " + Math.floor(1000 + Math.random() * 9000);
    localStorage.setItem("abyssbox-pro-multiplayer-name", name);
    return name;
}

function makeRoomCode(): string {
    let result: string = "";

    for (let i: number = 0; i < roomCodeLength; i++) {
        result += roomAlphabet[(Math.random() * roomAlphabet.length) | 0];
    }

    return result;
}

function cleanRoomCode(value: string): string {
    return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20);
}

function websocketUrl(workerUrl: string, room: string): string {
    const url: URL = new URL(workerUrl);
    url.protocol = url.protocol == "https:" ? "wss:" : "ws:";
    url.pathname = url.pathname.replace(/\/+$/, "") + "/room/" + encodeURIComponent(room);
    url.search = "";
    url.hash = "";
    return url.toString();
}

function setRoomInUrl(room: string | null): void {
    const url: URL = new URL(window.location.href);

    if (room == null || room == "") {
        url.searchParams.delete("room");
    } else {
        url.searchParams.set("room", room);
    }

    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
}

export class MultiplayerClient {
    private readonly _doc: SongDocument;
    private readonly _clientId: string = makeClientId();

    private _name: string = makeGuestName();
    private _socket: WebSocket | null = null;
    private _room: string = "";
    private _revision: number = 0;
    private _roomUsers: MultiplayerUser[] = [];
    private _lastSong: string = "";
    private _syncTimer: number | null = null;
    private _connected: boolean = false;
    private _applyingRemote: boolean = false;
    private readonly _sharedSoundFontUrls: Map<string, string> = new Map();
    private readonly _localSoundFontIds: Map<string, string> = new Map();
    private readonly _sharingSoundFonts: Map<string, Promise<string | null>> = new Map();
    private readonly _loadingSharedSoundFonts: Set<string> = new Set();

    private _patternGestureActive: boolean = false;
    private _patternGestureDirty: boolean = false;
    private _patternGestureBaseSong: string = "";
    private _queuedRemoteState: StateMessage | null = null;

    private readonly _remoteCursorLayer: HTMLDivElement;
    private readonly _remoteCursors: Map<string, HTMLDivElement> = new Map();
    private readonly _remoteCursorState: Map<string, CursorMessage> = new Map();
    private readonly _finePointer: boolean = window.matchMedia("(pointer: fine)").matches;
    private _cursorSendPending: boolean = false;
    private _cursorVisible: boolean = false;
    private _cursorX: number = 0;
    private _cursorY: number = 0;
    private _lastCursorChannel: number = -1;
    private _lastCursorBar: number = -1;
    private _cursorHideTimer: number | null = null;

    private readonly _button: HTMLButtonElement;
    private readonly _panel: HTMLDivElement;
    private readonly _status: HTMLDivElement;
    private readonly _roomInput: HTMLInputElement;
    private readonly _nameInput: HTMLInputElement;
    private readonly _users: HTMLDivElement;
    private readonly _createButton: HTMLButtonElement;
    private readonly _joinButton: HTMLButtonElement;
    private readonly _copyButton: HTMLButtonElement;
    private readonly _leaveButton: HTMLButtonElement;

    constructor(doc: SongDocument, editorRoot: HTMLElement) {
        this._doc = doc;

        const style: HTMLStyleElement = document.createElement("style");
        style.textContent = `
            .abyssboxMultiplayerButton {
                width: auto !important;
                min-width: 2.4em;
                padding-left: 0.55em !important;
                padding-right: 0.55em !important;
                margin-left: 3px;
                flex: 0 0 auto;
            }

            .abyssboxMultiplayerPanel {
                position: fixed;
                top: 52px;
                right: 18px;
                z-index: 10020;
                width: 270px;
                box-sizing: border-box;
                padding: 9px;
                border: 1px solid var(--ui-widget-background, #555);
                border-radius: 3px;
                background: var(--editor-background, #151515);
                color: var(--primary-text, white);
                box-shadow: 0 5px 18px rgba(0, 0, 0, 0.42);
                font-family: inherit;
            }

            .abyssboxMultiplayerPanel[hidden] {
                display: none !important;
            }

            .abyssboxMultiplayerTitle {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 7px;
                font-weight: bold;
            }

            .abyssboxMultiplayerStatus {
                margin-bottom: 7px;
                padding: 5px 6px;
                background: var(--ui-widget-background, #292929);
                color: var(--secondary-text, #aaa);
                font-size: 11px;
            }

            .abyssboxMultiplayerRow {
                display: grid;
                grid-template-columns: 60px minmax(0, 1fr);
                gap: 6px;
                align-items: center;
                margin: 5px 0;
                font-size: 11px;
            }

            .abyssboxMultiplayerRow input {
                min-width: 0;
                width: 100%;
                box-sizing: border-box;
            }

            .abyssboxMultiplayerActions {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 5px;
                margin-top: 7px;
            }

            .abyssboxMultiplayerActions button {
                min-width: 0;
                width: 100%;
            }

            .abyssboxMultiplayerUsers {
                margin-top: 8px;
                padding-top: 7px;
                border-top: 1px solid var(--ui-widget-background, #444);
                font-size: 10px;
                color: var(--secondary-text, #aaa);
            }

            .abyssboxMultiplayerUser {
                display: flex;
                align-items: center;
                gap: 5px;
                margin-top: 3px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .abyssboxMultiplayerUserText {
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .abyssboxRemoteCursorLayer {
                position: fixed;
                inset: 0;
                z-index: 10010;
                pointer-events: none;
                overflow: hidden;
            }

            .abyssboxRemoteCursor {
                position: fixed;
                left: 0;
                top: 0;
                transform: translate3d(-100px, -100px, 0);
                will-change: transform;
                pointer-events: none;
                transition: opacity 90ms linear;
            }

            .abyssboxRemoteCursorArrow {
                width: 0;
                height: 0;
                border-top: 0 solid transparent;
                border-bottom: 13px solid transparent;
                border-left: 9px solid var(--cursor-color);
                filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.5));
            }

            .abyssboxRemoteCursorLabel {
                display: inline-block;
                max-width: 180px;
                margin-left: 7px;
                margin-top: -2px;
                padding: 2px 5px;
                border-radius: 2px;
                background: var(--cursor-color);
                color: #fff;
                font-size: 9px;
                line-height: 1.25;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                text-shadow: 0 1px 1px rgba(0, 0, 0, 0.45);
                box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
            }

            .abyssboxMultiplayerDot {
                width: 5px;
                height: 5px;
                flex: 0 0 5px;
                border-radius: 50%;
                background: var(--link-accent, #a778ff);
            }
        `;
        document.head.appendChild(style);

        this._button = document.createElement("button");
        this._button.type = "button";
        this._button.className = "abyssboxMultiplayerButton";
        this._button.textContent = "MP";
        this._button.title = "Multiplayer";
        this._button.addEventListener("click", () => {
            this._panel.hidden = !this._panel.hidden;
        });

        this._remoteCursorLayer = document.createElement("div");
        this._remoteCursorLayer.className = "abyssboxRemoteCursorLayer";
        document.body.appendChild(this._remoteCursorLayer);

        this._panel = document.createElement("div");
        this._panel.className = "abyssboxMultiplayerPanel";
        this._panel.hidden = true;

        const title: HTMLDivElement = document.createElement("div");
        title.className = "abyssboxMultiplayerTitle";

        const titleText: HTMLSpanElement = document.createElement("span");
        titleText.textContent = "Multiplayer";

        const closeButton: HTMLButtonElement = document.createElement("button");
        closeButton.type = "button";
        closeButton.textContent = "×";
        closeButton.style.width = "28px";
        closeButton.addEventListener("click", () => {
            this._panel.hidden = true;
        });

        title.append(titleText, closeButton);

        this._status = document.createElement("div");
        this._status.className = "abyssboxMultiplayerStatus";
        this._status.textContent = "Not connected";

        this._roomInput = document.createElement("input");
        this._roomInput.type = "text";
        this._roomInput.maxLength = 20;
        this._roomInput.placeholder = "ABC123";

        this._nameInput = document.createElement("input");
        this._nameInput.type = "text";
        this._nameInput.maxLength = 24;
        this._nameInput.value = this._name;
        this._nameInput.addEventListener("change", () => {
            const value: string = this._nameInput.value.trim().slice(0, 24);
            this._name = value == "" ? makeGuestName() : value;
            this._nameInput.value = this._name;
            localStorage.setItem("abyssbox-pro-multiplayer-name", this._name);

            if (this._connected) {
                this._send({
                    type: "profile",
                    clientId: this._clientId,
                    name: this._name,
                });
            }
        });

        const roomRow: HTMLDivElement = this._makeRow("Room", this._roomInput);
        const nameRow: HTMLDivElement = this._makeRow("Name", this._nameInput);

        this._createButton = document.createElement("button");
        this._createButton.type = "button";
        this._createButton.textContent = "Create Room";
        this._createButton.addEventListener("click", () => {
            const room: string = makeRoomCode();
            this._roomInput.value = room;
            this.connect(room);
        });

        this._joinButton = document.createElement("button");
        this._joinButton.type = "button";
        this._joinButton.textContent = "Join";
        this._joinButton.addEventListener("click", () => {
            this.connect(this._roomInput.value);
        });

        this._copyButton = document.createElement("button");
        this._copyButton.type = "button";
        this._copyButton.textContent = "Copy Invite";
        this._copyButton.disabled = true;
        this._copyButton.addEventListener("click", async () => {
            if (this._room == "") return;

            const url: URL = new URL(window.location.href);
            url.searchParams.set("room", this._room);
            url.hash = "";

            try {
                await navigator.clipboard.writeText(url.toString());
                this._setStatus("Invite copied");
            } catch {
                window.prompt("Copy this invite link:", url.toString());
            }
        });

        this._leaveButton = document.createElement("button");
        this._leaveButton.type = "button";
        this._leaveButton.textContent = "Leave";
        this._leaveButton.disabled = true;
        this._leaveButton.addEventListener("click", () => {
            this.disconnect(true);
        });

        const actions: HTMLDivElement = document.createElement("div");
        actions.className = "abyssboxMultiplayerActions";
        actions.append(
            this._createButton,
            this._joinButton,
            this._copyButton,
            this._leaveButton,
        );

        this._users = document.createElement("div");
        this._users.className = "abyssboxMultiplayerUsers";
        this._users.textContent = "Nobody else here yet.";

        this._panel.append(title, this._status, roomRow, nameRow, actions, this._users);
        document.body.appendChild(this._panel);

        const versionArea: Element | null = editorRoot.querySelector(".version-area");
        if (versionArea != null) {
            versionArea.appendChild(this._button);
        } else {
            editorRoot.appendChild(this._button);
        }

        this._doc.notifier.watch(this._whenDocumentUpdated);

        editorRoot.addEventListener("mousedown", this._whenPatternGestureStarted, true);
        editorRoot.addEventListener("touchstart", this._whenPatternGestureStarted, true);
        document.addEventListener("mouseup", this._whenPatternGestureEnded);
        document.addEventListener("touchend", this._whenPatternGestureEnded);
        document.addEventListener("touchcancel", this._whenPatternGestureEnded);

        if (this._finePointer) {
            document.addEventListener("mousemove", this._whenCollaboratorMouseMoved, { passive: true });
            document.addEventListener("mouseleave", this._whenCollaboratorMouseLeft);
        }

        const roomFromUrl: string = cleanRoomCode(new URLSearchParams(window.location.search).get("room") || "");
        if (roomFromUrl != "") {
            this._roomInput.value = roomFromUrl;
            window.setTimeout(() => this.connect(roomFromUrl), 0);
        }
    }

    private _makeRow(label: string, control: HTMLElement): HTMLDivElement {
        const row: HTMLDivElement = document.createElement("div");
        row.className = "abyssboxMultiplayerRow";

        const labelElement: HTMLSpanElement = document.createElement("span");
        labelElement.textContent = label + ":";

        row.append(labelElement, control);
        return row;
    }

    private _setStatus(message: string): void {
        this._status.textContent = message;
    }

    private _renderUsers(): void {
        this._users.replaceChildren();

        const header: HTMLDivElement = document.createElement("div");
        const count: number = this._usersListCount();
        header.textContent = count == 1 ? "1 person in room" : count + " people in room";
        this._users.appendChild(header);

        for (const user of this._roomUsers) {
            const row: HTMLDivElement = document.createElement("div");
            row.className = "abyssboxMultiplayerUser";

            const dot: HTMLSpanElement = document.createElement("span");
            dot.className = "abyssboxMultiplayerDot";

            const name: HTMLSpanElement = document.createElement("span");
            name.className = "abyssboxMultiplayerUserText";

            const cursorState: CursorMessage | undefined = this._remoteCursorState.get(user.id);
            const context: string = cursorState == undefined
                ? ""
                : " · Ch " + (cursorState.channel + 1) + " · Bar " + (cursorState.bar + 1);

            name.textContent = user.name + (user.id == this._clientId ? " (you)" : "") + context;

            row.append(dot, name);
            this._users.appendChild(row);
        }
    }

    private _usersListCount(): number {
        return this._roomUsers.length;
    }

    private _send(data: unknown): void {
        if (this._socket == null || this._socket.readyState != WebSocket.OPEN) return;
        this._socket.send(JSON.stringify(data));
    }

    private _cursorColor(clientId: string): string {
        let hash: number = 0;

        for (let i: number = 0; i < clientId.length; i++) {
            hash = ((hash << 5) - hash + clientId.charCodeAt(i)) | 0;
        }

        const hue: number = Math.abs(hash) % 360;
        return "hsl(" + hue + " 78% 58%)";
    }

    private _getPatternArea(): HTMLElement | null {
        return document.querySelector(".pattern-area") as HTMLElement | null;
    }

    private _scheduleCursorSend(): void {
        if (!this._connected || this._cursorSendPending) return;

        this._cursorSendPending = true;

        window.setTimeout(() => {
            this._cursorSendPending = false;
            this._sendCursorState();
        }, 35);
    }

    private _sendCursorState(force: boolean = false): void {
        if (!this._connected) return;

        const channel: number = this._doc.channel;
        const bar: number = this._doc.bar;
        const contextChanged: boolean =
            channel != this._lastCursorChannel
            || bar != this._lastCursorBar;

        if (!force && !this._cursorVisible && !contextChanged) return;

        this._lastCursorChannel = channel;
        this._lastCursorBar = bar;

        this._send({
            type: "cursor",
            clientId: this._clientId,
            x: this._cursorX,
            y: this._cursorY,
            visible: this._finePointer && this._cursorVisible,
            channel,
            bar,
        });
    }

    private _whenCollaboratorMouseMoved = (event: MouseEvent): void => {
        if (!this._connected || !this._finePointer) return;

        const patternArea: HTMLElement | null = this._getPatternArea();
        if (patternArea == null) return;

        const rect: DOMRect = patternArea.getBoundingClientRect();
        const inside: boolean =
            event.clientX >= rect.left
            && event.clientX <= rect.right
            && event.clientY >= rect.top
            && event.clientY <= rect.bottom;

        if (!inside) {
            if (this._cursorVisible) {
                this._cursorVisible = false;
                this._scheduleCursorSend();
            }
            return;
        }

        this._cursorVisible = true;
        this._cursorX = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
        this._cursorY = Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height)));

        if (this._cursorHideTimer != null) {
            window.clearTimeout(this._cursorHideTimer);
        }

        this._cursorHideTimer = window.setTimeout(() => {
            this._cursorHideTimer = null;

            if (this._cursorVisible) {
                this._cursorVisible = false;
                this._scheduleCursorSend();
            }
        }, 1_500);

        this._scheduleCursorSend();
    };

    private _whenCollaboratorMouseLeft = (): void => {
        if (!this._cursorVisible) return;

        this._cursorVisible = false;
        this._scheduleCursorSend();
    };

    private _removeRemoteCursor(clientId: string): void {
        const cursor: HTMLDivElement | undefined = this._remoteCursors.get(clientId);

        if (cursor != undefined) {
            cursor.remove();
            this._remoteCursors.delete(clientId);
        }

        this._remoteCursorState.delete(clientId);
    }

    private _renderRemoteCursor(message: CursorMessage): void {
        if (message.clientId == this._clientId) return;

        this._remoteCursorState.set(message.clientId, message);

        let cursor: HTMLDivElement | undefined = this._remoteCursors.get(message.clientId);

        if (cursor == undefined) {
            cursor = document.createElement("div");
            cursor.className = "abyssboxRemoteCursor";
            cursor.style.setProperty("--cursor-color", this._cursorColor(message.clientId));

            const arrow: HTMLDivElement = document.createElement("div");
            arrow.className = "abyssboxRemoteCursorArrow";

            const label: HTMLDivElement = document.createElement("div");
            label.className = "abyssboxRemoteCursorLabel";

            cursor.append(arrow, label);
            this._remoteCursorLayer.appendChild(cursor);
            this._remoteCursors.set(message.clientId, cursor);
        }

        const label: HTMLElement = cursor.querySelector(".abyssboxRemoteCursorLabel") as HTMLElement;
        label.textContent =
            message.name
            + " · Ch " + (message.channel + 1)
            + " · Bar " + (message.bar + 1);

        const patternArea: HTMLElement | null = this._getPatternArea();

        if (!message.visible || patternArea == null || !this._finePointer) {
            cursor.style.opacity = "0";
            this._renderUsers();
            return;
        }

        const rect: DOMRect = patternArea.getBoundingClientRect();
        const x: number = rect.left + Math.max(0, Math.min(1, message.x)) * rect.width;
        const y: number = rect.top + Math.max(0, Math.min(1, message.y)) * rect.height;

        cursor.style.opacity = "1";
        cursor.style.transform = "translate3d(" + Math.round(x) + "px, " + Math.round(y) + "px, 0)";
        this._renderUsers();
    }

    private _whenPatternGestureStarted = (event: Event): void => {
        if (!this._connected || this._patternGestureActive) return;

        const target: EventTarget | null = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest(".pattern-area") == null) return;

        this._patternGestureActive = true;
        this._patternGestureDirty = false;
        this._patternGestureBaseSong = this._doc.song.toBase64String();

        if (this._syncTimer != null) {
            window.clearTimeout(this._syncTimer);
            this._syncTimer = null;
        }
    };

    private _whenPatternGestureEnded = (): void => {
        if (!this._patternGestureActive) return;

        this._patternGestureActive = false;

        // PatternEditor also listens for mouseup/touchend. Let it finish
        // recording its prospective Change before we touch the Song object.
        window.setTimeout(() => {
            void this._finishPatternGesture();
        }, 0);
    };

    private _noteSignature(note: unknown): string {
        return JSON.stringify(note);
    }

    private _noteStart(note: any): number {
        if (
            note != null
            && Array.isArray(note.points)
            && note.points.length > 0
            && Number.isFinite(Number(note.points[0]?.tick))
        ) {
            return Number(note.points[0].tick);
        }

        return 0;
    }

    private _notePitch(note: any): number {
        if (
            note != null
            && Array.isArray(note.pitches)
            && note.pitches.length > 0
            && Number.isFinite(Number(note.pitches[0]))
        ) {
            return Number(note.pitches[0]);
        }

        return 0;
    }

    private _countNoteSignatures(notes: any[]): Map<string, number> {
        const counts: Map<string, number> = new Map();

        for (const note of notes) {
            const signature: string = this._noteSignature(note);
            counts.set(signature, (counts.get(signature) || 0) + 1);
        }

        return counts;
    }

    private _mergePatternNotes(
        baseEncoded: string,
        localEncoded: string,
        remoteEncoded: string,
    ): string {
        try {
            const baseSong: Song = new Song(baseEncoded);
            const localSong: Song = new Song(localEncoded);
            const remoteSong: Song = new Song(remoteEncoded);

            const baseJson: any = baseSong.toJsonObject();
            const localJson: any = localSong.toJsonObject();
            const remoteJson: any = remoteSong.toJsonObject();

            if (
                !Array.isArray(baseJson.channels)
                || !Array.isArray(localJson.channels)
                || !Array.isArray(remoteJson.channels)
            ) {
                return remoteEncoded;
            }

            const channelCount: number = Math.min(
                baseJson.channels.length,
                localJson.channels.length,
                remoteJson.channels.length,
            );

            for (let channelIndex: number = 0; channelIndex < channelCount; channelIndex++) {
                const basePatterns: any[] = Array.isArray(baseJson.channels[channelIndex]?.patterns)
                    ? baseJson.channels[channelIndex].patterns
                    : [];
                const localPatterns: any[] = Array.isArray(localJson.channels[channelIndex]?.patterns)
                    ? localJson.channels[channelIndex].patterns
                    : [];
                const remotePatterns: any[] = Array.isArray(remoteJson.channels[channelIndex]?.patterns)
                    ? remoteJson.channels[channelIndex].patterns
                    : [];

                const patternCount: number = Math.min(
                    basePatterns.length,
                    localPatterns.length,
                    remotePatterns.length,
                );

                for (let patternIndex: number = 0; patternIndex < patternCount; patternIndex++) {
                    const baseNotes: any[] = Array.isArray(basePatterns[patternIndex]?.notes)
                        ? basePatterns[patternIndex].notes
                        : [];
                    const localNotes: any[] = Array.isArray(localPatterns[patternIndex]?.notes)
                        ? localPatterns[patternIndex].notes
                        : [];
                    const remoteNotes: any[] = Array.isArray(remotePatterns[patternIndex]?.notes)
                        ? remotePatterns[patternIndex].notes
                        : [];

                    const baseCounts: Map<string, number> = this._countNoteSignatures(baseNotes);
                    const localCounts: Map<string, number> = this._countNoteSignatures(localNotes);

                    const locallyAdded: any[] = [];
                    const remainingBaseForAdd: Map<string, number> = new Map(baseCounts);

                    for (const note of localNotes) {
                        const signature: string = this._noteSignature(note);
                        const remaining: number = remainingBaseForAdd.get(signature) || 0;

                        if (remaining > 0) {
                            remainingBaseForAdd.set(signature, remaining - 1);
                        } else {
                            locallyAdded.push(note);
                        }
                    }

                    const locallyDeleted: Map<string, number> = new Map();

                    for (const [signature, baseCount] of baseCounts) {
                        const localCount: number = localCounts.get(signature) || 0;

                        if (localCount < baseCount) {
                            locallyDeleted.set(signature, baseCount - localCount);
                        }
                    }

                    if (locallyAdded.length == 0 && locallyDeleted.size == 0) {
                        continue;
                    }

                    const mergedNotes: any[] = [];
                    const deletionsLeft: Map<string, number> = new Map(locallyDeleted);

                    for (const note of remoteNotes) {
                        const signature: string = this._noteSignature(note);
                        const deleteCount: number = deletionsLeft.get(signature) || 0;

                        if (deleteCount > 0) {
                            deletionsLeft.set(signature, deleteCount - 1);
                            continue;
                        }

                        mergedNotes.push(note);
                    }

                    const mergedCounts: Map<string, number> = this._countNoteSignatures(mergedNotes);

                    for (const note of locallyAdded) {
                        const signature: string = this._noteSignature(note);
                        const wantedCount: number = localCounts.get(signature) || 0;
                        const currentCount: number = mergedCounts.get(signature) || 0;

                        if (currentCount >= wantedCount) continue;

                        // JSON note objects are plain data. Clone so the temporary
                        // Song parser cannot mutate a reference from localJson.
                        const clone: any = JSON.parse(JSON.stringify(note));
                        mergedNotes.push(clone);
                        mergedCounts.set(signature, currentCount + 1);
                    }

                    mergedNotes.sort((a: any, b: any) => {
                        const startDifference: number = this._noteStart(a) - this._noteStart(b);
                        if (startDifference != 0) return startDifference;

                        return this._notePitch(a) - this._notePitch(b);
                    });

                    remotePatterns[patternIndex].notes = mergedNotes;
                }
            }

            const mergedSong: Song = new Song(JSON.stringify(remoteJson));
            return mergedSong.toBase64String();
        } catch (error) {
            console.warn("Could not merge simultaneous multiplayer note edits:", error);
            return remoteEncoded;
        }
    }

    private async _finishPatternGesture(): Promise<void> {
        const baseSong: string = this._patternGestureBaseSong;
        const localSong: string = this._doc.song.toBase64String();
        const queued: StateMessage | null = this._queuedRemoteState;

        this._patternGestureBaseSong = "";
        this._queuedRemoteState = null;

        if (this._cursorHideTimer != null) {
            window.clearTimeout(this._cursorHideTimer);
            this._cursorHideTimer = null;
        }

        for (const cursor of this._remoteCursors.values()) {
            cursor.remove();
        }

        this._remoteCursors.clear();
        this._remoteCursorState.clear();

        if (queued != null && queued.clientId != this._clientId) {
            const mergedSong: string = this._mergePatternNotes(
                baseSong,
                localSong,
                queued.song,
            );

            this._applyRemoteSong(mergedSong);

            // _applyRemoteSong updates _lastSong. Force one authoritative
            // merged snapshot back to the room so both users converge.
            await this._sendCurrentState(true);
            this._patternGestureDirty = false;
            return;
        }

        if (this._patternGestureDirty) {
            this._patternGestureDirty = false;
            await this._sendCurrentState();
        }
    }

    private _whenDocumentUpdated = (): void => {
        if (!this._connected || this._applyingRemote) return;

        this._scheduleCursorSend();

        if (this._patternGestureActive) {
            this._patternGestureDirty = true;
            return;
        }

        const song: string = this._doc.song.toBase64String();
        if (song == this._lastSong) return;

        if (this._syncTimer != null) {
            window.clearTimeout(this._syncTimer);
        }

        this._syncTimer = window.setTimeout(() => {
            this._syncTimer = null;
            void this._sendCurrentState();
        }, syncDelayMs);
    };

    private async _shareLocalSoundFont(id: string, name: string): Promise<string | null> {
        const existingUrl: string | undefined = this._sharedSoundFontUrls.get(id);
        if (existingUrl != undefined) return existingUrl;

        const existingShare: Promise<string | null> | undefined = this._sharingSoundFonts.get(id);
        if (existingShare != undefined) return existingShare;

        const promise: Promise<string | null> = (async () => {
            const cached: CachedSoundFont | null = await readCachedSoundFont(id);

            if (cached == null) {
                console.warn("Could not share local SoundFont because it is not in the browser cache:", id);
                return null;
            }

            if (cached.buffer.byteLength <= 0 || cached.buffer.byteLength > maxSharedSoundFontBytes) {
                console.warn("Could not share SoundFont because its file size is outside the multiplayer limit:", cached.buffer.byteLength);
                return null;
            }

            const hash: string = await hashBuffer(cached.buffer);
            const assetUrl: string = multiplayerHttpUrl("/assets/soundfont/" + hash + ".sf2");
            const uploadUrl: URL = new URL(assetUrl);

            uploadUrl.searchParams.set("room", this._room);
            uploadUrl.searchParams.set("client", this._clientId);
            uploadUrl.searchParams.set("name", (name || cached.name || "SoundFont").slice(0, 160));

            const oldStatus: string = this._status.textContent || "";
            this._setStatus("Sharing SoundFont...");

            try {
                const response: Response = await fetch(uploadUrl.toString(), {
                    method: "PUT",
                    mode: "cors",
                    credentials: "omit",
                    headers: {
                        "content-type": "application/octet-stream",
                    },
                    body: cached.buffer,
                });

                if (!response.ok) {
                    let message: string = "Could not share SoundFont (HTTP " + response.status + ").";

                    try {
                        const data = await response.json() as {error?: string};
                        if (data.error != undefined && data.error != "") message = data.error;
                    } catch {
                    }

                    throw new Error(message);
                }

                const data = await response.json() as {url?: string};
                const remoteUrl: string = data.url || assetUrl;

                this._sharedSoundFontUrls.set(id, remoteUrl);
                this._localSoundFontIds.set(remoteUrl, id);
                return remoteUrl;
            } catch (error) {
                console.warn("Multiplayer SoundFont sharing failed:", error);
                this._setStatus(error instanceof Error ? error.message : "SoundFont sharing failed");
                return null;
            } finally {
                if (this._connected && this._status.textContent == "Sharing SoundFont...") {
                    this._setStatus(oldStatus || ("Connected · " + this._room));
                }
            }
        })();

        this._sharingSoundFonts.set(id, promise);

        try {
            return await promise;
        } finally {
            this._sharingSoundFonts.delete(id);
        }
    }

    private async _makeSharedSongSnapshot(): Promise<string> {
        const replacements: {instrument: {soundFontUrl: string}; localId: string; remoteUrl: string}[] = [];

        for (const channel of this._doc.song.channels) {
            for (const instrument of channel.instruments) {
                if (instrument.type != InstrumentType.soundfont) continue;

                const localId: string = instrument.soundFontUrl;
                if (!SoundFontLibrary.isLocal(localId)) continue;

                const remoteUrl: string | null = await this._shareLocalSoundFont(
                    localId,
                    instrument.soundFontName,
                );

                if (remoteUrl == null) continue;

                replacements.push({
                    instrument,
                    localId,
                    remoteUrl,
                });

                instrument.soundFontUrl = remoteUrl;
            }
        }

        try {
            return this._doc.song.toBase64String();
        } finally {
            for (const replacement of replacements) {
                replacement.instrument.soundFontUrl = replacement.localId;
            }
        }
    }

    private _restoreMyLocalSoundFonts(): void {
        for (const channel of this._doc.song.channels) {
            for (const instrument of channel.instruments) {
                if (instrument.type != InstrumentType.soundfont) continue;

                const localId: string | undefined = this._localSoundFontIds.get(instrument.soundFontUrl);
                if (localId != undefined) {
                    instrument.soundFontUrl = localId;
                }
            }
        }
    }

    private async _loadSharedSoundFonts(): Promise<void> {
        const urls: {url: string; name: string}[] = [];

        for (const channel of this._doc.song.channels) {
            for (const instrument of channel.instruments) {
                if (instrument.type != InstrumentType.soundfont) continue;
                if (!isSharedSoundFontUrl(instrument.soundFontUrl)) continue;

                urls.push({
                    url: instrument.soundFontUrl,
                    name: instrument.soundFontName,
                });
            }
        }

        for (const item of urls) {
            if (SoundFontLibrary.get(item.url) != null) continue;
            if (this._loadingSharedSoundFonts.has(item.url)) continue;

            this._loadingSharedSoundFonts.add(item.url);
            const oldStatus: string = this._status.textContent || "";
            this._setStatus("Loading shared SoundFont...");

            try {
                await SoundFontLibrary.loadById(item.url, item.name);
                this._doc.notifier.notifyWatchers();
            } catch (error) {
                console.warn("Could not load multiplayer SoundFont:", item.url, error);
                this._setStatus("Shared SoundFont failed to load");
            } finally {
                this._loadingSharedSoundFonts.delete(item.url);

                if (this._connected && this._status.textContent == "Loading shared SoundFont...") {
                    this._setStatus(oldStatus || ("Connected · " + this._room));
                }
            }
        }
    }

    private async _sendHello(): Promise<void> {
        if (!this._connected) return;

        const localSong: string = this._doc.song.toBase64String();
        const sharedSong: string = await this._makeSharedSongSnapshot();

        if (!this._connected) return;

        this._lastSong = localSong;

        this._send({
            type: "hello",
            clientId: this._clientId,
            name: this._name,
            song: sharedSong,
        });
    }

    private async _sendCurrentState(force: boolean = false): Promise<void> {
        if (!this._connected || this._applyingRemote) return;

        const localSong: string = this._doc.song.toBase64String();
        if (!force && localSong == this._lastSong) return;

        const sharedSong: string = await this._makeSharedSongSnapshot();

        if (!this._connected) return;

        this._lastSong = localSong;

        this._send({
            type: "state",
            clientId: this._clientId,
            baseRevision: this._revision,
            song: sharedSong,
            bar: this._doc.bar,
            channel: this._doc.channel,
        });
    }

    private _applyRemoteSong(song: string): void {
        if (song == "" || song == this._doc.song.toBase64String()) {
            this._lastSong = song;
            return;
        }

        this._applyingRemote = true;
        this._lastSong = song;

        try {
            new ChangeSong(this._doc, song);
            this._restoreMyLocalSoundFonts();
            this._lastSong = this._doc.song.toBase64String();
            this._doc.notifier.notifyWatchers();
            void this._loadSharedSoundFonts();

            if (this._doc.prefs.displayBrowserUrl) {
                const url: URL = new URL(window.location.href);
                url.hash = this._doc.song.toBase64String();
                window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
            }
        } catch (error) {
            console.warn("Could not apply multiplayer song state:", error);
            this._setStatus("Could not apply room update");
        } finally {
            this._applyingRemote = false;
        }
    }

    private _handleMessage(message: ServerMessage): void {
        if (message.type == "welcome") {
            this._revision = message.revision;
            this._roomUsers = message.users;
            this._room = message.room;
            this._roomInput.value = message.room;
            this._applyRemoteSong(message.song);
            this._renderUsers();
            this._setStatus("Connected · " + message.room);
            this._copyButton.disabled = false;
            this._leaveButton.disabled = false;
            setRoomInUrl(message.room);
            this._sendCursorState(true);
            return;
        }

        if (message.type == "state") {
            this._revision = Math.max(this._revision, message.revision);

            if (message.clientId != this._clientId) {
                if (this._patternGestureActive) {
                    // Never replace PatternEditor's Song/Note instances while
                    // it has an active prospective change.
                    this._queuedRemoteState = message;
                } else {
                    this._applyRemoteSong(message.song);
                }
            } else {
                this._lastSong = this._doc.song.toBase64String();
            }

            return;
        }

        if (message.type == "presence") {
            this._roomUsers = message.users;

            const activeIds: Set<string> = new Set(message.users.map((user: MultiplayerUser) => user.id));

            for (const clientId of this._remoteCursors.keys()) {
                if (!activeIds.has(clientId)) {
                    this._removeRemoteCursor(clientId);
                }
            }

            this._renderUsers();
            return;
        }

        if (message.type == "cursor") {
            this._renderRemoteCursor(message);
            return;
        }

        if (message.type == "error") {
            this._setStatus(message.message);
        }
    }

    public connect(roomValue: string): void {
        const room: string = cleanRoomCode(roomValue);
        if (room == "") {
            this._setStatus("Enter a room code");
            return;
        }

        if (multiplayerWorkerUrl.startsWith("PASTE_")) {
            this._setStatus("Set the Cloudflare Worker URL first");
            return;
        }

        this.disconnect(false);
        this._room = room;
        this._roomInput.value = room;
        this._setStatus("Connecting to " + room + "...");

        let socketUrl: string;

        try {
            socketUrl = websocketUrl(multiplayerWorkerUrl, room);
        } catch {
            this._setStatus("Invalid multiplayer server URL");
            return;
        }

        const socket: WebSocket = new WebSocket(socketUrl);
        this._socket = socket;

        socket.addEventListener("open", () => {
            if (socket != this._socket) return;

            this._connected = true;
            this._lastSong = "";
            void this._sendHello();
        });

        socket.addEventListener("message", (event: MessageEvent) => {
            if (socket != this._socket || typeof event.data != "string") return;

            try {
                this._handleMessage(JSON.parse(event.data) as ServerMessage);
            } catch (error) {
                console.warn("Invalid multiplayer message:", error);
            }
        });

        socket.addEventListener("close", () => {
            if (socket != this._socket) return;

            this._connected = false;
            this._socket = null;
            this._copyButton.disabled = true;
            this._leaveButton.disabled = true;
            this._setStatus("Disconnected");
        });

        socket.addEventListener("error", () => {
            if (socket != this._socket) return;
            this._setStatus("Connection error");
        });
    }

    public disconnect(removeRoomFromUrl: boolean = false): void {
        if (this._syncTimer != null) {
            window.clearTimeout(this._syncTimer);
            this._syncTimer = null;
        }

        const socket: WebSocket | null = this._socket;
        this._socket = null;
        this._connected = false;
        this._revision = 0;
        this._roomUsers = [];
        this._sharingSoundFonts.clear();
        this._loadingSharedSoundFonts.clear();
        this._patternGestureActive = false;
        this._patternGestureDirty = false;
        this._patternGestureBaseSong = "";
        this._queuedRemoteState = null;
        this._copyButton.disabled = true;
        this._leaveButton.disabled = true;

        if (socket != null) {
            socket.close(1000, "Left room");
        }

        if (removeRoomFromUrl) {
            this._room = "";
            setRoomInUrl(null);
            this._renderUsers();
            this._setStatus("Not connected");
        }
    }
}
